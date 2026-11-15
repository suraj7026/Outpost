import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarEventIdentity, identifyCalendarOccurrence, previewCalendar, validateCalendarDefinition } from './calendar.js';
import type { CalendarDefinition } from './calendar.js';
import { calculateCalendarEligibility } from './calendar-eligibility.js';
import type { CalendarEligibilityInput } from './calendar-eligibility.js';

const ms = (value: string) => Date.parse(value);
const definition = (timezone = 'UTC', expression = '30 2 * * *', fold: CalendarDefinition['fold'] = 'earlier'): CalendarDefinition =>
  ({ kind: 'cron', expression, timezone, gap: 'skip', fold });
const preview = (d: CalendarDefinition, after: string, through: string, limit = 3) =>
  previewCalendar(d, { afterAt: ms(after), throughAt: ms(through), limit });
const times = (result: ReturnType<typeof preview>) => result.occurrences.map(o => new Date(o.scheduledAt).toISOString());

test('calendar validates five-field cron, explicit zones and bounded requests', () => {
  assert.equal(validateCalendarDefinition({ ...definition(), expression: '  0   9 * * MON  ' }).expression, '0 9 * * MON');
  for (const expression of ['@daily', '* * * * * *', '0 25 * * *', '0 9 * * MON#2', 'H * * * *', '0 9 ? * *', 'a'.repeat(257)]) {
    assert.throws(() => validateCalendarDefinition({ ...definition(), expression }));
  }
  for (const timezone of ['Invalid/Zone', '+05:30', '']) assert.throws(() => validateCalendarDefinition({ ...definition(), timezone }));
  assert.throws(() => validateCalendarDefinition({ ...definition(), gap: 'shift' }));
  for (const limit of [0, 101, Infinity, 1.5]) assert.throws(() => previewCalendar(definition(), { afterAt: ms('2026-01-01'), throughAt: ms('2026-02-01'), limit }));
  assert.throws(() => previewCalendar(definition(), { afterAt: ms('2026-01-01'), throughAt: ms('2040-01-01'), limit: 1 }));
  assert.throws(() => previewCalendar(definition(), { afterAt: NaN, throughAt: ms('2026-01-01'), limit: 1 }));
});

test('calendar rejects cron modifiers, partial tokens and names in the wrong field', () => {
  for (const expression of [
    '0 9 L * *', '0 9 15W * *', '0 9 * * 5L', '0* 9 * * *',
    '0 9 LW * *', '0 9 * * MONL', '0 9 * * MON#2', '0 9 * * +MON',
    '0x10 9 * * *', '0a 9 * * *', '1e1 9 * * *', '0-15x 9 * * *',
    '*/5x 9 * * *', '0-30/5x 9 * * *', '*/0 9 * * *', '1/5 9 * * *',
    '/5 9 * * *', '*//5 9 * * *', '0-30/ 9 * * *', '0- 9 * * *',
    '0,,30 9 * * *', '0, 9 * * *', '0 9 * * MON,', '0 9 * * MON-FRIX',
    'MON 9 * * *', '0 JAN * * *', '0 9 MON * *', '0 9 * MON *', '0 9 * * JAN',
    '60 9 * * *', '0 24 * * *', '0 9 0 * *', '0 9 * 13 *', '0 9 * * 8',
  ]) {
    assert.throws(() => validateCalendarDefinition(definition('UTC', expression)), `reject ${expression}`);
    assert.throws(() => preview(definition('UTC', expression), '2026-01-01T00:00Z', '2026-02-01T00:00Z'), `preview rejects ${expression}`);
  }
});

function assertInvalidExpression(expression: string): void {
  assert.throws(() => validateCalendarDefinition(definition('UTC', expression)), `reject ${expression}`);
  assert.throws(() => preview(definition('UTC', expression), '2026-01-01T00:00Z', '2026-01-03T23:59:59Z'), `preview rejects ${expression}`);
}

for (const expression of ['0-60/59 9 * * *', '0 9 * 1-13/11 *', '0 9 * * 0-8/5']) {
  test(`calendar rejects parent-reproduced skipped endpoint: ${expression}`, () => {
    assertInvalidExpression(expression);
  });
}

