# Outpost App-Wide Engineering Audit & Agent Specs (2026-11)

Each file in this folder is a self-contained, agent-executable specification for a single issue discovered during the Outpost codebase audit. Every spec documents the exact problem with file paths and observed behavior, root cause, concrete implementation steps, and verification criteria.

## Spec Index

| # | Spec | Priority | Area | Core Issue |
|---|---|---|---|---|
| 01 | [01-decouple-server-releases-from-mac-bundle.md](01-decouple-server-releases-from-mac-bundle.md) | P0 | Server Updates | Server tarballs are bundled inside `Outpost.app`, forcing a full Mac app rebuild for every server fix. |
| 02 | [02-unify-main-and-legacy-release-families.md](02-unify-main-and-legacy-release-families.md) | P0 | Server Updates | Dual `host-release` / `pi-release` families rely on 38 overlays + string-anchor patches on a frozen tarball. |
| 03 | [03-host-updater-staging-gc-and-config-ports.md](03-host-updater-staging-gc-and-config-ports.md) | P0 | Server Updates | Host updater leaks disk space (no release/op GC), hardcodes ports `4518/4519/4520`, ties `host_install.py` into `sourcesSha256`, and swallows refusal diagnostics. |
| 04 | [04-broaden-update-recovery-and-unblock-multi-server-queue.md](04-broaden-update-recovery-and-unblock-multi-server-queue.md) | P1 | Server Updates | One failed server blocks all other servers, recovery only handles `waiting_for_idle_failed`, enrollment is all-or-nothing, and `automatic_updates_recover` hardcodes `/usr/bin/ssh`. |
| 05 | [05-fix-sse-90s-timeout-and-snapshot-thrash.md](05-fix-sse-90s-timeout-and-snapshot-thrash.md) | P0 | Desktop Transport | The server ends SSE `/stream` after 60s and the desktop client also times the request out at 90s; `useConnection` fetches a full DB `snapshot` after every command and reconnects every 2s without backoff. |
| 06 | [06-fix-ledger-n-plus-one-and-memory-leaks.md](06-fix-ledger-n-plus-one-and-memory-leaks.md) | P1 | Server Core | `Ledger.list()` runs N+1 queries, `Coordinator` leaks `gates`/`runtimes` Maps, `events`/`outbox` grow unbounded, and `server/main.ts` drops error details. |
| 07 | [07-fix-approval-polling-and-policy-authority-drift.md](07-fix-approval-polling-and-policy-authority-drift.md) | P1 | Server Policy | `Gate.awaitDecisionAndDispatch` busy-polls SQLite every 25ms, `automation.save` lacks the documented authority ceiling, and non-command HTTP routes lack replay protection. |
| 08 | [08-wire-croner-and-automation-deletion.md](08-wire-croner-and-automation-deletion.md) | P1 | Features / Scheduler | A calendar engine already uses `croner`, but `Scheduler.tick` ignores it, so timezone does not affect run times and schedules cannot be deleted. |
| 09 | [09-unify-pi-worker-and-extension-controls.md](09-unify-pi-worker-and-extension-controls.md) | P2 | Server Runtime | Dual `PiRuntime` vs `RemotePiRuntime` paths cause parity bugs; bundled extensions are enabled unconditionally with full worker permissions. |
| 10 | [10-upgrade-browser-streaming-and-takeover-ux.md](10-upgrade-browser-streaming-and-takeover-ux.md) | P2 | Desktop / Browser | `BrowserViewer` polls full base64 JPEGs every 1s and masks all human-takeover text input as `type="password"`. |
| 11 | [11-consolidate-deploy-topologies-and-repo-hygiene.md](11-consolidate-deploy-topologies-and-repo-hygiene.md) | P2 | Repo / Dev Workflow | Untracked/committed build artifacts, 5 overlapping `deploy/` trees, 30 host-specific `outpost2_*` scripts, and a 129-file `desktop/src/` with 90 files still at the top level. |

## Suggested Execution Order

1. **Immediate Stability (P0):** `05` → `03` → `02` → `01`
2. **Reliability & Core UX (P1):** `06` → `07` → `04` → `08`
3. **Architecture & Maintainability (P2):** `09` → `10` → `11`
