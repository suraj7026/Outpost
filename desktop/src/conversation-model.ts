import { actionNeedsReview, object, text, type Json, type ServerRecord } from './types';
import { isSubagentParent, isSubagentRecord, subagentRun, type SubagentRun } from './subagents/model';

export type ConversationGroup =
  | { kind: 'owner'; id: string; record: ServerRecord }
  | { kind: 'run'; id: string; records: ServerRecord[] };

export interface TaskRunStatus {
  label: string;
  kind: 'running' | 'review' | 'success' | 'stopped' | 'error' | 'idle';
  active: boolean;
  transient: boolean;
}

const conversationKinds = new Set(['message', 'action', 'tool_stream', 'subagent_run', 'artifact']);
const identity = (record: ServerRecord) => `${record.kind}:${record.id}`;

function latestRecords(records: ServerRecord[]): ServerRecord[] {
  const latest = new Map<string, ServerRecord>();
  for (const record of records) {
    if (!conversationKinds.has(record.kind)) continue;
    const key = identity(record);
    const previous = latest.get(key);
    // Live updates may share a persisted revision; the later supplied projection wins.
    if (!previous || record.revision >= previous.revision) latest.set(key, record);
  }
  return [...latest.values()];
}

function timestamp(value: Json | undefined): number | undefined {
  const time = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

/** Retains whole stream records (including errors/output), even for not-yet-loaded actions. */
export function linkedToolStreams(records: ServerRecord[]): Map<string, ServerRecord[]> {
  const linked = new Map<string, ServerRecord[]>();
  for (const record of latestRecords(records)) {
    const actionId = text(record, 'actionId');
    if (record.kind !== 'tool_stream' || !actionId) continue;
    const streams = linked.get(actionId) ?? [];
    streams.push(record);
    linked.set(actionId, streams);
  }
  return linked;
}

/**
 * Pass one task's records and retain firstSeen across snapshots of that conversation.
 * The caller-owned cache uses kind:id keys plus verified subagent-slot links;
 * its insertion order breaks timestamp ties.
 * Only this cache is mutated. A run is a presentation group, not a server run ID.
 */
export function groupConversation(records: ServerRecord[], firstSeen: Map<string, number>): ConversationGroup[] {
  const known = new Set(firstSeen.keys());
  const items = latestRecords(records).filter(record => record.kind !== 'subagent_run' || subagentRun(record));
  // Assistant startedAt is emitted by live-events. Other current emissions only have
  // updatedAt; accept an explicit createdAt if supplied, never infer it from a revision.
  const initialTimes = items.map(record => timestamp(record.data.startedAt)
    ?? timestamp(record.data.createdAt) ?? timestamp(record.updatedAt));
  let fallback = 0;
  for (const time of [...firstSeen.values(), ...initialTimes]) {
    if (time !== undefined && Number.isFinite(time)) fallback = Math.max(fallback, time);
  }
  items.forEach((record, index) => {
    const key = identity(record);
    if (!Number.isFinite(firstSeen.get(key))) firstSeen.set(key, initialTimes[index] ?? fallback);
  });
  const positions = new Map([...firstSeen.keys()].map((key, index) => [key, index]));
  const replacements = new Map<ServerRecord, ServerRecord>();
  const slots = new Map<ServerRecord, { time: number; key: string }>();
  for (const record of items) {
    if (record.kind !== 'subagent_run') continue;
    const run = subagentRun(record)!;
    const parent = items.find(item => isSubagentParent(item, run));
    const slotKey = `subagent-slot:${run.taskId}:${run.parentSessionId}:${run.parentToolId}`;
    const parentKey = `tool_stream:${run.parentToolId}`;
    if (parent) {
      replacements.set(parent, record);
      // Remember verified correlation even after the wrapper disappears from a snapshot.
      const parentTime = firstSeen.get(parentKey)!;
      const time = known.has(identity(record)) && !known.has(parentKey)
        ? Math.min(parentTime, firstSeen.get(identity(record))!) : parentTime;
      if (!firstSeen.has(slotKey)) firstSeen.set(slotKey, time);
    }
    const time = firstSeen.get(slotKey);
    if (time !== undefined) {
      const keys = [parentKey, identity(record)].filter(key => firstSeen.get(key) === time);
      keys.sort((a, b) => positions.get(a)! - positions.get(b)!);
      slots.set(record, { time, key: keys[0] ?? identity(record) });
    }
  }
  const ordered = [...items].sort((a, b) => {
    const aSlot = slots.get(a), bSlot = slots.get(b);
    const aKey = aSlot?.key ?? identity(a), bKey = bSlot?.key ?? identity(b);
    return (aSlot?.time ?? firstSeen.get(aKey)!) - (bSlot?.time ?? firstSeen.get(bKey)!) || positions.get(aKey)! - positions.get(bKey)!;
  });
  const actions = new Map(items.filter(record => record.kind === 'action').map(record => [record.id, record]));
  const emitted = new Set<string>();
  const groups: ConversationGroup[] = [];
  let runId = 'run:before-owner';
  for (const item of ordered) {
    // Whichever is earlier, the action or a linked stream, claims the action's slot.
    const action = item.kind === 'tool_stream' && !isSubagentRecord(item) ? actions.get(text(item, 'actionId')) : undefined;
    const record = replacements.get(item) ?? (action && text(action, 'taskId') === text(item, 'taskId') ? action : item);
    const key = identity(record);
    if (emitted.has(key)) continue;
    emitted.add(key);
    if (record.kind === 'message' && text(record, 'author') === 'owner') {
      groups.push({ kind: 'owner', id: record.id, record });
      runId = `run:after:${record.id}`;
    } else {
      const previous = groups.at(-1);
      if (previous?.kind === 'run') previous.records.push(record);
      else groups.push({ kind: 'run', id: runId, records: [record] });
    }
  }
  return groups;
}

function displayLine(value: string): string {
  const clean = value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n\u2028\u2029]/, 1)[0]
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  const characters = Array.from(clean);
  return characters.length > 160 ? `${characters.slice(0, 159).join('')}…` : clean;
}

