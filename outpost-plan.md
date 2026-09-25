# Outpost: Plan, Build Guide and Design System

Working name. Version 2, September 25, 2026.

---

## 0. What changed in v2

**Build plan.** Section 8 is rewritten into something you can execute. It now has:

- Build principles and a critical-path map.
- A development environment and a layered testing strategy.
- A week-by-week calendar with milestones.
- A task-level backlog for every phase, with estimates and dependencies.
- A definition of done and cut lines.
- A design workflow, and release and operations procedures.
- Decision records and a weekly rhythm.

The detailed backlog raised the honest estimate to about 18 focused weeks, including a two-week hardening buffer. Applying the cut lines brings it to about 14.

**Protocol.** Section 5 gains:

- A `welcome` frame and protocol versioning.
- Heartbeats and reconnect rules.
- Delivery guarantees and backpressure rules.
- An HTTP command endpoint. iOS notification actions need this, because a backgrounded app can't hold a WebSocket open.

**Design system.** Section 9 is the full Ink design system: principles, tokens with measured contrast ratios, typography, spacing, motion, the status system, component specs, layout, a code theme, accessibility rules, and a token pipeline that generates CSS and Swift from one file.

Contrast checks found four problems, now fixed:

- `text-3` was below 4.5:1 in both modes.
- Light `danger` fell below 4.5:1 on raised surfaces.
- Input borders failed the 3:1 non-text rule.

The fixes adjust `text-3` and light `danger`, add a `control-border` token for form controls, and add a `text-disabled` token that keeps the old `text-3` values for disabled states only. The Claude Design prompt in section 13 is updated to match. **Re-paste it if you already used v1.**

---

## 1. TL;DR

Outpost is a personal, always-on agent server with thin clients on desktop and iPhone. Chat, Cowork and Code live in one app, work with any model, and run on your server's filesystem instead of your laptop's. The server is the product; every device is just a window into it.

The research shaped three things:

1. **The closest competitor is OpenHands Agent Canvas.** It is a self-hosted control center for coding agents that already speaks ACP. Its mobile client is an early MVP, and it has no knowledge-work mode. Your wedge is a native mobile experience with lock-screen approvals, a Cowork mode, and one unified UX.
2. **Two standards replace formats you would otherwise invent.** Open Responses items are your canonical conversation history. ACP lets you plug in existing agents (Claude Code, Codex, OpenCode, Gemini CLI) as optional Code-mode engines next to your own model-agnostic agent.
3. **Security is a design constraint from day one.** The March 2026 LiteLLM compromise showed what happens to a process that holds every API key. Your daemon is that process.

Build the sync spine first. Nothing else matters until the continuity demo in section 8.5 passes.

---

## 2. Research findings

The research was split into six workstreams, each with its own brief, and the results were synthesized here. Every section ends with what it means for Outpost.

### 2.1 Landscape and competitors

**Anthropic's own apps.** Claude Code and Cowork can already be reached remotely from the Claude mobile app. This proves the demand for remote agents, but those products are Claude-only. They are the benchmark for UX polish, not for openness.

**Happy (open source).** Happy is a mobile and web client for Claude Code and Codex. You run its `happy` wrapper on your own computer instead of `claude`, and a relay syncs end-to-end-encrypted sessions to the phone. It sends push notifications when the agent needs permission. Switching control to the phone restarts the session in remote mode, and pressing a key on the laptop takes control back. The agent still runs on your own machine, and control belongs to one device at a time.

**OpenCode.** OpenCode is a model-agnostic coding agent with a real headless server. `opencode serve` exposes an HTTP API with an OpenAPI spec and uses basic auth, and sessions, permissions, MCP and SSE events are all available through it. It also speaks ACP over stdio. It is the strongest candidate for an embeddable Code-mode engine, and its server API is a good design reference.

**OpenHands Agent Canvas.** This is the closest product to Outpost. It is a self-hosted control center that runs OpenHands, Claude Code, Codex, Gemini or any ACP agent on local, remote or cloud backends. It is built so agents keep running while your laptop is closed, and it runs agents in parallel, each in its own git worktree. Its mobile app is an early Expo MVP; QR pairing and a relay are listed as not built yet, and it recommends Tailscale for reaching a server. It is code-focused, with no knowledge-work mode.

| | Runs where | Model-agnostic | Chat / Cowork / Code | Native mobile | Multi-device at once |
|---|---|---|---|---|---|
| Claude apps (remote) | Anthropic / your machine | No | Yes | Yes | Yes |
| Happy | Your machine | Per wrapped agent | Code only | Yes (Expo) | One device controls at a time |
| OpenCode | Anywhere (`serve`) | Yes | Code only | No | Via API |
| OpenHands Agent Canvas | Local or remote backends | Yes (+ ACP) | Code (+ automations) | Early MVP | Yes, web-first |
| **Outpost** | **Your server** | **Yes (+ ACP engines)** | **All three** | **Native SwiftUI + Live Activities** | **Yes, by design** |

**What this means.** Don't compete on "can run a coding agent remotely." That is table stakes now. Compete on four things: one personal space for all agent work (including non-code work), a phone experience that feels native with lock-screen approvals, true simultaneous multi-device presence, and model freedom. Read the OpenCode server API and the OpenHands agent-server before writing your own.

### 2.2 Agent protocols: ACP

ACP is a JSON-RPC 2.0 protocol that standardizes how a client (an editor or UI) talks to a coding agent. Zed created it, JetBrains collaborates on it, and it is Apache-licensed. The ecosystem is large:

- Adapters exist for the Claude Agent SDK (`claude-agent-acp`) and Codex (`codex-acp`).
- A curated registry lists dozens of agents.
- OpenCode and Gemini CLI speak it natively.

ACP's standard transport is stdio. A Streamable HTTP and WebSocket transport was proposed in a July 2026 RFD, and a Rust crate implementing it already exists. Remote ACP is not yet something to depend on across all SDKs.

**What this means.** Use ACP on the engine side: the daemon launches an ACP agent inside a workspace sandbox and talks to it over stdio. Do not use ACP as the device protocol. ACP is a single client-to-agent link with no replay-from-cursor, no fan-out to multiple subscribers, and no push semantics. Those are exactly Outpost's core features, so devices need the Outpost Sync Protocol (section 5). The daemon translates ACP session updates into Outpost events.

### 2.3 Model layer: Open Responses, and a supply-chain warning

Open Responses is an open specification, announced by OpenAI in January 2026, for a provider-neutral LLM interface. It is based on the Responses API, and its building blocks are "items": messages, function calls, function-call outputs and reasoning. It also defines semantic streaming events. Ollama (0.13.3+) and OpenRouter implement it, and gateways translate it to Anthropic, Gemini and others.

LiteLLM, the most popular multi-provider router, had two malicious PyPI releases on March 24, 2026. They carried a credential stealer that ran on interpreter startup through a `.pth` file. The attack originated from a compromised CI dependency (Trivy) in LiteLLM's pipeline.

**What this means.** Store conversation history as Open Responses items, a well-specified format that already covers tool calls and reasoning. Then write thin adapters:

- **Open Responses adapter:** covers OpenAI, OpenRouter, Ollama and other compliant endpoints.
- **Native Anthropic Messages adapter:** keeps prompt caching, thinking blocks and server tools intact.
- **Native Gemini adapter.**

Skip LiteLLM in the key-holding process. Pin every dependency with hashes, and treat each new daemon dependency as a security decision.

### 2.4 MCP

The 2026-07-28 MCP revision is the largest since launch:

- The core protocol is now stateless. The initialize handshake and the `Mcp-Session-Id` header are gone.
- Servers that need state across calls pass explicit handles as tool arguments instead.
- Roots, sampling and logging are deprecated, with at least 12 months before removal.
- MCP Apps and Tasks arrive as extensions.

**What this means.** The daemon is the MCP client, so connectors work the same for every model. Use the official Python SDK at the 2026-07-28 revision rather than hand-rolling the protocol. Map MCP Tasks onto your own long-running tool-call events. MCP Apps can come later.

### 2.5 Sandboxing

Containers share the host kernel. For code that an agent writes and runs, the stronger options are:

- **microVMs** (Firecracker, Kata), with a dedicated kernel per workload.
- **gVisor**, which intercepts syscalls in user space. It adds roughly 10–30% overhead on I/O-heavy work and little on compute.

Docker Sandboxes (`sbx`) packages the microVM approach for agents:

- Each sandbox gets its own kernel and its own Docker daemon, so agents can build containers without Docker-in-Docker privileges.
- A host-side proxy enforces network allow/deny lists and injects credentials, so keys never enter the agent's space.
- On Linux it requires KVM. Most cloud VMs don't expose KVM unless you use bare-metal or nested-virtualization-capable instances.

**What this means.** Use tiered isolation:

