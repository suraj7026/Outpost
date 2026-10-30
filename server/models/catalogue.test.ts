import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogueService } from './catalogue.js';
import { catalogueKey, catalogueReadiness, type CatalogueEvidence, type CatalogueIdentity, type CatalogueRepository, type CatalogueSnapshot } from './catalogue-types.js';

const local: CatalogueIdentity = { kind: 'local-self-hosted', accountId: 'fixture-account', baseUrl: 'http://127.0.0.1:11434' };
const cloud: CatalogueIdentity = { kind: 'direct-cloud', accountId: 'fixture-cloud-account', baseUrl: 'https://ollama.com' };
// Test double only. Production atomic fence/version/abort semantics require PostgreSQL validation.
class Repository implements CatalogueRepository {
  snapshots = new Map<string, CatalogueSnapshot>();
  generations = new Map<string, number>();
  writes = 0;
  async load(key: string, signal: AbortSignal): Promise<unknown | null> {
    signal.throwIfAborted(); return structuredClone(this.snapshots.get(key) ?? null);
  }
  async beginRefresh(key: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return { generation: String(generation), snapshot: await this.load(key, signal) };
  }
  async publish(key: string, generation: string, snapshot: CatalogueSnapshot, signal: AbortSignal) {
    signal.throwIfAborted();
    if (String(this.generations.get(key)) !== generation) return false;
    assert.equal(snapshot.version, (this.snapshots.get(key)?.version ?? 0) + 1);
    assert.equal(catalogueKey(snapshot.identity), key);
    this.snapshots.set(key, structuredClone(snapshot)); this.writes++; return true;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown) { return new Response(JSON.stringify(value)); }
function transport(ids: string[], show: (id: string) => Response | Promise<Response> = () => json({ capabilities: ['completion', 'tools', 'thinking', 'vision'], model_info: { 'fixture.context_length': 8192 } })): typeof fetch {
  return async (_url, init) => init?.method === 'POST'
    ? show((JSON.parse(String(init.body)) as { model: string }).model)
    : json({ data: ids.map(id => ({ id })) });
}
async function seeded() {
  const repository = new Repository();
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(['model:exact']), policy: { freshnessMs: 0 } });
  const result = await service.refresh();
  assert.equal(result.status, 'fresh');
  return { repository, service, snapshot: result.snapshot };
}

test('catalogue offline first launch is explicitly empty, read never calls HTTP', async () => {
  const repository = new Repository(); let calls = 0;
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: async () => { calls++; throw new Error('secret-bearing network error'); } });
  assert.deepEqual(await service.read(), { status: 'empty', snapshot: null, diagnostics: [] });
  const failed = await service.refresh();
  assert.equal(failed.status, 'failed'); assert.equal(failed.snapshot, null);
  assert.deepEqual(failed.diagnostics, [{ stage: 'list', code: 'transport' }]);
  assert.equal(calls, 1); assert.equal(repository.writes, 0);
});

test('catalogue exact IDs, advertised limits, unknown thinking/output and qualifications remain separate', async () => {
  const repository = new Repository();
  const ids = ['fixture', 'fixture:tag', 'constructor', '__proto__', 'fixture-cloud'];
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(ids) });
  const result = await service.refresh();
  assert.deepEqual(result.snapshot?.models.map(model => model.id).sort(), [...ids].sort());
  for (const model of result.snapshot!.models) {
    assert.equal(model.contextWindow?.value, 8192); assert.equal(model.contextWindow?.source.kind, 'advertised');
    assert.equal(model.maxOutputTokens, null); assert.equal(model.thinkingChoices, null);
    assert.equal(model.qualification, null); assert.equal(catalogueReadiness(model, '1.4.0'), 'unqualified');
  }
});

