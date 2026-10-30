# T1 PostgreSQL foundation — dormant module slice

Base: `eedfac8c88c38ee07d6761a4a66bdebdeda9830c`. This is **not T1 completion or a runtime cutover**. Existing `server/core/ledger.ts`, all consumers, wire signing/canonicalization and historical evidence are unchanged. Nothing routes requests to this store, mirrors writes, or silently falls back to SQLite.

## Implemented boundary

- `server/storage/contracts.ts`: entirely asynchronous reader, repository, explicit transaction/savepoint, coordinator ownership and outbox contracts. Mutations require a live ownership object belonging to the repository instance. No process-global nesting state, sync bridge, or promise/sync unions.
- `server/storage/migrations.ts`: version 1 namespaced tables, safe integer SQL constraints, unique record/receipt/event identities, outbox state/claim constraints and indexes. Migration is explicit, transactional and serialized by a separate advisory lock; `open()` verifies versions but never migrates. No extensions or roles are created.
- `server/storage/postgres.ts`: bounded `pg` pool, explicit endpoint/user/database/password configuration, verified TLS required for TCP, fixed search path and connection/query/statement/lock/idle-transaction timeouts. Driver errors never expose SQL, parameters, credentials or causes. Callback errors are sanitized at the transaction boundary. No automatic transaction retries.
- `server/storage/conversion.ts`: safe int8/counter conversion, canonical text JSON, rejection of unsafe integers and JSON numeric literals that lose decimal precision during parsing, and exact legacy millisecond UTC ISO timestamp text (no driver Date conversion). Existing signing/digest helpers remain unchanged.
- `server/testing/postgres-fixture.ts`: private `mkdtemp` cluster, private 0700 Unix socket, empty TCP listen addresses, explicit user/database, no ambient PG or database-URL endpoint selection. Cleanup stops/removes only the created cluster. The helper's binary directory argument permits another explicitly supplied local installation; tests currently use Homebrew PostgreSQL 16.

## API and integration rules

Call `PostgresRepository.migrate(config)` only against an explicitly approved dedicated destination, then `open(config)` and `acquireOwnership()`. The runtime connection configuration must be explicit; an empty password is supplied through a driver callback to prevent `PGPASSWORD` fallback. Pool configuration is built from supported fields only: surplus input properties such as `connectionString`, custom streams and logging hooks are not forwarded to the driver. TLS configuration is reconstructed with `rejectUnauthorized: true` and optional `ca` only; surplus identity-check hooks, server names, keys and certificates are not forwarded. Migration/runtime role separation remains a deployment integration gate; the foundation does not provision either role.

All compound work uses `transaction(owner, async tx => ...)`. `tx.accept(command, async nested => ...)` preserves the existing digest inputs (`type`, `aggregateId`, `expectedRevision`, `payload`), receipt key `(deviceId, idempotencyKey)`, and replay result. A matching receipt returns before apply; digest conflicts never apply. Receipts, guarded revisions, records, events and outbox intent share the transaction. `put` also freezes its canonical payload before awaiting SQL, so record/event payloads cannot diverge through mutation of caller objects.

Every callback must **await all repository work and contain no model, tool, provider, filesystem or other external effects**. The API does not sandbox callbacks. Mutating operations reject overlap, failed mutations poison their scope, and closed handles reject reuse. A savepoint receives its own handle, suspends the parent handle, and rolls back only its nested scope. Nested handles must not escape their callbacks. No root repository reads should be substituted for transaction-bound reads.

### Cursor proof

Writer, ownership and migration transactions explicitly begin with `READ COMMITTED READ WRITE`, independent of role/database defaults. Fresh statement snapshots after lock waits are necessary to see the predecessor's committed receipts, watermark and migration version. No hidden retries are added. Every mutation first locks the singleton `outpost_writer` row, before mutable reads or receipt lookup. Event cursors increment its watermark transactionally while that lock is held through commit. Thus B cannot allocate a higher cursor until A commits or rolls back; rollback also rolls back allocation. No sequence is used. `snapshot(kinds)` reads watermark and records within one `REPEATABLE READ READ ONLY` transaction, without the writer lock. `events(after, limit)` returns the unfiltered cursor-ordered page (1–1000 events); integration must advance through private-kind events before applying visibility filtering. Snapshot authorization still needs integration into the consistent read boundary; the foundation is not an authorization API.

This deliberately serializes writes. It is not HA or a throughput qualification. Lock/statement timeouts produce failures rather than hidden retries.

### Ownership and external effects

Ownership holds a dedicated session advisory lock and increments a durable epoch. A second repository/session cannot acquire it. Acquisition always sets dispatch hold and changes predecessor `claimed` rows to `unknown`; it never replays them. `owner.lost` resolves on connection loss/release, and `owner.active` becomes false. The cutover runtime must subscribe to loss, withdraw readiness, stop admission and abort/drain local work.

`claimOutbox(topics, limit)` requires dispatch explicitly enabled, claims only pending rows for explicitly selected topics, and stamps the epoch. There is no default topic selection (including no implicit notice dispatch). Claim and operation-running revision should be written in the **same transaction**. Execute the effect only after that transaction returns successfully, outside the DB. `finishOutbox(id, 'done' | 'unknown')` checks both claimed state and epoch and requires one affected row; operation completion belongs in that same transaction. Unknown rows have no automatic requeue API. The next cutover must provide owner-authorized reconciliation, including any downstream fence enforcement.

