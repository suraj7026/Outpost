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
- Desktop administration, calendar and skills builders returned implementation reports; independent review remains pending. Research/PostgreSQL builders were asked to checkpoint. Safe recovery of the failed catalogue lane remains required.

## Acceptance tracking

| Work | Implementation | Verification | Release |
|---|---|---|---|
| Baseline and PostgreSQL identification | Recorded | Local baseline passed; SSH identification observed | Not a release qualification |
| T0a Swift Mac retirement | Integrated; independent review PASS | Integrated local checks passed | Not release qualification |
| T0b essential Tauri controls | Built in isolated worktree; review pending | Builder reports UI/Rust tests passed | Not assessed |
| T0b qualified Auto default | Core integration pending | Not run | Not assessed |
| T1 PostgreSQL foundation/import/recovery | Investigation complete; builder checkpoint requested | Not accepted | Live cutover gated |
| OP-031 catalogue service slice | Partial work preserved after ENOSPC | Failed run; review not started | Not assessed |
| OP-032 research service slice | Builder checkpoint requested | Not accepted | Not assessed |
| OP-004 calendar evaluator slice | Built in isolated worktree; review pending | Builder reports 18 new tests / 58 total passed | Not assessed |
| OP-007 approved-skill service slice | Built in isolated worktree; review pending | Builder reports 15 focused / 17 capability tests passed | Not assessed |
| OP-001–OP-040 full tickets | No end-to-end acceptance yet; partial slices above | Integration/verification pending | Not assessed |

A launch is not completion. Update individual tickets only after actual integration and evidence. Keep implementation, local/live verification and release acceptance distinct.

## External gates

Read-only SSH PostgreSQL identification is authorized and performed. Live PostgreSQL migration, database/role creation, remote service/network mutations, live provider/connector tests, broker hosting, release signing and recovery rehearsals still need their specific permissions/inputs. Do not use another application's credentials to work around the missing database role.

## Evidence

- [Baseline and PostgreSQL inventory](evidence/adoption/baseline-and-postgres.md)
- [T0a review, integrated tests and storage incident](evidence/adoption/t0a-retirement.md)
- [Approved programme and full ticket coverage](ADOPTION-PROGRAMME.md)
