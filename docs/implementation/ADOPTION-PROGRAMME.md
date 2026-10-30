# Outpost adoption programme — owner decisions and proposed delivery plan

**Status: approved by the owner on 2026-10-30; implementation started.** The owner additionally authorized SSH inspection to identify the existing PostgreSQL service. Live database migration, deployment and service/network changes remain separately gated.

This programme covers OP-001–OP-040 and prerequisites needed to make those tickets usable. It does not claim completion of the original 270-requirement catalogue. It supplements the historical implementation records rather than rewriting their evidence. The owner's questionnaire answers are the governing product decisions below.

## 1. Approved product direction; proposed execution plan

| Area | Owner decision / interpretation |
|---|---|
| Scope | All 40 adoption tickets, respecting conditional enablement and feasibility gates; repair necessary existing integration gaps. |
| Client | Tauri macOS is the only new-feature client. Remove the legacy Swift macOS application code, targets, build scripts and app-specific tests. Retain iPhone/shared code where needed by the iPhone; no new iPhone parity is promised. |
| Architecture | Outpost-native features informed by reading upstream source. Do not embed OpenClaw, Hermes or T3 runtimes. Preserve Pi integration and one coordinator. |
| Database | Use the existing server PostgreSQL service as the eventual authoritative Outpost store. Develop/rehearse locally before authorized production cutover. |
| Parallelism | Independent implementation lanes use isolated worktrees, with sequential integration and verification. |
| Build agents | Explicit `openai/gpt-6-astra` for builders and fresh independent reviewers. If unavailable, stop and request an explicit switch to `openai/gpt-6.1-sol`; no silent model or CLI fallback. |
| Approval cadence | One approval of this programme before implementation; autonomous progress thereafter within scope. Genuine blockers, new permissions and architecture/scope expansions still require a decision. |
| Git | Dedicated programme branch, reviewed feature commits and pushes to the existing `origin`. No automatic merge to main or release publication. |
| Runtime default | Auto only when an eligible independent reviewer is qualified for the applicable configuration/action class; otherwise Ask permission. Preserve existing task policies and show effective mode/fallback. |
| Host execution | Retain the explicitly privileged, trusted deployment model. Do not describe it as a sandbox. OP-025 remains a security/feasibility gate, not permission to execute arbitrary model code. |
| Build-time access | Local implementation and disposable local tests initially. Remote inspection, deployments, provider calls, service/network changes and release credentials require separate authorization. Git pushes to the agreed branch are specifically authorized. |
| Inference | Local/self-hosted and Cloud routes, exact identity, explicit egress policy, no silent local-to-Cloud fallback. |
| Remote access | Private Tailscale HTTPS/SSH first. Optional broker implementation stays gated; its concrete provider/hosting decision precedes that phase. |
| Integrations | GitHub plus Google Workspace (Gmail/Calendar). No Telegram. Provider scopes and actual test accounts require approval before live use. |
| Knowledge | Local embeddings, scoped memory, approved/versioned skills, owner-reviewed learned procedures. |
| Browser | Dedicated persistent agent profiles and real human login/MFA handoff. No everyday personal-browser attachment. |
| Design | Preserve Soft Studio/Ink and the existing AppKit sidebar. |
| Acceptance | Release-level qualification, including signed distribution, real-device testing and recovery/accessibility evidence. Missing authorization or resources keeps a gate blocked, not passed. For this desktop-only scope, physical-device qualification means the real Mac, not new iPhone feature acceptance. |

## 2. Local inspection findings

