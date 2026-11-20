# Spec 02: Unify Main and Legacy Server Release Families via Runtime Feature Flag

- **Priority:** P0
- **Area:** Server Updates / Packaging
- **Affected Files:**
  - `scripts/package-pi-update.mjs`
  - `scripts/package-host-release.mjs`
  - `scripts/test-pi-update.mjs`
  - `scripts/fixtures/outpost1-pi140-source.tar.gz`
  - `deploy/pi-update/` (`README.md`, `package.json`, `package-lock.json`)
  - `deploy/environment/release-policy.json`
  - `server/main.ts`
  - `server/gateway/coordinator.ts`
  - `server/browser/`
  - `desktop/src-tauri/src/server_update.rs`

## Exact Problem

Outpost currently maintains two completely separate server release pipelines:
1. `scripts/package-host-release.mjs` (sequence 8, main source tree with Camoufox).
2. `scripts/package-pi-update.mjs` (sequence 7, legacy-compatible family for Outpost 1), which extracts a frozen 202-file historical archive (`scripts/fixtures/outpost1-pi140-source.tar.gz`), overwrites **38 hardcoded overlay files**, copies a separate `deploy/pi-update/package.json` and `package-lock.json`, and mutates `server/gateway/coordinator.ts` and `server/main.ts` using **20+ brittle string-anchor insertions and replacements**.

## Root Cause & Impact

The dual pipeline exists solely to avoid forcing a Camoufox browser dependency migration on Outpost 1 while still shipping coordinator features (automations, workspace file review, full-control policy). However:
- Every coordinator change must be manually backported as an exact string-anchor patch into `scripts/package-pi-update.mjs`.
- Policy and API drift has already occurred (e.g., `deploy/pi-update/README.md` describes full-control-only normalization while `server/policy/` in main supports both `full_control` and `auto`; `recovery.inspect` / `recovery.investigate` are absent in the legacy baseline).
- Testing, signing, and qualification effort is permanently doubled.

## Exact Solution

1. **Introduce an explicit runtime browser engine flag (`OUTPOST_BROWSER_ENGINE`):**
   - In `server/main.ts` and `server/browser/`, support `OUTPOST_BROWSER_ENGINE=chromium|camoufox` (defaulting to `chromium` when `OUTPOST_CAMOUFOX_PYTHON` is unset, or `camoufox` when configured).
   - Make `playwright-camoufox` / Camoufox Python launcher loading lazy (dynamic `import()` / conditional spawn only when `OUTPOST_BROWSER_ENGINE=camoufox`), so servers without Camoufox OS dependencies start and pass `qualify-runtime.ts` cleanly using Playwright Chromium.
2. **Split `runtime-pins.json` into core vs. optional browser pins:**
   - Separate Node runtime pins (`nodeVersion`, `nodeSha256`) from optional Camoufox pins (`camoufoxVersion`, `camoufoxSha256`, `uvVersion`).
   - Only enforce Camoufox pin matching on hosts where `OUTPOST_BROWSER_ENGINE=camoufox` is enabled in `coordinator.env`.
3. **Retire `scripts/package-pi-update.mjs` and `deploy/pi-update/`:**
   - Once a single unified release (e.g., sequence 9) is verified against both a Chromium-only host (Outpost 1) and a Camoufox host (Outpost 2), remove `legacySequence` from `deploy/environment/release-policy.json`, archive/remove `deploy/pi-update/`, `scripts/package-pi-update.mjs`, and `scripts/fixtures/outpost1-pi140-source.tar.gz`.
   - Simplify `desktop/src-tauri/src/server_update.rs` and `scripts/sign-releases.mjs` to handle a single `host-release` artifact family.

## Verification & Acceptance Criteria

- [ ] Starting the unified server with `OUTPOST_BROWSER_ENABLED=true` and `OUTPOST_BROWSER_ENGINE=chromium` (without Camoufox or `uv` installed) passes `server/environment/qualify-runtime.ts` and `npm run check`.
- [ ] Starting the unified server with `OUTPOST_BROWSER_ENABLED=true` and `OUTPOST_BROWSER_ENGINE=camoufox` preserves existing Camoufox behavior.
- [ ] `scripts/package-host-release.mjs` produces a single signed release that passes preflight and qualification against both Outpost 1's Chromium env and Outpost 2's Camoufox env.
- [ ] `scripts/package-pi-update.mjs` and `deploy/pi-update/` are removed with zero remaining references in `desktop/build-mac.sh` or `scripts/sign-releases.mjs`.
