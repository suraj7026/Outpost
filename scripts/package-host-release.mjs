import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'desktop/src-tauri/resources');
const stage = mkdtempSync(join(tmpdir(), 'outpost-host-release-'));
const files = ['package.json', 'package-lock.json', 'deploy/environment/host_install.py', 'deploy/environment/host_update.py', 'deploy/environment/auto_update.py', 'deploy/environment/release-policy.json', 'deploy/environment/runtime-pins.json', 'deploy/agent/host-executor.mjs'];
function sources(directory) {
  for (const name of readdirSync(join(root, directory)).sort()) {
    if (name.startsWith('.') || name === '__pycache__' || name === 'node_modules') continue;
    const path = join(directory, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Release source must not be a symlink: ${path}`);
    if (stat.isDirectory()) sources(path);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') || ['server/browser-engine/launch.py', 'server/browser-engine/pyproject.toml', 'server/browser-engine/uv.lock'].includes(path)) files.push(path);
  }
}
sources('server');
try {
  for (const entry of ['server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs', 'server/scheduler/tools.ts']) {
    if (!files.includes(entry)) throw new Error(`Incomplete server release: ${entry}`);
  }
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    const bytes = readFileSync(join(root, path)); hash.update(path + '\0').update(bytes);
    mkdirSync(dirname(join(stage, path)), { recursive: true }); writeFileSync(join(stage, path), bytes);
  }
  const id = `host-${hash.digest('hex').slice(0, 20)}`;
  const policy = JSON.parse(readFileSync(join(root, 'deploy/environment/release-policy.json'), 'utf8'));
  if (!Number.isSafeInteger(policy.sequence) || policy.sequence < 1 || policy.compatibility !== 'native-v1') throw new Error('Invalid qualified release policy');
  const dependencies = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies;
  const manifest = { schema: 2, id, protocolVersion: 2, layoutVersion: 1, ...policy, rollback: true,
    piVersion: dependencies['@earendil-works/pi-coding-agent'], extensions: ['pi-ollama-cloud', 'pi-subagents'].map(name => {
      const version = dependencies[name];
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Missing exact extension pin: ${name}`);
      return { name, version };
    }) };
  writeFileSync(join(stage, 'host-manifest.json'), JSON.stringify(manifest));
  mkdirSync(output, { recursive: true });
  const archive = join(output, 'host-release.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = readFileSync(archive);
  writeFileSync(join(output, 'host-release.json'), JSON.stringify({ schema: 1, id, manifest, extensionPolicy: 'native-installed', requiredTools: ['automation.list', 'automation.save', 'automation.set_paused'], sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, runtimePinsSha256: createHash('sha256').update(readFileSync(join(root, 'deploy/environment/runtime-pins.json'))).digest('hex'), ...JSON.parse(readFileSync(join(root, 'deploy/environment/runtime-pins.json'), 'utf8')) }, null, 2) + '\n');
  console.log(`Packaged ${id}: ${files.length} allowlisted files, ${bytes.length} bytes → ${relative(root, archive)}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
