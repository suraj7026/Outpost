#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const packageRoot = dirname(dirname(entry));
const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const dependencies = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies;
const modules = realpathSync(join(root, 'node_modules')) + sep;
if (manifest.piVersion !== installed.version || dependencies['@earendil-works/pi-coding-agent'] !== installed.version || !realpathSync(entry).startsWith(modules) ||
    createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex') !== manifest.lockHash)
  throw new Error('Managed Pi release mismatch; refusing a different installation.');
const extensions = ['pi-ollama-cloud', 'pi-subagents'].filter(name => name === 'pi-ollama-cloud' || Object.hasOwn(dependencies, name)).map(name => {
  const version = dependencies[name];
  const directory = realpathSync(join(root, 'node_modules', name));
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      metadata.name !== name || metadata.version !== version || !directory.startsWith(modules) || !metadata.pi?.extensions?.length)
    throw new Error('Managed extension release mismatch; refusing a different installation.');
  for (const kind of ['extensions', 'skills', 'prompts', 'themes']) {
    const paths = metadata.pi[kind] ?? [];
    if (!Array.isArray(paths)) throw new Error('Managed extension resources invalid.');
    for (const path of paths) {
      const suffix = relative(directory, realpathSync(join(directory, path)));
      if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('Managed extension resources invalid.');
    }
  }
  return { name, version, directory };
});
if (process.argv[2] === '--outpost-runtime') {
  console.log(JSON.stringify({ release: manifest.id, piVersion: installed.version, profile: manifest.profile, resources: 'native-installed',
    extensions: extensions.map(({ name, version }) => ({ name, version })), extensionStates: Object.fromEntries(extensions.map(({ name }) => [name, 'enabled'])) }));
} else {
  const args = process.argv.slice(2);
  // Installing/updating packages through an unversioned profile would break worker/CLI parity.
  if (['install','remove','uninstall','update','config'].includes(args[0]) || args.some(arg => /^-e|^--(?:extension|skill|prompt-template|theme)(?:=|$)/.test(arg)))
    throw new Error('Resource changes are disabled in this managed release. Use the owner-reviewed release workflow.');
  // Explicit package directories retain their bundled skills/prompts despite ambient-discovery suppression.
  // Load the native provider policy last so package registration cannot replace composed authentication.
  // The upstream loader exclusion makes subagent tools eager rather than requiring an enable-tool call.
  const child = spawn(process.execPath, [join(packageRoot, 'dist/bundle/cli.js'), '--no-extensions',
    ...extensions.flatMap(({ directory }) => ['--extension', directory]), '--extension', join(root, 'server/pi-management/ollama-cloud-extension.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', ...(extensions.some(({ name }) => name === 'pi-subagents') ? ['--exclude-tools', 'subagents_enable'] : []), ...args], {
    stdio: 'inherit', env: { ...process.env, PI_CODING_AGENT_DIR: manifest.profile, OUTPOST_PI_RELEASE: manifest.id, PI_TELEMETRY: '0' },
  });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', () => { console.error('Managed Pi failed to start.'); process.exitCode = 1; });
}
