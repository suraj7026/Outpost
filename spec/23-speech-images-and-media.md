# 23. Speech, images and media

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **MEDIA-01 through MEDIA-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Process voice notes, images, audio/video and visual evidence using installed tools on the Ubuntu Server, with qualified Cloud vision where needed.

## What the owner sees

Owners attach/share media from either device and receive transcripts, extracted facts, captions, clips, images or reports as task artifacts with processing/verification status.

## Responsibility and boundary

Media ingestion; local transcription/OCR/conversion; image/vision jobs; clip/export jobs and resource-aware worker execution.

Dependencies: [02 Server files and artifacts](02-filesystem-and-artifacts.md), [03 Agent commands and processes](03-commands-and-processes.md), [05 Software and capability installation](05-software-and-capability-installation.md), [13 Documents and deliverables](13-documents-and-deliverables.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| MEDIA-01 | Voice task input | Record a voice note in the client, transcribe locally or on the owner's server, show the text, and treat ambiguous sensitive instructions as needing clarification. | E |
| MEDIA-02 | Spoken updates | Optional local speech output for progress and answers; provide transcript, mute, interruption and privacy controls. | A |
| MEDIA-03 | Screenshot understanding | Attach images or selected screen regions for analysis; explicitly confirm destination when local content leaves the Mac. | E |
| MEDIA-04 | OCR and scanned records | Extract text/tables from images and scans with coordinates/confidence where available and an owner-visible correction path. | E |
| MEDIA-05 | Image transformations | Resize, crop, annotate, compress, convert and organize assets using installed tools; preserve originals and check the visual result. | E |
| MEDIA-06 | Open image-generation tools | Optional self-hosted generation/editing worker when hardware and model licence allow; separately label generated imagery and required GPU resources. | A |
| MEDIA-07 | Audio/video processing | Use installable media tools for clipping, transcoding, subtitles, transcription, frame extraction and exports with input/output provenance. | E |
| MEDIA-08 | Meeting recordings | Process owner-supplied/authorized recordings into notes and action items; meeting capture itself requires a separate consented integration. | E |
| MEDIA-09 | Multimodal deliverables | Combine screenshots, charts, recordings and text into reports, tutorials or demos with reviewable intermediate artifacts. | A |
| MEDIA-10 | Media resource budgets | Queue large jobs, estimate storage/runtime, set retention and cancellation rules, and avoid starving the main operator's inference. | E |

## How to build it

1. Install and qualify local FFmpeg/OCR/transcription workers for actual owner formats/languages. Keep uploads and temporary files on managed server storage.

2. Expose typed jobs to Pi with limits on duration, size, CPU/GPU and output format. Route selected image interpretation to the qualified Ollama Cloud vision role; conversion/transcription infrastructure stays local.

3. Validate duration, codec/container integrity, transcript timing and image dimensions. Return previews and source-linked derivatives; keep originals and verification limitations explicit.

## Data and integration contracts

**Server-owned records:** media_assets; transcription_jobs; ocr_results; vision_observations; media_derivatives.

**Proposed Pi/tool or client command surface:** `speech.transcribe; image.inspect; image.ocr; media.convert; media.clip; media.validate`.

**Proposed durable events:** `media.accepted; transcription.ready; vision.completed; derivative.created; media.verified`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Treat embedded media metadata/filenames and OCR text as untrusted. Avoid unnecessary Cloud upload of private frames or captured credentials.
- No hosted conversion, transcription or media-generation service is introduced by installing a capability. Model/tool availability must be qualified before claiming generation support.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Resume bounded pure processing from source assets; preserve partial transcripts or failed render traces. Explain missing codecs, unsupported inputs and resource exhaustion instead of publishing a corrupt final.

## Acceptance and proof

- Transcribe an attached voice note locally and use its confirmed request in a shared task.
- Extract a table/image from a fixture and compare a generated report against the original evidence.
- Process/cancel a long conversion under resource limits and return only verified playable/openable artifacts.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
- [Tesseract documentation](https://tesseract-ocr.github.io/)
- [Ollama vision](https://docs.ollama.com/capabilities/vision)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
