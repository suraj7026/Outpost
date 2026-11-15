import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';
import { WorkerRuns } from '../pi-worker/runs.js';

const key = 'synthetic-ollama-private-key', modelId = 'namespace/fixture:v1';
const balance = { included: { balance_usd: 10, allowance_usd: 20,
  period: { from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' } }, purchased: { balance_usd: 0 } };
const response = () => new Response([
  { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic response' }, finish_reason: null }] },
  { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('production profile lists Ollama after key validation; defaults and real worker share the policy and cooldown', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-ollama-access-'));
  const environmentKey = process.env.OLLAMA_API_KEY; delete process.env.OLLAMA_API_KEY;
  const profile = new PiProfile(directory), service = new ProviderManagement(profile);
  const worker = new WorkerRuns(profile, join(directory, 'workspaces'), join(directory, 'sessions'));
  let checks = 0, inference = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = String(input), authorization = new Headers(options?.headers).get('authorization');
    if (url === 'https://ollama.com/api/balance') {
      checks++; assert.equal(options?.redirect, 'error');
      return authorization === `Bearer ${key}` ? Response.json(balance) : Response.json({ error: 'synthetic rejected key' }, { status: 401 });
    }
    if (url === 'https://ollama.com/v1/models') return Response.json({ data: [{ id: modelId }, { id: 'no-tools' }, { id: 'clef' }] });
    if (url === 'https://ollama.com/api/show') {
      return Response.json({ capabilities: JSON.parse(String(options?.body)).model === 'no-tools' ? ['completion'] : ['completion', 'tools'], model_info: { 'fixture.context_length': 65536 } });
    }
    assert.equal(url, 'https://ollama.com/v1/chat/completions', 'No unintended network calls');
    assert.equal(authorization, `Bearer ${key}`); inference++; return response();
  });
  try {
    let catalogue = await service.catalogue();
    assert.equal(catalogue.providers.find(p => p.id === 'ollama-cloud')?.authentication?.state, 'missing');
    assert.equal(checks, 0);
    await profile.saveCredential('ollama-cloud', { type: 'api_key', key }, profile.generation(), AbortSignal.timeout(5000));
    for (let n = 0; n < 4; n++) {
      catalogue = await service.catalogue();
      assert.deepEqual(catalogue.models.filter(m => m.providerId === 'ollama-cloud').map(m => m.modelId), [modelId]);
      assert.equal(catalogue.providers.find(p => p.id === 'ollama-cloud')?.authentication?.state, 'validated');
      assert.ok(!JSON.stringify(catalogue).includes(key));
    }
    assert.equal(checks, 1); assert.equal(inference, 0, 'Listing never runs a prompt');
    await profile.setDefault({ providerId: 'ollama-cloud', modelId }, profile.generation());
    assert.equal(checks, 1, 'Fresh default-validation runtime reuses the profile check');
    const runId = randomUUID();
    worker.start({ type: 'run.start', runId, taskId: randomUUID(), model: { providerId: 'ollama-cloud', modelId }, prompt: 'Synthetic test', systemPrompt: 'Synthetic test' });
    for (let n = 0; n < 400 && !['finished', 'failed'].includes(worker.poll(runId, 0).state); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(worker.poll(runId, 0).state, 'finished'); assert.equal(checks, 1); assert.equal(inference, 1);
    const originalAuth = readFileSync(join(directory, 'auth.json'), 'utf8');
    await service.request(randomUUID(), { type: 'refresh', providerId: 'ollama-cloud' });
    assert.equal(checks, 1, 'Explicit refresh does not hammer the balance endpoint');
    assert.equal(readFileSync(join(directory, 'auth.json'), 'utf8'), originalAuth);

    await profile.saveCredential('ollama-cloud', { type: 'api_key', key: 'replacement-invalid-key' }, profile.generation(), AbortSignal.timeout(5000));
    catalogue = await service.catalogue();
    assert.equal(catalogue.models.filter(m => m.providerId === 'ollama-cloud').length, 0);
    assert.equal(catalogue.providers.find(p => p.id === 'ollama-cloud')?.authentication?.state, 'invalid_key');
    assert.ok(catalogue.refreshErrors.includes('ollama-cloud')); assert.equal(checks, 2);
    await assert.rejects(profile.setDefault({ providerId: 'ollama-cloud', modelId }, profile.generation()), /model_not_available/);
    assert.equal(checks, 2); assert.equal(inference, 1);
    await service.request(randomUUID(), { type: 'provider.logout', providerId: 'ollama-cloud', operationId: randomUUID() });
    catalogue = await service.catalogue();
    assert.equal(catalogue.providers.find(p => p.id === 'ollama-cloud')?.authentication?.state, 'missing');
    assert.equal(catalogue.models.length, 0);
  } finally {
    await worker.close(); service.close(); rmSync(directory, { recursive: true, force: true });
    if (environmentKey === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = environmentKey;
  }
});

test('effective environment credentials, not a different stored key, determine Ollama availability', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-ollama-env-'));
  const original = process.env.OLLAMA_API_KEY;
  const service = new ProviderManagement(new PiProfile(directory));
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith('/api/balance')) return new Headers(options?.headers).get('authorization') === `Bearer ${key}`
      ? Response.json(balance) : Response.json({}, { status: 401 });
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: modelId }] });
    assert.ok(url.endsWith('/api/show')); return Response.json({ capabilities: ['completion', 'tools'], model_info: { 'fixture.context_length': 65536 } });
  });
  try {
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ 'ollama-cloud': { type: 'api_key', key: 'invalid-stored-key' } }));
    process.env.OLLAMA_API_KEY = key;
    assert.equal((await service.catalogue()).models.length, 0, 'Pi prioritizes the stored key; an ambient key cannot authorize it');
    writeFileSync(join(directory, 'auth.json'), '{}');
    assert.equal((await service.catalogue()).models.filter(m => m.providerId === 'ollama-cloud').length, 1, 'Validated environment key works without a stored key');
    process.env.OLLAMA_API_KEY = 'replacement-invalid-key';
    assert.equal((await service.catalogue()).models.length, 0, 'Replacing the effective environment key invalidates availability');
  } finally {
    service.close(); rmSync(directory, { recursive: true, force: true });
    if (original === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = original;
  }
});

