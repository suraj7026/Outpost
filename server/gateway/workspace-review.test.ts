import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from './coordinator.js';
import { httpServer } from './http.js';

async function fixture(t: test.TestContext, configured: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'outpost-workspace-query-'));
  const db = new Ledger();
  const workspaceRoot = join(root, configured ? 'shared-workspaces' : 'workspaces');
  const coordinator = new Coordinator(db, root, configured ? { workspaceRoot, sharedWorkspaces: true } : {});
  t.after(async () => { coordinator.live.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  // A review must never instantiate the execution gate, even for a queued task.
  t.mock.method(coordinator, 'gate', () => { throw new Error('Review invoked execution gate'); });
  const first = id(), second = id(), missing = id();
  for (const taskId of [first, second, missing]) coordinator.tasks.create(taskId, { goal: 'Review fixture', profile: 'code', mode: 'ask_permission' });
  return { root, workspaceRoot, db, coordinator, first, second, missing };
}

for (const configured of [false, true]) test(`workspace queries use ${configured ? 'configured shared' : 'default'} task roots with no writes`, async t => {
  const f = await fixture(t, configured);
  const { root, workspaceRoot, db, coordinator, first, second, missing } = f;
  for (const taskId of [first, second]) {
    await mkdir(join(workspaceRoot, taskId), { recursive: true });
    await writeFile(join(workspaceRoot, taskId, 'same.txt'), taskId);
  }
  if (configured) {
    await mkdir(join(root, 'workspaces', first), { recursive: true });
    await writeFile(join(root, 'workspaces', first, 'wrong.txt'), 'wrong default root');
  }
  const cursor = db.cursor();
  const taskBefore = db.need('task', first);
  assert.equal((await coordinator.query('workspace.read', { taskId: first, path: 'same.txt' }) as { text: string }).text, first);
  assert.equal((await coordinator.query('workspace.read', { taskId: second, path: 'same.txt' }) as { text: string }).text, second);
  const listing = await coordinator.query('workspace.files', { taskId: first }) as { files: { path: string }[]; truncated: boolean };
  assert.deepEqual(listing.files.map(file => file.path), ['same.txt']);
  assert.equal(listing.truncated, false);
  await assert.rejects(async () => coordinator.query('workspace.read', { taskId: first, path: `../${second}/same.txt` }));
  await symlink(join(workspaceRoot, second), join(workspaceRoot, first, 'other'));
  await assert.rejects(async () => coordinator.query('workspace.read', { taskId: first, path: 'other/same.txt' }), { code: 'workspace_unsafe_directory' });
  assert.deepEqual(await coordinator.query('workspace.files', { taskId: missing }), { files: [], truncated: false });
  await assert.rejects(async () => coordinator.query('workspace.read', { taskId: missing, path: 'absent.txt' }), { code: 'workspace_unavailable' });
  await assert.rejects(stat(join(workspaceRoot, missing)), { code: 'ENOENT' });
  assert.deepEqual(db.need('task', first), taskBefore);
  assert.equal(db.cursor(), cursor);
  for (const kind of ['action', 'operation', 'artifact', 'tool_stream']) assert.equal(db.list(kind).length, 0);
});

test('workspace queries strictly validate payloads and require existing UUID tasks before filesystem access', async t => {
  const { root, workspaceRoot, db, coordinator } = await fixture(t, true);
  const unknown = id();
  await mkdir(join(workspaceRoot, unknown), { recursive: true });
  await writeFile(join(workspaceRoot, unknown, 'secret'), 'orphan directory');
  db.put('task', 'not-a-uuid', 0, {});
  for (const type of ['workspace.files', 'workspace.read']) {
    const payload = type === 'workspace.read' ? { path: 'secret' } : {};
    for (const taskId of ['not-a-uuid', '../outside', '', 123, null]) {
      await assert.rejects(async () => coordinator.query(type, { ...payload, taskId }), { name: 'ZodError' });
    }
    await assert.rejects(async () => coordinator.query(type, { ...payload, taskId: unknown }), { code: 'not_found' });
  }
  const taskId = db.list('task').find(task => task.id !== 'not-a-uuid')!.id;
  for (const payload of [{}, { taskId, path: 'secret' }, { taskId, root }, { taskId, limit: 10 }]) {
    await assert.rejects(async () => coordinator.query('workspace.files', payload), { name: 'ZodError' });
  }
  for (const payload of [{ taskId }, { taskId, path: 123 }, { taskId, path: 'secret', root }]) {
    await assert.rejects(async () => coordinator.query('workspace.read', payload), { name: 'ZodError' });
  }
});

test('workspace queries require signed enrolled devices and environment binding on the existing HTTP routes', async t => {
  const { coordinator, workspaceRoot, first } = await fixture(t, false);
  await mkdir(join(workspaceRoot, first), { recursive: true });
  await writeFile(join(workspaceRoot, first, 'review.txt'), 'approved review');
  const server = httpServer(coordinator, 'workspace-review-test-token-'.repeat(2));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const deviceId = id(), keys = generateKeyPairSync('ed25519');
  coordinator.devices.pair(deviceId, 'Approved desktop', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
  async function request(type: string, payload: object, options: { version?: number; signed?: boolean; deviceId?: string; environmentId?: string; issuedAt?: number; tamper?: boolean } = {}) {
    const version = options.version ?? 2;
    const envelope = { ...(version === 2 ? { protocolVersion: 2, environmentId: options.environmentId ?? coordinator.environment.environmentId } : {}),
      deviceId: options.deviceId ?? deviceId, issuedAt: options.issuedAt ?? Date.now(), type, payload };
    const bytes = Buffer.from(JSON.stringify(envelope));
    return fetch(`${base}/v${version}/query`, { method: 'POST', body: options.tamper ? JSON.stringify({ ...envelope, payload: {} }) : bytes,
      headers: options.signed === false ? {} : { 'x-outpost-signature': sign(null, bytes, keys.privateKey).toString('base64') } });
  }
  for (const type of ['workspace.files', 'workspace.read']) {
    const payload = { taskId: first, ...(type === 'workspace.read' ? { path: 'review.txt' } : {}) };
    for (const options of [{ signed: false }, { deviceId: id() }, { environmentId: id() }, { issuedAt: 0 }, { tamper: true }]) {
      assert.notEqual((await request(type, payload, options)).status, 200);
    }
    for (const version of [1, 2]) {
      const response = await request(type, payload, { version });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json();
      if (type === 'workspace.read') {
        assert.deepEqual(Object.keys(result).sort(), ['hash', 'modifiedAt', 'name', 'path', 'size', 'text']);
        assert.equal(result.text, 'approved review');
      } else {
        assert.deepEqual(Object.keys(result).sort(), ['files', 'truncated']);
        assert.deepEqual(Object.keys(result.files[0]).sort(), ['modifiedAt', 'name', 'path', 'size']);
      }
    }
  }
  const missing = await request('workspace.read', { taskId: first, path: 'missing' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'workspace_unavailable', message: 'workspace_unavailable' });
  coordinator.devices.revoke(deviceId, 1);
  for (const type of ['workspace.files', 'workspace.read']) {
    assert.notEqual((await request(type, { taskId: first, ...(type === 'workspace.read' ? { path: 'review.txt' } : {}) })).status, 200);
  }
});
