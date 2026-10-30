# OP-032 — bounded web research module slice

## Status and boundaries

**Implementation:** additive module implemented, not runtime-integrated. **Verification:** local deterministic contracts verified. **Release:** blocked on parent integration and qualification. This is not full OP-032 acceptance.

Base revision: `eedfac8c88c38ee07d6761a4a66bdebdeda9830c`. The storage-incident checkpoint was resumed with explicit authorization; the validation below was rerun after resumption, not copied from the checkpoint.

Only the new `server/research/web-*.ts` modules/tests and this document are changed. Existing `sources.ts`, policy/Gate, coordinator, runtime, storage foundation and desktop are untouched. No tools are globally installed, no live account/provider calls were made, and no dependency installation, native build, migration, deployment, commit or push was performed.

## Files and integration seams

| File | Responsibility |
| --- | --- |
| `server/research/web-contracts.ts` | Scope, exact provider-request authorization, snapshots, async cache fencing, publication and cancellation contracts. |
| `server/research/web-url.ts` | Conservative URL canonicalization, public-address screening, injected DNS resolution. |
| `server/research/web-cache.ts` | Explicitly ephemeral bounded reference adapter; never an implicit durable-store fallback. |
| `server/research/web-provider.ts` | Fixed Ollama Cloud search/fetch HTTP protocol, injected account credential owner, bounded response streaming. |
| `server/research/web-research.ts` | Authorized cache/read/request/publication flow, coalescing, refresh, paging, inspection and scope deletion. |
| `server/research/web-research.test.ts` | Deterministic HTTP `Response` fixtures, fake authorizers/publishers, concurrency and adversarial contracts. |

Inspected existing Outpost `research/sources.ts`, `artifacts/files.ts`, `policy/trust.ts` and `gateway/coordinator.ts`. Their synchronous ledger and artifact publication methods were not wrapped into a pretend asynchronous PostgreSQL authority. The new contracts are explicit parent integration seams.

Read actual installed `pi-ollama-cloud` **0.13.1** `web-tools.ts`, `cache.ts`, and `docs/web-tools.md`, alongside the programme and OP-032 ticket. The implementation is independent: it does not import, install or copy the upstream extension runtime/cache. Its user-global raw-URL cache, synchronous load/save, permissive negative-cache selection, unbounded full expansion and last-writer-wins persistence are deliberately not adopted. No applicable implementation skill was discovered; the available discovered skills concerned child orchestration, which this lane was prohibited from running.

## Authority and egress contract

Every service operation needs a complete `{ identityId, accountId, taskId, scopeId }`. The cache partition is the SHA-256 of the ordered tuple. Cache keys also include operation kind and canonical request, including search result count. This prevents cross-account, identity, task or scope cache/coalescing reuse.

`WebAuthorization.check` must delegate to the existing concrete-action authority. It is **not** a policy engine. The parent adapter must enforce current identity/account/task grants, current egress policy, sensitive-content rules, per-task disable and owner kill switch at each requested stage. Returned revisions must change when applicable authority changes; returned signals must abort promptly on revocation/disable. The service checks before cache access and outgoing provider requests, again after asynchronous retrieval, and before publication/return. Cache hits are not permission bypasses. Management operations are separately checked.

The exact provider request is supplied to authorization, but this is not global tool registration or a complete Gate action envelope. Parent-owned registration must bind the actual tool version and full invocation arguments, including refresh, paging and snapshot identity, to the normal action owner. No ambient extension permissions or stored page content mint authority.

The HTTP adapter always targets `https://ollama.com/api/web_search` or `/api/web_fetch`. Its credential callback receives the bound scope; it does not read Pi auth files, environment keys, personal profiles or local inference configuration. Results explicitly report `egress: 'ollama-cloud'`. **Local inference does not make these Cloud tools local, free, or implicitly authorized.** The provider class is a low-level transport dependency, not a separately authorized tool entry point; runtime integration must expose the research service through the common gate, not bypass it.

Errors use fixed codes. HTTP error bodies, raw exception messages, credentials and URLs are not emitted as diagnostics. Authorized source URLs and untrusted page text are deliberately present in result/artifact data; they are not diagnostic log fields. Parent logging must not serialize raw tool arguments, authorization objects or snapshot bodies.