for (const [index, name, min, max, maxStep] of [
  [0, 'minute', 0, 59, 60], [1, 'hour', 0, 23, 24], [2, 'day', 1, 31, 31],
  [3, 'month', 1, 12, 12], [4, 'weekday', 0, 7, 7],
] as const) {
  test(`calendar rejects invalid ${name} atoms, both endpoints and steps`, () => {
    const expressionFor = (item: string) => ['0', '9', '*', '*', '*'].map((field, i) => i === index ? item : field).join(' ');
    for (const outside of [String(min - 1), String(max + 1), '9007199254740991', '9007199254740992', '999999999999999999999999999999999999']) {
      for (const item of [outside, `${min},${outside}`, `${outside}-${max}`, `${min}-${outside}`,
        `${outside}-${max}/2`, `${min}-${outside}/2`, `${outside}-${outside}/2`]) {
        assertInvalidExpression(expressionFor(item));
      }
    }
    // Upper endpoints are invalid even when the step never visits them (hour/day analogues included).
    assertInvalidExpression(expressionFor(`${min}-${max + 1}/${max - min}`));
    for (const step of ['0', '-1', '1.5', '1e1', String(maxStep + 1), '9007199254740991', '9007199254740992']) {
      for (const base of ['*', `${min}-${max}`]) assertInvalidExpression(expressionFor(`${base}/${step}`));
    }
    assertInvalidExpression(expressionFor(`${max}-${min}/2`));
  });
}

test('calendar rejects invalid endpoints hidden among mixed names and list items', () => {
  for (const expression of [
    '0 9 * JAN-13/11 *', '0 9 * JAN,1-13/11 *', '0 9 * 0-DEC/11 *',
    '0 9 * 13-DEC/2 *', '0 9 * JAN,DEC-13/2 *', '0 9 * DEC-JAN/2 *',
    '0 9 * * SUN-8/5', '0 9 * * MON,0-8/5', '0 9 * * 8-SUN/2',
    '0 9 * * MON,SAT-8/3', '0 9 * * FRI-MON/2', '0 9 * * SUN,9007199254740992-7/2',
  ]) assertInvalidExpression(expression);
});

test('calendar preserves field boundaries, maximum steps and steps larger than ranges', () => {
  for (const [expression, after, through, expected] of [
    ['0,59 9 * * *', '2026-01-01T08:59Z', '2026-01-01T10:00Z', ['2026-01-01T09:00:00.000Z', '2026-01-01T09:59:00.000Z']],
    ['0 0,23 * * *', '2025-12-31T23:59Z', '2026-01-01T23:59Z', ['2026-01-01T00:00:00.000Z', '2026-01-01T23:00:00.000Z']],
    ['0 9 1,31 * *', '2026-01-01T00:00Z', '2026-01-31T23:59Z', ['2026-01-01T09:00:00.000Z', '2026-01-31T09:00:00.000Z']],
    ['0 9 1 1,12 *', '2026-01-01T00:00Z', '2026-12-02T00:00Z', ['2026-01-01T09:00:00.000Z', '2026-12-01T09:00:00.000Z']],
    ['0-59/59 0-23/23 1-31/30 1-12/11 *', '2026-01-01T00:00Z', '2026-01-02T00:00Z', ['2026-01-01T00:59:00.000Z', '2026-01-01T23:00:00.000Z', '2026-01-01T23:59:00.000Z']],
    ['*/60 */24 */31 */12 *', '2025-12-31T23:59Z', '2026-01-02T00:00Z', ['2026-01-01T00:00:00.000Z']],
    ['0-1/60 0-1/24 1-2/31 1-2/12 *', '2025-12-31T23:59Z', '2026-01-02T00:00Z', ['2026-01-01T00:00:00.000Z']],
    ['0 9 * JAN-3/2,12 MON-5/2,7', '2026-01-01T00:00Z', '2026-01-06T00:00Z', ['2026-01-02T09:00:00.000Z', '2026-01-04T09:00:00.000Z', '2026-01-05T09:00:00.000Z']],
    ['0 9 * 1-mar/2,DEC 1-fri/2,SUN', '2026-01-01T00:00Z', '2026-01-06T00:00Z', ['2026-01-02T09:00:00.000Z', '2026-01-04T09:00:00.000Z', '2026-01-05T09:00:00.000Z']],
  ] as const) {
    assert.equal(validateCalendarDefinition(definition('UTC', expression)).expression, expression);
    assert.deepEqual(times(preview(definition('UTC', expression), after, through)), expected, expression);
  }
  for (const weekday of ['0', '7', 'SUN', '0,7,SUN', '*/7', '0-7/7', 'SUN-SUN/7', '7-SUN', '7-7', '0-1/7']) {
    const expression = `0 9 * * ${weekday}`;
    assert.equal(validateCalendarDefinition(definition('UTC', expression)).expression, expression);
    assert.deepEqual(times(preview(definition('UTC', expression), '2026-01-03T00:00Z', '2026-01-06T00:00Z')), ['2026-01-04T09:00:00.000Z'], expression);
  }
  for (const weekday of ['SAT-SUN', '6-7', '6-SUN', 'SAT-7', 'sat-sun/1']) {
    assert.deepEqual(times(preview(definition('UTC', `0 9 * * ${weekday}`), '2026-01-02T00:00Z', '2026-01-05T00:00Z')), [
      '2026-01-03T09:00:00.000Z', '2026-01-04T09:00:00.000Z',
    ], weekday);
  }
});

