import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';
import { LoginState } from './contracts.js';
import { WorkerRuns } from '../pi-worker/runs.js';
import { workerServer } from '../pi-worker/http.js';
import { WorkerClient } from '../pi-worker/client.js';
import { Coordinator } from '../gateway/coordinator.js';
import { httpServer } from '../gateway/http.js';
import { Ledger } from '../core/ledger.js';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
test('signed provider operations bypass task history/outbox and reject revoked devices', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-provider-http-'));
  const profile = new PiProfile(join(root, 'agent')), management = new ProviderManagement(profile);
  const runs = new WorkerRuns(profile, join(root, 'workspaces'), join(root, 'sessions'));
  const worker = workerServer(management, runs, 'fixture-worker-token-'.repeat(3));
  const workerURL = await listen(worker), db = new Ledger(join(root, 'ledger.sqlite'));
  const coordinator = new Coordinator(db, root, { worker: new WorkerClient(workerURL, 'fixture-worker-token-'.repeat(3)) });
  const server = httpServer(coordinator, 'unused'), url = await listen(server);
  const deviceId = randomUUID(), keys = generateKeyPairSync('ed25519');
  coordinator.devices.pair(deviceId, 'Fixture Mac', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
  const send = (payload: object, signed = true) => {
    const body = Buffer.from(JSON.stringify({ deviceId, issuedAt: Date.now(), type: 'agent', payload }));
    return fetch(`${url}/v1/agent`, { method: 'POST', body,
      headers: signed ? { 'x-outpost-signature': sign(null, body, keys.privateKey).toString('base64') } : {} });
  };
  try {
    await profile.configure({ providerId: 'fixture', baseUrl: 'https://example.test/v1', api: 'openai-completions',
      models: [{ id: 'model', name: 'Fixture', contextWindow: 8192, maxTokens: 1024 }] }, profile.generation());
    assert.notEqual((await send({ type: 'catalogue' }, false)).status, 200);
    assert.equal((await send({ type: 'catalogue' })).status, 200);
    const flowId = randomUUID();
    assert.equal((await send({ type: 'login.start', operationId: flowId, providerId: 'fixture', method: 'api_key' })).status, 200);
    let completed = false;
    for (let i = 0; i < 100; i++) {
      const response = await send({ type: 'login.status', flowId });
      assert.equal(response.status, 200);
      const state = LoginState.parse(await response.json());
      if (state.prompt) {
        const answer = await send({ type: 'login.answer', flowId, promptId: state.prompt.id, value: state.prompt.input.type === 'select' ? 'save' : 'fixture-http-secret' });
        assert.equal(answer.status, 200); assert.ok(!(await answer.text()).includes('fixture-http-secret'));
      }
      if (state.state === 'succeeded') { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(completed);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM commands').get()?.count, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()?.count, 0);
    assert.ok(!JSON.stringify(db.events(0)).includes('fixture-http-secret'));
    assert.deepEqual(db.list('message'), []);
    const secondFlow = randomUUID();
    await send({ type: 'login.start', operationId: secondFlow, providerId: 'fixture', method: 'api_key' });
    let savePrompt: string | undefined;
    for (let i = 0; i < 100; i++) {
      const state = LoginState.parse(await (await send({ type: 'login.status', flowId: secondFlow })).json());
      if (state.prompt?.input.type === 'select') { savePrompt = state.prompt.id; break; }
      if (state.prompt) await send({ type: 'login.answer', flowId: secondFlow, promptId: state.prompt.id, value: 'must-not-replace-existing-key' });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(savePrompt, 'Provider finished login but has not saved without a new signed authorization');
    coordinator.devices.revoke(deviceId, 1);
    assert.notEqual((await send({ type: 'login.answer', flowId: secondFlow, promptId: savePrompt, value: 'save' })).status, 200);
    const auth = await (await profile.runtime()).getAuth('fixture');
    assert.equal(auth?.auth.apiKey, 'fixture-http-secret', 'Revoked owner cannot commit background authentication');
    assert.notEqual((await send({ type: 'login.status', flowId })).status, 200);
    assert.notEqual((await send({ type: 'catalogue' })).status, 200);
  } finally {
    management.close(); await runs.close(); coordinator.live.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => worker.close(() => resolve()));
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