test('catalogue uses only exact scoped evidence and expires SDK-specific tool qualification', async () => {
  const evidence: CatalogueEvidence = { identity: local, modelId: 'fixture',
    maxOutputTokens: { value: 2048, source: { kind: 'probe', reference: 'fixture-only', observedAt: 10 } },
    thinkingChoices: [{ level: 'low', parameter: 'reasoning_effort', value: 'low', source: { kind: 'probe', reference: 'fixture-only', observedAt: 10 } }],
    qualification: { sdkVersion: '1.4.0', reference: 'fixture-not-live', observedAt: 10, expiresAt: 100,
      chat: true, toolStreaming: true, usage: true, cancellation: true, malformedResponses: true, overflow: true } };
  const result = await new CatalogueService({ identity: local, repository: new Repository(), evidence: [evidence], transport: transport(['fixture', 'fixture:tag']) }).refresh();
  const exact = result.snapshot!.models.find(model => model.id === 'fixture')!;
  const tagged = result.snapshot!.models.find(model => model.id === 'fixture:tag')!;
  assert.equal(exact.maxOutputTokens?.source.kind, 'probe'); assert.deepEqual(exact.thinkingChoices?.map(choice => choice.level), ['low']);
  assert.equal(tagged.thinkingChoices, null); assert.equal(tagged.qualification, null);
  assert.equal(catalogueReadiness(exact, '1.4.0', 50), 'tools');
  assert.equal(catalogueReadiness(exact, 'other-sdk', 50), 'unqualified');
  assert.equal(catalogueReadiness(exact, '1.4.0', 100), 'unqualified');
  assert.throws(() => new CatalogueService({ identity: cloud, repository: new Repository(), evidence: [evidence] }));
});

test('catalogue partial and total metadata failures preserve versioned last-good snapshot', async () => {
  const { repository, snapshot } = await seeded();
  for (const allFail of [false, true]) {
    const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(['model:exact', 'new'], id => {
      if (allFail || id === 'new') throw new Error('credential must never be reported');
      return json({ capabilities: ['completion'], model_info: { 'new.context_length': 99999 } });
    }) });
    const result = await service.refresh({ force: true });
    assert.equal(result.status, 'incomplete'); assert.deepEqual(result.snapshot, snapshot);
    assert.equal(result.diagnostics.length, allFail ? 2 : 1);
    assert.equal(repository.writes, 1);
    assert.deepEqual((await service.read()).snapshot, snapshot);
    assert.ok(!JSON.stringify(result).includes('credential'));
  }
});

test('catalogue complete refresh marks removed and non-chat models unavailable without substitutions', async () => {
  const { repository } = await seeded();
  const service: CatalogueService = new CatalogueService({ identity: local, repository,
    transport: transport(['embed:tag', 'clef', 'clef-flash:tag'], id => json({ capabilities: id.startsWith('clef') ? ['completion', 'tools'] : ['embedding'] })) });
  const result = await service.refresh({ force: true });
  assert.equal(result.snapshot?.version, 2);
  assert.equal(result.snapshot?.models.find(model => model.id === 'model:exact')?.availability, 'removed');
  assert.equal(result.snapshot?.models.filter(model => model.availability === 'incompatible').length, 3);
  assert.ok(result.snapshot!.models.every(model => catalogueReadiness(model, '1.4.0') === 'unavailable'));
  const empty = await new CatalogueService({ identity: local, repository, transport: transport([]) }).refresh({ force: true });
  assert.equal(empty.status, 'fresh'); assert.ok(empty.snapshot!.models.every(model => model.availability === 'removed'));
});

test('catalogue concurrent refresh in one service cancels old generation, latest exact IDs win', async () => {
  const repository = new Repository(); const started = deferred<void>(); const release = deferred<Response>(); let lists = 0;
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: async (url, init) => {
    if (init?.method !== 'POST' && ++lists === 1) { started.resolve(); return release.promise; }
    return transport(['new:exact'])(url, init);
  } });
  const first = service.refresh(); await started.promise;
  const second = await service.refresh({ force: true }); release.resolve(json({ data: [{ id: 'old' }] }));
  assert.equal((await first).status, 'superseded'); assert.equal(second.status, 'fresh');
  assert.deepEqual((await service.read()).snapshot?.models.map(model => model.id), ['new:exact']);
  assert.equal(repository.writes, 1);
});

test('catalogue repository fencing suppresses stale publication across service instances', async () => {
  const repository = new Repository(); const started = deferred<void>(); const release = deferred<Response>();
  const oldService = new CatalogueService({ identity: local, repository, transport: transport(['old'], async () => { started.resolve(); return release.promise; }) });
  const old = oldService.refresh(); await started.promise;
  const current = await new CatalogueService({ identity: local, repository, transport: transport(['new']) }).refresh({ force: true });
  release.resolve(json({ capabilities: ['completion'] }));
  assert.equal(current.status, 'fresh'); assert.equal((await old).status, 'superseded'); assert.equal(repository.writes, 1);
});

