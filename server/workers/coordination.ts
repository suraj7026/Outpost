import { Ledger } from '../core/ledger.js';
import { id, requireThat } from '../core/contracts.js';
export interface WorkerScope { taskId: string; identityId: string; resources: string[]; tools: string[]; budget: number; depth: number; cancelled: boolean }
export class Workers {
  constructor(private db: Ledger) {}
  delegate(parentId: string, requested: WorkerScope, deliverable: string) {
    return this.db.transaction(() => {
      const parent = this.db.need<WorkerScope>('worker',parentId), scope = parent.data;
      requireThat(!scope.cancelled && !requested.cancelled && requested.taskId === scope.taskId && requested.identityId === scope.identityId && requested.depth === scope.depth+1 && requested.depth <= 3,'invalid_child_scope');
      requireThat(requested.tools.every(tool => scope.tools.includes(tool)) && requested.resources.every(resource => scope.resources.includes(resource)),'child_scope_expansion');
      requireThat(Number.isSafeInteger(requested.budget) && requested.budget > 0 && requested.budget <= scope.budget,'child_budget_exceeded');
      this.db.put('worker',parentId,parent.revision,{ ...scope,budget: scope.budget-requested.budget });
      return this.db.put('worker',id(),0,{ ...requested,parentId,deliverable,state: 'queued' });
    });
  }
  acquire(resource: string, workerId: string, durationMs: number) {
    return this.db.transaction(() => {
      const worker = this.db.need<WorkerScope>('worker',workerId);
      requireThat(!worker.data.cancelled && worker.data.resources.includes(resource),'resource_scope_denied');
      requireThat(durationMs > 0 && durationMs <= 300000,'invalid_lease_duration');
      const lease = this.db.get('resource_lease',resource);
      requireThat(!lease || lease.data.state === 'released','resource_busy_or_requires_reconciliation');
      return this.db.put('resource_lease',resource,lease?.revision ?? 0,{ workerId,expiresAt: Date.now()+durationMs,state: 'held' });
    });
  }
  cancel(parentId: string) {
    this.db.transaction(() => {
      const queue = [parentId];
      for (const key of queue) { const worker = this.db.need<WorkerScope>('worker',key); this.db.put('worker',key,worker.revision,{ ...worker.data,cancelled: true }); queue.push(...this.db.list('worker').filter(row => row.data.parentId === key).map(row => row.id)); }
    });
  }
}
