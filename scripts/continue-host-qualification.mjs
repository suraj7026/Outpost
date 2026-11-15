// Resume ONLY a retained, isolated disposable harness VM after an investigated fixture failure.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [name, mode, packageDirectory, sourceArchive] = process.argv.slice(2);
assert.match(name ?? '', /^outpost-setup-test-[a-f0-9-]{36}$/);
assert.ok(['maintenance', 'bridge', 'bridge-legacy', 'bridge-reset'].includes(mode));
const root = resolve(import.meta.dirname, '..');
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, ...options });
const inspected = JSON.parse(docker(['inspect', name]))[0];
assert.equal(inspected.Config.Image, `${name}:test`); assert.equal(inspected.HostConfig.Privileged, false); assert.equal(inspected.Mounts.length, 0);
assert.ok(!Object.keys(inspected.HostConfig.PortBindings ?? {}).length);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const ssh = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/test/known_hosts', '-i', '/test/id_ed25519', '-p', '2222', 'fixture@127.0.0.1'];
const raw = (args, options = {}) => docker(['exec', '-i', name, ...ssh, args.map(quote).join(' ')], options);
const inside = (args, options = {}) => raw(['sudo', '-k', '-S', '-p', '', '--', ...args], { ...options, input: Buffer.concat([Buffer.from('disposable-fixture-only\n'), Buffer.from(options.input ?? '')]) });
const request = JSON.parse(inside(['python3', '-c', "from pathlib import Path;print(Path('/test/request.json').read_text())"]));
assert.equal(request.label, 'Disposable Linux installer');
const node = `/opt/outpost-native/releases/${request.releaseId}/node/bin/node`;
if (['bridge-legacy', 'bridge-reset'].includes(mode)) {
  const expected = mode === 'bridge-reset' ? request.releaseId : JSON.parse(readFileSync(resolve(packageDirectory, 'bridge.json'))).expectedRelease;
  const installation = JSON.parse(inside(['python3', '-c', "from pathlib import Path;print(Path('/etc/outpost-native/installation.json').read_text())"]));
  assert.equal(installation.environmentId, request.environmentId); assert.equal(installation.release, expected);
  request.releaseId = expected;
  inside(['python3', '-c', "import pathlib,sys;pathlib.Path('/test/request.json').write_bytes(sys.stdin.buffer.read())"], { input: JSON.stringify(request) });
  console.log('Resuming inspected schema-1 fixture; failed operation and partial release remain retained');
} else {
inside(['python3', '-c', "import pathlib,sys;p=pathlib.Path('/test/host_install.py');p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)"], { input: readFileSync(resolve(root, 'deploy/environment/host_install.py')) });
inside(['systemctl', 'enable', '--now', 'outpost-native-worker', 'outpost-native-host', 'outpost-native-coordinator']);
inside(['python3', '-c', `import sys;sys.path.insert(0,'/test');from host_install import Installer,OPERATIONS;i=Installer(OPERATIONS/'${request.operationId}');i.health();i.publish(10,'Fixture recovered after inventory health verification','ready')`], { timeout: 240000 });
}
const manifest = { id: request.releaseId };
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`PASS: ${message}`); };
check(inside([node, '/test/verify.mjs']).trim() === request.environmentId, 'Recovered disposable installation preserves its original signed enrollment');
if (mode === 'maintenance') {
  const { qualifyMaintenance } = await import('./qualify-maintenance-vm.mjs');
  await qualifyMaintenance({ root, inside, raw, node, manifest, request, check });
} else {
  assert.ok(packageDirectory && sourceArchive);
  const { qualifyNativeBridge } = await import('./qualify-native-bridge-vm.mjs');
  await qualifyNativeBridge({ root, inside, node, manifest, check, packageDirectory, sourceArchive, resumeLegacy: mode === 'bridge-legacy', resetLegacy: mode === 'bridge-reset' });
}
const boot = inside(['cat', '/proc/sys/kernel/random/boot_id']).trim();
inside(['systemctl', 'reboot']);
let verified = false;
for (let n = 0; n < 180; n++) {
  try { if (inside(['cat', '/proc/sys/kernel/random/boot_id'], { timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }).trim() !== boot && inside([node, '/test/verify.mjs'], { timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] }).trim() === request.environmentId) { verified = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 2000));
}
check(verified, 'Actual guest reboot preserves the upgraded release and existing signed enrollment');
check(inside(['curl', '--fail', '--silent', 'http://127.0.0.1:4318']).includes('legacy-service-still-running'), 'Unrelated service survives the qualified update and reboot');
console.log(`QUALIFICATION_COMPLETE ${mode}: ${checks} aggregate gates`);
docker(['rm', '--force', name]); docker(['image', 'rm', `${name}:test`]);
