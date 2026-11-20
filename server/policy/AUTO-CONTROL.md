# Full Control and Auto — backend contract

## Wire contract

- `Mode` accepts `full_control`, `auto`, and legacy input `ask_permission`. The legacy value normalizes to `auto`; only the first two values are advertised. Omitted task, schedule child, recovery investigation, and worker start modes default to `full_control`.
- The signed `runtime` query includes `controlModes: ['full_control', 'auto']` and `autoPolicyVersion: 1`. Clients must verify both before offering/sending Auto to older servers.
- `recovery.investigate` accepts optional `mode` alongside the existing optional `model` or `modelRef`. It still requires admission through maintenance/recovery/runtime checks.
- `policy.change` retains the policy revision contract. It fails with `mode_change_requires_stopped` while a runtime is starting, executing, waiting for approval, cleaning up, or has unconfirmed native work, or while coordinator tools are executing. Pause first and wait for shutdown. Changing a stopped policy retires unexecuted old actions; it never escalates them.
- `approval.decide` is a signed ordinary command: action ID in `aggregateId`, current action revision in `expectedRevision`, payload `{nonce, actionDigest, decision: 'approve' | 'deny'}`. The digest binds arguments, target, identity, effects, tool version, policy revision, expiration and Auto policy/classification. The nonce and digest are both signed. TTL is five minutes from proposal.
- The decision response is synchronously the updated **action record**, including `id`, `revision`, and authorized/denied state, not an operation receipt. Approve atomically queues `action.dispatch` under a unique approval key. A client must not send a second dispatch command. Command idempotency returns the original response without replaying execution.
- `RunStart.mode` is optional on input and normalized/defaulted by the worker. New worker `run.poll` responses include `settled` and `needsAttention`; these fields are optional in the reader for older workers. An interrupted worker that cannot attest cleanup remains fenced from mode changes/new runs rather than being assumed stopped.

## Enforcement

`auto-policy.ts` certifies actual built-in tool implementations through an internal registry, not names, connector trust declarations, model arguments, descriptions or claimed read effects. All uncertified tools require review. Financial, destructive, security and unclassified actions require exact approval. Claimed risk effects may refine the review category but never grant routine status.

Routine coverage is deliberately narrow: scoped built-in reads; bounded ordinary source/text workspace edits; exact absolute system ls/pwd/id argv with no shell/PATH/script interpretation; browser observe/capture and scroll only. Credential/auth/settings/hooks/config paths require security review. Empty, large or substantially destructive rewrites require review. All automation writes require approval in Auto, including save/resume of Full Control schedules. File hashes and schedule revisions are rechecked at execution.

Approval does not bypass protected `payment.*`, `trust.*` or `owner.*` tools/effects, identity delegation, host opt-in, task stops, device revocation, tool/policy changes, TTL, maintenance or recovery holds. Execution is claimed once before effects. Uncertain results remain unknown and cannot be redispatched.

Direct SDK and remote worker tool promises wait until the approved action finishes. Cancellation and expiration settle those waiters. Auto loads no native extension factories, tools, hooks, prompts, skills or subagents, including when reopening a Full Control session. Provider runtime/catalogue/credential support remains available. Full Control retains installed native extension behavior.

Startup preserves compatible, unexpired Auto pending actions and notices, but retires incompatible requests and pre-restart accepted approval dispatches. Stale queued continuations are not replayed, including for preserved pending requests. Uncertain effects are retained. Interrupted native work is not adopted as an Auto run.

## Explicit legacy overlays / packaging

No npm dependency or lockfile change is required. Ship coordinator and worker changes together.

The current `scripts/package-pi-update.mjs` overlay list additionally needs these production files (relative to the repository root):

- `server/policy/auto-policy.ts` — new module imported by the gate and certified built-ins.
- `server/artifacts/files.ts`
- `server/processes/runner.ts`
- `server/operations/machine.ts`
- `server/browser/direct.ts` where the target supports the direct-browser stack.
- `server/pi-worker/client.ts`
- `server/main.ts` — coordinated shutdown/waiter cleanup.

Keep the existing overlays for `server/core/contracts.ts`, `server/diagnostics/recovery.ts`, `server/policy/{trust,migration}.ts`, `server/tasks/tasks.ts`, `server/scheduler/{tools,scheduler}.ts`, `server/pi-adapter/{runtime,remote-runtime,system-prompt}.ts`, `server/pi-management/session-extensions.ts`, and `server/pi-worker/{contracts,runs}.ts` current. Existing subagent observation/background/provider-bootstrap dependencies remain required for Full Control; this change does not remove them.

**Adding files alone is insufficient for the pinned legacy coordinator.** `patchBaselineCoordinator` currently deletes `approval.decide` and does not install the new capabilities, gate callbacks, recovery selector, runtime settlement fences, shutdown, or single-claim queue behavior. Port those changes from `server/gateway/coordinator.ts` into that patch, or overlay the current coordinator with its complete compatible dependencies. Do not blindly replace a legacy browser coordinator with the current direct-browser implementation without its browser dependencies. If porting the baseline, adapt its old multi-argument `Gate.decide` call to the new `(actionId, expectedRevision, deviceId, payload)` signature.

`session-extensions.ts` now imports `server/core/contracts.ts`; private qualification/staging subsets must include it. The server qualification fixture has been updated accordingly.

Packaging scripts were intentionally not edited or executed for release generation. Update legacy package qualification assertions that still assume Full-Control-only modes or removal of approvals, then qualify the assembled bundle separately before release.
