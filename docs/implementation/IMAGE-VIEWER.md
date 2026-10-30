# Image viewer

## Approved design

The owner approved a Graphite Studio in-app lightbox for screenshots and uploaded images: opening an image is separate from downloading, with fit-to-window, actual size, zoom, drag-to-pan, dimensions/name, Escape to close, and arrow-key navigation through the same task's images. Supported formats: PNG, JPEG and WebP.

## Implementation plan

1. Extract artifact presentation from TaskView and add a reusable image-loading hook. Fetch only through the existing authenticated, SHA-256-verified Rust artifact command. Do not render remote Markdown image URLs or add new network/CSP permissions.
2. Mount one shared modal viewer for Evidence and Library. Group navigation by task, reset view on image/revision changes, preserve focus and provide local loading/error/retry states. Keep download explicit using the existing save command.
3. Lazily load thumbnail bytes when their artifact enters the viewport. Revoke object URLs on replacement/unmount and ignore late responses.
4. Test supported formats, keyboard/focus behavior, actual-size/fit/zoom/pan, same-task navigation, explicit downloads, loading/error/stale responses, recorded-preview blocking and responsive/reduced-motion appearance using synthetic IPC only.
5. Run existing regressions, build/sign/reinstall with a bundle backup. Preserve all user identity and server data. No live provider/task commands and no commits.

## Verification

Completed and installed at `~/Applications/Outpost Desktop.app`. The signed installed executable matches the release bundle. Previous app: `/tmp/outpost-before-image-viewer.zkwahr/Outpost Desktop.app`.

- Image viewer: **89 checks passed in Chromium and 89 in WebKit**, including supported formats, actual size/fit/zoom/pan, modal keyboard focus, same-task navigation, explicit save payload, late responses, corrupted-image/transport retry, URL revocation, recorded-preview blocking, reduced motion and narrow/light layouts. WebKit testing caught and fixed Safari's non-focusing button-click behavior by retaining the explicit opening element.
- Existing regressions: **145 Studio**, **48 recorded UI**, **14 streaming**, connection-administration suite, and **3 cloud-model tests** passed.
- Browser backend fixtures: **2 passed** for worker contracts/failure/cancellation and the existing Playwright headless/lease fixture. These are not a live Browser-Use provider qualification or a new takeover feature.
- Native release build and strict signature verification passed. Screenshots reviewed under `/tmp/outpost-image-viewer/` and `/tmp/outpost-image-viewer-webkit/`. No claim of native automated mouse/keyboard testing; macOS Accessibility access remains unavailable.
- The latest sidebar correction left-aligns the Outpost logo/wordmark with navigation icon padding. Its bounding-box assertions pass.

A disk-full build was recovered by cleaning only disposable Rust **debug** build output (`cargo clean --profile dev`). The shared Playwright cache subsequently disappeared during verification; browsers were restored in the isolated `/tmp/outpost-playwright` directory. To repeat the checks in this environment, set `PLAYWRIGHT_BROWSERS_PATH=/tmp/outpost-playwright`; set `OUTPOST_TEST_BROWSER=webkit` for the WebKit viewer run. No identity, server data, unrelated source work, or application backups were deleted.
