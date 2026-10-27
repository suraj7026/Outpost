# 02. Server files and artifacts

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **FS-01 through FS-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Give the agent a persistent filesystem while giving the owner task-linked evidence and deliverables rather than a general server file console.

## What the owner sees

Both clients show generated documents, screenshots, changed code, download status and share/export actions. Attachments upload to the server and become available to the same conversation on either device.

## Responsibility and boundary

Workspace roots; attachment ingestion; artifact metadata and checksums; provenance; versioned outputs and retention. The worker may access its files under policy; clients use authenticated artifact handles.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| FS-01 | Personal home directory | Maintain an agent home with projects, documents, downloads, outputs, scratch, and task state; survive reboots and app updates. | C |
| FS-02 | Full file operations | Read, write, edit, move, copy, rename, archive, extract, and search files; surface symlinks, permissions, encoding, and size limits. | C |
| FS-03 | Fast discovery | Use ripgrep/glob and indexed metadata, then scoped semantic retrieval where useful; search hidden files only when relevant and authorized. | C |
| FS-04 | Reliable transfers | Resumable upload/download with checksums, progress, cancellation, conflict choices, and destination visibility on both clients. | C |
| FS-05 | Structured artifacts | Attach files and directories to tasks with type, size, provenance, version, preview, and final/intermediate status. | C |
| FS-06 | Version and restore | Checkpoint task-owned files and offer restore previews; distinguish file restore, Git restore, and whole-machine recovery. | C |
| FS-07 | Shared and isolated folders | Reuse common reference material while isolating unrelated work; warn before two tasks modify the same shared asset. | C |
| FS-08 | Storage services and connectors | Keep artifact/object storage on the Ubuntu server, optionally through a self-hosted compatible service. External Drive/NAS/account connectors are explicit task targets, not required backend storage. | E |
| FS-09 | File intake pipeline | Detect duplicates, classify documents, extract metadata/OCR, quarantine suspicious inputs, and create searchable local indexes. | E |
| FS-10 | Storage lifecycle | Show disk use, temporary-file retention, trash, backups, and artifacts pinned against cleanup; require approval for broad destructive cleanup. | C |

## How to build it

1. Provision server paths for projects, task scratch, downloads and final outputs. Resolve paths relative to declared roots and account for symlinks, permissions and atomic replacement.

2. Implement resumable upload and streamed download with size/type limits, checksums and an authenticated artifact endpoint. Store opaque IDs in messages; never require a Mac-local path to reopen a result on iPhone.

3. Publish an artifact only after the producer closes it and records validation/provenance. Keep originals distinct from derivatives and final outputs, then add task-level version/retention controls.

## Data and integration contracts

**Server-owned records:** workspaces; file_refs; uploads; artifact_versions; artifact_sources; retention_policies.

**Proposed Pi/tool or client command surface:** `file.read; file.write; file.patch; file.search; artifact.publish; artifact.inspect; artifact.export`.

**Proposed durable events:** `upload.accepted; artifact.created; artifact.versioned; artifact.verified; artifact.expired`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- File contents are untrusted inputs, including filenames, archives, macros and embedded links. Apply the mode to agent file actions; do not export private files to an external destination without appropriate authority.
- Use a dedicated safe preview path for active document formats; temporary upload/download URLs are short-lived and scoped to the paired device.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Partial uploads remain incomplete and cannot masquerade as final files. Reconcile metadata against disk after crashes; report missing/corrupt artifacts explicitly. Retention removes index entries and retained file versions according to policy.

## Acceptance and proof

- Upload on iPhone, process on Ubuntu and open the same verified result on Mac.
- Resume an interrupted large upload and reject a checksum mismatch without publishing a broken artifact.
- Test traversal/symlink escapes, filename collisions, deleted outputs and access after device revocation.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Linux filesystem hierarchy](https://refspecs.linuxfoundation.org/FHS_3.0/fhs/index.html)
- [Python pathlib](https://docs.python.org/3/library/pathlib.html)
- [Pi tools and extensions](https://pi.dev/docs/latest/extensions)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
