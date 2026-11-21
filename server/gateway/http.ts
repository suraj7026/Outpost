import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { Command, EnvironmentCommand, Fault, requireThat } from '../core/contracts.js';
import { EnvironmentPairing, EnvironmentQuery, LegacyPairing, LegacyQuery } from '../environment/contracts.js';
import { Coordinator, publicKinds } from './coordinator.js';

export const REPLAY_WINDOW_MS = 300_000;
export const MAX_REPLAY_ENTRIES = 10_000;

export class ReplayCache {
  private entries = new Map<string, number>();
  constructor(private maxEntries = MAX_REPLAY_ENTRIES) {}
  get size() { return this.entries.size; }
  private sweepHead(now: number, limit = 8) {
    let checked = 0;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt > now) break;
      this.entries.delete(key);
      if (++checked >= limit) break;
    }
  }
  private prune(now: number) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
  consume(key: string, expiresAt: number, now = Date.now()): boolean {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing > now) return false;
      this.entries.delete(key);
    }
    this.sweepHead(now);
    if (this.entries.size >= this.maxEntries) this.prune(now);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, expiresAt);
    return true;
  }
}

export function httpServer(coordinator: Coordinator, pairingToken: string) {
  let pairingUsed = coordinator.db.list('device').length > 0;
  const replayCache = new ReplayCache();
  const consumeReplay = (version: number, operation: string, deviceId: string, signature: string, bytes: Buffer, issuedAt: number) => {
    const key = createHash('sha256')
      .update(`${version}:${operation}:${deviceId}:${signature}:`)
      .update(bytes)
      .digest('hex');
    requireThat(replayCache.consume(key, issuedAt + REPLAY_WINDOW_MS), 'replayed_request');
  };
  return createServer(async (req,res) => {
    res.setHeader('content-type','application/json'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
    res.setHeader('x-outpost-environment-id', coordinator.environment.environmentId);
    try {
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ status: 'ready',protocolVersion: 1,mode: 'private-agent',inference: coordinator.runtimeStatus().configured ? 'configured' : 'unconfigured' })); return; }
      if (req.method === 'GET' && req.url === '/v2/environment') {
        res.setHeader('x-outpost-protocol-version', '2');
        res.end(JSON.stringify(coordinator.environmentDescriptor())); return;
      }
      requireThat(req.method === 'POST','method_not_allowed');
      const route = /^\/v(\d+)\/(commands|query|agent|browser|artifact|pair|pair-device|stream)$/.exec(req.url ?? '');
      if (!route) throw new Fault('not_found', 'Endpoint not found', 404);
      const version = Number(route[1]), operation = route[2];
      coordinator.environment.requireProtocol(version);
      res.setHeader('x-outpost-protocol-version', String(version));
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; requireThat(size <= 1024*1024,'request_too_large'); chunks.push(bytes); }
      const bytes = Buffer.concat(chunks), raw: unknown = JSON.parse(bytes.toString('utf8'));
      const envelope = z.object({ protocolVersion: z.unknown().optional() }).parse(raw);
      const expectedVersion = version === 2 ? 2 : operation === 'commands' ? 1 : undefined;
      if (envelope.protocolVersion !== expectedVersion) {
        throw new Fault('unsupported_protocol', 'Request protocol must match its API route. Do not downgrade environment-bound requests.', 426);
      }
      if (operation === 'pair') {
        const pair = version === 2 ? EnvironmentPairing.parse(raw) : LegacyPairing.parse(raw);
        if ('environmentId' in pair) coordinator.environment.requireTarget(pair.environmentId);
        requireThat(!pairingUsed && pairingToken.length >= 32,'pairing_closed');
        requireThat(timingSafeEqual(createHash('sha256').update(pair.token).digest(),createHash('sha256').update(pairingToken).digest()),'invalid_pairing_token');
        const result = coordinator.devices.pair(pair.deviceId,pair.name,pair.publicKey); pairingUsed = true; res.end(JSON.stringify(result)); return;
      }
      const parsed = operation === 'commands'
        ? (version === 2 ? EnvironmentCommand.parse(raw) : Command.parse(raw))
        : (version === 2 ? EnvironmentQuery.parse(raw) : LegacyQuery.parse(raw));
      requireThat(Math.abs(Date.now()-parsed.issuedAt) < REPLAY_WINDOW_MS,'expired_request');
      const signature = z.string().parse(req.headers['x-outpost-signature']);
      coordinator.devices.authenticate(parsed.deviceId,bytes,signature);
      if ('environmentId' in parsed) coordinator.environment.requireTarget(parsed.environmentId);
      if (operation === 'stream') { coordinator.live.serve(res,parsed.deviceId,publicKinds); return; }
      if (operation === 'commands') res.end(JSON.stringify(coordinator.command(parsed)));
      else if (operation === 'query') res.end(JSON.stringify(await coordinator.query(parsed.type,parsed.payload)));
      else if (operation === 'agent') {
        consumeReplay(version, operation, parsed.deviceId, signature, bytes, parsed.issuedAt);
        res.end(JSON.stringify(await coordinator.agentRequest(parsed.deviceId,parsed.payload)));
      }
      else if (operation === 'browser') {
        requireThat(coordinator.browserControl, 'browser_unavailable');
        consumeReplay(version, operation, parsed.deviceId, signature, bytes, parsed.issuedAt);
        res.end(JSON.stringify(await coordinator.browserControl.request(parsed.deviceId, parsed.payload)));
      }
      else if (operation === 'artifact') {
        const key = z.string().parse(parsed.payload.artifactId), artifact = coordinator.db.need('artifact',key), data = coordinator.artifacts.read(key);
        res.setHeader('content-type','application/octet-stream'); res.setHeader('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(String(artifact.data.name))}`); res.end(data);
      } else if (operation === 'pair-device') {
        requireThat(!coordinator.maintenance.holding, 'maintenance_in_progress');
        const pair = z.strictObject({ deviceId: z.uuid(),name: z.string().min(1).max(80),publicKey: z.string() }).parse(parsed.payload);
        consumeReplay(version, operation, parsed.deviceId, signature, bytes, parsed.issuedAt);
        res.end(JSON.stringify(coordinator.devices.pair(pair.deviceId,pair.name,pair.publicKey)));
      } else throw new Fault('not_found','Endpoint not found',404);
    } catch (error) {
      res.statusCode = error instanceof Fault ? error.status : 400;
      res.end(JSON.stringify({ error: error instanceof Fault ? error.code : 'invalid_request',message: error instanceof Fault ? error.message : 'Request failed validation' }));
    }
  });
}
