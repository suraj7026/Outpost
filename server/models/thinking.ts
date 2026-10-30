import type { InferenceConfiguration } from './inference.js';

const cache = new Map<string,{ until: number; supported: boolean }>();
/** Ask Ollama rather than guessing reasoning support from a model's name. */
export async function supportsThinking(inference?: InferenceConfiguration): Promise<boolean> {
  if (!inference) return false;
  const key = `${inference.baseUrl}:${inference.model}`, cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.supported;
  try {
    const response = await fetch(`${inference.baseUrl.replace(/\/v1\/?$/,'')}/api/show`,{ method: 'POST',redirect: 'error',signal: AbortSignal.timeout(3000),headers: { 'content-type': 'application/json' },body: JSON.stringify({ model: inference.model }) });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    const supported = typeof result === 'object' && result !== null && 'capabilities' in result && Array.isArray(result.capabilities) && result.capabilities.includes('thinking');
    if (cache.size > 100) cache.clear();
    cache.set(key,{ until: Date.now()+300000,supported });
    return supported;
  } catch { return false; }
}
