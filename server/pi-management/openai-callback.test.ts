import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { OAuthCredential } from '@earendil-works/pi-ai';

// The actual pinned Pi OpenAI adapter, but token exchange is intercepted: no account or network call.
test('Pi OpenAI ChatGPT accepts the complete remote callback including its dynamic client ID; mismatched state cannot exchange tokens', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-openai-callback-'));
  try {
    const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const provider = runtime.getProvider('openai'); assert.ok(provider?.auth.oauth);
    let exchanges = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      assert.equal(String(input), 'https://auth.openai.com/api/accounts/oauth/token', 'No other request may escape this fixture');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), 'fixture-issued-client');
      assert.equal(body.get('code'), 'fixture-code-not-for-transcripts');
      assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
      assert.ok(body.get('code_verifier'));
      exchanges++;
      return new Response(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id',
        expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    for (const correct of [false, true]) {
      let authorization: URL | undefined;
      const operation: Promise<OAuthCredential> = provider.auth.oauth.login({ signal: AbortSignal.timeout(5000),
        notify: event => { if (event.type === 'auth_url') authorization = new URL(event.url); },
        prompt: async input => {
          assert.equal(input.type, 'manual_code'); assert.ok(authorization);
          const callback = new URL(authorization.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', correct ? authorization.searchParams.get('state')! : 'different-flow');
          callback.searchParams.set('code', 'fixture-code-not-for-transcripts');
          callback.searchParams.set('client_id', 'fixture-issued-client');
          return callback.href;
        },
      }, { getDeviceId: () => randomUUID(), agentName: 'Outpost synthetic test' });
      if (!correct) { await assert.rejects(operation, /state mismatch/i); assert.equal(exchanges, 0); }
      else { const credential = await operation; assert.equal(credential.clientId, 'fixture-issued-client'); assert.equal(exchanges, 1); }
    }
    assert.equal((await runtime.listCredentials()).length, 0, 'Login still needs the separate authorized save operation');
    mocked.mock.restore();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
