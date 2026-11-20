import { z } from 'zod';
import type { ServerRecord } from '../types';

const recordBytes = 128 * 1024 - 512;
const identity = z.string().regex(/^[a-zA-Z0-9_.:|+-]{1,256}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = z.enum(['queued', 'running', 'completed', 'failed', 'stopped', 'partial', 'unknown']);
const activity = z.strictObject({
  id: identity, kind: z.enum(['message', 'tool', 'notice']), label: z.string().max(256).optional(),
  text: z.string().max(8192).optional(), tool: z.string().max(128).optional(),
  arguments: z.string().max(4096).optional(), output: z.string().max(8192).optional(),
  state: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']).optional(), startedAt: timestamp.optional(),
});
// Mirror the public wire contract, not its Node/Buffer-dependent runtime validator.
const runSchema = z.strictObject({
  taskId: z.uuid(), parentSessionId: z.uuid(), parentCallId: identity, parentToolId: z.string().regex(/^[a-f0-9]{64}$/),
  runId: identity.optional(), agent: z.string().max(128).optional(), label: z.string().max(256), model: z.string().max(256).optional(),
  assignment: z.string().max(8192).optional(), executionMode: z.enum(['foreground', 'background', 'unknown']), state,
  startedAt: timestamp.optional(), endedAt: timestamp.optional(), summary: z.string().max(8192).optional(),
  activity: z.array(activity).max(128),
  files: z.array(z.strictObject({ path: z.string().max(512), change: z.string().max(128).optional() })).max(64).optional(),
  children: z.array(z.strictObject({ id: identity, agent: z.string().max(128).optional(), model: z.string().max(256).optional(), state })).max(64).optional(),
  incomplete: z.boolean(), truncated: z.boolean(), stopSupported: z.literal(false),
  streaming: z.boolean().optional(), interrupted: z.boolean().optional(),
});

type RunData = z.infer<typeof runSchema>;
export type SubagentState = RunData['state'];
export type SubagentActivity = z.infer<typeof activity>;
/** Legacy records cannot supply parent session/call identities that were never recorded. */
export type SubagentRun = (RunData & { recordId: string; legacy: false }) |
  (Omit<RunData, 'parentSessionId' | 'parentCallId'> & {
    recordId: string; legacy: true; parentSessionId?: string; parentCallId?: string;
  });

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Bound traversal before schema validation/serialization, including malformed nested input. */
function bounded(value: unknown): boolean {
  let nodes = 4096, characters = recordBytes;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 6) return false;
    if (typeof item === 'string') return item.length <= 8192 && (characters -= item.length) >= 0;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => visit(child, depth + 1));
    for (const key in item) {
      if (!Object.hasOwn(item, key)) return false;
      if ((characters -= key.length) < 0 || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    if (value.length > 65536) return undefined;
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return object(value);
}

function launchArguments(record: ServerRecord): Record<string, unknown> | undefined {
  if (!object(record) || !object(record.data) || record.kind !== 'tool_stream' ||
    (record.data.name !== 'subagent' && record.data.tool !== 'subagent')) return undefined;
  const args = jsonObject(record.data.arguments);
  if (!args || args.action !== undefined || object(args.options)?.action !== undefined) return undefined;
  return args;
}

/** Public kinds remain recognizable even when their payload must be rejected. */
export function isSubagentRecord(record: ServerRecord): boolean {
  return object(record) !== undefined && (record.kind === 'subagent_run' || launchArguments(record) !== undefined);
}

function observedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, limit)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim() || undefined;
}

function childOutcome(value: Record<string, unknown>): SubagentState {
  const execution = object(value.execution) ?? {};
  const rawStatus = value.state ?? value.status ?? execution.status;
  if (rawStatus !== undefined && typeof rawStatus !== 'string') return 'unknown';
  const status = rawStatus ?? '';
  if (value.stopped === true || execution.stopped === true || status === 'stopped') return 'stopped';
  if (['interrupted', 'detached', 'timedOut'].some(key => value[key] === true || execution[key] === true) ||
    ['partial', 'paused', 'detached', 'interrupted'].includes(status)) return 'partial';
  if (value.success === false || execution.success === false || ['failed', 'error', 'rejected'].includes(status) ||
    typeof value.exitCode === 'number' && Number.isFinite(value.exitCode) && value.exitCode !== 0) return 'failed';
  if (['running', 'started'].includes(status)) return 'running';
  if (['queued', 'pending'].includes(status)) return 'queued';
  return value.exitCode === 0 ? 'completed' : 'unknown';
}

