# Spec 29 — implementation acceptance record

**Assessment: working development slices, not a complete product or release candidate.**

The request covers all 31 specifications and 270 requirements. This implementation does **not** satisfy every requirement. Every module has an initial implementation or delivery/qualification record, but several are independently tested libraries rather than integrated product features. The searchable catalogue is requirements navigation, not evidence that 270 features shipped.

## Reproduction and observed results

Code revision tested: `a33563dea6d393371d3b3be62d75e9059c0e497f` (integration-hardening commit). Evidence captured 28 October 2026 on the development Mac, not an Ubuntu deployment.

| Command / rehearsal | Expected | Observed |
|---|---|---|
| `npm run check` | Type-check and deterministic backend tests pass | 33 tests passed, zero failures |
| `node --import tsx --test --test-reporter=junit server/**/*.test.ts` | Machine-readable backend results | [JUnit evidence](evidence/node-tests.xml), 33 passes |
| `swift test --package-path clients` | Native event projection handles duplicates, invalid pages and catalogue uniqueness | 3 tests passed |
| `./clients/build-mac.sh` | Build and ad-hoc sign the Mac app | `clients/build/Outpost.app` built successfully |
| `OUTPOST_SIMULATOR_ID=F3F8F51B-B0FE-4872-87E2-EC805B8CF0DE ./scripts/test-native-ui.sh phone` | Pair through real HTTP, create task, propose inspection, observe pending approval without manual refresh | Passed, 1 XCUITest, zero failures; iPhone 18 Pro simulator / iOS 27.0 |
| Mac XCUITest | Same flow on macOS | **Blocked**: runner timed out enabling automation mode. Build passed, UI automation did not execute. No permission bypass attempted. |
| `npm audit` | Identify known dependency vulnerabilities | Zero reported at capture time; not a security certification |

The iPhone smoke test exercised signing and Keychain with an **ad-hoc signed simulator app**. Building with `CODE_SIGNING_ALLOWED=NO` compiled, but Keychain identity creation failed in the first smoke test. Use the signed test script, not an unsigned simulator build, for this flow.

The native test required no human interaction after launch. It stops **before** LocalAuthentication approval and does not claim biometric/physical-device qualification. The backend signed-device fixture separately covers approval and actual execution.

Local, non-portable diagnostic artifacts:

- `clients/build/OutpostPhone-20261028-010708.xcresult`: passing iPhone UI run.
- `clients/build/MacUI.xcresult`: blocked macOS automation attempt.
- `/tmp/outpost-native-fixture.PO82PB`: isolated iPhone fixture ledger and server log.
- `/tmp/outpost-check.log`, `/tmp/outpost-swift.log`, `/tmp/outpost-mac-build.log`.

The committed results and screenshot are the portable evidence; the paths above may disappear.

## Real native visual evidence

[Soft Studio iPhone pending-action screen](evidence/iphone-pending-action.png)

SHA-256: `d2c55c222bea9d010cd3fc85a700f7ee726ab6d532c52f6e03674d8710e06e54`

This is an actual SwiftUI screen connected to the fixture coordinator, not an HTML mockup. The task and pending `system.inspect` action were created through signed HTTP commands. It shows an honest capacity wait because no qualified Cloud roles were configured. Inspection has **not** executed in this screenshot.

Reviewed: Geist typography, neutral Ink surfaces, 22-point panel corners, clear action target and identity, separate conversation/evidence, readable approval labels, scrollable evidence. Changed the compact task navigation title to inline to leave more room for work. The UI test also found and drove fixes for foreground polling, and the integration tests cover outbox notice starvation and operation correlation.

Not reviewed/accepted: VoiceOver interaction, extreme Dynamic Type, all small-device sizes, macOS window screenshots, dark-mode screenshots, Reduce Motion, keyboard-only completion, real Face ID/Touch ID, physical-device notifications. No claim of complete HIG/accessibility compliance.

## Module evidence and explicit remaining scope

