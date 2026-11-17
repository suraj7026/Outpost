import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { EnvironmentDescriptor } from '../environment/contracts.js';
import { RecoveryReport } from '../diagnostics/recovery.js';
import { Coordinator } from './coordinator.js';
import { httpServer } from './http.js';

const device = () => ({ id: id(), keys: generateKeyPairSync('ed25519') });
const publicKey = (owner: ReturnType<typeof device>) => owner.keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const token = 'isolated-environment-fixture-'.repeat(2);

async function fixture(allowLegacyProtocol = true) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-bound-http-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  const coordinator = new Coordinator(db, root, { environment: { label: 'Fixture', runtimeRelease: 'test-release', allowLegacyProtocol } });
  const server = httpServer(coordinator, token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    db, coordinator, base: `http://127.0.0.1:${address.port}`,
    async close() {
      coordinator.live.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function query(environment: Fixture, owner: ReturnType<typeof device>, type = 'snapshot', payload: object = {}) {
  return { protocolVersion: 2, environmentId: environment.coordinator.environment.environmentId, deviceId: owner.id, issuedAt: Date.now(), type, payload };
}
function command(environment: Fixture, owner: ReturnType<typeof device>, taskId: string) {
  return { ...query(environment, owner, 'task.create', { goal: 'Environment-owned work', profile: 'code' }), commandId: id(), idempotencyKey: id(), aggregateId: taskId, expectedRevision: 0 };
}
function request(environment: Fixture, path: string, value: object, owner: ReturnType<typeof device>, signedValue: object = value) {
  return fetch(environment.base + path, {
    method: 'POST', body: JSON.stringify(value),
    headers: { 'content-type': 'application/json', 'x-outpost-signature': sign(null, Buffer.from(JSON.stringify(signedValue)), owner.keys.privateKey).toString('base64') },
  });
}
async function pair(environment: Fixture, owner: ReturnType<typeof device>) {
  const response = await request(environment, '/v2/pair', {
    protocolVersion: 2, environmentId: environment.coordinator.environment.environmentId,
    deviceId: owner.id, name: 'Test desktop', publicKey: publicKey(owner), token,
  }, owner);
  assert.equal(response.status, 200);
}
async function expectError(response: Response, code: string, status = 409) {
  assert.equal(response.status, status);
  const body = await response.json() as { error: string };
  assert.equal(body.error, code);
}

test('two verified installations store one shared memory ID and deletion wins over delayed copies', async () => {
  const one = await fixture(), two = await fixture();
  const owner = device(), note = id(), content = 'Shared preferences for code review';
  const apply = (target: Fixture, key: string, text: string | null) =>
    request(target, '/v2/commands', { ...command(target, owner, key), type: 'memory.shared', payload: { text } }, owner);
  try {
    await pair(one, owner); await pair(two, owner);
    const first = await apply(one, note, content);
    assert.equal(first.status, 200);
    const record = await first.json();
    assert.equal(record.id, note);
    assert.equal(record.data.shared, true);
    assert.equal((await apply(two, note, record.data.text)).status, 200);
    assert.equal((await apply(two, note, record.data.text)).status, 200);
    assert.equal(two.coordinator.memory.search('preferences', 'shared', 'owner').length, 1);
    await expectError(await apply(two, note, 'A conflicting note'), 'shared_memory_conflict');

    const privateNote = one.coordinator.memory.save({ text: 'Private note', project: 'personal', identityId: 'owner', source: 'owner', provenance: 'owner' });
    await expectError(await apply(one, privateNote.id, null), 'memory_scope_conflict');
    assert.equal(one.coordinator.memory.search('Private', 'personal', 'owner').length, 1);

    assert.equal((await apply(one, note, null)).status, 200);
    assert.equal((await apply(two, note, null)).status, 200);
    const delayed = await apply(two, note, content);
    assert.equal(delayed.status, 200);
    assert.equal((await delayed.json()).data.forgotten, true);
    assert.equal(two.coordinator.memory.search('preferences', 'shared', 'owner').length, 0);

    const unseen = id();
    assert.equal((await apply(two, unseen, null)).status, 200);
    const olderCopy = await apply(two, unseen, 'Old offline copy');
    assert.equal((await olderCopy.json()).data.forgotten, true);
  } finally { await one.close(); await two.close(); }
});

test('discovery and authenticated descriptor expose identity and honest capabilities without enrollment secrets', async () => {
  const environment = await fixture();
  const owner = device();
  try {
    const response = await fetch(environment.base + '/v2/environment');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    const descriptor = EnvironmentDescriptor.parse(JSON.parse(text));
    const anonymous = await fetch(environment.base + '/v2/query', {
      method: 'POST', body: JSON.stringify(query(environment, owner, 'environment')),
    });
    assert.notEqual(anonymous.status, 200);
    assert.equal(descriptor.environmentId, environment.coordinator.environment.environmentId);
    assert.deepEqual(descriptor.supportedProtocolVersions, [1, 2]);
    assert.equal(descriptor.services.worker.readiness, 'not_configured');
    assert.equal(descriptor.capabilities.taskHandoff, false);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes('publicKey'), false);
    await pair(environment, owner);
    const authenticated = await request(environment, '/v2/query', query(environment, owner, 'environment'), owner);
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), descriptor);
    assert.equal(environment.db.list('device').length, 1);
  } finally { await environment.close(); }
});

