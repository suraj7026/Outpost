import { z } from 'zod';

const identifier = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
export const CatalogueIdentity = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct-cloud'), accountId: identifier, baseUrl: z.literal('https://ollama.com') }),
  z.strictObject({ kind: z.literal('local-self-hosted'), accountId: identifier, baseUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && url.hostname.replace(/\.$/, '') !== 'ollama.com' && value === url.origin;
  }) }),
]);
export type CatalogueIdentity = z.infer<typeof CatalogueIdentity>;
export function catalogueKey(identity: CatalogueIdentity): string {
  const parsed = CatalogueIdentity.parse(identity);
  return JSON.stringify([parsed.kind, parsed.accountId, parsed.baseUrl]);
}

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const source = z.strictObject({ kind: z.enum(['advertised', 'generated', 'probe', 'qualified']), reference: identifier, observedAt: timestamp });
const limit = z.strictObject({ value: positive, source });
const thinkingChoice = z.strictObject({
  level: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  parameter: z.enum(['reasoning_effort', 'think']), value: z.union([identifier, z.boolean()]), source,
});
const thinkingChoices = z.array(thinkingChoice).max(6).refine(values => new Set(values.map(value => value.level)).size === values.length);
const qualification = z.strictObject({
  sdkVersion: identifier, reference: identifier, observedAt: timestamp, expiresAt: timestamp,
  chat: z.boolean(), toolStreaming: z.boolean(), usage: z.boolean(), cancellation: z.boolean(),
  malformedResponses: z.boolean(), overflow: z.boolean(),
}).refine(value => value.expiresAt > value.observedAt);
/** Trusted, exact-identity evidence supplied by the coordinator, never by provider JSON. */
export const CatalogueEvidence = z.strictObject({
  identity: CatalogueIdentity, modelId: identifier,
  contextWindow: limit.optional(), maxOutputTokens: limit.optional(),
  thinkingChoices: thinkingChoices.optional(),
  qualification: qualification.optional(),
});
export type CatalogueEvidence = z.infer<typeof CatalogueEvidence>;
export const CatalogueModel = z.strictObject({
  id: identifier, availability: z.enum(['available', 'removed', 'incompatible']),
  advertised: z.strictObject({ capabilities: z.array(identifier).max(64), observedAt: timestamp }),
  modalities: z.array(z.enum(['text', 'image'])).max(2),
  contextWindow: limit.nullable(), maxOutputTokens: limit.nullable(),
  // null means unknown, not "off" and not a default set of levels.
  thinkingChoices: thinkingChoices.nullable(),
  qualification: qualification.nullable(),
});
export type CatalogueModel = z.infer<typeof CatalogueModel>;
export const CatalogueSnapshot = z.strictObject({
  schemaVersion: z.literal(1), version: positive, identity: CatalogueIdentity, refreshedAt: timestamp,
  models: z.array(CatalogueModel).max(512).refine(values => new Set(values.map(value => value.id)).size === values.length),
});
export type CatalogueSnapshot = z.infer<typeof CatalogueSnapshot>;

/** Implement with awaited, atomic PostgreSQL operations; no network work inside a transaction.
 * beginRefresh increments the key's durable fence and reads its last-good snapshot atomically.
 * publish checks that fence, validates version = prior version + 1, and commits atomically.
 * Cancellation observed before COMMIT dispatch prevents publication. Once COMMIT is dispatched,
 * cancellation cannot prove rollback: commit/acknowledgement may be uncertain. Methods await
 * owned transaction settlement under finite database timeouts, not a detached signal race.
 * A completed commit is not undone by later cancellation; re-read authoritative state on uncertainty.
 */
export interface CatalogueRepository {
  load(key: string, signal: AbortSignal): Promise<unknown | null>;
  beginRefresh(key: string, signal: AbortSignal): Promise<{ generation: string; snapshot: unknown | null }>;
  publish(key: string, generation: string, snapshot: CatalogueSnapshot, signal: AbortSignal): Promise<boolean>;
}
export type CatalogueDiagnostic = {
  stage: 'list' | 'metadata' | 'repository' | 'refresh';
  code: 'transport' | 'http' | 'malformed' | 'oversized' | 'timeout' | 'cancelled' | 'superseded' | 'storage';
  modelId?: string;
};
export interface CatalogueResult {
  status: 'empty' | 'cached' | 'fresh' | 'incomplete' | 'failed' | 'cancelled' | 'superseded';
  snapshot: CatalogueSnapshot | null;
  diagnostics: CatalogueDiagnostic[];
}

/** Readiness is not inferred from an advertised tools/thinking flag. Authority/role ceilings
 * are separate runtime decisions and are deliberately not represented here. */
export function catalogueReadiness(model: CatalogueModel, sdkVersion: string, now = Date.now()): 'unavailable' | 'unqualified' | 'chat' | 'tools' {
  if (model.availability !== 'available') return 'unavailable';
  const q = model.qualification;
  if (!q || q.sdkVersion !== sdkVersion || q.observedAt > now || q.expiresAt <= now || !q.chat
    || !q.usage || !q.cancellation || !q.malformedResponses || !q.overflow) return 'unqualified';
  return q.toolStreaming && model.advertised.capabilities.includes('tools') ? 'tools' : 'chat';
}
export { identifier as catalogueModelId };
