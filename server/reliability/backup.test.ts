import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { Artifacts } from '../artifacts/files.js';
import { Coordinator } from '../gateway/coordinator.js';
import { id } from '../core/contracts.js';
import { createBackup, restoreBackup } from './backup.js';
test('encrypted offline backup restores ledger, artifacts and revoked authority with separate key',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-restore-')), db = new Ledger(join(root,'ledger.sqlite')), artifacts = new Artifacts(db,join(root,'artifacts')), key = randomBytes(32);
  try {
    db.put('task','task',0,{ goal: 'private fixture' }); db.put('device','phone',0,{ revoked: true });
    const output = artifacts.publish('task','evidence.txt','text/plain',Buffer.from('verified source'));
    const archive = join(root,'offline.enc'); await createBackup(db,artifacts,key,archive);
    assert.ok(!readFileSync(archive).includes(Buffer.from('private fixture')));
    assert.throws(() => restoreBackup(archive,randomBytes(32),join(root,'wrong')));
    restoreBackup(archive,key,join(root,'replacement'));
    const restored = new Ledger(join(root,'replacement','ledger.sqlite'));
    assert.equal(restored.need('device','phone').data.revoked,true);
    assert.equal(new Artifacts(restored,join(root,'replacement','artifacts')).read(output.id).toString(),'verified source');
    const coordinator = new Coordinator(restored,join(root,'replacement'));
    assert.equal(coordinator.dispatchEnabled,false);
    restored.enqueue('action.dispatch',{ actionId: 'must-not-dispatch' },'held');
    await coordinator.drain();
    assert.equal(restored.db.prepare("SELECT state FROM outbox WHERE id='held'").get()?.state,'pending');
    const resume = { protocolVersion: 1,commandId: id(),idempotencyKey: id(),deviceId: id(),issuedAt: Date.now(),type: 'recovery.resume',aggregateId: 'server',expectedRevision: 1,payload: {} };
    assert.throws(() => coordinator.command(resume),/recovery_acknowledgment_required/);
    coordinator.command({ ...resume,payload: { acknowledged: true } });
    assert.equal(coordinator.dispatchEnabled,true);
    restored.close();
    assert.throws(() => restoreBackup(archive,key,join(root,'replacement')));
  } finally { db.close(); rmSync(root,{ recursive: true,force: true }); }
});
