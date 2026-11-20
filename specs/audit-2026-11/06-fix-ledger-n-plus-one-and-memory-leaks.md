# Spec 06: Fix SQLite Ledger N+1 Queries, Unbounded Growth, Coordinator Map Leaks & Swallowed Errors

- **Priority:** P1
- **Area:** Server Core & Persistence
- **Affected Files:**
  - `server/core/ledger.ts`
  - `server/core/ledger.test.ts`
  - `server/gateway/coordinator.ts`
  - `server/main.ts`

## Exact Problem

Direct inspection of `server/core/ledger.ts`, `server/gateway/coordinator.ts`, and `server/main.ts` revealed four backend scalability and observability bugs:

1. **N+1 SQLite query inside `Ledger.list()`:**
   - `server/core/ledger.ts` (lines 41–42):
     ```ts
     list<T = Data>(kind: string): RecordValue<T>[] {
       return this.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY updated_at DESC,id').all(kind).map(row => this.need<T>(kind, String(row.id)));
     }
     ```
   - Every `list(kind)` executes `1 + N` SQLite queries. The schema at lines 13–20 has no `records(kind, updated_at)` index. `snapshot()` (lines 75–77) still flatMaps `list()` per kind. `server/gateway/coordinator.ts` `publicKinds` (line 41) is exactly 21 kinds: `task`, `policy`, `message`, `action`, `artifact`, `inbox`, `automation`, `memory`, `identity`, `capability`, `browser`, `browser_control`, `workflow`, `source`, `citation`, `deployment_evidence`, `operation`, `device`, `recovery`, `tool_stream`, `subagent_run`. Connect and live-stream snapshots pass that array to `db.snapshot()`, and `Gate.stop()`, `Gate.resumeAfterReview()`, and `Coordinator` startup call `db.list()` repeatedly.
2. **Unbounded growth in `events`, `commands`, and `outbox` tables:**
   - The same schema (lines 13–20) creates `commands`, `outbox`, and `events`, and nothing deletes aged rows. `ledger.ts` never prunes completed `outbox` rows (`state='done'`), aged `commands` idempotency rows, or ancient `events` beyond a retention window. Combined with `snapshot()` returning all 21 kinds in one JSON payload, response size and SQLite size grow monotonically forever.
3. **Unbounded memory leaks in `Coordinator.gates` and `Coordinator.runtimes`:**
   - `server/gateway/coordinator.ts` (line 51) declares `this.gates` and `this.runtimes` (`private gates = new Map<string,Gate>()` and `private runtimes = new Map<string,PiRuntime | RemotePiRuntime>()`). There is no `gates.delete` or `runtimes.delete` in that file, so entries stay after a task completes, fails, or is cancelled.
4. **Swallowed background loop errors in `server/main.ts`:**
   - Lines 47 and 52:
     ```ts
     void coordinator.maintenance.advance().catch(() => console.error('Maintenance hold needs reconciliation'));
     ...
     }).catch(() => console.error('Background work needs inspection')).finally(() => { draining = false; });
     ```
   - Both handlers discard the thrown error. The messages are still `Maintenance hold needs reconciliation` and `Background work needs inspection`, leaving `journalctl` with zero error code, message, or stack trace when maintenance or task draining fails.

## Exact Solution

1. **Eliminate N+1 queries in `Ledger.list()`:**
   - Rewrite `Ledger.list()` to fetch all columns in a single query:
     ```ts
     list<T = Data>(kind: string): RecordValue<T>[] {
       return this.db.prepare('SELECT id, revision, data, updated_at FROM records WHERE kind=? ORDER BY updated_at DESC, id')
         .all(kind)
         .map(row => ({ kind, id: String(row.id), revision: Number(row.revision), data: JSON.parse(String(row.data)) as T, updatedAt: String(row.updated_at) }));
     }
     ```
   - Add a `records_kind_updated` index on `records(kind, updated_at DESC, id)`.
2. **Add periodic ledger maintenance / retention:**
   - Add a `Ledger.compact({ retainDoneOutboxMs, retainEventsCount })` method called periodically (e.g., hourly) from `server/main.ts` when not under maintenance hold:
     - Delete `outbox` rows with `state = 'done'` older than 7 days.
     - Keep `events` bounded (or add paginated `snapshot` support for `message`/`tool_stream`/`subagent_run` history).
3. **Evict terminal tasks from `Coordinator.gates` and `Coordinator.runtimes`:**
   - When a task transitions to `completed` or `cancelled` and has no active runtime or pending/dispatching actions, call `this.gates.delete(taskId)` and `this.runtimes.delete(taskId)`.
   - Re-creating a `Gate` on demand via `this.gate(taskId)` is already idempotent if the task is later inspected.
4. **Log structured non-secret error codes/messages in `server/main.ts`:**
   - Log `error instanceof Fault ? error.code : error instanceof Error ? error.message : String(error)` (redacting any potential bearer tokens/keys) instead of dropping the error completely.

## Verification & Acceptance Criteria

- [ ] `Ledger.list()` executes exactly 1 SQLite statement regardless of row count (verified in `server/core/ledger.test.ts`).
- [ ] `Coordinator` unit test proves `gates.size` and `runtimes.size` drop back to `0` after a task completes or is cancelled.
- [ ] `Ledger.compact()` deletes aged `done` outbox rows without touching `pending`, `claimed`, or `unknown` rows.
- [ ] `npm run check` passes.
