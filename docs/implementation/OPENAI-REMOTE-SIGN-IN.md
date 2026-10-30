# OpenAI browser return on a remote Pi worker

## Failure

Pi runs on Server 2, but the owner's browser runs on the Mac. OpenAI redirects to `http://127.0.0.1:1455/auth/callback` (or `localhost` for Codex). Before this fix, Outpost opened the authorization link without a Mac listener; Safari therefore displayed “can't connect.” The server-side Pi listener was on a different host.

The installed Pi 1.4.0 adapters already support a manual-return prompt. OpenAI ChatGPT requires the **complete callback URL**, including `state`, the authorization code and the dynamically issued `client_id`. Passing only the code is insufficient. These URLs are sensitive and must not be pasted into task conversations or logs.

## Fix

`desktop/src-tauri/src/oauth_callback.rs` captures the callback on the Mac. It is **not an HTTP proxy** and does not contact arbitrary internal endpoints:

- Only HTTPS authorization URLs on `auth.openai.com`, on the two supported authorization routes, are accepted.
- Only HTTP loopback port **1455**, path **`/auth/callback`**, with a single nonempty expected OAuth state is supported.
- Listener binds `127.0.0.1` before the browser opens. An occupied port produces an error/manual fallback, not a falsely working automatic flow.
- Only GET, the expected Host/path/state, and one nonempty code are accepted. Foreign Origin, duplicate state/code, arbitrary hosts/ports, oversize requests and request bodies are rejected.
- The listener is single-use, bounded by the login expiry (maximum ten minutes), and cancellable by its native session ID. Wrong callbacks do not consume the active login.
- Browser responses are static, no-store, no-referrer, and never echo callback contents. They say to return to Outpost, not that credentials have already been saved.
- The callback URL exists only in native/JS memory and travels through the existing signed, non-persisted `login.answer` path. Pi still checks its own state and PKCE and exchanges tokens on Server 2.
- Closing/changing the login prompt cancels the Mac listener. Late returns cannot submit to a cancelled or different prompt. The separate **Save server credential** step remains required.

`BrowserSignIn.tsx` handles the listener/browser sequence. Explicit private paste guidance remains available for manual fallback. General provider callback forwarding and provider packages are still disabled. No server runtime change or Kubernetes restart is needed for this desktop fix.

## Verification

- Native parser tests: state/path/host/method/origin/duplicate checks and destination restrictions.
- Real loopback native test: captures a callback once, retains its dynamic client ID and does not echo its code in the browser page.
- Cancellation/expiry and native-session ownership tests.
- Browser tests in Chromium/WebKit: bind before browser launch, automatic return through secret IPC, explicit save confirmation, cancellation/late return, port conflict and manual fallback guidance. Storage/transcript/metadata checks exclude the fixture callback.
- Actual pinned Pi OpenAI ChatGPT adapter test with a **mocked token endpoint**: complete callback works with the dynamic client ID; wrong state performs no token exchange. No live OpenAI request or account login occurs in this test.

Live account entitlement and a fresh owner-completed login are not claimed by these synthetic tests. A callback from an old/expired attempt must not be reused after installing the fix.
