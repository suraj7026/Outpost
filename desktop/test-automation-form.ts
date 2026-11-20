import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationBlocker, buildSchedule, intervalLabel, legacyModelSelection, localDateInput, modelRefSelection, readSchedule, saveAutomation, scheduleDraft, scheduleTime, type AutomationClient, type AutomationSchedule } from './src/automation-form.ts';
import type { ServerRecord } from './src/types.ts';
import { readFileSync } from 'node:fs';
import { actionSummary, chatStatus, displayTimeZones, loadedMessageCount, relativeTime, saveServerNote, serverNotePayload } from './src/workspace-presentation.ts';

const start = Date.now() + 86400000;
const schedule: AutomationSchedule = { name: 'Dependency audit', timezone: 'Europe/London', nextAt: start, intervalMs: 86400000, missed: 'coalesce', paused: false,
  task: { goal: 'Review dependency updates', profile: 'code', mode: 'full_control' } };
const record = (value = schedule, revision = 3): ServerRecord => ({ kind: 'automation', id: 'fixture-schedule', revision, updatedAt: '2026-11-15T10:00:00.000Z', data: { ...value, task: { ...value.task } } });
function harness() {
  const calls: { kind: string; id: string; revision: number; payload: unknown }[] = [];
  const client: AutomationClient = { connected: true, retired: false, busy: false, info: { pending: false }, records: [record()],
    command: async (kind, id, revision, payload) => { calls.push({ kind, id, revision, payload }); return { ...record(), id, revision: revision + 1, data: payload }; } };
  return { client, calls };
}

test('schedule payload contains only fields supported by strict Schedule / NewTask', () => {
  const draft = scheduleDraft(); Object.assign(draft, { name: '  Audit  ', goal: '  Review packages  ', frequency: 'once', start: localDateInput(start) });
  const value = buildSchedule(draft);
  assert.deepEqual(Object.keys(value).sort(), ['intervalMs', 'missed', 'name', 'nextAt', 'paused', 'task', 'timezone'].sort());
  assert.deepEqual(value.task, { goal: 'Review packages', profile: 'code', mode: 'full_control' });
  assert.equal(draft.mode, 'full_control');
  assert.equal(value.intervalMs, null); assert.equal(value.name, 'Audit'); assert.equal(value.nextAt, new Date(draft.start).getTime());
  assert.equal(readSchedule(record(value))?.nextAt, value.nextAt);
});

test('saved schedule modes preserve Auto, map legacy Ask to Auto, and default missing to Full control', async () => {
  for (const mode of ['ask_permission', 'auto', 'full_control', undefined]) {
    const row = record();
    row.data.task = { ...schedule.task, ...(mode === undefined ? {} : { mode }) };
    if (mode === undefined) delete (row.data.task as Record<string, unknown>).mode;
    const migrated = readSchedule(row);
    assert.ok(migrated);
    const expected = mode === 'auto' || mode === 'ask_permission' ? 'auto' : 'full_control';
    assert.equal(migrated.task.mode, expected);
    assert.equal(scheduleDraft(migrated).mode, expected);
    assert.equal(buildSchedule(scheduleDraft(migrated), migrated).task.mode, expected);
    const { client, calls } = harness();
    client.runtime = { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 };
    await saveAutomation(client, row.id, row.revision, migrated, true, false);
    assert.deepEqual(calls[0].payload, migrated);
  }
  const invalid = record(); invalid.data.task = { ...schedule.task, mode: 'made-up' };
  assert.equal(readSchedule(invalid), null);
});

