# Outpost adoption backlog — OpenClaw, T3 Code, Hermes, and Pi extensions

**Updated:** 30 October 2026 · **Status:** Proposed documentation backlog, not approved implementation work.

This directory turns the [comparative feature analysis](../OPENCLAW-FEATURE-ANALYSIS.md) into **40 individually linkable engineering tickets**. No GitHub issues have been created. OP-001–OP-017 correspond directly to the original F01–F17 recommendations; OP-018–OP-025 cover additional T3/Hermes findings; OP-026–OP-033 cover the explicitly requested **pi-subagents and pi-ollama-cloud features**; OP-034–OP-040 cover the [newer T3 remote/connectivity rescan](../T3-REMOTE-CONNECTIVITY-ANALYSIS.md). Overlapping ideas remain linked to their existing lifecycle, scheduling, recipe, and diagnostics owners rather than creating competing systems.

Each ticket specifies the Outpost gap, intended behavior, scope, dependencies, safety/recovery rules, acceptance criteria, and links to upstream evidence and existing Outpost integration files. The original report supplies further detail for F01–F17. A linked implementation owner does not mean the proposed feature is already wired into Outpost.

## Priorities and effort

- **P0:** dependable-execution foundation before expanding unattended work.
- **P1:** next daily-product-value tranche.
- **P2:** expansion after the relevant foundations.
- **P3:** optional later work or a gated feasibility study.
- **M / L / XL:** relative scope, not time estimates. XL tickets should be split into implementation slices after design approval.

Priority is not a strict dependency order. Read-only diagnostics and baseline measurement can start independently. Conditional dependencies in tickets apply only to the affected slice; for example, local scheduled output does not require a messaging connector.

## Ticket index

| Ticket | Feature | Priority | Effort | Principal references |
|---|---|---|---|---|
| [OP-001](OP-001.md) | Durable input queues and run admission | P0 | L | OpenClaw, T3 |
| [OP-002](OP-002.md) | Context budgets and recoverable compaction | P0 | L | All three |
| [OP-003](OP-003.md) | Model health, retry, approved fallback | P1 | L | OpenClaw, Hermes |
| [OP-004](OP-004.md) | Calendar/event automation and admission recovery | P1 | L | OpenClaw, Hermes |
| [OP-005](OP-005.md) | Quiet monitors and standing programs | P2 | L | OpenClaw, Hermes |
| [OP-006](OP-006.md) | Curated memory and cited hybrid recall | P1 | L | OpenClaw, Hermes |
| [OP-007](OP-007.md) | Approved skills and task instruction profiles | P1 | M–L | All three |
| [OP-008](OP-008.md) | Connector bundles and MCP lifecycle | P2 | XL | OpenClaw, Hermes |
| [OP-009](OP-009.md) | Specialist workers and aggregate budgets (umbrella) | P1 | XL | OpenClaw, Hermes, pi-subagents |
| [OP-010](OP-010.md) | Resumable deterministic recipes | P2 | L | OpenClaw, Hermes |
| [OP-011](OP-011.md) | Channel intake and reliable delivery | P2 | XL | OpenClaw, Hermes |
| [OP-012](OP-012.md) | Browser profiles and human handoff | P1 | XL | OpenClaw |
| [OP-013](OP-013.md) | Doctor, preflight, recovery inventory | P0 | L | OpenClaw, Hermes |
| [OP-014](OP-014.md) | Attention inbox and task board | P1 | M–L | OpenClaw, Hermes |
| [OP-015](OP-015.md) | Paired execution nodes and companion | P3 | XL | OpenClaw |
| [OP-016](OP-016.md) | Reviewed procedure learning | P3 | L | OpenClaw, Hermes |
| [OP-017](OP-017.md) | Usage, latency, operational diagnostics | P1 | L | All three |
| [OP-018](OP-018.md) | Scoped snapshots, streams, history paging | P0 | L | T3 |
| [OP-019](OP-019.md) | Task-owned worktrees | P1 | L | T3, Hermes |
| [OP-020](OP-020.md) | Checkpoint preview and safe restore | P1 | L | T3, Hermes |
| [OP-021](OP-021.md) | Diff, checks, and code review | P1 | L | T3, Hermes |
| [OP-022](OP-022.md) | Verified completion and run outcomes | P0 | L | T3, Hermes |
| [OP-023](OP-023.md) | Portable continuation and provenance | P1 | M–L | T3, Hermes |
| [OP-024](OP-024.md) | Scoped progressive tool discovery | P2 | M–L | Hermes |
| [OP-025](OP-025.md) | Isolated programmatic execution gate | P3 | XL | Hermes |
| [OP-026](OP-026.md) | Subagent roles, launch contracts, model ceilings | P1 | L | pi-subagents |
| [OP-027](OP-027.md) | Parallel workflows, review loops, councils | P1 | L | pi-subagents |
| [OP-028](OP-028.md) | Background children, retained runs, fleet inspector | P1 | L | pi-subagents |
| [OP-029](OP-029.md) | Supervisor decisions and structured interviews | P1 | M–L | pi-subagents |
| [OP-030](OP-030.md) | Watchdog review and delegation diagnostics | P2 | L | pi-subagents |
| [OP-031](OP-031.md) | Ollama catalogue and capability-aware selection | P1 | L | pi-ollama-cloud |
| [OP-032](OP-032.md) | Ollama web search/fetch and scoped cache | P1 | M–L | pi-ollama-cloud |
| [OP-033](OP-033.md) | Cloud quota and parent/child cost accounting | P1 | M–L | Both Pi extensions |
| [OP-034](OP-034.md) | Stable identity and multi-route failover | P1 | L | T3 remote runtime |
| [OP-035](OP-035.md) | Tailscale private HTTPS and diagnostics | P1 | M–L | T3 Tailscale integration |
| [OP-036](OP-036.md) | Optional managed access broker | P2 | XL | T3 Connect |
| [OP-037](OP-037.md) | Resource-aware worker placement/admission | P1 | L | T3 host load balancing |
| [OP-038](OP-038.md) | Peer links and remote subagents | P2 | XL | T3 linked environments |
| [OP-039](OP-039.md) | Ownership-safe SSH/services/resource protection | P1 | L | T3 remote operations |
| [OP-040](OP-040.md) | Provider hubs and pooled quota/routing policy | P2 | L | T3 usage integration |

