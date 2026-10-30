# OP-031 dormant durable catalogue repository

Base: `2b289c03877ac1a2af4188ecf8b0ac02ef7ba47b`. This additive slice is **not runtime wiring, full OP-031 acceptance, live qualification, or a database cutover**. Source contracts: the approved adoption programme, `op031-catalogue.md`, `catalogue-types.ts`, `catalogue.ts`, and the existing async storage contracts/implementation. No upstream implementation is copied.

## Authority and storage

`new PostgresCatalogueRepository(repository, owner)` takes the existing `Repository` and its current `CoordinatorOwnership`. It creates neither a connection pool nor an ownership lease. Two adapters share that one authority. All three methods, including offline `load`, use serialized owner transactions; offline reads therefore require active coordinator ownership. No transport, credential lookup, runtime caller, SQLite fallback, secondary cache or automatic retry is added.

The generic record kind is `models.catalogue`, keyed by the exact canonical `catalogueKey` (provider kind/account/origin). Record data is `{schemaVersion: 1, fence, snapshot}`. The safe-integer fence increments atomically on `beginRefresh`; exhaustion fails closed rather than rounding or resetting. The returned opaque generation contains scope key, fence, exact prior snapshot version and owner epoch. It is a freshness token, not a credential or an authorization grant. Record revisions are independently enforced by `tx.put` compare-and-swap.

`beginRefresh` preserves/returns last-good in the same transaction as the fence increment. `publish` validates and defensively copies the supplied snapshot, checks key identity, generation scope/epoch, durable fence and exact prior version, then awaits the versioned-record transaction commit. A stale/malformed generation or version mismatch returns false; malformed keys, snapshots and stored data fail closed. No absent/corrupt storage is silently converted into a successful empty cache. A genuine missing record returns null. Snapshot completeness is decided by the existing service (no partial metadata publication); the adapter enforces snapshot schema and identity, not provider truthfulness.

Every successful reservation/publication also uses the core's existing event/cursor behavior. The adapter does not introduce a separate history table, credentials or retention owner. Last-good remains until a complete successful publication; abandoned reservations persist across restart. Old-owner generation tokens cannot publish under a successor even when no newer reservation exists.

## Cancellation boundary and core prerequisite

The base `Repository.transaction(owner, apply)` lacks a signal/commit-dispatch hook. A wrapper racing a signal against the transaction would leak unowned writes and falsely imply rollback. This limitation was reported before implementation. The parent approved the following narrow contract correction and a separately owned core prerequisite: optional transaction options `{signal?: AbortSignal}`, with cancellation checks before/within work and immediately before COMMIT dispatch.

Cancellation observed before COMMIT dispatch prevents publication and awaits rollback/settlement. Once COMMIT is dispatched, cancellation cannot prove rollback: a successful commit may still occur and its acknowledgement can be uncertain. The adapter **never detaches or retries a mutation** and does not relabel a known successful commit as rolled back just because the signal subsequently aborted. All operations await owned settlement under the core's finite pool/query/lock timeouts; cancellation is not a promise of instantaneous return. On uncertain storage failure/cancelled service result, re-read authoritative storage. `CatalogueService` still bounds its own caller wait; its cancelled result is not proof of database rollback.

Only the cancellation comment in `catalogue-types.ts` is changed under explicit parent approval; no service, core implementation, schema, dependency or runtime wiring is authored by this lane. For local validation the parent explicitly authorized applying its core prerequisite patch to `server/storage/{contracts.ts,postgres.ts,postgres.test.ts}`; SHA-256 `748e917f5f0888c4c46a334072a5516e83f7ac0fd80cd37aa2f4e2a9d21b2fd9` was verified before `git apply --check`/apply. Those changes are a separate dependency, not duplicate catalogue-owned edits. The old slice document's stronger commit-linearization wording is superseded by this explicit dispatch/settlement boundary, not silently implemented with a second authority.

## Migration, privacy and disable/recovery

No schema migration or automatic startup action is required beyond the already migrated generic repository. Metadata is written only by an explicit adapter caller. Identity account IDs must be opaque non-secret scope IDs. Credentials are not accepted by the adapter; strict snapshot/state schemas reject extra fields, and the service passes credentials only to its injected transport. Metadata, model IDs and evidence references remain untrusted display data, not authority.

The module is dormant and can be disabled by not constructing it. Disabling does not delete last-good metadata or rewind the durable fence. Reopen under the successor core owner and re-read; do not reset fences, replay stale generations, or revert to SQLite. Existing core backup/restore and event retention owners apply to these generic records/events; this slice adds no purge API or private backup path.

## Verification status

The 13 tests in `server/models/catalogue-postgres.test.ts` exercised actual disposable PostgreSQL **16.15 (Homebrew)**, private Unix sockets only, with two adapter instances and real transactions. Coverage includes writer-lock contention, exact fence/version/scope/owner matching, queued and within-write cancellation, owner connection loss, repository restart, corrupted state, overflow, incomplete metadata and cross-service refresh/cancel races. A deferred PostgreSQL constraint trigger blocks actual COMMIT; cancellation then leaves the adapter pending until settlement and returns true for the confirmed commit. No mocked repository or transaction is used. Only HTTP is injected. No ambient/shared endpoint or live provider is accessed.

Final executed validation with the prerequisite applied:

- `npm run build`: exit 0, full backend `tsc --noEmit`.
- `./node_modules/.bin/tsx --test server/models/catalogue-postgres.test.ts server/models/catalogue.test.ts server/storage/postgres.test.ts`: exit 0, **72 passed**, 0 failed/cancelled/skipped (13 new adapter, 30 existing catalogue, 29 core tests).
- `npm test`: exit 0, **199 passed**, 0 failed/cancelled/skipped.
- `git diff --check`: exit 0; `git diff --cached --name-only`: empty. The three new files are untracked pending parent review/integration; nothing was staged or committed.
- Raw build/focused/full logs retained at `/tmp/outpost-catalogue-pg-validation/{build-final,focused-final,full-final}.log` and embedded in the assigned builder report. Earlier successful runs are also retained in that directory; the final test revision replaces a post-commit delivery hook with a stronger actual COMMIT-wait fixture.
- Free disk was checked before work and each testing phase: 4.9 GiB initially, 5.1 GiB at final validation; no low-space checkpoint was triggered. Dependency symlinks were read-only, no install/native build occurred.

Infrastructure checkpoint: the initial `functions.find` invocation failed `spawn Unknown system error -86` before edits/tests. The lane stopped and reported it. The parent explicitly authorized one continuation on the same runner using direct reads/ordinary shell inspection, never the broken finder. No further infrastructure failure occurred.

Remaining gates: independent review of both adapter and core prerequisite, parent integrated validation, coordinator lifecycle/API/credentials wiring, Tauri picker, live inference qualification under separate permission, retention/recovery qualification and full OP-031 acceptance. Repository reopen evidence is not a full PostgreSQL server crash/restore or lost-COMMIT-ack simulation. This slice verifies confirmed commit during cancellation, not network-induced uncertain commit outcome.
