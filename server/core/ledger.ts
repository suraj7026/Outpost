import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, digest, id, now, requireThat } from './contracts.js';
import type { Command, Data, Event, Json, RecordValue } from './contracts.js';

export class Ledger {
  readonly db: DatabaseSync;
  constructor(readonly path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, aggregate_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_aggregate ON events(aggregate_id,cursor);
      CREATE TABLE IF NOT EXISTS commands(device_id TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(device_id,key));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','done','unknown')), created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); requireThat(!(result instanceof Promise), 'async_transaction'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<T = Data>(kind: string, key: string): RecordValue<T> | undefined {
    const row = this.db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(kind, key);
    return row ? { kind, id: key, revision: Number(row.revision), data: JSON.parse(String(row.data)) as T, updatedAt: String(row.updated_at) } : undefined;
  }
  need<T = Data>(kind: string, key: string): RecordValue<T> {
    const record = this.get<T>(kind, key); requireThat(record, 'not_found', `${kind} not found`); return record;
  }
  list<T = Data>(kind: string): RecordValue<T>[] {
    return this.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY updated_at DESC,id').all(kind).map(row => this.need<T>(kind, String(row.id)));
  }
  put<T extends object>(kind: string, key: string, expected: number, data: T, eventType = `${kind}.changed`): RecordValue<T> {
    const current = this.get(kind, key);
    requireThat((current?.revision ?? 0) === expected, 'stale_revision');
    const revision = expected + 1, updatedAt = now();
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').run(kind,key,revision,canonical(data),updatedAt);
    this.db.prepare('INSERT INTO events(id,aggregate_id,revision,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(id(),key,revision,eventType,canonical({ kind, id: key, revision, data, updatedAt }),updatedAt);
    return { kind, id: key, revision, data, updatedAt };
  }
  enqueue(topic: string, payload: Json, key = id()) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,topic,payload,created_at) VALUES(?,?,?,?)').run(key,topic,canonical(payload),now()); return key;
  }
  accept(command: Command, apply: () => Json): Json {
    return this.transaction(() => {
      const hash = digest({ type: command.type, aggregateId: command.aggregateId, expectedRevision: command.expectedRevision, payload: command.payload });
      const previous = this.db.prepare('SELECT digest,result FROM commands WHERE device_id=? AND key=?').get(command.deviceId,command.idempotencyKey);
      if (previous) { requireThat(previous.digest === hash,'idempotency_conflict'); return JSON.parse(String(previous.result)) as Json; }
      const result = apply();
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(command.deviceId,command.idempotencyKey,hash,canonical(result));
      return result;
    });
  }
  events(after = 0, limit = 200): Event[] {
    requireThat(Number.isSafeInteger(after) && after >= 0 && after <= this.cursor(), 'invalid_cursor');
    requireThat(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,'invalid_limit');
    return this.db.prepare('SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT ?').all(after,limit).map(row => ({
      protocolVersion: 1, eventId: String(row.id), feedCursor: Number(row.cursor), aggregateId: String(row.aggregate_id), aggregateRevision: Number(row.revision),
      type: String(row.type), occurredAt: String(row.created_at), payload: JSON.parse(String(row.payload)) as Json,
    }));
  }
  cursor() { return Number(this.db.prepare('SELECT COALESCE(MAX(cursor),0) AS n FROM events').get()?.n ?? 0); }
  snapshot(kinds: string[]) {
    return this.transaction(() => ({ protocolVersion: 1, cursor: this.cursor(), records: kinds.flatMap(kind => this.list(kind)) }));
  }
}
