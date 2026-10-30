# Adoption execution status

**Programme approved:** 2026-10-30. **Branch:** `feat/outpost-adoption`.

## Current checkpoint

- Owner-supplied analyses and all 40 tickets preserved separately in `3c11251`.
- Fresh baseline: 40 backend tests pass; desktop frontend build passes; four Rust tests pass, one live test intentionally ignored.
- SSH identification found PostgreSQL 18.6, host-managed `18/main`, online on `surajhomeserver:5432` with SSL configured.
- Database login as the SSH user is unavailable (`role "surajadmin" does not exist`). No production modifications made. Local implementation can proceed independently.
- First delivery slice: remove legacy Swift Mac application/targets/build paths while retaining iPhone/shared code and Tauri identity. Independent PostgreSQL conversion investigation prepares T1.

## Acceptance tracking

| Work | Implementation | Verification | Release |
|---|---|---|---|
| Baseline and PostgreSQL identification | Recorded | Local baseline passed; SSH identification observed | Not a release qualification |
| T0a Swift Mac retirement | Queued for Astra builder/reviewer | Not run | Not assessed |
| T0b essential Tauri controls and qualified Auto default | Not started | Not run | Not assessed |
| T1 PostgreSQL foundation/import/recovery | Investigation queued | Not run | Live cutover gated |
| OP-001–OP-040 | Not started; coverage/order in programme | Not run | Not assessed |

A launch is not completion. Update individual tickets only after actual integration and evidence. Keep implementation, local/live verification and release acceptance distinct.

## External gates

Read-only SSH PostgreSQL identification is authorized and performed. Live PostgreSQL migration, database/role creation, remote service/network mutations, live provider/connector tests, broker hosting, release signing and recovery rehearsals still need their specific permissions/inputs. Do not use another application's credentials to work around the missing database role.

## Evidence

- [Baseline and PostgreSQL inventory](evidence/adoption/baseline-and-postgres.md)
- [Approved programme and full ticket coverage](ADOPTION-PROGRAMME.md)
