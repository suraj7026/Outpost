# 20. Specialist workers and coordination

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **TEAM-01 through TEAM-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Let a broad task delegate bounded research, code review, data or browser work without losing ownership, policy or resource control.

## What the owner sees

Show a compact public plan and specialist outcomes, active identity, waits and evidence. Both clients observe the same parent/child work; hidden model chatter is not a progress feed.

## Responsibility and boundary

Child-task contracts; worker leases; file/browser locks; concurrency/Cloud quotas; result verification and parent integration.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [06 Headless browser and live takeover](06-headless-browser.md), [09 Coding and software engineering](09-coding-and-review.md), [14 Data analysis and databases](14-data-and-databases.md), [18 Scheduling and monitoring](18-schedules-and-monitoring.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| TEAM-01 | Worker roles | Optional coding, browser, research, document, operations and verification workers, all implemented on Pi-compatible integration paths where practical. | E |
| TEAM-02 | Bounded delegation | Parent assigns a concrete deliverable, resources, budget, deadline and tool loadout; child authority is a subset of the parent's current grant. | E |
| TEAM-03 | Task dependency graph | Model prerequisites, parallel steps and joins; persist progress and avoid declaring a mission done while required children remain unresolved. | E |
| TEAM-04 | Workspace coordination | Separate worktrees or folders, account/profile leases, service locks, and explicit merge/handoff of shared results. | E |
| TEAM-05 | Cloud-capacity-aware queue | Schedule Pi model calls within Ollama Cloud account limits and task budgets; show quota/backoff state and separately bound local browser/tool workers. | C |
| TEAM-06 | Independent verification | Run deterministic checks or a separately scoped verifier; label model-based review as supporting judgment, not proof of correctness. | E |
| TEAM-07 | Budget inheritance | Charge nested tools/workers to the initiating task, prevent recursive runaway spawning, and cap depth/concurrency. | E |
| TEAM-08 | Worker recovery | Replace a crashed worker, attach its durable state, and reconcile outstanding effects before retrying the assigned step. | E |
| TEAM-09 | Owner-visible delegation | Show what each worker is doing, machine/account used, pending approval and final artifact; hide noisy internal chatter by default. | E |
| TEAM-10 | Same-server worker expansion | Scale isolated worker processes, containers or VMs on the same Ubuntu server with capability discovery, leases and quotas. A multi-server fleet is outside the current hosting scope. | A |

## How to build it

1. Build delegation in Outpost around Pi worker instances; do not assume a pinned Pi version natively provides the entire parent/child durable product contract.

2. Give each child a precise deliverable, source context, identity/resource scope, mode/policy version, budget and cancellation route. Isolate mutable workspaces and lease browser profiles/services.

3. Validate child results before accepting into the parent. Bound Cloud requests separately from local CPU/browser workers; preserve resource queue reasons and cancel orphan children when the parent stops.

## Data and integration contracts

**Server-owned records:** worker_jobs; delegation_contracts; resource_leases; result_envelopes; parent_child_links.

**Proposed Pi/tool or client command surface:** `worker.delegate; worker.inspect; worker.cancel; worker.result; resource.acquire; result.verify`.

**Proposed durable events:** `worker.queued; worker.started; resource.waiting; worker.completed; result.accepted; worker.failed`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- A child/reviewer cannot get greater authority than the owner-granted parent scope, override Ask permission or create another worker with a broader identity.
- Independent verification can use deterministic checks and a separate review worker, but agreement between models is not proof of correctness.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Expired worker leases permit recovery only after checking actual processes/effects. Retry pure analysis safely; reconcile side effects and retain partial child evidence before replacement.

## Acceptance and proof

- Delegate code review and research concurrently under a parent task and merge independently checked outputs.
- Race two workers for one browser identity or service and prove exclusive mutation ownership.
- Crash/cancel the parent and show no untracked workers, duplicate external effects or lost accepted results.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [OpenClaw subagents reference](https://docs.openclaw.ai/tools/subagents)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
