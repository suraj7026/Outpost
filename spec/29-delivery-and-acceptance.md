# Balanced delivery and acceptance

Status: proposed delivery programme, **27 October 2026**. This replaces any coding-first interpretation of the historical v2 calendar. No fixed delivery date is promised before server/model/browser/client spikes are measured.

## Delivery principles

Build shared vertical slices through Pi, policy, server state, browser/artifacts and both native clients. Coding, browser/personal work and server operations are equally important product pillars. Implementations can proceed sequentially, but a release gate cannot pass on coding alone while the other two remain static screens.

C/E/A feature labels identify foundational behavior and later depth inside each module. They do not mean all features marked E/A are required for the first release, or that a whole pillar can be postponed. Every item retains its stable feature ID; use [feature-map.md](feature-map.md) and module acceptance evidence to define the actual pilot set.

A prototype proves feasibility. A usable vertical slice proves coherent task completion. Production readiness additionally requires real provider/server/device testing, recovery, privacy, distribution and operational evidence. The current SwiftUI mock satisfies none of those backend gates.

## Gate-based roadmap

| Gate | Shared implementation | Coding proof | Browser/personal proof | Server operations proof |
|---|---|---|---|---|
| G0: qualify the stack | Pin Pi/runtime/browser; inspect server/virtualization/network; evaluate Cloud operator, smaller reviewer and vision; prototype two Swift clients and the wire schema. | Read/edit/test a disposable repo through Pi. | Headless navigate, inspect and capture a fixture page. | Inspect a disposable service/log and exercise one bounded admin operation. |
| G1: durable equal clients | Server task/event ledger, instructions, command idempotency, artifact store, reconnect/replay, device trust, direct APNs/inbox baseline. | Create a task on Mac and inspect its checks on iPhone. | Start invoice-style fixture work on iPhone and inspect the same captured output on Mac. | Start health work with both clients closed and retrieve one server-owned result. |
| G2: real mode gate | Full control, independent smaller-model Auto and per-work-action Ask permission; exact actions, policy revisions, stop/revoke and protected dispatch. | Same read/edit/test sequence under all three modes. | Same navigation/download sequence under all three modes. | Same inspect/restart sequence under all three modes. |
| G3: useful tool packs | Commands/processes; Git/gh; code diff/checkpoints; browser viewer/input lease; install/probe/update; file/source delivery. | Fix and review a bug in a worktree. | Complete upload/download and human takeover of the same headless browser from either client. | Install a pinned tool, restart a task-owned service and verify its health. |
| G4: identities and assistance | Agent-first accounts, selected owner grants, credential broker, challenge/login waits, native decisions and revocation. | Open a fixture PR as the agent identity. | Retrieve an authorized private invoice, complete login on phone and revoke access. | Access a scoped service/host using a dedicated identity without leaking credentials. |
| G5: personal and knowledge work | Documents/data, research/source capture, mail/calendar adapters, scheduler, monitoring and memory. | Produce a source-backed code/dependency review with reusable evidence. | Generate a checked report from web/account files and draft a scoped communication. | Run a quiet monitor and create a verified operational report while clients are closed. |
| G6: approved commerce | Whole-payment-workflow proposals/mandates on both clients, local broker, budgets, qualified provider route, handoff, receipts and reconciliation. | Explain/build a paid dependency/provisioning proposal without unauthorized spend. | Approve a complete fixture purchase workflow on either client and reconcile one order. | Apply a bounded paid-resource workflow with explicit recurring terms and provider evidence. |
| G7: broader depth | Specialist workers, procedures, richer integrations, media, long missions and context/resource optimization. | Delegate review and validate merged results. | Complete a multi-day document/research/admin errand with resumable waits. | Coordinate a multi-service task with resource locks and recovery. |
| G8: hardened single-server release | Backup/restore/export, upgrade/requalification, distribution/signing, accessibility, loss of devices, privacy and pilot runbooks. | Restore a code task and reproduce its checks. | Recover conversations, artifacts, identities and waiting decisions on a replacement server. | Restore server state, revoke a lost client and rehearse recovery from damaged workspace/root. |

