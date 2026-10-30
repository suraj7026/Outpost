# Server-side Pi providers and model selection

Status: owner approved the design, implementation and deployment. The initial built-in/compatible-provider release is deployed on Server 2 and installed on the Mac; see [deployment verification and remaining scope](SERVER-PI-PROVIDERS-STATUS.md). This document remains the broader target architecture, not a claim that provider-package activation or callback relay is implemented. No real provider-account sign-in or paid inference has occurred.

## Approved outcome

Outpost manages the Pi agent executing on `surajhomeserver2`, not a separate Pi on the Mac. The owner can add a provider through its Pi-supported API-key/OAuth flow, configure a compatible endpoint, or install a trusted provider extension. Configuration persists on Server 2. Refreshing exposes available models in the composer. Sending a message uses the explicitly selected provider/model in the actual server agent loop.

Provider support is discovered from the installed Pi runtime, not an Outpost-maintained shortlist. The GUI and remote CLI must use the same Pi installation and agent profile. Installed does not mean enabled, configured credentials do not prove upstream entitlement, and advertised models are not necessarily accessible to an account.

## Verified current constraints

- `server/pi-adapter/runtime.ts` creates a `ModelRuntime` with `modelsPath: null`, supplies a custom empty resource loader, registers `outpost-ollama`, and selects that provider explicitly. Changing another Pi profile cannot change these runs.
- `server/gateway/coordinator.ts` places agent state under `.outpost/pi/<task-id>` and workspaces under `.outpost/workspaces/<task-id>`. Task routing currently stores a model string, not a provider/model pair.
- `deploy/workspace/Dockerfile` points the workspace CLI at `/opt/workspace/node_modules/.bin/pi`. The coordinator imports its separate dependency from `/home/node/outpost-runtime/node_modules`. Sharing a home volume does not unify those installations.
- `desktop/src/useConnection.ts` filters the catalogue to Ollama cloud tags. The follow-up composer in `TaskView.tsx` renders a read-only model label.
- `registerBrowserUse` currently receives the task's model through the Ollama-specific inference configuration. `supportsThinking` is also Ollama-specific. Neither can be reused blindly for another provider.
- The coordinator owns the ledger and host-executor token. Loading arbitrary extensions inside that process is not an acceptable shortcut.
- Pi 1.4.0 exposes `ModelRuntime.getProviders`, `getAvailable`, `login`, `logout`, `refresh`, file-backed `AuthStorage`, and typed `AuthInteraction` prompts/events. Its credential store has **one stored credential per provider ID**, not arbitrary simultaneous accounts per provider.

## Scope

Included in this implementation:

1. One managed server Pi installation/profile consumed by the agent and workspace CLI.
2. Runtime-discovered provider/authentication metadata, shared credential storage, compatible-endpoint configuration, and explicit model refresh.
3. A generic login interaction bridge covering Pi's typed API-key and OAuth interactions.
4. Trusted provider-package installation, activation, load diagnostics, and capability refresh outside the coordinator process.
5. Provider-qualified defaults and per-message model selection, including the new-task and follow-up composer pickers.
6. Migration, regression tests, and controlled rollout documentation.

Separate follow-on interfaces: a complete embedded PTY terminal, general-purpose extension/skill/MCP editors, and Pi self-update UI. This work establishes their shared runtime contract, but does not claim those interfaces are built. Normal remote CLI configuration must work without waiting for an embedded terminal.

Image/classifier-only models remain visible as provider capabilities but cannot be selected as the conversational agent model. Arbitrary extension-owned custom terminal components are not automatically translated into React. Unsupported interactions are reported explicitly, never displayed as successful logins.

## Architectural choice

### Alternatives considered

- **Settings UI over today's adapter:** smallest change, but wrong. The agent would continue using forced Ollama routing and a different profile.
- **Load all Pi resources in the coordinator:** easier SDK wiring, but executes packages alongside ledger access and host-executor credentials. Rejected.
- **Managed Pi worker with coordinator-owned execution broker:** recommended. The real Pi session and extensions run in a dedicated non-root worker container on Server 2; the coordinator retains device authentication, task state, approvals, dispatch, and authoritative evidence.

### Process boundaries

The existing Mac client continues sending signed requests and receiving live events through the private connection. No local Mac agent is added.

The coordinator starts task-scoped Pi worker sessions through a versioned, authenticated, bounded protocol. Worker model/tool events feed the existing live-event adapter. The worker's `outpost_action` tool requests actions from the coordinator; it does not receive the host-executor token or access the ledger directly. Approval, dispatch, cancellation, stale-revision checks, and unknown-outcome recovery stay coordinator-owned.

The worker container mounts only its managed runtime, Pi profile, Pi sessions, and required task/project workspaces. It does not mount the coordinator source, ledger, device authority, or executor secrets. A subprocess under the same UID with the entire shared home would not be sufficient isolation; the deployment must actually enforce the narrower mounts/process boundary before enabling provider packages.

