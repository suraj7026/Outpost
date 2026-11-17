import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Installation } from './installation.js';
import { updateCheckpoint } from './update-checkpoint.js';
import { Ledger } from '../core/ledger.js';
import { Tasks } from '../tasks/tasks.js';
import { Maintenance } from './maintenance.js';
import type { WorkerClient } from '../pi-worker/client.js';
import { ReleaseManifest, compatibleUpdate } from '../pi-management/update-contracts.js';
const source = { schema: 2, id: 'host-' + 'a'.repeat(20), protocolVersion: 2, layoutVersion: 1, compatibility: 'native-v1', sequence: 1, piVersion: '1.4.0', extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }], rollback: true };
const target = { ...source, id: 'host-' + 'b'.repeat(20), sequence: 2, piVersion: '1.5.2',
  extensions: [...source.extensions, { name: 'pi-subagents', version: '0.88.1' }] };
const request = () => ({ type: 'maintenance.prepare', operationId: randomUUID(), expectedRelease: source.id, target, sha256: 'a'.repeat(64) });

test('qualified manifests reject unknown layouts, malformed IDs, downgrade and no-op', () => {
  const current = ReleaseManifest.parse(source), next = ReleaseManifest.parse(target);
  assert.ok(compatibleUpdate(current, next)); assert.ok(!compatibleUpdate(next, current)); assert.ok(!compatibleUpdate(current, current));
  for (const change of [{ schema: 1 }, { layoutVersion: 2 }, { protocolVersion: 1 }, { rollback: false }, { id: '../escape' }, { sequence: -1 }, { unknown: true }]) assert.equal(ReleaseManifest.safeParse({ ...target, ...change }).success, false);
});

test('extension-only releases remain ordered upgrades without requiring a Pi version change', () => {
  const current = ReleaseManifest.parse(target);
  const next = ReleaseManifest.parse({ ...target, id: 'host-' + 'c'.repeat(20), sequence: 3,
    extensions: [...source.extensions, { name: 'pi-subagents', version: '0.88.2' }] });
  assert.ok(compatibleUpdate(current, next));
  assert.equal(compatibleUpdate(next, current), false);
});

test('drain gates work and can cancel before checkpoint; hold restores no dispatch automatically', async () => {
  const db = new Ledger(), tasks = new Tasks(db); let active = true, holds = 0;
  const worker = { request: async (packet: any) => packet.request.type === 'runtime.inventory' ? { manifest: source, releaseId: source.id } : (holds++, { ready: true }) } as unknown as WorkerClient;
  const maintenance = new Maintenance(db, tasks, worker, () => active);
  try {
    const first = request(); assert.equal((await maintenance.request('owner', first)).state, 'draining'); assert.equal(holds, 0); assert.ok(maintenance.holding);
    await assert.rejects(maintenance.request('other', { type: 'maintenance.cancel', operationId: first.operationId }));
    assert.equal((await maintenance.request('owner', { type: 'maintenance.cancel', operationId: first.operationId })).state, 'cancelled');
    assert.ok(!maintenance.holding); active = false;
    const second = request(); assert.equal((await maintenance.request('owner', second)).state, 'prepared');
    assert.equal(db.need('recovery', 'server').data.dispatchEnabled, false);
    await assert.rejects(maintenance.request('owner', { type: 'maintenance.cancel', operationId: second.operationId }));
    assert.equal((await maintenance.request('owner', second)).state, 'prepared'); assert.equal(holds, 1);
    await assert.rejects(maintenance.request('owner', request()));
  } finally { db.close(); }
});

