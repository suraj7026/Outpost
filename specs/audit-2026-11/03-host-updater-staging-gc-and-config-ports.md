# Spec 03: Fix Host Updater Disk Leaks, Hardcoded Ports, Helper Hash Coupling & Swallowed Diagnostics

- **Priority:** P0
- **Area:** Server Updates / Host Execution
- **Affected Files:**
  - `deploy/environment/host_update.py`
  - `deploy/environment/auto_update.py`
  - `deploy/environment/host_install.py`
  - `deploy/environment/test_host_update.py`
  - `deploy/environment/test_auto_update.py`

## Exact Problem

Direct code inspection of `deploy/environment/host_update.py` and `deploy/environment/auto_update.py` revealed four concrete operational bugs:

1. **Zero disk garbage collection (releases & operation scratch dirs):**
   - `Updater.stage()` creates `/opt/outpost-native/releases/<releaseId>` (each containing a full `shutil.copytree` of `node/` + reconstructed `node_modules/` + source) and `/var/lib/outpost-setup/operations/<uuid>/` (containing `release.tar.gz`, `build-home/cache`, `dependency-build`, `dependency-snapshot`, `source`).
   - Neither `host_update.py` nor `auto_update.py` ever deletes temporary staging directories (`build-home`, `dependency-build`, `dependency-snapshot`) after completion or prunes releases older than `current` and `previous`. Over repeated updates, homelab disks will silently fill up and `no_active_update()` scans up to 4096 operation dirs.
2. **Hardcoded loopback ports in health checks:**
   - `host_update.py` hardcodes `http://127.0.0.1:4518/v2/environment`, `http://127.0.0.1:4520/v1`, and `http://127.0.0.1:4519/health` in `verify_host_listener()`, `health()`, and `release_hold()` instead of reading configured ports from `/etc/outpost-native/coordinator.env` and `worker.env`.
3. **Unrelated `host_install.py` edits break automatic updates on all servers:**
   - `auto_update.py` pins `MODULE_NAMES = ('auto_update.py', 'host_install.py', 'host_update.py')` in `sourcesSha256`. Any edit to fresh-installation logic in `host_install.py` changes the hash and causes `verify_current_helper` to block all unattended updates until the user disables automatic updates and re-enters sudo passwords on every server.
4. **Swallowed refusal/failure diagnostics:**
   - `auto_update.py` `main()` catches `Exception` and prints only `{"state":"refused","stage":"Auto-update refused; inspect existing operation if submitted"}` without writing the root cause or failing check to a root-only diagnostic log (e.g., `/var/lib/outpost-setup/auto-update-refusals.log`).

## Exact Solution

1. **Add post-commit cleanup & bounded release retention in `host_update.py`:**
   - Immediately after `self.publish('complete', ...)` (or terminal `failed` / `rolled_back` where `self.operation` is settled), delete `build-home/`, `dependency-build/`, and `dependency-snapshot/` inside `self.operation` while retaining `status.json`, `request.json`, `command.log`, and `launch.log`.
   - Add a `prune_old_releases()` step after successful commit that retains `current` and the immediately previous release (`self.previous`), removing older `host-*` directories under `/opt/outpost-native/releases/` safely under `installation_lock()`.
   - Share the immutable `node/` runtime across releases when `nodeSha256` is unchanged (via read-only `/opt/outpost-native/runtimes/node-<version>/` symlink) instead of `shutil.copytree` per release.
2. **Read service ports from `/etc/outpost-native/*.env`:**
   - Add a small helper `read_env_port(env_file, var_name, default)` in `host_update.py` and use it in `health()`, `verify_host_listener()`, and `release_hold()` (and mirror in `server_auto_update.rs`'s `SERVICE_PROBE`).
3. **Extract shared primitives out of `host_install.py`:**
   - Move `CONFIG`, `DATA`, `PREFIX`, `UNIT_DIRECTORY`, `OPERATIONS`, `atomic_json`, `extract_source`, `NoRedirect`, and `run_as_user` into a tiny, rarely changing `deploy/environment/common.py`.
   - Remove `host_install.py` from `auto_update.py`'s `MODULE_NAMES` (`('auto_update.py', 'host_update.py', 'common.py')`) so installer improvements never force sudo re-enrollment across existing servers.
4. **Log structured refusal diagnostics to root-only storage:**
   - In `auto_update.py`, give `require(condition, reason)` a fixed internal reason code (never echoing untrusted input or secrets) and append timestamped JSON lines `{ts, reason, stage}` to `/var/lib/outpost-setup/refusals.log` (mode `0600`, root-owned, rotated at 1 MiB) while keeping stdout redacted.

## Verification & Acceptance Criteria

- [ ] `python3 -m unittest discover -s deploy/environment -p 'test_host_update.py'` passes with new tests asserting:
  - Scratch directories (`build-home`, `dependency-build`, `dependency-snapshot`) are deleted after a completed update.
  - Releases older than `current` and `previous` are pruned safely while `current` and `previous` remain intact.
  - Non-default ports configured in `coordinator.env` / `worker.env` are respected by `health()` and `release_hold()`.
- [ ] `python3 -m unittest discover -s deploy/environment -p 'test_auto_update.py'` passes with new tests asserting:
  - Editing `host_install.py` does not change `sourcesSha256` or block `auto_update.py`.
  - A refused invocation writes a fixed non-secret reason code to `refusals.log` with mode `0600`.
