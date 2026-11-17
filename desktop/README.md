# Outpost

The macOS interface uses **React/TypeScript for the Graphite Studio UI, Rust for transport and identity, and native macOS window chrome**. No SwiftUI is used in this client. Tauri is the only macOS application and new-feature client. The Swift Mac app has been retired; the iPhone app, shared code/resources and all existing user data are retained.

## Build and open

Requirements: Node 24+, npm, Rust, Xcode Command Line Tools; macOS 14+ for this implementation. The current package is built for Apple Silicon, not a universal or notarized distribution.

```sh
cd desktop
npm ci
npm run desktop:build
open "src-tauri/target/release/bundle/macos/Outpost.app"
# Development: npm run tauri -- dev
```

The frontend is bundled, including Google Sans Flex and the Google Sans fallback (both under the SIL Open Font License). It does not require an external web server or CDN. Launching `npm run dev` alone gives an intentionally disconnected browser preview: the signing key is never placed in JavaScript.

## Connection and identity

- Rust reuses Keychain service `dev.outpost.identity`, account `device`, including the earlier client's exact Ed25519 identity. If macOS requests Keychain access, approve it yourself; no password is stored by this repository.
- The homelab endpoint is `http://127.0.0.1:4318`, supplied by the existing private SSH tunnel. Existing pairing and server-owned history are preserved.
- A new server can use first-device bootstrap in **Connection**. Bootstrap is closed after the first device; it is not a general re-pair button.
- Remote endpoints require HTTPS. HTTP is accepted only for localhost. Redirects are not followed.
- Signed command retries retain their original operation/idempotency IDs. Unknown outcomes block new commands until explicitly retried. The pending envelope is AES-GCM encrypted under a key derived from the Keychain identity, stored privately under the app's support directory.
- Task history remains on the server. This version keeps last-known records in memory while disconnected, but does **not** migrate the Swift client's encrypted offline history cache.

## Saved environments

Use **Settings → Servers** for the clickable server list and **Add server**. Each server opens its own General, Setup & connection, Models & providers, Devices & access, and Recovery pages. **Settings → Appearance → Theme** offers **Auto**, **Light**, and **Dark**, saved on this Mac. Auto follows macOS and updates while the app is open; manual choices override the system for the interface, native window chrome, setup dialogs, and terminal. Changing theme preserves open terminal sessions and other window preferences. Settings has deep links and back/forward navigation; opening another server’s settings does not change the current chat owner.

The sidebar and **All chats** group conversations under every server. Identical task IDs remain isolated by server. Offline and removed connections retain read-only history in memory until the app closes; remote history is never deleted by removing a saved connection. Choose a destination with **Run on…** when creating a new task, not a global environment dropdown. Each installation retains independent streams, pending recovery and provider state; switching chats never retargets an in-flight action. Legacy v1 live streaming and original Keychain enrollment remain supported.

History is memory-only while disconnected, not replication or a recovery checkpoint. Ambiguous legacy adoption requires explicit retirement consent; pending commands are never guessed into another installation. See [usage and limits](DESKTOP-ENVIRONMENTS.md) and [native IPC](NATIVE-ENVIRONMENTS.md). No live server migration or task handoff is delivered by these desktop changes. The reviewed build was installed and launched on 4 November 2026; the existing v1 connection remains usable, but server v2 activation is paused at a Linux signal-permission validation blocker.

## Set up server (local foundation)

**Settings → Servers → Add server** opens the large setup modal. **Setup & connection → Open server setup** resumes an existing server’s setup journal. Connect → Verify → Review → Install → Finish keeps the target identity visible throughout. Each server has its own progress, busy state, errors, consent and diagnostics; switching targets does not rearrange panels or retarget work. The advanced **Connect with a URL** path is inside the same modal.

SSH setup accepts a separate server address, username and port, and a selected private key or existing ssh-agent identity. Confirm the Ed25519 host fingerprint independently before read-only inspection. Known Kubernetes/container/data markers require migration review, not an automatic upgrade. Existing environment-aware installations can use an owned loopback tunnel, followed by signed enrollment verification and environment registration. Disconnect closes only the owned route, not the server.

