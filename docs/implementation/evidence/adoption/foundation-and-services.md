# Reviewed PostgreSQL foundation and service slices

**Accepted scope:** four additive module slices integrated over `01541b8`. None is a full adoption ticket, active PostgreSQL cutover, provider enablement or release qualification.

## Integrated slices and fresh reviews

| Slice | Fresh Astra reviewer | Verdict | Corrected findings |
|---|---|---|---|
| Dormant PostgreSQL repository | `ac03b278-6c20-4eae-87c6-8d5fce2adec1` | PASS | Explicit READ COMMITTED/READ WRITE for writers, ownership and migrations; allowlisted endpoint/TLS driver options. |
| OP-031 catalogue | `5ec4d601-bef1-415a-b46a-1de965cb2efc` | PASS | Response-body transport failures no longer mislabeled as malformed UTF-8. |
| OP-032 research | `4894ccb2-a3cd-4be5-8e63-8dbae5b3920a` | PASS | Service-wide finite deadline; cancellation-aware authorization, DNS, storage and publication waits; slot recovery and no late dispatch. |
| OP-007 approved skills | `143e2c08-e526-4cc0-8e02-dbc1ae6e0841` | PASS | Caller selection captured before validation/first await; no duplicate/size bypass through mutation. |

All source originated from isolated worktrees at `eedfac8c88c38ee07d6761a4a66bdebdeda9830c`. Parent captured HEAD/status/base-diff/addition inventories in `/tmp/outpost-fix-review.bvDRa7/`. Fresh reviewers inspected complete named source and regression assertions but had no command runner. Their verdicts do not independently establish executed tests.

Calendar was **not integrated**: its fresh review found stepped ranges can hide out-of-bound endpoints from Croner. Parent reproduced acceptance of `0-60/59 9 * * *`, `0 9 * 1-13/11 *` and `0 9 * * 0-8/5`. Evidence: `/tmp/outpost-calendar-bounds-repro.DvUHNl`. The prior lexical/timezone corrections alone are insufficient.

## Parent execution

Before integration, parent independently ran `npm run build` and these suites in each corrected worktree:

| Suite | Actual result | Raw log directory |
|---|---|---|
| PostgreSQL | 23 passed, none skipped | `/tmp/outpost-postgres-fixed-validation.eXdny8/` |
| Catalogue + existing Cloud regression | 31 passed, none skipped | `/tmp/outpost-catalogue-fixed-validation.yUrPNm/` |
| Research + existing citations regression | 62 passed, none skipped | `/tmp/outpost-research-fixed-validation.kZ0cAz/` |
| Skills / complete capabilities | 22 / 24 passed, none skipped | `/tmp/outpost-skills-fixed-validation.6n8uER/` |

Parent then integrated the exact 22 reviewed module/test/documentation additions and the PostgreSQL dependency delta. `pg` and `@types/pg` are pinned to **8.23.1**. `npm install --ignore-scripts --no-audit --no-fund` ran only in the main checkout's real `node_modules` directory; 15 packages were added and the resulting lockfile matched the reviewed PostgreSQL worktree byte-for-byte. No install ran through a worktree symlink.

**Integrated `npm run check`: TypeScript passed; 180 tests passed, zero failures/cancellations/skips.** Raw log: `/tmp/outpost-four-slices-integrated-check.log`. `git diff --check` passed. Calendar dependencies are not included yet.

Execution used Node **26.3.0** and disposable private Unix-socket-only PostgreSQL **16.15**, not the target PostgreSQL 18.6. Fixture tests exercised actual overlapping transactions, migration lock waits, nondefault isolation/read-only settings, backend termination, commit-safe cursors and fenced outbox ownership. Fixture roots were cleaned up. Endpoint/TLS regression interception made no alternate-network connections and is not TLS handshake evidence. Catalogue/research used injected provider fixtures, not real accounts. Skills used disposable approved bundles, not owner skills.

Temporary artifacts are local debugging evidence, not durable backups; portable outcomes are recorded here.

## Deliberately remaining work

- PostgreSQL remains dormant. The active coordinator still uses SQLite until serialized asynchronous caller conversion, import and recovery are completed. There is no dual-write/shadow authority or silent PostgreSQL fallback.
- The catalogue still needs its durable repository, authenticated APIs, exact-identity picker/runtime integration and live pinned-SDK qualification. Advertised tools/thinking is not qualification.
- Research still needs durable cache/artifact fencing, citation/retention/deletion/recovery, the common Gate and Tauri runtime integration. Cancellation ends a wait, not an already admitted effect or uncertain commit. Downstream Cloud redirect/DNS confinement is unproven; query/fragment URLs remain conservatively refused.
- Skills still need the durable approved registry, common-gate async loading, durable run pins, final-effect revocation enforcement and administration/evidence UI. Native Pi discovery stays empty. Trusted immutable roots remain required; loaded model context cannot be revoked retroactively.
- Qualified Auto defaults, remaining ticket tranches, target PostgreSQL/Node versions, crash/commit-ack recovery, live providers, native accessibility, signing and deployment remain separate gates.

Detailed contracts and constraints: [PostgreSQL](../../slices/t1-postgres-foundation.md), [catalogue](../../slices/op031-catalogue.md), [research](../../slices/op032-research.md), [skills](../../slices/op007-skills.md).
