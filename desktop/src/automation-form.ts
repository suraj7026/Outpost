import type { Json, ServerRecord } from './types';
import { modeBlocker, savedControlMode, type ControlCapabilities, type ControlMode } from './control-mode';

export const profiles = ['code', 'browser', 'operations', 'research', 'cowork', 'chat'] as const;
const legacyControlModes = ['ask_permission', 'auto', 'full_control'] as const;
export type AutomationTask = { goal: string; profile: typeof profiles[number]; mode: ControlMode; model?: string; modelRef?: { providerId: string; modelId: string } };
export type AutomationSchedule = { name: string; timezone: string; nextAt: number; intervalMs: number | null; missed: 'skip' | 'coalesce'; paused: boolean; task: AutomationTask };
export type AutomationDraft = { name: string; goal: string; profile: string; mode: ControlMode; start: string; timezone: string; frequency: 'once' | 'interval'; intervalMinutes: string; missed: string; model: string };
export type AutomationAuthority = { runtime?: ControlCapabilities | null; connected: boolean; retired?: boolean; busy: boolean; info: { pending: boolean; pendingError?: string | null } | null };

export function automationBlocker(connection: AutomationAuthority | undefined, native: boolean, preview: boolean): string {
  if (!native || preview) return 'Schedules are read-only in browser previews. Open the desktop app to make changes.';
  if (!connection || !connection.connected) return 'Connect this server to change schedules.';
  if (connection.retired) return 'This connection is retired. Select its verified replacement.';
  if (!connection.info || connection.info.pending || connection.info.pendingError) return 'Resolve pending work in this server’s recovery settings first.';
  if (connection.busy) return 'Wait for this server’s current operation to finish.';
  return '';
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const validModelRef = (value: unknown): value is { providerId: string; modelId: string } => isObject(value) && onlyKeys(value, ['providerId', 'modelId']) &&
  typeof value.providerId === 'string' && value.providerId.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.providerId) && !['__proto__', 'prototype', 'constructor'].includes(value.providerId) &&
  typeof value.modelId === 'string' && value.modelId.length > 0 && value.modelId.length <= 512 && value.modelId === value.modelId.trim() && !/[\x00-\x1f]/.test(value.modelId);
export const modelRefSelection = (ref: { providerId: string; modelId: string }) => `ref:${JSON.stringify(ref)}`;
export const legacyModelSelection = (model: string) => `model:${model}`;
const validZone = (zone: string) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; } };
export function readSchedule(record: ServerRecord): AutomationSchedule | null {
  const data = record.data, task = data.task;
  if (record.kind !== 'automation' || !onlyKeys(data, ['name', 'timezone', 'nextAt', 'intervalMs', 'missed', 'paused', 'task']) ||
      typeof data.name !== 'string' || !data.name.trim() || typeof data.timezone !== 'string' || !validZone(data.timezone) ||
      typeof data.nextAt !== 'number' || !Number.isSafeInteger(data.nextAt) || data.nextAt < 0 || !Number.isFinite(new Date(data.nextAt).getTime()) ||
      !(data.intervalMs === null || typeof data.intervalMs === 'number' && Number.isSafeInteger(data.intervalMs) && data.intervalMs >= 60000) ||
      !['skip', 'coalesce'].includes(String(data.missed)) || !(data.paused === undefined || typeof data.paused === 'boolean') ||
      !isObject(task) || !onlyKeys(task, ['goal', 'profile', 'mode', 'model', 'modelRef']) ||
      typeof task.goal !== 'string' || !task.goal.trim() || task.goal.trim().length > 20000 ||
      !profiles.some(value => value === task.profile) || !(task.mode === undefined || legacyControlModes.some(value => value === task.mode)) ||
      !(task.model === undefined || typeof task.model === 'string' && !!task.model.trim() && task.model.trim().length <= 200) ||
      !(task.modelRef === undefined || validModelRef(task.modelRef)) ||
      task.model !== undefined && task.modelRef !== undefined) return null;
  return { ...data, paused: data.paused ?? false, task: { ...task, mode: task.mode === undefined ? 'full_control' : savedControlMode(task.mode) } } as AutomationSchedule;
}

