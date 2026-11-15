import { z } from 'zod';
import {
  CatalogueEvidence, CatalogueIdentity, CatalogueSnapshot, catalogueKey, catalogueModelId,
  type CatalogueDiagnostic, type CatalogueModel, type CatalogueRepository, type CatalogueResult,
} from './catalogue-types.js';

const policySchema = z.strictObject({
  requestTimeoutMs: z.number().int().min(1).max(30_000).default(5_000),
  refreshTimeoutMs: z.number().int().min(1).max(120_000).default(20_000),
  maxResponseBytes: z.number().int().min(1).max(4_194_304).default(1_048_576),
  maxModels: z.number().int().min(1).max(256).default(256),
  concurrency: z.number().int().min(1).max(8).default(4),
  freshnessMs: z.number().int().min(0).max(86_400_000).default(14_400_000),
});
const listSchema = z.object({ data: z.array(z.object({ id: catalogueModelId })).max(256) });
const showSchema = z.object({
  capabilities: z.array(catalogueModelId).max(64),
  model_info: z.record(z.string(), z.unknown()).nullable().optional(),
});
type Code = CatalogueDiagnostic['code'];
class CatalogueFailure extends Error {
  constructor(readonly code: Code) { super(code); }
}
function abortCode(signal: AbortSignal): Code {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled';
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new CatalogueFailure(abortCode(signal));
}
/** Even a faulty injected transport must not hold refresh open after cancellation. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CatalogueFailure(abortCode(signal)));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function codeOf(error: unknown, fallback: Code): Code {
  return error instanceof CatalogueFailure ? error.code : fallback;
}

export interface CatalogueServiceOptions {
  identity: CatalogueIdentity;
  repository: CatalogueRepository;
  /** Server-owned credential only. Never persisted, logged, or sourced from developer files. */
  credential?: string;
  transport?: typeof fetch;
  evidence?: CatalogueEvidence[];
  policy?: z.input<typeof policySchema>;
  now?: () => number;
}
export interface CatalogueRefreshOptions { force?: boolean; signal?: AbortSignal }

/** A service has one immutable provider/account identity. Account changes create a new service
 * and cancel the old one; callers must not display an old identity's results in the new picker. */
export class CatalogueService {
  private readonly identity: CatalogueIdentity;
  private readonly key: string;
  private readonly repository: CatalogueRepository;
  private readonly transport: typeof fetch;
  private readonly credential: string | undefined;
  private readonly policy: z.output<typeof policySchema>;
  private readonly evidence: Map<string, CatalogueEvidence>;
  private readonly now: () => number;
  private current: AbortController | undefined;
  private epoch = 0;
  private lastGood: CatalogueSnapshot | null = null;
  private reserveTail: Promise<unknown> = Promise.resolve();

  constructor(options: CatalogueServiceOptions) {
    this.identity = CatalogueIdentity.parse(options.identity);
    this.key = catalogueKey(this.identity);
    this.repository = options.repository;
    this.transport = options.transport ?? fetch;
    this.credential = options.credential;
    this.policy = policySchema.parse(options.policy ?? {});
    this.now = options.now ?? Date.now;
    const evidence = z.array(CatalogueEvidence).max(256).parse(options.evidence ?? []);
    if (evidence.some(value => catalogueKey(value.identity) !== this.key)
      || new Set(evidence.map(value => value.modelId)).size !== evidence.length) throw new Error('catalogue_evidence_identity');
    this.evidence = new Map(evidence.map(value => [value.modelId, value]));
  }

  private snapshot(value: unknown): CatalogueSnapshot | null {
    if (value === null) return null;
    const parsed = CatalogueSnapshot.parse(value);
    if (catalogueKey(parsed.identity) !== this.key) throw new Error('catalogue_snapshot_identity');
    return parsed;
  }

