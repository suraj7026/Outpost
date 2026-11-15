import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  MetricCorrelation, MetricEvent, MetricIds, MetricReadFilter, MetricScope, MetricStage,
  type MetricObservation, type MetricRecord,
} from './metrics-schema.js';

const Limits = z.strictObject({
  retentionMs: z.number().int().min(1).max(86_400_000).default(3_600_000),
  maxRecords: z.number().int().min(1).max(10_000).default(2_000),
  maxBytes: z.number().int().min(1).max(16_777_216).default(2_097_152),
  maxPendingRecords: z.number().int().min(1).max(10_000).default(500),
  maxPendingBytes: z.number().int().min(1).max(16_777_216).default(524_288),
  maxBatchRecords: z.number().int().min(1).max(1_000).default(100),
  maxBatchBytes: z.number().int().min(1).max(1_048_576).default(131_072),
  exportTimeoutMs: z.number().int().min(1).max(60_000).default(5_000),
});
export type MetricsLimits = z.input<typeof Limits>;
export type MetricsExporter = (records: readonly MetricRecord[], signal: AbortSignal) => Promise<void>;
export type EmissionResult = 'accepted' | 'invalid' | 'duplicate' | 'conflict' | 'overflow' | 'closed';
export type ExportResult = 'exported' | 'failed' | 'cancelled' | 'timeout' | 'busy' | 'empty' | 'disabled' | 'closed';
type Entry = { record: MetricRecord; bytes: number; attemptKey: string | null };
type QuantityTotal = { measured: number | null; estimated: number | null; unknownObservations: number };
const total = (): QuantityTotal => ({ measured: null, estimated: null, unknownObservations: 0 });
function add(target: QuantityTotal, quantity: { source: 'unknown' } | { source: 'measured' | 'estimated'; value: number }) {
  if (quantity.source === 'unknown') target.unknownObservations++;
  else target[quantity.source] = (target[quantity.source] ?? 0) + quantity.value;
}

