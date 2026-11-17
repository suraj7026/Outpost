import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = 'scripts/fixtures/outpost1-pi140-source.tar.gz';
const baselineSha256 = 'f02c1479e7f59eb94221eb56977becd517c940da980f45381c68e35fc4deeff7';
const sourceRelease = 'host-e89b6404f05c3a07c0f6';
const compatibleSourceReleases = Object.freeze([
  'host-e89b6404f05c3a07c0f6',
  'host-24b08c6bb80dd3932f21',
  'host-b44894f3afe1c0de9685',
  'host-f428c9960b5b1f32dae0',
  'host-41cd62017ed6c74b5248',
]);
const extensionPolicy = 'native-installed';
const sequence = 6;
const requiredTools = Object.freeze(['automation.list', 'automation.save', 'automation.set_paused']);
const coordinatorPath = 'server/gateway/coordinator.ts';
const serviceEntrypoints = ['server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'];
const piVersion = '1.5.2';
const overlays = Object.freeze([
  'deploy/environment/auto_update.py',
  'deploy/environment/host_install.py',
  'deploy/environment/host_update.py',
  'server/environment/qualify-runtime.ts',
  'server/pi-adapter/runtime.ts',
  'server/pi-adapter/system-prompt.ts',
  'server/pi-management/bundled-extensions.ts',
  'server/pi-management/child-provider-bootstrap.ts',
  'server/pi-management/credential-store.ts',
  'server/pi-management/providers.ts',
  'server/pi-management/session-background.ts',
  'server/pi-management/session-extensions.ts',
  'server/pi-management/subscription-models.ts',
  'server/pi-worker/main.ts',
  'server/pi-worker/runs.ts',
  'server/scheduler/tools.ts',
]);
const pinsPath = 'deploy/environment/runtime-pins.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));
const serialized = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function sourceBytes(sourceRoot, path) {
  let current = sourceRoot;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Source must not be a symlink: ${path}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`Source must be a regular file: ${path}`);
  return readFileSync(current);
}

function filesAt(directory, prefix = '') {
  return readdirSync(join(directory, prefix)).sort().flatMap(name => {
    const path = posix.join(prefix, name);
    const stat = lstatSync(join(directory, path));
    if (stat.isDirectory()) return filesAt(directory, path);
    if (!stat.isFile()) throw new Error(`Unexpected staged entry: ${path}`);
    return [path];
  });
}

function extractBaseline(bytes, stage) {
  if (sha256(bytes) !== baselineSha256) throw new Error('Baseline archive SHA-256 mismatch');
  // Python preserves the captured AppleDouble files as ordinary bytes, unlike macOS tar.
  execFileSync('python3', ['-c', `
import io, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode='r:gz') as archive:
    members = archive.getmembers()
    if len(members) != 202 or len({m.name for m in members}) != 202:
        raise ValueError('Unexpected baseline file inventory')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if not member.isfile() or path.is_absolute() or '..' in path.parts or str(path) != member.name:
            raise ValueError('Unsafe baseline member: ' + member.name)
    for member in members:
        target = root / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
`, stage], { input: bytes, timeout: 30000 });
  const manifest = json(readFileSync(join(stage, 'host-manifest.json')));
  assert.deepStrictEqual(manifest, {
    schema: 2, id: sourceRelease, protocolVersion: 2, layoutVersion: 1,
    compatibility: 'native-v1', sequence: 1, rollback: true, piVersion: '1.4.0',
    extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }],
  }, 'Baseline manifest identity or contract mismatch');
  return manifest;
}

