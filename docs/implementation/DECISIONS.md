# Spec 30 — implementation decisions and qualification register

Recorded 28 October 2026 (local time). This supplements, rather than rewrites, the owner's [source specifications](../../spec/30-decisions-and-sources.md). It records actual implementation choices and their limits.

## Decisions made autonomously for this development implementation

| Area | Choice | Rationale / qualification boundary |
|---|---|---|
| Backend | TypeScript modular coordinator on Node with SQLite WAL | Durable transactional records/events/commands/outbox in one local service; not a substitute for isolated privileged services |
| Native apps | Shared SwiftUI library plus Mac/iPhone application entry points | One projection/command implementation; no competing task stores |
| Design | Soft Studio, Geist family, Ink neutral surfaces, 22-point panels | Derived from the owner's local design study; conversation/evidence split on wide windows and segmented panes on compact widths |
| Wire protocol | Version 1 JSON records, monotonic event cursors, revisions, signed commands | Swift structs mirror the backend; full code generation and compatibility negotiation are still missing |
| Authority | Ed25519 device signing; exact-action digest/nonce/version checks | Native keys remain in Keychain; local authentication is not server-attested step-up proof |
| Initial mode | **Ask permission in development** | Conservative temporary choice. Production default/inheritance remains an owner decision; it is not inferred from the mock |
| Network | Loopback-only HTTP; native remote URLs require HTTPS | Avoids silently exposing the coordinator. Physical-device ingress/TLS/private network has not been configured |
| Runtime | Pinned Pi SDK with built-in tools disabled; custom common-gate action tool | No arbitrary built-in tool bypass. Live Pi/Cloud execution has not been account-qualified |
| Browser | Direct Playwright headless Chromium | Real local fixture/screenshot evidence. No Linux desktop dependency; no claim of Ubuntu/browser-viewer completion or self-hosted Steel parity |
| Model roles | Configured operator, distinct reviewer, reserved vision ID | No invented IDs or smaller-model quality claims. The example remains `qualified: false`; vision is not wired into the Pi adapter |
| External providers | Durable domain intents and injected test adapters first | No actual mail/PR/payment/APNs effect is inferred from fixture success |
| Notifications | Direct HTTP/2 APNs adapter and durable inbox | No managed third-party push relay. Real signing/provisioning and delivery remain blocked |
| Cache | AES-GCM encrypted per-server snapshot and pending command state | Convenience/retry recovery only; server is authoritative. File attachment continuation is not yet fully durable in the native client |
| Backup | Authenticated encrypted ledger/artifact archive; restored coordinator starts on Recovery Hold | Limited local backup, not complete host/session/workspace backup. Dispatch requires explicit signed owner acknowledgment after review |
| Tool execution | Explicit enrolled executables, bounded output/time and process groups | **Cooperative, not sandboxed.** Root/interpreters/network access are not isolated by these checks |
| Distribution | macOS 14/iOS 17 declared minima; local ad-hoc Mac and simulator builds | Tested on the actual recent toolchain listed below, not all declared minimum OS versions. No release signing/notarization/TestFlight |

## Actual local pins and probes

Run `npm run qualify` to refresh [`QUALIFICATION.json`](QUALIFICATION.json). The script verifies installed direct dependencies against exact manifest/lockfile versions, captures local tool versions and source hashes, launches/closes headless Chromium, and records unperformed external qualifications. It reads **no API keys** and makes **no live provider call**.

Captured code revision: `d6fd43e0510639d8392be83053c2e223ad1c655b`.

| Dependency/tool | Actual evidence |
|---|---|
| Node | 26.3.0; built-in SQLite 3.53.1 |
| Pi coding-agent SDK | 1.4.0; MIT package metadata |
| Playwright | 1.64.1; Apache-2.0 package metadata |
| Installed Chromium | 156.0.8078.4; actual headless launch succeeded |
| Zod / TypeBox | 4.6.7 / 1.3.27; MIT package metadata |
| TypeScript / tsx | 5.9.3 / 4.23.15 |
| Undici | Override 8.12.3; lockfile retained; zero known vulnerabilities in captured npm audit |
| Xcode / Swift | Xcode 27.1 (27A9275), Apple Swift 6.4 |
| Development hardware | macOS arm64, 10 logical CPUs, 16 GiB memory; not the owner's Ubuntu server inventory |
| FFmpeg | 9.0.2 Homebrew build, **GPL enabled**; not a bundled/approved redistribution dependency |
| Native fonts | Geist/Geist Mono font files and their licences retained in shared resources |

