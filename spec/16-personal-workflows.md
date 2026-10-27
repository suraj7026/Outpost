# 16. Personal workflows and errands

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **LIFE-01 through LIFE-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Coordinate useful multi-step personal work across websites, files, communications and recurring responsibilities.

## What the owner sees

An outcome such as collecting invoices or reviewing subscriptions stays one task, with the agent choosing the tools and returning organized evidence, reminders and any decisions needed.

## Responsibility and boundary

Reusable personal workflow definitions; forms/account changes; invoice collection; subscription reviews; delegated errands and task-level outcome verification.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [06 Headless browser and live takeover](06-headless-browser.md), [07 Agent and owner identities](07-identities-and-credentials.md), [08 Verification challenges and human assistance](08-verification-and-human-assistance.md), [13 Documents and deliverables](13-documents-and-deliverables.md), [15 Communication and calendar](15-communication-and-calendar.md), [17 Payment workflows and purchases](17-payments-and-purchases.md), [18 Scheduling and monitoring](18-schedules-and-monitoring.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| LIFE-01 | Account administration | Retrieve statements/invoices, inspect settings, prepare profile updates, and execute approved account changes through supported sites/APIs. | E |
| LIFE-02 | Travel and appointments | Research options, compare complete prices and constraints, prepare booking details, then stop for required booking/payment confirmation. | E |
| LIFE-03 | Forms and applications | Assemble required documents, fill authorized forms, show declarations and final fields, and obtain permission for submission or attestation. | E |
| LIFE-04 | Shopping and procurement | Compare stock/specifications, construct a cart, calculate total cost, and ask for the transaction-specific purchase described in PAY. | E |
| LIFE-05 | Subscription management | Inventory explicitly connected subscriptions, track renewal dates, flag price changes, and prepare or perform approved cancellations. | E |
| LIFE-06 | Returns and support | Gather order evidence, prepare support tickets, request approved returns/refunds, and track response/status without inventing a successful resolution. | E |
| LIFE-07 | Personal file organization | Organize receipts, records, photos and downloads; show proposed mass changes and preserve originals/backups. | E |
| LIFE-08 | Deadline preparation | Track renewals, application deadlines and owner-defined obligations; collect required material and remind only under an approved schedule. | E |
| LIFE-09 | Multi-step errands | Combine research, document preparation, browser actions, correspondence and payment preparation under one visible task and authority envelope. | A |
| LIFE-10 | Home and lab integrations | Optional enrolled home-server, NAS or device APIs; expose device state and require specific approval for changes with physical consequences. | A |

## How to build it

1. Build workflow recipes around real pilot tasks, beginning with invoices, account administration, forms and subscription review. Bind all included tools to the parent task rather than spawning disconnected mini-products.

2. Capture original documents, selected account and provider-visible state before changes. Present factual recommendations and prepared actions with the current mode and applicable owner authorization.

3. Verify completion from provider confirmations, downloaded records or follow-up status. Store a reusable procedure only after its assumptions, failure paths and evidence have been exercised.

## Data and integration contracts

**Server-owned records:** workflow_templates; workflow_instances; form_proposals; obligations; completion_evidence.

**Proposed Pi/tool or client command surface:** `workflow.prepare; form.inspect; form.propose; account.change; obligation.track; workflow.verify`.

**Proposed durable events:** `workflow.started; form.prepared; obligation.discovered; workflow.waiting; workflow.verified`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- A form submission, cancellation and payment are different effects. The workflow must expose legal/financial/account implications and not infer authority from a prior unrelated task.
- Use the agent’s own identities when accepted by the service; selected owner access is explicit, scoped and auditable.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Support wait/resume for login, unavailable websites and owner decisions without losing collected records. Return partial results and precise blockers instead of claiming the errand is done.

## Acceptance and proof

- Collect multiple invoices, resolve login on one device and return organized files plus a source-backed summary to both.
- Prepare a subscription cancellation and verify actual provider state after the authorized change.
- Resume a form workflow after an interrupted upload without duplicate submission or lost attachments.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Playwright input actions](https://playwright.dev/docs/input)
- [Google Calendar integration](https://developers.google.com/workspace/calendar/api/guides/overview)
- [Model Context Protocol](https://modelcontextprotocol.io/specification/latest)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