- Baseline source is currently `e9af739`; the checkout is on `main` with a modified feature analysis and untracked remote analysis/tickets supplied before this programme. Preserve those inputs byte-for-byte in a distinct source-backlog snapshot after approval.
- `deploy/homelab/README.md` records an existing PostgreSQL service alongside other shared services. This is historical evidence, not a live inventory: database version, endpoint, TLS/authentication, available extensions, ownership, capacity and backups have not been verified.
- `server/core/ledger.ts` uses synchronous `node:sqlite` operations and explicitly rejects async transactions. PostgreSQL is therefore not an environment-variable-only change.
- The coordinator accesses the SQLite outbox directly; memory uses FTS5; backups package SQLite files; domain methods, HTTP/runtime code, tests and live verification scripts depend on synchronous ledger behavior.
- `clients/Package.swift` and `clients/project.yml` contain both shared/iPhone dependencies and Swift Mac targets. Deleting all of `clients/` would exceed the request and break retained assets/consumers, including homelab guide fonts.
- Tauri already reuses the Keychain identity. Its documentation says device enrollment/revocation and some management controls remain in the old client. Required desktop controls must be ported rather than removed with their last usable UI.
- Existing acceptance reports are historical. Fresh baselines are required; no tests have been rerun as part of writing this plan.

## 3. Architecture decisions

### 3.1 PostgreSQL first, before new runtime features

**Recommended:** migrate the authoritative storage and all affected call paths in a bounded foundation tranche before building new lifecycle features on top.

Alternatives rejected for this programme:

1. A synchronous PostgreSQL bridge or shadow in-memory ledger: hides network failures, blocks the event loop or creates a second authority.
2. A long-lived SQLite/PostgreSQL dual-write arrangement: doubles recovery/migration paths and introduces disagreement over command/effect ownership.

Implementation design:

- Use a maintained asynchronous PostgreSQL driver with bounded pooling, connection/query timeouts, parameterized statements, TLS configuration and redacted errors. Pin the selected dependency after compatibility review.
- Introduce explicit transaction-scoped repositories; eliminate the process-global SQLite nesting-depth assumption. Use awaited callbacks and transaction-local savepoints where nesting is necessary. External model/tool/provider calls must not occur while holding database transactions.
- Preserve atomic command receipts, revision checks, records, events and outbox intent. Unique constraints enforce idempotency and explicit compare-and-swap protects revisions under concurrent requests.
- Preserve signed-envelope canonicalization, existing identifiers and action digests through migration; JSONB storage does not redefine wire canonicalization. Validate numeric ranges instead of silently rounding PostgreSQL bigints in JavaScript.
- Define a commit-safe event cursor/watermark contract. A PostgreSQL sequence alone does not guarantee commit order; use transactional cursor allocation/serialization or an equivalently proven publication design. Snapshot-plus-delta tests must exercise overlapping transactions.
- Use fenced coordinator ownership and atomic outbox claims. A second accidental coordinator must not dispatch concurrently. `SKIP LOCKED` can support claims, but is not evidence that lost effects are safe to replay.
- PostgreSQL becomes the only active server authority. SQLite remains only in explicit read-only import/legacy-backup tooling, not as a silent production fallback.
- Preserve the generic versioned record envelope where useful; add typed relational tables/constraints for new lifecycle/index data where warranted. Do not redesign every domain solely for style.
- Replace FTS5 with scoped PostgreSQL text-search indexes; support exact identifiers as well as ordinary language. Local embedding generation remains separate. Do not assume `pgvector` is installed or install an extension on the shared server without approval; select and benchmark a bounded vector index implementation in the memory slice.
- Database records do not replace workspace files, browser credentials, Pi sessions or artifact blobs. Recovery inventory and consistency rules must cover those state classes separately.

### 3.2 Safe SQLite-to-PostgreSQL migration

1. Build a dry-run importer against disposable local fixtures. Preserve records/revisions, event identities/cursors, idempotency receipts, outbox state and forgetting tombstones. Reject nonempty/foreign destinations unless an explicit supported resume manifest matches.
2. Validate row counts, canonical payload hashes, artifacts and command replay behavior; rebuild derived indexes without resurrecting forgotten data.
3. Rehearse crash/resume and import integrity failures. Imported instances start with dispatch held. Claimed or ambiguous external work remains unknown/reconciling.
4. Before production: obtain read-only PostgreSQL/service inventory authorization, a dedicated Outpost database/role plan, backup destination/key custody and a maintenance window. Never modify another application's database/schema or dump unrelated data.
5. Freeze the old coordinator, back up all relevant state, import, verify, start PostgreSQL-backed Outpost on Recovery Hold, and reconcile before owner-authorized dispatch enablement.
6. Before new PostgreSQL writes, rollback can return to the frozen SQLite snapshot. After new writes/effects, rollback requires explicit reconciliation/export-forward recovery; never silently revert to an obsolete SQLite file.
7. Rehearse PostgreSQL backup/restore using supported tooling, consistent artifact manifests and dispatch holds. Do not claim off-host recovery or point-in-time recovery merely because PostgreSQL exists.

