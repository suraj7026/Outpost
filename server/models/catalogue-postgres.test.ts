import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { startPostgresFixture, type PostgresFixture } from '../testing/postgres-fixture.js';
import { PostgresRepository } from '../storage/postgres.js';
import type { CoordinatorOwnership } from '../storage/contracts.js';
import { catalogueKey, type CatalogueIdentity, type CatalogueSnapshot } from './catalogue-types.js';
import { CatalogueService } from './catalogue.js';
import { PostgresCatalogueRepository } from './catalogue-postgres.js';

const identity: CatalogueIdentity = { kind: 'local-self-hosted', accountId: 'fixture', baseUrl: 'http://localhost:11434' };
const key = catalogueKey(identity);
const otherKey = catalogueKey({ ...identity, accountId: 'other' });
const signal = () => AbortSignal.timeout(20_000);
function snapshot(version = 1): CatalogueSnapshot { return { schemaVersion: 1, version, identity, refreshedAt: 100, models: [] }; }
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

// Only the private fixture is accessed. HTTP below is injected, never fetched.
describe('PostgresCatalogueRepository actual private PostgreSQL', { concurrency: false }, () => {
  let fixture: PostgresFixture, admin: Pool, db: PostgresRepository, owner: CoordinatorOwnership;
  let first: PostgresCatalogueRepository, second: PostgresCatalogueRepository;
  before(async () => {
    fixture = await startPostgresFixture(); console.log(`Private catalogue fixture: ${fixture.version}; Unix socket only`);
    admin = new Pool({ ...fixture.config, application_name: 'catalogue-fixture-admin' });
    await PostgresRepository.migrate(fixture.config);
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE outpost_records,outpost_events,outpost_commands,outpost_outbox');
    await admin.query('UPDATE outpost_writer SET watermark=0,dispatch_enabled=false');
    db = await PostgresRepository.open(fixture.config); owner = await db.acquireOwnership();
    first = new PostgresCatalogueRepository(db, owner); second = new PostgresCatalogueRepository(db, owner);
  });
  afterEach(async () => { await db?.close(); });
  after(async () => { await admin?.end(); await fixture?.stop(); });
  async function waitForLock(queryPrefix: string, count = 1) {
    for (let i = 0; i < 200; i++) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name='outpost-storage' AND wait_event_type='Lock' AND query LIKE $1", [`${queryPrefix}%`]);
      if ((result.rowCount ?? 0) >= count) return;
      await delay(5);
    }
    assert.fail(`real PostgreSQL transaction did not wait: ${queryPrefix}`);
  }
  async function seed() {
    const reserved = await first.beginRefresh(key, signal());
    assert.equal(await first.publish(key, reserved.generation, snapshot(), signal()), true);
    return snapshot();
  }
  async function holdWriter() {
    const entered = barrier(), release = barrier();
    const pending = db.transaction(owner, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    return { release: release.resolve, pending };
  }
  async function holdCatalogueWrite() {
    const lock = await admin.connect();
    await lock.query('SELECT pg_advisory_lock(901,31)');
    await admin.query(`CREATE FUNCTION fixture_catalogue_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(901,31); RETURN NEW; END $$;
      CREATE TRIGGER fixture_catalogue_wait BEFORE INSERT ON outpost_events FOR EACH ROW
      WHEN (NEW.type='models.catalogue.changed') EXECUTE FUNCTION fixture_catalogue_wait()`);
    return async () => {
      await lock.query('SELECT pg_advisory_unlock(901,31)'); lock.release();
      await admin.query('DROP TRIGGER fixture_catalogue_wait ON outpost_events; DROP FUNCTION fixture_catalogue_wait()');
    };
  }

  test('two instances reserve atomic durable fences and last-good; only latest can publish', async () => {
    assert.equal(await first.load(key, signal()), null);
    const good = await seed();
    const held = await holdWriter();
    const reservations = [first.beginRefresh(key, signal()), second.beginRefresh(key, signal())];
    try { await waitForLock('SELECT epoch', 2); } finally { held.release(); }
    await held.pending;
    const results = await Promise.all(reservations);
    results.sort((a, b) => (JSON.parse(a.generation) as { fence: number }).fence - (JSON.parse(b.generation) as { fence: number }).fence);
    assert.deepEqual(results.map(value => value.snapshot), [good, good]);
    assert.notEqual(results[0]!.generation, results[1]!.generation);
    assert.equal(await first.publish(key, results[0]!.generation, snapshot(2), signal()), false);
    assert.equal(await second.publish(key, results[1]!.generation, snapshot(2), signal()), true);
    assert.deepEqual(await first.load(key, signal()), snapshot(2));
  });

  test('concurrent publication checks exact prior version; replay has one winner', async () => {
    const reserved = await first.beginRefresh(key, signal());
    const results = await Promise.all([first.publish(key, reserved.generation, snapshot(), signal()), second.publish(key, reserved.generation, snapshot(), signal())]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await second.publish(key, reserved.generation, snapshot(2), signal()), false);
    assert.deepEqual(await first.load(key, signal()), snapshot());
  });

  test('scope, canonical key, prior version, fence, owner epoch and malformed snapshots fail closed', async () => {
    await seed(); const reserved = await first.beginRefresh(key, signal());
    const token = JSON.parse(reserved.generation) as { key: string; fence: number; priorVersion: number; ownerEpoch: number };
    for (const changed of [{ ...token, key: otherKey }, { ...token, fence: token.fence + 1 }, { ...token, priorVersion: 0 }, { ...token, ownerEpoch: owner.epoch + 1 }]) {
      assert.equal(await first.publish(key, JSON.stringify(changed), snapshot(2), signal()), false);
    }
    assert.equal(await first.publish(key, reserved.generation, snapshot(3), signal()), false);
    assert.equal(await first.publish(key, 'not-json', snapshot(2), signal()), false);
    await assert.rejects(first.publish(otherKey, reserved.generation, snapshot(2), signal()), /catalogue_scope_mismatch/);
    await assert.rejects(first.load(' ' + key, signal()), /catalogue_invalid_key/);
    await assert.rejects(first.beginRefresh('["direct-cloud","account","https://user:secret@ollama.com"]', signal()), /catalogue_invalid_key/);
    await assert.rejects(first.publish(key, reserved.generation, { ...snapshot(2), version: NaN }, signal()), /catalogue_invalid_snapshot/);
    assert.deepEqual(await second.load(key, signal()), snapshot());
    assert.equal(await first.publish(key, reserved.generation, snapshot(2), signal()), true);
  });

  test('pre-aborted methods perform no work; queued cancellation drains before returning and never writes', async () => {
    const reserved = await first.beginRefresh(key, signal()); const controller = new AbortController(); controller.abort();
    await assert.rejects(first.load(key, controller.signal), /transaction_cancelled/);
    await assert.rejects(first.beginRefresh(key, controller.signal), /transaction_cancelled/);
    await assert.rejects(first.publish(key, reserved.generation, snapshot(), controller.signal), /transaction_cancelled/);
    const before = await db.cursor();
    for (const operation of ['reserve', 'publish'] as const) {
      const held = await holdWriter(), abort = new AbortController(); let settled = false;
      const pending = operation === 'reserve' ? second.beginRefresh(key, abort.signal) : second.publish(key, reserved.generation, snapshot(), abort.signal);
      const rejected = assert.rejects(pending, /transaction_cancelled/).finally(() => { settled = true; });
      try {
        await waitForLock('SELECT epoch'); abort.abort(); await delay(20);
        assert.equal(settled, false, 'adapter must not detach pending transaction on cancellation');
      } finally { held.release(); }
      await held.pending; await rejected;
    }
    assert.equal(await db.cursor(), before); assert.equal(await first.load(key, signal()), null);
    assert.equal(await first.publish(key, reserved.generation, snapshot(), signal()), true);
  });

  for (const operation of ['reserve', 'publish'] as const) test(`cancellation within ${operation} rolls back record, event and cursor before settlement`, async () => {
    const good = await seed(); const reserved = await first.beginRefresh(key, signal()); const before = await db.cursor();
    const release = await holdCatalogueWrite(), abort = new AbortController();
    const pending = operation === 'reserve' ? second.beginRefresh(key, abort.signal) : second.publish(key, reserved.generation, snapshot(2), abort.signal);
    const rejected = assert.rejects(pending, /transaction_cancelled/);
    try { await waitForLock('INSERT INTO outpost_events'); abort.abort(); }
    finally { await release(); }
    await rejected;
    assert.equal(await db.cursor(), before); assert.deepEqual(await first.load(key, signal()), good);
    assert.equal(await first.publish(key, reserved.generation, snapshot(2), signal()), true);
  });

  test('ownership connection loss during publication rolls back; successor reopens last-good', async () => {
    const good = await seed(); const reserved = await first.beginRefresh(key, signal());
    const release = await holdCatalogueWrite();
    const pending = second.publish(key, reserved.generation, snapshot(2), signal());
    const rejected = assert.rejects(pending, /ownership_lost|closed_transaction/);
    try {
      await waitForLock('INSERT INTO outpost_events');
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=174832 AND objid=2 AND granted");
      await owner.lost; assert.equal(owner.active, false);
    } finally { await release(); }
    await rejected;
    await assert.rejects(first.beginRefresh(key, signal()), /ownership_lost/);
    owner = await db.acquireOwnership(); second = new PostgresCatalogueRepository(db, owner);
    assert.deepEqual(await second.load(key, signal()), good);
    assert.equal(await second.publish(key, reserved.generation, snapshot(2), signal()), false);
  });

  test('repository close/reopen retains last-good and abandoned fences; old-owner tokens cannot publish', async () => {
    const good = await seed(); const abandoned = await second.beginRefresh(key, signal());
    const oldEpoch = owner.epoch;
    await db.close(); db = await PostgresRepository.open(fixture.config); owner = await db.acquireOwnership();
    assert.ok(owner.epoch > oldEpoch); first = new PostgresCatalogueRepository(db, owner);
    assert.deepEqual(await first.load(key, signal()), good);
    assert.equal(await first.publish(key, abandoned.generation, snapshot(2), signal()), false);
    const next = await first.beginRefresh(key, signal()); assert.notEqual(next.generation, abandoned.generation);
    assert.deepEqual(next.snapshot, good); assert.equal(await first.publish(key, next.generation, snapshot(2), signal()), true);
  });

  test('abort during actual COMMIT awaits settlement and never claims committed publication rolled back', async () => {
    const reserved = await first.beginRefresh(key, signal()); const abort = new AbortController();
    const lock = await admin.connect();
    await admin.query(`CREATE FUNCTION fixture_catalogue_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(901,32); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER fixture_catalogue_commit AFTER INSERT ON outpost_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_catalogue_commit()`);
    await lock.query('SELECT pg_advisory_lock(901,32)');
    let settled = false;
    const pending = first.publish(key, reserved.generation, snapshot(), abort.signal).finally(() => { settled = true; });
    try {
      await waitForLock('COMMIT'); abort.abort(); await delay(20);
      assert.equal(settled, false);
      assert.equal((await db.need<{ snapshot: CatalogueSnapshot | null }>('models.catalogue', key)).data.snapshot, null);
    } finally { await lock.query('SELECT pg_advisory_unlock(901,32)'); lock.release(); }
    try {
      assert.equal(await pending, true); assert.equal(abort.signal.aborted, true);
      assert.deepEqual(await second.load(key, signal()), snapshot());
    } finally { await admin.query('DROP TRIGGER fixture_catalogue_commit ON outpost_events; DROP FUNCTION fixture_catalogue_commit()'); }
  });

  test('incomplete discovery preserves durable last-good and stores no injected credential', async () => {
    const good = await seed();
    const service = new CatalogueService({ identity, repository: second, credential: 'fixture-credential-never-persist',
      transport: async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { capabilities: 42 } : { data: [{ id: 'model' }] })) });
    const result = await service.refresh({ force: true });
    assert.equal(result.status, 'incomplete'); assert.deepEqual(result.snapshot, good);
    assert.deepEqual(await first.load(key, signal()), good);
    const persisted = await admin.query('SELECT data FROM outpost_records UNION ALL SELECT payload AS data FROM outpost_events');
    assert.ok(!JSON.stringify(persisted.rows).includes('fixture-credential-never-persist'));
  });

  for (const cancel of [false, true]) test(`cross-instance service refresh race retains winning snapshot; cancel old=${cancel}`, async () => {
    await seed(); const entered = barrier(), release = barrier();
    const old = new CatalogueService({ identity, repository: first, transport: async (_url, init) => {
      if (init?.method === 'POST') { entered.resolve(); await release.promise; return new Response(JSON.stringify({ capabilities: ['completion'] })); }
      return new Response(JSON.stringify({ data: [{ id: 'old' }] }));
    } });
    const pending = old.refresh({ force: true }); await entered.promise;
    const current = new CatalogueService({ identity, repository: second, transport: async () => new Response(JSON.stringify({ data: [] })) });
    const winner = await current.refresh({ force: true });
    if (cancel) old.cancel(); release.resolve();
    assert.equal((await pending).status, cancel ? 'cancelled' : 'superseded'); assert.equal(winner.status, 'fresh');
    assert.deepEqual(await second.load(key, signal()), winner.snapshot); assert.equal(winner.snapshot?.version, 2);
  });

  test('corrupt durable state is rejected instead of silently returning an empty cache; fence overflow fails closed', async () => {
    await seed();
    for (const data of [
      { schemaVersion: 2, fence: 1, snapshot: snapshot() },
      { schemaVersion: 1, fence: 1, snapshot: { ...snapshot(), identity: { ...identity, accountId: 'other' } } },
    ]) {
      await admin.query('UPDATE outpost_records SET data=$1 WHERE kind=$2 AND id=$3', [JSON.stringify(data), 'models.catalogue', key]);
      await assert.rejects(first.load(key, signal()), /catalogue_invalid_state|catalogue_scope_mismatch/);
      await assert.rejects(first.beginRefresh(key, signal()), /catalogue_invalid_state|catalogue_scope_mismatch/);
    }
    await admin.query('UPDATE outpost_records SET data=$1 WHERE kind=$2 AND id=$3', [JSON.stringify({ schemaVersion: 1, fence: Number.MAX_SAFE_INTEGER, snapshot: snapshot() }), 'models.catalogue', key]);
    const before = await db.cursor(); await assert.rejects(first.beginRefresh(key, signal()), /catalogue_fence_exhausted/);
    assert.equal(await db.cursor(), before); assert.deepEqual(await second.load(key, signal()), snapshot());
  });
});
