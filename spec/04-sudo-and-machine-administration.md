# 04. Sudo and machine administration

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **SYS-01 through SYS-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Allow meaningful administration of the dedicated Ubuntu Server without handing the worker ownership of its own approval keys or authoritative audit.

## What the owner sees

Show requested administrative effect, current control mode, target server, impact and verified result. Owners need outcomes and evidence, not a machine-console UI.

## Responsibility and boundary

Inventory; scoped privilege execution; service/package/user/network/storage operations; reboot checkpoints and rescue coordination.

Dependencies: [03 Agent commands and processes](03-commands-and-processes.md), [05 Software and capability installation](05-software-and-capability-installation.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| SYS-01 | Machine inventory | Inspect OS, architecture, CPU/GPU, RAM, storage, ports, users, network, running services, and installed tool versions. | C |
| SYS-02 | Approved sudo | Request a scoped administrative action with a reason and impact preview; execute it through the protected privilege path and return the result. | C |
| SYS-03 | Root maintenance lease | Allow the owner to grant broad root over the agent's Ubuntu workspace for a bounded maintenance window, clearly showing reduced internal enforcement. | E |
| SYS-04 | Service management | Create/update/restart/stop task-owned systemd services, inspect journals, set restart policy, and verify health; system-wide changes follow admin policy. | C |
| SYS-05 | Package and runtime maintenance | Install, pin, update, and remove OS packages or runtimes, including approved non-default repositories; preserve inventory and rollback information. | C |
| SYS-06 | Users and permissions | Manage task accounts, groups, file ownership, SSH access and service identities through explicitly scoped admin operations. | E |
| SYS-07 | Network administration | Diagnose DNS/routes/TLS/firewall; preview externally reachable ports and protect the remote recovery channel before applying changes. | E |
| SYS-08 | Reboot-aware work | Plan updates and reboots, save state, warn affected tasks, boot automatically, and verify workers/services rejoin. | E |
| SYS-09 | Storage administration | Manage task volumes, mounts, quotas, logs and image cleanup; require stronger approval for formatting, destructive migrations, or broad deletions. | E |
| SYS-10 | External rescue | Restore a snapshot, replace a broken guest, revoke its broker credentials, or attach recovery media without relying on the damaged agent OS. | C |

## How to build it

1. Probe actual Ubuntu capacity, virtualization, storage and networking. Prefer a protected host coordinator with a root-capable Ubuntu Server guest on the same physical server; qualify the topology before claiming enforcement.

2. Build a narrow privilege broker for common operations with argv/resource validation and independent audit. Full control suppresses ordinary owner prompts within its grant; Auto calls the reviewer; Ask permission creates an exact action request.

3. Add pre-change snapshots, service health checks, safe reboot/resume and an owner-controlled rescue path. Keep package/network/storage procedure versions and evidence of what changed.

## Data and integration contracts

**Server-owned records:** machine_inventory; privileged_intents; maintenance_leases; reboot_checkpoints; rescue_requests.

**Proposed Pi/tool or client command surface:** `system.inspect; system.install; service.manage; network.preview; storage.prune; system.reboot; system.recover`.

**Proposed durable events:** `admin.proposed; admin.authorized; lease.started; host.restarting; machine.rejoined; recovery.completed`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- If the agent has unrestricted host root, explicitly label policy as cooperative; no prompt layer can make the same host root unable to change it.
- A root lease may leave persistence. Ending a lease is not proof of restoration; a verified snapshot/reprovision is needed when returning to a stronger boundary.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Reconnect using host-owned inventory and operation records after reboot. Preserve recovery access before firewall changes. Use a protected snapshot/rescue operation when the guest is damaged, then inspect retained task data before reuse.

## Acceptance and proof

- Exercise the same bounded sudo operation in all three modes and prove the expected prompt/reviewer behavior.
- Restart the guest and coordinator during maintenance, then recover one result and all waiting tasks.
- Demonstrate that guest root cannot sign owner decisions, alter a payment mandate or erase host-owned audit.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Ubuntu Server documentation](https://documentation.ubuntu.com/server/)
- [sudo manual](https://www.sudo.ws/docs/man/sudo.man/)
- [systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