test('calendar accepts field-aware names, lists, ranges and wildcard/range steps', () => {
  for (const expression of [
    '0,30 9-10 * JAN,MAR MON-FRI', '0-30/15 9 * JAN-MAR/2 MON,WED',
    '*/20 9 * * *', '0 9 * jan-mar mon-fri', '0 9 * * 0,7',
    '0 9 1,15 * *', '0 9 1-31/2 1-12/2 1-5/2',
  ]) assert.equal(validateCalendarDefinition(definition('UTC', expression)).expression, expression);
  assert.deepEqual(times(preview(definition('UTC', '0,30 9-10 * JAN,MAR MON-FRI'), '2026-01-05T08:59Z', '2026-01-05T10:30Z', 5)), [
    '2026-01-05T09:00:00.000Z', '2026-01-05T09:30:00.000Z', '2026-01-05T10:00:00.000Z', '2026-01-05T10:30:00.000Z',
  ]);
  assert.deepEqual(times(preview(definition('UTC', '0-30/15 9 * JAN-MAR/2 MON,WED'), '2026-01-05T08:59Z', '2026-01-05T10:00Z')), [
    '2026-01-05T09:00:00.000Z', '2026-01-05T09:15:00.000Z', '2026-01-05T09:30:00.000Z',
  ]);
  assert.deepEqual(times(preview(definition('UTC', '*/20 9 * * *'), '2026-01-05T08:59Z', '2026-01-05T10:00Z')), [
    '2026-01-05T09:00:00.000Z', '2026-01-05T09:20:00.000Z', '2026-01-05T09:40:00.000Z',
  ]);
});

test('calendar rejects timezone-like datetime and offset strings, including annotations', () => {
  for (const timezone of [
    '2026-01-01T00:00+05:30', '2026-01-01T00:00Z', '2026-01-01T00:00-04:00[America/New_York]',
    '2026-01-01T00:00[America/New_York]', '2026-01-01T00:00[!America/New_York]',
    '2026-01-01T00:00+05:30[+05:30]', '[America/New_York]',
    '+05:30', '-04:00', '+0530', '+05', 'Z', 'Invalid/Zone', 'America//New_York',
  ]) {
    assert.throws(() => validateCalendarDefinition(definition(timezone)), `reject ${timezone}`);
    assert.throws(() => preview(definition(timezone), '2026-01-01T00:00Z', '2026-01-02T00:00Z'), `preview rejects ${timezone}`);
  }
});

