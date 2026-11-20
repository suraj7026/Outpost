# Spec 04: Broaden Pre-Activation Update Recovery, Unblock Multi-Server Queue & Support Per-Server Opt-In

- **Priority:** P1
- **Area:** Server Updates / Desktop Supervisor
- **Affected Files:**
  - `deploy/environment/inspect_failed_update.py`
  - `deploy/environment/test_inspect_failed_update.py`
  - `desktop/src-tauri/src/server_auto_update.rs`
  - `desktop/src-tauri/src/server_auto_update_tests.rs`
  - `desktop/src/AutomaticUpdates.tsx`
  - `desktop/src/automatic-updates.ts`
  - `desktop/src/RuntimeSettings.tsx`

## Exact Problem

Four concrete UX and workflow bugs in the automatic update supervisor cause unnecessary deadlocks and friction:

1. **One failed or blocked server freezes updates for all other servers:**
   - In `desktop/src-tauri/src/server_auto_update.rs` (`should_launch()`, lines 1322–1348), if *any* journal target has state `Phase::Failed | Phase::RolledBack | Phase::Blocked | Phase::NeedsAttention`, `should_launch()` returns `false` for **every** server. An unrelated issue on Outpost 1 prevents Outpost 2 from receiving updates.
2. **Recovery only works for `waiting_for_idle_failed`:**
   - `deploy/environment/inspect_failed_update.py` (line 29) refuses unless `(state, failureStage, failureCode)` is `('failed', 'waiting_for_idle', 'waiting_for_idle_failed')`.
   - `server_auto_update.rs` applies that same triple later in the file. `validate_failed_recovery` (lines 1770–1771) requires `state == "failed"`, `failureStage == "waiting_for_idle"`, and `failureCode == "waiting_for_idle_failed"`. `automatic_updates_recover` (line 1799) first refuses unless `state == "failed"` and `failureCode == "waiting_for_idle_failed"`, then calls `validate_failed_recovery` (lines 1834–1835), which enforces the full triple.
   - Any other pre-activation failure—such as `preflight_failed` or `staging_failed` (e.g., an npm registry timeout during `npm ci`)—where no service was stopped and the previous release never changed, permanently deadlocks the UI with no recovery action.
3. **Hardcoded `/usr/bin/ssh` in `automatic_updates_recover`:**
   - Line 1829 of `server_auto_update.rs` calls `run("/usr/bin/ssh", &args, ...)` instead of `setup.ssh_program()`, breaking custom SSH paths and test fixtures.
4. **All-or-nothing global enrollment UX:**
   - `AutomaticUpdates.tsx` and `automatic-updates.ts` (`enable()`, lines 140–145) force enrolling *every* saved non-retired server in one batch. `enable()` rejects unless `JSON.stringify(environmentIds) !== JSON.stringify([...reviewedIds].sort())` is false, triggering sequential sudo password prompts for every server. Users cannot opt in just one server (e.g., a staging server first).

## Exact Solution

1. **Isolate per-server failure states in `should_launch()`:**
   - Change `should_launch()` in `server_auto_update.rs` to check only the *target* server's own state (`server.state == Phase::Checked`) and `journal.active_environment_id.is_none()` (preserving serialized execution one server at a time) without letting another server's terminal `Failed`/`Blocked`/`RolledBack` state block unrelated healthy servers.
   - Keep a global pause only when `active_environment_id` is actively held or `Unknown`/`Enrolling`.
2. **Allow verified pre-activation recovery for all pre-activation failure stages:**
   - In `inspect_failed_update.py` and `validate_failed_recovery()`, allow `failureStage` in `{'preflight', 'staging', 'waiting_for_idle'}` whenever `state == 'failed'`, the systemd unit is `inactive`/`failed`, the coordinator maintenance hold is confirmed `cancelled` (or never created for `preflight`), and `/opt/outpost-native/current` + `/etc/outpost-native/installation.json` still point to `expectedRelease`.
   - Continue to refuse automated recovery for `activating`, `health_verification`, `committing`, `releasing_dispatch`, `unknown`, or `needs_attention`.
3. **Use `setup.ssh_program()` consistently:**
   - Replace `"/usr/bin/ssh"` at `server_auto_update.rs:1829` with `setup.ssh_program()`.
4. **Support per-server opt-in toggles in `AutomaticUpdates.tsx`:**
   - Allow enabling/disabling automatic updates per saved server (checkboxes in the enrollment dialog pre-selected for connected servers, or per-server toggle rows), passing the selected `environmentIds` subset to `automatic_updates_enable`.

## Verification & Acceptance Criteria

- [ ] `python3 -m unittest discover -s deploy/environment -p 'test_inspect_failed_update.py'` passes for `preflight`, `staging`, and `waiting_for_idle` failures and continues to reject `activating` / `unknown` / `needs_attention`.
- [ ] `cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features update` passes with new tests verifying:
  - Server B proceeds to update even when Server A is in `Phase::Failed` or `Phase::Blocked`.
  - `automatic_updates_recover` invokes `setup.ssh_program()`.
  - Partial subset enrollment works for a single chosen server without requiring all saved servers.
- [ ] `node --test desktop/test-automatic-updates.ts` passes with updated per-server enrollment cases.
