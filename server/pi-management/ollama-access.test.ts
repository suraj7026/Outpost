import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { normalizeContext, type Provider, type RefreshModelsContext } from '@earendil-works/pi-ai';
import { OllamaAccessVerifier, ollamaApiKeyProvider } from './ollama-access.js';
import { registerOllamaCloud } from './ollama-cloud.js';

const key = 'synthetic-private-ollama-key';
const balance = (included = 10, purchased = 0) => ({ included: { balance_usd: included, allowance_usd: 20,
  period: { from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' } }, purchased: { balance_usd: purchased } });
async function original() {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  await registerOllamaCloud(runtime);
  const base = runtime.getProvider('ollama-cloud'); assert.ok(base);
  return { ...base, refreshModels: async () => {} };
}
async function refresh(provider: Provider, value = key, extra: Partial<RefreshModelsContext> = {}) {
  await provider.refreshModels!({ credential: { type: 'api_key', key: value }, allowNetwork: true, signal: AbortSignal.timeout(5000),
    publish: async publication => { assert.equal(publication.persist, undefined); publication.update?.(); return true; }, ...extra });
}
async function available(provider: Provider, value = key) {
  const credential = { type: 'api_key' as const, key: value };
  await provider.auth.apiKey!.check!({ credential, ctx: { env: async () => undefined, fileExists: async () => false }, signal: AbortSignal.timeout(5000) });
  return provider.filterModels!(provider.getModels(), credential);
}

test('Ollama validates the current key against fixed-origin balance without an inference probe', async () => {
  let calls = 0;
  const verifier = new OllamaAccessVerifier({ fetch: async (url, options) => {
    calls++; assert.equal(url, 'https://ollama.com/api/balance'); assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error'); assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${key}`);
    return Response.json(balance());
  } });
  const base = await original(), policy = ollamaApiKeyProvider(base, verifier);
  assert.equal((await available(policy)).length, 0);
  await refresh(policy);
  assert.ok((await available(policy)).length > 0);
  assert.equal(verifier.status(key).state, 'validated'); assert.equal(verifier.status(key).quota, 'available');
  assert.equal((await available(policy, 'different-private-key')).length, 0);
  await refresh(policy, key, { force: true }); assert.equal(calls, 1, 'Force model refresh still respects balance cooldown');
  assert.ok(!JSON.stringify(verifier.status(key)).includes(key));
});

test('balance checks coalesce across runtimes, expire, and honor Retry-After including force refresh', async () => {
  let now = 100_000, calls = 0;
  let response = () => Response.json(balance());
  const verifier = new OllamaAccessVerifier({ now: () => now, fetch: async () => { calls++; return response(); } });
  await Promise.all(Array.from({ length: 12 }, () => verifier.validate(key)));
  assert.equal(calls, 1);
  now += 60_001; assert.equal(verifier.status(key).state, 'unverified');
  response = () => Response.json({ error: key }, { status: 429, headers: { 'retry-after': '120' } });
  await assert.rejects(verifier.validate(key), /^Error: ollama_rate_limited$/);
  assert.equal(verifier.status(key).retryAt, now + 120_000);
  now += 61_000; await assert.rejects(verifier.validate(key), /ollama_rate_limited/); assert.equal(calls, 2);
  now += 60_000; response = () => Response.json(balance()); await verifier.validate(key); assert.equal(calls, 3);
});

test('invalid, suspended, redirected, malformed, oversized and unavailable balance responses fail closed safely', async () => {
  for (const [response, state] of [
    [() => Response.json({ error: key }, { status: 401 }), 'invalid_key'],
    [() => Response.json({ error: key }, { status: 403 }), 'account_suspended'],
    [() => Response.json({ error: key }, { status: 503 }), 'unavailable'],
    [() => new Response('', { status: 302, headers: { location: 'https://untrusted.example' } }), 'unavailable'],
    [() => Response.json({ data: [{ id: 'public-catalogue' }] }), 'unavailable'],
    [() => Response.json({ included: {}, purchased: {} }), 'unavailable'],
    [() => Response.json({ ...balance(), included: { balance_usd: '10' } }), 'unavailable'],
    [() => new Response('x'.repeat(70_000), { headers: { 'content-type': 'application/json' } }), 'unavailable'],
  ] as const) {
    const verifier = new OllamaAccessVerifier({ fetch: async () => response() });
    await assert.rejects(verifier.validate(key), error => error instanceof Error && error.message === `ollama_${state}`);
    assert.equal(verifier.status(key).state, state);
    assert.ok(!JSON.stringify(verifier.status(key)).includes(key));
  }
});

test('exhausted credits are distinct from invalid authentication, including legacy and purchased balances', async () => {
  for (const [data, quota] of [
    [balance(0), 'exhausted'], [balance(0, 5), 'available'],
    [{ included: { session: { remaining_percent: 50, resets_at: '2026-12-01T00:00:00Z' }, weekly: { remaining_percent: 0, resets_at: '2026-12-01T00:00:00Z' } }, purchased: { balance_usd: 0 } }, 'exhausted'],
    [{ included: { session: { remaining_percent: 50, resets_at: '2026-12-01T00:00:00Z' }, weekly: { remaining_percent: 20, resets_at: '2026-12-01T00:00:00Z' } }, purchased: { balance_usd: 0 } }, 'available'],
  ] as const) {
    const verifier = new OllamaAccessVerifier({ fetch: async () => Response.json(data) });
    await verifier.validate(key); assert.equal(verifier.status(key).state, 'validated'); assert.equal(verifier.status(key).quota, quota);
  }
});

test('cancelled callers and late checks cannot publish access for another key or rejected runtime generation', async () => {
  let release: (response: Response) => void = () => {};
  const verifier = new OllamaAccessVerifier({ fetch: async (_url, options) => {
    if (new Headers(options?.headers).get('authorization') === `Bearer ${key}`) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json(balance());
  } });
  const base = await original(), policy = ollamaApiKeyProvider(base, verifier);
  const controller = new AbortController(), pending = refresh(policy, key, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /ollama_check_cancelled/);
  await refresh(policy, 'replacement-key'); release(Response.json(balance()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await available(policy, key)).length, 0);
  assert.ok((await available(policy, 'replacement-key')).length > 0);
  const fresh = ollamaApiKeyProvider(base, verifier);
  await assert.rejects(refresh(fresh, 'replacement-key', { publish: async () => false }), /ollama_check_cancelled/);
  assert.equal((await available(fresh, 'replacement-key')).length, 0);
  const offline = ollamaApiKeyProvider(base, verifier);
  await refresh(offline, 'replacement-key', { allowNetwork: false });
  assert.equal((await available(offline, 'replacement-key')).length, 0, 'Cached authentication cannot activate a fresh offline runtime');
});

test('expired validation and rejected replacements never reuse a previous successful check', async () => {
  let now = 100_000, reject = false;
  const verifier = new OllamaAccessVerifier({ now: () => now, fetch: async () => reject ? Response.json({}, { status: 401 }) : Response.json(balance()) });
  const policy = ollamaApiKeyProvider(await original(), verifier);
  await refresh(policy); assert.ok((await available(policy)).length > 0);
  now += 60_001; assert.equal((await available(policy)).length, 0);
  reject = true; await assert.rejects(refresh(policy), /ollama_invalid_key/);
  assert.equal((await available(policy)).length, 0);
});

test('timeouts bound both stalled requests and stalled response bodies; pre-cancellation never contacts Ollama', async () => {
  let calls = 0, cancelled = false;
  const verifier = new OllamaAccessVerifier({ fetch: async () => { calls++; return new Promise<Response>(() => {}); } });
  await assert.rejects(verifier.validate(key, AbortSignal.abort()), /ollama_check_cancelled/);
  assert.equal(calls, 0);
  const body = new OllamaAccessVerifier({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  const keepAlive = setTimeout(() => {}, 10000);
  try {
    await Promise.all([assert.rejects(verifier.validate(key), /ollama_unavailable/), assert.rejects(body.validate(key), /ollama_unavailable/)]);
    assert.equal(cancelled, true);
    assert.equal(verifier.status(key).state, 'unavailable'); assert.equal(body.status(key).state, 'unavailable');
  } finally { clearTimeout(keepAlive); }
});

test('long and HTTP-date Retry-After values are not shortened to a minute or a day', async () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  for (const header of ['172800', 'Fri, 13 Nov 2026 00:00:00 GMT']) {
    const verifier = new OllamaAccessVerifier({ now: () => now, fetch: async () => Response.json({}, { status: 429, headers: { 'retry-after': header } }) });
    await assert.rejects(verifier.validate(key), /ollama_rate_limited/);
    assert.equal(verifier.status(key).retryAt, now + 172800000);
  }
});

test('direct streaming cannot bypass key checks or send credentials to a changed origin or unknown model', async () => {
  let calls = 0, streams = 0;
  const base = await original(), verifier = new OllamaAccessVerifier({ fetch: async () => { calls++; return Response.json({ error: key }, { status: 401 }); } });
  const policy = ollamaApiKeyProvider({ ...base, streamSimple: () => { streams++; throw new Error('unexpected inference'); } }, verifier);
  const model = base.getModels()[0]; assert.ok(model);
  for (const candidate of [model, { ...model, baseUrl: 'https://untrusted.example/v1' }, { ...model, id: 'unknown-model' }]) {
    const result = await policy.streamSimple(candidate, normalizeContext({ messages: [] }), { apiKey: key }).result();
    assert.equal(result.stopReason, 'error'); assert.ok(!result.errorMessage?.includes(key));
  }
  assert.equal(calls, 1); assert.equal(streams, 0);
});
