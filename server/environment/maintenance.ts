import type { Ledger } from '../core/ledger.js';
import { canonical, requireThat } from '../core/contracts.js';
import type { Tasks } from '../tasks/tasks.js';
import type { WorkerClient } from '../pi-worker/client.js';
import { UpdateRequest, ReleaseManifest, compatibleUpdate } from '../pi-management/update-contracts.js';

/** Coordinator-owned admission gate. Active work drains; new work/sign-ins cannot enter. */
export class Maintenance {
  private advancing = false;
  constructor(private db: Ledger, private tasks: Tasks, private worker: WorkerClient | undefined, private active: () => boolean) {}
  get holding() { return ['draining', 'holding', 'prepared'].includes(String(this.db.get('runtime_update', 'server')?.data.state)); }
  status() { return this.db.get('runtime_update', 'server')?.data ?? { state: 'idle' }; }
  async advance() {
    if (this.advancing || !['draining', 'holding'].includes(String(this.status().state))) return;
    this.advancing = true;
    try {
      const value = this.status();
      await this.request(String(value.owner), { type: 'maintenance.prepare', operationId: value.operationId,
        expectedRelease: value.expectedRelease, target: value.target, sha256: value.sha256 });
    } finally { this.advancing = false; }
  }
  async request(owner: string, input: unknown) {
    const request = UpdateRequest.parse(input);
    if (request.type === 'maintenance.status') return this.status();
    requireThat(this.worker, 'pi_worker_unavailable');
    const previous = this.db.get('runtime_update', 'server');
    if (request.type === 'maintenance.cancel') {
      requireThat(previous?.data.owner === owner && previous.data.operationId === request.operationId && ['staging', 'draining'].includes(String(previous.data.state)), 'maintenance_cannot_cancel');
      return this.db.put('runtime_update', 'server', previous.revision, { ...previous.data, state: 'cancelled' }).data;
    }
    requireThat(request.type === 'maintenance.prepare' || request.type === 'maintenance.stage', 'maintenance_internal_operation');
    if (this.holding || previous?.data.state === 'staging') {
      requireThat(previous?.data.owner === owner && previous.data.operationId === request.operationId && previous.data.sha256 === request.sha256 && canonical(previous.data.target) === canonical(request.target), 'maintenance_conflict');
      if (previous.data.state === 'prepared' || request.type === 'maintenance.stage') return previous.data;
      // Only the host's digest-bound checkpoint helper can move staged work to draining.
      requireThat(previous.data.state !== 'staging', 'maintenance_stage_not_ready');
    } else {
      requireThat(previous?.data.operationId !== request.operationId, 'maintenance_operation_finished');
      const inventory = await this.worker.request({ type: 'management', owner, request: { type: 'runtime.inventory' } }) as { manifest?: unknown; releaseId?: string };
      const source = ReleaseManifest.parse(inventory.manifest);
      requireThat(inventory.releaseId === request.expectedRelease && source.id === request.expectedRelease && compatibleUpdate(source, request.target), 'unsupported_update_path');
      requireThat(!this.holding && this.status().state !== 'staging', 'maintenance_conflict');
      this.db.put('runtime_update', 'server', previous?.revision ?? 0, { owner, operationId: request.operationId, expectedRelease: request.expectedRelease,
        target: request.target, sha256: request.sha256, state: request.type === 'maintenance.stage' ? 'staging' : 'draining' });
    }
    if (request.type === 'maintenance.stage' || this.active()) return this.status();
    let current = this.db.need('runtime_update', 'server');
    if (current.data.state === 'draining') {
      try { this.tasks.prepareMaintenance(); } catch { return this.status(); }
      current = this.db.put('runtime_update', 'server', current.revision, { ...current.data, state: 'holding' });
    }
    try {
      const result = await this.worker.request({ type: 'management', owner, request: { type: 'maintenance.hold', operationId: request.operationId } }) as { ready: boolean };
      if (!result.ready) {
        this.tasks.recover(); this.tasks.finishMaintenance();
        return this.db.put('runtime_update', 'server', current.revision, { ...current.data, state: 'draining' }).data;
      }
      const checkpoint = this.db.need('maintenance_checkpoint', 'server');
      this.db.put('maintenance_checkpoint', 'server', checkpoint.revision, { ...checkpoint.data, expiresAt: Date.now() + 3 * 3600000 });
      return this.db.put('runtime_update', 'server', current.revision, { ...current.data, state: 'prepared' }).data;
    } catch {
      // A lost worker hold reply is ambiguous; preserve the dispatch hold for recovery.
      throw new Error('maintenance_hold_unknown');
    }
  }
}
