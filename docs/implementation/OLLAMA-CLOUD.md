# Ollama Cloud — shared server provider

## Deployed

Release `ollama-cloud-20261030T204743Z-r2` replaces the conversational local-daemon proxy with **`pi-ollama-cloud@0.13.1`** on Server 2. The displayed provider name is **Ollama**; its exact Pi identity is `ollama-cloud`. The endpoint is `https://ollama.com/v1`.

The package is an exact, lockfile-pinned dependency of the same read-only release used by the worker and managed CLI. Both use Pi **1.4.0** and `/home/node/.pi/agent`. No Mac Pi installation is involved.

The owner explicitly approved this package/direct-cloud switch. Its published registration, discovery, configuration, usage and web-tool sources were inspected before activation. Installation used `--ignore-scripts --legacy-peer-deps`; Pi's extension loader supplies its host-module mappings, including TypeBox.

## Integration boundary

`server/pi-management/ollama-cloud.ts` uses Pi's public resource loader with empty settings, all automatic resource discovery disabled, and one explicit package path. It checks the package version and expected single provider registration. Only that provider configuration is installed into the model runtime. Package session hooks, commands and web tools are **not** attached to worker sessions; actions continue through the coordinator's existing approval/evidence path.

`ollama-cloud-extension.ts` gives the managed CLI the identical provider registration. The wrapper explicitly loads this first-party entry while other extension discovery remains disabled. This is a narrowly managed provider, not general package-management/activation UI. It is not a sandbox against malicious owner-authorized code.

Pi restores the persisted model catalogue when creating each runtime. Revision r2 fixes a Pi 1.4 registration race: the wrapper captures and awaits registration's own detached refresh instead of launching a competing refresh. Five consecutive full-suite runs and repeated fresh-runtime restoration checks passed after the fix. Explicit model refresh uses the package's live discovery, excludes non-tool/chat models, and preserves exact IDs. It does not convert old daemon IDs such as `:cloud` into direct-cloud IDs.

## Credential setup and verification limits

1. Open **Settings → Server Pi providers** and search for **Ollama**.
2. Select **API key**, enter an Ollama Cloud key privately, and confirm **Save server credential**.
3. Refresh models, select a model in the composer, and optionally save a default separately.

No Cloud key was present at rollout; no real key was copied from another provider or from chat. The live catalogue therefore showed **zero selectable Ollama models**, not a fabricated working account. Existing credentials were byte-for-byte unchanged.

The package's model-discovery endpoints are public. Their catalogue is **not proof of per-account subscription entitlement**. A stored key alone is also not such proof. Live authentication, account limits and inference remain owner-assisted qualification after key entry; this rollout made no paid requests. The separate requested OpenAI account-model filtering is not implemented by this Ollama change.

## Retiring the old connection

`PiProfile.retireLegacyOllama()` removes `outpost-ollama` from `models.json`. If it was the saved default, it clears that default instead of silently choosing another account/model. Unrelated settings and all credentials are retained. The old credential is not renamed or reused as `ollama-cloud`.

Historical tasks/session records remain intact. An unavailable historical model blocks the next instruction until the owner explicitly selects an available provider/model. Browser-Use's independent daemon/model configuration is unchanged.

## Rollout evidence

- Pod `pi-workspace-6d574db64-6542v`: **3/3 Ready**, zero restarts at verification.
- Worker and CLI identify release `ollama-cloud-20261030T204743Z-r2`, Pi 1.4.0, shared profile.
- Worker runs as UID 1000 with existing restricted mounts; coordinator source and ledger are absent.
- All **10 task records** preserved exactly; the maintenance checkpoint protected **3** review-stage tasks. Dispatch restored to its previous enabled state.
- Server-2 backups: `/home/node/.outpost/backups/ollama-cloud-20261030T204743Z` (before proxy retirement) and its `-r2` counterpart (before the restore-race fix); private ledger, profile, sessions and task baselines.
- Server-1 rollout records: `~/outpost-rollouts/ollama-cloud-20261030T204743Z/` and its `-r2` counterpart (previous deployments, patches and source records). Six deployed runtime/manifest files matched local SHA-256 hashes exactly.
- Source/backend check: **301 passed, 1 skipped**, no failures. Provider UI: **30 checks each** in Chromium/WebKit.
- Real package/SDK fixtures verify registration without credentials, dynamic catalogue persistence, exact IDs, authenticated streaming against a mocked endpoint, CLI/worker parity and non-destructive retirement. No real account calls occur in those fixtures.

Rollback must preserve any credentials or tasks created after activation. Do not blindly replace the ledger/profile from backup. Restoring the old proxy is a separate, explicit configuration operation; restoring old code alone does not restore it.
