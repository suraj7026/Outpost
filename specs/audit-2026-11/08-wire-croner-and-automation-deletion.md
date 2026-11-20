# Spec 08: Connect the Calendar Engine to Live Scheduling & Add `automation.delete`

- **Priority:** P1
- **Area:** Features / Scheduler & Automations UI
- **Affected Files:**
  - `server/scheduler/scheduler.ts`
  - `server/scheduler/calendar.ts`
  - `server/scheduler/calendar-eligibility.ts`
  - `server/scheduler/tools.ts`
  - `server/gateway/coordinator.ts`
  - `desktop/src/Automations.tsx`
  - `desktop/src/automation-form.ts`
  - `desktop/test-automation-form.ts`

## Exact Problem

`croner` 11.0.0 and `@js-temporal/polyfill` 0.5.1 are installed. The calendar engine already exists and is not connected to live scheduling.

1. **Calendar engine is implemented; `tick()` never calls it.**
   - `server/scheduler/calendar.ts` imports `Cron` from `croner` and implements calendar definitions (`kind: 'cron'`, a five-field expression, a named IANA timezone, `gap: 'skip'`, `fold`), IANA timezone validation, DST gap/fold handling, preview (`previewCalendar`), and occurrence identity (`identifyCalendarOccurrence`). `server/scheduler/calendar-eligibility.ts` sits on top of it (`calculateCalendarEligibility`). `server/scheduler/calendar.test.ts` already tests validation, preview, identity, eligibility, and DST gap/fold behavior. Croner is a parser/evaluator inside that module, not a live scheduler.
   - Those modules are imported only by each other and by `calendar.test.ts`. `scheduler.ts`, `tools.ts`, `coordinator.ts`, and the desktop UI do not import them.
   - `Schedule` is still `{ name, timezone, nextAt, intervalMs, missed, paused, task }`. `Scheduler.save()` validates `timezone` with `new Intl.DateTimeFormat('en', { timeZone }).format()` and stores the record. `tick()` then advances a due row with `nextAt + n * intervalMs` (and pauses a one-time row when `intervalMs` is null). `timezone` does not affect when a run fires. "Every 24 hours" (`intervalMs` 86,400,000) still drifts across DST. Users cannot schedule wall-clock jobs such as weekdays at 09:00 local time.
   - `tools.ts` documents the gap: `timezone` "Does not make fixed intervals calendar-aware," `intervalMs` "is not calendar-daily scheduling across DST," and `automation.save` supports "one-time or fixed intervals >=60000 ms, NOT cron expressions/calendar recurrence."
2. **No way to delete an automation.**
   - There is still no `automation.delete` on the scheduler, in `coordinator.ts` `command()` (only `automation.save`), in `tools.ts` (`automation.list`, `automation.save`, `automation.set_paused`), or in the Automations UI.
   - `desktop/src/Automations.tsx` still says "Deleting schedules and wall-clock recurrence are not supported by this server API." The form only offers "One time" and "Fixed interval." `automation-form.ts` `readSchedule` accepts only `name`, `timezone`, `nextAt`, `intervalMs`, `missed`, `paused`, and `task`. Old and one-time automations stay in the ledger, usually as `Paused`.

User-facing goals: wall-clock schedules that stay on local time across DST, and `automation.delete` with `expectedRevision`.

## Exact Solution

Wire the existing calendar module into `Schedule`, `save`, `tick`, tools, and the Automations UI. Do not add a second Cron parser, and do not start a Croner callback scheduler. Live admission stays inside `Scheduler.tick()`'s ledger transaction. Leave fixed-interval behavior as elapsed time.

1. **Store the existing calendar definition on `Schedule`.**
   - Add an optional calendar field with the existing definition shape from `calendar.ts`: `{ kind: 'cron', expression, timezone, gap: 'skip', fold: 'earlier' | 'later' | 'both' }`. Expressions stay five-field, which `validateCalendarDefinition` already enforces. A calendar definition and a non-null `intervalMs` are mutually exclusive. One-time schedules keep `intervalMs: null` and no calendar definition.
   - One IANA timezone controls a calendar schedule: the saved definition `timezone` is the zone `previewCalendar` uses. `gap` stays `'skip'` (a civil time that does not exist is not a run). Default `fold` to `'earlier'` unless the user chooses `later` or `both`.
