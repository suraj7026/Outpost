import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Pool } from 'pg';
import { id } from '../core/contracts.js';
import type { Command } from '../core/contracts.js';
import { startPostgresFixture } from '../testing/postgres-fixture.js';
import type { PostgresFixture } from '../testing/postgres-fixture.js';
import { PostgresRepository } from './postgres.js';
import type { CoordinatorOwnership, RepositoryTransaction } from './contracts.js';
import { jsonText, parseJson, safeInteger, timestampText } from './conversion.js';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function command(): Command { return { protocolVersion: 1, commandId: id(), deviceId: id(), idempotencyKey: 'key', type: 'task.create', aggregateId: id(), expectedRevision: 0, payload: { title: 'Test' }, issuedAt: Date.now() }; }

describe('PostgresRepository actual private PostgreSQL', { concurrency: false }, () => {
  let fixture: PostgresFixture, admin: Pool, db: PostgresRepository, owner: CoordinatorOwnership;
  before(async () => {
    fixture = await startPostgresFixture(); console.log(`Private fixture: ${fixture.version}; Unix socket only`);
    admin = new Pool({ ...fixture.config, application_name: 'outpost-fixture-admin' });
    await Promise.all([PostgresRepository.migrate(fixture.config), PostgresRepository.migrate(fixture.config)]);
    await PostgresRepository.migrate(fixture.config);
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE outpost_records,outpost_events,outpost_commands,outpost_outbox');
    await admin.query('UPDATE outpost_writer SET watermark=0,dispatch_enabled=false');
    db = await PostgresRepository.open(fixture.config); owner = await db.acquireOwnership();
  });
  afterEach(async () => { await db?.close(); });
  after(async () => { await admin?.end(); await fixture?.stop(); });
  async function writerWaiting() {
    for (let i = 0; i < 200; i++) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name='outpost-storage' AND wait_event_type='Lock' AND query LIKE 'SELECT epoch%'");
      if (result.rowCount) return;
      await delay(5);
    }
    assert.fail('second real PostgreSQL transaction did not wait for writer lock');
  }
  test('explicit migration is repeatable; no ambient config or unverified TCP', async () => {
    assert.equal((await admin.query('SELECT count(*) FROM outpost_migrations')).rows[0].count, '1');
    await assert.rejects(PostgresRepository.open({ ...fixture.config, host: '127.0.0.1' }), /verified_tls_required/);
    await assert.rejects(PostgresRepository.open({ ...fixture.config, database: '' }), /invalid_database_config/);
  });
  test('extra connectionString cannot redirect the selected private fixture database', async () => {
    await db.transaction(owner, tx => tx.put('task','approved-database',0,{}));
    // Even the unfixed driver override can only select another database in this same private cluster.
    const config = { ...fixture.config, connectionString: `${fixture.config.host} template1` };
    const unconnected = new Client(config);
    assert.equal(unconnected.host,fixture.config.host); assert.equal(unconnected.database,'template1');
    const selected = await PostgresRepository.open(config);
    try { assert.equal((await selected.need('task','approved-database')).revision,1); }
    finally { await selected.close(); }
  });
  test('same-key concurrent commands apply once, digest conflict never applies', async () => {
    const cmd = command(), entered = barrier(), release = barrier(); let applications = 0;
    const first = db.transaction(owner, tx => tx.accept(cmd, async nested => {
      applications++; await nested.put('task',cmd.aggregateId,0,cmd.payload); await nested.enqueue('run',cmd.payload,'job'); entered.resolve(); await release.promise; return { accepted: true };
    }));
    await entered.promise;
    const second = db.transaction(owner, tx => tx.accept({ ...cmd, commandId: id(), issuedAt: cmd.issuedAt + 1 }, async () => { applications++; return {}; }));
    await writerWaiting(); release.resolve();
    assert.deepEqual(await first, await second); assert.equal(applications,1);
    await assert.rejects(db.transaction(owner, tx => tx.accept({ ...cmd, payload: { title: 'Changed' } }, async () => { applications++; return {}; })), /idempotency_conflict/);
    assert.equal(applications,1); assert.equal((await db.events()).length,1);
    assert.equal((await admin.query('SELECT count(*) FROM outpost_commands')).rows[0].count,'1');
  });
  test('concurrent compare-and-swap has exactly one winner', async () => {
    await db.transaction(owner, tx => tx.put('task','cas',0,{}));
    const results = await Promise.allSettled([1,2].map(value => db.transaction(owner, tx => tx.put('task','cas',1,{ value }))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
    assert.equal(results.filter(r => r.status === 'rejected' && /stale_revision/.test(String(r.reason))).length,1);
    assert.equal((await db.need('task','cas')).revision,2); assert.equal(await db.cursor(),2);
  });
  test('failure rolls back receipt, record, event, outbox and cursor', async () => {
    await assert.rejects(db.transaction(owner, async tx => {
      await tx.accept(command(), async nested => { await nested.put('task','rollback',0,{}); await nested.enqueue('run',{},'job'); return { accepted: true }; });
      throw Error('credential=do-not-leak');
    }), error => String(error).includes('Transaction callback failed') && !String(error).includes('do-not-leak'));
    for (const table of ['records','events','commands','outbox']) assert.equal((await admin.query(`SELECT count(*) FROM outpost_${table}`)).rows[0].count,'0');
    assert.equal(await db.cursor(),0);
  });
  test('database error is redacted, and all preceding writes roll back', async () => {
    await admin.query(`CREATE FUNCTION fixture_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'postgres://user:secret@example/db'; END $$;
      CREATE TRIGGER fixture_failure BEFORE INSERT ON outpost_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_event()`);
    try {
      await assert.rejects(db.transaction(owner, async tx => { await tx.enqueue('run',{}); await tx.put('task','failure',0,{}); }), error => String(error).includes('Database operation failed') && !String(error).includes('secret'));
      assert.equal(await db.get('task','failure'),undefined); assert.equal(await db.cursor(),0);
      assert.equal((await admin.query('SELECT count(*) FROM outpost_outbox')).rows[0].count,'0');
    } finally { await admin.query('DROP TRIGGER fixture_failure ON outpost_events; DROP FUNCTION fixture_reject_event()'); }
  });
  test('savepoints isolate rollback, suspend parent, and reject all closed handles', async () => {
    let outer!: RepositoryTransaction, child!: RepositoryTransaction;
    await db.transaction(owner, async tx => {
      outer = tx; await tx.put('task','outer',0,{});
      await assert.rejects(tx.savepoint(async nested => {
        child = nested; await nested.put('task','child',0,{}); await nested.enqueue('run',{},'child-job');
        await assert.rejects(tx.get('task','outer'), /savepoint_active/);
        throw Error('rollback child');
      }));
      await assert.rejects(child.put('task','closed-child',0,{}), /closed_transaction/);
      await tx.savepoint(async nested => { await nested.savepoint(async inner => { await inner.put('task','inner',0,{}); }); });
      await tx.put('task','after',0,{});
    });
    assert.equal(await db.get('task','child'),undefined); assert.equal(await db.cursor(),3);
    await assert.rejects(outer.get('task','outer'), /closed_transaction/);
    await assert.rejects(outer.enqueue('run',{}), /closed_transaction/);
  });
  for (const rollback of [false,true]) test(`overlapping commit/snapshot watermark ordering; first rollback=${rollback}`, async () => {
    const entered = barrier(), release = barrier();
    const first = db.transaction(owner, async tx => { await tx.put('task','a',0,{}); await tx.put('private','b',0,{}); entered.resolve(); await release.promise; if (rollback) throw Error('abort'); });
    const observed = first.then(() => 'committed', () => 'rolled-back');
    await entered.promise;
    const second = db.transaction(owner, tx => tx.put('task','c',0,{}));
    await writerWaiting();
    const before = await db.snapshot(['task','private']); assert.equal(before.cursor,0); assert.deepEqual(before.records,[]);
    release.resolve(); assert.equal(await observed, rollback ? 'rolled-back' : 'committed'); await second;
    const snapshot = await db.snapshot(['task','private']);
    assert.equal(snapshot.cursor,rollback ? 1 : 3); assert.equal(snapshot.records.length,snapshot.cursor);
    const events = await db.events(before.cursor); assert.deepEqual(events.map(e => e.feedCursor),rollback ? [1] : [1,2,3]);
    assert.deepEqual(await db.events(snapshot.cursor),[]);
    if (!rollback) { assert.equal((await db.events(1,1))[0]?.type,'private.changed'); assert.equal((await db.events(2,1))[0]?.aggregateId,'c'); }
  });
  test('ownership excludes second coordinator, defaults to hold, atomic claims fence stale completion', async () => {
    const other = await PostgresRepository.open(fixture.config);
    try {
      await assert.rejects(other.acquireOwnership(), /coordinator_owned/);
      await db.transaction(owner, async tx => { await tx.enqueue('run',{},'job'); await tx.enqueue('notice',{},'notice'); });
      await assert.rejects(db.transaction(owner, tx => tx.claimOutbox(['run'])), /recovery_hold/);
      await db.transaction(owner, tx => tx.setDispatchEnabled(true));
      const claims = await Promise.all([1,2].map(() => db.transaction(owner, tx => tx.claimOutbox(['run']))));
      assert.equal(claims.flat().length,1); assert.equal(claims.flat()[0]?.epoch,owner.epoch);
      await owner.release(); const successor = await other.acquireOwnership();
      assert.ok(successor.epoch > owner.epoch);
      await assert.rejects(db.transaction(owner, tx => tx.put('task','stale',0,{})), /ownership_lost/);
      await assert.rejects(other.transaction(successor, tx => tx.finishOutbox('job','done')), /stale_claim/);
      await assert.rejects(other.transaction(successor, tx => tx.claimOutbox(['notice'])), /recovery_hold/);
      const rows = (await admin.query('SELECT id,state FROM outpost_outbox ORDER BY id')).rows;
      assert.deepEqual(rows,[{ id: 'job',state: 'unknown' },{ id: 'notice',state: 'pending' }]);
    } finally { await other.close(); }
  });
  test('claim and operation revision roll back together; completion guards affected rows', async () => {
    await db.transaction(owner, async tx => { await tx.enqueue('run',{},'job'); await tx.setDispatchEnabled(true); });
    await assert.rejects(db.transaction(owner, async tx => { await tx.claimOutbox(['run']); await tx.put('operation','job',0,{ state: 'running' }); throw Error('abort'); }));
    assert.equal(await db.get('operation','job'),undefined);
    await db.transaction(owner, async tx => { assert.equal((await tx.claimOutbox(['run'])).length,1); await tx.put('operation','job',0,{ state: 'running' }); });
    await db.transaction(owner, async tx => { await tx.finishOutbox('job','done'); await tx.put('operation','job',1,{ state: 'handled' }); });
    await assert.rejects(db.transaction(owner, tx => tx.finishOutbox('job','done')), /stale_claim/);
  });
  test('ownership connection loss fences subsequent mutations and leaves claims unknown on takeover', async () => {
    await db.transaction(owner, async tx => { await tx.enqueue('run',{},'job'); await tx.setDispatchEnabled(true); await tx.claimOutbox(['run']); });
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=174832 AND objid=2 AND granted");
    for (let i = 0; i < 200 && owner.active; i++) await delay(5);
    assert.equal(owner.active,false);
    await assert.rejects(db.transaction(owner, tx => tx.finishOutbox('job','done')), /ownership_lost/);
    const successor = await db.acquireOwnership(); assert.ok(successor.epoch > owner.epoch);
    assert.equal((await admin.query("SELECT state FROM outpost_outbox WHERE id='job'")).rows[0].state,'unknown');
  });
  test('import-range counters preserve high watermark and reject overflow without partial commits', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    await admin.query('UPDATE outpost_writer SET watermark=$1',[String(max - 1)]);
    await db.transaction(owner, tx => tx.put('task','last',0,{ unicode: 'é日本', decimal: 0.25, max }));
    assert.equal(await db.cursor(),max); assert.equal((await db.events(max - 1))[0]?.feedCursor,max);
    await assert.rejects(db.transaction(owner, async tx => {
      await assert.rejects(tx.put('task','overflow',0,{}), /cursor_exhausted/);
    }), /failed_transaction/);
    assert.equal(await db.get('task','overflow'),undefined);
    await assert.rejects(admin.query('UPDATE outpost_writer SET watermark=$1',['9007199254740992']));
    await assert.rejects(db.transaction(owner, tx => tx.put('task','unsafe',max,{})), /invalid_integer/);
    assert.equal((await db.need('task','last')).data.max,max);
    await admin.query('UPDATE outpost_records SET revision=$1 WHERE id=$2',[String(max),'last']);
    assert.equal((await db.need('task','last')).revision,max);
    await assert.rejects(db.transaction(owner, tx => tx.put('task','last',max,{})), /invalid_integer/);
    await assert.rejects(admin.query('UPDATE outpost_records SET revision=$1 WHERE id=$2',['9223372036854775807','last']));
  });
  test('independent overlapping transactions never share rollback state', async () => {
    const entered = barrier(), release = barrier();
    const failing = db.transaction(owner, async tx => { await tx.put('task','failed',0,{}); entered.resolve(); await release.promise; throw Error('abort'); });
    const failure = assert.rejects(failing, /Transaction callback failed/);
    await entered.promise;
    const success = db.transaction(owner, tx => tx.put('task','survives',0,{}));
    await writerWaiting(); release.resolve(); await failure; await success;
    assert.equal(await db.get('task','failed'),undefined); assert.equal((await db.need('task','survives')).revision,1); assert.equal(await db.cursor(),1);
  });
  test('real SQL errors inside a savepoint can roll back without poisoning its parent', async () => {
    await admin.query(`CREATE FUNCTION fixture_reject_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='child' THEN RAISE EXCEPTION 'redacted'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_child_failure BEFORE INSERT ON outpost_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_child()`);
    try {
      await db.transaction(owner, async tx => {
        await tx.put('task','before',0,{});
        await assert.rejects(tx.savepoint(child => child.put('task','child',0,{})), /Database operation failed/);
        await tx.put('task','after',0,{});
      });
      assert.equal(await db.get('task','child'),undefined); assert.equal(await db.cursor(),2);
    } finally { await admin.query('DROP TRIGGER fixture_child_failure ON outpost_events; DROP FUNCTION fixture_reject_child()'); }
  });
  test('ownership loss during an open mutation transaction rolls back instead of reporting success', async () => {
    const entered = barrier(), release = barrier();
    const mutation = db.transaction(owner, async tx => { await tx.put('task','lost',0,{}); entered.resolve(); await release.promise; });
    const failure = assert.rejects(mutation, /closed_transaction/);
    await entered.promise;
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=174832 AND objid=2 AND granted");
    await owner.lost; release.resolve(); await failure;
    assert.equal(await db.get('task','lost'),undefined); assert.equal(await db.cursor(),0);
  });
  test('checked-out transaction connection loss is redacted, rolls back, and does not crash the process', async () => {
    const entered = barrier(), release = barrier();
    const mutation = db.transaction(owner, async tx => { await tx.put('task','disconnected',0,{}); entered.resolve(); await release.promise; });
    const failure = assert.rejects(mutation, error => String(error) === 'Error: Database operation failed');
    await entered.promise;
    const terminated = await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='outpost-storage' AND state='idle in transaction'");
    assert.equal(terminated.rowCount,1);
    // Exercise an error event between queries, not just a query promise rejection.
    await delay(25); release.resolve(); await failure;
    assert.equal(await db.get('task','disconnected'),undefined); assert.equal(await db.cursor(),0);
    assert.equal(owner.active,true);
    await db.transaction(owner, tx => tx.put('task','fresh-connection',0,{}));
    assert.equal(await db.cursor(),1);
  });
  test('outbox key conflict never silently changes durable intent', async () => {
    await db.transaction(owner, tx => tx.enqueue('run',{ value: 1 },'same'));
    await db.transaction(owner, tx => tx.enqueue('run',{ value: 1 },'same'));
    await assert.rejects(db.transaction(owner, tx => tx.enqueue('run',{ value: 2 },'same')), /outbox_conflict/);
  });
});