function validatePackages(baseline, baselineLock, packageBytes, lockBytes) {
  const expected = structuredClone(baseline);
  expected.dependencies['@earendil-works/pi-coding-agent'] = piVersion;
  expected.dependencies['pi-subagents'] = '0.88.1';
  const packageManifest = json(packageBytes), lock = json(lockBytes);
  assert.deepStrictEqual(packageManifest, expected, 'Compatible-server package metadata/direct dependencies drifted');
  const { packages: oldPackages, ...oldMetadata } = baselineLock;
  const { packages, ...metadata } = lock;
  assert.deepStrictEqual(metadata, oldMetadata, 'Lock metadata drifted');
  assert.deepStrictEqual(packages?.[''], { ...oldPackages[''], dependencies: expected.dependencies }, 'Lock root metadata/dependencies drifted');
  for (const [name, version] of Object.entries({ ...expected.dependencies, ...expected.devDependencies })) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || entry.version !== version || entry.link || !entry.integrity || !entry.resolved?.startsWith('https://')) {
      throw new Error(`Locked dependency version/integrity mismatch: ${name}`);
    }
  }
  if (Object.keys(packages).some(path => path.split('/').includes('playwright-camoufox')) || lockBytes.includes('npm:playwright-camoufox')) {
    throw new Error('Compatible-server lock must not introduce a browser alias');
  }
}

function registerBaselineAutomation(bytes) {
  let source = bytes.toString('utf8');
  const insertions = [
    ["import { Scheduler } from '../scheduler/scheduler.js';\n",
      "import { registerAutomationTools } from '../scheduler/tools.js';\n"],
    ['    workspace.register(gate); registerInventory(gate); registerCommands(gate,workspace,new Set(this.options.executables ?? []),this.options.unrestrictedCommands);\n',
      `    registerAutomationTools(gate,this.scheduler,taskId,{ workerAvailable: !!this.options.worker, assertWritable: () => {
      requireThat(!this.maintenance.holding,'maintenance_in_progress');
      requireThat(this.dispatchEnabled,'recovery_dispatch_disabled');
    } });
`],
  ];
  for (const [anchor, addition] of insertions) {
    assert.equal(source.split(anchor).length, 2, 'Baseline coordinator registration anchor must be unique');
    source = source.replace(anchor, anchor + addition);
  }
  return Buffer.from(source);
}

function verifyRelativeImports(stage, files) {
  const inventory = new Set(files);
  for (const path of files.filter(path => path.endsWith('.ts') && !posix.basename(path).startsWith('._'))) {
    const source = readFileSync(join(stage, path), 'utf8');
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (![target, target.replace(/\.js$/, '.ts'), target.replace(/\.mjs$/, '.mts')].some(candidate => inventory.has(candidate))) {
        throw new Error(`Unresolved baseline-relative import: ${path} -> ${specifier}`);
      }
    }
  }
}

function verifyPythonImports(stage) {
  // Parse only: never execute privileged helpers or import from the working tree.
  execFileSync('python3', ['-I', '-c', `
import ast, pathlib, sys
root = pathlib.Path(sys.argv[1])
for path in sorted(root.rglob('*.py')):
    if path.name.startswith('._'):
        continue
    for node in ast.walk(ast.parse(path.read_bytes(), filename=str(path))):
        if isinstance(node, ast.Import):
            modules = [(name.name, 0) for name in node.names]
        elif isinstance(node, ast.ImportFrom):
            modules = [(node.module, node.level)] if node.module else [(name.name, node.level) for name in node.names]
        else:
            continue
        for module, level in modules:
            if not level and module.split('.')[0] in sys.stdlib_module_names:
                continue
            base = path.parent
            for _ in range(max(0, level - 1)):
                base = base.parent
            target = base.joinpath(*module.split('.'))
            candidates = [target.with_suffix('.py'), target / '__init__.py']
            if not any(candidate.is_relative_to(root) and candidate.is_file() for candidate in candidates):
                raise ValueError('Unresolved bundled Python import: ' + str(path.relative_to(root)) + ' -> ' + '.' * level + module)
`, stage], { timeout: 30000 });
}

function deterministicArchive(stage, archive) {
  execFileSync('python3', ['-c', `
import gzip, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
with open(sys.argv[2], 'wb') as output:
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for path in sorted(root.rglob('*')):
                if not path.is_file():
                    continue
                info = tarfile.TarInfo(path.relative_to(root).as_posix())
                info.size = path.stat().st_size
                info.mode = 0o644
                info.uid = info.gid = info.mtime = 0
                with path.open('rb') as source:
                    tar.addfile(info, source)
`, stage, archive], { timeout: 30000 });
}

