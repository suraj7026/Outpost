# Strict model access and remote action-contract repair

## Approved policy and scope

The owner approved blocking every unverified model, even when a provider has a saved API key or subscription credential. This applies to the shared Server-2 Pi runtime, model picker, defaults, execution admission and managed CLI. A public catalogue is not account entitlement. Verification failures never authorize static fallback models or another account.

`model-access.ts` installs access policies for every provider, including compatible endpoints. Providers without an approved verifier expose no available chat/image/classifier models and refuse direct generation calls. Explicitly requested unverified models cannot bypass the picker. The managed CLI loads the same policies, fails startup if policy installation fails (rather than allowing Pi to skip a broken extension), and refuses an unavailable saved default instead of silently choosing another account.

**Current verifier coverage:** only `openai` with a ChatGPT OAuth login has an implemented authenticated account verifier. OpenAI API-key authentication, Ollama Cloud, other API keys/subscriptions, and custom compatible endpoints remain blocked pending provider/method-specific verification. This is deliberately restrictive; it does not claim those credentials are invalid or those providers can never be verified. Credentials, configured endpoints and defaults are retained. Historical selections remain blocked until the owner explicitly selects a verified model.

Pi's transport metadata remains separate from authorization. Credential/key changes cannot reuse ChatGPT verification, which is memory-only and expires within 60 seconds. No inference probes are used. Discovery cannot guarantee quota, capacity or successful execution. Browser-Use/reviewer configuration remains independently managed and unchanged.

Synthetic transport/auth tests install in-process fixture verifiers through a trusted constructor dependency. Production startup supplies no such overrides. There is no environment, profile or management-API switch that marks public models verified. This is application policy, not a sandbox against owner-authorized code/root execution.

## Confirmed action regression

The saved session corresponding to the screenshot sent:
- `command.run` with `{command: ...}` instead of required `argv`;
- `browser.run` with `{}` instead of a nonempty `task`;
- `artifact.read_text` with `path` instead of `artifactId`;
- `file.read` with `path: "."`, which is a directory rather than a file.

The remote-worker migration had dropped the old prompt's argument guidance. `Gate.catalogue()` exposed names/effects but no argument schemas, and the coordinator replaced admission errors with generic `coordinator_action_failed`. The ledger confirmed the malformed commands/browser/artifact calls were not dispatched; the file-read action recorded `path_escape`.

The repair publishes JSON schemas derived from the same validators used by the tools, with scope-specific descriptions. The remote prompt includes these schemas, valid examples, the workspace location, and privilege guidance. Admission failures return fixed, safe correction hints, never raw Zod input or exception bodies. Uncertain execution failures still require inspection before retrying. `file.read` now explains directory misuse; traversal/symlink boundaries are unchanged. It does not reinterpret arbitrary command strings or bypass validation/approvals.

Tests exercise the real worker/SDK with a deliberately malformed command, observe actionable feedback in its next request, then execute a corrected action exactly once. Separate fixtures verify successful argv-based listing, file reads, schema parity, denied traversal and sanitized errors. No live task is retried or rewritten to conceal earlier failures.

## Privileges verified

Read-only live checks returned UID **0** and the expected hostname through the configured root executor on **both** `surajhomeserver` and `surajhomeserver2`. The coordinator and Pi worker run as UID **1000**; the worker has no `sudo` binary. `host.execute` is the existing root route through the coordinator's policy/evidence gate. `system.inspect` describes the container, not the physical host's administration capability. No sudoers, pod privileges, mounts, host authorization or approval policy were broadened.

## Rollout

Deployed release: **`access-tools-20261031T054634Z`**, Pi 1.4.0, shared `/home/node/.pi/agent`. Pod `pi-workspace-74f564b676-bdck5` was **3/3 Ready**, zero restarts. Worker and CLI listed the same eight verified ChatGPT models. Ollama's saved credential was present but yielded no selectable models under the new policy.

All **11 task records** and credential bytes were preserved. The idle checkpoint protected **4** review-stage tasks and restored dispatch to its previous enabled state. Private backups: `/home/node/.outpost/backups/access-tools-20261031T054634Z`; Server-1 rollout record: `~/outpost-rollouts/access-tools-20261031T054634Z/`. No historical errors were erased or failed live actions retried.

Checks: **309 passed, 1 skipped** in the working tree (including unrelated untracked diagnostics); **32 provider UI checks each** in Chromium/WebKit; TypeScript/desktop builds; **12 native tests passed, 1 ignored**; worker-mount isolation fixture. No paid inference probes or live fixture tasks were run. Do not restore stale profile/database backups on rollback.
