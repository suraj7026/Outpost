# Adoption execution status

**Programme approved:** 2026-10-30. **Branch:** `feat/outpost-adoption`.

## Current checkpoint

- Owner-supplied analyses and all 40 tickets preserved separately in `3c11251`.
- Fresh baseline: 40 backend tests pass; desktop frontend build passes; four Rust tests pass, one live test intentionally ignored.
- SSH identification found PostgreSQL 18.6, host-managed `18/main`, online on `surajhomeserver:5432` with SSL configured.
- Database login as the SSH user is unavailable (`role "surajadmin" does not exist`). No production modifications made. Local implementation can proceed independently.
- T0a Swift Mac retirement passed independent Astra review and integrated-branch revalidation: 44 backend tests, 3 shared Swift tests, 4 Rust tests and frontend build passed; live Rust test ignored. Source/targets/build paths removed, iPhone/shared resources and Tauri identity preserved.
- PostgreSQL investigation completed; the foundation builder and five other additive/desktop builders launched in workflow `8ab2b7d9-f3ca-402d-8e7e-b68024c92a6d`. Database/core integration remains serialized; no adoption ticket is yet end-to-end accepted.
- Storage incident: catalogue child `6c1d5e68-3bb7-44a9-b9c9-b09cec0687b8` failed with ENOSPC; partial source captured and running siblings asked to checkpoint. Removed only 2.3 GB of generated Rust output from the finished T0a worktree; free disk recovered to about 4.3 GiB. Heavy native builds will run serially. No alternate model/runner used.
- Recovery/review workflow `d08aee86-71fe-4120-a08f-9277a713f06f` completed: PostgreSQL/research resumed successfully; the single authorized same-runner Astra catalogue recovery found no source truncation. Fresh reviews finished for all six slices. Free disk was about 5.2 GiB after integrated desktop checks; heavy native builds remain serialized.
- T0b essential administration passed independent Astra review and integrated parent validation: 44 backend tests, frontend build, synthetic IPC browser scenarios and 7 Rust tests passed; 1 live Rust test ignored. Active documentation no longer describes these controls as missing. Qualified Auto remains pending.
- Calendar (cron/timezone validation), skills (caller-selection mutation), PostgreSQL (isolation/configuration boundary), and research (bounded cancellation/dependency waits) received REQUEST_CHANGES. Parent independently reproduced calendar and skills defects. Catalogue passed with a nonblocking body-error classification note; it will also be corrected before integration.
- Corrective workflow `a9f34da6-0eb3-4b6f-9bf8-3c43041bb4fe` completed. Fresh reviews PASS for PostgreSQL, catalogue, research and skills; these four additive slices are integrated. Parent independently reproduced focused checks and integrated `npm run check`: TypeScript and **180 tests passed**, none skipped. PostgreSQL remains dormant; no live services/providers or cutover were touched.
- Calendar's second correction passed fresh independent review and is integrated as an unwired calculation slice. Parent verified strict endpoint/atom bounds and exact dependency reconciliation; integrated TypeScript and **212 tests passed**, plus 33 focused calendar/scheduler tests. Dispatch/UI/end-to-end OP-004 acceptance remains pending. No automatic retry or alternate model/runner is authorized on infrastructure failure.
- Next dependency wave `443863c1-f5f3-4c5f-bb6e-89256088cb8d` launched from integrated base `2b289c03877ac1a2af4188ecf8b0ac02ef7ba47b`: one exclusive coherent PostgreSQL caller-conversion writer; isolated catalogue/skills PostgreSQL adapter writers; read-only import/recovery and research cache/publication scouts; and a fresh bounded calendar endpoint fix on its original worktree. Each builder has a fresh review stage. No launch counts as completion or authorization for live activation.
- Core/catalogue adapter workers stopped before edits when the bundled finder failed `spawn Unknown system error -86`. Parent verified both worktrees unchanged except original dependency symlinks and captured `/tmp/outpost-core-pg-finder-failure.qb7uLe/` and `/tmp/outpost-catalogue-pg-finder-failure.3naKic/`. One explicit same-model/native-runner continuation per affected lane was authorized using known paths/ordinary read tools, with no finder retry or alternate CLI. Siblings were warned not to invoke the broken finder. Further infrastructure failure stops the affected lane.
- Catalogue persistence exposed a shared cancellation-contract gap. Parent approved a core checkpoint limited to optional transaction cancellation through the pre-COMMIT-dispatch boundary, rather than partially converting the caller graph. The prerequisite passed fresh review and is integrated; parent combined calendar/skills/cancellation check passed TypeScript and **229 tests**, plus 64 focused capabilities/storage tests and a deploy-verifier type-check (no live execution). Once COMMIT is dispatched, cancellation cannot establish rollback; owned settlement stays bounded by database timeouts, with no detached writes or automatic retries. Catalogue received the exact core prerequisite patch for adapter validation. Disk was 4.9 GiB at the incident checkpoint.
- Skills durable registry passed fresh review and is integrated dormant, including immutable pins, monotonic revocation/deletion, CAS and atomic audit. Catalogue persistence also passed fresh review and is integrated dormant. Final parent check: TypeScript and **242 tests passed**, zero skips; focused catalogue/adapter/storage **72 passed**. Dependency wave `443863c1-f5f3-4c5f-bb6e-89256088cb8d` is complete; accepted slices do not constitute full runtime conversion. Import/research scouts completed design handoffs, not implementations. The import scout's alleged seven-byte OUTPOST1 defect was independently disproven: magic is eight bytes and existing backup round-trip passed; no offset change authorized.
- Source-only import corrections passed fresh independent review (`54a6b224-339b-4301-842c-1fe4024bd1c8`) and are integrated. Parent verified all eight file hashes and passed the integrated build and serial full suite: **271 passed, 1 skipped, zero failures** (272 total). The raw `ff` filename fixture cannot run on this filesystem (`EILSEQ`); actual production byte-decoder and synthetic enumeration tests passed. Worktree evidence remains `/tmp/outpost-import-fix-parent.dmab1g/`; integrated logs `/tmp/outpost-import-integrated.l5glzZ/`. The eight-byte OUTPOST1 format is preserved. No target connection/apply or full T1 acceptance is implemented.
- Workflow `3cbd99ba-e7c1-4278-a6ac-de66090776a7` now runs the importer corrections/re-review alongside actual caller conversion from `a49a8d900d079f289032cd04f38921013b793fc3` in a new isolated runtime worktree. Three dependent same-writer passes cover domain transactions, gateway/runtime/startup, and integrated verification; two fresh reviewers then inspect correctness and races/security. Partial graph checkpoints stay private and cannot be merged or called complete. Domain pass completed with builder-reported 63 domain/storage and 24 adapter tests passing; gateway/runtime conversion continues privately. Legacy archive assertions may be split from real-PG hold/resume assertions, but archive-to-running-PG continuity remains an explicit missing gate, not replaced evidence. No new live permissions were granted.
- Resource checkpoint: free disk dropped below 2 GiB; runtime worker stopped new tests after fixture teardown. Parent verified no active Rust builds and removed only untracked generated Rust targets from the completed desktop worktree and main checkout, preserving source/evidence (`/tmp/outpost-disk-checkpoint.teIqAv/`). Headroom recovered to approximately 4.6–4.9 GiB; serial tests resumed, native builds remain paused.
- Owner renewed delegation to complete the programme. Workflow `7b8d9e07-240e-4a15-8bd5-816d6930d489` adds isolated attention-board, workspace-lifecycle and metrics builders, each with fresh review, plus a read-only runtime/service integration scout. Base `5d22355840919e4b84b57de0e9b2dab935e048a4`. Core/schema/runtime ownership stays with the existing PostgreSQL writer. New mutation-heavy slices remain private pending T1 gates; launch is not acceptance.

