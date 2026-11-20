import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { digest, id } from '../core/contracts.js';
import { NewTask, Tasks } from '../tasks/tasks.js';
import {
  CALENDAR_LIMITS,
  MAX_CALENDAR_TIMESTAMP,
  MIN_CALENDAR_TIMESTAMP,
  calendarDefinitionDigest,
  identifyCalendarOccurrence,
  previewCalendar,
  validateCalendarDefinition,
  type CalendarDefinition,
  type CalendarSlot,
} from './calendar.js';
import { calculateCalendarEligibility } from './calendar-eligibility.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const CALENDAR_ON_TIME_GRACE_MS = 60_000;
export const CALENDAR_MAX_LATENESS_MS = 366 * DAY_MS;

export const CalendarScheduleDefinition = z.strictObject({
  kind: z.literal('cron'),
  expression: z.string().trim().min(1).max(256),
  timezone: z.string().trim().min(1).max(100),
  gap: z.literal('skip').default('skip'),
  fold: z.enum(['earlier', 'later', 'both']).default('earlier'),
});

export const Schedule = z.strictObject({
  name: z.string().min(1),
  timezone: z.string(),
  nextAt: z.number().int().nonnegative(),
  intervalMs: z.number().int().min(60000).nullable(),
  missed: z.enum(['skip', 'coalesce']),
  paused: z.boolean().default(false),
  task: NewTask,
  calendar: CalendarScheduleDefinition.optional(),
});
export type Schedule = z.infer<typeof Schedule>;

export function previewNextCalendarSlot(calendar: CalendarDefinition, afterAt: number): CalendarSlot {
  const throughAt = Math.min(afterAt + CALENDAR_LIMITS.horizonMs, MAX_CALENDAR_TIMESTAMP);
  if (throughAt <= afterAt) throw new RangeError('No upcoming calendar occurrence within horizon');
  const preview = previewCalendar(calendar, { afterAt, throughAt, limit: 1 });
  if (preview.status === 'search-limit') throw new RangeError('Calendar preview exceeded search limit');
  const slot = preview.occurrences[0];
  if (!slot) throw new RangeError('No upcoming calendar occurrence within horizon');
  return slot;
}

export function prepareSchedule(input: unknown, existing?: Schedule, now = Date.now()): Schedule {
  const schedule = Schedule.parse(input);
  if (!schedule.calendar) {
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format();
    return schedule;
  }
  if (schedule.intervalMs !== null) {
    throw new RangeError('Calendar schedules cannot set intervalMs');
  }
  const calendar = validateCalendarDefinition(schedule.calendar);
  if (schedule.timezone.trim() !== calendar.timezone) {
    throw new RangeError('Schedule timezone must match calendar timezone');
  }
  const anchor = schedule.nextAt === 0 ? Math.trunc(now) : schedule.nextAt;
  let nextAt: number;
  const sameDefinition = existing?.calendar !== undefined
    && existing.nextAt === schedule.nextAt
    && calendarDefinitionDigest(existing.calendar) === calendarDefinitionDigest(calendar);
  if (sameDefinition && existing.nextAt > MIN_CALENDAR_TIMESTAMP && existing.nextAt <= MAX_CALENDAR_TIMESTAMP) {
    const verify = previewCalendar(calendar, { afterAt: existing.nextAt - 1, throughAt: existing.nextAt, limit: 1 });
    nextAt = verify.status !== 'search-limit' && verify.occurrences.some(slot => slot.scheduledAt === existing.nextAt)
      ? existing.nextAt
      : previewNextCalendarSlot(calendar, anchor).scheduledAt;
  } else {
    nextAt = previewNextCalendarSlot(calendar, anchor).scheduledAt;
  }
  return { ...schedule, timezone: calendar.timezone, nextAt, calendar };
}

