# 01. Tasks and the Pi runtime

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **TASK-01 through TASK-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Turn an owner’s outcome into durable, steerable work across coding, web/personal work and server operations. Pi supplies the agent loop; Outpost owns product lifecycle and recovery.

## What the owner sees

The same task, accepted instructions, public progress and pending decisions appear on Mac and iPhone. Profiles select a starting tool loadout; they never create separate histories or different permission systems.

## Responsibility and boundary

Task/run/step lifecycle; Pi session mapping; instruction queue; cancellation; checkpoints and completion evidence. Do not own account secrets, payment execution or client caches.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [03 Agent commands and processes](03-commands-and-processes.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| TASK-01 | Outcome-based requests | Accept a goal in natural language; identify deliverables, relevant machine/accounts, constraints, and completion evidence before substantial work. | C |
| TASK-02 | One task across tools | Continue from research to browser, terminal, code, documents, and service management without making the owner recreate the request in another mode. | C |
| TASK-03 | Visible working plan | Show a concise editable plan with completed, active, blocked, and deferred steps; distinguish an estimate from an execution guarantee. | C |
| TASK-04 | Durable run lifecycle | Persist queued, running, waiting, verifying, completed, failed, interrupted, and cancelled states independently of connected clients. | C |
| TASK-05 | Steering and queued follow-ups | Let the user correct the active goal or queue another instruction; show when the correction was accepted and prevent obsolete work continuing silently. | C |
| TASK-06 | Pause, cancel, and resume | Stop at a safe boundary when possible; record subprocesses and external effects that cannot be instantly cancelled; resume from a durable checkpoint. | C |
| TASK-07 | Independent conversations | Support concurrent tasks on one machine with explicit file/service locks, resource quotas, and account identity; do not confuse shared OS access with isolation. | C |
| TASK-08 | Task branches and retries | Fork a task from a checkpoint, retry a failed step, compare outcomes, and retain abandoned branches without repeating irreversible actions. | E |
| TASK-09 | Long-running missions | Work for hours or days through waits, provider failures, machine restarts, and human approval; use structured checkpoints instead of relying on one context window. | E |
| TASK-10 | Evidence-based handoff | Finish with changed files, URLs, service state, command/test results, receipts, remaining blockers, and a clear statement of what was actually verified. | C |

## How to build it

1. Wrap a pinned Pi SDK/RPC version in a worker adapter with a versioned event mapper. Run one accountable execution owner per task and persist the mapping between Pi branch/session IDs and Outpost run IDs. Do not fork a second home-grown language-model loop.

2. Persist accepted goals/instructions and an outbox in one transaction. Dispatch work after commit; stream draft output separately from committed messages. Track public plans and observable tool results without exposing hidden model reasoning.

3. Route every proposed work action through the selected control mode. Propagate cancellation to tool/process/browser handles. Finalize only after evidence and unresolved-effect reconciliation; a successful model response is not completion.

## Data and integration contracts

**Server-owned records:** tasks; task_runs; task_steps; task_instructions; pi_session_refs; checkpoints.

**Proposed Pi/tool or client command surface:** `task.create; task.steer; task.pause; task.cancel; task.resume; task.fork; task.inspect`.

**Proposed durable events:** `task.created; instruction.accepted; run.started; step.proposed; run.waiting; run.completed; checkpoint.created`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- A page or tool result cannot become an owner instruction or change mode. Concurrent steering uses instruction sequence numbers so superseded work does not continue silently.
- Ask permission gates reads as well as mutations; Full control still operates within granted identities and any required payment workflow mandate.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

On restart, reconcile the latest finalized Pi state with the durable run and outstanding operation intents. Mark uncertain work interrupted or reconciling; never replay an external effect merely to reconstruct a transcript.

## Acceptance and proof

- Start each of a code fix, invoice retrieval and server-health task on Mac; continue/steer the same task on iPhone with both projections agreeing.
- Kill the worker after command acceptance and before/after an external effect; recover one recorded intent and reconcile the result.
- Race pause/cancel with follow-up input and verify one ordered outcome, including honest cancellation limits.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi RPC reference](https://pi.dev/docs/latest/rpc)
- [Pi local SDK reference](../../pi/packages/coding-agent/docs/sdk.md)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