test('catalogue account switches and direct Cloud are isolated; only injected transport and credentials used', async () => {
  const repository = new Repository(); const requests: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];
  const mock: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    return transport(['same:exact'])(url, init);
  };
  const a = new CatalogueService({ identity: cloud, repository, credential: 'test-token-A-unique', transport: mock });
  await a.refresh();
  const bIdentity = { ...cloud, accountId: 'other-account' };
  const b = new CatalogueService({ identity: bIdentity, repository, credential: 'test-token-B-unique', transport: mock });
  assert.equal((await b.read()).status, 'empty');
  await b.refresh();
  const localService = new CatalogueService({ identity: local, repository, transport: mock });
  assert.equal((await localService.read()).status, 'empty'); await localService.refresh();
  assert.equal(repository.snapshots.size, 3);
  assert.deepEqual(requests.map(request => request.auth), ['Bearer test-token-A-unique', 'Bearer test-token-A-unique', 'Bearer test-token-B-unique', 'Bearer test-token-B-unique', null, null]);
  assert.ok(requests.slice(0, 4).every(request => request.url.startsWith('https://ollama.com/')));
  assert.ok(requests.every(request => request.redirect === 'error'));
  assert.ok(!JSON.stringify([...repository.snapshots.values()]).includes('test-token-A-unique'));
  assert.throws(() => new CatalogueService({ identity: { ...local, baseUrl: 'http://user:pass@localhost' }, repository }));
  assert.throws(() => new CatalogueService({ identity: { ...local, baseUrl: 'https://ollama.com' }, repository }));
});

test('catalogue cancellation during metadata and before refresh retains known state', async () => {
  const { repository, snapshot } = await seeded(); const started = deferred<void>(); const release = deferred<Response>();
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(['model:exact'], async () => { started.resolve(); return release.promise; }) });
  await service.read(); const controller = new AbortController();
  const pending = service.refresh({ force: true, signal: controller.signal }); await started.promise; controller.abort();
  const result = await pending; release.resolve(json({ capabilities: ['completion'] }));
  assert.equal(result.status, 'cancelled'); assert.deepEqual(result.snapshot, snapshot); assert.equal(repository.writes, 1);
  assert.deepEqual((await service.refresh({ signal: controller.signal })).snapshot, snapshot);
});

test('catalogue cancellation during awaited publication prevents write with compliant repository', async () => {
  const { repository, snapshot } = await seeded(); const started = deferred<void>(); const release = deferred<void>();
  const publish = repository.publish.bind(repository);
  repository.publish = async (...args) => { started.resolve(); await release.promise; return publish(...args); };
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(['new']) });
  const pending = service.refresh({ force: true }); await started.promise; service.cancel();
  assert.equal((await pending).status, 'cancelled'); release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(repository.writes, 1); assert.deepEqual((await service.read()).snapshot, snapshot);
});

test('catalogue malformed model lists never erase a healthy snapshot', async () => {
  const { repository, snapshot } = await seeded();
  const badLists = [{}, { data: [{ id: '' }] }, { data: [{ id: ' trimmed' }] }, { data: [{ id: 'x\n' }] }, { data: [{ id: 'x' }, { id: 'x' }] }, { data: [null] }];
  for (const bad of badLists) {
    const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: async () => json(bad) });
    const result = await service.refresh({ force: true });
    assert.equal(result.status, 'failed'); assert.equal(result.diagnostics[0]?.code, 'malformed'); assert.deepEqual(result.snapshot, snapshot);
  }
  assert.equal(repository.writes, 1);
});

test('catalogue invalid metadata, invalid UTF-8 and invalid JSON are bounded diagnostics, not raw provider errors', async () => {
  for (const response of [json({ capabilities: true }), json({ capabilities: ['completion'], model_info: [] }), json({ capabilities: ['completion'], model_info: { 'x.context_length': 1.5 } }), new Response('{bad secret'), new Response(new Uint8Array([255])), new Response(new Uint8Array([0xe2, 0x82]))]) {
    const service: CatalogueService = new CatalogueService({ identity: local, repository: new Repository(), transport: transport(['x'], () => response) });
    const result = await service.refresh(); assert.equal(result.status, 'incomplete'); assert.equal(result.diagnostics[0]?.code, 'malformed');
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('catalogue response body TypeError is transport failure and preserves last-good state', async () => {
  const { repository, snapshot } = await seeded();
  for (const stage of ['list', 'metadata'] as const) {
    let reads = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new TextEncoder().encode('{'));
        else controller.error(new TypeError('terminated: private transport detail'));
      },
    }));
    const service: CatalogueService = new CatalogueService({ identity: local, repository,
      transport: stage === 'list' ? async () => response : transport(['model:exact'], () => response) });
    const result = await service.refresh({ force: true });
    assert.equal(reads, 2);
    assert.equal(result.status, stage === 'list' ? 'failed' : 'incomplete');
    assert.deepEqual(result.diagnostics, [{ stage, code: 'transport', ...(stage === 'metadata' ? { modelId: 'model:exact' } : {}) }]);
    assert.deepEqual(result.snapshot, snapshot); assert.equal(repository.writes, 1);
    assert.deepEqual((await service.read()).snapshot, snapshot);
    assert.ok(!JSON.stringify(result).includes('private transport detail'));
  }
});

