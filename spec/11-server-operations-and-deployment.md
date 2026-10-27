# 11. Server operations and deployments

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **OPS-01 through OPS-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Diagnose and manage real services and deployments as a first-class product pillar, using the same task, policy and evidence paths as coding and browsing.

## What the owner sees

Owners see findings, intended changes, impact, health checks and recovery evidence. No interactive Linux desktop or user terminal is required.

## Responsibility and boundary

Service/container investigation; infrastructure plan/apply; deployments; monitoring queries; cost-impact proposals and rollback verification.

Dependencies: [03 Agent commands and processes](03-commands-and-processes.md), [04 Sudo and machine administration](04-sudo-and-machine-administration.md), [07 Agent and owner identities](07-identities-and-credentials.md), [09 Coding and software engineering](09-coding-and-review.md), [10 Git hosting and delivery](10-github-and-delivery.md), [17 Payment workflows and purchases](17-payments-and-purchases.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| OPS-01 | Diagnose running services | Inspect health, processes, logs, ports, queues, dependency failures and disk pressure; correlate evidence before changing the service. | C |
| OPS-02 | Container operations | Build images, run Compose/Podman/Docker workloads, inspect logs and health, and manage task-owned volumes/networks under explicit host authority. | C |
| OPS-03 | Deployment workflow | Build, stage, test, compare versions and deploy; capture rollout/rollback evidence and actual environment ownership. | E |
| OPS-04 | Infrastructure as code | Prepare and explain Terraform/OpenTofu/Ansible changes, review plans, and apply only within an approved resource/cost scope. | E |
| OPS-05 | Cloud and hosting adapters | Install provider CLIs/connectors for explicitly connected accounts; inspect resources, troubleshoot builds, manage approved changes and record provider operation IDs. | E |
| OPS-06 | Domain/DNS/TLS work | Inspect and prepare domain records and certificates; show mail/verification impacts and request approval for public routing or domain purchases. | E |
| OPS-07 | Databases and migrations | Run authorized queries, inspect plans, back up and restore, prepare migrations, and distinguish production from disposable development data. | E |
| OPS-08 | Incident procedures | Execute a preapproved playbook, gather an incident timeline, apply bounded remediation, and escalate instead of widening authority when it fails. | E |
| OPS-09 | Cost-aware resource lifecycle | Estimate provisioning charges, enforce external limits where available, tag ownership, track expiry, and clean up only resources covered by the task. | E |
| OPS-10 | Agent self-maintenance | Diagnose its own worker/browser/tool failures and prepare updates; a separate trusted supervisor owns coordinator updates, credential policy and recovery. | C |

## How to build it

1. Implement read-only systemd/container/network/log adapters first, with machine/target identity in every result. External hosting/cloud systems remain task targets; Outpost infrastructure stays local.

2. Represent a deployment as a versioned plan with source revision, target, impact, expected cost, checks and rollback route. Apply mode/identity/payment rules to the resolved effect rather than CLI wording.

3. Execute one recorded plan and verify service behavior independently. Track irreversible migrations, partial rollouts and rollback boundaries; return logs, screenshots or health reports as task artifacts.

## Data and integration contracts

**Server-owned records:** service_targets; deployment_plans; deploy_operations; health_observations; incident_records.

**Proposed Pi/tool or client command surface:** `ops.inspect; logs.query; service.health; deploy.plan; deploy.apply; deploy.rollback; cost.inspect`.

**Proposed durable events:** `incident.opened; diagnosis.recorded; deployment.proposed; deployment.applied; health.verified; rollback.completed`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Paid provisioning can create a recurring financial commitment and must fit a whole-workflow mandate, regardless of control mode.
- Protect the server’s recovery connection and keep production secrets outside general project context.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Reconcile actual target state after disconnect/reboot or deployment timeout. Rollback is a separate checked operation; do not claim recovery because a rollback command exited successfully.

## Acceptance and proof

- Diagnose a fixture service failure, apply the selected fix and verify health from an independent probe.
- Deploy a reviewed revision and recover an injected health failure with a verified rollback.
- Run an operations task at the same pilot gate as a code and a browser task; report intervention/failure evidence for all three.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [systemd journalctl](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html)
- [Docker Engine API](https://docs.docker.com/reference/api/engine/)
- [OpenClaw elevated execution reference](https://docs.openclaw.ai/tools/elevated)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
