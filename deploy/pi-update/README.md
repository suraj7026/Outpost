# Full compatible server update (legacy browser runtime)

This sequence-6 artifact bundles the **full, self-contained compatible server
source**, including the coordinator, Pi worker, host executor, automation tools
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
- `server/environment/qualify-runtime.ts`
- `server/pi-adapter/runtime.ts`
- `server/pi-adapter/system-prompt.ts`
- `server/pi-management/bundled-extensions.ts`
- `server/pi-management/child-provider-bootstrap.ts`
- `server/pi-management/credential-store.ts`
- `server/pi-management/providers.ts`
- `server/pi-management/session-background.ts`
- `server/pi-management/session-extensions.ts`
- `server/pi-management/subscription-models.ts`
- `server/pi-worker/main.ts`
- `server/pi-worker/runs.ts`
- `server/scheduler/tools.ts`

The baseline `server/gateway/coordinator.ts` receives **only** the tested
`registerAutomationTools` import and registration, with the same integration as
the local coordinator: worker availability plus a callback checking maintenance
and `dispatchEnabled`. The automation tools independently enforce strict recovery
permission (`dispatchEnabled === true` when a recovery record exists), including
on execution after approval. The current coordinator is never copied. Removing
the two inserted blocks must recover the exact baseline bytes.

All other baseline files remain byte-exact, including legacy browser behavior,
all other gateway code, host executor, runtime pins and captured AppleDouble
sidecars. Packaging asserts that `server/main.ts`, `server/pi-worker/main.ts` and
`deploy/agent/host-executor.mjs` exist and are nonempty, preventing incomplete
service bundles. The captured baseline contains no `server/browser-engine`
Python files or locks; their absence is preserved. No Camoufox migration or
current browser source is imported.

The staged root package and lock come from `deploy/pi-update/package.json` and
`deploy/pi-update/package-lock.json`, never the current root package/lock. These
dedicated files are copied byte-for-byte and are unchanged for sequence 6.
They retain baseline metadata, scripts, overrides, dev dependencies and other
direct dependencies. The existing reviewed changes are Pi `1.4.0` to `1.5.2` and
addition of `pi-subagents` `0.88.1`; `pi-ollama-cloud` remains `0.13.1` and
`playwright` remains `1.64.1`. No `playwright-camoufox` alias is allowed.

Native installed extensions and child agents run with worker privileges, without
an extension execution adapter. Coordinator automation tools retain approval
gates; native extension tools are not rerouted through `outpost_action`. The
current system-prompt overlay retains recovery and automation instructions.

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

The sequence-6 host manifest retains only strict schema-2 fields. Its content ID
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

Future signed releases in the same legacy-browser family need an explicitly
signed family-selection contract in the parent/native implementation. This
packager does not relax the existing exact-source allowlist or imply that any
future same-pins release is already authorized. Runtime-pin comparison remains
byte-exact even after family selection is introduced.

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
- Coordinator changes limited to the import and guarded registration; legacy
  browser registration and inference retained.
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
verify the automation catalogue, owner approval, maintenance/recovery refusals
(including malformed records and post-approval changes), and synthetic save/list/
pause behavior. No scheduled task is run. It also runs the packaged runtime
qualifier, baseline `tsc --noEmit`, and strict manifest schema validation.

Qualification uses disposable HOME, TMPDIR, XDG, Pi agent, subagent and npm-cache
directories, not production profiles or credentials. Tests do not write desktop
resources or deploy. Local qualification is not Linux native-addon or live-host
activation qualification. Current state, credentials, settings, session receipts
and dependency directories are never collected into the archive.

Sequence-6 validation: all 12 offline tests and all 18 tests with `--qualify`
passed. Qualification covers the exact overlay bytes captured at test start;
rerun it after any approved overlay changes before signing or publishing.