test('catalogue size limits cover content-length, streamed bytes and model counts; response body is cancelled', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(100))); }, cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': '1000' } : {} });
    const service: CatalogueService = new CatalogueService({ identity: local, repository: new Repository(), policy: { maxResponseBytes: 64 }, transport: async () => response });
    const result = await service.refresh(); assert.equal(result.diagnostics[0]?.code, 'oversized'); assert.equal(cancelled, true);
  }
  const result = await new CatalogueService({ identity: local, repository: new Repository(), policy: { maxModels: 1 }, transport: transport(['a', 'b']) }).refresh();
  assert.equal(result.diagnostics[0]?.code, 'oversized');
});

test('catalogue request deadline bounds a stalled body and total deadline bounds refresh', async () => {
  // Keep a real test handle alive: AbortSignal.timeout intentionally uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const policy of [{ requestTimeoutMs: 10, refreshTimeoutMs: 500 }, { requestTimeoutMs: 500, refreshTimeoutMs: 10 }]) {
      let cancelled = false;
      const service: CatalogueService = new CatalogueService({ identity: local, repository: new Repository(), policy,
        transport: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })) });
      const result = await service.refresh(); assert.equal(result.status, 'failed'); assert.equal(result.diagnostics[0]?.code, 'timeout'); assert.equal(cancelled, true);
    }
  } finally { clearInterval(keepAlive); }
});

test('catalogue bounds metadata concurrency and freshness cooldown; force bypasses cooldown', async () => {
  let active = 0, maximum = 0, calls = 0;
  const service: CatalogueService = new CatalogueService({ identity: local, repository: new Repository(), policy: { concurrency: 2 },
    transport: transport(['a', 'b', 'c', 'd', 'e'], async () => {
      active++; calls++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return json({ capabilities: ['completion'] });
    }) });
  assert.equal((await service.refresh()).status, 'fresh'); assert.equal(maximum, 2); assert.equal(calls, 5);
  assert.equal((await service.refresh()).status, 'cached'); assert.equal(calls, 5);
  assert.equal((await service.refresh({ force: true })).snapshot?.version, 2); assert.equal(calls, 10);
});

test('catalogue storage failures, foreign identity and unsupported snapshot versions fail closed', async () => {
  const { repository, snapshot } = await seeded();
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(['new']) }); await service.read();
  repository.publish = async () => { throw new Error('postgres credential secret'); };
  const result = await service.refresh({ force: true }); assert.equal(result.status, 'failed'); assert.deepEqual(result.snapshot, snapshot);
  assert.deepEqual(result.diagnostics, [{ stage: 'repository', code: 'storage' }]);
  for (const value of [{ ...snapshot, schemaVersion: 2 }, { ...snapshot, identity: cloud }]) {
    repository.load = async () => value;
    const result = await new CatalogueService({ identity: local, repository }).read();
    assert.equal(result.status, 'failed'); assert.equal(result.snapshot, null);
  }
});

test('catalogue first-launch partial metadata failure has no invented fallback or persisted partial list', async () => {
  const repository = new Repository();
  const service: CatalogueService = new CatalogueService({ identity: cloud, repository,
    transport: transport(['known', 'unknown'], id => id === 'known' ? json({ capabilities: ['completion', 'tools'] }) : new Response('private error', { status: 503 })) });
  const result = await service.refresh();
  assert.equal(result.status, 'incomplete'); assert.equal(result.snapshot, null); assert.equal(repository.writes, 0);
  assert.deepEqual(result.diagnostics, [{ stage: 'metadata', modelId: 'unknown', code: 'http' }]);
});

