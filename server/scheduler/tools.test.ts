import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from '../gateway/coordinator.js';
import type { Action } from '../policy/trust.js';
import type { RecordValue } from '../core/contracts.js';
import { WorkerClient } from '../pi-worker/client.js';
import { outpostSystemPrompt } from '../pi-adapter/system-prompt.js';
import { Schedule } from './scheduler.js';

const names = ['automation.list', 'automation.save', 'automation.set_paused', 'automation.delete'] as const;
const AutomationRecord = z.strictObject({ kind: z.literal('automation'), id: z.string(), revision: z.number().int().positive(), data: Schedule, updatedAt: z.string() });
const DeletedAutomationRecord = z.strictObject({ kind: z.literal('automation'), id: z.string(), revision: z.number().int().positive(), data: z.strictObject({ deleted: z.literal(true) }), updatedAt: z.string(), deleted: z.literal(true) });
const AutomationPage = z.strictObject({ serverTime: z.number(), automations: z.array(AutomationRecord), total: z.number().int().nonnegative(), hasMore: z.boolean() });
const schedule = (overrides: Partial<z.input<typeof Schedule>> = {}) => ({
  name: 'Inspect service', timezone: 'UTC', nextAt: 1000, intervalMs: 60000, missed: 'coalesce' as const,
  task: { goal: 'Inspect service health', profile: 'operations' as const }, ...overrides,
});

