# 08. Verification challenges and human assistance

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **CAP-01 through CAP-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Keep browser tasks resumable when a CAPTCHA, MFA step, user-presence requirement or ambiguous page needs the owner.

## What the owner sees

The task explains what is blocking it, shows the relevant browser and offers takeover on either device. Assistance preserves the session and produces a clear return-to-agent transition.

## Responsibility and boundary

Challenge detection/classification; assistance queue; challenge evidence redaction; takeover coordination and permitted local solver adapters.

Dependencies: [06 Headless browser and live takeover](06-headless-browser.md), [07 Agent and owner identities](07-identities-and-credentials.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| CAP-01 | Challenge recognition | Distinguish CAPTCHA, login, MFA, permission denial, rate limit, paywall, and page failure; choose the correct waiting state. | C |
| CAP-02 | Resume after a challenge | Preserve task/tab/form state, request help once, and resume from a verified page state after resolution. | C |
| CAP-03 | Self-hosted solver plugins | Expose installed local challenge helpers to Pi for supported authorized workflows; any model reasoning uses the approved Ollama Cloud route. No hosted CAPTCHA-solving vendor is a default dependency. | E |
| CAP-04 | Local solving experiments | Evaluate open OCR/vision models for supported non-sensitive challenge tasks; label measured coverage and failure rates, not "solves any CAPTCHA." | A |
| CAP-05 | Challenge budget | Bound local solver attempts, runtime and Ollama Cloud inference use; stop and request human help when the approved budget or capability is exhausted. | E |
| CAP-06 | Human challenge UI | Open the exact live browser state on Mac or phone; pause competing input and confirm a resolution before the agent continues. | C |
| CAP-07 | Challenge memory | Record that a site/account often needs help and prefer a stable authorized session or official API where possible; do not store reusable challenge secrets. | E |
| CAP-08 | Respect explicit denial | If a service denies access or forbids the workflow, stop or use an authorized alternative; do not turn challenge handling into evasion of an access restriction. | C |
| CAP-09 | Challenge observability | Show site, challenge class, elapsed wait, attempts, cost, and what is needed from the owner; redact sensitive challenge content in retained logs. | C |
| CAP-10 | Provider conformance | Test timeout, cancellation, unsupported challenge, duplicate callbacks and failed solutions; solver success alone never proves the intended task succeeded. | E |

## How to build it

1. Detect supported challenge/login states from page evidence rather than claiming a generic error is a CAPTCHA. Store a minimal challenge request linked to the actual browser/session.

2. Deliver a privacy-preserving APNs alert and a persistent inbox item. Acquire the same browser input lease for human assistance; re-observe after the owner returns control.

3. Evaluate any open/local challenge helper only on authorized fixtures, with bounded attempts and website/provider constraints. No external solver SaaS or CAPTCHA farm belongs in the self-hosted baseline.

## Data and integration contracts

**Server-owned records:** assistance_requests; challenge_attempts; assistance_resolutions.

**Proposed Pi/tool or client command surface:** `assistance.request; challenge.inspect; assistance.takeover; assistance.resolve`.

**Proposed durable events:** `challenge.detected; assistance.requested; assistance.owner_present; assistance.resolved; assistance.expired`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- CAPTCHA success is not guaranteed, and an unsupported challenge is a handoff rather than an instruction to evade access controls.
- Financial PINs, private keys and recovery seeds never become general agent inputs. Challenge frames and one-time codes require narrow retention/redaction.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Track expiry and attempt limits; a changed/expired challenge requires fresh observation or a new assistance request. Never keep retrying indefinitely or accidentally create multiple login/purchase attempts.

## Acceptance and proof

- Pause a fixture task at a challenge, resolve it on iPhone and resume once with the original session.
- Expire or replace a challenge while a client is offline; reject the stale resolution and show the current request.
- Verify the notification and stored screenshot contain no OTP or credential value.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Steel MCP self-hosting limitations](https://github.com/steel-dev/steel-mcp-server)
- [Playwright authentication](https://playwright.dev/docs/auth)
- [Apple notification handling](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
