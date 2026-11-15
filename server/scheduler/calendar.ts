import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { Cron } from 'croner';
import { z } from 'zod';

const DAY_MS = 86_400_000;
export const CALENDAR_LIMITS = { previewSize: 100, horizonMs: 366 * 8 * DAY_MS, candidates: 10_000 } as const;
// Deliberately bounded to modern dates; no host-local timezone or Date overflow semantics.
export const CalendarTimestamp = z.number().int().min(Date.UTC(1970, 0, 3)).max(Date.UTC(2099, 11, 29));
const definitionSchema = z.strictObject({
  kind: z.literal('cron'),
  expression: z.string().trim().min(1).max(256),
  timezone: z.string().trim().min(1).max(100),
  gap: z.literal('skip'),
  fold: z.enum(['earlier', 'later', 'both']),
});
export type CalendarDefinition = z.infer<typeof definitionSchema>;

function compile(expression: string, years?: string): Cron {
  // No callback/name: Croner is a parser/evaluator here, never a scheduler.
  return new Cron(years ? `0 ${expression} ${years}` : expression, {
    timezone: 'UTC', mode: years ? '7-part' : '5-part', domAndDow: false,
  });
}

const CRON_FIELDS = [
  { min: 0, max: 59, names: [] },
  { min: 0, max: 23, names: [] },
  { min: 1, max: 31, names: [] },
  { min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] },
  { min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
].map(field => {
  const atom = field.names.length ? `(?:\\d+|${field.names.join('|')})` : String.raw`\d+`;
  return { ...field, pattern: new RegExp(`^(?:${atom}|(?:\\*|${atom}-${atom})(?:/\\d+)?)$`, 'i') };
});

function validCronItem(item: string, field: (typeof CRON_FIELDS)[number]): boolean {
  if (!field.pattern.test(item)) return false;
  const [base, step] = item.split('/');
  if (step !== undefined && (!Number.isSafeInteger(Number(step)) || Number(step) <= 0)) return false;
  // Croner checks only visited values in stepped ranges. Validate every atom,
  // including BOTH endpoints, before it can skip an invalid upper bound.
  // Do not rewrite names or Sunday aliases: Croner owns range ordering (including
  // end-of-range SUN = 7), maximum step sizes and recurrence evaluation.
  return base !== undefined && (base === '*' || base.split('-').every(atom => {
    const nameIndex = field.names.indexOf(atom.toUpperCase());
    const value = nameIndex < 0 ? Number(atom) : field.min + nameIndex;
    return Number.isSafeInteger(value) && value >= field.min && value <= field.max;
  }));
}

export function validateCalendarDefinition(input: unknown): CalendarDefinition {
  const value = definitionSchema.parse(input);
  value.expression = value.expression.split(/\s+/).join(' ');
  const fields = value.expression.split(' ');
  if (fields.length !== 5 || !fields.every((field, index) => {
    const bounds = CRON_FIELDS[index];
    return bounds !== undefined && field.split(',').every(item => validCronItem(item, bounds));
  })) {
    throw new RangeError('Expected standard five-field cron (minute hour day month weekday)');
  }
  compile(value.expression);
  // Temporal also accepts ISO datetimes and extracts their zone/offset. Require
  // a named identifier before using it for the runtime availability check.
  if (!/^[A-Za-z][A-Za-z0-9._+\-]*(?:\/[A-Za-z0-9._+\-]+)*$/.test(value.timezone)) {
    throw new RangeError('Expected a named IANA timezone identifier');
  }
  const zone = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value.timezone);
  if (/^[+\-]/.test(zone.timeZoneId)) throw new RangeError('Expected a named IANA timezone, not an offset');
  return value;
}

export interface CalendarSlot {
  scheduledAt: number;
  wallTime: string;
  offset: string;
  fold: 'unique' | 'earlier' | 'later';
}

function resolveWallTime(wallTime: string, definition: CalendarDefinition): CalendarSlot[] {
  const wall = Temporal.PlainDateTime.from(wallTime);
  const earlier = wall.toZonedDateTime(definition.timezone, { disambiguation: 'earlier' });
  const later = wall.toZonedDateTime(definition.timezone, { disambiguation: 'later' });
  // Gap disambiguation moves the clock: neither invented instant is an occurrence.
  if (!earlier.toPlainDateTime().equals(wall) || !later.toPlainDateTime().equals(wall)) return [];
  const unique = earlier.epochMilliseconds === later.epochMilliseconds;
  const choices = unique ? [earlier] : definition.fold === 'both' ? [earlier, later]
    : [definition.fold === 'earlier' ? earlier : later];
  return choices.map(value => ({
    scheduledAt: value.epochMilliseconds, wallTime, offset: value.offset,
    fold: unique ? 'unique' : value.epochMilliseconds === earlier.epochMilliseconds ? 'earlier' : 'later',
  }));
}

