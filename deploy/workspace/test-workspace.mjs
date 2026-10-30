import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'pi-workspace-test-'));
const launcher = fileURLToPath(new URL('./workspace', import.meta.url));
const log = join(home, 'calls.jsonl');
mkdirSync(join(home, '.local/bin'), { recursive: true });
writeFileSync(join(home, '.local/bin/kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (args.includes('get') && args.includes('deployment')) {
  if (process.env.MOCK_FAIL_GET) process.exit(1);
  process.stdout.write(process.env.MOCK_REPLICAS || '1');
}
`, { mode: 0o755 });
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; }
function run(args, extra = {}) {
  writeFileSync(log, '');
  const result = spawnSync('bash', [launcher, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, MOCK_LOG: log, ...extra },
  });
  const text = readFileSync(log, 'utf8').trim();
  return { ...result, calls: text ? text.split('\n').map(JSON.parse) : [] };
}
try {
  for (const script of ['workspace', 'workspace-init', 'bootstrap-worker.sh', 'provision-main.sh', 'verify-workspace.sh', 'bash_profile']) {
    const result = spawnSync('bash', ['-n', fileURLToPath(new URL(script, import.meta.url))]);
    check(result.status === 0, `${script}: valid Bash syntax`);
  }
  let result = run(['help']);
  check(result.status === 0 && result.calls.length === 0, 'help is offline');
  result = run([]);
  check(result.status === 2 && result.calls.length === 0, 'attach requires TTY before cluster access');
  result = run(['stop']);
  check(result.status === 2 && result.calls.length === 0, 'stop requires interactive confirmation');
  result = run(['exec']);
  check(result.status === 2 && result.calls.length === 0, 'empty exec rejected');
  result = run(['start'], { MOCK_REPLICAS: '0' });
  check(result.status === 0 && result.calls.some(args => args.includes('--replicas=1')), 'stopped deployment starts');
  result = run(['start']);
  check(result.status === 0 && !result.calls.some(args => args.includes('scale')), 'running deployment not scaled or restarted');
  result = run(['start'], { MOCK_FAIL_GET: '1' });
  check(result.status === 1 && result.stderr.includes('not provisioned'), 'unprovisioned workspace fails clearly');
  result = run(['exec', 'printf', '%s', 'literal; $(touch /tmp/SHOULD_NOT_RUN)']);
  check(result.status === 0, 'exec succeeds');
  check(result.calls.at(-1).includes('-c') && result.calls.at(-1).includes('workspace'), 'exec explicitly targets workspace, not coordinator');
  assert.deepEqual(result.calls.at(-1).slice(-4), ['--', 'printf', '%s', 'literal; $(touch /tmp/SHOULD_NOT_RUN)']);
  assertions++;
  for (const port of ['0', '0800', '65536', '3000;echo', '-1']) {
    result = run(['forward', port]);
    check(result.status === 2 && result.calls.length === 0, `invalid port ${port} rejected`);
  }
  result = run(['forward', '3000']);
  check(result.status === 0 && result.calls.at(-1).includes('--address=127.0.0.1'), 'forward binds only localhost');
  result = run(['status']);
  check(result.status === 0 && result.calls[0].includes('pi-workspace'), 'status scoped to workspace namespace');
  result = run(['logs']);
  check(result.status === 0 && result.calls[0].includes('workspace'), 'logs explicitly target workspace');
  console.log(`${assertions} workspace launcher/syntax checks passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
