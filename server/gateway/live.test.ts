import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from './coordinator.js';
import { httpServer } from './http.js';

test('signed SSE streams partial output, reconnects from snapshots, and closes on device revocation',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-live-')), db = new Ledger(join(root,'ledger.sqlite')), coordinator = new Coordinator(db,root);
  const keys = generateKeyPairSync('ed25519'), deviceId = id(), messageId = id(), taskId = id();
  coordinator.devices.pair(deviceId,'fixture',keys.publicKey.export({ format: 'der',type: 'spki' }).subarray(-32).toString('base64'));
  const server = httpServer(coordinator,'unused'); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, abort = new AbortController();
  const connect = async (valid = true) => {
    const bytes = Buffer.from(JSON.stringify({ deviceId,issuedAt: Date.now(),type: 'subscribe',payload: {} }));
    return fetch(`${base}/v1/stream`,{ method: 'POST',body: bytes,signal: AbortSignal.any([abort.signal,AbortSignal.timeout(5000)]),headers: { 'x-outpost-signature': valid ? sign(null,bytes,keys.privateKey).toString('base64') : 'invalid' } });
  };
  try {
    assert.notEqual((await connect(false)).status,200);
    const response = await connect(); assert.equal(response.status,200); assert.match(response.headers.get('content-type') ?? '',/text\/event-stream/);
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    const next = async (): Promise<Record<string,unknown>> => {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done,false); buffer += decoder.decode(chunk.value,{ stream: true }); }
      const end = buffer.indexOf('\n\n'), frame = buffer.slice(0,end); buffer = buffer.slice(end+2); return JSON.parse(frame.slice(6));
    };
    assert.equal((await next()).type,'snapshot');
    coordinator.live.publish('message',messageId,{ taskId,author: 'assistant',text: 'partial',thinking: 'visible fixture reasoning' });
    const live = await next(); assert.equal(live.type,'live'); assert.match(JSON.stringify(live),/partial/);
    const second = await connect(); const secondReader = second.body!.getReader(), replay = await secondReader.read();
    assert.match(new TextDecoder().decode(replay.value),/partial/); await secondReader.cancel();
    coordinator.live.finish('message',messageId,{ taskId,author: 'assistant',text: 'partial completed',thinking: 'visible fixture reasoning' });
    assert.equal(coordinator.live.snapshot().length,0);
    assert.equal(db.need('message',messageId).data.streaming,false);
    assert.equal(db.list('message').length,1,'Final output replaces, not duplicates, its partial message');
    assert.equal(db.list('task').length,0,'Subscriptions cannot launch tasks');
    coordinator.devices.revoke(deviceId,1);
    let ended = false; for (let attempt = 0; attempt < 20; attempt++) if ((await reader.read()).done) { ended = true; break; }
    assert.ok(ended,'Revocation closes an already open stream');
  } finally { abort.abort(); coordinator.live.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('restart preserves checkpoints but marks live records interrupted',() => {
  const db = new Ledger(), coordinator = new Coordinator(db,mkdtempSync(join(tmpdir(),'outpost-live-restart-'))), messageId = id();
  try {
    coordinator.live.publish('message',messageId,{ taskId: id(),text: 'checkpoint',thinking: 'visible' });
    new Coordinator(db,coordinator.root);
    const record = db.need('message',messageId);
    assert.equal(record.data.streaming,false); assert.equal(record.data.interrupted,true); assert.equal(record.data.text,'checkpoint');
  } finally { db.close(); rmSync(coordinator.root,{ recursive: true,force: true }); }
});
