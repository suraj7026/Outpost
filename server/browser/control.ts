import { Ledger } from '../core/ledger.js';
import { requireThat, id } from '../core/contracts.js';
import { BrowserSessions } from './sessions.js';
import { BrowserControlRequest } from './control-contracts.js';

interface Lease {
  taskId: string;
  leaseId: string;
  holder: string;
  state: 'pending' | 'human' | 'releasing' | 'released' | 'expired';
  expiresAt: number;
}

/** Device input never enters the durable command/action ledger. */
export class BrowserControl {
  private leases = new Map<string, Lease>();
  private requests = new Map<string, number>();
  private transitions = new Set<Promise<void>>();
  readonly epoch = id();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private db: Ledger, private sessions: BrowserSessions,
    private pause: (taskId: string) => void, private stopPi: (taskId: string) => Promise<void>,
    private leaseMs = 30000) {
    for (const row of db.list('browser_control')) if (['pending', 'human', 'releasing'].includes(String(row.data.state))) {
      db.put('browser_control', row.id, row.revision, { ...row.data, state: 'expired', expiresAt: 0 });
    }
    this.timer = setInterval(() => {
      for (const lease of this.leases.values()) this.expire(lease);
    }, 1000);
    this.timer.unref();
  }

  private publish(lease: Lease) {
    const previous = this.db.get('browser_control', lease.taskId);
    this.db.put('browser_control', lease.taskId, previous?.revision ?? 0, { ...lease }, 'browser.control_changed');
  }

  private background(work: Promise<void>) {
    this.transitions.add(work);
    void work.finally(() => this.transitions.delete(work));
  }

  private expire(lease: Lease) {
    if (['pending', 'human'].includes(lease.state) && (lease.expiresAt <= Date.now() || !this.sessions.isOpen(lease.taskId)
      || this.db.get('device', lease.holder)?.data.revoked !== false)) this.end(lease, 'expired');
  }

  private end(lease: Lease, state: 'released' | 'expired') {
    if (!['pending', 'human'].includes(lease.state)) return;
    lease.state = 'releasing'; this.publish(lease);
    this.background((async () => {
      await this.sessions.settled(lease.taskId);
      try {
        await this.stopPi(lease.taskId);
        this.sessions.release(lease.taskId);
        lease.state = state; lease.expiresAt = 0; this.publish(lease);
      } catch {
        // Remain fenced if the runtime cannot be confirmed stopped.
        lease.state = 'releasing'; this.publish(lease);
      }
    })());
  }

  status(taskId: string) {
    const lease = this.leases.get(taskId);
    if (lease) { this.expire(lease); return { ...lease }; }
    return this.db.get('browser_control', taskId)?.data ?? null;
  }

  revoke(deviceId: string) {
    for (const lease of this.leases.values()) if (lease.holder === deviceId) this.end(lease, 'expired');
  }

  async request(deviceId: string, input: unknown) {
    requireThat(!this.closed, 'browser_request_expired');
    requireThat(this.db.need('device', deviceId).data.revoked === false, 'revoked_device');
    const request = BrowserControlRequest.parse(input);
    requireThat(request.epoch === this.epoch, 'browser_request_expired');
    this.db.need('task', request.taskId);
    const now = Date.now();
    for (const [key, until] of this.requests) if (until <= now) this.requests.delete(key);
    const key = `${deviceId}:${request.requestId}`;
    requireThat(!this.requests.has(key), 'browser_request_replayed', 'Input is never replayed. Inspect the current page before acting again.');
    requireThat(this.requests.size < 20000, 'browser_request_capacity');
    this.requests.set(key, now + 600000);
    if (request.type === 'take') {
      const previous = this.leases.get(request.taskId);
      if (previous) this.expire(previous);
      requireThat(!previous || ['expired', 'released'].includes(previous.state), 'browser_control_held');
      this.sessions.reserve(request.taskId);
      try { this.pause(request.taskId); }
      catch (error) { this.sessions.release(request.taskId); throw error; }
      const lease: Lease = { taskId: request.taskId, leaseId: id(), holder: deviceId, state: 'pending', expiresAt: now + this.leaseMs };
      this.leases.set(request.taskId, lease); this.publish(lease);
      this.background((async () => {
        await this.sessions.settled(request.taskId);
        try {
          await this.stopPi(request.taskId);
          this.expire(lease);
          if (lease.state === 'pending') { this.sessions.refreshObservation(lease.taskId); lease.state = 'human'; this.publish(lease); }
        } catch { this.end(lease, 'expired'); }
      })());
      return { ...lease };
    }
    const lease = this.leases.get(request.taskId);
    if (lease) this.expire(lease);
    requireThat(lease && lease.holder === deviceId && lease.leaseId === request.leaseId && ['pending', 'human'].includes(lease.state), 'invalid_browser_lease');
    if (request.type === 'release') { this.end(lease, 'released'); return { ...lease }; }
    if (request.type === 'renew') { lease.expiresAt = now + this.leaseMs; return { ...lease }; }
    requireThat(lease.state === 'human', 'browser_handoff_pending');
    try { return await this.sessions.humanInput(request.taskId, request.frameId, request.input); }
    catch { throw new Error('Browser input did not confirm completion. Inspect a fresh frame before acting again.'); }
  }

  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const lease of this.leases.values()) this.end(lease, 'expired');
    await Promise.all(this.transitions);
  }
}