test('managed CLI lists Ollama after authentication, rejects bad keys and makes no offline check', () => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-ollama-cli-'));
  try {
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ 'ollama-cloud': { type: 'api_key', key } }));
    const mock = join(directory, 'fetch.mjs');
    writeFileSync(mock, `import { appendFileSync } from 'node:fs';
    const mock = async (input, options) => {
      if (process.env.FIXTURE_OFFLINE) { appendFileSync(${JSON.stringify(join(directory, 'offline-requests'))}, 'request\\n'); throw new Error('Offline must not access the network'); }
      const url = String(input);
      if (url === 'https://ollama.com/api/balance') {
        if (new Headers(options?.headers).get('authorization') !== ${JSON.stringify(`Bearer ${key}`)}) throw new Error('Wrong credential');
        return process.env.FIXTURE_INVALID ? Response.json({}, {status: 401}) : Response.json(${JSON.stringify(balance)});
      }
      if (url === 'https://ollama.com/v1/models') return Response.json({data:[{id:${JSON.stringify(modelId)}}]});
      if (url === 'https://ollama.com/api/show') return Response.json({capabilities:['completion','tools'], model_info:{'fixture.context_length':65536}});
      throw new Error('Unexpected request');
    }; Object.defineProperty(globalThis, 'fetch', {get:()=>mock, set:()=>{}});`);
    writeFileSync(join(directory, 'offline-requests'), '');
    for (const mode of ['online', 'offline', 'invalid']) {
      const cli = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href,
        resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), '--no-extensions', '--extension',
        resolve('server/pi-management/ollama-cloud-extension.ts'), '--no-skills', '--no-prompt-templates', '--no-themes',
        ...(mode === 'offline' ? ['--offline'] : []), '--list-models', 'ollama-cloud'], {
        encoding: 'utf8', timeout: 25000, env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory,
          OLLAMA_API_KEY: '', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', FIXTURE_OFFLINE: mode === 'offline' ? '1' : '', FIXTURE_INVALID: mode === 'invalid' ? '1' : '' },
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout.includes(modelId), mode === 'online', cli.stdout + cli.stderr);
      assert.ok(!(cli.stdout + cli.stderr).includes(key));
      assert.equal(readFileSync(join(directory, 'offline-requests'), 'utf8'), '', 'Offline mode never contacted any endpoint');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
