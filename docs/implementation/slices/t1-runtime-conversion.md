# T1 runtime conversion — cancellation prerequisite checkpoint

Base: `2b289c03877ac1a2af4188ecf8b0ac02ef7ba47b`.

**Implementation: in progress. Verification: cancellation prerequisite locally verified; runtime conversion not implemented. Release: blocked.** This checkpoint does not cut over the runtime, qualify T1, or make the existing SQLite runtime an acceptable PostgreSQL fallback. The parent explicitly bounded this pass to the shared cancellation seam plus evidence, with the complete caller conversion reserved for the next pass. No partial caller conversion, dependency changes, production migrations, or deployment changes were made.

Read with [the dormant foundation contract](t1-postgres-foundation.md) and [the programme](../ADOPTION-PROGRAMME.md). Preserve the existing signed-byte/canonicalization, ID/digest, command receipt and revision contracts throughout the later conversion.

## Implemented shared API

`server/storage/contracts.ts` exports:

```ts
export interface TransactionOptions { signal?: AbortSignal }
// Optional third argument; existing callers remain valid.
transaction<T>(owner: CoordinatorOwnership,
  apply: (tx: RepositoryTransaction) => Promise<T>,
  options?: TransactionOptions): Promise<T>;
```

`PostgresRepository` captures the signal before awaiting checkout and passes it to transaction/savepoint handles. An observed abort raises the redacted `Fault` code `transaction_cancelled`; the caller's abort reason is never surfaced. Checks run before checkout, after checkout/BEGIN, before callback admission after the writer lock, before and after awaited transaction SQL/mutation work, through savepoints, and synchronously immediately before COMMIT dispatch. Catching a cancellation inside the callback cannot permit commit: the signal remains aborted and `assertSettled` rechecks it.

Cancellation is **cooperative, not a detached write deadline**. Already-dispatched SQL settles under the existing driver/database timeouts before rollback/return. Callbacks must await all repository work and contain no external effects. Arbitrary callback promises are not forcibly interrupted or timed out; callers must not pass never-settling work or race a write against a timer and abandon ownership of its settlement.

Once COMMIT has been dispatched, the repository awaits it without checking the abort signal afterward. A confirmed commit returns its normal result even if cancellation arrives while COMMIT is pending. Failure or lost acknowledgement at that boundary remains a potentially committed `database_error`, not proof of rollback or authority to retry. The existing rollback cleanup is best effort and cannot reverse a committed transaction. No automatic retry or SQL cancellation protocol was added. Ownership fencing and database timeouts are retained.

No schema/data migration is required for this API addition. Disabling its use means omitting the optional argument; existing transaction callers remain unchanged. This does not relax the prohibition on reverting to stale SQLite after a future PostgreSQL cutover.

## Actual evidence

Six new regressions in `server/storage/postgres.test.ts` run inside the real private PostgreSQL fixture:

1. Pre-aborted request checks out no connection and invokes no callback (the connection method is intercepted only to assert it is never called).
2. Abort during an observed PostgreSQL writer-row lock wait skips the cancelled callback, preserving the independent writer.
3. Abort after receipt/record/event/outbox writes, even with a caught rejection, rolls everything and the watermark back. A subsequent no-signal transaction succeeds.
4. Nested savepoints inherit cancellation; swallowing a child rejection cannot commit the parent.
5. Abort while a SELECT is blocked on an actual table lock waits for query settlement and does not return rows to the callback.
6. A deferred PostgreSQL constraint trigger blocks COMMIT on an advisory lock. Aborting after the server is observed executing COMMIT does not settle early; releasing the fixture lock confirms the commit and normal return value.

Commands executed in this worktree:

- `npm run build`: exit 0.
- `./node_modules/.bin/tsx --test server/storage/postgres.test.ts`: exit 0, **29/29** tests.
- `npm run check`: exit 0, **186/186** tests, no failures/skips/cancellations. This includes unchanged SQLite product tests and additive feature tests; it is **not** 186 PostgreSQL product-flow tests.
- `./node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --strict --skipLibCheck deploy/agent/verify-live.ts deploy/agent/verify-stream.ts`: exit 0; type-check only, neither verifier executed.
- `git diff --check`: exit 0. Index empty; no files staged, no commits/pushes.

Private fixture: PostgreSQL **16.15 (Homebrew)**, unique private Unix socket, no TCP listener or ambient endpoint. Production PostgreSQL 18.6/TLS/roles and commit-ack loss remain unqualified. Raw command output is retained in the builder report and `/tmp/outpost-t1-runtime-evidence/{build-cancellation,postgres-cancellation,check-cancellation,deploy-typecheck}.log` (machine-local evidence, not portable repository assets).

Integration patch (three storage files only): `/tmp/outpost-t1-runtime-evidence/cancellation-prerequisite.patch`, SHA-256 `748e917f5f0888c4c46a334072a5516e83f7ac0fd80cd37aa2f4e2a9d21b2fd9`. This document is separate from that shared patch. Independent review and parent integration are still required.

