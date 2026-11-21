import { randomUUID, createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { createAgentSession, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { liveEvents, type LiveSink } from '../pi-adapter/live-events.js';
import { SubagentRuns } from '../pi-adapter/subagent-runs.js';
import type { RecordValue } from '../core/contracts.js';
import { managementError } from '../pi-management/contracts.js';
import { PiProfile } from '../pi-management/profile.js';
import { refreshSubscriptionModels } from '../pi-management/subscription-models.js';
import { refreshOllamaModels } from '../pi-management/ollama-access.js';
import { sessionExtensions } from '../pi-management/session-extensions.js';
import { SessionBackground, SessionWorkJournal, within } from '../pi-management/session-background.js';
import { actionFailureMessage, Projection, RunStart, type RunPoll, type ActionRequest } from './contracts.js';

interface PendingAction { input: ActionRequest; resolve: (value: unknown) => void; reject: (error: Error) => void }
interface Run {
  input: RunStart; fingerprint: string; state: RunPoll['state']; error: string | null; sequence: number; seen: number;
  projections: Map<string, Projection>; actions: Map<string, PendingAction>; answered: Set<string>;
  session: AgentSession | undefined; sessionInfo: RunPoll['session']; live: Map<string, RecordValue>; completion?: Promise<void>; settled: boolean; background?: SessionBackground;
}
const cancelled = (run: Run) => run.state === 'cancelled';
const finished = (run: Run) => ['finished','failed','cancelled'].includes(run.state);
export class WorkerRuns {
  private runs = new Map<string, Run>();
  private timer: ReturnType<typeof setInterval>;
  private journal: SessionWorkJournal;
  private closed = false;
  constructor(readonly profile: PiProfile, private workspaceRoot: string, private sessionRoot: string, private sharedWorkspaces = false) {
    if (!isAbsolute(workspaceRoot) || !isAbsolute(sessionRoot)) throw managementError('absolute_worker_roots_required');
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 }); mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    this.workspaceRoot = realpathSync(workspaceRoot); this.sessionRoot = realpathSync(sessionRoot);
    this.journal = new SessionWorkJournal(this.sessionRoot);
    this.timer = setInterval(() => {
      for (const [id, run] of this.runs) if (Date.now() - run.seen > 120000) {
        if (run.settled) this.runs.delete(id);
        else if (!run.background?.nativeActive) void this.abort(id);
      }
    }, 10000);
    this.timer.unref();
  }
  async close(timeoutMs = 5000) {
    this.closed = true;
    clearInterval(this.timer);
    try {
      await within((async () => {
        await Promise.all([...this.runs.keys()].map(id => this.abort(id)));
        await Promise.all([...this.runs.values()].map(run => run.completion));
        if (this.active) throw managementError('worker_native_work_needs_attention');
      })(), timeoutMs);
    } catch { throw managementError('worker_native_work_needs_attention'); }
  }
  private directory(root: string, taskId: string) {
    const path = join(root, taskId);
    mkdirSync(path, { recursive: true, mode: root === this.workspaceRoot && this.sharedWorkspaces ? 0o2770 : 0o700 });
    const actual = realpathSync(path), suffix = relative(root, actual);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw managementError('worker_path_denied');
    return actual;
  }
  private need(id: string) {
    const run = this.runs.get(id);
    if (!run) throw managementError('worker_run_unavailable');
    run.seen = Date.now(); return run;
  }
  get needsAttention() { return this.journal.needsAttention || [...this.runs.values()].some(run => run.background?.needsAttention); }
  get active() { return this.needsAttention || [...this.runs.values()].some(run => !run.settled); }
  start(input: unknown) {
    if (this.closed) throw managementError('worker_closed');
    if (this.profile.maintenance) throw managementError('maintenance_in_progress');
    const request = RunStart.parse(input);
        if (request.mode === 'auto' && this.needsAttention) throw managementError('worker_native_work_needs_attention');
        const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = this.runs.get(request.runId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw managementError('worker_run_conflict');
      return { runId: request.runId };
    }
    if ([...this.runs.values()].some(run => run.input.taskId === request.taskId && !run.settled)) throw managementError('task_already_running');
    if (this.runs.size >= 64) throw managementError('worker_capacity');
    const run: Run = { input: request, fingerprint, state: 'starting', error: null, sequence: 0, seen: Date.now(),
      projections: new Map(), actions: new Map(), answered: new Set(), session: undefined, sessionInfo: null, live: new Map(), settled: false };
    this.runs.set(request.runId, run);
    run.completion = this.execute(run).catch(() => {
      if (run.state !== 'cancelled') { run.state = 'failed'; run.error = 'agent_run_failed_check_provider_and_configuration'; }
    }).finally(() => {
      for (const pending of run.actions.values()) pending.reject(managementError('worker_run_ended'));
      if (run.session) this.journal.releaseOwnership(run.session);
      run.actions.clear(); run.session = undefined; run.settled = true;
    });
    return { runId: request.runId };
  }
  private async execute(run: Run) {
    const { taskId, model: selection } = run.input;
    const cwd = this.directory(this.workspaceRoot, taskId);
    const parent = this.directory(this.sessionRoot, taskId), sessions = join(parent, 'sessions');
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    if (lstatSync(sessions).isSymbolicLink()) throw managementError('worker_path_denied');
    const modelRuntime = await this.profile.runtime();
    if (selection.providerId === 'openai') await refreshSubscriptionModels(modelRuntime);
    if (selection.providerId === 'ollama-cloud') await refreshOllamaModels(modelRuntime);
    const model = (await modelRuntime.getAvailable(selection.providerId, { signal: AbortSignal.timeout(10000) }))
      .find(candidate => candidate.id === selection.modelId);
    if (!model) throw managementError('model_not_available');
    const sessionFile = run.input.sessionFile ? join(sessions, run.input.sessionFile) : undefined;
    if (sessionFile && !lstatSync(sessionFile).isFile()) throw managementError('worker_session_file_denied');
    const manager = sessionFile ? SessionManager.open(sessionFile, sessions, cwd) : SessionManager.create(cwd, sessions);
    const settings = this.profile.settings();
    if (settings.drainErrors().length) throw managementError('pi_settings_invalid');
    settings.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
    const extensions = await sessionExtensions({ cwd, agentDir: this.profile.directory, modelRuntime, mode: run.input.mode, extensionOverrides: run.input.extensionOverrides,
      systemPrompt: `${run.input.systemPrompt}\nThe actual task workspace is ${cwd}.` });
    if (cancelled(run)) return;
    const { session } = await createAgentSession({ cwd, agentDir: this.profile.directory, modelRuntime, model,
      noTools: 'builtin', settingsManager: settings, sessionManager: manager, resourceLoader: extensions.loader,
      customTools: [{ name: 'outpost_action', label: 'Outpost action', description: 'Request an action from the coordinator. Pending actions require owner review.',
        parameters: Type.Object({ tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
        execute: async (_id, input, signal) => {
          const value = z.strictObject({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.json()) }).parse(input);
          if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw managementError('action_arguments_too_large');
          if (run.actions.size >= 32 || signal?.aborted || run.state === 'cancelled') throw managementError('action_unavailable');
          const callId = randomUUID();
          const result = await new Promise<unknown>((resolve, reject) => {
            const cancel = () => { run.actions.delete(callId); reject(managementError('action_cancelled')); };
            signal?.addEventListener('abort', cancel, { once: true });
            const cleanup = () => signal?.removeEventListener('abort', cancel);
            run.actions.set(callId, { input: { callId, ...value }, resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); } });
          });
          const record = z.object({ id: z.string() }).parse(result);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { actionId: record.id } };
        } }] });
    run.session = session; run.background = extensions.background;
    let unsubscribe = () => {}, unobserve = () => {}, claimed = false;
    let subagents: SubagentRuns | undefined;
    try {
      if (extensions.background.enabled) { this.journal.own(session); claimed = true; }
      run.sessionInfo = { id: session.sessionId, file: basename(session.sessionFile ?? '') };
      const sink: LiveSink = {
        snapshot: () => [...run.live.values()],
        publish: (kind, id, data) => this.publish(run, kind, id, data, false),
        finish: (kind, id, data) => this.publish(run, kind, id, data, true),
      };
      subagents = new SubagentRuns(sink, { taskId, sessionId: session.sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}) });
      unobserve = extensions.observeSubagents((name, value) => {
        try { subagents?.extensionEvent(name, value); } catch { subagents?.observationFailed(); }
      });
      unsubscribe = session.subscribe(liveEvents(sink, taskId, session.sessionId, model.id, subagents));
      await extensions.bind(session);
      if (cancelled(run)) { await extensions.background.cancel(); return; }
      run.state = 'running';
      await session.prompt(run.input.prompt, { streamingBehavior: 'followUp' });
      await extensions.background.drain();
      extensions.check();
      const last = session.messages.findLast(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'error') throw managementError('inference_failed');
    } catch (error) {
      if (!cancelled(run)) { run.state = 'failed'; run.error = 'agent_run_failed_check_provider_and_configuration'; }
      await extensions.background.cancel();
      throw error;
    } finally {
      try {
        await extensions.dispose(session);
        if (claimed) this.journal.settled(session);
        extensions.check();
      } finally {
              try { subagents?.close(); } catch { subagents?.observationFailed(); }
              finally { unobserve(); unsubscribe(); }
            }
    }
    if (!cancelled(run)) run.state = 'finished';
  }
  private publish(run: Run, kind: string, id: string, data: RecordValue['data'], final: boolean) {
    // Exception bodies from providers can contain request headers. Public errors use stable codes.
    const clean = { ...data, ...(data.error ? { error: 'provider_request_failed' } : {}) };
    const projection = Projection.parse({ sequence: ++run.sequence, kind, id, data: clean, final });
    if (Buffer.byteLength(JSON.stringify(projection)) > 512 * 1024) throw managementError('worker_projection_too_large');
    const key = `${kind}:${id}`;
    if (!run.projections.has(key) && run.projections.size >= 64) throw managementError('worker_stream_backpressure');
    run.projections.set(key, projection);
    if (final) run.live.delete(key);
    else run.live.set(key, { kind, id, data: clean, revision: 0, updatedAt: new Date().toISOString() });
  }
  poll(id: string, after: number): RunPoll {
    const run = this.need(id);
    if (after > run.sequence) throw managementError('invalid_worker_cursor');
    for (const [key, value] of run.projections) if (value.sequence <= after) run.projections.delete(key);
    const all = [...run.projections.values()].sort((a, b) => a.sequence - b.sequence);
    const projections: Projection[] = []; let bytes = 0;
    for (const projection of all) {
      const size = Buffer.byteLength(JSON.stringify(projection));
      if (bytes + size > 512 * 1024 && projections.length) break;
      bytes += size; projections.push(projection);
    }
    const hasMore = projections.length < all.length;
    return { runId: id, taskId: run.input.taskId, state: run.state, settled: run.settled, needsAttention: this.needsAttention, session: run.sessionInfo, model: run.input.model,
      cursor: hasMore ? projections.at(-1)!.sequence : run.sequence, hasMore, projections,
      actions: [...run.actions.values()].slice(0, 8).map(value => value.input), error: run.error };
  }
  answer(id: string, callId: string, result: unknown, failed: boolean) {
    const run = this.need(id);
    if (run.answered.has(callId)) return { accepted: true };
    const pending = run.actions.get(callId);
    if (!pending || finished(run)) throw managementError('worker_action_unavailable');
    run.actions.delete(callId); run.answered.add(callId);
    if (failed) pending.reject(new Error(actionFailureMessage(result)));
    else pending.resolve(result);
    return { accepted: true };
  }
  async abort(id: string) {
    const run = this.need(id);
    if (run.settled) return { state: run.state };
    run.state = 'cancelled';
    for (const pending of run.actions.values()) pending.reject(managementError('worker_run_cancelled'));
    run.actions.clear();
    try {
      await within(Promise.all([run.session?.abort(), run.background?.cancel()]), 5000);
    } catch { run.error = 'native_work_needs_attention'; }
    return { state: run.state };
  }
  async steer(id: string, text: string) {
    const run = this.need(id);
    if (!run.session || run.state !== 'running') throw managementError('worker_not_running');
    await run.session.steer(text); return { accepted: true };
  }
}
