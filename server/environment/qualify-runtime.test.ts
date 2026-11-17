import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));

test('staging qualifier loads, binds and invokes installed native tools in a private process', { timeout: 120000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-staging-qualification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = join(directory, 'release');
  mkdirSync(join(release, 'server/environment'), { recursive: true });
  cpSync(join(project, 'server/pi-management'), join(release, 'server/pi-management'), { recursive: true });
  cpSync(join(project, 'server/environment/qualify-runtime.ts'), join(release, 'server/environment/qualify-runtime.ts'));
  symlinkSync(join(project, 'node_modules'), join(release, 'node_modules'));
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const ambient = join(directory, 'ambient');
  mkdirSync(join(ambient, 'extensions'), { recursive: true });
  writeFileSync(join(ambient, 'settings.json'), JSON.stringify({ packages: ['npm:must-never-install'], extensions: ['./extensions/unwanted.js'] }));
  writeFileSync(join(ambient, 'extensions/unwanted.js'), 'throw new Error("ambient extension executed");');
  writeFileSync(join(ambient, 'auth.json'), '{"ollama-cloud":{"type":"api_key","key":"ambient-secret-must-not-appear"}}');
  const before = readdirSync(directory).sort();
  const qualify = (dependencies: Record<string, string>) => {
    writeFileSync(join(release, 'package.json'), JSON.stringify({ type: 'module', dependencies }));
    return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(release, 'server/environment/qualify-runtime.ts')], {
      cwd: directory, encoding: 'utf8', timeout: 40000,
      env: { ...process.env, HOME: ambient, TMPDIR: directory, PI_CODING_AGENT_DIR: ambient, PI_SUBAGENTS_TEMP_ROOT: ambient,
        PI_OLLAMA_WEB_TOOLS: '0', OLLAMA_API_KEY: 'ambient-secret-must-not-appear', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1',
        JITI_FS_CACHE: 'false', TSX_DISABLE_CACHE: '1', OUTPOST_PI_RELEASE_FILE: join(project, 'pi-release.json') },
    });
  };
  const current = qualify(manifest.dependencies);
  assert.ifError(current.error);
  assert.equal(current.status, 0, current.stderr);
  // This tests an older bundle shape on the installed SDK, not Pi 1.4 compatibility.
  const providerOnly = { ...manifest.dependencies };
  delete providerOnly['pi-subagents'];
  const withoutSubagents = qualify(providerOnly);
  assert.ifError(withoutSubagents.error);
  assert.equal(withoutSubagents.status, 0, withoutSubagents.stderr);
  const mismatch = qualify({ ...manifest.dependencies, 'pi-subagents': '0.0.0' });
  assert.ifError(mismatch.error);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Managed runtime qualification failed/);

  // Mutate only a private package copy: metadata alone must never qualify a broken native extension.
  rmSync(join(release, 'node_modules'));
  mkdirSync(join(release, 'node_modules'));
  for (const name of readdirSync(join(project, 'node_modules'))) {
    if (name === 'pi-subagents') cpSync(join(project, 'node_modules', name), join(release, 'node_modules', name), { recursive: true });
    else symlinkSync(join(project, 'node_modules', name), join(release, 'node_modules', name));
  }
  const packageDir = join(release, 'node_modules/pi-subagents');
  const nativeManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ ...nativeManifest, pi: { ...nativeManifest.pi, extensions: ['./qualification.js'] } }));
  const missingEntry = qualify(manifest.dependencies);
  assert.ifError(missingEntry.error);
  assert.equal(missingEntry.status, 1, 'Every declared extension entry must exist');
  const fixtures = [
    'throw new Error("factory failed");',
    'await native(pi); pi.on("session_start", () => { throw new Error("startup failed"); });',
    'await native({ ...pi, registerTool(tool) { if (tool.name !== "subagent") pi.registerTool(tool); } });',
    'await native({ ...pi, registerTool(tool) { pi.registerTool(tool.name === "subagent" ? { ...tool, execute: async () => { throw new Error("native tool failed"); } } : tool); } });',
  ];
  for (const source of fixtures) {
    writeFileSync(join(packageDir, 'qualification.js'), `import native from './bundle/index.js'; export default async function(pi) { ${source} }`);
    const failed = qualify(manifest.dependencies);
    assert.ifError(failed.error);
    assert.equal(failed.status, 1, source);
    assert.match(failed.stderr, /Managed runtime qualification failed/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /ambient-secret|factory failed|startup failed|native tool failed/);
    assert.deepEqual(readdirSync(directory).sort(), before, 'Private qualification contexts must be removed even after failure');
  }
  assert.deepEqual(readdirSync(ambient).sort(), ['auth.json', 'extensions', 'settings.json']);
  assert.equal(readFileSync(join(ambient, 'auth.json'), 'utf8'), '{"ollama-cloud":{"type":"api_key","key":"ambient-secret-must-not-appear"}}');
});

test('calling the qualifier leaves parent environment and fetch untouched', { timeout: 45000 }, async () => {
  const { qualifyRuntime } = await import('./qualify-runtime.js');
  const env = { ...process.env }, fetch = globalThis.fetch;
  await qualifyRuntime();
  assert.ok(Object.keys(process.env).length === Object.keys(env).length && Object.entries(env).every(([key, value]) => process.env[key] === value), 'Parent environment must remain unchanged');
  assert.equal(globalThis.fetch, fetch);
});
