import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { httpServer } from '../gateway/http.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { id } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from '../gateway/coordinator.js';
import { InferenceConfiguration } from '../models/inference.js';
import { PiRuntime } from './runtime.js';
import { RemotePiRuntime } from './remote-runtime.js';
import { VerifiedFixtureProfile } from '../testing/verified-profile.js';
import { WorkerRuns } from '../pi-worker/runs.js';
import { WorkerClient } from '../pi-worker/client.js';
import { workerServer } from '../pi-worker/http.js';
import { ProviderManagement } from '../pi-management/providers.js';
import type { Action } from '../policy/trust.js';

const home = mkdtempSync(join(tmpdir(), 'outpost-auto-runtime-home-'));
const environment = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENTS_TEMP_ROOT: process.env.PI_SUBAGENTS_TEMP_ROOT };
process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, 'agent'); process.env.PI_SUBAGENTS_TEMP_ROOT = join(home, 'subagents');
after(() => {
  for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(home, { recursive: true, force: true });
});
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); }
  assert.fail('Timed out waiting for runtime state');
}

for (const remote of [false, true]) for (const cancel of [false, true]) test(`${remote ? 'remote HTTP worker' : 'direct SDK'}: Full session to Auto suppresses native tools, ${cancel ? 'cancels pending work' : 'waits for one approval and continues automatically'}`, { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(home, 'run-')), db = new Ledger();
  let phase: 'full' | 'auto' = 'full', autoRequests = 0, effects = 0;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const bytes of request) chunks.push(Buffer.from(bytes));
    if (request.url === '/api/show') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ capabilities: ['completion'] })); return; }
    const body = z.object({ model: z.string(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })), messages: z.array(z.object({ role: z.string() }).passthrough()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    const tools = body.tools.map(tool => tool.function.name);
    if (phase === 'full') assert.ok(tools.includes('subagent'), 'Full Control retains native extensions');
    else {
      autoRequests++;
      assert.deepEqual(tools, ['outpost_action'], 'Persisted active tools cannot reactivate native extensions in Auto');
      assert.doesNotMatch(JSON.stringify(body.messages.filter(message => ['system', 'developer'].includes(message.role))), /Installed release extensions are available natively/);
      if (autoRequests > 1) { assert.equal(effects, 1); assert.match(JSON.stringify(body.messages), /succeeded/); }
    }
    const call = phase === 'auto' && autoRequests === 1;
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'sensitive_action', type: 'function', function: { name: 'outpost_action', arguments: JSON.stringify({ tool: 'fixture.sensitive', arguments: {} }) } }] } : { role: 'assistant', content: 'Observed completion.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) response.write(`data: ${JSON.stringify({ id: 'auto-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const baseUrl = await listen(upstream);
  const inference = InferenceConfiguration.parse({ baseUrl: `${baseUrl}/v1`, model: 'auto-model', vision: false });
  let runs: WorkerRuns | undefined, management: ProviderManagement | undefined, server: Server | undefined, client: WorkerClient | undefined;
  if (remote) {
    const profile = new VerifiedFixtureProfile(join(root, 'agent'));
    writeFileSync(join(profile.directory, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'private-fixture-key' } }));
    await profile.configure({ providerId: 'fixture', baseUrl: `${baseUrl}/v1`, api: 'openai-completions', allowInsecureHttp: true,
      models: [{ id: 'auto-model', name: 'Fixture', contextWindow: 32768, maxTokens: 1024 }] }, profile.generation());
    runs = new WorkerRuns(profile, join(root, 'workspaces'), join(root, 'worker-sessions'));
    management = new ProviderManagement(profile);
    const token = 'private-auto-worker-fixture-token'.repeat(2);
    server = workerServer(management, runs, token);
    client = new WorkerClient(await listen(server), token);
  }
  const coordinator = new Coordinator(db, root, client ? { worker: client } : { inference });
  const task = coordinator.tasks.create(id(), { goal: 'Establish persisted Full Control session', profile: 'code' });
  const owner = id(), keys = generateKeyPairSync('ed25519');
    coordinator.devices.pair(owner, 'Owner', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
    const coordinatorServer = httpServer(coordinator, 'unused-pairing-token'.repeat(2));
    const coordinatorUrl = await listen(coordinatorServer);
  const gate = coordinator.gate(task.id);
  gate.register('fixture.sensitive', { version: 1, effects: ['security.access'], parse: () => ({}), target: () => 'fixture access', execute: async () => { effects++; return { changed: true }; } });
  const runtime = client ? new RemotePiRuntime(db, gate, client, coordinator.live) : new PiRuntime(db, gate, join(root, 'direct-session'), coordinator.live);
  const run = () => runtime instanceof RemotePiRuntime ? runtime.run(task.id, 'Perform the requested action.', { providerId: 'fixture', modelId: 'auto-model' }) : runtime.run(task.id, join(root, 'workspaces', task.id), 'Perform the requested action.', 'private-fixture-key', undefined, inference);
  try {
    await run();
    const sessionId = db.need('pi_session', task.id).data.sessionId;
    gate.changePolicy(task.id, 1, 'auto'); phase = 'auto';
    const completion = run().then(() => null, error => error as Error);
    assert.throws(() => gate.changePolicy(task.id, 2, 'full_control'), /mode_change_requires_stopped/);
    await until(() => db.list<Action>('action').some(action => action.data.state === 'pending'));
    const action = db.list<Action>('action')[0]!;
    await delay(100);
    assert.equal(autoRequests, 1, 'The model must not run past pending review'); assert.equal(effects, 0);
    assert.equal(db.need('task', task.id).data.state, 'waiting_for_approval');
    if (cancel) {
      coordinator.tasks.control(task.id, db.need('task', task.id).revision, 'pause');
      await runtime.abort(task.id); await completion;
      assert.equal(db.need('action', action.id).data.state, 'denied');
      await coordinator.drain(); assert.equal(effects, 0); assert.equal(autoRequests, 1);
    } else {
      const bytes = Buffer.from(JSON.stringify({ protocolVersion: 1, commandId: id(), idempotencyKey: id(), deviceId: owner, issuedAt: Date.now(), type: 'approval.decide', aggregateId: action.id, expectedRevision: action.revision,
        payload: { nonce: action.data.nonce, actionDigest: action.data.actionDigest, decision: 'approve' } }));
      const response = await fetch(`${coordinatorUrl}/v1/commands`, { method: 'POST', headers: { 'x-outpost-signature': sign(null, bytes, keys.privateKey).toString('base64') }, body: bytes });
      assert.equal(response.status, 200);
      const accepted = z.object({ id: z.string(), revision: z.number() }).parse(await response.json());
      assert.equal(accepted.id, action.id); assert.equal(accepted.revision, action.revision + 1);
      await coordinator.drain(); assert.equal(await completion, null);
      assert.equal(autoRequests, 2); assert.equal(effects, 1);
      assert.equal(db.need('action', action.id).data.state, 'succeeded');
      assert.ok(db.list('tool_stream').some(record => record.data.actionId === action.id && record.data.state === 'finished'));
    }
    assert.equal(runtime.isActive(task.id), false);
    assert.equal(db.need('pi_session', task.id).data.sessionId, sessionId, 'Mode changes retain conversation continuity, not native privileges');
  } finally {
    await runtime.abort(task.id); await coordinator.close(); management?.close(); await runs?.close();
    if (server) await close(server); await close(coordinatorServer); await close(upstream);
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
