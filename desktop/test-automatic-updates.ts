import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  automaticUpdateConnections, automaticUpdatePresentation, automaticUpdateTargets, automaticUpdatesInterval, automaticUpdatesPending,
  createAutomaticUpdatesController, type AutomaticUpdatesInput, type AutomaticUpdatesStatus,
} from './src/automatic-updates.ts';

const status = (patch: Partial<AutomaticUpdatesStatus> = {}): AutomaticUpdatesStatus => ({ enabled: false, targets: [], activeEnvironmentId: null, servers: [], ...patch });
const input = (): AutomaticUpdatesInput => ({
  native: true, recordedPreview: false,
  environments: [{ environmentId: 'alpha' }, { environmentId: 'beta' }],
  connections: { alpha: { connected: true, info: {} }, beta: { connected: true, info: {} } },
});
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(initial = input(), response?: (command: string, args?: Record<string, unknown>) => Promise<AutomaticUpdatesStatus>) {
  let current = initial, nextTimer = 0, active = 0, maximumActive = 0;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const controller = createAutomaticUpdatesController({
    input: () => current,
    invoke: async (command, args) => {
      calls.push({ command, args }); active += 1; maximumActive = Math.max(maximumActive, active);
      try { return await (response?.(command, args) ?? Promise.resolve(status())); }
      finally { active -= 1; }
    },
    schedule: (callback, delay) => {
      const id = ++nextTimer; timers.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: timer => { timers.delete(timer as unknown as number); },
  });
  return {
    controller, calls, timers, maximumActive: () => maximumActive,
    change(value: AutomaticUpdatesInput) { current = value; controller.connectionsChanged(); },
    async start() { controller.start(); await settle(); },
    async fire() {
      assert.equal(timers.size, 1, 'only one polling timer exists');
      const [id, timer] = [...timers][0]; timers.delete(id); timer.callback(); await settle();
    },
  };
}

test('mount restores status, then ticks both connected servers without automatically opting in', async () => {
  const h = harness();
  await h.start();
  assert.deepEqual(h.calls, [{ command: 'automatic_updates_status', args: undefined }]);
  await h.fire();
  assert.deepEqual(h.calls[1], { command: 'automatic_updates_tick', args: { connectedEnvironmentIds: ['alpha', 'beta'] } });
  assert.equal([...h.timers.values()][0].delay, automaticUpdatesInterval);
  await h.fire();
  assert.ok(h.calls.every(call => ['automatic_updates_status', 'automatic_updates_tick'].includes(call.command)));
  h.controller.stop();
  assert.equal(h.timers.size, 0);
});

test('browser and recorded previews never invoke native commands, including explicit actions', async () => {
  for (const mode of [{ native: false, recordedPreview: false }, { native: false, recordedPreview: true }, { native: true, recordedPreview: true }]) {
    const h = harness({ ...input(), ...mode });
    await h.start();
    await h.controller.refresh(); await h.controller.enable(true); await h.controller.disable();
    h.controller.connectionsChanged();
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
    h.controller.stop();
  }
});

test('all saved nonretired IDs are enrolled only with consent, including offline and missing connections', async () => {
  const value = input();
  value.environments.push({ environmentId: 'gamma' }, { environmentId: 'retired', retired: true }, { environmentId: 'old' });
  value.connections.beta.connected = false;
  value.connections.old = { connected: true, retired: true, info: {} };
  value.connections.removed = { connected: true, info: {} };
  const h = harness(value);
  await h.start();
  assert.deepEqual(automaticUpdateTargets(value), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(automaticUpdateConnections(value), ['alpha']);
  assert.equal(await h.controller.enable(false), false);
  assert.equal(await h.controller.enable(true, true, ['alpha']), false);
  assert.equal(h.calls.length, 1);
  await h.controller.enable(true);
  assert.deepEqual(h.calls[1], { command: 'automatic_updates_enable', args: { environmentIds: ['alpha', 'beta', 'gamma'], approved: true, password: true } });
  h.controller.stop();
});

test('changed registry invalidates old consent instead of silently enrolling a newly added server', async () => {
  const h = harness(); await h.start();
  const next = input(); next.environments.push({ environmentId: 'new-server' });
  h.change(next); await settle();
  assert.equal(await h.controller.enable(true, true, ['alpha', 'beta']), false);
  assert.ok(!h.calls.some(call => call.command === 'automatic_updates_enable'));
  h.controller.stop();
});

test('missing connection info, retired, pending and disconnected entries are not asserted connected or updated', () => {
  const value = input();
  value.connections.alpha.info = null; value.connections.beta.connected = false;
  assert.deepEqual(automaticUpdateConnections(value), []);
  value.connections.alpha.info = { pendingError: 'Needs recovery' };
  assert.deepEqual(automaticUpdateConnections(value), []);
  const complete = { environmentId: 'alpha', state: 'complete', message: 'Release installed.' };
  assert.deepEqual(automaticUpdatePresentation(undefined, true), { label: 'Status unknown', message: 'No supervisor status reported. No update outcome is confirmed.', uncertain: false });
  const offline = automaticUpdatePresentation(complete, false);
  assert.equal(offline.label, 'Status unavailable');
  assert.match(offline.message, /^Last reported \(complete\):/);
});

test('polling, connection changes and user actions share one synchronous IPC gate', async () => {
  const pending = deferred<AutomaticUpdatesStatus>();
  const h = harness(input(), async command => command === 'automatic_updates_tick' ? pending.promise : status());
  await h.start(); await h.fire();
  assert.equal(h.controller.getSnapshot().busy, true);
  h.controller.connectionsChanged(); h.controller.connectionsChanged();
  assert.equal(await h.controller.refresh(), false);
  assert.equal(await h.controller.enable(true), false);
  assert.equal(await h.controller.disable(), false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
  pending.resolve(status()); await settle();
  assert.equal(h.timers.size, 1);
  await h.fire();
  assert.equal(h.maximumActive(), 1);
  assert.equal([...h.timers.values()][0].delay, 15_000);
  h.controller.stop();
});

test('slow enrollment is never submitted twice and supports explicit passwordless enrollment', async () => {
  const pending = deferred<AutomaticUpdatesStatus>();
  const h = harness(input(), async command => command === 'automatic_updates_enable' ? pending.promise : status());
  await h.start();
  const first = h.controller.enable(true, false);
  assert.equal(await h.controller.enable(true, false), false);
  assert.deepEqual(h.calls[1].args, { environmentIds: ['alpha', 'beta'], approved: true, password: false });
  pending.resolve(status({ enabled: true, targets: ['alpha', 'beta'] }));
  assert.equal(await first, true);
  await h.fire();
  assert.equal(h.calls.filter(call => call.command === 'automatic_updates_enable').length, 1);
  h.controller.stop();
});

test('enabled supervisor continues ticking with no connections; local optout still reconciles pending work', async () => {
  const offline = input(); offline.connections = {};
  let enabled = true;
  const pending = { environmentId: 'alpha', state: 'unknown', message: 'Launch receipt not confirmed.' };
  const h = harness(offline, async command => {
    if (command === 'automatic_updates_disable') enabled = false;
    return status({ enabled, targets: ['alpha', 'beta'], activeEnvironmentId: 'alpha', servers: [pending] });
  });
  await h.start(); await h.fire();
  assert.deepEqual(h.calls[1].args, { connectedEnvironmentIds: [] });
  await h.controller.disable();
  assert.equal(h.controller.getSnapshot().status?.enabled, false);
  await h.fire();
  assert.deepEqual(h.calls.at(-1), { command: 'automatic_updates_tick', args: { connectedEnvironmentIds: [] } });
  assert.equal(h.calls.filter(call => call.command === 'automatic_updates_disable').length, 1);
  assert.ok(!h.calls.some(call => /start|cancel|enable$/.test(call.command)));
  h.controller.stop();
});

test('relaunch reads durable unknown state and only asks native to reconcile, never retries a start', async () => {
  const durable = status({ enabled: true, targets: ['alpha', 'beta'], servers: [{ environmentId: 'alpha', state: 'unknown', message: 'Original operation may be running.', releaseId: 'release-a' }] });
  for (let restart = 0; restart < 2; restart += 1) {
    const h = harness(input(), async () => durable);
    await h.start(); await h.fire(); await h.fire();
    assert.deepEqual(h.controller.getSnapshot().status, durable);
    assert.equal(await h.controller.enable(true), false);
    const view = automaticUpdatePresentation(durable.servers[0], true);
    assert.equal(view.label, 'Needs attention'); assert.equal(view.uncertain, true);
    assert.match(view.message, /may be running/);
    assert.ok(h.calls.every(call => ['automatic_updates_status', 'automatic_updates_tick'].includes(call.command)));
    h.controller.stop();
  }
});

test('unconfirmed enrollment is visible and reconciled through status without repeating enrollment', async () => {
  const h = harness(input(), async command => {
    if (command === 'automatic_updates_enable') throw new Error('Lost response');
    return status();
  });
  await h.start(); await h.controller.enable(true);
  assert.equal(h.controller.getSnapshot().uncertain, true);
  assert.match(h.controller.getSnapshot().error, /could not be confirmed/);
  assert.equal(await h.controller.enable(true), false);
  assert.equal([...h.timers.values()][0].delay, 15_000);
  await h.fire();
  assert.equal(h.calls.at(-1)?.command, 'automatic_updates_status');
  await h.fire();
  assert.equal(h.calls.filter(call => call.command === 'automatic_updates_enable').length, 1);
  h.controller.stop();
});

test('malformed or failed status never implies an update succeeded or grants enrollment', async () => {
  const h = harness(input(), async () => ({ enabled: false } as AutomaticUpdatesStatus));
  await h.start();
  assert.equal(h.controller.getSnapshot().status, null);
  assert.equal(h.controller.getSnapshot().uncertain, true);
  assert.equal(await h.controller.enable(true), false);
  await h.fire();
  assert.ok(h.calls.every(call => call.command === 'automatic_updates_status'));
  h.controller.stop();
});

test('unmount cancels timers and fences late responses; StrictMode remount cannot overlap IPC', async () => {
  const pending = deferred<AutomaticUpdatesStatus>();
  const h = harness(input(), async () => pending.promise);
  await h.start(); h.controller.stop();
  pending.resolve(status({ enabled: true })); await settle();
  assert.equal(h.controller.getSnapshot().status, null);
  assert.equal(h.timers.size, 0);

  const second = deferred<AutomaticUpdatesStatus>(); let reads = 0;
  const remount = harness(input(), async () => ++reads === 1 ? second.promise : status());
  await remount.start(); remount.controller.stop(); await remount.start();
  assert.equal(remount.calls.length, 1);
  second.resolve(status({ enabled: true })); await settle();
  assert.equal(remount.controller.getSnapshot().status, null);
  await remount.fire();
  assert.equal(remount.controller.getSnapshot().status?.enabled, false);
  assert.equal(remount.maximumActive(), 1);
  remount.controller.stop();
});

test('switching into preview fences an in-flight reply and prevents subsequent native calls', async () => {
  const pending = deferred<AutomaticUpdatesStatus>();
  const h = harness(input(), async () => pending.promise);
  await h.start(); h.change({ ...input(), recordedPreview: true });
  pending.resolve(status({ enabled: true })); await settle();
  assert.equal(h.controller.getSnapshot().status, null);
  assert.equal(h.timers.size, 0);
  await h.controller.disable();
  assert.equal(h.calls.length, 1);
  h.controller.stop();
});

test('native passive and terminal phases are not pending unless an environment is reserved', () => {
  for (const state of ['ready', 'checked', 'blocked', 'complete', 'failed', 'rolled_back', 'idle', 'not_enabled']) {
    const servers = [{ environmentId: 'alpha', state, message: 'Native status' }];
    assert.equal(automaticUpdatesPending(status({ servers })), false, state);
    assert.equal(automaticUpdatesPending(status({ servers, activeEnvironmentId: 'alpha' })), true, `${state} with reservation`);
  }
  for (const state of ['enrolling', 'authorizing', 'updating', 'unknown', 'verifying', 'needs_attention', 'future_phase']) {
    assert.equal(automaticUpdatesPending(status({ servers: [{ environmentId: 'alpha', state, message: 'Queue held' }] })), true, state);
  }
});

test('disabled initial checks with ready, checked or blocked rows still allow explicit all-server enrollment', async () => {
  for (const state of ['ready', 'checked', 'blocked', 'idle', 'not_enabled']) {
    const checked = status({ servers: ['alpha', 'beta'].map(environmentId => ({ environmentId, state, message: 'Read-only check' })) });
    const h = harness(input(), async command => command === 'automatic_updates_enable' ? status({ enabled: true, targets: ['alpha', 'beta'] }) : checked);
    await h.start(); await h.fire();
    assert.equal(await h.controller.enable(true), true, state);
    assert.deepEqual(h.calls.at(-1), { command: 'automatic_updates_enable', args: { environmentIds: ['alpha', 'beta'], approved: true, password: true } });
    h.controller.stop();
  }
});

test('active reservations override passive phases and true enrollment or uncertainty always blocks enable', async () => {
  const cases = [
    ...['ready', 'checked', 'blocked', 'not_enabled'].map(state => ({ state, activeEnvironmentId: 'alpha' })),
    ...['enrolling', 'authorizing', 'updating', 'unknown', 'verifying', 'needs_attention'].map(state => ({ state, activeEnvironmentId: null })),
  ];
  for (const { state, activeEnvironmentId } of cases) {
    const offline = input(); offline.connections = {};
    const held = status({ activeEnvironmentId, servers: [{ environmentId: 'alpha', state, message: 'Reserved or uncertain' }] });
    const h = harness(offline, async () => held);
    await h.start();
    assert.equal(await h.controller.enable(true), false, state);
    await h.fire();
    assert.deepEqual(h.calls.at(-1), { command: 'automatic_updates_tick', args: { connectedEnvironmentIds: [] } });
    assert.ok(!h.calls.some(call => call.command === 'automatic_updates_enable'));
    h.controller.stop();
  }
});

test('partial native enrollment is status, not success; reconciliation never silently enables remaining servers', async () => {
  let enrollmentCalls = 0, reconcile = false;
  const partial = status({ targets: ['alpha', 'beta'], activeEnvironmentId: 'beta', servers: [
    { environmentId: 'alpha', state: 'not_enabled', message: 'Enrolled; automatic launching remains off' },
    { environmentId: 'beta', state: 'enrolling', message: 'Enrollment could not be confirmed. Public-policy inspection only.' },
  ] });
  const reconciled = status({ targets: ['alpha', 'beta'], servers: partial.servers.map(server => ({ ...server, state: 'not_enabled' })) });
  const h = harness(input(), async command => {
    if (command === 'automatic_updates_enable') {
      enrollmentCalls += 1;
      return enrollmentCalls === 1 ? partial : status({ enabled: true, targets: ['alpha', 'beta'] });
    }
    return enrollmentCalls ? reconcile ? reconciled : partial : status();
  });
  await h.start();
  assert.equal(await h.controller.enable(true), false, 'a successful IPC response is not successful all-server enrollment');
  assert.deepEqual(h.controller.getSnapshot().status, partial);
  assert.equal(h.controller.getSnapshot().uncertain, false, 'the native response itself is valid');
  assert.equal(await h.controller.enable(true), false);
  await h.fire();
  assert.equal(enrollmentCalls, 1);
  reconcile = true;
  await h.fire();
  assert.equal(h.controller.getSnapshot().status?.enabled, false);
  assert.equal(enrollmentCalls, 1, 'public-policy reconciliation does not replay enrollment');
  assert.equal(await h.controller.enable(false), false);
  assert.equal(await h.controller.enable(true), true, 'fresh explicit consent is required after reconciliation');
  assert.equal(enrollmentCalls, 2);
  h.controller.stop();
});

test('enable requires confirmation for every requested target, not merely a valid status response', async () => {
  for (const reply of [
    status({ targets: ['alpha', 'beta'] }),
    status({ enabled: true, targets: ['alpha'] }),
    status({ enabled: true, targets: ['alpha', 'beta'], activeEnvironmentId: 'beta', servers: [{ environmentId: 'beta', state: 'enrolling', message: 'Not confirmed' }] }),
  ]) {
    const h = harness(input(), async command => command === 'automatic_updates_enable' ? reply : status());
    await h.start();
    assert.equal(await h.controller.enable(true), false);
    assert.deepEqual(h.controller.getSnapshot().status, reply);
    h.controller.stop();
  }
});

test('global provider and shared settings use the existing UI primitives and explicit safety consent', () => {
  const environments = readFileSync(new URL('./src/Environments.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('./src/RuntimeSettings.tsx', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./src/AutomaticUpdates.tsx', import.meta.url), 'utf8');
  assert.match(environments, /return <AutomaticUpdatesProvider registry=\{registry\} connections=\{connections\}>/);
  assert.match(settings, /<AutomaticUpdatesSection \/>/);
  assert.match(ui, /const working = useRef\(false\)/);
  for (const primitive of ['Section', 'SettingRow', 'Button', 'Dialog']) assert.ok(ui.includes(`<${primitive}`));
  assert.match(ui, /useState\(false\), \[password, setPassword\] = useState\(true\)/);
  assert.match(ui, /signed, compatible Outpost/);
  assert.match(ui, /short service interruptions/i);
  assert.match(ui, /not unrestricted sudo/);
  assert.match(ui, /No password enters this page or is stored/);
  assert.match(ui, /does not cancel an ongoing update or remove the restricted updater grant/);
  assert.match(ui, /Global setting for all saved servers/);
  assert.match(ui, /automaticUpdatePresentation\(server, connected && !!updates\?\.available && !updates\.uncertain\)/);
  assert.match(ui, /Target status unknown/);
  assert.match(ui, /Enrollment unconfirmed/);
  assert.match(ui, /Enrollment is not confirmed for all servers/);
  assert.match(ui, /does not repeat enrollment or enable the remaining servers/);
  assert.match(ui, /dialog === 'enable' && enrollmentNotice/);
  assert.match(ui, /enable\(approved, password, reviewedIds\)\.then\(confirmed => \{ if \(confirmed\) close\(\); \}\)/);
  assert.doesNotMatch(ui, /type="password"|environment_update_start|localStorage/);
});
