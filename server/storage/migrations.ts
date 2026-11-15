import type { PoolClient } from 'pg';
import { requireThat } from '../core/contracts.js';

export const schemaVersion = 1;
// Two-int advisory keys are distinct from the session ownership key.
export async function migrate(client: PoolClient): Promise<void> {
  // A lock waiter must see the predecessor's committed migration on its next statement.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
  try {
    await client.query('SELECT pg_advisory_xact_lock(174832, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS outpost_migrations(version integer PRIMARY KEY, applied_at text NOT NULL)`);
    const versions = await client.query<{ version: number }>('SELECT version FROM outpost_migrations ORDER BY version');
    requireThat(versions.rows.every((row, i) => row.version === i + 1) && versions.rows.length <= schemaVersion, 'unsupported_schema');
    if (!versions.rows.length) {
      await client.query(`
        CREATE TABLE outpost_writer (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
          watermark bigint NOT NULL DEFAULT 0 CHECK(watermark BETWEEN 0 AND 9007199254740991),
          epoch bigint NOT NULL DEFAULT 0 CHECK(epoch BETWEEN 0 AND 9007199254740991),
          dispatch_enabled boolean NOT NULL DEFAULT false
        );
        INSERT INTO outpost_writer(singleton) VALUES(true);
        CREATE TABLE outpost_records (
          kind text NOT NULL, id text NOT NULL,
          revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
          data text NOT NULL CHECK(data::json IS NOT NULL), updated_at text NOT NULL,
          PRIMARY KEY(kind,id)
        );
        CREATE TABLE outpost_events (
          cursor bigint PRIMARY KEY CHECK(cursor BETWEEN 1 AND 9007199254740991),
          id text UNIQUE NOT NULL, aggregate_id text NOT NULL,
          revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
          type text NOT NULL, payload text NOT NULL CHECK(payload::json IS NOT NULL), created_at text NOT NULL
        );
        CREATE INDEX outpost_events_aggregate ON outpost_events(aggregate_id,cursor);
        CREATE TABLE outpost_commands (
          device_id text NOT NULL, key text NOT NULL, digest text NOT NULL,
          result text NOT NULL CHECK(result::json IS NOT NULL), PRIMARY KEY(device_id,key)
        );
        CREATE TABLE outpost_outbox (
          id text PRIMARY KEY, topic text NOT NULL, payload text NOT NULL CHECK(payload::json IS NOT NULL),
          state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','done','unknown')),
          created_at text NOT NULL, claim_epoch bigint CHECK(claim_epoch BETWEEN 1 AND 9007199254740991),
          CHECK(state != 'claimed' OR claim_epoch IS NOT NULL)
        );
        CREATE INDEX outpost_outbox_pending ON outpost_outbox(created_at,id) WHERE state='pending';
      `);
      await client.query('INSERT INTO outpost_migrations VALUES(1,$1)', [new Date().toISOString()]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