const previewRequestSchema = z.strictObject({
  afterAt: CalendarTimestamp,
  throughAt: CalendarTimestamp,
  limit: z.number().int().min(1).max(CALENDAR_LIMITS.previewSize),
  candidateLimit: z.number().int().min(1).max(CALENDAR_LIMITS.candidates).default(CALENDAR_LIMITS.candidates),
}).refine(value => value.throughAt > value.afterAt && value.throughAt - value.afterAt <= CALENDAR_LIMITS.horizonMs,
  'Preview horizon must be positive and at most eight leap years');

export interface CalendarPreview {
  occurrences: CalendarSlot[];
  /** horizon: all slots in the window; limit: requested prefix; search-limit: no safe prefix returned. */
  status: 'horizon' | 'limit' | 'search-limit';
  candidatesExamined: number;
}

/** Strictly after afterAt, inclusive throughAt, in instant order (including both sides of a fold). */
export function previewCalendar(input: unknown, request: unknown): CalendarPreview {
  const definition = validateCalendarDefinition(input);
  const { afterAt, throughAt, limit, candidateLimit } = previewRequestSchema.parse(request);
  // IANA offsets are strictly within 24h. Search a wall-time envelope rather than
  // walking zoned time: wall order is not instant order across a repeated clock.
  const start = afterAt - DAY_MS;
  const end = throughAt + DAY_MS;
  const years = `${new Date(start).getUTCFullYear()}-${new Date(end).getUTCFullYear()}`;
  const cron = compile(definition.expression, years);
  let cursor = new Date(start);
  let candidatesExamined = 0;
  const slots: CalendarSlot[] = [];
  while (candidatesExamined < candidateLimit) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > end) return { occurrences: slots.slice(0, limit), status: slots.length >= limit ? 'limit' : 'horizon', candidatesExamined };
    if (next.getTime() <= cursor.getTime()) throw new Error('Calendar parser did not advance');
    // Once no unseen wall clock can precede the requested prefix, it is safe to return.
    const last = slots[limit - 1];
    if (last && next.getTime() - DAY_MS > last.scheduledAt) {
      return { occurrences: slots.slice(0, limit), status: 'limit', candidatesExamined };
    }
    cursor = next;
    candidatesExamined++;
    const wallTime = next.toISOString().slice(0, 19);
    for (const slot of resolveWallTime(wallTime, definition)) {
      if (slot.scheduledAt > afterAt && slot.scheduledAt <= throughAt) slots.push(slot);
    }
    slots.sort((a, b) => a.scheduledAt - b.scheduledAt);
    // Retaining only the earliest requested prefix bounds memory for dense expressions.
    if (slots.length > limit) slots.length = limit;
  }
  // Never pass an incompletely sorted prefix to admission or advance a cursor on exhaustion.
  return { occurrences: [], status: 'search-limit', candidatesExamined };
}

const identityString = z.string().min(1).max(256);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CalendarBinding = z.strictObject({
  scheduleId: identityString,
  scheduleRevision: revision,
  snapshotDigest: hash,
});
export type CalendarBinding = z.infer<typeof CalendarBinding>;
export interface CalendarOccurrence extends CalendarSlot, CalendarBinding {
  id: string;
  definitionDigest: string;
}
function digest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function calendarDefinitionDigest(input: unknown): string {
  const d = validateCalendarDefinition(input);
  return digest(['outpost.calendar.definition.v1', d.expression, d.timezone, d.gap, d.fold]);
}

/** Binding must be the immutable revision/snapshot saved by the transaction owner. */
export function identifyCalendarOccurrence(input: unknown, bindingInput: unknown, slot: CalendarSlot): CalendarOccurrence {
  const definition = validateCalendarDefinition(input);
  const binding = CalendarBinding.parse(bindingInput);
  CalendarTimestamp.parse(slot.scheduledAt);
  const wall = Temporal.Instant.fromEpochMilliseconds(slot.scheduledAt).toZonedDateTimeISO(definition.timezone).toPlainDateTime();
  const wallTime = wall.toString({ smallestUnit: 'second' });
  if (slot.scheduledAt % 1000 !== 0 || !compile(definition.expression).match(new Date(`${wallTime}Z`)) ||
      !resolveWallTime(wallTime, definition).some(value => JSON.stringify(value) === JSON.stringify({
        scheduledAt: slot.scheduledAt, wallTime: slot.wallTime, offset: slot.offset, fold: slot.fold,
      }))) throw new RangeError('Slot does not belong to calendar definition');
  const definitionDigest = calendarDefinitionDigest(definition);
  // Snapshot is deliberately NOT a key component: changing pins under an existing
  // revision must conflict, not manufacture a second occurrence of the same slot.
  const id = digest(['outpost.calendar.occurrence.v1', binding.scheduleId, binding.scheduleRevision, definitionDigest, slot.scheduledAt]);
  return { ...slot, ...binding, definitionDigest, id };
}

/** Stable across schedule edits. Authenticate/namespace source before calling; no payload is trusted here. */
export function calendarEventIdentity(input: unknown): string {
  const value = z.strictObject({ scheduleId: identityString, source: identityString, eventId: identityString }).parse(input);
  return digest(['outpost.calendar.event.v1', value.scheduleId, value.source, value.eventId]);
}