- **v1 on a normal VPS or EC2 instance:** Docker with the gVisor `runsc` runtime, plus quotas and a default-deny egress proxy.
- **KVM-capable host:** `sbx` or Firecracker.

Either way, copy the credential-injection pattern: the egress proxy adds provider auth headers on the way out, and the sandbox never holds a key.

### 2.6 Mobile push and connectivity

**Live Activities.** Live Activities can be updated through APNs using a push token per activity. Since iOS 17.2 they can also be started remotely using push-to-start tokens. iOS enforces an hourly update budget, and lower-priority pushes are how you stay under it.

**Connectivity.** OpenHands' own mobile client points users to Tailscale when a server is unreachable on the LAN.

**What this means.**

- Send approval requests as priority-10 alerting pushes.
- Send Live Activity progress at priority 5, coalesced, and only on step changes.
- While it is only you, the daemon can call APNs directly with your `.p8` key. Distributing to others would need a small hosted push relay.
- Tailscale is the v1 network path.
- The phone must be on the tailnet for a notification action to reach the server; Tailscale's on-demand VPN setting keeps that reliable.

---

## 3. Architecture

```
   Desktop (Tauri + React)     Browser (same bundle)     iPhone (SwiftUI)
            │                          │                        │
            └──── Outpost Sync Protocol (WSS) + HTTP commands ──┘
                        (Tailscale by default; Caddy+TLS optional)
                                      │
 ┌────────────────────────────────────▼───────────────────────────────────┐
 │ outpostd                                                                │
 │                                                                         │
 │  Gateway         device auth, pairing, subscriptions, fan-out           │
 │  Session engine  run loop per session, state machine, approvals         │
 │  Event log       SQLite (WAL): append-only events per session           │
 │  Engines         ├─ Native agent (model-agnostic, Open Responses items) │
 │                  └─ ACP bridge (Claude Code, Codex, OpenCode, Gemini)   │
 │  Provider router Anthropic native · Gemini native · Open Responses      │
 │  Tool host       fs, edit, glob/grep, shell, git, web, docs, MCP, skills│
 │  Vault           encrypted secrets; never mounted into sandboxes        │
 │  Egress proxy    default-deny allowlist + credential injection          │
 │  Notifier        APNs alerts + Live Activity updates                    │
 └───────────────┬─────────────────────────────────────┬──────────────────┘
                 │ exec / volume mounts                │ HTTP(S) via proxy
        ┌────────▼─────────┐  ┌──────────────────┐     ▼
        │ Workspace: repo  │  │ Workspace: docs  │   LLM providers,
        │ gVisor container │  │ gVisor container │   MCP servers, web
        │ git worktrees    │  │ doc toolchain    │
        └──────────────────┘  └──────────────────┘
```

Clients never talk to models, MCP servers or sandboxes directly. They send commands and receive events. Everything that matters is state on the server.

---

## 4. Core design decisions

### D1. Sessions are append-only event logs

Every session is an ordered sequence of events with a monotonically increasing `seq`. A device subscribes with "session S from seq N" and receives every persisted event after N, then a snapshot of anything in flight, then the live stream. That one mechanism covers multi-device sync, reconnection, offline catch-up and a full audit trail. Token-level deltas are broadcast but never persisted.

### D2. Runs are decoupled from connections

A session's run loop is a task inside the daemon, and devices are only subscribers. A disconnect never cancels anything; only an explicit `cancel` command does. If the daemon restarts, `running` sessions become `interrupted` and can be resumed from the log.

### D3. One run loop, three mode profiles

| | Chat | Cowork | Code |
|---|---|---|---|
| Workspace | None (scratch space for attachments) | A documents folder | A git repo, with a worktree per session |
| Tools | Web search, web fetch, read attachments | File read/write, doc tools (python-docx, openpyxl, python-pptx, pandoc), web, MCP connectors, skills | Read, edit, write, glob, grep, bash, git, web fetch, MCP |
| Default approval policy | Nothing needs approval | Ask before deleting files or sending anything outside the server | Ask for shell with network access, `git push`, and writes outside the worktree |
| Right pane | None | Outputs + folder browser | Files / Diff / Terminal / Preview |
| System prompt | Conversational | Deliverable-oriented, cites files it read | Engineering conventions, test-before-done |

Web search is your own tool backed by a search API (Brave, Tavily, Exa, or self-hosted SearXNG). Provider-native search differs across models, and relying on it would break model-agnosticism.

### D4. Canonical history uses Open Responses items

History is stored as Open Responses-shaped items, and adapters translate it per provider at call time. Each model carries a capability record:

```
tools: bool, parallel_tools: bool, vision: bool, reasoning: bool,
context_window: int, max_output: int, prompt_caching: bool,
agentic_grade: "strong" | "ok" | "weak"   # set by your eval suite
```

When a model can't handle something already in the history, the adapter degrades it deliberately. For example, if the model has no vision, images are replaced by their stored captions. Reasoning items from one provider are dropped or summarized before being sent to another.

### D5. Two kinds of engine

The **native agent** is your own run loop. It is fully model-agnostic, owns the tool set, and is the only engine for Chat and Cowork.

The **ACP bridge** is optional and exists for Code mode. It runs an existing agent inside the workspace sandbox and translates its session updates into Outpost events. These engines choose their own models, so the UI labels them as "engine: Claude Code" rather than as a model.

### D6. Approvals are events, so any device can answer

Before a tool call that the policy flags, the engine emits `approval.requested` and pauses, and the notifier sends an alerting push at the same time.

The first valid `approve` or `deny` wins, and every other device sees who resolved it and where. Commands carry idempotency keys, so double taps and simultaneous taps are harmless.

The policy has three tiers per workspace: `always ask`, `ask for risky`, and `auto`. "Always allow this in this workspace" saves a rule to the workspace policy.

### D7. Checkpoints and worktrees

Before the first file-changing tool call in a turn, the daemon snapshots the workspace into a shadow git directory (`.outpost/shadow`). "Undo turn" restores that snapshot. Each Code session also gets its own `git worktree` and branch, so parallel sessions never collide.

### D8. Secrets never enter sandboxes

Keys live in the daemon's encrypted vault. Sandboxes reach the internet only through the egress proxy, which applies the workspace allowlist and injects auth headers for known destinations.

### D9. Connectivity and pairing

For v1, the daemon listens only on the Tailscale interface. Pairing works like this:

1. `outpostd pair` shows a QR code with the server URL, a 5-minute one-time token and the server's public key fingerprint.
2. The device generates a keypair and exchanges the token for a device credential.
3. The device pins the fingerprint.

Devices are revocable from the Server & Devices screen.

### D10. Push and Live Activities

The notifier maps events to pushes:

- `approval.requested` becomes a priority-10 alert with Approve and Deny actions.
- Session completion or failure becomes a standard alert.
- A step change in a running session becomes a Live Activity update (priority 5, at most one every 30 seconds).

---

## 5. Data model and sync protocol

### 5.1 Tables (SQLite, WAL mode)

```sql
workspaces (id, name, kind TEXT CHECK(kind IN ('scratch','docs','repo')),
            path, sandbox_image_digest, policy JSON, created_at)

sessions   (id, workspace_id, mode TEXT CHECK(mode IN ('chat','cowork','code')),
            title, engine TEXT, model TEXT,
            status TEXT,   -- idle|running|waiting_approval|done|failed|interrupted|cancelled
            worktree_branch, last_seq INTEGER, created_by_device, created_at, updated_at)

events     (session_id, seq INTEGER, ts, type TEXT, actor TEXT, payload JSON,
            PRIMARY KEY (session_id, seq))

commands   (id TEXT PRIMARY KEY, device_id, type, received_at, result JSON)   -- idempotency

approvals  (id, session_id, seq_requested, tool_call JSON, risk TEXT,
            status TEXT, resolved_by_device, resolved_at)

checkpoints(id, session_id, seq, shadow_commit, created_at)
devices    (id, name, platform, public_key, apns_token, created_at, last_seen, revoked_at)
providers  (id, kind, base_url, secret_ref, enabled)
models     (id, provider_id, name, capabilities JSON)
usage      (session_id, seq, model, input_tokens, output_tokens, cached_tokens, cost_usd)
schema_migrations (version INTEGER PRIMARY KEY, applied_at)
```

### 5.2 Event types

Persisted:

```
session.created   session.renamed   status.changed    message.user
item.assistant    item.reasoning    tool.call         tool.result
file.changed      approval.requested approval.resolved checkpoint.created
model.switched    usage.recorded    error
```

Ephemeral (broadcast only):

```
delta.text   delta.tool_args   presence   tool.progress
```

### 5.3 Wire protocol, version 1 (WebSocket, JSON frames)

