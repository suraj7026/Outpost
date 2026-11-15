import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, sign, createHash } from 'node:crypto';
const enrollment = JSON.parse(readFileSync('/test/request.json')), bridge = JSON.parse(readFileSync('/test/bridge.json'));
assert.equal(enrollment.label, 'Disposable Linux installer');
const prefix = '/opt/outpost-native', original = `${prefix}/releases/${enrollment.releaseId}`, legacy = `${prefix}/releases/${bridge.expectedRelease}`;
const run = argv => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const units = ['outpost-native-coordinator.service', 'outpost-native-worker.service', 'outpost-native-host.service'];
const resumeLegacy = process.argv.includes('--resume-legacy');
if (!resumeLegacy) {
if (!existsSync(legacy)) {
  mkdirSync(legacy); run(['tar', '-xzf', '/test/legacy.tar.gz', '-C', legacy]);
  for (const name of ['node', 'node_modules']) symlinkSync(`${original}/${name}`, `${legacy}/${name}`);
} else {
  assert.ok(process.argv.includes('--reset-legacy-fixture'), 'Reusing a prior fixture needs an explicit isolated-fixture reset');
  assert.equal(JSON.parse(readFileSync(`${legacy}/host-manifest.json`)).id, bridge.expectedRelease);
  assert.ok(!existsSync('/var/lib/outpost-native/worker/profile/.outpost-maintenance.json'));
  run([`${original}/node/bin/node`, '--import', `${original}/node_modules/tsx/dist/loader.mjs`, '--input-type=module', '-e',
    `import {Ledger} from '${original}/server/core/ledger.ts';const db=new Ledger('/var/lib/outpost-native/coordinator/ledger.sqlite');try{if(db.list('task').some(t=>['queued','running'].includes(t.data.state))||!['finished','cancelled'].includes(db.need('runtime_update','server').data.state))throw Error('Fixture is not idle');}finally{db.close();}`]);
}
run(['systemctl', 'stop', ...units]);
for (const path of ['/etc/outpost-native/coordinator.env', '/etc/outpost-native/worker.env', ...units.map(name => `/etc/systemd/system/${name}`)]) {
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll(original, legacy).replaceAll(enrollment.releaseId, bridge.expectedRelease));
}
symlinkSync(legacy, `${prefix}/legacy.fixture`); renameSync(`${prefix}/legacy.fixture`, `${prefix}/current`);
const installation = JSON.parse(readFileSync('/etc/outpost-native/installation.json')); installation.release = bridge.expectedRelease;
writeFileSync('/etc/outpost-native/installation.json', JSON.stringify(installation));
}
const auth = '/var/lib/outpost-native/worker/profile/auth.json';
writeFileSync(auth, JSON.stringify({ anthropic: { type: 'api_key', key: 'disposable-legacy-canary' } }), { mode: 0o600 }); run(['chown', 'outpost-pi:outpost-pi', auth]);
run(['systemctl', 'daemon-reload']); run(['systemctl', 'start', ...units]);
async function descriptor(expected) {
  for (let n = 0; n < 120; n++) {
    try { const value = await (await fetch('http://127.0.0.1:4518/v2/environment')).json(); if (value.runtime.release === expected && value.environmentId === enrollment.environmentId) return value; } catch {}
    await delay(1000);
  }
  throw Error('Fixture identity/release health timed out');
}
await descriptor(bridge.expectedRelease);
console.log('PASS: Exact schema-1 production source runs with an independent disposable enrollment');
const stage = `/test/bridge-source-${randomUUID()}`; mkdirSync(stage); run(['tar', '-xzf', '/test/bridge.tar.gz', '-C', stage]);
const badStage = `/test/bad-bridge-${randomUUID()}`; mkdirSync(badStage); run(['tar', '-xzf', '/test/bridge.tar.gz', '-C', badStage]);
const badManifest = { ...bridge.manifest, id: `host-${createHash('sha256').update(bridge.manifest.id + ':fault:' + randomUUID()).digest('hex').slice(0, 20)}` };
writeFileSync(`${badStage}/host-manifest.json`, JSON.stringify(badManifest));
writeFileSync(`${badStage}/server/pi-worker/main.ts`, "throw new Error('Disposable bridge startup fault');\n");
run(['tar', '-czf', '/test/bad-bridge.tar.gz', '-C', badStage, '.']);
const badBytes = readFileSync('/test/bad-bridge.tar.gz');
const badRequest = { operationId: randomUUID(), environmentId: enrollment.environmentId, deviceId: enrollment.deviceId,
  releaseId: badManifest.id, expectedRelease: bridge.expectedRelease, target: badManifest, sha256: createHash('sha256').update(badBytes).digest('hex'), size: badBytes.length };
