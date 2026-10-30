import { randomUUID } from 'node:crypto';
import { webRequire } from './web-contracts.js';
import type { WebCacheLimits, WebCacheStore, WebEntry, WebFence, WebStored } from './web-contracts.js';

/** Explicitly ephemeral reference adapter; never selected implicitly in the runtime.
 * A PostgreSQL adapter must implement the same atomic fencing/quota contract.
 */
export class MemoryWebCacheStore implements WebCacheStore {
  private epoch = 0;
  private rows = new Map<string, { scope: string; value: WebStored; bytes: number }>();
  private reservations = new Map<string, { scope: string; fence: WebFence; until: number }>();
  constructor(readonly limits: WebCacheLimits, private now = Date.now, private reservationMs = 60_000) {
    for (const value of [...Object.values(limits), reservationMs]) webRequire(Number.isSafeInteger(value) && value > 0, 'invalid_cache_limits');
  }
  private key(scope: string, key: string) { return JSON.stringify([scope, key]); }
  async sweep(now: number): Promise<void> {
    for (const [key, row] of this.rows) if (row.value.entry.expiresAt <= now) this.rows.delete(key);
    for (const [key, reservation] of this.reservations) if (reservation.until <= now) this.reservations.delete(key);
  }
  async read(scope: string, key: string, now: number): Promise<WebStored | null> {
    await this.sweep(now);
    return structuredClone(this.rows.get(this.key(scope, key))?.value ?? null);
  }
  async reserve(scope: string, key: string): Promise<WebFence> {
    await this.sweep(this.now());
    const id = this.key(scope, key);
    webRequire(this.reservations.has(id) || this.reservations.size < this.limits.maxEntries, 'cache_quota');
    webRequire(Number.isSafeInteger(this.epoch + 1), 'cache_epoch_exhausted');
    const fence = { epoch: ++this.epoch, generation: randomUUID() };
    this.rows.delete(id);
    this.reservations.set(id, { scope, fence, until: this.now() + this.reservationMs });
    return structuredClone(fence);
  }
  async current(scope: string, key: string, fence: WebFence): Promise<boolean> {
    const id = this.key(scope, key), pending = this.reservations.get(id);
    if (pending && pending.until > this.now()) return pending.fence.generation === fence.generation && pending.fence.epoch === fence.epoch;
    const row = this.rows.get(id);
    return !!row && row.value.entry.expiresAt > this.now() && row.value.fence.generation === fence.generation && row.value.fence.epoch === fence.epoch;
  }
  async commit(scope: string, key: string, fence: WebFence, entry: WebEntry, now: number): Promise<boolean> {
    await this.sweep(now);
    // No await between fence validation, quota calculation and mutation.
    const id = this.key(scope, key), pending = this.reservations.get(id);
    if (!pending || pending.fence.generation !== fence.generation || pending.fence.epoch !== fence.epoch) return false;
    const bytes = Buffer.byteLength(JSON.stringify({ scope, key, entry, fence }));
    webRequire(bytes <= this.limits.maxEntryBytes, 'cache_entry_quota');
    const total = [...this.rows.values()].reduce((sum, row) => sum + row.bytes, 0) - (this.rows.get(id)?.bytes ?? 0) + bytes;
    webRequire(total <= this.limits.maxBytes && (this.rows.has(id) || this.rows.size < this.limits.maxEntries), 'cache_quota');
    webRequire(entry.expiresAt > now, 'invalid_expiry');
    this.rows.set(id, { scope, value: structuredClone({ entry, fence }), bytes });
    this.reservations.delete(id);
    return true;
  }
  async inspect(scope: string, now: number): Promise<{ entries: number; bytes: number }> {
    await this.sweep(now);
    const rows = [...this.rows.values()].filter(row => row.scope === scope);
    return { entries: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
  }
  async deleteScope(scope: string): Promise<{ throughEpoch: number }> {
    webRequire(Number.isSafeInteger(this.epoch + 1), 'cache_epoch_exhausted');
    const throughEpoch = ++this.epoch;
    for (const [key, row] of this.rows) if (row.scope === scope) this.rows.delete(key);
    for (const [key, reservation] of this.reservations) if (reservation.scope === scope) this.reservations.delete(key);
    return { throughEpoch };
  }
}
