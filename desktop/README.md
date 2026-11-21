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

Use **Settings → Servers** for the clickable server list and **Add server**. Each server opens its own General, Setup & connection, Models & providers, Server updates, Devices & access, and Recovery pages. **Settings → Appearance → Theme** offers **Auto**, **Light**, and **Dark**, saved on this Mac. Auto follows macOS and updates while the app is open; manual choices override the system for the interface, native window chrome, setup dialogs, and terminal. Changing theme preserves open terminal sessions and other window preferences. Settings has deep links and back/forward navigation; opening another server’s settings does not change the current chat owner.

The sidebar and **All chats** group conversations under every server. Identical task IDs remain isolated by server. Offline and removed connections retain read-only history in memory until the app closes; remote history is never deleted by removing a saved connection. Choose a destination with **Run on…** when creating a new task, not a global environment dropdown. Each installation retains independent streams, pending recovery and provider state; switching chats never retargets an in-flight action. Legacy v1 live streaming and original Keychain enrollment remain supported.

History is memory-only while disconnected, not replication or a recovery checkpoint. Ambiguous legacy adoption requires explicit retirement consent; pending commands are never guessed into another installation. See [usage and limits](DESKTOP-ENVIRONMENTS.md) and [native IPC](NATIVE-ENVIRONMENTS.md). No live server migration or task handoff is delivered by these desktop changes. The reviewed build was installed and launched on 4 November 2026; the existing v1 connection remains usable, but server v2 activation is paused at a Linux signal-permission validation blocker.

## Set up server (local foundation)

**Settings → Servers → Add server** opens the large setup modal. **Setup & connection → Open server setup** resumes an existing server’s setup journal. Connect → Verify → Review → Install → Finish keeps the target identity visible throughout. Each server has its own progress, busy state, errors, consent and diagnostics; switching targets does not rearrange panels or retarget work. The advanced **Connect with a URL** path is inside the same modal.

SSH setup accepts a separate server address, username and port, and a selected private key or existing ssh-agent identity. Confirm the Ed25519 host fingerprint independently before read-only inspection. Known Kubernetes/container/data markers require migration review, not an automatic upgrade. Existing environment-aware installations can use an owned loopback tunnel, followed by signed enrollment verification and environment registration. Disconnect closes only the owned route, not the server.

The same flow provides **Review installation plan → Authorize & install**, with a protected native sudo-password dialog, twelve checks grouped into four phases, scoped log copy/native download, confirmed cancellation and durable status recovery. New plans default to restricted workspace access; full server control remains an explicit opt-in. Existing reviewed plans and installed permissions are unchanged. Closing the modal backgrounds the view without cancelling a launched job. Receipt updates are bound to target/operation/environment/release identity and reject stale progress. It creates a separate, initially empty environment with private runtimes and non-root persistent services. Server readiness is 10/12; **Connect and finish setup** must verify signed enrollment before 12/12. Saved, verified SSH installations now reconnect automatically on launch and after tunnel loss, without Inspect/Reconnect/setup clicks, reinstalling, or retiring the legacy environment. General offers persistent Pause/Resume controls; changed trust or enrollment still needs attention. Browser provisioning may update shared Ubuntu libraries; review a maintenance window first.

Cross-release upgrades, rollback, history migration, Kubernetes removal and automatic repair of partial installs remain unavailable. SSH password login, key-passphrase UI and aliases/proxy commands remain unsupported; encrypted keys must be unlocked in the agent. The new installer was exercised in disposable real Ubuntu VMs, not either owner server.

## Native versus web

The owner-selected Graphite Studio layout is implemented directly in React, including its custom sidebar. Typography uses locally bundled Google Sans Flex with Google Sans as the fallback throughout the app, including controls, conversations and code/log text; OS-owned dialogs retain native typography. Font provenance is in `src/assets/fonts/README.md`, and redistribution notices ship in `dist/font-licenses/`. The separate native title strip is hidden; macOS traffic lights are overlaid inside the sidebar, with draggable app headers and native window resizing. In-app branding uses the existing three-bar Outpost application icon. System appearance is followed in Auto mode; Reduce Motion remains authoritative. The previous `src-tauri/native/sidebar.m` bridge is retained as source history but is no longer compiled or installed.

