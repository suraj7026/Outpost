import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildPiUpdate } from './package-pi-update.mjs';
import { buildHostRelease } from './package-host-release.mjs';
import { inspectArchive, signArtifact } from './sign-releases.mjs';

const root = resolve(import.meta.dirname, '..');
const baselinePath = 'scripts/fixtures/outpost1-pi140-source.tar.gz';
const baselineSha256 = 'f02c1479e7f59eb94221eb56977becd517c940da980f45381c68e35fc4deeff7';
const sourceRelease = 'host-e89b6404f05c3a07c0f6';
const compatibleSourceReleases = [sourceRelease, 'host-24b08c6bb80dd3932f21',
  'host-b44894f3afe1c0de9685', 'host-f428c9960b5b1f32dae0', 'host-41cd62017ed6c74b5248'];
const requiredTools = ['automation.list', 'automation.save', 'automation.set_paused'];
const policyPath = 'deploy/environment/release-policy.json';
const policy = JSON.parse(readFileSync(join(root, policyPath), 'utf8'));
const coordinatorPath = 'server/gateway/coordinator.ts';
const mainPath = 'server/main.ts';
const mainShutdownBefore = '  if (coordinator.browsers) void coordinator.closeBrowsers().finally(finish);\n  else finish();';
const mainShutdownAfter = '  void coordinator.close().finally(finish);';
const workspacePath = 'server/artifacts/workspace-review.ts';
const workspaceImport = "import { WorkspaceReview, WorkspaceFilesInput, WorkspaceReadInput } from '../artifacts/workspace-review.js';\n";
const workspaceQueries = `    if (type === 'workspace.files' || type === 'workspace.read') {
      const input = type === 'workspace.files' ? { ...WorkspaceFilesInput.parse(payload), path: undefined } : WorkspaceReadInput.parse(payload);
      this.db.need('task',input.taskId);
      const workspace = new WorkspaceReview(join(this.options.workspaceRoot ?? join(this.root,'workspaces'),input.taskId));
      return (input.path === undefined ? workspace.files() : workspace.read(input.path)).then(wire);
    }
`;
const automationImport = "import { registerAutomationTools } from '../scheduler/tools.js';\n";
const automationRegistration = `    registerAutomationTools(gate,this.scheduler,{ workerAvailable: !!this.options.worker, assertWritable: () => {
      requireThat(!this.maintenance.holding,'maintenance_in_progress');
      requireThat(this.dispatchEnabled,'recovery_dispatch_disabled');
    } });
`;
const serviceEntrypoints = ['server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'];
const subagentPublicKind = ",'subagent_run'";
const subagentRestartImport = "import { interruptedSubagent } from '../pi-adapter/subagent-contract.js';\n";
const subagentRestart = `    for (const record of db.list('subagent_run')) if (record.data.streaming) db.put('subagent_run', record.id, record.revision,
      { ...record.data, ...interruptedSubagent(record.data), streaming: false, interrupted: true });
`;
const recoveryImport = "import { recoveryAllowsDispatch, recoveryStatus } from '../diagnostics/recovery.js';\n";
const controlTransforms = [
    ["import { ClientCommand, Fault, id, requireThat } from '../core/contracts.js';",
      "import { ClientCommand, Fault, id, requireThat, controlModes, autoPolicyVersion } from '../core/contracts.js';\nimport { registerBuiltin, securityPath } from '../policy/auto-policy.js';"],
    ["import { ManagementRequest, ModelRef } from '../pi-management/contracts.js';\nimport { cloudReviewer } from '../models/cloud.js';\n",
      "import { ManagementRequest, ModelRef } from '../pi-management/contracts.js';\n"],
    ["    const reviewer = this.options.apiKey && this.options.roles ? cloudReviewer(this.options.apiKey,this.options.roles) : undefined;\n    gate = new Gate(this.db,reviewer,!!this.options.hosts);",
      `    gate = new Gate(this.db,!!this.options.hosts, () => {
      requireThat(!this.closing, 'coordinator_stopping');
      requireThat(!this.maintenance.holding, 'maintenance_in_progress');
      requireThat(this.dispatchEnabled, 'recovery_dispatch_disabled');
    }, key => !!this.runtimes.get(key)?.isActive(key));`],
    ["['task.pause', 'task.cancel', 'approval.decide']", "['task.pause', 'task.cancel']"],
    [`        case 'policy.change': return wire(this.gate(key).changePolicy(key,expected,payload.mode));
        case 'approval.decide': {
          const action = this.db.need<Action>('action',key);
          return wire(this.gate(action.data.taskId).decide(key,expected,z.string().parse(payload.nonce),z.string().parse(payload.actionDigest),z.enum(['approve','deny']).parse(payload.decision),command.deviceId));
        }
`, `        case 'policy.change': return wire(this.gate(key).changePolicy(key,expected,payload.mode));
        case 'approval.decide': {
          const action = this.db.need<Action>('action',key);
          return wire(this.gate(action.data.taskId).decide(key, expected, command.deviceId, payload));
        }
`],
    ["  get dispatchEnabled() { return this.db.get('recovery','server')?.data.dispatchEnabled !== false; }",
      "  get dispatchEnabled() { return recoveryAllowsDispatch(recoveryStatus(this.db)); }"],
    ["  private gates = new Map<string,Gate>(); private runtimes = new Map<string,PiRuntime | RemotePiRuntime>(); private jobs = new Set<string>();",
      "  private gates = new Map<string,Gate>(); private runtimes = new Map<string,PiRuntime | RemotePiRuntime>(); private jobs = new Set<string>();\n  private runtimeJobs = new Set<Promise<void>>();\n  private drains = new Set<Promise<void>>();\n  private closing = false;"],
    ["  command(input: unknown) {\n    const command = ClientCommand.parse(input);",
      "  command(input: unknown) {\n    requireThat(!this.closing, 'coordinator_stopping');\n    const command = ClientCommand.parse(input);"],
    ["gate.register('artifact.read_text',", "registerBuiltin(gate, 'artifact.read_text',"],
    ["gate.register('data.profile',", "registerBuiltin(gate, 'data.profile',"],
    ["execute: async args => profileCSV(workspace.read(String(args.path))) });",
      "execute: async args => profileCSV(workspace.read(String(args.path))) }, args => securityPath(String(args.path)) ? 'security' : 'routine');"],
    ["  runtimeStatus() {\n    return { piManagement:",
      "  runtimeStatus() {\n    return { controlModes: [...controlModes], autoPolicyVersion, piManagement:"],
    ["  async closeBrowsers() {", `  async close() {
    this.closing = true;
    for (const [taskId, gate] of this.gates) gate.stop(taskId);
    await Promise.allSettled([...this.runtimes].map(([taskId, runtime]) => runtime.abort(taskId)));
    await Promise.allSettled([...this.runtimeJobs, ...this.drains]);
    await this.closeBrowsers();
    this.live.close();
  }
  async closeBrowsers() {`],
    ["    void pending.catch(error => {", "    this.runtimeJobs.add(pending);\n    void pending.catch(error => {"],
    ["    });\n  }\n  async drain() {\n    if (!this.dispatchEnabled) return;", `    }).finally(() => this.runtimeJobs.delete(pending));
  }
  drain() {
    const pending = this.drainWork();
    this.drains.add(pending);
    void pending.then(() => this.drains.delete(pending), () => this.drains.delete(pending));
    return pending;
  }
  private async drainWork() {
    if (this.closing || !this.dispatchEnabled || this.maintenance.holding) return;`],
    ["        if (blockedTasks.has(taskId)) continue;",
      "        if (blockedTasks.has(taskId)) continue;\n        if (!runtime?.isActive(taskId) && this.db.need<Task>('task', taskId).data.state === 'waiting_for_approval') { blockedTasks.add(taskId); continue; }"],
    ["      this.db.db.prepare(\"UPDATE outbox SET state='claimed' WHERE id=? AND state='pending'\").run(key); this.jobs.add(key);",
      "      if (!this.db.db.prepare(\"UPDATE outbox SET state='claimed' WHERE id=? AND state='pending'\").run(key).changes) continue;\n      this.jobs.add(key);"],
];
const controlPaths = [
  'server/artifacts/files.ts', 'server/processes/runner.ts', 'server/operations/machine.ts',
  'server/pi-worker/client.ts', 'server/policy/auto-policy.ts',
  'server/core/contracts.ts', 'server/diagnostics/recovery.ts', 'server/models/cloud.ts',
  'server/operations/hosts.ts', 'server/policy/migration.ts', 'server/policy/trust.ts',
  'server/scheduler/scheduler.ts', 'server/tasks/tasks.ts',
];
const subagentPaths = [
  'server/gateway/live.ts', 'server/pi-adapter/live-events.ts', 'server/pi-adapter/remote-runtime.ts',
  'server/pi-adapter/subagent-contract.ts', 'server/pi-adapter/subagent-privacy.ts',
  'server/pi-adapter/subagent-runs.ts', 'server/pi-adapter/subagent-transcript.ts', 'server/pi-worker/contracts.ts',
];
const overlays = [
  'deploy/environment/auto_update.py',
  'deploy/environment/host_install.py', 'deploy/environment/host_update.py',
  workspacePath,
  'server/environment/qualify-runtime.ts',
  'server/pi-adapter/runtime.ts', 'server/pi-adapter/system-prompt.ts',
  'server/pi-management/bundled-extensions.ts',
  'server/pi-management/child-provider-bootstrap.ts',
  'server/pi-management/credential-store.ts', 'server/pi-management/providers.ts',
  'server/pi-management/session-background.ts', 'server/pi-management/session-extensions.ts',
  'server/pi-management/subscription-models.ts',
  'server/pi-worker/main.ts', 'server/pi-worker/runs.ts',
  'server/scheduler/tools.ts',
  ...subagentPaths, ...controlPaths,
].sort();
const packagePaths = ['deploy/pi-update/package.json', 'deploy/pi-update/package-lock.json'];
const pinsPath = 'deploy/environment/runtime-pins.json';
const runtimePath = 'server/pi-adapter/runtime.ts';
const temporary = mkdtempSync(join(tmpdir(), 'outpost-pi-update-test-'));
const sourceRoot = join(temporary, 'inputs');
const outputDir = join(temporary, 'output');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));
const put = (directory, path, bytes) => {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), bytes);
};

