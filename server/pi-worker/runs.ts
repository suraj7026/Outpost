import { randomUUID, createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { createAgentSession, createExtensionRuntime, SessionManager, type AgentSession, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { liveEvents, type LiveSink } from '../pi-adapter/live-events.js';
import type { RecordValue } from '../core/contracts.js';
import { managementError } from '../pi-management/contracts.js';
import { PiProfile } from '../pi-management/profile.js';
import { Projection, RunStart, type RunPoll, type ActionRequest } from './contracts.js';

interface PendingAction { input: ActionRequest; resolve: (value: unknown) => void; reject: (error: Error) => void }
interface Run {
  input: RunStart; fingerprint: string; state: RunPoll['state']; error: string | null; sequence: number; seen: number;
  projections: Map<string, Projection>; actions: Map<string, PendingAction>; answered: Set<string>;
  session: AgentSession | undefined; sessionInfo: RunPoll['session']; live: Map<string, RecordValue>;
}
const cancelled = (run: Run) => run.state === 'cancelled';
const finished = (run: Run) => ['finished','failed','cancelled'].includes(run.state);
export class WorkerRuns {
  private runs = new Map<string, Run>();
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly profile: PiProfile, private workspaceRoot: string, private sessionRoot: string) {
    if (!isAbsolute(workspaceRoot) || !isAbsolute(sessionRoot)) throw managementError('absolute_worker_roots_required');
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 }); mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    this.workspaceRoot = realpathSync(workspaceRoot); this.sessionRoot = realpathSync(sessionRoot);
    this.timer = setInterval(() => {
      for (const [id, run] of this.runs) if (Date.now() - run.seen > 120000) {
        void this.abort(id);
        if (finished(run)) this.runs.delete(id);
      }
    }, 10000);
    this.timer.unref();
  }
  async close() { clearInterval(this.timer); await Promise.all([...this.runs.keys()].map(id => this.abort(id))); }
  private directory(root: string, taskId: string) {
    const path = join(root, taskId);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const actual = realpathSync(path), suffix = relative(root, actual);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw managementError('worker_path_denied');
    return actual;
  }
  private need(id: string) {
    const run = this.runs.get(id);
    if (!run) throw managementError('worker_run_unavailable');
    run.seen = Date.now(); return run;
  }
  start(input: unknown) {
    const request = RunStart.parse(input), fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = this.runs.get(request.runId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw managementError('worker_run_conflict');
      return { runId: request.runId };
    }
    if ([...this.runs.values()].some(run => run.input.taskId === request.taskId && !finished(run))) throw managementError('task_already_running');
    if (this.runs.size >= 64) throw managementError('worker_capacity');
    const run: Run = { input: request, fingerprint, state: 'starting', error: null, sequence: 0, seen: Date.now(),
      projections: new Map(), actions: new Map(), answered: new Set(), session: undefined, sessionInfo: null, live: new Map() };
    this.runs.set(request.runId, run);
    void this.execute(run).catch(() => {
      if (run.state !== 'cancelled') { run.state = 'failed'; run.error = 'agent_run_failed_check_provider_and_configuration'; }
    }).finally(() => {
      for (const pending of run.actions.values()) pending.reject(managementError('worker_run_ended'));
      run.actions.clear(); run.session?.dispose(); run.session = undefined;
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
    const model = (await modelRuntime.getAvailable(selection.providerId, { signal: AbortSignal.timeout(10000) }))
      .find(candidate => candidate.id === selection.modelId);
    if (!model) throw managementError('model_not_available');
    const sessionFile = run.input.sessionFile ? join(sessions, run.input.sessionFile) : undefined;
    if (sessionFile && !lstatSync(sessionFile).isFile()) throw managementError('worker_session_file_denied');
    const manager = sessionFile ? SessionManager.open(sessionFile, sessions, cwd) : SessionManager.create(cwd, sessions);
    const settings = this.profile.settings();
    if (settings.drainErrors().length) throw managementError('pi_settings_invalid');
    settings.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
    // Resource discovery stays disabled until staged provider-package generations are implemented.
    // This must never fall back to discovering the worker user's or task directory's extensions.
    const loader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => run.input.systemPrompt, getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    };
    if (cancelled(run)) return;
    const { session } = await createAgentSession({ cwd, agentDir: this.profile.directory, modelRuntime, model,
      tools: ['outpost_action'], settingsManager: settings, sessionManager: manager, resourceLoader: loader,
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
    run.session = session;
    if (cancelled(run)) { await session.abort(); return; }
    if (!session.getActiveToolNames().includes('outpost_action')) throw managementError('action_tool_missing');
    run.sessionInfo = { id: session.sessionId, file: basename(session.sessionFile ?? '') }; run.state = 'running';
    const sink: LiveSink = {
      snapshot: () => [...run.live.values()],
      publish: (kind, id, data) => this.publish(run, kind, id, data, false),
      finish: (kind, id, data) => this.publish(run, kind, id, data, true),
    };
    const unsubscribe = session.subscribe(liveEvents(sink, taskId, session.sessionId, model.id));
    try {
      await session.prompt(run.input.prompt);
      const last = session.messages.findLast(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'error') throw managementError('inference_failed');
      if (!cancelled(run)) run.state = 'finished';
    } finally { unsubscribe(); }
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
    return { runId: id, taskId: run.input.taskId, state: run.state, session: run.sessionInfo, model: run.input.model,
      cursor: hasMore ? projections.at(-1)!.sequence : run.sequence, hasMore, projections,
      actions: [...run.actions.values()].slice(0, 8).map(value => value.input), error: run.error };
  }
  answer(id: string, callId: string, result: unknown, failed: boolean) {
    const run = this.need(id);
    if (run.answered.has(callId)) return { accepted: true };
    const pending = run.actions.get(callId);
    if (!pending || finished(run)) throw managementError('worker_action_unavailable');
    run.actions.delete(callId); run.answered.add(callId);
    if (failed) pending.reject(managementError('coordinator_action_failed'));
    else pending.resolve(result);
    return { accepted: true };
  }
  async abort(id: string) {
    const run = this.need(id);
    if (finished(run)) return { state: run.state };
    run.state = 'cancelled';
    for (const pending of run.actions.values()) pending.reject(managementError('worker_run_cancelled'));
    run.actions.clear(); await run.session?.abort(); return { state: run.state };
  }
  async steer(id: string, text: string) {
    const run = this.need(id);
    if (!run.session || run.state !== 'running') throw managementError('worker_not_running');
    await run.session.steer(text); return { accepted: true };
  }
}