The task workbench has a compact shared header and a collapsible document/browser workspace flush beside chat. A single rounded panel icon stays at the top-right in both states. The full-height divider is resizable (chat minimum/default 600px, workspace minimum 420px); narrower layouts switch to one pane rather than squeezing the composer. The file list toggles independently. Tabs, toolbar rows, and file-list separators share their heights; the workspace has no inset box or review acknowledgement footer. The outer window is fixed; conversation, evidence, recent tasks and page content scroll independently without moving the header, composer or shell padding. Settings opens directly into Startup, Theme, Conversation and Window preferences, using the app's shared icon-led rows, radio groups and switches. The Window section includes a live miniature preview of frost, opacity and sidebar collapse; it respects reduced motion and transparency. Optional native macOS frosted glass, opacity and the collapse-sidebar preference remain saved on this Mac. The sidebar's single state-aware button pins a hover-revealed sidebar or collapses/unpins a pinned sidebar; ⌘B also hides it and the native traffic lights. Hover the left edge to spring the sidebar in and move the workspace over; moving away slides it back out. Pinning holds that same layout. Reduce Motion disables the animation. Native traffic lights appear inside the sidebar header after it settles. Desktop resizing keeps the sidebar width/padding fixed, while AppKit retains the native button anchor synchronously without waiting for resize IPC. The spring uses 520ms in / 240ms out with a 350ms hover-dismiss delay. The edge trigger is invisible, and ⌘K reveals task search. Native window corners are paired with smaller inset workspace corners and even padding. Frosted glass requires native macOS support; a browser preview does not qualify native appearance or window-control behavior. Exact-action review opens a revision-bound dialog; approval and dispatch remain separate explicit operations. Automations and Memory sit in the main navigation after Library and before All chats; there is no separate Workspace tools disclosure. Command-N opens a new task; Command-K searches recent tasks.

## Consistent pages, controls, and chat attention

Settings, Machines, Library, Automations, Memory, and All chats share a centered 1,040px column with aligned page/section headings and bare icons in the left gutter. Memory reserves the selector space so All servers / One server does not move when the dropdown appears. Library cards show their owning chat and an Open chat action.

The separate Approvals destination is removed. Sidebar chats and All chats show counts derived from that chat's owning connection: pending approvals and authorized actions waiting for dispatch. All chats offers a 40px Needs attention filter combined with search/server filters. Ready for your review by itself does not imply an approval is pending. Offline/removed-server counts are explicitly last-known. Old saved Approvals startup locations migrate to All chats.

A chat's attention indicator opens the exact-action dialog. Approval/deny/dispatch controls share the footer, with primary action last. Approval never implicitly dispatches. The dialog rejects a changed task, owner, revision, nonce, digest, arguments, target, effects, or state before sending; unavailable connections, pending transport recovery, and busy/uncertain outcomes remain blocked.

Dark colors use sidebar `#0F0F0F`, workspace `#1E1E1E`, raised controls `#282828`, selected states/dividers `#363636`, and neutral text. Cards and dialogs use nearby neutral surfaces; semantic status colors remain. Light theme, native glass preferences, and forced-color accessibility retain their own behavior. Page actions use 36px controls, toolbar fields use 40px, and dialogs share 16px corners and consistent padding. Long schedule forms keep their header/footer visible while fields scroll. Specialized browser, image, and setup viewers retain their working dimensions.

Validation: `node desktop/tests/test-ui-consistency.mjs` (also `OUTPOST_TEST_BROWSER=webkit`), `node desktop/tests/test-settings-refinement.mjs`, `node desktop/tests/test-startup-navigation.mjs`, and `node_modules/.bin/tsx --tsconfig desktop/tsconfig.json --test desktop/tests/test-chat-attention.ts`. From `desktop`, `node tests/test-dialog-consistency.mjs` and `node tests/test-workspace-refinement.mjs` cover forms and mutation guards. All use synthetic connections, not live servers.

