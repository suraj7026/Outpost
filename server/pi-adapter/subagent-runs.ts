import { z } from 'zod';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { digest } from '../core/contracts.js';
import type { LiveSink } from './live-events.js';
import { SubagentRun, subagentRecordBytes, type SubagentActivity, type SubagentState } from './subagent-contract.js';
import { SubagentPrivacy, object, array, time, nativeId, relativeFile, sensitiveToolArguments } from './subagent-privacy.js';
import { readObservedAsyncStatus, readChildTranscript, type TranscriptLink, type TranscriptCursor } from './subagent-transcript.js';

interface ObservedRun {
  id: string; data: SubagentRun; privacy: SubagentPrivacy; terminal: boolean; last?: string;
  links: Map<string, { link: TranscriptLink; cursor: TranscriptCursor; complete: boolean }>;
  aliases: Map<string, string>;
  statuses: Map<string, { directory: string; lastRead: number; available: boolean }>;
  missing: boolean;
  tools: Map<string, boolean>;
}
export interface SubagentContext { taskId: string; sessionId: string; sessionFile?: string; secrets?: readonly string[] }
const active = (state: SubagentState) => state === 'running' || state === 'queued' || state === 'unknown';
const publicError = 'subagent_execution_failed';
const wire = (value: SubagentRun) => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));

function outcome(value: Record<string, unknown>, terminal: boolean, native = false): SubagentState {
  const execution = object(value.execution), states = [value.state, value.status, execution.status];
  if (value.stopped === true || execution.stopped === true || states.includes('stopped')) return 'stopped';
  if (value.interrupted === true || value.detached === true || value.timedOut === true || execution.interrupted === true || execution.detached === true || execution.timedOut === true || value.processSignal || execution.processSignal || states.some(state => ['partial', 'paused', 'detached', 'interrupted'].includes(String(state)))) return 'partial';
  if (states.some(state => ['failed', 'rejected', 'error'].includes(String(state))) || terminal && (value.success === false || execution.success === false || value.error || execution.error || typeof value.exitCode === 'number' && value.exitCode !== 0)) return 'failed';
  if (states.includes('pending') || states.includes('queued')) return 'queued';
  if (states.includes('running') || states.includes('started')) return 'running';
  if (terminal && (value.exitCode === 0 || native && (states.includes('complete') || states.includes('completed') || value.success === true))) return 'completed';
  return 'unknown';
}

