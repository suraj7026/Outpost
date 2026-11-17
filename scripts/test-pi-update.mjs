import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildPiUpdate } from './package-pi-update.mjs';

const root = resolve(import.meta.dirname, '..');
const baselinePath = 'scripts/fixtures/outpost1-pi140-source.tar.gz';
const baselineSha256 = 'f02c1479e7f59eb94221eb56977becd517c940da980f45381c68e35fc4deeff7';
const sourceRelease = 'host-e89b6404f05c3a07c0f6';
const compatibleSourceReleases = [sourceRelease, 'host-24b08c6bb80dd3932f21',
  'host-b44894f3afe1c0de9685', 'host-f428c9960b5b1f32dae0', 'host-41cd62017ed6c74b5248'];
const requiredTools = ['automation.list', 'automation.save', 'automation.set_paused'];
const coordinatorPath = 'server/gateway/coordinator.ts';
const automationImport = "import { registerAutomationTools } from '../scheduler/tools.js';\n";
const automationRegistration = `    registerAutomationTools(gate,this.scheduler,taskId,{ workerAvailable: !!this.options.worker, assertWritable: () => {
      requireThat(!this.maintenance.holding,'maintenance_in_progress');
      requireThat(this.dispatchEnabled,'recovery_dispatch_disabled');
    } });
`;
const serviceEntrypoints = ['server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'];
const overlays = [
  'deploy/environment/auto_update.py',
  'deploy/environment/host_install.py', 'deploy/environment/host_update.py',
  'server/environment/qualify-runtime.ts',
  'server/pi-adapter/runtime.ts', 'server/pi-adapter/system-prompt.ts',
  'server/pi-management/bundled-extensions.ts',
  'server/pi-management/child-provider-bootstrap.ts',
  'server/pi-management/credential-store.ts', 'server/pi-management/providers.ts',
  'server/pi-management/session-background.ts', 'server/pi-management/session-extensions.ts',
  'server/pi-management/subscription-models.ts',
  'server/pi-worker/main.ts', 'server/pi-worker/runs.ts',
  'server/scheduler/tools.ts',
];
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
import base64, json, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    assert all(m.isfile() for m in members)
    assert len({m.name for m in members}) == len(members)
    print(json.dumps({m.name: base64.b64encode(archive.extractfile(m).read()).decode() for m in members}))
`, path], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  return new Map(Object.entries(json(result)).map(([path, value]) => [path, Buffer.from(value, 'base64')]));
}

function command(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', timeout: 180000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (signal: ${result.signal ?? 'none'})`);
}

