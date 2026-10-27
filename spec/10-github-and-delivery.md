# 10. Git hosting and delivery

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **GIT-01 through GIT-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Use GitHub CLI and equivalent provider adapters from the server for issue-to-PR work and accountable software delivery.

## What the owner sees

Show the active agent/owner identity, remote/repository, reviewed revision, checks and final PR/release links. The owner can inspect or approve the same operation from either client.

## Responsibility and boundary

Remote authentication; issues/PRs/comments; CI inspection; push/merge/release operations and external-result reconciliation.

Dependencies: [07 Agent and owner identities](07-identities-and-credentials.md), [09 Coding and software engineering](09-coding-and-review.md), [11 Server operations and deployments](11-server-operations-and-deployment.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| GIT-01 | GitHub CLI | Install and use `gh` for authorized repository, issue, PR, checks, release and API work; show account/repository context before mutations. | C |
| GIT-02 | Repository lifecycle | Clone, initialize, fork and publish repositories; ask before changing visibility, deleting a repository, or exposing private material. | C |
| GIT-03 | Branches and worktrees | Isolate task branches, manage remotes/upstreams, preserve dirty worktrees, and clean up only after a verified handoff or owner rule. | C |
| GIT-04 | Commits and PRs | Generate useful commit messages and PR descriptions, attach issues/evidence, request reviewers, and keep final titles aligned with actual scope. | C |
| GIT-05 | CI investigation | Read checks, bounded logs/artifacts, and annotations; diagnose failures, propose reruns where authorized, and fix them without fabricated success. | C |
| GIT-06 | Review-response work | Incorporate reviewer comments, track resolved/unresolved items, and prepare responses for approved submission. | E |
| GIT-07 | Merge and release | Prepare merge/release summaries and artifacts; execute merges, tags, production deployments or rollback only under applicable authority. | E |
| GIT-08 | Conflicts and history | Rebase/merge with conflict resolution; preview force-push/reset/history-rewrite effects and retain a recovery reference. | C |
| GIT-09 | Git hosting adapters | Optional GitLab, Forgejo/Gitea and other hosts through their APIs/CLIs; retain host/account-specific authorization. | E |
| GIT-10 | Repository event tasks | Turn approved issue/PR/CI webhooks into scoped tasks, deduplicate events, and avoid executing instructions embedded in untrusted comments as owner authority. | E |

## How to build it

1. Install a pinned gh CLI and register typed wrappers alongside Git. Use the dedicated agent account by default, with per-repository grants and isolated credential scope.

2. Resolve repository, branch, base/head revision and destination before mode evaluation. Push/merge/comment/release each records an external operation intent and readable content preview.

3. Fetch authoritative provider results/checks and retain URLs/IDs. Use supported idempotent or lookup semantics to reconcile ambiguous submissions rather than create duplicate PRs/comments/releases.

## Data and integration contracts

**Server-owned records:** git_remotes; repository_grants; provider_operations; pull_requests; delivery_records.

**Proposed Pi/tool or client command surface:** `git.status; git.push; github.issue; github.pr; github.checks; github.merge; release.prepare`.

**Proposed durable events:** `remote.intent; branch.pushed; pr.created; ci.observed; merge.completed; release.published`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- An approved push does not mean merge or deploy. Changed head revision/check state requires revalidation of the intended operation.
- Never pass a broad owner token into an arbitrary worker environment while claiming repository-scoped protection.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Handle revoked access, changed branches, rate limits and remote conflicts explicitly. A timeout after push/PR creation triggers provider lookup before retry.

## Acceptance and proof

- Open an issue-linked PR as the agent identity, inspect checks and show the same provider result on both devices.
- Change the branch head after a decision and prevent a stale merge or misleading check summary.
- Simulate a provider timeout after PR creation and recover one PR rather than submit another.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [GitHub CLI manual](https://cli.github.com/manual/)
- [GitHub REST documentation](https://docs.github.com/en/rest)
- [Git push](https://git-scm.com/docs/git-push)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
