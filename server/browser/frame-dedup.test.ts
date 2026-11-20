import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-camoufox';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator, publicKinds } from '../gateway/coordinator.js';
import { httpServer } from '../gateway/http.js';
import { BrowserSessions } from './sessions.js';

function createFakeBrowser(initialBytes: Buffer = Buffer.from('jpeg-frame-v1')) {
  let screenshotBytes: Buffer = initialBytes;
  let screenshotCalls = 0;
  let currentUrl = 'https://fixture.example/page';
  let typedText = '';
  let holdScreenshot: (() => void) | null = null;
  let releaseScreenshot: (() => void) | null = null;
  let pageClosed = false;
  const pageEvents = new EventEmitter();
  const contextEvents = new EventEmitter();
  const mainFrame = {};

  const page = Object.assign(pageEvents, {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    mainFrame: () => mainFrame,
    isClosed: () => pageClosed,
    url: () => currentUrl,
    viewportSize: () => ({ width: 1280, height: 800 }),
    screenshot: async () => {
      screenshotCalls++;
      if (holdScreenshot) {
        const wait = new Promise<void>(resolve => { releaseScreenshot = resolve; });
        holdScreenshot();
        holdScreenshot = null;
        await wait;
      }
      return screenshotBytes;
    },
    keyboard: {
      insertText: async (text: string) => { typedText += text; },
      press: async () => {},
    },
    mouse: {
      click: async () => {},
      wheel: async () => {},
    },
    goto: async (url: string) => {
      currentUrl = url;
      pageEvents.emit('framenavigated', mainFrame);
    },
    close: async () => {
      pageClosed = true;
      pageEvents.emit('close');
    },
  }) as unknown as Page;

  const context = Object.assign(contextEvents, {
    pages: () => (pageClosed ? [] : [page]),
    newPage: async () => page,
    close: async () => {
      pageClosed = true;
      contextEvents.emit('close');
    },
  }) as unknown as BrowserContext;

  return {
    openContext: async () => context,
    setBytes(bytes: Buffer) { screenshotBytes = bytes; },
    getScreenshotCalls: () => screenshotCalls,
    getTypedText: () => typedText,
    armScreenshotHold() {
      let started!: () => void;
      const promise = new Promise<void>(resolve => { started = resolve; });
      holdScreenshot = started;
      return {
        started: promise,
        release: () => { releaseScreenshot?.(); releaseScreenshot = null; },
      };
    },
  };
}

const signal = () => new AbortController().signal;

