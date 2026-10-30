# OP-031 provider catalogue service slice

Implemented against base `eedfac8c88c38ee07d6761a4a66bdebdeda9830c` in the catalogue worktree. This is **not full OP-031 acceptance or picker integration**. No gateway, runtime, desktop, inference, Cloud reviewer, thinking probe, selection, or programme/status file is changed.

## Source inspection and provenance

Read the approved adoption programme, `docs/tickets/OP-031.md`, `server/models/{inference,cloud,thinking}.ts`, relevant model registration/thinking use in `server/pi-adapter/runtime.ts`, and the actual installed `/Users/sudarshanrajagopalan/.pi/agent/npm/node_modules/pi-ollama-cloud/{models.ts,thinking-levels.ts,package.json,LICENSE}`. Installed upstream version is **0.13.1**, repository <https://github.com/fgrehm/pi-ollama-cloud>, MIT, copyright (c) 2026 Fabio. No developer auth file was read.

The upstream design informs separate list/detail discovery, exact identity, retained baseline on incomplete metadata, explicit Cloud origin, and capability provenance. Its two known non-chat family names (`clef`, `clef-flash`) are retained as exclusions. The implementation is otherwise independently written: no upstream generated models, generated limits, pricing, default thinking map, prefix thinking mapping, compatibility flag table, cache, or provider registration is copied. Upstream's fallback max output of 32768 and fallback graded thinking/off choices are deliberately **not** adopted. A `thinking` capability alone supplies neither supported levels nor a working off switch.

Outpost currently uses a boolean `supportsThinking` probe and registers a runtime model with an inferred medium/off choice; this slice does not silently alter that separate path. The project pins `@earendil-works/pi-coding-agent` to **1.4.0**, also confirmed in the installed shared dependency (read-only). The installed `ModelRuntime.registerProvider` and provider `thinkingLevelMap` declarations were inspected; this slice does not register an extension or import its runtime. External qualifications must name the actual SDK/version used at integration; the helper requires an exact version-string match. Mock catalogue tests do not qualify its inference streaming adapter.

## Files

- `server/models/catalogue-types.ts`: validated identities, evidence, snapshot schema, narrow async repository contract, result types, readiness helper.
- `server/models/catalogue.ts`: bounded discovery, offline restore, last-good snapshot handling, generations/cancellation, redacted diagnostics.
- `server/models/catalogue.test.ts`: 30 focused tests using injected HTTP transport and an in-memory repository **test double only**.
- This document.

## Exact public API

```ts
new CatalogueService({
  identity,                 // CatalogueIdentity, immutable for this instance
  repository,               // CatalogueRepository, mandatory
  credential?,              // server-injected credential, not persisted
  transport?,               // typeof fetch; defaults to fetch
  evidence?,                // CatalogueEvidence[], exact model + identity
  policy?,                  // bounds below
  now?,                     // () => number; epoch milliseconds
})

service.read(signal?: AbortSignal): Promise<CatalogueResult>
service.refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<CatalogueResult>
service.cancel(): void

catalogueKey(identity: CatalogueIdentity): string
catalogueReadiness(model: CatalogueModel, sdkVersion: string, now?: number):
  'unavailable' | 'unqualified' | 'chat' | 'tools'
```

`read` is repository-only and never fetches HTTP. Initial absence returns `{status:'empty', snapshot:null, diagnostics:[]}`. A first offline/partial refresh returns `failed`/`incomplete` with null snapshot rather than invented model IDs or limits. Existing independently configured fixed-model routes remain untouched and are not advertised as catalogue-discovered. This is the explicit first-launch fallback, not a bundled static catalogue.

