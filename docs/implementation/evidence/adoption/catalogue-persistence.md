# Dormant PostgreSQL catalogue adapter integration

Integrated over `0784963` after fresh Astra reviewer `a8dda805-f9bb-4b77-b53c-48b501ba1da5` returned **PASS**, no P0/P1/P2 findings. Scope is the persistence adapter only, not runtime enablement or full OP-031 acceptance.

## Implementation and review

`PostgresCatalogueRepository` uses the injected existing repository and coordinator owner; it creates no second pool/authority, credential owner or cache. Durable namespaced metadata records preserve last-good snapshots, increment refresh fences atomically and validate exact scope, prior/next version and owner epoch before CAS publication. All operations await transaction settlement. The catalogue interface comment now states the reviewed pre-COMMIT-dispatch cancellation boundary and uncertain/confirmed post-dispatch outcomes accurately.

Three new adapter/test/documentation files and the contract comment are included. The prerequisite cancellation patch was already integrated once in `0784963`; parent checked all three storage files byte-identical to the adapter worktree and did not apply it again.

## Parent execution

- Corrected worktree: build passed; **72 adapter/catalogue/storage tests passed**, zero failures/skips. Logs and base evidence: `/tmp/outpost-catalogue-pg-parent.ixMy3s/`.
- Integrated branch: **`npm run check` passed TypeScript and 242 tests**, zero failures/cancellations/skips. Focused adapter/catalogue/storage suite: **72 passed**. `git diff --check` passed.
- Integrated logs: `/tmp/outpost-catalogue-persistence-integrated.TehwUQ/{check,focused}.log`.

Reviewer read source, assertions and parent logs but executed no commands. Actual database tests used private Unix-socket PostgreSQL **16.15/Homebrew** on Node **26.3.0**, never the live target. They exercise competing adapter transactions, stale scopes/versions/fences, ownership-backend termination, queued and in-write cancellation, and abort while actual COMMIT is blocked by a deferred constraint trigger. Last-good survives repository close/reopen; this is **not** a PostgreSQL-server restart or crash-recovery claim. Only HTTP provider responses were injected; SQL/repository behavior was real. Temporary paths are not durable backups.

## Open gates

The service may stop waiting before a transaction settles; a cancelled service result does not prove rollback. Re-read authoritative state after uncertain commit acknowledgement, never automatically replay a paid/provider request.

The adapter remains dormant until the PostgreSQL runtime owns lifecycle and authenticated account/scope/credential APIs, the picker uses exact identities and qualified capabilities, and restart/backup/commit-ack recovery is exercised. PostgreSQL 18.6, TLS/roles, live SDK/provider compatibility and release qualification remain outstanding. No cutover, model switch or deployment occurred.
