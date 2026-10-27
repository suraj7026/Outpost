# 25. iPhone, shared sync and Apple notifications

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **PHONE-01 through PHONE-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Provide an equal native iPhone client and direct server-to-APNs notifications, keeping every authoritative conversation/task/decision on Ubuntu.

## What the owner sees

iPhone can start/steer tasks, change the three modes, read the same history, inspect/share artifacts, take over the browser and authorize full payment workflows. Layout differs from Mac; domain capabilities and approval authority do not.

## Responsibility and boundary

Shared sync/replay semantics; iPhone navigation/input; device registration; durable notice/outbox; APNs token lifecycle, deep links and optional Live Activities.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [06 Headless browser and live takeover](06-headless-browser.md), [07 Agent and owner identities](07-identities-and-credentials.md), [17 Payment workflows and purchases](17-payments-and-purchases.md), [18 Scheduling and monitoring](18-schedules-and-monitoring.md), [24 Swift macOS client](24-swift-macos-client.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| PHONE-01 | Native sessions and inbox | Needs you, running and recent work with mode/profile icon, task title, machine/account summary and accessible touch targets. | C |
| PHONE-02 | Equal client continuity | Read and create the same server-owned conversations/tasks, steer/cancel, change control mode, review evidence and approve workflows from either device; reconnect without missing or duplicated committed content. | C |
| PHONE-03 | Equal native approvals | Review exact actions, scope and whole payment workflow details on either client; authenticate sensitive decisions and resolve once on the server. No Mac-only payment approval dependency. | C |
| PHONE-04 | Server inbox and Apple push | Persist notices on Ubuntu, stream to active clients and send APNs notifications directly from the Ubuntu notifier; deep-link and replay server state when the app opens. Push is not authoritative or guaranteed immediate. | C |
| PHONE-05 | Browser takeover | Inspect and interact with the live remote browser using zoom/touch/keyboard; display the account and return-control action clearly. | E |
| PHONE-06 | File and voice intake | Upload from Files/share sheet/camera/voice, with destination and local/server processing visibility, then preview and share returned artifacts. | E |
| PHONE-07 | Pairing and revocation | QR/fingerprint confirmation, Keychain-held device identity, last seen, lost-device revoke, and explicit re-pair after trust changes. | C |
| PHONE-08 | Readable offline history | Cache selected transcripts/artifacts with local protection, mark staleness, and avoid queuing offline financial approvals as if still current. | E |
| PHONE-09 | Lock-screen notifications and status | Use the owner-approved APNs exception for privacy-preserving alerts; optional Live Activities show status/freshness. Require the unlocked app for sensitive approval or payment authorization. | E |
| PHONE-10 | Remote emergency controls | Revoke a task's external grants, stop workers, pause automations, and ask the trusted supervisor to recover the guest, even if its agent process is stuck. | E |

## How to build it

1. Use the same protocol/domain reducers as Mac. Persist server snapshots and ordered events and provide cursor catch-up, command idempotency and one valid decision across concurrent devices.

2. Build native iPhone task creation, transcript/evidence, control-mode selection, inbox/workflow approval, browser takeover and artifact preview/share. Display sync freshness/offline state; sensitive offline approvals cannot execute as if current.

3. Send APNs directly from Ubuntu using server-held signing material. Register app/environment-specific device tokens, deduplicate notices, handle invalid tokens/retries/preferences and deep-link into the current server request. APNs is the owner-approved hosting exception, not a hosted Outpost relay.

## Data and integration contracts

**Server-owned records:** Server: device_registrations; notification_preferences; inbox_items; push_outbox; push_attempts. Client: protected rebuildable cache and Keychain device identity..

**Proposed Pi/tool or client command surface:** `device.pair; device.register_push; device.revoke; inbox.list; notice.acknowledge; shared task/approval/workflow commands`.

**Proposed durable events:** `device.paired; push.token_updated; inbox.created; push.sent; push.rejected; inbox.resolved; replay.caught_up`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Push is a wake-up hint and may be delayed or dropped; the server inbox is authoritative. Lock-screen payloads omit secrets, exact sensitive commands and payment credentials.
- Require unlock/current authentication for sensitive decisions and server validation of nonce, scope, expiry and device trust. Browser input still has one server-owned lease.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

On foreground/reconnect fetch missed events regardless of whether a push arrived. Resolve obsolete notifications to the latest request status; do not approve a stale request from a cached lock-screen action. Revoke tokens and session authority independently.

## Acceptance and proof

- With both clients active, mutate tasks/messages/mode/identity/approval from either device and converge to the same server revisions.
- Background/terminate iPhone, emit a notice, then test deep-link/replay and lost-push catch-up without missing or duplicating history.
- Race approval/denial from Mac and iPhone, reject revoked/stale signatures and prove payment workflow authorization is available on both.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Apple remote notification server](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server)
- [Apple notification handling](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions)
- [ActivityKit](https://developer.apple.com/documentation/activitykit)
- [Apple background execution guidance](https://developer.apple.com/documentation/backgroundtasks)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
