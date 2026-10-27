# 18. Scheduling and monitoring

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **AUTO-01 through AUTO-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Keep useful work running on the owner’s server while both clients are closed, and notify only when there is meaningful progress, completion, failure or a decision.

## What the owner sees

The same schedules, next/last run, active mode, account scope and run results appear on Mac and iPhone. Owners can create, pause, resume, edit or cancel from either client.

## Responsibility and boundary

Time/event triggers; occurrence ledger; due-job queue; quiet monitoring; missed-run handling; routine versioning and notification requests.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [07 Agent and owner identities](07-identities-and-credentials.md), [19 Memory and retrieval](19-memory-and-retrieval.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| AUTO-01 | One-time and recurring work | Natural-language schedules, explicit time zone, next-run preview, start/end dates, and support for one-off, interval and calendar schedules. | C |
| AUTO-02 | Meaningful monitors | Watch a URL, repo, service, folder, CI run, invoice or other resource; wake the model only when a condition or useful interval warrants it. | E |
| AUTO-03 | Durable scheduling semantics | Record scheduled occurrence IDs, missed-run policy, retries and deduplication; define catch-up behavior after outages and daylight-saving changes. | C |
| AUTO-04 | Webhook and event triggers | Authenticate incoming events, deduplicate/replay safely, rate-limit, and map them to a constrained task rather than unrestricted prompt execution. | E |
| AUTO-05 | Heartbeat goals | Periodically inspect an owner-authorized objective and continue useful work; remain quiet on unchanged/non-actionable state. | E |
| AUTO-06 | Bounded automatic remediation | Run a tested procedure only on specified services/resources, with rate/attempt limits, rollback and escalation. | E |
| AUTO-07 | Approval while unattended | Persist requests, notify once under policy, stop at the protected step, and expire or reschedule safely when no owner responds. | C |
| AUTO-08 | Resource and spend budgets | Limit model runtime, browser slots, API fees, cloud use and purchase authority per automation; prevent overlapping instances unless explicitly allowed. | E |
| AUTO-09 | Automation management | List, explain, test, pause, resume, edit and delete automations; show their permissions, last results, next run and change history. | C |
| AUTO-10 | Schedules are explicit authority | A memory note or generated plan does not silently create recurring work; scheduler/standing grants require an owner-authorized operation and record. | C |

## How to build it

1. Persist schedule/zone, task recipe, resources, identity, control mode, budget and notification intent. Separate trigger evaluation from task execution and deduplicate each occurrence.

2. Use a local scheduler and durable worker claims with overlap/missed-run policy. Capture meaningful baseline changes rather than sending routine healthy/no-change notifications.

3. Route scheduled actions through the same three-mode gate and any workflow/account mandate. APNs delivery comes from the server notifier; a missing push never removes a waiting inbox record.

## Data and integration contracts

**Server-owned records:** automations; automation_versions; trigger_occurrences; scheduled_runs; monitor_baselines; notification_requests.

**Proposed Pi/tool or client command surface:** `automation.create; automation.inspect; automation.pause; automation.resume; automation.run; monitor.compare`.

**Proposed durable events:** `automation.changed; occurrence.due; run.claimed; monitor.changed; automation.waiting; notice.requested`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Creating a schedule does not grant new authority. A stored procedure cannot silently broaden its resource/identity/payment scope when it runs later.
- Auto reviewer outage waits/asks; Ask permission may leave the scheduled task waiting for every work step. Full control is still the recorded owner choice, not an inference from a task name.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

After downtime decide explicitly whether to skip, coalesce or catch up missed occurrences. Preserve leases and provider operation IDs so one due trigger cannot duplicate a send or charge.

## Acceptance and proof

- Run a monitor while both clients are closed, alert once on meaningful change, and show one run/inbox record on reconnect.
- Reboot over a scheduled boundary and enforce overlap/missed-run policy without duplicate external effects.
- Pause/revoke on iPhone while a worker is waiting and verify Mac/server dispatch honor the updated version.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)
- [OpenClaw cron reference](https://docs.openclaw.ai/automation/cron-jobs)
- [Apple remote notifications](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