Relevant owners: G0–G3 [tasks](01-tasks-and-pi-runtime.md), [processes](03-commands-and-processes.md), [models](22-models-and-auto-reviewer.md), [trust](26-control-modes-approvals-and-trust.md), [clients](24-swift-macos-client.md), [sync/APNs](25-iphone-sync-and-notifications.md); G4–G6 use identity/payment/personal-work modules; G7–G8 deepen coordination/reliability. All gates retain the same shared contracts.

## First implementation tickets

These are proposed work units, not estimates or assigned implementation tasks.

| Ticket | Deliverable | Depends on | Completion evidence |
|---|---|---|---|
| SPEC-01 | Pin server, Pi and dependency manifests; record actual capacity/network/virtualization. | Owner server access | Inventory and repeatable local setup; no invented enforcement boundary. |
| SPEC-02 | Operator/reviewer/vision Cloud qualification and Pi transport spike. | SPEC-01, owner Cloud access | Tools/results/streaming/images/cancellation report and role IDs with failure cases. |
| SPEC-03 | Versioned protocol/schema fixtures and event/command contracts. | Architecture review | Swift/TypeScript generated bindings with replay/idempotency fixtures. |
| SPEC-04 | Task ledger, outboxes, Pi mapping and recovery coordinator. | SPEC-02, SPEC-03 | Crash/restart evidence preserving accepted instructions and outstanding intents. |
| SPEC-05 | Three-mode normalization/gate, reviewer validation and signed decisions. | SPEC-03, SPEC-04 | Full control/Auto/Ask permission matrix; reviewer outage/malformed-output asks. |
| SPEC-06 | Files/artifacts and checked upload/download/preview pipeline. | SPEC-03, SPEC-04 | Same artifact version opened from both clients; corruption/partial-upload rejection. |
| SPEC-07 | Equal Mac/iPhone task creation/transcript/decision/mode projections. | SPEC-03–06 | Two-device mutations and concurrent-decision convergence; visible offline state. |
| SPEC-08 | Direct APNs sender, registration/preferences, inbox and notification deep link. | SPEC-04, SPEC-07, entitlements | Invalid/stale token handling, lost-push catch-up and safe lock-screen payload. |
| SPEC-09 | Command runner/admin broker and code worktree/checks evidence. | SPEC-04–06 | Balanced code and service fixtures under all modes with restart/cancel proof. |
| SPEC-10 | Headless browser adapter and exclusive Mac/iPhone takeover. | SPEC-04–07 | Navigate/upload/download, race input leases, crash/recover without Linux desktop. |
| SPEC-11 | Agent-first identities, owner-scope grants and challenge handoff. | SPEC-05, SPEC-10 | Agent versus owner access, safe login and effective revoke on both clients. |
| SPEC-12 | Balanced first real pilot slice. | SPEC-08–11 | Code fix, invoice/browser task and service-management task, with evidence from both clients. |
| SPEC-13 | Documents/research/data/schedule/communication depth. | Useful pilot feedback | Validated outputs, source lineage and meaningful-change monitoring. |
| SPEC-14 | Whole-payment-workflow provider spike and native approvals. | SPEC-05, SPEC-07, SPEC-11, owner eligible route | Changed-cart/limit/expiry/duplicate/unknown-settlement tests before real transactions. |
| SPEC-15 | Backup/restore, upgrade and release rehearsal. | Stable pilot contracts | Replacement-server restore, lost-device revoke and balanced regression report. |

## Mandatory product scenarios

Every scenario below names observable proof. Automated tests should cover deterministic invariants; real-device/provider rehearsals cover integration behavior. Use fixtures/test identities and controlled services first.

### Shared history and equal clients

- Start a code task on Mac, close it and steer on iPhone. Both render the same server task, messages, steps and artifact IDs on reconnect.
- Start browser and operations tasks on iPhone, then inspect/approve from Mac. No phone-only or Mac-only task store is created.
- Mutate a mode, account grant, schedule or payment-workflow decision on one client and observe the same server revision on the other.
- Race approve and deny from two devices. Exactly one valid server resolution wins; the other device displays the recorded outcome.
- Duplicate command submissions and replay events after a long disconnect. No duplicate message, task, action or purchase is created from the UI retry.
- Drop the APNs alert, terminate/background iPhone and reopen. Cursor/inbox catch-up still discovers every unresolved request. A stale deep link opens its current resolved/expired state.