## File and browser workspace

Successful `file.write` actions now expose **Review file** cards. The panel reads actual current task-workspace bytes through signed, environment-bound `workspace.files` and `workspace.read` queries. Files created by workspace commands also appear in the list after refresh. Search, folder expansion, recorded-change filtering, document outline, Preview/Source/Changes, Copy, and native Download are available. Text attachments open in the same viewer; supported images retain their existing image viewer/download behavior.

The Browser tab reuses the live server browser and its explicit Take control / Return control flow. Polling and freshness timers stop while the tab or workspace is hidden. Closing the workspace preserves the selected file, tab, view mode, file-list preference, and preferred split width while the chat remains mounted. Escape closes it and restores focus to the fixed toggle. The divider supports pointer capture, arrow keys, Shift+arrows, Home/End, and double-click reset.

### Safety and limits

- Workspace listing and reads are read-only: no agent commands, approval changes, or directory creation. Listing is bounded to 1,000 scanned entries/eight directory levels. Symlinks, hardlinks, special files, and path escapes are refused.
- Preview/download supports UTF-8 text up to 1 MiB. Markdown does not execute HTML or fetch embedded images. Large/complex documents use bounded source rendering. Explicit HTTP(S) links open externally.
- Changes means **recorded `file.write` evidence**, not a Git working-tree diff. New-file additions are shown only when current bytes match the recorded write. Modified-file comparisons require a known hash-linked previous write; missing/stale history is stated instead of inventing a diff.
- Native downloads verify scope, path, byte length, and SHA-256, then save a uniquely named copy into Downloads. Files changed since preview require refreshing before download. No remote file writes are performed by the reviewer.
- Existing remote servers must be updated to a compatible bundled release for the new workspace query types. Both the main and legacy-compatible bundles include them. Unsupported queries show **Server update required** with an **Open Server updates** link scoped to the chat's server; legacy unbound connections instead link to setup guidance. Permission/network failures are not treated as missing features. A verified automatic update refreshes that server's open file/listing without a manual Retry; reconnecting also reloads them. The app never substitutes action arguments for saved file contents. Published artifacts and existing browser APIs remain usable.

Validation: `node desktop/tests/test-workspace-panel.mjs` and `OUTPOST_TEST_BROWSER=webkit node desktop/tests/test-workspace-panel.mjs` exercise the production build using isolated synthetic IPC. Unit tests: `node_modules/.bin/tsx --tsconfig desktop/tsconfig.json --test desktop/tests/test-workspace-files.ts desktop/tests/test-workspace-resize.ts desktop/tests/test-document-content.ts`. Server tests live in `server/artifacts/workspace-review.test.ts` and `server/gateway/workspace-review.test.ts`; native download tests use `cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features transport::tests::workspace`.

## Subagent runs

Native subagent launches appear as compact chat rows with status, observed assignment/title, child model when recorded, and recorded duration. Expand a row for its returned summary and recorded files; **Open run** shows the full-height Activity/Result inspector beside chat. **Expand run** opens a larger modal with the assignment, messages, and expandable recorded tool inputs/outputs. Escape returns from the modal to the side panel; closing the panel restores its originating chat control. The run inspector and Files workspace share the existing resizable split without discarding their current view.

- Detailed recording requires a server release containing the `subagent_run` projection. Only newly observed launches gain detailed history; older runs explicitly show unavailable details, without backfilling or scanning native sessions.
- Finished background launch tools are not treated as completed children. Missing evidence, interruption, partial results, truncation, and offline last-known state are shown explicitly.
- This is read-only observation. Individual stop, steer, and resume are unavailable; opening or copying a run never stops the parent task.
- Native subagents retain their existing server-worker privileges and native-extension execution policy, without individual action approvals. This UI does not introduce an approval sandbox or change extension enablement.
- Display records are bounded and omit hidden reasoning, raw native metadata, capability tokens, and internal paths. Content renders as inert text, without HTML execution or embedded remote loads. See the [server contract and privacy limits](../server/pi-adapter/SUBAGENT-RUNS.md).

