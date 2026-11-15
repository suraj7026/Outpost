import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from './metrics.js';
import { MetricCorrelation, MetricIds, type MetricObservation, type MetricRecord } from './metrics-schema.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const correlation = MetricCorrelation.parse({ identityId: uuid(1), projectId: uuid(2), taskId: uuid(3), runId: uuid(4), inputId: uuid(5), actionId: uuid(6), attemptId: uuid(7), workerId: uuid(8), deliveryId: uuid(9) });
const scope = { identityId: correlation.identityId, projectId: correlation.projectId };
const usage: Extract<MetricObservation, { kind: 'usage' }> = {
  kind: 'usage', basis: 'attempt', inputTokens: { source: 'measured', value: 10 },
  outputTokens: { source: 'estimated', value: 3 }, cacheReadTokens: { source: 'unknown' },
  cacheWriteTokens: { source: 'unknown' }, comparableUsd: { source: 'unknown' },
};
function event(n: number, observation: Exclude<MetricObservation, { kind: 'duration' }> = usage, context = correlation) {
  return { eventId: MetricIds.event.parse(uuid(n)), correlation: context, observation: structuredClone(observation) };
}

test('metrics monotonic measured stages, correlations and explicit outcomes', () => {
  let time = 100;
  const collector = new MetricsCollector({ clock: () => time });
  for (const [index, stage] of (['queue', 'first_token', 'execution', 'reducer', 'compaction', 'retry'] as const).entries()) {
    const span = collector.startStage(MetricIds.event.parse(uuid(20 + index)), correlation, stage);
    assert.ok(span); time += 7 + index;
    assert.equal(span.end(), 'accepted'); assert.equal(span.end(), 'duplicate');
  }
  collector.emit(event(30, { kind: 'outcome', state: 'interrupted' }));
  const summary = collector.readSummary(scope, { runId: correlation.runId });
  assert.equal(summary.durations.queue?.milliseconds, 7);
  assert.equal(summary.durations.first_token?.milliseconds, 8);
  assert.equal(summary.durations.execution?.milliseconds, 9);
  assert.equal(summary.durations.reducer?.milliseconds, 10);
  assert.equal(summary.records.length, 7);
  assert.deepEqual(summary.records[0]?.correlation, correlation);
  assert.deepEqual(summary.records.at(-1)?.observation, { kind: 'outcome', state: 'interrupted' });
  assert.equal(summary.history, 'unavailable'); assert.equal(summary.accountingAuthority, false);
});

test('metrics unknown vs measured zero and estimates; attempt dedup rejects nested aggregates and conflicting receipts', () => {
  const collector = new MetricsCollector();
  assert.equal(collector.emit(event(20)), 'accepted');
  assert.equal(collector.emit(event(20)), 'duplicate');
  assert.equal(collector.emit(event(21)), 'duplicate');
  assert.equal(collector.emit(event(22, { ...usage, inputTokens: { source: 'measured', value: 15 } })), 'conflict');
  assert.equal(collector.emit(event(23, usage, { ...correlation, runId: MetricIds.run.parse(uuid(99)) })), 'conflict');
  const aggregate = { ...usage, basis: 'nested_total' };
  assert.equal(collector.emit({ ...event(24), observation: aggregate as typeof usage }), 'invalid');
  assert.equal(collector.emit(event(25, usage, { ...correlation, attemptId: null })), 'invalid');
  collector.emit(event(26, { ...usage, inputTokens: { source: 'measured', value: 0 }, outputTokens: { source: 'unknown' }, comparableUsd: { source: 'estimated', value: 0.01 } }, { ...correlation, attemptId: MetricIds.attempt.parse(uuid(50)) }));
  const summary = collector.readSummary(scope);
  assert.equal(summary.usage.attempts, 2);
  assert.deepEqual(summary.usage.inputTokens, { measured: 10, estimated: null, unknownObservations: 0 });
  assert.deepEqual(summary.usage.outputTokens, { measured: null, estimated: 3, unknownObservations: 1 });
  assert.deepEqual(summary.usage.comparableUsd, { measured: null, estimated: 0.01, unknownObservations: 1 });
  assert.equal(summary.usage.cacheReadTokens.measured, null);
  const restarted = new MetricsCollector().readSummary(scope);
  assert.equal(restarted.usage.inputTokens.measured, null); assert.equal(restarted.history, 'unavailable');
  assert.equal(restarted.completeness, 'partial'); assert.deepEqual(restarted.records, []);
});

