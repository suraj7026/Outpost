import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { requireThat } from '../core/contracts.js';
import { PostgresRepository } from '../storage/postgres.js';
import type { CoordinatorOwnership } from '../storage/contracts.js';
import { startPostgresFixture } from '../testing/postgres-fixture.js';
import type { PostgresFixture } from '../testing/postgres-fixture.js';
import { ApprovedSkills, SKILL_LIMITS, skillHash } from './skills.js';
import type { SkillManifest, SkillPin } from './skills.js';
import { AuthorizedSkillRegistryWriter, PostgresSkillRegistry, SKILL_REGISTRY_KIND, SKILL_REGISTRY_AUDIT_KIND } from './skills-postgres.js';
import type { SkillRegistryChange } from './skills-postgres.js';

const scope = 'owner/project';
const pin: SkillPin = { rootId: 'approved', directory: 'sample-v1', name: 'sample', version: '1', digest: 'a'.repeat(64) };
const pin2: SkillPin = { ...pin, directory: 'sample-v2', version: '2', digest: 'b'.repeat(64) };
const authorization = { actorId: 'owner-device', authorizationId: 'gate-decision-1' };
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('skills-postgres: private real PostgreSQL registry', { concurrency: false }, () => {
  let fixture: PostgresFixture, admin: Pool, db: PostgresRepository, owner: CoordinatorOwnership;
  let registry: PostgresSkillRegistry, writer: AuthorizedSkillRegistryWriter;
  before(async () => {
    fixture = await startPostgresFixture(); console.log(`Private skills fixture: ${fixture.version}; Unix socket only`);
    admin = new Pool({ ...fixture.config, application_name: 'outpost-skills-fixture-admin' });
    await PostgresRepository.migrate(fixture.config);
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE outpost_records,outpost_events,outpost_commands,outpost_outbox');
    await admin.query('UPDATE outpost_writer SET watermark=0,dispatch_enabled=false');
    db = await PostgresRepository.open(fixture.config); owner = await db.acquireOwnership();
    registry = new PostgresSkillRegistry(db, scope);
    writer = new AuthorizedSkillRegistryWriter(db, owner, scope, () => authorization);
  });
  afterEach(async () => { await db?.close(); });
  after(async () => { await admin?.end(); await fixture?.stop(); });
  function change(operation: SkillRegistryChange['operation'], expectedRevision: number, selected = pin): SkillRegistryChange {
    return { scope, expectedRevision, operation, pin: selected };
  }
  async function waiting(queryPrefix: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name='outpost-storage' AND wait_event_type='Lock' AND query LIKE $1", [queryPrefix + '%']);
      if (result.rowCount) return;
      await delay(5);
    }
    assert.fail('expected private PostgreSQL lock wait was not observed');
  }
  test('scope-bound atomic reads, strict metadata-only requests, trusted per-write authorization and audit', async () => {
    assert.deepEqual(await registry.read(scope), { scope, revision: 0, entries: [] });
    await assert.rejects(registry.read('other'), /skill_scope_mismatch/);
    await assert.rejects(writer.writeAuthorized({ ...change('approve', 0), scope: 'other' }), /skill_scope_mismatch/);
    const unsafe = { ...change('approve', 0), instructions: 'must never persist', credentials: 'no' };
    await assert.rejects(writer.writeAuthorized(unsafe), /skill_registry_invalid/);
    assert.equal(await writer.writeAuthorized(change('approve', 0)), 1);
    assert.equal(await writer.writeAuthorized(change('activate', 1)), 2);
    const snapshot = await registry.read(scope);
    assert.deepEqual(snapshot.entries, [{ ...pin, approved: true, revoked: false, active: true }]);
    snapshot.entries.length = 0;
    assert.equal((await registry.read(scope)).entries.length, 1);
    assert.deepEqual(await new PostgresSkillRegistry(db, 'other').read('other'), { scope: 'other', revision: 0, entries: [] });
    const audit = await db.list(SKILL_REGISTRY_AUDIT_KIND);
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.find(record => record.data.revision === 2)?.data,
      { schemaVersion: 1, ...change('activate', 1), revision: 2, ...authorization, ownerEpoch: owner.epoch });
    assert.deepEqual((await db.events()).map(event => event.type), ['op007.skills.registry.changed', 'op007.skills.registry.audited', 'op007.skills.registry.changed', 'op007.skills.registry.audited']);
  });
  test('authorization is rechecked under the writer lock, denied writes have no state/audit/events', async () => {
    const entered = barrier(), release = barrier(); let allowed = true, calls = 0;
    writer = new AuthorizedSkillRegistryWriter(db, owner, scope, request => {
      calls++; assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.pin));
      requireThat(allowed, 'skill_write_unauthorized'); return authorization;
    });
    const blocker = db.transaction(owner, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = writer.writeAuthorized(change('approve', 0));
    const refused = assert.rejects(pending, /skill_write_unauthorized/);
    try { await waiting('SELECT epoch'); allowed = false; assert.equal(calls, 0); } finally { release.resolve(); }
    await blocker; await refused;
    assert.equal(calls, 1); assert.equal(await db.cursor(), 0); assert.deepEqual(await db.list(SKILL_REGISTRY_AUDIT_KIND), []);
    assert.equal((await registry.read(scope)).revision, 0);
  });
  test('pending requests snapshot caller-owned pin, scope and revision before awaiting', async () => {
    const mutable = { ...change('approve', 0), pin: { ...pin } };
    const pending = writer.writeAuthorized(mutable);
    mutable.pin.digest = pin2.digest; mutable.scope = 'other'; mutable.expectedRevision = 42;
    assert.equal(await pending, 1);
    assert.equal((await registry.read(scope)).entries[0]?.digest, pin.digest);
  });
  test('concurrent CAS has one winner, stale replay and mismatched pins fail closed', async () => {
    const results = await Promise.allSettled([pin, pin2].map(selected => writer.writeAuthorized(change('approve', 0, selected))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && /stale_revision/.test(String(result.reason))).length, 1);
    const winner = (await registry.read(scope)).entries[0]!;
    const winnerPin = winner.version === pin.version ? pin : pin2;
    await assert.rejects(writer.writeAuthorized(change('approve', 0, winnerPin)), /stale_revision/);
    for (const mismatch of [{ ...winner, digest: 'c'.repeat(64) }, { ...winner, directory: 'changed' }, { ...winner, rootId: 'other-root' }]) {
      const { approved: _approved, active: _active, revoked: _revoked, ...selected } = mismatch;
      await assert.rejects(writer.writeAuthorized(change('activate', 1, selected)), /skill_pin_mismatch/);
    }
    assert.equal((await registry.read(scope)).revision, 1); assert.equal(await db.cursor(), 2);
  });
  test('concurrent active rotations retain old pins and never publish two active versions', async () => {
    await writer.writeAuthorized(change('approve', 0)); await writer.writeAuthorized(change('approve', 1, pin2));
    const results = await Promise.allSettled([pin, pin2].map(selected => writer.writeAuthorized(change('activate', 2, selected))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const current = await registry.read(scope);
    assert.equal(current.revision, 3); assert.equal(current.entries.filter(entry => entry.active).length, 1);
    assert.equal(current.entries.length, 2);
    const active = current.entries.find(entry => entry.active)!;
    const selected = active.version === pin.version ? pin : pin2;
    await writer.writeAuthorized(change('deactivate', 3, selected));
    assert.equal((await registry.read(scope)).entries.filter(entry => entry.active).length, 0);
  });
  test('revocation and logical deletion are terminal and preserve immutable historical identity across reopen', async () => {
    await writer.writeAuthorized(change('approve', 0)); await writer.writeAuthorized(change('approve', 1, pin2));
    await writer.writeAuthorized(change('revoke', 2)); await writer.writeAuthorized(change('delete', 3, pin2));
    const oldWriter = writer, oldEpoch = owner.epoch;
    await db.close(); db = await PostgresRepository.open(fixture.config); owner = await db.acquireOwnership();
    registry = new PostgresSkillRegistry(db, scope); writer = new AuthorizedSkillRegistryWriter(db, owner, scope, () => authorization);
    assert.ok(owner.epoch > oldEpoch);
    assert.equal((await registry.read(scope)).revision, 4);
    assert.deepEqual((await registry.read(scope)).entries, [{ ...pin, approved: false, revoked: true, active: false }]);
    await assert.rejects(oldWriter.writeAuthorized(change('approve', 4, pin2)), /closed_repository|ownership_lost/);
    for (const selected of [pin, pin2]) {
      await assert.rejects(writer.writeAuthorized(change('approve', 4, selected)), /skill_revoked/);
      await assert.rejects(writer.writeAuthorized(change('activate', 4, selected)), /skill_revoked/);
      await assert.rejects(writer.writeAuthorized(change('approve', 4, { ...selected, digest: 'c'.repeat(64) })), /skill_pin_mismatch/);
    }
    const stored = await db.list<{ entries: { deleted: boolean }[] }>(SKILL_REGISTRY_KIND);
    assert.equal(stored[0]?.data.entries.length, 2); assert.equal(stored[0]?.data.entries.filter(entry => entry.deleted).length, 1);
    assert.equal((await db.list(SKILL_REGISTRY_AUDIT_KIND)).length, 4);
  });
  test('lost owner is fenced even for a write already waiting on PostgreSQL', async () => {
    const entered = barrier(), release = barrier();
    const blocker = db.transaction(owner, async () => { entered.resolve(); await release.promise; });
    const blockedResult = assert.rejects(blocker, /closed_transaction/);
    await entered.promise;
    const pending = assert.rejects(writer.writeAuthorized(change('approve', 0)), /ownership_lost/);
    try { await waiting('SELECT epoch'); await owner.release(); } finally { release.resolve(); }
    await blockedResult; await pending;
    assert.equal((await registry.read(scope)).revision, 0); assert.equal(await db.cursor(), 0);
  });
  test('reader never observes in-flight state without its audit/event commit', async () => {
    const lock = await admin.connect();
    await lock.query('SELECT pg_advisory_lock(7007,1)');
    await admin.query(`CREATE FUNCTION skills_fixture_pause_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind = '${SKILL_REGISTRY_AUDIT_KIND}' THEN PERFORM pg_advisory_xact_lock(7007,1); END IF; RETURN NEW; END $$;
      CREATE TRIGGER skills_fixture_pause BEFORE INSERT ON outpost_records FOR EACH ROW EXECUTE FUNCTION skills_fixture_pause_audit()`);
    try {
      const pending = writer.writeAuthorized(change('approve', 0));
      try {
        await waiting('INSERT INTO outpost_records');
        assert.equal((await registry.read(scope)).revision, 0);
        assert.equal((await db.list(SKILL_REGISTRY_AUDIT_KIND)).length, 0); assert.equal(await db.cursor(), 0);
      } finally { await lock.query('SELECT pg_advisory_unlock(7007,1)'); }
      assert.equal(await pending, 1);
      assert.equal((await registry.read(scope)).revision, 1); assert.equal((await db.list(SKILL_REGISTRY_AUDIT_KIND)).length, 1); assert.equal(await db.cursor(), 2);
    } finally {
      await lock.query('SELECT pg_advisory_unlock_all()'); lock.release();
      await admin.query('DROP TRIGGER skills_fixture_pause ON outpost_records; DROP FUNCTION skills_fixture_pause_audit()');
    }
  });
  test('injected audit failure rolls back registry, audit and both change events', async () => {
    await admin.query(`CREATE FUNCTION skills_fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind = '${SKILL_REGISTRY_AUDIT_KIND}' THEN RAISE EXCEPTION 'fixture-secret'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER skills_fixture_reject BEFORE INSERT ON outpost_records FOR EACH ROW EXECUTE FUNCTION skills_fixture_reject_audit()`);
    try {
      await assert.rejects(writer.writeAuthorized(change('approve', 0)), error => /Database operation failed/.test(String(error)) && !String(error).includes('fixture-secret'));
      assert.equal((await registry.read(scope)).revision, 0); assert.equal(await db.cursor(), 0);
      assert.equal((await db.list(SKILL_REGISTRY_AUDIT_KIND)).length, 0);
    } finally { await admin.query('DROP TRIGGER skills_fixture_reject ON outpost_records; DROP FUNCTION skills_fixture_reject_audit()'); }
  });
  test('scope record invariants and retained-entry resource limit fail closed', async () => {
    const entries = Array.from({ length: SKILL_LIMITS.registryEntries }, (_, index) => ({ ...pin, version: String(index), approved: false, revoked: true, active: false, deleted: true }));
    const key = JSON.stringify(['op007.skills', scope]);
    await db.transaction(owner, tx => tx.put(SKILL_REGISTRY_KIND, key, 0, { schemaVersion: 1, scope, entries }));
    await assert.rejects(writer.writeAuthorized(change('approve', 1, { ...pin, version: 'new' })), /skill_registry_full/);
    await db.transaction(owner, tx => tx.put(SKILL_REGISTRY_KIND, key, 1, { schemaVersion: 1, scope: 'other', entries: [] }));
    await assert.rejects(registry.read(scope), /skill_scope_mismatch/);
    await assert.rejects(writer.writeAuthorized(change('approve', 2)), /skill_scope_mismatch/);
    await db.transaction(owner, tx => tx.put(SKILL_REGISTRY_KIND, key, 2, { schemaVersion: 1, scope, entries: [entries[0], entries[0]] }));
    await assert.rejects(registry.read(scope), /skill_version_collision/);
    await assert.rejects(writer.writeAuthorized(change('approve', 3)), /skill_version_collision/);
  });
  test('actual ApprovedSkills bundles: rotation, new runs, revocation/deletion and repository restart', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'outpost-skills-pg-bundles-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    let pauseReadiness: (() => Promise<void>) | undefined;
    const skills = new ApprovedSkills(registry, { approved: root }, { check: async () => { await pauseReadiness?.(); return 'ready'; } });
    async function bundle(version: string) {
      const directory = `sample-v${version}`, text = `# Instructions version ${version}`, resource = `Reference ${version}`;
      await mkdir(join(root, directory));
      const contents = { 'SKILL.md': text, 'reference.md': resource };
      for (const [path, bytes] of Object.entries(contents)) await writeFile(join(root, directory, path), bytes);
      const manifest: SkillManifest = { schemaVersion: 1, name: 'sample', version, description: 'Disposable reviewed fixture', source: 'fixture', license: 'MIT', requirements: [{ kind: 'capability', id: 'read-only' }],
        files: Object.entries(contents).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: skillHash(Buffer.from(bytes)) })) };
      await writeFile(join(root, directory, 'skill.json'), JSON.stringify(manifest));
      return skills.inspect('approved', directory);
    }
    const first = await bundle('1'), second = await bundle('2'), context = { scope, runId: 'run-1' };
    await writer.writeAuthorized(change('approve', 0, first)); await writer.writeAuthorized(change('activate', 1, first));
    const existing = await skills.admit(context, ['sample']);
    await writer.writeAuthorized(change('approve', 2, second)); await writer.writeAuthorized(change('activate', 3, second));
    assert.equal((await existing.loadInstructions(context, 'sample')).version, '1');
    assert.equal(Buffer.from((await existing.loadResource(context, 'sample', 'reference.md')).bytes).toString(), 'Reference 1');
    assert.equal(existing.evidence.pins[0]?.digest, first.digest);
    const next = await skills.admit({ scope, runId: 'run-2' }, ['sample']);
    assert.equal(next.evidence.pins[0]?.version, '2');
    await assert.rejects(skills.discover('other'), /skill_registry_unavailable/);
    await assert.rejects(existing.loadInstructions({ scope: 'other', runId: 'run-1' }, 'sample'), /skill_scope_mismatch/);
    const loading = barrier(), resumeLoad = barrier();
    pauseReadiness = async () => { loading.resolve(); await resumeLoad.promise; };
    const inFlight = assert.rejects(existing.loadInstructions(context, 'sample'), /skill_not_approved/);
    await loading.promise;
    try { await writer.writeAuthorized(change('revoke', 4, first)); } finally { pauseReadiness = undefined; resumeLoad.resolve(); }
    await inFlight;
    await assert.rejects(existing.loadInstructions(context, 'sample'), /skill_not_approved/);
    await writer.writeAuthorized(change('delete', 5, second));
    await assert.rejects(next.loadResource({ scope, runId: 'run-2' }, 'sample', 'reference.md'), /skill_not_approved/);
    await db.close(); await admin.end();
    // Restart ONLY the fixture's own private cluster, never an ambient endpoint.
    assert.match(fixture.config.host, /^\/tmp\/outpost-pg-[A-Za-z0-9]+\/socket$/);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && key !== 'DATABASE_URL'));
    const restart = await promisify(execFile)('/opt/homebrew/opt/postgresql@16/bin/pg_ctl',
      ['-D', join(dirname(fixture.config.host), 'data'), '-l', join(dirname(fixture.config.host), 'server.log'), '-m', 'fast', '-w', 'restart'], { env: environment, timeout: 30000 });
    console.log(`Private fixture restart: ${restart.stdout.trim()}`);
    admin = new Pool({ ...fixture.config, application_name: 'outpost-skills-fixture-admin' });
    db = await PostgresRepository.open(fixture.config); owner = await db.acquireOwnership();
    const restartedRegistry = new PostgresSkillRegistry(db, scope);
    assert.equal((await restartedRegistry.read(scope)).revision, 6);
    assert.equal((await restartedRegistry.read(scope)).entries[0]?.revoked, true);
    assert.equal((await db.list(SKILL_REGISTRY_AUDIT_KIND)).length, 6);
    assert.equal((await db.events()).length, 12);
    const restartedWriter = new AuthorizedSkillRegistryWriter(db, owner, scope, () => authorization);
    await assert.rejects(restartedWriter.writeAuthorized(change('approve', 6, second)), /skill_revoked/);
    const restarted = new ApprovedSkills(restartedRegistry, { approved: root }, { check: async () => 'ready' });
    assert.deepEqual(await restarted.discover(scope), []);
    await assert.rejects(restarted.admit({ scope, runId: 'run-3' }, ['sample']), /skill_not_approved/);
  });
});
