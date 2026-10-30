import { z } from 'zod';
import { WebResearchError, webAbortable, webDigest, webRequire, webScopeKey } from './web-contracts.js';
import type { WebAction, WebArtifactPublisher, WebAuthorization, WebCacheStore, WebContent, WebEntry, WebFence, WebProvider, WebRequest, WebScope, WebSnapshot, WebStored } from './web-contracts.js';
import { canonicalWebUrl, resolveWebHost, validateWebTarget } from './web-url.js';
import type { WebResolver } from './web-url.js';

const Page = z.object({ offset: z.number().int().min(0).default(0), full: z.boolean().default(false), refresh: z.boolean().default(false), snapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const Search = Page.extend({ query: z.string().trim().min(1).max(2000), maxResults: z.number().int().min(1).max(10).default(5), expand: z.number().int().min(1).max(10).optional() }).strict();
const Fetch = Page.extend({ url: z.string().max(2048) }).strict();
const SearchData = z.object({ results: z.array(z.object({ title: z.string().max(1000), url: z.string().max(2048), content: z.string() })).max(10) });
const FetchData = z.object({ title: z.string().max(1000), content: z.string(), links: z.array(z.string().max(2048)).max(1000).nullable() });
export interface WebResearchLimits { successTtlMs: number; negativeTtlMs: number; maxContentBytes: number; pageChars: number; fullChars: number; snippetChars: number; maxLinks: number; maxConcurrent: number; operationTimeoutMs: number }
export const defaultWebResearchLimits: Readonly<WebResearchLimits> = Object.freeze({ successTtlMs: 86_400_000, negativeTtlMs: 900_000, maxContentBytes: 200_000, pageChars: 3000, fullChars: 12_000, snippetChars: 500, maxLinks: 10, maxConcurrent: 16, operationTimeoutMs: 30_000 });
interface Session { scope: Readonly<WebScope>; scopeKey: string; action: WebAction; signal: AbortSignal; revision: string }

/** Bounded server-owned research module. Not installed into Gate or Pi automatically. */
export class WebResearch {
  private flights = new Map<string, Promise<WebStored>>();
  private limits: WebResearchLimits;
  constructor(private deps: { store: WebCacheStore; authorizer: WebAuthorization; provider: WebProvider; artifacts: WebArtifactPublisher; resolver?: WebResolver; now?: () => number; limits?: Partial<WebResearchLimits> }) {
    this.limits = { ...defaultWebResearchLimits, ...deps.limits };
    for (const value of Object.values(this.limits)) webRequire(Number.isSafeInteger(value) && value > 0, 'invalid_research_limits');
    webRequire(this.limits.pageChars <= this.limits.fullChars && this.limits.operationTimeoutMs <= 2_147_483_647, 'invalid_research_limits');
  }
  private now() { return (this.deps.now ?? Date.now)(); }
  private async safe<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // One deadline covers admission, DNS, provider, storage and publication; stages do not reset it.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.limits.operationTimeoutMs);
    try { return await operation(AbortSignal.any([signal, deadline.signal])); } catch (error) {
      if (error instanceof WebResearchError) throw error;
      // Adapter exceptions, DNS errors, zod issues and HTTP bodies can contain secrets.
      throw new WebResearchError('research_operation_failed');
    } finally { clearTimeout(timer); }
  }
  private async wait<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    webRequire(!session.signal.aborted, 'cancelled');
    return webAbortable(operation(), session.signal);
  }
  private async begin(scope: WebScope, action: WebAction, signal: AbortSignal, stage: 'read' | 'manage' = 'read'): Promise<Session> {
    const frozen = Object.freeze({ ...scope }), scopeKey = webScopeKey(frozen);
    webRequire(!signal.aborted, 'cancelled');
    const grant = await webAbortable(this.deps.authorizer.check(frozen, Object.freeze(action), stage, signal), signal);
    webRequire(grant.revision.length > 0 && !signal.aborted && !grant.signal.aborted, 'authorization_revoked');
    return { scope: frozen, scopeKey, action, signal: AbortSignal.any([signal, grant.signal]), revision: grant.revision };
  }
  private async check(session: Session, stage: 'read' | 'request' | 'publish' | 'return' | 'manage'): Promise<void> {
    webRequire(!session.signal.aborted, 'cancelled');
    const grant = await this.wait(session, () => this.deps.authorizer.check(session.scope, session.action, stage, session.signal));
    webRequire(grant.revision === session.revision && !grant.signal.aborted && !session.signal.aborted, 'authorization_revoked');
    session.signal = AbortSignal.any([session.signal, grant.signal]);
  }
  private async current(session: Session, key: string, fence: WebFence, stage: 'publish' | 'return'): Promise<void> {
    await this.check(session, stage);
    webRequire(await this.wait(session, () => this.deps.store.current(session.scopeKey, key, fence)), 'stale_snapshot');
    webRequire(!session.signal.aborted, 'cancelled');
  }
  private key(request: WebRequest) { return webDigest(JSON.stringify(request)); }
  private async content(request: WebRequest, data: unknown): Promise<WebContent> {
    webRequire(Buffer.byteLength(JSON.stringify(data) ?? '') <= this.limits.maxContentBytes, 'response_too_large');
    const safeUrl = (url: string): string | null => { try { return canonicalWebUrl(url); } catch { return null; } };
    if (request.kind === 'search') {
      const parsed = SearchData.parse(data);
      webRequire(parsed.results.length <= request.maxResults, 'invalid_provider_response');
      return { kind: 'search', results: parsed.results.flatMap(result => {
        const url = safeUrl(result.url);
        return url ? [{ ...result, url }] : [];
      }) };
    }
    const parsed = FetchData.parse(data);
    return { kind: 'fetch', url: request.url, title: parsed.title, content: parsed.content,
      links: [...new Set((parsed.links ?? []).flatMap(link => { const url = safeUrl(link); return url ? [url] : []; }))] };
  }
  private async live(session: Session, request: WebRequest, key: string): Promise<WebStored> {
    const fence = await this.wait(session, () => this.deps.store.reserve(session.scopeKey, key));
    if (request.kind === 'fetch') await validateWebTarget(request.url, this.deps.resolver ?? resolveWebHost, session.signal);
    await this.check(session, 'request');
    const response = await this.wait(session, () => this.deps.provider.request(session.scope, request, session.signal));
    await this.check(session, 'publish');
    const retrievedAt = this.now();
    let entry: WebEntry;
    if (request.kind === 'fetch' && (response.status === 404 || response.status === 410)) {
      entry = { kind: 'negative', status: response.status, retrievedAt, expiresAt: retrievedAt + this.limits.negativeTtlMs };
    } else {
      webRequire(response.status >= 200 && response.status < 300, 'provider_request_failed');
      const content = await this.content(request, response.data), digest = webDigest(JSON.stringify(content));
      const expiresAt = retrievedAt + this.limits.successTtlMs;
      const snapshot: WebSnapshot = { snapshotId: webDigest(JSON.stringify([session.scopeKey, key, fence, retrievedAt, digest])), digest, retrievedAt, expiresAt, provenance: 'external_untrusted', content };
      entry = { kind: 'success', snapshot, expiresAt };
    }
    await this.check(session, 'publish');
    webRequire(await this.wait(session, () => this.deps.store.commit(session.scopeKey, key, fence, entry, this.now())), 'stale_snapshot');
    await this.current(session, key, fence, 'return');
    return { entry, fence };
  }
  private async obtain(session: Session, request: WebRequest, refresh: boolean, cacheOnly: boolean, expectedId?: string) {
    const key = this.key(request);
    await this.check(session, 'read');
    const stored = refresh ? null : await this.wait(session, () => this.deps.store.read(session.scopeKey, key, this.now()));
    let value = stored, cached = !!stored;
    if (!value) {
      webRequire(!cacheOnly, 'snapshot_unavailable');
      const flightKey = JSON.stringify([session.scopeKey, key, session.revision]);
      let flight = this.flights.get(flightKey);
      if (!flight) {
        webRequire(this.flights.size < this.limits.maxConcurrent, 'request_quota');
        flight = this.live(session, request, key);
        this.flights.set(flightKey, flight);
        const clear = () => { if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey); };
        void flight.then(clear, clear);
      }
      value = await webAbortable(flight, session.signal);
      cached = false;
    }
    await this.current(session, key, value.fence, 'return');
    webRequire(value.entry.expiresAt > this.now(), 'snapshot_unavailable');
    if (value.entry.kind === 'negative') throw new WebResearchError(cached ? 'cached_not_found' : 'source_not_found');
    const snapshot = value.entry.snapshot;
    webRequire(!expectedId || expectedId === snapshot.snapshotId, 'stale_snapshot');
    await this.current(session, key, value.fence, 'publish');
    const fence = value.fence;
    const artifactId = await this.wait(session, () => this.deps.artifacts.publish({ scope: session.scope, key, fence, snapshot: structuredClone(snapshot), signal: session.signal,
      assertCurrent: () => this.current(session, key, fence, 'publish') }));
    webRequire(typeof artifactId === 'string' && artifactId.length > 0 && artifactId.length <= 256, 'invalid_artifact');
    await this.current(session, key, value.fence, 'return');
    return { snapshot, cached, artifactId, egress: 'ollama-cloud' as const };
  }
  private page(content: string, offset: number, full: boolean) {
    webRequire(offset <= content.length, 'invalid_offset');
    const end = Math.min(content.length, offset + (full ? this.limits.fullChars : this.limits.pageChars));
    return { text: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalChars: content.length };
  }
  private metadata(result: { snapshot: WebSnapshot; cached: boolean; artifactId: string; egress: 'ollama-cloud' }) {
    const { content: _content, ...metadata } = result.snapshot;
    return { ...metadata, cached: result.cached, artifactId: result.artifactId, egress: result.egress };
  }
  async search(scope: WebScope, input: unknown, signal = new AbortController().signal) {
    return this.safe(signal, async signal => {
      const args = Search.parse(input);
      webRequire(!(args.refresh && (args.expand !== undefined || args.snapshotId || args.offset > 0)), 'invalid_refresh');
      webRequire(args.expand !== undefined || (args.offset === 0 && !args.full), 'invalid_expansion');
      webRequire(args.expand === undefined || !!args.snapshotId, 'snapshot_required');
      const request: WebRequest = { kind: 'search', query: args.query, maxResults: args.maxResults };
      const session = await this.begin(scope, request, signal);
      const result = await this.obtain(session, request, args.refresh, args.expand !== undefined || !!args.snapshotId, args.snapshotId);
      webRequire(result.snapshot.content.kind === 'search', 'invalid_cache_entry');
      const results = result.snapshot.content.results;
      if (args.expand !== undefined) {
        const item = results[args.expand - 1]; webRequire(item, 'invalid_expansion');
        return { ...this.metadata(result), resultIndex: args.expand, title: item.title, url: item.url, ...this.page(item.content, args.offset, args.full) };
      }
      return { ...this.metadata(result), results: results.map((item, index) => ({ index: index + 1, title: item.title, url: item.url, snippet: item.content.slice(0, this.limits.snippetChars), totalChars: item.content.length })) };
    });
  }
  async fetch(scope: WebScope, input: unknown, signal = new AbortController().signal) {
    return this.safe(signal, async signal => {
      const args = Fetch.parse(input), url = canonicalWebUrl(args.url);
      webRequire(!(args.refresh && (args.snapshotId || args.offset > 0)), 'invalid_refresh');
      webRequire(args.offset === 0 || !!args.snapshotId, 'snapshot_required');
      const request: WebRequest = { kind: 'fetch', url }, session = await this.begin(scope, request, signal);
      const result = await this.obtain(session, request, args.refresh, !!args.snapshotId, args.snapshotId);
      webRequire(result.snapshot.content.kind === 'fetch', 'invalid_cache_entry');
      const item = result.snapshot.content;
      return { ...this.metadata(result), title: item.title, url: item.url, links: args.offset === 0 ? item.links.slice(0, this.limits.maxLinks) : [], totalLinks: item.links.length, ...this.page(item.content, args.offset, args.full) };
    });
  }
  async inspect(scope: WebScope, signal = new AbortController().signal) {
    return this.safe(signal, async signal => {
      const session = await this.begin(scope, { kind: 'inspect' }, signal, 'manage');
      const result = await this.wait(session, () => this.deps.store.inspect(session.scopeKey, this.now()));
      await this.check(session, 'manage'); return result;
    });
  }
  async deleteScope(scope: WebScope, signal = new AbortController().signal) {
    return this.safe(signal, async signal => {
      const session = await this.begin(scope, { kind: 'delete' }, signal, 'manage');
      await this.check(session, 'manage');
      const { throughEpoch } = await this.wait(session, () => this.deps.store.deleteScope(session.scopeKey));
      await this.wait(session, () => this.deps.artifacts.deleteScope(session.scope, throughEpoch));
      await this.check(session, 'manage');
    });
  }
}
