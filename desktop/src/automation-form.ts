import type { Json, ServerRecord } from './types';
import { modeBlocker, savedControlMode, type ControlCapabilities, type ControlMode } from './control-mode';

export const profiles = ['code', 'browser', 'operations', 'research', 'cowork', 'chat'] as const;
const legacyControlModes = ['ask_permission', 'auto', 'full_control'] as const;
export const calendarFolds = ['earlier', 'later', 'both'] as const;
export type CalendarFold = typeof calendarFolds[number];
export type CalendarPreset = 'daily' | 'weekdays' | 'weekly' | 'custom';
export type CalendarDefinition = {
  kind: 'cron';
  expression: string;
  timezone: string;
  gap: 'skip';
  fold: CalendarFold;
};
export type CalendarPreviewSlot = {
  scheduledAt: number;
  wallTime: string;
  offset: string;
  fold: 'unique' | 'earlier' | 'later';
};
export type CalendarPreviewResult = {
  status: 'horizon' | 'limit' | 'search-limit';
  occurrences: CalendarPreviewSlot[];
};
export const calendarWeekdays = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
] as const;

export type AutomationTask = { goal: string; profile: typeof profiles[number]; mode: ControlMode; model?: string; modelRef?: { providerId: string; modelId: string } };
export type AutomationSchedule = {
  name: string;
  timezone: string;
  nextAt: number;
  intervalMs: number | null;
  missed: 'skip' | 'coalesce';
  paused: boolean;
  task: AutomationTask;
  calendar?: CalendarDefinition;
};
export type AutomationDraft = {
  name: string;
  goal: string;
  profile: string;
  mode: ControlMode;
  start: string;
  timezone: string;
  frequency: 'once' | 'interval' | 'calendar';
  intervalMinutes: string;
  calendarPreset: CalendarPreset;
  calendarTime: string;
  calendarDays: number[];
  calendarExpression: string;
  calendarFold: CalendarFold;
  missed: string;
  model: string;
};
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
export const validNamedZone = (zone: string) => /^[A-Za-z][A-Za-z0-9._+\-]*(?:\/[A-Za-z0-9._+\-]+)*$/.test(zone) && validZone(zone);

const validCalendar = (value: unknown): value is CalendarDefinition => isObject(value) &&
  onlyKeys(value, ['kind', 'expression', 'timezone', 'gap', 'fold']) &&
  value.kind === 'cron' &&
  typeof value.expression === 'string' && value.expression.trim().length > 0 && value.expression.trim().length <= 256 &&
  typeof value.timezone === 'string' && value.timezone.length <= 100 && validNamedZone(value.timezone) &&
  value.gap === 'skip' &&
  calendarFolds.some(fold => fold === value.fold);

