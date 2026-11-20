import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
import { Gate } from '../policy/trust.js';
import { registerBuiltin } from '../policy/auto-policy.js';
import { CalendarScheduleDefinition, Schedule, Scheduler, prepareSchedule } from './scheduler.js';

const AutomationId = z.string().trim().min(1).max(200).describe('Stable automation ID. Reuse the ID from automation.list for existing schedules; choose a unique descriptive ID for a new schedule and keep it when reconciling an uncertain save.');
const ListInput = z.strictObject({
  automationId: AutomationId.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});
const SaveInput = z.strictObject({
  automationId: AutomationId,
  expectedRevision: z.number().int().nonnegative().describe('0 to create a new schedule; otherwise the latest revision returned by automation.list. Never overwrite a stale revision.'),
  schedule: Schedule.extend({
    timezone: z.string().describe('Valid named IANA timezone, such as UTC or America/New_York. For calendar schedules, must match calendar.timezone and controls when runs fire across DST. For one-time and fixed-interval schedules, display-only and does not make fixed intervals calendar-aware.'),
    nextAt: z.number().int().nonnegative().describe('First/next due time as Unix epoch milliseconds (for calendar schedules, the requested start instant; the server places nextAt on the next matching slot strictly after it). Use serverTime from automation.list as a clock reference.'),
    intervalMs: z.number().int().min(60000).nullable().describe('null for one-time or calendar schedules; otherwise elapsed milliseconds between runs, at least 60000. Every 86400000 ms is elapsed time and is not calendar-daily scheduling across DST.'),
    calendar: CalendarScheduleDefinition.optional().describe('Optional wall-clock calendar recurrence using a standard five-field cron expression in a named IANA timezone so runs stay on local time across DST (gap is "skip", fold defaults to "earlier"). Mutually exclusive with non-null intervalMs.'),
    missed: z.enum(['skip', 'coalesce']).describe('For missed runs: skip drops overdue occurrences; coalesce starts one catch-up task rather than replaying every missed interval or slot.'),
    task: Schedule.shape.task.describe('Self-contained instructions for a NEW agent task, not a shell command or a continuation of this chat. Uses its saved mode (default full_control). Auto requires exact review of schedule writes, including Full Control children. modelRef requires a configured Pi worker.'),
  }),
});
const PauseInput = z.strictObject({
  automationId: AutomationId,
  expectedRevision: z.number().int().min(1).describe('Latest schedule revision from automation.list.'),
  paused: z.boolean().describe('true pauses future occurrences; false resumes using the existing nextAt and missed-interval policy. Does not cancel already-created tasks or delete the schedule.'),
});
const DeleteInput = z.strictObject({
  automationId: AutomationId,
  expectedRevision: z.number().int().min(1).describe('Latest schedule revision from automation.list.'),
});