### 3.3 One lifecycle, one effect gate

All entry points—desktop input, schedules, children, recipes, channels and peers—feed the same admission/run owners and concrete-action gate. Stored instructions, summaries, reviewer messages and connector metadata do not mint authority.

Distinct facts remain distinct: accepted input, admission, runtime delivery, observed execution, verification, delivery and unknown external effects. Current revocation, grants, revisions, identity and tool version must be rechecked immediately before effect.

Route failover reaches the same trusted server. Worker placement chooses a host for new work. Provider routing chooses inference destination. None implies live-task migration, coordinator HA or guaranteed exactly-once external effects.

### 3.4 Desktop retirement and compatibility

- Remove `clients/macOS/`, `clients/build-mac.sh`, Swift Mac application/UI-test targets, generated target references and obsolete active setup instructions.
- Remove Swift Mac-only presentation branches where not required by retained iPhone/shared testing. Preserve shared resources, licences and the retained iPhone application; a host-compilable shared test library is not a second Mac app.
- Keep Tauri's Objective-C/AppKit bridge, Rust transport and Keychain identity unchanged unless a specific ticket requires a reviewed change.
- Port missing essential device administration/recovery controls to Tauri. Scheduling/memory editing follows the corresponding feature tranche. Do not delete identities, cached user data or server history during source retirement.
- Preserve historical acceptance evidence, clearly marked superseded. Existing clients receive honest protocol compatibility errors rather than silently divergent semantics; full mobile feature parity is out of scope.

## 4. Delivery tranches

Tranches are dependency gates, not promises of calendar duration. A ticket can be sliced across tranches, but is accepted only when its complete approved contract has evidence. OP-009 is an umbrella, not work counted twice.

### T0 — Baseline, branch and desktop consolidation

- Capture user-owned backlog inputs separately; establish `feat/outpost-adoption` (or a nonconflicting equivalent).
- Record fresh backend/desktop/Rust/browser baselines and existing failures. Ensure local test harnesses never default to production endpoints/accounts or reused personal browser profiles.
- Add a traceability/evidence register linking each ticket, acceptance clause, revision, test command and status.
- Remove the Swift Mac application and restore essential Tauri device/recovery controls. Preserve the requested visual system.
- Define qualification-aware Auto defaults and test fail-to-Ask behavior; no fabricated qualified reviewer.

**Gate:** clean reproducible desktop build, identity continuity, explicit baseline failures, no active Swift Mac application target or documented supported build path.

### T1 — PostgreSQL foundation

- Async repository/transaction contracts and migrations, then domain/gateway/runtime conversion.
- PostgreSQL memory-index baseline, outbox recovery, backup/import tooling, main/config/deployment templates and test harnesses.
- Exercise concurrency, commit ordering, stale revisions, duplicate signed commands, failed transactions, disconnects and restored dispatch hold against real disposable PostgreSQL.
- Complete local migration rehearsal; do not cut over the live server without its separate authorization gate.

**Gate:** existing supported product flows run end-to-end against PostgreSQL; no hidden SQLite production dependency; reviewed local import/restore evidence. This is a prerequisite for new mutation-heavy features.

### T2 — Dependable runtime

OP-001, OP-002, OP-013, OP-018, OP-022, with OP-017 instrumentation and OP-003 model recovery.

Build durable admission and run finalization first, then compaction/retry; develop read-only diagnostics and scoped-stream protocols independently where contracts allow. Test restart and unknown-effect boundaries before adding unattended volume.