The same flow provides **Review installation plan → Authorize & install**, with a protected native sudo-password dialog, twelve checks grouped into four phases, scoped log copy/native download, confirmed cancellation and durable status recovery. New plans default to restricted workspace access; full server control remains an explicit opt-in. Existing reviewed plans and installed permissions are unchanged. Closing the modal backgrounds the view without cancelling a launched job. Receipt updates are bound to target/operation/environment/release identity and reject stale progress. It creates a separate, initially empty environment with private runtimes and non-root persistent services. Server readiness is 10/12; **Connect and finish setup** must verify signed enrollment before 12/12. Saved, verified SSH installations now reconnect automatically on launch and after tunnel loss, without Inspect/Reconnect/setup clicks, reinstalling, or retiring the legacy environment. General offers persistent Pause/Resume controls; changed trust or enrollment still needs attention. Browser provisioning may update shared Ubuntu libraries; review a maintenance window first.

Cross-release upgrades, rollback, history migration, Kubernetes removal and automatic repair of partial installs remain unavailable. SSH password login, key-passphrase UI and aliases/proxy commands remain unsupported; encrypted keys must be unlocked in the agent. The new installer was exercised in disposable real Ubuntu VMs, not either owner server.

## Native versus web

The owner-selected Graphite Studio layout is implemented directly in React, including its custom sidebar. Typography uses locally bundled Google Sans Flex with Google Sans as the fallback throughout the app, including controls, conversations and code/log text; OS-owned dialogs retain native typography. Font provenance is in `src/assets/fonts/README.md`, and redistribution notices ship in `dist/font-licenses/`. The separate native title strip is hidden; macOS traffic lights are overlaid inside the sidebar, with draggable app headers and native window resizing. In-app branding uses the existing three-bar Outpost application icon. System appearance is followed in Auto mode; Reduce Motion remains authoritative. The previous `src-tauri/native/sidebar.m` bridge is retained as source history but is no longer compiled or installed.

The task workbench has a compact header, centered conversation/composer, and an inset Evidence inspector with Overview/Changes/Activity tabs. Evidence is always visible in the desktop task layout; both visibility controls and the collapsed state have been removed. Narrow browser layouts retain Conversation/Evidence tabs. The outer window is fixed; conversation, evidence, recent tasks and page content scroll independently without moving the header, composer or shell padding. Settings → Appearance adds optional native macOS frosted glass with adjustable opacity and a saved collapse-sidebar preference. The sidebar's single state-aware button pins a hover-revealed sidebar or collapses/unpins a pinned sidebar; ⌘B also hides it and the native traffic lights. Hover the left edge to spring the sidebar in and move the workspace over; moving away slides it back out. Pinning holds that same layout. Reduce Motion disables the animation. Native traffic lights appear inside the sidebar header after it settles. Desktop resizing keeps the sidebar width/padding fixed, while AppKit retains the native button anchor synchronously without waiting for resize IPC. The spring uses 520ms in / 240ms out with a 350ms hover-dismiss delay. The edge trigger is invisible, and ⌘K reveals task search. Native window corners are paired with smaller inset workspace corners and even padding. Frosted glass requires native macOS support; a browser preview does not qualify native appearance or window-control behavior. Exact-action review opens a revision-bound dialog; approval and dispatch remain separate explicit operations. Automations and Memory sit in the main navigation after Library and before All chats; there is no separate Workspace tools disclosure. Command-N opens a new task; Command-K searches recent tasks.

## Startup page

Outpost opens the **New task home page** by default. Under **Settings → Appearance → On startup**, optionally choose **Last working page** to reopen the last chat with its owning server/environment, or another working page. This local preference applies on the next launch. Drafts and terminal state are not restored; missing restore targets fall back to the New task home page.

## Wired workflows

