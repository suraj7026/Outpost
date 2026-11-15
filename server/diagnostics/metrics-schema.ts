import { z } from 'zod';

// Only opaque UUIDs cross this boundary. Do not substitute model names, URLs or user text.
const uuid = z.string().uuid();
export const MetricIds = {
  identity: uuid.brand<'MetricIdentityId'>(), project: uuid.brand<'MetricProjectId'>(),
  task: uuid.brand<'MetricTaskId'>(), run: uuid.brand<'MetricRunId'>(),
  input: uuid.brand<'MetricInputId'>(), action: uuid.brand<'MetricActionId'>(),
  attempt: uuid.brand<'MetricAttemptId'>(), worker: uuid.brand<'MetricWorkerId'>(),
  delivery: uuid.brand<'MetricDeliveryId'>(), event: uuid.brand<'MetricEventId'>(),
};
export const MetricScope = z.strictObject({ identityId: MetricIds.identity, projectId: MetricIds.project });
export type MetricScope = z.infer<typeof MetricScope>;
export const MetricCorrelation = MetricScope.extend({
  taskId: MetricIds.task, runId: MetricIds.run, inputId: MetricIds.input,
  actionId: MetricIds.action.nullable(), attemptId: MetricIds.attempt.nullable(),
  workerId: MetricIds.worker.nullable(), deliveryId: MetricIds.delivery.nullable(),
});
export type MetricCorrelation = z.infer<typeof MetricCorrelation>;
const count = z.number().int().min(0).max(1_000_000_000);
const quantity = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('unknown') }),
  z.strictObject({ source: z.literal('measured'), value: count }),
  z.strictObject({ source: z.literal('estimated'), value: count }),
]);
export const MetricStage = z.enum(['queue', 'first_token', 'execution', 'reducer', 'compaction', 'retry']);
export type MetricStage = z.infer<typeof MetricStage>;
export const MetricObservation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('duration'), stage: MetricStage, milliseconds: z.number().min(0).max(86_400_000) }),
  z.strictObject({ kind: z.literal('usage'), basis: z.literal('attempt'),
    inputTokens: quantity, outputTokens: quantity, cacheReadTokens: quantity, cacheWriteTokens: quantity,
    // Comparable estimate, never billed spend or subscription balance.
    comparableUsd: z.discriminatedUnion('source', [
      z.strictObject({ source: z.literal('unknown') }),
      z.strictObject({ source: z.literal('estimated'), value: z.number().min(0).max(1_000_000) }),
    ]),
  }),
  z.strictObject({ kind: z.literal('context'), usedTokens: quantity, capacityTokens: count }),
  z.strictObject({ kind: z.literal('retry'), count }),
  z.strictObject({ kind: z.literal('transfer'), channel: z.enum(['artifact', 'snapshot', 'replay']), bytes: count }),
  z.strictObject({ kind: z.literal('reducer'), records: count }),
  z.strictObject({ kind: z.literal('outcome'), state: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']) }),
]);
export type MetricObservation = z.infer<typeof MetricObservation>;
export const MetricEvent = z.strictObject({ eventId: MetricIds.event, correlation: MetricCorrelation, observation: MetricObservation })
  .refine(event => event.observation.kind !== 'usage' || event.correlation.attemptId !== null);
export type MetricEvent = z.infer<typeof MetricEvent>;
export type MetricRecord = MetricEvent & { observedAtMs: number };
export type MetricReadFilter = { runId?: z.infer<typeof MetricIds.run>; taskId?: z.infer<typeof MetricIds.task> };
export const MetricReadFilter = z.strictObject({ runId: MetricIds.run.optional(), taskId: MetricIds.task.optional() });
