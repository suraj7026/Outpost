import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { SessionWorkJournal } from '../pi-management/session-background.js';

const privateHome = mkdtempSync(join(tmpdir(), 'outpost-worker-home-'));
const originalHome = process.env.HOME, originalAgentDir = process.env.PI_CODING_AGENT_DIR, originalTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.HOME = privateHome;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(privateHome, 'subagents');
process.env.PI_CODING_AGENT_DIR = join(privateHome, 'agent');
after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = originalTempRoot;
  rmSync(privateHome, { recursive: true, force: true });
});

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
    const body = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string() }).passthrough()),
          tools: z.array(z.object({ function: z.object({ name: z.string() }) })) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    const activeTools = body.tools.map(tool => tool.function.name);
    for (const name of ['outpost_action', 'subagent', 'ollama_web_search', 'ollama_web_fetch']) assert.ok(activeTools.includes(name), `${name} is active`);
    assert.ok(!activeTools.includes('bash') && !activeTools.includes('write'), 'Parent builtins remain unchanged');
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

for (const background of [false, true]) test(`worker observes ${background ? 'async' : 'foreground'} native child metadata without an action bridge`, { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-worker-child-'));
  const profile = new PiProfile(process.env.PI_CODING_AGENT_DIR!);
  const agents = join(profile.directory, 'agents'), proof = join(root, 'native-child.txt');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'worker-fixture.md'), '---\nname: worker-fixture\ndescription: Worker native fixture\ntools: write\n---\nWrite the requested file.\n');
  writeFileSync(join(profile.directory, 'auth.json'), JSON.stringify({ alpha: { type: 'api_key', key: 'worker-child-private-key' } }), { mode: 0o600 });
  const received: { parent: boolean; model: string; authorization: string | undefined }[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = z.object({ model: z.string(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
      messages: z.array(z.object({ role: z.string() }).passthrough()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    const parent = body.tools.some(tool => tool.function.name === 'outpost_action');
    received.push({ parent, model: body.model, authorization: request.headers.authorization });
    const call = body.messages.some(message => message.role === 'tool') ? undefined : parent
      ? { name: 'subagent', arguments: { agent: 'worker-fixture', task: 'Write the native proof file. Delegation is authorized.', async: background, options: { context: 'fresh' } } }
      : { name: 'write', arguments: { path: proof, content: 'WORKER_NATIVE_CHILD' } };
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `worker_native_${received.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: 'Native worker child finished.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) response.write(`data: ${JSON.stringify({ id: 'worker_native', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const endpoint = await listen(upstream);
  const runs = new WorkerRuns(profile, join(root, 'workspaces'), join(root, 'sessions'));
  try {
    await profile.configure({ providerId: 'alpha', baseUrl: `${endpoint}/v1`, api: 'openai-completions', allowInsecureHttp: true,
      models: [{ id: 'worker-native-model', name: 'Native fixture', contextWindow: 16384, maxTokens: 1024 }] }, profile.generation());
    const runId = randomUUID();
    runs.start({ type: 'run.start', runId, taskId: randomUUID(), model: { providerId: 'alpha', modelId: 'worker-native-model' },
      prompt: 'Delegate the native write to worker-fixture.', systemPrompt: 'Fixture: use outpost_action for coordinator actions.' });
    let state: RunPoll | undefined, cursor = 0;
    const projections = new Map<string, RunPoll['projections'][number]>();
    for (let i = 0; i < 1500; i++) {
      state = RunPoll.parse(runs.poll(runId, cursor)); cursor = state.cursor;
      for (const projection of state.projections) projections.set(`${projection.kind}:${projection.id}`, projection);
      assert.equal(state.actions.length, 0, 'Native extension execution must not enter Outpost approvals');
      if (['finished', 'failed', 'cancelled'].includes(state.state)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(state?.state, 'finished', JSON.stringify(state));
    assert.ok(received.some(request => !request.parent), JSON.stringify(state));
    assert.equal(readFileSync(proof, 'utf8'), 'WORKER_NATIVE_CHILD');
    assert.ok(received.every(request => request.model === 'worker-native-model' && request.authorization === 'Bearer worker-child-private-key'));
    const children = [...projections.values()].filter(projection => projection.kind === 'subagent_run');
    assert.equal(children.length, 1);
    const child = children[0]!;
    assert.equal(child.final, true); assert.equal(child.data.state, 'completed', JSON.stringify(child));
    assert.equal(child.data.parentSessionId, state?.session?.id); assert.equal(child.data.stopSupported, false);
    assert.equal(child.data.executionMode, background ? 'background' : 'foreground');
    assert.ok(z.array(z.object({ tool: z.string().optional() })).parse(child.data.activity).some(entry => entry.tool === 'write'), JSON.stringify(child));
    assert.doesNotMatch(JSON.stringify(children), /worker-child-private-key|capabilityToken|controlInbox|transcriptPath/);
    assert.equal(runs.active, false);
  } finally { await runs.close(); await close(upstream); rmSync(root, { recursive: true, force: true }); }
});

test('worker receipt failure disposes its session and does not leave a permanent active run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-worker-receipt-'));
  const profile = new PiProfile(join(root, 'agent'));
  writeFileSync(join(profile.directory, 'auth.json'), JSON.stringify({ alpha: { type: 'api_key', key: 'receipt-fixture-key' } }), { mode: 0o600 });
  await profile.configure({ providerId: 'alpha', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', allowInsecureHttp: true,
    models: [{ id: 'receipt-model', name: 'Receipt fixture', contextWindow: 16384, maxTokens: 1024 }] }, profile.generation());
  const runs = new WorkerRuns(profile, join(root, 'workspaces'), join(root, 'sessions'));
  const disposed = t.mock.method(AgentSession.prototype, 'dispose');
  t.mock.method(SessionWorkJournal.prototype, 'own', () => { throw Object.assign(new Error('receipt disk full'), { code: 'ENOSPC' }); });
  try {
    const runId = randomUUID();
    runs.start({ type: 'run.start', runId, taskId: randomUUID(), model: { providerId: 'alpha', modelId: 'receipt-model' }, prompt: 'Fixture', systemPrompt: 'Fixture' });
    for (let i = 0; i < 500 && runs.active; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runs.poll(runId, 0).state, 'failed');
    assert.equal(disposed.mock.callCount(), 1); assert.equal(runs.active, false); assert.equal(runs.needsAttention, false);
    assert.equal(new SessionWorkJournal(join(root, 'sessions')).needsAttention, false);
  } finally { await runs.close(); rmSync(root, { recursive: true, force: true }); }
});

test('worker close is bounded and never reports idle while owned startup is unresolved', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-close-'));
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  class SlowProfile extends PiProfile {
    override async runtime(metadataOnly = false) { await held; return super.runtime(metadataOnly); }
  }
  const runs = new WorkerRuns(new SlowProfile(join(root, 'agent')), join(root, 'workspaces'), join(root, 'sessions'));
  try {
    runs.start({ type: 'run.start', runId: randomUUID(), taskId: randomUUID(), model: { providerId: 'missing', modelId: 'missing' }, prompt: 'Fixture', systemPrompt: 'Fixture' });
    const started = Date.now();
    await assert.rejects(runs.close(30), /worker_native_work_needs_attention/);
    assert.ok(Date.now() - started < 500); assert.equal(runs.active, true);
    release();
    for (let i = 0; i < 100 && runs.active; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runs.active, false);
  } finally { release(); await runs.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const cancel of [false, true]) test(`native detached children ${cancel ? 'cancel only owned work' : 'retain callbacks and block maintenance through completion'}`, { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-detached-'));
  const profile = new PiProfile(process.env.PI_CODING_AGENT_DIR!);
  const agents = join(profile.directory, 'agents'); mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'background-fixture.md'), '---\nname: background-fixture\ndescription: Background lifecycle fixture\ntools: write\n---\nWrite the requested proof.\n');
  writeFileSync(join(profile.directory, 'auth.json'), JSON.stringify({ alpha: { type: 'api_key', key: 'background-private-key' } }), { mode: 0o600 });
  const received: { parent: boolean; other: boolean }[] = [];
  let release = () => {}, releaseOther = () => {};
  const held = new Promise<void>(resolve => { release = resolve; }), heldOther = new Promise<void>(resolve => { releaseOther = resolve; });
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = z.object({ model: z.string(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
      messages: z.array(z.object({ role: z.string() }).passthrough()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    const parent = body.tools.some(tool => tool.function.name === 'outpost_action');
    const other = JSON.stringify(body.messages).includes('background-other');
    received.push({ parent, other });
    if (!parent) await (other ? heldOther : held);
    const call = body.messages.some(message => message.role === 'tool') ? undefined : parent
      ? { name: 'subagent', arguments: { agent: 'background-fixture', task: other ? 'background-other write proof' : 'background-primary write proof', async: true, options: { context: 'fresh' } } }
      : { name: 'write', arguments: { path: join(root, other ? 'other.txt' : 'primary.txt'), content: 'DETACHED_NATIVE_WRITE' } };
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: 'Background completion observed.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) response.write(`data: ${JSON.stringify({ id: 'background', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const endpoint = await listen(upstream), workspaces = join(root, 'workspaces'), sessions = join(root, 'sessions');
  const runs = new WorkerRuns(profile, workspaces, sessions), runId = randomUUID(), otherId = randomUUID();
  const cursors = new Map<string, number>();
  const poll = (id: string) => { const state = runs.poll(id, cursors.get(id) ?? 0); cursors.set(id, state.cursor); return state; };
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!condition() && Date.now() < deadline) { poll(runId); if (cancel) poll(otherId); await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.ok(condition(), JSON.stringify({ received, primary: poll(runId), other: cancel ? poll(otherId) : null }));
  };
  try {
    await profile.configure({ providerId: 'alpha', baseUrl: `${endpoint}/v1`, api: 'openai-completions', allowInsecureHttp: true,
      models: [{ id: 'background-model', name: 'Background fixture', contextWindow: 16384, maxTokens: 1024 }] }, profile.generation());
    for (const id of cancel ? [runId, otherId] : [runId]) runs.start({ type: 'run.start', runId: id, taskId: randomUUID(), model: { providerId: 'alpha', modelId: 'background-model' },
      prompt: id === otherId ? 'Delegate background-other.' : 'Delegate background-primary.', systemPrompt: 'Native delegation is authorized.' });
    await wait(() => received.filter(request => !request.parent).length >= (cancel ? 2 : 1) && received.filter(request => request.parent).length >= (cancel ? 4 : 2));
    assert.equal(runs.active, true);
    assert.equal(poll(runId).state, 'running', 'Foreground reply must not discard native completion delivery');
    const { snapshotBackgroundWork } = await import('pi-subagents/background-work');
    assert.equal(snapshotBackgroundWork([poll(runId).session!.id]).items.length, 0, 'The external-provider registry does not contain this native job');
    if (cancel) {
      await runs.abort(runId);
      assert.equal(poll(runId).state, 'cancelled');
      assert.equal(poll(otherId).state, 'running');
      assert.equal(runs.active, true, 'Unrelated native work remains owned');
      assert.equal(existsSync(join(root, 'primary.txt')), false);
      releaseOther();
      await wait(() => !runs.active);
      assert.equal(readFileSync(join(root, 'other.txt'), 'utf8'), 'DETACHED_NATIVE_WRITE');
      assert.equal(existsSync(join(root, 'primary.txt')), false);
    } else {
      const restarted = new WorkerRuns(profile, workspaces, sessions);
      assert.equal(restarted.active, true); assert.equal(restarted.needsAttention, true);
      await assert.rejects(restarted.close(100), /worker_native_work_needs_attention/);
      release();
      await wait(() => !runs.active);
      assert.equal(poll(runId).state, 'finished');
      assert.equal(readFileSync(join(root, 'primary.txt'), 'utf8'), 'DETACHED_NATIVE_WRITE');
      assert.ok(received.filter(request => request.parent).length >= 3, 'Native completion wakes the retained parent and reaches inference');
      const cleanRestart = new WorkerRuns(profile, workspaces, sessions);
      assert.equal(cleanRestart.active, false); await cleanRestart.close();
    }
  } finally {
    release(); releaseOther(); await runs.close(); await close(upstream); rmSync(root, { recursive: true, force: true });
  }
});
