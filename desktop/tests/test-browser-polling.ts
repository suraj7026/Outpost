import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLL_MS,
  FAST_POLL_MS,
  IDLE_POLL_MS,
  INPUT_BOOST_MS,
  mergeBrowserFrame,
  nextBrowserPollDelayMs,
  type BrowserFrame,
} from '../src/browser-polling.ts';

test('nextBrowserPollDelayMs adapts between 250ms active/boost and 2000ms idle/unchanged', () => {
  const t0 = 10_000;
  // 250ms during 3s input boost window even when idle and unchanged
  assert.equal(
    nextBrowserPollDelayMs({ now: t0 + 500, boostUntil: t0 + INPUT_BOOST_MS, sessionState: 'idle', unchanged: true, hasError: false }),
    FAST_POLL_MS,
  );
  assert.equal(FAST_POLL_MS <= 300, true, 'Interactive refresh interval stays <= 300ms');

  // After 3s boost expires, idle + unchanged backs off to 2000ms
  assert.equal(
    nextBrowserPollDelayMs({ now: t0 + INPUT_BOOST_MS, boostUntil: t0 + INPUT_BOOST_MS, sessionState: 'idle', unchanged: true, hasError: false }),
    IDLE_POLL_MS,
  );

  // While running or starting, polls at 250ms even if frame is temporarily unchanged
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'running', unchanged: true, hasError: false }),
    FAST_POLL_MS,
  );
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'starting', unchanged: true, hasError: false }),
    FAST_POLL_MS,
  );

  // During pending/releasing control handoff, polls at 250ms
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'idle', controlState: 'pending', unchanged: true, hasError: false }),
    FAST_POLL_MS,
  );
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'idle', controlState: 'releasing', unchanged: true, hasError: false }),
    FAST_POLL_MS,
  );

  // Changed idle frame uses default 1000ms before settling into 2000ms unchanged backoff
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'idle', unchanged: false, hasError: false }),
    DEFAULT_POLL_MS,
  );

  // Closed or interrupted sessions back off to 2000ms
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'closed', unchanged: false, hasError: false }),
    IDLE_POLL_MS,
  );
  assert.equal(
    nextBrowserPollDelayMs({ now: t0, boostUntil: 0, sessionState: 'interrupted', unchanged: false, hasError: false }),
    IDLE_POLL_MS,
  );

  // Errors retry at default 1000ms (never hammering at 250ms even during input boost)
  assert.equal(
    nextBrowserPollDelayMs({ now: t0 + 100, boostUntil: t0 + INPUT_BOOST_MS, sessionState: 'running', unchanged: false, hasError: true }),
    DEFAULT_POLL_MS,
  );
});

test('mergeBrowserFrame preserves cached JPEG on unchanged responses and updates metadata', () => {
  const initial: BrowserFrame = {
    frame: 'base64-jpeg-payload',
    frameId: 'frame-1',
    capturedAt: '2026-11-20T10:00:00.000Z',
    width: 1280,
    height: 800,
    controlEpoch: 'epoch-1',
    control: null,
    tabs: [{ tab: 0, url: 'https://example.com', active: true }],
    session: { state: 'idle', mode: 'direct', url: 'https://example.com' },
  };

  // Minimal { unchanged: true, capturedAt, control } preserves frame, frameId, session, tabs, dimensions
  const lease = { leaseId: 'lease-1', holder: 'dev-1', state: 'human' as const, expiresAt: 99_999 };
  const mergedMinimal = mergeBrowserFrame(initial, {
    unchanged: true,
    capturedAt: '2026-11-20T10:00:02.000Z',
    control: lease,
  });
  assert.equal(mergedMinimal.frame, 'base64-jpeg-payload');
  assert.equal(mergedMinimal.frameId, 'frame-1');
  assert.equal(mergedMinimal.capturedAt, '2026-11-20T10:00:02.000Z');
  assert.deepEqual(mergedMinimal.control, lease);
  assert.deepEqual(mergedMinimal.session, initial.session);
  assert.deepEqual(mergedMinimal.tabs, initial.tabs);
  assert.equal(mergedMinimal.width, 1280);
  assert.equal(mergedMinimal.height, 800);

  // Closed response clears frame
  const closed = mergeBrowserFrame(mergedMinimal, {
    frame: null,
    capturedAt: null,
    session: { state: 'closed', mode: 'direct', url: 'https://example.com' },
  });
  assert.equal(closed.frame, null);
  assert.equal(closed.capturedAt, null);

  // Changed frame replaces image and frameId
  const changed = mergeBrowserFrame(initial, {
    frame: 'base64-jpeg-v2',
    frameId: 'frame-2',
    capturedAt: '2026-11-20T10:00:04.000Z',
    session: { state: 'idle', mode: 'direct', url: 'https://example.com/next' },
  });
  assert.equal(changed.frame, 'base64-jpeg-v2');
  assert.equal(changed.frameId, 'frame-2');
});
