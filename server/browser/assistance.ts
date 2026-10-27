import { z } from 'zod';
import { id, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
const Challenge = z.enum(['captcha','login','mfa','permission_denied','rate_limit','paywall','page_failure']);
interface Request { taskId: string; sessionId: string; kind: z.infer<typeof Challenge>; state: string; expiresAt: number; observation: number; attempts: number }
export class Assistance {
  constructor(private db: Ledger) {}
  request(taskId: string, sessionId: string, kind: unknown, observation: number) {
    const classification = Challenge.parse(kind);
    requireThat(!['permission_denied','paywall'].includes(classification),'access_denied_no_evasion');
    const previous = this.db.list<Request>('assistance').find(record => record.data.taskId === taskId && record.data.sessionId === sessionId && record.data.state === 'pending' && record.data.expiresAt > Date.now());
    if (previous) return previous;
    return this.db.transaction(() => {
      const request = this.db.put<Request>('assistance',id(),0,{ taskId,sessionId,kind: classification,state: 'pending',expiresAt: Date.now()+600000,observation,attempts: 0 });
      this.db.put('inbox',request.id,0,{ taskId,category: 'assistance',state: 'pending',title: 'Browser assistance needed' });
      this.db.enqueue('notice',{ noticeId: request.id,taskId },request.id); return request;
    });
  }
  resolve(requestId: string, expected: number, freshObservation: number, verified: boolean) {
    return this.db.transaction(() => {
      const request = this.db.need<Request>('assistance',requestId);
      requireThat(request.data.state === 'pending' && request.data.expiresAt > Date.now(),'stale_assistance');
      requireThat(verified && freshObservation > request.data.observation,'fresh_page_verification_required');
      const result = this.db.put('assistance',requestId,expected,{ ...request.data,state: 'resolved',observation: freshObservation });
      const notice = this.db.need('inbox',requestId); this.db.put('inbox',requestId,notice.revision,{ ...notice.data,state: 'resolved' }); return result;
    });
  }
}