/** Ephemeral diagnostics only: never a billing, admission, completion or durable accounting authority. */
export class MetricsCollector {
  private readonly limits;
  private readonly records = new Map<string, Entry>();
  private readonly attempts = new Map<string, string>();
  private readonly pending = new Map<string, Entry>();
  private bytes = 0;
  private pendingBytes = 0;
  private lastNow = 0;
  private closed = false;
  private active: { controller: AbortController } | null = null;
  private readonly counters = {
    accepted: 0, invalid: 0, duplicate: 0, conflict: 0, overflow: 0, expired: 0,
    exportOverflow: 0, exportExpired: 0, exported: 0, failedExport: 0,
    cancelledExport: 0, timedOutExport: 0, discardedOnClose: 0, invalidClock: 0,
  };
  constructor(options: { limits?: MetricsLimits; clock?: () => number; exporter?: MetricsExporter } = {}) {
    this.limits = Limits.parse(options.limits ?? {});
    this.clock = options.clock ?? (() => performance.now());
    this.exporter = options.exporter;
  }
  private readonly clock: () => number;
  private readonly exporter: MetricsExporter | undefined;
  private increment(key: keyof MetricsCollector['counters'], count = 1) {
    this.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[key] + count);
  }
  private now(): number | null {
    const time = this.clock();
    if (!Number.isFinite(time) || time < this.lastNow || time < 0) { this.increment('invalidClock'); return null; }
    this.lastNow = time;
    return time;
  }
  private expire(now: number) {
    for (const [key, entry] of this.records) {
      if (now - entry.record.observedAtMs < this.limits.retentionMs) break;
      this.records.delete(key); this.bytes -= entry.bytes;
      if (entry.attemptKey) this.attempts.delete(entry.attemptKey);
      if (this.pending.delete(key)) { this.pendingBytes -= entry.bytes; this.increment('exportExpired'); }
      this.increment('expired');
    }
  }
  /** Synchronous bounded insertion. No exporter, I/O, timer or promise runs on this path. */
  emit(event: Omit<MetricEvent, 'observation'> & { observation: Exclude<MetricObservation, { kind: 'duration' }> }): EmissionResult {
    return this.insert(event);
  }
  private insert(input: unknown, allowDuration = false): EmissionResult {
    if (this.closed) return 'closed';
    const parsed = MetricEvent.safeParse(input);
    if (!parsed.success || (!allowDuration && parsed.data.observation.kind === 'duration')) { this.increment('invalid'); return 'invalid'; }
    const now = this.now();
    if (now === null) return 'invalid';
    this.expire(now);
    const event = parsed.data, scope = `${event.correlation.identityId}:${event.correlation.projectId}`;
    const key = `${scope}:${event.eventId}`;
    const attemptKey = event.observation.kind === 'usage' ? `${scope}:${event.correlation.attemptId}` : null;
    const previous = this.records.get(key) ?? (attemptKey ? this.records.get(this.attempts.get(attemptKey) ?? '') : undefined);
    if (previous) {
      const equal = JSON.stringify(previous.record.correlation) === JSON.stringify(event.correlation)
        && JSON.stringify(previous.record.observation) === JSON.stringify(event.observation);
      const result = equal ? 'duplicate' : 'conflict'; this.increment(result); return result;
    }
    const record = { ...event, observedAtMs: now };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (this.records.size >= this.limits.maxRecords || this.bytes + bytes > this.limits.maxBytes) {
      this.increment('overflow'); return 'overflow';
    }
    const entry = { record, bytes, attemptKey };
    this.records.set(key, entry); this.bytes += bytes;
    if (attemptKey) this.attempts.set(attemptKey, key);
    this.increment('accepted');
    if (this.exporter) {
      if (this.pending.size >= this.limits.maxPendingRecords || this.pendingBytes + bytes > this.limits.maxPendingBytes || bytes + 2 > this.limits.maxBatchBytes) this.increment('exportOverflow');
      else { this.pending.set(key, entry); this.pendingBytes += bytes; }
    }
    return 'accepted';
  }
  /** Caller owns the small handle; collector stores no open-span map. End at most once. */
  startStage(eventId: z.infer<typeof MetricIds.event>, correlation: MetricCorrelation, stage: MetricStage) {
    const parsed = z.strictObject({ eventId: MetricIds.event, correlation: MetricCorrelation, stage: MetricStage }).safeParse({ eventId, correlation, stage });
    const start = this.now();
    if (this.closed || !parsed.success || start === null) { this.increment('invalid'); return null; }
    let ended = false;
    return { end: (): EmissionResult => {
      if (ended) { this.increment('duplicate'); return 'duplicate'; }
      ended = true;
      const end = this.now();
      if (end === null) return 'invalid';
      return this.insert({ eventId: parsed.data.eventId, correlation: parsed.data.correlation,
        observation: { kind: 'duration', stage: parsed.data.stage, milliseconds: end - start } }, true);
    } };
  }
  /** Server-only read API. Scope MUST come from current authenticated grants, not request labels. */
  readSummary(scopeInput: MetricScope, filterInput: MetricReadFilter = {}) {
    const scope = MetricScope.parse(scopeInput), filter = MetricReadFilter.parse(filterInput);
    const now = this.now();
    if (now !== null) this.expire(now);
    const records = [...this.records.values()].map(entry => entry.record).filter(record =>
      record.correlation.identityId === scope.identityId && record.correlation.projectId === scope.projectId
      && (!filter.runId || record.correlation.runId === filter.runId) && (!filter.taskId || record.correlation.taskId === filter.taskId));
    const usage = { attempts: 0, inputTokens: total(), outputTokens: total(), cacheReadTokens: total(), cacheWriteTokens: total(), comparableUsd: total() };
    const durations: Partial<Record<MetricStage, { samples: number; milliseconds: number }>> = {};
    const transferBytes: Partial<Record<'artifact' | 'snapshot' | 'replay', number>> = {};
    let retries: number | null = null, reducerRecords: number | null = null;
    for (const { observation } of records) {
      if (observation.kind === 'usage') {
        usage.attempts++;
        for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'comparableUsd'] as const) add(usage[field], observation[field]);
      } else if (observation.kind === 'duration') {
        const stage = durations[observation.stage] ?? { samples: 0, milliseconds: 0 };
        stage.samples++; stage.milliseconds += observation.milliseconds; durations[observation.stage] = stage;
      } else if (observation.kind === 'transfer') transferBytes[observation.channel] = (transferBytes[observation.channel] ?? 0) + observation.bytes;
      else if (observation.kind === 'retry') retries = (retries ?? 0) + observation.count;
      else if (observation.kind === 'reducer') reducerRecords = (reducerRecords ?? 0) + observation.records;
    }
    // No global counters here: those reveal activity in other identities/projects.
    return structuredClone({
      scope, filter, history: 'unavailable' as const, completeness: 'partial' as const,
      accountingAuthority: false as const, window: 'retained-process-observations' as const,
      retentionMs: this.limits.retentionMs, clockAvailable: now !== null, closed: this.closed,
      usage, durations, transferBytes, retries, reducerRecords, records,
    });
  }
  /** Operator-only health, not the identity/project read API. Counters saturate at MAX_SAFE_INTEGER. */
  health() {
    const now = this.now(); if (now !== null) this.expire(now);
    return { ...this.counters, retainedRecords: this.records.size, retainedBytes: this.bytes,
      pendingRecords: this.pending.size, pendingBytes: this.pendingBytes, exportActive: this.active !== null };
  }
  /** Explicitly awaited, one batch per call, no background retries. A non-cooperative sink holds the
   * single slot even after timeout/cancel; this bounds unresolved operations to one per collector. */
  async flush(signal?: AbortSignal): Promise<ExportResult> {
    if (this.closed) return 'closed';
    if (!this.exporter) return 'disabled';
    if (this.active) return 'busy';
    if (signal?.aborted) return 'cancelled';
    const now = this.now(); if (now === null) return 'failed'; this.expire(now);
    const batch: MetricRecord[] = []; let bytes = 2;
    for (const [key, entry] of this.pending) {
      const nextBytes = bytes + entry.bytes + (batch.length ? 1 : 0);
      if (batch.length >= this.limits.maxBatchRecords || nextBytes > this.limits.maxBatchBytes) break;
      batch.push(structuredClone(entry.record)); bytes = nextBytes;
      this.pending.delete(key); this.pendingBytes -= entry.bytes;
    }
    if (!batch.length) return 'empty';
    const controller = new AbortController();
    this.active = { controller };
    let result: ExportResult | null = null;
    let finish!: (value: ExportResult) => void;
    const completion = new Promise<ExportResult>(resolve => { finish = resolve; });
    const settle = (value: 'exported' | 'failed' | 'cancelled' | 'timeout') => {
      if (result !== null) return;
      result = value;
      this.increment(value === 'exported' ? 'exported' : value === 'failed' ? 'failedExport' : value === 'cancelled' ? 'cancelledExport' : 'timedOutExport', batch.length);
      finish(value);
    };
    const abort = () => settle(controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled');
    controller.signal.addEventListener('abort', abort, { once: true });
    const cancel = () => controller.abort('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), this.limits.exportTimeoutMs);
    // Promise reactions own all settlement, including synchronous throws; no detached rejection.
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return this.exporter!(batch, controller.signal);
    });
    void operation.then(() => { settle('exported'); this.active = null; }, () => { settle('failed'); this.active = null; });
    try { return await completion; }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', abort);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.active?.controller.abort('cancelled');
    this.increment('discardedOnClose', this.pending.size);
    this.pending.clear(); this.pendingBytes = 0;
    this.records.clear(); this.attempts.clear(); this.bytes = 0;
  }
}
