# Implementation plan: server Pi providers and composer picker

Design: [SERVER-PI-PROVIDERS.md](SERVER-PI-PROVIDERS.md).

Status: the owner-approved **initial limited release is deployed** on Server 2, with the desktop bundle installed. Shared runtime/profile, restricted worker mounts, credential-save confirmation, restart receipts, additive legacy migration and task-preserving checkpoints are implemented. See [deployment status](SERVER-PI-PROVIDERS-STATUS.md) for evidence and remaining scope. The full package/callback-relay roadmap below is not complete; those capabilities remain disabled. No real provider login or paid inference was performed.

## Execution rules

- Keep the existing working Ollama path until its replacement passes the real SDK synthetic-endpoint test.
- No Git commits/state changes, no unrelated diagnostics/metrics changes, and no deletion of identity, preferences or history.
- Tests use temporary agent profiles, fake credentials and local synthetic endpoints. Never discover the developer's personal Pi resources.
- Do not install arbitrary packages during startup/discovery. Package installation is explicit, staged, and separately authorized.
- Runtime/package reloads cannot interrupt an active response or silently switch its model.
- Do not label a settings-only implementation complete. The final integration proof must exercise the server task loop.

## 1. Contracts and compatibility tests

Proposed new files: `server/pi-management/contracts.ts`, `contracts.test.ts`.

Define versioned, validated contracts for:

- Runtime identity: Pi version, profile identity/path, generation and supported management protocol.
- Provider and auth-method metadata, model references/capabilities and catalogue freshness.
- Device-bound login flow IDs, prompt IDs, typed events, answers, cancellation and expiry.
- Redacted management operation receipts and conflict detection.
- Task-scoped worker run/events/action requests, cancellation, and settled-state acknowledgment.

Keep legacy `query('models')` semantics for existing clients. Add a separate structured management catalogue and a feature-capability query. New clients must show an update-required state against old servers rather than presenting a nonfunctional Add provider button.

Acceptance: schema rejection of unknown fields, unsupported model types, invalid flow transitions, cross-device answers, malformed model refs and unbounded messages. Exact IDs containing `/` and `:` round-trip without parsing into the wrong provider.

## 2. Shared profile and managed runtime lifecycle

Proposed files: `server/pi-management/profile.ts`, `runtime-release.ts`, associated tests, and a managed CLI launcher under `deploy/workspace/`.

- Introduce explicit profile/release configuration; production selects the existing server Pi profile, tests require temporary paths.
- Use Pi `AuthStorage` for credential persistence and locking. Add atomic/configuration-lock helpers for supported non-secret Pi settings/model configuration.
- Select a versioned runtime release through one manifest/launcher. Both the worker and CLI report the same release and profile identity.
- Validate profile-generation changes before publication. Preserve unrelated settings and detect concurrent CLI edits.
- Prepare an additive legacy Ollama configuration migration. Preserve exact endpoint/model IDs and all existing stored credentials. Fail on identity/endpoint conflicts.
- Make session-path mapping explicit so existing tasks retain their Pi history.

Acceptance: GUI/CLI storage interoperability using the same installed SDK, cross-process refresh/write locking, mode checks, interrupted-write recovery, config conflict rejection, legacy migration idempotence, and no personal-profile reads.

## 3. Pi worker and coordinator action broker

Proposed new directory: `server/pi-worker/` with protocol client/service, task runner, auth/catalogue operations and tests. Modify `server/pi-adapter/runtime.ts`, `server/gateway/coordinator.ts`, and deployment manifests.

- Move the actual Pi SDK session into the non-root worker boundary; do not duplicate the agent loop in the Mac or leave an independent CLI-only provider registry.
- Load the managed Pi resource generation and shared model configuration in that worker.
- Bridge `outpost_action` to coordinator-owned proposal/dispatch with task-bound authority, input validation and cancellation. Never forward host-executor credentials to the worker.
- Forward bounded, validated SDK events to the existing live feed. Preserve authoritative action IDs and ledger records; worker-reported success alone cannot mark an action successful.
- Distinguish agent settlement from a single model turn. Preserve abort, same-model steering, session restore, failure reporting and shutdown cleanup.
- Constrain deployment mounts: runtime/profile/session/workspace only in the worker; ledger/coordinator source/executor secrets remain outside it. Enforce this in manifests, not just documentation.
- Keep package activation unavailable when this worker boundary is missing or unhealthy. Do not fall back to in-process coordinator extension loading.

