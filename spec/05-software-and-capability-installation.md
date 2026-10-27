# 05. Software and capability installation

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **PKG-01 through PKG-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Make capabilities installable on the server as new tasks demand, instead of fixing the agent’s tool inventory forever.

## What the owner sees

Owners see installed, available, unhealthy and update-needed tools, their purpose and permissions. A tool is usable only after software, credentials, policy and health requirements pass.

## Responsibility and boundary

Software acquisition; package/runtime isolation; provenance and license inventory; install/update/uninstall lifecycle and readiness probes.

Dependencies: [03 Agent commands and processes](03-commands-and-processes.md), [04 Sudo and machine administration](04-sudo-and-machine-administration.md), [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| PKG-01 | Missing-tool discovery | Recognize when a task needs a tool; inspect available versions and trusted installation routes before proposing an installation. | C |
| PKG-02 | Standard package ecosystems | Support apt, project-local pip/uv, npm/pnpm, containers, and language-native tooling; prefer isolated project installs where appropriate. | C |
| PKG-03 | Capability catalogue | Show available packs, installed state, dependencies, permissions, licences, external services, disk footprint, and required secrets. | E |
| PKG-04 | Install plans | Present exact source/version, packages, elevated steps, new services/ports, estimated resource use, and any recurring spend. | C |
| PKG-05 | Installation grants | Approve a bounded installation plan once instead of prompting for every harmless substep; reject changes that expand its scope. | C |
| PKG-06 | Version and provenance record | Track package/image digests, source URLs, maintainer identity where available, install scripts, dependency lockfiles, and the task that requested them. | C |
| PKG-07 | Health and smoke checks | Run a capability's declared test after installation and before advertising it as usable; surface missing accounts separately from missing software. | C |
| PKG-08 | Update and rollback | Review capability updates, stage them, compare changed permissions, roll back failures, and uninstall without losing unrelated user data. | E |
| PKG-09 | Agent-authored tools | Let Pi build a new adapter or recipe in a staging area; require checks and owner approval before giving it new trust, privileged execution, or secrets. | E |
| PKG-10 | Rebuildable machine | Export an environment manifest and reconstruct tools on a replacement Ubuntu machine; exclude secret values and verify application data restoration separately. | E |

## How to build it

1. Define a pinned capability manifest and choose trusted package registries/distribution channels. Resolve executable/image versions, license and dependency inventory before dispatch.

2. Install project-local tools in isolated environments when possible and use the privilege broker for system changes. Apply the selected control mode to installation and preserve transaction logs/rollback information.

3. Run manifest smoke tests and register working tools with Pi. Stage updates, show permission differences and retain the previous version until verification succeeds. Uninstall must show retained data and dependent tasks.

## Data and integration contracts

**Server-owned records:** software_sources; installations; dependency_locks; capability_readiness; install_operations.

**Proposed Pi/tool or client command surface:** `software.find; capability.install; capability.probe; capability.update; capability.remove`.

**Proposed durable events:** `install.proposed; install.progress; installation.ready; capability.unhealthy; update.scope_changed`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- An install cannot silently add an owner account, network exposure, root authority or payment access. A changed trust scope is separately owner-controlled.
- Inspect acquired skill/tool text as untrusted executable capability material; do not automatically run downloaded post-install instructions with protected host authority.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Mark partial installs unusable and resumable/rollbackable. Keep lock files and previous manifests so a failed update can restore the known-good tool surface without replaying external effects.

## Acceptance and proof

- Install gh or a document pack, expose it to Pi and complete a real fixture task with its new tool.
- Reject a permission-expanding update while leaving the installed version working.
- Interrupt an installation and verify readiness is never reported before its health test passes.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Ubuntu package management](https://documentation.ubuntu.com/server/how-to/software/package-management/)
- [Python virtual environments](https://docs.python.org/3/library/venv.html)
- [Pi packages](https://pi.dev/docs/latest/packages)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
