import { z } from 'zod';
import {
  CalendarBinding, CalendarTimestamp, calendarDefinitionDigest, identifyCalendarOccurrence,
} from './calendar.js';
import type { CalendarOccurrence } from './calendar.js';

const eligibilitySchema = z.strictObject({
  binding: CalendarBinding,
  now: CalendarTimestamp,
  previousObservedAt: CalendarTimestamp,
  effectiveFrom: CalendarTimestamp,
  effectiveUntil: CalendarTimestamp.nullable(),
  paused: z.boolean(),
  revoked: z.boolean(),
  cancelled: z.boolean(),
  missed: z.enum(['skip', 'coalesce']),
  onTimeGraceMs: z.number().int().min(0).max(86_400_000),
  maxLatenessMs: z.number().int().min(0).max(366 * 86_400_000),
  overlap: z.enum(['forbid', 'allow']),
  activeRuns: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  completeWindow: z.boolean(),
  consumedOccurrenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
}).refine(value => value.onTimeGraceMs <= value.maxLatenessMs, 'Grace cannot exceed maximum lateness')
  .refine(value => value.effectiveUntil === null || value.effectiveUntil > value.effectiveFrom, 'Invalid revision window');
export type CalendarEligibilityInput = z.infer<typeof eligibilitySchema>;
export type CalendarEligibilityReason = 'eligible' | 'paused' | 'revoked' | 'cancelled' | 'clock-regressed' |
  'incomplete-window' | 'stale-revision' | 'outside-revision' | 'not-due' | 'duplicate' | 'too-late' |
  'missed' | 'coalesced' | 'overlap';
export interface CalendarEligibility {
  eligible: CalendarOccurrence[];
  decisions: { id: string; reason: CalendarEligibilityReason }[];
  hold: 'paused' | 'revoked' | 'cancelled' | 'clock-regressed' | 'incomplete-window' | null;
}

/** Pure advice, not an admission receipt. Recheck under the existing scheduler's fenced transaction. */
export function calculateCalendarEligibility(definition: unknown, input: unknown, occurrences: readonly CalendarOccurrence[]): CalendarEligibility {
  const state = eligibilitySchema.parse(input);
  if (occurrences.length > 1000) throw new RangeError('At most 1000 occurrences per eligibility window');
  const definitionDigest = calendarDefinitionDigest(definition);
  const seen = new Map<string, CalendarOccurrence>();
  for (const occurrence of occurrences) {
    // Old revisions/definitions are classified below, but their identities must not
    // collide within a batch. A caller must retain the original definition for replay.
    const prior = seen.get(occurrence.id);
    if (prior && (prior.scheduleId !== occurrence.scheduleId || prior.scheduleRevision !== occurrence.scheduleRevision ||
      prior.snapshotDigest !== occurrence.snapshotDigest || prior.definitionDigest !== occurrence.definitionDigest ||
      prior.scheduledAt !== occurrence.scheduledAt || prior.wallTime !== occurrence.wallTime ||
      prior.offset !== occurrence.offset || prior.fold !== occurrence.fold)) throw new RangeError('Conflicting occurrence identity');
    if (occurrence.definitionDigest === definitionDigest) {
      const expected = identifyCalendarOccurrence(definition, {
        scheduleId: occurrence.scheduleId, scheduleRevision: occurrence.scheduleRevision, snapshotDigest: occurrence.snapshotDigest,
      }, occurrence);
      if (expected.id !== occurrence.id) throw new RangeError('Invalid occurrence identity');
    }
    seen.set(occurrence.id, occurrence);
  }
  const ordered = [...seen.values()].sort((a, b) => a.scheduledAt - b.scheduledAt);
  const consumed = new Set(state.consumedOccurrenceIds);
  const current = (o: CalendarOccurrence) => o.scheduleId === state.binding.scheduleId &&
    o.scheduleRevision === state.binding.scheduleRevision && o.snapshotDigest === state.binding.snapshotDigest &&
    o.definitionDigest === definitionDigest;
  const inRevision = (o: CalendarOccurrence) => o.scheduledAt >= state.effectiveFrom &&
    (state.effectiveUntil === null || o.scheduledAt < state.effectiveUntil);
  // Choose before filtering receipts: a consumed latest slot must not resurrect an older one.
  const latest = ordered.filter(o => current(o) && inRevision(o) && o.scheduledAt <= state.now).at(-1);
  const hold = state.revoked ? 'revoked' : state.cancelled ? 'cancelled' : state.paused ? 'paused'
    : state.now < state.previousObservedAt ? 'clock-regressed' : !state.completeWindow ? 'incomplete-window' : null;
  const eligible: CalendarOccurrence[] = [];
  const decisions = ordered.map(occurrence => {
    let reason: CalendarEligibilityReason;
    const lateness = state.now - occurrence.scheduledAt;
    if (hold) reason = hold;
    else if (!current(occurrence)) reason = 'stale-revision';
    else if (!inRevision(occurrence)) reason = 'outside-revision';
    else if (lateness < 0) reason = 'not-due';
    else if (consumed.has(occurrence.id)) reason = 'duplicate';
    else if (lateness > state.maxLatenessMs) reason = 'too-late';
    else if (state.missed === 'skip' && lateness > state.onTimeGraceMs) reason = 'missed';
    else if (occurrence.id !== latest?.id) reason = 'coalesced';
    else if (state.overlap === 'forbid' && state.activeRuns > 0) reason = 'overlap';
    else { reason = 'eligible'; eligible.push(occurrence); }
    return { id: occurrence.id, reason };
  });
  return { eligible, decisions, hold };
}