test('unsupported Auto saves and schedule toggles fail closed, including legacy saved Auto', async () => {
  const auto: AutomationSchedule = { ...schedule, task: { ...schedule.task, mode: 'auto' } };
  for (const runtime of [undefined, {}, { controlModes: ['full_control', 'auto'] }, { controlModes: ['full_control', 'auto'], autoPolicyVersion: 2 }]) {
    for (const paused of [true, false]) {
      const { client, calls } = harness(); client.runtime = runtime;
      await assert.rejects(saveAutomation(client, 'fixture-schedule', 3, { ...auto, paused }, true, false), /needs a compatible server update/);
      client.records = [];
      await assert.rejects(saveAutomation(client, 'new-auto', 0, auto, true, false), /needs a compatible server update/);
      assert.equal(calls.length, 0);
    }
  }
  const { client, calls } = harness(); client.runtime = { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 };
  client.records = [];
  await saveAutomation(client, 'new-auto', 0, auto, true, false);
  assert.deepEqual(calls[0].payload, auto);
});

test('untouched edits preserve exact nextAt, paused state and fixed interval', () => {
  const initial = { ...schedule, nextAt: 1700000000123, intervalMs: 60001, paused: true };
  const edited = buildSchedule({ ...scheduleDraft(initial), name: 'Changed' }, initial);
  assert.equal(edited.nextAt, initial.nextAt); assert.equal(edited.intervalMs, 60001); assert.equal(edited.paused, true);
  assert.equal(edited.name, 'Changed');
});

test('untouched fall-back DST edits preserve the later offset rather than silently moving an hour', () => {
  const initial = { ...schedule, nextAt: Date.parse('2026-11-01T01:30:42.123-05:00'), paused: true };
  assert.equal(buildSchedule(scheduleDraft(initial), initial).nextAt, initial.nextAt);
  if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/New_York') {
    assert.throws(() => buildSchedule({ ...scheduleDraft(initial), start: '2027-03-14T02:30' }, initial, 0), /valid start/);
  }
});

test('display time zone does not reinterpret the Mac-local input', () => {
  const draft = scheduleDraft(schedule);
  const london = buildSchedule(draft, schedule), tokyo = buildSchedule({ ...draft, timezone: 'Asia/Tokyo' }, schedule);
  assert.equal(london.nextAt, tokyo.nextAt);
  assert.notEqual(scheduleTime(london), scheduleTime(tokyo));
  assert.equal(intervalLabel(86400000), 'Every 24 hours'); assert.equal(intervalLabel(null), 'One time');
  assert.equal(intervalLabel(3600000), 'Every 1 hour');
});

test('validation rejects invalid dates, unsupported choices and unsafe intervals', () => {
  const draft = scheduleDraft(schedule);
  for (const changes of [{ name: ' ' }, { goal: ' ' }, { goal: 'x'.repeat(20001) }, { profile: 'made-up' },
    { timezone: 'not/a-zone' }, { start: '' }, { start: '2026-02-30T12:00' }, { start: localDateInput(1000) },
    { intervalMinutes: '0.99999999999' }, { intervalMinutes: '-1' }, { intervalMinutes: 'NaN' }, { intervalMinutes: 'Infinity' }, { intervalMinutes: '1e100' }, { missed: 'replay-all' }]) {
    assert.throws(() => buildSchedule({ ...draft, ...changes }, schedule), JSON.stringify(changes));
  }
});

test('models use either legacy model or provider-qualified modelRef, never both', () => {
  const draft = scheduleDraft(schedule), ref = { providerId: 'fixture-provider', modelId: 'fixture-model' };
  assert.deepEqual(buildSchedule({ ...draft, model: modelRefSelection(ref) }, schedule).task.modelRef, ref);
  assert.equal(buildSchedule({ ...draft, model: legacyModelSelection('legacy:cloud') }, schedule).task.model, 'legacy:cloud');
  const chosen = buildSchedule({ ...draft, model: modelRefSelection(ref) }, schedule).task;
  assert.equal('model' in chosen, false);
  for (const model of ['ref:{', 'ref:{"providerId":"__proto__","modelId":"x"}', 'ref:{"providerId":"ok","modelId":" x"}', 'model:', 'not-encoded']) assert.throws(() => buildSchedule({ ...draft, model }, schedule));
});

