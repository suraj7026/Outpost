import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Artifacts } from '../artifacts/files.js';
import { createBackup, restoreBackup } from '../reliability/backup.js';
import { id } from '../core/contracts.js';
import { EnvironmentDescriptor } from './contracts.js';
import { Installation } from './installation.js';

test('installation identity survives reopening and moving existing data without rewriting history', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-environment-'));
  let db = new Ledger(join(root, 'ledger.sqlite'));
  try {
    const taskId = id();
    const task = db.put('task', taskId, 0, { goal: 'Preserve existing work', state: 'paused' });
    const cursor = db.cursor();
    const first = new Installation(db, { label: 'Server one' });
    assert.match(first.environmentId, /^[a-f0-9-]{36}$/);
    assert.equal(db.cursor(), cursor);
    db.close();
    renameSync(join(root, 'ledger.sqlite'), join(root, 'migrated.sqlite'));
    db = new Ledger(join(root, 'migrated.sqlite'));
    const reopened = new Installation(db, { label: 'Renamed host' });
    assert.equal(reopened.environmentId, first.environmentId);
    assert.deepEqual(db.need('task', taskId), task);
    assert.equal(db.cursor(), cursor);
    assert.equal(reopened.descriptor({ worker: false, hostAdministration: false }).label, 'Renamed host');
    assert.equal(new Installation(db).environmentId, first.environmentId);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh ledgers get distinct identities and reject malformed persisted identities', () => {
  const one = new Ledger(), two = new Ledger();
  try {
    const first = new Installation(one), second = new Installation(two);
    assert.notEqual(first.environmentId, second.environmentId);
    one.db.prepare('UPDATE installation_identity SET environment_id=? WHERE singleton=1').run('invalid');
    assert.throws(() => new Installation(one), { code: 'invalid_environment_identity' });
    assert.equal(one.db.prepare('SELECT environment_id FROM installation_identity').get()?.environment_id, 'invalid');
    two.db.exec('DELETE FROM installation_identity');
    assert.throws(() => new Installation(two), { code: 'missing_environment_identity' });
    assert.equal(two.db.prepare('SELECT count(*) AS count FROM installation_identity').get()?.count, 0);
  } finally { one.close(); two.close(); }
});

test('encrypted backup restoration preserves the environment identity and recovery hold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-environment-backup-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  try {
    const installation = new Installation(db);
    const artifacts = new Artifacts(db, join(root, 'artifacts'));
    const key = randomBytes(32), archive = join(root, 'backup.enc'), restoredRoot = join(root, 'restored');
    await createBackup(db, artifacts, key, archive);
    restoreBackup(archive, key, restoredRoot);
    const restored = new Ledger(join(restoredRoot, 'ledger.sqlite'));
    try {
      assert.equal(new Installation(restored).environmentId, installation.environmentId);
      assert.equal(restored.need('recovery', 'server').data.dispatchEnabled, false);
    } finally { restored.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('descriptor distinguishes configuration from readiness and explicitly advertises legacy compatibility', () => {
  const db = new Ledger();
  try {
    const installation = new Installation(db, { label: 'Server two', runtimeRelease: 'fixture-release', allowLegacyProtocol: false });
    const descriptor = EnvironmentDescriptor.parse(installation.descriptor({ worker: true, hostAdministration: true }));
    assert.equal(descriptor.environmentId, installation.environmentId);
    assert.equal(descriptor.protocolVersion, 2);
    assert.equal(descriptor.recordProtocolVersion, 1);
    assert.deepEqual(descriptor.supportedProtocolVersions, [2]);
    assert.equal(descriptor.legacyUnboundRequests, false);
    assert.equal(descriptor.runtime.release, 'fixture-release');
    assert.equal(descriptor.runtime.platform, process.platform);
    assert.equal(descriptor.runtime.architecture, process.arch);
    assert.deepEqual(descriptor.services.worker, { configured: true, readiness: 'unknown' });
    assert.deepEqual(descriptor.services.hostAdministration, { configured: true, readiness: 'unknown' });
    assert.equal(descriptor.capabilities.historyReplication, false);
    assert.equal(descriptor.capabilities.taskHandoff, false);
    assert.equal(new Installation(db).descriptor({ worker: false, hostAdministration: false }).services.worker.readiness, 'not_configured');
    assert.throws(() => installation.requireProtocol(1), { code: 'legacy_protocol_disabled' });
    assert.throws(() => installation.requireTarget(id()), { code: 'environment_mismatch' });
    installation.requireTarget(installation.environmentId);
    assert.throws(() => new Installation(db, { label: ' ' }));
    assert.throws(() => new Installation(db, { runtimeRelease: '/private/token' }));
  } finally { db.close(); }
});

