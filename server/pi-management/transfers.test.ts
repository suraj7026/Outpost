import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PiProfile } from './profile.js';
import { ProviderTransfers } from './transfers.js';
import { credentialStore } from './credential-store.js';
import type { TransferTicket } from './transfer-contracts.js';

const owner = randomUUID(), key = 'synthetic-transfer-secret-canary';
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-transfer-'));
  const source = new PiProfile(join(root, 'source')), destination = new PiProfile(join(root, 'destination'));
  const from = new ProviderTransfers(source), to = new ProviderTransfers(destination);
  t.after(() => { from.close(); to.close(); rmSync(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Transfers must not use network model discovery or inference'); });
  const put = async (profile: PiProfile, id: string, value: string) => (await credentialStore(profile.directory)).modify(id, async () => ({ type: 'api_key', key: value }));
  await put(source, 'anthropic', key);
  const prepare = async (replace = false, ids = ['anthropic']) => {
    const inventory = await from.inventory(), target = await to.inventory();
    return to.request(owner, { type: 'transfer.prepare', operationId: randomUUID(), source: inventory, destination: target,
      selection: ids.map(id => ({ provider: inventory.providers.find(p => p.id === id), replace })) }) as Promise<TransferTicket>;
  };
  const packet = async (ticket: TransferTicket) => from.request(owner, { type: 'transfer.export', ticket }) as Promise<any>;
  return { root, source, destination, from, to, put, prepare, packet };
}

test('encrypted import preserves source, binds owner, is replay-safe and persists only nonsecret receipts', async t => {
  const f = await fixture(t), ticket = await f.prepare(), packet = await f.packet(ticket);
  assert.ok(!JSON.stringify(packet).includes(key));
  await assert.rejects(f.to.request('another-device', { type: 'transfer.apply', sealed: packet }), /transfer_unavailable/);
  const result: any = await f.to.request(owner, { type: 'transfer.apply', sealed: packet });
  assert.equal(result.state, 'complete');
  assert.equal((await (await credentialStore(f.destination.directory)).read('anthropic') as any).key, key);
  assert.equal((await (await credentialStore(f.source.directory)).read('anthropic') as any).key, key);
  await f.put(f.destination, 'anthropic', 'later-key');
  assert.deepEqual(await f.to.request(owner, { type: 'transfer.apply', sealed: packet }), result);
  assert.equal((await (await credentialStore(f.destination.directory)).read('anthropic') as any).key, 'later-key');
  const receipt = readFileSync(join(f.destination.directory, '.outpost-transfers.sqlite'));
  assert.ok(!receipt.includes(Buffer.from(key))); assert.ok(!receipt.includes(Buffer.from(packet.ciphertext)));
});

test('keep destination by default; reviewed replacements cannot overwrite concurrent credential changes', async t => {
  const f = await fixture(t); await f.put(f.destination, 'anthropic', 'original');
  await assert.rejects(f.prepare(), /transfer_destination_conflict/);
  const ticket = await f.prepare(true), packet = await f.packet(ticket);
  await f.put(f.destination, 'anthropic', 'edited-after-review');
  const result: any = await f.to.request(owner, { type: 'transfer.apply', sealed: packet });
  assert.equal(result.state, 'needs_attention'); assert.equal(result.providers[0].state, 'not_confirmed');
  assert.equal((await (await credentialStore(f.destination.directory)).read('anthropic') as any).key, 'edited-after-review');
});

test('source edits, expired tickets, destination substitution and packet tampering cannot import', async t => {
  const f = await fixture(t), ticket = await f.prepare(), sealed = await f.packet(ticket);
  await assert.rejects(f.to.request(owner, { type: 'transfer.apply', sealed: { ...sealed, tag: Buffer.alloc(16).toString('base64') } }), /transfer_apply_failed/);
  await assert.rejects(f.to.request(owner, { type: 'transfer.apply', sealed: { ...sealed, ticket: { ...ticket, destinationId: randomUUID() } } }), /transfer_ticket_invalid/);
  await f.put(f.source, 'anthropic', 'changed-source');
  await assert.rejects(f.packet(ticket), /transfer_source_changed/);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 300001);
  await assert.rejects(f.packet(ticket), /transfer_source_changed/);
  const expired: any = await f.to.request(owner, { type: 'transfer.apply', sealed }); assert.equal(expired.state, 'expired');
  assert.equal(await (await credentialStore(f.destination.directory)).read('anthropic'), undefined);
});

test('literal inventory never executes credential commands, resolves environment templates or copies OAuth', async t => {
  const f = await fixture(t), marker = join(f.root, 'must-not-exist');
  writeFileSync(join(f.source.directory, 'auth.json'), JSON.stringify({
    anthropic: { type: 'api_key', key: `!touch '${marker}'; printf leaked-command` },
    openai: { type: 'api_key', key: 'prefix-$PRIVATE_ENV' },
    google: { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: Date.now() + 60000 },
    groq: { type: 'api_key', key: 'literal', env: { SECRET: 'private-env' } },
  }));
  writeFileSync(join(f.source.directory, 'models.json'), JSON.stringify({ providers: { groq: {
    baseUrl: 'https://endpoint.invalid/v1?token=private-url-canary', apiKey: `!touch '${marker}'`,
  } } }));
  const inventory = await f.from.inventory();
  assert.equal(existsSync(marker), false);
  assert.deepEqual(inventory.providers.map(p => p.method), ['unsupported', 'unsupported', 'oauth', 'unsupported']);
  assert.ok(!JSON.stringify(inventory).includes('private-'));
  await assert.rejects(f.prepare(false, ['google']), /transfer_selection_invalid/);
});

test('partial completion reports each provider and cancellation discards ephemeral keys', async t => {
  const f = await fixture(t); await f.put(f.source, 'openai', 'second-canary');
  const ticket = await f.prepare(false, ['anthropic', 'openai']), sealed = await f.packet(ticket);
  await f.put(f.destination, 'openai', 'concurrent-edit');
  const result: any = await f.to.request(owner, { type: 'transfer.apply', sealed });
  assert.deepEqual(result.providers, [{ id: 'anthropic', state: 'saved' }, { id: 'openai', state: 'not_confirmed' }]);
  const other = await f.prepare(true), otherPacket = await f.packet(other);
  await f.to.request(owner, { type: 'transfer.cancel', operationId: other.operationId });
  assert.equal((await f.to.request(owner, { type: 'transfer.apply', sealed: otherPacket }) as any).state, 'cancelled');
});

test('compatible custom endpoints survive native JSON key ordering and require a fresh conflict review', async t => {
  const f = await fixture(t);
  const configuration = { providerId: 'private-api', baseUrl: 'https://models.invalid/v1', api: 'openai-completions',
    models: [{ id: 'model', name: 'Private model', contextWindow: 4096, maxTokens: 1024 }] };
  await f.source.configure(configuration, f.source.generation()); await f.put(f.source, 'private-api', key);
  await f.destination.configure({ ...configuration, baseUrl: 'https://previous.invalid/v1' }, f.destination.generation());
  const { canonical } = await import('../core/contracts.js');
  const native = (value: unknown) => JSON.parse(canonical(value));
  const source = native(await f.from.inventory()), destination = native(await f.to.inventory());
  const request = { type: 'transfer.prepare', operationId: randomUUID(), source, destination,
    selection: [{ provider: source.providers.find((p: any) => p.id === 'private-api'), replace: false }] };
  await assert.rejects(f.to.request(owner, native(request)), /transfer_destination_conflict/);
  request.selection[0]!.replace = true;
  const ticket = await f.to.request(owner, native(request)) as TransferTicket;
  const sealed = await f.packet(native(ticket));
  assert.equal((await f.to.request(owner, { type: 'transfer.apply', sealed: native(sealed) }) as any).state, 'complete');
  assert.equal(f.destination.transferConfiguration('private-api')?.baseUrl, configuration.baseUrl);
  const stale = { ...request, operationId: randomUUID() };
  await assert.rejects(f.to.request(owner, stale), /transfer_destination_changed/);
});

test('unreviewed model configuration changes, duplicate selection and same-profile imports are blocked', async t => {
  const f = await fixture(t), source = await f.from.inventory(), destination = await f.to.inventory();
  const selection = [{ provider: source.providers[0], replace: false }];
  await assert.rejects(f.from.request(owner, { type: 'transfer.prepare', operationId: randomUUID(), source, destination: source, selection }), /transfer_same_installation/);
  await assert.rejects(f.to.request(owner, { type: 'transfer.prepare', operationId: randomUUID(), source, destination, selection: [...selection, ...selection] }));
  const ticket = await f.prepare(), sealed = await f.packet(ticket);
  writeFileSync(join(f.destination.directory, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'unreviewed' }));
  await assert.rejects(f.to.request(owner, { type: 'transfer.apply', sealed }), /transfer_apply_failed/);
  assert.equal(await (await credentialStore(f.destination.directory)).read('anthropic'), undefined);
});

test('worker restart expires prepared imports and preserves unknown application receipts', async t => {
  const f = await fixture(t), ticket = await f.prepare();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(f.destination.directory, '.outpost-transfers.sqlite'));
  const interrupted = randomUUID();
  db.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(interrupted, owner, '{}', JSON.stringify({ operationId: interrupted, state: 'applying', providers: [{ id: 'openai', state: 'saved' }] })); db.close();
  const restarted = new ProviderTransfers(f.destination);
  try {
    assert.equal((await restarted.request(owner, { type: 'transfer.status', operationId: ticket.operationId }) as any).state, 'expired');
    const unknown: any = await restarted.request(owner, { type: 'transfer.status', operationId: interrupted });
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.providers[0].state, 'saved');
  } finally { restarted.close(); }
});
