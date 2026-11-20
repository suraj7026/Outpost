import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Offline only. Explicit output/source roots keep packaging tests out of app resources. */
export function buildHostRelease({ outputDir = join(root, 'desktop/src-tauri/resources'), sourceRoot = root } = {}) {
  sourceRoot = resolve(sourceRoot);
  outputDir = resolve(outputDir);
  const stage = mkdtempSync(join(tmpdir(), 'outpost-host-release-'));
  const files = ['package.json', 'package-lock.json', 'deploy/environment/host_install.py', 'deploy/environment/host_update.py', 'deploy/environment/auto_update.py', 'deploy/environment/release-policy.json', 'deploy/environment/runtime-pins.json', 'deploy/agent/host-executor.mjs'];
  function sources(directory) {
    for (const name of readdirSync(join(sourceRoot, directory)).sort()) {
      if (name.startsWith('.') || name === '__pycache__' || name === 'node_modules') continue;
      const path = join(directory, name), stat = lstatSync(join(sourceRoot, path));
      if (stat.isSymbolicLink()) throw new Error(`Release source must not be a symlink: ${path}`);
      if (stat.isDirectory()) sources(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') || ['server/browser-engine/launch.py', 'server/browser-engine/pyproject.toml', 'server/browser-engine/uv.lock'].includes(path)) files.push(path);
    }
  }
  try {
    sources('server');
    for (const entry of ['server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs', 'server/scheduler/tools.ts', 'server/artifacts/workspace-review.ts', 'server/gateway/coordinator.ts', 'server/gateway/http.ts']) {
      if (!files.includes(entry)) throw new Error(`Incomplete server release: ${entry}`);
    }
    const hash = createHash('sha256');
    for (const path of files.sort()) {
      const bytes = readFileSync(join(sourceRoot, path)); hash.update(path + '\0').update(bytes);
      mkdirSync(dirname(join(stage, path)), { recursive: true }); writeFileSync(join(stage, path), bytes);
    }
    const id = `host-${hash.digest('hex').slice(0, 20)}`;
    const policy = JSON.parse(readFileSync(join(stage, 'deploy/environment/release-policy.json'), 'utf8'));
    if (!Number.isSafeInteger(policy.sequence) || policy.sequence < 1 || policy.compatibility !== 'native-v1') throw new Error('Invalid qualified release policy');
    const dependencies = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).dependencies;
    const manifest = { schema: 2, id, protocolVersion: 2, layoutVersion: 1, sequence: policy.sequence, compatibility: policy.compatibility, rollback: true,
      piVersion: dependencies['@earendil-works/pi-coding-agent'], extensions: ['pi-ollama-cloud', 'pi-subagents'].map(name => {
        const version = dependencies[name];
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Missing exact extension pin: ${name}`);
        return { name, version };
      }) };
    writeFileSync(join(stage, 'host-manifest.json'), JSON.stringify(manifest));
    mkdirSync(outputDir, { recursive: true });
    const archive = join(outputDir, 'host-release.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, timeout: 30000 });
    const bytes = readFileSync(archive), pins = readFileSync(join(stage, 'deploy/environment/runtime-pins.json'));
    const metadata = { schema: 1, id, manifest, extensionPolicy: 'native-installed', requiredTools: ['automation.list', 'automation.save', 'automation.set_paused'], sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      runtimePinsSha256: createHash('sha256').update(pins).digest('hex'), ...JSON.parse(pins.toString('utf8')) };
    writeFileSync(join(outputDir, 'host-release.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const metadata = buildHostRelease();
  console.log(`Packaged ${metadata.id}: ${metadata.size} bytes → desktop/src-tauri/resources/host-release.tar.gz`);
}
