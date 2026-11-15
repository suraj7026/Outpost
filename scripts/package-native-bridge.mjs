// Builds an explicitly reviewed native schema-1 bridge, preserving its browser code and dependency lock.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw Error('Usage: node scripts/package-native-bridge.mjs SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY');
const source = resolve(sourceArg), output = resolve(outputArg), project = resolve(import.meta.dirname, '..');
const original = JSON.parse(readFileSync(join(source, 'host-manifest.json')));
if (original.schema !== 1 || original.protocolVersion !== 2 || original.layoutVersion !== 1 || !/^host-[a-f0-9]{20}$/.test(original.id)) throw Error('Unsupported native bridge source');
mkdirSync(dirname(output), { recursive: true }); mkdirSync(output, { mode: 0o700 });
const stage = join(output, 'source'); mkdirSync(stage);
const files = [];
function collect(directory) {
  for (const name of readdirSync(join(source, directory)).sort()) {
    const path = join(directory, name), stat = lstatSync(join(source, path));
    if (stat.isSymbolicLink()) throw Error('Bridge source cannot contain symlinks');
    if (stat.isDirectory()) { if (!['node_modules', '.venv', '__pycache__'].includes(name)) collect(path); }
    else if (/\.(ts|js|mjs|py|json|toml|lock)$/.test(name)) files.push(path);
  }
}
collect('server'); collect('deploy/environment');
files.push('deploy/agent/host-executor.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', 'host-manifest.json');
const baseline = {};
for (const file of files) {
  const bytes = readFileSync(join(source, file)); baseline[file] = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(dirname(join(stage, file)), { recursive: true }); writeFileSync(join(stage, file), bytes);
}
function overlay(path) { mkdirSync(dirname(join(stage, path)), { recursive: true }); cpSync(join(project, path), join(stage, path)); }
for (const name of readdirSync(join(project, 'server/pi-management'))) if (name.endsWith('.ts')) overlay(join('server/pi-management', name));
for (const file of ['server/pi-worker/http.ts', 'server/pi-worker/runs.ts', 'server/environment/maintenance.ts', 'server/environment/update-checkpoint.ts', 'server/environment/qualify-runtime.ts', 'deploy/environment/host_update.py', 'deploy/environment/native_bridge.py']) overlay(file);
function replace(path, before, after) {
  const text = readFileSync(join(stage, path), 'utf8');
  if (text.split(before).length !== 2) throw Error(`Source requires separate qualification: ${path}`);
  writeFileSync(join(stage, path), text.replace(before, after));
}
replace('server/main.ts', '  if (draining || !coordinator.dispatchEnabled)', "  void coordinator.maintenance.advance().catch(() => console.error('Maintenance hold needs reconciliation'));\n  if (draining || !coordinator.dispatchEnabled)");
replace('server/main.ts', '  coordinator.scheduler.tick();', '  if (!coordinator.maintenance.holding) coordinator.scheduler.tick();');
replace('server/gateway/coordinator.ts', "import { Installation }", "import { Maintenance } from '../environment/maintenance.js';\nimport { Installation }");
replace('server/gateway/coordinator.ts', '  readonly environment: Installation;', '  readonly environment: Installation;\n  readonly maintenance: Maintenance;');
replace('server/gateway/coordinator.ts', '    this.tasks.recover();', '    this.tasks.recover();\n    this.maintenance = new Maintenance(db, this.tasks, options.worker, () => this.jobs.size > 0 || this.managementWrites.size > 0);');
replace('server/gateway/coordinator.ts', '    const command = ClientCommand.parse(input);', "    const command = ClientCommand.parse(input);\n    if (this.maintenance.holding) requireThat(this.maintenance.status().state === 'draining' && ['task.pause', 'task.cancel', 'approval.decide'].includes(command.type), 'maintenance_in_progress');");
replace('server/gateway/coordinator.ts', "    const writes = !['catalogue'", "    if (['maintenance.stage', 'maintenance.prepare', 'maintenance.status', 'maintenance.cancel'].includes(request.type)) return this.maintenance.request(deviceId, request);\n    requireThat(!['maintenance.hold', 'maintenance.release'].includes(request.type), 'maintenance_internal_operation');\n    if (this.maintenance.holding) requireThat(['catalogue', 'runtime.inventory', 'transfer.inventory', 'transfer.history', 'transfer.status', 'transfer.cancel', 'login.status', 'login.answer', 'login.cancel'].includes(request.type), 'maintenance_in_progress');\n    const writes = !['catalogue'");
writeFileSync(join(stage, 'bridge-source.json'), JSON.stringify({ id: original.id, baseline }));
const hash = createHash('sha256');
function hashTree(directory = '') {
  for (const name of readdirSync(join(stage, directory)).sort()) {
    const path = join(directory, name);
    if (lstatSync(join(stage, path)).isDirectory()) hashTree(path);
    else hash.update(path + '\0').update(readFileSync(join(stage, path)));
  }
}
hashTree();
const dependencies = JSON.parse(readFileSync(join(stage, 'package.json'))).dependencies;
const manifest = { schema: 2, id: 'host-' + hash.digest('hex').slice(0, 20), protocolVersion: 2, layoutVersion: 1, compatibility: 'native-v1', sequence: 1, rollback: true, piVersion: dependencies['@earendil-works/pi-coding-agent'], extensions: [{ name: 'pi-ollama-cloud', version: dependencies['pi-ollama-cloud'] }] };
writeFileSync(join(stage, 'host-manifest.json'), JSON.stringify(manifest));
execFileSync('tar', ['-czf', join(output, 'bridge.tar.gz'), '-C', stage, '.']);
const bytes = readFileSync(join(output, 'bridge.tar.gz'));
writeFileSync(join(output, 'bridge.json'), JSON.stringify({ expectedRelease: original.id, manifest, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }, null, 2));
console.log(`Packaged native bridge ${original.id} -> ${manifest.id}; dependency lock and browser source retained`);