Acceptance: existing synthetic SDK tool roundtrip passes across the worker boundary; action approval/revision/cancel/recovery tests still pass; wrong-task or expired broker capability fails; worker exit is reported as interruption without replay; mounted-path/secret-environment checks pass.

## 4. Provider catalogue and compatible endpoints

Proposed files: `server/pi-management/providers.ts`, `catalogue.ts`, and tests.

- Enumerate providers and auth methods from `ModelRuntime.getProviders()` and `Provider.auth`; use runtime-defined labels rather than a branded provider allowlist.
- List chat models through `getAvailable`, preserving provider filtering and exact IDs. Expose non-chat capability metadata separately.
- Implement explicit bounded `refresh`, with generation checks and sanitized per-provider errors. Preserve last-known catalogue freshness truthfully; never use it to imply a failed account is verified.
- Configure compatible endpoints through the supported Pi configuration schema. Separate secrets from public configuration projections and reject implicit command expressions in GUI-authored fields.
- Support explicit private inference origins without turning discovery/auth callback handling into an arbitrary internal-service proxy.
- Use model metadata for reasoning/vision limits; only the legacy Ollama adapter may use Ollama capability probes.

Acceptance: multiple built-ins enumerate; configured/unconfigured/OAuth/ambient sources are represented honestly; a synthetic compatible provider works; stale refresh completion cannot restore models from a removed account; failures never select a substitute model.

## 5. Auth service and signed desktop transport

Proposed files: `server/pi-management/auth-flows.ts`, `operations.ts`, `http.ts`, tests, and a dedicated Rust management transport module. Integrate routing in `server/gateway/http.ts` and Tauri handlers in `desktop/src-tauri/src/main.rs`.

- Implement Pi `AuthInteraction.prompt/notify` using device-bound, expiring flow state and step-specific answers.
- Support text, secret, select and manual-code prompts, authorization links, device codes, progress, cancellation and prompt cancellation races.
- Call Pi's login/logout APIs, preserving locked refresh semantics and credential replacement rules. Keep a stable server runtime login identity where Pi requests it.
- Add signed ephemeral management requests which bypass normal task-command/outbox/persisted retry payloads.
- Implement status reconciliation after response loss and redact failures before crossing process/client boundaries. Never serialize the `Credential` returned from `login` to the Mac.
- Add an explicitly consented, tightly bound localhost callback relay for providers that require it; prefer the provider's remote-friendly flow when available. The relay accepts only the expected active flow, callback route and state and shuts down on success/cancel/expiry.
- Verify device authority on each management request, including login polling and callback delivery. Expired/revoked devices cannot complete an existing flow.

Acceptance: synthetic API-key and OAuth login, multi-step prompts, callback/manual-code race, cancellation, timeouts, revoked devices, request replay, token refresh concurrency, unknown-result reconciliation and server restart. Scan server/client test artifacts, ledger/outbox records and log captures for fixture secrets; none may leak through normal product handling.

## 6. Trusted provider-package activation

Proposed files: `server/pi-management/packages.ts`, package staging/activation tests, worker discovery fixtures.

- Use the installed Pi package manager contract for npm/Git/local sources. Review its SDK APIs/examples before implementation; do not shell-interpolate a user package string.
- Require explicit source/version/trust approval. Stage installation outside the coordinator, validate package/resource load, then publish an idle-boundary generation.
- Resolve provider registrations through Pi's resource/runtime binding lifecycle rather than parsing TypeScript source or maintaining a separate extension provider list.
- Show installed versus active version, reload requirements and sanitized load failures.
- Preserve the previous working generation on package/install/load failure. Package changes affecting active work wait rather than mutating loaded resources in place.

Acceptance: a local synthetic provider extension appears in management discovery and supplies a model that the actual task worker uses. Failed load, incompatible runtime, duplicate provider identity, cancelled installation and active-run activation are tested. No real third-party package installation is needed for these tests.

## 7. Provider-qualified task routing and provenance

Modify `server/tasks/tasks.ts`, `server/gateway/coordinator.ts`, `server/pi-adapter/live-events.ts`, related tests and versioned client types.

