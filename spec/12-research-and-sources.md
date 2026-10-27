# 12. Research and source collection

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **RES-01 through RES-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Research questions on the open web, compare evidence and return inspectable conclusions rather than opaque summaries.

## What the owner sees

Both clients show source links, captured dates, extracted evidence, disagreements and the final report. Browser screenshots and original downloads remain available from the task.

## Responsibility and boundary

Local search adapter; fetch/extraction; source registry; provenance; comparison and citation validation.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [06 Headless browser and live takeover](06-headless-browser.md), [14 Data analysis and databases](14-data-and-databases.md), [19 Memory and retrieval](19-memory-and-retrieval.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| RES-01 | Self-hosted search | Run a search adapter/metasearch service on Ubuntu, expose it to Pi, and query public upstream sources under their access limits; no managed search API is required. | C |
| RES-02 | Source-grounded answers | Record source URL/title, access time, relevant evidence, publication date when available, and confidence; distinguish observation from inference. | C |
| RES-03 | Deep research tasks | Decompose questions, compare sources, follow citations, track unresolved claims, and deliver a report with a supporting evidence folder. | E |
| RES-04 | Structured extraction | Extract public or authorized account data into tables/JSON/CSV with schemas, deduplication, unit/currency normalization, and validation. | C |
| RES-05 | Responsible crawling | Scope domains/pages, rate-limit, checkpoint, honor applicable access restrictions, and stop on explicit blocks rather than silently escalating methods. | E |
| RES-06 | Change monitoring | Watch selected pages, docs, releases, prices or public records; retain before/after evidence and alert only on user-defined meaningful change. | E |
| RES-07 | Mixed-source research | Combine repo files, PDFs, spreadsheets, browser pages and connected knowledge sources with provenance for each claim. | C |
| RES-08 | Comparison dossiers | Build vendor/tool/travel/product comparisons including total costs, availability uncertainty, trade-offs, and links without making a purchase. | E |
| RES-09 | Reproducible datasets | Retain extraction code, source versions, filters and refresh procedures; show gaps and failed pages instead of hiding incomplete coverage. | E |
| RES-10 | Research-to-action handoff | Turn a verified finding into a proposed code change, server action, draft communication or purchase plan while preserving the next action's approval boundary. | E |

## How to build it

1. Self-host search/extraction adapters and expose them to Pi. Upstream public search engines are external data sources, not a hosted Outpost agent backend; handle engine availability and permitted access.

2. Store canonical URL, retrieval time, extraction method, content hash and selected evidence separately from the generated conclusion. Prefer primary sources for technical/official claims and mark inference/uncertainty.

3. Build source-aware retrieval and a final citation check against captured evidence. Generate a comparison/report with originals and reproducible calculations where relevant.

## Data and integration contracts

**Server-owned records:** research_queries; research_sources; source_snapshots; evidence_claims; citation_links.

**Proposed Pi/tool or client command surface:** `search.query; source.fetch; page.extract; evidence.record; research.compare; citation.verify`.

**Proposed durable events:** `source.discovered; source.captured; evidence.linked; report.ready`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Fetched pages are untrusted content and cannot change modes, add accounts or request hidden data transmission.
- Capture only needed source content and honor access/copyright constraints; authenticated material inherits account scope and cannot leak through general memory.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

If a source/search engine fails, show gaps and use a permitted fallback. Preserve retrieval dates and stale-source warnings; do not fabricate a citation or imply inaccessible content was reviewed.

## Acceptance and proof

- Compare alternatives using primary sources and open each cited supporting passage from either device.
- Inject contradictory/stale sources and verify the report separates facts, inference and unresolved issues.
- Feed a page with malicious tool instructions and demonstrate it cannot approve an operation or exfiltrate task files.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [SearXNG documentation](https://docs.searxng.org/)
- [Playwright browser automation](https://playwright.dev/docs/intro)
- [OpenClaw memory reference](https://docs.openclaw.ai/concepts/memory)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