Provider/auth/catalogue workers use the same runtime generation and profile as task workers. Their authenticated management operations cannot grant host-administration authority. Provider packages remain trusted code: they can access credentials and files deliberately exposed to their worker. Full-control agent tools can still perform privileged host work through the coordinator; this design does not claim a sandbox against owner-authorized root operations or malicious model output.

## Shared server installation and profile

- Production profile: existing `/home/node/.pi/agent`, selected explicitly with `PI_CODING_AGENT_DIR`. Tests use temporary profiles and cannot discover the developer's own Pi configuration.
- Standard Pi files remain authoritative: `auth.json`, `models.json`, `settings.json`, package declarations and resource paths. No separate Outpost-only copy of provider credentials.
- Managed Pi versions live in persistent versioned release directories, with one selected release used by both the CLI launcher and workers. Workers capture their release/profile generation at start; changing a launcher cannot replace code inside a running process.
- Show actual Pi version, profile path, generation and reload-required state. An installed CLI/worker version mismatch is a blocking diagnostic, not a successful update.
- Use Pi's file-backed credential locking and OAuth refresh semantics. Configuration writes preserve unrelated keys, use locking/atomic replacement, and detect concurrent CLI edits rather than overwriting them.
- Provider additions and completed authentication refresh discovery for subsequent runs. Package changes activate only at an idle boundary. Active workers use an immutable runtime/resource generation; direct CLI edits update the canonical profile and become pending discovery/activation rather than replacing live package files. Shared credential refresh remains separately serialized through Pi's credential store. Existing responses are not restarted to apply settings.
- Existing project trust decisions remain explicit. Opening a task directory must not silently trust its extensions or package declarations.

## Provider service and public data

All provider capabilities come from the active Pi generation:

- provider ID/name and origin: built-in, compatible configuration, or trusted extension;
- supported authentication methods from `Provider.auth`, including method labels and subscription metadata;
- stored-credential presence and source metadata without resolving/exporting secret values;
- chat/image/classifier model capabilities, last refresh state, and sanitized diagnostics.

Use `ModelRuntime.getAvailable` and provider-owned filtering, not a suffix filter applied to every provider. Label availability accurately: configured authentication is not an account-entitlement or successful-inference guarantee. Distinguish configured, sign-in required, refresh failed, and explicitly verified connection state. An optional connection test is a separate owner action and can incur provider usage.

The API uses structured model references:

```ts
type ModelRef = { providerId: string; modelId: string };
```

Never infer the provider by splitting an ID on `/` or `:`. Preserve exact upstream IDs. Expose catalogue generation and freshness so stale selections cannot silently route elsewhere. A failed refresh never falls back to another provider, account, or local model.

One credential per provider is supported initially, matching Pi. Switching between API-key and subscription authentication for the same provider warns that the stored method will be replaced. The UI does not invent an unsupported multi-account abstraction.

## Authentication and secret transport

Use Pi's `ModelRuntime.login(providerId, authType, interaction, options)` and `logout` rather than implementing provider-specific OAuth clients in Outpost.

The server owns each login flow, bound to initiating device, provider, runtime generation, expiry, and an unpredictable flow ID. Bridge all typed interactions:

- prompts: `text`, `secret`, `select`, `manual_code`;
- events: informational text/links, authorization URL, device verification code, and progress;
- cancellation at flow and individual-prompt level.

Each answer includes its current step ID. Reject stale, duplicate/conflicting, expired, cancelled, or wrong-device replies. Allow only one active login mutation per provider. Surface cancellation and interruption explicitly. A coordinator/worker restart does not replay a secret-bearing request or pretend an OAuth flow completed.

The Mac opens only validated HTTP(S) authentication links after an explicit user action. Prefer provider-supported device-code/manual redirect flows for remote login. If a flow requires a localhost callback, use a narrowly scoped callback relay tied to that exact flow, expected loopback port/path/state, and expiry; never expose an arbitrary URL-fetch/proxy endpoint or forward auth to an unrelated origin. Port conflicts and unsupported callback interactions produce actionable errors, not a success screen.

Credentials pass through a dedicated signed management transport, **not** task commands, the ordinary outbox, broad SSE records, transcript messages, or persisted desktop command retries. Responses contain metadata only. Secret answers, authorization codes and token-bearing URLs are not echoed into diagnostic logs. Login state is device-scoped and short-lived; do not broadcast it to other paired devices.

Pi's `auth.json` remains file-backed with restricted directory/file modes. Do not describe this as encrypted storage or macOS Keychain storage. Secrets exist transiently in login/request memory and on the server's protected filesystem. Logout removes the Pi credential; it does not claim to revoke the provider account or clear an independently configured environment credential.