test('two installations with the same enrolled device reject cross-environment commands and reads', async () => {
  const one = await fixture(), two = await fixture();
  const owner = device();
  try {
    await pair(one, owner); await pair(two, owner);
    const taskId = id();
    const create = command(one, owner, taskId);
    const first = await request(one, '/v2/commands', create, owner);
    assert.equal(first.status, 200);
    const original = await first.json();
    const retry = await request(one, '/v2/commands', { ...create, issuedAt: Date.now() }, owner);
    assert.deepEqual(await retry.json(), original);
    const cursor = two.db.cursor();
    await expectError(await request(two, '/v2/commands', create, owner), 'environment_mismatch');
    assert.equal(two.db.cursor(), cursor);
    assert.equal(two.db.list('task').length, 0);
    assert.throws(() => two.coordinator.command(create), { code: 'environment_mismatch' });
    assert.equal((await request(two, '/v2/commands', command(two, owner, taskId), owner)).status, 200);
    assert.equal(one.db.list('task').length, 1);
    assert.equal(two.db.list('task').length, 1);
    for (const path of ['/v2/query', '/v2/agent', '/v2/artifact', '/v2/stream', '/v2/pair-device']) {
      await expectError(await request(two, path, query(one, owner), owner), 'environment_mismatch');
    }
    const snapshot = await request(two, '/v2/query', query(two, owner), owner);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('x-outpost-environment-id'), two.coordinator.environment.environmentId);
    assert.equal(snapshot.headers.get('x-outpost-protocol-version'), '2');
  } finally { await one.close(); await two.close(); }
});

test('environment and protocol binding are signed and cannot be downgraded through legacy routes', async () => {
  const one = await fixture(), two = await fixture();
  const owner = device();
  try {
    await pair(one, owner); await pair(two, owner);
    const signed = query(one, owner);
    await expectError(await request(two, '/v2/query', { ...signed, environmentId: two.coordinator.environment.environmentId }, owner, signed), 'invalid_signature');
    const { environmentId: omitted, ...unbound } = signed;
    assert.ok(omitted);
    await expectError(await request(one, '/v2/query', unbound, owner), 'invalid_request', 400);
    await expectError(await request(one, '/v2/query', { ...signed, protocolVersion: 99 }, owner), 'unsupported_protocol', 426);
    await expectError(await request(one, '/v1/commands', command(one, owner, id()), owner), 'unsupported_protocol', 426);
    await expectError(await request(one, '/v1/query', signed, owner), 'unsupported_protocol', 426);
    await expectError(await request(one, '/v3/query', signed, owner), 'unsupported_protocol', 426);
    await expectError(await request(one, '/v2/query', { ...signed, issuedAt: 0 }, owner), 'expired_request');
    one.coordinator.devices.revoke(owner.id, 1);
    await expectError(await request(one, '/v2/query', query(one, owner), owner), 'revoked_device');
  } finally { await one.close(); await two.close(); }
});

