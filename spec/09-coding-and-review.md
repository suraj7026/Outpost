# 09. Coding and software engineering

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **DEV-01 through DEV-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Deliver investigated, tested and reviewable software changes as one of three equally important product pillars.

## What the owner sees

Both clients show the task’s changed files, turn/branch diffs, checks, browser screenshots and useful outcome. Mac can use a wider adjacent review pane; iPhone retains the same evidence and decision authority.

## Responsibility and boundary

Repository/worktree setup; code context and diagnostics; edits; build/test runs; code review; change checkpoints and platform-specific handoff.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [03 Agent commands and processes](03-commands-and-processes.md), [05 Software and capability installation](05-software-and-capability-installation.md), [06 Headless browser and live takeover](06-headless-browser.md), [10 Git hosting and delivery](10-github-and-delivery.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| DEV-01 | Repository understanding | Inspect project instructions, architecture, build/test commands, dependency graph, and recent changes before modifying code. | C |
| DEV-02 | Reproduce and debug | Reproduce failures, gather logs/stack traces, create a minimal case where helpful, and test the suspected cause before declaring a fix. | C |
| DEV-03 | Precise edits | Use patches/unique-match edits with conflict detection; preserve unrelated changes and reject stale edits rather than overwrite silently. | C |
| DEV-04 | Semantic code tools | LSP diagnostics, symbols, definitions/references, rename/refactor assistance, and code-aware search through installable language packs. | E |
| DEV-05 | Build and test | Discover and run appropriate unit/integration/end-to-end checks; retain outputs and distinguish failure, skipped checks, and passing checks. | C |
| DEV-06 | Feature implementation | Implement UI/backend/scripts, update relevant docs, handle migrations, and produce a reviewable change set with acceptance evidence. | C |
| DEV-07 | Browser-driven development | Start preview servers, inspect pages, exercise flows, collect console/network evidence, and iterate on screenshots within the same task. | C |
| DEV-08 | Code review | Review local diffs or PRs for correctness, tests, security, performance and regressions; attach evidence to precise changed locations. | E |
| DEV-09 | Change checkpoints | View changes per turn and full branch; undo files and coordinate Pi context so an abandoned edit is not still assumed to exist. | C |
| DEV-10 | Platform-specific build handoff | Ubuntu handles Linux-capable builds. Xcode/iOS signing needs the owner's Mac as an explicit local-client handoff, not a required second Outpost backend or hosted build service. | A |

## How to build it

1. Use Git worktrees or isolated task checkouts and a recorded base revision. Discover project instructions and language tooling; load only relevant code context into the Cloud model.

2. Expose structured file/search/patch/diagnostics tools and command-based build/test runners. Keep check results, changed files and browser evidence linked to the exact revision under review.

3. Implement turn and full-task diffs plus coordinated file/Pi-context checkpoint restore. Add a separate review pass and honest platform limits: Ubuntu cannot locally perform Xcode signing; an owner-authorized Mac build handoff is optional and explicit.

## Data and integration contracts

**Server-owned records:** code_workspaces; worktrees; change_sets; diagnostics; check_runs; review_findings.

**Proposed Pi/tool or client command surface:** `code.inspect; code.search; code.patch; diagnostics.read; checks.run; diff.inspect; checkpoint.restore`.

**Proposed durable events:** `worktree.ready; change.recorded; check.completed; review.finding; code.verified`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Respect existing uncommitted owner work; inspect before switching/resetting and never invent a clean worktree.
- Tests/review do not authorize push, merge or deploy. These actions follow mode, identity grants and the current exact revision.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Retain failed check traces and interrupted worktrees. Restoring a checkpoint must reconcile model assumptions with restored files; an old passing test cannot mark a changed revision verified.

## Acceptance and proof

- Reproduce a bug, change code, add a meaningful regression, inspect browser output and return a reviewable diff.
- Steer the same task from iPhone after Mac closes; verify no context/task fork is created.
- Undo a turn containing file changes and verify both the displayed diff and resumed agent context match.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Git worktrees](https://git-scm.com/docs/git-worktree)
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
- [t3code source control reference](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/source-control.md)
- [OpenCode permissions reference](https://opencode.ai/docs/permissions/)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