test('browser.frame returns { unchanged: true } with zero base64 payload when page is idle, and full frame on change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-frame-dedup-'));
  const db = new Ledger();
  const fake = createFakeBrowser(Buffer.from('frame-bytes-initial'));
  const coordinator = new Coordinator(db, root, { browser: { openContext: fake.openContext } });
  const server = httpServer(coordinator, 'fixture-token'.repeat(4));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const task = coordinator.tasks.create(id(), { goal: 'Verify frame dedup', profile: 'browser', mode: 'full_control' });
  const keys = generateKeyPairSync('ed25519'), deviceId = id();
  coordinator.devices.pair(deviceId, 'Viewer', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));

  const signedQuery = async (payload: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify({
      protocolVersion: 2,
      environmentId: coordinator.environment.environmentId,
      deviceId,
      issuedAt: Date.now(),
      type: 'browser.frame',
      payload,
    }));
    const signature = sign(null, bytes, keys.privateKey).toString('base64');
    return fetch(`http://127.0.0.1:${address.port}/v2/query`, {
      method: 'POST',
      body: bytes,
      headers: { 'x-outpost-signature': signature },
    });
  };

  try {
    await coordinator.browsers!.execute(task.id, 'direct', 'Open fixture', signal(), async () => {});
    const beforeCursor = db.cursor();

    // First query without lastFrameId returns full base64 frame
    const firstResponse = await signedQuery({ taskId: task.id });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as Record<string, unknown>;
    assert.equal(first.unchanged, undefined);
    assert.equal(first.frame, Buffer.from('frame-bytes-initial').toString('base64'));
    assert.equal(typeof first.frameId, 'string');
    assert.equal(typeof first.capturedAt, 'string');
    assert.equal(first.control, null);
    assert.equal(typeof first.controlEpoch, 'string');

    // Second query with matching lastFrameId on unchanged page returns { unchanged: true } with ZERO base64 transfer
    const secondResponse = await signedQuery({ taskId: task.id, lastFrameId: first.frameId });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as Record<string, unknown>;
    assert.equal(second.unchanged, true);
    assert.equal('frame' in second, false, 'Unchanged response must omit base64 frame payload');
    assert.equal(second.frameId, first.frameId);
    assert.equal(typeof second.capturedAt, 'string');
    assert.equal(second.control, null);
    assert.equal(second.controlEpoch, first.controlEpoch);

    // When page pixels change, query with old lastFrameId returns full new base64 frame and new frameId
    fake.setBytes(Buffer.from('frame-bytes-updated'));
    const thirdResponse = await signedQuery({ taskId: task.id, lastFrameId: first.frameId });
    assert.equal(thirdResponse.status, 200);
    const third = await thirdResponse.json() as Record<string, unknown>;
    assert.equal(third.unchanged, undefined);
    assert.equal(third.frame, Buffer.from('frame-bytes-updated').toString('base64'));
    assert.notEqual(third.frameId, first.frameId);

    // Unknown lastFrameId falls back gracefully to a full frame
    const unknownResponse = await signedQuery({ taskId: task.id, lastFrameId: id() });
    assert.equal(unknownResponse.status, 200);
    const unknown = await unknownResponse.json() as Record<string, unknown>;
    assert.equal(unknown.unchanged, undefined);
    assert.equal(unknown.frame, Buffer.from('frame-bytes-updated').toString('base64'));

    // Invalid payload shapes are rejected by strict Zod schema
    const invalidResponse = await signedQuery({ taskId: task.id, lastFrameId: 'x'.repeat(200) });
    assert.notEqual(invalidResponse.status, 200);
    const extraKeyResponse = await signedQuery({ taskId: task.id, unexpected: true });
    assert.notEqual(extraKeyResponse.status, 200);

    // Live frame polling never writes to durable ledger
    assert.equal(db.cursor(), beforeCursor);

    // Closed session with lastFrameId returns frame: null (never unchanged: true)
    await coordinator.browsers!.stop(task.id);
    const closedResponse = await signedQuery({ taskId: task.id, lastFrameId: third.frameId });
    assert.equal(closedResponse.status, 200);
    const closed = await closedResponse.json() as Record<string, unknown>;
    assert.equal(closed.unchanged, undefined);
    assert.equal(closed.frame, null);
    assert.equal(closed.capturedAt, null);
  } finally {
    await coordinator.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent frame requests coalesce screenshots and preserve per-client unchanged semantics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-frame-coalesce-'));
  const db = new Ledger();
  const fake = createFakeBrowser(Buffer.from('shared-frame'));
  const sessions = new BrowserSessions(db, root, { openContext: fake.openContext });
  const taskId = id();

  try {
    await sessions.execute(taskId, 'direct', 'Setup', signal(), async () => {});
    const initial = await sessions.frame(taskId);
    assert.ok(initial.frameId);
    const callsBefore = fake.getScreenshotCalls();

    const hold = fake.armScreenshotHold();
    const pUnchanged = sessions.frame(taskId, initial.frameId);
    const pFull = sessions.frame(taskId);
    await hold.started;
    hold.release();

    const [unchangedResult, fullResult] = await Promise.all([pUnchanged, pFull]);
    assert.equal(fake.getScreenshotCalls(), callsBefore + 1, 'Concurrent callers share one screenshot capture');
    assert.equal(unchangedResult.unchanged, true);
    assert.equal('frame' in unchangedResult, false);
    assert.equal(fullResult.unchanged, undefined);
    assert.equal(fullResult.frame, Buffer.from('shared-frame').toString('base64'));
  } finally {
    await sessions.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('humanInput accepts refreshed unchanged frameId, invalidates it after use, and never persists text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-frame-input-'));
  const db = new Ledger();
  const fake = createFakeBrowser(Buffer.from('static-form-page'));
  const sessions = new BrowserSessions(db, root, { openContext: fake.openContext });
  const taskId = id();

  try {
    await sessions.execute(taskId, 'direct', 'Setup', signal(), async () => {});
    sessions.reserve(taskId);

    const first = await sessions.frame(taskId);
    assert.ok(first.frameId);
    const unchanged = await sessions.frame(taskId, first.frameId);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.frameId, first.frameId);

    // humanInput succeeds with the unchanged frameId and does not persist text
    const secret = 'synthetic-secret-value-9981';
    const result = await sessions.humanInput(taskId, first.frameId, { action: 'text', text: secret });
    assert.deepEqual(result, { applied: true });
    assert.equal(fake.getTypedText(), secret);
    assert.equal(JSON.stringify(db.snapshot(publicKinds)).includes(secret), false);
    assert.equal(JSON.stringify(db.events(0, 200)).includes(secret), false);

    // Replaying consumed frameId fails with stale_browser_frame
    await assert.rejects(
      sessions.humanInput(taskId, first.frameId, { action: 'key', key: 'Enter' }),
      { code: 'stale_browser_frame' },
    );

    // Polling with consumed frameId returns a full new frame + new frameId even if pixels match
    const afterInput = await sessions.frame(taskId, first.frameId);
    assert.equal(afterInput.unchanged, undefined);
    assert.equal(afterInput.frame, Buffer.from('static-form-page').toString('base64'));
    assert.notEqual(afterInput.frameId, first.frameId);
  } finally {
    await sessions.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('frame cache stays bounded at 20 entries and refreshes active unchanged frameId via LRU', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-frame-lru-'));
  const db = new Ledger();
  const fake = createFakeBrowser(Buffer.from('frame-0'));
  const sessions = new BrowserSessions(db, root, { openContext: fake.openContext });
  const taskId = id();

  try {
    await sessions.execute(taskId, 'direct', 'Setup', signal(), async () => {});
    const kept = await sessions.frame(taskId);
    assert.ok(kept.frameId);
    const evicted = await sessions.frame(taskId);
    assert.ok(evicted.frameId);

    // Keep `kept.frameId` active while generating 25 additional frames from other callers
    for (let i = 0; i < 25; i++) {
      await sessions.frame(taskId);
      if (i % 10 === 0) {
        const hit = await sessions.frame(taskId, kept.frameId);
        assert.equal(hit.unchanged, true);
      }
    }

    // Active frameId is retained via LRU refresh, while older unused frameId was evicted
    const stillKept = await sessions.frame(taskId, kept.frameId);
    assert.equal(stillKept.unchanged, true);
    const wasEvicted = await sessions.frame(taskId, evicted.frameId);
    assert.equal(wasEvicted.unchanged, undefined);
    assert.equal(typeof wasEvicted.frame, 'string');
  } finally {
    await sessions.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
