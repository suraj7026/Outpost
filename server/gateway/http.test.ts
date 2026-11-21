import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from './coordinator.js';
import { httpServer } from './http.js';
for (const mode of [undefined,'ask_permission','auto','full_control']) test(`signed clients converge with ${mode ?? 'default'} preserves control mode, routine reads and durable evidence`,async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-http-')), db = new Ledger(join(root,'db.sqlite')), coordinator = new Coordinator(db,root), token = 'fixture-token-'.repeat(4);
  const server = httpServer(coordinator,token); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const mac = { id: id(),keys: generateKeyPairSync('ed25519') }, phone = { id: id(),keys: generateKeyPairSync('ed25519') };
  const pub = (device: typeof mac) => device.keys.publicKey.export({ format: 'der',type: 'spki' }).subarray(-32).toString('base64');
  const request = async (path: string, value: object, device = mac) => { const bytes = Buffer.from(JSON.stringify(value)); return fetch(base+path,{ method: 'POST',headers: { 'x-outpost-signature': sign(null,bytes,device.keys.privateKey).toString('base64') },body: bytes }); };
  const query = (type: string, payload: object = {}, device = mac) => ({ deviceId: device.id,issuedAt: Date.now(),type,payload });
  const command = (type: string, aggregateId: string, expectedRevision: number, payload: object) => ({ protocolVersion: 1,commandId: id(),idempotencyKey: id(),deviceId: mac.id,issuedAt: Date.now(),type,aggregateId,expectedRevision,payload });
  try {
    assert.equal((await request('/v1/pair',{ deviceId: mac.id,name: 'Mac',publicKey: pub(mac),token })).status,200);
    assert.equal((await request('/v1/pair-device',query('pair',{ deviceId: phone.id,name: 'Phone',publicKey: pub(phone) }))).status,200);
    const taskId = id(), create = command('task.create',taskId,0,{ goal: 'Read fixture',profile: 'code',...(mode ? { mode } : {}) });
        assert.notEqual((await fetch(base+'/v1/commands',{ method: 'POST',body: JSON.stringify(create) })).status,200);
        assert.equal(db.list('task').length,0);
    assert.equal((await request('/v1/commands',create)).status,200); assert.equal((await request('/v1/commands',create)).status,200);
    assert.equal(db.need('policy',taskId).data.mode,mode === 'full_control' ? 'full_control' : 'auto');
    await coordinator.drain();
    const proposal = command('action.propose',taskId,1,{ tool: 'system.inspect',arguments: {} });
    assert.equal((await request('/v1/commands',proposal)).status,200); await coordinator.drain();
    const action = db.list('action')[0]!;
    assert.equal(db.need('operation',action.id).data.state,'handled');
    assert.equal(action.data.state,'authorized');
    assert.equal(db.list('inbox').length,0);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM outbox WHERE topic='notice'").get()?.n,0);
    assert.equal((await request('/v1/commands',command('approval.decide',action.id,1,{ nonce: action.data.nonce,actionDigest: action.data.actionDigest,decision: 'approve' }))).status,409);
    assert.equal((await request('/v1/commands',command('action.dispatch',action.id,action.revision,{}))).status,200); await coordinator.drain();
    assert.equal(db.need('action',action.id).data.state,'succeeded');
    assert.equal((await request('/v1/commands',command('policy.change',taskId,1,{ mode: 'ask_permission' }))).status,200);
    assert.equal(db.need('policy',taskId).data.mode,'auto');
    assert.notEqual((await request('/v1/commands',command('policy.change',taskId,1,{ mode: 'auto' }))).status,200);
    const bytes = Buffer.from('invoice,total\nfixture,4200\n'), hash = createHash('sha256').update(bytes).digest('hex');
    const begin = await request('/v1/commands',command('artifact.begin',taskId,0,{ name: 'fixture.csv',mime: 'text/csv',size: bytes.length,hash }));
    const upload = await begin.json() as { id: string };
    const chunk = command('artifact.chunk',upload.id,0,{ offset: 0,base64: bytes.toString('base64') });
    assert.equal((await request('/v1/commands',chunk)).status,200);
    assert.equal((await request('/v1/commands',chunk)).status,200);
    assert.equal((await request('/v1/commands',command('artifact.complete',upload.id,0,{}))).status,200);
    const downloaded = await request('/v1/artifact',query('artifact',{ artifactId: upload.id },phone),phone);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
    const one = await (await request('/v1/query',query('snapshot'))).json();
    const two = await (await request('/v1/query',query('snapshot',{},phone),phone)).json(); assert.deepEqual(one,two);
    assert.equal(db.list('task').length,1);
    coordinator.devices.revoke(phone.id,1); assert.notEqual((await request('/v1/query',query('snapshot',{},phone),phone)).status,200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('tools query works without a taskId, matches task catalogue, and has no side effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-tools-query-'));
  const db = new Ledger(join(root, 'db.sqlite'));
  const coordinator = new Coordinator(db, root, {
    hosts: { token: 't'.repeat(32), endpoints: { main: 'http://127.0.0.1:9999' } },
  });
  const server = httpServer(coordinator, 'unused');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const keys = generateKeyPairSync('ed25519'), deviceId = id();
  coordinator.devices.pair(deviceId, 'fixture', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
  const post = async (path: string, body: object) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return fetch(base + path, { method: 'POST', headers: { 'x-outpost-signature': sign(null, bytes, keys.privateKey).toString('base64') }, body: bytes });
  };
  try {
    assert.equal(db.list('task').length, 0);
    const baseCatalogue = coordinator.query('tools', {});
    assert.ok(Array.isArray(baseCatalogue));
    const names = baseCatalogue.map(tool => (tool as { name: string }).name);
    for (const required of ['file.read', 'file.write', 'command.run', 'system.inspect', 'automation.list', 'automation.save', 'automation.set_paused', 'host.execute', 'recovery.inspect']) {
      assert.ok(names.includes(required), `Missing tool ${required}`);
    }
    assert.equal(db.list('task').length, 0, 'Task-independent tools query must not create tasks');
    assert.equal(existsSync(join(root, 'workspaces')), false, 'Task-independent tools query must not create workspaces');

    const v1 = await post('/v1/query', { deviceId, issuedAt: Date.now(), type: 'tools', payload: {} });
    assert.equal(v1.status, 200);
    assert.deepEqual(await v1.json(), baseCatalogue);

    const v2 = await post('/v2/query', { protocolVersion: 2, environmentId: coordinator.environment.environmentId, deviceId, issuedAt: Date.now(), type: 'tools', payload: {} });
    assert.equal(v2.status, 200);
    assert.deepEqual(await v2.json(), baseCatalogue);

    assert.throws(() => coordinator.query('tools', { taskId: id() }));
    assert.throws(() => coordinator.query('tools', { unexpected: true }));

    const taskId = id();
    coordinator.tasks.create(taskId, { goal: 'Check catalogue parity', profile: 'code' });
    assert.deepEqual(coordinator.query('tools', { taskId }), baseCatalogue);
  } finally {
    await coordinator.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
