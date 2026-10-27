# 27. Reliability, backups and resources

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **REL-01 through REL-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Keep the single-server operator recoverable and honest through process crashes, network failure, model outages, resource pressure and lost client devices.

## What the owner sees

Show meaningful running/waiting/reconciling/failed/offline states and explain what was actually completed. Owners can recover, export and move their server-held work without depending on a client being open.

## Responsibility and boundary

Operational health; durable outbox/claims; resource queues; backups/snapshots/export; restore/reprovision; staged updates and migration testing.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [03 Agent commands and processes](03-commands-and-processes.md), [04 Sudo and machine administration](04-sudo-and-machine-administration.md), [18 Scheduling and monitoring](18-schedules-and-monitoring.md), [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| REL-01 | Health and diagnosis | Surface control plane, Pi, machine, browser, model, broker and storage health separately; show actionable reasons and affected tasks. | C |
| REL-02 | Transactional outbox | Persist accepted intent before work, dispatch effects with deduplication, record actual completion and reconcile uncertain outcomes on recovery. | C |
| REL-03 | End-to-end identity | Carry task/run/tool/effect/approval IDs across workers and clients; show a unified timeline without exposing secrets or hidden model reasoning. | C |
| REL-04 | Backup and restore | Server-local ledger/account/workspace backups and host-owned guest snapshots, plus owner-exportable offline copies and tested restoration. No hosted backup backend is required. | C |
| REL-05 | Safe upgrades | Pin compatible versions, drain or interrupt work predictably, back up before migrations, and roll back worker/client incompatibilities. | C |
| REL-06 | Resource economics | Track server resources, Ollama Cloud usage/limits, browser/tool work and authorized external purchases separately; do not assume Cloud inference is unlimited or free. | E |
| REL-07 | Deterministic fixtures | Script Pi/model/tool outputs for reconnect, parallel approvals, malformed actions, crashes, timeouts and duplicate events without paid live dependencies. | C |
| REL-08 | Real model/site evaluations | Version a representative suite, measure completion and intervention, and rerun before changing the model, browser or privileged integrations. | C |
| REL-09 | Graceful degradation | Continue safe local work during a connector outage, queue model-limited tasks, stop protected actions when authority is unavailable and explain the limit. | C |
| REL-10 | Long-term portability | Export tasks, artifacts, environment manifests, memory and compatible Pi sessions; move machines without losing permission history or silently retaining revoked secrets. | E |

## How to build it

1. Use a transactional local ledger, retained artifacts and committed outboxes. Bound model/browser/CPU/disk concurrency separately, preserve operation IDs and instrument queue/timeout/failure causes without secret telemetry.

2. Build encrypted server-local backups and owner-exportable offline copies with manifests and integrity checks. Guest snapshots protect guest changes; another directory on the same disk does not protect against physical host/disk loss.

3. Rehearse restoration onto a replacement Ubuntu Server, key/device revocation, schema migration rollback and staged Pi/model/browser updates. Re-run the balanced pilot matrix after every release-impacting change.

## Data and integration contracts

**Server-owned records:** health_observations; job_leases; resource_queues; backup_manifests; restore_runs; migration_versions; export_manifests.

**Proposed Pi/tool or client command surface:** `health.inspect; queue.inspect; backup.create; backup.verify; restore.preview; restore.execute; system.export`.

**Proposed durable events:** `capacity.waiting; health.changed; backup.verified; restore.completed; version.changed; recovery.required`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- A backup is usable only after a restore check. Do not back up plaintext vault keys alongside encrypted secrets and call it protected.
- External operations with unknown results reconcile before retry. Availability pressure never changes Auto’s fail-to-ask behavior or bypasses payment mandates.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Recover server-owned state before restarting dispatch, then inspect outstanding effects and expired leases. Mark caches stale until replay catches up. Host loss is a shared failure domain; offline/export recovery must be explicit.

## Acceptance and proof

- Kill the coordinator, worker and browser at operation boundaries and reconcile tasks/history/approvals on both clients.
- Restore a clean server from an offline backup and verify tasks, artifacts, identities, modes and revoked-device behavior.
- Apply resource pressure and Cloud/APNs outages; retain the authoritative inbox and explain waits without losing work or duplicating effects.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite online backup](https://www.sqlite.org/backup.html)
- [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- [WireGuard](https://www.wireguard.com/quickstart/)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
