import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { Command, Fault, requireThat } from '../core/contracts.js';
import { Coordinator, publicKinds } from './coordinator.js';
const Query = z.strictObject({ deviceId: z.uuid(),issuedAt: z.number().int(),type: z.string(),payload: z.record(z.string(),z.json()) });
export function httpServer(coordinator: Coordinator, pairingToken: string) {
  let pairingUsed = coordinator.db.list('device').length > 0;
  return createServer(async (req,res) => {
    res.setHeader('content-type','application/json'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
    try {
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ status: 'ready',protocolVersion: 1,mode: 'private-agent',inference: coordinator.runtimeStatus().configured ? 'configured' : 'unconfigured' })); return; }
      requireThat(req.method === 'POST','method_not_allowed');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; requireThat(size <= 1024*1024,'request_too_large'); chunks.push(bytes); }
      const bytes = Buffer.concat(chunks), raw: unknown = JSON.parse(bytes.toString('utf8'));
      if (req.url === '/v1/pair') {
        requireThat(!pairingUsed && pairingToken.length >= 32,'pairing_closed');
        const pair = z.strictObject({ deviceId: z.uuid(),name: z.string().min(1).max(80),publicKey: z.string(),token: z.string().max(1000) }).parse(raw);
        requireThat(timingSafeEqual(createHash('sha256').update(pair.token).digest(),createHash('sha256').update(pairingToken).digest()),'invalid_pairing_token');
        const result = coordinator.devices.pair(pair.deviceId,pair.name,pair.publicKey); pairingUsed = true; res.end(JSON.stringify(result)); return;
      }
      const parsed = req.url === '/v1/commands' ? Command.parse(raw) : Query.parse(raw);
      requireThat(Math.abs(Date.now()-parsed.issuedAt) < 300000,'expired_request');
      coordinator.devices.authenticate(parsed.deviceId,bytes,z.string().parse(req.headers['x-outpost-signature']));
      if (req.url === '/v1/stream') { coordinator.live.serve(res,parsed.deviceId,publicKinds); return; }
      if (req.url === '/v1/commands') res.end(JSON.stringify(coordinator.command(parsed)));
      else if (req.url === '/v1/query') res.end(JSON.stringify(await coordinator.query(parsed.type,parsed.payload)));
      else if (req.url === '/v1/artifact') {
        const key = z.string().parse(parsed.payload.artifactId), artifact = coordinator.db.need('artifact',key), data = coordinator.artifacts.read(key);
        res.setHeader('content-type','application/octet-stream'); res.setHeader('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(String(artifact.data.name))}`); res.end(data);
      } else if (req.url === '/v1/pair-device') {
        const pair = z.strictObject({ deviceId: z.uuid(),name: z.string().min(1).max(80),publicKey: z.string() }).parse(parsed.payload);
        res.end(JSON.stringify(coordinator.devices.pair(pair.deviceId,pair.name,pair.publicKey)));
      } else throw new Fault('not_found','Endpoint not found',404);
    } catch (error) {
      res.statusCode = error instanceof Fault ? error.status : 400;
      res.end(JSON.stringify({ error: error instanceof Fault ? error.code : 'invalid_request',message: error instanceof Fault ? error.message : 'Request failed validation' }));
    }
  });
}
