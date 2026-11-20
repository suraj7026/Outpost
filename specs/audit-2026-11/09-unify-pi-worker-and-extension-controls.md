# Spec 09: Unify `PiRuntime` vs. `RemotePiRuntime` & Add Per-Environment Extension Controls

- **Priority:** P2
- **Area:** Server Runtime & Extension Governance
- **Affected Files:**
  - `server/gateway/coordinator.ts`
  - `server/main.ts`
  - `server/pi-adapter/runtime.ts`
  - `server/pi-adapter/remote-runtime.ts`
  - `server/pi-management/bundled-extensions.ts`
  - `server/pi-management/child-provider-bootstrap.ts`
  - `server/pi-management/session-extensions.ts`
  - `server/tasks/tasks.ts`
  - `desktop/src/RuntimeSettings.tsx`

## Exact Problem

1. **Dual Pi execution paths (`PiRuntime` vs. `RemotePiRuntime`) create parity bugs:**
   - `server/gateway/coordinator.ts` declares the `gates` and `runtimes` maps around line 51. `runPi()` (lines 277–291) branches on `this.options.worker`: `RemotePiRuntime` when a worker client is configured (lines 280–284), otherwise in-process `PiRuntime` (lines 285–290). `server/main.ts` builds that client only when `OUTPOST_PI_WORKER_URL` is set (lines 17–18).
   - Maintaining both paths requires duplicate credential-passing machinery (the direct adapter needs a private session-scoped socket in `child-provider-bootstrap.ts` to pass parent model credentials to child extensions). A provider-qualified `modelRef` still throws `pi_worker_required` when no worker is configured: `task.create` (line 134), and nearby `recovery.investigate` (line 131) and `task.steer` (line 136).
2. **Bundled extensions are enabled unconditionally with full worker permissions:**
   - `server/pi-management/bundled-extensions.ts` sets both `pi-ollama-cloud` and `pi-subagents` to `enabled`. `RuntimeSettings.tsx` displays that reported state and has no per-extension toggle. There is no `runtime.set_extension_enabled` action. In Full Control those extensions execute with the worker’s filesystem/network/process privileges outside `outpost_action`.
3. **New tasks and scheduled automations default to `full_control`:**
   - `desktop/src/App.tsx` initial mode is `useState<Mode>('full_control')` at line 90. `server/tasks/tasks.ts` `NewTask.mode` defaults to `full_control`. `server/scheduler/tools.ts` also describes the saved task mode as default `full_control`. That maximizes blast radius for unattended or exploratory tasks.

## Exact Solution

1. **Standardize on `pi-worker` everywhere (including local dev):**
   - Update `npm start` / `server/main.ts` so local development automatically spawns a loopback `pi-worker` child process (with an ephemeral per-run bearer token) if `OUTPOST_PI_WORKER_URL` is not explicitly provided.
   - Deprecate and remove the direct in-process `PiRuntime` branch and `child-provider-bootstrap.ts` once all tests run through `RemotePiRuntime`.
2. **Add per-environment extension enable/disable toggles:**
   - Persist an `extensions.enabled` map (e.g., `{ "pi-subagents": true, "pi-ollama-cloud": true }`) in the server ledger (`runtime_config` record) and read it in `server/pi-management/session-extensions.ts` before loading extensions into a Pi session.
   - Expose a `runtime.set_extension_enabled` management action and wire toggle switches into the **Extensions & browser tools** section of `desktop/src/RuntimeSettings.tsx`.
3. **Make default task mode configurable and default scheduled automations to `auto`:**
   - Allow setting a per-server default task mode (defaulting new unattended automations to `auto`, with explicit opt-in to `full_control`).

## Verification & Acceptance Criteria

- [ ] `npm start` starts both coordinator and a local loopback `pi-worker`, and `runtime.piManagement` is `true` out of the box.
- [ ] Disabling `pi-subagents` via `RuntimeSettings.tsx` prevents `session-extensions.ts` from loading `pi-subagents` on the next task run without requiring a server update or restart.
- [ ] `npm run check` and `npm --prefix desktop run build` pass.