export function compileCalendarExpression(preset: CalendarPreset, time: string, days: readonly number[], customExpression: string): string {
  if (preset === 'custom') {
    const normalized = customExpression.trim().split(/\s+/).filter(Boolean).join(' ');
    if (!normalized || normalized.length > 256 || normalized.split(' ').length !== 5) {
      throw new Error('Enter a standard five-field cron expression (minute hour day month weekday).');
    }
    return normalized;
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!match) throw new Error('Choose a valid time of day (HH:MM).');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (preset === 'daily') return `${minute} ${hour} * * *`;
  if (preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  const uniqueDays = [...new Set(days)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
  if (!uniqueDays.length) throw new Error('Select at least one day of the week.');
  return `${minute} ${hour} * * ${uniqueDays.join(',')}`;
}

export function detectCalendarPreset(expression: string): { preset: CalendarPreset; time: string; days: number[]; expression: string } {
  const normalized = expression.trim().split(/\s+/).filter(Boolean).join(' ');
  const parts = normalized.split(' ');
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && /^\d{1,2}$/.test(parts[0]!) && /^\d{1,2}$/.test(parts[1]!)) {
    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    if (minute >= 0 && minute <= 59 && hour >= 0 && hour <= 23) {
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const dow = parts[4]!;
      if (dow === '*') return { preset: 'daily', time, days: [1, 3, 5], expression: normalized };
      if (dow === '1-5') return { preset: 'weekdays', time, days: [1, 2, 3, 4, 5], expression: normalized };
      if (/^[0-7](?:,[0-7])*$/.test(dow)) {
        const days = [...new Set(dow.split(',').map(value => Number(value) === 7 ? 0 : Number(value)))].sort((a, b) => a - b);
        return { preset: 'weekly', time, days, expression: normalized };
      }
    }
  }
  return { preset: 'custom', time: '09:00', days: [1, 3, 5], expression: normalized };
}

export function readSchedule(record: ServerRecord): AutomationSchedule | null {
  const data = record.data, task = data.task, calendar = data.calendar;
  if (record.kind !== 'automation' || !onlyKeys(data, ['name', 'timezone', 'nextAt', 'intervalMs', 'missed', 'paused', 'task', 'calendar']) ||
      typeof data.name !== 'string' || !data.name.trim() || typeof data.timezone !== 'string' || !validZone(data.timezone) ||
      typeof data.nextAt !== 'number' || !Number.isSafeInteger(data.nextAt) || data.nextAt < 0 || !Number.isFinite(new Date(data.nextAt).getTime()) ||
      !(data.intervalMs === null || typeof data.intervalMs === 'number' && Number.isSafeInteger(data.intervalMs) && data.intervalMs >= 60000) ||
      !['skip', 'coalesce'].includes(String(data.missed)) || !(data.paused === undefined || typeof data.paused === 'boolean') ||
      !(calendar === undefined || (validCalendar(calendar) && data.intervalMs === null && data.timezone === calendar.timezone)) ||
      !isObject(task) || !onlyKeys(task, ['goal', 'profile', 'mode', 'model', 'modelRef']) ||
      typeof task.goal !== 'string' || !task.goal.trim() || task.goal.trim().length > 20000 ||
      !profiles.some(value => value === task.profile) || !(task.mode === undefined || legacyControlModes.some(value => value === task.mode)) ||
      !(task.model === undefined || typeof task.model === 'string' && !!task.model.trim() && task.model.trim().length <= 200) ||
      !(task.modelRef === undefined || validModelRef(task.modelRef)) ||
      task.model !== undefined && task.modelRef !== undefined) return null;
  const parsed: AutomationSchedule = {
    name: data.name,
    timezone: data.timezone,
    nextAt: data.nextAt,
    intervalMs: data.intervalMs,
    missed: data.missed as AutomationSchedule['missed'],
    paused: data.paused ?? false,
    task: { ...(task as Omit<AutomationTask, 'mode'>), mode: task.mode === undefined ? 'full_control' : savedControlMode(task.mode)! },
    ...(calendar ? { calendar: { ...calendar } } : {}),
  };
  return parsed;
}

export function localDateInput(epoch: number): string {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function scheduleDraft(schedule?: AutomationSchedule): AutomationDraft {
  const detected = schedule?.calendar ? detectCalendarPreset(schedule.calendar.expression) : null;
  return {
    name: schedule?.name ?? '',
    goal: schedule?.task.goal ?? '',
    profile: schedule?.task.profile ?? 'code',
    mode: schedule?.task.mode ?? 'full_control',
    start: localDateInput(schedule?.nextAt ?? Date.now() + 3600000),
    timezone: schedule?.calendar?.timezone ?? schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    frequency: schedule?.calendar ? 'calendar' : schedule?.intervalMs ? 'interval' : 'once',
    intervalMinutes: String((schedule?.intervalMs ?? 86400000) / 60000),
    calendarPreset: detected?.preset ?? 'weekdays',
    calendarTime: detected?.time ?? '09:00',
    calendarDays: detected?.days ?? [1, 3, 5],
    calendarExpression: detected?.expression ?? '0 9 * * 1-5',
    calendarFold: schedule?.calendar?.fold ?? 'earlier',
    missed: schedule?.missed ?? 'coalesce',
    model: schedule?.task.modelRef ? modelRefSelection(schedule.task.modelRef) : schedule?.task.model ? legacyModelSelection(schedule.task.model) : '',
  };
}

export function buildSchedule(draft: AutomationDraft, initial?: AutomationSchedule, now = Date.now()): AutomationSchedule {
  const name = draft.name.trim(), goal = draft.goal.trim();
  if (!name || !goal || goal.length > 20000) throw new Error('Enter a schedule name and a task of at most 20,000 characters.');
  if (!profiles.some(value => value === draft.profile)) throw new Error('Choose a supported profile.');
  if (draft.mode !== 'full_control' && draft.mode !== 'auto') throw new Error('Choose Full control or Auto.');
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
  const task: AutomationTask = { goal, profile: draft.profile as AutomationTask['profile'], mode: draft.mode, ...model };

  if (draft.frequency === 'calendar') {
    if (!validNamedZone(draft.timezone)) throw new Error('Enter a valid named IANA time zone, such as America/New_York.');
    if (!calendarFolds.some(fold => fold === draft.calendarFold)) throw new Error('Choose how to handle repeated daylight-saving hours.');
    const expression = compileCalendarExpression(draft.calendarPreset, draft.calendarTime, draft.calendarDays, draft.calendarExpression);
    const calendar: CalendarDefinition = { kind: 'cron', expression, timezone: draft.timezone, gap: 'skip', fold: draft.calendarFold };
    const unchanged = initial?.calendar !== undefined &&
      initial.calendar.expression === calendar.expression &&
      initial.calendar.timezone === calendar.timezone &&
      initial.calendar.gap === calendar.gap &&
      initial.calendar.fold === calendar.fold;
    const nextAt = unchanged ? initial.nextAt : Math.trunc(now);
    return { name, timezone: calendar.timezone, nextAt, intervalMs: null, calendar, missed: draft.missed as AutomationSchedule['missed'], paused: initial?.paused ?? false, task };
  }

  if (!validZone(draft.timezone)) throw new Error('Enter a valid IANA display time zone, such as Europe/London.');
  const parsed = new Date(draft.start).getTime();
  // An untouched edit must preserve sub-minute precision and ambiguous DST offsets.
  const nextAt = initial && draft.start === localDateInput(initial.nextAt) ? initial.nextAt : parsed;
  if (!Number.isSafeInteger(nextAt) || nextAt < 0 || localDateInput(nextAt) !== draft.start) throw new Error('Choose a valid start date and time on this Mac.');
  if ((!initial || nextAt !== initial.nextAt) && nextAt <= now) throw new Error('Choose a future start time.');
  const intervalMs = draft.frequency === 'once' ? null : Math.round(Number(draft.intervalMinutes) * 60000);
  if (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || Number(draft.intervalMinutes) < 1 || intervalMs < 60000)) throw new Error('Use a fixed interval of at least one minute.');
  return { name, timezone: draft.timezone, nextAt, intervalMs, missed: draft.missed as AutomationSchedule['missed'], paused: initial?.paused ?? false, task };
}

export function intervalLabel(intervalMs: number | null): string {
  if (intervalMs === null) return 'One time';
  const hours = intervalMs / 3600000;
  return Number.isInteger(hours) ? `Every ${hours} ${hours === 1 ? 'hour' : 'hours'}` : `Every ${Number((intervalMs / 60000).toFixed(4))} minutes`;
}

export function scheduleFrequencyLabel(schedule: AutomationSchedule): string {
  if (!schedule.calendar) return intervalLabel(schedule.intervalMs);
  const detected = detectCalendarPreset(schedule.calendar.expression);
  if (detected.preset === 'daily') return `Daily at ${detected.time}`;
  if (detected.preset === 'weekdays') return `Weekdays at ${detected.time}`;
  if (detected.preset === 'weekly') {
    const dayNames = detected.days.map(day => calendarWeekdays.find(item => item.value === day)?.label ?? String(day)).join(', ');
    return `Weekly (${dayNames}) at ${detected.time}`;
  }
  return `Calendar (${schedule.calendar.expression})`;
}

export function scheduleTime(schedule: AutomationSchedule): string {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: schedule.timezone }).format(schedule.nextAt); }
  catch { return 'Time unavailable'; }
}

