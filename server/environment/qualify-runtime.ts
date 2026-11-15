import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PiProfile } from '../pi-management/profile.js';
import { credentialStore } from '../pi-management/credential-store.js';

/** Staging smoke test: real Pi/provider loading and a synthetic model call, never a production account. */
export async function qualifyRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-qualification-'));
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async input => {
      if (String(input) !== 'https://outpost-qualification.invalid/v1/chat/completions') throw new Error('qualification_network_denied');
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"qualified"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const store = await credentialStore(directory);
    await store.modify('qualification', async () => ({ type: 'api_key', key: 'synthetic' }));
    const credential = await store.read('qualification');
    if (credential?.type !== 'api_key' || credential.key !== 'synthetic') throw new Error('qualification_credential_adapter_failed');
    await store.delete('qualification');
    const runtime = await new PiProfile(directory).runtime();
    if (!runtime.getProvider('ollama-cloud') || !runtime.getProvider('openai')) throw new Error('qualification_provider_missing');
    runtime.registerProvider('qualification', { baseUrl: 'https://outpost-qualification.invalid/v1', api: 'openai-completions', apiKey: 'synthetic', models: [
      { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 },
    ] });
    const model = runtime.getModel('qualification', 'fixture');
    if (!model || (await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Synthetic qualification', timestamp: Date.now() }] })).stopReason !== 'stop') throw new Error('qualification_failed');
  } finally { globalThis.fetch = fetch; rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await qualifyRuntime().catch(() => { console.error('Managed runtime qualification failed'); process.exitCode = 1; });
}
