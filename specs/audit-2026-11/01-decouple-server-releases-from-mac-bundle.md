# Spec 01: Decouple Signed Server Releases from the Mac App Bundle

- **Priority:** P0
- **Area:** Server Updates / Release Pipeline
- **Affected Files:**
  - `desktop/build-mac.sh`
  - `scripts/package-host-release.mjs`
  - `scripts/sign-releases.mjs`
  - `desktop/src-tauri/src/server_update.rs`
  - `desktop/src-tauri/src/server_auto_update.rs`
  - `desktop/src/RuntimeSettings.tsx`
  - `desktop/src/AutomaticUpdates.tsx`
  - `deploy/environment/AUTOMATIC-UPDATES.md`

## Exact Problem

`desktop/build-mac.sh` packages and signs server tarballs directly into `desktop/src-tauri/resources/` (`host-release.tar.gz`, `host-release.json`, `pi-release.tar.gz`, `pi-release.json`) before running `npx tauri build`. The desktop updater (`server_update.rs`, `server_auto_update.rs`) only reads `bundled_artifact()` from the installed `.app` bundle.

As a result:
1. Shipping a single server-side bugfix requires rebuilding, codesigning, and reinstalling the entire Tauri/Rust macOS application.
2. Users must manually rebuild `Outpost.app` to even detect that a newer server release exists ("Check for server updates compares against this app's bundled compatible release").
3. The `.app` bundle is unnecessarily coupled to server release cadence and bloats with multiple server archives.

## Root Cause & Impact

Bundling server artifacts inside the desktop app was a shortcut to avoid operating a release feed. In practice, server releases change far more frequently than the macOS shell, turning routine backend fixes into slow, error-prone full desktop builds and creating version skew between servers and Macs.

## Exact Solution

1. **Create a standalone server release publisher script (`scripts/publish-server-release.mjs`):**
   - Outputs `releases/<releaseId>.tar.gz`, `releases/<releaseId>.json` (signed with the existing Ed25519 publisher key via `scripts/sign-releases.mjs`), and a signed `feed.json` index listing the latest sequence per compatibility family.
   - Support two publication targets via config/CLI flag:
     - A local/LAN/tailnet static directory or HTTP endpoint (`OUTPOST_RELEASE_FEED_URL`).
     - Optional private GitHub Release asset upload.
2. **Teach the desktop app to fetch and verify signed release feeds:**
   - Add a configurable `releaseFeedUrl` setting (defaulting to bundled fallback if offline/unset) in `desktop/src-tauri/src/server_update.rs` and `server_auto_update.rs`.
   - Download `feed.json`, verify its Ed25519 signature against the **enrolled `publisherPublicKey`** before trusting any URL or metadata.
   - Cache verified tarballs under the app data directory (`$APP_DATA/release-cache/<sha256>.tar.gz`), verifying exact SHA-256 and size before staging or submitting to a server.
   - Retain bundled release fallback for air-gapped or first-time local builds, controlled by an explicit flag (`--bundle-server-release`) in `desktop/build-mac.sh` instead of mandatory bundling on every Mac build.
3. **Update Desktop UI copy & controls:**
   - Update `RuntimeSettings.tsx` and `AutomaticUpdates.tsx` to indicate whether a check compared against the signed release feed or a local bundled artifact.
   - Add a feed URL display/override in Server Updates settings.

## Verification & Acceptance Criteria

- [ ] `npm --prefix desktop run desktop:build` succeeds without requiring `host-release.tar.gz` or `pi-release.tar.gz` when `--bundle-server-release` is not passed.
- [ ] `node scripts/publish-server-release.mjs --out /tmp/outpost-feed` produces a signed `feed.json` and signed release tarball whose signature verifies with the existing `dev.outpost.release-signing` public key.
- [ ] A Rust unit test in `server_auto_update_tests.rs` proves that:
  - A valid signed `feed.json` served over loopback HTTP is accepted, downloaded, SHA-256 verified, and selected.
  - A tampered `feed.json`, mismatched publisher key, or tampered tarball SHA-256 fails closed without caching or launching an update.
- [ ] Existing `node --test scripts/test-sign-releases.mjs` and `cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features update` pass.