## Acceptance tracking

| Work | Implementation | Verification | Release |
|---|---|---|---|
| Baseline and PostgreSQL identification | Recorded | Local baseline passed; SSH identification observed | Not a release qualification |
| T0a Swift Mac retirement | Integrated; independent review PASS | Integrated local checks passed | Not release qualification |
| T0b essential Tauri controls | Integrated; independent review PASS | Parent backend/frontend/browser/Rust checks passed | Live/native/recovery gates remain |
| T0b qualified Auto default | Core integration pending | Not run | Not assessed |
| T1 PostgreSQL foundation/import/recovery | Dormant foundation/cancellation and source-only inventory integrated; actual caller conversion in isolated staged work; destination import/PG recovery absent | Fresh review PASS; parent 23-test fixture suite and integrated check passed | Live cutover gated; PostgreSQL 18.6 unqualified |
| OP-031 catalogue service slice | Reviewed module and dormant durable adapter integrated; runtime/UI pending | Fresh review PASS; parent focused/integrated checks passed | Not assessed |
| OP-032 research service slice | Reviewed module integrated; durable cache/publication design underway; runtime/UI pending | Fresh review PASS; parent focused/integrated checks passed | Not assessed |
| OP-004 calendar evaluator slice | Reviewed calculation module integrated; dispatch/runtime/UI pending | Fresh review PASS; parent 33 focused and 212 integrated tests passed | Not assessed |
| OP-007 approved-skill service slice | Reviewed module and dormant durable registry integrated; runtime/UI pending | Fresh review PASS; parent focused/integrated checks passed | Not assessed |
| OP-001–OP-040 full tickets | No end-to-end acceptance yet; partial slices above | Integration/verification pending | Not assessed |

A launch is not completion. Update individual tickets only after actual integration and evidence. Keep implementation, local/live verification and release acceptance distinct.

## External gates

Read-only SSH PostgreSQL identification is authorized and performed. Live PostgreSQL migration, database/role creation, remote service/network mutations, live provider/connector tests, broker hosting, release signing and recovery rehearsals still need their specific permissions/inputs. Do not use another application's credentials to work around the missing database role.

## Evidence

- [Baseline and PostgreSQL inventory](evidence/adoption/baseline-and-postgres.md)
- [T0a review, integrated tests and storage incident](evidence/adoption/t0a-retirement.md)
- [T0b administration review and integrated tests](evidence/adoption/t0b-administration.md)
- [PostgreSQL foundation and services: reviews and 180-test integration](evidence/adoption/foundation-and-services.md)
- [Calendar, skills persistence and cancellation: 229-test integration and import decisions](evidence/adoption/calendar-and-persistence-checkpoint.md)
- [Catalogue persistence and final 242-test integration](evidence/adoption/catalogue-persistence.md)
- [Source-only import review and 271-pass/1-skip integration](evidence/adoption/import-source.md)
- [Approved programme and full ticket coverage](ADOPTION-PROGRAMME.md)
