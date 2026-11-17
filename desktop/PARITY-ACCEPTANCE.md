# UI parity checklist — completed implementation pass

This supersedes the earlier partial-completion claims and records the follow-through on the owner's twelve-item checklist. Implemented with Astra and Astra subagents. No production server operations were used for validation.

| Area | Implemented now |
|---|---|
| Settings header/tabs | Server icon tile and actual status badge; compact refresh icon instead of permanent strip; quiet Machines back link instead of breadcrumb trail; six tabs kept on one row at 900px. |
| General | Inline name/save; dedicated connection/data rows; installation disclosure; removal confirmation dialog. |
| Connection | Routes and connection pause/resume moved here; route-check row, Add route dialog and Trust & credentials section; installation/SSH setup secondary. |
| Models/providers | Configured rows with one Manage action; actual auth/removal inside dialogs; two-step Add provider; compact import entry opening retained transfer state; refresh below list. |
| Pi/extensions | CPU/version/status row, separate extension rows and badges, concise no-newer-bundle state, available-update review dialog retaining native consent, polling and uncertain-outcome handling. |
| Devices | Trusted rows first; Add device, Details and revocation dialogs; public-identity copy; own identity below list; live-revision and self-revocation checks. |
| Recovery | Known-state panel, real trusted-device and loaded queued-task summaries; separate revision-bound resume review. Missing/unknown data remains explicit. |
| New task/chat/terminal | Centered 672px new composer; no Recent sessions table or old question heading. Actual Memory icon is NotebookPen; Automations is CalendarClock; Approvals is ShieldCheck. The approved follow-up uses the same full-workspace-width bottom terminal dock on Chat and New task; Escape collapses chat/draft pane and restores focus without forwarding Escape to SSH. Full-size Machines terminal still passes shell keys normally. Same rounded SquareTerminal glyph in launchers, pane, command evidence and setup diagnostics. |
| Automations | Compact statuses/actions, searchable IANA display-zone selector, long policy details folded away while DST warning stays visible. Existing create/edit/pause/resume APIs retained. |
| Memory | All servers / One server switch, server selector, real server-only owner note creation, shared-note replication/tombstones unchanged. |
| All chats | Relative dates with exact-date tooltip, semantic badges, chevrons, deduplicated loaded-message counts from the owning connection, actual chat navigation. |
| Approvals | Plain-language summaries with exact target/effects; separate review dialog with original arguments and real action controls, guarded against stale revision/nonce/digest and owner changes. |

## Terminal dock follow-up

The approved terminal mock is now implemented in `src/server-terminal/TerminalPane.tsx` and `server-terminal.css`: full-width dock reaching the workspace bottom on New task and Chat, connection-state dot with an accessible label, spaced host metadata, and a Help dialog containing shortcuts and verified host details. The global server-history/timestamp strip and terminal footer are removed from the DOM. Error, warning and uncertain-reboot notices remain visible. Dock layout, Help/Escape behavior, shell reuse and existing reboot safeguards pass 1,275 Chromium/WebKit assertions; the conversation suite passes 6,488 assertions across 66 cases.

## Conversation width and avatar gutters

Settings → Appearance now has Narrow (672px), Wide (864px), and Large (1056px) text-column presets. Narrow is the default for existing installations; invalid saved values also fall back to Narrow. The preference is stored with the existing local appearance settings and does not change a server. The response body uses the full column, with the Outpost avatar in a left gutter and the owner's avatar in a right gutter. The reply composer follows the preset; the new-task composer and full-width terminal are unchanged. Gutters and maximum widths shrink to fit narrow windows.

Verified: 7,238 unified assertions across 68 Chromium/WebKit cases, 179 appearance checks per engine, and 114 Markdown-spacing checks per engine, including width persistence, invalid/unavailable storage, long-text wrapping, avatar containment and streaming/scroll behavior.

## Deliberate capability differences

- Attachments and task evidence use an existing task ID. They remain available in a conversation, not as inert controls before creating a task.
- Schedule API supports one-time and elapsed-time intervals, not wall-clock weekdays/weekly recurrence or deletion. Time-zone display does not silently reinterpret timestamps. The DST caveat remains visible.
- Notes are immutable in the current API. Forget/create replacement is supported; in-place editing and moving note scope are not fabricated.
- Pi maintenance uses qualified bundled releases. A version string is not proof of a running process; badges report observed connectivity/inventory. No unsupported restart or arbitrary extension install is added.
- Loaded message/queued task counts are labeled as loaded/received records, not invented server-wide totals.
- The mock's fake examples, sample-success states and review-only sidebar are not copied into production.

## Validation

- TypeScript/Vite production build.
- 6,480 existing unified-conversation assertions across Chromium/WebKit; additional home-center/icon assertions added.
- 1,117 terminal assertions including Escape, focus return, no remote Escape write, retained shell, lifecycle and reboot safety.
- Full environment-isolation suite: 148 checks per engine.
- Provider suite: 53 checks per engine; maintenance/import: 55 per engine, including modal-close state retention and no repeated uncertain update/import.
- Administration suite: modal enrollment/copy/revocation, real recovery summaries, stale revision/live updates, self-revocation, pending errors and read-only gates.
- Workspace synthetic browser flows and 14 focused scheduling/presentation/owner-note contract tests.
- Side-by-side rendered comparison in `.outpost/parity-audit/comparison.html`; additional production screenshots in `.outpost/unified-conversation/screenshots/` and the test output directories.

Behavior tests are not a substitute for the screenshots. The rendered hierarchy and dialog states were checked separately. All test transport is synthetic; no real credentials, updates, reboots or schedules were invoked.
