import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';
import { LoginState } from './contracts.js';

const config = { providerId: 'fixture', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'exact/model:id', name: 'Fixture', contextWindow: 8192, maxTokens: 1024 }] };
test('persistent metadata receipts prevent mutation replay across worker restart; login secrets are not journalled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-management-recovery-')), profile = new PiProfile(root), owner = randomUUID();
  let service = new ProviderManagement(profile);
  try {
    const request = { type: 'provider.configure', operationId: randomUUID(), expectedGeneration: profile.generation(), configuration: config };
    const result = await service.request(owner, request);
    const flowId = randomUUID(), start = { type: 'login.start', operationId: flowId, providerId: 'fixture', method: 'api_key' };
    await service.request(owner, start);
    for (let i = 0; i < 100; i++) {
      const state = LoginState.parse(await service.request(owner, { type: 'login.status', flowId }));
      if (state.prompt?.input.type === 'secret') { await service.request(owner, { type: 'login.answer', flowId, promptId: state.prompt.id, value: 'sensitive-fixture-value' }); break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    service.close(); service = new ProviderManagement(profile);
    assert.deepEqual(await service.request(owner, request), result);
    await assert.rejects(service.request(owner, { ...request, configuration: { ...config, baseUrl: 'https://other.test/v1' } }), /conflict/);
    await assert.rejects(service.request(owner, start), /outcome_unknown/);
    await assert.rejects(service.request(owner, { type: 'login.status', flowId }), /unavailable/);
    assert.equal((await (await profile.runtime()).listCredentials()).length, 0);
    assert.ok(!readFileSync(join(root, '.outpost-management.sqlite')).includes(Buffer.from('sensitive-fixture-value')));
    const installId = profile.installationId();
    assert.equal(new PiProfile(root).installationId(), installId, 'Login host identity survives restart');
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('configuration change fences a completed provider login before its credential commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-login-generation-')), profile = new PiProfile(root), owner = randomUUID();
  const service = new ProviderManagement(profile);
  try {
    await profile.configure(config, profile.generation());
    const flowId = randomUUID();
    await service.request(owner, { type: 'login.start', operationId: flowId, providerId: 'fixture', method: 'api_key' });
    let finalPrompt: string | undefined;
    for (let i = 0; i < 100; i++) {
      const state = LoginState.parse(await service.request(owner, { type: 'login.status', flowId }));
      if (state.prompt?.input.type === 'select') { finalPrompt = state.prompt.id; break; }
      if (state.prompt) await service.request(owner, { type: 'login.answer', flowId, promptId: state.prompt.id, value: 'generation-secret' });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(finalPrompt);
    writeFileSync(join(root, 'settings.json'), '{"theme":"light"}');
    await assert.rejects(service.request(owner, { type: 'login.answer', flowId, promptId: finalPrompt, value: 'save' }), /unavailable/);
    assert.equal((await (await profile.runtime()).listCredentials()).length, 0);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});