**Gate:** no duplicate session owners, correct cancellation/revocation, bounded context/history/buffers, commit-safe snapshot/replay, verified completion rather than model-declared success.

### T3 — Daily coding and knowledge

OP-007, OP-019, OP-020, OP-021, OP-006, OP-014, OP-023.

Worktrees precede destructive restore and concurrent writers. Review/check freshness is revision-bound. Skills and memory are scoped, versioned and usable by the real runtime. The task board derives attention/completion from authoritative facts.

**Gate:** usable Tauri code-review/checkpoint flow, safe workspace cleanup, cited scoped recall, explicit continuation provenance, accessible attention actions.

### T4 — Subagents and Ollama

OP-009 through its OP-026/OP-028/OP-029 core; then OP-027. In parallel where independent: OP-031, OP-032, OP-033.

Start with a read-only scout/reviewer and a worker, prove effective tool/authority ceilings, reserve aggregate budgets and persist background completion/decisions. Add workflows/councils only after lifecycle and result verification. Catalogue discovery does not gate fixed-model child launches.

**Gate:** every nested action enters the common gate; no ambient extension tools; one writer per worktree; restart-safe parent wakeups and decisions; scoped research caches; honest cost/quota accounting.

### T5 — Private access and two-host placement

OP-034, OP-035, OP-039, OP-037.

Stable trusted server identity and the OP-018 connection owner precede route switching. Implement local service-ownership/diagnostic contracts before route-specific operations. Resource-aware placement uses fresh telemetry and atomic coordinator reservations, not client-side guesses.

**Gate:** wrong-host routes receive no credentials; permissions refresh on route change; only owned mappings/processes are managed; disconnected workers remain uncertain; concurrent clients cannot over-admit capacity. Real host/network changes require authorization.

### T6 — Automation and browser continuity

OP-004, OP-012, OP-010, then OP-005 and OP-030.

Calendar recurrence/preflight and recipe receipts share runtime admission. Browser handoff must fence actual Browser-Use input, not only a separate lease table. Begin with built-in/local-output workflows; connector-backed delivery completes with T7. Watchdog remains opt-in and bounded.

**Gate:** DST/restart/overlap behavior, one browser input owner, re-observation after takeover, unknown submissions not replayed, quiet monitors do not hide failed checks, bounded review loops.

### T7 — GitHub and Google Workspace integrations

OP-008, OP-024, OP-011, plus connector-backed slices of OP-004/OP-010.

Build managed connector/MCP lifecycle with a read-only GitHub pilot, then separately approved GitHub write/publish operations. Add Google OAuth/account lifecycle, scoped Gmail intake/drafts/approved sends and Calendar read/propose/approved writes. Use Gmail as the message intake/delivery pilot; do not add Telegram.

Channel-origin inputs default to draft/explicitly granted work; approvals stay on the signed desktop. Select minimal provider scopes during design; no blanket Google account access. Write adapters cannot be called qualified from mocks alone.

**Gate:** real runtime and Tauri management paths, schema-drift quarantine, revoke/disable fencing, cross-account isolation, lost-send acknowledgement reconciliation, provider rate-limit and credential-refresh recovery. Live qualification is a separate permission gate.

### T8 — Remaining expansion and feasibility

OP-016, OP-015, OP-036, OP-038, OP-040 and OP-025.

- Reviewed procedure learning with evidence and rollback.
- Paired execution-node capability and narrowly scoped local companion, not general remote desktop.
- Optional broker lifecycle after an explicit provider/hosting/cost/retention decision; the selected provider's working adapter and acceptance evidence are required, not only an interface or disabled toggle.
- Remote peer delegation with destination grants, isolated workspace contracts and correlated result/cancellation recovery.
- Provider-hub visibility separated from approved inference routing; automatic balancing remains adapter-qualified.
- OP-025: threat model, bounded read-only prototype only if a suitable approved local isolation backend exists, adversarial evidence and a go/no-go decision. If confinement is not demonstrated, keep disabled and record a no-go; do not claim a usable executor shipped.