`refresh` reserves a durable fence, checks freshness unless forced, GETs `/v1/models`, then POSTs `/api/show` with the **unaltered** `{model:id}`. The same paths are used for explicitly configured Ollama-compatible self-hosted origins. Redirects are forbidden. Partial details (including all failed) return the unchanged last-good snapshot and per-model diagnostics; they never persist partial lists or advance successful freshness. A complete empty list is authoritative: previous entries are marked removed, not replaced with defaults. Removal tombstones remain for one complete generation; subsequent absence drops them, bounding storage. A complete pass increments the snapshot version even if the IDs did not change.

`CatalogueResult` contains:

- `status`: `empty | cached | fresh | incomplete | failed | cancelled | superseded`.
- `snapshot`: a versioned complete last-good snapshot, or null.
- `diagnostics`: `{stage: 'list'|'metadata'|'repository'|'refresh', code: 'transport'|'http'|'malformed'|'oversized'|'timeout'|'cancelled'|'superseded'|'storage', modelId?: string}[]`.

Diagnostics contain no raw provider response, exception, URL, or credential. A failed response-body read is `transport`; invalid UTF-8 (including an incomplete final sequence), JSON or metadata is `malformed`. Failed-attempt diagnostics are returned, not durably retained by this slice. Consumers must escape provider IDs as untrusted display strings. IDs reject whitespace padding/control characters, are bounded, and are never trimmed, tag-stripped, alias-resolved, or used as object prototype keys.

### Identity and bounds

Identity is either `{kind:'direct-cloud', accountId, baseUrl:'https://ollama.com'}` or `{kind:'local-self-hosted', accountId, baseUrl:<explicit http/https origin>}`. Local origins exclude the direct Cloud hostname (including its DNS trailing-dot spelling), userinfo, paths, trailing slash, query and fragment. Scope keys encode kind, account ID and origin. Account IDs are opaque server-owned scope IDs, **not credentials**. Local/self-hosted names the endpoint, not a guarantee that its backend never forwards inference elsewhere. Admission/egress enforcement remains outside discovery.

Cloud origin is fixed; environment variables never redirect it to local endpoints. Credentials are injected explicitly, used only on that immutable origin, and excluded from snapshot data. There is no developer auth file lookup, environment auth lookup, SQLite access, user-global disk cache, or process-global catalogue.

Defaults / supported maximums:

| Policy | Default | Maximum |
|---|---:|---:|
| requestTimeoutMs | 5,000 | 30,000 |
| refreshTimeoutMs (repository + discovery + publish) | 20,000 | 120,000 |
| maxResponseBytes (each decoded HTTP body) | 1,048,576 | 4,194,304 |
| maxModels | 256 | 256 |
| concurrency | 4 | 8 |
| freshnessMs | 14,400,000 | 86,400,000 |

Timeouts, bytes, models and concurrency must be positive integers; freshness may be zero. Bodies are streamed with byte accounting, checked against declared length too, decoded as strict UTF-8, and cancelled on completion/error. There are no retries or hidden live inference probes. Automatic background scheduling is not implemented: the coordinator must call `refresh` under its approved lifecycle and choose bounded retry cadence after errors.

### Metadata versus readiness

Snapshots carry schemaVersion 1, monotonically increasing complete-snapshot `version`, exact identity, `refreshedAt`, and models. Each model records exact ID, availability (`available | removed | incompatible`), dated advertised capabilities, advertised modalities, optional dated/source-labelled context and output limits, explicit thinking choices or null, and qualification or null.

A chat candidate must advertise `completion` and not belong to the known excluded non-chat families. A candidate is **not qualified** just because it advertises `tools`. Context length is taken from positive safe-integer `*.context_length` metadata only when all such values agree; conflicts remain unknown. Missing context/output limits stay null. No context or output budget is guessed. Explicit trusted exact-model evidence can provide context/output limits and thinking choices with advertised/generated/probe/qualified source labels, reference and observation date. No evidence propagates to a tagged/family variant. Thinking choices specify Pi level, wire parameter (`reasoning_effort` or `think`), and exact wire value. Duplicate levels are rejected both in supplied evidence and restored snapshots. Null means unknown, not off; an off entry exists only if explicitly supplied.

