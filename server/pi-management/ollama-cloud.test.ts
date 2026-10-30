import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PiProfile } from './profile.js';
import { ollamaCloudConfiguration } from './ollama-cloud.js';
import { ProviderManagement } from './providers.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-cloud-'));
  return { directory, profile: new PiProfile(directory), close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('pinned cloud package registers in Settings without credentials, tools or local-daemon fallback', async () => {
  const f = fixture(), service = new ProviderManagement(f.profile);
  try {
    const config = await ollamaCloudConfiguration();
    assert.equal(config.name, 'Ollama'); assert.equal(config.baseUrl, 'https://ollama.com/v1');
    const catalogue = await service.catalogue();
    assert.equal(catalogue.providers.find(p => p.id === 'ollama-cloud')?.name, 'Ollama');
    assert.ok(catalogue.providers.find(p => p.id === 'ollama-cloud')?.methods.some(m => m.type === 'api_key'));
    assert.equal(catalogue.models.filter(m => m.providerId === 'ollama-cloud').length, 0);
    assert.equal(catalogue.providers.some(p => p.id === 'outpost-ollama'), false);
  } finally { service.close(); f.close(); }
});
test('cloud refresh persists exact tool-capable IDs and shares the same catalogue with the CLI', async t => {
  const f = fixture();
  try {
    const runtime = await f.profile.runtime();
    await runtime.login('ollama-cloud', 'api_key', { prompt: async () => 'synthetic-cloud-key', notify: () => {} });
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      assert.ok(url.startsWith('https://ollama.com/'), 'No local-daemon or third-party route');
      if (url.endsWith('/v1/chat/completions')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-cloud-key');
        assert.equal(JSON.parse(String(init?.body)).model, 'namespace/model:v1');
        const chunks = [
          { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Cloud fixture response' }, finish_reason: null }] },
          { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'namespace/model:v1' }, { id: 'no-tools' }, { id: 'clef' }] });
      assert.ok(url.endsWith('/api/show'));
      const id = JSON.parse(String(init?.body)).model;
      return Response.json({ capabilities: id === 'no-tools' ? ['completion'] : ['completion','tools','thinking'], model_info: { 'fixture.context_length': 65536 } });
    });
    const refreshed = await runtime.refresh({ providers: ['ollama-cloud'], allowNetwork: true, force: true });
    assert.equal(refreshed.errors.size, 0);
    for (let attempt = 0; attempt < 12; attempt++) {
      const restored = await f.profile.runtime();
      assert.deepEqual((await restored.getAvailable('ollama-cloud')).map(m => m.id), ['namespace/model:v1']);
    }
    const second = await f.profile.runtime();
    assert.deepEqual((await second.getAvailable('ollama-cloud')).map(m => m.id), ['namespace/model:v1']);
    assert.equal((await second.getAuth('ollama-cloud'))?.auth.apiKey, 'synthetic-cloud-key');
    const model = second.getModel('ollama-cloud', 'namespace/model:v1'); assert.ok(model);
    const message = await second.completeSimple(model, { messages: [{ role: 'user', content: 'Synthetic test only', timestamp: Date.now() }] });
    assert.equal(message.stopReason, 'stop'); assert.equal(message.provider, 'ollama-cloud');
    assert.equal(message.content[0]?.type === 'text' ? message.content[0].text : '', 'Cloud fixture response');
    const cli = spawnSync(process.execPath, [resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      '--no-extensions', '--extension', resolve('server/pi-management/ollama-cloud-extension.ts'), '--no-skills', '--no-prompt-templates', '--no-themes', '--offline', '--list-models', 'ollama-cloud'],
      { encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: f.directory, PI_CODING_AGENT_DIR: f.directory, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_OLLAMA_WEB_TOOLS: '0' } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /namespace\/model:v1/);
    assert.doesNotMatch(cli.stdout + cli.stderr, /synthetic-cloud-key/);
  } finally { f.close(); }
});
test('retiring the old proxy preserves credentials and unrelated settings, without assigning a new account', async () => {
  const f = fixture();
  try {
    const credentials = JSON.stringify({ 'outpost-ollama': { type: 'api_key', key: 'old-synthetic-key' }, openai: { type: 'api_key', key: 'other-synthetic-key' } });
    writeFileSync(join(f.directory,'auth.json'), credentials);
    writeFileSync(join(f.directory,'models.json'), JSON.stringify({ providers: { 'outpost-ollama': { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', models: [{ id: 'old:cloud' }] } } }));
    writeFileSync(join(f.directory,'settings.json'), JSON.stringify({ theme: 'dark', defaultProvider: 'outpost-ollama', defaultModel: 'old:cloud' }));
    await f.profile.retireLegacyOllama(f.profile.generation());
    await f.profile.retireLegacyOllama(f.profile.generation());
    assert.equal(readFileSync(join(f.directory,'auth.json'),'utf8'), credentials);
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'settings.json'),'utf8')), { theme: 'dark' });
    assert.equal((await f.profile.runtime()).getProvider('outpost-ollama'), undefined);
    assert.equal((await (await f.profile.runtime()).getAvailable('ollama-cloud')).length, 0);
    await assert.rejects(f.profile.configure({ providerId: 'ollama-cloud', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'test', name: 'test' }] }, f.profile.generation()));
  } finally { f.close(); }
});
