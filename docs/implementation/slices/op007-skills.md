# OP-007 — approved skills module slice

Implementation base: `eedfac8c88c38ee07d6761a4a66bdebdeda9830c`. This is an additive, locally tested module, **not full OP-007 acceptance or runtime enablement**. No catalogue, policy, gateway, runtime, storage foundation or desktop changes are included.

## Implemented contract

`server/capabilities/skills.ts` exports `ApprovedSkills`, `SkillManifest`, the asynchronous `SkillRegistryStorage` and `SkillReadinessProbe` contracts, and `SkillRunAdapter`.

- Configure an explicit map of root IDs to absolute, normalized, canonical server-owned paths. No directory discovery, default roots, environment expansion, package imports, extensions, dependency installers, network access, shell preprocessing or inherited credentials exist here.
- Each version occupies a retained directory under a configured root. `skill.json` is a strict JSON manifest with `schemaVersion: 1`, lowercase hyphenated `name`, opaque exact `version`, `description`, provenance `source`, `license`, `requirements`, and a `files` inventory. Each file has an exact relative `path`, `sha256` and byte length. `SKILL.md` is mandatory. Paths are portable ASCII components; case-folded duplicates and `skill.json` in the inventory are refused.
- `inspect(rootId, directory)` verifies the entire declared inventory and returns a frozen candidate pin. It never approves anything. Importing an ordinary Agent Skills package means a separately reviewed staging step: construct the manifest/inventory and review every included resource. SKILL.md YAML is returned as inert text, not interpreted as grants or configuration. Unknown manifest fields, including self-declared approval, extensions, environment and allowed-tools, fail closed.
- `digest` is SHA-256 of **exact `skill.json` bytes**, binding identity, requirements, provenance, inventory paths, lengths and individual content hashes. Whitespace changes require review too. Resource order is not silently canonicalized. Resource bytes are hashed during staging and again when requested; unused resource bodies are not read merely to advertise metadata. A changed requested file or changed manifest is refused, never silently refreshed.
- Registry approval must match scope, root ID, directory, name, version and digest exactly. Approved, non-revoked, active entries alone participate in discovery/new admission. No first-wins behavior: duplicate records, duplicate `(name,version)` entries, or multiple active versions of one name reject deterministically, independently of registry ordering.
- `discover(scope)` returns only compact metadata and readiness. `admit({scope,runId}, names)` synchronously copies caller-owned names before validation or any await, then validates and uses only that snapshot. It admits an explicit all-or-nothing bundle, sorted by name, rejecting duplicates, missing members or unmet requirements. Its frozen evidence captures scope, run ID, registry revision and frozen pins. There is no hot refresh of that selection.
- Readiness requirements identify a `tool`, `credential` or `capability`, optionally at an exact version. The injected probe supplies availability facts only. Reasons identify the dependency and `missing`, `version-mismatch`, `disabled` or `probe-unavailable`; no credential values are accepted. Probes run again at admission, metadata access and content load, including queued/scheduled use.
- `metadata(context)`, `loadInstructions(context,name)` and `loadResource(context,name,path)` verify the bound scope/run, current approval/revocation and pinned manifest. Content returns the **actual verified bytes**, with file hash, version/digest and `trust: 'instructions-only'`, never a path to reopen. Registry checks occur before and after asynchronous content loading. Registry failures fail closed without leaking driver error text.
- Deactivation prevents new admission; already admitted runs retain the old approved version. A new active version affects only new runs. Revocation, approval removal or deletion refuses future metadata/content loads for already admitted work as well. Published version pins must never be reassigned.

## Filesystem and resource bounds

`skills-files.ts` rejects traversal, absolute resource paths, URL/percent/backslash aliases, all symlinks (including root ancestors), hardlinks and nonregular files. It checks the directory chain, realpath, inode/device identity, byte length and modification/change times around a bounded file-descriptor read using `O_NOFOLLOW | O_NONBLOCK`. A deterministic test replaces a directory with a symlink between open and read; loading refuses the result. Hash verification protects against returning content different from the approved bytes.

