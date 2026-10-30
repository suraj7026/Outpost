import { Pool } from 'pg';
import type { PoolClient, PoolConfig, QueryResultRow } from 'pg';
import { Fault, digest, id, now, requireThat } from '../core/contracts.js';
import type { Command, Data, Event, Json, RecordValue } from '../core/contracts.js';
import type { CoordinatorOwnership, OutboxClaim, Repository, RepositoryTransaction, Snapshot, TransactionOptions } from './contracts.js';
import { jsonText, parseJson, safeInteger, timestampText } from './conversion.js';
import { migrate, schemaVersion } from './migrations.js';

export interface PostgresConfig {
  host: string; port: number; database: string; user: string; password: string;
  /** Unix sockets require false; TCP requires certificate verification. No ambient PG/URL defaults. */
  ssl: false | { rejectUnauthorized: true; ca?: string };
  maxConnections?: number;
}
function poolConfig(config: PostgresConfig): PoolConfig {
  requireThat(config.host.length > 0 && config.database.length > 0 && config.user.length > 0 && typeof config.password === 'string', 'invalid_database_config');
  requireThat(safeInteger(config.port, 1) <= 65535, 'invalid_database_config');
  requireThat(config.host.startsWith('/') ? config.ssl === false : config.ssl !== false && config.ssl.rejectUnauthorized === true, 'verified_tls_required');
  const max = safeInteger(config.maxConnections ?? 8, 3); requireThat(max <= 32, 'invalid_pool_size');
  // Allowlist TLS fields too: caller-provided hooks must not bypass certificate verification.
  const ssl: PostgresConfig['ssl'] = config.ssl === false ? false : { rejectUnauthorized: true };
  if (ssl !== false && config.ssl !== false && config.ssl.ca !== undefined) ssl.ca = config.ssl.ca;
  const password = config.password;
  // Never forward connectionString or other driver options that can override validated fields.
  // A password function prevents pg's empty-string -> PGPASSWORD environment fallback.
  return { host: config.host, port: config.port, database: config.database, user: config.user,
    password: async () => password, ssl, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    statement_timeout: 10000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15000,
    query_timeout: 12000, application_name: 'outpost-storage', options: '-c search_path=public' };
}
function createPool(config: PostgresConfig): Pool {
  const pool = new Pool(poolConfig(config));
  // pg emits errors on checked-out clients even between queries. Its client becomes
  // non-queryable; subsequent work/COMMIT fails through the redacting query boundary.
  // Handle these events as well as idle-pool errors without logging driver details.
  pool.on('connect', client => { client.on('error', () => {}); });
  pool.on('error', () => {});
  return pool;
}
// Never expose PostgreSQL detail, SQL, parameters, connection strings, or driver causes.
function databaseError(): Fault { return new Fault('database_error', 'Database operation failed', 503); }
function checkCancellation(signal?: AbortSignal): void {
  requireThat(!signal?.aborted, 'transaction_cancelled');
}
async function query<Row extends QueryResultRow>(db: Pool | PoolClient, sql: string, values: unknown[] = []) {
  try { return await db.query<Row>(sql, values); } catch { throw databaseError(); }
}
type RecordRow = { kind: string; id: string; revision: string; data: string; updated_at: string };
function record<T>(row: RecordRow): RecordValue<T> {
  return { kind: row.kind, id: row.id, revision: safeInteger(row.revision, 1), data: parseJson(row.data) as T, updatedAt: timestampText(row.updated_at) };
}
class Reader {
  constructor(protected readonly connection: Pool | PoolClient) {}
  protected check(): void {}
  protected async sql<Row extends QueryResultRow>(text: string, values: unknown[] = []) { this.check(); return query<Row>(this.connection, text, values); }
  async get<T = Data>(kind: string, key: string): Promise<RecordValue<T> | undefined> {
    const result = await this.sql<RecordRow>('SELECT * FROM outpost_records WHERE kind=$1 AND id=$2', [kind, key]);
    return result.rows[0] ? record<T>(result.rows[0]) : undefined;
  }
  async need<T = Data>(kind: string, key: string): Promise<RecordValue<T>> {
    const value = await this.get<T>(kind, key); requireThat(value, 'not_found'); return value;
  }
  async list<T = Data>(kind: string): Promise<RecordValue<T>[]> {
    return (await this.sql<RecordRow>('SELECT * FROM outpost_records WHERE kind=$1 ORDER BY updated_at DESC,id', [kind])).rows.map(record<T>);
  }
  async cursor(): Promise<number> {
    const result = await this.sql<{ watermark: string }>('SELECT watermark FROM outpost_writer WHERE singleton');
    requireThat(result.rows[0], 'missing_writer'); return safeInteger(result.rows[0].watermark);
  }
  async events(after = 0, limit = 200): Promise<Event[]> {
    safeInteger(after); requireThat(safeInteger(limit, 1) <= 1000, 'invalid_limit');
    requireThat(after <= await this.cursor(), 'invalid_cursor');
    const rows = (await this.sql<{ cursor: string; id: string; aggregate_id: string; revision: string; type: string; created_at: string; payload: string }>('SELECT * FROM outpost_events WHERE cursor>$1 ORDER BY cursor LIMIT $2', [after, limit])).rows;
    return rows.map(row => ({ protocolVersion: 1, eventId: row.id, feedCursor: safeInteger(row.cursor, 1), aggregateId: row.aggregate_id,
      aggregateRevision: safeInteger(row.revision, 1), type: row.type, occurredAt: timestampText(row.created_at), payload: parseJson(row.payload) }));
  }
}
class Ownership implements CoordinatorOwnership {
  private live = true;
  private released = false;
  private signalLost!: () => void;
  readonly lost = new Promise<void>(resolve => { this.signalLost = resolve; });
  private invalidate(): void { this.live = false; this.signalLost(); }
  get active() { return this.live; }
  constructor(readonly epoch: number, readonly client: PoolClient, readonly store: PostgresRepository) {
    client.on('error', () => { this.invalidate(); });
    client.on('end', () => { this.invalidate(); });
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true; this.invalidate();
    // Destroy the dedicated session, releasing only its advisory lock.
    this.client.release(true);
  }
}
class Transaction extends Reader implements RepositoryTransaction {
  private live = true;
  private childOpen = false;
  private failed = false;
  private operations = 0;
  private pendingQueries = 0;
  private sequence = 0;
  constructor(client: PoolClient, private readonly owner: Ownership, private readonly signal?: AbortSignal, private readonly parent?: Transaction) { super(client); }
  protected override check(): void {
    checkCancellation(this.signal);
    requireThat(this.live && this.owner.active && (!this.parent || this.parent.live), 'closed_transaction');
    requireThat(!this.childOpen, 'savepoint_active');
    requireThat(!this.failed, 'failed_transaction');
  }
  protected override async sql<Row extends QueryResultRow>(text: string, values: unknown[] = []) {
    this.check(); this.pendingQueries++;
    try {
      const result = await query<Row>(this.connection, text, values);
      this.check(); return result;
    }
    catch (error) { this.failed = true; throw error; }
    finally { this.pendingQueries--; }
  }
  private async operation<T>(apply: () => Promise<T>): Promise<T> {
    this.check(); requireThat(this.operations === 0, 'concurrent_transaction_operation'); this.operations++;
    try { const result = await apply(); this.check(); return result; }
    catch (error) { this.failed = true; throw error; } finally { this.operations--; }
  }
  assertSettled(): void { this.check(); requireThat(this.operations === 0 && this.pendingQueries === 0, 'unawaited_transaction_operation'); }
  close(): void { this.live = false; }
  async put<T extends object>(kind: string, key: string, expected: number, data: T, eventType = `${kind}.changed`): Promise<RecordValue<T>> {
    return this.operation(async () => {
      safeInteger(expected); const revision = safeInteger(expected + 1, 1), updatedAt = now(), text = jsonText(data);
      const result = expected === 0
        ? await this.sql('INSERT INTO outpost_records VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [kind,key,revision,text,updatedAt])
        : await this.sql('UPDATE outpost_records SET revision=$3,data=$4,updated_at=$5 WHERE kind=$1 AND id=$2 AND revision=$6 RETURNING id', [kind,key,revision,text,updatedAt,expected]);
      requireThat(result.rowCount === 1, 'stale_revision');
      const allocation = await this.sql<{ watermark: string }>('UPDATE outpost_writer SET watermark=watermark+1 WHERE singleton AND watermark<9007199254740991 RETURNING watermark');
      requireThat(allocation.rows[0], 'cursor_exhausted');
      const value = { kind, id: key, revision, data: parseJson(text) as T, updatedAt };
      await this.sql('INSERT INTO outpost_events VALUES($1,$2,$3,$4,$5,$6,$7)', [allocation.rows[0].watermark,id(),key,revision,eventType,jsonText(value),updatedAt]);
      return value;
    });
  }
  async enqueue(topic: string, payload: Json, key = id()): Promise<string> {
    return this.operation(async () => {
      const text = jsonText(payload);
      await this.sql('INSERT INTO outpost_outbox(id,topic,payload,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [key,topic,text,now()]);
      const previous = (await this.sql<{ topic: string; payload: string }>('SELECT topic,payload FROM outpost_outbox WHERE id=$1', [key])).rows[0];
      requireThat(previous?.topic === topic && previous.payload === text, 'outbox_conflict'); return key;
    });
  }
  async accept(command: Command, apply: (tx: RepositoryTransaction) => Promise<Json>): Promise<Json> {
    this.check(); safeInteger(command.expectedRevision); jsonText(command.payload);
    const hash = digest({ type: command.type, aggregateId: command.aggregateId, expectedRevision: command.expectedRevision, payload: command.payload });
    const { deviceId, idempotencyKey } = command;
    const previous = (await this.sql<{ digest: string; result: string }>('SELECT digest,result FROM outpost_commands WHERE device_id=$1 AND key=$2', [deviceId,idempotencyKey])).rows[0];
    if (previous) { requireThat(previous.digest === hash, 'idempotency_conflict'); return parseJson(previous.result); }
    // Suspend the parent handle while apply owns a savepoint-bound context.
    return this.savepoint(async tx => {
      const result = jsonText(await apply(tx));
      checkCancellation(this.signal);
      await query(this.connection, 'INSERT INTO outpost_commands VALUES($1,$2,$3,$4)', [deviceId,idempotencyKey,hash,result]);
      return parseJson(result);
    });
  }
  async savepoint<T>(apply: (tx: RepositoryTransaction) => Promise<T>): Promise<T> {
    this.assertSettled(); this.childOpen = true;
    const name = `nested_${++this.sequence}`;
    const child = new Transaction(this.connection as PoolClient, this.owner, this.signal, this);
    try {
      await query(this.connection, `SAVEPOINT ${name}`);
      child.assertSettled();
      const result = await apply(child); child.assertSettled();
      await query(this.connection, `RELEASE SAVEPOINT ${name}`);
      child.assertSettled(); return result;
    } catch (error) {
      child.close();
      try {
        await query(this.connection, `ROLLBACK TO SAVEPOINT ${name}`);
        await query(this.connection, `RELEASE SAVEPOINT ${name}`);
      } catch { this.failed = true; }
      throw error;
    } finally { child.close(); this.childOpen = false; }
  }
  async setDispatchEnabled(enabled: boolean): Promise<void> {
    await this.operation(async () => { await this.sql('UPDATE outpost_writer SET dispatch_enabled=$1 WHERE singleton', [enabled]); });
  }
  async claimOutbox(topics: string[], limit = 20): Promise<OutboxClaim[]> {
    return this.operation(async () => {
      requireThat(topics.length > 0 && safeInteger(limit, 1) <= 100, 'invalid_claim');
      const state = (await this.sql<{ dispatch_enabled: boolean }>('SELECT dispatch_enabled FROM outpost_writer WHERE singleton')).rows[0];
      requireThat(state?.dispatch_enabled, 'recovery_hold');
      const result = await this.sql<{ id: string; topic: string; payload: string }>(`UPDATE outpost_outbox SET state='claimed',claim_epoch=$1 WHERE id IN
        (SELECT id FROM outpost_outbox WHERE state='pending' AND topic=ANY($2::text[]) ORDER BY created_at,id LIMIT $3) RETURNING id,topic,payload`, [this.owner.epoch,topics,limit]);
      return result.rows.map(row => ({ id: row.id, topic: row.topic, payload: parseJson(row.payload), epoch: this.owner.epoch }));
    });
  }
  async finishOutbox(key: string, outcome: 'done' | 'unknown'): Promise<void> {
    await this.operation(async () => {
      requireThat(outcome === 'done' || outcome === 'unknown', 'invalid_outcome');
      const result = await this.sql("UPDATE outpost_outbox SET state=$2 WHERE id=$1 AND state='claimed' AND claim_epoch=$3", [key,outcome,this.owner.epoch]);
      requireThat(result.rowCount === 1, 'stale_claim');
    });
  }
}

/** Dormant foundation: no runtime caller or automatic migration/fallback. */
export class PostgresRepository extends Reader implements Repository {
  private closed = false;
  private readonly owners = new Set<Ownership>();
  private constructor(private readonly pool: Pool) { super(pool); }
  static async migrate(config: PostgresConfig): Promise<void> {
    const pool = createPool(config);
    try { const client = await pool.connect(); try { await migrate(client); } finally { client.release(); } }
    catch { throw databaseError(); } finally { await pool.end(); }
  }
  static async open(config: PostgresConfig): Promise<PostgresRepository> {
    const store = new PostgresRepository(createPool(config));
    try {
      const result = await query<{ version: number }>(store.pool, 'SELECT version FROM outpost_migrations ORDER BY version');
      requireThat(result.rows.length === schemaVersion && result.rows.every((row, i) => row.version === i + 1), 'unsupported_schema');
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  protected override check(): void { requireThat(!this.closed, 'closed_repository'); }
  async acquireOwnership(): Promise<CoordinatorOwnership> {
    this.check();
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw databaseError(); }
    try {
      const locked = await query<{ locked: boolean }>(client, 'SELECT pg_try_advisory_lock(174832,2) AS locked');
      requireThat(locked.rows[0]?.locked, 'coordinator_owned');
      await query(client, 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
      const state = await query<{ epoch: string }>(client, 'UPDATE outpost_writer SET epoch=epoch+1,dispatch_enabled=false WHERE singleton AND epoch<9007199254740991 RETURNING epoch');
      requireThat(state.rows[0], 'epoch_exhausted');
      await query(client, "UPDATE outpost_outbox SET state='unknown' WHERE state='claimed'");
      await query(client, 'COMMIT');
      const owner = new Ownership(safeInteger(state.rows[0].epoch, 1), client, this); this.owners.add(owner); return owner;
    } catch (error) { client.release(true); throw error; }
  }
  async transaction<T>(owner: CoordinatorOwnership, apply: (tx: RepositoryTransaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const signal = options.signal;
    checkCancellation(signal);
    this.check(); requireThat(owner instanceof Ownership && owner.store === this && owner.active, 'ownership_lost');
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw databaseError(); }
    const tx = new Transaction(client, owner, signal);
    try {
      checkCancellation(signal);
      await query(client, 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
      checkCancellation(signal);
      // Fresh statement snapshots after lock waits are required, regardless of role/database defaults.
      // This lock precedes all mutable reads and survives until commit; sequence allocation is NOT sufficient.
      const state = await query<{ epoch: string }>(client, 'SELECT epoch FROM outpost_writer WHERE singleton FOR UPDATE');
      requireThat(owner.active && state.rows[0] && safeInteger(state.rows[0].epoch) === owner.epoch, 'ownership_lost');
      tx.assertSettled();
      const result = await apply(tx); tx.assertSettled();
      // No await between this guard and COMMIT dispatch. Once sent, await owned
      // settlement: an abort cannot cancel a committed write or justify replay.
      checkCancellation(signal);
      await query(client, 'COMMIT'); return result;
    } catch (error) {
      await query(client, 'ROLLBACK').catch(() => undefined);
      if (error instanceof Fault && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)) {
        throw error.code === 'database_error' ? databaseError() : new Fault(error.code, error.code, error.status);
      }
      throw new Fault('transaction_failed', 'Transaction callback failed');
    } finally { tx.close(); client.release(); }
  }
  async snapshot(kinds: string[]): Promise<Snapshot> {
    this.check();
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw databaseError(); }
    const reader = new Reader(client);
    try {
      await query(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const cursor = await reader.cursor(), records: RecordValue[] = [];
      for (const kind of kinds) records.push(...await reader.list(kind));
      await query(client, 'COMMIT'); return { protocolVersion: 1, cursor, records };
    } catch (error) { await query(client, 'ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const owner of this.owners) await owner.release();
    await this.pool.end();
  }
}
