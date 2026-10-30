# Adoption execution status

**Programme approved:** 2026-10-30. **Branch:** `feat/outpost-adoption`.

## Current checkpoint

- Owner-supplied analyses and all 40 tickets preserved separately in `3c11251`.
- Fresh baseline: 40 backend tests pass; desktop frontend build passes; four Rust tests pass, one live test intentionally ignored.
- SSH identification found PostgreSQL 18.6, host-managed `18/main`, online on `surajhomeserver:5432` with SSL configured.
- Database login as the SSH user is unavailable (`role "surajadmin" does not exist`). No production modifications made. Local implementation can proceed independently.
- First active workflow: Swift Mac retirement builder followed by independent review, plus PostgreSQL investigation (`28783f43-2081-4618-a2f6-1e7e55be29f5`).
- Owner requested broader parallel implementation: expanding to isolated Tauri administration, Ollama catalogue, web research, calendar recurrence and approved-skill builder lanes with fresh reviews. Database/core integration remains serialized. These are partial slices until integrated end-to-end; none is reported as a completed ticket.

## Acceptance tracking

| Work | Implementation | Verification | Release |
|---|---|---|---|
| Baseline and PostgreSQL identification | Recorded | Local baseline passed; SSH identification observed | Not a release qualification |
| T0a Swift Mac retirement | Astra builder active; review follows | Pending | Not assessed |
| T0b essential Tauri controls | Parallel builder lane prepared | Not run | Not assessed |
| T0b qualified Auto default | Core integration pending | Not run | Not assessed |
| T1 PostgreSQL foundation/import/recovery | Astra investigation active | Not run | Live cutover gated |
| OP-031 catalogue service slice | Parallel builder lane prepared | Not run | Not assessed |
| OP-032 research service slice | Parallel builder lane prepared | Not run | Not assessed |
| OP-004 calendar evaluator slice | Parallel builder lane prepared | Not run | Not assessed |
| OP-007 approved-skill service slice | Parallel builder lane prepared | Not run | Not assessed |
| OP-001–OP-040 | Not started; coverage/order in programme | Not run | Not assessed |

A launch is not completion. Update individual tickets only after actual integration and evidence. Keep implementation, local/live verification and release acceptance distinct.

## External gates

Read-only SSH PostgreSQL identification is authorized and performed. Live PostgreSQL migration, database/role creation, remote service/network mutations, live provider/connector tests, broker hosting, release signing and recovery rehearsals still need their specific permissions/inputs. Do not use another application's credentials to work around the missing database role.

## Evidence

- [Baseline and PostgreSQL inventory](evidence/adoption/baseline-and-postgres.md)
- [Approved programme and full ticket coverage](ADOPTION-PROGRAMME.md)