function fixture(mode: 'full_control' | 'auto' | 'ask_permission' = 'full_control', options: ConstructorParameters<typeof Coordinator>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-automation-tools-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  const coordinator = new Coordinator(db, root, options);
  const task = coordinator.tasks.create(randomUUID(), { goal: 'Manage service automations', profile: 'operations', mode });
  const gate = coordinator.gate(task.id);
  db.put('device', 'reviewer', 0, { revoked: false });
  const approve = (action: RecordValue<Action>) => gate.decide(action.id, action.revision, 'reviewer', { nonce: action.data.nonce, actionDigest: action.data.actionDigest, decision: 'approve' });
  return {
    approve,
    db, coordinator, task, gate,
    propose: (name: string, input: unknown) => gate.propose(task.id, name, input),
    async run(name: string, input: unknown) {
      const action = await gate.propose(task.id, name, input);
      if (action.data.state === 'pending') approve(action);
      const observed = await gate.dispatch(action.id);
      assert.equal(observed.data.state, 'succeeded', JSON.stringify(observed.data.result));
      return observed.data.result;
    },
    async rejects(name: string, input: unknown) {
      assert.ok(gate.catalogue().some(tool => tool.name === name), `${name} must be registered before testing validation`);
      const cursor = db.cursor();
      await assert.rejects(gate.propose(task.id, name, input));
      assert.equal(db.cursor(), cursor, 'Rejected input must not create an action or mutate records');
    },
    close() { coordinator.live.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('automation tools expose descriptions, effects and authoritative JSON input schemas through Coordinator', () => {
  const f = fixture();
  try {
    const catalogue = f.gate.catalogue();
    assert.deepEqual(f.coordinator.query('tools', { taskId: f.task.id }), catalogue);
    assert.doesNotMatch(JSON.stringify(catalogue), /ask_permission/);
        assert.match(JSON.stringify(catalogue), /\"auto\"/);
    for (const name of names) {
      const tool = catalogue.find(item => item.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.ok(tool.description?.trim(), `${name} needs a description`);
      assert.deepEqual(tool.effects, [name === 'automation.list' ? 'automation.read' : 'automation.write']);
      assert.ok(tool.inputSchema);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      const properties = z.record(z.string(), z.unknown()).parse(tool.inputSchema.properties);
      const property = (key: string) => z.record(z.string(), z.unknown()).parse(properties[key]);
      if (name === 'automation.list') {
        assert.deepEqual(Object.keys(properties).sort(), ['automationId', 'limit', 'offset']);
        assert.equal(property('automationId').type, 'string');
        assert.equal(property('limit').type, 'integer');
        assert.equal(property('limit').minimum, 1); assert.equal(property('limit').maximum, 100); assert.equal(property('limit').default, 50);
        assert.equal(property('offset').type, 'integer'); assert.equal(property('offset').minimum, 0); assert.equal(property('offset').default, 0);
      } else {
        const required = z.array(z.string()).parse(tool.inputSchema.required);
        const expectedRequired = name === 'automation.save' ? ['automationId', 'expectedRevision', 'schedule']
          : name === 'automation.set_paused' ? ['automationId', 'expectedRevision', 'paused']
            : ['automationId', 'expectedRevision'];
        assert.deepEqual(required.sort(), expectedRequired.sort());
        assert.equal(property('automationId').type, 'string');
        assert.equal(property('expectedRevision').type, 'integer');
        assert.equal(property('expectedRevision').minimum, name === 'automation.save' ? 0 : 1);
        if (name === 'automation.save') {
          assert.equal(property('automationId').minLength, 1); assert.equal(property('automationId').maxLength, 200);
          assert.equal(property('schedule').type, 'object');
        } else if (name === 'automation.set_paused') {
          assert.equal(property('paused').type, 'boolean');
        } else {
          assert.deepEqual(Object.keys(properties).sort(), ['automationId', 'expectedRevision']);
        }
      }
    }
  } finally { f.close(); }
});

test('system prompt explicitly teaches automation tools, calendar schedules, fixed intervals, deletion, and no implicit OS cron', () => {
  const prompt = outpostSystemPrompt([]);
  for (const name of names) assert.ok(prompt.includes(name), `${name} must be explained, not merely serialized in the catalogue`);
  assert.match(prompt, /fixed[- ]interval/i);
  assert.match(prompt, /calendar/i);
  assert.match(prompt, /cron/i);
  assert.match(prompt, /IANA/);
  assert.match(prompt, /(?:OS|operating.system|system)[^\n]*cron|crontab/i);
  assert.match(prompt, /explicit/i);
  assert.match(prompt, /full_control without per-action approval/);
  assert.doesNotMatch(prompt, /ask_permission|Request permission|Stop and explain pending approvals|normal permission and evidence gates/);
});

test('save, list, update, pause, resume and delete reuse the UI automation records and preserve a non-UUID id', async () => {
  const f = fixture();
  try {
    const automationId = 'service-health/every-minute';
    const saved = AutomationRecord.parse(await f.run('automation.save', { automationId, expectedRevision: 0, schedule: schedule() }));
    assert.equal(saved.id, automationId); assert.equal(saved.revision, 1);
    assert.equal(saved.data.task.mode, 'full_control'); assert.equal(saved.data.paused, false);
    assert.deepEqual(saved, f.db.need('automation', automationId));
    const snapshot = z.object({ records: z.array(z.object({ kind: z.string() }).passthrough()) }).parse(f.coordinator.query('snapshot', {}));
    assert.deepEqual(snapshot.records.filter(record => record.kind === 'automation'), [saved]);
    const before = Date.now();
    const page = AutomationPage.parse(await f.run('automation.list', { automationId }));
    assert.ok(page.serverTime >= before && page.serverTime <= Date.now());
    assert.deepEqual(page.automations, [saved]); assert.equal(page.total, 1); assert.equal(page.hasMore, false);
    const updated = AutomationRecord.parse(await f.run('automation.save', { automationId, expectedRevision: 1, schedule: { ...saved.data, name: 'Updated health check', intervalMs: 120000 } }));
    assert.equal(updated.id, automationId); assert.equal(updated.revision, 2); assert.equal(updated.data.name, 'Updated health check');
    assert.equal(updated.data.intervalMs, 120000); assert.equal(f.db.list('automation').length, 1);
    const paused = AutomationRecord.parse(await f.run('automation.set_paused', { automationId, expectedRevision: 2, paused: true }));
    assert.equal(paused.revision, 3); assert.deepEqual(paused.data, { ...updated.data, paused: true });
    const resumed = AutomationRecord.parse(await f.run('automation.set_paused', { automationId, expectedRevision: 3, paused: false }));
    assert.equal(resumed.revision, 4); assert.deepEqual(resumed.data, updated.data);
    assert.deepEqual(resumed, f.db.need('automation', automationId));
    const deleted = DeletedAutomationRecord.parse(await f.run('automation.delete', { automationId, expectedRevision: 4 }));
    assert.equal(deleted.id, automationId); assert.equal(deleted.revision, 5);
    assert.equal(f.db.get('automation', automationId), undefined);
    const afterDelete = AutomationPage.parse(await f.run('automation.list', { automationId }));
    assert.deepEqual(afterDelete.automations, []); assert.equal(afterDelete.total, 0);
    assert.deepEqual(f.coordinator.scheduler.tick(1000), []);
  } finally { f.close(); }
});

test('calendar schedules save, pause, resume, tick across DST, and reject invalid definitions at parse time through tools', async () => {
  const f = fixture();
  try {
    const automationId = 'ny-weekday-standup';
    const saved = AutomationRecord.parse(await f.run('automation.save', {
      automationId,
      expectedRevision: 0,
      schedule: {
        name: 'NY standup',
        timezone: 'America/New_York',
        nextAt: Date.parse('2026-03-06T12:00:00Z'),
        intervalMs: null,
        missed: 'coalesce',
        calendar: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' },
        task: { goal: 'Post standup summary', profile: 'operations' },
      },
    }));
    assert.equal(saved.data.nextAt, Date.parse('2026-03-06T14:00:00Z'));
    // Pause and resume preserve nextAt.
    const paused = AutomationRecord.parse(await f.run('automation.set_paused', { automationId, expectedRevision: 1, paused: true }));
    assert.equal(paused.data.nextAt, Date.parse('2026-03-06T14:00:00Z'));
    const resumed = AutomationRecord.parse(await f.run('automation.set_paused', { automationId, expectedRevision: 2, paused: false }));
    assert.equal(resumed.data.nextAt, Date.parse('2026-03-06T14:00:00Z'));
    assert.equal(f.coordinator.scheduler.tick(Date.parse('2026-03-06T14:00:00Z')).length, 1);
    // Crosses spring-forward to 09:00 EDT (13:00Z).
    assert.equal(f.db.need<Schedule>('automation', automationId).data.nextAt, Date.parse('2026-03-09T13:00:00Z'));

    // Invalid calendar saves fail before proposal.
    for (const bad of [
      { intervalMs: 60000, calendar: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' } },
      { intervalMs: null, timezone: 'UTC', calendar: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' } },
      { intervalMs: null, timezone: '+05:30', calendar: { kind: 'cron', expression: '0 9 * * *', timezone: '+05:30', gap: 'skip', fold: 'earlier' } },
      { intervalMs: null, timezone: 'America/New_York', calendar: { kind: 'cron', expression: '@daily', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' } },
      { intervalMs: null, timezone: 'America/New_York', calendar: { kind: 'cron', expression: '0 0 31 2 *', timezone: 'America/New_York', gap: 'skip', fold: 'earlier' } },
    ]) {
      await f.rejects('automation.save', {
        automationId: 'bad-calendar',
        expectedRevision: 0,
        schedule: {
          name: 'Bad calendar',
          timezone: 'America/New_York',
          nextAt: Date.parse('2026-03-06T12:00:00Z'),
          missed: 'coalesce',
          task: { goal: 'Never', profile: 'operations' },
          ...bad,
        },
      });
    }
  } finally { f.close(); }
});

test('save and delete execute through the existing Scheduler inside a Ledger transaction, never during proposal', async t => {
  const f = fixture();
  try {
    const save = f.coordinator.scheduler.save.bind(f.coordinator.scheduler);
    const delegatedSave = t.mock.method(f.coordinator.scheduler, 'save', (key: string, expected: number, input: unknown) => {
      assert.equal(f.db.db.isTransaction, true, 'Execute must validate and save in the same transaction');
      return save(key, expected, input);
    });
    const del = f.coordinator.scheduler.delete.bind(f.coordinator.scheduler);
    const delegatedDelete = t.mock.method(f.coordinator.scheduler, 'delete', (key: string, expected: number) => {
      assert.equal(f.db.db.isTransaction, true, 'Execute must validate and delete in the same transaction');
      return del(key, expected);
    });
    const action = await f.propose('automation.save', { automationId: 'transactional-save', expectedRevision: 0, schedule: schedule() });
    assert.equal(delegatedSave.mock.callCount(), 0);
    const observed = await f.gate.dispatch(action.id);
    assert.equal(observed.data.state, 'succeeded', JSON.stringify(observed.data.result));
    assert.equal(delegatedSave.mock.callCount(), 1);
    assert.deepEqual(AutomationRecord.parse(observed.data.result), f.db.need('automation', 'transactional-save'));

    const deleteAction = await f.propose('automation.delete', { automationId: 'transactional-save', expectedRevision: 1 });
    assert.equal(delegatedDelete.mock.callCount(), 0);
    const deleted = await f.gate.dispatch(deleteAction.id);
    assert.equal(deleted.data.state, 'succeeded', JSON.stringify(deleted.data.result));
    assert.equal(delegatedDelete.mock.callCount(), 1);
    assert.equal(DeletedAutomationRecord.parse(deleted.data.result).revision, 2);
    assert.equal(f.db.get('automation', 'transactional-save'), undefined);
  } finally { f.close(); }
});

test('list defaults to 50 records, paginates without overlap, filters by id and never changes automations', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 52; index++) f.coordinator.scheduler.save(`routine-${index}`, 0, schedule());
    const records = f.db.list<Schedule>('automation');
    const first = AutomationPage.parse(await f.run('automation.list', {}));
    assert.equal(first.automations.length, 50); assert.equal(first.total, 52); assert.equal(first.hasMore, true);
    const last = AutomationPage.parse(await f.run('automation.list', { offset: 50 }));
    assert.equal(last.automations.length, 2); assert.equal(last.total, 52); assert.equal(last.hasMore, false);
    assert.deepEqual(new Set([...first.automations, ...last.automations].map(row => row.id)), new Set(records.map(row => row.id)));
    const limited = AutomationPage.parse(await f.run('automation.list', { limit: 1, offset: 1 }));
    assert.deepEqual(limited.automations, first.automations.slice(1, 2)); assert.equal(limited.total, 52); assert.equal(limited.hasMore, true);
    const all = AutomationPage.parse(await f.run('automation.list', { limit: 100, offset: 0 }));
    assert.equal(all.automations.length, 52); assert.equal(all.hasMore, false);
    const pastEnd = AutomationPage.parse(await f.run('automation.list', { offset: 52 }));
    assert.deepEqual(pastEnd.automations, []); assert.equal(pastEnd.total, 52); assert.equal(pastEnd.hasMore, false);
    const missing = AutomationPage.parse(await f.run('automation.list', { automationId: 'missing' }));
    assert.deepEqual(missing.automations, []); assert.equal(missing.total, 0); assert.equal(missing.hasMore, false);
    const selected = AutomationPage.parse(await f.run('automation.list', { automationId: records[0]!.id }));
    assert.deepEqual(selected.automations, [records[0]]); assert.equal(selected.total, 1); assert.equal(selected.hasMore, false);
    assert.deepEqual(f.db.list('automation'), records);
  } finally { f.close(); }
});

test('tool-created automations run through the existing Scheduler with full_control and honor pause/resume', async () => {
  const f = fixture();
  try {
    const automationId = 'scheduled-health';
    await f.run('automation.save', { automationId, expectedRevision: 0, schedule: schedule({ paused: true }) });
    assert.deepEqual(f.coordinator.scheduler.tick(1000), []);
    await f.run('automation.set_paused', { automationId, expectedRevision: 1, paused: false });
    const started = f.coordinator.scheduler.tick(181000);
    assert.equal(started.length, 1); assert.deepEqual(f.coordinator.scheduler.tick(181000), []);
    const child = f.db.need('task', started[0]!);
    assert.equal(child.data.goal, 'Inspect service health'); assert.equal(child.data.profile, 'operations');
    assert.equal(f.db.need('policy', child.id).data.mode, 'full_control');
    assert.equal(f.db.list('task').length, 2);
    assert.equal(f.db.list('occurrence')[0]?.data.automationId, automationId);
    const stored = f.db.need<Schedule>('automation', automationId);
    assert.equal(stored.revision, 3); assert.equal(stored.data.nextAt, 241000);
    const page = AutomationPage.parse(await f.run('automation.list', { automationId }));
    assert.deepEqual(page.automations, [stored]);
  } finally { f.close(); }
});

for (const mode of ['ask_permission', 'auto'] as const) test(`${mode} save, pause, resume and delete require exact approvals`, async () => {
  const f = fixture(mode);
  try {
    const automationId = 'owner-approved';
    for (const [name, input] of [
      ['automation.save', { automationId, expectedRevision: 0, schedule: schedule() }],
      ['automation.set_paused', { automationId, expectedRevision: 1, paused: true }],
      ['automation.set_paused', { automationId, expectedRevision: 2, paused: false }],
      ['automation.delete', { automationId, expectedRevision: 3 }],
    ] as const) {
      const before = f.db.list('automation');
      const action = await f.propose(name, input);
      assert.equal(action.data.state, 'pending'); assert.deepEqual(action.data.effects, ['automation.write']);
      assert.deepEqual(f.db.list('automation'), before, 'Proposal alone must not write or delete the schedule');
      assert.equal(f.db.need('inbox', action.id).data.state, 'pending');
      await assert.rejects(f.gate.dispatch(action.id), /not_authorized/);
      f.approve(action);
      const observed = await f.gate.dispatch(action.id);
      assert.equal(observed.data.state, 'succeeded');
      const result = name === 'automation.delete'
        ? DeletedAutomationRecord.parse(observed.data.result)
        : AutomationRecord.parse(observed.data.result);
      assert.equal(result.revision, input.expectedRevision + 1);
    }
    assert.equal(f.db.list('automation').length, 0);
  } finally { f.close(); }
});

test('stale save, pause and delete revisions, and updates to missing ids, are rejected before proposal', async () => {
  const f = fixture();
  try {
    f.coordinator.scheduler.save('existing', 0, schedule());
    const before = f.db.list('automation');
    for (const expectedRevision of [0, 2]) await f.rejects('automation.save', { automationId: 'existing', expectedRevision, schedule: schedule() });
    await f.rejects('automation.save', { automationId: 'missing', expectedRevision: 1, schedule: schedule() });
    await f.rejects('automation.set_paused', { automationId: 'existing', expectedRevision: 2, paused: true });
    await f.rejects('automation.set_paused', { automationId: 'missing', expectedRevision: 1, paused: true });
    await f.rejects('automation.delete', { automationId: 'existing', expectedRevision: 2 });
    await f.rejects('automation.delete', { automationId: 'missing', expectedRevision: 1 });
    assert.deepEqual(f.db.list('automation'), before);
  } finally { f.close(); }
});

for (const operation of ['create', 'update', 'pause', 'resume', 'delete'] as const) {
  for (const mode of ['full_control', 'ask_permission'] as const) test(`${operation} revalidates revisions for ${mode}; stale dispatch is rejected before execution without overwriting newer data`, async () => {
    const f = fixture(mode);
    try {
      const automationId = 'concurrent-schedule';
      const existing = operation === 'create' ? undefined : f.coordinator.scheduler.save(automationId, 0, schedule({ paused: operation === 'resume' }));
      const name = operation === 'create' || operation === 'update' ? 'automation.save'
        : operation === 'delete' ? 'automation.delete' : 'automation.set_paused';
      const input = name === 'automation.save'
        ? { automationId, expectedRevision: existing?.revision ?? 0, schedule: schedule({ name: 'Proposed value' }) }
        : name === 'automation.delete'
          ? { automationId, expectedRevision: existing!.revision }
          : { automationId, expectedRevision: existing!.revision, paused: operation === 'pause' };
      const action = await f.propose(name, input);
      if (action.data.state === 'pending') f.approve(action);
      const concurrent = f.coordinator.scheduler.save(automationId, existing?.revision ?? 0, schedule({ name: 'Concurrent owner edit', paused: operation === 'resume' }));
      await assert.rejects(f.gate.dispatch(action.id), /stale_revision/);
      assert.deepEqual(f.db.need('automation', automationId), concurrent);
      assert.equal(f.db.list('automation').length, 1);
    } finally { f.close(); }
  });
}

test('invalid list/save/pause/delete inputs fail at parse time without action or automation writes', async () => {
  const f = fixture();
  try {
    for (const input of [null, [], { extra: true }, { automationId: 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '50' }, { offset: -1 }, { offset: 0.5 }, { offset: '0' }]) await f.rejects('automation.list', input);
    const valid = { automationId: 'valid', expectedRevision: 0, schedule: schedule() };
    for (const input of [null, [], {}, { ...valid, automationId: '' }, { ...valid, automationId: 'a'.repeat(201) }, { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 0.5 }, { ...valid, expectedRevision: '0' }, { ...valid, extra: true }]) await f.rejects('automation.save', input);
    for (const invalid of [
      { timezone: 'Not/A_Real_Zone' }, { intervalMs: 59999 }, { intervalMs: 60000.5 }, { intervalMs: '60000' },
      { nextAt: -1 }, { nextAt: 0.5 }, { missed: 'replay' }, { cron: '* * * * *' }, { cronExpression: '* * * * *' },
      { task: { goal: 'Inspect', profile: 'operations', mode: 'root' } },
      { task: { goal: 'Inspect', profile: 'operations', model: 'legacy', modelRef: { providerId: 'openai', modelId: 'fixture' } } },
    ]) await f.rejects('automation.save', { ...valid, schedule: { ...schedule(), ...invalid } });
    f.coordinator.scheduler.save('existing', 0, schedule());
    const pause = { automationId: 'existing', expectedRevision: 1, paused: true };
    for (const input of [null, [], {}, { ...pause, expectedRevision: 0 }, { ...pause, expectedRevision: -1 }, { ...pause, expectedRevision: 1.5 }, { ...pause, expectedRevision: '1' }, { ...pause, paused: 'true' }, { ...pause, extra: true }]) await f.rejects('automation.set_paused', input);
    const del = { automationId: 'existing', expectedRevision: 1 };
    for (const input of [null, [], {}, { ...del, automationId: '' }, { ...del, expectedRevision: 0 }, { ...del, expectedRevision: -1 }, { ...del, expectedRevision: 1.5 }, { ...del, expectedRevision: '1' }, { ...del, extra: true }]) await f.rejects('automation.delete', input);
    assert.equal(f.db.list('action').length, 0); assert.equal(f.db.list('automation').length, 1);
  } finally { f.close(); }
});

test('valid boundary ids, one-shot schedules and IANA timezones are accepted', async () => {
  const f = fixture();
  try {
    for (const automationId of ['a', 'a'.repeat(200)]) {
      const saved = AutomationRecord.parse(await f.run('automation.save', { automationId, expectedRevision: 0, schedule: schedule({ timezone: 'America/New_York', intervalMs: null }) }));
      assert.equal(saved.id, automationId); assert.equal(saved.data.timezone, 'America/New_York'); assert.equal(saved.data.intervalMs, null);
    }
    assert.equal(f.coordinator.scheduler.tick(1000).length, 2);
    assert.deepEqual(f.coordinator.scheduler.tick(1000), []);
    assert.ok(f.db.list<Schedule>('automation').every(row => row.data.paused));
  } finally { f.close(); }
});

for (const sourceMode of ['ask_permission', 'auto', 'full_control'] as const) test(`${sourceMode} can save, pause, resume and delete after required review, preserving each child mode`, async () => {
  const f = fixture(sourceMode);
  try {
    for (const childMode of ['ask_permission', 'auto', 'full_control'] as const) {
      const automationId = `child-${childMode}`;
      const child = schedule({ task: { goal: 'Inspect', profile: 'operations', mode: childMode } });
      const saved = AutomationRecord.parse(await f.run('automation.save', { automationId, expectedRevision: 0, schedule: child }));
      assert.equal(saved.data.task.mode, childMode === 'full_control' ? 'full_control' : 'auto');
      await f.run('automation.set_paused', { automationId, expectedRevision: 1, paused: true });
      assert.equal(f.db.need<Schedule>('automation', automationId).data.paused, true);
      await f.run('automation.set_paused', { automationId, expectedRevision: 2, paused: false });
      assert.equal(f.db.need<Schedule>('automation', automationId).data.paused, false);
      await f.run('automation.delete', { automationId, expectedRevision: 3 });
      assert.equal(f.db.get('automation', automationId), undefined);
    }
    assert.equal(f.db.list('inbox').filter(row => row.data.state === 'pending').length, 0);
  } finally { f.close(); }
});

test('omitting child mode uses full_control even for a legacy ask_permission source', async () => {
  const f = fixture('ask_permission');
  try {
    const action = await f.propose('automation.save', { automationId: 'default-mode', expectedRevision: 0, schedule: schedule() });
    assert.equal(action.data.state, 'pending');
    assert.equal(f.db.list('automation').length, 0);
    f.approve(action);
    const observed = await f.gate.dispatch(action.id);
    assert.equal(observed.data.state, 'succeeded');
    assert.equal(AutomationRecord.parse(observed.data.result).data.task.mode, 'full_control');
  } finally { f.close(); }
});

for (const configured of [false, true]) test(`provider-qualified modelRef requires a configured worker (${configured})`, async () => {
  const f = fixture('full_control', configured ? { worker: new WorkerClient('http://127.0.0.1:1', 'fixture-worker-token'.repeat(2)) } : {});
  try {
    const modelRef = { providerId: 'openai', modelId: 'fixture' };
    const input = { automationId: 'qualified-model', expectedRevision: 0, schedule: schedule({ task: { goal: 'Inspect', profile: 'operations', mode: 'ask_permission', modelRef } }) };
    if (!configured) await f.rejects('automation.save', input);
    else {
      const saved = AutomationRecord.parse(await f.run('automation.save', input));
      assert.deepEqual(saved.data.task.modelRef, modelRef);
      const started = f.coordinator.scheduler.tick(1000);
      assert.equal(started.length, 1);
      const child = f.db.need('task', started[0]!);
      assert.equal(child.data.provider, modelRef.providerId); assert.equal(child.data.model, modelRef.modelId);
    }
  } finally { f.close(); }
});

for (const hold of ['recovery', 'invalid recovery', 'draining', 'holding', 'prepared'] as const) {
  for (const phase of ['before proposal', 'after proposal'] as const) test(`${hold} hold ${phase} blocks all automation writes without changing records`, async () => {
    const f = fixture();
    try {
      f.coordinator.scheduler.save('existing', 0, schedule());
      f.coordinator.scheduler.save('paused', 0, schedule({ paused: true }));
      const writes = [
        ['automation.save', { automationId: 'new', expectedRevision: 0, schedule: schedule() }],
        ['automation.save', { automationId: 'existing', expectedRevision: 1, schedule: schedule({ name: 'Changed' }) }],
        ['automation.set_paused', { automationId: 'existing', expectedRevision: 1, paused: true }],
        ['automation.set_paused', { automationId: 'paused', expectedRevision: 1, paused: false }],
        ['automation.delete', { automationId: 'existing', expectedRevision: 1 }],
      ] as const;
      const proposals: RecordValue<Action>[] = [];
      if (phase === 'after proposal') for (const [name, input] of writes) proposals.push(await f.propose(name, input));
      if (hold === 'recovery') f.db.put('recovery', 'server', 0, { dispatchEnabled: false });
      else if (hold === 'invalid recovery') f.db.put('recovery', 'server', 0, { dispatchEnabled: 'true' });
      else f.db.put('runtime_update', 'server', 0, { state: hold });
      const before = f.db.list('automation');
      if (phase === 'before proposal') for (const [name, input] of writes) await f.rejects(name, input);
      else for (const action of proposals) {
        await assert.rejects(f.gate.dispatch(action.id), /recovery_dispatch_disabled|maintenance_in_progress/);
        assert.deepEqual(f.db.list('automation'), before);
      }
      assert.deepEqual(f.db.list('automation'), before);
      await assert.rejects(f.run('automation.list', {}), /recovery_dispatch_disabled|maintenance_in_progress/);
      assert.deepEqual(f.db.list('automation'), before, 'Read-only ledger queries remain available without dispatch');
    } finally { f.close(); }
  });
}
