# Graphite Studio — desktop implementation

The approved reference is `mock/graphite-studies/` → **Graphite Studio**. The owner's follow-up screenshots clarified that the second image is the target, including its exact fonts, custom navigation, compact task header and narrow conversation column—not just the same color palette.

## Scope and superseded decision

The initial AppKit-sidebar adaptation was superseded by the owner's request for the mock's exact design. React now owns the entire application surface, including the sidebar. Tauri/macOS retain native traffic lights and window behavior. Following the owner's next screenshot, the separate title bar is removed using a hidden-title overlay; traffic lights sit in the sidebar and header drag regions support window movement. The old Objective-C sidebar source remains in the repository but is no longer compiled or installed; its IPC bridge was removed. Rust reports `nativeSidebar: false`.

- Exact Geist Regular/Medium/Semibold font binaries copied from the mock, including the OFL license. No font CDN.
- In-app branding uses the three-bar silhouette from the owner's existing Outpost icon, rendered as a theme-aware SVG without the rounded tile or box boundary. The macOS application icon remains unchanged.
- The redundant Personal workspace selector and Private workspace footer are removed. Connection settings remain in the sidebar footer. Per the latest screenshot correction, the logo/wordmark group is left-aligned with the navigation icons and the controls' inner padding; sidebar gutters balance the window edge against the main workspace, accounting for the outer shell inset. Task rows align with the New task control.
- The new-task picker and Connection settings list only cloud-tagged models advertised by the connected Ollama catalogue (`:cloud` and size-qualified `-cloud` tags). Exact identifiers are preserved. Local defaults cannot leak into the picker or task payload. Empty/failed catalogues disable task creation rather than silently falling back to local inference. Existing tasks retain their actual recorded model.
- Matching Graphite light/dark palette, sidebar geometry, 66px task header, 660px conversation/composer, inset inspector, rounded controls and reduced-motion handling.
- Per the owner's bottom-edge correction, the shell now has equal outer padding on all four sides: 12px on desktop and 8px on narrow layouts. The composer and inspector share a 12px internal bottom inset. Tests measure actual bounding boxes, not just CSS declarations, and verify the page does not overflow vertically.
- Tasks, Approvals, Machines and Library navigation. Automations and Memory remain accessible under Workspace tools. Sidebar search and Command-N/Command-K are wired.
- Initial connection opens the latest task when history exists; New task opens the existing task composer.
- Evidence uses Overview/Changes/Activity. Its handoff uses actual action records, including adverse results; it does not fabricate plan stages. Proposed changes show exact recorded arguments, not invented before/after diffs. Artifacts and full audit records remain available.
- Review opens a keyboard-accessible modal containing the existing exact-action controls. A revision change invalidates that open review. Nonce, digest, revision, explicit dispatch, unknown-outcome blocking and read-only safeguards remain intact.
- Server-owned content is not rewritten to imitate the mock's demonstration answer. No sample task, replay simulation, approval undo or fake progress ships in the app.

## Verification

- `npm --prefix desktop run build`: passed.
- `node desktop/test-studio-ui.mjs`: **179 checks passed in Chromium and 179 in WebKit** (`OUTPOST_TEST_BROWSER=webkit`), including byte-for-byte font comparisons and computed-style comparisons against the actual mock in dark/light appearances. Also covers 1440/1050/900/768/390px, modal focus/Escape, revision invalidation, keyboard tabs, persistent desktop Evidence, result interpretation and mutation guards. Both Evidence show/hide controls, their callback/state, and collapsed-layout CSS were removed at the owner's request. Evidence remains visible across reload and left-sidebar pin/collapse; narrow browser layouts retain the existing Conversation/Evidence tabs.
- `node desktop/test-cloud-models.mjs`: **3 unit tests passed** for tag filtering, exact identifiers and unavailable/local-default handling.
- `node desktop/test-ui.mjs /tmp/outpost-recorded-preview.json`: **48 checks passed**.
- `node desktop/test-stream-ui.mjs /tmp/outpost-recorded-preview.json`: **14 checks passed**.
- `node desktop/test-connection-administration.mjs`: passed synthetic enrollment/revocation/recovery, stale authority, pending-unknown, offline and recorded-preview checks.
- `cargo test --locked`: **7 passed, 1 intentionally ignored live-server test**.
- Native release build and strict ad-hoc code-signature verification passed.
- Browser screenshots reviewed in `/tmp/outpost-studio-ui/`. The preceding installed build's `/tmp/outpost-exact-studio-final.png` shows the actual private-server connection and custom Geist sidebar. `/tmp/outpost-studio-overlay.png` confirms removal of the native title strip, but the latest launch is awaiting the owner's macOS Keychain permission dialog, so full native visual verification of this last revision remains pending. Browser checks verify its branding and cloud-only controls. Automated native interaction was not performed because macOS Accessibility access is unavailable.

## Installation

Installed and reopened `/Users/sudarshanrajagopalan/Applications/Outpost Desktop.app`. Installed executable verified against the release build; running executable path verified. The build preceding the image viewer and latest left-alignment correction is retained at `/tmp/outpost-before-image-viewer.zkwahr/Outpost Desktop.app`. See [image viewer verification](IMAGE-VIEWER.md). The build preceding the frameless-logo/sidebar cleanup is retained at `/tmp/outpost-before-sidebar-polish.oPria1/Outpost Desktop.app`. The build preceding the uniform-padding correction is retained at `/tmp/outpost-before-padding.k6uisL/Outpost Desktop.app`. The build preceding the title-bar/icon/cloud-only changes is retained at `/tmp/outpost-before-overlay.UWmB0Y/Outpost Desktop.app`. Earlier builds remain under `/tmp/outpost-before-exact-studio.RTiyxo` and `/tmp/outpost-pre-studio.ay2iV7`.

Only application bundles were replaced. No Keychain identities, caches, preferences, server history or unrelated repository files were deleted. No live task/provider mutation was used for verification. No Git commits were made.
