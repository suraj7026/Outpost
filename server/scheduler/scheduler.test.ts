import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { digest } from '../core/contracts.js';
import { Tasks } from '../tasks/tasks.js';
import { identifyCalendarOccurrence, previewCalendar } from './calendar.js';
import { Scheduler, type Schedule } from './scheduler.js';

const nyCalendar = (expression = '0 9 * * 1-5', fold: 'earlier' | 'later' | 'both' = 'earlier') => ({
  kind: 'cron' as const,
  expression,
  timezone: 'America/New_York',
  gap: 'skip' as const,
  fold,
});

test('persisted schedules normalize legacy child modes when fired, without duplicate occurrences',() => {
  const db = new Ledger(), scheduler = new Scheduler(db,new Tasks(db));
  try {
    for (const mode of ['ask_permission','auto']) db.put('automation',mode,0,{ name: mode,timezone: 'UTC',nextAt: 1000,intervalMs: null,missed: 'coalesce',paused: false,task: { goal: 'Inspect',profile: 'operations',mode } });
    const started = scheduler.tick(1000);
    assert.equal(started.length,2);
    assert.deepEqual(scheduler.tick(1000),[]);
    for (const taskId of started) assert.equal(db.need('policy',taskId).data.mode,'auto');
    assert.ok(db.list<Schedule>('automation').every(record => record.data.task.mode === 'auto' && record.data.paused));
  } finally { db.close(); }
});

test('server scheduling coalesces missed runs without duplicate tasks and quiet monitors stay quiet',() => {
  const db = new Ledger(), scheduler = new Scheduler(db,new Tasks(db));
  scheduler.save('routine',0,{ name: 'Inspect',timezone: 'UTC',nextAt: 1000,intervalMs: 60000,missed: 'coalesce',task: { goal: 'Inspect service',profile: 'operations' } });
  assert.equal(scheduler.tick(181000).length,1); assert.equal(scheduler.tick(181000).length,0);
  assert.equal(db.list('task').length,1); assert.equal(db.list('policy')[0]?.data.mode,'full_control');
  assert.equal(scheduler.changed('site','one'),false); assert.equal(scheduler.changed('site','one'),false); assert.equal(scheduler.changed('site','two'),true); db.close();
});

test('calendar 0 9 * * 1-5 in America/New_York stays at 09:00 local time across spring-forward and fall-back DST', () => {
  const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
  try {
    // Spring-forward: 2026-03-08 02:00 EST -> 03:00 EDT.
    // Requested start: Friday 2026-03-06 07:00 EST (12:00Z).
    const saved = scheduler.save('ny-weekdays', 0, {
      name: 'Weekday standup',
      timezone: 'America/New_York',
      nextAt: Date.parse('2026-03-06T12:00:00Z'),
      intervalMs: null,
      missed: 'coalesce',
      calendar: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York', gap: 'skip' },
      task: { goal: 'Run morning standup', profile: 'operations' },
    });
    assert.equal(saved.data.calendar?.fold, 'earlier');
    assert.equal(saved.data.nextAt, Date.parse('2026-03-06T14:00:00Z')); // Fri 09:00 EST (-05:00)

    // Expected occurrence ID for Friday 09:00 EST via calendar.ts
    const fridaySlot = previewCalendar(saved.data.calendar, {
      afterAt: Date.parse('2026-03-06T13:59:59Z'),
      throughAt: Date.parse('2026-03-06T14:00:00Z'),
      limit: 1,
    }).occurrences[0]!;
    const expectedOcc = identifyCalendarOccurrence(saved.data.calendar, {
      scheduleId: saved.id,
      scheduleRevision: saved.revision,
      snapshotDigest: digest({ id: saved.id, revision: saved.revision, schedule: saved.data }),
    }, fridaySlot);

    assert.deepEqual(scheduler.tick(Date.parse('2026-03-06T13:59:59Z')), []);
    const friStarted = scheduler.tick(Date.parse('2026-03-06T14:00:00Z'));
    assert.equal(friStarted.length, 1);
    assert.ok(db.get('occurrence', expectedOcc.id), 'Occurrence receipt must be keyed by identifyCalendarOccurrence id');
    assert.deepEqual(scheduler.tick(Date.parse('2026-03-06T14:00:00Z')), []);

    // Next slot skips Sat/Sun and crosses spring-forward to Mon 2026-03-09 09:00 EDT (13:00Z, NOT 14:00Z).
    const afterFri = db.need<Schedule>('automation', 'ny-weekdays');
    assert.equal(afterFri.data.nextAt, Date.parse('2026-03-09T13:00:00Z'));
    assert.deepEqual(scheduler.tick(Date.parse('2026-03-09T12:59:59Z')), []);
    const monSpring = scheduler.tick(Date.parse('2026-03-09T13:00:00Z'));
    assert.equal(monSpring.length, 1);
    assert.equal(db.need<Schedule>('automation', 'ny-weekdays').data.nextAt, Date.parse('2026-03-10T13:00:00Z'));

    // Fall-back: 2026-11-01 02:00 EDT -> 01:00 EST.
    // Re-save starting Fri 2026-10-30 08:00 EDT (12:00Z).
    const current = db.need<Schedule>('automation', 'ny-weekdays');
    const fallSaved = scheduler.save('ny-weekdays', current.revision, {
      ...current.data,
      nextAt: Date.parse('2026-10-30T12:00:00Z'),
    });
    assert.equal(fallSaved.data.nextAt, Date.parse('2026-10-30T13:00:00Z')); // Fri 09:00 EDT (-04:00)
    assert.equal(scheduler.tick(Date.parse('2026-10-30T13:00:00Z')).length, 1);

    // Next slot crosses fall-back to Mon 2026-11-02 09:00 EST (14:00Z, NOT 13:00Z).
    const afterFallFri = db.need<Schedule>('automation', 'ny-weekdays');
    assert.equal(afterFallFri.data.nextAt, Date.parse('2026-11-02T14:00:00Z'));
    assert.deepEqual(scheduler.tick(Date.parse('2026-11-02T13:00:00Z')), []);
    assert.equal(scheduler.tick(Date.parse('2026-11-02T14:00:00Z')).length, 1);
    assert.equal(db.need<Schedule>('automation', 'ny-weekdays').data.nextAt, Date.parse('2026-11-03T14:00:00Z'));
  } finally { db.close(); }
});

