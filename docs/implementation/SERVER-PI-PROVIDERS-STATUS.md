# Server Pi providers — deployed limited release

Current Server-2 release: **`evidence-order-20261031T055909Z`**. The [execution-evidence repair](EXECUTION-EVIDENCE.md) preserves new error explanations and presents actual outcomes in timestamp order; provider/access policy is unchanged. [Strict access and action-contract repair](STRICT-MODEL-ACCESS-AND-ACTIONS.md) blocks all unverified provider/method combinations, including saved API keys, and restores remote tool schemas plus actionable validation errors. Only ChatGPT OAuth has an implemented access verifier; other methods stay blocked pending qualification. ChatGPT model choices now require authenticated account discovery in the picker, saved-default validation, worker admission and shared CLI; discovery failure blocks unverified choices. See [OpenAI account-model verification](OPENAI-ACCOUNT-MODELS.md). The owner-approved `pi-ollama-cloud@0.13.1` provider is active in the shared worker/CLI runtime, displayed as **Ollama**; the old conversational proxy is removed. See [Ollama Cloud deployment and setup](OLLAMA-CLOUD.md). This is **not completion of the general provider-package/terminal roadmap**. The initial built-in/compatible-provider rollout below remains historical verification.

## Initial deployment verification

- `pi-workspace-6c9d64bf7d-ht86z` on `surajhomeserver2`: **3/3 Ready**, zero restarts at verification (`workspace`, `coordinator`, `pi-worker`).
- Private coordinator health endpoint ready; Mac loopback tunnel health check passed.
- Worker runs as UID 1000. Its actual mounts expose the worker source subset and dependencies read-only. Ledger, coordinator source and host-executor token are not visible in the worker.
- CLI `command -v pi`: `/home/node/.local/bin/pi`; `pi --outpost-runtime` reports release `providers-20261030T200757Z`, Pi **1.4.0**, profile **`/home/node/.pi/agent`**, resources disabled.
- Worker catalogue reports the same release/profile/Pi version, **43 providers**, and one currently configured model: **`outpost-ollama` / `glm-5.3-flash:cloud`**. This is discovery/configuration verification, not a live inference test.
- All **9 task records** (IDs, revisions and data) matched the predeployment database backup exactly after cutover. The four `verifying` tasks stayed `verifying`; five already-interrupted tasks were not rewritten.
- All nine legacy Pi session paths were verified in place. Sessions were neither moved nor deleted.
- Existing `auth.json` bytes matched the backup exactly. The additive models/settings migration did not overwrite credentials. It retained the existing Ollama default and its prior configured limits.
- Planned-maintenance checkpoint was restored and completed; prior dispatch state was restored to enabled.
- No real provider login, paid inference, synthetic task in the live ledger, or unrelated workload change was performed.

## Desktop — initial release installation

Installed `/Users/sudarshanrajagopalan/Applications/Outpost Desktop.app`.

- Built with `npm --prefix desktop run desktop:build`.
- Staged and installed bundles passed strict deep signature verification.
- Installed executable compared byte-for-byte with the release bundle executable.
- Opened installed application; observed PID 92988. Closed the stale development-bundle process, not a server task.
- Previous bundle: `/tmp/outpost-before-server-providers.g9CE4p/Outpost Desktop.app`.
- Backup pointer: `/tmp/outpost-server-providers-backup-path`.
- Build log: `/tmp/outpost-provider-desktop-build.log`.

Open **Settings → Server Pi providers** to select a sign-in method or configure a compatible endpoint. Model selection is available in both composers and applies to the next instruction. A completed provider login now asks for a separate **Save server credential** confirmation.

## OpenAI browser-return follow-up

The desktop now captures OpenAI's loopback callback on the Mac and submits the complete URL through the existing private server login prompt. Previously the browser returned to a Mac port with no listener. Pi and token exchange remain on Server 2; no server redeployment is needed for this fix. Explicit save confirmation is unchanged. See [OpenAI remote sign-in](OPENAI-REMOTE-SIGN-IN.md) for restrictions, fallback and tests. General callback forwarding remains disabled.

Follow-up checks: provider UI **26 checks each** in Chromium/WebKit, real native loopback/cancellation/ownership tests, and the pinned Pi OpenAI adapter against a mocked token endpoint. These do not claim a live account login.

## Release blockers resolved for this rollout

### Credential-save authorization and recovery

Provider interactions run without automatic credential persistence. A completed interaction produces a fresh, device-bound confirmation prompt. The signed answer waits for the bounded credential save to settle; provider callbacks alone cannot save a credential. Revoked devices cannot answer that prompt. Generation changes expire the flow before commit. Pi's public credential API retains SDK file locking.

Coordinator metadata-only leases serialize revocation against admitted credential writes; uncertain requests retain a short expiry fence across coordinator restart. Revocation during a settling write returns a retryable `credential_commit_in_progress`, rather than falsely claiming the write was revoked.