try {
  if (process.argv.slice(2).some(arg => arg !== '--qualify')) throw new Error('Usage: node scripts/test-pi-update.mjs [--qualify]');
  for (const path of [baselinePath, ...overlays, ...packagePaths]) put(sourceRoot, path, readFileSync(join(root, path)));
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
      const allowed = new Set([...overlays, coordinatorPath, 'package.json', 'package-lock.json', 'host-manifest.json']);
      for (const [path, bytes] of baseline) {
        if (!allowed.has(path)) assert.deepEqual(files.get(path), bytes, path);
      }
      for (const path of overlays) assert.deepEqual(files.get(path), readFileSync(join(sourceRoot, path)), path);
    });

    await t.test('browser/gateway sources, runtime pins and host executor remain byte-exact except automation registration', () => {
      const protectedPaths = [...baseline.keys()].filter(path => /^(server\/(browser|browser-engine|gateway)\/|deploy\/agent\/)/.test(path) || path === pinsPath || /(?:uv\.lock|pyproject\.toml)$/.test(path));
      for (const path of protectedPaths.filter(path => path !== coordinatorPath)) assert.deepEqual(files.get(path), baseline.get(path), path);
      for (const path of serviceEntrypoints) assert.ok(files.get(path)?.length > 0, path);
      const coordinator = files.get(coordinatorPath).toString('utf8');
      assert.equal(coordinator.split(automationImport).length, 2);
      assert.equal(coordinator.split(automationRegistration).length, 2);
      assert.deepEqual(Buffer.from(coordinator.replace(automationImport, '').replace(automationRegistration, '')), baseline.get(coordinatorPath));
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
        sequence: 6, rollback: true, piVersion: '1.5.2',
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
      assert.equal(provenance.targetSequence, 6);
      assert.deepEqual(provenance.requiredTools, requiredTools);
      assert.deepEqual(provenance.patchedPaths, [coordinatorPath]);
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
          ? Buffer.from(JSON.stringify({ ...provenance, targetSequence: 5 }, null, 2) + '\n') : files.get(path);
        priorHash.update(path + '\0').update(bytes);
      }
      assert.notEqual(`host-${priorHash.digest('hex').slice(0, 20)}`, id, 'Sequence is bound to the archive identity');
    });

    await t.test('offline rebuild ignores mtimes and nonallowlisted current files', () => {
      put(sourceRoot, 'package.json', 'INVALID CURRENT ROOT PACKAGE');
      put(sourceRoot, 'package-lock.json', 'INVALID CURRENT ROOT LOCK');
      put(sourceRoot, pinsPath, '{"camoufoxVersion":"must-not-be-used"}');
      put(sourceRoot, 'server/gateway/coordinator.ts', 'MUST NOT OVERLAY');
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
        'server/scheduler/tools.ts']) {
        const original = readFileSync(join(sourceRoot, path));
        try {
          writeFileSync(join(sourceRoot, path), Buffer.concat([original, Buffer.from('\n')]));
          const changed = buildPiUpdate({ outputDir: join(temporary, 'changed'), sourceRoot });
          assert.notEqual(changed.id, metadata.id, path);
          assert.notEqual(changed.sha256, metadata.sha256, path);
        } finally { writeFileSync(join(sourceRoot, path), original); }
      }
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

  if (process.argv.includes('--qualify')) {
    const staged = join(temporary, 'qualification');
    const tsxLoader = join(staged, 'node_modules/tsx/dist/loader.mjs');
    for (const [path, bytes] of files) put(staged, path, bytes);
    const home = join(temporary, 'qualification-home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, TMPDIR: home, JITI_FS_CACHE: 'false',
      PI_CODING_AGENT_DIR: join(home, 'agent'), PI_SUBAGENTS_TEMP_ROOT: join(home, 'subagents'),
      XDG_CACHE_HOME: join(home, 'cache'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      npm_config_cache: join(temporary, 'npm-cache'), npm_config_update_notifier: 'false' };
    await test('qualification of extracted artifact (dependency downloads; scripts disabled)', async t => {
      command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], staged, env);
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
      await t.test('baseline coordinator exposes automation tools with approval, maintenance and strict recovery gates', () => {
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
  coordinator.tasks.create(taskId, { goal: 'Qualification only', profile: 'code', mode: 'ask_permission' });
  const gate = coordinator.gate(taskId);
  const names = gate.catalogue().map(tool => tool.name);
  for (const name of ${JSON.stringify(requiredTools)}) assert.equal(names.filter(value => value === name).length, 1);
  const save = { automationId: 'qualification', expectedRevision: 0, schedule: {
    name: 'Never executed', timezone: 'UTC', nextAt: Date.now() + 3600000,
    intervalMs: null, missed: 'skip', task: { goal: 'Synthetic only', profile: 'code', mode: 'ask_permission' },
  } };
  const pending = await gate.propose(taskId, 'automation.save', save);
  assert.equal(pending.data.state, 'pending');
  assert.equal(db.get('automation', save.automationId), undefined);
  await assert.rejects(() => gate.dispatch(pending.id), /not_authorized/);
  gate.changePolicy(taskId, gate.policy(taskId).revision, 'full_control');
  const authorized = await gate.propose(taskId, 'automation.save', save);
  assert.equal((await gate.dispatch(authorized.id)).data.state, 'succeeded');
  assert.equal(db.need('automation', save.automationId).revision, 1);
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
    const blocked = await gate.dispatch(beforeHold.id);
    assert.equal(blocked.data.state, 'unknown');
    assert.match(blocked.data.result.detail, /recovery_dispatch_disabled/);
    assert.equal(db.need('automation', save.automationId).revision, 1);
    const list = await gate.propose(taskId, 'automation.list', {});
    assert.equal((await gate.dispatch(list.id)).data.result.total, 1);
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