test('ambiguous hold survives restart, cannot be cancelled and reconciles without replacing checkpoint', async () => {
  const db = new Ledger(), tasks = new Tasks(db); let lost = true;
  const worker = { request: async (packet: any) => {
    if (packet.request.type === 'runtime.inventory') return { manifest: source, releaseId: source.id };
    if (lost) throw new Error('Synthetic lost reply after hold'); return { ready: true };
  } } as unknown as WorkerClient;
  let maintenance = new Maintenance(db, tasks, worker, () => false);
  try {
    const operation = request(); await assert.rejects(maintenance.request('owner', operation), /maintenance_hold_unknown/);
    assert.equal(maintenance.status().state, 'holding');
    await assert.rejects(maintenance.request('owner', { type: 'maintenance.cancel', operationId: operation.operationId }));
    const checkpoint = db.need('maintenance_checkpoint', 'server');
    maintenance = new Maintenance(db, tasks, worker, () => false); lost = false;
    assert.ok(maintenance.holding); assert.equal((await maintenance.request('owner', operation)).state, 'prepared');
    assert.deepEqual(db.need('maintenance_checkpoint', 'server').data.previousRecovery, checkpoint.data.previousRecovery);
  } finally { db.close(); }
});

test('staging leaves dispatch available; only digest-bound host completion requests autonomous draining', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-stage-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const owner = randomUUID(), environment = new Installation(db).environmentId;
  db.put('device', owner, 0, { revoked: false });
  const tasks = new Tasks(db); let active = true, holds = 0;
  const worker = { request: async (packet: { request: { type: string } }) => packet.request.type === 'runtime.inventory'
    ? { manifest: source, releaseId: source.id } : (holds++, { ready: true }) } as unknown as WorkerClient;
  const maintenance = new Maintenance(db, tasks, worker, () => active), operation = { ...request(), type: 'maintenance.stage' };
  try {
    assert.equal((await maintenance.request(owner, operation)).state, 'staging');
    assert.equal(maintenance.holding, false); await maintenance.advance(); assert.equal(holds, 0);
    await assert.rejects(maintenance.request(owner, { ...operation, type: 'maintenance.prepare' }), /maintenance_stage_not_ready/);
    assert.throws(() => updateCheckpoint(root, environment, operation.operationId, 'b'.repeat(64), 'prepare'), /update_binding_mismatch/);
    updateCheckpoint(root, environment, operation.operationId, operation.sha256, 'stage');
    updateCheckpoint(root, environment, operation.operationId, operation.sha256, 'prepare');
    assert.equal(maintenance.holding, true); await maintenance.advance(); assert.equal(holds, 0);
    active = false; await maintenance.advance(); assert.equal(holds, 1);
    updateCheckpoint(root, environment, operation.operationId, operation.sha256);
    assert.equal(maintenance.status().state, 'prepared');
    assert.throws(() => updateCheckpoint(root, environment, operation.operationId, operation.sha256, 'abort'), /update_cannot_abort/);
    updateCheckpoint(root, environment, operation.operationId, operation.sha256, 'finish');
    assert.equal(db.need('recovery', 'server').data.dispatchEnabled, true);
    const cancelled = { ...operation, operationId: randomUUID() }; await maintenance.request(owner, cancelled);
    await maintenance.request(owner, { type: 'maintenance.cancel', operationId: cancelled.operationId });
    await assert.rejects(maintenance.request(owner, cancelled), /maintenance_operation_finished/);
    assert.throws(() => updateCheckpoint(root, environment, cancelled.operationId, cancelled.sha256, 'prepare'), /update_not_staging/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ['staging', 'draining'] as const) {
  test(`cancellation during ${phase} blocks late host checkpoints and advance without acquiring a hold`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'outpost-cancel-')), db = new Ledger(join(root, 'ledger.sqlite'));
    const owner = randomUUID(), environment = new Installation(db).environmentId;
    db.put('device', owner, 0, { revoked: false });
    db.put('recovery', 'server', 0, { dispatchEnabled: true });
    const recovery = db.need('recovery', 'server');
    let active = true, holds = 0;
    const worker = { request: async (packet: { request: { type: string } }) => packet.request.type === 'runtime.inventory'
      ? { manifest: source, releaseId: source.id } : (holds++, { ready: true }) } as unknown as WorkerClient;
    const maintenance = new Maintenance(db, new Tasks(db), worker, () => active);
    const operation = { ...request(), type: 'maintenance.stage' };
    try {
      await maintenance.request(owner, operation);
      if (phase === 'draining') {
        updateCheckpoint(root, environment, operation.operationId, operation.sha256, 'stage');
        updateCheckpoint(root, environment, operation.operationId, operation.sha256, 'prepare');
        await maintenance.advance();
      }
      assert.equal(maintenance.status().state, phase);
      assert.equal(holds, 0);
      assert.equal((await maintenance.request(owner, { type: 'maintenance.cancel', operationId: operation.operationId })).state, 'cancelled');
      const cancelled = db.need('runtime_update', 'server');
      active = false;
      await maintenance.advance();
      for (const type of ['maintenance.stage', 'maintenance.prepare']) {
        await assert.rejects(maintenance.request(owner, { ...operation, type }), /maintenance_operation_finished/);
      }
      for (const action of ['stage', 'prepare', 'check'] as const) {
        assert.throws(() => updateCheckpoint(root, environment, operation.operationId, operation.sha256, action),
          action === 'check' ? /update_not_prepared/ : /update_not_staging/);
      }
      assert.deepEqual(db.need('runtime_update', 'server'), cancelled);
      assert.equal(maintenance.holding, false);
      assert.equal(holds, 0);
      assert.equal(db.get('maintenance_checkpoint', 'server'), undefined);
      assert.deepEqual(db.need('recovery', 'server'), recovery);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('cancellation is rejected while the worker hold reply is still pending', async () => {
  const db = new Ledger(), tasks = new Tasks(db);
  const hold = Promise.withResolvers<{ ready: boolean }>(), entered = Promise.withResolvers<void>();
  let holds = 0;
  const worker = { request: async (packet: { request: { type: string } }) => {
    if (packet.request.type === 'runtime.inventory') return { manifest: source, releaseId: source.id };
    holds++; entered.resolve();
    return hold.promise;
  } } as unknown as WorkerClient;
  const maintenance = new Maintenance(db, tasks, worker, () => false), operation = request();
  const pending = maintenance.request('owner', operation);
  try {
    await entered.promise;
    assert.equal(maintenance.status().state, 'holding');
    assert.equal(maintenance.holding, true);
    const checkpoint = db.need('maintenance_checkpoint', 'server');
    const holding = db.need('runtime_update', 'server');
    await assert.rejects(maintenance.request('owner', { type: 'maintenance.cancel', operationId: operation.operationId }), /maintenance_cannot_cancel/);
    assert.deepEqual(db.need('runtime_update', 'server'), holding);
    assert.deepEqual(db.need('maintenance_checkpoint', 'server'), checkpoint);
    assert.equal(db.need('recovery', 'server').data.dispatchEnabled, false);
    hold.resolve({ ready: true });
    assert.equal((await pending).state, 'prepared');
    assert.equal(holds, 1);
    assert.equal(maintenance.holding, true);
    assert.equal(db.need('recovery', 'server').data.dispatchEnabled, false);
  } finally {
    hold.resolve({ ready: true });
    try { await pending; } finally { db.close(); }
  }
});

test('worker not idle restores original paused dispatch policy and retains draining admission', async () => {
  const db = new Ledger(), tasks = new Tasks(db);
  db.put('recovery', 'server', 0, { dispatchEnabled: false, reason: 'Administrator hold' });
  const worker = { request: async (packet: any) => packet.request.type === 'runtime.inventory' ? { manifest: source, releaseId: source.id } : { ready: false } } as unknown as WorkerClient;
  try {
    const maintenance = new Maintenance(db, tasks, worker, () => false);
    assert.equal((await maintenance.request('owner', request())).state, 'draining');
    assert.deepEqual(db.need('recovery', 'server').data, { dispatchEnabled: false, reason: 'Administrator hold' });
    assert.equal(db.need('maintenance_checkpoint', 'server').data.state, 'completed');
  } finally { db.close(); }
});
