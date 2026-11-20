import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { digest, requireThat, Fault } from '../core/contracts.js';
import { Gate } from '../policy/trust.js';
import { LiveFeed } from '../gateway/live.js';
import type { Task } from '../tasks/tasks.js';
import { ModelRef } from '../pi-management/contracts.js';
import { Projection, RunPoll } from '../pi-worker/contracts.js';
import { interruptedSubagent } from './subagent-contract.js';
import { WorkerClient } from '../pi-worker/client.js';
import { outpostSystemPrompt } from './system-prompt.js';

// Keep the poll envelope/actions strict; child display frames are validated separately.
const ObservedRunPoll = RunPoll.extend({ projections: z.array(z.unknown()).max(64) });
const ChildDisplay = z.object({ kind: z.literal('subagent_run') });
const ChildIdentity = z.object({ id: z.string(), data: z.object({
  taskId: z.string(), parentSessionId: z.string(), parentCallId: z.string(), parentToolId: z.string(),
}) });

export class RemotePiRuntime {
  private current: { taskId: string; runId: string; model: ModelRef; cancelled: boolean } | undefined;
  private needsAttention = false;
  private async settleAbort(runId: string) {
    this.needsAttention = true;
    try {
      await this.worker.request({ type: 'run.abort', runId });
      const deadline = Date.now() + 5000;
      for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
        const poll = ObservedRunPoll.parse(await this.worker.request({ type: 'run.poll', runId, after: 0 }));
        requireThat(poll.runId === runId, 'worker_run_mismatch');
        if (poll.needsAttention) return;
        if (poll.settled === true) { this.needsAttention = false; return; }
        if (poll.settled === undefined) return; // Older workers cannot attest native cleanup.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch { /* Keep the mode-change fence until native cleanup can be established. */ }
  }
  constructor(private db: Ledger, private gate: Gate, private worker: WorkerClient, private live: LiveFeed) {}
  isActive(taskId: string) { return this.current?.taskId === taskId || this.needsAttention; }
  canSteer(model: ModelRef) { return this.current?.model.providerId === model.providerId && this.current.model.modelId === model.modelId; }
  async run(taskId: string, prompt: string, selection: ModelRef) {
    requireThat(!this.current && !this.needsAttention, 'pi_already_running');
    const model = ModelRef.parse(selection), run = { taskId, runId: randomUUID(), model, cancelled: false };
    this.gate.startRuntime(taskId);
    this.current = run;
    const previous = this.db.get<{ file: string }>('pi_session', taskId);
    const operations = new Map<string, { fingerprint: string; done: Promise<void> }>();
    const observations = new Map<string, Projection>();
    const rejectChildDisplay = (value: unknown, sessionId: string | undefined) => {
      const identity = ChildIdentity.safeParse(value);
      if (!identity.success) return;
      const { id, data } = identity.data, known = observations.get(id);
      if (!known || data.taskId !== taskId || data.parentSessionId !== sessionId ||
        data.taskId !== known.data.taskId || data.parentSessionId !== known.data.parentSessionId ||
        data.parentCallId !== known.data.parentCallId || data.parentToolId !== known.data.parentToolId) return;
      // Reuse only previously validated content/identity, never fields from the rejected payload.
      const incomplete = { ...known, data: { ...known.data, ...interruptedSubagent(known.data) } };
      observations.set(id, incomplete);
      if (known.final) this.live.finish('subagent_run', id, incomplete.data);
      else this.live.publish('subagent_run', id, incomplete.data);
    };
    let cursor = 0;
    try {
      await this.worker.request({ type: 'run.start', runId: run.runId, taskId, model, prompt,
        mode: this.gate.policy(taskId).data.mode,
        systemPrompt: outpostSystemPrompt(this.gate.catalogue(), undefined, this.gate.policy(taskId).data.mode),
        ...(previous?.data.file ? { sessionFile: basename(previous.data.file) } : {}) });
      if (run.cancelled) { this.gate.stop(taskId); await this.settleAbort(run.runId); }
      while (true) {
        const poll = ObservedRunPoll.parse(await this.worker.request({ type: 'run.poll', runId: run.runId, after: cursor }));
        requireThat(poll.taskId === taskId && poll.runId === run.runId && poll.model.providerId === model.providerId && poll.model.modelId === model.modelId, 'worker_run_mismatch');
        const projections = poll.projections.map(value => ({ value, frame: ChildDisplay.safeParse(value).success
          ? Projection.safeParse(value).data : Projection.parse(value) }));
        if (poll.session && this.db.get('pi_session', taskId)?.data.sessionId !== poll.session.id) {
          const saved = this.db.get('pi_session', taskId);
          this.db.put('pi_session', taskId, saved?.revision ?? 0, { file: poll.session.file, sessionId: poll.session.id,
            adapterVersion: 2, workerRunId: run.runId, provider: model.providerId, model: model.modelId });
        }
        for (const { value, frame } of projections) {
          if (!frame) { rejectChildDisplay(value, poll.session?.id); continue; }
          if (frame.kind === 'subagent_run') {
            if (frame.data.taskId !== taskId || !poll.session || frame.data.parentSessionId !== poll.session.id ||
              frame.data.parentToolId !== digest({ sessionId: poll.session.id, callId: frame.data.parentCallId }) ||
              frame.id !== digest({ kind: 'subagent_run', sessionId: poll.session.id, callId: frame.data.parentCallId })) {
              rejectChildDisplay(value, poll.session?.id); continue;
            }
            observations.set(frame.id, frame);
          } else requireThat(frame.data.taskId === taskId, 'worker_projection_scope');
          if (frame.final) this.live.finish(frame.kind, frame.id, frame.data);
          else this.live.publish(frame.kind, frame.id, frame.data);
        }
        cursor = poll.cursor;
        for (const action of poll.actions) {
          const fingerprint = digest(action);
          const existing = operations.get(action.callId);
          requireThat(!existing || existing.fingerprint === fingerprint, 'worker_action_conflict');
          if (existing || run.cancelled) continue;
          const done = (async () => {
            let result: unknown = null, failed = false;
            try {
              const proposed = await this.gate.propose(taskId, action.tool, action.arguments);
              result = await this.gate.awaitDecisionAndDispatch(proposed.id);
            } catch (error) {
              failed = true;
              result = { code: error instanceof z.ZodError ? 'invalid_tool_arguments' : error instanceof Fault && error.code === 'unavailable_tool' ? 'unavailable_tool' : 'coordinator_action_failed' };
            }
            if (!run.cancelled) await this.worker.request({ type: 'run.action-result', runId: run.runId,
              callId: action.callId, result: z.json().parse(result), failed });
          })();
          // A delivery failure must interrupt this run, never rerun the action.
          void done.catch(() => { run.cancelled = true; void this.worker.request({ type: 'run.abort', runId: run.runId }).catch(() => {}); });
          operations.set(action.callId, { fingerprint, done });
        }
        if (poll.state === 'failed') throw new Error('Pi worker inference failed; inspect provider status.');
        if (poll.state === 'cancelled' || run.cancelled) throw new Error('Pi worker run interrupted.');
        if (poll.state === 'finished' && !poll.hasMore) {
                  requireThat(!this.db.list('action').some(record => record.data.taskId === taskId && record.data.state === 'pending'), 'worker_finished_with_pending_action');
                  break;
                }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await Promise.all([...operations.values()].map(value => value.done));
      const task = this.db.need<Task>('task', taskId);
      if (!['paused','cancelled'].includes(task.data.state)) {
        this.db.put('task', taskId, task.revision, { ...task.data, state: 'verifying',
          blocker: 'Run finished. Review the evidence or send the next instruction.' });
      }
    } catch (error) {
      run.cancelled = true;
      this.gate.stop(taskId);
      await this.settleAbort(run.runId);
      throw error;
    } finally {
      await Promise.allSettled([...operations.values()].map(value => value.done));
      this.live.interrupt(taskId); this.current = undefined; this.gate.finishRuntime(taskId);
    }
  }
  async abort(taskId: string) {
    this.gate.stop(taskId);
    if (this.current?.taskId === taskId) {
      this.current.cancelled = true;
      await this.settleAbort(this.current.runId);
    }
  }
  async steer(taskId: string, text: string) {
    if (this.current?.taskId === taskId) await this.worker.request({ type: 'run.steer', runId: this.current.runId, text });
  }
}