function readable(value: string): string {
  const label = displayLine(value.replace(/[._-]+/g, ' '));
  return label ? label[0].toUpperCase() + label.slice(1) : '';
}

export function actionLabel(record: ServerRecord): string {
  let args = object(record.data.arguments);
  let name = text(record, 'tool') || text(record, 'name');
  if (record.kind === 'tool_stream' && typeof args.tool === 'string') {
    name = args.tool;
    args = object(args.arguments);
  }
  let verb = '', detail: Json | undefined;
  if (name === 'host.execute') {
    verb = 'Run'; detail = args.command;
  } else if (name === 'command.run') {
    verb = 'Run';
    const argv = args.argv;
    if (Array.isArray(argv) && argv.length && argv.every((arg): arg is string => typeof arg === 'string')) {
      const shell = /^(?:.*\/)?(?:bash|sh|zsh|dash|ksh)$/.test(argv[0]);
      detail = shell && ['-c', '-lc'].includes(argv[1]) && argv[2] !== undefined ? argv[2] : argv.join(' ');
    }
  } else if (name === 'file.read' || name === 'file.write') {
    verb = name === 'file.read' ? 'Read' : 'Write'; detail = args.path;
  } else if (name === 'browser.open') {
    verb = 'Open'; detail = args.url;
  }
  return typeof detail === 'string' && displayLine(detail)
    ? displayLine(`${verb} ${detail}`) : readable(name) || 'Tool call';
}

const status = (label: string, kind: TaskRunStatus['kind'], transient = false): TaskRunStatus =>
  ({ label, kind, active: kind === 'running', transient });

// Status follows observation time, unlike the timeline's stable first-seen ordering.
const observationTime = (record: ServerRecord) => timestamp(record.updatedAt)
  ?? timestamp(record.data.startedAt) ?? timestamp(record.data.createdAt) ?? 0;

function subagentOutcome(run: SubagentRun): TaskRunStatus | undefined {
  switch (run.state) {
    case 'failed': return status('Subagent failed', 'error');
    case 'partial': return status('Subagent partially completed', 'review');
    case 'unknown': return status('Subagent outcome unknown', 'review');
    case 'stopped': return status('Subagent stopped', 'stopped');
  }
}

function eventOutcome(record: ServerRecord, actions: Map<string, ServerRecord>): TaskRunStatus | undefined {
  const run = subagentRun(record);
  if (run) return subagentOutcome(run);
  if (record.kind === 'action') {
    if (actionNeedsReview(record)) return status('Action failed', 'error');
    if (text(record, 'state') === 'denied') return status('Action denied', 'review');
  } else {
    if (record.kind === 'tool_stream' && text(record, 'state') === 'error') return status('Tool attempt failed', 'error');
    if (record.kind === 'message' && (text(record, 'error') || text(record, 'stopReason') === 'error')) return status('Response failed', 'error');
    if (record.data.interrupted === true) return status('Interrupted', 'stopped');
    // A finished wrapper is not proof that its action succeeded (e.g. exitCode != 0).
    const action = record.kind === 'tool_stream' ? actions.get(text(record, 'actionId')) : undefined;
    if (action) return eventOutcome(action, actions);
  }
}