- Add structured provider/model selection to new tasks and follow-up instructions without invalidating old records.
- Freeze the selection in the accepted instruction/outbox payload; do not resolve it later from a mutable task default.
- Queue a changed-model instruction for a new worker run after the current run settles. Do not feed it as steering to the previous model.
- Revalidate the selected model/auth before starting its request. Persist the actually used provider/model on run and assistant-message provenance.
- Add a separate explicit shared-Pi default-setting action, with conflict handling. It must not rewrite running tasks.
- Decouple Browser-Use and review model selection from the Pi chat model. Preserve their existing verified Ollama setup and display their separate configuration.

Acceptance: two synthetic providers receive exactly their selected messages; queued A/B model switches preserve order; provider logout/removal while queued blocks rather than falls back; session restoration and task cancellation work; new chat-provider selection does not send its model ID to Browser-Use's Ollama endpoint; old cloud-model tasks still route correctly.

## 8. Graphite Studio provider management and model picker

Proposed frontend files under `desktop/src/agent/`: provider manager, login dialog, compatible-provider form, package activation form, model picker and management hooks/types. Integrate with `App.tsx`, `ConnectionSettings.tsx`, `TaskView.tsx`, `useConnection.ts` and `models.ts` without reshaping the approved Studio shell.

- Add Agent / Providers management with Add provider, runtime-discovered auth methods, configuration status, refresh, reconnect and sign-out.
- Show Server 2/runtime/profile identity so nobody confuses this with local Mac configuration.
- Render Pi's typed login steps without retaining secrets after submission/close. Show subscription versus API-key methods and credential replacement warnings.
- Add compatible-provider and trusted provider-package flows. Only offer backend-supported operations; render reload/error/unsupported states honestly.
- Replace both the new-task select and follow-up model label with one searchable provider-grouped picker above the composer. Preserve the independent Full control selector.
- Show selected provider/model and supported reasoning controls, with a separate Set default action. No fabricated quota, usage, pricing or capabilities.
- Respect disconnected/revoked/read-only preview and unknown-pending states. Prevent stale login/catalogue completions after endpoint changes.
- Preserve keyboard navigation, focus return, Escape, reduced motion, narrow layouts and independent scrolling.

Acceptance: Chromium and WebKit synthetic UI flows for provider search/auth/custom configuration/extension loading/catalogue refresh/model selection, including keyboard-only use and errors. Existing Studio, sidebar, appearance, scroll, image-viewer, approval and connection-administration suites continue passing.

## 9. Integration, rollout and reporting

- Run backend type checks and synthetic suites, frontend build, browser regressions, Rust transport tests and native bundle verification.
- Produce an end-to-end synthetic proof: Add provider → save server profile → refresh → choose model → send task → observe that provider receiving the real SDK request → preserve tool approvals and evidence.
- Document exact runtime/profile versions, completed tests, unsupported interactions and untested live-provider cases. Do not call synthetic OAuth testing a successful ChatGPT sign-in.
- Request an idle deployment window before server changes. Back up relevant profile/deployment files without printing secrets; preserve current tasks, ledger, sessions and project data.
- Deploy worker/backend first; verify the feature handshake and legacy Ollama behavior before installing the new desktop bundle. Retain and strictly verify the preceding app bundle.
- Let the owner perform live sign-in. A live inference verification is opt-in because it sends context and may consume paid usage.
- Verify the running server reports the intended shared runtime/profile and that a remote CLI change is reflected in Outpost discovery.

## Tracking

- [x] Owner's functional flow and server-only target captured.
- [x] Source/SDK/deployment assessment completed.
- [x] Detailed design and implementation sequence written and self-reviewed.
- [x] Owner approves detailed worker/runtime/auth design and implementation.
- [x] Core contracts, explicit profile, authenticated worker protocol and real SDK/action-broker synthetic roundtrip.
- [x] Built-in provider discovery, compatible endpoints, generic login transport and initial auth tests.
- [x] Provider-qualified instruction routing, composer pickers and initial provider Settings UI.
- [x] Full backend suite, frontend build, Rust transport and Chromium/WebKit UI regressions at the current checkpoint.
- [x] Versioned managed release/CLI, additive Ollama migration, deployment-enforced worker mounts and planned recovery checkpoint tests.
- [x] Fresh signed credential-save confirmation, generation checks, bounded revocation leases and durable metadata-only mutation receipts.
- [x] Owner-approved limited rollout, preserved task/session/credential data, live runtime/mount checks and verified desktop installation.
- [ ] Callback relay and trusted provider-package staging/activation.
- [ ] Full advanced configuration coverage and remaining package/CLI concurrency acceptance tests.
- [ ] Single automated native UI-to-worker proof and owner live provider/inference qualification.
