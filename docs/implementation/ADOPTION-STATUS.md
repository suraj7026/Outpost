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
- Calendar remains blocked: the corrective review found out-of-range stepped endpoints still accepted by Croner. Parent reproduced minute 60/month 13/weekday 8 acceptance; another bounded validation correction and fresh review are required. No automatic retry or alternate model/runner is authorized on infrastructure failure.

## Acceptance tracking

| Work | Implementation | Verification | Release |
|---|---|---|---|
| Baseline and PostgreSQL identification | Recorded | Local baseline passed; SSH identification observed | Not a release qualification |
| T0a Swift Mac retirement | Integrated; independent review PASS | Integrated local checks passed | Not release qualification |
| T0b essential Tauri controls | Integrated; independent review PASS | Parent backend/frontend/browser/Rust checks passed | Live/native/recovery gates remain |
| T0b qualified Auto default | Core integration pending | Not run | Not assessed |
| T1 PostgreSQL foundation/import/recovery | Reviewed dormant foundation integrated; caller conversion/import pending | Fresh review PASS; parent 23-test fixture suite and integrated check passed | Live cutover gated; PostgreSQL 18.6 unqualified |
| OP-031 catalogue service slice | Reviewed module integrated; durable/runtime/UI wiring pending | Fresh review PASS; parent focused/integrated checks passed | Not assessed |
| OP-032 research service slice | Reviewed module integrated; durable/runtime/UI wiring pending | Fresh review PASS; parent focused/integrated checks passed | Not assessed |
| OP-004 calendar evaluator slice | Built; residual stepped-range endpoint defect blocks integration | Corrective review REQUEST_CHANGES; parent reproduction confirmed | Not assessed |
| OP-007 approved-skill service slice | Reviewed module integrated; durable/runtime/UI wiring pending | Fresh review PASS; parent focused/integrated checks passed | Not assessed |
| OP-001–OP-040 full tickets | No end-to-end acceptance yet; partial slices above | Integration/verification pending | Not assessed |

A launch is not completion. Update individual tickets only after actual integration and evidence. Keep implementation, local/live verification and release acceptance distinct.

## External gates

Read-only SSH PostgreSQL identification is authorized and performed. Live PostgreSQL migration, database/role creation, remote service/network mutations, live provider/connector tests, broker hosting, release signing and recovery rehearsals still need their specific permissions/inputs. Do not use another application's credentials to work around the missing database role.

## Evidence

- [Baseline and PostgreSQL inventory](evidence/adoption/baseline-and-postgres.md)
- [T0a review, integrated tests and storage incident](evidence/adoption/t0a-retirement.md)
- [T0b administration review and integrated tests](evidence/adoption/t0b-administration.md)
- [PostgreSQL foundation and services: reviews and 180-test integration](evidence/adoption/foundation-and-services.md)
- [Approved programme and full ticket coverage](ADOPTION-PROGRAMME.md)
