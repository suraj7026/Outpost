import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from '../gateway/coordinator.js';
import { InferenceConfiguration } from '../models/inference.js';
import { PiRuntime } from './runtime.js';
import { AgentSession, VERSION } from '@earendil-works/pi-coding-agent';
import { SessionWorkJournal } from '../pi-management/session-background.js';

// This fixture uses the real package, child SDK, provider transport, and native tools.
// Environment changes are confined to this test-file process, never the application.

const privateHome = mkdtempSync(join(tmpdir(),'outpost-runtime-home-'));
const originalHome = process.env.HOME, originalAgentDir = process.env.PI_CODING_AGENT_DIR, originalTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.HOME = privateHome;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(privateHome,'subagents');
process.env.PI_CODING_AGENT_DIR = join(privateHome,'agent');
after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = originalTempRoot;
  rmSync(privateHome,{ recursive: true,force: true });
});

for (const rejectInference of [false,true]) test(`Pi direct inference ${rejectInference ? 'surfaces model errors' : 'activates and executes the custom action tool'}`,async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-pi-')), db = new Ledger(join(root,'ledger.sqlite'));
  const frames: unknown[] = [];
  const requests: Array<{ model: string; tools: { function: { name: string } }[]; messages: { role: string; content: string }[] }> = [];
  const server = createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/api/show') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ capabilities: ['completion','thinking'] })); return; }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (rejectInference) { res.writeHead(401,{ 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture inference denied' } })); return; }
    res.writeHead(200,{ 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'fixture',object: 'chat.completion.chunk',created: 1,model: 'exact-name:cloud',choices: [{ index: 0,delta: { role: 'assistant',reasoning_content: 'Fixture reasoning exposed by the model.' },finish_reason: null }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve,70));
    const toolCall = requests.length === 1;
    const delta = toolCall ? { role: 'assistant',tool_calls: [{ index: 0,id: 'call_fixture',type: 'function',function: { name: 'outpost_action',arguments: JSON.stringify({ tool: 'file.write',arguments: { path: 'proof.txt',text: 'CUSTOM_TOOL_EXECUTED',expectedHash: null } }) } }] } : { role: 'assistant',content: 'Observed the file.write result.' };
    for (const choice of [{ delta,finish_reason: null },{ delta: {},finish_reason: toolCall ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture',object: 'chat.completion.chunk',created: 1,model: 'exact-name:cloud',choices: [{ index: 0,...choice }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const inference = InferenceConfiguration.parse({ baseUrl: `http://127.0.0.1:${address.port}/v1`,model: 'exact-name:cloud',vision: false });
  const coordinator = new Coordinator(db,root,{ inference });
  const task = coordinator.tasks.create(id(),{ goal: 'Write the proof file',profile: 'code',mode: 'full_control',model: 'exact-name:cloud' });
  const gate = coordinator.gate(task.id), runtime = new PiRuntime(db,gate,join(root,'pi',task.id),coordinator.live);
  const unsubscribe = coordinator.live.subscribe(frame => frames.push(frame));
  try {
    const run = runtime.run(task.id,join(root,'workspaces',task.id),task.data.goal,'ollama',undefined,inference);
    if (rejectInference) await assert.rejects(run,/fixture inference denied|401/);
    else {
      await run;
      assert.equal(readFileSync(join(root,'workspaces',task.id,'proof.txt'),'utf8'),'CUSTOM_TOOL_EXECUTED');
      assert.equal(db.list('action')[0]?.data.state,'succeeded');
      assert.equal(db.need('task',task.id).data.state,'verifying');
      const activeTools = requests[0]!.tools.map(tool => tool.function.name);
      for (const name of ['outpost_action','subagent','ollama_web_search','ollama_web_fetch']) assert.ok(activeTools.includes(name), `${name} is active`);
      assert.ok(!activeTools.includes('bash') && !activeTools.includes('write'));
      assert.equal(db.need('pi_session', task.id).data.piVersion, VERSION);
      assert.equal(requests[0]?.model,'exact-name:cloud');
      assert.ok(db.list('message').some(record => record.data.thinking === 'Fixture reasoning exposed by the model.'));
      assert.ok(frames.some(frame => JSON.stringify(frame).includes('"type":"live"')));
      assert.ok(db.list('tool_stream').some(record => record.data.state === 'finished' && record.data.actionId));
      assert.equal(coordinator.live.snapshot().length,0);
    }
    const systemPrompt = requests[0]?.messages.find(message => message.role === 'system' || message.role === 'developer')?.content ?? '';
    assert.match(systemPrompt, /Installed release extensions are available natively/);
    assert.match(systemPrompt, /Existing coordinator-gated tools still use outpost_action/);
    assert.match(systemPrompt, /recovery\.inspect/);
    assert.match(systemPrompt, /missing recovery record preserves legacy dispatch/);
    assert.match(systemPrompt, /manual inspection commands/);
    assert.equal(systemPrompt.includes("host: 'surajhomeserver' or 'surajhomeserver2'"),false);
    assert.equal(runtime.isActive(task.id),false);
  } finally { unsubscribe(); coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('direct runtime disposes the SDK session and clears maps when receipt writing fails', async t => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-receipt-failure-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ capabilities: ['completion'] })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const inference = InferenceConfiguration.parse({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'receipt-model', vision: false });
  const coordinator = new Coordinator(db, root, { inference });
  const task = coordinator.tasks.create(id(), { goal: 'Receipt failure', profile: 'code', mode: 'full_control', model: inference.model });
  const runtime = new PiRuntime(db, coordinator.gate(task.id), join(root, 'pi'), coordinator.live);
  const disposed = t.mock.method(AgentSession.prototype, 'dispose');
  t.mock.method(SessionWorkJournal.prototype, 'own', () => { throw Object.assign(new Error('receipt disk full'), { code: 'ENOSPC' }); });
  try {
    await assert.rejects(runtime.run(task.id, join(root, 'workspaces', task.id), task.data.goal, 'fixture-key', undefined, inference), /receipt disk full/);
    assert.equal(disposed.mock.callCount(), 1);
    assert.equal(runtime.isActive(task.id), false); assert.equal(runtime.needsAttention, false);
    assert.equal(db.list('pi_session').length, 0);
    assert.equal(new SessionWorkJournal(join(root, 'pi')).needsAttention, false);
  } finally { coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('shutdown failure closes credential bootstrap resources and permits a clean same-session retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-shutdown-failure-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    if (request.url === '/api/show') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ capabilities: ['completion'] })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'shutdown', object: 'chat.completion.chunk', created: 1, model: 'shutdown-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Finished.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const inference = InferenceConfiguration.parse({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'shutdown-model', vision: false });
  const coordinator = new Coordinator(db, root, { inference });
  const task = coordinator.tasks.create(id(), { goal: 'Shutdown fixture', profile: 'code', mode: 'full_control', model: inference.model });
  const runtime = new PiRuntime(db, coordinator.gate(task.id), join(root, 'pi'), coordinator.live);
  const dispose = AgentSession.prototype.dispose;
  const fault = t.mock.method(AgentSession.prototype, 'dispose', function(this: AgentSession) { dispose.call(this); throw new Error('fixture shutdown failure'); });
  try {
    const run = () => runtime.run(task.id, join(root, 'workspaces', task.id), task.data.goal, 'private-shutdown-key', undefined, inference);
    await assert.rejects(run(), /fixture shutdown failure/);
    const first = db.need<{ sessionId: string }>('pi_session', task.id).data.sessionId;
    const source = readFileSync(join(root, 'pi', '.native-child-provider', first, 'provider.mjs'), 'utf8');
    const encoded = source.match(/createConnection\(("[^"]+")\)/)?.[1]; assert.ok(encoded);
    const socketPath = String(JSON.parse(encoded));
    assert.equal(existsSync(socketPath), false);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
    }), /ENOENT|ECONNREFUSED/);
    const registry = Reflect.get(globalThis, Symbol.for('pi-subagents.required-child-extensions.v1')) as { bySession: Map<string, unknown> };
    assert.equal(registry.bySession.has(first), false);
    assert.equal(runtime.needsAttention, true, 'Uncertain extension shutdown keeps its ownership receipt');
    fault.mock.restore();
    await run();
    assert.equal(db.need<{ sessionId: string }>('pi_session', task.id).data.sessionId, first);
    assert.equal(registry.bySession.has(first), false); assert.equal(runtime.isActive(task.id), false);
  } finally {
    fault.mock.restore(); coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});

for (const background of [false, true]) test(`native upstream subagent ${background ? 'inherits parent-only model and literal credentials in a detached native child' : 'inherits direct runtime model and credentials and executes outside coordinator approvals'}`, { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-native-child-')), db = new Ledger(join(root,'ledger.sqlite'));
  const proof = join(root,'outside-task-workspace.txt'), shellProof = join(root,'child-shell.txt');
  const apiKey = '!native-private-test-key';
  const agents = join(process.env.PI_CODING_AGENT_DIR!, 'agents');
  mkdirSync(agents,{ recursive: true });
  writeFileSync(join(agents,'native-fixture.md'),'---\nname: native-fixture\ndescription: Native integration fixture\ntools: write, read, bash\n---\nPerform the requested file operation.\n');
  const requests: { parent: boolean; authorization: string | undefined; model: string }[] = [];
  const results: unknown[] = [];
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request,response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === '/api/show') { response.setHeader('content-type','application/json'); response.end(JSON.stringify({ capabilities: ['completion'] })); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; tools: { function: { name: string } }[]; messages: { role: string; content: unknown }[] };
    const parent = body.tools.some(tool => tool.function.name === 'outpost_action');
    requests.push({ parent,authorization: request.headers.authorization,model: body.model });
    if (background && !parent) await held;
    const toolResults = body.messages.filter(message => message.role === 'tool');
    results.push(...toolResults);
    const call = parent ? (toolResults.length ? undefined : { name: 'subagent', arguments: {
      agent: 'native-fixture', task: 'Write the proof, read it back, and run a shell command. Native delegation is explicitly authorized.', ...(background ? {} : { async: false }),
      options: { context: 'fresh' } } }) : [
      { name: 'write', arguments: { path: proof, content: 'NATIVE_CHILD_WRITE' } },
      { name: 'read', arguments: { path: proof } },
      { name: 'bash', arguments: { command: `cat '${proof}' > '${shellProof}'` } },
    ][toolResults.length];
    const delta = call ? { role: 'assistant',tool_calls: [{ index: 0,id: `native_${requests.length}`,type: 'function',function: { name: call.name,arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant',content: 'Native child verified.' };
    response.writeHead(200,{ 'content-type': 'text/event-stream' });
    for (const choice of [{ delta,finish_reason: null },{ delta: {},finish_reason: call ? 'tool_calls' : 'stop' }]) response.write(`data: ${JSON.stringify({ id: 'native',object: 'chat.completion.chunk',created: 1,model: body.model,choices: [{ index: 0,...choice }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const inference = InferenceConfiguration.parse({ baseUrl: `http://127.0.0.1:${address.port}/v1`,model: 'native-fixture-model',vision: false });
  const assertUnprovisioned = () => {
    for (const name of ['models.json','auth.json']) {
      const path = join(process.env.PI_CODING_AGENT_DIR!, name);
      const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
      assert.ok(!content.includes(apiKey) && !content.includes(inference.model), 'No out-of-band native model or credential provisioning');
    }
  };
  assertUnprovisioned();
  const coordinator = new Coordinator(db,root,{ inference });
  const task = coordinator.tasks.create(id(),{ goal: 'Delegate native file verification',profile: 'code',mode: 'full_control',model: inference.model });
  const runtime = new PiRuntime(db,coordinator.gate(task.id),join(root,'pi',task.id),coordinator.live);
  try {
    const running = runtime.run(task.id,join(root,'workspaces',task.id),task.data.goal,apiKey,undefined,inference);
    void running.catch(() => {});
    if (background) {
      for (let i = 0; i < 500 && !requests.some(request => !request.parent); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(requests.some(request => !request.parent)); assert.equal(runtime.isActive(task.id), true);
      const liveChild = coordinator.live.snapshot().find(record => record.kind === 'subagent_run');
      assert.ok(liveChild); assert.equal(liveChild.data.state, 'running');
      assert.equal(liveChild.data.executionMode, 'background'); assert.equal(liveChild.data.endedAt, undefined);
      release();
    }
    await running;
    if (background) assert.ok(requests.filter(request => request.parent).length >= 3, 'Completion reaches the retained direct-runtime parent');
    assert.ok(requests.some(request => !request.parent), JSON.stringify(results));
    assert.equal(readFileSync(proof,'utf8'),'NATIVE_CHILD_WRITE');
    assert.equal(readFileSync(shellProof,'utf8'),'NATIVE_CHILD_WRITE');
    assert.ok(requests.every(request => request.authorization === `Bearer ${apiKey}` && request.model === inference.model));
    assert.equal(db.list('action').length,0, 'Native child actions are not routed through the coordinator');
    assert.ok(db.list('tool_stream').some(record => JSON.stringify(record.data).includes('subagent')));
    assert.ok(!JSON.stringify(db.snapshot(['message','tool_stream','pi_session'])).includes(apiKey));
    const children = db.list('subagent_run');
    assert.equal(children.length, 1, 'One public record per parent launch');
    const child = children[0]!.data;
    assert.equal(child.state, 'completed', JSON.stringify(child));
    assert.equal(child.executionMode, background ? 'background' : 'foreground');
    assert.equal(child.stopSupported, false); assert.equal(child.streaming, false);
    assert.equal(child.parentSessionId, db.need('pi_session', task.id).data.sessionId);
    assert.equal(child.model, `outpost-ollama/${inference.model}`);
    const activity = z.array(z.object({ kind: z.string(), tool: z.string().optional(), output: z.string().optional() })).parse(child.activity);
    for (const tool of ['read', 'write', 'bash']) assert.ok(activity.some(entry => entry.kind === 'tool' && entry.tool === tool), `${tool} is observed: ${JSON.stringify(child)}`);
    assert.ok(activity.some(entry => entry.output?.includes('NATIVE_CHILD_WRITE')));
    assert.doesNotMatch(JSON.stringify(children), /native-private-test-key|capabilityToken|controlInbox|transcriptPath/);
    assert.equal(runtime.isActive(task.id),false);
  } finally {
    release(); await runtime.abort(task.id); coordinator.live.close();
    await new Promise<void>(resolve => server.close(() => resolve())); db.close();
    rmSync(join(agents,'native-fixture.md'),{ force: true }); rmSync(root,{ recursive: true,force: true });
    assertUnprovisioned();
  }
});