test('misrouted bootstrap cannot consume pairing and existing enrollment stays closed', async () => {
  const environment = await fixture();
  const owner = device();
  try {
    await expectError(await request(environment, '/v2/pair', {
      protocolVersion: 2, environmentId: id(), deviceId: owner.id, name: 'Test', publicKey: publicKey(owner), token,
    }, owner), 'environment_mismatch');
    assert.equal(environment.db.list('device').length, 0);
    await pair(environment, owner);
    await expectError(await request(environment, '/v2/pair', {
      protocolVersion: 2, environmentId: environment.coordinator.environment.environmentId,
      deviceId: id(), name: 'Untrusted', publicKey: publicKey(owner), token,
    }, owner), 'pairing_closed');
    const other = device();
    const enrollment = await request(environment, '/v2/pair-device', query(environment, owner, 'pair', {
      deviceId: other.id, name: 'Second desktop', publicKey: publicKey(other),
    }), owner);
    assert.equal(enrollment.status, 200);
    assert.equal((await request(environment, '/v2/query', query(environment, other), other)).status, 200);
  } finally { await environment.close(); }
});

test('legacy access is preserved by default and can be disabled explicitly without disabling v2', async () => {
  const legacy = await fixture(), strict = await fixture(false);
  const owner = device();
  try {
    const bootstrap = { deviceId: owner.id, name: 'Existing client', publicKey: publicKey(owner), token };
    assert.equal((await request(legacy, '/v1/pair', bootstrap, owner)).status, 200);
    const envelope = { deviceId: owner.id, issuedAt: Date.now(), type: 'snapshot', payload: {} };
    assert.equal((await request(legacy, '/v1/query', envelope, owner)).status, 200);
    const descriptor = EnvironmentDescriptor.parse(await (await fetch(strict.base + '/v2/environment')).json());
    assert.deepEqual(descriptor.supportedProtocolVersions, [2]);
    await expectError(await request(strict, '/v1/pair', bootstrap, owner), 'legacy_protocol_disabled', 426);
    await pair(strict, owner);
    await expectError(await request(strict, '/v1/query', envelope, owner), 'legacy_protocol_disabled', 426);
    assert.equal((await request(strict, '/v2/query', query(strict, owner), owner)).status, 200);
    const v1 = { ...command(legacy, owner, id()), protocolVersion: 1 };
    const { environmentId: omitted, ...legacyCommand } = v1;
    assert.ok(omitted);
    const accepted = await request(legacy, '/v1/commands', legacyCommand, owner);
    assert.equal(accepted.status, 200);
    const boundRetry = await request(legacy, '/v2/commands', {
      ...legacyCommand, protocolVersion: 2, environmentId: legacy.coordinator.environment.environmentId,
    }, owner);
    assert.equal(boundRetry.status, 200);
    assert.deepEqual(await boundRetry.json(), await accepted.json());
    assert.equal(legacy.db.list('task').length, 1);
    assert.throws(() => strict.coordinator.command(legacyCommand), { code: 'legacy_protocol_disabled' });
  } finally { await legacy.close(); await strict.close(); }
});

test('bound artifact uploads/downloads and streams work without changing the v1 record format', async () => {
  const environment = await fixture();
  const owner = device();
  try {
    await pair(environment, owner);
    const taskId = id();
    assert.equal((await request(environment, '/v2/commands', command(environment, owner, taskId), owner)).status, 200);
    const content = Buffer.from('owned content');
    const send = (type: string, aggregateId: string, payload: object) => request(environment, '/v2/commands', {
      ...command(environment, owner, aggregateId), type, payload,
    }, owner);
    const started = await send('artifact.begin', taskId, {
      name: 'fixture.txt', mime: 'text/plain', size: content.length, hash: createHash('sha256').update(content).digest('hex'),
    });
    assert.equal(started.status, 200);
    const artifact = await started.json() as { id: string };
    assert.equal((await send('artifact.chunk', artifact.id, { offset: 0, base64: content.toString('base64') })).status, 200);
    assert.equal((await send('artifact.complete', artifact.id, {})).status, 200);
    const downloaded = await request(environment, '/v2/artifact', query(environment, owner, 'artifact', { artifactId: artifact.id }), owner);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'owned content');
    const response = await request(environment, '/v2/stream', query(environment, owner, 'subscribe'), owner);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(response.headers.get('x-outpost-environment-id'), environment.coordinator.environment.environmentId);
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      const frame = new TextDecoder().decode(first.value);
      assert.match(frame, /"type":"snapshot"/);
      assert.match(frame, /"protocolVersion":1/);
      assert.ok(frame.includes(taskId));
    } finally { await reader.cancel(); }
  } finally { await environment.close(); }
});