export function formatCalendarSlot(slot: CalendarPreviewSlot, timezone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone,
    }).format(slot.scheduledAt);
    const foldNote = slot.fold === 'unique' ? '' : ` · ${slot.fold} occurrence`;
    return `${formatted} (UTC${slot.offset}${foldNote})`;
  } catch {
    return `${slot.wallTime} (UTC${slot.offset})`;
  }
}

export type CalendarPreviewClient = {
  connected: boolean;
  api: { query: <T>(kind: string, payload?: Record<string, Json>) => Promise<T> };
};
export async function previewCalendarOnServer(client: CalendarPreviewClient | undefined, calendar: CalendarDefinition, limit = 3): Promise<CalendarPreviewResult> {
  if (!client || !client.connected) throw new Error('Connect this server to preview upcoming runs.');
  const raw = await client.api.query<unknown>('automation.preview', { calendar: { ...calendar }, limit });
  if (!isObject(raw) || !['horizon', 'limit', 'search-limit'].includes(String(raw.status)) || !Array.isArray(raw.occurrences)) {
    throw new Error('The server returned an unexpected preview response.');
  }
  const occurrences: CalendarPreviewSlot[] = [];
  for (const item of raw.occurrences) {
    if (!isObject(item) || typeof item.scheduledAt !== 'number' || typeof item.wallTime !== 'string' || typeof item.offset !== 'string' || !['unique', 'earlier', 'later'].includes(String(item.fold))) {
      throw new Error('The server returned an unexpected preview response.');
    }
    occurrences.push({
      scheduledAt: item.scheduledAt,
      wallTime: item.wallTime,
      offset: item.offset,
      fold: item.fold as CalendarPreviewSlot['fold'],
    });
  }
  return { status: raw.status as CalendarPreviewResult['status'], occurrences };
}

