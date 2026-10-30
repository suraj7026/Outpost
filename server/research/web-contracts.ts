import { createHash } from 'node:crypto';

export const webDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export class WebResearchError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WebResearchError'; }
}
export function webRequire(value: unknown, code: string): asserts value {
  if (!value) throw new WebResearchError(code);
}
export interface WebScope { identityId: string; accountId: string; taskId: string; scopeId: string }
export function webScopeKey(scope: WebScope): string {
  for (const value of [scope.identityId, scope.accountId, scope.taskId, scope.scopeId]) {
    webRequire(typeof value === 'string' && value.length > 0 && value.length <= 256, 'invalid_scope');
  }
  return webDigest(JSON.stringify([scope.identityId, scope.accountId, scope.taskId, scope.scopeId]));
}
export type WebRequest = { kind: 'search'; query: string; maxResults: number } | { kind: 'fetch'; url: string };
export type WebAction = WebRequest | { kind: 'inspect' | 'delete' };
export interface WebAuthorization {
  /** Must enter the existing concrete-action gate, not implement a second policy engine.
   * Check identity/account/task grants, current egress policy, sensitive-content rules,
   * per-task disable and owner kill switch at EVERY stage. Revision changes fence work.
   * signal must abort on revocation/disable, even while an HTTP request is pending.
   * Ollama Cloud egress is independent of the inference route (including local inference).
   */
  check(scope: Readonly<WebScope>, action: Readonly<WebAction>, stage: 'read' | 'request' | 'publish' | 'return' | 'manage', signal: AbortSignal): Promise<{ revision: string; signal: AbortSignal }>;
}
export interface WebSearchResult { title: string; url: string; content: string }
export type WebContent = { kind: 'search'; results: WebSearchResult[] } | { kind: 'fetch'; url: string; title: string; content: string; links: string[] };
export interface WebSnapshot {
  snapshotId: string; digest: string; retrievedAt: number; expiresAt: number;
  provenance: 'external_untrusted'; content: WebContent;
}
export type WebEntry = { kind: 'success'; snapshot: WebSnapshot; expiresAt: number } | { kind: 'negative'; status: 404 | 410; retrievedAt: number; expiresAt: number };
export interface WebFence { epoch: number; generation: string }
export interface WebStored { entry: WebEntry; fence: WebFence }
export interface WebCacheLimits { maxEntries: number; maxBytes: number; maxEntryBytes: number }
/** All methods are atomic across owners. reserve invalidates the old entry and supersedes older writers for this key;
 * deleteScope advances the epoch and fences ALL pending writers/publications in that scope.
 * A reservation after deletion must have epoch > the returned throughEpoch; artifact cleanup
 * uses this cutoff so concurrent NEW publications are not accidentally removed.
 * commit enforces GLOBAL count/byte quotas atomically; rejection must not store the entry.
 * sweep/delete remove content, not just its index. No network calls in DB transactions.
 * Callers may stop waiting on cancellation/deadline; an admitted write can still commit.
 * Durable adapters own atomic fencing and cleanup/reconciliation, not the caller's wait.
 */
export interface WebCacheStore {
  read(scope: string, key: string, now: number): Promise<WebStored | null>;
  reserve(scope: string, key: string): Promise<WebFence>;
  current(scope: string, key: string, fence: WebFence): Promise<boolean>;
  commit(scope: string, key: string, fence: WebFence, entry: WebEntry, now: number): Promise<boolean>;
  inspect(scope: string, now: number): Promise<{ entries: number; bytes: number }>;
  deleteScope(scope: string): Promise<{ throughEpoch: number }>;
  sweep(now: number): Promise<void>;
}
/** Publication must be idempotent by scoped snapshotId, verified by digest, and bind the
 * artifact to taskId with external_untrusted provenance. The durable adapter MUST atomically
 * fence publication against cache scope deletion and implement retention/deletion propagation.
 * assertCurrent is an additional immediate policy check, NOT a substitute for atomic fencing.
 * Observe signal at the effect boundary. Cancellation of the service wait does not roll back
 * a committed publication or prove a lost acknowledgement never committed; reconcile durably.
 */
export interface WebArtifactPublisher {
  publish(input: { scope: Readonly<WebScope>; key: string; fence: WebFence; snapshot: WebSnapshot; signal: AbortSignal; assertCurrent: () => Promise<void> }): Promise<string>;
  deleteScope(scope: Readonly<WebScope>, throughEpoch: number): Promise<void>;
}
export interface WebProvider { request(scope: Readonly<WebScope>, request: WebRequest, signal: AbortSignal): Promise<{ status: number; data: unknown }> }

/** Stop waiting even if an injected dependency is slow to acknowledge cancellation. */
export async function webAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new WebResearchError('cancelled'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
