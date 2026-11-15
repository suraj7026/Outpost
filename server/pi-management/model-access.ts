import { lazyStream, type Provider } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { registerSubscriptionPolicy } from './subscription-models.js';
import { OllamaAccessVerifier, registerOllamaAccess } from './ollama-access.js';

/** Trusted, in-process verifier implementations only; never profile flags or user-supplied endpoints. */
export type AccessVerifiers = ReadonlyMap<string, (provider: Provider) => Provider>;

export function unverifiedProvider(base: Provider): Provider {
  return { ...base, filterModels: () => [], filterAllModels: () => [],
    ...(base.generateImages ? { generateImages: async () => { throw new Error('model_access_unverified'); } } : {}),
    ...(base.classify ? { classify: async () => { throw new Error('model_access_unverified'); } } : {}),
    ...(base.fetchDeferred ? { fetchDeferred: model => lazyStream(model, async () => { throw new Error('model_access_unverified'); }) } : {}),
    stream: model => lazyStream(model, async () => { throw new Error('model_access_unverified: This provider has no approved credential-scoped access verifier.'); }),
    streamSimple: model => lazyStream(model, async () => { throw new Error('model_access_unverified: This provider has no approved credential-scoped access verifier.'); }),
  };
}

export async function registerModelAccess(runtime: ModelRuntime, verifiers: AccessVerifiers = new Map(), ollama = new OllamaAccessVerifier()) {
  await registerSubscriptionPolicy(runtime);
  const refresh = runtime.refresh, pending: ReturnType<ModelRuntime['refresh']>[] = [];
  runtime.refresh = options => { const result = refresh.call(runtime, options); pending.push(result); return result; };
  try {
    for (const base of runtime.getProviders()) {
      if (base.id === 'openai') continue;
      const verifier = verifiers.get(base.id);
      if (base.id === 'ollama-cloud' && !verifier) registerOllamaAccess(runtime, base, ollama);
      else runtime.registerNativeProvider(verifier?.(base) ?? unverifiedProvider(base));
    }
  } finally { runtime.refresh = refresh; }
  // All registrations happen while the runtime is private. Await their actual refreshes.
  await Promise.all(pending);
}