  /** Offline-only restore. No automatic discovery, credentials lookup, or active route mutation. */
  async read(signal?: AbortSignal): Promise<CatalogueResult> {
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(this.policy.refreshTimeoutMs), ...(signal ? [signal] : [])]);
    try {
      check(boundedSignal);
      const snapshot = this.snapshot(await bounded(this.repository.load(this.key, boundedSignal), boundedSignal));
      this.remember(snapshot);
      return { status: snapshot ? 'cached' : 'empty', snapshot, diagnostics: [] };
    } catch (error) {
      const code = codeOf(error, 'storage');
      return { status: code === 'cancelled' ? 'cancelled' : 'failed', snapshot: structuredClone(this.lastGood), diagnostics: [{ stage: 'repository', code }] };
    }
  }

  private remember(snapshot: CatalogueSnapshot | null): void {
    if (snapshot && (!this.lastGood || snapshot.version > this.lastGood.version)) this.lastGood = structuredClone(snapshot);
  }

  cancel(): void { this.current?.abort(); }

  async refresh(options: CatalogueRefreshOptions = {}): Promise<CatalogueResult> {
    const epoch = ++this.epoch;
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.policy.refreshTimeoutMs), ...(options.signal ? [options.signal] : [])]);
    let snapshot: CatalogueSnapshot | null = structuredClone(this.lastGood);
    let stage: CatalogueDiagnostic['stage'] = 'repository';
    try {
      check(signal);
      // Serialize fence reservations, not network work, so a delayed older reservation cannot
      // invalidate a newer refresh in this service. The repository fences other instances too.
      const reservation = this.reserveTail.then(async () => {
        check(signal);
        return this.repository.beginRefresh(this.key, signal);
      });
      this.reserveTail = reservation.catch(() => {});
      const reserved = await bounded(reservation, signal);
      snapshot = this.snapshot(reserved.snapshot);
      check(signal);
      this.remember(snapshot);
      if (!options.force && snapshot && this.now() >= snapshot.refreshedAt
        && this.now() - snapshot.refreshedAt < this.policy.freshnessMs) {
        return { status: 'cached', snapshot, diagnostics: [] };
      }
      stage = 'list';
      const listed = listSchema.safeParse(await this.json('/v1/models', signal));
      if (!listed.success) {
        const tooMany = listed.error.issues.some(issue => issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'data');
        throw new CatalogueFailure(tooMany ? 'oversized' : 'malformed');
      }
      const ids = listed.data.data.map(value => value.id);
      if (ids.length > this.policy.maxModels) throw new CatalogueFailure('oversized');
      if (new Set(ids).size !== ids.length) throw new CatalogueFailure('malformed');
      const models: CatalogueModel[] = [];
      const diagnostics: CatalogueDiagnostic[] = [];
      let cursor = 0;
      stage = 'metadata';
      await Promise.all(Array.from({ length: Math.min(ids.length, this.policy.concurrency) }, async () => {
        while (cursor < ids.length) {
          check(signal);
          const id = ids[cursor++];
          if (id === undefined) break;
          try {
            const response = await this.json('/api/show', signal, id);
            models.push(this.model(id, response));
          } catch (error) {
            check(signal);
            diagnostics.push({ stage: 'metadata', modelId: id, code: codeOf(error, 'malformed') });
          }
        }
      }));
      check(signal);
      if (epoch !== this.epoch) throw new CatalogueFailure('superseded');
      // Never replace a healthy snapshot with partial metadata, including an all-failed pass.
      if (diagnostics.length) return { status: 'incomplete', snapshot, diagnostics };
      const present = new Set(ids);
      // Retain removal tombstones for one complete generation; do not grow history unboundedly.
      for (const old of snapshot?.models ?? []) {
        if (!present.has(old.id) && old.availability !== 'removed') models.push({ ...old, availability: 'removed' });
      }
      const next = CatalogueSnapshot.parse({ schemaVersion: 1, version: (snapshot?.version ?? 0) + 1,
        identity: this.identity, refreshedAt: this.now(), models: models.sort((a, b) => a.id.localeCompare(b.id)) });
      stage = 'repository';
      check(signal);
      const published = await bounded(this.repository.publish(this.key, reserved.generation, next, signal), signal);
      check(signal);
      if (!published || epoch !== this.epoch) return { status: 'superseded', snapshot, diagnostics: [{ stage: 'refresh', code: 'superseded' }] };
      this.remember(next);
      return { status: 'fresh', snapshot: next, diagnostics: [] };
    } catch (error) {
      const code = epoch !== this.epoch ? 'superseded' : codeOf(error, stage === 'repository' ? 'storage' : 'transport');
      return { status: code === 'superseded' ? 'superseded' : code === 'cancelled' ? 'cancelled' : 'failed', snapshot,
        diagnostics: [{ stage, code }] };
    } finally {
      if (epoch === this.epoch) this.current = undefined;
    }
  }

  private model(id: string, raw: unknown): CatalogueModel {
    const parsed = showSchema.safeParse(raw);
    if (!parsed.success) throw new CatalogueFailure('malformed');
    const { capabilities, model_info } = parsed.data;
    const observedAt = this.now();
    const evidence = this.evidence.get(id);
    const contextValues = Object.entries(model_info ?? {}).filter(([key]) => key.endsWith('.context_length'));
    const validContexts = contextValues.map(([, value]) => value).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
    if (validContexts.length !== contextValues.length) throw new CatalogueFailure('malformed');
    // Conflicting architecture context lengths remain unknown rather than guessing the largest.
    const advertisedContext = new Set(validContexts).size === 1 ? validContexts[0] : undefined;
    const family = id.split(':')[0];
    const chat = capabilities.includes('completion') && family !== 'clef' && family !== 'clef-flash';
    return {
      id, availability: chat ? 'available' : 'incompatible',
      advertised: { capabilities, observedAt }, modalities: chat ? (capabilities.includes('vision') ? ['text', 'image'] : ['text']) : [],
      contextWindow: evidence?.contextWindow ?? (advertisedContext === undefined ? null : {
        value: advertisedContext, source: { kind: 'advertised', reference: '/api/show:model_info.context_length', observedAt },
      }),
      maxOutputTokens: evidence?.maxOutputTokens ?? null,
      thinkingChoices: evidence?.thinkingChoices ?? null,
      qualification: evidence?.qualification ?? null,
    };
  }

  private async json(path: string, parent: AbortSignal, id?: string): Promise<unknown> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.policy.requestTimeoutMs)]);
    check(signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.credential) headers.authorization = `Bearer ${this.credential}`;
      if (id !== undefined) headers['content-type'] = 'application/json';
      const pending = this.transport(`${this.identity.baseUrl}${path}`, { method: id === undefined ? 'GET' : 'POST',
        redirect: 'error', signal, headers, ...(id === undefined ? {} : { body: JSON.stringify({ model: id }) }) });
      // A late transport result still has its body closed after an aborted wait.
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await bounded(pending, signal);
      reader = response.body?.getReader();
      if (!response.ok) throw new CatalogueFailure('http');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.policy.maxResponseBytes)) throw new CatalogueFailure('oversized');
      if (!reader) throw new CatalogueFailure('malformed');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '', bytes = 0;
      for (;;) {
        const chunk = await bounded(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.policy.maxResponseBytes) throw new CatalogueFailure('oversized');
        try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw new CatalogueFailure('malformed'); }
      }
      try { text += decoder.decode(); } catch { throw new CatalogueFailure('malformed'); }
      check(signal);
      try { return JSON.parse(text) as unknown; } catch { throw new CatalogueFailure('malformed'); }
    } catch (error) {
      if (signal.aborted) throw new CatalogueFailure(abortCode(signal));
      throw error instanceof CatalogueFailure ? error : new CatalogueFailure('transport');
    } finally {
      if (reader) { void reader.cancel().catch(() => {}); }
    }
  }
}
