import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PiProfile } from './profile.js';
import { refreshSubscriptionModels } from './subscription-models.js';
import { refreshOllamaModels } from './ollama-access.js';

/** Managed CLI entry: the same provider and access policies as the worker, with no package tools. */
export default async function managedProviders(pi: ExtensionAPI) {
  try {
    const profile = new PiProfile(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
    const runtime = await profile.runtime();
    if (!process.argv.includes('--offline') && process.env.PI_OFFLINE === undefined) {
      await Promise.all([refreshSubscriptionModels(runtime), refreshOllamaModels(runtime)]);
    }
    const settings = profile.settings(), provider = settings.getDefaultProvider(), model = settings.getDefaultModel();
    const inspecting = process.argv.some(arg => ['--list-models','--help','-h'].includes(arg) || arg.startsWith('--list-models='));
    const explicit = process.argv.some(arg => ['--model','--models','--provider'].includes(arg) || /^(--model|--models|--provider)=/.test(arg));
    if (!inspecting && !explicit && (provider || model) && !(await runtime.getAvailable()).some(m => m.provider === provider && m.id === model)) {
      console.error('Saved default model has not passed its provider access policy. Choose an available provider/model explicitly; no fallback was selected.');
      process.exit(1);
    }
    for (const provider of runtime.getProviders()) pi.registerProvider(provider);
  } catch {
    // Pi normally skips failed extensions. That would expose its unfiltered built-ins here.
    console.error('Managed model-access enforcement unavailable. CLI startup blocked.');
    process.exit(1);
  }
}
