# Outpost Desktop — Tauri

The macOS interface uses **React/TypeScript for the Graphite Studio UI, Rust for transport and identity, and native macOS window chrome**. No SwiftUI is used in this client. Tauri is the only macOS application and new-feature client. The Swift Mac app has been retired; the iPhone app, shared code/resources and all existing user data are retained.

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

The owner-selected Graphite Studio mock is implemented directly in React, including its custom sidebar and exact bundled Geist font files. The separate native title strip is hidden; macOS traffic lights are overlaid inside the sidebar, with draggable app headers and native window resizing. In-app branding uses the existing three-bar Outpost application icon. System appearance and Reduce Motion remain authoritative. The previous `src-tauri/native/sidebar.m` bridge is retained as source history but is no longer compiled or installed.

The task workbench has a compact header, centered conversation/composer, and an inset Evidence inspector with Overview/Changes/Activity tabs. Evidence is always visible in the desktop task layout; both visibility controls and the collapsed state have been removed. Narrow browser layouts retain Conversation/Evidence tabs. The outer window is fixed; conversation, evidence, recent tasks and page content scroll independently without moving the header, composer or shell padding. Settings → Appearance adds optional native macOS frosted glass with adjustable opacity and a saved collapse-sidebar preference. The sidebar's single state-aware button pins a hover-revealed sidebar or collapses/unpins a pinned sidebar; ⌘B also hides it and the native traffic lights. Hover the left edge to spring the sidebar in and move the workspace over; moving away slides it back out. Pinning holds that same layout. Reduce Motion disables the animation. Native traffic lights appear inside the sidebar header after it settles. Desktop resizing keeps the sidebar width/padding fixed, while AppKit retains the native button anchor synchronously without waiting for resize IPC. The spring uses 520ms in / 240ms out with a 350ms hover-dismiss delay. The edge trigger is invisible, and ⌘K reveals task search. See `docs/implementation/AUTO-HIDE-SIDEBAR.md`. Native window corners are paired with smaller inset workspace corners and even padding. See `docs/implementation/APPEARANCE.md` for platform constraints and verification. Exact-action review opens a revision-bound dialog; approval and dispatch remain separate explicit operations. Automations and Memory are under Workspace tools. Command-N opens a new task; Command-K searches recent tasks. See [implementation and verification](../docs/implementation/GRAPHITE-STUDIO.md).

## Wired workflows

- Task creation and follow-up instructions with exact provider/model identities and per-task control mode. Managed servers supply the Pi provider catalogue; older servers retain the advertised Ollama Cloud-only picker. Empty/failed catalogues or unavailable selections block submission rather than silently changing providers. A selection applies to the next instruction, not the response already in progress.
- Live text, model-exposed thinking and tool-call lifecycle over an authenticated SSE/IPC stream, with reconnect snapshots and durable partial checkpoints.
- Server-owned history, conversation rendering, follow-up instructions, pause/resume/cancel.
- Exact-action approvals and dispatch, with action arguments and observed results.
- Uploads with content hashes, integrity-checked artifact downloads, browser captures and JSON evidence.
- In-app PNG/JPEG/WebP viewer from Evidence or Library: click an image to view; Download is separate. Fit, actual size, zoom and drag-to-pan; left/right arrows browse the task's images, Escape closes, `0` fits and `1` selects actual size. Filename/dimensions, retry states and focus restoration are included. External Markdown image URLs are not loaded.
- Read-only server inspection as an explicit agent task; host cards show recorded command results, **not** invented live metrics.
- Connection settings, first-device pairing and model discovery.
- Additional-device enrollment using the trusted Mac's signed request, trusted-device revocation with confirmation, and revision-bound Recovery Hold acknowledgment. Unknown enrollment outcomes require refreshing and verifying the device ID/key; enrollment is never automatically retried.

Full control is the new-task default because this deployment is intentionally an unrestricted private administrative agent. Root access is not a sandbox. Cloud-selected models send context to Ollama Cloud; Chromium and Browser-Use still run on your own worker.

See [live streaming behavior and verification](../docs/implementation/LIVE-STREAMING.md). Thinking expands during generation; models without exposed reasoning do not get fabricated thinking. Tool lifecycle is live, but subprocess stdout and nested Browser-Use steps are not yet streamed individually.

## Server provider sign-in

Use **Settings → Server Pi providers**. Pi and credential storage remain on Server 2. For OpenAI browser sign-in, Outpost starts a flow-bound loopback listener on this Mac before opening the browser, then sends the full callback URL through the private signed login prompt. Keep Settings open until the separate **Save server credential** confirmation. An occupied port or interrupted return offers explicit manual-paste guidance; never paste a callback URL into task chat. Start a fresh login after an expired attempt. See [OpenAI remote sign-in](../docs/implementation/OPENAI-REMOTE-SIGN-IN.md) for restrictions and verification. General callback forwarding and provider packages remain disabled.

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

The live Rust test passed with signed task creation, idempotent retry, file write, workspace command and a follow-up file read. The packaged app visibly connected with the existing identity. Screenshots of the real installed Tauri window were captured during implementation.

From the repository root, `node desktop/test-studio-ui.mjs` runs isolated mock-style parity and Studio interaction tests against the built frontend, including exact font-binary checks and cloud-only picker/dispatch checks. `node desktop/test-cloud-models.mjs` covers the cloud-filter and selection rules. `node desktop/test-image-viewer.mjs` runs synthetic image-viewer checks; set `OUTPOST_TEST_BROWSER=webkit` to run them in WebKit (Chromium is also used to generate valid test images). `node desktop/test-scroll-containment.mjs` checks fixed chrome and independent scrolling with long content, including streaming and resizing; it supports the same WebKit switch. `node desktop/test-ui.mjs /path/to/recorded-preview.json` runs the browser UI checks. Input must explicitly contain `{snapshot,runtime,models}` recorded from the user's server. No sample records or keys are bundled. Recorded preview mode refuses all mutations. `node desktop/test-stream-ui.mjs /path/to/recorded-preview.json` additionally exercises live updates through a controlled Tauri IPC fixture (14 checks). The original recorded-data run passed 48 assertions across 1440, 1050, 768 and 390px, plus light mode and offline handling. This does not claim automated native mouse/keyboard testing; macOS Accessibility permission was unavailable.
