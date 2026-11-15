import { createCipheriv, createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { credentialStore } from './credential-store.js';
import type { Credential } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { PiProfile } from './profile.js';
import { managementError } from './contracts.js';
import { canonical } from '../core/contracts.js';
import { TransferRequest, TransferSource, type TransferProvider, type TransferTicket, type TransferResult } from './transfer-contracts.js';

const literal = (value: Credential | undefined): value is { type: 'api_key'; key: string } => value?.type === 'api_key' &&
  Object.keys(value).every(k => ['type', 'key'].includes(k)) && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 32768 && !/^!|[$\r\n\x00]/.test(value.key);
const bytes = (text: string, size?: number) => {
  const value = Buffer.from(text, 'base64');
  if (value.toString('base64') !== text || size !== undefined && value.length !== size) throw managementError('transfer_packet_invalid');
  return value;
};
const publicKey = (text: string) => {
  const key = createPublicKey({ key: bytes(text), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw managementError('transfer_key_invalid');
  return key;
};
const serializeKey = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }).toString('base64');
const secret = (privateKey: KeyObject, peer: string, ticket: TransferTicket) => Buffer.from(hkdfSync('sha256',
  diffieHellman({ privateKey, publicKey: publicKey(peer) }), Buffer.from(ticket.operationId), Buffer.from(canonical(ticket)), 32));
type Prepared = { ticket: TransferTicket; privateKey: KeyObject; expected: Map<string, string> };

/** Plaintext exists only inside the source/destination worker. Receipts contain metadata, never packets. */
export class ProviderTransfers {
  private readonly salt = randomBytes(32);
  private readonly prepared = new Map<string, Prepared>();
  private readonly db: DatabaseSync;
  constructor(private readonly profile: PiProfile) {
    const path = join(profile.directory, '.outpost-transfers.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);
      UPDATE transfers SET result=json_set(result,'$.state','expired') WHERE json_extract(result,'$.state')='prepared';
      UPDATE transfers SET result=json_set(result,'$.state','unknown') WHERE json_extract(result,'$.state')='applying';`);
  }
  close() { this.prepared.clear(); this.salt.fill(0); this.db.close(); }
  get active() { return [...this.prepared.values()].some(p => p.ticket.expiresAt > Date.now()); }
  private fingerprint(value: unknown) { return createHmac('sha256', this.salt).update(JSON.stringify(value ?? null)).digest('hex'); }
  private credentials() { return credentialStore(this.profile.directory); }
  async inventory() {
    const generation = this.profile.generation();
    const runtime = await this.profile.runtime(true), providers: TransferProvider[] = [];
    const store = await this.credentials();
    const ids = new Set([...(await store.list()).map(entry => entry.providerId), ...this.profile.transferProviderIds()]);
    for (const providerId of ids) {
      const provider = runtime.getProvider(providerId), credential = await store.read(providerId);
      let configuration: Record<string, unknown> | null = null, supported = !!provider;
      try { configuration = this.profile.transferConfiguration(providerId); } catch { supported = false; }
      const candidate = { id: providerId, name: provider?.name ?? providerId, method: credential?.type === 'oauth' ? 'oauth'
        : supported && literal(credential) ? 'api_key' : 'unsupported', revision: this.fingerprint(credential), baseUrl: supported ? provider?.baseUrl ?? '' : '', configuration };
      providers.push(TransferSource.shape.providers.element.parse(candidate));
    }
    if (this.profile.generation() !== generation) throw managementError('transfer_configuration_changed');
    return TransferSource.parse({ installationId: this.profile.installationId(), generation, providers });
  }
  private status(owner: string, id: string): TransferResult {
    const row = this.db.prepare('SELECT owner,result FROM transfers WHERE id=?').get(id);
    if (!row || row.owner !== owner) throw managementError('transfer_unavailable');
    const result = JSON.parse(String(row.result)) as TransferResult;
    const prepared = this.prepared.get(id);
    if (result.state === 'prepared' && (!prepared || prepared.ticket.expiresAt <= Date.now())) {
      result.state = 'expired'; this.prepared.delete(id); this.save(result);
    }
    return result;
  }
  private save(result: TransferResult) { this.db.prepare('UPDATE transfers SET result=? WHERE id=?').run(JSON.stringify(result), result.operationId); }
  async request(owner: string, input: unknown): Promise<unknown> {
    const request = TransferRequest.parse(input);
    if (request.type === 'transfer.inventory') return this.inventory();
    if (request.type === 'transfer.history') return this.db.prepare('SELECT id FROM transfers WHERE owner=? ORDER BY rowid DESC LIMIT 20').all(owner).map(row => this.status(owner, String(row.id)));
    if (request.type === 'transfer.status') return this.status(owner, request.operationId);
    if (request.type === 'transfer.cancel') {
      const status = this.status(owner, request.operationId);
      if (status.state === 'prepared') { status.state = 'cancelled'; this.prepared.delete(request.operationId); this.save(status); }
      return status;
    }
    if (request.type === 'transfer.prepare') {
      for (const [id, value] of this.prepared) if (value.ticket.expiresAt <= Date.now()) this.prepared.delete(id);
      if (this.prepared.size >= 16) throw managementError('transfer_capacity');
      const previous = this.db.prepare('SELECT request FROM transfers WHERE id=?').get(request.operationId);
      if (previous) throw managementError('transfer_already_prepared_check_status');
      if (Number(this.db.prepare('SELECT count(*) AS n FROM transfers').get()?.n) >= 10000) throw managementError('transfer_capacity');
      const destinationId = this.profile.installationId();
      if (request.source.installationId === destinationId) throw managementError('transfer_same_installation');
      const inventory = await this.inventory(), expected = new Map<string, string>();
      if (canonical(inventory) !== canonical(request.destination)) throw managementError('transfer_destination_changed');
      for (const selection of request.selection) {
        const provider = selection.provider;
        if (provider.method !== 'api_key' || !request.source.providers.some(p => canonical(p) === canonical(provider))) throw managementError('transfer_selection_invalid');
        const current = inventory.providers.find(p => p.id === provider.id);
        if (current && !selection.replace) throw managementError('transfer_destination_conflict');
        expected.set(provider.id, current?.revision ?? this.fingerprint(undefined));
        const configuration = this.profile.transferConfiguration(provider.id);
        if (configuration && canonical(configuration) !== canonical(provider.configuration) && !selection.replace) throw managementError('transfer_endpoint_conflict');
        const runtime = await this.profile.runtime(true), target = runtime.getProvider(provider.id);
        if (!provider.configuration && (!target?.auth.apiKey || (target.baseUrl ?? '') !== provider.baseUrl || configuration)) throw managementError('transfer_provider_unavailable');
      }
      const keys = generateKeyPairSync('x25519');
      const ticket: TransferTicket = { version: 1, operationId: request.operationId, owner, sourceId: request.source.installationId, destinationId,
        sourceGeneration: request.source.generation, destinationGeneration: inventory.generation, expiresAt: Date.now() + 300000,
        publicKey: serializeKey(keys.publicKey), selection: request.selection };
      this.db.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(ticket.operationId, owner, JSON.stringify(ticket), JSON.stringify({ operationId: ticket.operationId, state: 'prepared', providers: [] }));
      this.prepared.set(ticket.operationId, { ticket, privateKey: keys.privateKey, expected });
      return ticket;
    }
    if (request.type === 'transfer.export') {
      const ticket = request.ticket;
      if (ticket.owner !== owner || ticket.sourceId !== this.profile.installationId() || ticket.sourceId === ticket.destinationId || ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 300000 || ticket.sourceGeneration !== this.profile.generation()) throw managementError('transfer_source_changed');
      const inventory = await this.inventory(), credentials: { id: string; key: string }[] = [];
      for (const selection of ticket.selection) {
        const current = inventory.providers.find(p => p.id === selection.provider.id);
        const credential = await (await this.credentials()).read(selection.provider.id);
        if (!literal(credential) || canonical(current) !== canonical(selection.provider) || this.fingerprint(credential) !== selection.provider.revision) throw managementError('transfer_source_changed');
        credentials.push({ id: selection.provider.id, key: credential.key });
      }
      if (ticket.sourceGeneration !== this.profile.generation()) throw managementError('transfer_source_changed');
      const keys = generateKeyPairSync('x25519'), key = secret(keys.privateKey, ticket.publicKey, ticket), nonce = randomBytes(12);
      const plaintext = Buffer.from(JSON.stringify(credentials));
      try {
        const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(canonical(ticket)));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return { ticket, publicKey: serializeKey(keys.publicKey), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
      } finally { key.fill(0); plaintext.fill(0); }
    }
    const { sealed } = request, ticket = sealed.ticket;
    const status = this.status(owner, ticket.operationId);
    const saved = this.prepared.get(ticket.operationId);
    if (status.state !== 'prepared') return status; // A packet is never applied twice, even after restart.
    if (!saved || canonical(saved.ticket) !== canonical(ticket) || ticket.owner !== owner || ticket.destinationId !== this.profile.installationId()) throw managementError('transfer_ticket_invalid');
    const key = secret(saved.privateKey, sealed.publicKey, ticket);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes(sealed.nonce, 12));
      decipher.setAAD(Buffer.from(canonical(ticket))); decipher.setAuthTag(bytes(sealed.tag, 16));
      plaintext = Buffer.concat([decipher.update(bytes(sealed.ciphertext)), decipher.final()]);
      const credentials = z.array(z.strictObject({ id: z.string(), key: z.string().min(1).max(32768) })).max(16).parse(JSON.parse(plaintext.toString('utf8')));
      if (credentials.length !== ticket.selection.length || credentials.some((c, i) => c.id !== ticket.selection[i]?.provider.id || !literal({ type: 'api_key', key: c.key }))) throw managementError('transfer_packet_invalid');
      if (this.profile.generation() !== ticket.destinationGeneration) throw managementError('transfer_destination_changed');
      status.state = 'applying'; this.save(status); this.prepared.delete(ticket.operationId);
      let generation = ticket.destinationGeneration;
      for (const [index, credential] of credentials.entries()) {
        const provider = ticket.selection[index]!.provider;
        try {
          generation = await this.profile.importCredential(provider.id, credential.key, provider.configuration, generation,
            current => this.fingerprint(current) === saved.expected.get(provider.id));
          status.providers.push({ id: provider.id, state: 'saved' });
        } catch { status.providers.push({ id: provider.id, state: 'not_confirmed' }); }
        this.save(status);
      }
      status.state = status.providers.every(p => p.state === 'saved') ? 'complete' : 'needs_attention'; this.save(status);
      return status;
    } catch { throw managementError('transfer_apply_failed_check_status'); }
    finally { key.fill(0); plaintext?.fill(0); }
  }
}