`catalogueReadiness` rejects unavailable models and missing, expired, future-dated, wrong-SDK, or incomplete qualification. Qualified chat requires explicit chat/usage/cancellation/malformed-response/overflow evidence; qualified tools additionally requires tool-streaming qualification and currently advertised tools. This is a catalogue readiness helper, **not an authorization grant, child scope check, role selector, or runtime admission decision**. Trusted evidence is a server-side input; do not expose it as a client/provider writable object.

### Repository and stale generations

```ts
interface CatalogueRepository {
  load(key: string, signal: AbortSignal): Promise<unknown | null>;
  beginRefresh(key: string, signal: AbortSignal): Promise<{
    generation: string;
    snapshot: unknown | null;
  }>;
  publish(key: string, generation: string,
    snapshot: CatalogueSnapshot, signal: AbortSignal): Promise<boolean>;
}
```

The production PostgreSQL adapter is an integration gate, **not included here**. Requirements:

1. Await every operation, bound it by the signal, and validate key/snapshot identity/schema at the trust boundary.
2. Atomically increment a durable per-key fence and return the last-good snapshot in `beginRefresh`. Generations are opaque strings, never JavaScript-rounded PostgreSQL bigints.
3. In `publish`, atomically compare the fence, require version = stored version + 1, and commit only a complete snapshot. Return false on stale fence. No external provider call runs inside a database transaction.
4. Cancellation before publication's commit linearization point prevents the write. Cancellation after an already completed commit cannot undo it. A returned cancellation therefore does not prove a commit was rolled back if it raced the acknowledgement; re-read authoritative storage.
5. Wrong-key identities, unsupported schemas, malformed stored data, and storage failures must not become an empty successful refresh.

One service supersedes/cancels its earlier refresh immediately and serializes fence reservations (not discovery). The repository fence handles other instances. Snapshot publication is awaited before `fresh` is returned. The service keeps a private defensive last-good copy for cancellation fallback, never a shared mutable cache. It does not allow a late cached read to downgrade that internal copy.

On account changes the coordinator cancels/discards the old service and constructs a new one; the new scope cannot restore the old account's snapshot. UI/coordinator consumers must gate completions by their active identity/request and snapshot version, ignore `superseded` as an update, and not apply an older result over a newer revision. This service never changes the active selected model or route.

## Recovery and verification executed

The previous builder failed with ENOSPC and had no final artifact. This one authorized retry preserved its four useful files rather than replacing them. Before edits, all four were byte-identical to `/tmp/outpost-enospc-checkpoint.vOqJmT/catalogue-source.tgz`, ended with a newline and contained no NUL bytes. Full source/test/doc reads and fresh compilation checked syntax/content boundaries; no truncation was found. macOS `._` archive metadata was ignored when comparing source bytes. Initial free space was 7.3 GiB; no ENOSPC recurred. No install, dependency-link mutation or native build was performed.

The recovered baseline independently passed compilation and 21 focused tests. Retry edits reject the Cloud trailing-dot alias in local identities, apply duplicate-thinking-level validation to restored data, classify the hard 256-model overflow as `oversized`, and add nine boundary/recovery regressions. Earlier validation claims in the partial document were not taken as evidence.

Final validation in this retry:

- `npm run build` — exit 0 (`tsc --noEmit`, full backend compilation).
- `./node_modules/.bin/tsx --test server/models/catalogue.test.ts server/models/cloud.test.ts` — exit 0, **30 passed** (29 catalogue tests plus 1 existing Cloud regression).
- `git diff --check` — exit 0; new files also checked explicitly before handoff.
- `git diff --cached --name-only` — no staged files.

