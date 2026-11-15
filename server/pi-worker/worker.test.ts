import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from '../gateway/coordinator.js';
import { RemotePiRuntime } from '../pi-adapter/remote-runtime.js';
import { VerifiedFixtureProfile as PiProfile } from '../testing/verified-profile.js';
import { ProviderManagement } from '../pi-management/providers.js';
import { CompatibleProvider, LoginState } from '../pi-management/contracts.js';
import { WorkerRuns } from './runs.js';
import { workerServer } from './http.js';
import { WorkerClient } from './client.js';
import { RunPoll } from './contracts.js';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('authenticated worker: add providers, log in, select each model and execute real Pi actions through the coordinator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-worker-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const received: { path: string; model: string; authorization: string | undefined }[] = [];
  let holdBeta: Promise<void> | undefined;
  let injectInvalid = true, correctedValidation = false;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const bytes of request) chunks.push(Buffer.from(bytes));
    const body = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string() }).passthrough()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    received.push({ path: request.url ?? '', model: body.model, authorization: request.headers.authorization });
    if (request.url?.startsWith('/beta/') && holdBeta) await holdBeta;
    const toolMessages = body.messages.filter(message => message.role === 'tool');
    const tool = toolMessages.length < (injectInvalid ? 2 : 1) && request.url?.startsWith('/alpha/');
    if (injectInvalid) {
      assert.match(JSON.stringify(body.messages.filter(m => m.role === 'system' || m.role === 'developer')), /inputSchema/);
      if (toolMessages.length === 1) {
        assert.match(JSON.stringify(toolMessages), /invalid_tool_arguments/);
        assert.match(JSON.stringify(toolMessages), /command.run needs argv/);
        correctedValidation = true;
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: injectInvalid && toolMessages.length === 0 ? 'invalid_command' : 'write_proof', type: 'function', function: {
      name: 'outpost_action', arguments: JSON.stringify(injectInvalid && toolMessages.length === 0 ? { tool: 'command.run', arguments: { command: 'ls -la' } } : { tool: 'file.write', arguments: { path: 'proof.txt', text: 'ACTUAL_REMOTE_PI_TOOL', expectedHash: null } }) } }] }
      : { role: 'assistant', content: `Observed response from ${request.url?.startsWith('/beta/') ? 'beta' : 'alpha'}.` };
    response.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const upstreamURL = await listen(upstream);
  const profile = new PiProfile(join(root, 'agent'));
  const management = new ProviderManagement(profile), runs = new WorkerRuns(profile, join(root, 'workspaces'), join(root, 'pi'));
  const token = 'worker-fixture-token-not-a-real-secret';
  const server = workerServer(management, runs, token), endpoint = await listen(server), client = new WorkerClient(endpoint, token);
  const coordinator = new Coordinator(db, root, { worker: client }), owner = randomUUID();
  try {
    const denied = await fetch(`${endpoint}/v1`, { method: 'POST', body: JSON.stringify({ type: 'management', owner, request: { type: 'catalogue' } }) });
    assert.equal(denied.status, 401);
    for (const providerId of ['alpha','beta']) {
      const catalogue = z.object({ generation: z.string() }).parse(await client.request({ type: 'management', owner, request: { type: 'catalogue' } }));
      await client.request({ type: 'management', owner, request: { type: 'provider.configure', operationId: randomUUID(), expectedGeneration: catalogue.generation,
        configuration: CompatibleProvider.parse({ providerId, baseUrl: `${upstreamURL}/${providerId}/v1`, api: 'openai-completions',
          models: [{ id: 'same/model:identifier', name: providerId, contextWindow: 16384, maxTokens: 1024 }] }) } });
      const flowId = randomUUID();
      await client.request({ type: 'management', owner, request: { type: 'login.start', operationId: flowId, providerId, method: 'api_key' } });
      let success = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = LoginState.parse(await client.request({ type: 'management', owner, request: { type: 'login.status', flowId } }));
        if (state.prompt) await client.request({ type: 'management', owner, request: { type: 'login.answer', flowId, promptId: state.prompt.id, value: state.prompt.input.type === 'select' ? 'save' : `fixture-${providerId}-key` } });
        if (state.state === 'succeeded') { success = true; break; }
        assert.notEqual(state.state, 'failed');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(success);
    }
    const task = coordinator.tasks.create(randomUUID(), { goal: 'Write proof', profile: 'code', mode: 'full_control' });
    const adapter = new RemotePiRuntime(db, coordinator.gate(task.id), client, coordinator.live);
    await adapter.run(task.id, task.data.goal, { providerId: 'alpha', modelId: 'same/model:identifier' });
    injectInvalid = false;
    assert.ok(correctedValidation, 'The real SDK receives safe actionable feedback and can correct invalid arguments');
    assert.ok(db.list('tool_stream').some(record => record.data.state === 'error' && String(record.data.output).includes('invalid_tool_arguments')), 'The public execution record preserves the SDK error explanation');
    assert.equal(readFileSync(join(root, 'workspaces', task.id, 'proof.txt'), 'utf8'), 'ACTUAL_REMOTE_PI_TOOL');
    assert.equal(db.list('action')[0]?.data.state, 'succeeded');
    assert.equal(db.list('action').length, 1, 'Polling does not replay the proposed action');
    await adapter.run(task.id, 'Reply using the other provider', { providerId: 'beta', modelId: 'same/model:identifier' });
    assert.ok(received.some(value => value.path === '/alpha/v1/chat/completions' && value.authorization === 'Bearer fixture-alpha-key'));
    assert.ok(received.some(value => value.path === '/beta/v1/chat/completions' && value.authorization === 'Bearer fixture-beta-key'));
    assert.ok(received.every(value => value.model === 'same/model:identifier'));
    assert.ok(db.list('message').some(message => message.data.provider === 'alpha'));
    assert.ok(db.list('message').some(message => message.data.provider === 'beta'));
    const snapshot = JSON.stringify(db.snapshot(['task','message','action','tool_stream','pi_session']));
    assert.ok(!snapshot.includes('fixture-alpha-key') && !snapshot.includes('fixture-beta-key'));
    assert.equal(adapter.isActive(task.id), false);
    let releaseBeta: () => void = () => {};
    holdBeta = new Promise(resolve => { releaseBeta = resolve; });
    const queuedTaskId = randomUUID(), before = received.length;
    const command = (type: string, revision: number, payload: object) => coordinator.command({ protocolVersion: 1,
      commandId: randomUUID(), idempotencyKey: randomUUID(), deviceId: owner, issuedAt: Date.now(),
      type, aggregateId: queuedTaskId, expectedRevision: revision, payload });
    command('task.create', 0, { goal: 'Queue model changes', profile: 'code', mode: 'full_control', modelRef: { providerId: 'beta', modelId: 'same/model:identifier' } });
    await coordinator.drain();
    for (let i = 0; i < 100 && received.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(received.length, before + 1);
    command('task.steer', db.need('task', queuedTaskId).revision, { text: 'Next turn alpha', modelRef: { providerId: 'alpha', modelId: 'same/model:identifier' } });
    command('task.steer', db.need('task', queuedTaskId).revision, { text: 'Then beta', modelRef: { providerId: 'beta', modelId: 'same/model:identifier' } });
    await coordinator.drain();
    assert.equal(received.length, before + 1, 'Changed-model follow-ups do not enter the active Pi run');
    releaseBeta(); holdBeta = undefined;
    for (let i = 0; i < 200; i++) {
      await coordinator.drain();
      if (received.length >= before + 4 && db.need('task', queuedTaskId).data.state === 'verifying') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(received.slice(before).map(value => value.path.split('/')[1]), ['beta','alpha','alpha','beta']);
    assert.equal(readFileSync(join(root, 'workspaces', queuedTaskId, 'proof.txt'), 'utf8'), 'ACTUAL_REMOTE_PI_TOOL');
    const runId = randomUUID(), badTask = randomUUID();
    await client.request({ type: 'run.start', runId, taskId: badTask, model: { providerId: 'missing', modelId: 'anything' }, prompt: 'No fallback', systemPrompt: 'Fixture' });
    let failed = false;
    for (let i = 0; i < 50; i++) {
      const state = RunPoll.parse(await client.request({ type: 'run.poll', runId, after: 0 }));
      if (state.state === 'failed') { failed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(failed, 'Unavailable selection fails without inference fallback');
    await assert.rejects(client.request({ type: 'run.start', runId, taskId: badTask, model: { providerId: 'alpha', modelId: 'other' }, prompt: 'Changed request', systemPrompt: 'Fixture' }));
  } finally {
    management.close(); await runs.close(); coordinator.live.close();
    await close(server); await close(upstream); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
