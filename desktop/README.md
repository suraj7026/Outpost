# Outpost Desktop — Tauri

The new macOS interface uses **React/TypeScript for content, Rust for transport and identity, and AppKit for the sidebar**. No SwiftUI is used in this client. Tauri is the only macOS application and new-feature client. The Swift Mac app has been retired; the iPhone app, shared code/resources and all existing user data are retained.

## Build and open

Requirements: Node 24+, npm, Rust, Xcode Command Line Tools; macOS 14+ for this implementation. The current package is built for Apple Silicon, not a universal or notarized distribution.

```sh
cd desktop
npm ci
npm run desktop:build
open "src-tauri/target/release/bundle/macos/Outpost Desktop.app"
# Development: npm run tauri -- dev
```

The frontend is bundled, including Geist fonts. It does not require an external web server or CDN. Launching `npm run dev` alone gives an intentionally disconnected browser preview: the signing key is never placed in JavaScript.

## Connection and identity

- Rust reuses Keychain service `dev.outpost.identity`, account `device`, including the earlier client's exact Ed25519 identity. If macOS requests Keychain access, approve it yourself; no password is stored by this repository.
- The homelab endpoint is `http://127.0.0.1:4318`, supplied by the existing private SSH tunnel. Existing pairing and server-owned history are preserved.
- A new server can use first-device bootstrap in **Connection**. Bootstrap is closed after the first device; it is not a general re-pair button.
- Remote endpoints require HTTPS. HTTP is accepted only for localhost. Redirects are not followed.
- Signed command retries retain their original operation/idempotency IDs. Unknown outcomes block new commands until explicitly retried. The pending envelope is AES-GCM encrypted under a key derived from the Keychain identity, stored privately under the app's support directory.
- Task history remains on the server. This version keeps last-known records in memory while disconnected, but does **not** migrate the Swift client's encrypted offline history cache.

## Native versus web

`src-tauri/native/sidebar.m` is a small Objective-C/AppKit bridge compiled by Rust's build script. It creates an actual `NSSplitViewController`, sidebar `NSTableView` in source-list style, SF Symbols, native selection, resizable/collapsible split pane and native toolbar toggle. Tauri's existing WKWebView becomes the detail pane, with automatic full-window resizing disabled. Native callbacks emit navigation events; React supplies task labels and selected state.

This uses public AppKit APIs, not the experimental third-party split-view plugin or a CSS imitation. macOS owns the traffic lights, sidebar material and window chrome. Light/dark content follows the system. The HTML sidebar is only the browser/non-native fallback; screenshots of recorded browser previews are labeled accordingly.

## Wired workflows

- Task creation with exact Ollama model names and per-task control mode.
- Live text, model-exposed thinking and tool-call lifecycle over an authenticated SSE/IPC stream, with reconnect snapshots and durable partial checkpoints.
- Server-owned history, conversation rendering, follow-up instructions, pause/resume/cancel.
- Exact-action approvals and dispatch, with action arguments and observed results.
- Uploads with content hashes, integrity-checked artifact downloads, browser captures and JSON evidence.
- Read-only server inspection as an explicit agent task; host cards show recorded command results, **not** invented live metrics.
- Connection settings, first-device pairing and model discovery.
- Additional-device enrollment using the trusted Mac's signed request, trusted-device revocation with confirmation, and revision-bound Recovery Hold acknowledgment. Unknown enrollment outcomes require refreshing and verifying the device ID/key; enrollment is never automatically retried.

Full control is the new-task default because this deployment is intentionally an unrestricted private administrative agent. Root access is not a sandbox. Cloud-selected models send context to Ollama Cloud; Chromium and Browser-Use still run on your own worker.

See [live streaming behavior and verification](../docs/implementation/LIVE-STREAMING.md). Thinking expands during generation; models without exposed reasoning do not get fabricated thinking. Tool lifecycle is live, but subprocess stdout and nested Browser-Use steps are not yet streamed individually.

## Migration limits

- Automations and Memory currently display existing server records. Desktop editing is not implemented; retained iPhone forms are not new-feature parity.
- Administration is available under **Connection → Trusted devices / Enroll another device / Recovery Hold**, only with confirmed current device authority and no unknown pending command. Offline and recorded previews are read-only. These controls reuse the Keychain signer but do not claim biometric confirmation for every operation. Live cross-device, identity-continuity, pending-command restart and recovery rehearsals remain unqualified; do not delete identity/server data or reopen bootstrap as a workaround.
- No live interactive browser takeover/video view yet: current outputs are screenshots and structured results.
- iPhone still uses the retained Swift client. Linux/Windows secure identity storage and native navigation are not implemented.
- Closing the app does not cancel server-owned tasks. Pausing/cancelling a task does not undo completed commands.

## Verification

```sh
npm run build
node test-connection-administration.mjs # local synthetic IPC; no Keychain or live server
cd src-tauri
cargo test --locked
# Explicit opt-in: uses the real paired Keychain identity and private server.
# Creates a small isolated verification task, tests retry and a second Pi turn.
OUTPOST_LIVE_CLIENT=1 cargo test live_signed_client_roundtrip -- --ignored --nocapture
```

The live Rust test passed with signed task creation, idempotent retry, file write, workspace command and a follow-up file read. The packaged app visibly connected with the existing identity. A screenshot of the real AppKit/Tauri window was captured during implementation.

From the repository root, `node desktop/test-ui.mjs /path/to/recorded-preview.json` runs the browser UI checks. Input must explicitly contain `{snapshot,runtime,models}` recorded from the user's server. No sample records or keys are bundled. Recorded preview mode refuses all mutations. `node desktop/test-stream-ui.mjs /path/to/recorded-preview.json` additionally exercises live updates through a controlled Tauri IPC fixture (14 checks). The original recorded-data run passed 48 assertions across 1440, 1050, 768 and 390px, plus light mode and offline handling. This does not claim automated native mouse/keyboard testing; macOS Accessibility permission was unavailable.
