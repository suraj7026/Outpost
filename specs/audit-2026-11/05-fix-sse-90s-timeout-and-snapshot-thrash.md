# Spec 05: Fix 90-Second SSE Stream Timeout, Full-Snapshot Thrash & Reconnect Storm

- **Priority:** P0
- **Area:** Desktop Transport & Sync (`Rust` + `React`)
- **Affected Files:**
  - `desktop/src-tauri/src/transport.rs`
  - `desktop/src/useConnection.ts`
  - `desktop/src-tauri/src/server_auto_update.rs`
  - `server/gateway/coordinator.ts`
  - `server/gateway/live.ts`

## Exact Problem

Four concrete transport and sync bugs degrade responsiveness, battery/CPU, and live streaming reliability:

1. **90-second total-request timeout kills every SSE `/stream` connection:**
   - In `desktop/src-tauri/src/transport.rs` (lines 427–428):
     ```rust
     if path.ends_with("/stream") {
         request = request.timeout(Duration::from_secs(90));
     }
     ```
   - In `reqwest`, `RequestBuilder::timeout()` bounds the **entire request + response body lifetime**, not idle time between chunks. A live SSE stream (`POST /v2/stream`) that the server leaves open is forcibly aborted after 90 seconds. When that call ends, `useConnection.ts` (line 129) sets `connected` false, clears `liveRecords`, and the reconnect path then calls `connect()`, which loads a full DB `snapshot`.
   - `server/gateway/live.ts` has no SSE keepalive comment (`: keepalive`). `serve()` writes only `data:` frames. The `{ type: 'heartbeat' }` every 10 seconds (line 74) is a JSON data frame, not that comment. `serve()` also ends every response after 60 seconds (`setTimeout(() => response.end(), 60000)`, line 75), so the server currently closes the stream before the 90-second client timeout.
2. **Full database `snapshot` reload after EVERY command:**
   - In `desktop/src/useConnection.ts`, `perform()` (lines 163–172) `await`s `refresh()` after a successful command when the lifecycle ticket is still current. `refresh()` (lines 46–49) queries `snapshot` and does not consult `streamActive`. That downloads **all records across all 21 `publicKinds`**—even when the live SSE stream is active and already delivering incremental frames.
3. **2-second reconnect poll with zero backoff while disconnected:**
   - In `desktop/src/useConnection.ts` (lines 143–161), `setInterval(..., 2000)` ticks every 2 seconds. If `streamActive.current` is set it returns immediately (also if paused, syncing, or a command is in flight), so the interval does not reconnect while a live stream is up. If `!connected` it calls `connect()` every 2 seconds with no exponential backoff or jitter. If connected and the stream is down it polls `events` after `cursor`.
4. **Full `snapshot` download in `postverify()` to find one task ID:**
   - In `desktop/src-tauri/src/server_auto_update.rs`, `postverify()` first checks environment, runtime, and worker inventory (lines 1712–1721). It then best-effort queries `snapshot` (`.ok()`, lines 1722–1738) to find one `task` id before an optional `tools` query. The snapshot is not the only verification. There is still no task-independent `tools` query: with no task id, the tools check is skipped.

## Exact Solution

1. **Remove total-body timeout on SSE streams; use read/idle timeout instead:**
   - In `desktop/src-tauri/src/transport.rs`, build a dedicated `reqwest::Client` for streaming with `.connect_timeout(Duration::from_secs(15))` and `.read_timeout(Duration::from_secs(90))` (and **no** total `.timeout()`). `server/gateway/live.ts` does not already emit an SSE keepalive comment. Add `: keepalive\n\n` every 20–30 seconds so idle streams stay healthy while dead TCP connections still fail within 90s, and remove or raise `serve()`'s 60-second `response.end()` (line 75). The existing `{ type: 'heartbeat' }` data frame is not that comment.
2. **Skip full `snapshot` reload in `perform()` when SSE is active:**
   - In `desktop/src/useConnection.ts`, when `streamActive.current` is true after a command succeeds, call only `refreshInfo()` (to clear pending state) and let the active SSE stream deliver the resulting `records` frame—or fetch only incremental `events` since `cursor.current` as a lightweight fallback. Reserve full `snapshot` for initial connect or cursor rewind.
3. **Add capped exponential backoff with jitter to reconnects:**
   - Replace the fixed 2s `!connected` → `connect()` branch of the `setInterval` in `useConnection.ts` (lines 143–161) with a scheduled backoff (`2s → 4s → 8s → 16s → 30s` max, with ±20% jitter) that resets immediately to `0` on `window` focus, `online` event, or manual `connect()` click. Keep the immediate return while `streamActive.current` is set, and keep the connected-but-stream-down `events` poll after `cursor`.
4. **Add a task-independent `tools` query (or `taskId` optional) on the coordinator:**
   - In `server/gateway/coordinator.ts`, allow `query('tools', {})` without requiring a `taskId` (returning the base coordinator tool catalogue) and update `postverify()` in `server_auto_update.rs` to call `query("tools", {})` directly instead of downloading `snapshot`.

## Verification & Acceptance Criteria

- [ ] A live SSE stream stays connected for > 180 seconds without disconnecting or triggering a reconnect cycle.
- [ ] Sending `task.steer` or `task.pause` while SSE is active issues zero `snapshot` queries.
- [ ] Disconnecting a server backs off reconnect attempts (`2s, 4s, 8s, ... <= 30s`) instead of polling every 2 seconds.
- [ ] `postverify()` in `server_auto_update.rs` no longer calls `query("snapshot", ...)`.
- [ ] `cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --no-default-features` and `node desktop/test-reconnection.mjs` pass.
