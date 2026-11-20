# Outpost

A server-owned agent workspace. The new macOS client uses **Tauri, TypeScript/React and Rust**, with a genuine AppKit sidebar and Ink-styled conversation/evidence views. Tauri is the application client. The Swift clients, design prototypes and historical specification/documentation directories have been removed.

**Start here:** [Tauri desktop](desktop/README.md) · [Private two-server agent deployment](deploy/agent/README.md). The current source uses the Pi SDK and direct Camoufox browser tools. Existing deployments need a qualified engine migration before enabling the new browser engine. Root executors remain separately and explicitly enabled.

**Status: development implementation, not all specifications complete.** The server has durable tasks, signed device commands, exact-action approvals, verified artifacts and domain-level tool libraries. The desktop talks to the real coordinator. Many libraries still need end-to-end wiring and live qualification; do not treat the development implementation as production-ready.

## Run locally

Requirements: Node 24+, npm, and Rust/macOS/Xcode command-line tools for the desktop app. Tests that use Chromium need the Playwright browser installation; Camoufox integration tests also require the pinned engine and browser build under `server/browser-engine/`. No Cloud credentials are required to run deterministic fixtures or explicitly propose a machine inspection.

```sh
npm ci
npx playwright install chromium
npm run check


# Keep this token private; use it for first-device bootstrap in Connection.
export OUTPOST_PAIRING_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$OUTPOST_PAIRING_TOKEN"
npm start
```

The development coordinator listens only on `http://127.0.0.1:4318`, with data under `.outpost/`. `OUTPOST_DATA` selects another data directory; `PORT` changes the port. It does not expose an unauthenticated network service. Do not publish the loopback HTTP endpoint directly to the Internet.

### Mac — Tauri

```sh
cd desktop
npm ci
npm run desktop:build
open "src-tauri/target/release/bundle/macos/Outpost.app"
```

The client reuses the existing macOS Keychain device identity. For the deployed homelab, the private SSH tunnel supplies `http://127.0.0.1:4318`; no new bootstrap token is needed. See [desktop setup and migration limits](desktop/README.md).

The local desktop implementation now includes saved environments, identity-verified connections, per-environment recovery and owner-qualified unified history, while retaining the deployed v1 connection. See [desktop environments](desktop/DESKTOP-ENVIRONMENTS.md). The reviewed app is installed locally; server activation is paused at validation. This has not yet installed independent server environments or delivered history replication/task handoff.

**Connection settings → Set up server** now includes reviewed new-environment installation over pinned SSH: protected sudo authorization, private runtimes, non-root coordinator/worker services, initial enrollment, live stage progress/logs, scoped cancellation and final authenticated registration. **Full server control is now the default setup choice:** explicit installation consent installs an authenticated, loopback-only root executor with host filesystem, Docker and service access. Restricted workspace mode remains optional. The earlier restricted installer was exercised in a real Ubuntu x86 VM. Full control has now been activated and verified on the existing Outpost 1 native server, preserving its identity/data; an actual reboot test of the extension remains pending. Existing Kubernetes/data are not migrated or removed; browser dependencies can update shared OS libraries and require maintenance review. Upgrade/rollback and history migration remain unimplemented. The full-control deployment updated the existing Server 1 installation; Server 2 and Kubernetes were untouched.

### Automatic server updates

The installed app checks all connected saved servers, not just the selected server. **Settings → Servers → your server → Server updates → Automatic server updates** offers one-time opt-in for both servers, followed by sequential, idle-drained updates of signed compatible releases. Status survives app restarts; unknown/failed operations are inspected rather than launched again. No sudo password is saved, and the server grant authorizes only a fixed, signed-release updater—not unrestricted sudo.

Developer builds now require a publisher signing key: run `node scripts/sign-releases.mjs --init` once on the build Mac, then use `npm --prefix desktop run desktop:build`. Enrollment pins that publisher; do not rotate it silently. Building the app does not enroll live servers. See [automatic update authorization, packaging and recovery](deploy/environment/AUTOMATIC-UPDATES.md).

### Manual server Pi and bundled-extension updates

This source pins **Pi 1.5.2**, **pi-ollama-cloud 0.13.1**, and **pi-subagents 0.88.1**. Build the Mac app with `npm --prefix desktop run desktop:build` to include the signed main sequence-8 and legacy-compatible sequence-7 server releases. In the app, select the saved server, open **Server updates**, choose **Check for server updates**, review the release IDs and sequences, and **Authorize server update**. Coordinator features can update even when Pi's version is unchanged. An exact compatible match is shown as **Up to date with this app**; incompatible runtimes, missing verified SSH routes and conflicting sequences are shown as blocked, not up to date. The check compares against the app's bundled release, not npm's latest versions; future upgrades require a new reviewed app bundle.

Both release families include the authenticated file-review APIs. Unsupported workspace queries link to the owning server's update settings rather than leaving only Retry; a verified automatic completion refreshes the open workspace. Legacy unbound connections link to connection settings and still require separately qualified setup.

