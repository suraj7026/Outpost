import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { platform, arch, release, cpus, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

// Local, read-only probes only. Never reads API keys or calls a paid/provider API.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const probe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  return { ok: result.status === 0, output: result.status === 0 ? result.stdout.trim().slice(0, 4096) : 'Unavailable or probe failed' };
};
const manifest = json('package.json'), lock = json('package-lock.json');
const dependencies = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).map(([name, pin]) => {
  const installed = json(`node_modules/${name}/package.json`), resolved = lock.packages[`node_modules/${name}`];
  if (installed.version !== pin || resolved?.version !== pin) throw Error(`Installed/locked version differs from exact pin: ${name}`);
  return { name, version: installed.version, license: installed.license ?? 'Inspect package license', integrity: resolved.integrity ?? null, redistributionReview: 'not-completed' };
});
let browser = { available: false, version: null, boundary: 'local headless smoke probe; not an Ubuntu/host isolation qualification' };
let instance;
try {
  instance = await chromium.launch({ headless: true });
  browser = { ...browser, available: true, version: instance.version() };
} catch { /* Missing browser installation is recorded, not interpreted as success. */ }
finally { await instance?.close(); }
const sources = ['package-lock.json', 'server/pi-adapter/runtime.ts', 'server/models/cloud.ts', 'server/gateway/coordinator.ts', 'clients/Shared/Protocol.swift'].map(path => ({ path, sha256: sha(readFileSync(path)) }));
const report = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceRevision: probe('git', ['rev-parse', 'HEAD']).output,
  implementationTreeClean: spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'server', 'clients', 'package-lock.json']).status === 0,
  overall: 'DEVELOPMENT_ONLY_NOT_QUALIFIED_FOR_RELEASE',
  runtime: { node: process.version, nodeSQLite: process.versions.sqlite, platform: platform(), arch: arch(), kernel: release(), cpuCount: cpus().length, totalMemoryBytes: totalmem() },
  tools: { swift: probe('swift', ['--version']), xcode: probe('xcodebuild', ['-version']), ffmpeg: probe('ffmpeg', ['-version']) },
  dependencies, overrides: manifest.overrides, browser, sources,
  boundaries: { bind: '127.0.0.1', enforcement: 'cooperative-development', virtualization: 'not-probed', hostRootIsolation: 'not-qualified', productionDefault: 'owner-decision-pending; development uses ask_permission' },
  externalQualification: { ollamaRoles: 'not-run', smallerReviewerSafety: 'not-run', vision: 'not-run', ubuntuDeployment: 'not-run', physicalDevices: 'not-run', apnsDelivery: 'not-run', providerAccounts: 'not-run', paymentRoute: 'not-run', replacementServerRestore: 'not-run', redistribution: 'not-reviewed' },
};
const destination = process.argv[2] ?? 'docs/implementation/QUALIFICATION.json';
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(`Recorded local pins/probes in ${destination}. No release or external-service qualification is implied.`);
