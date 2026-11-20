# Full compatible server update (legacy browser runtime)

This sequence-7 artifact bundles the **full, self-contained compatible server
source**, including the coordinator, Pi worker, host executor, file-review APIs, automation tools
and authorized auto-update helper. It is not a Pi-only payload, a fresh-install
artifact, or a browser migration. The `pi-release.*` resource names and
`buildPiUpdate` API remain for compatibility.

The reviewed installed source releases are:

- `host-e89b6404f05c3a07c0f6` — immutable original schema-2, sequence-1 baseline.
- `host-24b08c6bb80dd3932f21` — deployed sequence-2 update.
- `host-b44894f3afe1c0de9685` — deployed legacy-browser family.
- `host-f428c9960b5b1f32dae0` — deployed legacy-browser family.
- `host-41cd62017ed6c74b5248` — deployed legacy-browser family.

App-connection auto-updates are approved for both runtime variants; this is the
legacy-compatible variant. Native selection, connection orchestration, signing,
release policy and the other host packager are owned separately. Shipping this
archive alone does not enroll a host or enable auto-updates.

## Immutable baseline and narrowly scoped changes

The builder verifies `scripts/fixtures/outpost1-pi140-source.tar.gz` against
SHA-256 `f02c1479e7f59eb94221eb56977becd517c940da980f45381c68e35fc4deeff7`
before extracting it into a disposable directory. It checks the exact baseline
manifest and 202-file inventory. It never contacts SSH or recaptures the source.

Only these working-tree source files replace/add baseline files:

- `deploy/environment/auto_update.py`
- `deploy/environment/host_install.py`
- `deploy/environment/host_update.py`
- `server/artifacts/workspace-review.ts`
- `server/core/contracts.ts`
- `server/diagnostics/recovery.ts`
- `server/environment/qualify-runtime.ts`
- `server/gateway/live.ts`
- `server/models/cloud.ts`
- `server/operations/hosts.ts`
- `server/pi-adapter/live-events.ts`
- `server/pi-adapter/remote-runtime.ts`
- `server/pi-adapter/runtime.ts`
- `server/pi-adapter/subagent-contract.ts`
- `server/pi-adapter/subagent-privacy.ts`
- `server/pi-adapter/subagent-runs.ts`
- `server/pi-adapter/subagent-transcript.ts`
- `server/pi-adapter/system-prompt.ts`
- `server/pi-management/bundled-extensions.ts`
- `server/pi-management/child-provider-bootstrap.ts`
- `server/pi-management/credential-store.ts`
- `server/pi-management/providers.ts`
- `server/pi-management/session-background.ts`
- `server/pi-management/session-extensions.ts`
- `server/pi-management/subscription-models.ts`
- `server/pi-worker/contracts.ts`
- `server/pi-worker/main.ts`
- `server/pi-worker/runs.ts`
- `server/policy/migration.ts`
- `server/policy/trust.ts`
- `server/scheduler/scheduler.ts`
- `server/scheduler/tools.ts`
- `server/tasks/tasks.ts`

The baseline `server/gateway/coordinator.ts` receives only audited, unique-anchor
transforms: automation import/registration, workspace-review import/query handlers,
subagent public-feed/restart handling, and full-control policy integration. The latter
removes the reviewer import/construction and `approval.decide` handler/maintenance
exception, updates the `Gate` constructor, and uses the shared recovery helper for
fail-closed dispatch checks. Removing the inserted blocks and reversing the exact
replacements must recover the original baseline bytes; the current coordinator is
never copied.

Automation retains worker availability and maintenance/recovery checks, including
revalidation at execution. A missing recovery record permits legacy dispatch; a
present record must explicitly enable dispatch. The baseline predates
`recovery.inspect` and `recovery.investigate`: this patch does not add those APIs.
The packaged recovery helper and prompt guidance use full control, not approvals.
Workspace queries retain authentication, require the task to exist, and read
bounded workspace files without mutating them.

All other baseline files remain byte-exact, including legacy browser behavior,
all other gateway code outside the listed live overlay, host executor, runtime pins and captured AppleDouble
sidecars. Packaging asserts that `server/main.ts`, `server/pi-worker/main.ts` and
`deploy/agent/host-executor.mjs` exist and are nonempty, preventing incomplete
service bundles. The captured baseline contains no `server/browser-engine`
Python files or locks; their absence is preserved. No Camoufox migration or
current browser source is imported.

The staged root package and lock come from `deploy/pi-update/package.json` and
`deploy/pi-update/package-lock.json`, never the current root package/lock. These
dedicated files are copied byte-for-byte and are unchanged from sequence 6.
They retain baseline metadata, scripts, overrides, dev dependencies and other
direct dependencies. The existing reviewed changes are Pi `1.4.0` to `1.5.2` and
addition of `pi-subagents` `0.88.1`; `pi-ollama-cloud` remains `0.13.1` and
`playwright` remains `1.64.1`. No `playwright-camoufox` alias is allowed.

Native installed extensions and child agents run with worker privileges, without
an extension execution adapter; native extension tools are not rerouted through
`outpost_action`. Coordinator tools retain validation, evidence, host boundaries,
revocation and maintenance/recovery holds, but no per-action approval or reviewer.
New tasks and scheduled tasks use `full_control`; legacy `auto`/`ask_permission`
inputs normalize to it, and malformed values still fail validation.

At startup, the task recovery overlay normalizes persisted policies and schedules,
retires unexecuted pending approvals, resolves their notices, and retires associated
unclaimed queue entries. Affected tasks pause for explicit resume and replanning;
startup never dispatches old approvals. Completed/unknown effects and reconciliation
records are not replayed, and existing terminal/manual holds remain intact. The
migration is idempotent and preserves prepared maintenance checkpoints.