Limits: manifest 32 KiB; SKILL.md 64 KiB; each asset 1 MiB; declared bundle total 8 MiB; 64 files per bundle; 32 skills per selection; 1,024 retained registry entries per scope; relative paths 512 characters; descriptions 1,024 characters; 32 requirements per manifest. Reads allocate at most the applicable file limit plus one byte and detect growth. The registry owner must bound its own query/results before materialization; the service additionally validates its returned snapshot.

This is **not a hostile-host sandbox**. Portable Node does not provide directory-FD-relative `openat` traversal. Chain and inode checks plus content hashes refuse observed drift and redirects, but cannot exclude every adversarial rename/restore race before reading bytes into process memory. Approved roots and ancestors must be owned by the trusted server and not writable by task processes/untrusted users; immutable version storage is an integration precondition. Host/root compromise is outside this module's guarantee. No raw host paths or filesystem error details are returned in load errors.

## Pi 1.4.0 integration boundary

The installed and pinned `@earendil-works/pi-coding-agent` is 1.4.0. Read in full: `docs/skills.md`, `docs/sdk.md`, `dist/core/resource-loader.d.ts`, `dist/core/skills.d.ts`, `dist/core/source-info.d.ts`, and `examples/sdk/04-skills.ts`; inspected `dist/core/agent-session.js` skill expansion. Existing Outpost `server/pi-adapter/runtime.ts` supplies an explicitly empty custom ResourceLoader and only `outpost_action`.

Pi's native `Skill` has `filePath`/`baseDir`, and `_expandSkillCommand` synchronously uses `readFileSync` without an awaited approval/revocation hook. Therefore this slice deliberately supplies `adapter.nativePiSkills`, a typechecked `Pick<ResourceLoader,'getSkills'>` returning **no native skill paths**. This exception/boundary and strict manifest design were explicitly approved by the supervisor during the build.

Later integration must:

1. Resolve authenticated scope/run IDs server-side and construct the adapter from the trusted registry; never accept model-provided approval, roots or persisted evidence as authority.
2. Render awaited compact metadata safely as untrusted instruction metadata. Invoke the async content methods through the common Outpost action routing. Do not place loaded content into grants, tool registration, system authority or extension factories. Any executable text remains text until a separately authorized concrete action reaches the common gate.
3. Preserve empty native skill/extension/package/agent-file/prompt discovery. Do not wire `DefaultResourceLoader`, native `/skill` file expansion or direct read paths around the adapter.
4. Persist exact selection/evidence under the durable run owner before execution; add authorized restart rehydration of those pins rather than re-resolving active versions. This slice has immutable in-process selections, not a durable run repository or resume API.
5. Check current revocation again at the final runtime-use/effect boundary; subscribe/invalidate or stop affected work when revocation occurs. Revocation **cannot erase instructions already in model context**. The final post-read registry check cannot make a future effect atomic with revocation. Common-gate grants, current task state and policy remain authoritative.

## PostgreSQL/approval integration and recovery gates

`SkillRegistryStorage.read(scope)` must be an awaited, fresh, atomic scope-authorized repository view, not direct SQLite or cached approval. Its owner must enforce unique immutable `(scope,name,version)` pins, monotonic revocation, activation/approval CAS, audit provenance and retention of older approved versions. Writes and schema migrations are intentionally outside this lane. Durable registry/readiness adapters, signed administration, runtime routing, task evidence UI and restart tests remain parent integration work after PostgreSQL/runtime gates.

No migration or filesystem writes are performed by this module. Disabling all active entries stops new admissions; revoke to stop subsequent loads by existing selections. Retain version directories and evidence while runs/history reference them. Restoring a prior version for new runs means activating that retained approved pin, not rewriting content or undoing revocation. Backup/restore must cover both registry state and exact version files; missing files fail closed. Do not garbage-collect pinned content until durable run retention permits it.

## Upstream references (not embedded code)

- OpenClaw local HEAD `12c7926d2502b621f30297ac4f176aa5b6fa2fb8`: `docs/tools/skills.md` (inventory/readiness/visibility, immutable revisions, snapshots, path checks, authority caveats).
- Hermes local HEAD `088f657ecf77674c7b8e2ededf4e3576d82e042c`: `website/docs/user-guide/features/skills.md`, `agent/skill_bundles.py`, and relevant `agent/skill_commands.py` sections (progressive loading, bundles, collisions and preprocessing).
- These are current sibling checkout revisions, not claims about historical analysis pins. No upstream implementation was copied. Ambient discovery, first-wins precedence, missing-member skipping, shell preprocessing, installers and environment injection were intentionally not adopted.
- No applicable local SKILL.md files or Outpost AGENTS.md were found. The normative programme, OP-007 ticket, existing catalogue, trust gate and Pi runtime were read before implementation.