```jsonc
// client → server
{"t":"hello", "protocol":1, "device_id":"...", "sig":"...", "client":"ios/0.3.0",
 "resume":[{"session":"s1","from_seq":482}]}
{"t":"subscribe",   "session":"s1", "from_seq":482}
{"t":"unsubscribe", "session":"s1"}
{"t":"cmd", "id":"c-9f2", "type":"send_message", "session":"s1", "content":[...]}
{"t":"cmd", "id":"c-9f3", "type":"approve", "approval":"a7", "remember":false}
{"t":"cmd", "id":"c-9f4", "type":"deny" | "cancel" | "switch_model" | "undo_turn" | "rename", ...}
{"t":"ping"}

// server → client
{"t":"welcome", "protocol":1, "server":"0.4.1", "min_client_protocol":1, "capabilities":[...]}
{"t":"event", "session":"s1", "seq":483, "type":"tool.call", "payload":{...}}
{"t":"snapshot", "session":"s1", "at_seq":483, "inflight":{"item_id":"...","text":"partial..."}}
{"t":"delta", "session":"s1", "item_id":"...", "text":"..."}
{"t":"ack", "cmd":"c-9f3", "ok":true}                     // or ok:false, reason
{"t":"sessions", "list":[{id, title, status, mode, updated_at, needs_you}]}
{"t":"pong"}
```

### 5.4 Connection lifecycle and client sync

Every client implements the same state machine: `disconnected → connecting → authenticating → syncing → live`. An error goes to `backoff`, which returns to `connecting`.

- Backoff starts at 0.5 seconds, doubles up to 30 seconds, and adds jitter.
- Clients ping every 20 seconds. A missing pong for 45 seconds forces a reconnect.
- On reconnect, the client resumes each subscribed session from its last applied `seq`.

Clients reduce events into a view state using a pure reducer: `(state, event) → state`. Deltas append to an in-flight buffer keyed by `item_id`. That buffer is discarded when the persisted `item.assistant` with the same `item_id` arrives, which is what makes reconnects seamless.

The TypeScript implementation lives in `@outpost/sync` and the Swift one in `OutpostSync`. Both are tested against the same golden event streams (section 8.4), so the two clients can never quietly disagree.

### 5.5 Delivery guarantees and backpressure

**Ordering and durability.** `seq` is assigned under a per-session lock inside the same SQLite transaction as the insert. Events are published to subscribers only after the commit, so no client ever sees an event that wasn't durable. Persisted events are delivered at least once and in order, and clients ignore any `seq` they have already applied.

**Backpressure.** Each connection has a bounded queue. When it fills, the gateway first drops that connection's deltas and marks it as needing a snapshot. If persisted events still can't be queued, the gateway closes the connection, and the client heals itself by resuming from its last `seq`. Persisted events are never silently dropped.

**Approvals.** Resolution is first-writer-wins inside a transaction. Later attempts get `ok:false, reason:"already_resolved"`, with the resolving device's name.

### 5.6 HTTP API

The HTTP API mirrors the WebSocket commands, for clients that can't hold a socket open:

```
POST /v1/commands            same body as a WS "cmd" frame; used by iOS notification actions
GET  /v1/sessions            session list
GET  /v1/sessions/{id}/events?from_seq=N&limit=500
POST /v1/uploads             resumable upload (tus-style) into a workspace
GET  /v1/files/{workspace}/{path}
GET  /v1/health              liveness and version
GET  /v1/metrics             host health and queue depths for the Server screen
POST /v1/pair                pairing token exchange
```

---

## 6. The native run loop

```python
async def run_turn(session: Session) -> None:
    checkpointed = False
    while True:
        req = adapters.build(session.history, session.profile.tools, session.model.caps)
        async for ev in provider.stream(req):
            bus.ephemeral(session.id, ev)                 # deltas to subscribed devices
        items = provider.completed_items()
        log.append(session, items)                        # persisted, seq assigned
        usage.record(session, provider.usage())

        calls = [i for i in items if i.type == "function_call"]
        if not calls:
            return set_status(session, "idle")

        for call in schedule(calls, parallel=session.model.caps.parallel_tools):
            if tools.mutates_files(call) and not checkpointed:
                checkpoints.create(session); checkpointed = True
            if policy.requires_approval(session.workspace, call):
                set_status(session, "waiting_approval")
                decision = await approvals.request(session, call)   # push + wait
                set_status(session, "running")
                if decision.denied:
                    log.append(session, tool_result(call, error="denied by user"))
                    continue
            result = await tools.execute(call, sandbox=session.workspace.sandbox)
            log.append(session, tool_result(call, truncate(result, store_full=True)))

        if context.near_limit(session, threshold=0.8):
            await compaction.summarize_older_turns(session)
```

Large tool outputs are truncated in history, and the full text goes to `.outpost/results/<id>.txt`, where the agent can re-read it on demand. Compaction replaces older turns with a summary item, and the originals stay in the event log for the UI.

---

## 7. Stack and repo layout

| Layer | Choice | Why |
|---|---|---|
| Daemon | Python 3.12, FastAPI, uvicorn, asyncio | Your strongest language; Pydantic defines the schema once |
| Packaging | `uv` with a hashed lockfile; systemd unit | Reproducible installs; supply-chain hygiene |
| Storage | SQLite (WAL), numbered SQL migrations | Single-writer event log fits SQLite well |
| Model adapters | Your own: Open Responses, Anthropic native, Gemini native | No heavyweight router in the key-holding process |
| MCP | Official Python SDK at spec 2026-07-28 | Current, stateless revision |
| ACP bridge | JSON-RPC over stdio to engines in the sandbox | Small; use an official SDK where one fits |
| Sandbox | Docker + gVisor `runsc`; `sbx`/Firecracker on KVM hosts | Practical on VPSes |
| Egress | Small proxy (mitmproxy-based or Envoy) with allowlist and header injection | Keeps keys out of sandboxes |
| Web client | React + TypeScript + Vite, Monaco, xterm.js | One UI for browser and desktop |
| Desktop | Tauri 2 wrapping the web bundle | Light; native menus, notifications, keychain |
| iOS | SwiftUI, URLSessionWebSocketTask, ActivityKit, WidgetKit | Live Activities need native code |
| Shared types | Pydantic → JSON Schema → quicktype → TS + Swift Codable | Schema defined in one place |
| Design tokens | `design/tokens.json` → generated CSS and Swift | One source for both clients |
| Network | Tailscale; Caddy + TLS as opt-in public mode | No open ports by default |

A TypeScript daemon (Node or Bun) is the main alternative. It would share types with the web client natively. ADR-001 settles the choice in week 1.

```
outpost/
  daemon/            gateway, sessions, engines/{native,acp}, providers, tools, vault, notifier
  schema/            pydantic models → json-schema → generated TS/Swift
  design/            tokens.json, build_tokens.py, Monaco themes
  clients/web/       React app (served by daemon)
  clients/desktop/   Tauri 2 shell
  clients/ios/       SwiftUI app + Live Activity widget extension
  packages/sync-ts/  @outpost/sync
  packages/sync-swift/ OutpostSync (Swift package)
  testdata/golden/   recorded event streams + expected view states (shared by all clients)
  testdata/scripts/  scripted-model fixtures for agent tests
  sandbox/images/    code and docs images, pinned by digest
  deploy/            install.sh, systemd unit, tailscale serve config, Caddyfile
  evals/             per-model agentic task suite
  docs/adr/          decision records
```

Server sizing to start: 4 vCPU and 8 GB of RAM handles a few concurrent Code sessions. Give it 80 GB+ of disk.

---

## 8. How to build it

### 8.1 Build principles

**Build vertical slices, not layers.** Every milestone ends with something you can use end to end, even if it is ugly. A beautiful Code UI on top of a sync layer that loses events is worth nothing. A plain UI on a spine that never loses events is a product.

**The spine comes first and is never cut.** Replay, resume, idempotent commands and the chaos tests are the product's foundation. Everything else has a cut line (section 8.13).

**Most tests use no real model.** A scripted provider replays fixture outputs, including tool calls, approvals and errors, so the run loop, the sync layer and the UI can be tested deterministically for free. Real models only run in the eval suite.

**Decisions get written down.** Anything you'd otherwise re-argue with yourself in a month gets a short ADR (section 8.16).

**Dogfood from the first milestone.** Once M1 passes, all your own chat use goes through Outpost. Once M2 passes, all your side-project coding does. Real use sets priorities better than any backlog.

### 8.2 Critical path

```
schema ─► event store ─► gateway ─► commands ─► pairing ────────┐
  │                         │                                    ├─► web client v1 ─► M1
  ├─► vault ─► providers ─► chat engine ─────────────────────────┘
  │
  └─► @outpost/sync ─► golden streams ─┬─► web client
                                       └─► OutpostSync (Swift) ─► iOS app ─► APNs ─► M3

workspace mgr ─┬─► tools ─► approvals ─► checkpoints ─► code UI ─► M2
               └─► egress proxy ┘

docs image ─► uploads/outputs ─► doc tools + skills ─► MCP ─► M4
```