test('calendar accepts named IANA zones and aliases without changing their spelling', () => {
  for (const [timezone, expected] of [
    ['UTC', '2026-01-01T09:00:00.000Z'], ['Etc/UTC', '2026-01-01T09:00:00.000Z'],
    ['US/Eastern', '2026-01-01T14:00:00.000Z'], ['America/New_York', '2026-01-01T14:00:00.000Z'],
    ['Asia/Kolkata', '2026-01-01T03:30:00.000Z'], ['Etc/GMT+5', '2026-01-01T14:00:00.000Z'],
  ] as const) {
    const d = definition(timezone, '0 9 * * *');
    assert.equal(validateCalendarDefinition(d).timezone, timezone);
    assert.deepEqual(times(preview(d, '2026-01-01T00:00Z', '2026-01-02T00:00Z')), [expected]);
  }
});

for (const [zone, after, through, expected] of [
  ['America/New_York', '2026-03-08T00:00Z', '2026-03-10T00:00Z', '2026-03-09T06:30:00.000Z'],
  ['Europe/Berlin', '2026-03-29T00:00Z', '2026-03-31T00:00Z', '2026-03-30T00:30:00.000Z'],
  ['Australia/Lord_Howe', '2026-10-03T12:00Z', '2026-10-05T12:00Z', '2026-10-04T15:15:00.000Z'],
]) test(`calendar skips spring gap in ${zone}`, () => {
  assert.deepEqual(times(preview(definition(zone, zone === 'Australia/Lord_Howe' ? '15 2 * * *' : '30 2 * * *'), after!, through!, 1)), [expected]);
});

