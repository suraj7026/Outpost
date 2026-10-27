import { createPublicKey, verify, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Mode, digest, id, requireThat } from '../core/contracts.js';
import type { Data, Json } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';

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
}
export interface Tool {
  version: number; effects: string[];
  parse(input: unknown): Data;
  target(args: Data): string;
  execute(args: Data, signal: AbortSignal): Promise<Json>;
}
export interface Review { actionDigest: string; policyVersion: number; decision: 'allow' | 'ask'; summary: string }
export type Reviewer = (action: Readonly<Action>) => Promise<unknown>;
const ReviewSchema = z.strictObject({ actionDigest: z.string(), policyVersion: z.number().int(), decision: z.enum(['allow','ask']), summary: z.string().min(1).max(500) });

export class Gate {
  private tools = new Map<string,Tool>();
  private running = new Map<string,AbortController>();
  constructor(readonly db: Ledger, private reviewer?: Reviewer) {}
  register(name: string, tool: Tool) { requireThat(!this.tools.has(name),'duplicate_tool'); this.tools.set(name,tool); }
  catalogue() { return [...this.tools].map(([name,tool]) => ({ name, version: tool.version, effects: tool.effects })); }
  policy(taskId: string) { return this.db.need<Policy>('policy',taskId); }
  changePolicy(taskId: string, expected: number, mode: unknown) { return this.db.put('policy',taskId,expected,{ mode: Mode.parse(mode) }); }
  private current(action: Action) {
    requireThat(action.expiresAt > Date.now(),'expired_action');
    requireThat(this.policy(action.taskId).revision === action.policyVersion,'stale_policy');
    const task = this.db.get<{ state: string }>('task',action.taskId);
    requireThat(!task || !['paused','cancelled','failed','completed','interrupted'].includes(task.data.state),'task_not_dispatchable');
    const tool = this.tools.get(action.tool);
    requireThat(tool && tool.version === action.toolVersion,'tool_changed');
    requireThat(action.identityRef === 'agent-local','identity_not_delegated');
    requireThat(!action.effects.some(effect => /^(trust|payment|owner|host)\./.test(effect)),'protected_effect');
    return tool;
  }
  async propose(taskId: string, name: string, input: unknown) {
    const tool = this.tools.get(name); requireThat(tool,'unavailable_tool');
    const args = tool.parse(input), policy = this.policy(taskId);
    const envelope = { taskId, tool: name, toolVersion: tool.version, arguments: args, target: tool.target(args), identityRef: 'agent-local', effects: tool.effects, policyVersion: policy.revision, expiresAt: Date.now()+300_000 };
    const action: Action = { ...envelope, actionDigest: digest(envelope), state: 'pending', nonce: randomBytes(32).toString('hex'), review: 'Owner decision required', decidedBy: null, result: null };
    this.current(action);
    if (policy.data.mode === 'full_control') { action.state = 'authorized'; action.review = 'Within scoped full control'; }
    if (policy.data.mode === 'auto' && this.reviewer) {
      try {
        const result = ReviewSchema.parse(await Promise.race([this.reviewer(structuredClone(action)),new Promise((_,reject) => { const timer = setTimeout(() => reject(Error('review timeout')),10_000); timer.unref(); })]));
        requireThat(result.actionDigest === action.actionDigest && result.policyVersion === action.policyVersion,'invalid_review_binding');
        action.review = result.summary;
        if (result.decision === 'allow' && !action.effects.includes('unknown')) action.state = 'authorized';
      } catch { action.review = 'Reviewer unavailable or invalid; owner decision required'; }
    }
    return this.db.transaction(() => {
      this.current(action);
      const record = this.db.put('action',id(),0,action,'action.proposed');
      if (action.state === 'pending') {
        this.db.put('inbox',record.id,0,{ taskId, category: 'approval', state: 'pending', title: 'An action needs your decision' });
        this.db.enqueue('notice',{ noticeId: record.id, taskId },record.id);
      }
      return record;
    });
  }
  decide(actionId: string, expected: number, nonce: string, hash: string, decision: 'approve' | 'deny', deviceId: string) {
    const record = this.db.need<Action>('action',actionId), action = record.data;
    this.current(action);
    requireThat(action.nonce === nonce && action.actionDigest === hash,'changed_request');
    if (action.state !== 'pending') return record;
    const updated = this.db.put('action',actionId,expected,{ ...action, state: decision === 'approve' ? 'authorized' : 'denied', decidedBy: deviceId },'approval.resolved');
    const notice = this.db.need('inbox',actionId); this.db.put('inbox',actionId,notice.revision,{ ...notice.data,state: 'resolved' });
    return updated;
  }
  async dispatch(actionId: string) {
    const claim = this.db.transaction(() => {
      const record = this.db.need<Action>('action',actionId);
      requireThat(record.data.state === 'authorized','not_authorized');
      const tool = this.current(record.data);
      return { tool, record: this.db.put('action',actionId,record.revision,{ ...record.data,state: 'dispatching' as const },'action.dispatched') };
    });
    const controller = new AbortController(); this.running.set(actionId,controller);
    try {
      const result = await claim.tool.execute(claim.record.data.arguments,controller.signal);
      return this.db.transaction(() => this.db.put('action',actionId,claim.record.revision,{ ...claim.record.data,state: 'succeeded',result },'action.observed'));
    } catch {
      return this.db.transaction(() => this.db.put('action',actionId,claim.record.revision,{ ...claim.record.data,state: 'unknown',result: { error: 'Execution interrupted or failed; inspect evidence before retrying' } },'action.reconciliation_required'));
    } finally { this.running.delete(actionId); }
  }
  stop(taskId: string) {
    for (const [actionId,controller] of this.running) if (this.db.need<Action>('action',actionId).data.taskId === taskId) controller.abort();
  }
}