The app checks the installed release's public runtime-pin digest over pinned SSH before offering an update. Outpost 1's legacy runtime family uses a separate [complete compatible-server bundle](deploy/pi-update/README.md), preserving its browser source and runtime pins while updating the reviewed coordinator/tool overlays. This avoids introducing the main bundle's Camoufox migration. Other mismatched browser/runtime releases require separate qualification; that safety gate is not bypassed.

For compatible native installations, dependencies stage before work drains; activation restarts the server with health checks and a retained rollback release. Credentials, sessions, task history and the existing browser installation are preserved. Legacy/container or unqualified installations require a separately reviewed migration; this flow does not reinstall them. A successful local build/test is not evidence that a live server was upgraded.

If an update shows **Unknown**, check its status rather than launching it again. **Cancel pending update** asks the authenticated coordinator to cancel that exact operation; it succeeds only before a maintenance hold/activation begins. A missing host receipt is not proof of cancellation. Once the server confirms cancellation, create a new review before authorizing another attempt. Launch diagnostics retain fixed error categories, never password or raw exception text. Host failures are reported as **Failed**, not as user cancellation merely because the coordinator cleaned up the reservation.

**Installed extensions are enabled by default.** Installing this release makes `pi-subagents` and the full `pi-ollama-cloud` extension available to Pi, including native tools, bundled resources and child agents; there is no separate activation switch. Their execution uses the worker's filesystem/network/process permissions without individual action approvals. Coordinator tools use `outpost_action` with Full control while retaining validation, evidence, host boundaries, and recovery/maintenance holds. Only install extensions you trust with the worker profile and credentials.

Native background work remains tracked while sessions drain, and unresolved work after a restart prevents maintenance from treating the worker as idle. Worker children use the native Pi profile; the legacy direct adapter supplies parent-only model credentials to its local children through a private, session-scoped socket without writing API keys into extension modules. General package installation and direct `pi update` / `pi update --extensions` remain outside the managed release workflow.

### Agent automation tools

The coordinator exposes `automation.list`, `automation.save`, and `automation.set_paused` through `outpost_action` in both direct and worker-backed agent sessions. Each has a description and JSON input schema. They manage the same server-owned records as the desktop **Automations** page, not Linux cron files.

- `automation.list`: inspect schedules, IDs, revisions, and the server clock; supports `automationId`, `limit`, and `offset`.
- `automation.save`: create with a stable `automationId` and `expectedRevision: 0`, or replace a complete schedule using its latest revision. Each occurrence creates a new agent task with self-contained instructions.
- `automation.set_paused`: pause/resume using the latest revision without replacing the task configuration. Pausing does not cancel existing tasks; resuming may immediately admit overdue work.

All calls use the existing action approval/evidence gate. Writes recheck revisions and recovery/maintenance holds at execution. Scheduled task mode defaults to `ask_permission`; the agent cannot save or resume a schedule with greater authority than its current task. Provider-qualified models require a configured Pi worker.

Supported timing remains one-time or fixed intervals of at least one minute. Calendar cron expressions are not wired into the scheduler; every 24 hours is not a fixed local hour across DST. The Outpost server must be running. The agent is instructed to use these tools for scheduled agent work and only use OS cron when explicitly requested. Source changes require a server deployment/restart and a new agent run; they do not update already-running installations or import existing OS cron entries.

### Pairing and additional devices

For an unpaired server, open **Connection** on the first device, enter the bootstrap token and choose **Pair First Device**. Bootstrap closes after the first device.

From an **already trusted Tauri Mac**, open **Connection → Enroll another device / Trusted devices**. Verify the new device's ID and public pairing key, enroll it, then reconnect it to the same server. Revocation requires confirmation against the displayed revision.

Tauri now exposes **Connection → Recovery Hold** with revision-bound acknowledgment before resuming dispatch. Offline, revoked, unconfirmed and recorded-preview clients cannot administer the server; unknown pending commands must be resolved first. Enrollment has no automatic retry: refresh and verify the device ID/key after an uncertain outcome. These controls do not imply per-operation biometric confirmation or live recovery qualification. Do not reset pairing, delete Keychain identities or clear server data as a workaround.

## Verification

```sh
npm run check                         # backend and client-retirement regression tests

npm --prefix desktop run build        # Tauri frontend type-check and bundle
node desktop/test-connection-administration.mjs # synthetic IPC administration checks
node desktop/test-environments.mjs    # synthetic two-environment isolation and recovery
# After: npx playwright install webkit
OUTPOST_TEST_BROWSER=webkit node desktop/test-environments.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features
npm --prefix desktop run desktop:build # packaged Tauri app
npm run qualify                       # local pins/probes → .outpost/qualification.json; not live qualification
```

Use disposable fixtures for tests, not live accounts or server data. The recovery launcher retains its required qualification record under `scripts/fixtures/` and continues to enforce the exact helper hash.