## Offline packaging

Requires Node.js 24+ and Python 3.10+. Packaging does not run npm, lifecycle
scripts, downloads, SSH, privileged helpers, or host changes. Self-contained
means complete source and dependency locks: installed dependencies and runtime
binaries are not collected from this machine.

```sh
node scripts/package-pi-update.mjs
```

The CLI's only persistent writes are:

- `desktop/src-tauri/resources/pi-release.tar.gz`
- `desktop/src-tauri/resources/pi-release.json`

For isolated output:

```js
import { buildPiUpdate } from './scripts/package-pi-update.mjs';
const metadata = buildPiUpdate({ outputDir: '/absolute/disposable/output' });
```

The optional `sourceRoot` supports isolated test fixtures; it cannot override the
baseline hash or identity. Packaging rejects symlink inputs, unresolved relative
TypeScript imports and unbundled nonstandard-library Python imports. Python is
parsed, not executed: `auto_update.py` and its `host_update.py` / `host_install.py`
dependencies must all be in the bundle.

Archives use sorted regular entries, fixed modes/ownership/timestamps and a
zero-timestamp gzip header. Identical inputs and toolchain produce identical
archive and metadata bytes.

## Metadata and native/signing integration

The sequence-7 host manifest retains only strict schema-2 fields. Its sequence
comes from `legacySequence` in `deploy/environment/release-policy.json`. Its content ID
hashes every staged file in sorted path order except the generated host manifest,
including the lockfile and `pi-update-source.json`. Provenance includes the
baseline digest, original source release, reviewed compatible-source list,
`extensionPolicy: 'native-installed'`, `requiredTools`, target sequence, overlay
paths, `patchedPaths: ['server/gateway/coordinator.ts']` and sorted changed paths.
The sequence therefore contributes to deterministic archive identity.

Outer metadata retains schema 1, ID, manifest, archive SHA-256/size and exact old
runtime-pin values plus their byte hash. Its additional contract is:

- `sourceRelease: 'host-e89b6404f05c3a07c0f6'` — retain this known baseline for
  existing public artifact metadata and native `pi_source_releases` validation.
- `compatibleSourceReleases` — exactly the five reviewed IDs above.
- `updateScope: 'compatible-server'` — UI/native consumers should describe the
  full compatible runtime, not a Pi-only update, despite legacy filenames.
- `extensionPolicy: 'native-installed'`.
- `requiredTools: ['automation.list', 'automation.save', 'automation.set_paused']`.

The signing tool must embed `requiredTools` in publisher authorization; outer
metadata alone is not authorization. Native selection must independently accept
all five reviewed sources and enforce identical runtime pins. Neither caller
input, a working-tree manifest nor sequence inference can add compatible sources.

Native selection accepts publisher-signed `compatible-server` releases within
the existing qualified runtime family without enumerating every previous content
ID. Signatures, schema/layout/protocol, byte-exact runtime pins and forward sequence
checks still apply. Legacy unsigned Pi-only metadata retains its exact-source
allowlist; this does not authorize a runtime/browser migration.

## Lock provenance

The initial dedicated lock came from the verified baseline. Its matching package
was changed only for the two Pi/subagents pins, then resolved with:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

This is a maintainer-only networked lock-generation step, not packaging. Do not
substitute the root lock or regenerate it during a build. Needed transitive
changes are already represented in the dedicated lock.

## Tests and qualification

```sh
node scripts/test-pi-update.mjs
node scripts/test-pi-update.mjs --qualify
```

Default tests are offline and write only temporary fixtures. They verify:

- Immutable baseline identity, complete inventory and byte-exact protected files.
- Exact reversal of all audited coordinator transforms; legacy browser registration
  and inference retained.
- Full-control-only execution, signed-client authentication/revocation, normalized
  modes/schedules, and safe pending-approval migration using extracted source from
  both release families. Omitting migration must fail behavioral qualification.
- Complete helper imports and all three service entrypoints.
- Exact package/lock inputs, strict metadata, required tools and sequence-bound
  identity; deterministic rebuilding and overlay-byte sensitivity.
- Rejection of tampering, dependency drift, broken imports, symlinks and empty
  worker entrypoints before publication.
- Packaged updater preflight for all five reviewed IDs, with synthetic installed
  manifests; changed runtime pins (even whitespace) and each missing service
  entrypoint fail before checkpointing. This tests updater preflight, not native
  source-selection authorization.

`--qualify` installs dependencies into the extracted artifact with
`npm ci --ignore-scripts --no-audit --no-fund`. It loads real native extension
resources, binds a synthetic Pi model/session, and checks tools without executing
native tools or child agents. It instantiates the packaged legacy coordinator to
verify full-control automation execution, maintenance/recovery refusals (including
malformed records and holds introduced after proposal), and synthetic save/list/
pause behavior. Both release families run the full-control and migration regressions
with their own dependency locks. Synthetic schedules may enqueue tasks; no real
model, browser or enrolled-host work runs. Qualification also runs the packaged
runtime qualifier, baseline `tsc --noEmit`, and strict manifest schema validation.
Both extracted release families exercise authenticated `workspace.files`/`workspace.read`.
Removing either handler makes qualification fail; missing workspace-review modules
are rejected by signing inspection.

Qualification uses disposable HOME, TMPDIR, XDG, Pi agent, subagent and npm-cache
directories, not production profiles or credentials. Tests do not write desktop
resources or deploy. Local qualification is not Linux native-addon or live-host
activation qualification. Current state, credentials, settings, session receipts
and dependency directories are never collected into the archive.

Qualification covers the exact overlay bytes captured at test start. Rerun both
offline tests and `--qualify` after any approved overlay changes before signing or
publishing; source changes do not allocate a new release sequence.