execFileSync('python3', [`${stage}/deploy/environment/native_bridge.py`, '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(badRequest) + '\n'), badBytes]) });
let badOutcome;
for (let n = 0; n < 900; n++) {
  badOutcome = JSON.parse(readFileSync(`/var/lib/outpost-setup/operations/${badRequest.operationId}/status.json`));
  if (['complete', 'failed', 'rolled_back', 'needs_attention'].includes(badOutcome.state)) break;
  await delay(1000);
}
assert.equal(badOutcome.state, 'rolled_back', JSON.stringify(badOutcome));
await descriptor(bridge.expectedRelease);
assert.equal(JSON.parse(readFileSync(auth)).anthropic.key, 'disposable-legacy-canary');
console.log('PASS: Failed bridge activation rolls back to the exact schema-1 source and preserves provider data');
// Fail both activation and rollback through a real systemd pre-start failure.
const dropIn = '/etc/systemd/system/outpost-native-worker.service.d'; mkdirSync(dropIn, { recursive: true });
const fault = `${dropIn}/qualification-fault.conf`; assert.ok(!existsSync(fault));
writeFileSync(fault, '[Service]\nExecStartPre=/usr/bin/false\n'); run(['systemctl', 'daemon-reload']);
const recoveryManifest = { ...bridge.manifest, id: `host-${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 20)}` };
writeFileSync(`${badStage}/host-manifest.json`, JSON.stringify(recoveryManifest));
run(['tar', '-czf', '/test/recovery-fault.tar.gz', '-C', badStage, '.']);
const recoveryBytes = readFileSync('/test/recovery-fault.tar.gz');
const recoveryRequest = { ...badRequest, operationId: randomUUID(), releaseId: recoveryManifest.id, target: recoveryManifest,
  sha256: createHash('sha256').update(recoveryBytes).digest('hex'), size: recoveryBytes.length };
execFileSync('python3', [`${stage}/deploy/environment/native_bridge.py`, '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(recoveryRequest) + '\n'), recoveryBytes]) });
let recoveryOutcome;
for (let n = 0; n < 900; n++) {
  recoveryOutcome = JSON.parse(readFileSync(`/var/lib/outpost-setup/operations/${recoveryRequest.operationId}/status.json`));
  if (['complete', 'failed', 'rolled_back', 'needs_attention'].includes(recoveryOutcome.state)) break;
  await delay(1000);
}
assert.equal(recoveryOutcome.state, 'needs_attention');
assert.deepEqual(JSON.parse(readFileSync('/var/lib/outpost-native/worker/profile/.outpost-maintenance.json')), { owner: enrollment.deviceId, operationId: recoveryRequest.operationId });
assert.equal(JSON.parse(readFileSync(auth)).anthropic.key, 'disposable-legacy-canary');
console.log('PASS: Real failed rollback retains the operation-bound worker hold and fixture credentials');
// Explicit fixture-only administrator recovery: remove only our fault, independently
// verify the retained old services, then finish the same bound checkpoint under lock.
unlinkSync(fault); run(['systemctl', 'daemon-reload']); run(['systemctl', 'reset-failed', ...units]); run(['systemctl', 'start', ...units]);
run(['python3', '-c', `import sys,fcntl;sys.path.insert(0,'${stage}/deploy/environment');from native_bridge import NativeBridge,OPERATIONS\nwith (OPERATIONS.parent/'install.lock').open('a') as lock:\n fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\n bridge=NativeBridge(OPERATIONS/'${recoveryRequest.operationId}');bridge.checkpointed=True;bridge.health('${bridge.expectedRelease}');bridge.release_hold();bridge.publish('rolled_back','Explicit fixture administrator verified recovery')`]);
await descriptor(bridge.expectedRelease); assert.ok(!existsSync('/var/lib/outpost-native/worker/profile/.outpost-maintenance.json'));
console.log('PASS: Explicit inspected recovery verifies old health before releasing the same checkpoint');
const request = { operationId: randomUUID(), environmentId: enrollment.environmentId, deviceId: enrollment.deviceId,
  releaseId: bridge.manifest.id, expectedRelease: bridge.expectedRelease, target: bridge.manifest, sha256: bridge.sha256, size: bridge.size };
const reply = JSON.parse(execFileSync('python3', [`${stage}/deploy/environment/native_bridge.py`, '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(request) + '\n'), readFileSync('/test/bridge.tar.gz')]), encoding: 'utf8' }));
assert.equal(reply.operationId, request.operationId);
let outcome;
for (let n = 0; n < 900; n++) {
  outcome = JSON.parse(readFileSync(`/var/lib/outpost-setup/operations/${request.operationId}/status.json`));
  if (['complete', 'failed', 'rolled_back', 'needs_attention'].includes(outcome.state)) break;
  await delay(1000);
}
assert.equal(outcome.state, 'complete', JSON.stringify(outcome));
await descriptor(bridge.manifest.id);
assert.equal(JSON.parse(readFileSync(auth)).anthropic.key, 'disposable-legacy-canary');
const active = `${prefix}/releases/${bridge.manifest.id}`;
for (const path of ['package-lock.json', 'deploy/environment/runtime-pins.json', 'server/browser/browser-use.ts', 'server/browser/sessions.ts']) assert.deepEqual(readFileSync(`${legacy}/${path}`), readFileSync(`${active}/${path}`));
console.log('PASS: Qualified bridge preserves the actual legacy browser source and dependency/runtime pins');
const body = JSON.stringify({ protocolVersion: 2, environmentId: enrollment.environmentId, deviceId: enrollment.deviceId, issuedAt: Date.now(), type: 'agent', payload: { type: 'runtime.inventory' } });
const response = await fetch('http://127.0.0.1:4518/v2/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-outpost-signature': sign(null, Buffer.from(body), readFileSync('/test/device.pem')).toString('base64') }, body });
assert.equal(response.status, 200); const inventory = await response.json(); assert.equal(inventory.manifest.schema, 2); assert.equal(inventory.providerTransfer, true);
assert.ok(!existsSync('/var/lib/outpost-native/worker/profile/.outpost-maintenance.json'));
console.log('PASS: Existing signed enrollment now reaches Pi maintenance and provider import; bridge releases its hold');
const workerToken = readFileSync('/etc/outpost-native/coordinator/worker-token', 'utf8').trim();
const worker = async request => {
  const response = await fetch('http://127.0.0.1:4520/v1', { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'management', owner: enrollment.deviceId, request }) });
  return { status: response.status, body: await response.json() };
};
const guardOperation = randomUUID(), credentialsBefore = readFileSync(auth);
assert.equal((await worker({ type: 'maintenance.hold', operationId: guardOperation })).body.ready, true);
const heldCatalogue = await worker({ type: 'catalogue' });
assert.notEqual(heldCatalogue.status, 200); assert.ok(JSON.stringify(heldCatalogue.body).includes('maintenance_in_progress'));
assert.equal((await worker({ type: 'runtime.inventory' })).status, 200);
assert.deepEqual(readFileSync(auth), credentialsBefore);
assert.equal((await worker({ type: 'maintenance.release', operationId: guardOperation })).body.released, true);
console.log('PASS: Held catalogue reads cannot refresh credentials; authenticated inventory stays available');
enrollment.releaseId = bridge.manifest.id; writeFileSync('/test/request.json', JSON.stringify(enrollment));
console.log('NATIVE_BRIDGE_QUALIFIED');
