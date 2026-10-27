# 19. Memory and retrieval

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **MEM-01 through MEM-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Preserve useful context and preferences across tasks while keeping permissions separate from remembered facts.

## What the owner sees

Owners can inspect sources, correct, pin, forget and export memories from either client. Memory is server-owned and scoped to its source/project/identity.

## Responsibility and boundary

Memory ingestion and provenance; approved versus inferred state; local keyword/semantic indexes; retrieval; correction and retention.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [07 Agent and owner identities](07-identities-and-credentials.md), [12 Research and source collection](12-research-and-sources.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| MEM-01 | Explicit durable memory | Save owner preferences, project conventions, decisions and known service facts with source, date, scope and correction history. | C |
| MEM-02 | Episodic task history | Search previous work, results, errors and supporting artifacts; summarize what happened without replacing retained evidence. | C |
| MEM-03 | Local semantic retrieval | Use approved local embeddings plus keyword search; keep indexes rebuildable and respect source/account boundaries. | E |
| MEM-04 | Task working state | Save current plan, facts, files, active processes, pending decisions and next action before context compaction or a long wait. | C |
| MEM-05 | Provenance and freshness | Mark direct observation, owner instruction, imported note and inference; revalidate stale operational facts before consequential action. | C |
| MEM-06 | Inspect, correct, and forget | Provide a memory browser, edit/supersede/delete actions and deletion propagation to indexes; explain retained audit/backup limits. | E |
| MEM-07 | Knowledge collections | Index selected repos, folders and connected sources into named collections with update schedules and access scopes. | E |
| MEM-08 | Procedure learning | Propose a reusable skill from a successful task, include prerequisites and verification, and request review before expanding its authority. | E |
| MEM-09 | Memory never grants permission | Keep remembered preferences and past approvals separate from live policy/grants; a retrieved page cannot promote itself into owner instructions. | C |
| MEM-10 | Controlled consolidation | Deduplicate and condense notes in the background, preserve source links, flag contradictions, and keep an owner-readable change history. | A |

## How to build it

1. Start with a source-backed memory ledger and local full-text retrieval. Record ownership, source, time, confidence/status and supersession before introducing semantic embeddings.

2. Add an optional local embedding worker and rebuildable indexes on Ubuntu. Filter by task/project/identity scope before ranking and sending selected context to Cloud inference.

3. Expose correction/deletion controls and distinguish owner-confirmed preferences from model inferences. Propagate revisions/tombstones to caches and indexes and disclose backup retention limits.

## Data and integration contracts

**Server-owned records:** memory_items; memory_sources; memory_revisions; retrieval_indexes; deletion_tombstones.

**Proposed Pi/tool or client command surface:** `memory.search; memory.propose; memory.confirm; memory.correct; memory.pin; memory.forget`.

**Proposed durable events:** `memory.proposed; memory.confirmed; memory.corrected; memory.forgotten; index.rebuilt`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- A remembered approval or preference is not live authority and cannot change the three modes or create a payment mandate.
- Untrusted web/mail content remains source-tagged; one account’s private context cannot leak into unrelated tasks or generic agent memory.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Rebuild derived indexes from the durable memory/source ledger. If an embedding worker fails use keyword retrieval or show degraded search; never move indexing to an unapproved hosted service.

## Acceptance and proof

- Remember a preference, retrieve it on another task/device and show its actual source.
- Correct/forget an item and verify current retrieval and both client projections stop showing the superseded content.
- Test cross-account queries and malicious source text without leaking data or granting authority.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [OpenClaw memory reference](https://docs.openclaw.ai/concepts/memory)
- [Ollama embedding capability reference — local helper qualification](https://docs.ollama.com/capabilities/embeddings)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