The golden streams are the hinge between the web and iOS clients. They are built in Phase 1 with the TypeScript library, and the Swift library is written against the same files in Phase 3.

### 8.3 Development environment

Develop on your laptop and deploy to the server.

- `make dev` starts the daemon in dev mode. Dev mode uses a `./.dev` data directory, defaults to the scripted provider, runs sandboxes with Docker's default `runc` runtime, and uses localhost-only auth.
- The web client runs under Vite with hot reload, proxying WebSocket traffic to the daemon.
- `outpostd dev seed` creates sample workspaces and sessions from recorded events, so UI work never needs a live agent.
- Real provider keys live in an uncommitted `.env.dev` and are only needed for manual testing and evals.

gVisor is Linux-only. Local development on macOS or Windows uses `runc`, while CI and the server use `runsc`. The sandbox security tests therefore run in Linux CI, not locally. If you'd rather develop directly on the server, as you already do with Claude Code on EC2, the same `make dev` works there with `runsc`.

The iOS app develops against a dev daemon reachable over Tailscale, or against the simulator talking to localhost.

CI runs on GitHub Actions:

- **Every push:** lint and type checks (ruff, pyright, tsc), then unit, scripted-agent, golden and chaos tests.
- **Linux job:** the sandbox security tests with `runsc`.
- **Every PR:** Playwright end-to-end tests.
- **Every tag:** an iOS build (on a macOS runner) that uploads to TestFlight.

### 8.4 Testing strategy

| Layer | What it covers | Tools | When |
|---|---|---|---|
| Unit | Adapter translation, policy classifier, reducers, token build | pytest, vitest, XCTest | Every push |
| Scripted agent | Full run loop against fixture model outputs: tool calls, parallel calls, approvals, denials, provider errors, context limits | pytest + scripted provider | Every push |
| Golden streams | Recorded event JSONL → expected view-state JSON; the same files run against `@outpost/sync` and `OutpostSync` | vitest, XCTest | Every push |
| Chaos | Disconnect mid-stream, SIGKILL the daemon mid-turn, duplicate and concurrent commands, two devices approving at once, slow consumers | pytest harness | Every push |
| Sandbox security | No secrets in env or files, host paths invisible, egress blocked for unlisted hosts, CPU/memory/pids limits enforced | pytest on a Linux runner with `runsc` | Every push (Linux) |
| End to end, web | Pair, chat, a Code flow with approval and undo, all on the scripted provider | Playwright | Every PR |
| iOS UI | Pairing, sessions list, approval sheet, reconnect after backgrounding | XCUITest | Before each TestFlight build |
| Model evals | About 20 real tasks on fixture repos and documents; sets each model's `agentic_grade` | `evals/` harness, cost-capped | Weekly or before switching defaults |

The chaos suite's core assertion is simple. After any sequence of disconnects and restarts, every client's final transcript must equal the transcript rebuilt from the event log.

### 8.5 Calendar and milestones

| Week | Phase | Milestone and exit test |
|---|---|---|
| 1 | 0: Spikes | ADR-001 to ADR-004 decided from spike results |
| 2–6 | 1: Spine | **M1 Continuity.** Start a long answer on the laptop, close the tab mid-stream, finish reading on the phone browser with nothing missing or duplicated. Switch models mid-chat. Restart the daemon and resume an interrupted session. |
| 7–10 | 2: Code | **M2 Remote fix.** Fix a real bug in one of your repos entirely through Outpost. Approve `git push` from a second device, and undo one turn along the way. |
| 11–13 | 3: iOS | **M3 Lock screen.** Start a Code session on the laptop and close the lid. Approve from the iPhone lock screen, and watch the Live Activity reach "Done". |
| 14–16 | 4: Cowork | **M4 Report from phone.** Upload two CSVs from the phone, get a formatted docx back, and open it on the laptop. |
| 17–18 | Hardening | **v1.** Security checklist passes, backup restore drill done, Tauri app packaged, two weeks of dogfood fixes. |

### 8.6 Phase 0 backlog: spikes (week 1, about 4.5 days)

| ID | Task | Estimate | Depends on | Done when |
|---|---|---|---|---|
| P0-1 | Monorepo scaffold: uv and pnpm workspaces, Makefile targets (`dev`, `test`, `lint`, `gen`), CI skeleton | 0.5d | — | CI is green on the empty project |
| P0-2 | Sync spike: FastAPI + SQLite event table + WebSocket subscribe-from-seq + a fake token streamer | 1.5d | P0-1 | The two-tab kill-and-reconnect transcript diff is empty |
| P0-3 | Engine spike: drive `opencode serve` over HTTP/SSE and `claude-agent-acp` over stdio; record event shapes and the permission flow | 1d | — | A findings note plus sample logs |
| P0-4 | Sandbox spike on the real server: install gVisor, run `--runtime=runsc`, check `/dev/kvm`, time `pnpm install` and `pytest` under `runc` vs `runsc`, confirm egress blocking | 1d | — | A benchmark table and an isolation decision |
| P0-5 | Write ADR-001 to ADR-004 | 0.5d | P0-2, P0-3, P0-4 | Decisions recorded |
| P0-D | Claude Design pass 1, in parallel | evenings | — | Design system page and the desktop Code session |

### 8.7 Phase 1 backlog: the spine (weeks 2–6, about 22 days)

| ID | Task | Estimate | Depends on |
|---|---|---|---|
| P1-01 | Schema package: Pydantic event and command models, JSON Schema export, TS and Swift codegen, and a CI check that generated files are current | 1d | P0-5 |
| P1-02 | Event store: append under a per-session lock, read-from-seq, WAL, numbered migrations, backup before migrating | 1.5d | P1-01 |
| P1-03 | Session engine skeleton: state machine, task registry, cancel, mark `interrupted` at boot | 1.5d | P1-02 |
| P1-04 | Gateway: WebSocket endpoint, `hello`/`welcome`, subscribe and replay, fan-out with bounded queues, heartbeats, session list feed | 2d | P1-02 |
| P1-05 | Commands: dispatcher, idempotency table, `POST /v1/commands` mirror | 1d | P1-04 |
| P1-06 | Device pairing and auth: keypairs, terminal QR, token exchange, fingerprint pinning, revoke | 1.5d | P1-04 |
| P1-07 | Vault: encrypted secret store, key from a systemd credential | 0.5d | P1-01 |
| P1-08 | Provider layer: interface, scripted provider, Anthropic native adapter, Open Responses adapter, capability registry, usage and cost | 3d | P1-07 |
| P1-09 | Native engine for Chat: streaming deltas, in-flight snapshots, model switch with history degradation | 1.5d | P1-03, P1-08 |
| P1-10 | Chat tools: web search through one API, web fetch with readable-text extraction | 1d | P1-09 |
| P1-11 | `@outpost/sync`: connection state machine, resume, reducer, golden-stream tests | 2d | P1-01 |
| P1-12 | Web client v1: Ink tokens, app shell, session list, chat view, composer, model picker, provider settings, pairing screen | 3.5d | P1-11, P0-D |
| P1-13 | Chaos test suite in CI | 1d | P1-04, P1-09 |
| P1-14 | Deploy v0: `install.sh`, systemd unit, `tailscale serve`, nightly backup | 1d | P1-06 |

### 8.8 Phase 2 backlog: Code mode (weeks 7–10, about 20–22 days)

| ID | Task | Estimate | Depends on |
|---|---|---|---|
| P2-01 | Workspace manager: create from a git URL, pinned image digests, gVisor container lifecycle, quotas | 2d | P1-03 |
| P2-02 | Egress proxy: per-workspace allowlist, credential injection for providers and GitHub | 2d | P2-01 |
| P2-03 | A worktree per session: branch naming, cleanup on archive | 0.5d | P2-01 |
| P2-04 | Core tools: read, write, edit (unique-match replace), glob, grep (ripgrep), bash (timeout, output cap), git helpers | 3.5d | P2-01 |
| P2-05 | Output truncation with full-result files | 0.5d | P2-04 |
| P2-06 | Policy and approvals: tiers, shell risk classifier, approval events, first-wins resolution, saved "always allow" rules | 2d | P2-04, P1-05 |
| P2-07 | Checkpoints and undo turn through the shadow git | 1.5d | P2-04 |
| P2-08 | `file.changed` events and unified diff generation | 1d | P2-04 |
| P2-09 | Web Code layout: file tree, read-only Monaco with the Ink theme, diff view, tool rows, approval card, read-only terminal stream | 4d | P2-06, P2-08 |
| P2-10 | Compaction v1 | 1d | P1-09 |
| P2-11 | Eval harness v0: 10 tasks on a fixture repo, run per model | 1.5d | P2-04 |
| P2-12 | ACP bridge for one engine (only if ADR-002 says so) | 2d | P2-01 |

