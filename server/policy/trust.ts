import { createPublicKey, verify, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Mode, autoPolicyVersion, digest, id, requireThat } from '../core/contracts.js';
import type { Data, Json, RecordValue } from '../core/contracts.js';
import { classifyAction, type Classification } from './auto-policy.js';
import { Ledger } from '../core/ledger.js';

export const DEFAULT_APPROVAL_TTL_MS = 30 * 60_000;
export const MIN_APPROVAL_TTL_MS = 60_000;
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export function resolveApprovalTtlMs(raw = process.env.OUTPOST_APPROVAL_TTL_MS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_APPROVAL_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_APPROVAL_TTL_MS;
  return Math.min(MAX_APPROVAL_TTL_MS, Math.max(MIN_APPROVAL_TTL_MS, Math.trunc(parsed)));
}

export interface Device { name: string; publicKey: string; revoked: boolean }
export class Devices {
  constructor(private db: Ledger) {}
  pair(deviceId: string, name: string, publicKey: string) {
    requireThat(Buffer.from(publicKey,'base64').length === 32,'invalid_key');
    return this.db.put('device',deviceId,0,{ name, publicKey, revoked: false });
  }
  authenticate(deviceId: string, bytes: Buffer, signature: string) {
    const device = this.db.need<Device>('device',deviceId);
    requireThat(!device.data.revoked,'revoked_device');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(device.data.publicKey,'base64')]), format: 'der', type: 'spki' });
    requireThat(verify(null,bytes,key,Buffer.from(signature,'base64')),'invalid_signature');
  }
  revoke(deviceId: string, expected: number) { const device = this.db.need<Device>('device',deviceId); return this.db.put('device',deviceId,expected,{ ...device.data, revoked: true }); }
}
export interface Policy { mode: z.infer<typeof Mode> }
export interface Action {
  taskId: string; tool: string; toolVersion: number; arguments: Data; target: string; identityRef: string;
  effects: string[]; policyVersion: number; expiresAt: number; actionDigest: string;
  state: 'pending' | 'authorized' | 'denied' | 'dispatching' | 'succeeded' | 'failed' | 'unknown';
  nonce: string; review: string; decidedBy: string | null; result: Json;
    autoPolicyVersion?: number; classification?: Classification;
}
export interface Tool {
  version: number; effects: string[];
  inputSchema?: Record<string, unknown>;
  description?: string;
  parse(input: unknown): Data;
  target(args: Data): string;
  execute(args: Data, signal: AbortSignal): Promise<Json>;
}

