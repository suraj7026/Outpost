# T1 — source-only import preparation

Status: additive source inventory/dry-run tooling, **not migration, restore, or full T1 acceptance**. No runtime wiring or existing backup/storage/ledger changes. Base: `c71e722ceb561837b33cac5892859fe3b537155f`.

## Interface and authority

Run using the existing runner (no installation):

```sh
./node_modules/.bin/tsx server/reliability/import/cli.ts sqlite --database /absolute/frozen.sqlite --artifacts /absolute/frozen-artifacts --frozen
./node_modules/.bin/tsx server/reliability/import/cli.ts outpost1 --archive /absolute/legacy.enc < /private/key.raw
```

The legacy key input is exactly 32 **raw bytes**, not hex/base64, argv, or an environment variable. Standard output contains only the deterministic manifest; standard error contains a fixed error code without source paths, payloads, key material, SQL, or stack traces. No manifest is emitted on validation failure. The caller owns output retention and permissions (for example, a private shell redirection with `umask 077`). There is no built-in output-file overwrite behavior. Unknown arguments, including any PostgreSQL/target/apply option, fail. API: `dryRun(Source): SourceManifest`.

The importer has no PostgreSQL dependency/connection, target URL, apply path, runtime startup, ownership acquisition, receipt replay, or dispatch capability. Full `npm test` also runs the repository's pre-existing disposable private PostgreSQL fixture suites; that is separate regression evidence, not importer target access or migration qualification.

## Frozen source contract

The operator must stop writers and provide a consistent, independently created SQLite backup snapshot and its corresponding frozen artifact directory. `--frozen` is an explicit acknowledgment, not a mechanism for freezing a running coordinator. Any `-wal`, `-shm`, or `-journal` entry (even empty or a dangling link) causes refusal. This tool never checkpoints a source or copies a live main file while ignoring WAL.

Every existing path component must be a real directory/file, not a symbolic link; use canonical absolute paths, including on macOS where `/tmp` and `/var` may be aliases. Files must be regular with one hard link. Files are opened no-follow/nonblocking and checked for inode/device/mode/link-count/size/mtime/ctime consistency before and after bounded reads. Artifact listing, root identity, file identities and streamed hashes are checked again at completion. In-place changes, path substitutions, new/deleted entries, and late sidecars invalidate the run. These checks do not replace the operational freeze or defend against a privileged adversary controlling the OS and metadata. Reads may update access times; content, modification times and directory entries are not intentionally changed.

The SQLite bytes are copied into an exclusive 0700 temporary directory with 0600 files. **Only that inspection copy** is opened with `DatabaseSync(..., {readOnly:true})`, query-only mode and a read transaction. This avoids SQLite creating WAL/SHM sidecars beside the supplied source, including legacy WAL-mode main-file snapshots. The source is never opened through `Ledger` or `Artifacts`. Private staging, including any inspection-copy sidecars, is removed on success or exception. An OS/process kill can leave private temporary data; crash-proof secure erasure is not claimed.

## Supported schema and manifest

- Exact legacy Ledger v1 SQL objects, migration row/version, application/user version zero, UTF-8 database encoding and integrity check. Foreign tables, triggers, views, altered schema and unsupported versions fail. The exact optional `memory_search` FTS5 family is recognized but its contents are never authority.
- Streaming ordered rows: records `(kind,id)` using SQLite BINARY UTF-8 ordering, events `cursor`, receipts `(device_id,key)`, outbox `id`, migrations `version`. Text bytes must round-trip as UTF-8. Counter validation is selected by expected column identity, never the returned JavaScript type: `revision`, `cursor` and migration `version` must be bigint values of at least one, within JS safe-integer range. TEXT/REAL storage classes are rejected even where SQLite INTEGER affinity allows them. Allocator `sqlite_sequence.seq` is likewise required to be a nonnegative safe bigint, without using it as the event watermark. Timestamps preserve their original valid ISO milliseconds text. JSON validates numeric round trips, duplicate keys and depth; original JSON text is hashed separately from canonical semantics. No source JSON is rewritten.
- Each table has count and length-framed raw/canonical row SHA-256. Column names are included in each canonical row encoding. Raw hashes preserve whitespace/key order inside stored JSON. IDs, revisions, receipt digests/results, historical events, revocation records, outbox states and forgetting tombstones are included without synthesizing new values.
- Cursor gaps are retained. The watermark is `MAX(events.cursor)` (zero when empty), **not** count or `sqlite_sequence`. Sequence data is not imported; the entire source file fingerprint still covers it.
- Tombstone count/hash covers current `memory` records with `forgotten:true`. Historical events can still contain prior memory text; inventory is not erasure. Any future search rebuild must exclude forgotten records.
- Manifest fields contain counts, fingerprints and fixed diagnostic codes, never raw payloads, filesystem paths, arbitrary names/IDs or kinds. Kind/file names are represented by hashes. Hashes and counts are still sensitive metadata and should be retained privately. No timing or wall-clock fields enter the manifest.

