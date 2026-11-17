import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledExtensions } from './bundled-extensions.js';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';
import { ReleaseManifest } from './update-contracts.js';

const dependencies = { 'pi-ollama-cloud': '0.13.1', 'pi-subagents': '0.88.1' };
const expected = {
  extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }, { name: 'pi-subagents', version: '0.88.1' }],
  extensionStates: { 'pi-ollama-cloud': 'enabled', 'pi-subagents': 'enabled' },
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release'), marker = join(root, 'executed');
  mkdirSync(release);
  const declare = (pins: Record<string, unknown>) => writeFileSync(join(release, 'package.json'), JSON.stringify({ dependencies: pins }));
  const install = (name: string, version: string) => {
    const path = join(release, 'node_modules', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, type: 'module', exports: './index.js', pi: { extensions: ['./index.js'] }, credential: 'private-package-canary' }));
    writeFileSync(join(path, 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw Error('Bundle must not execute');`);
  };
  declare(dependencies);
  for (const [name, version] of Object.entries(dependencies)) install(name, version);
  return { root, release, marker, declare, install };
}

test('bundle inventory verifies both exact versions without executing packages or exposing extra metadata', t => {
  const f = fixture(t);
  assert.deepEqual(bundledExtensions(f.release), expected);
  assert.equal(existsSync(f.marker), false);
  assert.ok(!JSON.stringify(bundledExtensions(f.release)).includes('private-package-canary'));
});

test('native bridge inventories only declared packages, even if undeclared subagents is installed', t => {
  const f = fixture(t);
  f.declare({ 'pi-ollama-cloud': dependencies['pi-ollama-cloud'] });
  const legacy = { extensions: [expected.extensions[0]], extensionStates: { 'pi-ollama-cloud': 'enabled' } };
  assert.deepEqual(bundledExtensions(f.release), legacy);
  rmSync(join(f.release, 'node_modules/pi-subagents'), { recursive: true });
  assert.deepEqual(bundledExtensions(f.release), legacy);
  assert.equal(existsSync(f.marker), false);
});

for (const name of Object.keys(dependencies)) {
  test(`declared ${name} must be installed inside the release, with matching name and version`, t => {
    const f = fixture(t), path = join(f.release, 'node_modules', name);
    rmSync(path, { recursive: true });
    assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
    f.install(name, '0.0.0');
    assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'other-package', version: dependencies[name as keyof typeof dependencies] }));
    assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
    writeFileSync(join(path, 'package.json'), '{invalid');
    assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
    rmSync(path, { recursive: true });
    mkdirSync(join(f.root, 'external'));
    writeFileSync(join(f.root, 'external/package.json'), JSON.stringify({ name, version: dependencies[name as keyof typeof dependencies] }));
    symlinkSync(join(f.root, 'external'), path);
    assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
    assert.equal(existsSync(f.marker), false);
  });
}

test('declared dependencies require exact pins and the provider-only bundle cannot be omitted', t => {
  const f = fixture(t);
  for (const name of Object.keys(dependencies)) {
    for (const pin of ['^0.88.1', '~0.88.1', '*', 'latest', 'file:../package', 'npm:pi-subagents@0.88.1', '', null, 88]) {
      f.declare({ ...dependencies, [name]: pin });
      assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
    }
  }
  f.declare({ 'pi-subagents': dependencies['pi-subagents'] });
  assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
  writeFileSync(join(f.release, 'package.json'), '{invalid');
  assert.throws(() => bundledExtensions(f.release), /bundled_extensions_invalid/);
});

test('runtime inventory is credential-free and keeps activation states outside strict release manifests', async t => {
  const f = fixture(t), profile = new PiProfile(join(f.root, 'profile'));
  const service = new ProviderManagement(profile, async () => { throw Error('Inventory must not construct a model runtime'); });
  t.after(() => service.close());
  const auth = JSON.stringify({ anthropic: { type: 'api_key', key: `!touch '${f.marker}'; printf private-credential-canary` } });
  writeFileSync(join(profile.directory, 'auth.json'), auth);
  const inventory = service.inventory();
  assert.deepEqual(inventory.extensions, expected.extensions);
  assert.deepEqual(inventory.extensionStates, expected.extensionStates);
  assert.deepEqual(await service.request('inventory-owner', { type: 'runtime.inventory' }), inventory);
  assert.equal(existsSync(f.marker), false);
  assert.equal(readFileSync(join(profile.directory, 'auth.json'), 'utf8'), auth);
  assert.ok(!JSON.stringify(inventory).includes('private-credential-canary'));
  const manifest = { schema: 2, id: 'host-01234567890123456789', protocolVersion: 2, layoutVersion: 1,
    compatibility: 'native-v1', sequence: 1, piVersion: profile.version, extensions: inventory.extensions, rollback: true };
  assert.deepEqual(ReleaseManifest.parse(manifest), manifest);
  assert.equal(ReleaseManifest.safeParse({ ...manifest, extensionStates: inventory.extensionStates }).success, false);
  assert.equal(ReleaseManifest.safeParse({ ...manifest, extensions: [{ ...inventory.extensions[0], state: 'provider-only' }] }).success, false);
});