test('unsupported records remain read-only rather than silently dropping unknown fields', () => {
  for (const changes of [{ cron: '0 9 * * *' }, { intervalMs: 59999 }, { timezone: 'invalid' }, { nextAt: 'tomorrow' }, { task: { ...schedule.task, model: 'a', modelRef: { providerId: 'b', modelId: 'c' } } }, { task: { ...schedule.task, extra: true } }]) {
    const row = record(); Object.assign(row.data, changes); assert.equal(readSchedule(row), null);
  }
  assert.ok(readSchedule(record()));
});

test('save, edit, pause and resume use automation.save on the owning client with expected revisions', async () => {
  const { client, calls } = harness();
  await saveAutomation(client, 'fixture-schedule', 3, { ...schedule, paused: true }, true, false);
  assert.deepEqual(calls[0], { kind: 'automation.save', id: 'fixture-schedule', revision: 3, payload: { ...schedule, paused: true } });
  client.records = [];
  await saveAutomation(client, 'new-schedule', 0, schedule, true, false);
  assert.equal(calls[1].revision, 0); assert.equal(calls[1].id, 'new-schedule');
});

test('all mutation blockers are checked before commands, including pendingError and absent info', async () => {
  for (const change of [{ connected: false }, { retired: true }, { busy: true }, { info: null }, { info: { pending: true } }, { info: { pending: false, pendingError: 'unknown' } }]) {
    const { client, calls } = harness(); Object.assign(client, change);
    assert.ok(automationBlocker(client, true, false));
    await assert.rejects(saveAutomation(client, 'fixture-schedule', 3, schedule, true, false)); assert.equal(calls.length, 0);
  }
  for (const [native, preview] of [[false, false], [true, true]]) {
    const { client, calls } = harness(); await assert.rejects(saveAutomation(client, 'fixture-schedule', 3, schedule, native, preview)); assert.equal(calls.length, 0);
  }
  assert.ok(automationBlocker(undefined, true, false));
});

test('stale, missing and duplicate create records cannot be overwritten', async () => {
  const { client, calls } = harness();
  await assert.rejects(saveAutomation(client, 'fixture-schedule', 2, schedule, true, false), /changed/);
  await assert.rejects(saveAutomation(client, 'fixture-schedule', 0, schedule, true, false), /changed/);
  await assert.rejects(saveAutomation(client, 'missing', 3, schedule, true, false), /changed/);
  assert.equal(calls.length, 0);
});

test('server notes match the verified memory.save strict owner contract, not memory.shared', async () => {
  const coordinator = readFileSync(new URL('../server/gateway/coordinator.ts', import.meta.url), 'utf8');
  const contract = coordinator.match(/case 'memory\.save':([\s\S]*?)(?=\n\s*case |\n\s*default:)/)?.[1];
  assert.ok(contract, 'Coordinator exposes the memory.save case');
  assert.ok(contract.includes("z.strictObject({ text: z.string(),project: z.string(),identityId: z.string(),source: z.string(),provenance: z.literal('owner') }).parse(payload)"));
  const memory = readFileSync(new URL('../server/memory/memory.ts', import.meta.url), 'utf8');
  assert.match(memory, /input.text.length > 0 && input.text.length <= 20000 && input.source.length > 0/);
  assert.match(memory, /confirmed: input.provenance === 'owner',forgotten: false/);
  assert.match(memory, /'memory',id\(\),0/);
  const payload = serverNotePayload('  local note  ', ' release-project ');
  assert.deepEqual(payload, { text: 'local note', project: 'release-project', identityId: 'owner', source: 'Outpost desktop · server note', provenance: 'owner' });
  const { client, calls } = harness();
  client.command = async (kind, id, revision, data) => {
    calls.push({ kind, id, revision, payload: data });
    return { kind: 'memory', id: 'server-generated-id', revision: 1, updatedAt: new Date().toISOString(), data: { ...data, confirmed: true, forgotten: false } };
  };
  const result = await saveServerNote(client, 'command-aggregate', 'local note', 'release-project', true, false);
  assert.equal(result.id, 'server-generated-id');
  assert.deepEqual(calls, [{ kind: 'memory.save', id: 'command-aggregate', revision: 0, payload }]);
  for (const [text, project] of [['', 'project'], ['x'.repeat(20001), 'project'], ['text', ' ']]) assert.throws(() => serverNotePayload(text, project));
});

