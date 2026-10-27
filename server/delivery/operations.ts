import { Ledger } from '../core/ledger.js';
import { digest, requireThat } from '../core/contracts.js';
import type { Data, Json } from '../core/contracts.js';
interface Operation { request: Data; hash: string; state: 'prepared' | 'dispatching' | 'unknown' | 'confirmed' | 'failed'; providerId: string | null; result: Json }
export interface DeliveryProvider { send(request: Data, operationKey: string): Promise<{ providerId: string; result: Json }>; lookup(operationKey: string): Promise<{ providerId: string; result: Json } | null> }
export class Deliveries {
  constructor(private db: Ledger) {}
  prepare(key: string, request: Data) {
    const previous = this.db.get<Operation>('delivery',key);
    if (previous) { requireThat(previous.data.hash === digest(request),'operation_key_conflict'); return previous; }
    return this.db.put<Operation>('delivery',key,0,{ request,hash: digest(request),state: 'prepared',providerId: null,result: null });
  }
  async send(key: string, approvedHash: string, provider: DeliveryProvider) {
    const intent = this.db.transaction(() => {
      const record = this.db.need<Operation>('delivery',key);
      requireThat(record.data.state === 'prepared' && record.data.hash === approvedHash,'stale_delivery');
      return this.db.put('delivery',key,record.revision,{ ...record.data,state: 'dispatching' as const });
    });
    try {
      const result = await provider.send(intent.data.request,key);
      return this.db.put('delivery',key,intent.revision,{ ...intent.data,state: 'confirmed',...result });
    } catch {
      return this.db.put('delivery',key,intent.revision,{ ...intent.data,state: 'unknown' });
    }
  }
  async reconcile(key: string, provider: DeliveryProvider) {
    const record = this.db.need<Operation>('delivery',key);
    requireThat(['unknown','dispatching'].includes(record.data.state),'not_reconciling');
    const result = await provider.lookup(key);
    return result ? this.db.put('delivery',key,record.revision,{ ...record.data,state: 'confirmed',...result }) : record;
  }
}
export function githubPRPlan(repository: string, head: string, base: string, revision: string, title: string, body: string) {
  requireThat(/^[\w.-]+\/[\w.-]+$/.test(repository) && /^[a-f0-9]{40,64}$/.test(revision),'invalid_repository_revision');
  requireThat([head,base].every(branch => /^[a-zA-Z0-9][\w./-]*$/.test(branch) && !branch.includes('..')),'invalid_branch');
  return { provider: 'github',operation: 'pull_request',repository,head,base,revision,title,body,includesMerge: false,includesDeployment: false };
}
