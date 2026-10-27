# 13. Documents and deliverables

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **DOC-01 through DOC-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Produce useful spreadsheets, PDFs, documents and presentations on Ubuntu, with rendered/checked outputs shared through the server.

## What the owner sees

The task returns originals, final deliverables, preview thumbnails, source/calculation notes and clear validation status. Opening a file on iPhone or Mac accesses the same version.

## Responsibility and boundary

Document parsing/conversion; template-driven generation; spreadsheet formulas; PDF/render previews; deliverable verification and publication.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [03 Agent commands and processes](03-commands-and-processes.md), [05 Software and capability installation](05-software-and-capability-installation.md), [12 Research and source collection](12-research-and-sources.md), [14 Data analysis and databases](14-data-and-databases.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| DOC-01 | Read heterogeneous documents | Parse PDF, office files, HTML, Markdown, text and scanned images; retain page/sheet/section references and mark extraction failures. | C |
| DOC-02 | Write reports and documents | Produce DOCX, PDF, Markdown and HTML with headings, tables, citations, charts and reusable owner templates. | C |
| DOC-03 | Spreadsheet work | Create and edit XLSX/CSV, formulas, formatting and charts; recalculate with a compatible engine and check representative formula results. | C |
| DOC-04 | Slide decks | Generate PPTX and rendered previews from research, data or a reference deck; inspect layouts instead of claiming a saved file is presentation-ready. | E |
| DOC-05 | PDF workflows | Merge/split, extract, annotate, fill supported forms, redact where technically validated, and generate PDFs while preserving original evidence. | E |
| DOC-06 | Render and inspect | Render final documents to pages/slides and check clipping, pagination, fonts, charts and missing content; store previews beside the original artifact. | C |
| DOC-07 | Revision and review | Compare document versions, apply requested changes, show meaningful diffs or redlines when supported, and retain a recoverable earlier version. | E |
| DOC-08 | Batch transformations | Convert, rename, classify, summarize and organize large document collections with restartable progress and per-file failures. | E |
| DOC-09 | Template library | Owner-approved branding, layouts, writing conventions, spreadsheets and reports that can be selected per task without granting new external authority. | E |
| DOC-10 | Delivery workflow | Package outputs, show provenance and unresolved issues, then download/share/upload/send only under the destination's applicable permission. | C |

## How to build it

1. Package headless document tools and parsers on the server with pinned versions and font/template assets. Prototype LibreOffice headless, Python libraries and Docling only against actual supported formats.

2. Use typed job inputs, preserved originals and explicit output paths. Keep formulas, units, source references and generation parameters so the result can be inspected and rerun.

3. Render outputs and inspect representative pages/cells/slides; check formulas, pagination, missing fonts and corrupt output. Publish checked versions and thumbnails to the artifact store. A completed generation command alone does not prove a usable deliverable.

## Data and integration contracts

**Server-owned records:** document_jobs; document_sources; render_attempts; deliverable_checks; templates.

**Proposed Pi/tool or client command surface:** `document.extract; document.generate; spreadsheet.calculate; document.render; deliverable.validate; artifact.publish`.

**Proposed durable events:** `document.ingested; render.completed; validation.failed; deliverable.published`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Do not execute untrusted macros, embedded scripts or document links. Parse/render in constrained workers and restrict network access where practical.
- Owner files and extracted private text remain within task/account scope; Cloud inference disclosure applies when selected content is sent to Ollama.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Persist conversion failures and intermediates; retry only idempotent rendering steps. If a format cannot be generated or checked reliably, provide an honest supported alternative with retained originals.

## Acceptance and proof

- Generate a report from mixed inputs, verify calculations and rendering, then open/share it on both clients.
- Test long tables, missing fonts, corrupt inputs and spreadsheet formula errors without publishing an unchecked final.
- Restart a converter mid-job and retain one final version with traceable sources and validation results.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [LibreOffice headless options](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)
- [Docling documentation](https://docling-project.github.io/docling/)
- [openpyxl documentation](https://openpyxl.readthedocs.io/en/stable/)
- [python-pptx documentation](https://python-pptx.readthedocs.io/en/latest/)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