Use authenticated status/receipt reconciliation after a lost response. Do not automatically repeat credential mutations or package installs. Receipts contain operation metadata only; any replay/conflict fingerprint must be a server-keyed HMAC, not a persisted raw payload or unsalted secret hash.

## Compatible providers and provider packages

The compatible-provider form edits the Pi-supported configuration schema: provider ID, explicit endpoint, protocol/API type, model definitions, and supported metadata. Keep literal credentials in `auth.json`, not returned `models.json` projections. Do not invent a universal `/models` discovery route for endpoints without one.

Validate endpoint schemes, embedded credentials, and changes of origin. Private Ollama endpoints are supported by explicit owner configuration; metadata/control-plane destinations are not implicitly authorized. GUI configuration must not introduce shell-command credential expressions. Existing deliberate CLI-managed advanced configuration is evaluated only within the trusted worker boundary and shown with appropriate source/trust metadata.

Package installation is a distinct trusted-code operation. Show the exact npm/Git/local source, version/ref and affected profile; require explicit trust confirmation. Resolve and validate a staged generation, preserve the previous generation, report installation/load errors, and activate only when it is safe. Installation and extension factories never run in the coordinator. Runtime compatibility checks include built-in provider enumeration plus an actual synthetic extension-provided model call. Failed activation retains the previous working generation.

## Model selection and task behavior

- Default provider/model lives in the shared Pi settings. It applies to new tasks, not historical messages.
- New-task and follow-up composers share one searchable picker, grouped by provider, with selected state, available capability metadata and a Manage providers action.
- A composer selection is local pending intent until submitted. Sending records the selected `ModelRef` atomically with the instruction and freezes it in that instruction's queued execution payload.
- A changed-provider follow-up waits for the current agent run to settle before starting the next run with the selected model. It must not become steering input for the old model. Preserve existing same-model steering semantics where applicable.
- Revalidate authentication and model availability immediately before execution. If invalid, surface a blocker without silently choosing another model or resending the conversation elsewhere.
- Persist provider/model provenance on actual runs and assistant messages. Preserve historical provider/model records and Pi session branches.
- The picker explains that changing providers sends conversation context to the selected provider on the next submission. It does not fabricate reasoning controls, prices, quotas, or subscription balances.
- Legacy model-only tasks resolve explicitly to the migrated legacy Ollama provider; older client requests retain their existing routing contract. New API projections are versioned rather than silently changing the old string catalogue shape.

Browser-Use and optional automatic review retain independent provider/model settings. Changing the conversation model must not send an OpenAI ID to `ChatOllama`. Their currently supported integrations remain labeled honestly; extending those engines to every provider is not implied by changing the Pi agent model.

## Migration and deployment

1. Inspect server installation/profile metadata and active-work state without printing credential contents.
2. Back up relevant configuration and deployment definitions privately. Do not delete identity, sessions, history, projects, existing packages, or unrelated workloads.
3. Preserve the existing Ollama origin and exact cloud model identifiers as the legacy provider configuration. Existing tasks do not change providers. If the chosen legacy provider ID conflicts with existing CLI configuration, stop for an explicit resolution; do not overwrite it.
4. Preserve existing shared Pi credentials/settings. Per-task session files remain valid through a validated path mapping or an additive copy with originals retained; do not rewrite conversation histories wholesale.
5. Deploy the constrained worker and matching management protocol, validate health, then enable the client flow. Mixed-version clients receive an explicit unsupported-feature state.
6. A pod/container rollout can interrupt work. It requires an idle checkpoint and explicit rollout approval. Local tests do not authorize signing into accounts, installing real third-party packages, making paid model calls, or restarting active server tasks.
7. Rollback selects the preceding runtime/deployment generation and desktop bundle without erasing newly saved credentials or server history. Non-backward-compatible config changes require restoration from the retained private backup, not an unsafe blind downgrade.

## Completion criteria

The work is complete only when a configured provider is usable by the actual Outpost task loop, not merely listed in Settings. Automated tests must demonstrate built-in authentication interaction mapping, a compatible synthetic endpoint, an extension-provided synthetic provider, shared CLI/profile changes, correct next-message routing, and preserved approval/evidence behavior.

Live qualification is reported separately: actual account sign-in requires the owner, and any paid provider test requires explicit consent. Full embedded-terminal and general extension-management UI remain separate deliverables.

## Design review checklist

- [x] Remote-only scope confirmed by owner.
- [x] Current runtime, deployment paths, SDK APIs, task queue and desktop model handling inspected.
- [x] Alternatives and security boundary documented.
- [x] Credentials, OAuth, package activation, queue ordering, migration and browser-model coupling addressed.
- [x] Design self-review: no placeholder requirements; current behavior distinguished from planned behavior; acceptance and rollout gates explicit.
- [ ] Owner review of this detailed design.
- [ ] Implementation and verification in `SERVER-PI-PROVIDERS-PLAN.md`.