### 8.9 Phase 3 backlog: iOS (weeks 11–13, about 15 days)

| ID | Task | Estimate | Depends on |
|---|---|---|---|
| P3-01 | `OutpostSync` Swift package: state machine, resume, reducer, passing the shared golden streams | 2.5d | P1-11 |
| P3-02 | QR pairing through AVFoundation; device key in the Keychain | 1d | P3-01 |
| P3-03 | Sessions list grouped into Needs you / Running / Recent | 1.5d | P3-01 |
| P3-04 | Live session view: streaming, tool rows, composer, continuity line | 3d | P3-01 |
| P3-05 | Approval sheet, plus notification actions that call `POST /v1/commands` | 2d | P3-04, P1-05 |
| P3-06 | APNs sender in the daemon: token auth with the `.p8` key, HTTP/2, priority rules | 1d | P1-03 |
| P3-07 | Live Activity: attributes, widget UI, token upload, coalesced daemon updates | 2.5d | P3-06 |
| P3-08 | Read-only diff viewer | 1d | P3-04 |
| P3-09 | TestFlight pipeline | 0.5d | P3-02 |

Handle one edge case in P3-05. If the phone is not on the tailnet when you tap Approve, the action fails. Show a local notification saying "Couldn't reach outpost-01, open the app to retry" rather than failing silently.

### 8.10 Phase 4 backlog: Cowork (weeks 14–16, about 12.5 days)

| ID | Task | Estimate | Depends on |
|---|---|---|---|
| P4-01 | Docs sandbox image: pandoc, python-docx, openpyxl, python-pptx, headless LibreOffice for previews | 1d | P2-01 |
| P4-02 | Resumable uploads and downloads | 1.5d | P1-05 |
| P4-03 | Doc tools and a skills loader (instruction files plus scripts, usable by any model) | 2d | P4-01 |
| P4-04 | Outputs pane with previews (Markdown, PDF, images, docx converted to PDF) | 2.5d | P4-02 |
| P4-05 | MCP client on the 2026-07-28 SDK, connector settings, OAuth tokens in the vault | 3d | P1-07 |
| P4-06 | iOS: outputs list, share sheet, upload from Files | 2d | P4-02, P3-04 |
| P4-07 | Cowork approval policy for external sends | 0.5d | P2-06 |

### 8.11 Phase 5 backlog (after v1, not estimated)

- More ACP engines.
- A dev-server preview proxy.
- An interactive terminal.
- A cost dashboard.
- Compaction tuning.
- Tauri auto-update.
- An engine picker and a workspace policy editor UI.
- A Gemini native adapter, if the Open Responses path proves insufficient.
- Multi-user support, and a push relay if you ever distribute the app.

### 8.12 Definition of done

A ticket is done when all of these hold:

- It is merged with tests at the right layer (section 8.4).
- Lint and type checks are clean.
- UI work renders correctly in both dark and light mode and passes the grayscale check (section 9.12).
- No new daemon dependency was added without a line in an ADR.
- The CHANGELOG has an entry.

A milestone is done when its exit test passes on the real server and you've recorded a short screen capture of it.

### 8.13 Cut lines

| Phase | Cut first | Cut if still behind | Never cut |
|---|---|---|---|
| 1 | Web search tool; QR on web (keep terminal QR) | Model-switch history degradation (lock the model per session) | Replay, resume, idempotency, chaos tests |
| 2 | ACP bridge; terminal stream | Compaction (keep sessions shorter) | Approvals, checkpoints, egress proxy, sandbox tests |
| 3 | Live Activity | Diff viewer | Push approvals, golden-stream parity |
| 4 | MCP (skills only) | Document previews (download only) | Uploads and outputs |

Applying every "cut first" item saves about 4 weeks, bringing v1 to roughly 14 weeks.

### 8.14 Design workflow

Claude Design runs in four passes, each timed so screens exist just before you build them:

| Pass | Week | Scope |
|---|---|---|
| 1 | 1 | Design system page and the desktop Code session |
| 2 | 4 | Remaining desktop screens, including Providers, Server & Devices, and Connect |
| 3 | 9 | All mobile screens |
| 4 | 13 | Cowork refinements, engine picker, policy editor |

The handoff rule: Claude Design explores, but `design/tokens.json` is the source of truth. If a design uses a value that isn't a token, either add the token deliberately or change the design.

Review every pass against four checks:

- Dark and light parity.
- No hue outside the danger and diff tokens.
- Statuses readable in a grayscale screenshot.
- Touch targets of at least 44 pt on mobile.

### 8.15 Release, deployment and operations

**Versioning.** The daemon uses semver. The protocol has an integer version, and the server supports the current and previous versions. Clients outside that range show "Server update needed" rather than misbehaving.

**Install.** `install.sh` does the following:

- Creates an `outpost` system user.
- Installs uv, Docker and gVisor, and registers `runsc` as a Docker runtime.
- Writes the systemd unit, with the vault key as a systemd credential.
- Configures `tailscale serve`.

**Updates.** `outpostd update` fetches a tagged release, backs up the database, runs migrations and restarts. Sessions that were running come back as `interrupted`, and you get a push notification so you can resume them.

**Backups.** Nightly, the daemon takes an online SQLite backup and a tarball of the workspaces (excluding dependency folders), and sends both to S3-compatible storage. Do a restore drill once a month; a backup you've never restored is a guess.

**Observability.** Logs are structured JSON tagged with `session_id` and `seq`. `/v1/health` and `/v1/metrics` power the Server screen. OpenTelemetry export is optional.

**Runbook entries** to write during hardening:

- Rotate a provider key.
- Revoke a lost phone.
- Restore from backup.
- Force-cancel a stuck session.
- Recover from a full disk by pruning worktrees and images.

### 8.16 Decision records

Keep ADRs in `docs/adr/` as short files with three parts: context, decision, consequences. The initial set:

| ADR | Decision |
|---|---|
| 001 | Daemon language: Python vs TypeScript |
| 002 | Code-mode engine strategy: native-first vs ACP-first |
| 003 | Sandbox tier: gVisor vs microVM |
| 004 | Canonical history format: Open Responses items |
| 005 | Device protocol separate from ACP |
| 006 | SQLite as the only store for v1 |
| 007 | Tailscale-only networking for v1 |

### 8.17 Weekly rhythm

- **Monday:** pick the next tickets in dependency order.
- **Friday:** record a two-minute demo of whatever works end to end, then update the CHANGELOG and any ADRs.
- **Throughout the week:** add friction you hit while dogfooding to a papercuts list. Spend Friday afternoon fixing the top three.

If a ticket runs past twice its estimate, stop and decide: cut it, split it, or write an ADR explaining why the estimate was wrong.

---

## 9. Ink design system

### 9.1 Principles

**Contrast, not color.** The interface has no accent hue. Hierarchy comes from contrast, weight, spacing and inversion (filled vs outlined). The "ink" is the highest-contrast color available: near-white on graphite in dark mode, near-black on paper in light mode.

**One loud element.** "Needs you" is the only element allowed to be loud, because an approval waiting on you is the moment the whole multi-device design exists for. Everything else stays quiet so that it stands out.

**Quiet chrome, readable content.** Chrome recedes into text-2 and text-3 so the conversation, code and documents carry the page.

**Two hues, strictly scoped.** Danger red marks failures and destructive actions. A muted green/red pair appears only inside diffs and +/− counts. Nothing else gets color.

**Parity and grayscale legibility.** Every screen is designed in dark and light. Every status must still read correctly in a grayscale screenshot.

### 9.2 Color tokens

Contrast ratios are measured against `bg` in each mode. ⚑ marks the values changed in v2 after the contrast checks.

