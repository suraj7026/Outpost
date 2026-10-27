import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { id, requireThat } from '../core/contracts.js';
export interface APNsConfig { teamId: string; keyId: string; privateKeyPEM: string; topic: string; environment: 'sandbox' | 'production' }
export interface APNsResult { status: number; reason: string | null }
export type PushTransport = (token: string, noticeId: string, config: APNsConfig) => Promise<APNsResult>;
export const sendAPNs: PushTransport = async (token,noticeId,config) => {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256',kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId,iat: Math.floor(Date.now()/1000) })).toString('base64url');
  const content = `${header}.${claims}`, signature = sign('sha256',Buffer.from(content),{ key: createPrivateKey(config.privateKeyPEM),dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return new Promise((resolve,reject) => {
    const client = connect(config.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    let settled = false;
    const finish = (result: APNsResult | Error) => { if (settled) return; settled = true; client.destroy(); if (result instanceof Error) reject(result); else resolve(result); };
    client.on('error',error => finish(error)); client.setTimeout(10000,() => finish(Error('APNs timeout')));
    const request = client.request({ ':method': 'POST',':path': `/3/device/${token}`,authorization: `bearer ${content}.${signature}`,'apns-topic': config.topic,'apns-push-type': 'alert','apns-priority': '10','apns-collapse-id': noticeId,'apns-expiration': String(Math.floor(Date.now()/1000)+3600) });
    let status = 0, body = '';
    request.on('response',headers => { status = Number(headers[':status']); });
    request.on('data',(chunk: Buffer) => { body += chunk.toString(); if (body.length > 8192) finish(Error('APNs response too large')); });
    request.on('error',error => finish(error)); request.on('end',() => { try { const parsed: unknown = body ? JSON.parse(body) : {}; const result = z.object({ reason: z.string().optional() }).parse(parsed); finish({ status,reason: result.reason ?? null }); } catch { finish(Error('Invalid APNs response')); } });
    request.end(JSON.stringify({ aps: { alert: { title: 'Outpost',body: 'Your workspace has an update.' },sound: 'default' },noticeId }));
  });
};
interface Token { deviceId: string; token: string; topic: string; environment: 'sandbox' | 'production'; disabled: boolean }
export class Notifications {
  constructor(private db: Ledger) {}
  register(deviceId: string, token: string, topic: string, environment: 'sandbox' | 'production') {
    requireThat(/^[a-fA-F0-9]{32,256}$/.test(token),'invalid_push_token');
    requireThat(!this.db.need<{ revoked: boolean }>('device',deviceId).data.revoked,'revoked_device');
    const key = `${deviceId}:${topic}:${environment}`;
    return this.db.put<Token>('push_token',key,this.db.get('push_token',key)?.revision ?? 0,{ deviceId,token,topic,environment,disabled: false });
  }
  async deliver(noticeId: string, config: APNsConfig, transport = sendAPNs) {
    const notice = this.db.need('inbox',noticeId); if (notice.data.state !== 'pending') return;
    for (const token of this.db.list<Token>('push_token')) {
      const data = token.data, device = this.db.need<{ revoked: boolean }>('device',data.deviceId);
      if (data.disabled || device.data.revoked || data.topic !== config.topic || data.environment !== config.environment) continue;
      const key = `${noticeId}:${token.id}`, previous = this.db.get('push_delivery',key);
      if (previous?.data.state === 'accepted' || Number(previous?.data.attempts ?? 0) >= 5 || Number(previous?.data.retryAt ?? 0) > Date.now()) continue;
      let result: APNsResult;
      try { result = await transport(data.token,noticeId,config); } catch { result = { status: 0,reason: 'transport_unavailable' }; }
      const attempts = Number(previous?.data.attempts ?? 0)+1;
      this.db.transaction(() => {
        this.db.put('push_attempt',id(),0,{ noticeId,deviceId: data.deviceId,...result });
        this.db.put('push_delivery',key,previous?.revision ?? 0,{ state: result.status === 200 ? 'accepted' : 'retry',attempts,retryAt: Date.now()+Math.min(3600000,1000*2**attempts) });
        if (result.status === 410 || ['BadDeviceToken','DeviceTokenNotForTopic'].includes(result.reason ?? '')) this.db.put('push_token',token.id,token.revision,{ ...data,disabled: true });
      });
    }
  }
}