test('fixed intervalMs schedules still advance by elapsed milliseconds across DST', () => {
  const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
  try {
    const start = Date.parse('2026-03-06T14:00:00Z'); // Fri 09:00 EST
    scheduler.save('fixed-daily', 0, {
      name: 'Elapsed 24h',
      timezone: 'America/New_York',
      nextAt: start,
      intervalMs: 86_400_000,
      missed: 'coalesce',
      task: { goal: 'Check metrics', profile: 'operations' },
    });
    // Jump 3 elapsed days to Mon 2026-03-09 14:00Z (10:00 EDT — shifted local hour).
    assert.deepEqual(scheduler.tick(Date.parse('2026-03-09T13:00:00Z')).length, 1); // catches up Fri/Sat/Sun (Sun 14:00Z <= Mon 13:00Z)
    assert.equal(db.need<Schedule>('automation', 'fixed-daily').data.nextAt, Date.parse('2026-03-09T14:00:00Z'));
  } finally { db.close(); }
});

test('calendar skips spring-forward gaps and honors fold policies (earlier, later, both)', () => {
  // Spring gap: 2026-03-08 02:30 does not exist in America/New_York.
  {
    const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
    try {
      const gap = scheduler.save('spring-gap', 0, {
        name: 'Gap skip',
        timezone: 'America/New_York',
        nextAt: Date.parse('2026-03-07T07:30:00Z'), // exactly Sat 02:30 EST -> next strictly after skips Sun Mar 8 -> Mon Mar 9 02:30 EDT
        intervalMs: null,
        missed: 'coalesce',
        calendar: nyCalendar('30 2 * * *'),
        task: { goal: 'Run nightly', profile: 'operations' },
      });
      assert.equal(gap.data.nextAt, Date.parse('2026-03-09T06:30:00Z'));
    } finally { db.close(); }
  }

  // Fall-back fold: 2026-11-01 01:30 occurs at 05:30Z (EDT) and 06:30Z (EST).
  for (const [fold, expected] of [
    ['earlier', [Date.parse('2026-11-01T05:30:00Z')]],
    ['later', [Date.parse('2026-11-01T06:30:00Z')]],
    ['both', [Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z')]],
  ] as const) {
    const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
    try {
      const key = `fold-${fold}`;
      const saved = scheduler.save(key, 0, {
        name: key,
        timezone: 'America/New_York',
        nextAt: Date.parse('2026-11-01T04:00:00Z'),
        intervalMs: null,
        missed: 'coalesce',
        calendar: nyCalendar('30 1 * * *', fold),
        task: { goal: `Fold ${fold}`, profile: 'operations' },
      });
      assert.equal(saved.data.nextAt, expected[0]);
      assert.equal(scheduler.tick(expected[0]).length, 1);
      const afterFirst = db.need<Schedule>('automation', key);
      if (expected.length === 2) {
        assert.equal(afterFirst.data.nextAt, expected[1]);
        assert.equal(scheduler.tick(expected[1]!).length, 1);
        assert.equal(db.need<Schedule>('automation', key).data.nextAt, Date.parse('2026-11-02T06:30:00Z'));
      } else {
        assert.equal(afterFirst.data.nextAt, Date.parse('2026-11-02T06:30:00Z'));
      }
    } finally { db.close(); }
  }
});

test('calendar missed policies coalesce across downtime (including >100 slots), skip late runs, and hold on clock regression', () => {
  // Coalesce across 3 hours of per-minute schedule (180 due slots > previewSize 100).
  {
    const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
    try {
      scheduler.save('dense-coalesce', 0, {
        name: 'Every minute coalesce',
        timezone: 'UTC',
        nextAt: Date.parse('2026-06-01T00:00:00Z'),
        intervalMs: null,
        missed: 'coalesce',
        calendar: { kind: 'cron', expression: '* * * * *', timezone: 'UTC', gap: 'skip', fold: 'earlier' },
        task: { goal: 'Check queue', profile: 'operations' },
      });
      const coalesceStarted = scheduler.tick(Date.parse('2026-06-01T03:00:00Z'));
      assert.equal(coalesceStarted.length, 1);
      assert.equal(db.need<Schedule>('automation', 'dense-coalesce').data.nextAt, Date.parse('2026-06-01T03:01:00Z'));
    } finally { db.close(); }
  }

  // Genuine clock-regression hold: nextAt <= now < previousObservedAt holds without firing or advancing.
  {
    const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
    try {
      const saved = scheduler.save('clock-hold', 0, {
        name: 'Clock hold',
        timezone: 'UTC',
        nextAt: Date.parse('2026-06-01T08:00:00Z'),
        intervalMs: null,
        missed: 'coalesce',
        paused: true,
        calendar: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', gap: 'skip', fold: 'earlier' },
        task: { goal: 'Run on monotonic clock', profile: 'operations' },
      });
      assert.equal(saved.data.nextAt, Date.parse('2026-06-01T09:00:00Z'));
      // Observe 09:10 while paused, then unpause preserving nextAt = 09:00.
      assert.deepEqual(scheduler.tick(Date.parse('2026-06-01T09:10:00Z')), []);
      scheduler.save('clock-hold', saved.revision, { ...saved.data, paused: false });
      // Clock steps backward to 09:05 (due, but < previousObservedAt 09:10) -> held!
      assert.deepEqual(scheduler.tick(Date.parse('2026-06-01T09:05:00Z')), []);
      assert.equal(db.need<Schedule>('automation', 'clock-hold').data.nextAt, Date.parse('2026-06-01T09:00:00Z'));
      // Once clock recovers to 09:10 -> fires and advances!
      assert.equal(scheduler.tick(Date.parse('2026-06-01T09:10:00Z')).length, 1);
      assert.equal(db.need<Schedule>('automation', 'clock-hold').data.nextAt, Date.parse('2026-06-02T09:00:00Z'));
    } finally { db.close(); }
  }

  // Skip policy drops slots overdue beyond on-time grace (60s), advances cursor, and fires on-time slots.
  {
    const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
    try {
      scheduler.save('daily-skip', 0, {
        name: 'Daily skip',
        timezone: 'UTC',
        nextAt: Date.parse('2026-06-01T08:00:00Z'),
        intervalMs: null,
        missed: 'skip',
        calendar: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', gap: 'skip', fold: 'earlier' },
        task: { goal: 'Morning report', profile: 'operations' },
      });
      assert.deepEqual(scheduler.tick(Date.parse('2026-06-01T09:05:00Z')), []); // 5 min late -> skipped
      assert.equal(db.need<Schedule>('automation', 'daily-skip').data.nextAt, Date.parse('2026-06-02T09:00:00Z'));
      assert.equal(scheduler.tick(Date.parse('2026-06-02T09:00:30Z')).length, 1); // 30s late -> within grace, fires!
      assert.equal(db.need<Schedule>('automation', 'daily-skip').data.nextAt, Date.parse('2026-06-03T09:00:00Z'));
    } finally { db.close(); }
  }
});

test('calendar save rejects invalid cron expressions, invalid or offset timezones, intervalMs conflicts, and impossible dates', () => {
  const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
  const base = {
    name: 'Invalid',
    timezone: 'America/New_York',
    nextAt: Date.parse('2026-03-06T12:00:00Z'),
    intervalMs: null,
    missed: 'coalesce' as const,
    task: { goal: 'Check', profile: 'operations' as const },
  };
  try {
    for (const expression of ['@daily', '* * * * * *', '0 25 * * *', '0 9 L * *', '0 9 ? * *', '0 0 31 2 *']) {
      assert.throws(() => scheduler.save('bad-expr', 0, { ...base, calendar: nyCalendar(expression) }), `should reject ${expression}`);
    }
    for (const timezone of ['Invalid/Zone', '+05:30', '-04:00', '2026-01-01T00:00Z', '']) {
      assert.throws(() => scheduler.save('bad-tz', 0, {
        ...base, timezone, calendar: { kind: 'cron', expression: '0 9 * * *', timezone, gap: 'skip', fold: 'earlier' },
      }), `should reject tz ${timezone}`);
    }
    // Mutually exclusive with non-null intervalMs
    assert.throws(() => scheduler.save('conflict-interval', 0, { ...base, intervalMs: 60000, calendar: nyCalendar() }));
    // Mismatched top-level timezone vs calendar timezone
    assert.throws(() => scheduler.save('mismatch-tz', 0, { ...base, timezone: 'UTC', calendar: nyCalendar() }));
    // Unsupported gap policy
    assert.throws(() => scheduler.save('bad-gap', 0, { ...base, calendar: { ...nyCalendar(), gap: 'shift' } }));
    assert.equal(db.list('automation').length, 0);

    // nextAt: 0 is anchored from server now cleanly.
    const before = Date.now();
    const fromNow = scheduler.save('from-now', 0, { ...base, nextAt: 0, calendar: nyCalendar() });
    assert.ok(fromNow.data.nextAt > before);
  } finally { db.close(); }
});

test('pausing and resuming a calendar schedule preserves its nextAt slot instead of skipping it', () => {
  const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
  try {
    const created = scheduler.save('preserve-slot', 0, {
      name: 'Weekday report',
      timezone: 'America/New_York',
      nextAt: Date.parse('2026-03-06T12:00:00Z'),
      intervalMs: null,
      missed: 'coalesce',
      calendar: nyCalendar(),
      task: { goal: 'Report', profile: 'operations' },
    });
    const slot = Date.parse('2026-03-06T14:00:00Z');
    assert.equal(created.data.nextAt, slot);
    const paused = scheduler.save('preserve-slot', created.revision, { ...created.data, paused: true });
    assert.equal(paused.data.nextAt, slot);
    assert.deepEqual(scheduler.tick(slot), []);
    const resumed = scheduler.save('preserve-slot', paused.revision, { ...paused.data, paused: false });
    assert.equal(resumed.data.nextAt, slot);
    assert.equal(scheduler.tick(slot).length, 1);
  } finally { db.close(); }
});

test('Scheduler.delete enforces expectedRevision, emits automation.deleted, and prevents future tick firings', () => {
  const db = new Ledger(), scheduler = new Scheduler(db, new Tasks(db));
  try {
    const saved = scheduler.save('to-delete', 0, {
      name: 'Removable',
      timezone: 'America/New_York',
      nextAt: Date.parse('2026-03-06T12:00:00Z'),
      intervalMs: null,
      missed: 'coalesce',
      calendar: nyCalendar(),
      task: { goal: 'Should never run', profile: 'operations' },
    });
    assert.throws(() => scheduler.delete('missing', 1), { code: 'not_found' });
    assert.throws(() => scheduler.delete('to-delete', 0), { code: 'stale_revision' });
    assert.throws(() => scheduler.delete('to-delete', 2), { code: 'stale_revision' });
    assert.ok(db.get('automation', 'to-delete'));

    const deleted = scheduler.delete('to-delete', saved.revision);
    assert.equal(deleted.kind, 'automation');
    assert.equal(deleted.id, 'to-delete');
    assert.equal(deleted.revision, saved.revision + 1);
    assert.equal(deleted.deleted, true);
    assert.equal(db.get('automation', 'to-delete'), undefined);
    assert.equal(db.list('automation').length, 0);

    const lastEvent = db.events().at(-1);
    assert.equal(lastEvent?.type, 'automation.deleted');
    assert.equal(lastEvent?.aggregateId, 'to-delete');
    assert.equal(lastEvent?.aggregateRevision, saved.revision + 1);

    // Deleted schedule must never fire on later ticks or delete a second time.
    assert.deepEqual(scheduler.tick(Date.parse('2026-03-06T14:00:00Z')), []);
    assert.equal(db.list('task').length, 0);
    assert.throws(() => scheduler.delete('to-delete', deleted.revision), { code: 'not_found' });
  } finally { db.close(); }
});