Validation: `node desktop/tests/test-subagents.mjs` and `OUTPOST_TEST_BROWSER=webkit node desktop/tests/test-subagents.mjs` exercise the built real app with synthetic IPC. Unit tests: `node_modules/.bin/tsx --tsconfig desktop/tsconfig.json --test desktop/tests/test-subagent-model.ts`. No live servers or native subagent jobs are launched by these browser tests.

## Server updates

**Settings → Servers → your server → Server updates** exposes the existing signed updater; old `/runtime` bookmarks continue to work. It shows Outpost release IDs/sequences separately from Pi versions, and **Check for server updates** reports an exact bundled match, a newer compatible release, or an actionable block. These checks use the release bundled with the app, not npm or an online release feed.

Enable **Automatic server updates** once for the reviewed saved servers using protected native authorization. While the app is open and connected, the supervisor checks and updates enrolled servers sequentially after active work drains. Offline servers are checked on reconnect. Existing credentials/history, compatibility checks, rollback and unknown-outcome guards remain intact. Opening the page does not enroll servers. Building this source does not update the installed app or live servers; install a new app build, then enable or review updates there. See [authorization and release qualification](../deploy/environment/AUTOMATIC-UPDATES.md).

## Startup page

Outpost opens the **New task home page** by default. Under **Settings → Startup → On startup**, optionally choose **Last working page** to reopen the last chat with its owning server/environment, or another working page. This local preference applies on the next launch. Drafts and terminal state are not restored; missing restore targets fall back to the New task home page.

## Wired workflows

- Task creation and follow-up instructions with exact provider/model identities and a Full control / Auto selector for tasks, schedules and recovery investigations. Managed servers supply the Pi provider catalogue; older servers retain the advertised Ollama Cloud-only picker. Empty/failed catalogues or unavailable selections block submission rather than silently changing providers. A selection applies to the next instruction, not the response already in progress.
- Live text, model-exposed thinking and tool-call lifecycle over an authenticated SSE/IPC stream, with reconnect snapshots and durable partial checkpoints.
- Server-owned history, conversation rendering, follow-up instructions, pause/resume/cancel.
- Automatic action dispatch with exact action arguments and observed results. Authorized actions are queued work, not approval requests.
- Uploads with content hashes, integrity-checked artifact downloads, browser captures and JSON evidence.
- In-app PNG/JPEG/WebP previews in chat, Evidence and Library preserve the image's aspect ratio without cropping or upscaling, bounded to 560 × 360 px. Chat image cards (including their filename and download footer) are centered within the conversation column; screenshot padding is preserved. Click to view; Download is separate. Fit, actual size, zoom and drag-to-pan; left/right arrows browse the task's attachments, Escape closes, `0` fits and `1` selects actual size. Filename/dimensions, retry states and focus restoration are included.
- Markdown images can reference a unique attachment in the same task by filename, `./filename`, or `#artifact-ID`. External HTTPS images require an explicit **Load image** click per image; anonymous requests send no cross-origin cookies or referrer, and the remote site must allow CORS image sharing. Loaded images use the same viewer, with **Open original** for browser access rather than an unverified native download. Other URLs/local paths show an unavailable state; recorded previews never fetch images.
- Read-only server inspection as an explicit agent task; host cards show recorded command results, **not** invented live metrics.
- Connection settings, first-device pairing and model discovery.
- Additional-device enrollment using the trusted Mac's signed request, trusted-device revocation with confirmation, and revision-bound Recovery Hold acknowledgment. Unknown enrollment outcomes require refreshing and verifying the device ID/key; enrollment is never automatically retried.