export function localDateInput(epoch: number): string {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function scheduleDraft(schedule?: AutomationSchedule): AutomationDraft {
  return { name: schedule?.name ?? '', goal: schedule?.task.goal ?? '', profile: schedule?.task.profile ?? 'code', mode: schedule?.task.mode ?? 'full_control',
    start: localDateInput(schedule?.nextAt ?? Date.now() + 3600000), timezone: schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    frequency: schedule?.intervalMs ? 'interval' : 'once', intervalMinutes: String((schedule?.intervalMs ?? 86400000) / 60000),
    missed: schedule?.missed ?? 'coalesce', model: schedule?.task.modelRef ? modelRefSelection(schedule.task.modelRef) : schedule?.task.model ? legacyModelSelection(schedule.task.model) : '' };
}

export function buildSchedule(draft: AutomationDraft, initial?: AutomationSchedule, now = Date.now()): AutomationSchedule {
  const name = draft.name.trim(), goal = draft.goal.trim();
  if (!name || !goal || goal.length > 20000) throw new Error('Enter a schedule name and a task of at most 20,000 characters.');
  if (!profiles.some(value => value === draft.profile)) throw new Error('Choose a supported profile.');
  if (draft.mode !== 'full_control' && draft.mode !== 'auto') throw new Error('Choose Full control or Auto.');
  if (!validZone(draft.timezone)) throw new Error('Enter a valid IANA display time zone, such as Europe/London.');
  const parsed = new Date(draft.start).getTime();
  // An untouched edit must preserve sub-minute precision and ambiguous DST offsets.
  const nextAt = initial && draft.start === localDateInput(initial.nextAt) ? initial.nextAt : parsed;
  if (!Number.isSafeInteger(nextAt) || nextAt < 0 || localDateInput(nextAt) !== draft.start) throw new Error('Choose a valid start date and time on this Mac.');
  if ((!initial || nextAt !== initial.nextAt) && nextAt <= now) throw new Error('Choose a future start time.');
  const intervalMs = draft.frequency === 'once' ? null : Math.round(Number(draft.intervalMinutes) * 60000);
  if (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || Number(draft.intervalMinutes) < 1 || intervalMs < 60000)) throw new Error('Use a fixed interval of at least one minute.');
  if (!['skip', 'coalesce'].includes(draft.missed)) throw new Error('Choose how to handle missed intervals.');
  let model: Pick<AutomationTask, 'model' | 'modelRef'> = {};
  if (draft.model) {
    if (draft.model.startsWith('ref:')) {
      let ref: unknown;
      try { ref = JSON.parse(draft.model.slice(4)); } catch { throw new Error('Choose a valid provider model.'); }
      if (!validModelRef(ref)) throw new Error('Choose a valid provider model.');
      model = { modelRef: ref };
    } else if (draft.model.startsWith('model:')) {
      const selected = draft.model.slice(6).trim();
      if (!selected || selected.length > 200) throw new Error('Choose a valid model.');
      model = { model: selected };
    } else throw new Error('Choose a valid model.');
  }
  return { name, timezone: draft.timezone, nextAt, intervalMs, missed: draft.missed as AutomationSchedule['missed'], paused: initial?.paused ?? false,
    task: { goal, profile: draft.profile as AutomationTask['profile'], mode: draft.mode, ...model } };
}

export function intervalLabel(intervalMs: number | null): string {
  if (intervalMs === null) return 'One time';
  const hours = intervalMs / 3600000;
  return Number.isInteger(hours) ? `Every ${hours} ${hours === 1 ? 'hour' : 'hours'}` : `Every ${Number((intervalMs / 60000).toFixed(4))} minutes`;
}
export function scheduleTime(schedule: AutomationSchedule): string {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: schedule.timezone }).format(schedule.nextAt); }
  catch { return 'Time unavailable'; }
}

export type AutomationClient = AutomationAuthority & { records: ServerRecord[]; command: (kind: string, id: string, revision: number, payload: Record<string, Json>) => Promise<ServerRecord | undefined> };
export async function saveAutomation(client: AutomationClient | undefined, id: string, revision: number, schedule: AutomationSchedule, native: boolean, preview: boolean) {
  const blocked = automationBlocker(client, native, preview) || modeBlocker(schedule.task.mode, client?.runtime);
  if (blocked || !client) throw new Error(blocked);
  const current = client.records.find(record => record.kind === 'automation' && record.id === id);
  if (revision === 0 ? !!current : !current || current.revision !== revision) throw new Error('This schedule changed. Close and reopen it to review the latest version.');
  const payload = { ...schedule, task: { ...schedule.task } };
  const result = await client.command('automation.save', id, revision, payload);
  if (!result || result.kind !== 'automation' || result.id !== id || result.revision <= revision) throw new Error('Couldn’t confirm the save. Check the latest schedule and server recovery before retrying; do not create another copy.');
  return result;
}
