# OpenAI account-model verification

## Policy

For the `openai` provider with a saved ChatGPT OAuth credential, selectable models must be present in the authenticated **GET `https://api.openai.com/v1/models`** response. Discovery uses the current server credential; it does not send a prompt, perform test inference, guess a subscription plan from JWT claims, or substitute an API-billed account.

`subscription-models.ts` parses the account endpoint's `models[].slug` shape, requires `visibility: "list"` and `supported_in_api: true`, and excludes cloud-orchestrator-only and ChatGPT-workspace-executor-only models. Exact IDs are intersected with Pi's supported transport metadata. Pi's built-in/public catalogue supplies capabilities, not permission. Unknown model capabilities are not invented. No subscription model names are hardcoded in production code.

The prior observed eight-model account list is a diagnostic snapshot, not a permanent allowlist. In particular, `gpt-5.4-nano` is not permitted merely because Pi knows it; `gpt-6.1-terra` is not denied merely because an earlier request failed. A model's presence in discovery does not guarantee quota, capacity, or a successful inference request.

## Enforcement and lifecycle

- The desktop's signed provider catalogue contains only verified, supported ChatGPT models. A failure removes those choices and reports that account verification must succeed. Other providers are not substituted.
- Saving a credential already invalidates the management runtime. Every catalogue read checks the current credential, including changes made by the shared CLI. Logout removes availability. Verification from one access token cannot authorize another.
- Verification is memory-only, scoped to the exact access token using a process-local keyed fingerprint, and expires after at most **60 seconds** (or credential expiry). No token, fingerprint, account response, or entitlement cache is written to model storage, receipts, task transcripts, or diagnostics.
- Explicit refresh bypasses freshness. Expired, failed, cancelled, malformed, oversized, duplicate-ID, and unsupported-shape discovery never falls back to the static list. SDK refresh failures invalidate the management runtime's verification.
- Saved-default validation and each worker instruction recheck availability using a fresh runtime before starting inference. A queued/historical unsupported choice fails rather than switching models/providers. This is worker-side execution admission; accepting a task command into the durable queue is not proof of model access.
- A provider stream guard also verifies the exact model before dispatch, covering direct SDK/CLI lookups and subsequent tool-loop requests. An expired check is renewed before another provider request. Selection itself is not changed mid-response.
- The managed CLI loads the same first-party policy alongside the pinned Ollama registration. Online startup verifies the account; `--offline` exposes no unverified ChatGPT choices. Other providers retain their existing offline behavior.
- OpenAI API-key credentials keep their distinct API-billing catalogue behavior. No API-key fallback is introduced for a ChatGPT login. Ollama and Browser-Use settings are unchanged.

Discovery has an eight-second request budget, a two-MiB body limit, a bounded schema, and redirects disabled. Only the fixed HTTPS OpenAI endpoint receives the OAuth bearer token. Upstream failure bodies are not reflected. Pi's own token refresh remains under its credential-store lock; this does not replace the separate signed confirmation required to save a new login.

## Verification

Synthetic tests use temporary profiles and fake credentials. They cover visibility/API/executor restrictions, missing verification, credential replacement, logout, TTL expiry, forced failure, empty/malformed/oversized results, duplicate IDs, rejected and late publications, direct-dispatch refusal, saved-default refusal, real worker refusal, catalogue error state, and separate real CLI online/offline behavior. All inference paths are mocked or refused. The provider UI fixture checks the account-verification error alongside existing stale-catalogue submission blocking.

The CLI fixture pins its mocked `fetch` getter because Pi installs its own HTTP dispatcher during startup. A preload assignment alone does not intercept that later replacement. No real credentials are used in fixtures.

## Deployment

Deployed release: **`openai-models-20261030T210815Z`**, Pi **1.4.0**, shared profile `/home/node/.pi/agent`. Pod `pi-workspace-584c77d68f-qtrth` was **3/3 Ready**, zero restarts at verification. Both the live worker catalogue and managed CLI showed exactly the eight account-approved models, including `gpt-6.1-terra`, and excluded `gpt-5.4-nano`. These were authenticated read-only discovery checks, not inference tests.

All **10 task records** and credential bytes were unchanged. The maintenance checkpoint protected **3** review-stage tasks, completed successfully, and restored dispatch to its previous enabled state. Backups are private under `/home/node/.outpost/backups/openai-models-20261030T210815Z`; Server-1 rollout records are under `~/outpost-rollouts/openai-models-20261030T210815Z/`. The loopback tunnel reconnected after pod replacement and health returned ready.

Checks: backend working tree **307 passed, 1 skipped**; TypeScript and desktop builds; **31 provider UI checks each** in Chromium/WebKit; worker mount/isolation fixture. The working-tree count includes unrelated untracked diagnostics and does not imply they were committed or deployed.

Preserve newer credentials and tasks on rollback; never blindly restore the database or profile.
