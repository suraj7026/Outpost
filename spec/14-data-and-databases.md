# 14. Data analysis and databases

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **DATA-01 through DATA-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Inspect, transform, reconcile and explain structured data with reproducible computations, including approved database work.

## What the owner sees

Return understandable findings, calculations, exceptions, preview tables/charts and downloadable data. Show which database/identity and snapshot each result used.

## Responsibility and boundary

Dataset ingestion/profiling; query execution; transformations; reconciliation; charts; database mutation plans and data exports.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [03 Agent commands and processes](03-commands-and-processes.md), [07 Agent and owner identities](07-identities-and-credentials.md), [13 Documents and deliverables](13-documents-and-deliverables.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| DATA-01 | Local analysis | Use Python, pandas/Polars, SQL or DuckDB-style tooling for cleaning, joining, aggregation, validation and reproducible calculations. | C |
| DATA-02 | Data quality reports | Identify missing values, duplicate records, schema drift, inconsistent units, outliers and rejected rows with counts and reproducible checks. | C |
| DATA-03 | Charts and explanations | Produce appropriate charts/tables with labelled units, filters, assumptions and a link to the data and calculation used. | C |
| DATA-04 | Query connected databases | Connect to approved databases with read-only roles by default; show database/environment, row limits and query cost controls. | E |
| DATA-05 | Approved data mutations | Preview update/delete scope, take a viable backup where possible, use transactions, verify counts, and require write authority distinct from read access. | E |
| DATA-06 | Data pipelines | Build restartable import/export and transformation jobs with checkpoints, schemas, lineage and explicit destination permissions. | E |
| DATA-07 | API datasets | Paginate, respect rate limits, resume extraction, reconcile totals, and preserve source IDs rather than silently drop failed pages. | E |
| DATA-08 | Notebook and script outputs | Deliver runnable scripts/notebooks, dependency manifests and a concise method, with sensitive values represented as references. | E |
| DATA-09 | Large-data execution | Stream or chunk oversized inputs, estimate disk/RAM, avoid loading everything into model context, and fail clearly when resources are insufficient. | E |
| DATA-10 | Business/finance preparation | Prepare reconciliations, invoice summaries, expense categorization and operational reports with traceable calculations; submissions or transfers use separate authority. | E |

## How to build it

1. Use local Python/SQL engines such as DuckDB or pandas for file analysis and scoped database adapters for connected systems. Record schema, types, units and source hashes before analysis.

2. Separate read queries from mutation/migration plans, using transactions and parameterized statements where supported. Record actual target and query parameters before policy evaluation.

3. Produce deterministic calculations, source-to-output lineage, sampled checks and exception reports. Chart artifacts should explain the analysis rather than supply decorative dashboard metrics.

## Data and integration contracts

**Server-owned records:** datasets; data_profiles; analysis_runs; query_intents; reconciliation_exceptions; data_lineage.

**Proposed Pi/tool or client command surface:** `data.profile; data.query; data.transform; data.reconcile; chart.render; database.plan; database.apply`.

**Proposed durable events:** `dataset.registered; query.completed; anomaly.recorded; analysis.verified; database.change_verified`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Read-only and write grants are distinct; a SQL string is not assumed safe because it starts with SELECT. Respect database functions, triggers and provider behavior.
- Mask sensitive columns in model-facing results and apply export authorization to destinations, not just to local query access.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Cancel long queries, bound memory and spill temporary work to managed storage. Unknown mutation results require database/provider reconciliation; do not replay a bulk update as a retry.

## Acceptance and proof

- Reconcile fixture datasets with known exceptions and independently verify totals and row counts.
- Approve a database mutation under each mode and reject a changed target/query before dispatch.
- Process a dataset larger than memory, cancel/recover cleanly and return a valid artifact with lineage.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [DuckDB documentation](https://duckdb.org/docs/)
- [pandas documentation](https://pandas.pydata.org/docs/)
- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
