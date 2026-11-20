# Spec 07: Replace 25ms Approval Busy-Polling, Enforce Automation Authority Ceiling & Harden HTTP Replay/Pairing Gates

- **Priority:** P1
- **Area:** Server Policy, Security & Gateway
- **Affected Files:**
  - `server/policy/trust.ts`
  - `server/scheduler/tools.ts`
  - `server/gateway/http.ts`
  - `server/gateway/coordinator.ts`
  - `README.md`

## Exact Problem

Direct code inspection of `server/policy/trust.ts`, `server/scheduler/tools.ts`, and `server/gateway/http.ts` revealed three concrete runtime and security issues:

1. **25ms busy-polling loop in `Gate.awaitDecisionAndDispatch()`:**
   - In `server/policy/trust.ts`, `propose()` hardcodes `expiresAt: Date.now()+300_000` around line 96. `awaitDecisionAndDispatch` starts around line 138, and `const timer = setInterval(check, 25)` is around line 159. Every waiting approval executes full SQLite reads (`this.db.need`, `this.current(record.data)`) **40 times per second** for up to 5 minutes.
   - That 5-minute expiry is real: if a user steps away for 6 minutes during an Auto-mode prompt, the action expires and forces a replan.
2. **Missing authority ceiling in `automation.save` / `automation.set_paused` (doc vs. code drift):**
   - `README.md` line 72 still says: *"Scheduled task mode defaults to `ask_permission`; the agent cannot save or resume a schedule with greater authority than its current task."*
   - In `server/scheduler/tools.ts` (lines 40–43), `validateTask()` only checks `pi_worker_required`. There is a blank line and no authority-ceiling check. `SaveInput` descriptions say the saved mode defaults to `full_control`. `server/tasks/tasks.ts` `NewTask.mode` defaults to `full_control` (line 7). An auto-mode caller can still save a `full_control` child.
3. **No replay deduplication on non-command HTTP routes + `pair-device` bypasses maintenance hold:**
   - `server/gateway/http.ts` checks `Math.abs(Date.now()-parsed.issuedAt) < 300000` around line 42 for non-pair routes. Commands do have idempotency via `Ledger.accept` (the `commands` table). Agent and browser routes do not; they have no nonce/replay cache inside that 5-minute window.
   - `pair-device` is handled around lines 56–58 and does not check `coordinator.maintenance.holding`. Coordinator agent requests do check maintenance (`server/gateway/coordinator.ts` around line 198); the HTTP `pair-device` branch does not.

## Exact Solution

1. **Make `Gate.awaitDecisionAndDispatch()` event-driven:**
   - Replace the 25ms `setInterval` with an explicit waiter callback map (`Map<string, () => void>`) notified immediately when `decide()`, `retire()`, `stop()`, or `changePolicy()` mutates that action or task, plus a single `setTimeout` scheduled for `record.data.expiresAt - Date.now()` to handle expiration cleanly.
   - Make the approval expiration configurable (e.g., default 30 minutes via `OUTPOST_APPROVAL_TTL_MS`, bounded between 1m and 24h) so human-in-the-loop approvals don't time out after 5 minutes.
2. **Enforce task authority ceiling in `registerAutomationTools()`:**
   - Pass the calling task's current `policy.mode` into `validateTask(schedule, callerMode)` in `server/scheduler/tools.ts`.
   - Refuse (`authority_escalation_denied`) if `callerMode === 'auto'` and `schedule.task.mode === 'full_control'` on either `automation.save` or `automation.set_paused(paused: false)`.
   - Update `README.md` so the documentation accurately reflects the two-mode (`auto` / `full_control`) model and the enforced ceiling.
3. **Harden `pair-device` and non-command replay window in `server/gateway/http.ts`:**
   - Reject `pair-device` while `coordinator.maintenance.holding` is true (`maintenance_in_progress`).
   - Add a bounded in-memory signature/nonce replay cache (TTL = 5 minutes matching the `issuedAt` window, capped at e.g. 10,000 entries) for mutating non-command routes (`pair-device`, `agent`, `browser`).

## Verification & Acceptance Criteria

- [ ] `Gate.awaitDecisionAndDispatch()` wakes immediately on `decide()` with zero polling timers; unit test confirms no interval polling occurs while waiting.
- [ ] Unit test in `server/scheduler/` confirms an `auto`-mode task cannot save or resume a `full_control` automation, while a `full_control` task can save either mode.
- [ ] Unit test in `server/gateway/` confirms replaying the exact signed bytes of a `pair-device` or `browser` request within 5 minutes is rejected, and `pair-device` is refused during maintenance hold.
- [ ] `npm run check` passes.
