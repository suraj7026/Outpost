import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';
import { CompatibleProvider } from './contracts.js';

test('production blocks unsupported providers and rejects Ollama keys without authenticated validation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-strict-access-'));
  const profile = new PiProfile(directory), service = new ProviderManagement(profile);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    requests++; assert.equal(String(url), 'https://ollama.com/api/balance', 'Only the approved read-only key check is permitted');
    return Response.json({ error: 'synthetic invalid key' }, { status: 401 });
  });
  try {
    writeFileSync(join(directory,'auth.json'), JSON.stringify({
      openai: { type: 'api_key', key: 'sk-fixture' },
      anthropic: { type: 'oauth', access: 'fixture-subscription', refresh: 'fixture-refresh', expires: Date.now()+3600000 },
      'ollama-cloud': { type: 'api_key', key: 'fixture-cloud-key' },
      compatible: { type: 'api_key', key: 'fixture-compatible-key' },
    }));
    await profile.configure(CompatibleProvider.parse({ providerId: 'compatible', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'namespace/model:v1', name: 'Fixture', contextWindow: 16384, maxTokens: 1024 }] }), profile.generation());
    const runtime = await profile.runtime();
    assert.equal((await runtime.getAvailable()).length, 0);
    assert.equal((await runtime.getAllAvailable()).length, 0);
    for (const [provider, id] of [['openai','gpt-5.4-nano'],['compatible','namespace/model:v1']]) {
      const model = runtime.getModel(provider!, id!); assert.ok(model);
      const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Synthetic only', timestamp: Date.now() }] });
      assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage ?? '', /model_access_unverified/);
      await assert.rejects(profile.setDefault({ providerId: provider!, modelId: id! }, profile.generation()), /model_not_available/);
    }
    const catalogue = await service.catalogue();
    assert.equal(catalogue.models.length, 0);
    for (const id of ['openai','anthropic','ollama-cloud','compatible']) assert.equal(catalogue.providers.find(p => p.id === id)?.configured, true);
    assert.equal(requests, 1, 'Read-only authentication check, never inference or a public-catalogue permission guess');
    assert.equal(catalogue.providers.find(p => p.id === 'ollama-cloud')?.authentication?.state, 'invalid_key');
  } finally { service.close(); rmSync(directory,{recursive:true,force:true}); }
});
