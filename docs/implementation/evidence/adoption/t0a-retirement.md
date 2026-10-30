# T0a — legacy Swift Mac retirement

**Accepted scope:** source/build-path retirement only. Integrated locally on 2026-10-30 after independent Astra review; not full T0 or release qualification.

## Changes

Removed the legacy Mac application entry point, build script, Swift executable product/target, XcodeGen/generated Xcode Mac app and UI-test targets, Mac-only bootstrap fallback and Mac native-test path. Retained the iPhone app, shared library/tests/resources/font licences, homelab guide consumers, Tauri Rust/Keychain implementation and Objective-C/AppKit sidebar. No identities, user data or installed applications were deleted.

At the T0a checkpoint, active documentation described Tauri as the only Mac application and identified still-pending T0b management controls. Those controls have since been integrated; see [T0b administration evidence](t0b-administration.md). Historical reports retain their original evidence under explicit supersession notices. Four automated regression tests guard retirement and retained resources.

## Independent review

- Builder: `9ea04e4d-f79e-4439-900b-13e7d4bba680`, source base `33bb7f3ab733da4d5fd1081b3dcf96ebd38c0325`.
- Fresh reviewer: `55544c53-e90c-419a-ad0f-50ebfe92cff8`, verdict **PASS**, no P0/P1/P2 findings.
- Reviewer inspected source and parent-provided complete diff/new test. Its file-search tool reported `spawn Unknown system error -86`; it did not have command-execution tools. Parent supplied independent test reproduction; the reviewer explicitly did not claim to have executed tests.
- Parent preserved newer programme/status updates instead of applying the worker's older status-file diff.

The temporary literal `T0b` documentation assertion was replaced during T0b integration with assertions for Tauri/Recovery Hold documentation and against obsolete gap notices.

## Integrated-branch reproduction

Parent ran these on the integrated `feat/outpost-adoption` working tree, based on `eedfac8c88c38ee07d6761a4a66bdebdeda9830c` plus this retirement change:

| Command | Actual result |
|---|---|
| `npm run check` | TypeScript passed; **44 tests passed**, zero failed/skipped. |
| `npm --prefix desktop run build` | TypeScript/Vite build passed; existing Lucide directive warnings remain. |
| `swift test --package-path clients` | **3 shared projection/catalogue tests passed**. |
| `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml` | **4 passed**, one live signed-client test intentionally ignored. |
| `git diff --check` | Passed. |

Before integration, parent independently repeated the four focused retirement tests and three Swift tests in the builder worktree. Reviewer inspected their logs.

Builder additionally reported an ad-hoc packaged Tauri build, iPhone simulator build-for-testing, XcodeGen repeatability and guide-generation checks. These are builder evidence, not separately repeated integrated native release qualification. No app was launched against a live account; no real identity continuity, accessibility, physical-device or notarized release claim is made.

## Storage incident during parallel work

After T0a review and integrated backend checks, a separate catalogue builder failed with `ENOSPC: no space left on device, write`. Its advertised output artifact was absent. Parent captured its partial source/status at `/tmp/outpost-enospc-checkpoint.vOqJmT` and requested safe checkpoints from running siblings. Source archive SHA-256: `0ae84c966cca4e33b44320b665daf3e4735cc61bb9e1ed792f4a5dc81fe5152e`.

Only the generated `desktop/src-tauri/target` directory in the completed/reviewed T0a worktree was removed (2.3 GB). It was not a symlink, contained no tracked files and belonged to this programme. Source, test logs, retained iPhone data and the main checkout's build caches were preserved. Free space increased from about 1.7 GiB to 4.3 GiB. Heavy native build validation must be serialized; the failed catalogue slice is not accepted and needs same-runner recovery plus review.

Temporary paths are local evidence references, not durable backup guarantees. This document records portable results and the incident without claiming the unfinished slices passed.