test('server-note guards prevent every unsafe mutation and unconfirmed responses never report success', async () => {
  for (const change of [{ connected: false }, { retired: true }, { busy: true }, { info: null }, { info: { pending: true } }, { info: { pending: false, pendingError: 'uncertain' } }]) {
    const { client, calls } = harness(); Object.assign(client, change);
    await assert.rejects(saveServerNote(client, 'id', 'note', 'project', true, false)); assert.equal(calls.length, 0);
  }
  for (const [native, preview] of [[false, false], [true, true]]) {
    const { client, calls } = harness(); await assert.rejects(saveServerNote(client, 'id', 'note', 'project', native, preview)); assert.equal(calls.length, 0);
  }
  await assert.rejects(saveServerNote(undefined, 'id', 'note', 'project', true, false));
  const good = { kind: 'memory', id: 'server-id', revision: 1, updatedAt: '', data: { ...serverNotePayload('note', 'project'), confirmed: true, forgotten: false } };
  for (const result of [undefined, { ...good, kind: 'task' }, { ...good, revision: 0 }, { ...good, data: { ...good.data, shared: true } }, { ...good, data: { ...good.data, project: 'other' } }, { ...good, data: { ...good.data, confirmed: false } }, { ...good, data: { ...good.data, forgotten: true } }]) {
    const { client } = harness(); client.command = async () => result;
    await assert.rejects(saveServerNote(client, 'id', 'note', 'project', true, false), /Couldn’t confirm/);
  }
});

test('workspace presentation never invents counts, success, effects or time zones', () => {
  const message: ServerRecord = { kind: 'message', id: 'message-1', revision: 1, updatedAt: '', data: { taskId: 'task-1' } };
  assert.equal(loadedMessageCount(undefined, 'task-1'), undefined);
  assert.equal(loadedMessageCount([message, message, { ...message, id: 'other', data: { taskId: 'task-2' } }, { ...message, kind: 'action', id: 'action' }], 'task-1'), 1);
  assert.equal(loadedMessageCount([], 'task-1'), 0);
  assert.deepEqual(chatStatus('completed'), { label: 'Finished', tone: 'success' });
  assert.equal(chatStatus('verifying').label, 'Ready for your review');
  assert.equal(chatStatus('unknown_future_state').tone, 'neutral');
  assert.equal(actionSummary({ ...message, kind: 'action', data: { tool: 'command.run' } }), 'Run a command in the task’s workspace');
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(relativeTime('bad', now), 'Time unavailable');
  assert.match(relativeTime('2026-11-16T10:00:00Z', now), /2 hours ago/);
  assert.match(relativeTime('2026-11-16T14:00:00Z', now), /in 2 hours/);
  const zones = displayTimeZones('Asia/Tokyo');
  assert.ok(zones.includes('UTC')); assert.ok(zones.includes('Asia/Tokyo')); assert.ok(zones.includes('Europe/London'));
  assert.ok(!displayTimeZones('fake/zone').includes('fake/zone'));
});

test('unconfirmed saves never report success', async () => {
  for (const value of [undefined, { ...record(), id: 'other' }, { ...record(), kind: 'task' }, record(schedule, 3)]) {
    const { client } = harness(); client.command = async () => value;
    await assert.rejects(saveAutomation(client, 'fixture-schedule', 3, schedule, true, false), /Couldn’t confirm/);
  }
});