test('catalogue account switch cancels in-flight old identity without leaking state to new identity', async () => {
  const repository = new Repository(); const started = deferred<void>(); const release = deferred<Response>();
  const oldAccount = new CatalogueService({ identity: cloud, repository,
    transport: transport(['old-account-only'], async () => { started.resolve(); return release.promise; }) });
  const old = oldAccount.refresh(); await started.promise; oldAccount.cancel();
  const newAccount = new CatalogueService({ identity: { ...cloud, accountId: 'new-account' }, repository, transport: transport(['new-account-only']) });
  const result = await newAccount.refresh(); release.resolve(json({ capabilities: ['completion'] }));
  assert.equal((await old).status, 'cancelled');
  assert.deepEqual(result.snapshot?.models.map(model => model.id), ['new-account-only']);
  assert.equal(repository.snapshots.has(catalogueKey(cloud)), false);
});

test('catalogue awaits repository commit and does not expose mutable internal fallback state', async () => {
  const repository = new Repository(); const started = deferred<void>(); const release = deferred<void>();
  const publish = repository.publish.bind(repository);
  repository.publish = async (...args) => { started.resolve(); await release.promise; return publish(...args); };
  const service: CatalogueService = new CatalogueService({ identity: local, repository, transport: transport(['exact']) });
  let returned = false;
  const pending = service.refresh().then(result => { returned = true; return result; });
  await started.promise; assert.equal(returned, false); assert.equal(repository.writes, 0);
  release.resolve(); const result = await pending;
  assert.equal(repository.writes, 1); result.snapshot!.models.length = 0;
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await service.refresh({ signal: controller.signal })).snapshot?.models.map(model => model.id), ['exact']);
});

test('catalogue metadata response byte overflow preserves last-good version', async () => {
  const { repository, snapshot } = await seeded();
  const result = await new CatalogueService({ identity: local, repository, policy: { maxResponseBytes: 128 },
    transport: transport(['model:exact'], () => json({ capabilities: ['completion'], extra: 'x'.repeat(200) })) }).refresh({ force: true });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.snapshot, snapshot);
  assert.deepEqual(result.diagnostics, [{ stage: 'metadata', modelId: 'model:exact', code: 'oversized' }]);
});

test('catalogue origin validation rejects Cloud DNS aliases in local scope and non-origin URLs', () => {
  for (const baseUrl of ['https://ollama.com.', 'http://ollama.com.', 'https://OLLAMA.COM', 'https://ollama.com:443',
    'http://localhost/', 'http://localhost/v1', 'http://localhost?token=secret', 'http://localhost#fragment']) {
    assert.throws(() => new CatalogueService({ identity: { ...local, baseUrl }, repository: new Repository() }), baseUrl);
  }
  assert.throws(() => new CatalogueService({ identity: { ...cloud, baseUrl: local.baseUrl } as CatalogueIdentity, repository: new Repository() }));
});

test('catalogue hard model limit rejects 257 IDs before any detail request', async () => {
  let details = 0;
  const result = await new CatalogueService({ identity: local, repository: new Repository(),
    transport: transport(Array.from({ length: 257 }, (_, i) => `model:${i}`), () => { details++; return json({ capabilities: ['completion'] }); }) }).refresh();
  assert.equal(result.status, 'failed'); assert.equal(result.snapshot, null); assert.equal(details, 0);
  assert.deepEqual(result.diagnostics, [{ stage: 'list', code: 'oversized' }]);
});

test('catalogue missing or conflicting limits remain unknown and tools alone do not imply chat', async () => {
  const result = await new CatalogueService({ identity: local, repository: new Repository(),
    transport: transport(['missing', 'conflicting', 'tools-only'], id => json({
      capabilities: id === 'tools-only' ? ['tools', 'thinking'] : ['completion'],
      ...(id === 'conflicting' ? { model_info: { 'a.context_length': 4096, 'b.context_length': 8192 } } : {}),
    })) }).refresh();
  assert.equal(result.status, 'fresh');
  for (const model of result.snapshot!.models) {
    assert.equal(model.contextWindow, null); assert.equal(model.maxOutputTokens, null); assert.equal(model.thinkingChoices, null);
  }
  assert.equal(result.snapshot!.models.find(model => model.id === 'tools-only')?.availability, 'incompatible');
});

test('catalogue restored thinking choices reject ambiguous duplicate levels', async () => {
  const { repository, snapshot } = await seeded();
  const choice = { level: 'low', parameter: 'think', value: true, source: { kind: 'probe', reference: 'fixture-only', observedAt: 1 } };
  repository.load = async () => ({ ...snapshot, models: [{ ...snapshot!.models[0], thinkingChoices: [choice, choice] }] });
  const result = await new CatalogueService({ identity: local, repository }).read();
  assert.equal(result.status, 'failed'); assert.equal(result.snapshot, null);
  assert.deepEqual(result.diagnostics, [{ stage: 'repository', code: 'storage' }]);
});