**Gate:** ticket-specific end-to-end acceptance, authority/retention/revocation tests, no unsafe interpretation of an optional capability as automatically enabled.

### T9 — Integrated release qualification

- Run balanced Code/Browser/Operations workflows across the completed programme, not only per-module fixtures.
- Rehearse restart, route flapping, network partitions, provider failures, exhausted budgets, stale revisions, revocation, OAuth expiry, interrupted upgrades and uncertain delivery.
- Rehearse target PostgreSQL cutover and whole-system recovery with keys, artifacts, sessions, workspaces, browser profiles and connector checkpoints accounted for.
- Build signed/notarized Tauri distribution using owner-authorized identity, test clean installation/upgrade on a real Mac, and verify minimum supported platform behavior. Document unsupported architecture/OS combinations rather than inventing coverage.
- Audit keyboard navigation, VoiceOver, text sizing/zoom, light/dark appearance, contrast, reduced motion and native/web focus boundaries.
- Review upstream reuse licences/notices, dependencies and release configuration. Record actual results and outstanding defects; do not replace old evidence with invented passing reports.

**Gate:** required release checks actually pass. Signing, deployment, live accounts, physical-Mac interaction, accessibility permissions or recovery credentials that are missing remain blockers.

## 5. Complete ticket coverage

| Ticket | Tranche | Required acceptance focus |
|---|---|---|
| OP-001 | T2 | Ordered durable input; bounded admission; cancellation/restart ownership. |
| OP-002 | T2 | Supported Pi compaction; original evidence/authority preserved; bounded recovery. |
| OP-003 | T2 | Classified bounded retry; approved route changes only; no repeated tool effects. |
| OP-004 | T6/T7; broker extension T8 | Calendar/event identity, DST, preflight, pause, execution/delivery separation. |
| OP-005 | T6 | Quiet history, debounce, expiry, bounded remediation, honest failed probes. |
| OP-006 | T3 | PostgreSQL lexical/local-semantic recall, citations, scope and forgetting. |
| OP-007 | T3 | Approved progressive skill loading, pinned versions and confined references. |
| OP-008 | T7 | Install/probe/activate/update/disable/revoke; supervised MCP; real adapter. |
| OP-009 | T4 | Worker umbrella; aggregate reservations, inherited authority and verification. |
| OP-010 | T6/T7 | Durable typed steps, stale approvals, uncertain effects and resumable receipts. |
| OP-011 | T7 | Gmail intake/delivery, authenticated routing, deduplication and reconciliation. |
| OP-012 | T6 | Dedicated profiles, engine-enforced takeover, artifact transfers and recovery. |
| OP-013 | T2; extended T5/T8/T9 | Read-only doctor, exact repair plans, complete recovery inventory. |
| OP-014 | T3; extended T4 | Authoritative board/inbox, actionable blockers and cross-view convergence. |
| OP-015 | T8 | Node identity/capabilities, revocation, concrete local companion capability. |
| OP-016 | T8 | Reviewed procedure drafts, source evidence, activation/rollback and sanitization. |
| OP-017 | T2 onward | Correlated timings/usage, bounded redacted metrics and measured baselines. |
| OP-018 | T2; extended T5 | Scoped snapshots, paged history, bounded streams and one retry owner. |
| OP-019 | T3 | Managed worktrees, single writer, setup approvals and safe cleanup. |
| OP-020 | T3 | Checkpoint coverage, stale restore preview, shared-tree refusal and quotas. |
| OP-021 | T3 | Real diffs/checks/review, revision freshness and separate publish authority. |
| OP-022 | T2 onward | Evidence-backed run finalization, explicit unknown/failed/cancelled outcomes. |
| OP-023 | T3 | Bounded continuation, provenance, omissions and destination reauthorization. |
| OP-024 | T7 | Scoped schema discovery, concrete-action unwrapping and fail-closed validation. |
| OP-025 | T8 | Threat model and demonstrated confinement or explicit disabled no-go. |
| OP-026 | T4 | Roles, exact launch contracts, fresh/fork scope and hard model/tool ceilings. |
| OP-027 | T4; deterministic composition T6 | Keyed workflows, bounded parallel lanes, structured reviews and councils. |
| OP-028 | T4 | Durable async tree, retained sessions, correlated control and fleet inspection. |
| OP-029 | T4 | Durable child interviews/decisions, exact replies and no authority escalation. |
| OP-030 | T6 | Opt-in bounded watchdog, evidence-based findings and delegation doctor. |
| OP-031 | T4 | Capability-aware catalogue, last-good snapshots and explicit refresh status. |
| OP-032 | T4 | Gated Cloud search/fetch, scoped cache, citations, quotas and egress. |
| OP-033 | T4; extended T8 | Deduplicated attempt accounting and distinct measured/estimated/account usage. |
| OP-034 | T5 | Key-bound logical server, multiple routes, permission refresh and cooldowns. |
| OP-035 | T5 | Private Serve discovery/setup/removal with ownership and sanitized diagnostics. |
| OP-036 | T8 | Selected broker implementation, proof-bound bootstrap, fenced teardown/upgrade. |
| OP-037 | T5 | Server-owned atomic placement/reservation, fresh telemetry and locality. |
| OP-038 | T8 | Destination-granted peer children, scoped reads/writes and restartable followers. |
| OP-039 | T5 | Owned SSH/services, staged updates, interruption and reversible protection plans. |
| OP-040 | T8 | Deduplicated hub quota, explicit endpoints, no implicit inference balancing. |