Every requirement's stable ID and owner remain in [`spec/feature-map.md`](../../spec/feature-map.md). The generated native catalogue preserves all 270 IDs. The table below links **module-local evidence**; it is not per-feature acceptance. No module is marked fully accepted.

| Spec | Implemented/tested slice | Evidence | Major missing integration/depth |
|---|---|---|---|
| 00 | Modular coordinator, ledger, shared native client | `PLAN.md`, `server/gateway/` | Protected Ubuntu host/guest deployment, full end-to-end pillars |
| 01 | Tasks, ordered instructions, checkpoint/recovery, Pi adapter | `server/tasks/tasks.test.ts`, `gateway/recovery.test.ts` | Live Pi task completion, complete plan/run lifecycle, continuation after human waits |
| 02 | Confined file operations, stale-write hashes, chunked/checksummed artifacts | `server/artifacts/files.test.ts`, `gateway/http.test.ts` | Hostile concurrent filesystem isolation, large-file streaming, native upload-resume UI |
| 03 | Process groups, bounded output, timeout/cancel, clean environment | `server/processes/runner.test.ts` | cgroups/VM isolation, full live log transport, complete executable qualification |
| 04 | Real machine inventory, bounded admin previews | `server/operations/machine.test.ts` | Privileged execution broker, task-owned systemd administration |
| 05 | Capability manifests, hash checks, health probes, staged activation | `server/capabilities/catalogue.test.ts` | Install/update/uninstall UI, package trust and full qualification lifecycle |
| 06 | Real headless Chromium observation/screenshot/input lease | `server/browser/browser.test.ts` | Coordinator/native viewer wiring, uploads/downloads, browser crash recovery, Ubuntu deployment |
| 07 | Encrypted credential vault, task scopes, revocation | `server/brokers/identities.test.ts` | OAuth/provider accounts, native identity/grant management, Chrome attach/import, isolated broker |
| 08 | Deduplicated assistance with fresh observation checks | `server/browser/assistance.test.ts` | Native same-session login/CAPTCHA/MFA flow and sensitive capture redaction |
| 09 | Repository inspection, conflict-safe patches, checks tied to revision | `server/code/repository.test.ts` | Full Pi worktree/review experience, diffs/checks on both clients, LSP |
| 10 | PR planning, durable external-delivery intents, uncertain reconciliation | `server/delivery/operations.test.ts` | Live GitHub identity, PR/push CI integration and native controls |
| 11 | Independent deployment/rollback health checks | `server/operations/health.test.ts` | Actual service/deployment orchestrator and protected machine credentials |
| 12 | Bounded source capture and passage-grounded citations | `server/research/sources.test.ts` | Search provider, research tool/client wiring, full provenance/redaction UX |
| 13 | Escaped HTML, actual Chromium PDF/screenshot generation, CSV safety | `server/documents/documents.test.ts` | Office formats, rich previews, broad document validation |
| 14 | CSV profiling and exact minor-unit reconciliation | `server/data/analysis.test.ts` | SQL/database connectors, spreadsheet analytics, charting and permissions |
| 15 | Bound mail drafts and calendar proposals | `server/communication/drafts.test.ts` | Gmail/Graph/calendar provider delivery, read/sync, full compose UI |
| 16 | Workflow dependency rules and artifact-backed steps | `server/workflows/recipes.test.ts` | Integrated errand execution across provider accounts and browser |
| 17 | Whole-workflow mandate digest, budget reservation, uncertain settlement | `server/brokers/payments.test.ts` | Both native mandate screens, issuer handoff, eligible sandbox/live payment route |
| 18 | Durable schedule occurrences, missed-run coalescing, quiet monitors | `server/scheduler/scheduler.test.ts` | Rich recurrence/timezone/DST editing and real monitor connectors |
| 19 | Scoped SQLite FTS, provenance, forgetting tombstones, rebuild | `server/memory/memory.test.ts` | Vector/hybrid retrieval, comprehensive retention and native provenance controls |
| 20 | Worker scope/budget accounting, resource leases, cancel propagation | `server/workers/coordination.test.ts` | Live Pi specialist scheduling/merge and native worker oversight |
| 21 | Tool catalogue, common-gate invocation and discovery | `server/capabilities/tools.test.ts` | Production MCP transport, signed extension installation and compatibility suite |
| 22 | Pinned Pi adapter, distinct roles, fail-to-ask reviewer validation | `server/models/cloud.test.ts` | Actual account model qualification, smaller-reviewer evaluation, vision/media use |
| 23 | Bounded ffprobe/ffmpeg inspection and audio conversion | `server/media/media.test.ts` | Voice transcription/playback, image/OCR provider integration, native media flows |
| 24 | Real Mac workspace, signed commands, encrypted projection/pending retry cache | Swift tests; Mac release build | Full module navigation, streaming, visual/accessibility verification, distribution |
| 25 | Shared iPhone workspace, HTTP replay, APNs sender/token fixtures | `server/gateway/http.test.ts`, `notifier/apns.test.ts`; native smoke test | Physical two-client rehearsal, signed APNs entitlements/delivery, Live Activities, notification preferences UI |
| 26 | Three modes, exact-action approvals, signed devices, dispatch rechecks | `server/policy/trust.test.ts` | Qualified isolation, server-verifiable step-up, complete policy inheritance, redaction/security audit |
| 27 | Encrypted ledger/artifact backup and checked offline restoration | `server/reliability/backup.test.ts` | External backup rotation, large archive streaming, key escrow/rotation, replacement Ubuntu rehearsal, comprehensive resource limits |
| 28 | Durable records/events/outbox/idempotency, shared wire semantics | `server/core/ledger.test.ts`, HTTP/Swift tests | Generated typed bindings, full schema migration/protocol negotiation/conformance suite |
| 29 | Reproducible regression and native fixture scripts; this report | JUnit, XCUITest screenshot | Balanced real pilot and per-feature acceptance evidence |
| 30 | Explicit local pins, source/decision register, unqualified-input record | `DECISIONS.md`, `QUALIFICATION.json` | Owner infrastructure/account/distribution decisions and actual qualification |