| Token | Dark | Light | Use | Contrast (dark / light) |
|---|---|---|---|---|
| `bg` | `#0F1011` | `#FAFAF9` | App background | — |
| `surface` | `#16171A` | `#FFFFFF` | Panels, inputs, composer | — |
| `raised` | `#1C1D21` | `#F4F4F2` | Cards, popovers, approval card, expanded tool output | — |
| `border` | `#26282C` | `#E6E6E3` | Dividers, card outlines (decorative) | — |
| `border-strong` | `#34363B` | `#D4D4D0` | Panel edges, secondary button outlines | — |
| `control-border` ⚑ new | `#686B72` | `#8A8C88` | Input, checkbox, radio and toggle outlines | 3.57 / 3.25 (non-text, ≥3:1) |
| `text` | `#EDEDEF` | `#111113` | Primary text | 16.29 / 18.06 |
| `text-2` | `#A1A3A8` | `#5C5E63` | Secondary text, tool verbs, metadata on `raised` | 7.55 / 6.21 |
| `text-3` ⚑ | `#7C7F86` | `#717379` | Metadata, timestamps, placeholders on `bg`/`surface` | 4.75 / 4.54 |
| `text-disabled` ⚑ new | `#6B6E75` | `#8E9096` | Disabled controls only (exempt from contrast rules) | 3.73 / 3.06 |
| `ink` | `#EDEDEF` | `#111113` | Primary fills, focus ring, running arc, "Needs you" pill | — |
| `on-ink` | `#0F1011` | `#FFFFFF` | Text and icons on ink | 16.29 / 18.86 |
| `ink-subtle` | `rgba(237,237,239,0.08)` | `#ECECEA` | Selected rows, hover | text on it: 13.63 / 15.94 |
| `danger` ⚑ light | `#F2555A` | `#C42636` | Failures, destructive actions | 5.64 / 5.47 |
| `diff-add-fg` / `-bg` | `#7FD1A8` / `rgba(127,209,168,0.10)` | `#1F7A4D` / `#E8F5EE` | Added lines, +N counts | fg on its bg: 8.88 / 4.74 |
| `diff-del-fg` / `-bg` | `#F2888C` / `rgba(242,85,90,0.10)` | `#B4232F` / `#FCEBEC` | Removed lines, −N counts | fg on its bg: 7.12 / 5.66 |

### 9.3 Color usage rules

**Text colors by role.**

- `text` is for anything the user reads as content.
- `text-2` is for supporting labels.
- `text-3` is for metadata, but only on `bg` and `surface`. On `raised` it drops to about 4.2:1, so use `text-2` for small text there.
- `text-disabled` is never used for anything that is not actually disabled.

**Ink fills.** Ink fills are reserved for three things:

- The single primary action in a view.
- The "Needs you" pill.
- The focus ring.

Two filled ink buttons side by side mean one of them is wrong.

**Danger.** Danger appears as text or a small dot for failures. As a fill, it only appears on confirmation buttons for irreversible actions, such as "Delete workspace". White text on light-mode danger measures 5.71:1, and dark text on dark-mode danger 5.64:1.

### 9.4 Typography

The typefaces are Geist Sans and Geist Mono, both under the SIL Open Font License, bundled in the web app and the iOS app.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `caption` | 12 / 16 | 400 | Badges, timestamps, capability pills |
| `small` | 13 / 18 | 400 or 500 | Sidebar rows, tool rows, dense UI |
| `body` | 14 / 20 | 400 | Desktop default |
| `prose` | 14 / 22 desktop, 16 / 26 mobile | 400 | Assistant messages and documents (more leading for reading) |
| `body-lg` | 16 / 24 | 400 | Mobile default |
| `title` | 20 / 28 | 600 | Screen and section titles |
| `display` | 28 / 34, −0.01em | 600 | Home screen and empty states only |
| `mono-sm` | 12 / 18 | 400 | Paths, model names, IDs, token counts |
| `mono` | 13 / 20 | 400 | Code, commands, diffs, terminal |

Use weight 500 for emphasis inside UI and weight 600 only for titles. Use sentence case everywhere, never all caps. Keep assistant prose to a maximum width of 720 px.

On iOS, register the fonts with `Font.custom(_:size:relativeTo:)` so they scale with Dynamic Type.

### 9.5 Spacing, radius, borders and elevation

**Spacing** follows a 4-point scale: `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-5` 20, `space-6` 24, `space-8` 32, `space-10` 40, `space-12` 48.

**Radius** varies with element size, so the UI never looks like one shape stamped everywhere:

- `radius-sm` 4: checkboxes and inner badges.
- `radius-md` 6: buttons, inputs, rows.
- `radius-lg` 10: cards, panels, the composer.
- `radius-xl` 14: the top corners of mobile sheets.
- `pill`: status pills and the server chip.

**Borders** are always 1 px hairlines. The focus ring is a 2 px ink outline with a 2 px offset.

**Elevation** has only three levels:

- `e0` is flat, used for almost everything.
- `e1` is for popovers and menus: `raised` fill, `border-strong`, and a shadow of `0 8px 24px` at 35% black in dark mode or 10% ink in light mode.
- `e2` is for sheets and modals: the same, with a `0 16px 48px` shadow.

### 9.6 Iconography

Icons come from Lucide, with a 1.5 px stroke. They are 16 px on desktop and 20 px on mobile, colored `text-2` by default and `text` when active.

Mode icons are `message-square` for Chat, `file-text` for Cowork and `code-xml` for Code. Status glyphs are custom (section 9.8), because they need to animate and stay legible at 12 px.

### 9.7 Motion