## URL protection and explicit limitations

- Only HTTP/HTTPS, without embedded credentials, are supported. Nonstandard ports are rejected.
- **Every query string and fragment is rejected**, including otherwise benign parameters. Known credential-like path components and nested percent encoding are also rejected. This is conservative behavior, not claimed URL compatibility with the upstream extension. No egress policy was widened to compensate.
- WHATWG URL parsing normalizes alternate numeric IPv4 forms before screening. Private, loopback, link-local, shared-address, multicast and selected special-purpose ranges are rejected. IPv6 acceptance is conservative public-unicast only; transition/embedded-IPv4 forms and some legitimate special allocations are rejected.
- Local/private-style hostnames are rejected. Before a live fetch request, every answer from the injected resolver must be public; empty, mixed-public/private or failed answers fail closed. Malicious returned links/results are filtered, so search result count may be less than requested. Returned links are data, not automatically fetched.
- Lexical checks cannot recognize every opaque secret placed in a path, hostname or search query. The injected authorizer must apply the owner's sensitive-content policy before egress; arbitrary page content remains untrusted data.

**Cloud-side redirects and DNS rebinding remain a qualification gate.** Local screening checks the submitted target and local DNS answers. Ollama resolves/fetches the target remotely and may follow target redirects; the local adapter cannot pin that remote connection or inspect its redirect chain. `redirect: 'error'` protects the direct request to the Ollama API, not Ollama's downstream fetch. Therefore this slice does not prove remote SSRF confinement. Parent integration must keep activation gated until the provider behavior/destination policy is qualified; local fixtures are not evidence for remote guarantees.

## Snapshot and paging behavior

Successful normalized content is hashed with SHA-256. A snapshot ID binds content digest, canonical request key, complete scope partition, retrieval time and generation fence. It is stable across cache hits/expansion but changes on a fresh retrieval even when content is unchanged. Output includes snapshot ID, digest, retrieval/expiry timestamps, fresh/cached state, artifact ID and `external_untrusted` provenance.

Search defaults to five results and accepts at most ten. Snippets are bounded. Expansion requires the original query/result-count combination and `snapshotId`, plus a one-based `expand` index. Expansion is **cache-only**: missing/expired snapshots fail without another paid search. Result indices refer to the normalized safe-result set. Fetch continuations with nonzero offset also require `snapshotId`; a mismatched or unavailable snapshot fails rather than silently switching evidence.

Offsets are JavaScript UTF-16 string offsets, not bytes or model tokens. Ordinary pages default to 3,000 units; `full` defaults to a maximum of 12,000, never unlimited. Both return deterministic `nextOffset` and total length. Fetch links are bounded on the first page only. Title/URL/result/link-count validation and response/cache byte quotas bound metadata as well as text. Prompt-injection content is preserved as quoted source data; nothing in the module interprets it as instructions or performs requested actions.

## Cache, refresh, quotas and cancellation

Reference service limits are explicit and configurable, not activated product configuration: 24-hour success TTL, 15-minute negative TTL, 200,000 bytes of provider JSON for normalization, 500-unit snippets, ten displayed links and sixteen concurrent provider flights. A service-owned `operationTimeoutMs` defaults to 30 seconds and starts before initial authorization, hence before DNS. The same deadline covers the complete operation rather than resetting at each stage. The HTTP adapter additionally defaults to a 256 KiB streamed response limit and its own 15-second timeout. Cache byte/entry quotas must be supplied explicitly to the reference adapter.

Only fetch **404/410** results are negative-cached. Search failures, authentication/permission errors, throttling, transport errors, timeouts/cancellation, malformed responses and server failures are not negative-cached. Refresh bypasses the current entry and invalidates it when reserving a new generation; failed refresh does not silently fall back to old content. Refresh cannot be combined with snapshot-bound continuation/expansion. Successful empty searches remain ordinary successful snapshots.

