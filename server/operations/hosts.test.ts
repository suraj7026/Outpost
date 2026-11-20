import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Gate } from '../policy/trust.js';
import { registerHosts, hostAdministrationFromEnvironment } from './hosts.js';

test('host configuration supports a single native host and the legacy pair, and fails closed', () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-host-config-'));
  const token = 'a'.repeat(64), file = join(root,'host-token');
  writeFileSync(file,token + '\n',{ mode: 0o600 });
  try {
    assert.equal(hostAdministrationFromEnvironment({}),undefined);
    assert.deepEqual(hostAdministrationFromEnvironment({ OUTPOST_HOST_ENDPOINTS: '{"local":"http://127.0.0.1:4519/"}',OUTPOST_HOST_TOKEN_FILE: file }),
      { token,endpoints: { local: 'http://127.0.0.1:4519' } });
    assert.deepEqual(hostAdministrationFromEnvironment({ OUTPOST_HOST_TOKEN: token,OUTPOST_HOST_MAIN: 'http://host-main:4319',OUTPOST_HOST_WORKER: 'http://host-worker:4319' })?.endpoints,
      { surajhomeserver: 'http://host-main:4319',surajhomeserver2: 'http://host-worker:4319' });
    assert.throws(() => hostAdministrationFromEnvironment({ OUTPOST_HOST_ENDPOINTS: '{"local":"http://127.0.0.1:4519"}' }));
    for (const env of [
      { OUTPOST_HOST_MAIN: 'http://host-main:4319' },
      { OUTPOST_HOST_ENDPOINTS: '{}' },
      { OUTPOST_HOST_ENDPOINTS: 'null' },
      { OUTPOST_HOST_ENDPOINTS: '{"local":"file:///etc/passwd"}' },
      { OUTPOST_HOST_ENDPOINTS: '{"local":"http://user:pass@localhost:4519"}' },
    ]) assert.throws(() => hostAdministrationFromEnvironment({ OUTPOST_HOST_TOKEN: token,...env }));
  } finally { rmSync(root,{ recursive: true,force: true }); }
});

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
    const gate = new Gate(db,true); registerHosts(gate,configuration,taskId);
    const proposed = await gate.propose(taskId,'host.execute',{ host: 'surajhomeserver',command: 'id -u' });
    const result = await gate.dispatch(proposed.id); assert.equal(result.data.state,'succeeded'); assert.equal(calls,1);
    await assert.rejects(gate.propose(taskId,'host.execute',{ host: 'unrecognized-host',command: 'id -u' }));
    const native = new Gate(db,true);
    registerHosts(native,{ token: 'fixture-private-token',endpoints: { local: endpoint } },taskId);
    const local = await native.propose(taskId,'host.execute',{ host: 'local',command: 'id -u' });
    assert.equal((await native.dispatch(local.id)).data.state,'succeeded');
    assert.equal(calls,2);
    await assert.rejects(native.propose(taskId,'host.execute',{ host: 'surajhomeserver',command: 'id -u' }));
    db.put('policy',taskId,1,{ mode: 'ask_permission' });
    const legacy = await native.propose(taskId,'host.execute',{ host: 'local',command: 'id -u' });
    assert.equal(legacy.data.state,'pending');
    await assert.rejects(native.dispatch(legacy.id), /not_authorized/);
    assert.equal(calls,2,'Auto cannot prove arbitrary root shell effects');
    assert.equal(db.list('inbox').length,1);
    gate.register('protected.fixture',{ version: 1,effects: ['owner.identity'],parse: () => ({}),target: () => 'owner',execute: async () => null });
    await assert.rejects(gate.propose(taskId,'protected.fixture',{}),/protected_effect/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});