| Token | Value | Use |
|---|---|---|
| `dur-fast` | 120 ms | Hover, press |
| `dur-base` | 160 ms | Expand and collapse, tab switch |
| `dur-slow` | 180 ms | Sheets, popovers |
| `ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Everything that enters |
| `spin` | 1.2 s linear, infinite | Running arc |
| `pulse` | 1.6 s ease-in-out, infinite | "Needs you" dot (opacity 1 → 0.45) |
| `stream-in` | 120 ms opacity fade per chunk | Streaming text |

When reduced motion is enabled, the arc becomes a static three-quarter ring, the pulse stops, and fades become instant.

### 9.8 Status system

| Status | Glyph | Label | Color | Motion | Accessibility label |
|---|---|---|---|---|---|
| Running | 12 px arc, 1.5 px stroke | Optional elapsed time | `ink` on `border-strong` track | `spin` | "Running" |
| Needs you | 8 px filled dot + inverted pill | "Needs you" | Pill in `ink` / `on-ink` | `pulse` on the dot | "Needs your approval" |
| Done | 12 px check | — | `text-2` | None | "Done" |
| Failed | 8 px dot | "Failed" | `danger` | None | "Failed" |
| Interrupted | 12 px hollow circle | "Interrupted" | `text-3` | None | "Interrupted, can resume" |
| Idle | None | — | — | — | — |

The glyph shapes differ from each other (arc, dot plus pill, check, dot plus label, hollow circle), so status reads correctly with no color at all.

### 9.9 Components

| Component | Anatomy and sizes | States and rules |
|---|---|---|
| Button | Heights 28 (sm), 32 (default desktop), 44 (mobile). Horizontal padding 10 / 12 / 16. Label `small` at 500 weight; optional 16 px icon. | **Primary:** ink fill, on-ink text; hover 90% opacity, pressed 80%. **Secondary:** transparent, `border-strong`, `text`; hover `ink-subtle`. **Ghost:** transparent, `text-2`; hover `ink-subtle` + `text`. **Danger:** danger text; danger fill only for irreversible confirmations. **Disabled:** `text-disabled`, no fill. |
| Input | Height 32 desktop, 44 mobile. `surface` fill, `control-border`, `radius-md`. Placeholder in `text-3`. | Focus: border becomes `ink` plus focus ring. Error: danger border plus a helper line in danger. Secrets are masked with a reveal toggle. |
| Segmented control (modes) | Container in `raised` with `border`, 2 px inset. Segments 28 high, icon plus label. | Selected: `surface` fill, `border-strong`, `text` at 500. Unselected: `text-2`. Never ink-filled; the loudness budget belongs to "Needs you". |
| Session row | Desktop 32 high: glyph, title in `small`, workspace in `mono-sm` `text-3`. Mobile 60 high, two lines: title in `body-lg`, then workspace, elapsed time and model in `caption`. | Selected: `ink-subtle` plus a 2 px ink bar on the left edge. Hover: `ink-subtle`. A "Needs you" pill replaces the metadata on the right. |
| Tool-call row | 28 high: 14 px icon in `text-3`, verb in `text-2`, target in `mono-sm` `text`, right-aligned summary (e.g. `+146 −27` in diff colors), chevron. | Expanded: output in a `raised` panel, `mono`, capped at 12 lines with "Show all". Errors show a danger dot plus the first error line. |
| Approval card | `raised`, `border-strong`, `radius-lg`, padding 16. Title "Approval needed" plus a risk pill (Low / Medium / High). Command block in `mono` on `bg` with `border`. | Actions: Approve (primary), Deny (secondary), "Always allow in this workspace" (ghost). Footer "Also sent to iPhone" in `caption` `text-2`. After resolution it collapses to one line: "Approved on iPhone, 14:02". High-risk commands show the risk pill in danger text. |
| Model picker | Trigger shows `provider / model` in `mono-sm`. Popover (`e1`) grouped by provider. | Each model shows capability pills (tools, vision, reasoning, context size) in `caption` with a `border` outline, plus an agentic-grade pill. Unavailable models are shown as disabled with the reason. |
| Server chip | Pill, `border`, `mono-sm`: name, state, latency. | Connected: ink dot. Reconnecting: spinning arc plus "Reconnecting". Offline: danger dot plus "Offline", and clicking opens diagnostics. |
| Composer | `surface`, `border-strong`, `radius-lg`. Text area in `body`, growing to 40% of the viewport. Toolbar: attach, workspace, model, permission level, send. | Send is a 32 px primary icon button, disabled while empty. While running, send becomes a secondary "Stop" button. |
| Diff view | Line numbers in `mono-sm` `text-3`, code in `mono`. | Added and removed lines use the diff tokens. Hunk headers sit in `raised` with `text-2`. Unchanged context lines are in `text-2`. |
| File output card | `raised`, `radius-lg`: file type icon, name in `small` at 500, size and time in `caption`. | Hover shows Open and Download. The preview opens in the right pane on desktop and as a sheet on mobile. |
| Toast | `raised`, `border`, `radius-md`, `small`, bottom-left on desktop, top on mobile. | Neutral by default; a danger variant for failures. Disappears after 4 seconds unless it contains an action. |
| Empty state | `display` or `title`, one line of `text-2`, one primary action. | Tells the user what to do next, never how they should feel. |

### 9.10 Layout

**Desktop.**

- A title bar 44 high.
- A left sidebar 264 wide, collapsible to 56.
- A center pane with a minimum width of 560, and conversations capped at 760.
- A right pane 480 by default, resizable from 360 to 720.

**Desktop breakpoints.**

- 1280 and up: all three panes.
- 1024 to 1279: the right pane overlays the center.
- Below 1024: the sidebar collapses to icons.

**Mobile.**

- 16 pt side padding and safe-area insets.
- List rows 60 high.
- The composer is sticky above the keyboard.
- Sheets have 14 pt top radius and a grabber.
- Every touch target is at least 44 pt.

### 9.11 Code and diff theme

The code theme is grayscale by design, so the only color in a Code session is the diff.

| Syntax role | Treatment |
|---|---|
| Keywords | `text`, bold (Monaco only supports normal or bold) |
| Identifiers | `text` |
| Strings | `text-2` |
| Numbers and constants | `text` |
| Comments | `text-3` |
| Punctuation | `text-2` |

The editor background is `surface`, the gutter uses `text-3` for line numbers, the selection is `ink-subtle`, and the cursor is `ink`. Define two Monaco themes, `outpost-ink-dark` and `outpost-ink-light`, generated from the tokens. Apply the same mapping to xterm.js, with ANSI colors collapsed to grays except red, which maps to `danger`.

### 9.12 Accessibility

- All text passes WCAG AA at the sizes it is used, following the rules in section 9.3.
- Form controls meet 3:1 through `control-border`.
- Status is never color-only (section 9.8).
- Focus is always visible.
- Reduced motion is respected everywhere.
- iOS supports Dynamic Type up to the accessibility sizes, and every glyph has a VoiceOver label.

The **grayscale check** is part of the definition of done: take a screenshot, desaturate it, and confirm every status and every primary action is still identifiable.

### 9.13 Implementation: one token file, two clients

`design/tokens.json` is the single source. `design/build_tokens.py` (about 80 lines, run by `make gen`) writes `clients/web/src/styles/tokens.css`, `clients/ios/Outpost/Design/Tokens.swift`, and the Monaco and xterm themes. CI fails if the generated files are stale.

```json
{
  "color": {
    "bg":             { "dark": "#0F1011", "light": "#FAFAF9" },
    "surface":        { "dark": "#16171A", "light": "#FFFFFF" },
    "raised":         { "dark": "#1C1D21", "light": "#F4F4F2" },
    "border":         { "dark": "#26282C", "light": "#E6E6E3" },
    "border-strong":  { "dark": "#34363B", "light": "#D4D4D0" },
    "control-border": { "dark": "#686B72", "light": "#8A8C88" },
    "text":           { "dark": "#EDEDEF", "light": "#111113" },
    "text-2":         { "dark": "#A1A3A8", "light": "#5C5E63" },
    "text-3":         { "dark": "#7C7F86", "light": "#717379" },
    "text-disabled":  { "dark": "#6B6E75", "light": "#8E9096" },
    "ink":            { "dark": "#EDEDEF", "light": "#111113" },
    "on-ink":         { "dark": "#0F1011", "light": "#FFFFFF" },
    "ink-subtle":     { "dark": "rgba(237,237,239,0.08)", "light": "#ECECEA" },
    "danger":         { "dark": "#F2555A", "light": "#C42636" },
    "diff-add-fg":    { "dark": "#7FD1A8", "light": "#1F7A4D" },
    "diff-add-bg":    { "dark": "rgba(127,209,168,0.10)", "light": "#E8F5EE" },
    "diff-del-fg":    { "dark": "#F2888C", "light": "#B4232F" },
    "diff-del-bg":    { "dark": "rgba(242,85,90,0.10)", "light": "#FCEBEC" }
  },
  "space":  { "1": 4, "2": 8, "3": 12, "4": 16, "5": 20, "6": 24, "8": 32, "10": 40, "12": 48 },
  "radius": { "sm": 4, "md": 6, "lg": 10, "xl": 14, "pill": 999 },
  "motion": { "fast": 120, "base": 160, "slow": 180, "ease-out": [0.2, 0, 0, 1] },
  "font":   { "sans": "Geist", "mono": "Geist Mono" }
}
```

Generated CSS (excerpt). It follows the system theme by default, and the user can override it in settings:

```css
:root, [data-theme="light"] {
  --bg: #FAFAF9; --surface: #FFFFFF; --raised: #F4F4F2;
  --text: #111113; --text-2: #5C5E63; --text-3: #717379;
  --ink: #111113; --on-ink: #FFFFFF; --danger: #C42636;
  /* … */
}
[data-theme="dark"] {
  --bg: #0F1011; --surface: #16171A; --raised: #1C1D21;
  --text: #EDEDEF; --text-2: #A1A3A8; --text-3: #7C7F86;
  --ink: #EDEDEF; --on-ink: #0F1011; --danger: #F2555A;
  /* … */
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* same values as [data-theme="dark"] */ }
}
```

Generated Swift (excerpt):

```swift
import SwiftUI

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

enum Ink {
    static let bg      = Color(light: 0xFAFAF9, dark: 0x0F1011)
    static let surface = Color(light: 0xFFFFFF, dark: 0x16171A)
    static let text    = Color(light: 0x111113, dark: 0xEDEDEF)
    static let text2   = Color(light: 0x5C5E63, dark: 0xA1A3A8)
    static let text3   = Color(light: 0x717379, dark: 0x7C7F86)
    static let ink     = Color(light: 0x111113, dark: 0xEDEDEF)
    static let onInk   = Color(light: 0xFFFFFF, dark: 0x0F1011)
    static let danger  = Color(light: 0xC42636, dark: 0xF2555A)
    // …
}
```

---

## 10. Security checklist

| Area | Rule |
|---|---|
| Secrets | Encrypted vault in the daemon. Never in sandbox env, files or mounts. The egress proxy injects auth. |
| Isolation | gVisor minimum; microVM where KVM exists. CPU, memory, pids and disk quotas per workspace. |
| Network | Default-deny egress from sandboxes with a per-workspace allowlist. Daemon bound to Tailscale only. |
| Approvals | Risky tool calls pause for approval. Policy changes are logged as events. |
| Devices | Per-device keys, fingerprint pinning, revocation, last-seen visible in the UI. |
| Supply chain | Hashed lockfile, minimal daemon dependencies, no auto-updating packages in the key-holding process, pinned image digests. |
| Prompt injection | Treat fetched content as data. Show the source of instruction-like content. Tool output never changes policy. |
| Audit | The event log is the audit log, exportable per session. |
| Backups | Nightly database and workspace backups, with a monthly restore drill. |

---

## 11. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Model quality varies widely | Loops tuned on frontier models fall apart on small ones | Eval suite; `agentic_grade` badge in the model picker; fewer tools for weak models |
| Scope | This is three products | Phase gates, exit tests, cut lines (section 8.13) |
| Competition moves fast | Agent Canvas ships releases weekly; Anthropic's own remote features exist | Differentiate on mobile, Cowork and unified UX; reuse ACP engines rather than racing them |
| Protocol churn | MCP just shipped a breaking revision; ACP remote transport is still an RFD | Protocol code isolated behind adapters; official SDKs |
| Security | One process holds every credential and runs untrusted agent code | Section 10, with the sandbox tests in CI |
| Push relay | Needed if you ever distribute the app | Stay single-user at first; build a tiny relay when needed |
| Running cost | A 24/7 server plus tokens | Usage table from day one; per-session cost in the UI |
| Estimate slip | Solo projects routinely run long | Twice-estimate stop rule (section 8.17); a two-week buffer; cut lines |

---

## 12. Open decisions

1. Product name.
2. Python or TypeScript daemon (ADR-001).
3. Native-first or ACP-first Code mode (ADR-002).
4. Hosting: a normal VPS or EC2 instance with gVisor, or a bare-metal or home box with microVMs (ADR-003).
5. Single-user forever, or multi-user later.
6. Open source or closed.

---

## 13. Claude Design prompt (v2)

Paste this into Claude Design and attach the two reference screenshots, telling it they are for layout only. Follow the four-pass schedule in section 8.14. This version carries the v2 tokens.

```
Design a desktop and mobile app called "Outpost" (working name): a model-agnostic
AI agent workspace where all agents run on the user's own remote server. The
desktop and mobile apps are thin clients that connect to that server. One app
contains three modes: Chat (conversation), Cowork (knowledge work that produces
documents), and Code (coding agent with repo, diffs, terminal). Sessions keep
running on the server when devices disconnect, and progress is visible live on
both laptop and phone. The user brings their own LLM providers (Anthropic,
OpenAI, Google, OpenRouter, local Ollama).