Full control remains the default. Auto permits narrowly certified routine actions and requires exact approval for financial, destructive, security-sensitive and unknown actions. Scripts, root commands and browser interactions may need review; native extensions and subagents are disabled in Auto. One approval executes the displayed action once and continues the agent. Legacy Ask permission inputs normalize to Auto. Auto is disabled on servers without verified support. On server startup, legacy pending approval requests are retired without execution and affected tasks pause for explicit resume; uncertain effects are never replayed. Update both the desktop app and server to apply this behavior. Authentication, recovery/maintenance holds and host-access boundaries remain unchanged. Root access is not a sandbox. Cloud-selected models send context to Ollama Cloud; Camoufox runs on your own server once the engine migration is deployed; Pi uses its selected model directly.

**Settings → Appearance → Conversation detail** controls all tool-call and model-provided thinking disclosures. **Compact** (the default) starts individual rows collapsed; **Extended** opens them. Visually consecutive tool calls share a compact activity stack with live progress. Empty, whitespace-only and reasoning-only assistant envelopes do not split the stack; their reasoning remains available in the run’s Thinking disclosure. Visible responses, errors, interruptions and images still divide activity, with row and raw-output expansion retained if a late message splits or merges a group. Untouched completed stacks collapse automatically in Compact, while inspected rows and manually expanded groups stay visible. Active work, failures, interrupted/unknown outcomes and approval requests always keep their group open. Text, images and owner turns remain outside these groups and keep their chronological positions. Each row can still be toggled independently, and that choice survives streaming updates and tool/action linking. The preference is saved on this Mac; if storage is blocked, it lasts for the app session and a warning explains the persistence failure. Active thinking uses a subtle three-dot animation that stops on completion, response text, interruption or error; Reduce Motion uses static dots. Models without exposed reasoning do not get fabricated traces or durations. Normal replies and execution are unchanged, and exact-action approval dialogs always show their review details. Tool lifecycle is live, but subprocess stdout is not yet streamed individually.

## SSH terminal and OS reboot

Open **Terminal** beside the server name in a chat's composer, or **Machines → Open terminal**. Both use the chosen server's verified saved SSH connection and share its shell. Collapsing the pane keeps it running; Disconnect and app quit close the shell without cancelling agent tasks. Use remote `tmux` for persistent shell work.

**Reboot server…** is available in either terminal toolbar. It requires exact-host confirmation and optional protected native sudo authorization, interrupts the entire server, and never retries dispatch automatically. Read-only boot-ID checks distinguish a verified return from an unknown outcome. This is separate from resetting an Outpost installation. URL-only/unbound legacy connections need verified SSH setup first.

## Server provider sign-in

Use **Settings → Servers → your server → Models & providers**. Managed servers have one provider catalogue; the legacy Ollama list appears only for older servers without provider management. Pi and credential storage remain on that server (Server 2 in the existing deployment). For OpenAI browser sign-in, Outpost starts a flow-bound loopback listener on this Mac before opening the browser, then sends the full callback URL through the private signed login prompt. Keep Settings open until the separate **Save server credential** confirmation. An occupied port or interrupted return offers explicit manual-paste guidance; never paste a callback URL into task chat. Start a fresh login after an expired attempt. General callback forwarding and package installation remain disabled. The owner-approved, pinned **pi-ollama-cloud** provider is loaded on the shared server runtime and appears as **Ollama**. Its Cloud API key can be saved privately, but the strict access policy now blocks selection until an approved credential-scoped verifier is implemented; public discovery is insufficient. The old daemon-backed conversational provider is retired without rewriting history. For a saved ChatGPT login, model choices now come from authenticated account discovery, with server-side checks before inference. A discovery failure removes unverified choices rather than falling back to Pi's catalogue or API billing. This applies to every Pi provider: currently only ChatGPT OAuth has a verifier; saved API keys and other subscriptions do not by themselves enable any models.

## Migration limits