Advisory ownership/epochs do **not** stop an already-running external effect after a network partition. A lost claim/result commit acknowledgement is uncertain, not evidence of failure or permission to retry. Dispatch must remain held on takeover until previous effects are quiescent/reconciled. The loss signal is local observation, not a distributed exactly-once guarantee.

### Migration, retention, disable and rollback

The schema preserves generic record envelopes, canonical receipt/event JSON text and legacy timestamp format. It does not yet import SQLite, rebuild memory indexes, restore artifacts, or provide dump/restore tooling. Imported counters must pass `safeInteger` and schema constraints; imported JSON must pass loss-detecting parsing. Unsupported/unsafe source values fail closed, rather than being rounded. Import must preserve IDs/digests/receipts/timestamps, set the writer watermark to the maximum imported cursor and retain dispatch hold. A validated import/resume manifest, foreign/nonempty-destination rejection and tombstone retention remain later gates.

There is no retention/deletion policy implemented: records/events/receipts/outbox rows are retained. No production migration was run. Disable by leaving the module unreferenced (its current state); no legacy rollback is needed for this additive slice. Once a later cutover accepts PostgreSQL writes, switching back to stale SQLite is not an allowed rollback.

## Dependency evidence

`npm view pg version engines --json` reported `8.23.1`, Node `>=16.0.0`; `npm view @types/pg version --json` reported `8.23.1`. Both are exact manifest pins and lockfile-resolved. Verified installed with `npm ls pg @types/pg typescript tsx`, TypeScript 5.9.3, tsx 4.23.15, Node **26.3.0**. Only the worktree's `node_modules` symlink was unlinked before local installation; its target and `desktop/node_modules` were not modified. npm reported zero vulnerabilities at installation. Node 24 minimum-engine qualification has not been run.

## Local validation

The ENOSPC-resume checkpoint passed 18 focused / 58 full-suite tests. Fresh review then identified implicit transaction-default dependence and unrestricted configuration forwarding. The bounded correction adds explicit transaction modes and driver/TLS allowlists, with five new regression tests. Before the fix, all five new tests failed (18 passed / 5 failed); after it, the current source passes the checks below. No installation, dependency change or native build was needed for this correction; available disk remained above 5 GiB.

- `npm run build`: exit 0, strict TypeScript check including unchanged legacy runtime and new storage/fixture/tests.
- `./node_modules/.bin/tsx --test server/storage/postgres.test.ts`: exit 0, **23/23** passing; actual private PostgreSQL **16.15 (Homebrew)**, no TCP listener.
- `npm test`: exit 0, **63/63** passing (40 unchanged tests plus 23 storage tests).
- Fresh private-database connections verify `REPEATABLE READ` defaults. Both initial migrations are observed waiting on an advisory lock before release, and the second same-key command is observed waiting on the writer lock; both now succeed with one application. A separate read-only-default regression verifies actual schema creation, ownership epoch writes and record writes after explicitly setting write mode. Existing repeatable-read/read-only snapshot handling is unchanged.
- Configuration regression executes a private-fixture database selection with a surplus `connectionString`. A separate socket-free interception captures the actual pool options, then constructs the installed driver's client without calling `connect()` to verify approved host/database and certificate-verification fields remain intact despite surplus URL/TLS options. No alternate-network contact occurs. This is executed driver-boundary coverage, not a real TLS handshake or production certificate qualification.
- A new checked-out connection termination regression first reproduced an uncaught `pg` error event (exit 1, 17 passed/1 failed). Pool-created clients now handle these events without exposing driver details; subsequent work/commit rejects through the redacting query boundary. Final runs verify rollback, process survival and a successful fresh-connection transaction. This is backend termination coverage, not lost-commit-ack qualification.
- Concurrency tests observe actual second PostgreSQL sessions waiting on the writer row lock, rather than substituting mocked scheduling. Coverage: concurrent migrations, matching command one-apply/digest conflict, CAS one winner, independent rollback, record/event/receipt/outbox rollback, injected SQL failure redaction, nested savepoint and SQL-error isolation, closed handles, commit/rollback watermark overlap with snapshots and private-event pagination, ownership contention/loss during writes, checked-out transaction connection termination, durable takeover hold/unknown claims, epoch completion fences, atomic claim/operation changes, high imported counters and JSON precision boundaries.
- Normal fixture teardown left no `outpost-pg-*` temporary cluster directories. Tests perform no live provider/account calls or remote database access.

Only PostgreSQL 16.15 binaries were available in the checked Homebrew/Postgres.app locations; no PostgreSQL 18 fixture was started. These results are **not target PostgreSQL 18.6 qualification**. Competing ownership tests use separate real connections/repository instances in one test process, not two independently killed coordinator OS processes. No claim is made for kill-at-every-commit, lost-ack network fault injection, production TLS/role/capacity, importer/backup restoration, or end-to-end PostgreSQL product flows.

## Remaining integration gates

1. Fresh independent review and parent integration of this bounded slice.
2. One exclusive atomic async conversion of the full domain/gateway/runtime caller graph, authentication/revocation read boundaries, SSE/live publication, coordinator loss handling and effect gating. Current legacy runtime intentionally remains active.
3. PostgreSQL memory indexes, validated SQLite importer, backup/restore and cross-store artifact/session/workspace recovery; fault/crash and uncertain-effect rehearsals.
4. Node minimum-version and PostgreSQL 18.6 target qualification; dedicated role/database/TLS configuration, explicit production authorization, backup and maintenance window.
5. End-to-end T1 acceptance against PostgreSQL. Unit/module evidence here cannot satisfy those gates.
