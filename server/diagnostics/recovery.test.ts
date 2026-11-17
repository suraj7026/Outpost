import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from '../gateway/coordinator.js';
import { InferenceConfiguration } from '../models/inference.js';
import { RecoveryReport } from './recovery.js';

function fixture(options: ConstructorParameters<typeof Coordinator>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-diagnostics-')), db = new Ledger();
  const coordinator = new Coordinator(db, root, options);
  return { db, coordinator, close() { coordinator.live.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const report = (coordinator: Coordinator) => RecoveryReport.parse(coordinator.query('recovery.diagnostics', {}));
const changes = (db: Ledger) => db.db.prepare('SELECT total_changes() AS n').get()?.n;

for (const state of ['missing', 'held', 'enabled', 'invalid'] as const) test(`recovery diagnostics: ${state} is authoritative and read-only`, () => {
  const f = fixture({ environment: { runtimeRelease: 'fixture-release' } });
  try {
    if (state !== 'missing') f.db.put('recovery', 'server', 0, { dispatchEnabled: state === 'invalid' ? 'false' : state === 'enabled', reason: 'PRIVATE-RECOVERY-REASON' });
    const before = changes(f.db), cursor = f.db.cursor();
    f.db.db.exec('PRAGMA query_only=ON');
    const value = report(f.coordinator);
    assert.deepEqual(value.recovery, { state, revision: state === 'missing' ? null : 1 });
    assert.equal(value.dispatchEnabled, state === 'missing' || state === 'enabled');
    assert.equal(value.dispatchEnabled, f.coordinator.dispatchEnabled);
    assert.equal(value.environmentId, f.coordinator.environment.environmentId);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.collectedAt, new Date(value.collectedAt).toISOString());
    assert.equal(value.release, 'fixture-release');
    assert.equal(value.platform, process.platform);
    assert.equal(value.architecture, process.arch);
    assert.deepEqual(value.maintenance, { state: 'idle', holding: false });
    assert.deepEqual(value.runtime, { configured: false, hostAdministration: false, hosts: [] });
    assert.deepEqual(value.work, { queuedTasks: 0, unknownActions: 0, unknownOperations: 0, unknownOutbox: 0 });
    assert.deepEqual(value.agent, { available: false, reason: state === 'missing' || state === 'enabled' ? 'runtime_not_configured' : `recovery_${state}` });
    assert.equal(JSON.stringify(value).includes('PRIVATE-RECOVERY-REASON'), false);
    if (state === 'missing') assert.equal(value.findings.find(item => item.code === 'recovery_missing')?.severity, 'info');
    assert.deepEqual(Object.keys(value).sort(), ['schemaVersion', 'environmentId', 'collectedAt', 'release', 'platform', 'architecture', 'recovery', 'dispatchEnabled', 'maintenance', 'runtime', 'work', 'findings', 'agent'].sort());
    assert.throws(() => f.coordinator.query('recovery.diagnostics', { command: 'read secrets' }));
    report(f.coordinator);
    assert.equal(changes(f.db), before);
    assert.equal(f.db.cursor(), cursor);
    assert.equal(f.db.get('recovery', 'server') === undefined, state === 'missing');
  } finally { f.close(); }
});

test('all malformed recovery data fails closed, while boolean records tolerate existing metadata', () => {
  const f = fixture();
  try {
    f.db.put('recovery', 'server', 0, {});
    for (const data of [null, [], 'enabled', true, 1, {}, { dispatchEnabled: null }, { dispatchEnabled: 0 }, { dispatchEnabled: 1 }, { dispatchEnabled: 'true' }, { dispatchEnabled: [] }]) {
      f.db.db.prepare("UPDATE records SET data=? WHERE kind='recovery' AND id='server'").run(JSON.stringify(data));
      assert.equal(report(f.coordinator).recovery.state, 'invalid');
      assert.equal(f.coordinator.dispatchEnabled, false);
    }
    f.db.put('recovery', 'server', 1, { dispatchEnabled: true, arbitraryPrivateMetadata: { secret: 'do not return this' } });
    assert.deepEqual(report(f.coordinator).recovery, { state: 'enabled', revision: 2 });
    assert.equal(f.coordinator.dispatchEnabled, true);
  } finally { f.close(); }
});

test('reports counts and configured host names, never work payloads, endpoints or credentials', () => {
  const f = fixture({
    inference: InferenceConfiguration.parse({ model: 'private-model', baseUrl: 'http://127.0.0.1:1/v1' }),
    hosts: { token: 'PRIVATE-HOST-TOKEN', endpoints: { local: 'http://private-host:4519', other: 'http://other-private-host:4519' } },
  });
  try {
    for (const [kind, states] of [['task', ['queued', 'queued', 'running', 'interrupted']], ['action', ['unknown', 'pending', 'succeeded']], ['operation', ['unknown', 'unknown', 'handled']]] as const)
      for (const state of states) f.db.put(kind, id(), 0, { state, payload: 'PRIVATE-WORK-PAYLOAD' });
    for (const state of ['unknown', 'unknown', 'unknown', 'pending', 'claimed', 'done']) {
      const key = f.db.enqueue('fixture', { secret: 'PRIVATE-OUTBOX-PAYLOAD' });
      f.db.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state, key);
    }
    const before = changes(f.db);
    f.db.db.exec('PRAGMA query_only=ON');
    const value = report(f.coordinator);
    assert.deepEqual(value.work, { queuedTasks: 2, unknownActions: 1, unknownOperations: 2, unknownOutbox: 3 });
    assert.deepEqual(value.runtime, { configured: true, hostAdministration: true, hosts: ['local', 'other'] });
    assert.deepEqual(value.agent, { available: true, reason: null });
    assert.equal(value.release, null);
    assert.match(value.findings.find(item => item.code === 'runtime_health_unverified')?.summary ?? '', /do not prove/);
    assert.equal(value.findings.find(item => item.code === 'uncertain_effects')?.severity, 'warning');
    for (const secret of ['PRIVATE-', 'http://', 'private-model', 'private-host']) assert.equal(JSON.stringify(value).includes(secret), false);
    assert.equal(changes(f.db), before);
  } finally { f.close(); }
});

for (const state of ['draining', 'holding', 'prepared']) test(`diagnostics remain available during maintenance ${state}`, () => {
  const f = fixture({ apiKey: 'PRIVATE-KEY', roles: {} });
  try {
    f.db.put('runtime_update', 'server', 0, { state, owner: 'PRIVATE-OWNER', target: { secret: 'PRIVATE-TARGET' } });
    f.db.put('recovery', 'server', 0, { dispatchEnabled: false });
    const before = changes(f.db);
    f.db.db.exec('PRAGMA query_only=ON');
    const value = report(f.coordinator);
    assert.deepEqual(value.maintenance, { state, holding: true });
    assert.equal(value.agent.available, false);
    assert.equal(JSON.stringify(value).includes('PRIVATE-'), false);
    assert.equal(changes(f.db), before);
  } finally { f.close(); }
});

test('unrecognized maintenance data and host names cannot become arbitrary report text', () => {
  const endpoints = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`host-${String(n).padStart(2, '0')}`, 'http://private:1']));
  endpoints['PRIVATE\nINSTRUCTIONS'] = 'http://private:1';
  const f = fixture({ hosts: { token: 'PRIVATE-TOKEN', endpoints } });
  try {
    f.db.put('runtime_update', 'server', 0, { state: 'PRIVATE\nINSTRUCTIONS' });
    const value = report(f.coordinator);
    assert.equal(value.maintenance.state, 'unknown');
    assert.equal(value.runtime.hosts.length, 32);
    assert.equal(value.runtime.hosts[0], 'host-00');
    assert.ok(value.findings.some(item => item.code === 'host_names_bounded'));
    assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
    assert.ok(JSON.stringify(value).length < 10000);
  } finally { f.close(); }
});

