# Outpost

A server-owned agent workspace. The new macOS client uses **Tauri, TypeScript/React and Rust**, with a genuine AppKit sidebar and Ink-styled conversation/evidence views. The earlier SwiftUI Mac/iPhone clients remain available during migration.

**Start here:** [Tauri desktop](desktop/README.md) · [Private two-server agent deployment](deploy/agent/README.md). The live deployment uses the Pi SDK, the existing Ollama daemon, self-hosted Browser-Use, and explicitly enabled root executors on both servers.

**Status: development implementation, not all specifications complete.** The server has durable tasks, signed device commands, exact-action approvals, verified artifacts and domain-level tool libraries. The clients talk to the real coordinator rather than the in-memory mock. Many libraries still need end-to-end wiring and live qualification. See the [acceptance report](docs/implementation/ACCEPTANCE.md) before treating anything as production-ready.

## Run locally

Requirements: Node 24+, npm, macOS/Xcode for native apps, and XcodeGen for the iPhone project. Tests that use Chromium need the Playwright browser installation. No Cloud credentials are required to run deterministic fixtures or explicitly propose a machine inspection.

```sh
npm ci
npx playwright install chromium
npm run check
npm run contracts

# Keep this token private; paste its value into the first client's Connection screen.
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
open "src-tauri/target/release/bundle/macos/Outpost Desktop.app"
```

The client reuses the existing macOS Keychain device identity. For the deployed homelab, the private SSH tunnel supplies `http://127.0.0.1:4318`; no new bootstrap token is needed. See [desktop setup and migration limits](desktop/README.md).

### Legacy SwiftUI Mac client

```sh
./clients/build-mac.sh
open clients/build/Outpost.app
```

Open **Connection**, leave the loopback server address, enter the bootstrap token and choose **Pair First Device**. The bootstrap route closes after the first device.

Create a task. Without direct Ollama inference or qualified legacy Cloud configuration, its state intentionally becomes **waiting for capacity**, with an explanation. To exercise real local work, open **Evidence → Inspect Machine**, approve the exact read-only action using local authentication, then choose **Run Approved Action**. Approval and execution are separate recorded steps. You can also attach/download verified files, steer/pause/cancel tasks, create simple schedules, and manage scoped memory notes.

### iPhone simulator and additional devices

```sh
cd clients
xcodegen generate
open Outpost.xcodeproj
```

Select the **OutpostPhone** scheme and a simulator; run with normal/ad-hoc signing enabled. Unsigned simulator builds can compile while Keychain fails. A physical iPhone requires a real signing team and an authenticated HTTPS/private-network path to the server; `127.0.0.1` on the phone is the phone itself.

If Mac is already paired:

1. On iPhone, open Connection and copy its **Device ID** and **Public Pairing Key**.
2. On the trusted Mac, open **Connection → Enroll Another Device**, enter those values and a name, then authenticate and enroll.
3. On iPhone, enter the same server URL and choose **Reconnect**. Do not reuse the bootstrap route.

The same enrollment flow is available on either platform. **Trusted Devices** permits revocation. A revoked device's future signed requests are rejected; already completed effects are not undone. Native enrollment/revocation compiles and shares tested backend endpoints, but its local-authentication flow still needs a physical-device rehearsal.

## Verification

```sh
npm run check                         # 40 backend tests at the recorded revision
swift test --package-path clients     # 3 projection/catalogue tests
./clients/build-mac.sh
npm run qualify                       # local pins/probes; never a live provider qualification

# Stop the dev coordinator first: this script owns a fresh loopback fixture.
xcrun simctl list devices available
OUTPOST_SIMULATOR_ID=<simulator-uuid> ./scripts/test-native-ui.sh phone
# Requires macOS automation permissions; blocked in the recorded environment:
./scripts/test-native-ui.sh mac
```

