# 24. Swift macOS client

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **MAC-01 through MAC-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Provide a calm native Mac window onto the server-owned operator, sharing capabilities and domain state with iPhone.

## What the owner sees

Use the refined Ink palette, Geist typography, quiet navigation, left-aligned task entry, focused decisions and contextual evidence. Support keyboard work and wider review panes without introducing a separate Mac task store or execution engine.

## Responsibility and boundary

Mac navigation/views; native input/preview/share; device keys; rebuildable offline cache; optional consented Chrome/local attachment bridge.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [06 Headless browser and live takeover](06-headless-browser.md), [07 Agent and owner identities](07-identities-and-credentials.md), [09 Coding and software engineering](09-coding-and-review.md), [17 Payment workflows and purchases](17-payments-and-purchases.md), [18 Scheduling and monitoring](18-schedules-and-monitoring.md), [19 Memory and retrieval](19-memory-and-retrieval.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| MAC-01 | Native app shell | SwiftUI/AppKit windows, menus, keyboard navigation, drag/drop and accessibility; retain the Ink hierarchy and restrained visual language. | C |
| MAC-02 | Projects and tasks sidebar | Group projects, recent tasks, needs-you requests and running work; support search, pin/archive, unread/completion states and machine context. | C |
| MAC-03 | Conversation and plan | Stream readable messages and public progress, show tool rows and task steps, and support steering, attachments, model/profile choices and cancellation. | C |
| MAC-04 | Contextual evidence surfaces | Present task plans, changed files/diffs, live browser, read-only action evidence, screenshots and generated outputs. No user shell, arbitrary server filesystem console or Linux desktop viewer. | C |
| MAC-05 | Code review surface | Turn/branch diffs, file tree, changed-file summary, checkpoint restore, checks and PR context in the style of t3code's workflow. | C |
| MAC-06 | Machine and capabilities | Health, installed tools, service/process inventory, resource queue, storage and capability installation/update screens. | C |
| MAC-07 | Approvals and accounts | Trusted decision centre with exact action previews, account scope, grants, revocation, and device authentication for high-impact actions. | C |
| MAC-08 | Local companion | Optional selected-tab/file/screen bridge, share extension or share-sheet intake where supported, and clear revocable consent for each local capability. | E |
| MAC-09 | Automation and memory tools | Native lists/editors for schedules, monitors, stored procedures, memory inspection, evidence history and configuration changes. | E |
| MAC-10 | Native quality | Dark/light parity, Dynamic Type where applicable, VoiceOver, visible focus, reduced motion, keyboard shortcuts and usable large transcripts. | C |

## How to build it

1. Create shared OutpostProtocol, OutpostSync, OutpostDomain and OutpostDesign Swift packages. Generate protocol models from the shared schema and keep platform navigation/rendering outside transport reducers.

2. Build server pairing, authenticated command acceptance and cursor replay before rich panes. Add task/mode controls, approvals/workflows, browser takeover, changed-file review and generated-file preview/share through the same server records as iPhone.

3. Adapt the existing Ink mock components, then test real long histories, keyboard/focus, VoiceOver, dark/light, offline/stale states and multiwindow behavior. Do not mistake the current mock’s shared in-memory store for implemented server sync.

## Data and integration contracts

**Server-owned records:** Client cache projections only; server records remain authoritative. Keychain owns the device credential; window/pane preferences can remain device-local..

**Proposed Pi/tool or client command surface:** `Authenticated server commands/events and artifact/browser streams; no direct shell, payment, Ollama key or persistent database authority in the client.`.

**Proposed durable events:** `Consume shared task, message, policy, identity, artifact, inbox and device events; do not synthesize authoritative server completions locally.`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- No raw server terminal, arbitrary filesystem console or Linux desktop UI. Read-only command evidence is part of the task transcript, not a command prompt.
- Require current device authentication for sensitive decisions and scope any optional local Chrome/file bridge visibly and revocably.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Rebuild caches by server snapshot/replay. Show disconnected/stale states and rejected/unknown command status explicitly; do not invent a local conversation fork when the server is temporarily unavailable.

## Acceptance and proof

- Start and steer tasks in all three pillars; close Mac and continue the exact server task on iPhone.
- Approve a workflow or change mode on phone and observe the same resolved record on Mac without refresh-created duplicates.
- Exercise keyboard, VoiceOver, long content, compact/spacious sizes and dark/light against the Ink design contract.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [SwiftUI documentation](https://developer.apple.com/documentation/swiftui)
- [Apple Keychain services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication)
- [Local Ink design assets](../Ink%20design%20system%20implementation/Index.dc.html)
- [Refined mock design contract](../mock/docs/design.md)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
