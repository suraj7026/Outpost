# App-managed automatic server updates

## Policy

Deployment scope defaults to **both saved Outpost servers**, not just the currently selected chat/server. The installed Mac app checks connected saved SSH environments in the background. Installation is opt-in: enable **Automatic server updates** in **Settings → Servers → your server → Server updates** and approve all listed environments once. The app then updates enrolled environments sequentially, only while the app is running and connected. Offline environments are checked when they reconnect; no coordinator history or credentials are migrated between servers.

The existing manual update path remains available. An active, failed, unknown, or unreconciled operation blocks automatic progression. Turning automatic updates off stops future automatic launches but does not cancel an admitted update or remove the server-side grant. A failed/unknown update requires inspection; repeatedly reconnecting or restarting the app does not authorize another launch.

## Settings and file-review compatibility

**Server updates** replaces the Pi-centric tab label while retaining its `/runtime` deep link. The page separates the installed Outpost release ID/sequence from Pi and extension versions. **Check for server updates** compares against this app's bundled compatible release, not an online latest-release feed. An exact compatible release/manifest match is **Up to date with this app**; unsupported installations, missing pinned SSH, incompatible runtime pins, downgrades and conflicting same-sequence content are **Update blocked**, with the reason visible. Older receipts without a classified outcome never imply an exact match.

The main sequence-8 and legacy-compatible sequence-7 bundles both include `workspace.files` and `workspace.read`. Coded `unknown_query` responses (plus exact older bridge string responses) show **Server update required** and link to the chat owner's settings. Permission and transport failures remain ordinary errors. Legacy unbound connections link to setup guidance, never an automatic reinstall. Successful automatic completion refreshes that server's selected file/listing once per release; updates on another server do not reload the current workspace. Reconnection also reloads current file contents.

The native updater remains the admission authority. Opening settings or a file-review link does not grant authorization. Manual launches remain blocked by active/uncertain automatic work; checks and status reads cannot silently opt in or repeat a launch. Both bundle families are qualified against authenticated file queries in isolated extracted-archive tests.

## Releases and signing

Each Mac app build contains two complete archives:

- `host-release`: current source for the current runtime/browser family.
- `pi-release`: historical resource filename for a **complete compatible-server release**, retaining the legacy browser implementation, dependency lock and runtime pins. Its reviewed source overlays include the automation tools and coordinator registration; it is no longer just a Pi version bump.

The desktop verifies the signed installed release, probes the runtime-pin digest through pinned SSH, and selects a signed compatible archive. Schema, layout, protocol, compatibility family and runtime pins must match; activation requires a strictly newer sequence. A runtime/browser migration is not an unattended update. Legacy unsigned `pi-only` metadata retains its exact source allowlist.

`desktop/build-mac.sh` packages both archives, verifies the required service/tool files, and signs their metadata before building the app. No live working directory is copied to a server. The signed payload binds the complete archive SHA-256 and size, manifest, runtime-pin digest, and required tool catalogue entries.

Initialize the **build publisher** once on the developer Mac:

```sh
node scripts/sign-releases.mjs --init
npm --prefix desktop run desktop:build
```

The private Ed25519 publisher key stays in the `dev.outpost.release-signing` / `publisher-v1` macOS Keychain item. Initialization never replaces an existing key. Builds fail if signing authority is unavailable; they do not quietly produce unsigned automatic-update releases. For CI, `OUTPOST_RELEASE_SIGNING_KEY_FILE` may identify a private (0600) Ed25519 PEM file supplied by the secret manager. Never add that key to source control, app resources, or server releases. Tests use generated disposable keys and never access the real publisher key.

Bump the qualified `sequence` (main) and `legacySequence` (legacy-compatible) in `deploy/environment/release-policy.json` for subsequent releases in their respective families. Different content must not reuse a published family/sequence; content hashes alone do not authorize a forward update. Future same-family signed releases need not enumerate every previously produced content ID; changing the family compatibility contract requires explicit qualification, not just reusing a version string.

## One-time server authorization