## Exact remaining caller graph / open gates

The following remain **unchanged legacy synchronous consumers**, not converted flows:

- Authority/entry: `server/core/ledger.ts`, `server/gateway/{coordinator,http,live}.ts`, `server/policy/trust.ts`, `server/main.ts`.
- Domain mutations: `server/tasks/tasks.ts`, `server/scheduler/scheduler.ts`, `server/brokers/{identities,payments}.ts`, `server/workers/coordination.ts`, `server/browser/{browser,assistance}.ts`, `server/communication/drafts.ts`, `server/delivery/operations.ts`, `server/notifier/apns.ts`, `server/operations/health.ts`, `server/workflows/recipes.ts`, `server/research/sources.ts`, and the legacy `server/capabilities/catalogue.ts` (distinct from the additive model catalogue).
- Cross-store/index: `server/artifacts/files.ts`, `server/memory/memory.ts`, `server/reliability/backup.ts`.
- Async callers and indirect effects: `server/pi-adapter/{runtime,live-events}.ts`, `server/browser/browser-use.ts`; deployment verifiers `deploy/agent/{verify-live,verify-stream}.ts` still depend on SQLite and must not become alternate PostgreSQL writers.
- Existing tests for all of the above still use their original storage contract; conversion must await assertions and cleanup and retain all existing coverage. No tests were deleted or disabled here.

The next exclusive pass must convert the graph together, not route only some mutations to PostgreSQL:

1. Bind each compound mutation to an explicit transaction context, rechecking mutable authority/revisions after every relevant external await. Keep providers/tools/network/filesystem effects outside DB transactions. Preserve atomic commands/records/events/outbox/search updates and the existing watermark proof.
2. Serialize first-device bootstrap in the DB; authenticate original signed bytes and recheck revocation within command/read authorization boundaries. Add signed same-key/CAS/revocation/pairing concurrency tests.
3. Move constructor recovery to async initialization after coordinator ownership. Atomically claim outbox and operation state, fence completion by epoch, preserve hold/unknown semantics. Subscribe to ownership loss to stop admission and local effects; do not treat a lost claim or result acknowledgement as permission to replay.
4. Reserve per-task Pi ownership before the first await, persist mapping before accepting further input, release on failure, and retain local task/controller associations for immediate abort. Split external effect failure from observation-commit failure.
5. Make snapshots/SSE asynchronous with subscribe-before-snapshot buffering, close cleanup before awaits, bounded single-flight persistence/poll queues, revision/generation ordering, revocation rechecks, and finalization that cannot be overwritten by a late checkpoint. Preserve filtered-event cursor progression and redacted reasoning exclusions.
6. Add explicit versioned PostgreSQL scoped text-search baseline without extensions: scope filters, deterministic ranking/ties, identifier/punctuation behavior, bounded results, atomic forget and tombstone-safe rebuild. No FTS work was added in this pass.
7. Stage/checksum immutable artifact bytes outside transactions, reconcile rename/metadata failures and browser-session compensation/lease execution. Preserve backup APIs honestly; coordinate separately prepared legacy import and PostgreSQL dump/restore contracts with the parent. Current backup remains the unchanged SQLite API, not a PostgreSQL backup.
8. Make startup/shutdown async and endpoint configuration explicit verified TLS/private socket; absent config must fail closed after cutover. No implicit runtime migration/cutover, silent SQLite fallback, destructive migration, or deploy-verifier execution. Drain/fence shutdown work within a bounded deadline, leaving uncertain work recoverable.
9. Real private-PG product tests, overlapping snapshot/delta schedules, ownership-loss/claim/result commit faults, bounded SSE/queue tests, crash boundaries for scheduler/files/session mapping and shutdown, imported receipts/cursors/revocations and full backup restoration are still required. Keep root build/check green at the integrated boundary. Node minimum-version and target PostgreSQL qualification remain open.

The additive model catalogue, skills and web-research modules and desktop/UI were not edited. Their adapters remain separately owned; this optional cancellation API is the shared prerequisite, not permission to implement a second variant.

## Run constraints and infrastructure incident

Disk was checked before work and tests and after validation: **4.9 GiB free**, above the 2 GiB stop threshold. Existing `node_modules` and `desktop/node_modules` symlinks were read-only and remain untracked; no dependency/shared-directory changes were made.

Initial file discovery using `functions.find` failed with `spawn Unknown system error -86`. The lane stopped and reported it immediately. The parent verified the untouched worktree, retained checkpoint `/tmp/outpost-core-pg-finder-failure.qb7uLe/`, and explicitly authorized one continuation on the same native runner/model using supplied exact storage paths and normal bash inspection, without retrying the failed tool or switching runners/providers. No later infrastructure failure occurred. The parent then explicitly selected this isolated prerequisite checkpoint instead of a partial runtime conversion.
