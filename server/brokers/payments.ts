import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { digest, id, requireThat } from '../core/contracts.js';
export const WorkflowMandate = z.strictObject({ taskId: z.string(),merchant: z.string().min(1),purpose: z.string().min(1),itemsHash: z.string().regex(/^[a-f0-9]{64}$/),identityId: z.string(),fundingAlias: z.string(),delivery: z.string(),maxMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency: z.string().regex(/^[A-Z]{3}$/),recurrence: z.enum(['none','monthly','yearly']),steps: z.array(z.string()).min(1),expiresAt: z.number().int() });
export type WorkflowMandate = z.infer<typeof WorkflowMandate>;
interface Mandate { terms: WorkflowMandate; hash: string; revoked: boolean; consumedMinor: number; deviceId: string }
export class Payments {
  constructor(private db: Ledger) {}
  authorize(terms: unknown, exactDigest: string, deviceId: string) {
    const parsed = WorkflowMandate.parse(terms);
    requireThat(parsed.expiresAt > Date.now() && digest(parsed) === exactDigest,'stale_payment_authority');
    const device = this.db.need<{ revoked: boolean }>('device',deviceId); requireThat(!device.data.revoked,'revoked_device');
    return this.db.put<Mandate>('mandate',id(),0,{ terms: parsed,hash: exactDigest,revoked: false,consumedMinor: 0,deviceId });
  }
  reserve(mandateId: string, operationKey: string, currentTerms: unknown, amountMinor: number, step: string) {
    return this.db.transaction(() => {
      const mandate = this.db.need<Mandate>('mandate',mandateId), data = mandate.data;
      const terms = WorkflowMandate.parse(currentTerms);
      requireThat(!data.revoked && data.terms.expiresAt > Date.now(),'expired_or_revoked_mandate');
      requireThat(digest(terms) === data.hash && terms.steps.includes(step),'payment_scope_changed');
      requireThat(Number.isSafeInteger(amountMinor) && amountMinor > 0,'invalid_amount');
      const previous = this.db.get('payment_attempt',operationKey);
      if (previous) { requireThat(previous.data.mandateId === mandateId && previous.data.amountMinor === amountMinor && previous.data.step === step,'payment_key_conflict'); return previous; }
      requireThat(amountMinor <= data.terms.maxMinor-data.consumedMinor,'payment_budget_exceeded');
      this.db.put('mandate',mandateId,mandate.revision,{ ...data,consumedMinor: data.consumedMinor+amountMinor });
      return this.db.put('payment_attempt',operationKey,0,{ mandateId,amountMinor,step,state: 'reserved',providerId: null });
    });
  }
  unknown(operationKey: string, expected: number) { const attempt = this.db.need('payment_attempt',operationKey); return this.db.put('payment_attempt',operationKey,expected,{ ...attempt.data,state: 'reconciling' }); }
  revoke(mandateId: string, expected: number) { const record = this.db.need<Mandate>('mandate',mandateId); return this.db.put('mandate',mandateId,expected,{ ...record.data,revoked: true }); }
}