export function registerAutomationTools(gate: Gate, scheduler: Scheduler, options: {
  workerAvailable: boolean;
  assertWritable: () => void;
}) {
  const current = (automationId: string, expectedRevision: number) => {
    const record = gate.db.get<Schedule>('automation', automationId);
    requireThat((record?.revision ?? 0) === expectedRevision, 'stale_revision');
    return record;
  };
  const validateTask = (schedule: Schedule) => {

    requireThat(!schedule.task.modelRef || options.workerAvailable, 'pi_worker_required');
  };
  const assertWritable = () => {
    options.assertWritable();
    // Older coordinators allow malformed recovery records; automation writes must fail closed there too.
    const recovery = gate.db.get('recovery', 'server');
    requireThat(!recovery || recovery.data.dispatchEnabled === true, 'recovery_dispatch_disabled');
  };
  const validateSave = (input: unknown) => {
    const args = SaveInput.parse(input);
    assertWritable();
    const record = current(args.automationId, args.expectedRevision);
    prepareSchedule(args.schedule, record ? Schedule.parse(record.data) : undefined);
    validateTask(args.schedule);
    return args;
  };
  const validatePause = (input: unknown) => {
    const args = PauseInput.parse(input);
    assertWritable();
    const record = current(args.automationId, args.expectedRevision);
    requireThat(record, 'not_found');
    if (!args.paused) validateTask(Schedule.parse(record.data));
    return args;
  };
  const validateDelete = (input: unknown) => {
    const args = DeleteInput.parse(input);
    assertWritable();
    const record = current(args.automationId, args.expectedRevision);
    requireThat(record, 'not_found');
    return args;
  };

  registerBuiltin(gate, 'automation.list', {
    version: 1, effects: ['automation.read'], inputSchema: z.toJSONSchema(ListInput),
    description: 'List Outpost Automations on this server, or inspect one by automationId. Returns IDs, revisions, complete schedules and serverTime (Unix milliseconds). Use before creating to avoid duplicates, before editing/pausing/resuming/deleting for the current revision, and after uncertain results. Paginate with limit/offset. Does not inspect Linux crontab or /etc/cron.d.',
    parse: input => z.record(z.string(), z.json()).parse(ListInput.parse(input)),
    target: args => args.automationId ? `automation ${args.automationId}` : 'Outpost Automations on this server',
    execute: async input => {
      const args = ListInput.parse(input);
      const selected = args.automationId ? gate.db.get<Schedule>('automation', args.automationId) : undefined;
      const records = args.automationId ? selected ? [selected] : [] : gate.db.list<Schedule>('automation');
      return z.json().parse({ serverTime: Date.now(), automations: records.slice(args.offset, args.offset + args.limit), total: records.length, hasMore: args.offset + args.limit < records.length });
    },
  });
  gate.register('automation.save', {
    version: 1, effects: ['automation.write'], inputSchema: z.toJSONSchema(SaveInput),
    description: 'Create or replace a server-owned Outpost Automation visible in the Automations UI. Supply a stable automationId, expectedRevision (0 for new) and a complete schedule. Supports one-time schedules (intervalMs: null, no calendar), fixed elapsed-time intervals >=60000 ms (not calendar-daily across DST), or wall-clock calendar schedules (intervalMs: null with calendar: { kind: "cron", expression, timezone, gap: "skip", fold }) in a named IANA timezone so local times stay consistent across DST. Each occurrence queues a NEW task in the saved mode (default full_control); Auto requires exact approval of this schedule write; the server must be running. Saving is not proof that a scheduled task ran. Inspect before retrying uncertain/stale writes.',
    parse: input => z.record(z.string(), z.json()).parse(validateSave(input)),
    target: args => `automation ${args.automationId}: ${SaveInput.parse(args).schedule.name}`,
    execute: async input => gate.db.transaction(() => {
      const args = validateSave(input);
      return z.json().parse(scheduler.save(args.automationId, args.expectedRevision, args.schedule));
    }),
  });
  gate.register('automation.set_paused', {
    version: 1, effects: ['automation.write'], inputSchema: z.toJSONSchema(PauseInput),
    description: 'Pause or resume an existing Outpost Automation using its current revision from automation.list. Preserves the schedule and task settings. Pausing does not delete the schedule or cancel tasks already queued/running. Resuming retains nextAt and the missed-interval policy, so a past-due schedule may run immediately; use automation.save to change nextAt first if needed. Use automation.delete to delete a schedule; no OS-cron changes.',
    parse: validatePause,
    target: args => `${args.paused ? 'pause' : 'resume'} automation ${args.automationId}`,
    execute: async input => gate.db.transaction(() => {
      const args = validatePause(input);
      const record = gate.db.need<Schedule>('automation', args.automationId);
      return z.json().parse(scheduler.save(args.automationId, args.expectedRevision, { ...record.data, paused: args.paused }));
    }),
  });
  gate.register('automation.delete', {
    version: 1, effects: ['automation.write'], inputSchema: z.toJSONSchema(DeleteInput),
    description: 'Permanently delete an existing Outpost Automation using its current revision from automation.list. Prevents future scheduled runs from firing; does not cancel tasks already queued/running. Pausing still does not delete. Auto requires exact approval of this schedule write.',
    parse: validateDelete,
    target: args => `delete automation ${args.automationId}`,
    execute: async input => gate.db.transaction(() => {
      const args = validateDelete(input);
      return z.json().parse(scheduler.delete(args.automationId, args.expectedRevision));
    }),
  });
}
