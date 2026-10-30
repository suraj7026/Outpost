# Spring sidebar and native window controls

## Current approved behavior

The owner superseded the earlier floating-pane design: on desktop, hovering the left edge slides in the actual sidebar **and pushes/resizes the workspace**. A single state-aware button pins the hover-revealed sidebar; once pinned, that same button collapses and unpins it. The saved pin preference, Cmd/Ctrl-B, Cmd/Ctrl-K, hover delay, keyboard focus and modal protections remain.

- Spring entrance: 520ms, 7px overshoot, 2px rebound; exit: 240ms after the 350ms hover-dismiss delay.
- Sidebar translation and workspace grid width follow the same timing. Re-entry during dismissal starts from both current positions rather than jumping or restarting offscreen.
- Pinning an already revealed sidebar causes no second layout shift. Closing restores full workspace width. All supported native window widths (minimum 900px) use the push layout; browser-only layouts at 780px or narrower retain a usable drawer.
- Desktop resizing keeps a fixed 222px sidebar, 12px shell inset and consistent sidebar padding. Legacy 900/1150/1600px sidebar breakpoint jumps no longer move navigation, branding or window-control anchors. Only browser drawers at ≤780px use the 8px shell inset.
- Reduce Motion disables both animations. Closing content becomes inert immediately, then leaves layout after its exit finishes. Keyboard reveal focuses sidebar controls so it cannot auto-dismiss before a keyboard user reaches them.
- Native traffic lights remain hidden during movement and appear **inside** the measured sidebar header after settling. They hide immediately when dismissal begins. The single Pin/Collapse control remains at the opposite end of that same row.
- This Mac, its selected/hover states, and its avatar share the sidebar's transparency without a separately tinted tile. Frame/sidebar tint is now only one quarter of the opacity setting; the main content's previous composite is preserved.
- The edge hover target remains interactive but paints nothing. The former strip came from the generic `button:hover:not(:disabled)` rule outranking the edge's hover rule. The target now has a stronger transparent override and zero opacity; keyboard entry immediately transfers focus to the visible sidebar control.

## Implementation

`useSidebar.ts` owns reveal/focus/pin handling and native coordination. `useSidebarMotion.ts` uses the Web Animations API to animate the sidebar and CSS grid together, capture interrupted positions, cancel superseded completions and honor reduced motion. No animation package was added. The existing outer scroll lock, padding and corner geometry remain intact.

`native/window_controls.m` uses the real AppKit window buttons. Showing a button can reset its native layout, so the bridge **shows first, completes native layout, then positions** the buttons using the measured CSS header coordinates. It sizes their native titlebar hit region to the three buttons, not the entire workspace header. The fixed `trafficLightPosition` config was removed so Tao cannot overwrite measured positions. A per-window native controller retains the last requested visibility/anchor and synchronously restores it on AppKit resize, update and view-frame notifications—including AppKit resetting individual button frames. Updates are guarded against reentrancy and no-op frame writes; observations are window-scoped and cleaned up with the controller. No swizzling, reparenting, global event hooks or replacement buttons are used. Native access is dispatched onto the main thread by `window_controls.rs`. The frontend deduplicates identical anchors and skips superseded queued requests, so resizing no longer waits for or floods browser-to-native IPC.

During unpinned reveal only, a 120ms window-local native pointer query includes the native-button region, which doesn't emit DOM pointer events. Hit bounds use the intended sidebar width rather than its changing animated bounds. No Accessibility permission, global event hook, desktop capture or server request is required. DOM leave/blur handling remains a fallback, and timers/observers stop when unused.

The legacy `native/sidebar.m` remains uncompiled; only the small window-controls bridge is built.

## Verification

- Sidebar: **135 checks in Chromium and 135 in WebKit**, including sampled intermediate grid positions, spring overshoot/rebound, native control timing/coordinates, interruption continuity, inert closing content, pin persistence, keyboard access, reduced motion, narrow fallback and modal protection. Resize regression sweeps cross 900/901, 1149/1150/1151 and 1599/1600/1601px in both directions, checking unchanged sidebar/header geometry, no redundant positioning IPC and visible Evidence.
- Appearance: **129 per engine**; Studio 179 per engine; scroll containment 207 per engine; recorded UI 48; streaming 14; image viewer 89 per engine; connection-administration suite passed.
- Native AppKit test validates real standard-button hide/show, positioning within the sidebar row, a confined native hit region, repeated resize/layout/update cycles without frontend calls, immediate correction of a reset button frame, hidden-state retention and pointer bounds without opening a visible window:
  ```sh
  clang -fobjc-arc -framework Cocoa desktop/src-tauri/native/window_controls.m desktop/src-tauri/native/window_controls.test.m -o /tmp/outpost-window-controls-test
  /tmp/outpost-window-controls-test
  ```
- Browser screenshots: `/tmp/outpost-sidebar/` and `/tmp/outpost-frost/`. Browser fixtures verify UI/native IPC contracts, not WindowServer pixels; full native mouse automation remains unavailable without Accessibility permission.

Use `PLAYWRIGHT_BROWSERS_PATH=/tmp/outpost-playwright`; set `OUTPOST_TEST_BROWSER=webkit` for WebKit. No live server/provider mutations, data deletion or Git commits.

## Installation

Native release build and strict signature verification passed. Installed and reopened `~/Applications/Outpost Desktop.app`, with its executable verified against the release bundle. Latest previous app retained at `/tmp/outpost-before-resize-fix.lUIwx0/Outpost Desktop.app`; the preceding persistent-Evidence backup remains at `/tmp/outpost-before-persistent-evidence.7JV2nv/Outpost Desktop.app`. Identity, preferences and server history were preserved.
