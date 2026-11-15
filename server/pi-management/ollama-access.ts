import { createHmac, randomBytes } from 'node:crypto';
import { lazyStream, type Credential, type Provider } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { managementError, type OllamaAuthentication } from './contracts.js';

const endpoint = 'https://ollama.com/api/balance';
const baseUrl = 'https://ollama.com/v1';
const interval = 60_000;
const timestamp = z.string().datetime({ offset: true });
const windowSchema = z.object({ remaining_percent: z.number().min(0).max(100), resets_at: timestamp });
const balanceSchema = z.object({
  included: z.union([
    z.object({ balance_usd: z.number(), allowance_usd: z.number().nonnegative(), period: z.object({ from: timestamp, until: timestamp }) }),
    z.object({ session: windowSchema, weekly: windowSchema }),
    z.object({ monthly: windowSchema }),
  ]),
  purchased: z.object({ balance_usd: z.number() }),
});

type Result = { status: OllamaAuthentication; until: number };
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(managementError('ollama_check_cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(managementError('ollama_check_cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function readBalance(response: Response, signal: AbortSignal) {
  if (!response.headers.get('content-type')?.includes('application/json')) throw managementError('ollama_unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw managementError('ollama_unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await wait(reader.read(), signal); if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) throw managementError('ollama_unavailable');
      chunks.push(next.value);
    }
    return balanceSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { void reader.cancel().catch(() => {}); }
}

/** Profile-scoped, bounded and memory-only. No key, balance amount or upstream body is projected. */
export class OllamaAccessVerifier {
  private readonly salt = randomBytes(32);
  private readonly checks = new Map<string, { result?: Result; pending?: Promise<Result> }>();
  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  identity(key: string) { return createHmac('sha256', this.salt).update(key).digest('hex'); }
  validated(identity: string) {
    const result = this.checks.get(identity)?.result;
    return !!result && result.until > this.now() && result.status.state === 'validated';
  }
  status(key?: string): OllamaAuthentication {
    if (!key) return { state: 'missing' };
    const result = this.checks.get(this.identity(key))?.result;
    return result && result.until > this.now() ? { ...result.status } : { state: 'unverified' };
  }
  async validate(key: string, signal: AbortSignal = AbortSignal.timeout(9000)) {
    if (signal.aborted) throw managementError('ollama_check_cancelled');
    if (!key || key.length > 32768 || /[\r\n]/.test(key)) throw managementError('ollama_invalid_key');
    const identity = this.identity(key);
    let entry = this.checks.get(identity);
    if (!entry) {
      if (this.checks.size >= 32) {
        const oldest = [...this.checks].find(([, value]) => !value.pending);
        if (!oldest) throw managementError('ollama_unavailable');
        this.checks.delete(oldest[0]);
      }
      entry = {}; this.checks.set(identity, entry);
    }
    if (!entry.pending && (!entry.result || entry.result.until <= this.now())) {
      const saved = entry;
      // Shared checks have their own timeout: cancelling one caller must not poison other runtimes.
      saved.pending = this.check(key).then(result => { saved.result = result; delete saved.pending; return result; });
    }
    const result = await wait(entry.pending ?? Promise.resolve(entry.result!), signal);
    if (result.status.state !== 'validated') throw managementError(`ollama_${result.status.state}`);
  }
  private async check(key: string): Promise<Result> {
    const signal = AbortSignal.timeout(8000);
    let response: Response | undefined;
    try {
      const request = (this.options.fetch ?? globalThis.fetch)(endpoint, { method: 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal });
      void request.then(value => { if (signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
      response = await wait(request, signal);
      if (response.status !== 200) {
        const state = response.status === 401 ? 'invalid_key' : response.status === 403 ? 'account_suspended' : response.status === 429 ? 'rate_limited' : 'unavailable';
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
        const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
        const backoff = state === 'rate_limited' ? Math.max(interval, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - this.now() : interval) : interval;
        const until = Math.min(8.64e15, this.now() + backoff);
        return { status: { state, checkedAt: this.now(), retryAt: until }, until };
      }
      const balance = await readBalance(response, signal);
      signal.throwIfAborted();
      const included = balance.included;
      const available = balance.purchased.balance_usd > 0 || ('balance_usd' in included ? included.balance_usd > 0
        : 'monthly' in included ? included.monthly.remaining_percent > 0 : included.session.remaining_percent > 0 && included.weekly.remaining_percent > 0);
      return { status: { state: 'validated', quota: available ? 'available' : 'exhausted', checkedAt: this.now() }, until: this.now() + interval };
    } catch {
      return { status: { state: 'unavailable', checkedAt: this.now(), retryAt: this.now() + interval }, until: this.now() + interval };
    } finally { if (response && !response.bodyUsed) void response.body?.cancel().catch(() => {}); }
  }
}

/** Explicit Ollama exception: authenticate the key, not a claim of per-model entitlement. */
export function ollamaApiKeyProvider(base: Provider, verifier: OllamaAccessVerifier): Provider {
  if (base.id !== 'ollama-cloud' || base.baseUrl !== baseUrl || !base.auth.apiKey) throw managementError('ollama_provider_invalid');
  const apiKey = base.auth.apiKey;
  let published: string | undefined;
  let checked: { source: string; effective: string } | undefined;
  const source = (credential?: Credential) => verifier.identity(JSON.stringify(credential ?? null));
  const isChat = (model: { provider: string; id: string; baseUrl: string; api: string; type?: string }) =>
    model.provider === base.id && model.baseUrl === baseUrl && model.api === 'openai-completions' && (!model.type || model.type === 'chat');
  const accepts = (credential?: Credential) => credential?.type !== 'oauth' && checked?.source === source(credential) &&
    checked.effective === published && verifier.validated(checked.effective);
  const guard = async (model: Parameters<Provider['streamSimple']>[0], key?: string, signal?: AbortSignal) => {
    if (!key || !isChat(model) || !base.getModels().some(candidate => candidate.id === model.id && isChat(candidate))) throw managementError('ollama_model_unavailable');
    await verifier.validate(key, signal);
  };
  return {
    ...base,
    auth: { ...base.auth, apiKey: { ...apiKey, async check(context) {
      if (apiKey.check && !await apiKey.check(context)) { checked = undefined; return undefined; }
      const result = await apiKey.resolve(context);
      checked = result?.auth.apiKey ? { source: source(context.credential), effective: verifier.identity(result.auth.apiKey) } : undefined;
      return result ? { type: 'api_key', ...(result.source ? { source: result.source } : {}) } : undefined;
    } } },
    filterModels: (models, credential) => accepts(credential) ? (base.filterModels?.(models, credential) ?? models).filter(isChat) : [],
    filterAllModels: (models, credential) => accepts(credential) ? (base.filterAllModels?.(models, credential) ?? models).filter(isChat) : [],
    ...(base.generateImages ? { generateImages: async () => { throw managementError('model_access_unverified'); } } : {}),
    ...(base.classify ? { classify: async () => { throw managementError('model_access_unverified'); } } : {}),
    ...(base.fetchDeferred ? { fetchDeferred: model => lazyStream(model, async () => { throw managementError('model_access_unverified'); }) } : {}),
    async refreshModels(context) {
      if (!context.allowNetwork) { await base.refreshModels?.(context); return; }
      if (context.baseUrl && context.baseUrl !== baseUrl || context.credential?.type !== 'api_key') {
        published = undefined; throw managementError('ollama_model_unavailable');
      }
      const key = context.credential.key;
      published = undefined;
      if (!key) throw managementError('ollama_invalid_key');
      await verifier.validate(key, context.signal);
      await base.refreshModels?.(context);
      context.signal.throwIfAborted();
      if (!await context.publish({ update: () => { published = verifier.identity(key); } })) throw managementError('ollama_check_cancelled');
    },
    stream(model, context, options) { return lazyStream(model, async () => {
      await guard(model, options?.apiKey, options?.signal); return base.stream(model, context, options);
    }); },
    streamSimple(model, context, options) { return lazyStream(model, async () => {
      await guard(model, options?.apiKey, options?.signal); return base.streamSimple(model, context, options);
    }); },
  };
}

const runtimes = new WeakMap<ModelRuntime, OllamaAccessVerifier>();
export function registerOllamaAccess(runtime: ModelRuntime, base: Provider, verifier: OllamaAccessVerifier) {
  runtimes.set(runtime, verifier);
  runtime.registerNativeProvider(ollamaApiKeyProvider(base, verifier));
}
export async function refreshOllamaModels(runtime: ModelRuntime) {
  if (!runtimes.has(runtime)) return false;
  try {
    const result = await runtime.refresh({ providers: ['ollama-cloud'], allowNetwork: true, signal: AbortSignal.timeout(15000) });
    return result.aborted || result.errors.has('ollama-cloud');
  } catch { return true; }
}
export async function ollamaAuthentication(runtime: ModelRuntime): Promise<OllamaAuthentication | undefined> {
  const verifier = runtimes.get(runtime); if (!verifier) return undefined;
  try {
    const options = { signal: AbortSignal.timeout(3000) };
    if (!await runtime.checkAuth('ollama-cloud', options)) return { state: 'missing' };
    const auth = await runtime.getAuth('ollama-cloud', options);
    return verifier.status(auth?.auth.apiKey);
  } catch { return { state: 'unavailable' }; }
}
