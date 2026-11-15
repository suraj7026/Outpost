// Exact downloaded schema-1 source, synthetic enrollment/data only, inside the disposable VM.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function qualifyNativeBridge({ root, inside, node, manifest, check, packageDirectory, sourceArchive, resumeLegacy = false, resetLegacy = false }) {
  for (const [name, bytes] of [['legacy.tar.gz', readFileSync(sourceArchive)], ['bridge.tar.gz', readFileSync(join(packageDirectory, 'bridge.tar.gz'))], ['bridge.json', readFileSync(join(packageDirectory, 'bridge.json'))], ['qualify-bridge.mjs', readFileSync(join(root, 'scripts/qualify-native-bridge-guest.mjs'))]]) {
    inside(['python3', '-c', `import pathlib,sys;p=pathlib.Path('/test/${name}');p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)`], { input: bytes });
  }
  const artifact = JSON.parse(readFileSync(join(packageDirectory, 'bridge.json')));
  console.log(`Bridge fixture artifact: ${artifact.manifest.id} sha256=${artifact.sha256}`);
  const output = inside([node, '/test/qualify-bridge.mjs', ...(resumeLegacy ? ['--resume-legacy'] : []), ...(resetLegacy ? ['--reset-legacy-fixture'] : [])], { timeout: 1200000, maxBuffer: 4 * 1024 * 1024 });
  for (const line of output.split('\n').filter(line => line.startsWith('PASS:'))) console.log(line);
  check(output.includes('NATIVE_BRIDGE_QUALIFIED'), 'Exact schema-1 source transitions to the maintenance engine without changing browser source, dependencies, identity or provider data');
}
