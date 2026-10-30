# Outpost — Graphite studies

Three new interactive directions in one comparison studio:

- **Graphite Studio:** spacious conversation and persistent evidence inspector.
- **Ink Precision:** compact execution record, exact patch, and task queue.
- **Quiet Workspace:** open reading plane, inline evidence disclosure, and task shelf.

## Open

From the repository root:

```sh
node mock/graphite-studies/serve.mjs
open 'http://127.0.0.1:4391/?compare=1'
```

Alternatively open `index.html` directly. Everything, including the Geist fonts, is local. `PORT` can override 4391. The server binds only to loopback.

Choose **Explore** in the comparison or use the three direction tabs. Try **Replay** for the inspection-path motion, **Review change → Simulate approval → Undo**, evidence tabs, task selection, and the message composer. The sun/moon control previews appearance; the play/pause control switches motion. System reduced motion takes precedence.

**⌘K / Ctrl+K:** task picker. **⌘N / Ctrl+N:** new sample task. **Escape:** dismiss dialog/navigation. **Enter:** send sample message; **Shift+Enter:** newline. Arrow keys navigate the focused evidence tabs.

## Scope

All task content, machine state, reports, configuration changes and approvals are illustrative. State lives in memory and resets on reload. Attachments use a sample file; no file picker or upload is used. Machines, library and workspace controls open preview dialogs, not full administration screens. Replay is an animated simulation, not a model stream. No external network requests, backend calls, native bridge, account access, credentials or command execution.

The production Tauri app, existing HTML studies and Swift mock are unchanged. These browser mockups do not emulate the production AppKit sidebar or native window chrome.

## Checks

```sh
node mock/graphite-studies/test.mjs
```

Uses the repository's existing Playwright dependency. 71 assertions cover three directions at 1440, 768 and 390px, task state, sample messages, approval/undo, replay, keyboard controls, responsive overflow, light appearance, comparison and reduced motion. Browser exceptions and external requests are checked. Screenshots and results are under `review/`.

Design-taste app inspector: zero failures for all three directions in both appearances at all three widths. Remaining warnings concern the proportion of 11–12px metadata/control labels; nothing renders below 11px. Source-lint warnings are documented in `REVIEW.md`.

Design rationale and draw seeds: `DESIGN.md`. Geist licence: `assets/Geist-OFL.txt`.