### The three modes

- For each of file read, file edit, test run, browser navigation, external send and scoped sudo, verify Full control dispatches ordinary granted work without a routine owner prompt.
- Under Auto, use the smaller independent reviewer and retain its classification. Inject outage, timeout, invalid output, unfamiliar effect and prompt injection; the affected action waits/asks rather than starts.
- Under Ask permission, intercept every actual work step, including reads. A rejection prevents execution; changed arguments/target require another request.
- Tighten mode while an action is queued. Dispatch must recheck the current version. Show already running effects honestly and reconcile them instead of claiming a toggle undid them.
- Attempt mode escalation, owner-account substitution, policy update or payment-mandate creation through tool output or the reviewer; protected authority rejects it.

### Headless browser and evidence

- Run on Ubuntu Server without a Linux desktop environment. Browse a fixture, produce a screenshot and download a document to the shared artifact store.
- Take over on Mac, attempt simultaneous iPhone input and reject the non-owner lease. Return control and force a fresh observation before Pi acts.
- Crash Chromium and reconnect a client. Recover supported state, detect reauthentication and retain screenshots/downloads; never invent a successful login restoration.
- Inspect task results on either client without exposing a user shell or arbitrary server filesystem console.

### Identities and personal work

- Connect dedicated agent accounts created by the owner and complete a GitHub/web workflow as that identity.
- Grant a selected owner account for one scope; display the identity clearly and revoke it from the other client. Subsequent protected use fails.
- Test Chrome selected-session attachment and selected credential import separately. No general password/profile export is assumed.
- Resolve CAPTCHA/login/MFA on the same protected browser session. Redact one-time codes/credentials from saved screenshots, messages, logs and Cloud context.
- Produce a research-backed document/report with originals, calculations, checks and openable/shareable outputs on both clients.

### Whole payment workflow

- On each native client, review purpose, merchant, items, selected identity/funding alias, maximum/currency, recurrence, included steps and expiry. Authenticate and record the same server mandate format.
- Complete the authorized fixture checkout-to-receipt sequence without repeated routine prompts. This applies to the explicitly approved workflow even in Ask permission.
- Change merchant, items, identity, currency, recurrence or exceed the limit; pause for renewed workflow authorization. Full control and Auto do not silently approve the change.
- Test issuer-authentication handoff and unsupported final-checkout handoff without requesting a financial PIN or recovery seed in chat.
- Inject timeout after charge, repeated device taps, two concurrent purchases, revocation, expired mandate and delayed settlement/refund. Reconcile authoritative provider state before another financial attempt.

### Recovery and operational release

- Kill worker/coordinator/browser at action boundaries, reboot the guest and lose connectivity. Preserve intent/authority/evidence and reconcile uncertain effects.
- Exhaust disk/memory/browser slots or Cloud quota. Bound work, retain useful artifacts and explain the exact capacity wait.
- Restore a replacement Ubuntu server from the offline/exported backup. Rebuild client caches, recover artifacts/history, rotate/revoke device authority and verify all three pillars.
- Upgrade Pi, models, browser and adapters in staging, run conformance and the balanced regression suite, and keep an honest rollback/requalification path.

## Evidence required to call a module complete

Record feature IDs, source revision, dependency/model/browser versions, fixture identifiers, test/rehearsal commands, expected versus observed effects, durable operation/event evidence, artifact hashes, screenshots from real UI, intervention counts and unresolved limitations. A module acceptance report links its requirement IDs to proof; the feature map alone is not proof.

No real server credentials, account login, payment method, provider transaction or APNs provisioning is activated merely by writing these specifications. Such work must follow the actual owner-authorized integration task and appropriate test/rehearsal boundaries.

References: [main plan gates and scenarios](../outpost-plan.md), [protocol contracts](28-protocol-and-data-contracts.md), [module index](README.md), [source/version rules](30-decisions-and-sources.md).