## Initial local evidence (before adversarial correction)

Node `v26.3.0`; existing read-only dependency symlinks reused without installation or mutation.

- `npm run build` — exit 0 (`tsc --noEmit`, whole server).
- `node --import tsx --test server/capabilities/skills.test.ts` — exit 0; 15 tests passed, 0 failed/skipped.
- `node --import tsx --test server/capabilities/*.test.ts` — exit 0; 17 tests passed, including existing catalogue and connector-tools regressions.
- `git diff --check` and `test -z "$(git diff --cached --name-only)"` — exit 0; no staged files. The two pre-existing untracked dependency symlinks were left unchanged.
- Tests cover explicit approval/no discovery; metadata-only advertising; immutable pins and copy isolation; readiness/recheck/failure; retained versions/new-run refresh; revocation after admission and during loading; scope/run mismatch; deterministic collisions; manifest/resource drift; traversal and aliases; symlink/root/hardlink escapes; oversize metadata/instructions/assets/aggregate inventory; inert authority-expanding instructions; invalid UTF-8/case aliases; directory replacement races; registry outage redaction.

## Adversarial review correction — pending admission input snapshot

Read the complete fresh `skills-adversarial-review.md` (review output `d08aee86-71fe-4120-a08f-9277a713f06f`) and the parent-executed reproduction artifact `/tmp/outpost-skills-review-repro.LbafUh`. The review identified one P1: validation used the caller's `names`, but copying occurred after awaiting registry state. Append/replacement/clearing immediately after `admit()` could admit 2/33/0 pins instead of the original one. Those original observations are parent evidence, not reviewer-executed tests.

The bounded correction in `skills.ts` captures `selectedNames` synchronously on entry and uses that same snapshot for validation and selection. No registry, authority, filesystem, native Pi, persistence or runtime contracts changed. `skills-files.ts` is unchanged by this correction.

Added seven regression tests in `skills.test.ts`: three pending-admission mutations (append duplicate, replace with 33 copies, clear); two invalid original selections (duplicate, 33 distinct names, both rejected before registry access even if subsequently repaired); adjacent caller mutation of admission scope/run and configured roots; and fail-closed mutation of context during metadata/instruction/resource access. Each valid pending-admission mutation must retain exactly the original pin and permit verified loading of that original selection.

Adjacent boundary inspection (source-derived): admission scope/run strings are already captured before the first await; root mappings are copied into the private map synchronously; pin/state data pass through strict schema parsing; readiness receives a frozen requirement copy; path/name parameters are primitive strings. Access methods use the bound scope/pins for repository work and recheck caller context before returning, so mutations cannot redirect authority and mismatches fail closed. New executed regressions specifically cover admission context/root-map isolation and pending-access context refusal; inspection is not claimed as exhaustive adversarial execution of every boundary.

Executed correction evidence:

- Free-space preflight: `df -k .` reported 5,487,776 KiB available; pre-validation guard reported 5,462,776 KiB, both above the 2 GiB stop threshold.
- Before the code fix: `node --import tsx --test --test-name-pattern='pending admission|invalid initial selection|adjacent admission' server/capabilities/skills.test.ts` — exit 1 as expected; 6 tests executed, 3 passed and the 3 mutation regressions failed with the reproduced 2/33/0-pin results. This was an intentional test-first failure, not an infrastructure failure.
- After the fix: `node --import tsx --test server/capabilities/skills.test.ts` — exit 0; **22 passed**, zero failures/skips.
- `npm run build` — exit 0; whole-server `tsc --noEmit`.
- `node --import tsx --test server/capabilities/*.test.ts` — exit 0; **24 passed**, zero failures/skips, including existing catalogue/tools regressions.

Fresh independent verification of this correction and integrated PostgreSQL/runtime/end-to-end acceptance remain required. All earlier integration gates and trusted-root limitations above remain unchanged; this is not full OP-007 completion. No live providers/accounts, deployments or release qualification were used or claimed.
