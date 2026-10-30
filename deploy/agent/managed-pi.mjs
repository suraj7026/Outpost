#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const packageRoot = dirname(dirname(entry));
const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
if (manifest.piVersion !== installed.version || !realpathSync(entry).startsWith(realpathSync(join(root, 'node_modules')) + '/') ||
    createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex') !== manifest.lockHash)
  throw new Error('Managed Pi release mismatch; refusing a different installation.');
if (process.argv[2] === '--outpost-runtime') {
  console.log(JSON.stringify({ release: manifest.id, piVersion: installed.version, profile: manifest.profile, resources: 'managed-provider-only', providerPackages: ['pi-ollama-cloud@0.13.1'] }));
} else {
  const args = process.argv.slice(2);
  // Installing/updating packages through an unversioned profile would break worker/CLI parity.
  if (['install','remove','uninstall','update','config'].includes(args[0]) || args.some(arg => /^(?:-e|--extension|--skill|--prompt-template|--theme)(?:=|$)/.test(arg)))
    throw new Error('Resource changes are disabled in this managed release. Use the owner-reviewed release workflow.');
  const child = spawn(process.execPath, [join(packageRoot, 'dist/bundle/cli.js'), '--no-extensions', '--extension', join(root, 'server/pi-management/ollama-cloud-extension.ts'), '--no-skills', '--no-prompt-templates', '--no-themes', ...args], {
    stdio: 'inherit', env: { ...process.env, PI_CODING_AGENT_DIR: manifest.profile, OUTPOST_PI_RELEASE: manifest.id, PI_TELEMETRY: '0', PI_OLLAMA_WEB_TOOLS: '0' },
  });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', () => { console.error('Managed Pi failed to start.'); process.exitCode = 1; });
}