Coverage includes offline first launch, no-network restore, exact/prototype-like IDs, missing/conflicting limits, unknown thinking/output metadata, evidence scoping, SDK/expiry/future/incomplete qualification, partial/all-failed metadata, removed/incompatible models and tombstone expiry, same-service overlap and delayed reservations, cross-service fencing, late-read fallback protection, account switches including in-flight cancellation, injected credentials/origin separation, pre-abort/metadata/publish cancellation, malformed IDs/schema/JSON/UTF-8, duplicate restored thinking levels, declared and streamed oversized bodies, configured and hard model-count limits, request/total/repository deadlines, worker concurrency, cooldown/force, awaited storage, foreign/schema-invalid snapshots, storage failure, and defensive fallback copies. HTTP is mocked through the injected transport, including all Cloud URLs; no live provider/account request was made.

The first compile after adding the retry regressions failed with TS7022 on a test-local service/result inference cycle. An explicit `CatalogueService` annotation corrected it; the next full compilation and focused test run passed. The final results above are fresh runs, not inferred from the previous builder's document. No inference compatibility probe was run.

### Fresh-review P2 correction

Read the fresh `catalogue-review.md` completely. Its only finding was nonblocking P2: the blanket `TypeError` classification after acquiring a body reader conflated transport termination with invalid UTF-8. The review's installed Undici `TypeError('terminated')` source observation was independently inspected read-only; it is source-derived evidence, not a live connection-failure test.

The correction scopes `malformed` conversion to the two `TextDecoder.decode` calls (stream chunks and final flush). Response-body read failures now retain `transport` classification. No public type, persistence, cancellation or integration boundary changed.

Executed evidence in this normal review-correction run:

- Added a deterministic body-stream fixture that emits a valid UTF-8 prefix and then errors with `TypeError`, covering both list and metadata paths, redacted diagnostics and unchanged persisted last-good state. Before the source fix, `./node_modules/.bin/tsx --test --test-name-pattern='catalogue response body TypeError' server/models/catalogue.test.ts` failed as expected: `malformed` instead of `transport`.
- Retained the existing invalid-UTF-8 assertion and added a truncated multibyte UTF-8 fixture to exercise the final decoder flush.
- `npm run build` — exit 0 (`tsc --noEmit`).
- `./node_modules/.bin/tsx --test server/models/catalogue.test.ts server/models/cloud.test.ts` — exit 0, **31 passed**, 0 failed/cancelled/skipped (30 catalogue tests plus 1 existing Cloud regression).
- Free space was 5.2 GiB before edits and after compilation/tests; no infrastructure failure, retry, install or native build occurred. All transport fixtures remain offline.

Only `catalogue.ts`, `catalogue.test.ts` and this document changed during this correction; `catalogue-types.ts` is unchanged. Independent verification of the correction and all parent integration gates below remain required. This is not full OP-031 acceptance.

## Remaining integration/acceptance gates

- Implement/rehearse the repository using authoritative PostgreSQL and verify fence/version/abort/commit-ack races with real transactions, including multiple coordinator instances and restart recovery.
- Wire the one coordinator's scoped catalogue API, force/cancel commands, background scheduling/error backoff, server credential owner and account lifecycle. Do not fetch automatically on every picker render.
- Wire the Tauri picker to freshness, provenance, unknown limits/thinking, incomplete diagnostics, unavailable tombstones, and exact provider/account/model identity; do not silently substitute or mutate active routes/tasks.
- Wire parent/reviewer/worker selection to effective child scope/ceiling and requested-versus-resolved thinking reporting. This service intentionally does not decide these policies.
- Qualify actual inference compatibility/flags, chat/tool streaming, usage, cancellation, malformed responses and overflow against the pinned SDK with opt-in/budgeted approved probes. Fixture qualification objects in these tests are not live evidence.
- Run integrated PostgreSQL/runtime/desktop end-to-end acceptance and independent review. This service slice alone does not complete OP-031.

## Upstream notice

For the retained upstream exclusion facts and source-informed implementation:

MIT License

Copyright (c) 2026 Fabio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
