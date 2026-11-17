import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t, subagents = true) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-managed-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, data) => writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data));
  const sdk = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(join(sdk, 'dist/bundle'), { recursive: true });
  mkdirSync(join(root, 'server/pi-management'), { recursive: true });
  copyFileSync(new URL('./managed-pi.mjs', import.meta.url), join(root, 'managed-pi.mjs'));
  write('server/pi-management/ollama-cloud-extension.ts', 'throw new Error("The fake SDK must not execute provider policy");');
  write('node_modules/@earendil-works/pi-coding-agent/package.json', { name: '@earendil-works/pi-coding-agent', version: '1.5.2', type: 'module', exports: './dist/index.js' });
  write('node_modules/@earendil-works/pi-coding-agent/dist/index.js', 'throw new Error("Do not import the fake SDK");');
  write('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', `
    console.log(JSON.stringify({ args: process.argv.slice(2), profile: process.env.PI_CODING_AGENT_DIR,
      release: process.env.OUTPOST_PI_RELEASE, telemetry: process.env.PI_TELEMETRY, webTools: process.env.PI_OLLAMA_WEB_TOOLS }));
    process.exitCode = process.argv.includes('--fixture-failure') ? 7 : 0;
  `);
  const dependencies = { '@earendil-works/pi-coding-agent': '1.5.2', 'pi-ollama-cloud': '0.13.9', ...(subagents ? { 'pi-subagents': '0.88.9' } : {}) };
  const extensions = Object.entries(dependencies).filter(([name]) => name.startsWith('pi-')).map(([name, version]) => ({ name, version }));
  for (const { name, version } of extensions) {
    const path = `node_modules/${name}`;
    for (const directory of ['skills', 'prompts', 'themes']) mkdirSync(join(root, path, directory), { recursive: true });
    write(`${path}/package.json`, { name, version, pi: { extensions: ['./index.js'], skills: ['./skills'], prompts: ['./prompts'], themes: ['./themes'] } });
    write(`${path}/index.js`, 'throw new Error("The fake SDK must not execute extensions");');
  }
  write('package.json', { type: 'module', dependencies });
  write('package-lock.json', { lockfileVersion: 3, packages: { '': { dependencies } } });
  write('release.json', { id: 'fixture-release', piVersion: '1.5.2', profile: join(root, 'profile'),
    lockHash: createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex') });
  const run = (args, env = {}) => spawnSync(process.execPath, [join(root, 'managed-pi.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: root, ...env },
  });
  return { root, write, run, extensions };
}

test('managed CLI loads pinned native package directories before provider policy without an enable flag', t => {
  const { root, run, extensions } = fixture(t);
  const result = run(['--offline', '--model', 'fixture/model', '-p', 'Synthetic prompt']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.deepEqual(invocation.args, ['--no-extensions',
    ...extensions.flatMap(({ name }) => ['--extension', join(root, 'node_modules', name)]),
    '--extension', join(root, 'server/pi-management/ollama-cloud-extension.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--exclude-tools', 'subagents_enable',
    '--offline', '--model', 'fixture/model', '-p', 'Synthetic prompt']);
  assert.equal(invocation.profile, join(root, 'profile'));
  assert.equal(invocation.release, 'fixture-release');
  assert.equal(invocation.telemetry, '0');
  assert.equal(invocation.webTools, undefined, 'Native web tools must not be disabled by the managed wrapper');
  assert.equal(run(['--fixture-failure']).status, 7);
});

for (const subagents of [true, false]) test(`runtime report verifies installed pins and reports only bundled enabled packages (${subagents})`, t => {
  const { root, run, extensions } = fixture(t, subagents);
  const result = run(['--outpost-runtime']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { release: 'fixture-release', piVersion: '1.5.2', profile: join(root, 'profile'),
    resources: 'native-installed', extensions, extensionStates: Object.fromEntries(extensions.map(({ name }) => [name, 'enabled'])) });
  if (!subagents) {
    const invocation = JSON.parse(run(['--offline']).stdout);
    assert.ok(!invocation.args.includes('subagents_enable'));
    assert.ok(!invocation.args.some(arg => arg.includes('pi-subagents')));
  }
});

test('unversioned package mutation and arbitrary resource injection remain blocked', t => {
  const { run } = fixture(t);
  for (const args of [['install', 'npm:unreviewed'], ['remove', 'pi-subagents'], ['uninstall', 'pi-subagents'], ['update'], ['update', '--models'], ['config'],
    ['--extension', '/unreviewed'], ['--extension=/unreviewed'], ['-e', '/unreviewed'], ['-e/unreviewed'], ['--skill', '/unreviewed'], ['--prompt-template=/unreviewed'], ['--theme', '/unreviewed']]) {
    const result = run(args);
    assert.ifError(result.error);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Resource changes are disabled/);
    assert.equal(result.stdout, '');
  }
});

for (const kind of ['version', 'missing', 'outside', 'resource', 'lock', 'sdk-pin']) test(`managed CLI refuses invalid release ${kind} before starting or reporting enabled`, t => {
  const { root, run, write } = fixture(t);
  const path = 'node_modules/pi-subagents/package.json';
  const metadata = JSON.parse(readFileSync(join(root, path), 'utf8'));
  if (kind === 'version') write(path, { ...metadata, version: '0.0.0' });
  if (kind === 'missing') rmSync(join(root, 'node_modules/pi-subagents'), { recursive: true });
  if (kind === 'outside') {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    write('outside/package.json', metadata);
    rmSync(join(root, 'node_modules/pi-subagents'), { recursive: true });
    symlinkSync(outside, join(root, 'node_modules/pi-subagents'));
  }
  if (kind === 'resource') write(path, { ...metadata, pi: { extensions: ['./missing.js'] } });
  if (kind === 'lock') write('package-lock.json', '{}');
  if (kind === 'sdk-pin') {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['@earendil-works/pi-coding-agent'] = '0.0.0';
    write('package.json', manifest);
  }
  for (const args of [['--outpost-runtime'], ['--offline']]) {
    const result = run(args, { OLLAMA_API_KEY: 'secret-must-never-print' });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /secret-must-never-print/);
  }
});
