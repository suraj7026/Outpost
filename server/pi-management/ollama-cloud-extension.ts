import { ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSubscriptionPolicy, refreshSubscriptionModels } from './subscription-models.js';
import { ollamaCloudConfiguration } from './ollama-cloud.js';

/** The CLI uses the same pinned provider registration as the worker and Settings. */
export default async function (pi: ExtensionAPI) {
  pi.registerProvider('ollama-cloud', await ollamaCloudConfiguration());
  const builtins = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  await registerSubscriptionPolicy(builtins);
  if (!process.argv.includes('--offline')) await refreshSubscriptionModels(builtins);
  const openai = builtins.getProvider('openai');
  if (!openai) throw new Error('subscription_provider_invalid');
  pi.registerProvider(openai);
}
