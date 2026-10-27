import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { id, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
interface Identity { label: string; ownership: 'agent' | 'owner'; origin: string; scopes: string[]; revoked: boolean; secretRef: string }
interface Grant { identityId: string; taskId: string; scopes: string[]; expiresAt: number; revoked: boolean }
export class IdentityBroker {
  constructor(private db: Ledger, private key: Buffer) { requireThat(key.length === 32,'invalid_vault_key'); }
  connect(label: string, ownership: 'agent' | 'owner', origin: string, scopes: string[], secret: string) {
    requireThat(new URL(origin).protocol === 'https:','https_required');
    const identityId = id(), secretRef = id(), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(identityId));
    const encrypted = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
    return this.db.transaction(() => {
      this.db.put('vault',secretRef,0,{ iv: iv.toString('base64'),ciphertext: encrypted.toString('base64'),tag: cipher.getAuthTag().toString('base64'),identityId });
      return this.db.put<Identity>('identity',identityId,0,{ label,ownership,origin: new URL(origin).origin,scopes,revoked: false,secretRef });
    });
  }
  grant(identityId: string, taskId: string, scopes: string[], expiresAt: number) {
    const identity = this.db.need<Identity>('identity',identityId).data;
    requireThat(!identity.revoked && scopes.every(scope => identity.scopes.includes(scope)) && expiresAt > Date.now(),'invalid_identity_scope');
    this.db.need('task',taskId);
    return this.db.put<Grant>('identity_grant',id(),0,{ identityId,taskId,scopes,expiresAt,revoked: false });
  }
  use(grantId: string, taskId: string, origin: string, scope: string) {
    const grant = this.db.need<Grant>('identity_grant',grantId).data, identity = this.db.need<Identity>('identity',grant.identityId).data;
    requireThat(!grant.revoked && !identity.revoked && grant.expiresAt > Date.now() && grant.taskId === taskId && grant.scopes.includes(scope) && new URL(origin).origin === identity.origin,'identity_access_denied');
    const secret = this.db.need<{ iv: string; ciphertext: string; tag: string }>('vault',identity.secretRef).data;
    const decipher = createDecipheriv('aes-256-gcm',this.key,Buffer.from(secret.iv,'base64'));
    decipher.setAAD(Buffer.from(grant.identityId)); decipher.setAuthTag(Buffer.from(secret.tag,'base64'));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext,'base64')),decipher.final()]);
  }
  revoke(identityId: string, expected: number) { const identity = this.db.need<Identity>('identity',identityId); return this.db.put('identity',identityId,expected,{ ...identity.data,revoked: true }); }
}
