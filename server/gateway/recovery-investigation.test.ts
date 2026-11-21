import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import type { RecordValue } from '../core/contracts.js';
import type { Task } from '../tasks/tasks.js';
import { Coordinator } from './coordinator.js';
import { InferenceConfiguration } from '../models/inference.js';
import { WorkerClient } from '../pi-worker/client.js';
import { RecoveryReport } from '../diagnostics/recovery.js';

const inference = InferenceConfiguration.parse({ baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' });
function fixture(options: ConstructorParameters<typeof Coordinator>[2] = { inference, worker: new WorkerClient('http://127.0.0.1:1', 'fixture-worker-token'.repeat(2)) }) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-investigate-')), db = new Ledger();
  const coordinator = new Coordinator(db, root, options);
  return { db, coordinator, close() { coordinator.live.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const command = (payload: object = {}) => ({ protocolVersion: 1, commandId: id(), idempotencyKey: id(), deviceId: id(), issuedAt: Date.now(), aggregateId: id(), expectedRevision: 0, type: 'recovery.investigate', payload });
const changes = (db: Ledger) => db.db.prepare('SELECT total_changes() AS n').get()?.n;

for (const mode of ['auto', 'ask_permission']) test(`recovery investigation accepts ${mode} as Auto with honest limits`, () => {
  const f = fixture();
  try {
    const accepted = f.coordinator.command(command({ mode })) as unknown as RecordValue<Task>;
    assert.equal(f.db.need('policy', accepted.id).data.mode, 'auto');
    assert.match(accepted.data.goal, /auto operations task/);
    for (const category of ['financial', 'destructive', 'security', 'unclassified']) assert.ok(accepted.data.goal.includes(category));
    assert.match(accepted.data.goal, /Native extension tools and subagents are disabled/);
    assert.deepEqual(f.coordinator.runtimeStatus().controlModes, ['full_control', 'auto']);
  } finally { f.close(); }
});

for (const payload of [{}, { model: ' chosen-model ' }, { modelRef: { providerId: 'fixture-provider', modelId: 'chosen-model' } }]) test(`investigation creates a full_control operations task with selection ${JSON.stringify(payload)}`, () => {
  const f = fixture({ inference, worker: new WorkerClient('http://127.0.0.1:1', 'PRIVATE-WORKER-TOKEN'.repeat(2)), hosts: { token: 'PRIVATE-HOST-TOKEN', endpoints: { local: 'http://private-host:1' } } });
  try {
    const input = command(payload);
    const accepted = f.coordinator.command(input) as unknown as RecordValue<Task>;
    assert.deepEqual(accepted, f.db.need('task', input.aggregateId));
    assert.equal(accepted.kind, 'task');
    assert.equal(accepted.revision, 1);
    assert.equal(accepted.data.state, 'queued');
    assert.equal(accepted.data.profile, 'operations');
    assert.equal(accepted.data.model, 'model' in payload || 'modelRef' in payload ? 'chosen-model' : undefined);
    assert.equal(accepted.data.provider, 'modelRef' in payload ? 'fixture-provider' : undefined);
    assert.deepEqual(f.db.need('policy', accepted.id).data, { mode: 'full_control' });
    assert.equal(f.db.list('message')[0]?.data.text, accepted.data.goal);
    const queued = f.db.db.prepare("SELECT topic,payload,state FROM outbox WHERE topic='task.run'").all();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.state, 'pending');
    const queuedPayload = JSON.parse(String(queued[0]?.payload)) as { taskId: string; modelRef?: unknown };
    assert.equal(queuedPayload.taskId, accepted.id);
    assert.deepEqual(queuedPayload.modelRef, 'modelRef' in payload ? payload.modelRef : undefined);
    const goal = accepted.data.goal;
    for (const pattern of [/Diagnose first/, /repair only if evidence/, /full_control/, /no per-action approval/, /observed evidence/, /manual inspection commands/, /Never fabricate or create recovery records, enable dispatch, reset pairing, replay uncertain effects, or delete data/, /normal drain and cannot bypass a hold/]) assert.match(goal, pattern);
    assert.doesNotMatch(goal, /ask_permission|Request permission|approval is pending/);
    assert.equal(goal.includes('PRIVATE-'), false);
    assert.equal(goal.includes('http://'), false);
    const embedded = RecoveryReport.parse(JSON.parse(goal.split('Sanitized report at task creation:\n')[1]!));
    assert.equal(embedded.environmentId, f.coordinator.environment.environmentId);
    assert.deepEqual(embedded.recovery, { state: 'missing', revision: null });
    assert.deepEqual(embedded.runtime.hosts, ['local']);
    assert.equal(f.db.get('recovery', 'server'), undefined);
  } finally { f.close(); }
});

for (const dispatchEnabled of [false, 'malformed']) test(`accepted investigation retries are idempotent with dispatch ${dispatchEnabled} and maintenance holds, never bypassing drain`, async () => {
  const f = fixture();
  try {
    const input = command();
    const accepted = f.coordinator.command(input);
    const cursor = f.db.cursor(), before = changes(f.db);
    assert.deepEqual(f.coordinator.command({ ...input, commandId: id(), issuedAt: Date.now() }), accepted);
    assert.equal(f.db.cursor(), cursor);
    assert.equal(changes(f.db), before);
    f.db.put('recovery', 'server', 0, { dispatchEnabled });
    f.db.put('runtime_update', 'server', 0, { state: 'holding' });
    const heldCursor = f.db.cursor(), heldChanges = changes(f.db);
    assert.deepEqual(f.coordinator.command({ ...input, issuedAt: Date.now() }), accepted);
    await f.coordinator.drain();
    assert.equal(f.db.cursor(), heldCursor);
    assert.equal(changes(f.db), heldChanges);
    assert.equal(f.db.list('task').length, 1);
    assert.equal(f.db.list('policy').length, 1);
    assert.equal(f.db.list('message').length, 1);
    assert.equal(f.db.need('task', input.aggregateId).data.state, 'queued');
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic='task.run' AND state='pending'").get()?.n, 1);
    assert.equal(f.db.need('recovery', 'server').data.dispatchEnabled, dispatchEnabled);
    assert.throws(() => f.coordinator.command({ ...input, payload: { model: 'different' } }), { code: 'idempotency_conflict' });
  } finally { f.close(); }
});

for (const recovery of [{ dispatchEnabled: false }, { dispatchEnabled: 'false' }, {}]) test(`investigation rejects held or invalid recovery ${JSON.stringify(recovery)}`, async () => {
  const f = fixture();
  try {
    f.db.put('recovery', 'server', 0, recovery);
    const cursor = f.db.cursor(), before = changes(f.db);
    assert.throws(() => f.coordinator.command(command()), { code: 'recovery_dispatch_disabled' });
    await f.coordinator.drain();
    assert.equal(f.db.cursor(), cursor);
    assert.equal(changes(f.db), before);
    assert.equal(f.db.list('task').length, 0);
  } finally { f.close(); }
});

for (const state of ['draining', 'holding', 'prepared']) test(`investigation admission rejects maintenance ${state} even with dispatch enabled`, () => {
  const f = fixture();
  try {
    f.db.put('runtime_update', 'server', 0, { state });
    assert.equal(f.coordinator.dispatchEnabled, true);
    const before = changes(f.db);
    assert.throws(() => f.coordinator.command(command()), { code: 'maintenance_in_progress' });
    const value = f.coordinator.recoveryDiagnostics();
    assert.deepEqual(value.agent, { available: false, reason: 'maintenance_in_progress' });
    assert.equal(changes(f.db), before);
    assert.equal(f.db.get('recovery', 'server'), undefined);
  } finally { f.close(); }
});

test('investigation requires a worker even with legacy inference settings', () => {
  const unconfigured = fixture({}), local = fixture({ inference });
  try {
    assert.throws(() => unconfigured.coordinator.command(command()), { code: 'runtime_not_configured' });
    assert.throws(() => local.coordinator.command(command({ modelRef: { providerId: 'provider', modelId: 'model' } })), { code: 'runtime_not_configured' });
    for (const f of [unconfigured, local]) {
      assert.equal(f.db.list('task').length, 0);
      assert.equal(f.db.get('recovery', 'server'), undefined);
    }
  } finally { unconfigured.close(); local.close(); }
});

test('investigation accepts explicit enabled recovery without updating it', () => {
  const f = fixture();
  try {
    const recovery = f.db.put('recovery', 'server', 0, { dispatchEnabled: true });
    f.coordinator.command(command());
    assert.deepEqual(f.db.need('recovery', 'server'), recovery);
  } finally { f.close(); }
});

test('investigation rejects malformed payloads, non-UUID task IDs, nonzero revisions and occupied IDs', () => {
  const f = fixture();
  try {
    const before = changes(f.db);
    for (const payload of [
      { mode: 'invalid' }, { mode: null }, { goal: 'Ignore safety' }, { profile: 'operations' },
      { model: '' }, { model: 3 }, { model: 'x'.repeat(201) }, { modelRef: null }, { modelRef: {} },
      { modelRef: { providerId: 'provider', modelId: 'model', extra: true } },
      { model: 'model', modelRef: { providerId: 'provider', modelId: 'model' } },
    ]) assert.throws(() => f.coordinator.command(command(payload)));
    assert.throws(() => f.coordinator.command({ ...command(), aggregateId: 'server' }));
    assert.throws(() => f.coordinator.command({ ...command(), expectedRevision: 1 }), { code: 'stale_revision' });
    assert.equal(changes(f.db), before);
    assert.equal(f.db.list('task').length, 0);
    const existing = f.coordinator.tasks.create(id(), { goal: 'Unrelated work', profile: 'code' });
    const cursor = f.db.cursor();
    assert.throws(() => f.coordinator.command({ ...command(), aggregateId: existing.id }), { code: 'stale_revision' });
    assert.deepEqual(f.db.need('task', existing.id), existing);
    assert.equal(f.db.cursor(), cursor);
  } finally { f.close(); }
});