function legacyRun(record: ServerRecord): SubagentRun | undefined {
  const args = launchArguments(record);
  const taskId = identity.safeParse(record.data.taskId);
  if (!args || !taskId.success || !identity.safeParse(record.id).success) return undefined;
  // Old streams sometimes persisted a partial result as JSON. Read only known evidence;
  // never return its content, paths, credentials, reasoning, or raw metadata/output.
  const result = object(record.data.result) ?? jsonObject(record.data.output);
  const details = object(record.data.details) ?? object(result?.details) ?? {};
  const results = Array.isArray(details.results) && details.results.length <= 64
    ? details.results.map(value => object(value) ?? {}) : [];
  const single = results.length === 1 ? results[0] : undefined;
  const background = args.async === true || details.background === true || typeof details.asyncId === 'string';
  const executionMode = background ? 'background' : args.async === false || results.length ? 'foreground' : 'unknown';
  let runState: SubagentState = 'unknown';
  if (record.data.streaming === true && (record.data.state === 'preparing' || record.data.state === 'running')) {
    runState = record.data.state === 'preparing' ? 'queued' : 'running';
  } else if (!background && record.data.state === 'error') runState = 'failed';
  else if (!background && record.data.state === 'finished' && results.length) {
    const outcomes = results.map(childOutcome);
    runState = outcomes.includes('failed') ? 'failed' : outcomes.includes('stopped') ? 'stopped'
      : outcomes.includes('partial') ? 'partial' : outcomes.every(value => value === 'completed') ? 'completed' : 'unknown';
  }
  const agent = observedText(args.agent, 128) ?? observedText(single?.agent, 128);
  const model = observedText(single?.model, 256) ?? observedText(args.model, 256);
  const assignment = observedText(args.task, 8192);
  const session = z.uuid().safeParse(record.data.parentSessionId ?? record.data.sessionId);
  const call = identity.safeParse(record.data.callId);
  const started = timestamp.safeParse(record.data.startedAt);
  const truncated = record.data.outputTruncated === true ||
    [[args.agent, 128], [args.model, 256], [args.task, 8192], [single?.agent, 128], [single?.model, 256]]
      .some(([value, limit]) => typeof value === 'string' && typeof limit === 'number' && value.length > limit) ||
    Array.isArray(details.results) && details.results.length > 64;
  return {
    recordId: record.id, legacy: true, taskId: taskId.data, parentToolId: record.id,
    ...(session.success ? { parentSessionId: session.data } : {}), ...(call.success ? { parentCallId: call.data } : {}),
    label: agent ?? (args.workflow ? 'Workflow' : 'Subagent'), ...(agent ? { agent } : {}), ...(model ? { model } : {}),
    ...(assignment ? { assignment } : {}), executionMode, state: runState,
    ...(started.success ? { startedAt: started.data } : {}),
    summary: 'Older-run details unavailable.', activity: [], incomplete: true, truncated, stopSupported: false,
    ...(typeof record.data.streaming === 'boolean' ? { streaming: record.data.streaming } : {}),
    ...(typeof record.data.interrupted === 'boolean' ? { interrupted: record.data.interrupted } : {}),
  };
}

/** Pure, browser-safe projection. No parent model fallback and no metadata passthrough. */
export function subagentRun(record: ServerRecord, taskId?: string): SubagentRun | undefined {
  if (!object(record) || !object(record.data)) return undefined;
  if (taskId !== undefined && record.data.taskId !== taskId) return undefined;
  let run: SubagentRun;
  if (record.kind === 'subagent_run') {
    if (!identity.safeParse(record.id).success || !bounded(record.data)) return undefined;
    const parsed = runSchema.safeParse(record.data);
    if (!parsed.success) return undefined;
    const { streaming: _streaming, interrupted: _interrupted, ...payload } = parsed.data;
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > recordBytes) return undefined;
    run = { ...parsed.data, recordId: record.id, legacy: false };
  } else {
    const legacy = legacyRun(record);
    if (!legacy) return undefined;
    run = legacy;
  }
  // Transport loss is not proof of native completion or cancellation. A terminal
  // native outcome remains valid even if its later detail enrichment was interrupted.
  if (run.interrupted === true) {
    if (['queued', 'running', 'unknown'].includes(run.state)) run.state = 'unknown';
    run.incomplete = true;
  }
  return run;
}

/** The digest is session-scoped; older wrappers omit sessionId, but never taskId. */
export function isSubagentParent(record: ServerRecord, run: SubagentRun): boolean {
  if (!object(record) || !object(record.data) || run.legacy || record.kind !== 'tool_stream' ||
    record.id !== run.parentToolId || record.data.taskId !== run.taskId) return false;
  if (!launchArguments(record)) return false;
  for (const key of ['sessionId', 'parentSessionId']) {
    if (record.data[key] !== undefined && record.data[key] !== run.parentSessionId) return false;
  }
  return record.data.callId === undefined || record.data.callId === run.parentCallId;
}

export function subagentStatusLabel(run: SubagentRun): string {
  const labels: Record<SubagentState, string> = {
    queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed',
    stopped: 'Stopped', partial: 'Partially completed', unknown: 'Outcome unknown',
  };
  return labels[run.state];
}

/** Undefined means no observed interval; a wrapper's duration is never a child duration. */
export function subagentDurationMs(run: SubagentRun, now = Date.now()): number | undefined {
  const end = run.endedAt ?? (['queued', 'running'].includes(run.state) ? now : undefined);
  return run.startedAt !== undefined && end !== undefined && Number.isSafeInteger(end) && end >= run.startedAt
    ? end - run.startedAt : undefined;
}

export function subagentCopyText(run: SubagentRun): string {
  return [run.label, subagentStatusLabel(run), run.agent && `Agent: ${run.agent}`, run.model && `Model: ${run.model}`,
    run.assignment, run.summary, run.incomplete && 'Details incomplete.', run.truncated && 'Details truncated.',
    ...run.activity.map(item => [item.label ?? item.tool, item.text, item.arguments, item.output].filter(Boolean).join('\n')),
    ...(run.files ?? []).map(file => [file.path, file.change].filter(Boolean).join(' — ')),
  ].filter(Boolean).join('\n\n');
}
