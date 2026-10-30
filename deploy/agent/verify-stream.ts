import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { join } from 'node:path';
import { Ledger } from '../../server/core/ledger.js';
import { Devices } from '../../server/policy/trust.js';

const db = new Ledger(join(process.env.OUTPOST_DATA ?? '/home/node/.outpost','ledger.sqlite'));
assert.ok(db.list('device').some(device => !device.data.revoked));
const keys = generateKeyPairSync('ed25519'), deviceId = randomUUID(), taskId = randomUUID(), devices = new Devices(db);
devices.pair(deviceId,'Temporary streaming verifier',keys.publicKey.export({ format: 'der',type: 'spki' }).subarray(-32).toString('base64'));
const abort = new AbortController(), started = Date.now();
async function request(path: string, data: object, signal?: AbortSignal) {
  const bytes = Buffer.from(JSON.stringify({ deviceId,issuedAt: Date.now(),...data }));
  return fetch(`http://127.0.0.1:4318${path}`,{ method: 'POST',body: bytes,headers: { 'content-type': 'application/json','x-outpost-signature': sign(null,bytes,keys.privateKey).toString('base64') },...(signal ? { signal } : {}) });
}
async function command(type: string, revision: number, payload: object) {
  const result = await request('/v1/commands',{ protocolVersion: 1,commandId: randomUUID(),idempotencyKey: randomUUID(),aggregateId: taskId,expectedRevision: revision,type,payload });
  assert.ok(result.ok,await result.text());
}
try {
  const response = await request('/v1/stream',{ type: 'subscribe',payload: {} },AbortSignal.any([abort.signal,AbortSignal.timeout(180000)]));
  assert.equal(response.status,200);
  await command('task.create',0,{ profile: 'operations',mode: 'full_control',goal: 'Live streaming verification. Briefly state the next step, then use outpost_action command.run with argv ["/bin/bash","-lc","printf STREAM_READY; sleep 1; printf STREAM_DONE"] and cwd ".". Then report the observed result. Do not create or change files or perform any other operations.' });
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  let textUpdates = 0, thinkingUpdates = 0, toolUpdates = 0, firstLiveMs: number | null = null, done = false;
  const lengths = new Map<string,{ text: number; thinking: number }>();
  while (!done) {
    const chunk = await reader.read(); assert.equal(chunk.done,false,'Stream ended before the verification completed');
    buffer += decoder.decode(chunk.value,{ stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0,end).slice(6)); buffer = buffer.slice(end+2);
      if ((frame.type === 'live' || frame.type === 'settled') && frame.record.data.taskId === taskId) {
        const record = frame.record;
        if (frame.type === 'live' && record.kind === 'message') {
          const previous = lengths.get(record.id) ?? { text: 0,thinking: 0 }, current = { text: String(record.data.text ?? '').length,thinking: String(record.data.thinking ?? '').length };
          if (current.text > previous.text) textUpdates++;
          if (current.thinking > previous.thinking) thinkingUpdates++;
          lengths.set(record.id,current);
          if ((current.text || current.thinking) && firstLiveMs === null) firstLiveMs = Date.now()-started;
        }
        if (record.kind === 'tool_stream') toolUpdates++;
      }
      if (frame.type === 'records') for (const record of frame.records) if (record.kind === 'task' && record.id === taskId && ['verifying','interrupted','failed','cancelled'].includes(record.data.state)) {
        assert.equal(record.data.state,'verifying',record.data.blocker); done = true;
      }
    }
  }
  const action = db.list('action').find(action => action.data.taskId === taskId && action.data.tool === 'command.run');
  assert.ok(action && JSON.stringify(action.data.result).includes('STREAM_READYSTREAM_DONE'));
  console.log(JSON.stringify({ taskId,textUpdates,thinkingUpdates,toolUpdates,firstLiveMs,durationMs: Date.now()-started }));
  assert.ok(textUpdates > 0,'Expected answer text before finalization');
  assert.ok(thinkingUpdates > 0,'Expected model-exposed thinking from this thinking-capable model');
  assert.ok(toolUpdates > 0,'Expected live tool lifecycle events');
  console.log('Real Ollama → Pi → authenticated live text/thinking/tool events: PASSED');
} finally {
  abort.abort();
  const task = db.get('task',taskId);
  if (task?.data.state === 'running') await command('task.cancel',task.revision,{}).catch(() => {});
  const device = db.need('device',deviceId); devices.revoke(deviceId,device.revision); db.close();
}
