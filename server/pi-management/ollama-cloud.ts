import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, type ProviderConfig, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { managementError } from './contracts.js';

export const ollamaCloudVersion = '0.13.1';
let configuration: Promise<ProviderConfig> | undefined;

/** Load only the reviewed package from this release, never user/project resource declarations. */
export function ollamaCloudConfiguration(): Promise<ProviderConfig> {
  configuration ??= (async () => {
    const manifestPath = fileURLToPath(import.meta.resolve('pi-ollama-cloud/package.json'));
    const root = dirname(realpathSync(manifestPath));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== 'pi-ollama-cloud' || manifest.version !== ollamaCloudVersion)
      throw managementError('ollama_package_version_mismatch');
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
      settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [join(root, 'index.ts')],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    const registrations = loaded.runtime.pendingProviderRegistrations;
    if (loaded.errors.length || loaded.extensions.length !== 1 || registrations.length !== 1 ||
        registrations[0]?.name !== 'ollama-cloud' || loaded.runtime.pendingNativeProviderRegistrations.length ||
        loaded.runtime.pendingVirtualModelRegistrations.length)
      throw managementError('ollama_package_registration_invalid');
    const config = registrations[0].config;
    if (config.baseUrl !== 'https://ollama.com/v1' || config.api !== 'openai-completions' || !config.refreshModels)
      throw managementError('ollama_package_registration_invalid');
    // Provider-only integration: package session hooks/tools never run outside the coordinator gate.
    return { ...config, name: 'Ollama' };
  })();
  return configuration;
}

export async function registerOllamaCloud(runtime: ModelRuntime) {
  const config = await ollamaCloudConfiguration();
  // Pi 1.4 registration starts a detached refresh. Capture and await that exact refresh:
  // starting a second one can race its model-file read and restore the fallback after return.
  // This runtime is still private to construction; its method is restored synchronously.
  const refresh = runtime.refresh;
  const pending: ReturnType<ModelRuntime['refresh']>[] = [];
  runtime.refresh = options => { const result = refresh.call(runtime, options); pending.push(result); return result; };
  try { runtime.registerProvider('ollama-cloud', config); }
  finally { runtime.refresh = refresh; }
  for (const result of await Promise.all(pending)) {
    if (result.aborted || result.errors.has('ollama-cloud')) throw managementError('ollama_catalogue_restore_failed');
  }
}