- Task creation and follow-up instructions with exact provider/model identities and per-task control mode. Managed servers supply the Pi provider catalogue; older servers retain the advertised Ollama Cloud-only picker. Empty/failed catalogues or unavailable selections block submission rather than silently changing providers. A selection applies to the next instruction, not the response already in progress.
- Live text, model-exposed thinking and tool-call lifecycle over an authenticated SSE/IPC stream, with reconnect snapshots and durable partial checkpoints.
- Server-owned history, conversation rendering, follow-up instructions, pause/resume/cancel.
- Exact-action approvals and dispatch, with action arguments and observed results.
- Uploads with content hashes, integrity-checked artifact downloads, browser captures and JSON evidence.
- In-app PNG/JPEG/WebP previews in chat, Evidence and Library preserve the image's aspect ratio without cropping or upscaling, bounded to 560 × 360 px. Click to view; Download is separate. Fit, actual size, zoom and drag-to-pan; left/right arrows browse the task's attachments, Escape closes, `0` fits and `1` selects actual size. Filename/dimensions, retry states and focus restoration are included.
- Markdown images can reference a unique attachment in the same task by filename, `./filename`, or `#artifact-ID`. External HTTPS images require an explicit **Load image** click per image; anonymous requests send no cross-origin cookies or referrer, and the remote site must allow CORS image sharing. Loaded images use the same viewer, with **Open original** for browser access rather than an unverified native download. Other URLs/local paths show an unavailable state; recorded previews never fetch images.
- Read-only server inspection as an explicit agent task; host cards show recorded command results, **not** invented live metrics.
- Connection settings, first-device pairing and model discovery.
- Additional-device enrollment using the trusted Mac's signed request, trusted-device revocation with confirmation, and revision-bound Recovery Hold acknowledgment. Unknown enrollment outcomes require refreshing and verifying the device ID/key; enrollment is never automatically retried.

Full control is the new-task default because this deployment is intentionally an unrestricted private administrative agent. Root access is not a sandbox. Cloud-selected models send context to Ollama Cloud; Camoufox runs on your own server once the engine migration is deployed; Pi uses its selected model directly.

**Settings → Appearance → Conversation detail** controls all tool-call and model-provided thinking disclosures. **Compact** (the default) starts them collapsed; **Extended** opens them, including completed-history groups. Each row can still be toggled independently, and that choice survives streaming updates and tool/action linking. The preference is saved on this Mac; if storage is blocked, it lasts for the app session and a warning explains the persistence failure. Active thinking uses a subtle three-dot animation that stops on completion, response text, interruption or error; Reduce Motion uses static dots. Models without exposed reasoning do not get fabricated traces or durations. Normal replies and execution are unchanged, and exact-action approval dialogs always show their review details. Tool lifecycle is live, but subprocess stdout is not yet streamed individually.

## SSH terminal and OS reboot

Open **Terminal** beside the server name in a chat's composer, or **Machines → Open terminal**. Both use the chosen server's verified saved SSH connection and share its shell. Collapsing the pane keeps it running; Disconnect and app quit close the shell without cancelling agent tasks. Use remote `tmux` for persistent shell work.

**Reboot server…** is available in either terminal toolbar. It requires exact-host confirmation and optional protected native sudo authorization, interrupts the entire server, and never retries dispatch automatically. Read-only boot-ID checks distinguish a verified return from an unknown outcome. This is separate from resetting an Outpost installation. URL-only/unbound legacy connections need verified SSH setup first.

## Server provider sign-in

Use **Settings → Servers → your server → Models & providers**. Managed servers have one provider catalogue; the legacy Ollama list appears only for older servers without provider management. Pi and credential storage remain on that server (Server 2 in the existing deployment). For OpenAI browser sign-in, Outpost starts a flow-bound loopback listener on this Mac before opening the browser, then sends the full callback URL through the private signed login prompt. Keep Settings open until the separate **Save server credential** confirmation. An occupied port or interrupted return offers explicit manual-paste guidance; never paste a callback URL into task chat. Start a fresh login after an expired attempt. General callback forwarding and package installation remain disabled. The owner-approved, pinned **pi-ollama-cloud** provider is loaded on the shared server runtime and appears as **Ollama**. Its Cloud API key can be saved privately, but the strict access policy now blocks selection until an approved credential-scoped verifier is implemented; public discovery is insufficient. The old daemon-backed conversational provider is retired without rewriting history. For a saved ChatGPT login, model choices now come from authenticated account discovery, with server-side checks before inference. A discovery failure removes unverified choices rather than falling back to Pi's catalogue or API billing. This applies to every Pi provider: currently only ChatGPT OAuth has a verifier; saved API keys and other subscriptions do not by themselves enable any models.

