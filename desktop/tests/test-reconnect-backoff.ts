import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nextReconnectDelay,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_RATIO,
  RECONNECT_MAX_DELAY_MS,
} from '../src/reconnect-backoff.ts';

test('exponential backoff follows 2s -> 4s -> 8s -> 16s -> 30s max at midpoint', () => {
  const mid = () => 0.5;
  assert.equal(nextReconnectDelay(0, mid), 2_000);
  assert.equal(nextReconnectDelay(1, mid), 4_000);
  assert.equal(nextReconnectDelay(2, mid), 8_000);
  assert.equal(nextReconnectDelay(3, mid), 16_000);
  assert.equal(nextReconnectDelay(4, mid), 30_000);
  assert.equal(nextReconnectDelay(5, mid), 30_000);
  assert.equal(nextReconnectDelay(20, mid), 30_000);
});

test('backoff applies +/-20% jitter and clamps to 30s ceiling', () => {
  const expected = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  for (let attempt = 0; attempt < expected.length; attempt++) {
    const base = expected[attempt]!;
    const min = Math.round(base * (1 - RECONNECT_JITTER_RATIO));
    const max = Math.min(RECONNECT_MAX_DELAY_MS, Math.round(base * (1 + RECONNECT_JITTER_RATIO)));
    assert.equal(nextReconnectDelay(attempt, () => 0), min);
    assert.equal(nextReconnectDelay(attempt, () => 1), max);
    for (let i = 0; i < 50; i++) {
      const value = nextReconnectDelay(attempt);
      assert.ok(value >= min && value <= max, `attempt ${attempt}: ${value} not in [${min}, ${max}]`);
      assert.ok(value <= RECONNECT_MAX_DELAY_MS);
    }
  }
  assert.equal(nextReconnectDelay(-3, () => 0.5), RECONNECT_BASE_DELAY_MS);
});
