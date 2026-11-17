# Approved mock vs production — historical parity audit

**Follow-up:** the twelve-item implementation pass is now recorded in [PARITY-ACCEPTANCE.md](PARITY-ACCEPTANCE.md). The findings below describe the earlier partial build, not the current implementation. They are retained as the acceptance checklist and evidence for why a structural rewrite was needed.

## Verdict

**The approved mock has only been partially translated into production.** The previous implementation summary overstated completion. Real functionality and safety tests exist, but they do not establish visual or interaction parity.

Reference: the exact `design-review/Outpost-review.html` supplied by the owner. Production: current React source and `dist`, rendered with synthetic server records at 1440 × 1000. The comparison is not a recording of a real server or proof of native rendering. Screenshots: `../.outpost/parity-audit/comparison.html`. Reference-only review navigation, sample badges, fake records and scenario switches are not product requirements.

Sol audited settings; GLM audited workspace pages. No MiniMax was used. Findings combine source inspection and rendered comparison. The recovery screenshots use the same **no-hold** state; other fixture contents differ and should not be mistaken for layout defects.

## Implemented / partial / missing

| Surface | Implemented | Missing or materially different from the reference | Status |
|---|---|---|---|
| Composer | Layered black context strip, rounded composer, circular action buttons, shared permission hover surface, model padding, consistent terminal glyph, removed question heading | Home still includes its existing recent-session/footer layout rather than the centered mock. New-task attachment/files controls are absent because those actions currently require an existing task. | Mostly implemented controls; not exact page parity |
| Settings shell | Six server tabs, owner-bound routes, underlined active selection, constrained width | Missing server-icon header tile and trailing status badge. Extra breadcrumbs/description/connection refresh strip alter the hierarchy. Tabs wrap rather than scroll. Names/order differ. | Partial |
| General | Rename/save, connection state, installation details and remove-connection operation | Form order differs; Save sits beneath the field instead of beside it. Connection/pause/routes remain here. Missing approved status/data-ownership rows and distinct compact removal section/confirmation modal. | Partial |
| Connection | Existing route registration/trust checks, reconnect and pause behavior elsewhere | Approved dedicated Connection page is absent. Setup points back to General. Missing route/check row, Add route dialog and grouped trust section. | Missing approved page structure |
| Models & providers | Configured providers first, searchable Add provider, real auth flows, default-model picker, guarded credential changes | Missing one Manage button per row and Manage dialog. Authentication/remove buttons remain directly exposed. Refresh is above, not below, provider list. Add flow exposes methods directly instead of provider selection then provider details. | Partial |
| Import | Real source selection, review, replacement consent and receipts | Entire section is expanded instead of a quiet Import settings entry opening a modal. | Functionality implemented; approved presentation missing |
| Pi & extensions | Inventory and native compatible-release update review/progress/recovery | Missing compact runtime status row and badges; extensions and review remain in one large section. No matching review modal. No standalone restart; see capability limits below. | Partial |
| Devices | Device records, identity/public-key disclosure, enrollment, revocation and revision guards | Identity is first instead of last. No compact icon/status/Details rows, Add device dialog, Details dialog, copy-identity control or modal revocation flow. Enrollment stays expanded at the bottom. | Partial; major hierarchy gap |
| Recovery | Real hold record, missing-record handling, revision-bound acknowledgement and resume | Missing prominent healthy/held/unknown state block, supporting rows and separate consequence-review modal. Technical paragraphs remain the main presentation. | Partial |
| Automations | Real create/edit/pause/resume, server ownership, expected revisions, correct supported payloads | Row actions/badges and form hierarchy differ. No friendly timezone select or compact recurrence presentation. Mock calendar recurrence/delete cannot be copied as working features. | Partial; some capability limits |
| Memory | Shared-note create dialog, readable note text, copy/sync status, safe forget/retry | Missing All servers / One server switch and server filter. No server-note creation UI, edit dialog or scope migration. | Partial |
| All chats | Search, server filter, readable titles, real chat navigation, cached/offline states, no visible UUIDs | Absolute dates instead of relative time; no trailing chevron or semantic status colors; message counts not supplied by current view data. | Closest workspace match; still partial |
| Approvals | Real review actions and useful empty state | Layout/summary hierarchy is not the mock's compact fact sheet. Reference Show example/sample actions must not be shipped. | Core behavior implemented; visual parity incomplete |

## Confirmed UI-only omissions

These do not require new backend endpoints:

1. **Restore the settings hierarchy**: server header/status row, consistent page gutters, scrolling tabs, General and Connection separated.
2. **Port the approved row and dialog structure**, rather than layering CSS onto the old forms: provider Manage, Add route, Add device, device Details, import, removal/revocation/recovery consequence review.
3. **Keep real safety checks inside those flows**: server ownership, expected revisions, pending/unknown outcomes, self-revocation, trust verification, credentials and update consent must remain intact.
4. **Port Recovery and Pi status composition** using only observed data. Do not infer “Running” merely from a version string or fabricate queued-task counts.
5. **Add Memory scope/filter controls**, relative chat timestamps, chevrons and semantic badges using real state mappings.
6. Use a searchable/listed IANA zone field for the existing scheduling display zone without implying wall-clock recurrence.

## Genuine capability limits and verified distinctions

- `server/scheduler/scheduler.ts:5–25` accepts `nextAt` and `intervalMs`, not daily/weekdays/weekly calendar rules. It has no schedule deletion method. The mock's calendar recurrence and delete require additional backend work.
- `server/memory/memory.ts:13–26` explicitly rejects changing the text of an existing shared note (`shared_memory_conflict`); forgotten notes remain tombstones. In-place shared-note editing and moving scope are not UI-only.
- **Server-only note creation is not necessarily a backend gap.** `MemoryStore.save` and the coordinator's existing `memory.save` command create a new owner note with project/identity/source fields. The missing create UI needs explicit scope wiring and validation, not an invented endpoint. The previous broad description of all note-management gaps as backend limits was too strong.
- Native runtime maintenance supports compatible-release updates. A separate restart action, arbitrary extensions and independent Pi upgrade were not established as supported by the audited APIs. Do not simulate them in production.
- The mock's recovery “Check command status” is not automatically equivalent to reconnecting. Receipt/status semantics must be verified before labeling it as confirmation.
- Provider authentication/access and import remain capability-gated. This does **not** prevent using the approved Manage/import dialog layout.

## Icon change in this audit

`src/icon-refinement.css` softens selected rectangular Lucide glyphs: panels, server, calendar, monitor/laptop, files and notebook. Rounded line caps/joins are retained, with modest 3px corner radii; the terminal keeps its 5px radius. Glyph dimensions, hit targets, labels and action behavior are unchanged. Filled Outpost branding and content/artifact SVGs are excluded.

This icon patch does not close the structural gaps above. The settings/workspace audit is read-only; no additional page rewrite or live server action is represented as completed here.

## Acceptance criteria for the next implementation pass

- Capture the exact mock and production side by side at matching viewport, theme and logical state.
- Review default page **and** open-dialog states, not just whether clicks succeed.
- Match content order, compact rows, trailing actions, hierarchy, field sizing and spacing.
- Separately qualify backend-supported behavior and tests; preserve existing security/ownership assertions.
- Report each remaining divergence explicitly. A passing test count alone is not design acceptance.