2. **`Scheduler.save()` validates and places `nextAt` through `calendar.ts`.**
   - For a calendar schedule, call `validateCalendarDefinition`. An invalid cron expression or an invalid timezone (including offsets and non-IANA strings) throws and fails the save. Do not construct `new Cron(...)` in `scheduler.ts`.
   - Set `nextAt` from `previewCalendar`: the next slot strictly after the requested start, within the module's horizon. If the preview status is `search-limit` or there is no occurrence, fail the save.
   - Keep the `Intl.DateTimeFormat` check only for one-time and fixed-interval schedules. Their timezone remains a display zone and does not change the instant or the elapsed interval.
3. **`tick()` uses that definition for calendar rows.**
   - One-time and fixed-interval rows keep today's path: due when `nextAt <= time`, then advance by `intervalMs` only.
   - When a calendar row is due, ask `previewCalendar` for the due slot and the following slot, `identifyCalendarOccurrence` for the occurrence id (schedule id, revision, definition digest, `scheduledAt`), and `calculateCalendarEligibility` whether that slot may start a task. Pass the schedule's revision binding, `paused`, and `missed` (`skip` or `coalesce`). Eligibility is advice: recheck it inside the existing fenced transaction and persist the occurrence id so a retry does not start a second task. Then store the following slot's `scheduledAt` as `nextAt`.
   - A `0 9 * * 1-5` definition in `America/New_York` therefore stays at 09:00 local time across spring-forward and fall-back. Do not advance a calendar schedule by adding `intervalMs`.
4. **Add `automation.delete` and expose calendar saves on the tools and coordinator.**
   - `automation.save` accepts the calendar definition and uses the same `validateCalendarDefinition` / `previewCalendar` path. Describe calendar schedules as wall-clock recurrence in the selected IANA timezone. Keep the existing statement that a fixed `intervalMs` is elapsed time and is not calendar-daily across DST.
   - Add `Scheduler.delete(key, expectedRevision)`. Reject a revision mismatch. Remove the record, or tombstone it and emit `automation.deleted`, so SSE clients drop it. A deleted schedule must not fire on a later `tick()`.
   - Register `automation.delete` in `server/gateway/coordinator.ts` `command()` and in `server/scheduler/tools.ts`. Require `expectedRevision` from `automation.list`. Gate it as an automation write that requires approval in Auto mode, same as other schedule writes. Pausing still does not delete.
5. **Upgrade `desktop/src/Automations.tsx` and `automation-form.ts`.**
   - Add a third frequency, calendar schedule. Presets compile to five-field expressions `validateCalendarDefinition` already accepts: daily at HH:MM, weekdays at HH:MM, weekly on selected days, and a custom five-field expression. Show the next three runs in the selected IANA timezone from `previewCalendar` on the server, not from a client-side cron parser.
   - Extend `AutomationSchedule`, `buildSchedule`, and `readSchedule` so a calendar record round-trips. For calendar mode, the timezone picker sets the definition timezone and therefore when the run fires. For fixed intervals, keep today's copy: the zone is display-only, and daylight-saving can shift the local hour.
   - Add a **Delete** button with a confirmation dialog. On confirm, send `automation.delete` with that record's `expectedRevision`. Remove the sentence "Deleting schedules and wall-clock recurrence are not supported by this server API."

## Verification & Acceptance Criteria

- [ ] Unit tests in `server/scheduler/` verify:
  - `tick()` uses the existing calendar definition (`previewCalendar`, occurrence identity, and calendar eligibility), so a `0 9 * * 1-5` schedule in `America/New_York` stays at 09:00 local time across both spring-forward and fall-back DST boundaries. Fixed `intervalMs` schedules still advance by elapsed milliseconds only.
  - Invalid cron expressions or invalid IANA timezones still fail at `save()`, rejected by `validateCalendarDefinition`.
  - `automation.delete` enforces `expectedRevision` and prevents future `tick()` firings.
- [ ] `node --test desktop/test-automation-form.ts` and `npm run check` pass.