describe('PostgresRepository explicit transaction modes with nondefault database settings', { concurrency: false }, () => {
  let fixture: PostgresFixture, admin: Pool;
  before(async () => {
    fixture = await startPostgresFixture();
    admin = new Pool({ ...fixture.config, application_name: 'outpost-fixture-admin' });
    await admin.query("ALTER DATABASE postgres SET default_transaction_isolation = 'repeatable read'");
    // Verify defaults using a fresh connection, as all repository pools below will do.
    const fresh = new Pool(fixture.config);
    try { assert.equal((await fresh.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation,'repeatable read'); }
    finally { await fresh.end(); }
  });
  after(async () => { await admin?.end(); await fixture?.stop(); });
  async function waitForLocks(queryPrefix: string, count: number) {
    for (let i = 0; i < 200; i++) {
      const waiting = await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='outpost-storage' AND wait_event_type='Lock' AND query LIKE $1", [`${queryPrefix}%`]);
      if (Number(waiting.rows[0].count) === count) return;
      await delay(5);
    }
    assert.fail(`expected ${count} real transactions waiting on ${queryPrefix}`);
  }
  test('concurrent initial migrations see committed schema after advisory-lock wait under REPEATABLE READ default', async () => {
    const blocker = await admin.connect();
    await blocker.query('SELECT pg_advisory_lock(174832,1)');
    const migrations = Promise.allSettled([PostgresRepository.migrate(fixture.config),PostgresRepository.migrate(fixture.config)]);
    try {
      // Both sessions start their transactions before either is allowed to migrate.
      await waitForLocks('SELECT pg_advisory_xact_lock',2);
    } finally { await blocker.query('SELECT pg_advisory_unlock(174832,1)'); blocker.release(); }
    const results = await migrations;
    assert.deepEqual(results.map(result => result.status),['fulfilled','fulfilled']);
    assert.equal((await admin.query('SELECT count(*) FROM outpost_migrations')).rows[0].count,'1');
    await PostgresRepository.migrate(fixture.config);
  });
  test('overlapping same-key commands replay after writer-lock wait under REPEATABLE READ default', async () => {
    const db = await PostgresRepository.open(fixture.config), release = barrier();
    try {
      const owner = await db.acquireOwnership(), cmd = command(), entered = barrier(); let applications = 0;
      const first = db.transaction(owner, tx => tx.accept(cmd, async child => {
        applications++; await child.put('task',cmd.aggregateId,0,cmd.payload); entered.resolve(); await release.promise; return { accepted: true };
      }));
      await entered.promise;
      const second = db.transaction(owner, tx => tx.accept(cmd, async () => { applications++; return {}; }));
      const outcomes = Promise.allSettled([first,second]);
      try { await waitForLocks('SELECT epoch',1); } finally { release.resolve(); }
      const results = await outcomes;
      assert.deepEqual(results.map(result => result.status),['fulfilled','fulfilled']);
      assert.deepEqual(results[0],results[1]); assert.equal(applications,1);
      assert.equal(await db.cursor(),1); assert.equal((await db.events()).length,1);
      assert.equal((await admin.query('SELECT count(*) FROM outpost_commands')).rows[0].count,'1');
    } finally { release.resolve(); await db.close(); }
  });
  test('migration, ownership and writer transactions explicitly override read-only defaults on fresh connections', async () => {
    await admin.query('ALTER DATABASE postgres SET default_transaction_read_only = on');
    const fresh = new Pool(fixture.config);
    try { assert.equal((await fresh.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on'); }
    finally { await fresh.end(); }
    // Force a real migration write, not just opening an already-current schema.
    await admin.query('DROP TABLE outpost_outbox,outpost_commands,outpost_events,outpost_records,outpost_writer,outpost_migrations');
    await PostgresRepository.migrate(fixture.config);
    const db = await PostgresRepository.open(fixture.config);
    try {
      const owner = await db.acquireOwnership();
      await db.transaction(owner, tx => tx.put('task','explicit-write',0,{}));
      const snapshot = await db.snapshot(['task']);
      assert.equal(snapshot.cursor,1); assert.equal(snapshot.records[0]?.id,'explicit-write');
    } finally { await db.close(); }
  });
});

test('PostgresRepository allowlists endpoint and TLS options before the driver; no alternate endpoint contact', async t => {
  const captured: Pool['options'][] = [];
  // Intercept before pg can create/connect a socket, even if this regression fails.
  t.mock.method(Pool.prototype,'connect',function(this: Pool): never {
    captured.push(this.options); throw Error('fixture stopped before connection');
  });
  const ssl = { rejectUnauthorized: true as const, ca: 'fixture CA', checkServerIdentity: () => undefined, servername: 'unapproved.invalid', cert: 'unsupported', key: 'unsupported' };
  const config = { host: 'approved.invalid', port: 5432, database: 'approved', user: 'fixture', password: '', ssl,
    connectionString: 'postgresql://fixture@uncontacted.invalid/unapproved?sslmode=disable',
    sslnegotiation: 'direct', stream: () => { throw Error('unsupported stream invoked'); }, log: () => { throw Error('unsupported logger invoked'); } };
  await assert.rejects(PostgresRepository.open(config),/Database operation failed/);
  await assert.rejects(PostgresRepository.migrate(config),/Database operation failed/);
  assert.equal(captured.length,2);
  for (const options of captured) {
    assert.equal(options.connectionString,undefined);
    assert.equal('stream' in options,false); assert.equal('log' in options,false); assert.equal('sslnegotiation' in options,false);
    assert.notEqual(options.ssl,ssl);
    assert.deepEqual(options.ssl,{ rejectUnauthorized: true, ca: 'fixture CA' });
    // Exercise the installed driver's actual parsing without ever calling connect().
    const client = new Client(options);
    assert.equal(client.host,'approved.invalid'); assert.equal(client.database,'approved'); assert.equal(client.port,5432);
    assert.deepEqual(client.ssl,{ rejectUnauthorized: true, ca: 'fixture CA' });
  }
});

test('PostgreSQL/import conversion rejects unsafe counters and JSON numbers, preserves ISO text', () => {
  assert.equal(safeInteger('9007199254740991'),Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992','9223372036854775807','1e3','1.0','-1',NaN,Infinity,1.1]) assert.throws(() => safeInteger(value));
  for (const value of [NaN,Infinity,9007199254740992,{ nested: [9007199254740992] }]) assert.throws(() => jsonText(value));
  assert.throws(() => parseJson('{"n":9007199254740992}'));
  assert.throws(() => parseJson('{"n":9007199254740991.1}'));
  assert.throws(() => parseJson('{"n":0.123456789012345678901}'));
  assert.deepEqual(parseJson('{"n":1.00e2,"string":"123456789012345678901"}'),{ n: 100, string: '123456789012345678901' });
  const value = { unicode: 'é日本', fraction: 1.25, nested: [null,true] }; assert.deepEqual(parseJson(jsonText(value)),value);
  assert.equal(timestampText('2026-10-30T01:02:03.004Z'),'2026-10-30T01:02:03.004Z');
  for (const value of [new Date(),'2026-02-30T00:00:00.000Z','2026-10-30']) assert.throws(() => timestampText(value));
});