Worker SQLite receipts persist only operation IDs, nonsecret mutation digests and sanitized configuration results. They prevent configuration/logout replay across restart. Interrupted login IDs become explicitly unavailable/unknown after restart, never replayed with a stored secret. Login values and auth URLs do not enter the receipt journal, task ledger, outbox or desktop command retry file.

### Shared installation and worker boundary

The versioned release lives at `/home/node/.outpost/releases/providers-20261030T200757Z` and is mounted read-only at `/opt/outpost`. Workspace CLI and worker resolve the same Pi installation. Release manifest validation checks Pi version, profile, dependency-lock digest and resolved package location. Release ID is included in configuration generation and catalogue metadata.

`deploy/agent/provider-worker-patch.mjs` renders the restricted worker mounts. The worker gets only its source subset, dependencies, Pi profile, task workspaces, Pi sessions, its own temporary volume and worker-service token. It does not share the coordinator PID namespace. Provider packages/resources remain disabled in both the worker and managed CLI.

This is not a sandbox against owner-authorized root tools. The coordinator still owns those tools, approvals and evidence. The trusted interactive workspace retains its pre-existing home access; release permissions are not claimed to defend against a malicious owner editing their own home.

### Task-preserving checkpoint and legacy migration

`Tasks.prepareMaintenance()` refuses running/queued tasks, dispatching actions, live streams and unsettled execution outbox work. It holds dispatch and records exact revisions of settled review tasks. Startup validates that checkpoint before preserving those records. `finishMaintenance()` restores the prior dispatch setting. Unplanned restarts retain conservative recovery behavior.

`PiProfile.migrateLegacyOllama()` adds the legacy provider only when absent, preserves unrelated settings/credentials, refuses endpoint/model conflicts and is idempotent. It uses the existing nonsecret local-Ollama auth sentinel, not an account credential. Existing Pi session directories are mounted at their original absolute paths.

## Backups and rollback constraints

Server 2 private backup directory:

`/home/node/.outpost/backups/providers-20261030T200757Z`

Contains a SQLite backup of the ledger, the prior Pi profile, and prior Pi session directories. Credentials are present in this private backup; do not print or publish it.

Server 1 rollout records:

`~/outpost-rollouts/providers-20261030T200757Z/`

Contains the original deployment JSON, applied patch, source staging archive and restricted worker token file. The Kubernetes secret is `pi-workspace/outpost-pi-worker`. Do not print/export that directory or secret.

The original `/home/node/outpost-runtime` source and dependencies remain intact. **Do not blindly restore the old deployment:** its recovery code rewrites Verifying tasks, and its legacy adapter cannot interpret arbitrary new provider-qualified tasks or worker session mappings. Rollback must first hold dispatch, inspect new tasks/session mappings, and preserve the checkpoint-aware recovery implementation. Do not run two coordinators against the ledger or restore a stale database over newer history.

## Verification

- Backend type check and desktop TypeScript/Vite/native release builds passed.
- Final full backend suite: **297 passed, 1 skipped, 0 failed**, including additive migration, authentication recovery and maintenance checkpoint tests.
- Deployment-manifest isolation contract test passed; Kubernetes server-side dry-run and actual live mount checks passed.
- Rust: **8 passed, 1 intentionally ignored** owner-Keychain/live-server test.
- Initial-release provider UI: **19 checks each** in Chromium and WebKit; Studio **179 checks each**.
- Earlier unchanged-shell regressions: sidebar **135**, appearance **129**, scrolling **207**, image viewer **89**, each engine.
- Synthetic real SDK tests cover two providers, exact IDs, actual coordinator action execution, queued model switching, signed credential isolation, revoked-device save refusal, generation fencing, receipt restart behavior and task-preserving checkpoints.
- `git diff --check` passed before installation.

Isolated backend test invocation:

```sh
t=$(mktemp -d)
env -i PATH="$PATH" HOME="$t" LC_ALL=C \
  PI_CODING_AGENT_DIR="$t/pi" PLAYWRIGHT_BROWSERS_PATH=/tmp/outpost-playwright npm test
node --test deploy/agent/provider-worker-patch.test.mjs
```

## Still disabled / not claimed

- Trusted provider-package installation, package activation/rollback, and general resource editors.
- General Mac-to-server callback forwarding. OpenAI has a narrowly scoped Mac capture-to-manual-prompt path; other providers use their supplied device/manual-code methods, and callback-only methods may still require server-side interaction.
- General embedded remote terminal and live browser takeover.
- New provider credentials, Ollama account entitlement and paid inference qualification. OpenAI ChatGPT discovery now filters choices using the saved account's authenticated response; this does not establish quota/capacity or guarantee inference success. The owner performs sign-in; no billing or entitlement is inferred from a stored credential alone.
- A single automated native-Mac UI-to-live-provider inference test. Browser UI uses synthetic IPC; real SDK routing is tested with local synthetic endpoints. Live deployment validation used metadata, mount and history checks only.
