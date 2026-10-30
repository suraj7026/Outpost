import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { safeInteger, timestampText } from '../../storage/conversion.js';
import { check, limits } from './contracts.js';
import type { SourceManifest } from './contracts.js';
import { hashJson, RowHash, strictJson, sha, byteOrder, uuid, hashPattern } from './manifest.js';

// Pinned to the legacy Ledger v1 schema. Unknown objects are not silently omitted.
const schemaSql = [
  'CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  'CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL, PRIMARY KEY(kind,id))',
  'CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, aggregate_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL)',
  'CREATE INDEX events_aggregate ON events(aggregate_id,cursor)',
  'CREATE TABLE commands(device_id TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(device_id,key))',
  "CREATE TABLE outbox(id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','done','unknown')), created_at TEXT NOT NULL)",
  'CREATE TABLE sqlite_sequence(name,seq)',
];
const ftsSql = [
  'CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, project UNINDEXED, identity_id UNINDEXED, text)',
  "CREATE TABLE 'memory_search_config'(k PRIMARY KEY, v) WITHOUT ROWID",
  "CREATE TABLE 'memory_search_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3)",
  "CREATE TABLE 'memory_search_data'(id INTEGER PRIMARY KEY, block BLOB)",
  "CREATE TABLE 'memory_search_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
  "CREATE TABLE 'memory_search_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
];
const normalize = (sql: string) => sql.replace(/^CREATE (TABLE|INDEX|VIRTUAL TABLE) IF NOT EXISTS /, 'CREATE $1 ');
export function noSidecars(database: string) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let exists = true;
    try { lstatSync(database + suffix); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e;
    }
    check(!exists, 'source_not_frozen');
  }
}
function text(value: unknown): string { check(typeof value === 'string', 'invalid_text'); return value; }
function integer(value: unknown, minimum = 0) { check(typeof value === 'bigint', 'invalid_integer'); return safeInteger(value.toString(), minimum); }
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_record_data');
  return value as Record<string, unknown>;
}
export interface BlobRecord { id: string; size: number; hash: string }
export interface UploadRecord extends BlobRecord { offset: number; state: string }

