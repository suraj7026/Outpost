import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Gate } from '../policy/trust.js';
import { registerHosts } from './hosts.js';

test('root execution requires host opt-in and binds authenticated requests to the task',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-hosts-')), db = new Ledger(join(root,'ledger.sqlite')), taskId = id();
  db.put('policy',taskId,0,{ mode: 'full_control' });
  let calls = 0;
  const server = createServer(async (req,res) => {
    calls++; assert.equal(req.headers.authorization,'Bearer fixture-private-token');
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(input.taskId,taskId); assert.equal(input.command,'id -u');
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ exitCode: 0,stdout: '0\n' }));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`, configuration = { token: 'fixture-private-token',endpoints: { surajhomeserver: endpoint,surajhomeserver2: endpoint } };
  try {
    const restricted = new Gate(db); registerHosts(restricted,configuration,taskId);
    await assert.rejects(restricted.propose(taskId,'host.execute',{ host: 'surajhomeserver',command: 'id -u' }),/protected_effect/);
    assert.equal(calls,0);
    const gate = new Gate(db,undefined,true); registerHosts(gate,configuration,taskId);
    const proposed = await gate.propose(taskId,'host.execute',{ host: 'surajhomeserver',command: 'id -u' });
    const result = await gate.dispatch(proposed.id); assert.equal(result.data.state,'succeeded'); assert.equal(calls,1);
    await assert.rejects(gate.propose(taskId,'host.execute',{ host: 'unrecognized-host',command: 'id -u' }));
    gate.register('protected.fixture',{ version: 1,effects: ['owner.identity'],parse: () => ({}),target: () => 'owner',execute: async () => null });
    await assert.rejects(gate.propose(taskId,'protected.fixture',{}),/protected_effect/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});
