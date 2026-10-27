# 03. Agent commands and processes

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **RUN-01 through RUN-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Let Pi use Ubuntu Server as a real work computer through shell commands, process control and installed headless applications.

## What the owner sees

Owners see a readable action timeline, captured results and relevant attachments. Internal PTYs serve the agent; neither client exposes an interactive user terminal or Linux desktop.

## Responsibility and boundary

Command launch; PTY sessions; process groups; bounded output; timeouts; cancellation; environment selection and reusable command procedures.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [04 Sudo and machine administration](04-sudo-and-machine-administration.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| RUN-01 | Noninteractive shell | Execute commands with explicit cwd, arguments, environment, timeout, exit code, and bounded model-facing output; retain complete logs as artifacts. | C |
| RUN-02 | Agent-only interactive PTY | Handle REPLs, prompts, SSH and terminal programs inside the server worker. Return captured activity/evidence to clients; do not expose a user terminal console. | E |
| RUN-03 | Background processes | Start, attach, inspect, signal, and stop long processes; track descendants and distinguish command completion from a service remaining healthy. | C |
| RUN-04 | Resource supervision | Limit CPU, RAM, disk, process count, runtime, browser slots, and GPU concurrency per task; explain queueing and out-of-memory failures. | C |
| RUN-05 | Cancellation propagation | Propagate aborts through Pi, tool calls, subprocess groups, browsers, and downloads; record orphan cleanup rather than falsely claiming immediate cancellation. | C |
| RUN-06 | Structured command tools | Offer typed wrappers for common operations while retaining general shell; sensitive wrappers enforce resource and argument restrictions outside the guest. | C |
| RUN-07 | Remote SSH operations | Connect to explicitly enrolled hosts using scoped credentials; preserve host-key checking and show which machine every command targets. | E |
| RUN-08 | Headless application automation | Use CLI/API and headless conversion interfaces for installed software; return logs, screenshots and artifacts. Linux desktop environments and generic desktop automation are out of scope. | E |
| RUN-09 | Environment profiles | Select language/runtime/tool versions and task-specific env without leaking one project's credentials or dependency state into another. | C |
| RUN-10 | Reusable procedures | Save a verified sequence as a versioned recipe with parameters, prerequisites, permissions, rollback notes, and tests. | E |

## How to build it

1. Use a server runner that accepts typed argv/cwd/env/timeout and assigns an operation ID before launch. Retain shell support where required, but record resolved execution context and displayed command separately.

2. Capture stdout/stderr incrementally with bounded model context and a complete retained log artifact. Own child process groups and PTY handles; redact secret-bearing fields before distribution to model/client.

3. Track long-running services independently from launcher exit. Add resource limits and process cancellation, versioned environment profiles and explicit SSH target identifiers.

## Data and integration contracts

**Server-owned records:** command_intents; process_handles; command_results; environment_profiles; procedure_runs.

**Proposed Pi/tool or client command surface:** `command.run; process.start; process.inspect; process.signal; pty.respond; procedure.execute`.

**Proposed durable events:** `command.proposed; command.started; output.chunk; command.exited; process.orphaned; process.cleaned`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Mode review evaluates the intended effect, not only the executable name. A command invoking Python, a nested shell or an HTTP client must not evade account/payment/admin boundaries.
- Never trust a shell to prove protected policy enforcement against unrestricted root. Protected operations remain mediated outside the worker authority.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Record exit code, signal, timeout and verification independently. After runner death, inspect surviving processes and either reattach a permitted handle or clean up; do not relaunch blindly.

## Acceptance and proof

- Run a build and a long process with streaming output; verify captured logs are available identically on both clients.
- Pause/deny a proposed read or command in Ask permission; verify it does not execute before acceptance.
- Cancel a process tree, recover a runner crash and explain any process that could not be stopped.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Node child_process](https://nodejs.org/api/child_process.html)
- [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)
- [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