Ticket acceptance clauses remain normative. The table is an index, not a substitute for reading each ticket and its upstream references.

## 6. Subagent execution and handoff contract

### Responsibilities and isolation

- Parent owns architecture, dependency graph, scope decisions, integration, final acceptance and publication.
- Builders implement one bounded ticket slice end-to-end, including tests, client wiring and migration/disable documentation.
- Fresh independent reviewers inspect requirements, actual diff and actual test evidence. They do not simply accept builder summaries.
- Owner expanded concurrency on 2026-10-30: start six independent builder lanes in separate worktrees (Swift Mac retirement, Tauri administration, model catalogue, web research, calendar recurrence and approved skills), plus PostgreSQL investigation and fresh reviewers. Start PostgreSQL conversion as its investigation resolves. Reduce concurrency if measured resource use or shared-contract conflicts warrant it.
- PostgreSQL conversion has exclusive write ownership of the ledger, existing domain transaction call sites and core coordinator/runtime wiring. Other builders may implement independently testable additive modules and desktop controls under explicit file boundaries. New service modules use asynchronous storage contracts where persistence is needed; parent-owned integration follows the database/runtime dependency gates. A reviewed additive slice is not completion of its full ticket.
- No writer shares a cwd/worktree. Cross-cutting schema, contracts, coordinator, policy and client-connection changes serialize unless interfaces and integration bases have already been fixed.
- Children cannot recursively spawn agents, change model/provider, push branches, deploy, use live secrets or expand scope without explicit parent authorization.

### Required child brief

Every launch specifies: exact model, goal, ticket/acceptance clauses, assigned worktree and base revision, approved edit scope, integration interfaces, relevant Outpost/upstream files and pinned source evidence, authority limits, required tests, expected evidence paths and conditions requiring a question.

Read relevant upstream code and tests before adopting behavior; retain licence/commit provenance for copied portions. Do not mistake present-day sibling checkouts for historical commits recorded by the analysis. Qualify Pi APIs against the actual installed/pinned SDK rather than assuming developer extensions are active in Outpost.

### Per-slice sequence