The native fixture script pairs, creates a real task, proposes machine inspection and waits for the approval card without manually refreshing. It preserves an `.xcresult` and isolated fixture ledger. It does not approve a sensitive action or send real notifications/payments. See the [native screenshot](docs/implementation/evidence/iphone-pending-action.png).

## Optional integration configuration

| Variable | Purpose / limitation |
|---|---|
| `OUTPOST_DATA` | Durable ledger, artifacts, task workspaces and Pi session root |
| `OUTPOST_PAIRING_TOKEN` | First-device bootstrap secret; route closes after first enrollment |
| `OUTPOST_OLLAMA_BASE_URL`, `OUTPOST_OLLAMA_MODEL` | Direct Ollama-compatible endpoint and exact model name; the homelab uses the existing daemon for local/Cloud models |
| `OUTPOST_FULL_CONTROL` | `true` permits arbitrary workspace executables; task policy still controls dispatch |
| `OUTPOST_HOST_TOKEN`, `OUTPOST_HOST_MAIN`, `OUTPOST_HOST_WORKER` | Explicitly enables authenticated, unrestricted root executors; keep the token private |
| `OUTPOST_BROWSER_PYTHON` | Persistent Browser-Use venv interpreter; local Chromium with ChatOllama |
| `OUTPOST_EXECUTABLES` | Colon-separated absolute executables eligible for the gated command tool; **not a sandbox** |
| `OLLAMA_API_KEY` | Actual owner-authorized Ollama Cloud account key; never commit it |
| `OUTPOST_ROLES_FILE` | JSON matching [the deliberately unqualified example](docs/implementation/roles.example.json); must reference real conformance evidence before enabling |
| `APNS_KEY_FILE`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_TOPIC`, `APNS_ENVIRONMENT` | Direct APNs provider configuration; signing entitlements and real device delivery are not provisioned by this repository |

Do not flip `qualified` to `true` merely to bypass the model gate. The flag is an operator declaration, not a benchmark. The operator/reviewer must be distinct; actual reviewer size, licences, reliability and acceptable false-allow thresholds still need evidence. The legacy vision role is reserved. Direct Ollama inference and Browser-Use have a separate vision configuration; support still depends on the exact selected model.

## Repository map

- `server/core/`, `server/gateway/`: durable SQLite WAL records, events, outbox, signed HTTP.
- `server/policy/`, `server/tasks/`, `server/pi-adapter/`: mode gate, task lifecycle and pinned Pi integration.
- Other `server/` directories: independently tested domain capabilities; not all are exposed as running coordinator tools.
- `desktop/`: Tauri client, React screens, Rust signing/transport, native AppKit sidebar.
- `deploy/agent/`: two-host root executors and workspace coordinator deployment.
- `clients/Shared/`: shared SwiftUI workspace, Keychain signing, encrypted cache and projections.
- `clients/macOS/`, `clients/iOS/`: platform entry points.
- `spec/`: 31 specifications and ownership of all 270 requirements.
- `docs/implementation/`: [plan](docs/implementation/PLAN.md), [acceptance/gaps](docs/implementation/ACCEPTANCE.md), [decisions](docs/implementation/DECISIONS.md), [operations](docs/implementation/RUNBOOK.md), [local qualification](docs/implementation/QUALIFICATION.json).
- `mock/`: pre-existing design study, not the application backend.

## Safety and completion limits

This is a **private, explicitly privileged deployment**, not a hostile-agent sandbox. When host administration and a task's full-control mode are enabled, the agent can execute arbitrary root commands on both servers and read host secrets. Authentication and private networking protect entry; they do not constrain an authorized agent. Untrusted web content and model mistakes remain risks. Cloud-selected Ollama models send task/tool/page context to Ollama Cloud.

One exact Ollama Cloud model and the live file/command/root/browser path have been exercised; this is not universal model or production qualification. Payments, real APNs delivery, complete redaction, physical two-client convergence, full-system restoration and signed/notarized distribution remain unqualified. No module is declared production-complete solely because its unit fixtures pass.
