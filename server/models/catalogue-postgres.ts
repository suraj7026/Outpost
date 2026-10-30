import { z } from 'zod';
import { Fault } from '../core/contracts.js';
import type { CoordinatorOwnership, Repository, RepositoryTransaction } from '../storage/contracts.js';
import { CatalogueIdentity, CatalogueSnapshot, catalogueKey, type CatalogueRepository } from './catalogue-types.js';

const recordKind = 'models.catalogue';
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stateSchema = z.strictObject({ schemaVersion: z.literal(1), fence: counter.positive(), snapshot: CatalogueSnapshot.nullable() });
const generationSchema = z.strictObject({ key: z.string(), fence: counter.positive(), priorVersion: counter, ownerEpoch: counter.positive() });
type State = z.infer<typeof stateSchema>;

function fail(code: string): never { throw new Fault(code, code); }
function validateKey(key: string): void {
  try {
    const [kind, accountId, baseUrl] = z.tuple([z.string(), z.string(), z.string()]).parse(JSON.parse(key) as unknown);
    if (catalogueKey(CatalogueIdentity.parse({ kind, accountId, baseUrl })) !== key) fail('catalogue_invalid_key');
  } catch { fail('catalogue_invalid_key'); }
}
function snapshotForKey(value: unknown, key: string): CatalogueSnapshot {
  const parsed = CatalogueSnapshot.safeParse(value);
  if (!parsed.success) fail('catalogue_invalid_snapshot');
  if (catalogueKey(parsed.data.identity) !== key) fail('catalogue_scope_mismatch');
  return parsed.data;
}

/** Dormant metadata adapter. The injected repository/owner are the sole authority.
 * Every operation awaits transaction settlement, including cancellation during COMMIT.
 * No connection, ownership acquisition, credential lookup, network request or retry is made here.
 */
export class PostgresCatalogueRepository implements CatalogueRepository {
  constructor(private readonly repository: Repository, private readonly owner: CoordinatorOwnership) {}

  private check(signal: AbortSignal): void {
    if (signal.aborted) fail('transaction_cancelled');
    if (!this.owner.active) fail('ownership_lost');
  }

  private async state(tx: RepositoryTransaction, key: string, signal: AbortSignal) {
    const record = await tx.get<unknown>(recordKind, key);
    this.check(signal);
    if (!record) return { revision: 0, data: null };
    const parsed = stateSchema.safeParse(record.data);
    if (!parsed.success) fail('catalogue_invalid_state');
    if (parsed.data.snapshot) snapshotForKey(parsed.data.snapshot, key);
    return { revision: record.revision, data: parsed.data };
  }

  async load(key: string, signal: AbortSignal): Promise<CatalogueSnapshot | null> {
    this.check(signal); validateKey(key);
    return this.repository.transaction(this.owner, async tx => {
      this.check(signal);
      return (await this.state(tx, key, signal)).data?.snapshot ?? null;
    }, { signal });
  }

  async beginRefresh(key: string, signal: AbortSignal): Promise<{ generation: string; snapshot: CatalogueSnapshot | null }> {
    this.check(signal); validateKey(key);
    return this.repository.transaction(this.owner, async tx => {
      this.check(signal);
      const previous = await this.state(tx, key, signal);
      const fence = (previous.data?.fence ?? 0) + 1;
      if (!Number.isSafeInteger(fence)) fail('catalogue_fence_exhausted');
      const snapshot = previous.data?.snapshot ?? null;
      const data: State = { schemaVersion: 1, fence, snapshot };
      await tx.put(recordKind, key, previous.revision, data);
      this.check(signal);
      return { generation: JSON.stringify({ key, fence, priorVersion: snapshot?.version ?? 0, ownerEpoch: this.owner.epoch }), snapshot };
    }, { signal });
  }

  async publish(key: string, generation: string, snapshot: CatalogueSnapshot, signal: AbortSignal): Promise<boolean> {
    this.check(signal); validateKey(key);
    // Parse to a defensive copy before the first await; caller mutation cannot change the write.
    const next = snapshotForKey(snapshot, key);
    let token: z.infer<typeof generationSchema>;
    try { token = generationSchema.parse(JSON.parse(generation) as unknown); }
    catch { return false; }
    if (token.key !== key || token.ownerEpoch !== this.owner.epoch) return false;
    return this.repository.transaction(this.owner, async tx => {
      this.check(signal);
      const previous = await this.state(tx, key, signal);
      if (!previous.data || previous.data.fence !== token.fence
        || (previous.data.snapshot?.version ?? 0) !== token.priorVersion
        || next.version !== token.priorVersion + 1) return false;
      await tx.put(recordKind, key, previous.revision, { ...previous.data, snapshot: next });
      this.check(signal);
      return true;
    }, { signal });
  }
}
