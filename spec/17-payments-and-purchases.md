# 17. Payment workflows and purchases

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **PAY-01 through PAY-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Authorize and carry out an entire bounded payment workflow, including checkout, required authentication handoff, result reconciliation and receipt collection.

## What the owner sees

Either client displays the same workflow proposal and can authorize it. One approval covers the included routine steps; changed merchant/items/identity/currency/recurrence or an exceeded total requires renewed authorization. No Mac-only checkout approval path exists.

## Responsibility and boundary

Purchase proposals; workflow mandates; budget reservations; brokered instrument references; provider execution; order/receipt/reconciliation and aftercare.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [06 Headless browser and live takeover](06-headless-browser.md), [07 Agent and owner identities](07-identities-and-credentials.md), [08 Verification challenges and human assistance](08-verification-and-human-assistance.md), [15 Communication and calendar](15-communication-and-calendar.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| PAY-01 | Purchase preparation | Research, select items, prepare a cart and calculate total including currency, tax, shipping, deposits and recurring terms before requesting payment. | E |
| PAY-02 | Whole payment workflow approval | On either native client, approve merchant/payee, purpose, items, funding alias, maximum total/currency, delivery, recurrence, expiry and included checkout-to-receipt steps; require current owner authentication. | E |
| PAY-03 | Authorized workflow execution and handoff | Execute the owner-approved payment workflow through a supported broker/provider route; do not repeat prompts for included routine steps. Hand off issuer authentication or unsupported final checkout, and reconcile the real result. | E |
| PAY-04 | Brokered payment method | Use tokenized/provider-supported payment credentials outside the root-capable machine; never place the owner's general-purpose card or wallet secrets in Pi context. | E |
| PAY-05 | Bounded virtual instrument | Optional provider-issued virtual card or delegated instrument with available merchant/category/amount/time controls; only if the owner's location and account are eligible. | A |
| PAY-06 | Standing purchase mandate | Explicit opt-in rules for narrow repeat purchases: supplier, purpose, per-order/cumulative budget, currency, frequency, expiry and allowed recurrence; owner can revoke. | A |
| PAY-07 | Step-up authentication | Pause for bank/card/UPI/wallet authentication where required; the owner completes PIN, biometrics, passkey or OTP in the appropriate trusted interface. | E |
| PAY-08 | No duplicate purchases | Maintain a purchase ledger and operation key, reserve concurrent budget, verify provider/order state after timeouts, and never blindly replay a checkout click. | E |
| PAY-09 | Receipts and aftercare | Save invoices/receipts, record order and subscription IDs, track delivery/refund state, and prepare approved cancellation or return actions. | E |
| PAY-10 | Spending control centre | Show pending/committed/settled spend, recurring commitments, budget reservations, failed attempts and disputed or unknown outcomes; reconcile against provider records. | E |

## How to build it

1. Define a signed workflow mandate binding purpose, merchant/payee, account, items, delivery, maximum total/currency, recurrence, permitted steps and expiry. Separate quote/proposal, authorization, execution and settlement states.

2. Qualify a supported payment route for the actual owner/provider jurisdiction using test merchants first. Keep instrument secrets in the protected broker. Revalidate the mandate and reserve budget transactionally before each financial effect; use provider idempotency/lookup semantics where available.

3. Execute included steps without routine repeat prompts, including in Ask permission as the explicit workflow-level authorization exception. Hand off issuer/bank/user-presence authentication or unsupported checkout, reconcile unknown outcomes, and retain order IDs, receipts, fees and refunds.

## Data and integration contracts

**Server-owned records:** purchase_workflows; workflow_mandates; budget_reservations; payment_attempts; provider_orders; receipts.

**Proposed Pi/tool or client command surface:** `purchase.prepare; payment.propose_workflow; payment.authorize; payment.execute_step; payment.reconcile; receipt.collect; purchase.aftercare`.

**Proposed durable events:** `purchase.proposed; workflow.authorized; budget.reserved; payment.auth_required; order.reconciling; order.confirmed; receipt.ready`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Full control and Auto do not mint payment authorization. The smaller reviewer cannot approve a payment workflow or increase its limit. Revocation blocks future steps but cannot undo an already settled payment.
- Do not assume a merchant payment-creation API can pay arbitrary shops, universal virtual-card availability or exportable wallet/banking secrets. Financial authentication occurs in the required trusted interface.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

A timeout after submitting payment sets reconciling/unknown; query authoritative order/payment state before another attempt. Budget accounting tracks pending/committed/settled and later fees rather than treating all authorization as settlement.

## Acceptance and proof

- Approve one full fixture checkout from iPhone, complete its permitted steps and show the same receipt and mandate on Mac.
- Reject changed cart, currency, merchant, recurrence, identity, expiry or over-limit total; obtain a renewed workflow approval.
- Simulate a post-charge timeout, duplicate device taps, concurrent purchases and delayed settlement; recover one order without double charging.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Stripe PaymentIntent lifecycle — merchant integration reference](https://docs.stripe.com/api/payment_intents)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [AP2 protocol — optional interoperability](https://ap2-protocol.org/)
- [UCP payment flow — optional interoperability](https://developers.google.com/merchant/ucp/faq)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
