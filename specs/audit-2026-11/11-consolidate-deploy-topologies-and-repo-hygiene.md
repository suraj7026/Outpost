# Spec 11: Consolidate Deployment Topologies, Replace One-Off Repair Scripts & Clean Up Repo Hygiene

- **Priority:** P2
- **Area:** Repository Hygiene & Developer Workflow
- **Affected Files:**
  - `.gitignore`
  - `deploy/` (`agent/`, `environment/`, `homelab/`, `pi-update/`, `workspace/`)
  - `scripts/` (30 `*outpost2*` files)
  - `desktop/src/` (129 files; 90 still at the top level)
  - `desktop/` (54 root `test-*.mjs`/`.ts` files, `desktop/dist/`)
  - `clients/.build/`
  - `outpost-plan.md` (240,781 bytes)
  - `server/` (33 subdirectories; SQLite ledger in `main.ts`, `pg` used by the Postgres repository)

## Exact Problem

1. **Build artifacts, bytecode caches, and large files sit in the workspace:**
   - Root `.gitignore` already ignores `__pycache__/` and `*.py[cod]`. It does not list `desktop/dist/`. `desktop/.gitignore` already ignores `dist/`, so `desktop/dist/` is untracked, but the directory is still on disk at about 6.3 MB (6,335,535 bytes).
   - `deploy/environment/` still has 24 `.pyc` files on disk, under `__pycache__/`, for Python 3.12 and 3.13. Root `.gitignore` and `deploy/environment/.gitignore` already ignore them.
   - `clients/.build/` exists (empty `index-build` directories) after the Swift client was retired. Root `.gitignore` already matches it via `.build/`.
   - Tracked `outpost-plan.md` is 240,781 bytes. Tracked `deploy/homelab/cluster-guide.html` is 337,951 bytes.
2. **Five overlapping `deploy/` trees + deploy-time monkey patching:**
   - `deploy/` holds `agent/`, `environment/`, `homelab/`, `pi-update/`, and `workspace/`. Five trees.
   - `deploy/agent/` contains `provider-worker-patch.mjs` and `coordinator-patch.json`, patching runtime code at deploy time instead of using config flags.
3. **Proliferation of host-specific `outpost2_*` repair scripts in `scripts/`:**
   - `scripts/` has 30 `*outpost2*` files (`continue-outpost2-setup.py`, `verify_outpost2_python.py`, `verify_outpost2_node.py`, `normalize_outpost2_runtime.py`, `repair-outpost2-browser.py`, `remove-outpost2-node-cache.py`, `remove-outpost2-stale-uv-lock.py`, and their tests). `scripts/fixtures/outpost2-original-release.tar.gz` is a further name match, not one of those 30 files.
4. **`desktop/src/` is 129 files, 90 of them still at the top level, and desktop tests are unwired:**
   - This is not a flat 98-file directory. Subdirectories exist: `subagents`, `anchor-menu`, `workspace`, `image-viewer`, `agent`, `environment`, `assets`, `server-terminal`. 90 files remain at the top level, including 29 CSS files (`settings-pages.css`, `settings-refinement.css`, `composer.css`, `composer-refinement.css`, `page-consistency.css`, and the rest).
   - `desktop/` has 55 `test-*` names at its root: 54 `test-*.mjs`/`.ts` files plus the `test-fixtures/` directory. `desktop/package.json` scripts are `dev`, `build`, `preview`, `tauri`, and `desktop:build`. There is no `test` script, so those files are not run by `npm --prefix desktop test`.
5. **Silent startup error swallowing in `desktop/src-tauri/src/main.rs`:**
   - Line 34: `let _ = setup.restore_bindings(&registry);` silently discards route-restoration errors on startup.
6. **Unclear boundary between the live SQLite server and the Postgres repository:**
   - `server/` has 33 subdirectories, many not wired into `server/main.ts`.
   - `package.json` depends on `pg` 8.23.1. `server/storage/postgres.ts` imports `pg` and is the Postgres repository. `server/capabilities/skills-postgres.ts` is the Postgres skill registry on that repository interface; it does not import `pg` itself. `server/main.ts` does not import `pg`. It opens `ledger.sqlite` through `node:sqlite` WAL. `pg` is not an unused dependency line, and the running server is not on Postgres.

## Exact Solution

1. **Remove on-disk artifacts that ignore rules already cover, and untrack the large tracked files:**
   - Root `.gitignore` already ignores `__pycache__/` and `*.py[cod]`, and `deploy/environment/.gitignore` does too. Delete the 24 on-disk `.pyc` files. Do not add another bytecode rule.
   - Root `.gitignore` does not list `desktop/dist/`, and `desktop/.gitignore` already ignores `dist/`. Delete the on-disk tree (about 6.3 MB). Do not treat it as a tracked path.
   - `clients/.build/` already matches `.build/`. Remove the leftover empty directory. Do not ignore all of `clients/` for a directory that contains only that build tree.
   - Move tracked `outpost-plan.md` (240,781 bytes) to `docs/archive/outpost-plan.md`. Untrack `deploy/homelab/cluster-guide.html` (337,951 bytes) with `git rm --cached` and ignore that generated file.
2. **Consolidate `deploy/` and replace `outpost2_*` scripts with `doctor`:**
   - Declare `deploy/environment/` as the single canonical native deployment path; move retired `deploy/homelab/` and `deploy/workspace/` to `deploy/archive/` (or delete if unused).
   - Fold `deploy/agent/provider-worker-patch.mjs` and `coordinator-patch.json` into first-class server config options.
   - Replace the 30 `scripts/*outpost2*` files with one generic, idempotent `deploy/environment/doctor.py` (`--check` / `--fix`) that validates Node, Python/uv locks, browser cache, systemd units, and file permissions for *any* host. Leave `scripts/fixtures/outpost2-original-release.tar.gz` out of that replacement unless the fixture is retired with them.
3. **Organize `desktop/` by feature and add a unified test runner:**
   - Group `desktop/src/` into `features/{tasks,updates,environments,settings,browser,automations,memory}` and `shared/{ui,api,styles}`.
   - Move `desktop/test-*.{mjs,ts}` into `desktop/tests/` and add `"test"` and `"check"` scripts to `desktop/package.json`.
   - Log or surface `setup.restore_bindings(&registry)` failures in `desktop/src-tauri/src/main.rs` (line 34) instead of `let _ = ...`.
4. **Separate the live SQLite server from the Postgres repository:**
   - Move unwired domain libraries out of `server/` into `server/experimental/` (or document an explicit package export boundary).
   - Keep `server/main.ts` on the SQLite ledger. `pg` 8.23.1 is imported by `server/storage/postgres.ts`; `server/capabilities/skills-postgres.ts` is the skill registry on that repository and does not import `pg` itself. Drop that Postgres path only as an explicit decision to retire it, not because the dependency looks unused, and do not move the running server onto Postgres as a hygiene step.

## Verification & Acceptance Criteria

- [ ] `git status` is clean after `npm run check`, `npm --prefix desktop run build`, and Python unit tests (zero untracked `__pycache__` or `dist/` diffs).
- [ ] `npm --prefix desktop test` runs the desktop unit/integration suite from a single command.
- [ ] `python3 deploy/environment/doctor.py --check` passes on a clean host fixture and detects stale `uv` locks, wrong permissions, or broken symlinks.
- [ ] `npm run check`, `npm --prefix desktop run build`, and `cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features` all pass.
