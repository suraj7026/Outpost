# UI consistency implementation

**Current status:** see [PARITY-ACCEPTANCE.md](PARITY-ACCEPTANCE.md) for the completed twelve-item follow-up. The historical notes below describe the initial partial pass.

**Correction:** this pass implemented real functionality and some visual refinements, not full parity with `design-review/Outpost-review.html`. The settings layout, row structure and several modal flows still differ materially. See [the screen-by-screen parity audit](DESIGN-PARITY-AUDIT.md) for implemented, partial, missing and capability-limited items. Preview data and simulated actions are not imported into production.

## Changes

- Layered black composer context, rounded input surface, circular action controls, matching new/reply padding and input heights.
- Shared permission selector combines shield, value and chevron into one hover/focus surface. Native select chrome is removed, and model controls have consistent padding.
- One Lucide terminal glyph across the composer and terminal pane. New-task terminal uses the selected draft server. Task status, Stop and jump-to-latest remain operational.
- Removed the large new-task question heading; retained an accessible heading.
- Settings have compact sections, short primary copy, secondary technical disclosures, distinct active/hover tabs and consistent soft-filled fields.
- Configured providers appear first; Add provider opens the existing real sign-in flow. Native update review, credential confirmation, device authority, recovery acknowledgement and unknown-result handling remain in place.
- All chats has search/server filtering and readable title/status/time rather than exposed UUIDs. Approvals and memory have useful empty states; shared-note creation uses a dialog while preserving replica/tombstone/retry behavior.
- Automations now creates, edits, pauses and resumes real schedules through `automation.save`, bound to the owning server and expected revision.

## Machines navigation follow-up

The six server sections now belong to **Machines**: General, Connection, Models & providers, Pi & extensions, Devices, and Recovery. Each machine offers **Manage server** and its existing **Open terminal** action. Server pages keep Machines selected and link back through the breadcrumb. Settings retains Mac preferences and a shortcut to Machines.

Existing `#settings/servers/{id}/{tab}` links remain supported and retain the selected server without changing the active chat owner. The new overview is `#machines`; old `#settings/servers` overview links open it too. Removing a connection returns to Machines. This is a navigation-only follow-up, not completion of the remaining visual parity audit.

Validation: production build, 134 environment-isolation checks in each of Chromium/WebKit, 1,077 terminal browser assertions, plus provider, maintenance and device/recovery checks.

## Backend limits, not simulated features

- Scheduling supports one-time runs and elapsed-time intervals of at least one minute. Every 24 hours is not calendar-daily scheduling; DST may shift the local hour. The form makes this explicit. No deletion endpoint or cron/calendar recurrence is invented.
- Runtime management offers the supported compatible-release update/recovery workflow. Independent Pi upgrades, arbitrary extension installation and an unsupported standalone Pi restart are not introduced.
- Shared notes use the existing immutable-note/forget API; no pretend edit or scope migration action is shown.
- Home attachment and task-evidence controls are not displayed before a task exists; the reply composer retains its real upload and resource controls.
- No server commands, account changes, live updates, or scheduling operations were used to validate this UI.

## Main files

`src/ComposerControls.tsx`, `src/composer-refinement.css`, `src/ComposerContext.tsx`, `src/TaskView.tsx`, `src/App.tsx`, `src/settings-refinement.css`, `src/agent/ProviderSettings.tsx`, `src/Automations.tsx`, `src/automation-form.ts`, `src/workspace-refinement.css`, `src/WorkspaceViews.tsx`, `src/SharedMemory.tsx`, and `src/ChatHistory.tsx`.

## Checks

From the repository root:

```sh
npm --prefix desktop run build
npx tsx --test desktop/tests/test-automation-form.ts
node desktop/tests/test-unified-conversation.mjs
node desktop/tests/test-providers.mjs
node desktop/tests/test-maintenance.mjs
node desktop/tests/test-connection-administration.mjs
node desktop/tests/test-server-terminal.mjs
node desktop/tests/test-environments.mjs
node desktop/tests/test-focus-treatment.mjs
```

Verified after implementation: production TypeScript/Vite build and signed native macOS app build; 6,480 unified-conversation assertions across 66 Chromium/WebKit cases; 1,051 terminal assertions; 125 environment-isolation checks per engine; 3,282 Chromium and 3,056 WebKit focus checks; provider, maintenance/import, device/recovery suites; and 11 schedule unit tests in each of two time zones. The native bundle passed `codesign --verify --deep --strict`. The native build was subsequently installed and relaunched at the owner's request. These checks establish behavior and build validity, not visual parity.

The standalone workspace synthetic harness is run from `desktop`: `node tests/test-workspace-refinement.mjs`. Time-zone unit checks also run with `TZ=America/New_York` and `TZ=Asia/Kolkata`. The browser suites use synthetic transport, not credentials or production servers. Test expectations were updated for the approved terminal placement, provider picker and unified chat list; safety assertions were retained.
