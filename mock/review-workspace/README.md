# Outpost review workspace mock

Open `index.html` in a browser. From the repository root on macOS:

```sh
open mock/review-workspace/index.html
```

This isolated design mock does not change the application or connect to an agent. It reuses Outpost's bundled Google Sans Flex font and dark palette.

## In the real app shell

Open `in-app.html` to see the proposal rendered beside the **actual Outpost React app**, not a recreation of its navigation and chat. It bundles the current `desktop/src/main.tsx` entry and uses a synthetic, deny-by-default native transport. No production source files are changed. The reviewer is an isolated preview iframe inserted alongside the real conversation column; this is not production feature integration.

```sh
open mock/review-workspace/in-app.html
```

The file is self-contained and works offline. The app sidebar, conversation rendering, tool call, model picker, and composer are the real components. The document/browser reviewer still uses the original sample mock. The screenshot set includes navigation open, navigation collapsed, the entire workspace collapsed, Changes, and Browser.

- The document/browser workspace sits flush beside chat, with no inset box, outer frame, or rounded container. A single full-height vertical divider separates them; individual controls retain their rounding.
- One **rounded panel icon** sits at the top-right of a shared workspace header, outside the resizable columns. Its position stays unchanged when opening, closing, or resizing the reviewer. Its tooltip and accessible label switch between Open workspace and Close workspace; no text button or duplicate close icon appears inside the pane. Chat reclaims the width when collapsed.
- The real composer's Files control also toggles the workspace. Reopening preserves the selected file, document mode, browser tab, and file-list visibility for this session.
- **Drag the divider** between chat and the document/browser workspace to resize. Chat defaults to and stays at least 600px, keeping the composer above its single-row breakpoint; the workspace stays at least 420px. The chat width is capped at 760px. When both minimum widths cannot fit, the preview switches to a single pane instead of compressing chat further. The chosen width survives collapsing/reopening during the session and is clamped when the window or navigation width changes.
- **Keyboard resizing:** focus the divider and use Left/Right (16px), Shift+Left/Right (48px), or Home/End for the limits. Double-click restores the default width. Narrow windows use a single pane instead of squeezing both columns.
- **Files** independently hides or shows the file list without closing the document/browser.
- **Escape** while focused inside the reviewer closes it and returns keyboard focus to Open workspace.
- Reload resets the sample session. These controls affect the preview only.

Rebuild and verify from the repository root:

```sh
node mock/review-workspace/build-in-app.mjs
node mock/review-workspace/check-in-app.mjs
```

The check loads the packaged HTML directly from disk, tests pane toggling through both the header and real composer control, verifies the document and browser tabs, and asserts zero page errors, unexpected IPC, or network requests. Live agent actions are blocked. Only sample content is shown.

## Layout

- Left: conversation, a created-file card with a Review file action, and the existing composer.
- Center: shared document/browser tabs. Documents offer Preview, Source, and Changes, with copy/download actions. No review-status footer or acknowledgement button.
- Right: searchable project files, an added-files filter, and a clickable document outline.
- Narrow screens: file sidebar becomes an overlay; phones switch between Chat, Review, and Browser.

## Scope

Three sample documents are held in memory in `sample-data.js`. README.md is newly added; sources.md and notes.md are existing sample files. The new-file diff shows the complete document as additions. Viewing a file does not approve, save, revert, or apply filesystem changes. Reloading resets the mock.

The Browser tab is an illustrative source page, not a live embedded browser. Its external-open control opens the actual public repository. Other interactions do not make network requests. Chat sending and attachment picking show explanatory notices only. Downloads save sample markdown through the browser.

Preview HTML is fixed, trusted sample content; it is not a production Markdown renderer. A production version needs real file discovery, safe Markdown rendering, real diffs, and the existing browser integration. Research wording is illustrative, not a newly verified technical report.

## Validation

```sh
node mock/review-workspace/check.mjs
```

Playwright checks document modes, absence of the review footer, file switching/filtering, source navigation, sidebar/focus controls, downloads, mobile navigation, font availability, browser exceptions, and page overflow at 1440, 768, and 390 pixels. It also captures desktop document, changes, and browser screenshots.

Visual review: the document is the largest pane and is reachable directly from chat; the explorer and outline remain secondary. Existing Outpost tokens are preserved rather than introducing a new theme. The composer remains visible while content scrolls; the document fills its pane to the bottom. Tablet metadata was shortened to avoid wrapped labels; phone footer metadata was reduced to keep one line. Desktop, tablet, and phone captures were reviewed. The in-app preview supports drag resizing; live browser navigation is not part of this mock.
