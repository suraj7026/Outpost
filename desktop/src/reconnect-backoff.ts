export const RECONNECT_BASE_DELAY_MS = 2_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER_RATIO = 0.2;

/**
 * Capped exponential backoff (`2s -> 4s -> 8s -> 16s -> 30s` max) with +/-20% jitter.
 * Clamped to RECONNECT_MAX_DELAY_MS so reconnect attempts never exceed 30 seconds.
 */
export function nextReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(0, Math.floor(attempt));
  const base = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** step);
  const sample = Math.min(1, Math.max(0, random()));
  const factor = 1 - RECONNECT_JITTER_RATIO + sample * (RECONNECT_JITTER_RATIO * 2);
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(base * factor));
}