function archiveFiles(path) {
  const result = execFileSync('python3', ['-c', `
import base64, json, pathlib, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    assert all(m.isfile() or m.isdir() for m in members)
    names = [pathlib.PurePosixPath(m.name) for m in members]
    assert all(not p.is_absolute() and '..' not in p.parts for p in names)
    assert len(set(names)) == len(names)
    print(json.dumps({str(pathlib.PurePosixPath(m.name)): base64.b64encode(archive.extractfile(m).read()).decode() for m in members if m.isfile()}))
`, path], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  return new Map(Object.entries(json(result)).map(([path, value]) => [path, Buffer.from(value, 'base64')]));
}

function command(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', timeout: 180000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (signal: ${result.signal ?? 'none'})`);
}

function qualificationEnvironment(home) {
  mkdirSync(home, { recursive: true });
  return { ...process.env, HOME: home, TMPDIR: home, JITI_FS_CACHE: 'false', TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1',
    PI_CODING_AGENT_DIR: join(home, 'agent'), PI_SUBAGENTS_TEMP_ROOT: join(home, 'subagents'),
    XDG_CACHE_HOME: join(home, 'cache'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
    npm_config_cache: join(home, 'npm-cache'), npm_config_update_notifier: 'false' };
}

function qualifyWorkspaceReview(staged, env) {
  // Inject only the test: its relative imports must resolve to the extracted release, never working-tree server code.
  const path = 'server/gateway/workspace-review.test.ts';
  put(staged, path, readFileSync(join(root, path)));
  const result = spawnSync(process.execPath, ['--import', join(staged, 'node_modules/tsx/dist/loader.mjs'), '--test', path],
    { cwd: staged, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Packaged workspace review failed:\n${result.stdout}\n${result.stderr}`);
}

function qualifyControlModes(staged, env, legacy = false) {
  const tests = ['server/policy/trust.test.ts', 'server/policy/migration.test.ts',
    'server/tasks/tasks.test.ts', 'server/tasks/maintenance.test.ts',
    'server/scheduler/scheduler.test.ts', 'server/scheduler/tools.test.ts',
    'server/models/cloud.test.ts', 'server/operations/hosts.test.ts', 'server/gateway/http.test.ts',
    'server/policy/auto.test.ts', 'server/gateway/auto-http.test.ts', 'server/pi-adapter/auto-runtime.test.ts'];
  // Inject tests only. The legacy browser is deliberately uncertified, so strengthen
  // just its routine-read expectations to require approval; never alter packaged source.
  for (const path of tests) {
    let source = readFileSync(join(root, path), 'utf8');
    if (legacy && path === 'server/policy/auto.test.ts') {
      const start = source.indexOf("test('browser observations/capture may auto;");
      const end = source.indexOf("\ntest(", start + 1);
      assert.ok(start >= 0 && end > start, 'Legacy browser test adaptation requires its audited block');
      const block = source.slice(start, end);
      assert.equal(block.split("'authorized'").length, 2);
      source = source.slice(0, start) + block.replaceAll("'authorized'", "'pending'")
        .replace('browser observations/capture may auto;', 'legacy uncertified browser observations/capture require approval;') + source.slice(end);
    }
    put(staged, path, source);
  }
  const result = spawnSync(process.execPath, ['--import', join(staged, 'node_modules/tsx/dist/loader.mjs'), '--test', ...tests],
    { cwd: staged, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Packaged control-mode qualification failed:\n${result.stdout}\n${result.stderr}`);
}

function qualifyCoordinatorFences(staged, env, pattern) {
  const path = 'server/gateway/packaged-auto-fences.test.mjs';
  put(staged, path, String.raw`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { id } from '../core/contracts.ts';
import { Ledger } from '../core/ledger.ts';
import { Coordinator } from './coordinator.ts';
import { WorkerClient } from '../pi-worker/client.ts';
const command = (type, aggregateId, expectedRevision, payload = {}) => ({ protocolVersion: 1, commandId: id(), idempotencyKey: id(), deviceId: id(), issuedAt: Date.now(), type, aggregateId, expectedRevision, payload });
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail('Coordinator did not settle within the fixture deadline');
}
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'packaged-auto-fences-')), db = new Ledger();
  const coordinator = new Coordinator(db, root, options);
  t.after(async () => { await coordinator.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, coordinator };
}
test('coordinator certifies its actual artifact and data reads, but security paths remain reviewed', async t => {
  const f = fixture(t), task = f.coordinator.tasks.create(id(), { goal: 'Inspect fixture', profile: 'code', mode: 'auto' });
  const gate = f.coordinator.gate(task.id);
  writeFileSync(join(f.root, 'workspaces', task.id, 'fixture.csv'), 'name,value\nfixture,1\n');
  const artifact = f.coordinator.artifacts.publish(task.id, 'fixture.txt', 'text/plain', Buffer.from('fixture'));
  for (const [tool, args] of [['system.inspect', {}], ['data.profile', { path: 'fixture.csv' }], ['artifact.read_text', { artifactId: artifact.id }]]) {
    const action = await gate.propose(task.id, tool, args);
    assert.equal(action.data.state, 'authorized', 'Certified built-in must be routine: ' + tool);
    assert.equal((await gate.dispatch(action.id)).data.state, 'succeeded');
  }
  assert.equal((await gate.propose(task.id, 'data.profile', { path: '.env' })).data.classification, 'security');
});
for (const cleanup of ['unattested', 'attention', 'settled']) test('runtime settlement callback fences mode changes: ' + cleanup, async t => {
  let taskId, model, aborted = false;
  class Worker extends WorkerClient {
    async request(packet) {
      if (packet.type === 'run.start') { taskId = packet.taskId; model = packet.model; return {}; }
      if (packet.type === 'run.abort') { aborted = true; return {}; }
      if (packet.type === 'run.poll') return { runId: packet.runId, taskId, model, state: 'failed', session: null,
        cursor: 0, hasMore: false, projections: [], actions: [], error: 'synthetic failure',
        ...(aborted && cleanup !== 'unattested' ? { settled: cleanup === 'settled', needsAttention: cleanup === 'attention' } : {}) };
      throw Error('Unexpected fixture worker request');
    }
  }
  const worker = new Worker('http://127.0.0.1', 'synthetic-worker-token'.repeat(3));
  const f = fixture(t, { worker });
  const task = f.coordinator.tasks.create(id(), { goal: 'Settle synthetic runtime', profile: 'code', modelRef: { providerId: 'fixture', modelId: 'fixture' } });
  await f.coordinator.drain();
  await until(() => f.db.need('task', task.id).data.state === 'interrupted');
  const gate = f.coordinator.gate(task.id);
  assert.equal(gate.isActive(task.id), false, 'Run bookkeeping settled; residual fence must come from runtime callback');
  if (cleanup === 'settled') assert.equal(gate.changePolicy(task.id, 1, 'auto').data.mode, 'auto');
  else assert.throws(() => gate.changePolicy(task.id, 1, 'auto'), /mode_change_requires_stopped/);
});
test('single claim remains done when overlapping drains observe an already-consumed row', async t => {
  const f = fixture(t), task = f.coordinator.tasks.create(id(), { goal: 'Queue fixture', profile: 'code' });
  const gate = f.coordinator.gate(task.id), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  gate.register('fixture.slow', { version: 1, effects: ['unknown'], parse: () => ({}), target: () => 'fixture', execute: async () => { calls++; entered.resolve(); await release.promise; return null; } });
  gate.register('fixture.fast', { version: 1, effects: ['unknown'], parse: () => ({}), target: () => 'fixture', execute: async () => { calls++; return null; } });
  const operations = [];
  for (const tool of ['fixture.slow', 'fixture.fast']) {
    const action = await gate.propose(task.id, tool, {});
    operations.push(f.coordinator.command(command('action.dispatch', action.id, action.revision)).operationId);
  }
  const first = f.coordinator.drain();
  try {
    await entered.promise; await f.coordinator.drain(); release.resolve(); await first;
    assert.equal(calls, 2);
    for (const key of operations) {
      assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE id=?').get(key).state, 'done', 'Conditional claim must not reclaim a completed row');
      assert.equal(f.db.need('operation', key).data.state, 'handled');
    }
  } finally { release.resolve(); await first; }
});
test('shutdown fences admission and awaits a starting runtime before closing the ledger', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let taskId, model;
  class Worker extends WorkerClient {
    async request(packet) {
      if (packet.type === 'run.start') { taskId = packet.taskId; model = packet.model; entered.resolve(); await release.promise; return {}; }
      if (packet.type === 'run.abort') return {};
      if (packet.type === 'run.poll') return { runId: packet.runId, taskId, model, state: 'cancelled', settled: true, needsAttention: false,
        session: null, cursor: 0, hasMore: false, projections: [], actions: [], error: null };
      throw Error('Unexpected fixture worker request');
    }
  }
  const f = fixture(t, { worker: new Worker('http://127.0.0.1', 'synthetic-worker-token'.repeat(3)) });
  const task = f.coordinator.tasks.create(id(), { goal: 'Starting fixture', profile: 'code', modelRef: { providerId: 'fixture', modelId: 'fixture' } });
  await f.coordinator.drain(); await entered.promise;
  const gate = f.coordinator.gate(task.id);
  assert.throws(() => gate.changePolicy(task.id, 1, 'auto'), /mode_change_requires_stopped/);
  let closed = false;
  const closing = f.coordinator.close().then(() => { closed = true; });
  try {
    await delay(40); assert.equal(closed, false, 'Shutdown must await the starting runtime');
    assert.throws(() => f.coordinator.command(command('task.create', id(), 0, { goal: 'Late work', profile: 'code' })), /coordinator_stopping/);
    await assert.rejects(gate.propose(task.id, 'system.inspect', {}), /coordinator_stopping/);
  } finally { release.resolve(); await closing; }
  assert.equal(gate.isActive(task.id), false);
});
`);
  const result = spawnSync(process.execPath, ['--import', join(staged, 'node_modules/tsx/dist/loader.mjs'), '--test',
    ...(pattern ? ['--test-name-pattern', pattern] : []), path], { cwd: staged, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Packaged coordinator fence qualification failed:\n${result.stdout}\n${result.stderr}`);
}

function qualifySubagents(staged, env) {
  const loader = join(staged, 'node_modules/tsx/dist/loader.mjs');
  const check = (args) => {
    const result = spawnSync(process.execPath, ['--import', loader, ...args], { cwd: staged, env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Packaged subagent qualification failed:\n${result.stdout}\n${result.stderr}`);
  };
  check(['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Ledger } from './server/core/ledger.ts';
import { digest } from './server/core/contracts.ts';
import { Coordinator, publicKinds } from './server/gateway/coordinator.ts';
assert.ok(publicKinds.includes('subagent_run'), 'subagent_run must be public');
const db = new Ledger(), coordinator = new Coordinator(db, join(process.env.HOME, 'subagent-review'));
const taskId = randomUUID(), sessionId = randomUUID(), callId = 'packaged-child';
const id = digest({ kind: 'subagent_run', sessionId, callId });
const data = { taskId, parentSessionId: sessionId, parentCallId: callId, parentToolId: digest({ sessionId, callId }),
  label: 'Observed child', executionMode: 'background', state: 'running', activity: [],
  incomplete: false, truncated: false, stopSupported: false };
try {
  coordinator.live.publish('subagent_run', id, data);
  assert.ok(db.snapshot(publicKinds).records.some(record => record.kind === 'subagent_run' && record.id === id));
  coordinator.live.interrupt(taskId);
  const saved = db.need('subagent_run', id);
  assert.equal(saved.data.state, 'unknown');
  assert.equal(saved.data.incomplete, true);
  assert.equal(saved.data.streaming, false);
  assert.equal(saved.data.interrupted, true);
  assert.equal(saved.data.endedAt, undefined);
} finally { coordinator.live.close(); db.close(); }
`]);
  check(['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from './server/core/ledger.ts';
import { digest } from './server/core/contracts.ts';
import { Coordinator, publicKinds } from './server/gateway/coordinator.ts';
const root = mkdtempSync(join(process.env.HOME, 'subagent-restart-')), path = join(root, 'ledger.sqlite');
let db = new Ledger(path), coordinator = new Coordinator(db, root);
const taskId = randomUUID(), sessionId = randomUUID(), before = new Map();
try {
  for (const state of ['queued', 'running', 'unknown', 'completed', 'failed', 'stopped', 'partial']) {
    for (const streaming of [true, false]) {
      const callId = state + '-' + streaming, id = digest({ kind: 'subagent_run', sessionId, callId });
      const data = { taskId, parentSessionId: sessionId, parentCallId: callId, parentToolId: digest({ sessionId, callId }),
        label: 'Observed child', executionMode: 'background', state,
        activity: [{ id: 'observed', kind: 'message', text: 'Recorded child work' }],
        ...(['completed', 'failed', 'stopped', 'partial'].includes(state) ? { endedAt: 123 } : {}),
        incomplete: false, truncated: false, stopSupported: false };
      if (streaming) coordinator.live.publish('subagent_run', id, data);
      else coordinator.live.finish('subagent_run', id, data);
      before.set(id, db.need('subagent_run', id));
    }
  }
  coordinator.live.close(); db.close();
  db = new Ledger(path); coordinator = new Coordinator(db, root);
  for (const [id, previous] of before) {
    const saved = db.need('subagent_run', id);
    if (!previous.data.streaming) { assert.deepEqual(saved, previous, 'Settled history must remain unchanged'); continue; }
    const active = ['queued', 'running', 'unknown'].includes(previous.data.state);
    assert.equal(saved.data.state, active ? 'unknown' : previous.data.state, 'Restart must interrupt active subagents without changing terminal states');
    assert.deepEqual(saved.data, { ...previous.data, state: active ? 'unknown' : previous.data.state,
      incomplete: true, streaming: false, interrupted: true });
    assert.equal(saved.revision, previous.revision + 1);
  }
  assert.equal(db.snapshot(publicKinds).records.filter(record => record.kind === 'subagent_run').length, before.size);
  const recovered = db.list('subagent_run');
  coordinator.live.close();
  coordinator = new Coordinator(db, root);
  assert.deepEqual(db.list('subagent_run'), recovered, 'Restart interruption must be idempotent');
} finally { coordinator.live.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
`]);
  const tests = ['server/pi-adapter/subagent-runs.test.ts', 'server/pi-adapter/subagent-remote.test.ts'];
  // Only tests are injected: every runtime import must come from the extracted artifact.
  for (const path of tests) put(staged, path, readFileSync(join(root, path)));
  check(['--test', ...tests]);
}

try {
  if (process.argv.slice(2).some(arg => arg !== '--qualify')) throw new Error('Usage: node scripts/test-pi-update.mjs [--qualify]');
  for (const path of [baselinePath, policyPath, ...overlays, ...packagePaths]) put(sourceRoot, path, readFileSync(join(root, path)));
  const baseline = archiveFiles(join(sourceRoot, baselinePath));
  const metadata = buildPiUpdate({ outputDir, sourceRoot });
  const archivePath = join(outputDir, 'pi-release.tar.gz');
  const archive = readFileSync(archivePath);
  const files = archiveFiles(archivePath);

  await test('Full compatible server release preserves the pinned legacy source and strict artifact contract', async t => {
    t.diagnostic(`Isolated artifact ${metadata.id}; sha256 ${metadata.sha256}; ${metadata.size} bytes`);
    await t.test('baseline digest, source manifest identity and complete inventory', () => {
      assert.equal(sha256(readFileSync(join(sourceRoot, baselinePath))), baselineSha256);
      assert.equal(baseline.size, 202);
      assert.equal(json(baseline.get('host-manifest.json')).id, sourceRelease);
      assert.equal(json(baseline.get('host-manifest.json')).sequence, 1);
      const expected = new Set([...baseline.keys(), ...overlays, 'pi-update-source.json']);
      assert.deepEqual([...files.keys()].sort(), [...expected].sort());
      const allowed = new Set([...overlays, coordinatorPath, mainPath, 'package.json', 'package-lock.json', 'host-manifest.json']);
      for (const [path, bytes] of baseline) {
        if (!allowed.has(path)) assert.deepEqual(files.get(path), bytes, path);
      }
      for (const path of overlays) assert.deepEqual(files.get(path), readFileSync(join(sourceRoot, path)), path);
    });

    await t.test('browser/gateway sources, runtime pins and host executor remain byte-exact except audited coordinator transforms and live overlay', () => {
      const protectedPaths = [...baseline.keys()].filter(path => /^(server\/(browser|browser-engine|gateway)\/|deploy\/agent\/)/.test(path) || path === pinsPath || /(?:uv\.lock|pyproject\.toml)$/.test(path));
      for (const path of protectedPaths.filter(path => path !== coordinatorPath && path !== 'server/gateway/live.ts')) assert.deepEqual(files.get(path), baseline.get(path), path);
      assert.deepEqual(files.get('server/gateway/live.ts'), readFileSync(join(sourceRoot, 'server/gateway/live.ts')));
      for (const path of serviceEntrypoints) assert.ok(files.get(path)?.length > 0, path);
      const coordinator = files.get(coordinatorPath).toString('utf8');
      let unpatched = coordinator;
      for (const insertion of [automationImport, automationRegistration, workspaceImport, workspaceQueries, subagentPublicKind, subagentRestartImport, subagentRestart, recoveryImport]) {
        assert.equal(coordinator.split(insertion).length, 2);
        unpatched = unpatched.replace(insertion, '');
      }
      for (const [before, after] of [...controlTransforms].reverse()) {
        assert.equal(unpatched.split(after).length, 2, 'Audited coordinator replacement must be unique');
        unpatched = unpatched.replace(after, before);
      }
      assert.deepEqual(Buffer.from(unpatched), baseline.get(coordinatorPath));
      assert.doesNotMatch(coordinator, /cloudReviewer|ask_permission/);
      assert.match(coordinator, /\.decide\(key, expected, command\.deviceId, payload\)/);
      const main = files.get(mainPath).toString('utf8');
      assert.equal(main.split(mainShutdownAfter).length, 2);
      assert.deepEqual(Buffer.from(main.replace(mainShutdownAfter, mainShutdownBefore)), baseline.get(mainPath));
      assert.match(main, /OUTPOST_BROWSER_PYTHON/);
      assert.match(main, /OUTPOST_CHROMIUM_PATH/);
      assert.doesNotMatch(main, /OUTPOST_CAMOUFOX_PYTHON/);
      assert.doesNotMatch(coordinator, /case 'recovery\.investigate'|gate\.register\('recovery\.inspect'/, 'Do not add unrelated recovery APIs absent from the baseline');
      assert.deepEqual(files.get(workspacePath), readFileSync(join(root, workspacePath)));
      assert.match(coordinator, /registerBrowserUse\(gate/);
      assert.match(coordinator, /browserInference/);
      assert.deepEqual([...files.keys()].filter(path => path.startsWith('server/browser-engine/')), [...baseline.keys()].filter(path => path.startsWith('server/browser-engine/')));
      assert.equal(Object.hasOwn(json(files.get(pinsPath)), 'camoufoxVersion'), false);
    });

    await t.test('full native session overlays and current recovery prompt replace the old runtime patch', () => {
      assert.ok(baseline.has('server/pi-adapter/system-prompt.ts'));
      for (const path of [runtimePath, 'server/pi-worker/runs.ts']) {
        assert.match(files.get(path).toString('utf8'), /await sessionExtensions\(/);
        assert.match(files.get(path).toString('utf8'), /await extensions\.bind\(session\)/);
        assert.deepEqual(files.get(path), readFileSync(join(sourceRoot, path)));
      }
      assert.match(files.get(runtimePath).toString('utf8'), /piVersion: VERSION/);
      assert.match(files.get('server/pi-adapter/system-prompt.ts').toString('utf8'), /recovery\.inspect/);
      assert.deepEqual(files.get('server/pi-worker/main.ts'), readFileSync(join(sourceRoot, 'server/pi-worker/main.ts')));
      const qualifier = files.get('server/environment/qualify-runtime.ts').toString('utf8');
      assert.match(qualifier, /export async function qualifyRuntime\(/);
      assert.match(qualifier, /qualifyRuntime\(\)/);
      assert.match(qualifier, /await sessionExtensions\(/);
      assert.match(qualifier, /import\.meta\.url === pathToFileURL/);
    });

    await t.test('Full Control and Auto policy, certification, migration and runtime fences ship together', () => {
      for (const path of controlPaths) assert.deepEqual(files.get(path), readFileSync(join(sourceRoot, path)), path);
      assert.match(files.get('server/tasks/tasks.ts').toString('utf8'), /retireLegacyApprovals\(this\.db\)/);
      assert.match(files.get('server/core/contracts.ts').toString('utf8'), /pipe\(z\.enum\(controlModes\)\)/);
      assert.match(files.get('server/core/contracts.ts').toString('utf8'), /autoPolicyVersion = 1/);
      assert.doesNotMatch(files.get('server/models/cloud.ts').toString('utf8'), /cloudReviewer|independent_reviewer_required/);
      assert.match(files.get('server/policy/trust.ts').toString('utf8'), /decide\(actionId: string, expected: number, deviceId: string, input: unknown\)/);
      assert.match(files.get('server/policy/auto-policy.ts').toString('utf8'), /new WeakMap<Tool, Classifier>/);
      for (const path of ['server/pi-adapter/runtime.ts', 'server/pi-adapter/remote-runtime.ts']) {
        const runtime = files.get(path).toString('utf8');
        assert.match(runtime, /awaitDecisionAndDispatch/);
        assert.match(runtime, /startRuntime\(taskId\)/);
        assert.match(runtime, /finishRuntime\(taskId\)/);
        assert.match(runtime, /needsAttention/);
      }
      assert.doesNotMatch(files.get('server/operations/hosts.ts').toString('utf8'), /approval\/evidence gate/);
    });

    await t.test('auto-update helper imports are self-contained without executing privileged code', () => {
      const helper = files.get('deploy/environment/auto_update.py').toString('utf8');
      assert.match(helper, /^import host_update$/m);
      assert.match(helper, /^from host_install import /m);
      for (const name of ['auto_update', 'host_install', 'host_update']) {
        assert.ok(files.get(`deploy/environment/${name}.py`)?.length > 0, name);
      }
      assert.match(files.get('server/scheduler/tools.ts').toString('utf8'), /recovery\.data\.dispatchEnabled === true/);
    });

    await t.test('privacy sources remain unchanged and artifact contains no new state directories', () => {
      for (const path of ['server/pi-management/profile.ts', 'server/pi-management/auth-flows.ts',
        'server/pi-management/transfers.ts', 'server/pi-management/transfer-contracts.ts', 'server/pi-worker/http.ts']) {
        assert.deepEqual(files.get(path), baseline.get(path), path);
      }
      const directories = paths => new Set(paths.flatMap(path => {
        const parts = path.split('/');
        return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
      }));
      assert.deepEqual(directories([...files.keys()]), directories([...baseline.keys()]));
      for (const path of files.keys()) {
        assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|\.pi|\.outpost-native-work|async-subagent-runs|auth\.json|settings\.json)(?:\/|$)/);
      }
    });

    await t.test('only Pi and subagents direct pins change; lock matches every exact direct pin', () => {
      const expected = json(baseline.get('package.json'));
      expected.dependencies['@earendil-works/pi-coding-agent'] = '1.5.2';
      expected.dependencies['pi-subagents'] = '0.88.1';
      assert.deepEqual(json(files.get('package.json')), expected);
      assert.deepEqual(files.get('package.json'), readFileSync(join(sourceRoot, packagePaths[0])));
      assert.deepEqual(files.get('package-lock.json'), readFileSync(join(sourceRoot, packagePaths[1])));
      const lock = json(files.get('package-lock.json'));
      assert.deepEqual(lock.packages[''].dependencies, expected.dependencies);
      for (const [name, version] of Object.entries({ ...expected.dependencies, ...expected.devDependencies })) {
        assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
        assert.ok(lock.packages[`node_modules/${name}`].integrity, name);
      }
      assert.equal(files.get('package-lock.json').includes('playwright-camoufox'), false);
    });

    await t.test('content ID includes sorted full source, provenance and lock; artifact and manifest agree', () => {
      const hash = createHash('sha256');
      for (const path of [...files.keys()].filter(path => path !== 'host-manifest.json').sort()) hash.update(path + '\0').update(files.get(path));
      const id = `host-${hash.digest('hex').slice(0, 20)}`;
      const manifest = { schema: 2, id, protocolVersion: 2, layoutVersion: 1, compatibility: 'native-v1',
        sequence: policy.legacySequence, rollback: true, piVersion: '1.5.2',
        extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }, { name: 'pi-subagents', version: '0.88.1' }] };
      assert.deepEqual(json(files.get('host-manifest.json')), manifest);
      assert.deepEqual(metadata, { schema: 1, id, manifest, sha256: sha256(archive), size: archive.length,
        sourceRelease, compatibleSourceReleases, updateScope: 'compatible-server', extensionPolicy: 'native-installed', requiredTools,
        runtimePinsSha256: sha256(baseline.get(pinsPath)), ...json(baseline.get(pinsPath)) });
      assert.deepEqual(json(readFileSync(join(outputDir, 'pi-release.json'))), metadata);
      const provenance = json(files.get('pi-update-source.json'));
      assert.equal(provenance.sourceRelease, sourceRelease);
      assert.equal(provenance.baselineSha256, baselineSha256);
      assert.deepEqual(provenance.overlayPaths, [...overlays].sort());
      assert.equal(Object.hasOwn(provenance, 'runtimeVersionPatched'), false);
      assert.equal(provenance.extensionPolicy, 'native-installed');
      assert.equal(provenance.targetSequence, policy.legacySequence);
      assert.deepEqual(provenance.requiredTools, requiredTools);
      assert.deepEqual(provenance.patchedPaths, [coordinatorPath, mainPath]);
      assert.deepEqual(provenance.compatibleSourceReleases, compatibleSourceReleases);
      assert.ok(Object.isFrozen(metadata.compatibleSourceReleases));
      assert.throws(() => metadata.compatibleSourceReleases.push('host-00000000000000000000'), TypeError);
      assert.equal(metadata.compatibleSourceReleases.includes('host-00000000000000000000'), false);
      const changed = [...files.keys()].filter(path => !['host-manifest.json', 'pi-update-source.json'].includes(path) && !files.get(path).equals(baseline.get(path) ?? Buffer.alloc(0))).sort();
      assert.deepEqual(provenance.changedFiles, changed);
      assert.ok(changed.includes('package-lock.json'));
      assert.ok(changed.includes(coordinatorPath));
      assert.ok(Object.isFrozen(metadata.requiredTools));
      const priorHash = createHash('sha256');
      for (const path of [...files.keys()].filter(path => path !== 'host-manifest.json').sort()) {
        const bytes = path === 'pi-update-source.json'
          ? Buffer.from(JSON.stringify({ ...provenance, targetSequence: policy.legacySequence - 1 }, null, 2) + '\n') : files.get(path);
        priorHash.update(path + '\0').update(bytes);
      }
      assert.notEqual(`host-${priorHash.digest('hex').slice(0, 20)}`, id, 'Sequence is bound to the archive identity');
    });

    await t.test('offline rebuild ignores mtimes and nonallowlisted current files', () => {
      put(sourceRoot, 'package.json', 'INVALID CURRENT ROOT PACKAGE');
      put(sourceRoot, 'package-lock.json', 'INVALID CURRENT ROOT LOCK');
      put(sourceRoot, pinsPath, '{"camoufoxVersion":"must-not-be-used"}');
      put(sourceRoot, 'server/gateway/coordinator.ts', 'MUST NOT OVERLAY');
      put(sourceRoot, mainPath, 'MUST NOT OVERLAY CURRENT BROWSER CONFIGURATION');
      put(sourceRoot, 'server/browser-engine/uv.lock', 'MUST NOT ADD');
      for (const path of ['.pi/auth.json', 'data/private.json', 'node_modules/private.json',
        'server/pi-management/.outpost-native-work/private.json', 'server/pi-worker/sessions/private.json']) {
        put(sourceRoot, path, 'PRIVATE STATE MUST NOT BE PACKAGED');
      }
      for (const path of [...overlays, ...packagePaths]) utimesSync(join(sourceRoot, path), 1234567890, 1234567890);
      const second = join(temporary, 'second');
      assert.deepEqual(buildPiUpdate({ outputDir: second, sourceRoot }), metadata);
      assert.deepEqual(readFileSync(join(second, 'pi-release.tar.gz')), archive);
      assert.deepEqual(readFileSync(join(second, 'pi-release.json')), readFileSync(join(outputDir, 'pi-release.json')));
    });

    await t.test('changed allowed source and lock bytes each change the content ID', () => {
      for (const path of [overlays[0], packagePaths[1], runtimePath, 'server/pi-management/session-background.ts',
        'server/pi-management/session-extensions.ts', 'server/pi-worker/main.ts', 'server/environment/qualify-runtime.ts',
        'server/scheduler/tools.ts', workspacePath, ...subagentPaths, ...controlPaths]) {
        const original = readFileSync(join(sourceRoot, path));
        try {
          writeFileSync(join(sourceRoot, path), Buffer.concat([original, Buffer.from('\n')]));
          const changed = buildPiUpdate({ outputDir: join(temporary, 'changed'), sourceRoot });
          assert.notEqual(changed.id, metadata.id, path);
          assert.notEqual(changed.sha256, metadata.sha256, path);
          assert.equal(changed.manifest.sequence, metadata.manifest.sequence, 'Content changes do not allocate release sequences');
        } finally { writeFileSync(join(sourceRoot, path), original); }
      }
    });

    await t.test('legacy policy sequence is explicit, validated and bound to content identity', () => {
      const original = readFileSync(join(sourceRoot, policyPath));
      try {
        put(sourceRoot, policyPath, JSON.stringify({ ...policy, legacySequence: policy.legacySequence + 1 }));
        const changed = buildPiUpdate({ outputDir: join(temporary, 'next-legacy'), sourceRoot });
        assert.equal(changed.manifest.sequence, policy.legacySequence + 1);
        assert.notEqual(changed.id, metadata.id);
        assert.equal(Object.hasOwn(changed.manifest, 'legacySequence'), false);
        for (const legacySequence of [undefined, 0, -1, 1.5, '8', Number.MAX_SAFE_INTEGER + 1]) {
          put(sourceRoot, policyPath, JSON.stringify({ ...policy, legacySequence }));
          assert.throws(() => buildPiUpdate({ outputDir: join(temporary, 'invalid-policy'), sourceRoot }), /Invalid qualified legacy release policy/);
          assert.equal(existsSync(join(temporary, 'invalid-policy')), false);
        }
      } finally { put(sourceRoot, policyPath, original); }
    });

    await t.test('fails closed before publication for tampered snapshot, dependency drift and unresolved imports', () => {
      const cases = [
        [baselinePath, bytes => Buffer.concat([bytes, Buffer.from('tampered')]), /Baseline archive SHA-256 mismatch/],
        [packagePaths[0], bytes => { const value = json(bytes); value.dependencies.playwright = 'npm:playwright-camoufox@1.0.0'; return JSON.stringify(value); }, /package metadata\/direct dependencies drifted/],
        [packagePaths[0], bytes => { const value = json(bytes); value.scripts.build = 'changed'; return JSON.stringify(value); }, /package metadata\/direct dependencies drifted/],
        [packagePaths[1], bytes => { const value = json(bytes); value.packages['node_modules/@earendil-works/pi-coding-agent'].version = '1.4.0'; return JSON.stringify(value); }, /Locked dependency version\/integrity mismatch/],
        [packagePaths[1], bytes => { const value = json(bytes); value.packages['node_modules/pi-subagents'].version = '0.88.0'; return JSON.stringify(value); }, /Locked dependency version\/integrity mismatch/],
        [packagePaths[1], bytes => { const value = json(bytes); value.packages[''].dependencies.playwright = '1.0.0'; return JSON.stringify(value); }, /Lock root metadata\/dependencies drifted/],
        ['server/scheduler/tools.ts', bytes => bytes + "\nimport '../missing-baseline-module.js';\n", /Unresolved baseline-relative import/],
        [workspacePath, bytes => bytes + "\nimport '../missing-review-module.js';\n", /Unresolved baseline-relative import/],
        ['deploy/environment/auto_update.py', bytes => bytes + '\nimport missing_bundled_helper\n', /Unresolved bundled Python import/],
        ['deploy/environment/auto_update.py', bytes => bytes + '\nfrom .missing_bundled_helper import check\n', /Unresolved bundled Python import/],
        ['server/pi-worker/main.ts', () => '', /Missing service entrypoint/],
      ];
      for (const [path, transform, error] of cases) {
        const original = readFileSync(join(sourceRoot, path));
        const rejected = join(temporary, 'rejected');
        try {
          writeFileSync(join(sourceRoot, path), transform(original));
          assert.throws(() => buildPiUpdate({ outputDir: rejected, sourceRoot }), error, path);
          assert.equal(existsSync(rejected), false, 'A failed build must not publish artifacts');
        } finally { writeFileSync(join(sourceRoot, path), original); }
      }
      for (const path of [...subagentPaths, ...controlPaths]) {
        const original = readFileSync(join(sourceRoot, path));
        try {
          rmSync(join(sourceRoot, path));
          assert.throws(() => buildPiUpdate({ outputDir: join(temporary, 'missing-overlay'), sourceRoot }), /ENOENT/, path);
          assert.equal(existsSync(join(temporary, 'missing-overlay')), false);
        } finally { put(sourceRoot, path, original); }
      }
      const path = overlays[0], original = readFileSync(join(sourceRoot, path));
      try {
        rmSync(join(sourceRoot, path));
        symlinkSync(join(root, path), join(sourceRoot, path));
        assert.throws(() => buildPiUpdate({ outputDir: join(temporary, 'rejected'), sourceRoot }), /must not be a symlink/);
      } finally {
        rmSync(join(sourceRoot, path));
        writeFileSync(join(sourceRoot, path), original);
      }
    });

    await t.test('all five reviewed sources pass preflight; changed pins and omitted service entrypoints fail before checkpoint', () => {
      const staged = join(temporary, 'guard-source');
      for (const [path, bytes] of files) put(staged, path, bytes);
      put(sourceRoot, 'baseline-manifest.json', baseline.get('host-manifest.json'));
      execFileSync('python3', ['-B', '-c', `
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'deploy/environment'))
import host_update as update
root = pathlib.Path(sys.argv[2])
previous, operation = root / 'previous', root / 'operation'
previous.mkdir(parents=True)
(operation / 'source/deploy/environment').mkdir(parents=True)
(previous / 'deploy/environment').mkdir(parents=True)
(root / 'current').symlink_to(previous)
update.PREFIX = root
source = json.loads(pathlib.Path(sys.argv[3]).read_text())
obj = object.__new__(update.Updater)
obj.previous, obj.operation, obj.release = previous, operation, root / 'not-yet-created'
manifest = json.loads((pathlib.Path(sys.argv[1]) / 'host-manifest.json').read_text())
checkpoints = []
obj.checkpoint = checkpoints.append
pins = (pathlib.Path(sys.argv[1]) / 'deploy/environment/runtime-pins.json').read_bytes()
(previous / 'deploy/environment/runtime-pins.json').write_bytes(pins)
target = operation / 'source/deploy/environment/runtime-pins.json'
for name in json.loads(sys.argv[5]):
    destination = operation / 'source' / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes((pathlib.Path(sys.argv[1]) / name).read_bytes())
# Synthetic installed manifests exercise each reviewed ID without reading a live host.
installed = [source] + [dict(manifest, id=release, sequence=2) for release in json.loads(sys.argv[4])[1:]]
for current in installed:
    (previous / 'host-manifest.json').write_text(json.dumps(current))
    obj.installation = {'environmentId': 'isolated', 'release': current['id']}
    obj.request = {'environmentId': 'isolated', 'expectedRelease': current['id'], 'target': manifest}
    target.write_bytes(pins)
    obj.preflight()
    assert checkpoints == ['stage']
    checkpoints.clear()
    target.write_bytes(pins + b'\\n')
    try:
        obj.preflight()
    except update.PreflightFailure as error:
        assert error.code == 'runtime_pins_mismatch'
    else:
        raise AssertionError('Runtime pins guard was relaxed')
    assert checkpoints == []
    target.write_bytes(pins)
    for name in json.loads(sys.argv[5]):
        entrypoint = operation / 'source' / name
        saved = entrypoint.read_bytes()
        entrypoint.unlink()
        try:
            obj.preflight()
        except update.PreflightFailure as error:
            assert error.code == 'missing_service_files'
        else:
            raise AssertionError('Missing service entrypoint was accepted: ' + name)
        finally:
            entrypoint.write_bytes(saved)
        assert checkpoints == []
`, staged, join(temporary, 'guard'), join(sourceRoot, 'baseline-manifest.json'), JSON.stringify(compatibleSourceReleases), JSON.stringify(serviceEntrypoints)], {
        // Only a local fixture is read; no installer/update entry point is invoked.
        timeout: 30000,
      });
    });
  });

  const hostOutputDir = join(temporary, 'host-output');
  const hostMetadata = buildHostRelease({ outputDir: hostOutputDir });
  const hostArchive = readFileSync(join(hostOutputDir, 'host-release.tar.gz'));
  const hostFiles = archiveFiles(join(hostOutputDir, 'host-release.tar.gz'));
  const hostStage = join(temporary, 'host-source');
  await test('both packaged runtime families qualify workspace review before fixture signing', async t => {
    await t.test('policy exceeds shipped host-7 / legacy-6 sequences without changing runtime families', () => {
      assert.ok(policy.sequence > 7);
      assert.ok(policy.legacySequence > 6);
      assert.equal(hostMetadata.manifest.sequence, policy.sequence);
      assert.equal(metadata.manifest.sequence, policy.legacySequence);
      assert.notEqual(hostMetadata.runtimePinsSha256, metadata.runtimePinsSha256);
      assert.deepEqual(hostFiles.get(pinsPath), readFileSync(join(root, pinsPath)));
      assert.deepEqual(files.get(pinsPath), baseline.get(pinsPath));
    });
    const { privateKey } = generateKeyPairSync('ed25519');
    for (const [name, packaged, artifact, bytes, staged] of [
      ['host', hostFiles, hostMetadata, hostArchive, hostStage],
      ['legacy', files, metadata, archive, join(temporary, 'legacy-source')],
    ]) {
      for (const [path, content] of packaged) put(staged, path, content);
      // Fast offline coverage uses installed dependencies; --qualify additionally checks each packaged lock.
      symlinkSync(join(root, 'node_modules'), join(staged, 'node_modules'), 'dir');
      const env = qualificationEnvironment(join(temporary, `${name}-review-home`));
      if (name === 'legacy') await t.test('legacy: extracted source typechecks with installed dependencies', () => {
        command(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], staged, env);
      });
      await t.test(`${name}: Full Control and Auto execution, signed approvals, runtime isolation and migration use extracted code`, () => qualifyControlModes(staged, env, name === 'legacy'));
      await t.test(`${name}: coordinator certification, runtime settlement, overlapping drains and shutdown fences`, () => qualifyCoordinatorFences(staged, env));
      await t.test(`${name}: omitting runtime callback or conditional queue claim fails qualification`, () => {
        const original = packaged.get(coordinatorPath).toString('utf8');
        for (const [before, after, pattern] of [
          ['key => !!this.runtimes.get(key)?.isActive(key)', '() => false', 'runtime settlement callback'],
          ['if (!this.db.db.prepare("UPDATE outbox SET state=\'claimed\' WHERE id=? AND state=\'pending\'").run(key).changes) continue;', 'this.db.db.prepare("UPDATE outbox SET state=\'claimed\' WHERE id=? AND state=\'pending\'").run(key);', 'single claim'],
          ['await Promise.allSettled([...this.runtimeJobs, ...this.drains]);', 'await Promise.allSettled([]);', 'shutdown'],
        ]) {
          assert.equal(original.split(before).length, 2, 'Fence mutation must target one audited site');
          try {
            put(staged, coordinatorPath, original.replace(before, after));
            assert.throws(() => qualifyCoordinatorFences(staged, env, pattern), /Packaged coordinator fence qualification failed/);
          } finally { put(staged, coordinatorPath, original); }
        }
      });
      await t.test(`${name}: omitting approval migration fails behavioral qualification`, () => {
        const path = 'server/tasks/tasks.ts', original = packaged.get(path).toString('utf8');
        const migration = 'const paused = retireLegacyApprovals(this.db);';
        assert.equal(original.split(migration).length, 2);
        try {
          put(staged, path, original.replace(migration, 'const paused = new Set<string>();'));
          assert.throws(() => qualifyControlModes(staged, env, name === 'legacy'), /Packaged control-mode qualification failed/);
        } finally { put(staged, path, original); }
      });
      await t.test(`${name}: subagent projection, privacy, remote contracts, public feed and restart use extracted release code`, () => qualifySubagents(staged, env));
      await t.test(`${name}: omitting subagent restart interruption fails behavioral qualification`, () => {
        const coordinator = packaged.get(coordinatorPath).toString('utf8');
        assert.equal(coordinator.split(subagentRestartImport).length, 2);
        assert.equal(coordinator.split(subagentRestart).length, 2);
        try {
          put(staged, coordinatorPath, coordinator.replace(subagentRestart, ''));
          assert.throws(() => qualifySubagents(staged, env), /Restart must interrupt active subagents/);
        } finally { put(staged, coordinatorPath, coordinator); }
      });
      await t.test(`${name}: omitting the public subagent kind fails behavioral qualification`, () => {
        const coordinator = packaged.get(coordinatorPath).toString('utf8');
        assert.equal(coordinator.split(subagentPublicKind).length, 2);
        try {
          put(staged, coordinatorPath, coordinator.replace(subagentPublicKind, ''));
          assert.throws(() => qualifySubagents(staged, env), /subagent_run must be public/);
        } finally { put(staged, coordinatorPath, coordinator); }
      });
      await t.test(`${name}: authenticated workspace.files/read exercise extracted release code`, () => {
        assert.deepEqual(packaged.get(workspacePath), readFileSync(join(root, workspacePath)));
        qualifyWorkspaceReview(staged, env);
        const signed = signArtifact(artifact, bytes, privateKey, inspectArchive(bytes));
        const payload = JSON.parse(Buffer.from(signed.authorization.payload, 'base64'));
        assert.deepEqual(payload.manifest, artifact.manifest);
        assert.equal(Object.hasOwn(payload.manifest, 'legacySequence'), false);
      });
      await t.test(`${name}: removing the query handlers fails behavioral qualification`, () => {
        const coordinator = packaged.get(coordinatorPath).toString('utf8');
        assert.equal(coordinator.split(workspaceQueries).length, 2);
        try {
          put(staged, coordinatorPath, coordinator.replace(workspaceQueries, ''));
          assert.throws(() => qualifyWorkspaceReview(staged, env), /Unsupported query/);
        } finally { put(staged, coordinatorPath, coordinator); }
      });
    }
    await t.test('host source bytes and policy changes affect identity; missing review module fails before publication', () => {
      const original = hostFiles.get(workspacePath), originalPolicy = hostFiles.get(policyPath);
      try {
        const rebuilt = buildHostRelease({ outputDir: join(temporary, 'host-rebuilt'), sourceRoot: hostStage });
        assert.equal(rebuilt.id, hostMetadata.id);
        put(hostStage, workspacePath, Buffer.concat([original, Buffer.from('\n')]));
        const changed = buildHostRelease({ outputDir: join(temporary, 'host-changed'), sourceRoot: hostStage });
        assert.notEqual(changed.id, hostMetadata.id);
        assert.equal(changed.manifest.sequence, hostMetadata.manifest.sequence);
        put(hostStage, workspacePath, original);
        put(hostStage, policyPath, JSON.stringify({ ...policy, sequence: policy.sequence + 1 }));
        const next = buildHostRelease({ outputDir: join(temporary, 'host-next'), sourceRoot: hostStage });
        assert.notEqual(next.id, hostMetadata.id);
        assert.equal(next.manifest.sequence, policy.sequence + 1);
        for (const sequence of [undefined, 0, -1, 1.5, '9', Number.MAX_SAFE_INTEGER + 1]) {
          put(hostStage, policyPath, JSON.stringify({ ...policy, sequence }));
          assert.throws(() => buildHostRelease({ outputDir: join(temporary, 'invalid-host-policy'), sourceRoot: hostStage }), /Invalid qualified release policy/);
          assert.equal(existsSync(join(temporary, 'invalid-host-policy')), false);
        }
        put(hostStage, policyPath, originalPolicy);
        rmSync(join(hostStage, workspacePath));
        assert.throws(() => buildHostRelease({ outputDir: join(temporary, 'host-rejected'), sourceRoot: hostStage }), /Incomplete server release: server\/artifacts\/workspace-review\.ts/);
        assert.equal(existsSync(join(temporary, 'host-rejected')), false);
      } finally { put(hostStage, workspacePath, original); put(hostStage, policyPath, originalPolicy); }
    });
  });

  if (process.argv.includes('--qualify')) {
    const hostLocked = join(temporary, 'host-qualification');
    for (const [path, bytes] of hostFiles) put(hostLocked, path, bytes);
    await test('authenticated workspace review with the current host dependency lock', () => {
      const env = qualificationEnvironment(join(temporary, 'host-qualification-home'));
      command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], hostLocked, env);
      qualifyWorkspaceReview(hostLocked, env);
      qualifySubagents(hostLocked, env);
      qualifyControlModes(hostLocked, env);
      qualifyCoordinatorFences(hostLocked, env);
    });
    const staged = join(temporary, 'qualification');
    const tsxLoader = join(staged, 'node_modules/tsx/dist/loader.mjs');
    for (const [path, bytes] of files) put(staged, path, bytes);
    const home = join(temporary, 'qualification-home');
    const env = qualificationEnvironment(home);
    await test('qualification of extracted artifact (dependency downloads; scripts disabled)', async t => {
      command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], staged, env);
      await t.test('authenticated workspace review with the frozen legacy dependency lock', () => qualifyWorkspaceReview(staged, env));
      await t.test('subagent integration with the frozen legacy dependency lock', () => qualifySubagents(staged, env));
      await t.test('Full Control and Auto behavior with the frozen legacy dependency lock', () => qualifyControlModes(staged, env, true));
      await t.test('coordinator lifecycle fences with the frozen legacy dependency lock', () => qualifyCoordinatorFences(staged, env));
      await t.test('real installed native extensions load resources and activate tools without opt-in or adapters', () => {
        command(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { sessionExtensions } from './server/pi-management/session-extensions.ts';
const home = process.env.HOME, cwd = join(home, 'native-workspace'), agentDir = join(home, 'native-agent');
mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
globalThis.fetch = async () => { throw new Error('Native loading qualification must not use the network'); };
const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider('qualification', { api: 'openai-completions', baseUrl: 'https://outpost-qualification.invalid/v1', apiKey: 'synthetic', models: [
  { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
] });
const extensions = await sessionExtensions({ cwd, agentDir, systemPrompt: 'Synthetic native extension qualification', modelRuntime: runtime });
const loaded = extensions.loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const declared = [];
for (const name of ['pi-ollama-cloud', 'pi-subagents']) {
  const directory = realpathSync(join(process.cwd(), 'node_modules', name));
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  for (const path of metadata.pi.extensions) declared.push(realpathSync(join(directory, path)));
}
assert.deepEqual(loaded.extensions.map(extension => extension.resolvedPath).sort(), declared.sort());
assert.ok(extensions.toolNames.includes('subagent'));
assert.ok(extensions.loader.getSkills().skills.length > 0);
assert.ok(extensions.loader.getPrompts().prompts.length > 0);
assert.equal(extensions.background.enabled, true);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: extensions.loader,
  modelRuntime: runtime, model: runtime.getModel('qualification', 'fixture'), noTools: 'builtin',
  sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(), customTools: [
    { name: 'outpost_action', label: 'Action', description: 'Synthetic coordinator action', parameters: Type.Object({}),
      execute: async () => { throw new Error('No coordinator actions allowed during qualification'); } },
  ] });
try {
  await extensions.bind(session);
  const active = session.getActiveToolNames();
  assert.ok(['outpost_action', 'subagent', 'ollama_web_search', ...extensions.toolNames].every(name => active.includes(name)));
  extensions.check();
} finally { await extensions.dispose(session); }
`], staged, env);
      });
      await t.test('baseline coordinator exposes full-control automation tools with maintenance and strict recovery gates', () => {
        command(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Ledger } from './server/core/ledger.ts';
import { Coordinator } from './server/gateway/coordinator.ts';
globalThis.fetch = async () => { throw new Error('Automation qualification must not use the network'); };
const db = new Ledger();
const coordinator = new Coordinator(db, join(process.env.HOME, 'automation'), {
  worker: { request: async () => { throw new Error('No worker calls allowed during qualification'); } },
});
try {
  const taskId = randomUUID();
  coordinator.tasks.create(taskId, { goal: 'Qualification only', profile: 'code', mode: 'full_control' });
  const gate = coordinator.gate(taskId);
  const names = gate.catalogue().map(tool => tool.name);
  for (const name of ${JSON.stringify(requiredTools)}) assert.equal(names.filter(value => value === name).length, 1);
  const save = { automationId: 'qualification', expectedRevision: 0, schedule: {
    name: 'Never executed', timezone: 'UTC', nextAt: Date.now() + 3600000,
    intervalMs: null, missed: 'skip', task: { goal: 'Synthetic only', profile: 'code', mode: 'full_control' },
  } };
  assert.equal(gate.policy(taskId).data.mode, 'full_control');
  const authorized = await gate.propose(taskId, 'automation.save', save);
  assert.equal(authorized.data.state, 'authorized');
  assert.equal(db.get('automation', save.automationId), undefined);
  assert.equal(db.list('inbox').length, 0);
  assert.equal((await gate.dispatch(authorized.id)).data.state, 'succeeded');
  assert.equal(db.need('automation', save.automationId).revision, 1);
  assert.equal(db.need('automation', save.automationId).data.task.mode, 'full_control');
  const pause = { automationId: save.automationId, expectedRevision: 1, paused: true };
  const setState = (kind, data) => db.put(kind, 'server', db.get(kind, 'server')?.revision ?? 0, data);
  for (const state of ['draining', 'holding', 'prepared']) {
    setState('runtime_update', { state });
    await assert.rejects(() => gate.propose(taskId, 'automation.save', { ...save, automationId: 'blocked' }), /maintenance_in_progress/);
    await assert.rejects(() => gate.propose(taskId, 'automation.set_paused', pause), /maintenance_in_progress/);
  }
  setState('runtime_update', { state: 'idle' });
  for (const recovery of [{ dispatchEnabled: false }, {}, { dispatchEnabled: 'true' }, { dispatchEnabled: 1 }]) {
    setState('recovery', { dispatchEnabled: true });
    const beforeHold = await gate.propose(taskId, 'automation.set_paused', pause);
    setState('recovery', recovery);
    await assert.rejects(() => gate.propose(taskId, 'automation.save', { ...save, automationId: 'blocked' }), /recovery_dispatch_disabled/);
    await assert.rejects(() => gate.propose(taskId, 'automation.set_paused', pause), /recovery_dispatch_disabled/);
    await assert.rejects(() => gate.dispatch(beforeHold.id), /recovery_dispatch_disabled/);
    assert.equal(db.need('automation', save.automationId).revision, 1);
    await assert.rejects(() => gate.propose(taskId, 'automation.list', {}), /recovery_dispatch_disabled/);
  }
  setState('recovery', { dispatchEnabled: true });
  const pausing = await gate.propose(taskId, 'automation.set_paused', pause);
  assert.equal((await gate.dispatch(pausing.id)).data.state, 'succeeded');
  assert.equal(db.need('automation', save.automationId).data.paused, true);
  assert.equal(db.list('task').length, 1, 'Qualification must not run scheduled tasks');
} finally { coordinator.live.close(); db.close(); }
`], staged, env);
      });
      await t.test('packaged qualification entry point: synthetic runtime smoke test', () => {
        command(process.execPath, ['--import', tsxLoader, 'server/environment/qualify-runtime.ts'], staged, env);
      });
      await t.test('baseline TypeScript configuration: tsc --noEmit', { skip: !files.has('tsconfig.json') }, () => {
        command(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], staged, env);
      });
      await t.test('baseline strict schema accepts the packaged host manifest', () => {
        command(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e',
          "import {readFileSync} from 'node:fs'; import {ReleaseManifest} from './server/pi-management/update-contracts.ts'; ReleaseManifest.parse(JSON.parse(readFileSync('host-manifest.json', 'utf8')));"], staged, env);
      });
    });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