1. Confirm dependency gates and write the bounded slice contract.
2. Builder reads existing/upstream owners, adds regression tests and implements the real flow.
3. Run focused validation; preserve commands, exit codes and unavailable checks.
4. Fresh reviewer checks correctness, authorization/recovery and end-to-end requirements. Security-critical slices also receive an independent adversarial/evidence review.
5. Builder fixes accepted findings; fresh review verifies changed behavior. After two unsuccessful automatic fix rounds, checkpoint and escalate the unresolved issue rather than loop indefinitely or waive it.
6. Parent inspects the actual diff and reruns relevant tests on the integrated branch. Test results from a worktree alone do not qualify the final integrated revision.
7. Commit the accepted slice, update its evidence/status and push the programme branch. Do not merge to main, deploy or publish a release implicitly.
8. Select the next ready slice; keep externally blocked work distinct from locally implementable work.

Use one asynchronous native orchestration workflow for dependent build/review/fix work, with stable child keys, durable result references and retained-child correction where useful. Native completion wakes the supervisor; no model polling loops.

Infrastructure, launch or runtime failure stops the affected lane and is reported with run/worktree/partial-diff state. No silent fallback to another CLI or provider. Failed tests and missing reviews are not converted to acceptance. Preserve a resumable checkpoint when runtime/session limits interrupt the programme.

## 7. Evidence and status rules

Track three independent dimensions:

1. **Implementation:** not started / in progress / integrated / disabled feasibility no-go.
2. **Verification:** not run / local verified / live qualified / blocked / failed.
3. **Release:** not assessed / blocked / accepted.

A fixture-only adapter, unconnected module, screenshot-only screen or green catalogue row is not a completed feature. Live qualification must identify target environment, account/model configuration, source revision and evidence without exposing secrets.

Every accepted slice includes applicable migration and retention behavior, disable/rollback paths, privacy boundaries, bounded resource behavior, and representative end-to-end tests. Optional features may be disabled by default while fully implemented; a configuration stub alone is not implementation.

Suggested evidence location: `docs/implementation/evidence/adoption/`, with an index linking portable reports. Keep large local logs, database dumps, recordings and confidential test data out of Git; record redacted manifests/hashes where appropriate.

## 8. External decision and permission gates

These gates do not prevent local work on independent features. They prevent unsafe activation and false release-completion claims.

| Gate | Needed before | Required owner input/authorization |
|---|---|---|
| PG inventory | Production database design qualification | Bounded read-only inspection of the named existing server/service: version, endpoint/network, roles/TLS, extensions, capacity and backup status. No secret dumps or unrelated data. |
| PG cutover | Any live migration | Dedicated database/schema and least-privileged role approval, connection secret reference, verified backup, maintenance window and recovery owner. |
| Live models | Reviewer/Cloud/usage qualification | Approved endpoint/accounts/models, budget and permitted test content. No developer Pi auth-file copying. |
| GitHub/Google | Live connector acceptance | Test repositories/mailboxes/calendars, OAuth application/scopes and test recipients; writes separately approved. |
| Tailscale/services | Host or exposure changes | Named mapping/service/resource plans and rollback. No Funnel/public ingress. |
| Broker | Provider-specific OP-036 implementation and deployment | Hosting/provider, identity approach, domain, spending cap, transport/privacy and optional webhook-retention decision. No mandatory cloud service inferred. |
| Nodes/peers | Live remote delegation | Approved destinations, keys/grants, data boundaries and workspace/isolation capabilities. |
| Recovery | Release gate | Retention policy, encrypted off-host destination, key custody, restore target and an approved rehearsal. |
| Distribution | Signed release qualification | Apple signing/notarization identity through a secure reference; approved build targets, real Mac access and accessibility permissions. |

Do not paste secrets into chat or repository files. Use existing secure configuration/credential references. Until additional permission is supplied, all implementation agents stay within local/disposable environments.

## 9. Execution authorization

The owner approved starting implementation and SSH identification of PostgreSQL on 2026-10-30. Work proceeds on `feat/outpost-adoption` using Astra builders and reviewers. See [ADOPTION-STATUS.md](ADOPTION-STATUS.md) for progress and [initial evidence](evidence/adoption/baseline-and-postgres.md). Subsequent in-scope slices proceed automatically; other live gates above remain closed until explicitly authorized.
