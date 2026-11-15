// Invoked only by the disposable Ubuntu VM harness. No production routes or credentials.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function qualifyMaintenance({ root, inside, node, manifest, check }) {
  inside(['python3', '-c', "import pathlib,sys;p=pathlib.Path('/test/reviewed-host_update.py');p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)"], { input: readFileSync(join(root, 'deploy/environment/host_update.py')) });
  const source = readFileSync(join(root, 'scripts/qualify-maintenance-guest.mjs'));
  inside(['python3', '-c', "import pathlib,sys;p=pathlib.Path('/test/qualify-maintenance.mjs');p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)"], { input: source });
  const output = inside([node, '--import', `/opt/outpost-native/releases/${manifest.id}/node_modules/tsx/dist/loader.mjs`, '/test/qualify-maintenance.mjs'], { timeout: 2400000, maxBuffer: 4 * 1024 * 1024 });
  for (const line of output.split('\n').filter(line => line.startsWith('PASS:'))) console.log(line);
  check(output.includes('MAINTENANCE_QUALIFIED'), 'Real Linux update, rollback, stage-before-drain and two-installation encrypted import qualification');
}