test('metrics scope and run/task filters prevent cross-identity/project reads and output alias mutation', () => {
  const collector = new MetricsCollector();
  collector.emit(event(20));
  collector.emit(event(21, usage, { ...correlation, identityId: MetricIds.identity.parse(uuid(90)) }));
  collector.emit(event(22, usage, { ...correlation, projectId: MetricIds.project.parse(uuid(91)) }));
  const summary = collector.readSummary(scope);
  assert.equal(summary.records.length, 1); assert.equal(summary.usage.inputTokens.measured, 10);
  assert.equal('accepted' in summary, false);
  assert.equal(collector.readSummary(scope, { taskId: MetricIds.task.parse(uuid(92)) }).records.length, 0);
  assert.equal(collector.readSummary(scope, { runId: MetricIds.run.parse(uuid(93)) }).records.length, 0);
  summary.records[0]!.correlation.projectId = MetricIds.project.parse(uuid(94));
  summary.usage.inputTokens.measured = 1000;
  assert.equal(collector.readSummary(scope).records.length, 1);
  assert.equal(collector.readSummary(scope).usage.inputTokens.measured, 10);
  assert.throws(() => collector.readSummary({ ...correlation, identityId: '' as typeof correlation.identityId }));
});

test('metrics strict allowlist rejects secret/payload/reasoning/labels at every level without export or error echo', async () => {
  const exported: MetricRecord[] = [];
  const collector = new MetricsCollector({ exporter: async records => { exported.push(...records); } });
  const secret = 'private-prompt-secret';
  const base = event(20);
  const invalid = [
    { ...base, prompt: secret }, { ...base, payload: secret }, { ...base, reasoning: secret },
    { ...base, labels: { secret } }, { ...base, correlation: { ...correlation, secret } },
    { ...base, correlation: { ...correlation, workerId: secret } },
    { ...base, observation: { ...usage, secret } },
    { ...base, observation: { ...usage, inputTokens: { source: 'measured', value: 2, secret } } },
    { ...base, observation: { kind: 'duration', stage: 'queue', milliseconds: 10 } },
    { ...base, observation: { kind: 'retry', count: Infinity } },
    { ...base, observation: { kind: 'retry', count: -1 } },
  ];
  for (const input of invalid) assert.equal(collector.emit(input as typeof base), 'invalid');
  assert.equal(collector.health().invalid, invalid.length);
  assert.equal(collector.emit(base), 'accepted');
  assert.equal(await collector.flush(), 'exported');
  assert.equal(JSON.stringify(exported).includes(secret), false);
  assert.equal(JSON.stringify(collector.readSummary(scope)).includes(secret), false);
  assert.equal(base.observation.kind, 'usage');
  if (base.observation.kind !== 'usage') throw new Error('Expected usage fixture');
  base.observation.inputTokens = { source: 'measured', value: 999 };
  assert.equal(collector.readSummary(scope).usage.inputTokens.measured, 10);
});

test('metrics finite record/byte bounds and retention are honest, dedup window expires', () => {
  let time = 0;
  const collector = new MetricsCollector({ clock: () => time, limits: { maxRecords: 1, retentionMs: 10 } });
  assert.equal(collector.emit(event(20)), 'accepted');
  assert.equal(collector.emit(event(21, { kind: 'retry', count: 1 })), 'overflow');
  assert.equal(collector.emit(event(20)), 'duplicate');
  assert.equal(collector.health().overflow, 1);
  time = 10;
  assert.equal(collector.readSummary(scope).records.length, 0);
  assert.equal(collector.health().expired, 1);
  assert.equal(collector.emit(event(20)), 'accepted');
  assert.equal(collector.readSummary(scope).usage.inputTokens.measured, 10);
  const tiny = new MetricsCollector({ limits: { maxBytes: 1 } });
  assert.equal(tiny.emit(event(30)), 'overflow'); assert.equal(tiny.health().retainedBytes, 0);
  assert.throws(() => new MetricsCollector({ limits: { maxRecords: Infinity } }));
  assert.throws(() => new MetricsCollector({ limits: { retentionMs: 0 } }));
});

test('metrics snapshot/replay/artifact and reducer synthetic fixture reports costs without claiming runtime wiring', () => {
  const collector = new MetricsCollector();
  collector.emit(event(20, { kind: 'transfer', channel: 'snapshot', bytes: 100_000 }));
  collector.emit(event(21, { kind: 'transfer', channel: 'replay', bytes: 500 }));
  collector.emit(event(22, { kind: 'transfer', channel: 'artifact', bytes: 700 }));
  collector.emit(event(23, { kind: 'reducer', records: 200 }));
  collector.emit(event(24, { kind: 'retry', count: 2 }));
  collector.emit(event(25, { kind: 'context', usedTokens: { source: 'estimated', value: 3000 }, capacityTokens: 4096 }));
  const summary = collector.readSummary(scope);
  assert.deepEqual(summary.transferBytes, { snapshot: 100_000, replay: 500, artifact: 700 });
  assert.equal(summary.reducerRecords, 200); assert.equal(summary.retries, 2);
  assert.deepEqual(summary.records.at(-1)?.observation, { kind: 'context', usedTokens: { source: 'estimated', value: 3000 }, capacityTokens: 4096 });
});

