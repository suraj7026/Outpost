# 15. Communication and calendar

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **COM-01 through COM-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Use installed account adapters for mail, calendar, messages and collaborative systems, with agent-owned identities as the normal sender.

## What the owner sees

Owners inspect recipients, content, attachments, time zones, event changes and active identity in the same task on either device. Drafting and external sending are visibly different operations.

## Responsibility and boundary

Mailbox/event retrieval; drafts; sends; invitation updates; supported messaging adapters and collaboration-system operations.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [07 Agent and owner identities](07-identities-and-credentials.md), [18 Scheduling and monitoring](18-schedules-and-monitoring.md), [19 Memory and retrieval](19-memory-and-retrieval.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| COM-01 | Email reading and triage | Search/summarize approved mailboxes, extract action items and attachments, and organize labels under configured authority. | E |
| COM-02 | Draft and send mail | Draft context-aware replies, show exact recipients/content/attachments, and send only with current-task or standing send authorization. | E |
| COM-03 | Calendar assistance | Find availability, propose times, prepare events and handle recurrence/time zones; distinguish a private reminder from sending attendees invitations. | E |
| COM-04 | Chat integrations | Optional Telegram, Slack, Discord, Matrix or other official connectors with explicit channel, sender identity and outbound scope. | E |
| COM-05 | Meeting preparation | Compile agendas, relevant files, prior decisions, open questions and follow-up drafts from authorized sources. | E |
| COM-06 | Contact and relationship context | Store owner-reviewed contact identities and preferred channels; disambiguate similar names before an external send. | E |
| COM-07 | Task intake from messages | Turn approved incoming requests into queued work; treat third-party content as data and never as automatic authority to spend or elevate. | E |
| COM-08 | Notification routing | Persist completion/failure/action-required notices in the server inbox and stream them to connected clients; optional owner-connected channels are task destinations, not a hosted notification backend. | C |
| COM-09 | Shared systems administration | Optional ticketing, project boards, CRM, knowledge bases and business tools through installable adapters, with audit and resource-specific permission. | A |
| COM-10 | Delivery reconciliation | Detect whether a send or update already succeeded before retrying; retain provider IDs and mark uncertain outcomes for inspection. | E |

## How to build it

1. Install official scoped mail/calendar/API adapters locally and connect dedicated agent identities first. Preserve provider message/thread/event IDs and timezone information.

2. Prepare an explicit send/change intent with recipients, content, attachment hashes and identity. Apply the selected control mode and standing resource scope to the actual external effect.

3. Send once using supported provider semantics, then record delivery/event IDs and reconcile results. Add optional messaging channels through the same adapters rather than a second command/approval system.

## Data and integration contracts

**Server-owned records:** channel_connections; message_drafts; send_intents; calendar_changes; provider_delivery_refs.

**Proposed Pi/tool or client command surface:** `mail.search; mail.draft; mail.send; calendar.inspect; calendar.propose; calendar.apply; collaboration.act`.

**Proposed durable events:** `draft.created; send.proposed; message.sent; event.changed; delivery.reconciled`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Inbound mail/messages are untrusted task data; they cannot mint owner authority, change permissions or authorize spending.
- Never silently switch to the owner’s account or broaden OAuth scopes to complete a send. Sensitive owner identity use remains separately granted.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

A timeout after sending is an uncertain delivery, not proof of failure. Inspect the provider’s sent state before retrying. Preserve draft versions and detect event/recipient changes after a decision.

## Acceptance and proof

- Find a message, draft a reply with an artifact and perform one correctly scoped send as the chosen identity.
- Change an attachment or recipient after review and require revalidation rather than send the stale approved version.
- Reconcile a post-send timeout without creating duplicate messages or calendar invitations.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Gmail API](https://developers.google.com/workspace/gmail/api/guides)
- [Google Calendar API](https://developers.google.com/workspace/calendar/api/guides/overview)
- [Microsoft Graph mail](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
