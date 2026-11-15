import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from './metrics.js';
import { MetricCorrelation, MetricIds } from './metrics-schema.js';

const uuid = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const correlation = MetricCorrelation.parse({ identityId: uuid(1), projectId: uuid(2), taskId: uuid(3), runId: uuid(4), inputId: uuid(5), actionId: null, attemptId: null, workerId: null, deliveryId: null });
const scope = { identityId: correlation.identityId, projectId: correlation.projectId };
const observation = (n: number) => ({ eventId: MetricIds.event.parse(uuid(n)), correlation, observation: { kind: 'reducer' as const, records: 1 } });

test('metrics export accounts for JSON array separators and exact batch byte limit', async () => {
  const record = { ...observation(20), observedAtMs: 0 };
  const bytes = Buffer.byteLength(JSON.stringify([record]));
  let calls = 0;
  const collector = new MetricsCollector({ clock: () => 0, limits: { maxBatchBytes: bytes }, exporter: async batch => {
    calls++;
    assert.equal(batch.length, 1);
    assert.equal(Buffer.byteLength(JSON.stringify(batch)), bytes);
    // Sink-owned mutable copies cannot corrupt local scope or aggregates.
    batch[0]!.correlation.projectId = MetricIds.project.parse(uuid(99));
  } });
  collector.emit(observation(20)); collector.emit(observation(21));
  assert.equal(await collector.flush(), 'exported'); assert.equal(collector.health().pendingRecords, 1);
  assert.equal(await collector.flush(), 'exported'); assert.equal(calls, 2);
  assert.equal(collector.readSummary(scope).records.length, 2);
  assert.equal(collector.health().exported, 2);
});

test('metrics burst is count and byte bounded while sink fails; summaries remain partial', async () => {
  const collector = new MetricsCollector({ clock: () => 0,
    limits: { maxRecords: 100, maxBytes: 100_000, maxPendingRecords: 10, maxPendingBytes: 10_000, maxBatchRecords: 5 },
    exporter: async () => { throw new Error('failed sink'); },
  });
  for (let i = 20; i < 10_020; i++) collector.emit(observation(i));
  const before = collector.health();
  assert.equal(before.retainedRecords, 100); assert.ok(before.retainedBytes <= 100_000);
  assert.equal(before.pendingRecords, 10); assert.ok(before.pendingBytes <= 10_000);
  assert.equal(before.overflow, 9_900); assert.equal(before.exportOverflow, 90);
  assert.equal(await collector.flush(), 'failed'); assert.equal(await collector.flush(), 'failed');
  assert.equal(await collector.flush(), 'empty'); assert.equal(collector.health().failedExport, 10);
  assert.equal(collector.readSummary(scope).completeness, 'partial');
  assert.equal(collector.readSummary(scope).reducerRecords, 100);
});

test('metrics synchronous exporter throw is classified and frees its one operation slot', async () => {
  const collector = new MetricsCollector({ exporter: () => { throw new Error('private synchronous failure'); } });
  collector.emit(observation(20)); assert.equal(await collector.flush(), 'failed');
  assert.equal(collector.health().exportActive, false);
  collector.emit(observation(21)); assert.equal(await collector.flush(), 'failed');
  assert.equal(collector.health().failedExport, 2);
});
