# Live agent streaming

## Data path

Pi `message_start/update/end` and `tool_execution_start/update/end` → bounded live projections → authenticated POST `/v1/stream` (SSE) → Rust incremental UTF-8 decoder → Tauri IPC Channel → React conversation/evidence.

This replaces the two-second polling path while a live connection is healthy. Polling remains a fallback. UI changes require reopening the newly built desktop application; the earlier Swift client can see durable message checkpoints but has no new thinking panel.

## Behavior

- Text and model-visible reasoning arrive during generation, not only at message completion.
- Ollama `/api/show` determines thinking capability for the exact selected model. Supported models use Pi's medium thinking level. Unsupported/unavailable capability probes retain the existing non-thinking configuration; no model is substituted.
- Only actual `thinking` content is exposed. Redacted blocks and opaque reasoning signatures are never published. No synthetic thinking is generated.
- Thinking expands while it is streaming and can be manually expanded/collapsed. Reading older conversation text disables automatic following until the reader scrolls to the bottom.
- Tool argument construction, execution and final results are distinct. The live call links to the durable action ID once proposed, avoiding a duplicate finished card.
- Native command stdout and Browser-Use's nested internal steps are still returned by their existing tools, generally at completion. This feature streams the main Pi agent and its tool lifecycle, not a live terminal or browser video.

## Durability and privacy

Live updates coalesce at 50 ms. Partial records checkpoint every two seconds; finalized content overwrites the same stable message ID rather than duplicating it. A server crash may lose the last two seconds of partial output. Restored partial records are marked interrupted.

Every stream is authenticated with the existing signed device envelope. Open streams check revocation; no keys or bearer tokens go into browser URLs. Reconnect begins with an authoritative snapshot plus current live records and never replays an action. Streams rotate after 60 seconds, with heartbeats and capped buffering/connections. Slow consumers disconnect and resnapshot. Displayed text/thinking are capped at 128 KiB per channel; tool previews at 16 KiB. Finalized Pi session context remains authoritative.

The gateway remains private. Model reasoning can contain sensitive task context and is retained in the existing protected server data directory. Cloud-selected models still send context to Ollama Cloud.

## Recorded verification

- Real `glm-5.3-flash:cloud` run: 11 incremental answer updates, 17 thinking updates and 3 tool lifecycle updates; first content at 2.194 seconds, completion at 6.739 seconds. The workspace command produced the expected output.
- Backend tests cover authenticated SSE, reconnect snapshots, revocation of an open stream, interrupted checkpoints, SDK custom tools and model reasoning events.
- Rust tests cover split UTF-8 characters, multiple frames per chunk, malformed JSON and buffer limits. A separate real Keychain-signed Rust test received 20 text, 37 thinking and 4 tool frames before completion, then verified a second Pi turn and idempotent command retry.
- 40 backend tests and four deterministic Rust tests passed. The explicit live Rust test also passed.
- 14 live UI checks cover incremental rendering, automatic thinking expansion, follow-tail versus reading older messages, tool states, finalization without duplicates and stale-frame protection. The existing 48 frontend checks also passed. These are controlled fixtures, not invented production activity.
