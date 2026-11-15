// Real Ubuntu x86 VM integration test. Docker runs a native-architecture QEMU
// process with no privileges, host mounts, published ports, or production data.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
execFileSync(process.execPath, [join(root, 'scripts/package-host-release.mjs')], { stdio: 'inherit' });
const context = mkdtempSync(join(tmpdir(), 'outpost-linux-installer-'));
const name = `outpost-setup-test-${randomUUID()}`, image = `${name}:test`;
const manifest = JSON.parse(readFileSync(join(root, 'desktop/src-tauri/resources/host-release.json')));
const archive = readFileSync(join(root, 'desktop/src-tauri/resources/host-release.tar.gz'));
const keys = generateKeyPairSync('ed25519');
const request = { operationId: randomUUID(), environmentId: randomUUID(), deviceId: randomUUID(),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  label: 'Disposable Linux installer', releaseId: manifest.id, sha256: createHash('sha256').update(archive).digest('hex'),
  size: archive.length, browser: process.env.OUTPOST_TEST_BROWSER_RUNTIME === '1', coexistence: true, fullControl: true };
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, ...options });
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const ssh = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/test/known_hosts', '-i', '/test/id_ed25519', '-p', '2222', 'fixture@127.0.0.1'];
const raw = (args, options = {}) => docker(['exec', '-i', name, ...ssh, args.map(quote).join(' ')], options);
const inside = (args, options = {}) => raw(['sudo', '-k', '-S', '-p', '', '--', ...args], { ...options, input: Buffer.concat([Buffer.from('disposable-fixture-only\n'), Buffer.from(options.input ?? '')]) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const statusCode = action => { try { action(); return 0; } catch (error) { return error.status; } };
const cancellationTest = process.env.OUTPOST_TEST_CANCEL_INSTALL === '1';
let checks = 0, passed = false;
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`PASS: ${message}`); };
try {
  for (const file of ['Dockerfile.test', 'host_install.py']) copyFileSync(join(root, 'deploy/environment', file), join(context, file));
  for (const key of ['id_ed25519', 'host_ed25519']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(context, key)]);
  writeFileSync(join(context, 'known_hosts'), '[127.0.0.1]:2222 ' + readFileSync(join(context, 'host_ed25519.pub'), 'utf8'));
  const publicSSH = readFileSync(join(context, 'id_ed25519.pub'), 'utf8').trim();
  const hostPrivate = readFileSync(join(context, 'host_ed25519'), 'utf8').trim().split('\n').map(line => '    ' + line).join('\n');
  writeFileSync(join(context, 'user-data'), `#cloud-config
hostname: outpost-disposable-test
users:
  - name: fixture
    groups: [sudo]
    sudo: ALL=(ALL) ALL
    shell: /bin/bash
    lock_passwd: false
    ssh_authorized_keys: [${JSON.stringify(publicSSH)}]
ssh_pwauth: false
chpasswd:
  expire: false
  users:
    - name: fixture
      password: disposable-fixture-only
      type: text
ssh_keys:
  ed25519_private: |
${hostPrivate}
  ed25519_public: ${JSON.stringify(readFileSync(join(context, 'host_ed25519.pub'), 'utf8').trim())}
runcmd:
  - [mkdir, -p, /etc/rancher/k3s, /srv/remotejobs/pi-workspace, /srv/legacy-fixture]
  - [sh, -c, "echo retain-existing-data > /srv/remotejobs/pi-workspace/sentinel; echo legacy-service-still-running > /srv/legacy-fixture/index.html"]
`);
  writeFileSync(join(context, 'meta-data'), `instance-id: ${name}\nlocal-hostname: outpost-disposable-test\n`);
  writeFileSync(join(context, 'request.json'), JSON.stringify(request));
  writeFileSync(join(context, 'device.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(context, 'verify.mjs'), `
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
const request=JSON.parse(readFileSync('/test/request.json'));
const body=JSON.stringify({protocolVersion:2,environmentId:request.environmentId,deviceId:request.deviceId,issuedAt:Date.now(),type:'environment',payload:{}});
const response=await fetch('http://127.0.0.1:4518/v2/query',{method:'POST',headers:{'content-type':'application/json','x-outpost-signature':sign(null,Buffer.from(body),readFileSync('/test/device.pem')).toString('base64')},body});
if(!response.ok) throw new Error('Signed enrollment rejected: '+response.status);
const value=await response.json(); if(value.environmentId!==request.environmentId||value.runtime.release!==request.releaseId) throw new Error('Identity or release mismatch');
console.log(value.environmentId);
`);
  docker(['build', '-t', image, '-f', join(context, 'Dockerfile.test'), context], { stdio: 'inherit', timeout: 1200000 });
  docker(['run', '--detach', '--init', '--memory=5g', '--cpus=2', '--name', name, image]);
  let booted = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (statusCode(() => raw(['true'], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 })) === 0) { booted = true; break; }
    await delay(2000);
  }
  check(booted, 'Unmodified Ubuntu x86 VM booted with independently pinned SSH host key');
  inside(['cloud-init', 'status', '--wait'], { timeout: 180000 });
  check(inside(['uname', '-m']).trim() === 'x86_64', 'Guest is the supported x86 architecture, not an altered preflight fixture');
  inside(['mkdir', '-p', '/test']);
  for (const file of ['host_install.py', 'request.json', 'device.pem', 'verify.mjs']) {
    inside(['python3', '-c', `import pathlib,sys;p=pathlib.Path('/test/${file}');p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)`], { input: readFileSync(join(context, file)) });
  }
  const legacyUnit = '[Unit]\nDescription=Disposable pre-existing service\n[Service]\nUser=fixture\nExecStart=/usr/bin/python3 -m http.server 4318 --bind 127.0.0.1 --directory /srv/legacy-fixture\n[Install]\nWantedBy=multi-user.target\n';
  inside(['python3', '-c', `import pathlib;pathlib.Path('/etc/systemd/system/fixture-legacy.service').write_text(${JSON.stringify(legacyUnit)})`]);
  inside(['systemctl', 'daemon-reload']);
  inside(['systemctl', 'enable', '--now', 'fixture-legacy']);
  const packet = Buffer.concat([Buffer.from(JSON.stringify(request) + '\n'), archive]);
  const launch = () => JSON.parse(inside(['/usr/bin/python3', '/test/host_install.py', '--bootstrap'], { input: packet }));
  const start = launch();
  check(start.operationId === request.operationId, 'SSH plus password-authorized launch returns the exact durable operation');
  check(start.state !== 'unknown', `Persistent setup launch confirmed: ${start.error ?? start.state}`);
  const statusPath = `/var/lib/outpost-setup/operations/${request.operationId}/status.json`;
  const status = () => JSON.parse(inside(['python3', '-c', `from pathlib import Path;print(Path('${statusPath}').read_text())`]));
  let previous = '', outcome, cancellationRequested = false;
  const deadline = Date.now() + 2400000;
  while (Date.now() < deadline) {
    outcome = status();
    if (outcome.stage !== previous) { console.log(`${outcome.completedSteps}/12 ${outcome.stage}`); previous = outcome.stage; }
    if (cancellationTest && !cancellationRequested && outcome.state === 'running' && outcome.completedSteps >= 2) {
      raw(['python3', '-c', `from pathlib import Path;Path('/var/lib/outpost-setup/operations/${request.operationId}/cancel').write_text('1')`]);
      cancellationRequested = true;
    }
    if (['ready', 'failed', 'cancelled'].includes(outcome.state)) break;
    await delay(3000);
  }
  if (cancellationTest) {
    check(cancellationRequested && outcome?.state === 'cancelled', 'Unprivileged scoped cancellation stops the real owned setup operation');
    check(outcome.completedSteps < 10, 'Cancelled setup never claims readiness');
    check(inside(['curl', '--fail', '--silent', 'http://127.0.0.1:4318']).includes('legacy-service-still-running'), 'Cancelling setup leaves the pre-existing service running');
    check(inside(['python3', '-c', "from pathlib import Path;assert Path('/srv/remotejobs/pi-workspace/sentinel').read_text().strip()=='retain-existing-data';assert Path('/opt/outpost-native').is_dir();assert not Path('/etc/systemd/system/outpost-native-coordinator.service').exists();print('retained')"]).trim() === 'retained', 'Cancellation retains partial native files and original legacy data without activating services');
    check(launch().state === 'cancelled', 'Repeating a cancelled operation reads its receipt instead of reinstalling');
    console.log(`${checks} real Ubuntu VM cancellation checks passed`);
  } else {
  check(outcome?.state === 'ready', `Native services reached readiness: ${outcome?.error ?? outcome?.state}`);
  check(outcome.completedSteps === 10, 'Server does not claim client registration completed');
  const node = `/opt/outpost-native/releases/${manifest.id}/node/bin/node`;
  check(inside([node, '/test/verify.mjs']).trim() === request.environmentId, 'Real signed v2 query verifies pre-enrollment and installation identity');
  check(statusCode(() => inside(['runuser', '-u', 'outpost-pi', '--', 'test', '-r', '/var/lib/outpost-native/coordinator/ledger.sqlite'])) === 1, 'Pi worker cannot read coordinator ledger');
  check(statusCode(() => inside(['runuser', '-u', 'outpost-pi', '--', 'test', '-r', '/etc/outpost-native/coordinator/worker-token'])) === 1, 'Pi worker cannot read coordinator credentials');
  check(inside(['curl', '--fail', '--silent', 'http://127.0.0.1:4318']).includes('legacy-service-still-running'), 'Existing listener is unchanged');
  check(inside(['python3', '-c', "from pathlib import Path; print(Path('/srv/remotejobs/pi-workspace/sentinel').read_text())"]).trim() === 'retain-existing-data', 'Legacy persistent data is unchanged');
  const again = launch();
  check(again.state === 'ready' && again.environmentId === request.environmentId, 'Repeated launch only reads its existing receipt');
  check(inside(['systemctl', 'is-enabled', 'outpost-native-coordinator', 'outpost-native-worker']).trim() === 'enabled\nenabled', 'Both non-root services are enabled at boot');
  const confined = ['systemd-run', '--wait', '--pipe', '--property=User=outpost-coord', '--property=Group=outpost-coord', '--property=SupplementaryGroups=outpost-workspaces', '--property=UMask=0007', '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes', '--property=ProtectSystem=strict', '--property=ProtectHome=yes', '--property=MemoryMax=40%', `--property=ReadWritePaths=/var/lib/outpost-native/coordinator /var/lib/outpost-native/workspaces`, `--property=WorkingDirectory=/opt/outpost-native/releases/${manifest.id}`, '--setenv=HOME=/var/lib/outpost-native/coordinator'];
  inside([...confined, node, '--import', 'tsx', '--input-type=module', '-e', "import {Workspace} from './server/artifacts/files.ts';process.umask(0o007);new Workspace('/var/lib/outpost-native/workspaces/fixture-task',true).write('proof.txt','coordinator',null);"]);
  check(inside(['runuser', '-u', 'outpost-pi', '--', 'python3', '-c', "from pathlib import Path;p=Path('/var/lib/outpost-native/workspaces/fixture-task/proof.txt');assert p.read_text()=='coordinator';p.write_text('worker');print('shared-ok')"]).trim() === 'shared-ok', 'Real service identities share only the group-writable task workspace');
  check(statusCode(() => inside(['runuser', '-u', 'outpost-pi', '--', 'test', '-r', '/etc/outpost-native/coordinator/host-token'])) === 1, 'Pi worker cannot read root executor credentials');
  check(inside(['curl', '--silent', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', 'http://127.0.0.1:4519/execute']).trim() === '401', 'Root executor rejects unauthenticated requests');
  check(inside(['ss', '-ltnH', 'sport = :4519']).includes('127.0.0.1:4519'), 'Native root executor listens only on host loopback');
  const hostSmoke = `import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {Ledger} from './server/core/ledger.ts';import {Gate} from './server/policy/trust.ts';import {registerHosts} from './server/operations/hosts.ts';
const db=new Ledger('/var/lib/outpost-native/coordinator/host-control-fixture.sqlite'), task=randomUUID();
try {db.put('policy',task,0,{mode:'full_control'});const gate=new Gate(db,undefined,true);registerHosts(gate,{token:readFileSync('/etc/outpost-native/coordinator/host-token','utf8').trim(),endpoints:{local:'http://127.0.0.1:4519'}},task);
const action=await gate.propose(task,'host.execute',{host:'local',command:'/usr/bin/id -u; /usr/bin/test -r /etc/shadow && printf "host-files-readable\\\\n"; /usr/bin/systemctl is-active fixture-legacy'}), result=await gate.dispatch(action.id);
if(result.data.state!=='succeeded'||result.data.result.exitCode!==0||result.data.result.stdout!=='0\\n'+'host-files-readable\\n'+'active\\n')throw Error('Host access evidence failed: '+JSON.stringify(result.data));console.log('root-gate-ok');}finally{db.close()}`;
  check(inside([...confined, node, '--import', 'tsx', '--input-type=module', '-e', hostSmoke]).includes('root-gate-ok'), 'Non-root coordinator performs gated root host inspection with recorded evidence');
  check(inside(['systemctl', 'is-enabled', 'outpost-native-host']).trim() === 'enabled', 'Full server control persists across boots');
  if (request.browser) {
    const smoke = "import {openBrowser} from './server/browser/engine.ts';const browser=await openBrowser();try{const page=await browser.newPage();await page.setContent('<input aria-label=proof>');await page.fill('input','native-install');if(await page.inputValue('input')!=='native-install'||(await page.screenshot()).length<1000||!(await page.evaluate(()=>navigator.userAgent)).includes('Firefox/'))throw Error('Browser verification failed');console.log('camoufox-ok')}finally{await browser.close()}";
    check(inside([...confined, `--setenv=XDG_CACHE_HOME=/opt/outpost-native/releases/${manifest.id}/browsers`, node, '--import', 'tsx', '--input-type=module', '-e', smoke], { timeout: 180000 }).includes('camoufox-ok'), 'Installed Camoufox renders, accepts input and captures screenshots under service confinement');
    check(inside([...confined, `/opt/outpost-native/releases/${manifest.id}/server/browser-engine/.venv/bin/python`, '-c', "from importlib.metadata import version;print(version('camoufox'))"], { timeout: 180000 }).includes('0.5.9'), 'Private pinned Camoufox launcher imports successfully');
  }
  const conflict = { ...request, operationId: randomUUID(), environmentId: randomUUID() };
  inside(['/usr/bin/python3', '/test/host_install.py', '--bootstrap'], { input: Buffer.concat([Buffer.from(JSON.stringify(conflict) + '\n'), archive]) });
  let refused;
  for (let attempt = 0; attempt < 30; attempt++) {
    refused = JSON.parse(inside(['python3', '-c', `from pathlib import Path;print(Path('/var/lib/outpost-setup/operations/${conflict.operationId}/status.json').read_text())`]));
    if (refused.state === 'failed') break;
    await delay(1000);
  }
  check(refused.state === 'failed' && refused.completedSteps === 0, 'A second independent install refuses occupied native paths without overwriting the first');
  check(inside([node, '/test/verify.mjs']).trim() === request.environmentId, 'Refused installation leaves the existing enrollment and running services intact');
  if (process.env.OUTPOST_TEST_MAINTENANCE === '1') {
    const { qualifyMaintenance } = await import('./qualify-maintenance-vm.mjs');
    await qualifyMaintenance({ root, inside, raw, node, manifest, request, check });
  }
  if (process.env.OUTPOST_TEST_BRIDGE_PACKAGE && process.env.OUTPOST_TEST_BRIDGE_SOURCE) {
    const { qualifyNativeBridge } = await import('./qualify-native-bridge-vm.mjs');
    await qualifyNativeBridge({ root, inside, node, manifest, check, packageDirectory: process.env.OUTPOST_TEST_BRIDGE_PACKAGE, sourceArchive: process.env.OUTPOST_TEST_BRIDGE_SOURCE });
  }
  const bootID = inside(['cat', '/proc/sys/kernel/random/boot_id']).trim();
  inside(['systemctl', 'reboot']);
  let verified = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      if (inside(['cat', '/proc/sys/kernel/random/boot_id'], { timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }).trim() !== bootID && inside([node, '/test/verify.mjs'], { timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] }).trim() === request.environmentId) { verified = true; break; }
    } catch {}
    await delay(2000);
  }
  check(verified, 'Actual guest reboot preserves enrollment and installation identity without the desktop');
  check(inside([...confined, node, '--import', 'tsx', '--input-type=module', '-e', hostSmoke]).includes('root-gate-ok'), 'Root host access survives a real guest reboot');
  check(inside(['curl', '--fail', '--silent', 'http://127.0.0.1:4318']).includes('legacy-service-still-running'), 'Pre-existing service also survives the guest reboot');
  console.log(`${checks} real Ubuntu VM installer checks passed; browser runtime requested=${request.browser}`);
  }
  passed = true;
} catch (error) {
  try { console.error(docker(['logs', '--tail', '50', name])); } catch {}
  try { console.error(inside(['journalctl', '--no-pager', '-n', '100', '-u', `outpost-setup-${request.operationId}`, '-u', 'outpost-native-coordinator', '-u', 'outpost-native-worker', '-u', 'outpost-native-host'])); } catch {}
  for (const file of ['launch.log', 'command.log']) {
    try { console.error(inside(['python3', '-c', `from pathlib import Path;print(Path('/var/lib/outpost-setup/operations/${request.operationId}/${file}').read_text()[-12000:])`])); } catch {}
  }
  throw error;
} finally {
  if (passed || process.env.OUTPOST_TEST_KEEP_FAILED !== '1') {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    spawnSync('docker', ['image', 'rm', image], { stdio: 'ignore' });
    rmSync(context, { recursive: true, force: true });
  } else console.error(`Retained failed disposable fixture: ${name}; private context ${context}`);
}
