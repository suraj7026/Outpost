import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { normalizeContext, type OAuthCredential, type Provider, type RefreshModelsContext } from '@earendil-works/pi-ai';
import { subscriptionProvider } from './subscription-models.js';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';
import { WorkerRuns } from '../pi-worker/runs.js';

const supported = 'gpt-6.1-sol', denied = 'gpt-5.4-nano';
const entry = (slug: string, extra = {}) => ({ slug, visibility: 'list', supported_in_api: true, ...extra });
const credential = (access = 'fixture-oauth-access'): OAuthCredential => ({ type: 'oauth', access, refresh: 'fixture-refresh', expires: Date.now() + 3600000 });
async function original() {
  const r = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const p = r.getProvider('openai'); assert.ok(p); const { refreshModels: _refresh, ...staticProvider } = p; return staticProvider;
}
async function refresh(provider: Provider, value = credential(), extra: Partial<RefreshModelsContext> = {}) {
  await provider.refreshModels!({ credential: value, allowNetwork: true, signal: AbortSignal.timeout(5000),
    publish: async p => { assert.equal(p.persist, undefined, 'Account state is not persisted'); p.update?.(); return true; }, ...extra });
}

test('authenticated account catalogue, not baked-in metadata, controls ChatGPT availability', async () => {
  let calls = 0;
  const base = await original();
  const policy = subscriptionProvider(base, { fetch: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-oauth-access'); calls++;
    return Response.json({ models: [entry(supported), entry(denied, { visibility: 'hide' }),
      entry('gpt-6-sol', { supported_in_api: false }), entry('gpt-6-luna', { allow_only_chatgpt_workspace_executor: true }),
      entry('gpt-6-astra', { allow_only_codex_cloud_agent_orchestrator: true }), entry('future-unknown-model')] });
  } });
  assert.equal(policy.filterModels!(base.getModels(), credential()).length, 0);
  await refresh(policy);
  assert.deepEqual(policy.filterModels!(base.getModels(), credential()).map(m => m.id), [supported]);
  assert.equal(policy.filterAllModels!(base.getAllModels!(), credential()).length, 1);
  await refresh(policy); assert.equal(calls, 1, 'Short cache is tied to the same access token');
  assert.equal(policy.filterModels!(base.getModels(), credential('different-account')).length, 0);
  assert.ok(policy.filterModels!(base.getModels(), { type: 'api_key', key: 'sk-fixture' }).some(m => m.id === denied), 'API-key billing remains separate');
});

test('expiry, forced failure, malformed or oversized responses fail closed without reflected secrets', async () => {
  let now = Date.now(), response = () => Response.json({ models: [entry(supported)] });
  const base = await original(), policy = subscriptionProvider(base, { now: () => now, fetch: async () => response() });
  await refresh(policy);
  now += 61000;
  assert.equal(policy.filterModels!(base.getModels(), credential()).length, 0);
  await refresh(policy);
  for (const invalid of [() => Response.json({ error: 'private-provider-body' }, { status: 403 }),
    () => Response.json({ data: [{ id: supported }] }),
    () => Response.json({ models: [entry(supported), entry(supported)] }),
    () => new Response('private-provider-body'.repeat(120000), { headers: { 'content-type': 'application/json' } })]) {
    response = invalid;
    await assert.rejects(refresh(policy, credential(), { force: true }), e => e instanceof Error && e.message === 'subscription_models_unavailable');
    assert.equal(policy.filterModels!(base.getModels(), credential()).length, 0);
  }
  response = () => Response.json({ models: [entry(supported)] });
  await assert.rejects(refresh(policy, credential(), { force: true, signal: AbortSignal.abort() }), /subscription_models_unavailable/);
  assert.equal(policy.filterModels!(base.getModels(), credential()).length, 0);
  response = () => Response.json({ models: [] }); await refresh(policy);
  assert.equal(policy.filterModels!(base.getModels(), credential()).length, 0, 'Empty account list is not replaced with static models');
});

test('late old-account responses and rejected publications cannot authorize models', async () => {
  const base = await original(); let release: (response: Response) => void = () => {};
  const policy = subscriptionProvider(base, { fetch: async (_url, options) => {
    if (new Headers(options?.headers).get('authorization')?.includes('account-a')) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ models: [entry('gpt-6-sol')] });
  } });
  const old = refresh(policy, credential('account-a'));
  await new Promise(resolve => setImmediate(resolve));
  await refresh(policy, credential('account-b'));
  release(Response.json({ models: [entry(supported)] })); await old;
  assert.equal(policy.filterModels!(base.getModels(), credential('account-a')).length, 0);
  assert.deepEqual(policy.filterModels!(base.getModels(), credential('account-b')).map(m => m.id), ['gpt-6-sol']);
  await assert.rejects(refresh(policy, credential('account-b'), { force: true, publish: async () => false }));
  assert.equal(policy.filterModels!(base.getModels(), credential('account-b')).length, 0);
});