for (const [zone, expression, after, through, earlier, later] of [
  ['America/New_York', '30 1 * * *', '2026-11-01T00:00Z', '2026-11-02T00:00Z', '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
  ['Europe/Berlin', '30 2 * * *', '2026-10-24T23:00Z', '2026-10-25T04:00Z', '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
  ['Australia/Lord_Howe', '45 1 * * *', '2026-04-04T12:00Z', '2026-04-04T18:00Z', '2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z'],
]) test(`calendar fold policies and strict cursors in ${zone}`, () => {
  for (const fold of ['earlier', 'later', 'both'] as const) {
    const d = definition(zone, expression, fold);
    assert.deepEqual(times(preview(d, after!, through!)), fold === 'both' ? [earlier, later] : [fold === 'earlier' ? earlier : later]);
    assert.deepEqual(times(preview(d, earlier!, through!)), fold === 'earlier' ? [] : [later]);
    assert.deepEqual(times(preview(d, later!, through!)), []);
  }
});

test('calendar sorts dense folds by instant, not wall order; no duplicate slots', () => {
  const result = preview(definition('America/New_York', '* 1 * * *', 'both'), '2026-11-01T05:58Z', '2026-11-01T07:00Z', 4);
  assert.deepEqual(times(result), ['2026-11-01T05:59:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T06:01:00.000Z', '2026-11-01T06:02:00.000Z']);
});

test('calendar DOM and DOW use OR; sparse and impossible expressions have bounded outcomes', () => {
  assert.deepEqual(times(preview(definition('UTC', '0 9 15 * MON'), '2026-06-01T09:00Z', '2026-06-20T00:00Z')), ['2026-06-08T09:00:00.000Z', '2026-06-15T09:00:00.000Z']);
  const leap = preview(definition('UTC', '0 0 29 2 *'), '2026-01-01T00:00Z', '2031-01-01T00:00Z');
  assert.deepEqual(times(leap), ['2028-02-29T00:00:00.000Z']);
  const impossible = preview(definition('UTC', '0 0 31 2 *'), '2026-01-01T00:00Z', '2031-01-01T00:00Z');
  assert.equal(impossible.status, 'horizon'); assert.deepEqual(impossible.occurrences, []);
  const exhausted = previewCalendar(definition('UTC', '* * * * *'), { afterAt: ms('2026-01-01'), throughAt: ms('2026-01-03'), limit: 1, candidateLimit: 2 });
  assert.deepEqual(exhausted, { status: 'search-limit', candidatesExamined: 2, occurrences: [] });
  const gapsOnly = preview(definition('America/New_York', '30 2 8 3 *'), '2026-03-07T00:00Z', '2026-03-09T00:00Z');
  assert.deepEqual(times(gapsOnly), []);
});

const binding = { scheduleId: 'daily', scheduleRevision: 1, snapshotDigest: 'a'.repeat(64) };
const daily = definition('UTC', '0 9 * * *');
const slots = preview(daily, '2026-06-01T00:00Z', '2026-06-04T00:00Z').occurrences;
const occurrences = slots.map(slot => identifyCalendarOccurrence(daily, binding, slot));
const state: CalendarEligibilityInput = {
  binding, now: ms('2026-06-03T09:01Z'), previousObservedAt: ms('2026-06-01T00:00Z'),
  effectiveFrom: ms('2026-06-01T00:00Z'), effectiveUntil: null,
  paused: false, revoked: false, cancelled: false, missed: 'coalesce', onTimeGraceMs: 60_000,
  maxLatenessMs: 3 * 86_400_000, overlap: 'forbid', activeRuns: 0, completeWindow: true, consumedOccurrenceIds: [],
};
const eligibility = (changes: Partial<CalendarEligibilityInput> = {}, batch = occurrences) => calculateCalendarEligibility(daily, { ...state, ...changes }, batch);

test('calendar identity pins revision, zone and fold without changing on retry or snapshot conflict', () => {
  const first = occurrences[0]!;
  assert.equal(identifyCalendarOccurrence(daily, binding, slots[0]!).id, first.id);
  assert.notEqual(identifyCalendarOccurrence(daily, { ...binding, scheduleRevision: 2 }, slots[0]!).id, first.id);
  assert.equal(identifyCalendarOccurrence(daily, { ...binding, snapshotDigest: 'b'.repeat(64) }, slots[0]!).id, first.id);
  const edited = definition('Europe/Berlin', '0 9 * * *');
  const editedSlot = preview(edited, '2026-06-01T00:00Z', '2026-06-02T00:00Z').occurrences[0]!;
  assert.notEqual(identifyCalendarOccurrence(edited, binding, editedSlot).id, first.id);
  assert.throws(() => identifyCalendarOccurrence(edited, binding, slots[0]!));
  const folds = preview(definition('America/New_York', '30 1 * * *', 'both'), '2026-11-01T00:00Z', '2026-11-02T00:00Z').occurrences;
  assert.notEqual(identifyCalendarOccurrence(definition('America/New_York', '30 1 * * *', 'both'), binding, folds[0]!).id,
    identifyCalendarOccurrence(definition('America/New_York', '30 1 * * *', 'both'), binding, folds[1]!).id);
});

test('calendar event identity deduplicates delivery retries and namespaces sources/schedules', () => {
  const input = { scheduleId: 'daily', source: 'verified-account-A', eventId: 'delivery-1' };
  assert.equal(calendarEventIdentity(input), calendarEventIdentity({ ...input }));
  assert.notEqual(calendarEventIdentity(input), calendarEventIdentity({ ...input, source: 'verified-account-B' }));
  assert.notEqual(calendarEventIdentity(input), calendarEventIdentity({ ...input, scheduleId: 'other' }));
  assert.notEqual(calendarEventIdentity({ scheduleId: 'a:b', source: 'c', eventId: 'd' }), calendarEventIdentity({ scheduleId: 'a', source: 'b:c', eventId: 'd' }));
});

test('calendar downtime coalesces newest due only, skip/grace and max lateness are inclusive', () => {
  assert.deepEqual(eligibility().decisions.map(d => d.reason), ['coalesced', 'coalesced', 'eligible']);
  assert.deepEqual(eligibility({ missed: 'skip' }).decisions.map(d => d.reason), ['missed', 'missed', 'eligible']);
  assert.equal(eligibility({ missed: 'skip', now: state.now + 1 }).eligible.length, 0);
  assert.equal(eligibility({ maxLatenessMs: 60_000 }).eligible.length, 1);
  assert.equal(eligibility({ maxLatenessMs: 60_000, now: state.now + 1 }).eligible.length, 0);
  assert.equal(eligibility({ now: ms('2026-06-03T08:00Z'), maxLatenessMs: 60_000 }).eligible.length, 0);
});

test('calendar duplicate receipts never resurrect coalesced work; conflicting duplicate IDs fail', () => {
  const latest = occurrences.at(-1)!;
  assert.equal(eligibility({}, [...occurrences, latest]).eligible.length, 1);
  assert.equal(eligibility({ consumedOccurrenceIds: [latest.id, latest.id] }).eligible.length, 0);
  assert.throws(() => eligibility({}, [...occurrences, { ...latest, snapshotDigest: 'b'.repeat(64) }]));
  assert.throws(() => eligibility({}, [{ ...latest, id: 'b'.repeat(64) }]));
});

test('calendar overlap, cancellation, pause, revocation, clock regression and incomplete scans fail closed', () => {
  assert.equal(eligibility({ activeRuns: 1 }).decisions.at(-1)?.reason, 'overlap');
  assert.equal(eligibility({ activeRuns: 1, overlap: 'allow' }).eligible.length, 1);
  for (const [changes, reason] of [
    [{ paused: true }, 'paused'], [{ revoked: true }, 'revoked'], [{ cancelled: true }, 'cancelled'],
    [{ previousObservedAt: state.now + 1 }, 'clock-regressed'], [{ completeWindow: false }, 'incomplete-window'],
  ] as const) { const result = eligibility(changes); assert.equal(result.hold, reason); assert.equal(result.eligible.length, 0); }
  assert.equal(eligibility({ previousObservedAt: state.now }).eligible.length, 1);
});

test('calendar revision windows are start-inclusive/end-exclusive and stale snapshots cannot run', () => {
  const latest = occurrences.at(-1)!;
  assert.equal(eligibility({ effectiveFrom: latest.scheduledAt }).eligible.length, 1);
  assert.equal(eligibility({ effectiveUntil: latest.scheduledAt }).decisions.at(-1)?.reason, 'outside-revision');
  assert.equal(eligibility({ binding: { ...binding, scheduleRevision: 2 } }).eligible.length, 0);
  assert.equal(eligibility({ binding: { ...binding, snapshotDigest: 'b'.repeat(64) } }).eligible.length, 0);
  assert.equal(calculateCalendarEligibility(definition('Europe/Berlin', '0 9 * * *'), state, occurrences).eligible.length, 0);
});

test('calendar skips a full missing civil day and handles a two-hour fold', () => {
  assert.deepEqual(times(preview(definition('Pacific/Apia', '0 12 * * *'), '2011-12-30T00:00Z', '2012-01-01T00:00Z')), [
    '2011-12-30T22:00:00.000Z', '2011-12-31T22:00:00.000Z',
  ]);
  assert.deepEqual(times(preview(definition('Antarctica/Troll', '30 1 * * *', 'both'), '2026-10-24T22:00Z', '2026-10-25T04:00Z')), [
    '2026-10-24T23:30:00.000Z', '2026-10-25T01:30:00.000Z',
  ]);
});

test('calendar cursor inside second fold retains only the permitted later occurrence', () => {
  for (const fold of ['earlier', 'later', 'both'] as const) {
    assert.deepEqual(times(preview(definition('America/New_York', '30 1 * * *', fold), '2026-11-01T06:15Z', '2026-11-01T07:00Z')),
      fold === 'earlier' ? [] : ['2026-11-01T06:30:00.000Z']);
  }
});

test('calendar forward clock jump respects lateness and duplicate receipt tombstones', () => {
  assert.equal(eligibility({ now: ms('2026-06-20T00:00Z') }).eligible.length, 0);
  assert.equal(eligibility({ consumedOccurrenceIds: occurrences.map(o => o.id) }).eligible.length, 0);
  const latest = occurrences.at(-1)!;
  // Property insertion order is not identity, including on JSON round trips.
  const { id, ...rest } = latest;
  assert.equal(eligibility({}, [...occurrences, { id, ...rest }]).eligible.length, 1);
});