test('metrics failed exporter is counted, never invoked by emit, has bounded batches and no retry', async () => {
  let calls = 0;
  const collector = new MetricsCollector({ limits: { maxBatchRecords: 1 }, exporter: async () => { calls++; throw new Error('private provider failure'); } });
  collector.emit(event(20)); collector.emit(event(21, { kind: 'retry', count: 1 }));
  assert.equal(calls, 0);
  assert.equal(await collector.flush(), 'failed'); assert.equal(calls, 1);
  assert.equal(collector.health().failedExport, 1); assert.equal(collector.health().pendingRecords, 1);
  assert.equal(await collector.flush(), 'failed'); assert.equal(await collector.flush(), 'empty');
  assert.equal(collector.health().failedExport, 2);
  assert.equal(JSON.stringify(collector.health()).includes('private'), false);
  assert.equal(collector.readSummary(scope).records.length, 2);
});

test('metrics queue count/byte and batch byte overflow and expired export loss counters', async () => {
  let time = 0;
  const exporter = async () => {};
  const collector = new MetricsCollector({ clock: () => time, exporter, limits: { maxPendingRecords: 1, retentionMs: 10 } });
  collector.emit(event(20)); collector.emit(event(21, { kind: 'retry', count: 1 }));
  assert.equal(collector.health().exportOverflow, 1); assert.equal(collector.health().pendingRecords, 1);
  time = 10;
  assert.equal(await collector.flush(), 'empty'); assert.equal(collector.health().exportExpired, 1);
  for (const limits of [{ maxPendingBytes: 1 }, { maxBatchBytes: 1 }]) {
    const limited = new MetricsCollector({ exporter, limits }); limited.emit(event(20));
    assert.equal(limited.health().exportOverflow, 1); assert.equal(limited.health().pendingBytes, 0);
    assert.equal(await limited.flush(), 'empty');
  }
});

test('metrics exporter cancellation keeps one uncooperative operation owned until settlement; close clears buffers', async () => {
  let resolve!: () => void;
  let sinkSignal: AbortSignal | undefined;
  const collector = new MetricsCollector({ exporter: (_records, signal) => { sinkSignal = signal; return new Promise<void>(done => { resolve = done; }); } });
  collector.emit(event(20));
  const controller = new AbortController();
  const flushing = collector.flush(controller.signal);
  await Promise.resolve();
  assert.equal(await collector.flush(), 'busy');
  controller.abort(); assert.equal(await flushing, 'cancelled');
  assert.equal(sinkSignal?.aborted, true); assert.equal(collector.health().cancelledExport, 1);
  assert.equal(await collector.flush(), 'busy');
  resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(collector.health().exported, 0);
  collector.emit(event(21, { kind: 'retry', count: 1 })); collector.close(); collector.close();
  assert.equal(collector.health().discardedOnClose, 1); assert.equal(collector.health().retainedBytes, 0);
  assert.equal(collector.emit(event(22)), 'closed'); assert.equal(await collector.flush(), 'closed');
});

test('metrics timeout does not retry or count late completion as successful export', async () => {
  let reject!: (reason: Error) => void;
  let calls = 0;
  const collector = new MetricsCollector({ limits: { exportTimeoutMs: 5 }, exporter: () => { calls++; return new Promise<void>((_resolve, fail) => { reject = fail; }); } });
  collector.emit(event(20));
  assert.equal(await collector.flush(), 'timeout'); assert.equal(collector.health().timedOutExport, 1);
  assert.equal(await collector.flush(), 'busy'); assert.equal(calls, 1);
  reject(new Error('late secret')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(collector.health().exported, 0); assert.equal(collector.health().failedExport, 0);
});

test('metrics abort before flush leaves queue intact and close aborts an active sink', async () => {
  const collector = new MetricsCollector({ exporter: async (_records, signal) => {
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
  } });
  collector.emit(event(20));
  const controller = new AbortController(); controller.abort();
  assert.equal(await collector.flush(controller.signal), 'cancelled'); assert.equal(collector.health().pendingRecords, 1);
  const flushing = collector.flush(); await Promise.resolve(); collector.close();
  assert.equal(await flushing, 'cancelled'); assert.equal(collector.health().cancelledExport, 1);
});

test('metrics rejects regressing or invalid monotonic clock without invented durations', () => {
  let time = 10;
  const collector = new MetricsCollector({ clock: () => time });
  const stage = collector.startStage(MetricIds.event.parse(uuid(20)), correlation, 'queue'); assert.ok(stage);
  time = 5; assert.equal(stage.end(), 'invalid');
  time = NaN; assert.equal(collector.emit(event(21)), 'invalid');
  assert.equal(collector.readSummary(scope).clockAvailable, false);
  time = 11; assert.equal(collector.readSummary(scope).records.length, 0);
  assert.equal(collector.health().invalidClock, 3);
});