function collectDueCalendarSlots(calendar: CalendarDefinition, nextAt: number, time: number): { slots: CalendarSlot[]; completeWindow: boolean } {
  const windowStart = Math.max(nextAt - 1, time - CALENDAR_LIMITS.horizonMs, MIN_CALENDAR_TIMESTAMP);
  if (time <= windowStart) return { slots: [], completeWindow: true };
  const initial = previewCalendar(calendar, { afterAt: windowStart, throughAt: time, limit: CALENDAR_LIMITS.previewSize });
  if (initial.status === 'search-limit') return { slots: [], completeWindow: false };
  if (initial.status === 'horizon') return { slots: initial.occurrences, completeWindow: true };

  // More than previewSize slots fell due during downtime: isolate a complete tail
  // window ending at `time` so eligibility sees the exact newest due occurrence.
  for (const span of [HOUR_MS, DAY_MS, 7 * DAY_MS, 31 * DAY_MS, 366 * DAY_MS, CALENDAR_LIMITS.horizonMs]) {
    const tailStart = Math.max(windowStart, time - span);
    if (tailStart >= time) continue;
    const tail = previewCalendar(calendar, { afterAt: tailStart, throughAt: time, limit: CALENDAR_LIMITS.previewSize });
    if (tail.status === 'search-limit') return { slots: [], completeWindow: false };
    if (tail.status === 'horizon') {
      if (tail.occurrences.length > 0) return { slots: tail.occurrences, completeWindow: true };
      if (tailStart === windowStart) return { slots: [], completeWindow: true };
      continue;
    }
    let lo = tailStart;
    let hi = time;
    for (let step = 0; step < 24 && hi - lo > 1; step++) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = previewCalendar(calendar, { afterAt: mid, throughAt: time, limit: CALENDAR_LIMITS.previewSize });
      if (probe.status === 'search-limit') return { slots: [], completeWindow: false };
      if (probe.status === 'horizon') {
        if (probe.occurrences.length > 0) return { slots: probe.occurrences, completeWindow: true };
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return { slots: [], completeWindow: false };
  }
  return { slots: [], completeWindow: false };
}

export class Scheduler {
  private observedAt = new Map<string, number>();
  constructor(private db: Ledger, private tasks: Tasks) {}
  save(key: string, expected: number, input: unknown) {
    return this.db.transaction(() => {
      const existing = this.db.get<Schedule>('automation', key);
      const existingSchedule = existing ? Schedule.parse(existing.data) : undefined;
      const schedule = prepareSchedule(input, existingSchedule);
      return this.db.put('automation', key, expected, schedule);
    });
  }
  delete(key: string, expectedRevision: number) {
    const deleted = this.db.transaction(() => this.db.delete('automation', key, expectedRevision, 'automation.deleted'));
    this.observedAt.delete(key);
    return deleted;
  }
  tick(time = Date.now()) {
    const observedUpdates: [string, number][] = [];
    const started = this.db.transaction(() => {
      const created: string[] = [];
      for (const row of this.db.list<Schedule>('automation')) {
        const schedule = this.db.get<Schedule>('automation', row.id);
        if (!schedule || schedule.revision !== row.revision) continue;
        const data = Schedule.parse(schedule.data);
        if (data.paused || data.nextAt > time) {
          if (data.calendar && time >= MIN_CALENDAR_TIMESTAMP && time <= MAX_CALENDAR_TIMESTAMP) {
            observedUpdates.push([schedule.id, Math.max(this.observedAt.get(schedule.id) ?? time, time)]);
          }
          continue;
        }
        if (!data.calendar) {
          const occurrence = `${schedule.id}:${schedule.revision}:${data.nextAt}`;
          const overdue = data.intervalMs !== null && time - data.nextAt >= data.intervalMs;
          if (!(overdue && data.missed === 'skip') && !this.db.get('occurrence', occurrence)) {
            const taskId = id();
            this.tasks.create(taskId, data.task);
            created.push(taskId);
            this.db.put('occurrence', occurrence, 0, { automationId: schedule.id, taskId, scheduledAt: data.nextAt });
          }
          const nextAt = data.intervalMs ? data.nextAt + (Math.floor((time - data.nextAt) / data.intervalMs) + 1) * data.intervalMs : data.nextAt;
          this.db.put('automation', schedule.id, schedule.revision, { ...data, nextAt, paused: data.intervalMs === null });
          continue;
        }

        if (time < MIN_CALENDAR_TIMESTAMP || time > MAX_CALENDAR_TIMESTAMP) continue;
        const calendar = validateCalendarDefinition(data.calendar);
        const snapshotDigest = digest({ id: schedule.id, revision: schedule.revision, schedule: data });
        const binding = { scheduleId: schedule.id, scheduleRevision: schedule.revision, snapshotDigest };
        const due = collectDueCalendarSlots(calendar, data.nextAt, time);
        const occurrences = due.slots.map(slot => identifyCalendarOccurrence(calendar, binding, slot));
        const consumedOccurrenceIds = occurrences.filter(o => !!this.db.get('occurrence', o.id)).map(o => o.id);
        const previousObservedAt = this.observedAt.get(schedule.id) ?? Math.min(data.nextAt, time);
        const advice = calculateCalendarEligibility(calendar, {
          binding,
          now: time,
          previousObservedAt,
          effectiveFrom: data.nextAt,
          effectiveUntil: null,
          paused: data.paused,
          revoked: false,
          cancelled: false,
          missed: data.missed,
          onTimeGraceMs: CALENDAR_ON_TIME_GRACE_MS,
          maxLatenessMs: CALENDAR_MAX_LATENESS_MS,
          overlap: 'allow',
          activeRuns: 0,
          completeWindow: due.completeWindow,
          consumedOccurrenceIds,
        }, occurrences);

        // Eligibility is pure advice: recheck binding, pause, receipts and next slot inside the fenced transaction.
        const fenced = this.db.get<Schedule>('automation', schedule.id);
        if (!fenced || fenced.revision !== schedule.revision) continue;
        const fencedData = Schedule.parse(fenced.data);
        if (fencedData.paused || advice.hold !== null) continue;

        const nextThroughAt = Math.min(time + CALENDAR_LIMITS.horizonMs, MAX_CALENDAR_TIMESTAMP);
        const following = nextThroughAt > time
          ? previewCalendar(calendar, { afterAt: time, throughAt: nextThroughAt, limit: 1 })
          : { occurrences: [], status: 'horizon' as const, candidatesExamined: 0 };
        if (following.status === 'search-limit') continue;

        for (const chosen of advice.eligible) {
          if (chosen.scheduledAt > time || chosen.scheduleRevision !== fenced.revision || chosen.snapshotDigest !== snapshotDigest) continue;
          if (this.db.get('occurrence', chosen.id)) continue;
          const taskId = id();
          this.tasks.create(taskId, fencedData.task);
          created.push(taskId);
          this.db.put('occurrence', chosen.id, 0, {
            automationId: fenced.id,
            taskId,
            scheduledAt: chosen.scheduledAt,
            wallTime: chosen.wallTime,
            offset: chosen.offset,
            fold: chosen.fold,
          });
        }
        const nextSlot = following.occurrences[0];
        this.db.put('automation', fenced.id, fenced.revision, nextSlot
          ? { ...fencedData, nextAt: nextSlot.scheduledAt }
          : { ...fencedData, paused: true });
        observedUpdates.push([fenced.id, Math.max(previousObservedAt, time)]);
      }
      return created;
    });
    for (const [key, observed] of observedUpdates) this.observedAt.set(key, observed);
    return started;
  }
  changed(monitorId: string, observed: string) {
    const hash = digest(observed), previous = this.db.get('monitor', monitorId);
    if (previous?.data.hash === hash) return false;
    this.db.put('monitor', monitorId, previous?.revision ?? 0, { hash, observedAt: Date.now() }); return previous !== undefined;
  }
}
