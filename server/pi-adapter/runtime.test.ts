import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from '../gateway/coordinator.js';
import { InferenceConfiguration } from '../models/inference.js';
import { PiRuntime } from './runtime.js';

for (const rejectInference of [false,true]) test(`Pi direct inference ${rejectInference ? 'surfaces model errors' : 'activates and executes the custom action tool'}`,async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-pi-')), db = new Ledger(join(root,'ledger.sqlite'));
  const frames: unknown[] = [];
  const requests: Array<{ model: string; tools: { function: { name: string } }[] }> = [];
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
      assert.ok(requests[0]?.tools.some(tool => tool.function.name === 'outpost_action'));
      assert.equal(requests[0]?.model,'exact-name:cloud');
      assert.ok(db.list('message').some(record => record.data.thinking === 'Fixture reasoning exposed by the model.'));
      assert.ok(frames.some(frame => JSON.stringify(frame).includes('"type":"live"')));
      assert.ok(db.list('tool_stream').some(record => record.data.state === 'finished' && record.data.actionId));
      assert.equal(coordinator.live.snapshot().length,0);
    }
    assert.equal(runtime.isActive(task.id),false);
  } finally { unsubscribe(); coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});