function activeStatus(records: ServerRecord[], actions: Map<string, ServerRecord>): TaskRunStatus | undefined {
  const active = new Map<string, ServerRecord>();
  for (const record of records) {
    if (record.data.interrupted === true || eventOutcome(record, actions)) continue;
    const run = subagentRun(record);
    if (run && ['queued', 'running'].includes(run.state)) {
      active.set(identity(record), record);
    } else if (record.kind === 'action' && ['authorized', 'dispatching'].includes(text(record, 'state'))) {
      active.set(identity(record), record);
    } else if (record.data.streaming === true) {
      if (record.kind === 'tool_stream' && ['preparing', 'running'].includes(text(record, 'state'))) {
        const actionId = text(record, 'actionId');
        if (actions.has(actionId)) continue;
        const key = actionId ? `action:${actionId}` : identity(record);
        if (!active.has(key)) active.set(key, record);
      } else if (record.kind === 'message' && text(record, 'author') === 'assistant') {
        active.set(identity(record), record);
      }
    }
  }
  const current = [...active.values()];
  // Actual tool work takes precedence over a concurrently streaming explanation.
  const primary = current.find(record => record.kind !== 'message') ?? current[0];
  if (!primary) return undefined;
  const child = subagentRun(primary);
  let label = child ? displayLine(`${child.state === 'queued' ? 'Queued' : 'Running'} subagent: ${child.label}`)
    : primary.kind === 'message'
      ? text(primary, 'text').trim() ? 'Responding' : text(primary, 'thinking').trim() ? 'Thinking' : 'Waiting for model output'
      : primary.kind === 'action' && text(primary, 'state') === 'authorized'
        ? displayLine(`Queued: ${actionLabel(primary)}`) : actionLabel(primary);
  if (current.length > 1) {
    const suffix = ` · ${current.length} active`;
    const available = 160 - suffix.length;
    const characters = Array.from(label);
    if (characters.length > available) label = `${characters.slice(0, available - 1).join('')}…`;
    label += suffix;
  }
  return status(label, 'running');
}

/**
 * The bar describes current task/activity, not a verdict on every historical attempt.
 * Pending/unknown actions and unresolved children remain visible despite newer observations.
 * Completed is authoritative except for safety notices and unresolved child work;
 * cancelled always wins. Child detail incompleteness alone is not a failed outcome.
 * active describes working status, not whether the parent should offer Stop.
 */
export function taskRunStatus(task: ServerRecord, records: ServerRecord[]): TaskRunStatus {
  const state = text(task, 'state');
  if (state === 'cancelled') return status('Cancelled', 'stopped', true);
  if (state === 'failed') return status('Failed', 'error');
  if (state === 'interrupted') return status('Interrupted', 'stopped');

  const candidates = latestRecords(records)
    .filter(record => text(record, 'taskId') === task.id && record.kind !== 'artifact');
  const projected = candidates.filter(record => record.kind === 'subagent_run')
    .map(record => subagentRun(record, task.id)).filter((run): run is SubagentRun => run !== undefined);
  const related = candidates.filter(record => record.kind === 'subagent_run' ? subagentRun(record, task.id) !== undefined
    : !projected.some(run => isSubagentParent(record, run)))
    .sort((a, b) => observationTime(b) - observationTime(a) || identity(a).localeCompare(identity(b)));
  const actions = new Map(related.filter(record => record.kind === 'action').map(record => [record.id, record]));
  if ([...actions.values()].some(record => text(record, 'state') === 'pending')) return status('Waiting for approval', 'review');
  if ([...actions.values()].some(record => text(record, 'state') === 'unknown')) return status('Action outcome unknown', 'review');
  const children = related.map(record => subagentRun(record, task.id)).filter((run): run is SubagentRun => run !== undefined);
  const activeChildren = related.filter(record => {
    const run = subagentRun(record, task.id);
    return run && ['queued', 'running'].includes(run.state);
  });
  const childOutcomes = children.map(subagentOutcome);
  const childOutcome = childOutcomes.find(outcome => outcome?.kind === 'error') ?? childOutcomes.find(Boolean);
  if (state === 'completed') {
    const active = activeStatus(activeChildren, actions);
    return active ?? childOutcome ?? status('Completed', 'success', true);
  }

  switch (state) {
    case 'waiting_for_approval': return status('Waiting for approval', 'review');
    case 'waiting_for_login': return status('Waiting for login', 'review');
    case 'waiting_for_human': return status('Waiting for human', 'review');
    case 'waiting_for_payment_auth': return status('Waiting for payment authorization', 'review');
    case 'waiting_for_capacity': return status('Waiting for capacity', 'idle');
    case 'paused': return status('Paused', 'stopped');
  }
  if (state === 'running' || state === 'reconciling') {
    const current = activeStatus(related, actions);
    if (current) return current;
  } else {
    const current = activeStatus(activeChildren, actions);
    if (current) return current;
  }
  if (childOutcome) return childOutcome;
  // Millisecond timestamps can tie. Without an event cursor, retain failure evidence
  // for that latest instant rather than arbitrarily treating a sibling as recovery.
  const latestTime = related[0] ? observationTime(related[0]) : undefined;
  const outcomes = related.filter(record => observationTime(record) === latestTime)
    .map(record => eventOutcome(record, actions));
  const latestOutcome = outcomes.find(outcome => outcome?.kind === 'error') ?? outcomes.find(Boolean);
  if (latestOutcome) return latestOutcome;
  if (state === 'verifying') return status('Ready for your review', 'review');
  if (text(task, 'blocker').trim()) return status('Blocked', 'review');
  switch (state) {
    case 'queued': return status('Queued', 'running');
    case 'running': return status('Running', 'running');
    case 'reconciling': return status('Reconciling', 'running');
    default: return status(readable(state) || 'Idle', 'idle');
  }
}