/** Only the private byte-for-byte inspection copy is opened; no Ledger constructor. */
export function inventorySqlite(database: string) {
  const db = new DatabaseSync(database, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    check(db.prepare('PRAGMA encoding').get()?.encoding === 'UTF-8', 'unsupported_sqlite_encoding');
    check(db.prepare('PRAGMA user_version').get()?.user_version === 0 && db.prepare('PRAGMA application_id').get()?.application_id === 0, 'unsupported_schema_version');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name COLLATE BINARY').all();
    const derivedMemoryIndex = schema.some(row => row.name === 'memory_search');
    const expected = [...schemaSql, ...(derivedMemoryIndex ? ftsSql : [])].map(normalize).sort(byteOrder);
    const actual = schema.filter(row => row.sql !== null).map(row => normalize(text(row.sql))).sort(byteOrder);
    check(JSON.stringify(actual) === JSON.stringify(expected), 'unsupported_schema');
    const autoindexes = new Set(['sqlite_autoindex_records_1', 'sqlite_autoindex_events_1', 'sqlite_autoindex_commands_1', 'sqlite_autoindex_outbox_1']);
    for (const row of schema.filter(row => row.sql === null)) check(row.type === 'index' && autoindexes.delete(text(row.name)), 'unsupported_schema');
    check(autoindexes.size === 0, 'unsupported_schema');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    check(integrity.length === 1 && integrity[0]?.integrity_check === 'ok', 'sqlite_integrity');
    const migrationStatement = db.prepare('SELECT version,applied_at FROM migrations'); migrationStatement.setReadBigInts(true);
    const migration = migrationStatement.all();
    check(migration.length === 1 && integer(migration[0]?.version, 1) === 1, 'unsupported_schema_version');
    timestampText(migration[0]?.applied_at);
    const tables: SourceManifest['tables'] = {}, kinds = new Map<string, number>(), tombstones = new RowHash(), uploadsHash = new RowHash();
    const artifacts: BlobRecord[] = [], uploads: UploadRecord[] = [];
    const outboxStates: Record<string, number> = { pending: 0, claimed: 0, done: 0, unknown: 0 };
    let min = 0, max = 0;
    const definitions = [
      ['records', 'kind COLLATE BINARY,id COLLATE BINARY', 'data'],
      ['events', 'cursor', 'payload'], ['commands', 'device_id COLLATE BINARY,key COLLATE BINARY', 'result'],
      ['outbox', 'id COLLATE BINARY', 'payload'], ['migrations', 'version', ''],
    ] as const;
    for (const [table, order, jsonColumn] of definitions) {
      const textColumns: Record<string, string[]> = {
        records: ['kind', 'id', 'data', 'updated_at'], events: ['id', 'aggregate_id', 'type', 'payload', 'created_at'],
        commands: ['device_id', 'key', 'digest', 'result'], outbox: ['id', 'topic', 'payload', 'state', 'created_at'], migrations: ['applied_at'],
      };
      const byteColumns = textColumns[table]!.map(column => `CAST(${column} AS BLOB) AS __bytes_${column}`);
      const statement = db.prepare(`SELECT *,${byteColumns.join(',')} FROM ${table} ORDER BY ${order}`); statement.setReadBigInts(true);
      const hashes = new RowHash();
      for (const row of statement.iterate()) {
        const raw: Record<string, unknown> = {};
        for (const column of textColumns[table]!) {
          const bytes = row[`__bytes_${column}`];
          check(bytes instanceof Uint8Array && Buffer.from(bytes).equals(Buffer.from(text(row[column]), 'utf8')), 'invalid_utf8');
        }
        for (const [key, value] of Object.entries(row)) if (!key.startsWith('__bytes_')) {
          // SQLite INTEGER affinity is not a storage-class guarantee; validate by column.
          raw[key] = key === 'revision' || key === 'cursor' || key === 'version' ? integer(value, 1) : text(value);
        }
        for (const key of ['created_at', 'updated_at', 'applied_at']) if (key in raw) timestampText(raw[key]);
        let parsed: unknown;
        if (jsonColumn) { const json = text(raw[jsonColumn]); check(Buffer.byteLength(json) <= limits.json, 'source_capacity'); parsed = strictJson(json); }
        const semantic = jsonColumn ? { ...raw, [jsonColumn]: parsed } : raw;
        hashes.add(raw, semantic);
        if (table === 'records') {
          const kind = text(raw.kind), id = text(raw.id), data = object(parsed);
          const kindHash = sha(kind); kinds.set(kindHash, (kinds.get(kindHash) ?? 0) + 1);
          if (kind === 'memory' && data.forgotten === true) tombstones.add(raw, semantic);
          if (kind === 'artifact' || kind === 'upload') {
            check(uuid(id) && hashPattern.test(text(data.hash)), 'invalid_artifact_metadata');
            const entry = { id, size: safeInteger(data.size), hash: text(data.hash) };
            check(entry.size <= limits.file, 'source_capacity');
            if (kind === 'artifact') artifacts.push(entry);
            else {
              const offset = safeInteger(data.offset), state = text(data.state);
              check(offset <= entry.size && (state === 'incomplete' || state === 'complete'), 'invalid_upload');
              uploads.push({ ...entry, offset, state }); uploadsHash.add(raw, semantic);
            }
            check(artifacts.length + uploads.length <= limits.files, 'source_capacity');
          }
        } else if (table === 'events') {
          const cursor = raw.cursor as number; if (!min) min = cursor; max = cursor;
        } else if (table === 'commands') check(hashPattern.test(text(raw.digest)), 'invalid_receipt_digest');
        else if (table === 'outbox') { const state = text(raw.state); check(Object.hasOwn(outboxStates, state), 'invalid_outbox_state'); outboxStates[state]!++; }
      }
      tables[table] = hashes.finish();
    }
    // sqlite_sequence is allocator metadata, not the legacy MAX(cursor) watermark.
    const sequenceStatement = db.prepare('SELECT name,seq FROM sqlite_sequence'); sequenceStatement.setReadBigInts(true);
    const sequence = sequenceStatement.all();
    check(sequence.length <= 1 && sequence.every(row => row.name === 'events'), 'unsupported_sequence');
    for (const row of sequence) integer(row.seq);
    const tombstoneSummary = tombstones.finish(), uploadSummary = uploadsHash.finish();
    return {
      schema: { version: 1 as const, hash: hashJson(schema.map(row => ({ ...row }))), derivedMemoryIndex }, tables,
      recordsByKind: [...kinds].sort(([a], [b]) => byteOrder(a, b)).map(([kindHash, count]) => ({ kindHash, count })),
      events: { min, max, count: tables.events!.count, watermark: max }, outboxStates,
      tombstones: { count: tombstoneSummary.count, hash: tombstoneSummary.rawHash },
      uploads: { count: uploadSummary.count, hash: uploadSummary.rawHash }, artifacts, uploadRecords: uploads,
    };
  } finally { db.close(); }
}