/** Offline only. sourceRoot supports isolated fixtures; baseline identity is never configurable. */
export function buildPiUpdate({ outputDir = join(root, 'desktop/src-tauri/resources'), sourceRoot = root } = {}) {
  sourceRoot = resolve(sourceRoot);
  outputDir = resolve(outputDir);
  const temporary = mkdtempSync(join(tmpdir(), 'outpost-pi-update-'));
  const stage = join(temporary, 'source');
  mkdirSync(stage);
  try {
    const sourceManifest = extractBaseline(sourceBytes(sourceRoot, baselinePath), stage);
    const original = new Map(filesAt(stage).map(path => [path, readFileSync(join(stage, path))]));
    const packageBytes = sourceBytes(sourceRoot, 'deploy/pi-update/package.json');
    const lockBytes = sourceBytes(sourceRoot, 'deploy/pi-update/package-lock.json');
    validatePackages(json(original.get('package.json')), json(original.get('package-lock.json')), packageBytes, lockBytes);
    for (const path of overlays) {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      writeFileSync(join(stage, path), sourceBytes(sourceRoot, path));
    }
    writeFileSync(join(stage, coordinatorPath), registerBaselineAutomation(original.get(coordinatorPath)));
    writeFileSync(join(stage, 'package.json'), packageBytes);
    writeFileSync(join(stage, 'package-lock.json'), lockBytes);
    const allowed = new Set([...overlays, coordinatorPath, 'package.json', 'package-lock.json', 'host-manifest.json']);
    for (const [path, bytes] of original) {
      if (!allowed.has(path)) assert.deepStrictEqual(readFileSync(join(stage, path)), bytes, `Nonallowlisted file changed: ${path}`);
    }
    const stagedFiles = filesAt(stage);
    for (const path of stagedFiles) {
      if (!original.has(path) && !overlays.includes(path)) throw new Error(`Nonallowlisted added file: ${path}`);
    }
    for (const path of serviceEntrypoints) {
      assert.ok(stagedFiles.includes(path) && readFileSync(join(stage, path)).length > 0, `Missing service entrypoint: ${path}`);
    }
    verifyRelativeImports(stage, stagedFiles);
    verifyPythonImports(stage);
    const changedFiles = stagedFiles.filter(path => path !== 'host-manifest.json' && !readFileSync(join(stage, path)).equals(original.get(path) ?? Buffer.alloc(0))).sort();
    const provenance = { schema: 1, sourceRelease, baselineSha256, compatibleSourceReleases,
      extensionPolicy, requiredTools, targetSequence: sequence, overlayPaths: overlays, patchedPaths: [coordinatorPath], changedFiles };
    writeFileSync(join(stage, 'pi-update-source.json'), serialized(provenance));
    const hash = createHash('sha256');
    for (const path of filesAt(stage).filter(path => path !== 'host-manifest.json').sort()) {
      hash.update(path + '\0').update(readFileSync(join(stage, path)));
    }
    const id = `host-${hash.digest('hex').slice(0, 20)}`;
    const manifest = { ...sourceManifest, id, sequence, piVersion,
      extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }, { name: 'pi-subagents', version: '0.88.1' }] };
    writeFileSync(join(stage, 'host-manifest.json'), serialized(manifest));
    const archive = join(temporary, 'pi-release.tar.gz');
    deterministicArchive(stage, archive);
    const bytes = readFileSync(archive), pins = original.get(pinsPath);
    const metadata = { schema: 1, id, manifest, sha256: sha256(bytes), size: bytes.length,
      sourceRelease, compatibleSourceReleases, updateScope: 'compatible-server', extensionPolicy, requiredTools,
      runtimePinsSha256: sha256(pins), ...json(pins) };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'pi-release.tar.gz'), bytes);
    writeFileSync(join(outputDir, 'pi-release.json'), serialized(metadata));
    return metadata;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const metadata = buildPiUpdate();
  console.log(`Packaged full compatible server runtime ${metadata.id}: ${metadata.size} bytes, source ${metadata.sourceRelease}`);
}