The attached screenshots show an existing agent app. Use them ONLY as a
reference for information architecture (sidebar with sessions, composer, file
tree + editor pane, edited-files summary). Do not copy their visual style,
typography, or colors.

DESIGN SYSTEM: "Graphite / Ink"
Minimalist, calm, precise, keyboard-first. The interface has no accent hue.
Graphite neutrals only. The "accent" is the highest-contrast ink: near-white
in dark mode, near-black in light mode. Hierarchy comes from contrast, weight,
spacing, and inversion (filled vs outlined), never from color. The only hues
allowed are danger red (failures, destructive actions) and a muted green/red
pair used strictly inside diff views and +/− line counts.

Dark mode tokens:
  bg #0F1011 · surface #16171A · raised #1C1D21
  border #26282C · border-strong #34363B · control-border #686B72
  text #EDEDEF · text-2 #A1A3A8 · text-3 #7C7F86 · text-disabled #6B6E75
  ink (accent) #EDEDEF · on-ink #0F1011 · ink-subtle rgba(237,237,239,0.08)
  danger #F2555A
  diff-add fg #7FD1A8 on rgba(127,209,168,0.10)
  diff-del fg #F2888C on rgba(242,85,90,0.10)
Light mode tokens:
  bg #FAFAF9 · surface #FFFFFF · raised #F4F4F2
  border #E6E6E3 · border-strong #D4D4D0 · control-border #8A8C88
  text #111113 · text-2 #5C5E63 · text-3 #717379 · text-disabled #8E9096
  ink (accent) #111113 · on-ink #FFFFFF · ink-subtle #ECECEA
  danger #C42636
  diff-add fg #1F7A4D on #E8F5EE
  diff-del fg #B4232F on #FCEBEC

Color rules: text-3 is for metadata on bg/surface only; use text-2 for small
text on raised. text-disabled is only for disabled controls. control-border
outlines inputs, checkboxes and toggles. Ink fills are reserved for the single
primary action in a view, the "Needs you" pill, and the focus ring.

Primary buttons are inverted ink (white fill in dark, black fill in light).
Secondary buttons are outlined with border-strong. Selected rows use
ink-subtle plus a 2px ink bar on the left edge. Focus ring: 2px ink outline,
2px offset. Syntax highlighting is grayscale: keywords in text (bold),
identifiers in text, strings in text-2, comments in text-3. Only diff lines
get color.

Typography: Geist Sans for UI, Geist Mono for code, file paths, model names,
commands, token counts, and IDs. Scale 12/13/14/16/20/28. Base size 14 on
desktop, 16 on mobile; assistant prose uses extra leading (14/22 desktop,
16/26 mobile). Weights 400/500/600 only. No serif type anywhere. No all-caps
labels; sentence case everywhere.
Shape: 4pt spacing grid; radius 4 (checkboxes), 6 (controls, rows), 10
(cards, panels, composer), 14 (mobile sheet tops), pill (status). 1px
hairline borders instead of shadows; soft shadow only on popovers and sheets.
Lucide icons, 1.5px stroke, 16px desktop / 20px mobile.
Motion: 120–180ms ease-out. Streaming text fades in. The running indicator is
a slowly rotating ink arc. Respect reduced motion.

Session status system (used everywhere; must work without color):
  Running → rotating ink arc
  Needs you (approval pending) → inverted "Needs you" pill (ink fill, on-ink
    text) with a filled dot that pulses softly. This is the loudest element in
    the whole UI, on purpose.
  Done → check in text-2
  Failed → danger dot + "Failed" label in danger
  Interrupted → hollow circle in text-3
Modes are distinguished by icon and label, never by color.

HARD RULES: No accent hue of any kind: no orange, blue, green, violet, yellow,
or pink outside the danger and diff tokens. No gradients, no glassmorphism, no
emoji, no illustrations. Do not resemble Claude or ChatGPT branding. Use
realistic content, never lorem ipsum.

COMPONENTS (show on a design-system page first):
buttons (primary ink, secondary, ghost, danger); inputs; segmented mode
switcher (Chat / Cowork / Code) whose selected segment is a surface fill with
border-strong, never ink; model picker showing "provider / model" in mono with
capability badges (tools, vision, reasoning, 200k); server chip
("outpost-01 connected 38 ms"); session row with status glyph; collapsed
tool-call rows ("Read src/FilterBar.tsx", "Edited 3 files +146 −27",
"Ran pnpm test ✓ 11/11"); approval card (command in mono, risk label, Approve /
Deny / Always allow in this workspace, and a resolved state "Approved on
iPhone, 14:02"); file output card; composer with attach, workspace picker,
model picker, permission level; toast; empty state.

DESKTOP SCREENS (1440×900, each in dark AND light):
1. Home: centered composer with mode switcher, workspace and model pickers;
   recent sessions with live statuses; server chip in the top bar.
2. Code session: left sidebar (264px) of sessions grouped by workspace; center
   conversation (max 760px) with collapsed tool rows; right pane (480px) with
   tabs Files / Diff / Terminal / Preview. Header shows session title,
   worktree branch, and an "Undo turn" checkpoint control. Sample task:
   fixing a filter-chip sync bug in a React app.
3. Code session, approval state: inline approval card for
   "git push origin fix/filter-sync", with a subtle note "Also sent to iPhone".
4. Cowork session: conversation plus a right "Outputs" pane with generated
   file cards (Q3_Report.docx, pipeline.xlsx, summary.md), a workspace folder
   browser, and an upload drop zone.
5. Chat session: single centered column, max width 720px, no right pane.
6. Settings → Providers: provider list with connection status; add-provider
   form (base URL, masked API key, "Test connection" result); model list with
   capability badges; default model per mode.
7. Server & Devices: host health (CPU, memory, disk, uptime); running
   sessions; workspaces with container status; paired devices (MacBook Pro,
   iPhone) with last seen and revoke; "Pair new device" QR panel.
8. Connect to server (first run): server URL or scan QR, fingerprint
   confirmation step.

MOBILE SCREENS (iPhone, 390×844, each in dark AND light):
1. Sessions list grouped into Needs you / Running / Recent. Each row (60pt)
   shows mode icon, title, workspace, elapsed time, and model. Server chip at
   top.
2. Live session view: streaming conversation, collapsed tool rows, sticky
   composer, and a continuity line "Started on MacBook, running 12 min".
3. Approval bottom sheet: command, diff summary, large Approve / Deny targets
   (minimum 44pt).
4. Read-only diff viewer.
5. Lock screen: push notification for an approval request plus a Live
   Activity showing a running session's current step.
6. Pair device via QR scan.

Start with the design-system page, then Desktop screen 2 (Code session), then
the rest.
```

Screens planned for design pass 4: an engine picker ("Native agent" vs ACP engines such as Claude Code), a workspace policy editor (three approval tiers plus saved rules), and a per-session cost and usage panel.

---

## 14. Sources

- OpenCode server docs: https://opencode.ai/docs/server/
- OpenHands Agent Canvas: https://github.com/OpenHands/OpenHands and https://www.openhands.dev/product/canvas
- OpenHands mobile (MVP): https://github.com/OpenHands/openhands-mobile
- Happy: https://github.com/slopus/happy
- ACP: https://zed.dev/acp, https://github.com/agentclientprotocol, https://agentclientprotocol.com/get-started/registry
- ACP remote transport RFD: https://agentclientprotocol.com/rfds/streamable-http-websocket-transport
- Open Responses: https://www.openresponses.org/ and https://docs.agno.com/reference/models/open-responses
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- LiteLLM incident: https://docs.litellm.ai/blog/security-update-march-2026 and https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/
- Sandboxing overview: https://northflank.com/blog/how-to-sandbox-ai-agents
- Docker Sandboxes: https://www.docker.com/products/docker-sandboxes/ and https://docs.docker.com/ai/sandboxes/install/
- Live Activities push updates (WWDC23): https://developer.apple.com/videos/play/wwdc2023/10185/
- Contrast ratios computed with the WCAG 2.x relative-luminance formula; alpha tokens are blended over `bg` before measuring.
