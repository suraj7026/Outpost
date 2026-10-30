# Fixed window and independent scroll panes

The owner reported that the whole desktop window could scroll. The previous shell had a viewport height but did not lock `html`, `body` or the React root, disable document overscroll, or prevent programmatic scrolling of hidden-overflow layout ancestors. Conversation tail-follow and thinking disclosure also used ancestor-traversing `scrollIntoView` calls.

## Correction

- Anchor the React root to the viewport; document/root overflow is clipped and root overscroll is disabled.
- Give the app grid one explicitly bounded row. Layout-only containers use `overflow: clip`, which cannot become programmatically scrolled containers.
- Keep conversation, evidence, recent tasks and page contents independently scrollable with overscroll contained within their panes.
- Tail-follow changes only the conversation pane's `scrollTop`. Thinking disclosure adjusts only that same pane; neither traverses the window's ancestors.
- Keep the header, composer, sidebar chrome and outer insets fixed during scrolling, streaming and resizing. Dialog/image-viewer scrolling remains independent.

## Verification and installation

- `desktop/test-scroll-containment.mjs`: **207 checks passed in Chromium and 207 in WebKit** with long messages/code blocks, long evidence lists, task-list overflow, wheel events at pane boundaries, live updates, thinking expansion, programmatic scrolling, window resizing and route changes at 1440/900/390px.
- Regression checks passed: 145 Studio, 48 recorded UI, 14 live-stream, 89 image viewer in each engine, and connection-administration suite.
- Native release build and strict signature verification passed. Replaced and reopened `~/Applications/Outpost Desktop.app`; executable verified against the release build. Previous bundle: `/tmp/outpost-before-scroll-lock.hAYOP0/Outpost Desktop.app`.
- Browser checks exercise WebKit but are not automated native macOS trackpad/elastic-scroll testing. No provider/task mutations, identity/data deletion or commits were performed.

Tests can use the isolated browser runtime with `PLAYWRIGHT_BROWSERS_PATH=/tmp/outpost-playwright`; add `OUTPOST_TEST_BROWSER=webkit` for the WebKit run.