“All three” in earlier rows refers to OpenClaw, T3 Code, and Hermes. OP-009 is an umbrella, not additional implementation effort to count again on top of OP-026–OP-029. OP-027 shares deterministic step execution with OP-010; OP-030 extends OP-013/OP-022; OP-033 extends OP-017.

## Suggested delivery groups and gates

### A — Dependable runtime

Implement [OP-001](OP-001.md), [OP-002](OP-002.md), [OP-013](OP-013.md), [OP-018](OP-018.md), and [OP-022](OP-022.md), supported by [OP-017](OP-017.md) measurement and [OP-003](OP-003.md) bounded recovery.

**Exit gate:** accepted input, runtime ownership, interruption, reconnect, verification, and unknown outcomes remain correct under crash/restart tests. Establish payload/context/capacity budgets before adding automation volume.

### B — Daily coding and knowledge

Implement [OP-007](OP-007.md), [OP-019](OP-019.md), [OP-020](OP-020.md), [OP-021](OP-021.md), [OP-006](OP-006.md), [OP-014](OP-014.md), and [OP-023](OP-023.md).

**Exit gate:** workspaces have one writer; restore cannot clobber another task; checks/reviews are revision-bound; memory and skills are scoped and versioned. Coding review precedes broad provider/channel expansion.

### B2 — Requested subagent and Ollama extension capabilities

Advance [OP-009](OP-009.md) from P2 to **P1**. Implement its bounded delegation core through [OP-026](OP-026.md), [OP-028](OP-028.md), and [OP-029](OP-029.md): approved roles/model ceilings, durable async children, fleet inspection, and supervisor decisions. Start with one scout/reviewer and one worker; require OP-019 before concurrent writers. Then add [OP-027](OP-027.md) parallel reviews, workflows, and councils.

Add [OP-031](OP-031.md), [OP-032](OP-032.md), and [OP-033](OP-033.md) for Ollama model discovery, research tools, and quota visibility. These provider slices can proceed alongside group B and do not require a generic MCP marketplace. Fixed-model child launches need not wait for catalogue discovery.

**Exit gate:** every child action passes Outpost's gate, runtime/model/extension contracts are qualified, background completion and decisions recover correctly, concurrent budgets are reserved, and local inference is never silently switched to Cloud. Queries sent through Cloud web tools have explicit egress policy. Cost estimates remain distinct from billed/account-level data.

### B3 — Private access and bounded multi-host execution

Build [OP-034](OP-034.md) on OP-018's single connection/synchronization owner, then add [OP-035](OP-035.md) Tailscale private HTTPS and [OP-039](OP-039.md) ownership-safe SSH/service diagnostics. Implement [OP-037](OP-037.md) using fresh telemetry and atomic reservations in **one coordinator**, starting with the existing two execution hosts rather than independent server replicas.

