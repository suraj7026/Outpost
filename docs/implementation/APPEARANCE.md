# Appearance and sidebar — approved design and implementation plan

## Design

The owner chose frosted glass with blur, a saved collapse-sidebar option, and corrected corner/padding geometry based on native window screenshots.

- Add Appearance to existing Settings, alongside untouched connection administration. Optional native macOS frosted glass, an opacity slider, and a collapse-sidebar checkbox. Preferences are device-local, not server mutations. Default solid appearance preserves the current setup until enabled.
- Use Tauri's native macOS vibrancy (behind-window NSVisualEffectView), not CSS blur pretending to blur the desktop. Keep text, icons, composer and evidence opaque. This Mac's background and avatar use translucent frosting, while content backgrounds retain a stronger tint for readability.
- Fall back to solid backgrounds for unsupported platforms, effect failures, Reduce Transparency or Increased Contrast. Show local errors rather than leaving a clear/unreadable window.
- One sidebar control pins a hover reveal or collapses/unpins a pinned sidebar; Cmd/Ctrl-B also collapses/restores navigation. Hover the left edge to slide in the sidebar and push the workspace over, then move away to dismiss it; native traffic lights appear inside the sidebar header after the spring settles. Cmd/Ctrl-K reveals search even when collapsed. This supersedes the original header toggle; see `AUTO-HIDE-SIDEBAR.md`.
- Keep 12px outer padding (8px only at ≤780px), reduce workspace corner radius to 8px (6px only at ≤780px) rather than the previous oversized 20px. Native macOS owns the outer window corners; do not introduce a competing CSS window silhouette. Preserve the outer scroll lock.

## Implementation and verification

1. Add isolated appearance state/storage, native effects integration and Settings controls.
2. Add persistent layout state and sidebar-local Close/Pin controls, edge-hover reveal, keyboard access and coordinated native traffic-light visibility.
3. Apply translucent surface tokens and coordinated corner geometry, without modifying provider/approval/artifact logic.
4. Test persistence, corrupt/unavailable storage, unsupported/effect failure fallback, accessibility preferences, sidebar/search/keyboard behavior, geometry and scroll containment in Chromium/WebKit. Run existing UI and image-viewer regression suites.
5. Build/sign, back up and replace only the app bundle; preserve identity and server state. No commits.

## Completed verification

- `desktop/test-appearance.mjs`: **95 checks in Chromium and 95 in WebKit**. Tests include native effect IPC contracts, rapid-toggle serialization, local persistence, invalid/unavailable storage, reduced-transparency fallback, native-effect errors, sidebar shortcuts/search, narrow layouts, switch geometry and corner/inset bounds.
- Scroll containment: **207 checks per browser**. Existing Studio (145), recorded UI (48), stream (14), image viewer (89 per browser), and connection-administration checks passed.
- Reviewed dark/light Settings screenshots; corrected inherited form-label and minimum-input-height styles so switches align beside text with 44×28 geometry.
- Native release build and strict signing verification passed. Installed and reopened `~/Applications/Outpost Desktop.app`; verified executable identity against the release bundle. Backup: `/tmp/outpost-before-appearance.1MH7wj/Outpost Desktop.app`.
- Native background blur requires Tauri's `macos-private-api` feature and transparent webview configuration; this local build is not represented as Mac App Store eligible. Only the `core:window:allow-set-effects` permission was added.
- Browser screenshots validate UI geometry and effect commands, not actual desktop pixels behind the native window. Native glass appearance still requires an owner-side visual check; macOS Accessibility automation is unavailable. Turn on **Settings → Appearance → Frosted glass** to enable it. Native material also follows macOS active/inactive appearance.
- No provider/task changes, identity/preferences deletion, or Git commits were performed.

## Earlier frosting refinement (superseded by the tuning below)

The owner requested a frosted This Mac control and stronger baseline frosting even at the lowest opacity.

- Native material is now `UnderWindowBackground`, appropriate for the window backdrop. macOS still controls its blur kernel; no custom native blur-radius claim or private blur-filter patch is made.
- The adjustable tint is composited over a fixed 18% veil: at the 20% slider minimum, the frame tint is 34.4% rather than 20%. Every slider step still changes tint. Reading surfaces retain at least 82% tint.
- This Mac's background uses 18% tint normally, 30% on hover, 28% when selected, and 36% for selected hover. Its avatar background is also translucent. All foreground content remains full-opacity and unfiltered.
- A 24px CSS backdrop blur treats the footer's in-app background; a 32px blur and 78% tint treat the floating hover drawer. These filters blur **in-app content**, not desktop pixels outside WebKit. Native NSVisualEffectView still supplies the actual behind-window blur.
- Glass-off, Reduce Transparency and Increased Contrast return solid surfaces and disable CSS backdrop filters. Existing settings, rounded corners, padding, pin/hover behavior and native traffic-light handling are unchanged.
- Appearance checks now total **123 per browser** (Chromium and WebKit), including minimum tint, slider response, every footer state, avatar tint, overlay blur and independent high-contrast CSS fallback. All sidebar, Studio, scroll-containment, recorded/live UI, image-viewer and connection-administration regressions passed. Browser screenshots at `/tmp/outpost-frost/` validate layout and CSS, not native desktop blur pixels.
- Rebuilt, strictly signature-verified, installed and reopened the refinement. Executable matches the release bundle; previous app preserved at `/tmp/outpost-before-frost.UiUbR4/Outpost Desktop.app`.

## Current translucency and motion refinement

The owner requested substantially more translucency, no separate dark This Mac tile, a bouncing sidebar that pushes the workspace, and native dots inside the sidebar row.

- Removed the fixed veil and, in the latest targeted refinement, reduced only frame/sidebar tint to one quarter of the opacity setting (5% at a 20% selection; 11.25% at the default 45%). Reading surfaces keep their prior 56–88% surface tint.
- The main content's appearance is preserved rather than inadvertently becoming more transparent with its parent: for the original frame alpha `b` and new frame alpha `f = b / 4`, the reading surface receives an underlay of `(b - f) / (1 - f)` beneath its existing surface tint. This restores the same composite over any desktop backdrop. Canvas-composite tests cover 20%, 45% and 80% settings in dark/light appearances in both engines.
- The narrow-screen drawer tint is also reduced by 75%, while retaining its blur. This Mac still adds no separate background.
- This Mac and its avatar have transparent backgrounds in every glass-mode state. They inherit the sidebar's glass rather than adding another material layer. Hover/selection still use foreground emphasis; keyboard focus outlines remain.
- Native `UnderWindowBackground` still owns actual desktop blur. Its kernel is controlled by macOS; no programmable native blur-radius claim is made. The browser-only narrow drawer now uses a stronger 64px **in-app** backdrop blur with much less tint. Native desktop layouts use the moving sidebar, not a floating pane.
- Accessibility solid-background overrides remain. Appearance checks pass in both browsers, including identical footer transparency across states, minimum opacity, no native-effect changes when adjusting opacity, and solid high-contrast fallbacks.
- Appearance checks now pass **129 per engine**, and sidebar checks **135 per engine**, including stable desktop geometry across resize breakpoints. The latter include the invisible hover edge, one state-aware button, 520ms entrance, 240ms exit and 350ms hover-dismiss delay.
- See `AUTO-HIDE-SIDEBAR.md` for motion, synchronized workspace layout, interruption behavior and native traffic-light placement.