test('recovery diagnostics uses signed v1/v2 queries during holds without writes or environment/auth bypass', async () => {
  const one = await fixture(), two = await fixture();
  const owner = device();
  try {
    await pair(one, owner); await pair(two, owner);
    const missing = await request(one, '/v2/query', query(one, owner, 'recovery.diagnostics'), owner);
    assert.equal(missing.status, 200);
    const missingReport = RecoveryReport.parse(await missing.json());
    assert.deepEqual(missingReport.recovery, { state: 'missing', revision: null });
    assert.equal(missingReport.dispatchEnabled, true);
    assert.equal(one.db.get('recovery', 'server'), undefined);
    one.db.put('recovery', 'server', 0, { dispatchEnabled: false, reason: 'PRIVATE-RECOVERY-REASON' });
    one.db.put('runtime_update', 'server', 0, { state: 'prepared', secret: 'PRIVATE-MAINTENANCE' });
    const before = one.db.db.prepare('SELECT total_changes() AS n').get()?.n;
    const cursor = one.db.cursor();
    const bound = query(one, owner, 'recovery.diagnostics');
    const legacy = { deviceId: owner.id, issuedAt: Date.now(), type: 'recovery.diagnostics', payload: {} };
    for (const [path, envelope] of [['/v1/query', legacy], ['/v2/query', bound]] as const) {
      const response = await request(one, path, envelope, owner);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const text = await response.text(), value = RecoveryReport.parse(JSON.parse(text));
      assert.equal(value.environmentId, one.coordinator.environment.environmentId);
      assert.deepEqual(value.recovery, { state: 'held', revision: 1 });
      assert.equal(value.dispatchEnabled, false);
      assert.deepEqual(value.maintenance, { state: 'prepared', holding: true });
      assert.equal(value.agent.available, false);
      assert.equal(text.includes('PRIVATE-'), false);
      assert.equal(text.includes(token), false);
    }
    const anonymous = await fetch(one.base + '/v2/query', { method: 'POST', body: JSON.stringify(bound) });
    assert.notEqual(anonymous.status, 200);
    await expectError(await request(one, '/v2/query', bound, device()), 'invalid_signature');
    await expectError(await request(one, '/v2/query', { ...bound, issuedAt: 0 }, owner), 'expired_request');
    await expectError(await request(one, '/v2/query', { ...bound, payload: { command: 'arbitrary shell read' } }, owner), 'invalid_request', 400);
    await expectError(await request(one, '/v1/query', { ...legacy, payload: { goal: 'arbitrary goal' } }, owner), 'invalid_request', 400);
    await expectError(await request(two, '/v2/query', bound, owner), 'environment_mismatch');
    await expectError(await request(two, '/v2/query', { ...bound, environmentId: two.coordinator.environment.environmentId }, owner, bound), 'invalid_signature');
    await expectError(await request(one, '/v1/query', bound, owner), 'unsupported_protocol', 426);
    assert.equal(one.db.db.prepare('SELECT total_changes() AS n').get()?.n, before);
    assert.equal(one.db.cursor(), cursor);
    one.coordinator.devices.revoke(owner.id, 1);
    await expectError(await request(one, '/v2/query', bound, owner), 'revoked_device');
    await expectError(await request(one, '/v1/query', legacy, owner), 'revoked_device');
    assert.equal((await request(two, '/v2/query', query(two, owner, 'recovery.diagnostics'), owner)).status, 200);
  } finally { await one.close(); await two.close(); }
});

test('recovery diagnostics respects disabled legacy access while remaining available over v2', async () => {
  const environment = await fixture(false), owner = device();
  try {
    await pair(environment, owner);
    environment.db.put('recovery', 'server', 0, { dispatchEnabled: 'malformed' });
    await expectError(await request(environment, '/v1/query', { deviceId: owner.id, issuedAt: Date.now(), type: 'recovery.diagnostics', payload: {} }, owner), 'legacy_protocol_disabled', 426);
    const response = await request(environment, '/v2/query', query(environment, owner, 'recovery.diagnostics'), owner);
    assert.equal(response.status, 200);
    const value = RecoveryReport.parse(await response.json());
    assert.equal(value.recovery.state, 'invalid');
    assert.equal(value.dispatchEnabled, false);
  } finally { await environment.close(); }
});
