# 26. Control modes, approvals and trust

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **TRUST-01 through TRUST-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Make the owner’s three autonomy choices real server-side execution policy, with explicit identity, payment and trust boundaries.

## What the owner sees

Full control, Auto and Ask permission are named identically on both clients. Show active scope and version, exact pending actions, reviewer classifications, whole-workflow authorizations, revocation and audit.

## Responsibility and boundary

Policy/version store; action normalization; deterministic resource checks; three-mode gate; signed owner decisions; safety-review dispatch; protected audit and emergency stop.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [03 Agent commands and processes](03-commands-and-processes.md), [04 Sudo and machine administration](04-sudo-and-machine-administration.md), [06 Headless browser and live takeover](06-headless-browser.md), [07 Agent and owner identities](07-identities-and-credentials.md), [17 Payment workflows and purchases](17-payments-and-purchases.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [24 Swift macOS client](24-swift-macos-client.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| TRUST-01 | Three modes and scoped authority | Persist Full control, Auto and Ask permission on the server with scope, policy version, expiry and revocation. Auto uses a smaller independent reviewer; Ask permission gates every work action; protected trust changes stay owner-only. | C |
| TRUST-02 | External effect mediation | Broker protected account, payment, production and trust changes; prevent alternate shell/HTTP/MCP paths from silently gaining those credentials. | C |
| TRUST-03 | Instruction provenance | Distinguish owner instructions from pages, files, tool output and messages; untrusted content cannot create policy, schedules or new approving devices. | C |
| TRUST-04 | Sensitive-data minimization | Redact secrets, OTPs and private payment details across text, structured tool results, screenshots, traces, exports and crash reports. | C |
| TRUST-05 | Protected audit trail | Record intent, authority, approval, execution, provider IDs and verification outside the machine's root-accessible storage. | C |
| TRUST-06 | Reauthentication and exact binding | Require current owner presence for high-impact grants; reject altered requests, stale carts, changed destinations and replayed decision signatures. | C |
| TRUST-07 | Data boundaries | Per-project/account retrieval scope, controlled file uploads, SSRF protection for broker services, and explicit routes to approved private-network resources. | C |
| TRUST-08 | Revocation and emergency stop | Revoke future capabilities and sessions promptly; distinguish revocation from refunding money or undoing an already completed action. | C |
| TRUST-09 | Plugin and dependency trust | Pinned dependencies/images, staged updates, extension provenance, permission diffs and no automatic promotion of agent-written trusted code. | C |
| TRUST-10 | Owner visibility and export | Inspect active permissions, external identities, task evidence, retained data and exports; provide deletion/retention controls with backup/audit limitations explained. | E |

## How to build it

1. Normalize every proposed work effect into a canonical action envelope: task/run, actor, tool/arguments, target, identity, data destination, effect class, scope, policy version, expiry and digest. Check deterministic restrictions before mode branching.

2. Full control allows ordinary scoped work without routine prompts. Auto obtains an independently validated smaller-model allow/ask result; uncertainty/outage asks. Ask permission gates every work step, including reads. Protected trust operations remain owner-only, and a payment workflow mandate is required in every mode.

3. Persist request/decision/dispatch/audit transitions transactionally. Verify paired-device signatures against the exact digest, nonce, expiry and current policy. Implement first-valid resolution, tightening-mode rechecks and protected broker dispatch outside guest root.

## Data and integration contracts

**Server-owned records:** policy_versions; task_policy_bindings; action_proposals; safety_reviews; approval_requests; signed_decisions; grants; audit_events.

**Proposed Pi/tool or client command surface:** `policy.inspect; policy.change; action.propose; action.classify; approval.decide; grant.revoke; emergency.stop`.

**Proposed durable events:** `policy.changed; action.proposed; review.allowed; review.ask; approval.requested; approval.resolved; authority.revoked`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- The reviewer cannot promote itself, grant an owner identity, authorize money or treat untrusted tool/page text as owner intent. A small LLM is not a security boundary.
- Do not claim strong enforcement when unrestricted agent root shares the same protected host authority. Document cooperative mode honestly and qualify the same-server host/guest design.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Unknown execution state requires reconciliation. A mode change or revoke blocks future dispatch but cannot undo a committed external effect. On restoring a more restricted machine boundary, inspect persistence and use protected snapshot/reprovision where needed.

## Acceptance and proof

- Run one read/edit/sudo/browser/external-send action in each mode and verify dispatch/prompt behavior, including read prompts in Ask permission.
- Inject reviewer outage, malformed output, prompt injection and stale policy hashes; fail to ask/block rather than silently allow.
- Race two device decisions, alter exact arguments/cart/scope and attempt worker self-approval; reject invalid authority and retain one auditable outcome.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Pi security boundary](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
- [OpenCode permissions reference](https://opencode.ai/docs/permissions/)
- [OpenClaw approvals reference](https://docs.openclaw.ai/tools/exec-approvals)
- [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