**Exit gate:** route switching reaches the same cryptographically trusted server and preserves active permissions; pending commands remain idempotent; concurrent clients cannot over-admit worker capacity; a disconnected worker is not assumed stopped. A route change, worker placement, and provider choice are separate decisions. No live-task migration or coordinator HA is implied.

### C — Bounded recurring and reusable work

Implement [OP-004](OP-004.md), [OP-012](OP-012.md), and [OP-010](OP-010.md), then [OP-005](OP-005.md). Integrate delegated workflows with those existing owners. Add opt-in [OP-030](OP-030.md) watchdog review only after the core delegation and accounting contracts are qualified.

**Exit gate:** schedules preserve occurrence identity, browser takeover fences automation, recipes resume without replaying unknown effects, and children cannot exceed aggregate parent authority/budgets. Start with built-in actions/local output; connector-backed steps wait for group D.

### D — Optional ecosystem expansion

Implement [OP-008](OP-008.md), then [OP-024](OP-024.md) only if catalogue growth warrants it; add [OP-011](OP-011.md), [OP-016](OP-016.md), and [OP-015](OP-015.md) based on demonstrated need. [OP-025](OP-025.md) is a feasibility/security gate, not a promise to enable arbitrary code execution.

Add [OP-036](OP-036.md) Connect-style managed reachability only if private routes are insufficient; add [OP-038](OP-038.md) independent-environment delegation only after local child lifecycle and destination grants work. [OP-040](OP-040.md) offers optional pooled usage/endpoint policy; adding a usage hub does not configure inference balancing.

**Exit gate:** integration processes have explicit privileges, concrete actions still use the common gate, revocation works, unknown sends are reconciled, and imported code/assets have a licence review. Broker provisioning/cleanup and peer delegation must survive interruption without expanding authority or replaying uncertain effects.

## Common definition of done

1. Add versioned commands/events/projections within the existing ledger/outbox and server-owned lifecycle.
2. Preserve signed commands, exact-action approvals, scope checks, revision conflicts, and revocation at dispatch.
3. Test duplicate input, restart, stale revisions, cancellation, exhausted budgets, unavailable dependencies, and uncertain side effects.
4. Document migration, disable/rollback behavior, retention/deletion, backup coverage, and redacted observability.
5. Implement truthful desktop states and reusable API contracts; do not assume older clients automatically gain parity.
6. Include unit/integration tests and a representative end-to-end acceptance scenario. Upstream tests linked in tickets are reference material, not test results from this analysis.

## Evidence snapshots and link convention

| Repository | Local inspected commit |
|---|---|
| Outpost | `e9af7395c8358dbac6e5d3bd28d598b55204c8d3` |
| OpenClaw | `12c7926d2502b621f30297ac4f176aa5b6fa2fb8` |
| T3 Code — initial review | `cfafb4bb54d244e4612f5681aad3832ea64cb0fb` |
| T3 Code — remote/connectivity rescan | `2c119bd975deb06f49505a0af3ec8d272806b923` |
| Hermes | `088f657ecf77674c7b8e2ededf4e3576d82e042c` |

Upstream links are relative to sibling checkouts under the same developer directory. They work locally but are not guaranteed to resolve in Outpost's GitHub renderer. Use the recorded commit when opening the corresponding file in an upstream repository; do not assume its current main branch matches. This analysis did not fetch or update upstream repositories. T3 was 2,585 commits behind recorded origin/main at the initial inspection; by the 30 October rescan the local checkout had changed and was clean with zero commits behind its recorded origin/main. Relative T3 links now open that newer checkout; earlier findings are not automatically requalified. The rescan covers T3 Connect inside `infra/relay` and T3's Tailscale integration, not a separate Tailscale source audit.

### Installed extension snapshots

- **pi-subagents 0.83.0:** [installed manifest](../../../../.pi/agent/npm/node_modules/pi-subagents/package.json), [upstream repository](https://github.com/nicobailon/pi-subagents).
- **pi-ollama-cloud 0.13.1:** [installed manifest](../../../../.pi/agent/npm/node_modules/pi-ollama-cloud/package.json), [upstream repository](https://github.com/fgrehm/pi-ollama-cloud).

Extension file links point outside the developer directory to the operator's installed `.pi/agent/npm/node_modules/` packages. They are local evidence links, not portable GitHub links or pinned source commits; use the recorded npm version when reproducing the inspection. No packages were installed or updated. Outpost's own Pi SDK is pinned to 1.4.0; extension/SDK/headless compatibility still needs qualification.

This is static analysis, not a live qualification report or a full security audit. Hermes source/documentation mismatches, T3's older proposals, and extension permissions/budget/usage limitations are discussed in the main analysis. No agents or live provider probes were run for the extension review. All proposed names/contracts remain subject to design review; no application code was changed.