Package metadata and a clean vulnerability scan do not establish redistribution compliance or security. Review transitive packages, Chromium notices, font terms and FFmpeg build flags before shipping. No broad permissive-license claim is made for optional tools.

## Source register: what was actually used

| Source | Implementation use | Evidence limit |
|---|---|---|
| `spec/00`–`spec/30`, `spec/feature-map.md` | Product requirements and stable ownership | Authored specifications, not upstream implementation evidence |
| `mock/html-studies/index.html`, `mock/docs/design.md` | Soft Studio composition and local design intent | Pre-existing study remains separate from the real app |
| Pi SDK docs/examples and installed `dist/` API declarations | `createAgentSession`, resource loader, session manager, model runtime, custom tool adapter | Pinned adapter compiles; no live Cloud transport conformance established |
| Installed Playwright package/API | Headless contexts, observations, screenshots and rendered PDF fixture | Local Chromium fixture only; download/viewer/handoff product integration remains incomplete |
| Node built-in SQLite/crypto/process interfaces | WAL transactions, Ed25519/AES-GCM, process control, backup | Local tests, not a malicious-root security proof |
| SwiftUI, CryptoKit, Security, LocalAuthentication, UserNotifications APIs in installed SDK | Shared native UI, signing/cache, device confirmation, push registration | Simulator smoke + native builds; no real APNs/physical-device qualification |
| Primary URLs in `spec/30-decisions-and-sources.md` | Upstream reference index and future provider integration guidance | Not all primary pages were revalidated during coding; links are not conformance evidence |

The older Pi/OpenClaw/t3code commit snapshots in the research specification are historical references. They are **not** claimed to be the runtime currently compiled here. The actual Pi package pin and lockfile integrity are in the qualification report.

## Inputs still required — defaults are not fabricated

| Input | Current state | Required next evidence |
|---|---|---|
| Ubuntu server/network | Not accessed | Owner-authorized inventory, supported virtualization, storage and private ingress |
| Enforcement topology | Cooperative local implementation only | Independent protected broker/worker boundary, network/identity escape tests, root guest teardown/recovery |
| Production mode default/inheritance | Deferred; development Ask | Explicit product decision after reviewing the prototype |
| Cloud role IDs and licences | No selected/qualified account roles | Account inventory and actual tool/result/streaming/image/cancel/quota/timeout conformance |
| Smaller Auto reviewer | Distinct ID required, size/quality not measured | Held-out cross-pillar action set, prompt-injection and false-allow analysis, owner-accepted launch threshold |
| Browser viewer/transport | Native transport not implemented | Both-client exclusive input leases, latency/bandwidth, capture redaction and crash/recovery |
| Agent/owner accounts | No live connectors activated | Dedicated test identities, least-privilege scopes, selected grants, consent and revocation rehearsal |
| Payment route | No eligible real route or native mandate experience | Sandbox eligibility, complete workflow UI/terms, issuer handoff and authoritative unknown-settlement reconciliation |
| APNs/distribution | Sender fixtures only | Signing team/topic/environment, entitlements, actual tokens, background delivery and lost-push catch-up |
| Retention/backup destination | Local proof only | Owner retention policy, encrypted off-host destination, key custody and replacement-server recovery |
| Minimum OS/accessibility | Declared minima, limited recent-OS testing | Actual minimum-OS builds plus VoiceOver/Dynamic Type/dark-mode/keyboard/real biometric audit |

## Release decision

**Do not release or call all specifications complete.** All 31 spec areas have scoped implementation/report commits, but the [acceptance matrix](ACCEPTANCE.md) records substantial missing behavior and integration—not just absent credentials. The next decision is whether to expand the balanced pilot after qualifying the real infrastructure, not whether to relabel prototype evidence as completion.