## Files, uploads, and limits

Every artifact record must have a matching regular `<uuid>.blob` with exact size and SHA-256. Directory entries are enumerated incrementally with a one-entry buffer and a handle closed in `finally`; entry 10,001 triggers refusal before further enumeration or sorting. Only a bounded accepted collection is sorted. Names travel losslessly via reversible latin1 bytes, then must exactly round-trip as UTF-8 before lookup or hashing. Invalid-byte names are rejected, not decoded into replacement-character aliases. All accepted root entries are streamed and inventoried, including unexpected files; directories and unsafe aliases fail rather than being traversed. `.part` files associated with uploads are inventoried by size/hash, and their size is compared with the stored offset. Complete uploads must agree with their published record. Incomplete uploads always add `partial_uploads_unsupported`; absent parts, offset disagreement and a blob existing before completion add explicit missing/ambiguous blockers. Unexpected files are never published or silently discarded. Legacy backups do not include incomplete upload bytes, so such records remain visible with missing-part blockers.

Bounds: 128 MiB SQLite, 200 MiB encrypted archive, 128 MiB aggregate decoded legacy data, 64 MiB per artifact, 10,000 filesystem entries and artifact/upload records combined, one million rows per table, 1 MiB per stored JSON value. Files are hashed in 64 KiB chunks. Legacy authenticated JSON/base64 decoding is intentionally in-memory under its bounds, not a constant-memory archive parser. All sources carry `source_only_no_apply` and `external_state_not_inventoried` blockers; `applySupported` is always false. Claimed/unknown effects explicitly require reconciliation.

## OUTPOST1 compatibility

Decode only; never call the existing restore function. The current writer's magic is **eight bytes**, hex `4f5554504f535431`; ranges are magic `[0,8)`, IV `[8,20)`, GCM tag `[20,36)`, ciphertext `[36,end)`. AES-256-GCM AAD is exactly `outpost-backup-v1`. The scout's seven-byte/header-defect allegation was incorrect. No seven-byte variant is accepted and the existing decoder is unchanged.

Authentication precedes parsing/extraction. Version/shape, UTF-8, canonical base64 (including padding bits), SHA-256, aggregate/per-file size, unique UUIDs and SQLite/artifact cross-inventory must all validate. Archive parsing/authentication failures are uniformly `invalid_archive`; later schema/inventory failures remain redacted. No partially validated files are published. Tests generate a real archive using the current writer and assert the literal golden magic and offsets; deterministic-IV re-encryption exercises the same layout. No checked-in opaque backup or private key fixture is needed.

## Local validation and remaining gates

`server/reliability/import.test.ts` is flat so the existing `npm test` glob includes it. Tests cover repeat manifest equality and source content/stat equality; safe integer boundaries/Unicode; cursor gaps; tombstones, revoked devices, receipts and outbox; zero/nonzero blobs; actual writer archives, wrong keys/tags/truncation, foreign archive shape, duplicate IDs, base64/hash defects; foreign schema and lossy JSON; WAL and missing freeze acknowledgment; traversal, symlink/hardlink, streaming substitutions; incomplete uploads and rename ambiguity; redacted CLI errors and target-option refusal.

Review-fix regressions additionally cover TEXT/REAL record/event revisions, cursor/version minima and SQLite INTEGER PRIMARY KEY type enforcement, allocator storage classes/minima, and unchanged sources on refusal. A 10,003-entry fixture proves refusal after exactly 10,001 directory reads and one close, then acceptance/sorting at exactly 10,000 entries; read failure and invalid-name paths also prove handle cleanup. A raw `ff` versus actual U+FFFD filename fixture runs only on supporting filesystems and explicitly reports unsupported creation (this local filesystem returned `EILSEQ`). Independently, exact filename-byte decoding and a synthetic byte-preserving enumeration boundary are tested on every platform; actual Unicode/U+FFFD filenames are inventoried without decoding collisions. No claim of a successful raw-byte filesystem fixture is made when it is skipped.

Source-only evidence does not qualify exact inserts, receipt replay against a new authority, import journals/resume, PostgreSQL maintenance/readiness contracts, dispatch fencing, target validation, crash/lost-ack schedules, derived index rebuild, PostgreSQL backup/restore, live cutover, off-host recovery or whole-system state/key custody. Pi sessions, workspaces, browser profiles, connector credentials/checkpoints and key custody are explicit exclusions. Independent review and parent integration validation remain required.