## Migration limits

- Automations and Memory currently display existing server records. Desktop editing is not implemented; retained iPhone forms are not new-feature parity.
- Administration is available under **Settings → Servers → your server → Devices & access / Recovery**, only with confirmed current device authority and no unknown pending command. Offline and recorded previews are read-only. These controls reuse the Keychain signer but do not claim biometric confirmation for every operation. Live cross-device, identity-continuity, pending-command restart and recovery rehearsals remain unqualified; do not delete identity/server data or reopen bootstrap as a workaround.
- The task Evidence panel now offers live browser frames and explicit **Take control / Return control**, with an enlarged view. Input is exclusive and transient; returning control leaves Pi paused. This is screenshot polling, not video or a Linux desktop.
- iPhone still uses the retained Swift client. Linux/Windows secure identity storage and native navigation are not implemented.
- Closing the app does not cancel server-owned tasks. Pausing/cancelling a task does not undo completed commands.

## Verification

```sh
# From the repository root:
npm --prefix desktop run build
node desktop/test-connection-administration.mjs # synthetic IPC; no Keychain or live server
node desktop/test-environments.mjs
node desktop/test-appearance.mjs
OUTPOST_TEST_BROWSER=webkit node desktop/test-appearance.mjs
node desktop/test-conversation-detail.mjs # synthetic Compact/Extended and thinking lifecycle tests in Chromium + WebKit
node desktop/test-terminal-theme.mjs
# Install the browser first if missing: npx playwright install webkit
OUTPOST_TEST_BROWSER=webkit node desktop/test-environments.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features

# Explicit opt-in only: uses the real paired Keychain identity and private server.
# Creates a small verification task, tests retry and a second Pi turn.
OUTPOST_LIVE_CLIENT=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml live_signed_client_roundtrip -- --ignored --nocapture
```

The earlier single-environment implementation passed the live Rust roundtrip and was inspected in the packaged app with the existing identity. That historical evidence does not qualify the current multi-environment changes: their reviewed native and Chromium/WebKit tests use synthetic identities/IPC, and the live-Keychain test remains intentionally ignored.

From the repository root, `node desktop/test-browser-modes.mjs` checks browser viewing, takeover, transient input, unknown outcomes, competing-device states, enlarged view and stale task replies at three widths; it also supports `OUTPOST_TEST_BROWSER=webkit`.

From the repository root, `node desktop/test-studio-ui.mjs` runs isolated approved-style assertions and Studio interaction tests against the built frontend, including bundled-font checks and cloud-only picker/dispatch checks. `node desktop/test-typography.mjs` verifies the shared font stack, rendered fonts and fallback, offline loading, and Settings-row alignment at desktop/tablet/phone widths; it also supports `OUTPOST_TEST_BROWSER=webkit`. `node desktop/test-cloud-models.mjs` covers the cloud-filter and selection rules. `node desktop/test-image-viewer.mjs` runs synthetic image-viewer checks; set `OUTPOST_TEST_BROWSER=webkit` to run them in WebKit (Chromium is also used to generate valid test images). `node desktop/test-scroll-containment.mjs` checks fixed chrome and independent scrolling with long content, including streaming and resizing; it supports the same WebKit switch. `node desktop/test-ui.mjs /path/to/recorded-preview.json` runs the browser UI checks. Input must explicitly contain `{snapshot,runtime,models}` from a synthetic fixture or an authorized recording; use synthetic input for regression runs. No sample records or keys are bundled. Recorded preview mode refuses all mutations. `node desktop/test-stream-ui.mjs /path/to/recorded-preview.json` additionally exercises live updates through a controlled Tauri IPC fixture (14 checks). The original recorded-data run passed 48 assertions across 1440, 1050, 768 and 390px, plus light mode and offline handling. This does not claim automated native mouse/keyboard testing; macOS Accessibility permission was unavailable.
