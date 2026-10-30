# Calendar integration and persistence checkpoint

## Accepted calendar scope

Integrated the unwired OP-004 calculation slice over `c71e722`, after fresh Astra review `7cac9c2f-056a-46ce-a392-1f7ee339d014`: **PASS**, no remaining P0/P1/P2 findings. This is not calendar dispatch or full OP-004 acceptance.

The slice supplies timer-free five-field recurrence, named IANA timezone validation, explicit gap/fold behavior, bounded preview, stable occurrence identities and fail-closed eligibility advice. Independent review caught permissive cron/timezone inputs and then stepped-range endpoint validation defects. Parent reproduced both rounds; the final correction checks every atom and both endpoints before Croner evaluates recurrence. Tests retain valid named ranges, Sunday aliases and field-specific step behavior, including non-hour DST folds and a skipped civil day.

### Parent verification

- Corrected worktree: build and **33 calendar/scheduler tests passed**. Raw artifacts: `/tmp/outpost-calendar-bounds-validation.ha3Hpy/` (also contains exceptional-base HEAD/status/diff and installed versions).
- Integrated branch: `npm run check` passed TypeScript and **212 tests**, none failed/skipped; focused calendar/scheduler suite **33 passed**; `git diff --check` passed.
- Integrated raw logs: `/tmp/outpost-calendar-integrated.XiGY5J/{install,check,focused}.log`.
- Dependencies: exact `croner@11.0.0`, `@js-temporal/polyfill@0.5.1`, reviewed transitive `jsbi@4.3.2`. Parent checked every prior lockfile package against the integrated PostgreSQL dependency baseline: unchanged; only the three reviewed calendar packages and two root dependencies were added. Installation ran only in the main checkout's real dependency directory with scripts disabled.

Reviewers inspected source and assertions, not executed tests. Parent results above are separately executed on Node 26.3.0. Temporary paths are not durable backup guarantees. Calendar dispatch remains unwired pending PostgreSQL occurrence receipts, atomic admission/cursor updates, ownership/revision and before-effect authorization, delivery recovery, complete-window acquisition, Tauri controls and crash/restart qualification.

## Accepted persistence prerequisites; runtime conversion still absent

The core writer requested a bounded checkpoint instead of a partial runtime graph. Parent approved **cancellation prerequisite only**; the approximately 30 legacy callers, their tests and runtime routing remain unchanged. This is not completion of the planned PostgreSQL conversion.

Parent inspected the three-file prerequisite and independently passed its build and **29 private PostgreSQL tests**. Patch SHA-256: `748e917f5f0888c4c46a334072a5516e83f7ac0fd80cd37aa2f4e2a9d21b2fd9`; raw patch/logs: `/tmp/outpost-transaction-cancellation-prerequisite.t1RlPV/`. Fresh reviewer `8d54812f-540b-42cb-80ea-fcf05394fa36` passed the cancellation prerequisite only, explicitly blocking full runtime/T1 acceptance as unimplemented. Parent integrated the exact patch and checkpoint document. The catalogue adapter writer was explicitly authorized to apply this exact prerequisite in its own worktree, without maintaining a second variant.

Cancellation is cooperative before COMMIT dispatch. Once dispatched, the owned transaction must settle under database timeouts; a confirmed commit remains confirmed, and a lost acknowledgement is not proof of rollback or authority to retry. Never detach a write using a caller-side promise race. Arbitrary never-settling callback work is not forcibly cancelled; transaction callbacks must contain only awaited repository work.

Skills registry persistence passed fresh review `a84d459e-d345-4795-bb97-6800a9aa4cd2` and is integrated as three dormant additions. It supplies a scope-bound fresh reader, separate trusted authorized writer, immutable version pins, terminal revocation/deletion tombstones, CAS and atomic audit/events. Parent build/**33 registry+skills tests** passed in `/tmp/outpost-skills-pg-parent.VdeEol/`, including actual approved bundles and graceful private-PostgreSQL restart. This is not crash/PITR or durable runtime-pin rehydration proof. No registry administration/runtime API has been activated.

After combining calendar, skills persistence and the cancellation prerequisite, parent reran **`npm run check`: TypeScript and 229 tests passed**, none failed/skipped. Focused capabilities/storage: **64 passed**. Separate deploy-verifier TypeScript check passed without running either live verifier. `git diff --check` passed. Logs: `/tmp/outpost-calendar-skills-cancellation-integrated.vE7vbb/{check,capabilities-storage,deploy-typecheck}.log`. Intermediate calendar+skills validation also passed 223 tests before applying the cancellation patch; final 229-test results supersede that intermediate integration checkpoint.

Catalogue persistence remains in fresh review; parent build and 72 catalogue/adapter/storage tests passed in `/tmp/outpost-catalogue-pg-parent.ixMy3s/`. It is not included in this integration checkpoint.

## Scout decisions and rejected claim

Read-only research-storage design confirms that generic `put` copies data into historical events. Therefore erasable research content must not use generic records/events as its cache. A storage-owned relational transaction interface, deletion/TTL fencing, publication lifecycle and durable cleanup intent must be designed together with artifact/citation access. This design is not implemented or accepted yet; no migration version is reserved by the scout.

The import scout's claim that `OUTPOST1` is seven bytes and current restore offsets are broken is **incorrect and rejected**. Parent executed `Buffer.byteLength('OUTPOST1')` and obtained **8**, hex `4f5554504f535431`; the real `server/reliability/backup.test.ts` round-trip also passed (log in the prerequisite directory). Correct ranges remain magic `[0,8)`, IV `[8,20)`, tag `[20,36)`, ciphertext `[36,...)`. No decoder correction or speculative seven-byte compatibility is authorized.

Source-only import preparation is running in workflow `72d44a7d-d5e6-4d5b-bcd9-5329006d0387`: frozen-source inventory, deterministic manifests, artifact integrity and explicit legacy archive decoding, with the corrected header contract. It has no target-database connection/apply permission. Durable import/resume markers, target ownership, runtime readiness refusal during incomplete import, PostgreSQL dump/restore and full recovery remain later gates. No live deployment/database/provider actions occurred.