test('direct model lookup cannot bypass subscription verification or send an inference request', async () => {
  const base = await original(); let streams = 0, requests = 0;
  const policy = subscriptionProvider({ ...base, streamSimple: () => { streams++; throw new Error('must not dispatch'); } }, {
    fetch: async () => { requests++; return Response.json({ models: [entry(supported)] }); },
  });
  const model = base.getModels().find(m => m.id === denied); assert.ok(model);
  const result = await policy.streamSimple(model, normalizeContext({ messages: [] }), { apiKey: credential().access }).result();
  assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage ?? '', /subscription_model_not_verified/);
  assert.equal(streams, 0); assert.equal(requests, 1);
});

test('managed CLI uses the same account policy and stays closed offline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-subscription-cli-'));
  try {
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ openai: credential() }));
    const mock = join(directory, 'mock.mjs');
    writeFileSync(mock, `const mockFetch = async (url, options) => {
      if (String(url).startsWith('https://pi.dev/api/models/providers/openai?')) return new Response('', {status:404});
      if (String(url) !== 'https://api.openai.com/v1/models' || options?.method !== 'GET') throw new Error('unexpected_request');
      return Response.json({models:[${JSON.stringify(entry(supported))}]});
    }; Object.defineProperty(globalThis, 'fetch', {get:()=>mockFetch, set:()=>{}});`);
    for (const offline of [false, true]) {
      const cli = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href,
        resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), '--no-extensions', '--extension',
        resolve('server/pi-management/ollama-cloud-extension.ts'), '--no-skills', '--no-prompt-templates', '--no-themes',
        ...(offline ? ['--offline'] : []), '--list-models', 'openai'], { encoding: 'utf8', timeout: 20000,
        env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' } });
      assert.equal(cli.status, 0, cli.stderr);
      if (offline) assert.ok(!cli.stdout.includes(supported)); else assert.ok(cli.stdout.includes(supported), cli.stdout + cli.stderr);
      assert.ok(!cli.stdout.includes(denied));
      assert.ok(!(cli.stdout + cli.stderr).includes('fixture-oauth-access'));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real profile, catalogue, defaults and worker all refuse unavailable ChatGPT models; account replacement refreshes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-subscription-'));
  const profile = new PiProfile(directory), service = new ProviderManagement(profile);
  const worker = new WorkerRuns(profile, join(directory, 'workspaces'), join(directory, 'sessions'));
  const authPath = join(directory, 'auth.json');
  let fail = false, requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith('https://pi.dev/api/models/providers/openai?')) {
      assert.equal(new Headers(options?.headers).has('authorization'), false); return new Response('', { status: 404 });
    }
    assert.equal(String(input), 'https://api.openai.com/v1/models', 'No inference or unintended network requests'); requests++;
    if (fail) return Response.json({ error: 'private-error-body' }, { status: 403 });
    const account = new Headers(options?.headers).get('authorization');
    return Response.json({ models: [entry(account?.includes('replacement') ? 'gpt-6-sol' : supported)] });
  });
  try {
    writeFileSync(authPath, JSON.stringify({ openai: credential() }));
    let catalogue = await service.catalogue();
    assert.deepEqual(catalogue.models.filter(m => m.providerId === 'openai').map(m => m.modelId), [supported]);
    assert.ok(!JSON.stringify(catalogue).includes('fixture-oauth-access'));
    await assert.rejects(profile.setDefault({ providerId: 'openai', modelId: denied }, profile.generation()), /model_not_available/);
    const runId = randomUUID();
    worker.start({ type: 'run.start', runId, taskId: randomUUID(), model: { providerId: 'openai', modelId: denied }, prompt: 'Fixture', systemPrompt: 'Fixture' });
    for (let n = 0; n < 200 && worker.poll(runId, 0).state !== 'failed'; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(worker.poll(runId, 0).state, 'failed');
    writeFileSync(authPath, JSON.stringify({ openai: credential('replacement-account') }));
    catalogue = await service.catalogue();
    assert.deepEqual(catalogue.models.filter(m => m.providerId === 'openai').map(m => m.modelId), ['gpt-6-sol']);
    const originalAuth = readFileSync(authPath, 'utf8');
    fail = true;
    catalogue = await service.request(randomUUID(), { type: 'refresh', providerId: 'openai' }) as typeof catalogue;
    assert.equal(catalogue.models.filter(m => m.providerId === 'openai').length, 0);
    assert.ok(catalogue.refreshErrors.includes('openai'));
    assert.equal(readFileSync(authPath,'utf8'), originalAuth);
    assert.ok(requests > 1);
    await (await profile.runtime()).logout('openai');
    catalogue = await service.catalogue();
    assert.equal(catalogue.models.filter(m => m.providerId === 'openai').length, 0);
  } finally { await worker.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});
