# OpenClaw, T3 Code, Hermes, and Pi extensions → Outpost: feature adoption analysis

**Initial analysis date:** 29 October 2026 · **Remote/networking rescan:** 30 October 2026

**Deliverable:** detailed product and engineering recommendations, not an implementation or an approved replacement specification.

**Recommendation:** selectively borrow OpenClaw's operator patterns, T3 Code's coding and synchronization workflows, and Hermes' memory, skill, and automation practices. Extend Outpost's server-owned architecture; do not embed any of these runtimes.

**Actionable backlog:** [40 detailed adoption tickets](tickets/README.md), with dependencies, acceptance criteria, upstream source files, and Outpost integration seams. All tickets are proposed, not implementation commitments. Sections 1–10 preserve the original OpenClaw analysis; sections 11–13 add T3/Hermes findings; section 14 adds Pi extension features; section 15 and the [remote-connectivity rescan](T3-REMOTE-CONNECTIVITY-ANALYSIS.md) cover the newer T3 snapshot's Connect, Tailscale, routing, host placement, peer delegation, and provider hubs. The filename is retained for existing links.

## Contents

1. [Executive recommendation](#1-executive-recommendation)
2. [Scope, evidence, and limitations](#2-scope-evidence-and-limitations)
3. [What Outpost already has](#3-what-outpost-already-has)
4. [Prioritized opportunity map](#4-prioritized-opportunity-map)
5. [Detailed feature recommendations](#5-detailed-feature-recommendations)
6. [Shared architecture and data contracts](#6-shared-architecture-and-data-contracts)
7. [Delivery sequence and acceptance gates](#7-delivery-sequence-and-acceptance-gates)
8. [What not to copy](#8-what-not-to-copy)
9. [Reuse, licensing, and maintenance](#9-reuse-licensing-and-maintenance)
10. [Source register](#10-source-register)
11. [T3 Code findings](#11-t3-code-findings)
12. [Hermes findings](#12-hermes-findings)
13. [Combined adoption plan](#13-combined-adoption-plan)
14. [Pi subagent and Ollama Cloud extensions](#14-pi-subagent-and-ollama-cloud-extensions)
15. [T3 remote access and load-balancing rescan](#15-t3-remote-access-and-load-balancing-rescan)

---

## 1. Executive recommendation

OpenClaw is useful to Outpost primarily as a reference for operating a persistent agent: how work enters the system, waits for capacity, survives interruptions, finds knowledge, invokes integrations, and reports outcomes. Its value is not simply that it has many tools.

Outpost already has durable tasks, device-signed commands, a common action gate, exact-action approvals, artifacts, a Pi runtime, headless browser execution, host execution, and a live desktop interface. Replacing these with an OpenClaw Gateway would introduce competing owners for tasks, permissions, sessions, schedules, and delivery.

The best path is **Outpost-native implementation of selected OpenClaw behaviors**, with narrowly scoped code reuse where practical.

### Highest-value additions

- **Durable input queues and capacity scheduling:** make steering, follow-ups, cancellation, and concurrent tasks predictable.
- **Context management:** keep long-running tasks usable; Outpost currently disables automatic compaction.
- **Operational diagnostics:** explain failures and offer bounded repair actions before adding more autonomous behavior.
- **Richer automations:** turn existing interval schedules into calendar-aware, observable, permission-bound recurring work.
- **Hybrid memory and usable skills:** make existing knowledge and capability foundations available to the actual runtime.
- **An attention-oriented task board:** expose what is running, blocked, awaiting approval, or ready for review.
- **Browser continuity:** persistent task/identity profiles and a real human handoff, rather than only completion screenshots.

After those foundations, add connectors, durable recipes, and bounded specialist workers. Messaging channels are useful secondary entrances, but should not replace the Mac/iPhone clients as the trusted control surface.

### Three adoption strategies

| Strategy | Benefit | Cost/risk | Judgment |
|---|---|---|---|
| Implement the behaviors inside Outpost | Preserves policy, ledger, clients, and deployment choices | More deliberate integration work | **Recommended default** |
| Reuse small OpenClaw algorithms or adapters | Can save work on ranking, scheduling, normalization, and test cases | Dependency extraction, licensing, upstream divergence | Use selectively after an import/dependency audit |
| Embed an entire OpenClaw Gateway or maintain a fork | Fast access to a broad ecosystem | Two runtimes, identities, stores, recovery models, and control planes | Not recommended without an explicit product pivot |

The key product distinction should remain: **Outpost is an evidence-oriented personal operator with a persistent workspace and visible authority**, not a clone of a multi-channel chat assistant.

## 2. Scope, evidence, and limitations

### Repository snapshots

| Repository | Inspected baseline | Working-tree qualification |
|---|---|---|
| OpenClaw | `12c7926d2502b621f30297ac4f176aa5b6fa2fb8` | Working tree reported clean during inspection |
| Outpost | `e9af7395c8358dbac6e5d3bd28d598b55204c8d3` | Clean before this documentation update; contains the previously inspected working-tree changes |
| T3 Code — initial analysis | `cfafb4bb54d244e4612f5681aad3832ea64cb0fb` (16 October 2026) | Historical baseline for section 11; then 2,585 commits behind recorded `origin/main` |
| T3 Code — remote/networking rescan | `2c119bd975deb06f49505a0af3ec8d272806b923` (29 October 2026) | Clean on 30 October; zero commits behind recorded `origin/main`; checkout had changed between reviews, not fetched/updated by this rescan |
| Hermes | `088f657ecf77674c7b8e2ededf4e3576d82e042c` (29 October 2026) | Clean local checkout; not fetched or updated |

The original Outpost inspection used `28014e1` plus uncommitted work; that work is now captured in `e9af739`. Upstream findings apply to these local snapshots, **not necessarily current upstream releases**. Relative sibling-repository links require the checkouts alongside Outpost; commit hashes above identify the evidence revision. T3 links now open the newer local checkout; use the older commit to reproduce initial findings. The focused rescan does not imply every earlier T3 claim was requalified.

### Method

- Read Outpost's README, feature ownership catalogue, architecture/model specifications, acceptance report, desktop documentation, and live-streaming record.
- Inspect current coordinator/runtime wiring and concrete implementations of tasks, policy, scheduling, memory, workers, recipes, capabilities, browser leases, hosts, and backups.
- Read OpenClaw's feature documentation and inspect representative implementation contracts: cron schedules and outcomes, queue options, hybrid search merging, and the Lobster tool adapter.
- Locate relevant upstream owners and tests as implementation starting points.
- Inspect T3's current orchestration-v2 implementation, Pi adapter, checkpoints, stream budgets, connection design, and coding-workflow documentation. Older proposal documents are not treated as the implementation baseline.
- Review Hermes' memory/skills, context accounting, scheduling receipts, tool search/validation, checkpointing, profiles, worker lanes, and representative implementation files. Where source and documentation disagree, retain the qualification rather than infer full correctness.

This is a **static comparative analysis**. No live providers, remote hosts, messaging accounts, payment systems, or application flows were exercised for this document. Existing test results quoted by repository documents remain historical evidence, not tests rerun here. Located tests are references, not a claim that they pass at this checkout.

### Evidence terminology

- **Observed:** visible in the inspected code or documentation.
- **Integrated slice:** current coordinator/runtime/client wiring exposes some usable functionality; this does not imply full qualification.
- **Primitive/library:** implementation exists, but complete runtime and client integration is not established.
- **Proposed:** a recommendation for Outpost, including all new fields, commands, events, and acceptance criteria below.

Older Outpost specifications describe Swift clients, a single physical server, and a Cloud-first model path. Newer working-tree documentation describes a Tauri Mac client, two-host privileged execution, direct Ollama-compatible inference, and Browser-Use. This report uses the newer implementation as the factual baseline while treating unresolved architecture-policy differences as decisions to reconcile—not permission to silently rewrite the original product contract.

## 3. What Outpost already has

| Area | Observed baseline | Actual opportunity |
|---|---|---|
| Tasks | Durable creation, instruction sequence, steer/pause/cancel/resume, checkpoint and restart interruption | Explicit queued-turn lifecycle, capacity limits, safe continuation, branches, richer plan/completion semantics |
| Agent runtime | Pi sessions mapped to task IDs; `outpost_action` routes work through the gate | Skills/resources, bounded context, reliable queue handoff, recovery policies |
| Policy | Three modes, exact action digest, policy revision, expiry, approval decisions, dispatch checks | Stronger end-to-end authority propagation and complete integration—not a second approval system |
| Desktop | Tauri/React content, Rust signing/transport, AppKit sidebar; task creation and evidence | Rich operational views and feature parity with legacy controls |
| Live activity | Authenticated SSE, text and exposed reasoning, tool lifecycle, reconnect snapshots | Queue state, budgets, nested browser/process progress, consolidated diagnostics |
| Scheduling | `nextAt`, fixed intervals, one-shots, pause, skip/coalesce, durable occurrences | Calendar recurrence, overlap policy, event triggers, run/delivery history, budgets |
| Memory | SQLite FTS5, project/identity filters, provenance, forgetting tombstones, rebuild | Runtime retrieval, semantic/hybrid search, correction UI, trustworthy recall |
| Workers | Scope and budget inheritance, depth limit, resource leases, cancellation records | Live worker launch/admission, result delivery, recovery, parent verification |
| Workflows | Dependency validation, readiness, artifact-backed verification | An executable, resumable workflow runner |
| Capabilities | Manifest staging, executable hash checks, probes, activation; tool catalogue primitive | Skills/MCP/package lifecycle and safe runtime loading |
| Browser | Integrated Browser-Use action and output artifacts; separate Playwright observation/lease primitive | Unified profile ownership, persistent sessions, takeover, recovery, structured step evidence |
| Hosts | Explicit authenticated root execution on two configured hosts | Optional general node registry and capability-based routing—not merely adding remote execution |
| Recovery | Unknown-state handling and encrypted ledger/artifact backup with restored dispatch hold | Complete recovery inventory, diagnostics, whole-system rehearsal, selective safe repairs |
| Communications | Draft/calendar primitives, delivery-operation records, APNs implementation | Real provider adapters and opt-in message intake/routing |

### Particularly important implementation observations

1. `server/pi-adapter/runtime.ts` currently returns empty skill, extension, prompt, and agent-file collections from its resource loader. Having a capability library does not mean the running agent can load a skill.
2. The same runtime sets both compaction and retry to disabled. These are deliberate current settings, not capabilities to assume are already active through Pi.
3. `server/gateway/coordinator.ts` registers files, commands, inventory, optional hosts/Browser-Use, artifact text, CSV profiling, and report generation. It does not automatically expose every domain directory as a tool.
4. `Scheduler.tick()` computes future runs using milliseconds. A validated timezone string is not yet wall-clock calendar scheduling or DST behavior.
5. The runtime ends ordinary successful turns in `verifying`, or `waiting_for_approval` when pending actions exist. A finished model turn is not a verified completed task.
6. The current private root-execution deployment is not a sandbox. New automation and connector features amplify that existing risk unless authority and isolation are addressed explicitly.
7. The older acceptance report is valuable but predates newer live-runtime and Tauri work. Its “missing integration” rows must not be treated as a complete description of the current tree.

## 4. Prioritized opportunity map

**P0:** foundation before increasing unattended execution. **P1:** next product-value tranche. **P2:** expansion after foundations. **P3:** optional later capability.

Effort is relative, not a calendar estimate: **M** = bounded subsystem change; **L** = cross-layer feature; **XL** = multiple lifecycle/integration surfaces. Qualification, both-client support, and migration work are included in the judgment.

| ID | Feature | Priority / effort | Outpost baseline | Existing requirement alignment |
|---|---|---|---|---|
| F01 | Durable input queues and capacity lanes | P0 / L | Steering and outbox exist | TASK-05/06, TEAM-05, REL-06 |
| F02 | Context budgeting and compaction | P0 / L | Persistent sessions; compaction disabled | MODEL-06/10, MEM-04, TASK-09 |
| F03 | Model health, bounded retry, approved fallback | P1 / L | Exact selection and role validation | MODEL-02/04/05/08/09 |
| F04 | Calendar automations and event triggers | P1 / L | Interval scheduler integrated | AUTO-01/03/04/07/09/10 |
| F05 | Quiet monitors and standing programs | P2 / L | Change hash primitive | AUTO-02/05/06/08, RUN-10 |
| F06 | Hybrid memory and cited recall | P1 / L | Scoped FTS primitive, save/forget commands | MEM-01/02/03/05/06/07/09 |
| F07 | Skill library and task instruction profiles | P1 / M–L | Runtime skill loading empty | EXT-01/05/06, RUN-10 |
| F08 | Connector bundles and MCP lifecycle | P2 / XL | Manifest/tool primitives | EXT-02/04/07/08/10, PKG-03/07 |
| F09 | Bounded specialist workers | P2 / XL | Scope/budget/lease primitives | TEAM-01 through TEAM-09 |
| F10 | Resumable deterministic recipes | P2 / L | Dependency/evidence primitive | LIFE-09, RUN-10, MODEL-10 |
| F11 | Optional message-channel intake and delivery | P2 / XL | Drafts, notices, delivery primitives | COM-01/04/07/08/10 |
| F12 | Browser profiles, continuity, and handoff | P1 / XL | Browser-Use integrated; lease primitive separate | WEB-04/05/06/09/10, ID-03/04/06 |
| F13 | Doctor, setup checks, and recovery planning | P0 / L | Runbooks, probes, partial backup | REL-01/04/05/09, PKG-07, SYS-10 |
| F14 | Task board and attention inbox | P1 / M–L | Task list, live state, approval inbox | MAC-02/03/04/07, PHONE-01/04 |
| F15 | Paired execution nodes and local companion | P3 / XL | Two fixed root hosts | RUN-07, DEV-10, MAC-08, TEAM-10 |
| F16 | Reviewed procedure learning | P3 / L | Memory/workflow foundations | MEM-08/10, RUN-10, EXT-06 |
| F17 | Usage, latency, and operational diagnostics | P1 / L | Live tool/message events | MODEL-05/07, REL-01/06/08 |

Most recommendations deepen requirements Outpost already owns. The F-identifiers are **analysis references**, not replacements for the existing 270 requirement IDs.

## 5. Detailed feature recommendations

### F01 — Durable input queues and capacity lanes

**OpenClaw reference:** queue modes distinguish steering, sequential follow-ups, collection, and interruption. Per-session serialization coexists with bounded parallelism across sessions and priority-aware capacity. See [O01](#o01-queues-and-capacity).

**Outpost gap:** accepted instructions are durable, but the coordinator largely chooses between steering an active runtime and launching another turn when inactive. There is no equivalent explicit product contract for queued-message state, queue overflow, admission fairness, and shared model/tool capacity.

**User experience**

The composer offers **Steer current work**, **Run after this**, and an explicit **Stop and replace** action. A queued instruction shows its order, accepted time, and whether it is waiting for the current turn or a shared resource. Cancelling one queued instruction does not cancel the active task. The UI never claims a queued request is already executing.

**Functional design**

- Persist an input record before acknowledging acceptance: task, originating device/actor, text/artifact references, requested mode, sequence, authority reference, and lifecycle state.
- Serialize active model turns for a task/session. Starting another task can run concurrently if global/provider capacity permits.
- Start with `steer` and `followup`. Add `collect` only for inputs with compatible source, authority, task, and model settings. Interrupt must remain an explicit user action.
- Use capacity pools for model calls, browser sessions, and host jobs. A queue wait should explain the limiting resource.
- Give foreground work priority, but age background jobs so recurring work cannot starve indefinitely.
- Preserve original input identities during replay. An expired or revoked instruction is cancelled/refused, not reassigned to a newer caller.
- Reject excess queued inputs visibly rather than silently dropping instructions in the first version.

**Integration:** extend `Tasks`, coordinator dispatch, and Pi adapter admission. Reuse the existing ledger/outbox, not OpenClaw's in-process queue as the durable source of truth. Add queue projections to the existing SSE path.

**Safety/recovery:** stopping must prevent queued work from being promoted during cancellation. In-flight external effects remain subject to reconciliation. An accepted instruction is not evidence it reached Pi; maintain that distinction across the ledger/session-store boundary.

**Acceptance:** simultaneous Mac/iPhone input produces one ordered record per idempotency key; only one turn owns a session; cancelled queued work stays cancelled after restart; starvation and capacity limits are tested; revocation before execution prevents new effects.

### F02 — Context budgeting, compaction, and long-task continuity

**OpenClaw reference:** context engines separate ingestion, context assembly, compaction, and after-turn maintenance. The built-in engine preserves recent messages and summarizes older context. See [O02](#o02-context-and-compaction).

**Outpost gap:** persistent Pi sessions exist, but automatic compaction is disabled. Large command outputs, browser results, tool descriptions, and long conversations can exhaust the model context. Stream display caps are not model-context limits.

**User experience**

A context indicator distinguishes available budget, recent conversation, attached evidence, and retrieved material. When compaction occurs, the timeline records a short “Earlier context summarized” event with an inspectable summary. Original evidence remains accessible. The agent can continue a long investigation without pretending forgotten details are current facts.

**Functional design**

1. Measure or conservatively estimate context use against the selected model's effective window; reserve room for the next tool result and response.
2. Store verbose output as artifacts. Give the model bounded excerpts plus retrievable references, not repeated full logs.
3. Build a durable task-state summary: objective, owner constraints, current plan, verified outcomes, unresolved blockers, artifact references, and pending action IDs.
4. Compact older conversational material while preserving recent tool-call/result pairing and references to unfinished work.
5. Record the summary's source range, model/version information, creation time, and a content hash. A summary is derived context, not replacement audit evidence.
6. Retrieve additional evidence on demand. Do not eagerly inject all memory, skills, and source files into every turn.
7. Preserve stable instruction prefixes and session-pinned tool/skill versions where possible.

**Integration:** put policy and durable task-state assembly in Outpost's runtime adapter. Use the pinned Pi session/compaction capabilities after validating their lifecycle rather than importing a second transcript manager. Do not assume Outpost's ledger and Pi's session storage commit atomically.

**Safety/recovery:** summaries cannot grant authority, convert an inference into a verified fact, or make an old approval current. If compaction fails, surface the failure and permit bounded recovery/manual continuation; do not silently truncate the owner's constraints.

**Acceptance:** a deliberately over-window coding or research task continues with preserved requirements; tool pairs remain valid; original evidence is readable; pending approvals still bind to original actions; cancellation during compaction is recoverable.

### F03 — Model health, bounded retries, and approved fallback

**OpenClaw reference:** separate transient recovery, authentication/profile handling, and model fallback; distinguish the model selected by the user from the model that actually answered. Explicit user model choices are strict. See [O03](#o03-model-recovery).

**Outpost gap:** exact model selection and role checks exist, while general runtime retry is disabled. Users need actionable provider failures and controlled recovery, not silent model substitution.

**Functional design**

- Maintain an inventory of exact model IDs, route, role eligibility, observed tool/vision/streaming support, effective context limits, qualification evidence, and last health result.
- Classify errors: transient transport, rate limit, authentication, unavailable model, context overflow, malformed tool protocol, local storage conflict, cancellation, and policy refusal.
- Retry only eligible transient failures with bounded backoff, an overall deadline, and visible attempt status. Honor provider retry guidance when present.
- Keep explicit task model selections strict by default. Owner-approved default selections may use a recorded fallback chain.
- Restrict fallback to qualified models and approved data destinations. A local-to-Cloud or provider change must not happen silently.
- Record selected model, actual attempt model, reason, usage if known, and outcome separately.
- Preserve operator/reviewer role separation. An unavailable Auto reviewer still asks the owner; an operator fallback must not become its own reviewer.

**User experience:** “Waiting for provider capacity; retrying in …”, “Selected model unavailable”, and “Used approved fallback …” are different states. The owner can cancel or choose a new qualified model; a successful fallback does not invisibly change the task's long-term preference.

**Integration:** extend `server/models/` and the Pi adapter, using F01 for admission and F17 for attempt records. Reconcile the older Cloud-only specification with the current direct-Ollama route before defining allowed fallback destinations.

**Safety/recovery:** continue from recorded work rather than replaying an entire effectful prompt. An HTTP timeout after a tool effect is not permission to repeat it. Do not copy provider-refusal escalation behavior; policy refusals should remain terminal unless the user changes the request through an allowed path.

**Acceptance:** rate-limit recovery is bounded; explicit selection remains strict; no tool effect is duplicated; authentication failures name a repair action; reviewer outage never becomes automatic approval; unknown usage is not displayed as zero cost.

### F04 — Calendar automations and authenticated event triggers

**OpenClaw reference:** automations support one-shot, interval, cron, process-exit, and stream schedules, plus webhooks. Execution outcomes and delivery outcomes are distinct. See [O04](#o04-automations-and-webhooks).

**Outpost gap:** one-shots, intervals, skip/coalesce, and durable occurrences already exist. Missing depth includes wall-clock recurrence, overlap rules, event admission, detailed history, and modern desktop editing.

**User experience**

“Every weekday at 08:30, prepare a service-health summary” becomes an explicit schedule preview: timezone, next occurrences, task scope, model choice, budget, output destination, and required approvals. The owner can inspect runs, pause future occurrences, cancel a current run separately, or run once now.

**Functional design**

- Add schedule kinds incrementally: timestamp, fixed interval, calendar/cron, then authenticated event triggers. Defer arbitrary stream-watcher scripts until process supervision is ready.
- Preview several future times before saving. Specify behavior for nonexistent/repeated DST times; do not treat a daily interval as equivalent to a daily wall-clock time.
- Define overlap policy per job: skip, retain one pending run, or allow bounded parallel runs. Default to no overlap for effectful work.
- Preserve occurrence identity and definition revision. Editing a job must not duplicate an occurrence or revive an old grant.
- Support missed-run skip/coalesce, maximum lateness, optional jitter for non-exact work, execution deadline, and budget.
- Capture task/run state separately from output delivery: completed but delivery failed is not a failed computation.
- Webhooks get connector-specific credentials/signature verification, source allowlists, payload limits, replay protection, and durable deduplication. Never accept arbitrary client-selected task authority.
- A “run now” command is separately identified and does not accidentally move the natural next occurrence.

**Integration:** extend `server/scheduler/scheduler.ts`, current signed automation commands, task creation, notices, and desktop automation forms. Keep a single scheduling owner; do not introduce an independent heartbeat timer.

**Safety/recovery:** a schedule is timing, not authority. Revalidate the stored program/task grant at dispatch. An unattended action requiring approval stays pending and creates an inbox item; it does not downgrade the policy to finish the job.

**Acceptance:** DST/clock-change tests, restart catch-up, editing while due, overlapping runs, duplicate webhook delivery, missed delivery, and revoked grants all have explicit recorded outcomes.

### F05 — Quiet monitoring and standing programs

**OpenClaw reference:** heartbeat is scheduler-owned periodic agent work with quiet/no-reply behavior, active hours, busy deferral, and explicit program instructions. Standing orders separate scope, triggers, approval gates, and escalation. See [O05](#o05-heartbeat-and-standing-orders).

**Outpost opportunity:** make the server useful between conversations without turning it into an uncontrolled agent that continually invents work.

**Example:** “Monitor the staging service. Notify me after two failed checks. You may restart this named service once within ten minutes; ask before changing configuration.”

**Functional design**

- Store a structured program: objective, resources, allowed observations/actions, trigger, budget, active hours, notification rules, expiry, and owner approval reference.
- Use ordinary F04 automation occurrences. Prefer deterministic HTTP/service/disk checks; invoke a model only for interpretation or bounded remediation.
- Maintain a baseline and compare meaningful changes, not arbitrary raw text. Add hysteresis/debounce so brief flapping does not create alert storms.
- Distinguish `healthy`, `changed`, `action_needed`, `unknown`, and `check_failed`. Silence must not make a failed check look healthy.
- Send notifications only for configured changes, escalations, overdue checks, or recovery. Expose quiet results in history.
- Bound remediation by exact resources, count, elapsed time, and budget. A failed restart escalates instead of looping.
- Permit snooze/pause with an explicit duration; show when monitoring resumes.

**Integration:** expand `Scheduler.changed()` into a monitor state owner using scheduler occurrences, task execution, and the existing inbox/APNs path. Monitor-specific state is not a second task engine.

**Important adaptation:** OpenClaw's documented standing orders are workspace instructions. In Outpost, readable program instructions must be backed by structured, current server authority. A Markdown sentence saying “you may restart anything” must not itself mint a grant.

**Acceptance:** unchanged healthy checks stay quiet; unavailable probes show unknown/failure; repeated outages produce bounded alerts; expired programs cannot act; owner pause prevents future effects; remediation evidence includes before/after observations.

### F06 — Hybrid memory search and cited recall

**OpenClaw reference:** combine keyword and vector retrieval, rank with relevance/recency/importance, reduce duplicate snippets, and preserve source locations/provenance. Its documented degradation depends on provider configuration, not a blanket promise to always fall back silently. See [O06](#o06-memory-and-retrieval).

**Outpost gap:** FTS already exists, but semantic retrieval and complete runtime/UI integration do not. The current FTS query requires all query terms, which can miss semantically related wording.

**User experience**

Ask “What fixed the last certificate renewal problem?” and receive a concise answer linked to the prior task, command evidence, and dated note. The owner can see why a memory was used, correct it, pin durable instructions, or forget it.

**Functional design**

1. Keep ledger-owned memory items authoritative; build searchable chunks and embeddings as rebuildable indexes.
2. Bind every item to project, identity, source, provenance, confirmation state, timestamps, and retention policy.
3. Use local/self-hosted embeddings initially to align with Outpost's local indexing goals. Show index/model status and rebuild progress.
4. Run lexical and semantic retrieval within authorized scope. Merge scores and optionally diversify repeated snippets. Do not copy upstream ranking constants without an Outpost evaluation set.
5. Keep exact identifiers, file paths, error strings, and command names discoverable through lexical search.
6. Inject only a bounded selection into task context. Imported pages and inferred notes remain untrusted evidence; owner-confirmed items can have a distinct recall policy.
7. Record retrieval provenance so answers can cite source task/artifact/revision instead of presenting an unsupported recollection.
8. Define an explicit degraded mode. If semantic search fails, display “keyword-only” when such fallback is configured; otherwise show unavailable.
9. Forgetting removes active chunks, embeddings, caches, and recall eligibility. Document that retained backups may still contain older data until their retention expires.

**Integration:** extend `server/memory/memory.ts`; register gated search/propose/correct operations; restore full Memory editing in the new desktop; use F02's bounded context assembly.

**Safety/recovery:** memory never grants permission. Scope filters must apply before results are exposed. An embedding-model/dimension change requires a versioned rebuild, not comparisons between incompatible vectors.

**Acceptance:** benchmark exact and paraphrased queries; test cross-project/identity leakage; correct a stale fact; forget then rebuild without resurrection; exercise provider outage and source deletion; citations resolve to evidence visible to the caller.

### F07 — Skill library and task instruction profiles

**OpenClaw reference:** skills are discoverable Markdown instruction packages with precedence, environment gating, and session snapshots. See [O07](#o07-skills-and-procedure-learning).

**Outpost gap:** the current Pi resource loader exposes no skills or agent files. Hardcoded instructions in the adapter describe a small tool set but do not provide reusable domain procedures.

**User experience:** a Skills view lists installed procedures, publisher/source, version, supported tools, readiness, and scope. A task shows which skills were selected. A missing executable or connector is explained rather than discovered through repeated failed tool calls.

**Functional design**

- Load owner-managed and project-approved skill roots with deterministic precedence; show collisions explicitly.
- Index name, description, version/hash, applicable task profiles, required tools, and required configuration. Load full instructions only when needed.
- Pin skill versions for each run/session. Applying a change to active work requires an explicit refresh boundary, not silent mid-turn prompt mutation.
- Enforce bounded file sizes and confined relative-resource reads. A skill cannot escape its approved package root through path traversal or symlink tricks.
- Surface readiness: available, missing dependency, disabled, incompatible, or awaiting approval.
- Preserve Outpost's task presets—Code, Browser, Research, Operations, Cowork, Chat—as defaults over one task system, not new independent personalities or permission domains.
- Keep repository conventions separate from global personal procedures. Loading an arbitrary repository's instructions must not grant it execution authority.

**Integration:** adapt the Pi `ResourceLoader` and existing capability catalogue. Introduce a controlled resource-read path so skill assets are accessible without bypassing Ask permission for actual work. Define which trusted metadata is internal setup versus task-visible content access.

**Safety/recovery:** instructions are not executable permissions. A skill requesting broader tools still goes through policy and capability approval. A version update that introduces new executable dependencies or destinations needs review.

**Acceptance:** deterministic collision handling; unavailable requirements surfaced; scope isolation; pinned versions survive resume; unauthorized skill instructions cannot change mode, install code, or access owner secrets.

### F08 — Connector bundles and a managed MCP lifecycle

**OpenClaw reference:** distinguish instruction/configuration bundles from native in-process plugins. Bundles map supported skills, MCP definitions, and other declared surfaces; not every external bundle feature is automatically supported. See [O08](#o08-plugin-bundles).

**Outpost opportunity:** turn one-off integrations into installable, observable capability packs while keeping one policy boundary.

**Functional design**

- Define an Outpost pack manifest: identity, version, source, licence, content hash, runtime compatibility, declared tools, permission/destination requirements, dependencies, and health probe.
- Separate pack kinds: instruction-only; supervised executable/MCP connector; privileged in-process extension. Make the different trust levels prominent.
- Stage before activation. Show the permission diff, verify content, run a bounded probe, and activate the exact approved version.
- Start with a private/local registry and one useful connector. Avoid a public marketplace before revocation and update behavior are reliable.
- Manage MCP process/connection lifecycle: start, handshake, schema discovery, timeout, health, cancellation, crash recovery, and clean shutdown.
- Translate every exposed tool into Outpost's normalized action envelope. Effects/targets come from reviewed adapter metadata and validation, not a connector's untrusted self-description alone.
- Inject credentials only into the connector that needs them; do not put secret values in model-visible schemas or full inherited environments.
- Quarantine incompatible schemas or failed updates while preserving the previous working version when safe.
- Expose install, enable, disable, update, rollback, and revoke as separate operations with recorded outcomes.

**Integration:** extend `Capabilities.stage/probe/activate`, tool discovery, and supervised process ownership. The existing manifest is executable-oriented; support for instruction-only and remote MCP packs requires an explicit schema migration/design, not fabricated executable paths.

**Safety/recovery:** an out-of-process connector is not automatically sandboxed. OS identity, filesystem/network scope, and secret access still determine isolation. In-process plugins can compromise the coordinator; keep them owner-vetted and rare.

**Acceptance:** malicious schema/oversized output fixtures; hung connector cancellation; revoked pack cannot dispatch; permission expansion blocks activation; failed update rolls back visibly; all effectful tools appear in the ordinary action history.

### F09 — Bounded specialist workers

**OpenClaw reference:** children have separate sessions, explicit context modes, bounded nesting, result announcements, and parent-linked oversight. Internal workers need not become separate top-level conversations. See [O09](#o09-specialist-workers).

**Outpost gap:** delegation contracts exist as primitives, but there is no complete integrated worker scheduler and result/verification lifecycle.

**User experience:** a parent task shows “Researcher”, “Implementer”, and “Reviewer” worker cards with scope, state, evidence, and resource use. Opening a card shows its transcript without replacing the parent draft. The owner can stop one worker or the tree.

**Functional design**

- Require an explicit delegation policy/authorization before the coordinator spawns workers. Task complexity alone is not delegation authority.
- A child contract includes objective, deliverable format, model, permitted tools/resources, identity, budget, timeout, context mode, and parent reference.
- Use isolated context by default; offer a bounded parent-context fork only when necessary and authorized.
- Integrate live child launches with F01 capacity pools. Queued workers consume no model slot until admitted.
- Retain existing scope-subset and depth checks. Include child consumption in parent budgets rather than multiplying the parent's allowance.
- Allow one writer per shared workspace/resource. Use separate worktrees or isolated directories for concurrent code writers.
- Deliver a structured result: outcome, summary, artifacts, evidence/checks, unresolved issues, and resource usage. The parent verifies important claims before accepting a result.
- Completion is pushed through the durable event/outbox path, not polled continuously by a model.
- Cancellation propagates to descendants and supervised tools. Restart recovers execution/result states without blindly launching duplicate children.

**Integration:** extend `server/workers/coordination.ts`, task/run records, Pi adapter, artifact ownership, and desktop child-run views. Do not replace Outpost's worker scope model with unrestricted upstream session tools.

**Safety/recovery:** a child cannot widen tool, identity, host, or payment authority. If an interrupted writer's effects are uncertain, keep its resource unavailable until reconciled rather than treating lease expiry as proof of safe takeover.

**Acceptance:** two independent readers run concurrently; competing writers are serialized; child budget/depth expansion is refused; subtree cancellation works; restart does not lose completion; fake success without evidence is not accepted by the parent.

### F10 — Resumable deterministic recipes

**OpenClaw reference:** Lobster executes typed multi-step pipelines and returns durable approval/input checkpoints rather than keeping a process waiting for the user. See [O10](#o10-resumable-workflows).

**Outpost gap:** recipes currently validate dependency graphs and evidence-backed step verification, but do not constitute a complete execution engine.

**Example:** collect service metrics → generate report → render PDF → request delivery approval → send to the approved recipient → verify receipt. If approval takes a day, the workflow resumes at delivery, not at metric collection unless freshness rules require a refresh.

**Functional design**

- Separate a versioned recipe definition from each execution instance.
- Give each step typed inputs/outputs, dependencies, effect class, timeout, evidence requirements, and retry/compensation policy.
- Start with sequential steps plus explicit approval/input waits; add bounded parallel branches only when proven necessary.
- Persist completed step outputs and hashes. A resumed run consumes those outputs instead of rerunning successful external effects.
- Treat a continuation token/reference as a locator, not authorization. Resume checks current actor, grant, step version, input hash, and freshness.
- Structured human questions specify expected answer shape and validation; free-form answers cannot silently widen the workflow.
- When an input, target, recipient, amount, or recipe version materially changes, invalidate the affected downstream preview/approval.
- Distinguish retryable read/compute steps from submissions with unknown outcomes. Only a named compensating action can attempt reversal, and it may need its own approval.

**Integration:** extend `server/workflows/recipes.ts` and invoke every work step through the existing gate. Link existing delivery-operation and payment-mandate primitives where applicable. Reuse a constrained data model before adopting an external DSL/runtime.

**Safety/recovery:** do not import Lobster's approval mechanism as a competing authority. Ordinary Ask permission still applies unless an existing explicitly approved workflow mandate covers the exact steps. A “workflow” label must not hide an arbitrary shell script's effects.

**Acceptance:** process restart at every checkpoint; stale approval rejection; repeated resume is idempotent; unknown delivery does not resend; changed inputs invalidate dependent work; cancellation leaves an accurate partial result and evidence list.

### F11 — Optional message-channel intake and reliable delivery

**OpenClaw reference:** normalized channel/account/peer/thread routing, stable session assignment, and explicit return routes. See [O11](#o11-channel-routing).

**Outpost opportunity:** let the owner forward a message, email, or chat thread into a task and receive concise completion notifications without opening a client for every interaction.

**Recommended initial slice:** one opt-in intake integration and one reply path. For example, an owner-approved bot or dedicated mailbox can create **draft tasks** and return status. Do not begin with every OpenClaw channel.

**Functional design**

- Normalize each inbound event with connector, account, sender, conversation/thread, external message ID, timestamps, attachment references, and provenance.
- Authenticate the webhook/connection, then separately authorize the sender. A valid platform signature does not make every platform user an Outpost owner.
- Deduplicate externally retried events before task creation. Persist an explicit source-to-task binding.
- Default to isolated conversation scopes. Do not merge all direct messages into one shared history merely because OpenClaw supports that configuration.
- Route replies to the captured origin unless the owner explicitly selects another destination. A model-generated recipient string is not trusted routing authority.
- Start with status, draft intake, and low-risk configured tasks. Send sensitive approvals to the signed Mac/iPhone surface.
- Model outgoing delivery as accepted, confirmed, failed, partial, or unknown. Store the provider receipt when available; unknown delivery requires reconciliation.
- Bound attachment size/type, scan/parse safely, and treat message/document content as untrusted task data.
- Separate “reply to requester” from “send a new message to someone else”; the latter is a new external effect.

**Integration:** build on `server/communication/`, `server/delivery/`, tasks, and the existing inbox. Connectors should feed the same F01 admission layer, not call the model directly.

**Safety/recovery:** no owner identity based on display names; no channel text that can change policy; no public endpoint carrying the bootstrap pairing secret. Disable/revoke must stop new admission while preserving readable historical provenance.

**Acceptance:** replayed event creates one task; another sender cannot inherit owner context; thread replies return correctly; uncertain sends are not duplicated; disconnected connectors recover from checkpoints; sensitive actions still require current Outpost authority.

### F12 — Browser profiles, continuity, and human handoff

**OpenClaw reference:** managed browser profiles, tab ownership, snapshots/actions, optional existing-browser attachment, and download metadata. See [O12](#o12-browser-profiles).

**Outpost gap:** Browser-Use is already integrated. A separate Playwright library has observation and takeover lease primitives, but the desktop documents no live takeover/video surface. The opportunity is to unify lifecycle and ownership, not replace a working browser with a second independent browser manager.

**User experience**

A task names its browser identity and profile, shows current tabs and recent observations, and offers **Take over** when login/MFA requires the owner. Returning control forces a fresh observation. A completed download becomes a verified artifact, not a raw server path.

**Functional design**

- Introduce one profile/session owner shared by Browser-Use and lower-level browser actions.
- Keep agent and owner identities separate; never silently reuse a more privileged logged-in profile.
- Persist profile metadata and supported browser state, with visible logout/session-expiry handling.
- Retain stable tab/session IDs. Associate each action with the observation it was based on; reject stale observation references where applicable.
- Use one server-owned input lease: agent or one device. Expiry/disconnect must not allow simultaneous control.
- Provide a browser-scoped viewer and input channel, not a general Linux remote desktop.
- Stream bounded step progress and screenshots through authorized transport. Redact or suspend capture for sensitive entry where technically supported, and clearly document limits.
- Manage downloads/uploads through artifact contracts: final URL policy, filename/content validation, size limits, hash, and task ownership.
- On browser crash, restore only supported state and reconcile pending effects before retrying a click or form submission.

**Integration:** `server/browser/`, Browser-Use worker, identity broker, artifact store, gate, desktop evidence pane, and retained iPhone client. Lease checks must reach the actual Browser-Use input path; a separate lease table alone does not enforce takeover.

**Safety/recovery:** optional attachment to personal Chrome is a later, explicit grant. It exposes authenticated sessions and must not become a shortcut around identity boundaries. SSRF/private-network access needs policy appropriate to the homelab, not a blanket assumption that all internal addresses are safe.

**Acceptance:** the real automation engine stops input during takeover; second-device takeover conflicts are visible; resumed action re-observes; login expiry is honest; crash after submit becomes unknown/reconciliation; downloaded evidence survives reconnect.

### F13 — Doctor, setup validation, and recovery planning

**OpenClaw reference:** Doctor groups configuration, provider, state, session, plugin, service, and security checks, with migration/repair workflows. See [O13](#o13-doctor-and-operations).

**Outpost opportunity:** turn scattered runbooks and probes into an operational product. This is especially valuable because Outpost can administer its own infrastructure.

**User experience:** Connection/Health explains whether a failure is the tunnel, gateway, pairing identity, model, browser worker, host executor, queue, disk, or a restoration hold. Each finding includes evidence, severity, and a specific next step. “Repair” shows a plan before mutating anything.

**Functional design**

- Default to read-only checks: software versions, protocol compatibility, model readiness, disk pressure, ledger access, pending unknown effects, outbox backlog, browser dependency availability, credential presence/expiry metadata, and host reachability.
- Keep failure local: a broken optional connector must not prevent inspection of healthy tasks or unrelated integrations.
- Emit structured findings with stable codes, timestamps, affected resource, observed evidence, and a suggested operation.
- Separate automatic read-only diagnosis from approved repair. A repair has preconditions, exact changes, backup requirements, verification, and rollback/manual recovery guidance.
- Perform configuration migrations through an explicit owner; do not silently accept several competing legacy shapes forever.
- Generate a sanitized support bundle excluding secrets and private prompt/tool content by default. Let the owner preview included fields.
- Provide a recovery manifest that lists what is protected: ledger, published artifacts, Pi sessions, workspaces/repositories, browser profiles, connector state, and keys stored elsewhere.
- Preserve restored dispatch hold. Recovery acknowledgment must not imply external effects have been reconciled.

**Integration:** build on operations health, capability probes, backup, deployment runbooks, and signed owner commands. Proposed CLI/desktop diagnostics should share the same check results.

**Important existing limitation:** current backup code covers ledger and published artifacts with explicit size limits; it does not capture the entire workspace/browser/Pi/key estate. Label it accurately until a whole-system restore is rehearsed.

**Acceptance:** read-only mode performs no repairs; a missing optional component does not break the report; secrets are excluded; migration is repeatable; restore to a clean environment leaves dispatch held; failed repair retains usable evidence and recovery instructions.

### F14 — Task board and attention inbox

**OpenClaw reference:** Workboard supports cards and rule-based session boards derived from gateway facts, with links to runs and evidence. See [O14](#o14-workboard-and-client-state).

**Outpost opportunity:** make concurrent work understandable without requiring the owner to open every conversation.

**Recommended first version:** an opinionated task board, not a general project-management application.

| Column | Source of truth |
|---|---|
| Queued | Accepted task/input awaiting execution |
| Working | Active runtime or active owned worker |
| Needs you | Pending approval, structured question, or browser handoff |
| Blocked | Capacity/provider failure, interruption, unknown effect, or failed prerequisite |
| Review | Model work finished; evidence/outcome needs verification |
| Completed | Explicit verified completion record |

**Functional design**

- Derive placement from server facts with a documented precedence. Approval/blocker states outrank a stale “running” field.
- Each card shows objective, project/profile, active model, meaningful public progress, blocker, last evidence, and updated time.
- Opening a card returns to the existing task; no duplicate session/task is created.
- Filters cover project, task type, status, automation origin, and recent activity. Keep specialist workers nested unless deliberately promoted to independent work.
- Reuse SSE/event invalidation and snapshots. Do not create a per-card polling loop.
- Show stale/offline state explicitly; last-known cards remain readable without implying live execution.
- Make approvals/questions actionable through their canonical records. Resolving on one device updates the other.
- Add optional manual pinning later, but never let dragging to Completed fabricate execution success. Visual placement and verified task state are distinct.

**Integration:** derive a board projection over task, run, action, inbox, worker, operation, and artifact records. Reuse the AppKit sidebar and React content rather than transplanting OpenClaw's Lit UI.

**Safety/recovery:** previews must be bounded public text, not unfiltered shell arguments, secrets, or reasoning content. A board cache is display state and cannot authorize an action.

**Acceptance:** restart does not show dead workers as active; approvals converge across clients; reconnect does not duplicate cards; unknown-effect tasks remain visible; verification is required for Completed; keyboard/screen-reader use has equivalent controls.

### F15 — Paired execution nodes and local companion

**OpenClaw reference:** a gateway can route work to paired node hosts with advertised commands/capabilities and approval-bound execution plans. See [O15](#o15-execution-nodes).

**Outpost baseline:** authenticated execution already reaches two configured root hosts. A node feature should replace fixed host-specific assumptions only when there is a concrete need: Mac-only builds, owner-approved local files, or additional bounded workers.

**Functional design**

- Enroll each node with an individual identity, owner-visible name, version, platform, declared capabilities, and allowed execution scopes.
- Route by explicit task requirement: e.g. macOS/Xcode build versus Linux browser work. Display the actual execution location before effect.
- Support capability changes as reviewable enrollment upgrades. A previously approved read-only node cannot suddenly advertise unrestricted execution without consent.
- Sign/bind execution plans to task, node, working directory, inputs, expiry, and current grant. Recheck at the node before execution.
- Capture output and artifact hashes with node provenance; distinguish node offline, capacity busy, command failed, and outcome unknown.
- Revoke individual nodes and rotate their credentials without sharing one broad secret across the fleet.
- Keep phone/macOS OS permissions explicit for any local capability. Pairing is not blanket permission to record screens or use cameras.

**Integration:** generalize `server/operations/hosts.ts` behind a registry/transport abstraction, retain the central ledger, and preserve existing deployment behavior during a deliberate migration. Nodes must not become alternate task or policy authorities.

**Scope decision:** the older one-server specification and newer two-server deployment differ. Broad local execution is an explicit product decision, not a prerequisite for adopting the other features.

**Acceptance:** revoke a node between admission and effect; reject changed capability scope; recover from a disconnect without duplicate execution; verify artifact origin; deny routing to a node that lacks the requested platform/tool.

### F16 — Reviewed procedure learning

**OpenClaw reference:** Skill Workshop turns repeated successful work into versioned procedures, distinguishes skills from factual memory, and supports undo/archive. See [O07](#o07-skills-and-procedure-learning).

**Outpost opportunity:** reduce repeated trial-and-error without allowing the agent to silently rewrite its own operating authority.

**User experience:** after a successful multi-step task, Outpost offers **Save as procedure**. The proposal explains when to use it, prerequisites, steps, validation, failure recovery, and evidence from the original run. The owner can review a diff before enabling it.

**Functional design**

- Extract a procedure only from sufficiently verified work; preserve links to the task and artifacts that demonstrated it.
- Separate facts (“the service uses port X”) from method (“how to deploy and verify the service”). Facts remain memory; repository conventions remain repository documentation.
- Store draft, approved, retired, and archived states with immutable versions and reversible updates.
- Strip credentials, transient IDs, machine-specific accidents, and one-time approval assumptions from generated instructions.
- Declare required tools/resources and failure conditions. A learned procedure that needs new permissions remains unavailable until separately approved.
- Start with user-initiated promotion. Background learning can be considered later with cost limits and review queues.
- Track actual uses, successful evidence, and failures. Suggest review/archive for stale procedures; do not silently delete a rarely used recovery runbook.
- Keep running sessions pinned to their approved procedure version.

**Integration:** build on F07's skill registry and F10's recipe definitions where steps are deterministic. Use memory only for associated facts/provenance, not as an executable workflow store.

**Safety/recovery:** never automatically enable a newly learned high-privilege procedure. Undo affects future instruction versions, not external actions already performed. An agent-written skill cannot exempt itself from allowlists or the common gate.

**Acceptance:** generated procedure contains no secret placeholders resolved to real secrets; new permissions require approval; rollback is reversible; a failed original task cannot become a trusted “known-good” procedure; active runs keep a stable version.

### F17 — Usage, latency, and operational diagnostics

**OpenClaw reference:** queue snapshots expose blocking causes/capacity; automation outcomes include model/provider/usage and separate delivery traces; Control UI surfaces activity and recovery status. See [O01](#o01-queues-and-capacity), [O04](#o04-automations-and-webhooks), and [O14](#o14-workboard-and-client-state).

**Outpost opportunity:** answer “What is it doing?”, “Why is it waiting?”, and “What did this cost?” from recorded facts, not generated narration.

**Functional design**

- Capture task, run, model attempt, action, worker, workflow step, and delivery IDs across the existing event path.
- Record queue time, model time-to-first-content, model completion time, tool duration, browser step count, retry count, provider errors, and result/delivery state.
- Track token/usage values only when the provider supplies them; otherwise show unavailable or explicitly estimated. The current Pi registration's zero-valued cost metadata is not proof inference is free.
- Offer task and automation budgets with distinct units: time, model tokens/cost where measurable, concurrency, process output, and browser steps.
- Explain budget exhaustion before the next eligible action and show what was already spent. Do not imply exact hard monetary limits when a provider cannot report real-time billing.
- Present a task timeline and a compact system health/capacity view. Tool activity comes from public structured progress, not an LLM guessing what a process is doing.
- Expose terminal unknown outcomes prominently and link reconciliation controls.
- Keep telemetry local by default. Redact exports and avoid recording secrets or duplicating full private model/tool content in metrics.

**Integration:** extend live events, durable run/action records, provider adapter, scheduler, and desktop evidence. Use a small local projection initially; a separate analytics service is unnecessary.

**Safety/recovery:** diagnostics cannot become an alternate way to retrieve secrets. Treat the authoritative outcome separately from a stream disconnect: the UI losing a connection does not mean execution stopped.

**Acceptance:** a known fixture reconstructs queue/model/tool/delivery phases; retries count once per actual attempt; missing billing is marked unknown; cancelled work retains partial usage; diagnostics do not leak credentials; stale metrics are labeled with observation time.

## 6. Shared architecture and data contracts

### 6.1 Keep existing ownership boundaries

The recommended path is:

**Signed clients / approved connector events → admission and input queue → existing task/run owner → Pi runtime or recipe/worker execution → existing action gate → tools/connectors/browser/nodes → evidence and delivery records → existing event/SSE projection.**

Schedules create admitted work. Memory and skills supply bounded context. Diagnostics read recorded facts. The board is a projection. None of those components should independently authorize work or own a second task lifecycle.

### 6.2 Proposed durable records

These are conceptual additions or extensions—not new tables already present, and not a final schema. Reuse existing ledger record kinds where their semantics fit.

| Record | Essential information | Owner |
|---|---|---|
| Task input | Task/session, sequence, actor/device, mode, payload references, authority reference, lifecycle | Task/admission layer |
| Capacity admission | Work ID, pool, priority, queued/admitted times, reason, cancellation | Queue owner |
| Model attempt | Run, selected/actual model, route, qualification, classification, usage, outcome | Model/runtime layer |
| Context checkpoint | Task/run, source range, summary/artifact, hashes, unresolved references | Runtime adapter |
| Automation definition | Trigger, timezone, overlap/missed policy, task template, grant, budget, version | Scheduler |
| Automation occurrence | Definition revision, source occurrence ID, task/run, execution/delivery outcome | Scheduler + delivery owner |
| Standing program | Scope, actions, limits, escalation, expiry, approval | Policy/program owner |
| Memory chunk/index | Source item/revision, project/identity, provenance, embedding version | Memory owner; index derived |
| Skill/pack version | Source, hash, manifest, readiness, permissions, approval, retirement | Capabilities owner |
| Worker job/result | Parent, scope, budget, workspace, result/evidence, acceptance | Workers owner |
| Workflow execution/step | Recipe version, inputs/outputs, state, action IDs, checkpoint, evidence | Workflows owner |
| Channel binding | Connector/account/peer/thread, authorized principal, task/session mapping | Communications owner |
| Browser profile/session | Identity, host, tabs, lease, observations, recovery status | Browser owner |
| Diagnostic finding | Code, scope, evidence, severity, proposed repair, verification | Health/recovery owner |
| Node registration | Device identity, capabilities, grants, reachability/version | Device/node owner |

All effectful work should retain the existing task/run/action/idempotency relationships. Durable acceptance, execution, observation, and delivery are separate facts.

### 6.3 Proposed command surfaces

Examples of intended responsibilities, not promises of implemented APIs:

- Task inputs: enqueue, list, cancel, steer, interrupt.
- Context: inspect budget, inspect summary, request compaction.
- Models: inspect health, inspect attempts, select an approved model/fallback policy.
- Automations: preview, save, pause, run now, inspect history, revoke.
- Memory: search, propose, confirm, correct, forget, inspect sources.
- Skills/packs: inspect, stage, probe, approve, activate, disable, rollback.
- Workers: delegate, inspect, stop, obtain result, accept/reject evidence.
- Workflows: preview, start, answer, resume, cancel, reconcile.
- Browser: inspect profile, observe, acquire/release takeover, obtain artifact.
- Doctor: inspect, preview repair, execute approved repair, verify.

Use the existing signed command envelope for client mutations. Connector credentials authenticate inbound events but do not inherit device-administration powers.

### 6.4 Non-negotiable cross-cutting invariants

1. **One effect gate:** nested recipes, MCP calls, workers, schedules, and browser actions do not bypass Outpost policy.
2. **Current authority:** revalidate grants, policy version, relevant device/connector revocation, task state, and tool version immediately before effect.
3. **No duplicate effects by optimistic replay:** uncertain submissions enter reconciliation.
4. **No fictitious completion:** a model response, tool invocation, or HTTP acceptance is not verified task success.
5. **Derived views stay derived:** boards, cached history, search indexes, and summaries do not become authority stores.
6. **Explicit privacy boundaries:** selecting Cloud inference or a remote connector has visible data consequences.
7. **Truthful isolation:** prompt rules, path allowlists, private networking, and process separation are not equivalent to a hostile-agent sandbox.
8. **Bounded work:** queues, child depth, browser steps, retries, context, output, and unattended programs need enforceable limits.
9. **Same facts on both clients:** layouts can differ; approval and completion semantics cannot.
10. **No silent scope expansion:** new capabilities, personal-browser attachment, new destinations, local nodes, and broader autonomy require explicit owner decisions.

Several are target invariants, not claims that the current implementation fully enforces them. For example, existing device authentication and gate checks should be traced end-to-end before claiming revocation cancels already accepted autonomous work.

## 7. Delivery sequence and acceptance gates

### Phase A — Make the current operator dependable

**Build:** F01 queue/admission, F02 context management, F13 read-only Doctor; start F17 instrumentation.

**Why first:** richer automation and worker fan-out otherwise amplify context exhaustion, unclear waits, and recovery uncertainty.

**Exit evidence:**

- Two simultaneous client instructions remain ordered without competing session runs.
- Cancellation and restart preserve exact accepted/unknown/completed distinctions.
- A long task compacts without losing constraints or pending action references.
- Health reports locate model/browser/host failures and preserve secret confidentiality.
- Rehearse code, browser, and operations tasks—not only coding benchmarks.

### Phase B — Expose daily product value

**Build:** F14 task board, F04 calendar automation, F06 runtime memory retrieval, F07 owner-managed skills, F03 bounded model recovery. Complete F17's initial task timeline.

F06 should ship in slices: first wire existing scoped FTS and source inspection, then add embeddings/hybrid ranking. F07 starts with trusted local procedures, not a marketplace.

**Exit evidence:** a scheduled health/report task runs with a timezone preview, uses one approved procedure, finds relevant prior evidence, shows live/queued/review state, and produces a verified artifact. Provider failure has a visible bounded outcome. Both clients can inspect the same task and approval facts.

### Phase C — Complete browser continuity

**Build:** F12 profile/session ownership, then live handoff and recovery.

A limited persistent-agent-profile slice can be developed alongside Phase B. Owner-account takeover waits for actual engine-level lease enforcement and privacy testing.

**Exit evidence:** authenticate through an authorized human handoff, resume safely after fresh observation, and verify a download/result without exposing a generic desktop or duplicating submission after interruption.

### Phase D — Add bounded reusable execution

**Build:** F08 one managed connector, F10 executable recipes, F09 specialist workers.

**Suggested pilot:** a researcher and verifier produce a comparison report in separate scopes; a recipe renders it and waits for approved delivery through one connector.

**Exit evidence:** enforce child scope/budget, single-writer coordination, continuation identity, connector cancellation, and no duplicated delivery after restart. Parent completion includes evidence-backed acceptance.

### Phase E — Add proactive and optional surfaces

**Build:** F05 quiet monitoring and F11 message intake. Consider F16 reviewed learning and F15 general nodes only after explicit scope decisions.

**Exit evidence:** an unattended program runs for a sustained pilot period with bounded notifications and budget; external message replay produces one task; revoked authority stops future work; operator review confirms no hidden permission widening.

### Suggested measurement set

Set numeric targets after establishing a real baseline; do not invent success percentages from static inspection.

- End-to-end verified task success by Code/Browser/Operations pillar.
- Lost/duplicated accepted inputs and duplicate external effects.
- Queue wait versus model/tool execution time.
- Recovery rate and owner effort after interruption.
- Approval correctness, stale-approval refusal, and reviewer false-allow/false-ask rates.
- Memory retrieval quality and scope-leakage tests.
- Automation alert precision, missed checks, and unnecessary model calls.
- Context-related failures and token usage per successful task.
- Connector/worker cancellation and orphan-process outcomes.
- Cross-client convergence and stale/offline representation.

### Decisions required before implementation

1. Which current architecture decisions supersede the older one-server/Swift/Cloud-only specification?
2. What is the desired default authority for scheduled work, independent of the desktop's current Full control default?
3. Which exact model roles and fallback routes have qualification evidence?
4. Which one connector/channel has enough daily value to justify its operational cost?
5. Should memory embeddings remain strictly local, and which sources may be indexed?
6. Is a browser owner-account handoff in the next milestone, or only persistent agent profiles?
7. Should procedures always need owner promotion initially? Recommendation: yes.
8. Is general node/local-Mac execution a real requirement, or are the two current hosts sufficient?

These decisions do not block reading this report. They gate implementation choices that would otherwise change scope or authority.

## 8. What not to copy

### Do not replace existing Outpost foundations

Do not rebuild task persistence, approvals, device pairing, artifact integrity, live SSE, or host execution merely because OpenClaw has equivalents. Add missing contracts and qualification to the existing owners.

### Do not transplant the whole permission model

OpenClaw's session/channel/operator configuration and Outpost's three modes plus exact-action approvals are not interchangeable. In particular, task presets should not become separate agents with inconsistent authority, and workflow/skill text should not mint permissions.

### Do not confuse operational breadth with immediate value

Defer the long tail of messaging providers, many model providers, alternate harnesses, and public plugin distribution. Each adds authentication, upgrades, compatibility, health, and incident handling—not only a tool registration.

### Do not copy refusal-based model escalation

Use fallback for eligible availability/capacity failures within approved routes. Do not adopt automatic model switching intended to work around a policy refusal.

### Do not adopt autonomous learning defaults wholesale

Prefer reviewed procedure proposals over automatically modifying active instructions, bypassing skill allowlists, or enabling new privileged workflows.

### Do not replace Outpost's native shell with OpenClaw's UI stack

OpenClaw's Control UI is Lit-based; Outpost's current desktop is React/Tauri with AppKit navigation. Borrow information organization and state behavior, not an entire component framework or visual identity.

### Do not expand into generic remote desktop or a user terminal

Browser-scoped handoff fits Outpost. A Linux desktop, generic VNC, and a client shell conflict with the older explicit product constraints and need a separate product decision.

### Useful later, but not first

| Capability | Why defer | Reconsider when |
|---|---|---|
| Voice input and spoken updates | Recording permissions, transcription quality, privacy, and media lifecycle add a separate integration surface | Text intake and file handling are reliable; begin with push-to-talk, not always-listening capture |
| Rich generated widgets/canvas/MCP Apps | Active content creates a new origin, sandbox, and interaction boundary | Verified artifacts and basic previews no longer satisfy real workflows |
| Meeting bots / telephony | Consent, account/platform constraints, recording retention, and reliability | A specific authorized use case justifies the cost |
| Multi-person shared workspaces | Identity and visibility semantics are much more complex than a personal operator | Outpost explicitly changes from personal use to a trusted team product |
| Autonomous memory consolidation | Can promote wrong facts and generate ongoing inference cost | Manual correction, provenance, retrieval evaluation, and undo are proven |
| Branding mascots and decorative activity | Does not address reliability or task completion | Core operational surfaces are already excellent |

These are intentionally deferred opportunities, not a claim that the corresponding OpenClaw implementations were fully audited here.

## 9. Reuse, licensing, and maintenance

### What “copy” should mean

1. **Copy the user-visible behavior** where it solves an Outpost problem.
2. **Adapt the algorithm or contract** to Outpost's owners and safety model.
3. **Copy source only after dependency and licence review**, retaining required notices and relevant tests.

OpenClaw's root [LICENSE](../../openclaw/LICENSE) is MIT, copyright 2026 OpenClaw Foundation. It permits reuse/modification/distribution, subject to preserving the copyright and permission notice in copies or substantial portions. This is not a blanket licence determination for every dependency, asset, plugin, model, or separately distributed package. Review [THIRD_PARTY_NOTICES.md](../../openclaw/THIRD_PARTY_NOTICES.md), relevant package licences, and external runtime licences before vendoring.

Do not reuse product names, logos, or imply endorsement. This report contains recommendations and references, not a source-code import.

### Reuse candidates

| Area | Best reuse approach | Reason |
|---|---|---|
| Queue/admission | Reimplement semantics over Outpost ledger; borrow failure scenarios | Upstream in-process scheduling is not Outpost's durability contract |
| Cron/calendar evaluation | Evaluate the maintained scheduling dependency and upstream edge-case tests | Timezone/DST parsing is subtle; copying a large scheduler adds unnecessary ownership |
| Hybrid ranking | Consider extracting narrow ranking helpers and tests | Algorithm is separable, but current imports include OpenClaw SDK/provenance contracts |
| Skills | Reuse Markdown package conventions and bounded loading ideas | Existing Pi integration should remain the runtime seam |
| MCP | Use a maintained transport SDK and Outpost gate adapters | Upstream plugin internals are not a drop-in SDK for Outpost |
| Workflow checkpoints | Reuse concepts; assess external Lobster runtime separately | Outpost already owns workflow/evidence/approval primitives |
| Task board | Reimplement projections and interaction behavior in React | Different domain model and UI framework |
| Node protocol | Design a narrow Outpost protocol if needed | Upstream pairing/auth/protocol is tightly coupled to its Gateway |
| Doctor | Borrow check taxonomy and repair discipline | Checks must understand Outpost's topology, data, and recovery owners |

### Maintenance checklist for any actual source import

- Record upstream commit, original paths, licence, and local modifications.
- Inspect transitive imports and runtime assumptions; do not copy a helper whose actual owner is an entire subsystem.
- Preserve applicable tests and add Outpost boundary tests.
- Map errors and identifiers into Outpost's existing contracts.
- Review dependency security/updates and assign a local owner.
- Keep a small provenance file or notice for substantial reused portions.
- Avoid importing two state stores or two permission engines for the same responsibility.

## 10. Source register

Paths below refer to the inspected sibling checkouts. OpenClaw links are local repository references pinned by the snapshot recorded in section 2, not claims about a future upstream release. Source files listed as implementation entry points may need further dependency review before coding.

### Outpost baseline references

- [Current README](../README.md) — current product/deployment summary and explicit limitations.
- [Desktop README](../desktop/README.md) — Tauri/Rust/AppKit implementation, wired flows, migration limits.
- [Live streaming record](implementation/LIVE-STREAMING.md) — actual streaming path and recorded verification.
- [Acceptance report](implementation/ACCEPTANCE.md) — older qualification record, still important for unqualified boundaries.
- [Feature ownership map](../spec/feature-map.md) — existing requirement IDs; C/E/A indicate implementation sequencing, not acceptance.
- [Architecture specification](../spec/00-system-architecture.md) — original product/security boundaries; some deployment/client details predate the working tree.
- [Model specification](../spec/22-models-and-auto-reviewer.md) — role qualification, context, and fallback intent.
- [Coordinator](../server/gateway/coordinator.ts), [main](../server/main.ts), [tasks](../server/tasks/tasks.ts), [Pi runtime](../server/pi-adapter/runtime.ts), [gate](../server/policy/trust.ts) — current runtime/tool wiring and authority checks.
- [Scheduler](../server/scheduler/scheduler.ts), [memory](../server/memory/memory.ts), [workers](../server/workers/coordination.ts), [recipes](../server/workflows/recipes.ts), [capabilities](../server/capabilities/catalogue.ts) — primitives and extension seams.
- [Browser leases/Playwright](../server/browser/browser.ts), [Browser-Use adapter](../server/browser/browser-use.ts), [hosts](../server/operations/hosts.ts), [backup](../server/reliability/backup.ts) — execution/recovery boundaries.

### O01 Queues and capacity

- [Command queue documentation](../../openclaw/docs/concepts/queue.md).
- [Queue option/snapshot contracts](../../openclaw/src/process/command-queue.types.ts).
- Implementation entry: [command-queue.ts](../../openclaw/src/process/command-queue.ts).
- Test starting points: [cancellation](../../openclaw/src/process/command-queue.cancellation.test.ts), [capacity groups](../../openclaw/src/process/command-queue.capacity-groups.test.ts).

### O02 Context and compaction

- [Context engine documentation](../../openclaw/docs/concepts/context-engine.md).
- Implementation entry points: [context engine types](../../openclaw/src/context-engine/types.ts), [legacy engine](../../openclaw/src/context-engine/legacy.ts), [bounded context](../../openclaw/src/context-engine/bounded-context.ts).

### O03 Model recovery

- [Model failover documentation](../../openclaw/docs/concepts/model-failover.md). Adopt availability/recovery semantics selectively; do not copy refusal escalation.
- Implementation entry: [model-fallback-runner.ts](../../openclaw/src/agents/model-fallback-runner.ts).
- Test starting points: [operator model policy](../../openclaw/src/agents/model-fallback.operator-model-policy.test.ts), [run deadline](../../openclaw/src/agents/model-fallback.run-deadline.test.ts).

### O04 Automations and webhooks

- [Automation index](../../openclaw/docs/automation/cron-jobs.md), [schedule kinds and semantics](../../openclaw/docs/automation/cron-jobs/schedules.md), [inbound webhooks](../../openclaw/docs/automation/cron-jobs/webhooks.md).
- Inspected implementation/contracts: [schedule.ts](../../openclaw/src/cron/schedule.ts), [types.ts](../../openclaw/src/cron/types.ts).
- Test starting points: [schedule tests](../../openclaw/src/cron/schedule.test.ts), [restart catch-up](../../openclaw/src/cron/service.restart-catchup.test.ts), [restart delivery](../../openclaw/src/cron/service.restart-delivery.test.ts).

### O05 Heartbeat and standing orders

- [Heartbeat](../../openclaw/docs/gateway/heartbeat.md), [standing orders](../../openclaw/docs/automation/standing-orders.md).
- Implementation entry: [heartbeat-monitor.ts](../../openclaw/src/cron/heartbeat-monitor.ts).
- Test starting point: [busy heartbeat poll](../../openclaw/src/cron/service.heartbeat-busy-poll.test.ts).

### O06 Memory and retrieval

- [Memory search](../../openclaw/docs/concepts/memory-search.md).
- Inspected ranking implementation: [hybrid.ts](../../openclaw/extensions/memory-core/src/memory/hybrid.ts).
- Related implementation: [MMR](../../openclaw/extensions/memory-core/src/memory/mmr.ts), [temporal decay](../../openclaw/extensions/memory-core/src/memory/temporal-decay.ts).
- Test starting point: [hybrid ranking tests](../../openclaw/extensions/memory-core/src/memory/hybrid.test.ts).

### O07 Skills and procedure learning

- [Skills](../../openclaw/docs/tools/skills.md), [Skill Workshop](../../openclaw/docs/tools/skill-workshop.md).
- The relevant contrast is Outpost's currently empty resource-loader skill collection, not an absence of skill support in the underlying Pi ecosystem.

### O08 Plugin bundles

- [Plugin bundles](../../openclaw/docs/plugins/bundles.md).
- [OpenClaw vision](../../openclaw/VISION.md) — small core, capable plugins, and the distinction between code plugins and narrower bundles.

### O09 Specialist workers

- [Sub-agent behavior and documentation index](../../openclaw/docs/tools/subagents.md).
- Follow its tool-policy, operations, nesting, and announcement references before implementing a compatible subset; this report does not assert full protocol compatibility.

### O10 Resumable workflows

- [Lobster workflow documentation](../../openclaw/docs/tools/lobster.md).
- Inspected adapter: [lobster-tool.ts](../../openclaw/extensions/lobster/src/lobster-tool.ts).
- Runtime integration entry: [lobster-runner.ts](../../openclaw/extensions/lobster/src/lobster-runner.ts).
- This is the workflow feature, not the unrelated decorative lobster described under the web documentation.

### O11 Channel routing

- [Channel routing](../../openclaw/docs/channels/channel-routing.md).
- Implementation entry points: [resolve-route.ts](../../openclaw/src/routing/resolve-route.ts), [session-key.ts](../../openclaw/src/routing/session-key.ts).
- Test starting point: [routing tests](../../openclaw/src/routing/resolve-route.test.ts).

### O12 Browser profiles

- [Browser capabilities and subpage index](../../openclaw/docs/tools/browser.md).
- Implementation entry: [browser-profiles.ts](../../openclaw/extensions/browser/browser-profiles.ts).
- Outpost's takeover design also derives from its own existing lease implementation and product specification; it is not presented as a verbatim OpenClaw feature.

### O13 Doctor and operations

- [Doctor index](../../openclaw/docs/gateway/doctor.md), [check taxonomy](../../openclaw/docs/gateway/doctor/checks.md).
- Implementation entry points: [health flow](../../openclaw/src/flows/doctor-health.ts), [repair flow](../../openclaw/src/flows/doctor-repair-flow.ts).

### O14 Workboard and client state

- [Workboard](../../openclaw/docs/plugins/workboard.md), [Control UI](../../openclaw/docs/web/control-ui.md).
- Implementation entry: [Workboard extension](../../openclaw/extensions/workboard/).
- Use its fact-derived state and reconnect principles; do not infer that its Lit components can be dropped into Outpost's React desktop.

### O15 Execution nodes

- [Node host](../../openclaw/docs/nodes/node-host.md).
- Outpost comparison: [current fixed-host execution adapter](../server/operations/hosts.ts).

---

## 11. T3 Code findings

T3 is the strongest of these references for **making coding work reviewable and keeping long-lived clients synchronized**. Its broader harness catalogue is less immediately valuable than making Outpost's existing Pi integration dependable. Keep Tauri/React/AppKit and Outpost's ledger; neither Electron nor Effect is a prerequisite for these behaviors.

### Durable commands, ordered inputs, and honest completion

[EventSink.ts](../../t3code/apps/server/src/orchestration-v2/EventSink.ts) implements transactional command receipts, events, projections, and effect requests before publication/execution. This is implemented orchestration-v2 code, not merely an architectural proposal. Outpost already has transactions, an outbox, and idempotent commands in [ledger.ts](../server/core/ledger.ts); the opportunity is to complete the boundary between durable acceptance and Pi execution, not replace SQLite or add a second event store.

[QueuedRunOrder.ts](../../t3code/apps/server/src/orchestration-v2/QueuedRunOrder.ts) makes delivery order explicit. [RunFinalizationService.ts](../../t3code/apps/server/src/orchestration-v2/RunFinalizationService.ts) is a useful reference for separating run outcomes from task projections. Outpost should distinguish an input being accepted, delivered, executed, and verified; interrupted external effects can remain unknown. See [OP-001](tickets/OP-001.md) and [OP-022](tickets/OP-022.md).

### Bounded streams and scoped client state

[ThreadStream.ts](../../t3code/apps/server/src/orchestration-v2/ThreadStream.ts) bounds replay to 128 events and 1 MiB encoded/raw-payload budgets before snapshot fallback. [LiveStreamBudget.ts](../../t3code/apps/server/src/orchestration-v2/LiveStreamBudget.ts) separately bounds live buffering. These numbers are upstream choices, **not proposed universal Outpost defaults**.

Outpost's [live.ts](../server/gateway/live.ts) starts with a full public-record snapshot and rotates streams after 60 seconds; [useConnection.ts](../desktop/src/useConnection.ts) maintains broad state. This suggests growing transfer/reducer costs, but no benchmark was performed. Adopt compact workspace summaries, task-scoped subscriptions, paged historical messages, explicit reset semantics, and bounded queues. Follow T3's [connection runtime](../../t3code/docs/internals/connection-runtime.md) principle of one retry owner per environment; sleep/resume should not start competing reconnect loops. Its [performance regression guidance](../../t3code/docs/internals/performance-regressions.md) supplies test invariants rather than proof that Outpost is already slow. See [OP-018](tickets/OP-018.md).

### Managed worktrees, checkpoints, and review

T3's [source-control workflow](../../t3code/docs/user/source-control.md), [checkpoint store](../../t3code/apps/server/src/checkpointing/CheckpointStore.ts), and [restore isolation guard](../../t3code/apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts) fill a substantial Outpost product gap. Outpost can inspect a repository, apply precise patches, and bind checks to revisions in [repository.ts](../server/code/repository.ts), but does not expose an equivalent end-to-end workspace/checkpoint/review flow.

The crucial safety behavior is **refusing whole-workspace file restoration when another thread may share or overlap that workspace**. Conversation rewind and filesystem restore must be separate operations. Neither reverses a deployment, message, or other external side effect. Add task-owned worktrees before enabling destructive whole-tree restore; show base revision, tracked/untracked exclusions, a restore preview, and stale-revision conflicts. Build a changed-files/diff/checks surface before automatic PR publishing. See [OP-019](tickets/OP-019.md), [OP-020](tickets/OP-020.md), and [OP-021](tickets/OP-021.md).

### Pi capabilities and portable continuation

The [Pi adapter](../../t3code/packages/provider-pi/src/server/adapter.ts) exposes capabilities such as steering, queued input, compaction, rollback/forking, extensions, and streaming. Outpost should negotiate the subset it can actually support and expose unsupported states honestly. Enabling native extensions wholesale would violate Outpost's current single-gate tool model: a permission hook is not an OS sandbox, and extensions can execute code outside tool calls.

[Portable handoffs](../../t3code/docs/user/portable-handoffs.md) and [ContextHandoffService.ts](../../t3code/apps/server/src/orchestration-v2/ContextHandoffService.ts) provide a bounded context-selection reference. A handoff is not byte-identical provider session state. Preserve unresolved decisions, source artifacts, workspace revision, and omissions, but revalidate authority in the destination session. Do not import approval tokens through a summary. See [OP-002](tickets/OP-002.md), [OP-007](tickets/OP-007.md), and [OP-023](tickets/OP-023.md).

## 12. Hermes findings

Hermes is especially useful for **memory that survives sessions, reusable procedural knowledge, and automation that can explain why it did not run**. It also demonstrates the operational complexity introduced by many plugins, profiles, providers, and background execution paths. Borrow bounded product behaviors, not its entire Python agent/messaging/desktop stack.

### Bounded memory and explicit session boundaries

The [memory guide](../../hermes-agent/website/docs/user-guide/features/memory.md) describes bounded MEMORY.md and USER.md stores, injected as a frozen session-start snapshot. Writes persist immediately but the system-prompt prefix stays stable until a new session. Tool responses can expose live state. This is a useful complement to Outpost's scoped FTS/provenance implementation: use a small curated startup packet plus on-demand historical retrieval rather than injecting every remembered fact.

The documented 2,200/1,375-character defaults are Hermes choices, not Outpost requirements. Outpost should set token budgets based on its models and keep memories identity/project scoped with source provenance, correction history, and deletion propagation. A conversational claim of remembering is not a saved-memory receipt. Memory mutation should use the existing action gate, not assume Hermes' optional write-approval defaults are sufficient. See [OP-006](tickets/OP-006.md) and the [memory provider manager](../../hermes-agent/agent/memory_manager.py).

### Skills as discoverable, versioned procedures

Hermes' [skills documentation](../../hermes-agent/website/docs/user-guide/features/skills.md) covers progressive disclosure, explicit invocation, bundles, and learning procedures from sources. [skill_bundles.py](../../hermes-agent/agent/skill_bundles.py) and [skill_commands.py](../../hermes-agent/agent/skill_commands.py) are implementation entry points. Outpost should first make approved skills loadable through Pi, pin their versions per run, and display which instructions were used. A bundle selects procedures; it must not silently grant tools, credentials, or greater authority.

Later, offer “save this successful procedure” as a reviewed draft with source artifacts, evaluation evidence, a version diff, and rollback. Do not let an agent silently rewrite its own active instructions. Knowledge-base skills can use a compact index and separately loaded references rather than one giant prompt. See [OP-007](tickets/OP-007.md) and [OP-016](tickets/OP-016.md).

### Context pressure and cache integrity

[Context compression and caching](../../hermes-agent/website/docs/developer-guide/context-compression-and-caching.md) distinguishes provider-reported usage anchors, estimates of appended content, gateway hygiene, in-loop compression, and reactive overflow recovery. It explicitly acknowledges heuristic fallbacks and limited replay evidence. Outpost should similarly distinguish measured tokens from estimates and invalidate usage anchors on model/context changes.

Use Pi's supported compaction path where possible, with ledger-visible checkpoints and a bounded recovery budget; do not build a competing compressor first. Keep the normal instruction/memory prefix stable within a run, with explicit exceptions for revocation and safety updates. Compression cannot convert untrusted retrieved content into system instructions or preserve stale approvals. See [OP-002](tickets/OP-002.md), [context_engine.py](../../hermes-agent/agent/context_engine.py), and [usage_anchor.py](../../hermes-agent/agent/usage_anchor.py).

### Scheduling: preflight, durable receipts, and uncertain delivery

Hermes' [cron guide](../../hermes-agent/website/docs/user-guide/features/cron.md) goes beyond schedule syntax: prerequisite checks can block a run before spending model tokens, job-specific skills/model configuration are explicit, and scheduled execution is distinct from result delivery. [scheduler_authority.py](../../hermes-agent/cron/scheduler_authority.py), [executions.py](../../hermes-agent/cron/executions.py), and [delivery_queue.py](../../hermes-agent/cron/delivery_queue.py) provide implementation entry points for admission identity and recovery.

Adopt preflight with a visible blocked-config state, one alert per failure episode, bounded catch-up, timezone/DST rules, recurrence budgets, and separate execution/delivery receipts. A known completed result should be deliverable without rerunning the agent. An ambiguous send must remain unknown rather than automatically duplicating the message. Pause ownership/recovery rules need explicit Outpost tests; do not inherit subtle upstream pause/resume behavior by assumption. Script-only jobs are useful later but must be reviewed recipes with pinned content, not arbitrary shell text accepted from a webhook. See [OP-004](tickets/OP-004.md), [OP-010](tickets/OP-010.md), and [OP-011](tickets/OP-011.md).

### Progressive tool discovery without authority expansion

The [tool-search guide](../../hermes-agent/website/docs/user-guide/features/tool-search.md), [tool_search.py](../../hermes-agent/tools/tool_search.py), and [catalog implementation](../../hermes-agent/tools/tool_search_catalog.py) show search/describe/call bridges scoped to the session's enabled tools. Compact listings keep capabilities discoverable while schemas load on demand. This becomes valuable when Outpost gains MCP/connectors; its current small `outpost_action` surface does not justify the complexity yet.

Important caveat: [tool_search_validation.py](../../hermes-agent/tools/tool_search_validation.py) documents fail-open cases for unsupported/missing schemas and external references. Outpost must validate supported schemas locally and reject or quarantine unvalidated executable tools. The bridge must unwrap to the actual action before digesting arguments and requesting approval; approval of a generic `tool_call` is not enough. See [OP-024](tickets/OP-024.md).

### Worker lanes and reviewed completion

The [worker-lane contract](../../hermes-agent/website/docs/user-guide/features/kanban-worker-lanes.md) separates board lifecycle ownership, executors, and reviewers. It distinguishes review from blocked work and treats a worker exiting without a lifecycle result as a failure rather than completion. Useful implementation seams include [kanban_db_dispatch.py](../../hermes-agent/hermes_cli/kanban_db_dispatch.py) and [kanban_workflow.py](../../hermes-agent/hermes_cli/kanban_workflow.py).

Two cautions matter. First, the lane document explicitly calls descendant scoping cooperative runtime behavior, **not OS confinement**. Second, [iteration_budget.py](../../hermes-agent/agent/iteration_budget.py) says each parent/child has its own cap, so aggregate iterations may exceed the parent's limit; this conflicts with older instruction-file descriptions of a shared budget. Outpost should retain explicit aggregate budget reservation/accounting across descendants and one writer per workspace, not copy either an inaccurate description or weaker defaults. See [OP-009](tickets/OP-009.md), [OP-014](tickets/OP-014.md), and [OP-022](tickets/OP-022.md).

### Checkpoint storage, profiles, and execution isolation

Hermes' [checkpoint guide](../../hermes-agent/website/docs/user-guide/checkpoints-and-rollback.md) and [checkpoint_manager.py](../../hermes-agent/tools/checkpoint_manager.py) add useful storage/retention lessons: snapshots are opt-in, use a shadow Git store, and need size limits and cleanup. This complements T3's isolation-first restore rule; it is not permission to snapshot secrets or promise rollback of remote effects. See [OP-020](tickets/OP-020.md).

[Profiles](../../hermes-agent/website/docs/user-guide/profiles.md) isolate config, credentials, sessions, skills, and memory. Outpost should initially use project/identity-scoped **task configuration profiles**, not create multiple competing operator homes or clone secrets/schedules. A full multi-profile product is deferred.

[Programmatic execution](../../hermes-agent/website/docs/user-guide/features/code-execution.md) and [code_execution_tool.py](../../hermes-agent/tools/code_execution_tool.py) reduce context by processing intermediate tool results in code. Do not equate a child process, private RPC socket, or temporary working directory with an OS security boundary. Any Outpost version needs constrained execution and per-action authorization, or must remain disabled. Similarly, evaluate execution backends by real filesystem/network/credential boundaries, not the word “sandbox.” This is an explicitly gated research/implementation ticket, [OP-025](tickets/OP-025.md).

## 13. Combined adoption plan

### Complementary references

| Reference | Highest-value contribution | Do not transplant |
|---|---|---|
| OpenClaw | Persistent operator queues, monitors, integrations, browser/session continuity | Gateway/runtime ownership, broad permissions, ecosystem breadth as an initial milestone |
| T3 Code | Durable run semantics, scoped streams, managed worktrees, checkpoints, diffs/checks, portable context | Electron/Effect architecture, all provider adapters, extension execution outside Outpost policy |
| Hermes | Curated memory, skill reuse, cache-aware context, scheduling recovery, scoped tool discovery, review lanes | Autonomous instruction mutation, per-child-only budgets, host execution mislabeled as isolation |

### Ticket organization and revised sequence

The [ticket index](tickets/README.md) is the actionable cross-project backlog. OP-001 through OP-017 preserve the original F01–F17 mapping and incorporate relevant T3/Hermes evidence. OP-018 through OP-025 add missing coding/synchronization, verified completion, portable handoff, tool-discovery, and isolated-execution work. OP-026 through OP-033 add explicit subagent and Ollama extension features; section 14 advances the requested delegation core into the next product tranche. Each ticket links concrete upstream files and existing Outpost owners; these are integration starting points, not claims that missing code already exists.

1. **Dependable runtime:** OP-001, OP-002, OP-013, OP-018, and OP-022. Measure with OP-017 and add bounded model recovery through OP-003. Exit only when acceptance, execution, interruption, reconnect, and completion states survive restarts honestly.
2. **Useful daily coding and knowledge:** OP-007, OP-019, OP-020, OP-021, OP-006, OP-014, and OP-023. Worktrees and verified review now precede broad connector/channel adoption. No whole-workspace restore before isolation; no stale check results presented as current evidence.
3. **Bounded recurring and reusable work:** OP-004, OP-012, OP-010, and OP-009, followed by OP-005. Require admission/delivery recovery tests and aggregate budgets before unattended expansion.
4. **Optional ecosystem expansion:** OP-008, OP-024, OP-011, OP-016, OP-015, and OP-025. Tool discovery depends on an actual tool catalogue; programmatic execution depends on demonstrated confinement. Defer rather than weaken the common gate.

This refines section 7's original OpenClaw-first sequence. Priority labels express risk/value, not that every P0 ticket must finish before any independent read-only work starts. No release dates or implementation effort estimates have been validated.

### Common definition of done

- Persist commands/results through the existing ledger and outbox. No second task or approval authority.
- Authenticate commands, bind approval to the concrete action/revision, and recheck revocation at dispatch.
- Exercise restart, duplicate input, stale revision, cancellation, capacity exhaustion, and unknown-side-effect paths—not only the happy path.
- Expose honest states in the current desktop, with API/event contracts suitable for other clients. Do not assume legacy Swift screens have new-feature parity.
- Bound history, buffers, context, artifacts, schedules, retries, and child work; provide retention/deletion rules.
- Provide migrations, rollback/disable behavior, redacted diagnostics, and feature-level tests. Referenced upstream tests are examples, not validation runs performed here.

### Licensing addendum

T3's [MIT licence](../../t3code/LICENSE) identifies copyright 2026 T3 Tools Inc.; Hermes' [MIT licence](../../hermes-agent/LICENSE) identifies copyright 2025 Nous Research. OpenClaw's licence discussion in section 9 still applies. Preserve required notices for substantial copied source or documentation, review transitive dependencies and asset licences separately, and record the imported commit. Behavioral inspiration does not require adopting upstream dependencies. This update contains recommendations and references, not imported runtime code.

## 14. Pi subagent and Ollama Cloud extensions

### Confirmed installed packages and evidence boundary

These are the two extensions present in the operator's Pi installation:

| Package | Inspected version | Local evidence | Upstream |
|---|---|---|---|
| `pi-subagents` | **0.83.0** | [package manifest](../../../.pi/agent/npm/node_modules/pi-subagents/package.json), [README](../../../.pi/agent/npm/node_modules/pi-subagents/README.md) | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) |
| `pi-ollama-cloud` | **0.13.1** | [package manifest](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/package.json), [README](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/README.md) | [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud) |

This addition reviews installed package documentation, public API declarations, and representative Ollama TypeScript implementation. The subagent distribution contains bundled runtime code and declarations; this is not a full audit of its internal runtime. Versions identify installed npm artifacts, not an assumed upstream Git commit. No child agents, live probes, account requests, or provider benchmarks were run for this review. Local extension links resolve under the operator's `.pi/agent/npm/node_modules/`, outside Outpost, and may change after an extension upgrade.

Outpost's [package manifest](../package.json) pins Pi SDK 1.4.0, and its [runtime](../server/pi-adapter/runtime.ts) uses a custom resource loader with empty extension/skill collections and only `outpost_action`. **Installed in the developer's Pi does not mean installed or integrated in Outpost.** Even if package minimum versions appear compatible, qualify the actual APIs, settlement events, headless behavior, and child-loading path before enabling either package.

### Subagent features to adopt explicitly

The earlier OP-009 worker ticket was too broad to capture this extension's user-facing functionality. Keep it as the lifecycle/budget umbrella and add these concrete slices:

| Ticket | Requested capability | Outpost adaptation |
|---|---|---|
| [OP-026](tickets/OP-026.md) | Builtin/custom roles, per-role models/thinking, fresh/fork context, preflight and capability ceilings | Versioned role registry and an exact resolved launch contract; disable ambient extension/tool inheritance |
| [OP-027](tickets/OP-027.md) | Sequential/parallel workflows, independent lanes, structured results, review loops, councils | Reviewed workflow templates, bounded fan-out, isolated writers, explicit verdicts and pass caps |
| [OP-028](tickets/OP-028.md) | Async runs, retained children, resume/steer/interrupt/stop, fleet inspector, mission evidence | Durable ledger-owned child tree, scoped desktop inspection, correlated control receipts and completion delivery |
| [OP-029](tickets/OP-029.md) | Child questions, structured interviews, progress updates, nested supervisor routing | Durable decision inbox with exact request correlation; distinguish guidance from action approval |
| [OP-030](tickets/OP-030.md) | Opt-in watchdog, scope-drift/test-gap checks, launch diagnostics | Bounded independent review and delegation doctor, never a replacement permission arbiter |

**Roles and context.** The package supplies scout, researcher, evidence-auditor, worker, reviewer, oracle, and delegate roles. Outpost should expose reviewed equivalents and custom profiles, not silently load project-local agents. Fresh-context review reduces inherited assumptions; forked context preserves useful background but needs scope filtering and provenance. Research roles require actual research tools: supplying a role name is not proof those tools loaded. Use [model resolution guidance](../../../.pi/agent/npm/node_modules/pi-subagents/docs/models.md) and the [launch-contract declaration](../../../.pi/agent/npm/node_modules/pi-subagents/src/api/preflight.d.ts) to design a preview showing effective model, thinking, skills, tools, extensions, workspace, and context. Upstream's optional/warn-only model restrictions are not a suitable default for Outpost's enforced authority.

**Workflows and councils.** [Workflow documentation](../../../.pi/agent/npm/node_modules/pi-subagents/docs/workflows.md) supports stable keyed children, parallel fan-out, sequential lanes, structured output, gates, steering receipts, worktree isolation, and retained-session reuse. A normal child exit or `ok` receipt does not prove the requested work was done. Make verification explicit through OP-022. The [council protocol](../../../.pi/agent/npm/node_modules/pi-subagents/skills/council-mode/SKILL.md) adds independent reports, curated cross-examination, and an owner-facing memo; it is read-only advice, not unrestricted peer chat or authorization to implement. Adopt the behavior without copying terminal slash commands or requiring arbitrary JavaScript workflows in the first release.

**Background ownership and visibility.** [Observability](../../../.pi/agent/npm/node_modules/pi-subagents/docs/observability.md) distinguishes in-process foreground children, detached runners, live hints, status snapshots, completion replay, and process-terminal proof. Translate the fleet into Outpost's desktop/task UI, with paged transcripts and artifact links. Keep launch acceptance, execution success, task verification, notification delivery, resumability, and safe cleanup as separate facts. Some upstream completion records are temporary and best-effort; they cannot replace the ledger. Async child usage also does not automatically appear in Pi's ordinary session footer, so capture it explicitly.

**Missions and schedules.** The [mission guide](../../../.pi/agent/npm/node_modules/pi-subagents/docs/missions.md) contributes objective/run/decision/receipt linkage, bounded persistent workflow state, quiet recurring outcomes, and recovery navigation. Map these to Outpost tasks, recipes, scheduler occurrences, and delivery receipts rather than introduce another lifecycle owner. Upstream goal missions provide attention notices, not autonomous replanning; closing a mission does not itself pause its schedule, and goal notice budgets do not gate schedule admission. Outpost must explicitly couple revocation/closure and schedule policy where intended, and retain aggregate admission limits.

**Permissions and budgets: deliberately do not copy defaults.** The [watchdog guide](../../../.pi/agent/npm/node_modules/pi-subagents/docs/watchdog.md) documents optional child permissions whose unspecified tools default to allow, whose bash calls pass through, and whose `ask` is answered by a model arbiter. None is equivalent to Outpost's exact-action owner approval. The workflow guide also says usage budgets account for completed children and reject later launches without stopping already-running ones. Outpost needs admission reservation and active aggregate limits from OP-009. External CLI runners remain a separate later adapter/security decision; failed native delegation must not silently fall back to them.

### Ollama extension features beyond existing inference

`pi-ollama-cloud` connects directly to `https://ollama.com`; it is not the local `ollama` provider and does not require a local daemon. Outpost already has compatible inference, so adopt the missing provider/research/visibility features instead of duplicating its transport blindly.

| Ticket | Requested capability | Outpost adaptation |
|---|---|---|
| [OP-031](tickets/OP-031.md) | Live model discovery, cached catalogue, modality/context/thinking metadata | Capability-aware picker and role-model selection; exact provider identity and last-good snapshot |
| [OP-032](tickets/OP-032.md) | Web search/fetch, cached expansion, pagination, refresh and toggles | Gate-controlled research tools, cited artifacts, identity-scoped bounded cache and explicit Cloud egress |
| [OP-033](tickets/OP-033.md) | Quota/balance, renewal, request history, cost estimates | Desktop/provider diagnostics and durable parent/child totals with explicit accuracy/completeness labels |

**Catalogue details.** [models.ts](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/models.ts) queries `/v1/models` and `/api/show`, filters chat/tool-suitable models, sets explicit OpenAI-compatible transport flags, and keeps a generated or persisted fallback. On partial metadata failure the implementation retains its last-good baseline and reports an incomplete refresh; do not infer complete fresh coverage from README shorthand. [thinking-levels.ts](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/thinking-levels.ts) uses generated metadata and probe-derived overrides: supported levels and a true off switch are not established by a boolean `thinking` flag alone. Outpost's existing [thinking probe](../server/models/thinking.ts) is therefore a starting point, not full parity.

**Research tools.** [Web-tool behavior](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/docs/web-tools.md) includes snippets, free cached expansion, chunked text fetch, explicit refresh, success/selected-failure caching, and size/entry caps. The extension's cache stores raw URLs/content and uses last-writer-wins across processes. Outpost should instead own concurrent cache writes, enforce identity/credential scope, reject secret-bearing URLs, retain source timestamps, and expose deletion. Even with a local model, using these web APIs sends queries/URLs to Ollama Cloud; the UI and policy must make that boundary visible.

**Usage truthfulness.** [usage.ts](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/usage.ts) and the [usage guide](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/docs/usage.md) expose account balance and request histograms. The footer integration in [index.ts](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/index.ts) is TUI-only and guards against stale refresh generations. Reuse the data contract, not the terminal widget. Published per-token equivalents are not subscription charges; missing price entries return zero upstream and cache-token usage is unavailable. Outpost should label unknown prices as unknown, retain measured usage separately, and avoid double-counting child receipts.

### Revised priority and first milestone

The operator explicitly requested these features. **Advance OP-009 from P2 to P1** and deliver a bounded delegation core alongside daily coding/knowledge work, rather than leaving all subagents behind general connectors. Section 13's prior sequence is refined as follows:

1. Complete the admission, policy, scoped-stream, and verified-completion foundations in group A.
2. Add one read-only scout/reviewer role, one worker role, preflight, a durable background run, fleet inspection, and supervisor decisions: OP-009, OP-026, OP-028, OP-029. Require managed worktrees before concurrent writers.
3. Add Ollama catalogue/selection, research tools, and quota visibility through OP-031–OP-033. Search/fetch and quota can ship independently of general MCP support and need not wait for writable multi-agent workflows.
4. Add bounded parallel reviews, review loops, and councils through OP-027; then opt-in watchdog behavior through OP-030. Integrate recurring delegated recipes through existing OP-004/OP-010 rather than another scheduler.

Do not promise safe plug-and-play loading: Pi extensions execute trusted code with host process privileges. Either bind explicitly approved APIs with mandatory child gate propagation or reproduce the relevant behavior inside Outpost. Acceptance tests must prove the gate is active in every child, including resumes and nested launches. The package being MIT or having a permission hook is not evidence of confinement.

### Extension licensing

Both inspected packages are MIT: [pi-subagents licence](../../../.pi/agent/npm/node_modules/pi-subagents/LICENSE), copyright 2026 Nico Bailon; [pi-ollama-cloud licence](../../../.pi/agent/npm/node_modules/pi-ollama-cloud/LICENSE), copyright 2026 Fabio. Preserve notices for substantial copied source/documentation and review dependencies/assets separately. Record exact package versions and integrity hashes if code is imported; this update imports no runtime code.

## 15. T3 remote access and load-balancing rescan

The requested rescan found implemented functionality that the earlier coding-focused review did not cover adequately. Read the [detailed rescan](T3-REMOTE-CONNECTIVITY-ANALYSIS.md) for concrete source links, algorithm thresholds, trust boundaries, and qualification limits. This uses the newer `2c119bd9` checkout, not the original `cfafb4bb5` snapshot. T3 Connect lives within T3's `infra/relay`; Tailscale was reviewed through T3's integration, not a standalone VPN audit.

### What is implemented, and what it means

- **T3 Connect:** account-linked environments, proof-bound bootstrap, environment-issued sessions, managed Cloudflare tunnels, generation-fenced provisioning/cleanup, connector recovery, and optional held webhook delivery. Normal application traffic goes through the environment's tunnel hostname rather than an application proxy in the relay Worker; the tunnel provider still participates in transport. Cloud login is not blanket execution authority.
- **Tailscale:** MagicDNS/tailnet discovery, private HTTPS Serve setup/removal, bounded CLI probes, and typed diagnostics. Tailscale reachability does not replace pairing/authentication; a shared-address-space IP alone does not prove Tailscale membership. Outpost already uses Tailscale for administration, so the gap is product integration and safe lifecycle management.
- **Multiple routes:** one stable environment can have LAN, Tailscale/VPN, HTTPS, SSH, and Connect routes. Preflight, route ordering, credential-aware learned addresses, cooldowns, and permission refresh improve reconnect behavior. This is failover to the same server, not migration of work between servers.
- **Host load balancing:** opt-in web/desktop placement of new threads, scoring `weight × CPU count × idle CPU fraction × available memory fraction`. Missing/stale/saturated candidates are excluded, and the draft's selection is pinned. It is not a distributed reservation system, live thread migration, GPU scheduler, or fixed traffic split. Mobile retains manual selection in the inspected docs.
- **Linked environments:** explicit remote delegation with narrowed mode grants, namespaced idempotency, origin tracking, restartable result followers, and cancellation. Links are not OS isolation, and the inspected remote delegate path does not support the local `worktree` isolation flag unchanged.
- **Provider hubs:** pooled quota visibility through CLIProxyAPI integration is separate from configuring model traffic through that proxy. Monitoring a pool does not mean T3 itself balances inference across it.

### New tickets and integration ownership

| Ticket | Feature | Priority |
|---|---|---|
| [OP-034](tickets/OP-034.md) | Stable server identity and multi-route failover | P1 |
| [OP-035](tickets/OP-035.md) | Tailscale private HTTPS setup/status/removal | P1 |
| [OP-036](tickets/OP-036.md) | Optional managed Connect-style broker | P2 |
| [OP-037](tickets/OP-037.md) | Resource-aware worker placement with durable admission | P1 |
| [OP-038](tickets/OP-038.md) | Peer links and remote subagent delegation | P2 |
| [OP-039](tickets/OP-039.md) | Ownership-safe SSH/services and resource protection | P1 |
| [OP-040](tickets/OP-040.md) | Provider hubs, pooled quota, approved endpoint routing | P2 |

Keep **one Outpost coordinator/ledger** and place new worker jobs across the existing approved hosts first. Revalidate workspace, model, credentials, scope, and capacity, then reserve capacity atomically before dispatch. Host CPU/memory is only one input; queued work, model/browser slots, GPU limits where measured, and data locality matter. A network partition does not prove a worker stopped. Do not create multiple active SQLite coordinators behind a round-robin proxy as a shortcut to HA.

Remote access should initially build on private Tailscale/SSH and preserve Outpost's HTTPS-or-loopback transport rule. The managed broker and independent-environment federation are later opt-in operational expansions. No requirement to adopt Cloudflare, Clerk, T3 subscription plans, or external inference proxies follows from this analysis.

These tickets extend existing ownership rather than duplicate it: OP-018 owns scoped synchronization, OP-001/OP-009 own admission/budgets, OP-026–OP-029 own subagents, OP-004 owns webhook occurrences/deduplication, OP-012 owns browser takeover, and OP-017/OP-033 own diagnostics and usage. OP-015 remains optional generic execution-node expansion; the two-host placement slice need not wait for it.

## Final recommendation

The strongest next milestone is **a dependable Outpost operator**, not maximum feature parity with any reference project: durable inputs, bounded context and synchronization, clear diagnostics, and verified completion. Then add usable skills/memory and task-owned worktrees with safe checkpoints and revision-bound code review. Expand scheduling, browser continuity, recipes, and bounded workers only on those foundations.

Use T3 primarily for coding and synchronization, Hermes for bounded knowledge and automation recovery, OpenClaw for persistent-operator patterns, pi-subagents for explicitly managed delegation, and pi-ollama-cloud for model discovery, research tools, and quota visibility. The [40-ticket backlog](tickets/README.md) includes the requested extension and remote/load-balancing features while preserving Outpost's ledger, Pi runtime, clients, evidence model, and explicit authority boundaries. Start remote work with private access and server-owned worker placement; managed brokers and full environment federation remain explicit later choices.