## Optional integration configuration

| Variable | Purpose / limitation |
|---|---|
| `OUTPOST_DATA` | Durable ledger (including persistent installation identity), artifacts, task workspaces and Pi session root |
| `OUTPOST_ENVIRONMENT_LABEL`, `OUTPOST_RUNTIME_RELEASE` | Non-secret descriptor label (default `Outpost`) and optional release identifier; neither changes installation identity |
| `OUTPOST_ALLOW_LEGACY_PROTOCOL` | Defaults to `true` while installed clients use `/v1`; set `false` only after upgrading clients to environment-bound `/v2` |
| `OUTPOST_PAIRING_TOKEN` | First-device bootstrap secret; route closes after first enrollment |
| `OUTPOST_OLLAMA_BASE_URL`, `OUTPOST_OLLAMA_MODEL` | Direct Ollama-compatible endpoint and exact model name; the homelab uses the existing daemon for local/Cloud models |
| `OUTPOST_FULL_CONTROL` | `true` permits arbitrary workspace executables; task policy still controls dispatch |
| `OUTPOST_HOST_ENDPOINTS`, `OUTPOST_HOST_TOKEN_FILE` | Named root executors and a protected token file; native full-control setup enrolls `{"local":"http://127.0.0.1:4519"}`. No public executor listener |
| `OUTPOST_HOST_TOKEN`, `OUTPOST_HOST_MAIN`, `OUTPOST_HOST_WORKER` | Legacy two-server root executor configuration; still supported. Keep the token private |
| `OUTPOST_BROWSER_ENABLED` | `true` enables task-owned Chromium, direct Pi tools, live desktop viewing and explicit human takeover |
| `OUTPOST_CAMOUFOX_PYTHON` | Optional absolute interpreter for the pinned `server/browser-engine` launcher; enable browsing separately with `OUTPOST_BROWSER_ENABLED=true` |
| `XDG_CACHE_HOME` | On Linux, the private cache containing the verified, pinned Camoufox installation |
| `OUTPOST_BROWSER_VISION` | `true` (default) or `false`; must match the delegated model's actual image support |
| `OUTPOST_EXECUTABLES` | Colon-separated absolute executables eligible for the gated command tool; **not a sandbox** |
| `OLLAMA_API_KEY` | Actual owner-authorized Ollama Cloud account key; never commit it |
| `OUTPOST_ROLES_FILE` | JSON role configuration loaded by `server/main.ts`; must reference real conformance evidence before enabling |
| `APNS_KEY_FILE`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_TOPIC`, `APNS_ENVIRONMENT` | Direct APNs provider configuration; signing entitlements and real device delivery are not provisioned by this repository |

Do not flip `qualified` to `true` merely to bypass the model gate. The flag is an operator declaration, not a benchmark. The operator/reviewer must be distinct; actual reviewer size, licences, reliability and acceptable false-allow thresholds still need evidence. The legacy vision role is reserved. Browser reasoning uses Pi's selected model; vision support still depends on that exact model.

The shared direct/delegated browser session provides desktop **Take control / Return control**. Returning control never automatically resumes Pi. Browser viewing uses screenshot polling, not video or a Linux desktop.

## Repository map

- `server/core/`, `server/gateway/`: durable SQLite WAL records, events, outbox, signed HTTP.
- `server/policy/`, `server/tasks/`, `server/pi-adapter/`: mode gate, task lifecycle and pinned Pi integration.
- Other `server/` directories: independently tested domain capabilities; not all are exposed as running coordinator tools.
- `desktop/`: Tauri client, React screens, Rust signing/transport, native AppKit sidebar.
- `deploy/agent/`: two-host root executors and workspace coordinator deployment.
- `scripts/`: packaging, recovery and local qualification tools; required recovery evidence is retained in `scripts/fixtures/`.

## Safety and completion limits

This is a **private, explicitly privileged deployment**, not a hostile-agent sandbox. Tasks offer Full control (default) and Auto. Auto requires exact approval for financial, destructive, security-sensitive and unclassified actions; there is no Ask permission mode. When host administration is configured, the agent can execute arbitrary root commands on each enrolled host and read host secrets. Authentication and private networking protect entry; they do not constrain an authorized agent. Untrusted web content and model mistakes remain risks. Cloud-selected Ollama models send task/tool/page context to Ollama Cloud.

Existing servers and the desktop app must be updated for the two-mode policy. Legacy ask_permission inputs normalize to Auto; clients only enable Auto after verifying server capabilities. On startup, old pending approval requests are retired without execution and affected tasks pause for explicit resume; completed and uncertain effects are not replayed. Authentication, configured host boundaries, and recovery/maintenance holds remain in place.

One exact Ollama Cloud model and the live file/command/root/browser path have been exercised; this is not universal model or production qualification. Payments, real APNs delivery, complete redaction, physical two-client convergence, full-system restoration and signed/notarized distribution remain unqualified. No module is declared production-complete solely because its unit fixtures pass.
