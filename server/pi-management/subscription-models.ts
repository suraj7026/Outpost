import { createHmac, randomBytes } from 'node:crypto';
import { lazyStream, type Credential, type Provider, type RefreshModelsContext } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { managementError } from './contracts.js';

const invalidators = new WeakMap<Provider, () => void>();
const runtimeInvalidators = new WeakMap<ModelRuntime, () => void>();
const endpoint = 'https://api.openai.com/v1/models';
const ttl = 60_000;
const bodyLimit = 2 * 1024 * 1024;
const catalogueSchema = z.object({ models: z.array(z.object({
  slug: z.string().min(1).max(256), visibility: z.string(), supported_in_api: z.boolean(),
  allow_only_codex_cloud_agent_orchestrator: z.boolean().optional(),
  allow_only_chatgpt_workspace_executor: z.boolean().optional(),
})).max(512) });

async function readCatalogue(response: Response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    void response.body?.cancel().catch(() => {});
    throw managementError('subscription_models_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw managementError('subscription_models_unavailable');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > bodyLimit) throw managementError('subscription_models_unavailable');
      chunks.push(result.value);
    }
    const data = catalogueSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (new Set(data.models.map(m => m.slug)).size !== data.models.length) throw managementError('subscription_models_unavailable');
    return new Set(data.models.filter(m => m.visibility === 'list' && m.supported_in_api &&
      !m.allow_only_codex_cloud_agent_orchestrator && !m.allow_only_chatgpt_workspace_executor).map(m => m.slug));
  } finally { void reader.cancel().catch(() => {}); }
}

/** Account-bound, memory-only policy. A static Pi model or a credential alone never grants access. */
export function subscriptionProvider(base: Provider, options: { fetch?: typeof fetch; now?: () => number } = {}): Provider {
  if (base.id !== 'openai') throw managementError('subscription_provider_invalid');
  const clock = options.now ?? Date.now;
  const key = randomBytes(32);
  const fingerprint = (access: string) => createHmac('sha256', key).update(access).digest('hex');
  let revision = 0;
  let verified: { key: string; until: number; models: Set<string> } | undefined;
  const allowed = (access: string, id: string, baseUrl: string) =>
    baseUrl === 'https://api.openai.com/v1' && verified?.key === fingerprint(access) && verified.until > clock() && verified.models.has(id);
  const accepts = (credential: Credential | undefined, model: { id: string; baseUrl: string; type?: string }) =>
    credential?.type === 'oauth' && (credential.expires > clock() && model.type !== 'classifier' && model.type !== 'image' && allowed(credential.access, model.id, model.baseUrl));
  const verify = async (access: string, signal: AbortSignal, force = false, expires = Infinity,
    publish: RefreshModelsContext['publish'] = async publication => { publication.update?.(); return true; }) => {
    const accountKey = fingerprint(access);
    if (!force && verified?.key === accountKey && verified.until > clock()) return;
    const current = ++revision; verified = undefined;
    try {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, { method: 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${access}`, accept: 'application/json' }, signal: bounded });
      const models = await readCatalogue(response);
      bounded.throwIfAborted();
      if (!await publish({ update: () => {
        if (current === revision) verified = { key: accountKey, until: Math.min(clock() + ttl, expires), models };
      } })) throw managementError('subscription_models_unavailable');
    } catch {
      if (current === revision) verified = undefined;
      throw managementError('subscription_models_unavailable');
    }
  };
  const guard = async (model: { id: string; baseUrl: string }, access: string | undefined, signal?: AbortSignal) => {
    // API-key inference stays blocked until a credential-scoped verifier is implemented for it.
    if (!access || access.startsWith('sk-')) throw managementError('model_access_unverified');
    if (model.baseUrl !== 'https://api.openai.com/v1') throw managementError('subscription_model_not_verified');
    await verify(access, signal ?? AbortSignal.timeout(8000));
    if (!allowed(access, model.id, model.baseUrl)) throw managementError('subscription_model_not_verified');
  };
  const policy: Provider = {
    ...base,
    ...(base.generateImages ? { generateImages: async () => { throw managementError('model_access_unverified'); } } : {}),
    ...(base.classify ? { classify: async () => { throw managementError('model_access_unverified'); } } : {}),
    ...(base.fetchDeferred ? { fetchDeferred: model => lazyStream(model, async () => { throw managementError('model_access_unverified'); }) } : {}),
    filterModels: (models, credential) => (base.filterModels?.(models, credential) ?? models).filter(m => accepts(credential, m)),
    filterAllModels: (models, credential) => (base.filterAllModels?.(models, credential) ?? models).filter(m => accepts(credential, m)),
    async refreshModels(context) {
      if (context.credential?.type !== 'oauth') { revision++; verified = undefined; return; }
      if (context.allowNetwork && context.force) { revision++; verified = undefined; }
      // Pi's public catalogue supplies transport metadata only, never account access.
      // A failed public refresh may retain known metadata; authenticated discovery still must succeed.
      await base.refreshModels?.(context).catch(() => {});
      const credential = context.credential, accountKey = fingerprint(credential.access);
      if (verified?.key !== accountKey) verified = undefined;
      if (!context.allowNetwork) return;
      await verify(credential.access, context.signal, context.force, credential.expires, context.publish);
    },
    stream(model, context, options) { return lazyStream(model, async () => {
      await guard(model, options?.apiKey, options?.signal); return base.stream(model, context, options);
    }); },
    streamSimple(model, context, options) { return lazyStream(model, async () => {
      await guard(model, options?.apiKey, options?.signal); return base.streamSimple(model, context, options);
    }); },
  };
  invalidators.set(policy, () => { revision++; verified = undefined; });
  return policy;
}

export async function registerSubscriptionPolicy(runtime: ModelRuntime) {
  const base = runtime.getProvider('openai');
  if (!base) throw managementError('subscription_provider_invalid');
  // Await Pi 1.4's detached registration refresh before issuing the network refresh.
  const refresh = runtime.refresh;
  const pending: ReturnType<ModelRuntime['refresh']>[] = [];
  runtime.refresh = options => { const result = refresh.call(runtime, options); pending.push(result); return result; };
  const policy = subscriptionProvider(base);
  runtimeInvalidators.set(runtime, invalidators.get(policy)!);
  try { runtime.registerNativeProvider(policy); }
  finally { runtime.refresh = refresh; }
  await Promise.all(pending);
}

export async function refreshSubscriptionModels(runtime: ModelRuntime) {
  try {
    const result = await runtime.refresh({ providers: ['openai'], allowNetwork: true, signal: AbortSignal.timeout(9000) });
    const failed = result.aborted || result.errors.has('openai');
    if (failed) runtimeInvalidators.get(runtime)?.();
    return failed;
  } catch { runtimeInvalidators.get(runtime)?.(); return true; }
}