- Automations and Memory currently display existing server records. Desktop editing is not implemented; retained iPhone forms are not new-feature parity.
- Administration is available under **Settings → Servers → your server → Devices & access / Recovery**, only with confirmed current device authority and no unknown pending command. Offline and recorded previews are read-only. These controls reuse the Keychain signer but do not claim biometric confirmation for every operation. Live cross-device, identity-continuity, pending-command restart and recovery rehearsals remain unqualified; do not delete identity/server data or reopen bootstrap as a workaround.
- The task workspace’s Browser tab offers live browser frames and explicit **Take control / Return control**, with an enlarged view. Input is exclusive and transient; returning control leaves Pi paused. This is screenshot polling, not video or a Linux desktop.
- iPhone still uses the retained Swift client. Linux/Windows secure identity storage and native navigation are not implemented.
- Closing the app does not cancel server-owned tasks. Pausing/cancelling a task does not undo completed commands.

## Verification

```sh
# From the repository root:
npm --prefix desktop run build
node desktop/tests/test-connection-administration.mjs # synthetic IPC; no Keychain or live server
node desktop/tests/test-environments.mjs
node desktop/tests/test-appearance.mjs
OUTPOST_TEST_BROWSER=webkit node desktop/tests/test-appearance.mjs
node desktop/tests/test-conversation-detail.mjs # synthetic Compact/Extended and thinking lifecycle tests in Chromium + WebKit
node desktop/tests/test-terminal-theme.mjs
# Install the browser first if missing: npx playwright install webkit
OUTPOST_TEST_BROWSER=webkit node desktop/tests/test-environments.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features

# Explicit opt-in only: uses the real paired Keychain identity and private server.
# Creates a small verification task, tests retry and a second Pi turn.
OUTPOST_LIVE_CLIENT=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml live_signed_client_roundtrip -- --ignored --nocapture
```

The earlier single-environment implementation passed the live Rust roundtrip and was inspected in the packaged app with the existing identity. That historical evidence does not qualify the current multi-environment changes: their reviewed native and Chromium/WebKit tests use synthetic identities/IPC, and the live-Keychain test remains intentionally ignored.

From the repository root, `node desktop/tests/test-browser-modes.mjs` checks browser viewing, takeover, transient input, unknown outcomes, competing-device states, enlarged view and stale task replies at three widths; it also supports `OUTPOST_TEST_BROWSER=webkit`.

From the repository root, `node desktop/tests/test-studio-ui.mjs` runs isolated approved-style assertions and Studio interaction tests against the built frontend, including bundled-font checks and cloud-only picker/dispatch checks. `node desktop/tests/test-typography.mjs` verifies the shared font stack, rendered fonts and fallback, offline loading, and Settings-row alignment at desktop/tablet/phone widths; it also supports `OUTPOST_TEST_BROWSER=webkit`. `node desktop/tests/test-cloud-models.mjs` covers the cloud-filter and selection rules. `node desktop/tests/test-image-viewer.mjs` runs synthetic image-viewer checks; set `OUTPOST_TEST_BROWSER=webkit` to run them in WebKit (Chromium is also used to generate valid test images). `node desktop/tests/test-scroll-containment.mjs` checks fixed chrome and independent scrolling with long content, including streaming and resizing; it supports the same WebKit switch. `node desktop/tests/test-ui.mjs /path/to/recorded-preview.json` runs the browser UI checks. Input must explicitly contain `{snapshot,runtime,models}` from a synthetic fixture or an authorized recording; use synthetic input for regression runs. No sample records or keys are bundled. Recorded preview mode refuses all mutations. `node desktop/tests/test-stream-ui.mjs /path/to/recorded-preview.json` additionally exercises live updates through a controlled Tauri IPC fixture (14 checks). The original recorded-data run passed 48 assertions across 1440, 1050, 768 and 390px, plus light mode and offline handling. This does not claim automated native mouse/keyboard testing; macOS Accessibility permission was unavailable.