export type AutomationClient = AutomationAuthority & { records: ServerRecord[]; command: (kind: string, id: string, revision: number, payload: Record<string, Json>) => Promise<ServerRecord | undefined> };
export async function saveAutomation(client: AutomationClient | undefined, id: string, revision: number, schedule: AutomationSchedule, native: boolean, preview: boolean) {
  const blocked = automationBlocker(client, native, preview) || modeBlocker(schedule.task.mode, client?.runtime);
  if (blocked || !client) throw new Error(blocked);
  const current = client.records.find(record => record.kind === 'automation' && record.id === id);
  if (revision === 0 ? !!current : !current || current.revision !== revision) throw new Error('This schedule changed. Close and reopen it to review the latest version.');
  const payload: Record<string, Json> = {
    name: schedule.name,
    timezone: schedule.timezone,
    nextAt: schedule.nextAt,
    intervalMs: schedule.intervalMs,
    missed: schedule.missed,
    paused: schedule.paused,
    task: { ...schedule.task },
    ...(schedule.calendar ? { calendar: { ...schedule.calendar } } : {}),
  };
  const result = await client.command('automation.save', id, revision, payload);
  if (!result || result.kind !== 'automation' || result.id !== id || result.revision <= revision) throw new Error('Couldn’t confirm the save. Check the latest schedule and server recovery before retrying; do not create another copy.');
  return result;
}

export async function deleteAutomation(client: AutomationClient | undefined, id: string, revision: number, native: boolean, preview: boolean) {
  const blocked = automationBlocker(client, native, preview);
  if (blocked || !client) throw new Error(blocked);
  const current = client.records.find(record => record.kind === 'automation' && record.id === id);
  if (revision < 1 || !current || current.revision !== revision) throw new Error('This schedule changed. Close and reopen it to review the latest version.');
  const result = await client.command('automation.delete', id, revision, {});
  if (!result || result.kind !== 'automation' || result.id !== id || result.revision <= revision || (result.deleted !== true && result.data?.deleted !== true)) {
    throw new Error('Couldn’t confirm the deletion. Check the latest schedules and server recovery before retrying.');
  }
  return result;
}