export class Gate {
  private tools = new Map<string,Tool>();
  private running = new Map<string,AbortController>();
  private waiters = new Map<string, (error?: Error) => void>();
  private runtimeTasks = new Set<string>();
  startRuntime(taskId: string) { requireThat(!this.runtimeTasks.has(taskId), 'pi_already_running'); this.runtimeTasks.add(taskId); }
  finishRuntime(taskId: string) { this.runtimeTasks.delete(taskId); }
  constructor(readonly db: Ledger, private allowHostAdministration = false, private assertDispatch: () => void = () => {}, private runtimeActive: (taskId: string) => boolean = () => false) {}
  private notify(actionId: string, error?: Error) { this.waiters.get(actionId)?.(error); }
  isActive(taskId: string) {
    return this.runtimeTasks.has(taskId) || [...this.running.keys(), ...this.waiters.keys()].some(key => this.db.need<Action>('action', key).data.taskId === taskId);
  }
  register(name: string, tool: Tool) { requireThat(!this.tools.has(name),'duplicate_tool'); this.tools.set(name,tool); }
  catalogue() { return [...this.tools].map(([name,tool]) => ({ name, version: tool.version, effects: tool.effects, ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}), ...(tool.description ? { description: tool.description } : {}) })); }
  policy(taskId: string) {
    const policy = this.db.need<Policy>('policy',taskId), mode = Mode.parse(policy.data.mode);
    return policy.data.mode === mode ? policy : this.db.put('policy',taskId,policy.revision,{ ...policy.data,mode },'policy.normalized');
  }
  changePolicy(taskId: string, expected: number, mode: unknown) {
    const parsed = Mode.parse(mode), previous = this.db.get<Policy>('policy', taskId);
    requireThat((previous?.revision ?? 0) === expected, 'stale_revision');
    if (previous) {
      const state = this.db.get('task', taskId)?.data.state;
      requireThat(!this.runtimeActive(taskId) && !this.isActive(taskId) && !['running', 'waiting_for_approval'].includes(String(state)), 'mode_change_requires_stopped');
    }
    const result = this.db.put('policy',taskId,expected,{ mode: parsed });
    // A new policy never adopts or escalates old pending/authorized work.
    if (previous) this.stop(taskId);
    return result;
  }
  private current(action: Action) {
    requireThat(action.expiresAt > Date.now(),'expired_action');
    requireThat(this.policy(action.taskId).revision === action.policyVersion,'stale_policy');
    const task = this.db.get<{ state: string }>('task',action.taskId);
    requireThat(!task || !['paused','cancelled','failed','completed','interrupted','reconciling'].includes(task.data.state),'task_not_dispatchable');
    this.assertDispatch();
    const recovery = this.db.get('recovery', 'server');
    requireThat(!recovery || recovery.data.dispatchEnabled === true, 'recovery_dispatch_disabled');
    const tool = this.tools.get(action.tool);
    requireThat(tool && tool.version === action.toolVersion,'tool_changed');
    requireThat(action.identityRef === 'agent-local','identity_not_delegated');
    requireThat(!/^(trust|payment|owner)\./.test(action.tool) && !action.effects.some(effect => /^(trust|payment|owner)\./.test(effect) || (effect.startsWith('host.') && !this.allowHostAdministration)),'protected_effect');
    requireThat(digest(tool.effects) === digest(action.effects), 'tool_changed');
    const { state: _state, nonce: _nonce, review: _review, decidedBy: _device, result: _result, actionDigest, ...envelope } = action;
    requireThat(digest(envelope) === actionDigest, 'action_changed');
    requireThat(digest(tool.parse(action.arguments)) === digest(action.arguments), 'arguments_changed');
    if (action.decidedBy) requireThat(!this.db.need<Device>('device', action.decidedBy).data.revoked, 'revoked_device');
    if (this.policy(action.taskId).data.mode === 'auto') {
      requireThat(action.autoPolicyVersion === autoPolicyVersion, 'stale_auto_policy');
      if (action.state !== 'pending' && !action.decidedBy) requireThat(classifyAction(tool, action.arguments) === 'routine', 'approval_required');
    }
    return tool;
  }
  async propose(taskId: string, name: string, input: unknown, operationId: string = id()) {
    const tool = this.tools.get(name); requireThat(tool,'unavailable_tool');
    const args = tool.parse(input), policy = this.policy(taskId);
    const classification = policy.data.mode === 'auto' ? classifyAction(tool, args) : undefined;
    const envelope = { taskId, tool: name, toolVersion: tool.version, arguments: args, target: tool.target(args), identityRef: 'agent-local', effects: tool.effects, policyVersion: policy.revision, expiresAt: Date.now() + resolveApprovalTtlMs(),
      ...(classification ? { autoPolicyVersion, classification } : {}) };
    const pending = classification !== undefined && classification !== 'routine';
    const action: Action = { ...envelope, actionDigest: digest(envelope), state: pending ? 'pending' : 'authorized', nonce: randomBytes(32).toString('hex'), review: pending ? `Auto requires exact approval: ${classification}` : classification ? 'Proven routine built-in action' : 'Within scoped full control', decidedBy: null, result: null };
    return this.db.transaction(() => {
      this.current(action);
      const record = this.db.put('action',operationId,0,action,'action.proposed');
      if (pending) {
        this.db.put('inbox', record.id, 0, { taskId, actionId: record.id, category: 'approval', state: 'pending' });
        this.db.enqueue('notice', { taskId, noticeId: record.id }, `notice:${record.id}`);
        const task = this.db.get('task', taskId);
        if (task) this.db.put('task', taskId, task.revision, { ...task.data, state: 'waiting_for_approval', blocker: action.review });
      }
      return record;
    });
  }
  decide(actionId: string, expected: number, deviceId: string, input: unknown) {
    const value = z.strictObject({ nonce: z.string(), actionDigest: z.string(), decision: z.enum(['approve', 'deny']) }).parse(input);
    const updated = this.db.transaction(() => {
      const record = this.db.need<Action>('action', actionId);
      requireThat(record.revision === expected, 'stale_revision');
      requireThat(record.data.state === 'pending', 'approval_not_pending');
      requireThat(value.nonce === record.data.nonce && value.actionDigest === record.data.actionDigest, 'approval_mismatch');
      requireThat(!this.db.need<Device>('device', deviceId).data.revoked, 'revoked_device');
      this.current(record.data);
      const next = this.db.put<Action>('action', actionId, expected, { ...record.data, state: value.decision === 'approve' ? 'authorized' : 'denied', decidedBy: deviceId }, 'approval.decided');
      this.resolveNotice(actionId, value.decision);
      if (value.decision === 'approve') this.db.enqueue('action.dispatch', { taskId: record.data.taskId, actionId }, `approval:${actionId}`);
      else this.resumeAfterReview(record.data.taskId);
      return next;
    });
    this.notify(actionId);
    return updated;
  }
  private resolveNotice(actionId: string, resolution: string) {
    const notice = this.db.get('inbox', actionId);
    if (notice?.data.state === 'pending') this.db.put('inbox', actionId, notice.revision, { ...notice.data, state: 'resolved', resolution });
    this.db.db.prepare("UPDATE outbox SET state='done' WHERE topic='notice' AND state='pending' AND json_extract(payload,'$.noticeId')=?").run(actionId);
  }
  private resumeAfterReview(taskId: string) {
    const task = this.db.get('task', taskId);
    if (task?.data.state === 'waiting_for_approval' && !this.db.list<Action>('action').some(record => record.data.taskId === taskId && ['pending', 'authorized', 'dispatching'].includes(record.data.state)))
      this.db.put('task', taskId, task.revision, { ...task.data, state: this.runtimeActive(taskId) || this.isActive(taskId) ? 'running' : 'verifying', blocker: null });
  }
  async awaitDecisionAndDispatch(actionId: string, signal?: AbortSignal): Promise<RecordValue<Action>> {
    requireThat(!signal?.aborted, 'action_cancelled');
    const initial = this.db.need<Action>('action', actionId);
    if (initial.data.state === 'authorized' && !initial.data.decidedBy) return this.dispatch(actionId);
    requireThat(!this.waiters.has(actionId), 'action_already_waiting');
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const clearExpiry = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      };
      const cleanup = () => {
        clearExpiry();
        signal?.removeEventListener('abort', abort);
        unsubscribe?.();
        unsubscribe = undefined;
        this.waiters.delete(actionId);
      };
      const finish = (error?: Error, record?: RecordValue<Action>) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(record!);
      };
      const scheduleExpiry = (expiresAt: number) => {
        clearExpiry();
        const remaining = Math.min(MAX_TIMEOUT_MS, Math.max(1, expiresAt - Date.now()));
        timer = setTimeout(check, remaining);
      };
      const abort = () => { this.stop(initial.data.taskId); };
      const check = () => {
        if (settled) return;
        try {
          const record = this.db.need<Action>('action', actionId);
          if (['succeeded', 'failed', 'unknown', 'denied'].includes(record.data.state)) { finish(undefined, record); return; }
          if (record.data.state !== 'dispatching') {
            this.current(record.data);
            scheduleExpiry(record.data.expiresAt);
          } else {
            clearExpiry();
          }
        } catch (error) {
          if (settled) return;
          settled = true;
          try { this.retire(actionId, 'Approval expired or authority changed; explicitly replan without replay.'); }
          finally { cleanup(); reject(error instanceof Error ? error : new Error('approval_unavailable')); }
        }
      };
      this.waiters.set(actionId, error => { if (error) finish(error); else check(); });
      unsubscribe = this.db.onChange(changes => {
        if (changes.some(change =>
          (change.kind === 'action' && change.id === actionId) ||
          ((change.kind === 'policy' || change.kind === 'task') && change.id === initial.data.taskId) ||
          change.kind === 'recovery' ||
          change.kind === 'runtime_update' ||
          change.kind === 'device'
        )) check();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }
  private retire(actionId: string, reason: string, notifyWaiter = true) {
    const record = this.db.need<Action>('action', actionId);
    if (['pending', 'authorized'].includes(record.data.state)) {
      this.db.put('action', actionId, record.revision, { ...record.data, state: 'denied', review: reason }, 'action.retired');
      this.resolveNotice(actionId, reason);
      this.resumeAfterReview(record.data.taskId);
      if (notifyWaiter) this.notify(actionId);
    }
  }
  async dispatch(actionId: string): Promise<RecordValue<Action>> {
    let claim: { tool: Tool; record: RecordValue<Action> };
    try {
      claim = this.db.transaction(() => {
        const record = this.db.need<Action>('action',actionId);
        requireThat(record.data.state === 'authorized','not_authorized');
        const tool = this.current(record.data);
        return { tool, record: this.db.put('action',actionId,record.revision,{ ...record.data,state: 'dispatching' as const },'action.dispatched') };
      });
    } catch (error) {
      this.notify(actionId);
      throw error;
    }
    this.notify(actionId);
    const controller = new AbortController(); this.running.set(actionId,controller);
    try {
      const result = await claim.tool.execute(claim.record.data.arguments,controller.signal);
      return this.db.transaction(() => this.db.put<Action>('action',actionId,claim.record.revision,{ ...claim.record.data,state: 'succeeded',result },'action.observed'));
    } catch (error) {
      return this.db.transaction(() => this.db.put<Action>('action',actionId,claim.record.revision,{ ...claim.record.data,state: 'unknown',result: { error: 'Execution interrupted or failed; inspect evidence before retrying',detail: error instanceof Error ? error.message.slice(0,2000) : 'Unknown execution failure' } },'action.reconciliation_required'));
    } finally {
      this.running.delete(actionId);
      this.resumeAfterReview(claim.record.data.taskId);
      this.notify(actionId);
    }
  }
  stop(taskId: string) {
    for (const [actionId,controller] of this.running) if (this.db.need<Action>('action',actionId).data.taskId === taskId) controller.abort();
    for (const action of this.db.list<Action>('action')) if (action.data.taskId === taskId) {
      const waiter = this.waiters.get(action.id);
      this.db.transaction(() => {
        this.retire(action.id, 'Task stopped or policy changed; request a fresh action after explicit resume.', false);
        waiter?.(new Error('action_cancelled'));
      });
    }
  }
}