test('catalogue readiness requires every qualification check and current advertised tools', async () => {
  const evidence: CatalogueEvidence = { identity: local, modelId: 'exact', qualification: {
    sdkVersion: '1.4.0', reference: 'fixture-only', observedAt: 10, expiresAt: 100,
    chat: true, toolStreaming: true, usage: true, cancellation: true, malformedResponses: true, overflow: true,
  } };
  const result = await new CatalogueService({ identity: local, repository: new Repository(), evidence: [evidence], transport: transport(['exact']) }).refresh();
  const model = result.snapshot!.models[0]!;
  assert.equal(catalogueReadiness(model, '1.4.0', 9), 'unqualified');
  for (const check of ['chat', 'usage', 'cancellation', 'malformedResponses', 'overflow'] as const) {
    assert.equal(catalogueReadiness({ ...model, qualification: { ...model.qualification!, [check]: false } }, '1.4.0', 50), 'unqualified');
  }
  assert.equal(catalogueReadiness({ ...model, qualification: { ...model.qualification!, toolStreaming: false } }, '1.4.0', 50), 'chat');
  assert.equal(catalogueReadiness({ ...model, advertised: { ...model.advertised, capabilities: ['completion'] } }, '1.4.0', 50), 'chat');
});

test('catalogue delayed fence reservations cannot overtake a newer same-service refresh', async () => {
  const repository = new Repository(); const started = deferred<void>(); const release = deferred<void>();
  const begin = repository.beginRefresh.bind(repository); let reservations = 0;
  repository.beginRefresh = async (...args) => {
    if (++reservations === 1) { started.resolve(); await release.promise; }
    return begin(...args);
  };
  const service = new CatalogueService({ identity: local, repository, transport: transport(['new']) });
  const old = service.refresh(); await started.promise;
  const current = service.refresh({ force: true });
  assert.equal((await old).status, 'superseded'); assert.equal(reservations, 1);
  release.resolve(); assert.equal((await current).status, 'fresh');
  assert.equal(reservations, 2); assert.equal(repository.writes, 1);
});

test('catalogue late offline read cannot downgrade internal last-good fallback', async () => {
  const { repository, snapshot } = await seeded(); const started = deferred<void>(); const release = deferred<unknown>();
  const service = new CatalogueService({ identity: local, repository, transport: transport(['new']) });
  await service.read(); const load = repository.load.bind(repository);
  let reads = 0;
  repository.load = async (...args) => {
    if (++reads === 1) { started.resolve(); return release.promise; }
    return load(...args);
  };
  const oldRead = service.read(); await started.promise;
  const current = await service.refresh({ force: true }); assert.equal(current.snapshot?.version, 2);
  release.resolve(snapshot); assert.equal((await oldRead).snapshot?.version, 1);
  const controller = new AbortController(); controller.abort();
  const fallback = await service.refresh({ signal: controller.signal });
  assert.deepEqual(fallback.snapshot, current.snapshot);
});

test('catalogue bounds stalled repository reads, reservations and publications', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const operation of ['load', 'beginRefresh', 'publish'] as const) {
      const repository = new Repository();
      repository[operation] = async () => new Promise<never>(() => {});
      const service: CatalogueService = new CatalogueService({ identity: local, repository, policy: { refreshTimeoutMs: 20 }, transport: transport(['exact']) });
      const result = await (operation === 'load' ? service.read() : service.refresh());
      assert.equal(result.status, 'failed'); assert.equal(repository.writes, 0);
      assert.deepEqual(result.diagnostics, [{ stage: 'repository', code: 'timeout' }]);
    }
  } finally { clearInterval(keepAlive); }
});

test('catalogue authoritative empty lists retain removals for only one generation', async () => {
  const { repository } = await seeded();
  const service = new CatalogueService({ identity: local, repository, transport: transport([]) });
  const first = await service.refresh({ force: true });
  assert.deepEqual(first.snapshot?.models.map(model => [model.id, model.availability]), [['model:exact', 'removed']]);
  const second = await service.refresh({ force: true });
  assert.equal(second.snapshot?.version, 3); assert.deepEqual(second.snapshot?.models, []);
  const restored = await new CatalogueService({ identity: local, repository, transport: async () => { throw new Error('unexpected HTTP'); } }).read();
  assert.deepEqual(restored.snapshot, second.snapshot);
});
