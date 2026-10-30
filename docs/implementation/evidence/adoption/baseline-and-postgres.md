# Adoption baseline and PostgreSQL identification

Captured 2026-10-30 by the parent session. Tests ran on source `e9af739` with the owner-supplied documentation changes; no application source had changed. These are observed local results, not release qualification.

## Fresh local baseline

| Command | Observed result |
|---|---|
| `npm run check` | TypeScript passed; all 40 backend tests passed, zero skipped/failed. Included local HTTP, Pi fixture, Chromium, policy and recovery tests. |
| `npm --prefix desktop run build` | TypeScript/Vite production build passed. Two existing Lucide `use client` bundler warnings; not test failures. |
| `cargo test --manifest-path desktop/src-tauri/Cargo.toml` | Four deterministic tests passed; one live private-server test intentionally ignored. |

Not run: live inference, live paired-client mutation, signed/notarized distribution, native accessibility automation, physical-client release rehearsal or remote recovery. Browser-preview tests require recorded-input setup; no such evidence was fabricated.

## Authorized read-only SSH inspection

Connected using existing SSH trust with batch authentication and strict host-key verification to `surajadmin@surajhomeserver`. No SSH trust, service, firewall, role, schema or data modifications were made.

| Property | Observed evidence |
|---|---|
| Host | `surajhomeserver` |
| PostgreSQL | Host-managed installation, not a PostgreSQL Docker container |
| Version | Server binary and client report `18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)` |
| Cluster | `18/main`, online, owned by OS user `postgres` |
| Service | `postgresql@18-main.service` active/running |
| Port | 5432 |
| Listen addresses | Configured `*`; listeners on all IPv4 and IPv6 interfaces. This does not prove external reachability or firewall safety. |
| Data directory | `/var/lib/postgresql/18/main` |
| Configured TLS | `ssl = on`; certificate identity and client verification not qualified |
| Configured maximum connections | 100 |
| Configured shared buffers | 128 MB |

A credential-free Unix-socket query using the SSH user's default PostgreSQL role was attempted with read-only transaction defaults and a five-second statement timeout. PostgreSQL rejected it: `role "surajadmin" does not exist`. No credentials were searched, copied or exposed; no role was created and no authentication bypass attempted.

Still unverified: whether an Outpost database already exists, intended dedicated role, effective authentication/network rules, extensions (including vector), live database settings, current workload/capacity and backup/recovery state. Metadata verification/cutover needs an approved connection or separately authorized privileged database inspection. This does not block disposable local development.

## Local development tooling

`psql`, `pg_ctl` and `initdb` are available through Homebrew. This is tooling availability only; no claim yet that a disposable PostgreSQL test cluster has been created or tested. Prefer a private temporary cluster/socket over any existing local/shared database.