The app uses its existing device identity and pinned SSH route. A protected native dialog requests sudo authorization for enrollment only; passwords never reach React, receipts, logs, or persistent storage.

Enrollment installs root-owned trusted code under `/usr/local/lib/outpost-updater` and the fixed `/usr/local/libexec/outpost-update` launcher. `/etc/sudoers.d/outpost-update` grants the enrolled SSH user exactly that launcher **with no arguments**, not Python, a shell, arbitrary commands or unrestricted sudo. `/etc/outpost-native/auto-update.json` pins installation ID, existing device ID, publisher public key, SSH username and helper-source hashes. It contains no secret.

Every subsequent launch must pass both:

1. A publisher signature authorizing the exact compatible release.
2. A signature from the still-enrolled device authorizing the exact operation and environment.

The helper also verifies the existing signed `maintenance.stage` reservation, current release, monotonic sequence, runtime pins, archive integrity, bounded extraction and mandatory entrypoints/tools. It runs the trusted installed updater—not an arbitrary runner named by the client or supplied by an archive. Changed publisher/device pins fail closed; future builds never silently rotate trust. Helper-source changes block automatic launches before maintenance reservation. For an intentional helper upgrade, turn automatic updates off and enable them again with fresh protected consent. Renewal binds the exact previous policy and cannot change environment, device, publisher, or SSH user. It stages immutable helper versions and atomically selects the new version. A root-owned terminal enrollment receipt can prove that a failed renewal retained the previous policy; the app then releases the enrollment latch but leaves automatic updates off. Missing or uncertain receipts never authorize a retry.

To revoke unattended authority on a server, an administrator removes the exact `/etc/sudoers.d/outpost-update` grant using their normal privileged workflow. Do not delete update operation directories or release data to resolve an uncertain operation. Re-enrollment/replacing helper trust is intentionally not an unattended repair operation.

## Durable sequence and verification

The native journal and existing per-server receipts are saved before enrollment, maintenance reservation and launch. A process-wide guard plus local file lock serializes automatic operations and excludes concurrent manual starts. After an app restart, the supervisor inspects the original operation instead of issuing a new one. Missing or corrupt journal data is not interpreted as permission to retry.

Per server:

1. Validate the signed compatible artifact and enrolled policy.
2. Persist operation identity; obtain the existing signed maintenance reservation.
3. Submit one signed request to the fixed helper. Unknown replies remain inspect-only.
4. Stage dependencies separately from trusted source/Node. Promote dependency contents into fresh root-owned inodes verified against lockfile SRI hashes.
5. Let the running coordinator drain work and acquire its maintenance checkpoint/worker hold.
6. Verify entrypoints before switching, retain the prior release, and activate only Outpost services.
7. Require a stable readiness window for coordinator, authenticated worker and host executor. Verify host token enforcement without running a command; qualify the advertised tools using an isolated real coordinator fixture.
8. Commit only after health verification; attempt rollback on activation failure. Release holds through the existing checkpoint mechanism.
9. The app independently verifies the environment/release, worker, fresh service stability, runtime pins and required tools before admitting the next server. Historical PIDs need not survive a reboot; current observations must be stable. Empty task history is valid and does not create a production test task.

The completion receipt records verified required tools and health evidence. A failure after commit must not restart newly admitted work. No Linux cron jobs are created by this updater.

## Validation

```sh
node --test scripts/test-sign-releases.mjs
node scripts/test-pi-update.mjs --qualify
python3 -m unittest discover -s deploy/environment -p 'test_auto_update.py'
python3 -m unittest discover -s deploy/environment -p 'test_host_update.py'
node --test desktop/test-automatic-updates.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features update
npm run build
npm --prefix desktop run build
node desktop/test-maintenance.mjs
node desktop/test-workspace-panel.mjs
OUTPOST_TEST_BROWSER=webkit node desktop/test-workspace-panel.mjs
```

Unit/fixture tests do not substitute for a disposable Linux systemd qualification and an actual app-driven enrollment/update rehearsal. Enabling the grant on a live server is a separate one-time user action; implementing or rebuilding the feature alone does not enroll existing installations.