### Important security/product boundaries

- Local coordinator and subprocess runner are **cooperative development**, not an isolation boundary against malicious code, root or an enrolled arbitrary interpreter. Do not enroll an unrestricted shell/interpreter and treat its path as a sandbox.
- Auto uses a deterministic reviewer fixture in tests. No measured dangerous-false-allow threshold or actual smaller-model evaluation exists.
- Native LocalAuthentication gates sensitive UI interactions. The server currently verifies a device signature, **not hardware-attested proof of that local authentication**.
- Upload primitives are resumable/idempotent on the server; the current native file importer does not retain a complete multi-chunk upload continuation across termination.
- The backup includes the ledger and published artifacts, **not** all Pi sessions, working repositories, browser profiles, partial uploads or external vault/master keys. Copy/restore these separately before calling it full-system recovery.
- Browser, credentials, payment, worker and many other domain libraries are not all exposed through the running coordinator or native UI. A passed isolated fixture does not make them usable product flows.

## Balanced release gates

| Gate | Assessment |
|---|---|
| G0 | Partial local feasibility only. Pi/browser pinned and native builds work; Ubuntu, Cloud and bounded administration qualification absent. |
| G1 | Partial. Real signed HTTP convergence, native iPhone flow, durable outbox/artifacts and APNs fixtures; no two-physical-client/APNs rehearsal. |
| G2 | Partial deterministic policy proof. Not passed across all real coding/browser/ops actions or a qualified reviewer. |
| G3–G7 | Not passed. Domain primitives exist; integrated balanced pilot, accounts, commerce, delegation and deep workflows remain incomplete. |
| G8 | Not passed. Local encrypted restore fixture is not a hardened single-server operational release. |

The next milestone is **a real balanced G0–G2 pilot**, not a release declaration: qualify the Ubuntu topology and Cloud roles, wire browser and task-owned service tools through the same gate, then run the same three-pillar flows from both clients. Provider accounts and payment work require their explicit eligible test scopes; do not turn on live effects merely to make this table green.