`MemoryWebCacheStore` is a testable, explicitly ephemeral reference implementation. It enforces global entry count, serialized entry bytes and total stored bytes atomically; overflow is an error rather than hidden success or indefinite storage. Expiry is swept on access/reservation/commit/inspection, and `sweep` is available for an owner retention job. Reservations are independently count-bounded and expire after 60 seconds by default. Failed requests can occupy their reservation until expiry; repeated requests for the same key can replace it. No eviction of another live entry is silently performed to admit a quota violation.

One server-owned `WebResearch` instance coalesces concurrent requests only within the same scope/request/policy revision. Each caller is independently authorized and rechecked before disclosure. A follower's cancellation stops that wait; cancelling the owning request conservatively fails its coalesced followers too. Independent service instances are protected from stale commits by generation fences but do **not** offer distributed provider-call deduplication. Parent integration must retain one request owner (or separately qualify distributed coalescing), not claim exactly-once billing.

Cancellation, revocation and service-deadline signals fence new requests and suppress returned content. Initial and subsequent authorization, DNS, storage, publication and coalesced provider waits are raced against the applicable signal; credential retrieval and HTTP/stream waits also have transport cancellation protection. A stalled resolver or request authorizer therefore cannot keep a flight slot forever: expiry/cancellation settles the flight and late dependency completion does not resume provider dispatch. Each public operation clears its deadline timer on settlement. Timeout uses the fixed `cancelled` error code and is not negative-cached. The provider must also honor cancellation; an already dispatched remote request cannot be unsent or guaranteed unbilled. Self-review fixed non-success response-body cleanup so a stalled stream cancellation cannot hold a classified error indefinitely.

Stopping a wait is **not rollback**. An already admitted cache write, scope deletion or artifact publication can commit after the service has stopped waiting; a lost acknowledgement does not prove failure. In particular, a cancelled publication wait can leave the preceding cache commit intact. Adapters still own atomic authority/generation fencing at the effect boundary, durable cleanup intent and reconciliation. The service prevents stale result disclosure; it does not claim to cancel an already committed effect or force an uncooperative dependency to release its own resources.

`inspect` returns scoped entry/byte totals without raw queries/URLs. `deleteScope` removes cached content and fences pending generations, then asks the publisher to delete artifacts only through the returned epoch cutoff. A newly admitted publication after deletion has a newer epoch and is not accidentally removed by old cleanup. Scope deletion is not a permanent disable; authorization/kill-switch controls determine whether subsequent research may be admitted.

## Durable publication, retention and parent gates

The publisher must return an idempotent, digest-verified artifact ID bound to task and source provenance. It receives the scope, snapshot, store fence, cancellation signal and immediate authorization recheck callback. **The callback alone is not atomic publication fencing.** The durable adapter must validate the same generation in its commit/publication owner and prevent a stale/deleted generation from publishing even when deletion races the last callback.

Before activation, parent-owned work must supply and qualify:

1. PostgreSQL implementation of the async cache contract: atomic reservation/commit/quota enforcement, serialized scope deletion, durable epochs and stale-writer rejection, bounded queries/timeouts and authorized scoped access. No process-local shadow authority.
2. Durable source/artifact publication, task/citation linkage, hash verification, idempotency, expiry cleanup and artifact quotas. Existing `Sources.cite` is not wired here; original source tests remain unchanged.
3. Durable deletion/retention intent and recovery. Persist the deletion cutoff/cleanup intent before acknowledging the store deletion; replay artifact cleanup after failure/crash. Cache deletion plus publisher deletion are not a cross-system transaction in this module. Automatic cache sweeping does not itself remove artifact blobs; the publisher/retention owner must honor snapshot expiry and clean all applicable copies. Handle publication failures after cache commit without inventing a verified artifact.
4. Existing Gate/runtime integration, actual account credential references, owner controls, task disable, kill-switch signals, exact-action tool registration and Tauri cache/research surfaces. This slice installs none of them.
5. Live authorized provider verification, remote target/redirect/rebinding behavior, usage/cost accounting, PostgreSQL restart/concurrency tests and final end-to-end acceptance.

No SQLite/legacy/global extension cache is imported. No schema migration is included. While unregistered, disable/rollback is simply leaving the module unregistered; it has no startup side effects. Once integrated, disable must revoke signals and prevent new reads/egress, while retention/deletion proceeds through the durable owner rather than abandoning stored sensitive content.

