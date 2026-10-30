# Source-only import preparation — reviewed integration

## Scope and verdict

Fresh independent review **PASS**, followed by parent integration of the eight exact reviewed additions. This is frozen SQLite inventory and authenticated legacy OUTPOST1 decode preparation, **not destination import, migration, restore qualification or T1 completion**. The tool has no target configuration, connection or apply path; manifests always report `applySupported: false`.

Files: `server/reliability/import/{cli,contracts,dry-run,legacy-outpost1,manifest,sqlite-source}.ts`, `server/reliability/import.test.ts`, and `docs/implementation/slices/t1-import-source.md`.

Builder/reviewer workflow: `3cbd99ba-e7c1-4278-a6ac-de66090776a7`. Corrective builder: `61188cb4-c7fd-4734-8017-8c396ed9373d`; fresh reviewer: `54a6b224-339b-4301-842c-1fe4024bd1c8`. Reports are `import-validation-fix.md` and `import-validation-review.md` under that workflow's session artifacts. Review was source/log inspection, not reviewer execution.

## Corrections and guarantees

- Counter validation dispatches by column identity, requires the expected SQLite integer storage class, checks minima and rejects unsafe integers. Allocator metadata is independently validated and never substituted for the event watermark.
- Directory names retain original bytes through enumeration and must round-trip exactly as UTF-8 before lookup/hash; invalid bytes cannot alias a replacement-character name.
- Incremental enumeration rejects entry 10,001 before further enumeration/sorting and closes the directory handle on every path.
- Only a private inspection copy is opened through SQLite; frozen source identity/content and sidecar checks remain. Operational freezing is still required.
- Existing OUTPOST1 eight-byte magic and offsets 8/20/36 remain unchanged. Authentication precedes extraction. Actual legacy-writer round-trip tests remain.

## Parent execution evidence

Original worktree base: `c71e722ceb561837b33cac5892859fe3b537155f`. Parent captured HEAD/status/base diff and all eight SHA-256 hashes; after worktree execution, verified files unchanged. Artifacts: `/tmp/outpost-import-fix-parent.dmab1g/`.

- Worktree build passed.
- Focused importer: **29 passed, 1 skipped**, zero failures.
- Full worktree suite: **209 passed, 1 skipped**, zero failures.

Integrated onto parent base `5d22355840919e4b84b57de0e9b2dab935e048a4`; all eight hashes matched both before and after copying. Parent executed:

```sh
npm run build
node --import tsx --test --test-concurrency=1 server/**/*.test.ts
git diff --check
```

Integrated build and whitespace checks passed. Tests: **272 total, 271 passed, 1 skipped, zero failures/cancellations**. Logs: `/tmp/outpost-import-integrated.l5glzZ/{build,tests}.log`. PostgreSQL regression tests used only the existing private fixture (local Homebrew PostgreSQL 16.15), not the live target or an importer connection. Serial execution limits disk pressure.

### Explicit platform limitation

The actual raw `ff` filename collision fixture was skipped because this filesystem rejects creation with `EILSEQ`. The production byte-decoding primitive, synthetic byte-preserving enumeration and actual valid Unicode/replacement-character names were tested successfully. This is **not** native invalid-byte filename qualification on a supporting filesystem. Do not report all 272 tests passed.

## Outstanding gates

Destination inserts, immutable identities/receipts, resumable import journals, lost-ack/crash recovery, dispatch fencing, index rebuild and target validation remain absent. PostgreSQL backup/restore and full-system recovery remain unqualified. Pi sessions, workspaces, browser profiles, connector state and key custody are explicit exclusions.

The private runtime conversion will need test imports adapted to explicit legacy-only fixtures. Any such changes require review and integrated retesting; this evidence applies to the exact source-only additions on the pre-conversion parent branch, not an unreviewed future runtime graph.
