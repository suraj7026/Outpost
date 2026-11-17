import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { managementError } from './contracts.js';

const activation = { 'pi-ollama-cloud': 'enabled', 'pi-subagents': 'enabled' } as const;
type ExtensionName = keyof typeof activation;
export type BundledExtensions = {
  extensions: { name: ExtensionName; version: string }[];
  extensionStates: Partial<typeof activation>;
};
const packageManifest = z.object({ name: z.string(), version: z.string() });
const releaseManifest = z.object({ dependencies: z.record(z.string(), z.unknown()) });
const exactVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);

/** Installed release packages are enabled by default; inventory never executes package code. */
export function bundledExtensions(releaseDirectory = fileURLToPath(new URL('../../', import.meta.url))): BundledExtensions {
  try {
    const { dependencies } = releaseManifest.parse(JSON.parse(readFileSync(join(releaseDirectory, 'package.json'), 'utf8')));
    const modules = realpathSync(join(releaseDirectory, 'node_modules')) + sep;
    const extensions: BundledExtensions['extensions'] = [];
    const extensionStates: BundledExtensions['extensionStates'] = {};
    for (const name of Object.keys(activation) as ExtensionName[]) {
      // Native bridges retain their original dependency set, before subagents was bundled.
      if (name === 'pi-subagents' && !Object.hasOwn(dependencies, name)) continue;
      const version = exactVersion.parse(dependencies[name]);
      const path = realpathSync(join(modules, name, 'package.json'));
      if (!path.startsWith(modules)) throw managementError('bundled_extensions_invalid');
      const installed = packageManifest.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (installed.name !== name || installed.version !== version) throw managementError('bundled_extensions_invalid');
      extensions.push({ name, version });
      Object.assign(extensionStates, { [name]: activation[name] });
    }
    return { extensions, extensionStates };
  } catch { throw managementError('bundled_extensions_invalid'); }
}