## Resumed validation evidence (before independent review)

After checking free storage (7,604,340 KiB available, above the 2 GiB stop threshold), ran:

```sh
npm run build && node --import tsx --test server/research/web-research.test.ts server/research/sources.test.ts
```

Exit **0**. TypeScript `tsc --noEmit` passed. **53 tests passed**: 52 new focused cases plus the existing source citation test; zero failures, skips, cancellations or todos. The resumed run includes the new stalled error-body cleanup regression, not only pre-checkpoint tests.

Focused cases cover cached expansion with no paid call, deterministic capped full/continuation pages, prompt-injection text as data, refresh/expiry/negative TTL, failure exclusions, quota overflow, cache-hit authorization, in-flight revocation/policy changes, pre-cancellation/kill switch, cross-identity/account/task/scope concurrency, stale independent-owner generations, deletion/publication cutoffs, malicious URLs/private DNS answers, oversized streaming, stalled credential cancellation and coalesced follower cancellation. Fixtures use injected HTTP responses/resolvers and fake authorization/publication adapters; they do not call the public network or start external services.

Final untracked-file whitespace, scope/status and unstaged-index checks are recorded in the accompanying builder report. No full backend suite, real PostgreSQL, runtime/UI, live provider or release qualification is claimed. Fresh independent/security review is required before integration.

## Independent-review lifecycle corrections and current validation

Read the complete fresh `research-review.md` (REQUEST_CHANGES). Its two P1 findings were **source-derived**, not reviewer-executed reproductions: DNS could outlive the transport-only timeout and permanently retain a flight; directly awaited authorization/publication could ignore caller cancellation and retain work. The earlier 53-test evidence above remains historical, not evidence that those gaps were covered.

This correction adds one configurable service deadline before initial authorization (and therefore before DNS), keeps it through all subsequent stages, and clears it on operation settlement. Authorization and publication are raced against the applicable cancellation/deadline signal. Storage waits are similarly bounded so a pending reservation/commit acknowledgement cannot retain a flight forever. Late dependency results do not resume the abandoned continuation or dispatch a provider request. Durable adapter fencing remains mandatory, and cancellation still does not prove an admitted mutation or remote request was rolled back.

Nine added regressions execute the required cases using deterministic Node mock timers and deferred adapters:

- Never-settling and late-settling resolver variants: deadline failure, `maxConcurrent: 1` slot recovery, and no provider dispatch for the expired operation even after late resolution.
- Stalled request authorization under explicit cancellation and deadline expiry: a different request succeeds **before** the grant resolves; the late grant cannot dispatch the abandoned request.
- Stalled initial authorization under both stop conditions: prompt rejection with no DNS/provider invocation after a late grant.
- Stalled publication under both stop conditions: no stale result on late acknowledgement; the callback/signal are fenced, but an intentionally uncooperative fake publisher can still finish its admitted effect. The test explicitly retains the already committed cache row rather than claiming rollback.
- Cache commit-acknowledgement cancellation: a stored row may exist, the flight slot is released, a different request succeeds, and the late acknowledgement cannot trigger publication/return for the cancelled caller.

Current executed validation command (cache creation disabled):

```sh
TSX_DISABLE_CACHE=1 npm run build && TSX_DISABLE_CACHE=1 node --import tsx --test server/research/web-research.test.ts server/research/sources.test.ts
```

Exit **0**: `tsc --noEmit` passed; **62 tests passed** (61 research cases plus the unchanged source citation test), with zero failures, cancellations, skips or todos. An earlier intermediate run in this correction passed 61 tests before the commit-acknowledgement regression was added. Mock timers demonstrate deadline behavior without live DNS/network calls or wall-clock sleep; these results do not qualify external adapters or PostgreSQL.

Only `web-research.ts`, `web-contracts.ts` contract comments, `web-research.test.ts` and this document changed in the review-fix round. The URL restriction and Cloud redirect/rebinding limitations above are unchanged. The two findings are addressed by implementation and executed regressions, **pending fresh independent verification**, not declared review-accepted. Runtime/UI registration, durable PostgreSQL/artifact integration, live provider qualification and full OP-032 acceptance remain parent gates.