/** Session-scoped passive reducer. It never invokes tools/RPC, discovers jobs, or controls children. */
export class SubagentRuns {
  private calls = new Map<string, ObservedRun>();
  private runs = new Map<string, ObservedRun>();
  private pending = new Map<string, { name: string; value: unknown }[]>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private sink: LiveSink, private context: SubagentContext) {}
  toolArguments(value: unknown) { return new SubagentPrivacy(this.context.secrets).arguments(value); }
  toolOutput(value: unknown) { return new SubagentPrivacy(this.context.secrets).text(value, 16000); }
  private watch() {
    if (!this.timer) { this.timer = setInterval(() => {
      try { this.refresh(); } catch { this.observationFailed(); }
    }, 1000); this.timer.unref(); }
  }
  observationFailed() {
    for (const run of this.calls.values()) {
      run.missing = true;
      if (!run.terminal) run.data.state = 'unknown';
      for (const child of run.data.children ?? []) if (active(child.state)) child.state = 'unknown';
      try { this.emit(run); } catch { /* A failed sink must not escape into native execution. */ }
    }
  }

  private newRun(callId: string, args: Record<string, unknown>) {
    const privacy = new SubagentPrivacy(this.context.secrets), agent = privacy.text(args.agent, 128);
    const data: SubagentRun = { taskId: this.context.taskId, parentSessionId: this.context.sessionId, parentCallId: callId,
      parentToolId: digest({ sessionId: this.context.sessionId, callId }), label: agent ?? (args.workflow ? 'Workflow' : 'Subagent'),
      executionMode: args.async === true ? 'background' : args.async === false ? 'foreground' : 'unknown', state: 'running',
      startedAt: Date.now(), activity: [], incomplete: true, truncated: false, stopSupported: false };
    if (agent) data.agent = agent;
    const assignment = privacy.text(args.task), model = privacy.text(args.model, 256);
    if (assignment) {
      data.assignment = assignment;
      data.label = assignment.split(/[\r\n\u2028\u2029]/, 1)[0]!.slice(0, 256);
    }
    if (model) data.model = model;
    const run: ObservedRun = { id: digest({ kind: 'subagent_run', sessionId: this.context.sessionId, callId }), data, privacy, terminal: false, links: new Map(), aliases: new Map(), statuses: new Map(), missing: false, tools: new Map() };
    this.calls.set(callId, run);
    return run;
  }
  private bind(run: ObservedRun, id: unknown, root = true) {
    const key = nativeId(id);
    if (!key) return;
    const previous = this.runs.get(key);
    if (previous && previous !== run) { run.missing = true; return; }
    this.runs.set(key, run);
    if (root) run.data.runId = key;
    const pending = this.pending.get(key); this.pending.delete(key);
    for (const event of pending ?? []) this.extensionEvent(event.name, event.value);
  }
  private activity(run: ObservedRun, item: SubagentActivity) {
    const previous = run.data.activity.findIndex(entry => entry.id === item.id);
    if (previous >= 0) {
      const old = run.data.activity[previous]!;
      run.data.activity[previous] = { ...old, ...item, ...(item.state === 'running' && old.state && old.state !== 'running' && old.state !== 'unknown' ? { state: old.state } : {}) };
    }
    else run.data.activity.push(item);
    if (run.data.activity.length > 128) { run.data.activity.shift(); run.data.truncated = true; }
  }
  private textActivity(run: ObservedRun, key: string, text: unknown, kind: 'message' | 'notice' = 'message') {
    const safe = run.privacy.text(text);
    if (safe) this.activity(run, { id: digest({ run: run.id, key }), kind, text: safe });
  }
  private children(run: ObservedRun, values: unknown[], terminal: boolean, native = false) {
    if (values.length > 64) run.data.truncated = true;
    for (const raw of values.slice(0, 64)) {
      const child = object(raw), index = time(child.index);
      if (array(child.children).length || child.transcriptError) run.missing = true;
      const candidates = [nativeId(child.childId), nativeId(child.workflowKey), child.runId !== run.data.runId ? nativeId(child.runId) : undefined, index !== undefined && (!child.runId || child.runId === run.data.runId) ? `step:${index}` : undefined].filter((id): id is string => !!id);
      const id = candidates.map(id => run.aliases.get(id)).find(Boolean) ?? candidates[0];
      if (!id) { run.missing = true; continue; }
      for (const alias of candidates) if (run.aliases.size < 512) run.aliases.set(alias, id);
      const children = run.data.children ??= [];
      let row = children.find(row => row.id === id);
      if (!row) { if (children.length >= 64) { run.data.truncated = true; continue; } row = { id, state: 'unknown' }; children.push(row); }
      const agent = run.privacy.text(child.agent, 128), model = run.privacy.text(child.model, 256);
      if (agent) row.agent = agent;
      if (model) { row.model = model; if (values.length === 1 && run.data.agent === agent) run.data.model = model; }
      const state = outcome(child, terminal, native);
      if (active(row.state) || terminal && state !== 'unknown' && (row.state === 'completed' || state !== 'completed')) row.state = state;
      if (child.runId) this.bind(run, child.runId, false);
      const ownRun = nativeId(child.runId) ?? run.data.runId;
      const p = object(child.progress ?? child.progressSummary ?? child);
      if (p.currentTool) {
        const tool = run.privacy.text(p.currentTool, 128);
        if (tool) this.activity(run, { id: digest({ run: run.id, child: id, hint: 'current-tool' }), kind: 'notice', text: tool,
          label: 'Observed tool activity', ...(time(p.currentToolStartedAt) !== undefined ? { startedAt: time(p.currentToolStartedAt)! } : {}) });
      }
      if (p.progressText) this.textActivity(run, `progress:${id}`, p.progressText, 'notice');
      if (child.finalOutput && terminal && state !== 'failed') this.textActivity(run, `output:${id}`, child.finalOutput);
      if (child.error || state === 'failed') this.textActivity(run, `error:${id}`, publicError, 'notice');
      this.link(run, child, ownRun, index);
      if (array(child.messages).length > 32) run.data.truncated = true;
      for (const message of array(child.messages).slice(-32)) this.message(run, object(message), `${run.id}:${ownRun ?? id}:${index ?? 0}`);
      const changed = array(object(object(child.effects).fileMutation).evidence ? object(object(object(child.effects).fileMutation).evidence).changedFiles : undefined);
      if (changed.length > 64) run.data.truncated = true;
      for (const candidate of changed.slice(0, 64)) {
        const path = relativeFile(candidate);
        if (!path) continue;
        const files = run.data.files ??= [];
        if (!files.some(file => file.path === path) && files.length < 64) files.push({ path, change: 'observed' });
      }
    }
  }
  private link(run: ObservedRun, child: Record<string, unknown>, runId: string | undefined, index: number | undefined) {
    const path = child.transcriptPath ?? object(child.artifactPaths).transcriptPath;
    const agent = child.agent;
    if (!this.context.sessionFile || typeof path !== 'string' || path.length > 4096 || !runId || typeof agent !== 'string' || index === undefined) return;
    const key = `${runId}:${index}`;
    if (!run.links.has(key) && run.links.size < 64) run.links.set(key, { link: { path, runId, agent, index }, cursor: { offset: 0 }, complete: false });
    this.watch();
  }
  private toolArgumentsObserved(run: ObservedRun, key: string, value: unknown) {
    const sensitive = value === undefined || sensitiveToolArguments(value);
    if (!run.tools.has(key) && run.tools.size >= 1024) { run.tools.delete(run.tools.keys().next().value!); run.data.truncated = true; }
    run.tools.set(key, sensitive);
    if (sensitive) run.missing = true;
  }
  private message(run: ObservedRun, message: Record<string, unknown>, scope: string) {
    const role = message.role;
    if (!['assistant', 'user', 'toolResult'].includes(String(role))) return;
    if (message.stopReason === 'error') { this.textActivity(run, `error:${scope}`, publicError, 'notice'); return; }
    const blocks = array(message.content);
    if (blocks.length > 64) run.data.truncated = true;
    const text = blocks.slice(0, 32).filter(block => object(block).type === 'text').map(block => run.privacy.text(object(block).text) ?? '').join('\n');
    if (role === 'toolResult') {
      const callId = nativeId(message.toolCallId);
      if (!callId) return;
      const tool = run.privacy.text(message.toolName, 128);
      const output = message.isError === true ? publicError : run.tools.get(`${scope}:${callId}`) !== false ? 'Tool output omitted: sensitive or unavailable arguments.' : run.privacy.text(text);
      this.activity(run, { id: digest({ scope, callId }), kind: 'tool', ...(tool ? { tool } : {}), ...(output ? { output } : {}), state: message.isError === true ? 'failed' : 'completed' });
    } else {
      if (text) this.textActivity(run, `${scope}:${role}:${time(message.timestamp) ?? digest(text)}`, text);
      if (role === 'assistant') for (const block of blocks.slice(0, 64)) {
        const call = object(block), callId = nativeId(call.id);
        if (call.type !== 'toolCall' || !callId) continue;
        this.toolArgumentsObserved(run, `${scope}:${callId}`, call.arguments);
        const tool = run.privacy.text(call.name, 128), args = run.privacy.arguments(call.arguments);
        this.activity(run, { id: digest({ scope, callId }), kind: 'tool', ...(tool ? { tool } : {}), ...(args ? { arguments: args } : {}), state: 'running' });
      }
    }
  }
  private recordedStatus(run: ObservedRun, force = false) {
    const identities = [this.context.sessionId, ...(this.context.sessionFile ? [this.context.sessionFile] : [])];
    for (const [id, link] of run.statuses) {
      if (!force && Date.now() - link.lastRead < 750) continue;
      link.lastRead = Date.now();
      const status = readObservedAsyncStatus(link.directory, id, identities);
      link.available = !!status;
      if (!status) {
        if (!run.terminal && id === run.data.runId) run.data.state = 'unknown';
        continue;
      }
      const steps = array(status.steps);
      this.children(run, steps.slice(0, 64).map((value, index) => ({ ...object(value), ...(id !== run.data.runId && !object(value).runId ? { runId: id } : {}), index })), true, true);
      if (steps.length > 64) run.data.truncated = true;
      if (id === run.data.runId) {
        const state = outcome(status, true, true);
        if (state !== 'unknown' && (!run.terminal || !active(state) && (run.data.state === 'completed' || state !== 'completed'))) run.data.state = state;
        if (!active(state)) run.terminal = true;
        const started = time(status.startedAt), ended = time(status.endedAt);
        if (started !== undefined) run.data.startedAt = started;
        if (ended !== undefined && run.terminal) run.data.endedAt = ended;
      }
    }
  }
  private transcripts(run: ObservedRun) {
    if (!this.context.sessionFile) return;
    for (const [key, entry] of run.links) {
      const read = readChildTranscript(this.context.sessionFile, entry.link, entry.cursor);
      if (read.truncated) run.data.truncated = true;
      entry.complete = !read.unavailable && !read.pending;
      for (const record of read.records) {
        const value = record.value, scope = `${run.id}:${key}`;
        if (value.outputTruncated === true) run.data.truncated = true;
        if (value.recordType === 'message') this.message(run, object(value.message), scope);
        else if (value.recordType === 'tool_start') {
          const callId = nativeId(value.toolCallId);
          if (!callId) continue;
          this.toolArgumentsObserved(run, `${scope}:${callId}`, value.argsPayload ?? value.argsPreview);
          const tool = run.privacy.text(value.toolName, 128), args = run.privacy.arguments(value.argsPayload ?? value.argsPreview);
          this.activity(run, { id: digest({ scope, callId }), kind: 'tool', ...(tool ? { tool } : {}), ...(args ? { arguments: args } : {}), state: 'running', ...(time(value.ts) !== undefined ? { startedAt: time(value.ts)! } : {}) });
        } else if (value.recordType === 'tool_end') {
          const callId = nativeId(value.toolCallId);
          if (callId) this.activity(run, { id: digest({ scope, callId }), kind: 'tool', state: value.isError === true ? 'failed' : 'completed', ...(value.isError === true ? { output: publicError } : {}) });
        } else if (value.recordType === 'truncated') run.data.truncated = true;
        else if (value.recordType === 'stderr') this.textActivity(run, `stderr:${key}`, publicError, 'notice');
      }
    }
  }
  private emit(run: ObservedRun, final = run.terminal) {
    if (run.data.state === 'completed') {
      const states = run.data.children?.map(child => child.state) ?? [];
      if (states.includes('failed')) run.data.state = 'failed';
      else if (states.includes('stopped')) run.data.state = 'stopped';
      else if (states.some(state => active(state) || state === 'partial')) run.data.state = 'partial';
    }
    run.data.truncated ||= run.privacy.truncated;
    run.data.incomplete = run.missing || active(run.data.state) || run.data.state === 'partial' || [...run.statuses.values()].some(link => !link.available) || !run.terminal || run.data.truncated || run.privacy.redacted || run.links.size < Math.max(1, run.data.children?.length ?? 0) || [...run.links.values()].some(link => !link.complete) || run.data.children?.some(child => active(child.state) || child.state === 'partial') === true;
    while (Buffer.byteLength(JSON.stringify(run.data)) > subagentRecordBytes - 1024) {
      if (run.data.activity.length) run.data.activity.shift();
      else if (run.data.files?.length) run.data.files.pop();
      else if (run.data.children?.length) run.data.children.pop();
      else { delete run.data.summary; delete run.data.assignment; }
      run.data.truncated = true; run.data.incomplete = true;
    }
    const data = SubagentRun.parse(run.data), serialized = JSON.stringify(data);
    if (serialized === run.last) return;
    if (final) this.sink.finish('subagent_run', run.id, wire(data));
    else this.sink.publish('subagent_run', run.id, wire(data));
    run.last = serialized;
  }
  refresh() {
    if (this.closed) return;
    for (const run of this.calls.values()) { this.recordedStatus(run); this.transcripts(run); this.emit(run); }
  }
  observe(event: AgentSessionEvent) {
    if (this.closed) return;
    if (event.type === 'message_end') {
      const message = object(event.message);
      if (message.role === 'custom' && message.customType === 'subagent-notify') {
        for (const value of array(object(message.details).runs).slice(0, 64)) this.completion(object(value), true);
      }
    }
    if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_update' && event.type !== 'tool_execution_end') return;
    const final = event.type === 'tool_execution_end';
    const result = object(final ? event.result : event.type === 'tool_execution_update' ? event.partialResult : undefined);
    const details = object(result.details);
    if (final && !event.isError) for (const value of array(details.completions).slice(0, 64)) this.completion(object(value), true);
    if (event.toolName !== 'subagent' || !nativeId(event.toolCallId)) return;
    let run = this.calls.get(event.toolCallId);
    const args = object(!final ? event.args : undefined);
    if (!run) {
      if (event.type !== 'tool_execution_start' || args.action !== undefined || object(args.options).action !== undefined) return;
      run = this.newRun(event.toolCallId, args);
    }
    this.bind(run, details.runId ?? details.asyncId);
    if (details.asyncId || details.background === true) run.data.executionMode = 'background';
    else if (array(details.results).length || array(details.progress).length) run.data.executionMode = 'foreground';
    this.children(run, array(details.results), final);
    this.children(run, array(details.progress), false);
    const workflow = object(details.workflowChildren);
    if (workflow.workflowRunId) this.bind(run, workflow.workflowRunId);
    this.children(run, array(workflow.children), final, true);
    if (run.data.executionMode !== 'background' && final) {
      const results = array(details.results).map(value => outcome(object(value), true));
      const receipt = object(details.receipt);
      const state = outcome({ ...details, state: receipt.state ?? workflow.workflowState }, true, true);
      const next = event.isError ? 'failed' : results.includes('failed') ? 'failed' : results.includes('stopped') ? 'stopped' : results.includes('partial') ? 'partial'
        : state !== 'unknown' ? state : results.length && results.every(state => state === 'completed') ? 'completed' : 'unknown';
      if (!run.terminal || run.data.state === 'completed' || !active(next) && next !== 'completed') run.data.state = next;
      run.terminal = !active(run.data.state);
      if (['completed', 'failed', 'stopped'].includes(run.data.state)) run.data.endedAt = Date.now();
      if (event.isError) run.data.summary = publicError;
      else {
        if (array(result.content).length > 8) run.data.truncated = true;
        const text = array(result.content).slice(0, 8).filter(value => object(value).type === 'text').map(value => run.privacy.text(object(value).text) ?? '').join('\n');
        const summary = run.privacy.text(text); if (summary) run.data.summary = summary;
      }
    } else if (final && event.isError) {
      // A failed parent turn does not prove that an already-launched async child stopped.
      if (!run.data.runId) { run.data.state = 'failed'; run.terminal = true; run.data.endedAt = Date.now(); }
      run.data.summary = publicError;
    }
    this.transcripts(run); this.emit(run);
  }
  private completion(value: Record<string, unknown>, native: boolean) {
    const id = nativeId(value.runId) ?? nativeId(value.id);
    const run = id ? this.runs.get(id) : undefined;
    if (!run) return;
    if (value.sessionId !== undefined && value.sessionId !== this.context.sessionId && value.sessionId !== this.context.sessionFile) return;
    if (id !== run.data.runId) {
      const results = array(value.results);
      this.children(run, [{ ...(results.length === 1 ? object(results[0]) : {}), ...value, runId: id }], true, native);
      if (results.length > 1) run.missing = true;
    } else {
      this.children(run, array(value.results), true, native);
      this.children(run, array(value.childRuns), true, native);
      this.children(run, array(object(value.workflowChildren).children), true, native);
    }
    if (id === run.data.runId) {
      const state = outcome(value, true, native);
      if (state !== 'unknown' && state !== 'running' && state !== 'queued') {
        if (!run.terminal || run.data.state === 'completed' || state !== 'completed') run.data.state = state;
        run.terminal = true;
        run.data.endedAt ??= time(value.timestamp) ?? Date.now();
      }
      const summary = state === 'failed' || value.error ? publicError : run.privacy.text(value.summary ?? value.output);
      if (summary) run.data.summary = summary;
    }
    this.transcripts(run); this.emit(run);
  }
  extensionEvent(name: string, raw: unknown) {
    if (this.closed) return;
    const value = object(raw);
    if (name === 'subagent:jobs-changed') { this.refresh(); return; }
    if (value.sessionId !== undefined && value.sessionId !== this.context.sessionId && value.sessionId !== this.context.sessionFile) return;
    const id = nativeId(value.runId) ?? nativeId(value.id);
    if (!id) return;
    let run = this.runs.get(id);
    if (!run && name === 'subagent:async-started') {
      const callId = nativeId(value.toolCallId), parentId = nativeId(value.parentWorkflowRunId);
      run = callId ? this.calls.get(callId) : parentId ? this.runs.get(parentId) : undefined;
      if (run) this.bind(run, id, !parentId);
    }
    if (!run) {
      // A launch event can precede the tool receipt. Never attribute by agent name or timing.
      if (value.sessionId !== undefined && this.pending.size < 32 && Buffer.byteLength(JSON.stringify(raw)) <= 128 * 1024) {
        const events = this.pending.get(id) ?? [];
        if (events.length < 4) events.push({ name, value: raw });
        this.pending.set(id, events);
      }
      return;
    }
    if (name === 'subagent:async-started') {
      if (id === run.data.runId) run.data.executionMode = 'background';
      if (value.sessionId !== undefined && typeof value.asyncDir === 'string' && value.asyncDir.length <= 4096 && run.statuses.size < 64) {
        run.statuses.set(id, { directory: value.asyncDir, lastRead: 0, available: false }); this.watch(); this.recordedStatus(run);
      }
    } else if (name === 'subagent:async-complete') {
      this.recordedStatus(run, true); this.completion(value, true); return;
    } else if (name === 'subagent:foreground-complete') {
      // This event describes one detached foreground child, not terminal proof for its parent group.
      this.children(run, [{ ...value, runId: id !== run.data.runId ? id : undefined, index: value.taskIndex }], true, true);
    } else if (name === 'subagent:child-status') {
      this.children(run, [{ ...value, runId: value.childRunId, index: value.stepIndex, state: value.status === 'stopping' ? 'running' : value.status }], value.status === 'stopped', true);
    } else if (name === 'subagent:process-terminal') {
      this.recordedStatus(run, true);
    } else if (name === 'subagent:control-event') {
      if (value.type === 'needs_attention' || value.type === 'active_long_running') this.textActivity(run, `control:${id}:${value.type}`, value.type === 'needs_attention' ? 'Child needs attention' : 'Child remains active', 'notice');
    }
    this.transcripts(run); this.emit(run);
  }
  close() {
    if (this.closed) return;
    clearInterval(this.timer);
    for (const run of this.calls.values()) this.recordedStatus(run, true);
    this.refresh();
    for (const run of this.calls.values()) if (!run.terminal) {
      run.data.state = 'unknown'; run.data.incomplete = true;
      this.textActivity(run, 'observation-ended', 'Observation ended without terminal evidence.', 'notice');
      this.emit(run, true);
    }
    this.closed = true; this.pending.clear(); this.calls.clear(); this.runs.clear();
  }
}