test('recovery.inspect advertises strict empty input and uses the normal approval/evidence gate', async () => {
  const f = fixture();
  try {
    const task = f.coordinator.tasks.create(id(), { goal: 'Inspect recovery', profile: 'operations', mode: 'ask_permission' });
    const gate = f.coordinator.gate(task.id);
    const tool = gate.catalogue().find(item => item.name === 'recovery.inspect');
    assert.ok(tool?.inputSchema);
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.equal(tool.inputSchema.additionalProperties, false);
    const before = f.db.cursor();
    for (const input of [{ command: 'anything' }, { taskId: task.id }, [], null]) await assert.rejects(gate.propose(task.id, 'recovery.inspect', input));
    assert.equal(f.db.cursor(), before);
    const action = await gate.propose(task.id, 'recovery.inspect', {});
    assert.equal(action.data.state, 'pending');
    await assert.rejects(gate.dispatch(action.id), { code: 'not_authorized' });
    gate.decide(action.id, action.revision, action.data.nonce, action.data.actionDigest, 'approve', id());
    const observed = await gate.dispatch(action.id);
    assert.equal(observed.data.state, 'succeeded');
    const toolReport = RecoveryReport.parse(observed.data.result), queryReport = report(f.coordinator);
    assert.deepEqual({ ...toolReport, collectedAt: null }, { ...queryReport, collectedAt: null });
    assert.equal(f.db.get('recovery', 'server'), undefined);
  } finally { f.close(); }
});
