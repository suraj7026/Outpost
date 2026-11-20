# Spec 10: Upgrade Browser Live Viewing from 1s Polling & Fix Human-Takeover Input UX

- **Priority:** P2
- **Area:** Desktop / Server Browser
- **Affected Files:**
  - `desktop/src/BrowserViewer.tsx`
  - `server/browser/sessions.ts`
  - `server/gateway/coordinator.ts`
  - `server/gateway/live.ts`

## Exact Problem

Direct code inspection of `desktop/src/BrowserViewer.tsx` revealed two significant performance and usability issues:

1. **1-second full-JPEG HTTP polling, gated but not change-aware:**
   - `desktop/src/BrowserViewer.tsx` does not use `setInterval` for frames. The `setInterval` around lines 63–69 only refreshes the on-screen clock.
   - A recursive `setTimeout(..., 1000)` (lines 73–87) polls only when `connected && viewActive && expanded && hasSession && !recordedPreview()`. Each tick calls `refresh()`, which runs `api.query('browser.frame', { taskId })` (line 51). The query is skipped while `document.hidden` (line 76); the timeout is still rescheduled.
   - Each query that runs is a signed Ed25519 HTTP POST. The server still captures and returns a base64 JPEG when the page is static, and React decodes it. During active human takeover, 1 FPS feels sluggish and unresponsive.
2. **All human-takeover text input is masked as `type="password"`:**
   - Line 180 of `BrowserViewer.tsx`:
     ```tsx
     <label>Text for focused field<input type="password" autoComplete="off" value={inputText} maxLength={20000} disabled={!canInput} onChange={event => setInputText(event.target.value)} /></label>
     ```
   - Every string a user wants to type into the remote browser—search queries, URLs, emails, form fields—is hidden behind password dots with no way to see typos before clicking **Send text**.

## Exact Solution

1. **Add change-gated frames + adaptive frame rate (or CDP `Page.startScreencast`):**
   - **Phase A (fast win, works on both Chromium & Camoufox):** Add an optional `lastFrameId` parameter to `query('browser.frame', { taskId, lastFrameId })`. On the server, hash the captured frame (or track DOM/navigation mutation counter) and return `{ unchanged: true, capturedAt, control }` with no base64 payload when nothing changed. Adapt the client poll interval: `250ms` for 3 seconds after user input or while `state === 'running'`, backing off to `2000ms` when idle/unchanged.
   - **Phase B (Chromium low-latency stream):** For Chromium sessions, use CDP `Page.startScreencast` to push changed JPEG frames over the existing SSE/binary stream channel while a viewer is attached, stopping screencast automatically when no viewer is open.
2. **Fix the takeover text input UX in `BrowserViewer.tsx`:**
   - Change the default input from `type="password"` to `type="text"` with an explicit **"Mask input (password/secret)"** toggle button (eye icon) right next to the field.
   - Keep `autoComplete="off"`, `spellCheck={false}`, and never persist sent text in chat or input logs regardless of whether masking is toggled on or off.

## Verification & Acceptance Criteria

- [ ] When a browser page is idle, `browser.frame` returns `{ unchanged: true }` with zero base64 image transfer.
- [ ] During active takeover input, frame refresh latency drops to <= 300ms for interactive feedback.
- [ ] Users can toggle between visible text and masked password input in `BrowserViewer.tsx`, and sent text is still cleared immediately on submit and never persisted to logs/records.
- [ ] `node desktop/test-browser-modes.mjs` and `npm --prefix desktop run build` pass.
