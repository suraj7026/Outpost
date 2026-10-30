# T0b — essential Tauri administration controls

**Accepted scope:** additional-device enrollment, trusted-device revocation and Recovery Hold controls, integrated after independent Astra source review. This is not full T0b (qualified Auto remains pending), full-ticket acceptance, or release qualification.

## Implementation

- Connection settings now include trusted device records, enrollment and Recovery Hold. Offline, revoked, unconfirmed signer, pending-command and recorded/non-native preview states disable administration.
- Enrollment calls the authenticated `/v1/pair-device` route. Rust validates target inputs, signs with the existing Keychain identity, keeps the target distinct from the signer and refuses unknown pending commands. Uncertain enrollment is never automatically retried; the owner must refresh and verify ID/key.
- Revocation requires confirmation of the displayed revision and warns before self-revocation. Recovery acknowledgment is bound to the held revision. Conflicts require refreshed review, not automatic resubmission.
- Revocation/recovery use the existing encrypted pending-command transport. Failed snapshot refresh marks authority disconnected. No identity, server state or user data was removed.
- Active setup/recovery documentation now describes these controls instead of the T0a-era desktop gap. The retirement test no longer requires the obsolete literal `T0b` warning.

## Review and integrated evidence

Builder: `748c5104-3750-4a14-ac39-0445df0d9adb`, base `eedfac8c88c38ee07d6761a4a66bdebdeda9830c`. Fresh reviewer: `af570970-7bb8-4fc5-a4a0-22d4114cdea2`, **PASS**, no actionable findings, bounded slice only. Reviewer inspected source and test assertions; its read-only profile could not execute tests. Parent independently executed the following on the adoption branch after integrating the eight reviewed source/test files over `2611ed5` and updating docs/retirement assertions:

| Command | Actual result |
|---|---|
| `npm run check` | TypeScript passed; **44 backend/retirement tests passed**, none failed/skipped. |
| `npm --prefix desktop run build` | TypeScript/Vite passed; existing Lucide module-directive warnings remain. |
| `node desktop/test-connection-administration.mjs` | Passed synthetic IPC browser scenarios: enrollment arguments, confirmation/cancel, stale revision re-review, refreshed authority invalidation, recovery acknowledgment, pending uncertainty, offline/revoked and read-only preview refusal. |
| `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml` | **7 passed, 1 live test intentionally ignored**. Loopback transport fixtures verify actual signed request bytes, signer/target distinction, expected revisions and uncertain pending state. |
| `git diff --check` | Passed. |

Local raw logs: `/tmp/outpost-desktop-integrated-backend.d8cqI1`, `/tmp/outpost-desktop-integrated-frontend.WL9lY0`, `/tmp/outpost-desktop-integrated-rust.rnNn18`. Temporary paths are not durable backup guarantees; portable results are recorded above. No live account, provider, Keychain identity or remote server was accessed by these tests.

## Remaining gates

The browser test uses Chromium and synthetic Tauri IPC, not WKWebView/native accessibility. Transport fixtures use an ephemeral fixed test identity, not Keychain. Pending-state tests do not establish encrypted-file restart recovery. Real-Mac keyboard/VoiceOver, focus/visual qualification, identity continuity, cross-device revoke/conflict, lost enrollment response reconciliation, restored-server Recovery Hold and PostgreSQL-backed integration still need qualification. Signed/notarized distribution and deployment remain separately gated.

The existing full-control new-task default remains unchanged in this slice; the approved qualified-Auto/Ask change remains required in core integration. Scheduling and memory editing are not delivered here.
