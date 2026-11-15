// Root fixture driver in a disposable, isolated Ubuntu guest only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash, sign } from 'node:crypto';
const enrollment = JSON.parse(readFileSync('/test/request.json'));
assert.equal(enrollment.label, 'Disposable Linux installer');
const root = `/opt/outpost-native/releases/${enrollment.releaseId}`, node = `${root}/node/bin/node`;
const { Ledger } = await import(`${root}/server/core/ledger.ts`);
const { initializeInstallation } = await import(`${root}/server/environment/initialize.ts`);
const key = readFileSync('/test/device.pem');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (argv, options = {}) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
const pass = label => console.log(`PASS: ${label}`);
const api = async (environment, port, payload, signal) => {
  const body = JSON.stringify({ protocolVersion: 2, environmentId: environment, deviceId: enrollment.deviceId, issuedAt: Date.now(), type: 'agent', payload });
  const response = await fetch(`http://127.0.0.1:${port}/v2/agent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-outpost-signature': sign(null, Buffer.from(body), key).toString('base64') }, body, signal: signal ?? AbortSignal.timeout(30000) });
  const value = await response.json(); if (!response.ok) throw Error(`Fixture API rejected ${payload.type}: ${response.status} ${value.error ?? ''}`); return value;
};
const primary = payload => api(enrollment.environmentId, 4518, payload);
const ledgerPath = '/var/lib/outpost-native/coordinator/ledger.sqlite';
const withLedger = fn => { const db = new Ledger(ledgerPath); try { return fn(db); } finally { db.close(); } };
const sourceAuth = '/var/lib/outpost-native/worker/profile/auth.json';
writeFileSync(sourceAuth, JSON.stringify({ anthropic: { type: 'api_key', key: 'fixture-source-secret-canary' } }), { mode: 0o600 });
run(['chown', 'outpost-pi:outpost-pi', sourceAuth]);
const authBefore = readFileSync(sourceAuth), task = randomUUID();
const transferOnly = process.argv.includes('--transfer-only');
if (!transferOnly) withLedger(db => db.put('task', task, 0, { goal: 'Disposable active-work gate', state: 'running', runId: randomUUID() }));

function artifact(sequence, broken = false) {
  const stage = `/test/release-${sequence}`, id = `host-${createHash('sha256').update(`${enrollment.releaseId}:${sequence}:${broken}`).digest('hex').slice(0, 20)}`;
  mkdirSync(stage); run(['tar', '-xzf', `/var/lib/outpost-setup/operations/${enrollment.operationId}/release.tar.gz`, '-C', stage]);
  const target = { ...JSON.parse(readFileSync(`${stage}/host-manifest.json`)), id, sequence };
  writeFileSync(`${stage}/host-manifest.json`, JSON.stringify(target));
  writeFileSync(`${stage}/deploy/environment/host_update.py`, readFileSync('/test/reviewed-host_update.py'));
  if (broken) writeFileSync(`${stage}/server/pi-worker/main.ts`, "throw new Error('Disposable activation fault');\n");
  const archive = `/test/release-${sequence}.tar.gz`; run(['tar', '-czf', archive, '-C', stage, '.']);
  const bytes = readFileSync(archive);
  return { target, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function launch(release, expectedRelease) {
  const operationId = randomUUID();
  await primary({ type: 'maintenance.stage', operationId, expectedRelease, target: release.target, sha256: release.sha256 });
  const request = { operationId, environmentId: enrollment.environmentId, deviceId: enrollment.deviceId, releaseId: release.target.id, expectedRelease, sha256: release.sha256, size: release.bytes.length, target: release.target };
  const reply = JSON.parse(run(['python3', '/test/reviewed-host_update.py', '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(request) + '\n'), release.bytes]) }));
  assert.equal(reply.operationId, operationId); return { request, reply };
}
function status(operation) { return JSON.parse(readFileSync(`/var/lib/outpost-setup/operations/${operation.request.operationId}/status.json`)); }
async function waitFor(operation, predicate, limit = 1500000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    const value = status(operation);
    if (predicate(value)) return value;
    if (['failed', 'needs_attention', 'rolled_back'].includes(value.state)) throw Error(`Unexpected update result: ${value.state}`);
    await delay(1000);
  }
  throw Error('Disposable update timed out');
}
let target = { target: JSON.parse(readFileSync(`${root}/host-manifest.json`)) };
if (!transferOnly) {
target = artifact(2); const update = await launch(target, enrollment.releaseId);
await waitFor(update, value => value.state === 'staging');
assert.equal(withLedger(db => db.need('runtime_update', 'server').data.state), 'staging');
assert.equal(withLedger(db => db.get('recovery', 'server')?.data.dispatchEnabled), undefined);
assert.equal(withLedger(db => db.need('task', task).data.state), 'running');
assert.equal((await primary({ type: 'runtime.inventory' })).releaseId, enrollment.releaseId);
pass('Dependencies stage while the original server and active work remain available');
await waitFor(update, value => value.state === 'waiting_for_idle');
await assert.rejects(primary({ type: 'login.start', operationId: randomUUID(), providerId: 'anthropic', method: 'api_key' }));
assert.equal(withLedger(db => db.need('task', task).data.state), 'running');
withLedger(db => { const row = db.need('task', task); db.put('task', task, row.revision, { ...row.data, state: 'completed' }); });
await waitFor(update, value => value.state === 'complete');
assert.equal((await primary({ type: 'runtime.inventory' })).releaseId, target.target.id);
assert.deepEqual(readFileSync(sourceAuth), authBefore);
assert.equal(withLedger(db => db.need('task', task).data.state), 'completed');
pass('Detached update activates only after idle, preserves credentials/history and verifies both services');
const replay = JSON.parse(run(['python3', '/test/reviewed-host_update.py', '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(update.request) + '\n'), target.bytes]) }));
assert.equal(replay.state, 'complete');
pass('Repeated launch only reads its receipt; no second activation');

const broken = artifact(3, true), rollback = await launch(broken, target.target.id);
await waitFor(rollback, value => value.state === 'rolled_back');
assert.equal((await primary({ type: 'runtime.inventory' })).releaseId, target.target.id);
assert.deepEqual(readFileSync(sourceAuth), authBefore);
assert.equal(withLedger(db => db.need('recovery', 'server').data.dispatchEnabled), true);
pass('Real systemd worker startup failure restores the prior healthy release and dispatch policy');

const interruptedRelease = artifact(4), interrupted = await launch(interruptedRelease, target.target.id);
await waitFor(interrupted, value => value.state === 'staging');
for (let n = 0; n < 100 && !existsSync(`/opt/outpost-native/releases/${interruptedRelease.target.id}`); n++) await delay(100);
run(['systemctl', 'stop', `outpost-update-${interrupted.request.operationId}`]);
assert.equal((await primary({ type: 'runtime.inventory' })).releaseId, target.target.id);
assert.deepEqual(readFileSync(sourceAuth), authBefore);
assert.ok(existsSync(`/opt/outpost-native/releases/${interruptedRelease.target.id}`));
const interruptedReplay = JSON.parse(run(['python3', '/test/reviewed-host_update.py', '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(interrupted.request) + '\n'), interruptedRelease.bytes]) }));
assert.equal(interruptedReplay.state, 'staging');
await primary({ type: 'maintenance.cancel', operationId: interrupted.request.operationId });
pass('Stopping the detached staging job leaves the running release intact and retains partial files; replay never relaunches it');

}
// Independent enrollment, ledger, worker profile, service users and authentication token.
const second = '/var/lib/outpost-qualification-second', secondId = randomUUID(), token = randomBytes(32).toString('hex');
mkdirSync(second, { mode: 0o711 });
for (const name of ['coordinator', 'worker', 'workspaces']) mkdirSync(`${second}/${name}`, { mode: 0o700 });
initializeInstallation(`${second}/coordinator`, { environmentId: secondId, deviceId: enrollment.deviceId, publicKey: enrollment.publicKey, name: 'Disposable second enrollment' });
writeFileSync(`${second}/worker/token`, token, { mode: 0o600 }); writeFileSync(`${second}/coordinator/token`, token, { mode: 0o600 });
run(['chown', '-R', 'outpost-coord:outpost-coord', `${second}/coordinator`]);
run(['chown', '-R', 'outpost-pi:outpost-pi', `${second}/worker`, `${second}/workspaces`]);
const release = `/opt/outpost-native/releases/${target.target.id}`;
writeFileSync(`${release}/pi-second.json`, JSON.stringify({ ...JSON.parse(readFileSync(`${release}/pi-release.json`)), profile: `${second}/worker/profile` }), { mode: 0o644 });
run(['systemd-run', '--unit=outpost-qualification-worker', '--property=User=outpost-pi', '--property=Group=outpost-pi', `--property=WorkingDirectory=${release}`, `--setenv=PI_CODING_AGENT_DIR=${second}/worker/profile`, `--setenv=OUTPOST_PI_RELEASE_FILE=${release}/pi-second.json`, `--setenv=OUTPOST_PI_WORKSPACES=${second}/workspaces`, `--setenv=OUTPOST_PI_SESSIONS=${second}/worker/sessions`, `--setenv=OUTPOST_PI_WORKER_TOKEN_FILE=${second}/worker/token`, '--setenv=OUTPOST_PI_WORKER_PORT=14520', `${release}/node/bin/node`, '--import', 'tsx', `${release}/server/pi-worker/main.ts`]);
run(['systemd-run', '--unit=outpost-qualification-coordinator', '--property=User=outpost-coord', '--property=Group=outpost-coord', `--property=WorkingDirectory=${release}`, `--setenv=OUTPOST_DATA=${second}/coordinator`, '--setenv=OUTPOST_PI_WORKER_URL=http://127.0.0.1:14520', `--setenv=OUTPOST_PI_WORKER_TOKEN_FILE=${second}/coordinator/token`, '--setenv=PORT=14518', '--setenv=OUTPOST_ALLOW_LEGACY_PROTOCOL=false', `${release}/node/bin/node`, '--import', 'tsx', `${release}/server/main.ts`]);
const destination = payload => api(secondId, 14518, payload);
for (let n = 0; ; n++) { try { await destination({ type: 'transfer.inventory' }); break; } catch (error) { if (n > 60) {
  console.error(run(['journalctl', '--no-pager', '-n', '30', '-u', 'outpost-qualification-worker', '-u', 'outpost-qualification-coordinator']));
  try { console.error('Worker diagnostic', await (await fetch('http://127.0.0.1:14520/v1', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'management', owner: enrollment.deviceId, request: { type: 'transfer.inventory' } }) })).json()); } catch {}
  throw error;
} await delay(1000); } }
const prepare = async () => {
  const source = await primary({ type: 'transfer.inventory' }), target = await destination({ type: 'transfer.inventory' });
  assert.notEqual(source.installationId, target.installationId);
  return destination({ type: 'transfer.prepare', operationId: randomUUID(), source, destination: target, selection: [{ provider: source.providers.find(p => p.id === 'anthropic'), replace: true }] });
};
const ticket = await prepare(), sealed = await primary({ type: 'transfer.export', ticket });
assert.ok(!JSON.stringify(sealed).includes('fixture-source-secret-canary'));
// Drop the real HTTP response only after the destination committed the application.
const droppingProxy = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch('http://127.0.0.1:14518/v2/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-outpost-signature': request.headers['x-outpost-signature'] }, body: Buffer.concat(chunks) });
    assert.equal(upstream.status, 200); await upstream.arrayBuffer(); response.destroy();
  } catch { response.destroy(); }
});
await new Promise(resolve => droppingProxy.listen(0, '127.0.0.1', resolve));
try { await assert.rejects(api(secondId, droppingProxy.address().port, { type: 'transfer.apply', sealed })); }
finally { await new Promise(resolve => droppingProxy.close(resolve)); }
const receipt = await destination({ type: 'transfer.status', operationId: ticket.operationId });
assert.equal(receipt.state, 'complete');
assert.equal(JSON.parse(readFileSync(`${second}/worker/profile/auth.json`)).anthropic.key, 'fixture-source-secret-canary');
assert.deepEqual(readFileSync(sourceAuth), authBefore);
assert.ok(!readFileSync(`${second}/worker/profile/.outpost-transfers.sqlite`).includes(Buffer.from('fixture-source-secret-canary')));
assert.deepEqual(await destination({ type: 'transfer.apply', sealed }), receipt);
pass('Two independently enrolled installations transfer encrypted fixture keys; lost-reply reconciliation and replay are safe');
await assert.rejects(api(enrollment.environmentId, 14518, { type: 'transfer.inventory' }));
const tamperTicket = await prepare(), tamper = await primary({ type: 'transfer.export', ticket: tamperTicket });
await assert.rejects(destination({ type: 'transfer.apply', sealed: { ...tamper, tag: Buffer.alloc(16).toString('base64') } }));
await destination({ type: 'transfer.cancel', operationId: tamperTicket.operationId });
pass('Wrong-installation signed requests and tampered ciphertext are rejected by real gateways/workers');
const expiring = await prepare();
run(['systemctl', 'restart', 'outpost-qualification-worker']);
for (let n = 0; ; n++) { try { const value = await destination({ type: 'transfer.status', operationId: expiring.operationId }); assert.equal(value.state, 'expired'); break; } catch (error) { if (n > 60) throw error; await delay(1000); } }
pass('Real worker restart discards ephemeral import keys and retains nonsecret receipts');
run(['systemctl', 'stop', 'outpost-qualification-coordinator', 'outpost-qualification-worker']);
// The parent harness verifies identity and this active release after a real guest reboot.
enrollment.releaseId = target.target.id; writeFileSync('/test/request.json', JSON.stringify(enrollment));
console.log('MAINTENANCE_QUALIFIED');
