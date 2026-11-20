import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator, publicKinds } from './coordinator.js';
import { digest } from '../core/contracts.js';
import { httpServer } from './http.js';

test('signed SSE streams partial output, reconnects from snapshots, and closes on device revocation',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-live-')), db = new Ledger(join(root,'ledger.sqlite')), coordinator = new Coordinator(db,root);
  const keys = generateKeyPairSync('ed25519'), deviceId = id(), messageId = id(), taskId = id();
  coordinator.devices.pair(deviceId,'fixture',keys.publicKey.export({ format: 'der',type: 'spki' }).subarray(-32).toString('base64'));
  const server = httpServer(coordinator,'unused'); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, abort = new AbortController();
  const connect = async (valid = true) => {
    const bytes = Buffer.from(JSON.stringify({ deviceId,issuedAt: Date.now(),type: 'subscribe',payload: {} }));
    return fetch(`${base}/v1/stream`,{ method: 'POST',body: bytes,signal: AbortSignal.any([abort.signal,AbortSignal.timeout(5000)]),headers: { 'x-outpost-signature': valid ? sign(null,bytes,keys.privateKey).toString('base64') : 'invalid' } });
  };
  try {
    assert.notEqual((await connect(false)).status,200);
    const response = await connect(); assert.equal(response.status,200); assert.match(response.headers.get('content-type') ?? '',/text\/event-stream/);
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    const next = async (): Promise<Record<string,unknown>> => {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done,false); buffer += decoder.decode(chunk.value,{ stream: true }); }
      const end = buffer.indexOf('\n\n'), frame = buffer.slice(0,end); buffer = buffer.slice(end+2); return JSON.parse(frame.slice(6));
    };
    assert.equal((await next()).type,'snapshot');
    coordinator.live.publish('message',messageId,{ taskId,author: 'assistant',text: 'partial',thinking: 'visible fixture reasoning' });
    const live = await next(); assert.equal(live.type,'live'); assert.match(JSON.stringify(live),/partial/);
    const second = await connect(); const secondReader = second.body!.getReader(), replay = await secondReader.read();
    assert.match(new TextDecoder().decode(replay.value),/partial/); await secondReader.cancel();
    coordinator.live.finish('message',messageId,{ taskId,author: 'assistant',text: 'partial completed',thinking: 'visible fixture reasoning' });
    assert.equal(coordinator.live.snapshot().length,0);
    assert.equal(db.need('message',messageId).data.streaming,false);
    assert.equal(db.list('message').length,1,'Final output replaces, not duplicates, its partial message');
    assert.equal(db.list('task').length,0,'Subscriptions cannot launch tasks');
    coordinator.devices.revoke(deviceId,1);
    let ended = false; for (let attempt = 0; attempt < 20; attempt++) if ((await reader.read()).done) { ended = true; break; }
    assert.ok(ended,'Revocation closes an already open stream');
  } finally { abort.abort(); coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('automation.preview and automation.delete enforce revisions, idempotency, snapshot exclusion and SSE deletion delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-auto-del-')), db = new Ledger(join(root, 'ledger.sqlite')), coordinator = new Coordinator(db, root);
  const keys = generateKeyPairSync('ed25519'), deviceId = id(), scheduleId = id();
  coordinator.devices.pair(deviceId, 'fixture', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
  const server = httpServer(coordinator, 'unused'); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, abort = new AbortController();
  const post = async (path: string, body: object) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return fetch(`${base}${path}`, { method: 'POST', body: bytes, headers: { 'x-outpost-signature': sign(null, bytes, keys.privateKey).toString('base64') } });
  };
  const cmd = (type: string, aggregateId: string, expectedRevision: number, payload: object, idempotencyKey = id()) => ({
    protocolVersion: 1, commandId: id(), idempotencyKey, deviceId, issuedAt: Date.now(), type, aggregateId, expectedRevision, payload,
  });
  try {
    // 1. automation.preview valid & invalid cases
    const previewRes = await post('/v1/query', {
      deviceId, issuedAt: Date.now(), type: 'automation.preview',
      payload: { calendar: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' }, afterAt: Date.parse('2026-03-06T12:00:00Z'), limit: 3 },
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as { status: string; occurrences: { scheduledAt: number }[] };
    assert.equal(preview.occurrences.length, 3);
    assert.equal(preview.occurrences[0]?.scheduledAt, Date.parse('2026-03-06T14:00:00Z'));
    assert.equal(preview.occurrences[1]?.scheduledAt, Date.parse('2026-03-09T13:00:00Z')); // after spring forward
    assert.equal(preview.status, 'limit');

    for (const bad of [
      { calendar: { kind: 'cron', expression: 'bad cron', timezone: 'UTC' } },
      { calendar: { kind: 'cron', expression: '0 9 * * *', timezone: '+05:30' } },
      { calendar: { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' } },
      {},
    ]) {
      const res = await post('/v1/query', { deviceId, issuedAt: Date.now(), type: 'automation.preview', payload: bad });
      assert.equal(res.status, 400);
    }

    // 2. Open SSE stream before saving/deleting
    const subBytes = Buffer.from(JSON.stringify({ deviceId, issuedAt: Date.now(), type: 'subscribe', payload: {} }));
    const streamRes = await fetch(`${base}/v1/stream`, { method: 'POST', body: subBytes, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), headers: { 'x-outpost-signature': sign(null, subBytes, keys.privateKey).toString('base64') } });
    assert.equal(streamRes.status, 200);
    const reader = streamRes.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    const nextFrame = async (): Promise<Record<string, unknown>> => {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value, { stream: true }); }
      const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); return JSON.parse(frame.slice(6));
    };
    assert.equal((await nextFrame()).type, 'snapshot');

    // 3. Save calendar schedule
    const saveRes = await post('/v1/commands', cmd('automation.save', scheduleId, 0, {
      name: 'Weekday digest', timezone: 'America/New_York', nextAt: 0, intervalMs: null, missed: 'coalesce', paused: false,
      calendar: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' },
      task: { goal: 'Send digest', profile: 'code', mode: 'full_control' },
    }));
    assert.equal(saveRes.status, 200);
    const saved = await saveRes.json() as { id: string; revision: number; data: { nextAt: number } };
    assert.equal(saved.revision, 1);
    assert.ok(saved.data.nextAt > Date.now());

    // Wait for SSE records frame containing the saved schedule
    let seenSaved = false;
    for (let i = 0; i < 10 && !seenSaved; i++) {
      const frame = await nextFrame();
      if (frame.type === 'records' && Array.isArray(frame.records) && frame.records.some((r: { id?: string; revision?: number }) => r.id === scheduleId && r.revision === 1)) seenSaved = true;
    }
    assert.ok(seenSaved, 'SSE delivered saved schedule');

    // 4. Delete rejections: extra payload field, stale revision
    assert.equal((await post('/v1/commands', cmd('automation.delete', scheduleId, 1, { extra: true }))).status, 400);
    const staleRes = await post('/v1/commands', cmd('automation.delete', scheduleId, 0, {}));
    assert.equal(staleRes.status, 409);
    assert.equal((await staleRes.json() as { error: string }).error, 'stale_revision');
    assert.equal(db.list('automation').length, 1);

    // 5. Valid delete + idempotent retry with same idempotencyKey
    const delCmd = cmd('automation.delete', scheduleId, 1, {});
    const delRes1 = await post('/v1/commands', delCmd);
    assert.equal(delRes1.status, 200);
    const deleted = await delRes1.json() as { kind: string; id: string; revision: number; deleted?: boolean; data: { deleted?: boolean } };
    assert.equal(deleted.kind, 'automation');
    assert.equal(deleted.id, scheduleId);
    assert.equal(deleted.revision, 2);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.data.deleted, true);

    const delRes2 = await post('/v1/commands', delCmd);
    assert.equal(delRes2.status, 200);
    assert.deepEqual(await delRes2.json(), deleted);

    // 6. Deleting again with a new idempotencyKey returns not_found
    const repeatRes = await post('/v1/commands', cmd('automation.delete', scheduleId, 2, {}));
    assert.equal(repeatRes.status, 409);
    assert.equal((await repeatRes.json() as { error: string }).error, 'not_found');

    // 7. SSE delivers deletion frame, snapshot excludes deleted automation, tick does not fire
    let seenDeleted = false;
    for (let i = 0; i < 10 && !seenDeleted; i++) {
      const frame = await nextFrame();
      if (frame.type === 'records' && Array.isArray(frame.records) && frame.records.some((r: { id?: string; revision?: number; deleted?: boolean }) => r.id === scheduleId && r.revision === 2 && r.deleted === true)) seenDeleted = true;
    }
    assert.ok(seenDeleted, 'SSE delivered automation deletion record');

    const snap = await (await post('/v1/query', { deviceId, issuedAt: Date.now(), type: 'snapshot', payload: {} })).json() as { records: { kind: string; id: string }[] };
    assert.equal(snap.records.some(r => r.kind === 'automation' && r.id === scheduleId), false);
    assert.equal(coordinator.scheduler.tick(saved.data.nextAt + 1000).length, 0);
    assert.equal(db.list('task').length, 0);
  } finally {
    abort.abort(); coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('subagent snapshots persist and restart/interruption never invent terminal success', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-subagent-history-')), path = join(root, 'ledger.sqlite');
  let db = new Ledger(path);
  const taskId = id(), sessionId = id(), key = digest({ child: 'fixture' });
  const data = { taskId, parentSessionId: sessionId, parentCallId: 'launch', parentToolId: digest({ sessionId, callId: 'launch' }),
    label: 'Worker', executionMode: 'background', state: 'running', activity: [{ id: 'observed', kind: 'message', text: 'Recorded work' }], incomplete: true, truncated: false, stopSupported: false };
  try {
    let coordinator = new Coordinator(db, root);
    coordinator.live.publish('subagent_run', key, data);
    coordinator.live.close(); db.close(); db = new Ledger(path);
    coordinator = new Coordinator(db, root);
    const record = db.need('subagent_run', key);
    assert.equal(record.data.state, 'unknown'); assert.equal(record.data.incomplete, true);
    assert.equal(record.data.streaming, false); assert.equal(record.data.interrupted, true);
    assert.deepEqual(record.data.activity, data.activity);
    assert.ok(publicKinds.includes('subagent_run'));
    assert.match(JSON.stringify(db.snapshot(publicKinds)), /Recorded work/);
    coordinator.live.publish('subagent_run', key, { ...data, state: 'running' });
    coordinator.live.interrupt(taskId);
    assert.equal(db.need('subagent_run', key).data.state, 'unknown');
    coordinator.live.finish('subagent_run', key, { ...data, state: 'completed' });
    new Coordinator(db, root);
    assert.equal(db.need('subagent_run', key).data.state, 'completed');
    coordinator.live.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('restart preserves checkpoints but marks live records interrupted',() => {
  const db = new Ledger(), coordinator = new Coordinator(db,mkdtempSync(join(tmpdir(),'outpost-live-restart-'))), messageId = id();
  try {
    coordinator.live.publish('message',messageId,{ taskId: id(),text: 'checkpoint',thinking: 'visible' });
    new Coordinator(db,coordinator.root);
    const record = db.need('message',messageId);
    assert.equal(record.data.streaming,false); assert.equal(record.data.interrupted,true); assert.equal(record.data.text,'checkpoint');
  } finally { db.close(); rmSync(coordinator.root,{ recursive: true,force: true }); }
});
