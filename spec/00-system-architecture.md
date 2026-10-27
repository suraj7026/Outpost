# System architecture and product contract

Status: proposed implementation architecture, updated from the owner’s answers on **27 October 2026**. The specifications describe the production target. The current `mock/` application is only an in-memory design artifact.

## Product and scope

Outpost is a personal operator with its own persistent **Ubuntu Server**. It can code, browse and do personal work, administer services, install tools and return useful evidence. Coding, browser/personal work and server operations are equally important first-release pillars. Chat, Cowork, Code, Browser, Research and Operations are task presets, not separate agents, histories or permission systems.

The Mac and iPhone apps are equal Swift clients. The server owns conversations, committed messages, tool history, task/run state, files, decisions, policy, memory and schedules. Both apps see the same domain records and can start/steer tasks, select control mode, inspect/share outputs, take over the browser and authorize payment workflows. Screen layout and local pane preferences can differ. A disconnected client shows its last-known revision and reconnects; it cannot truthfully claim instantaneous synchronization while offline.

The agent normally uses its own accounts, which the owner will create. Owner accounts remain available through explicit, scoped connections. Every operation identifies the chosen account and must never silently fall back to a more privileged owner identity.

## Deployment boundary

All Outpost execution, durable data and service adapters run on one physical Ubuntu server. The approved external runtime/transport exceptions are:

- **Ollama Cloud inference:** qualified open models for the operator, a smaller independent Auto reviewer and vision.
- **Apple APNs:** push notification transport. The sender and notification ledger stay on Ubuntu; there is no hosted Outpost notification relay.

GitHub, mail/calendar providers, public websites, package registries, merchants and banks are external task targets. Their adapter code, credentials and authority mediation remain on Ubuntu. This does not turn a website or bank into a self-hosted service. Hosted browser fleets, CAPTCHA farms, managed search/vector databases, orchestration SaaS, vault SaaS and remote document converters are excluded from the baseline.

```text
Swift Mac client                         Swift iPhone client
  device key + rebuildable cache           device key + rebuildable cache
                 authenticated commands / replay / artifacts / browser
                                      |
ONE PHYSICAL UBUNTU SERVER            |
  Protected host services
    gateway + device trust + command/event ledger + outboxes
    policy + owner approvals + Auto reviewer dispatcher
    identity/vault/payment brokers + protected browser profiles
    notifier + scheduler + artifact store + audit + backup control
    local search/index/doc/media adapters + inference gateway
                         |
                scoped local tool APIs
                         |
  Ubuntu Server agent workspace (prefer a same-host isolated VM)
    Pi worker(s), filesystem, Git/gh, language runtimes
    commands/processes/agent PTY, headless browser, installed packs
    scoped sudo/root capability

  Ubuntu inference gateway ------------> Ollama Cloud
  Ubuntu notification sender ----------> Apple APNs
```

A same-server host/guest split is a recommended enforcement design, not an owner-selected VM product or implemented guarantee. Qualify virtualization and resource costs on the actual server. If Pi has unrestricted root over the protected host as well, the host’s policy/vault/audit protections become cooperative. A privileged container or Docker socket must not be labelled an equivalent strong boundary without evidence.

## No Linux desktop or client terminal

There is no Linux desktop environment, generic remote desktop, VNC product feature or desktop-app automation layer. Use CLI/API/headless interfaces and installed server tools. The headless browser has a browser-scoped live viewer and takeover/input path; implementing that transport must not introduce a whole desktop as an undocumented dependency.

The agent may use a PTY internally for terminal applications. Clients display understandable actions, captured read-only results, code changes, checks, screenshots, documents and other generated artifacts. They do not expose a user shell, arbitrary server filesystem console or terminal emulator. Task-scoped changed files and downloadable artifacts are evidence surfaces, not a remote file manager.

## The three control modes

These modes are independent of the task preset and OS privilege. The same task may use Code tools and sudo under any chosen mode.

| Mode | Ordinary work actions | Human visibility |
|---|---|---|
| Full control | Dispatch within the task/resource/identity grant without routine permission prompts. | Public action/result history, stop/revoke, artifacts and any separately required owner grants. |
| Auto | Deterministic checks, then a separate smaller qualified Cloud reviewer allows or asks for each normalized proposed action. | Concise assessment, target/identity/effect and any decision request. |
| Ask permission | Ask before every actual work/tool action, including file reads, browser navigation, edits, commands and API operations. | Exact action and effect in the persistent inbox before dispatch. |

Owner-only changes to mode, approving devices, vault export, trust policy and payment authority remain protected. Neither the main agent nor reviewer can promote itself or mint owner authorization. Full control does not confer an unconnected owner account or payment mandate.

Internal inference, event commits, health bookkeeping and cache replay are not each presented as work requiring a click. Do not exploit this distinction to hide a tool action inside “bookkeeping.” Do not silently group a whole arbitrary shell script or workflow into one harmless read request; show the resolved effect and scope.

The owner has not yet selected the production default or whether overrides should be task-scoped, workspace-scoped, or both. Proposed implementation: server workspace default plus explicit task binding, with the active value always visible. The mock can start in Ask permission as an illustrative initial state; that is not an approved production default.

### Auto reviewer implementation

1. The worker proposes a normalized action envelope. The protected coordinator resolves task scope, target, identity, effect class, policy version and expiry.
2. Deterministic checks reject invalid authority, protected-policy changes, missing owner-identity access or absent payment-workflow mandates before model evaluation.
3. Send only the required action/context to a separate smaller qualified Ollama Cloud model. Do not reuse the action-producing session as its own independent reviewer.
4. Locally validate the result: `allow` or `ask`, evaluated action digest/policy version and concise explanation. Do not rely on unqualified model confidence or cloud-enforced JSON schema.
5. Unknown effects, timeout, unavailable model, malformed output, stale scope or uncertainty become an owner request. No fail-open or silent provider/model-role substitution.
6. Persist the review and decision before dispatch. Re-evaluate if arguments, target, identity or policy changed.

The reviewer is a fallible classifier, not the enforcement boundary. Benchmark dangerous false allows, excessive prompts, ambiguous shell/browser effects and prompt injection. Exact model IDs and launch thresholds remain evaluation decisions; no safety accuracy is assumed.

### Mode changes and concurrency

A client submits an authenticated policy-change command with an expected revision. Commit the new version on the server and broadcast it. At the next action boundary, tighten/revoke queued authority and recheck unstarted operations. Already running irreversible effects cannot be cancelled by changing a toggle. Record what is in flight and its reconciliation state.

## Whole-payment-workflow authority

A payment approval covers the defined sequence, not merely the final button. The native proposal on either client includes purpose, merchant/payee, selected account, items/delivery, funding alias, maximum total/currency, allowed recurrence, included steps and expiry.

After current owner authentication and server verification, persist a mandate. The agent can perform its included ordinary steps without repeated prompts, including the explicit payment-workflow exception to per-action Ask permission. Each financial effect still checks the mandate, current budget, identity, expiry and revocation. Full control and Auto cannot create or widen this mandate.

A materially changed merchant, item set, account, currency, recurrence or total above the approved maximum requires renewed workflow authorization. Do not silently split charges or substitute another payment method. Required issuer/bank authentication remains an owner handoff; provider support and owner eligibility are implementation inputs. A timeout after submission becomes reconciliation, not a second purchase.

## Authoritative state and sync

Use a transactional local ledger and file/artifact store on Ubuntu. Pi owns the finalized model-session representation through its pinned session manager; Outpost maps it into a product event stream and task/run IDs. Do not pretend the two stores share an atomic transaction.

Both clients apply the same committed event sequence and domain schema. Draft token streaming is ephemeral and can be replaced by the committed message after reconnect. Commands have client-generated idempotency keys and server operation IDs. The first valid resolution wins an approval race; both clients render that recorded outcome. See [shared contracts](28-protocol-and-data-contracts.md).

Clients may cache encrypted/rebuildable snapshots for responsive or offline reading. They never become alternate conversation authorities, store the Cloud/vault key or create a local run when disconnected. Show pending commands, server acceptance, completion and unknown status separately.

## Browser and identity ownership

A task chooses the agent or owner identity explicitly. Separate profiles/grants prevent account crossover. Protected owner browser actions must not be reachable through unrestricted raw CDP/cookie export/arbitrary authenticated HTTP while claiming exact mediation.

Browser input has one server-owned lease: agent, a Mac device or an iPhone device. Takeover pauses agent input; another device cannot click concurrently. After return or lease expiry, observe the page again before acting. Persist supported profile state and evidence, but detect logout/new-device authentication instead of promising universal session portability.

## Notifications

The server creates an inbox record and push-outbox intent transactionally with the underlying notice. A direct APNs sender uses server-held signing material, environment/topic-scoped tokens, bounded retries and invalid-token cleanup. Payloads contain an opaque notice/task reference and minimal text; secrets, detailed sensitive commands and payment credentials do not appear on the lock screen.

Push delivery can be delayed or absent. Foreground/reconnect always fetches authoritative inbox/events; an APNs acceptance is not proof the owner read a notice. Opening a stale notification shows the current resolved/expired state. Sensitive approvals occur in the unlocked app with a fresh server challenge. Optional Live Activities are status, never payment authority.

## Suggested code organization

These are proposed paths for implementation, not existing production directories:

```text
server/coordinator/       task/command/event state and worker claims
server/pi-adapter/        pinned harness integration and event mapping
server/policy/            action normalization, modes and reviewer dispatch
server/brokers/           privilege, identities, payments and protected browser
server/capabilities/      local tools, manifests and MCP adapters
server/artifacts/         uploads, generated outputs and previews
server/notifier/          inbox, APNs outbox and preferences
server/scheduler/         triggers, occurrences and monitoring
server/storage/           migrations, ledger and backup interfaces
clients/Shared/           Protocol, Sync, Domain and Ink Design Swift packages
clients/macOS/            native Mac navigation and specialist views
clients/iOS/              native iPhone navigation, intake and notifications
```

Use a modular server process/package layout first; a module is a responsibility boundary, not a demand for 27 network microservices. Isolate privileged and untrusted work where the authority model requires it. Prefer TypeScript/Node around Pi, Python for specialist tool jobs, Swift for clients and language-neutral generated wire schemas. Final runtime versions and storage schema need pinned integration evidence.

## Sources and next documents

- [Pi SDK](https://pi.dev/docs/latest/sdk), [Pi extensions](https://pi.dev/docs/latest/extensions), [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).
- [Ollama Cloud](https://docs.ollama.com/cloud), [Playwright browser contexts](https://playwright.dev/docs/api/class-browsercontext), [Steel Browser](https://github.com/steel-dev/steel-browser).
- [Apple notification server](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server).
- [Shared contracts](28-protocol-and-data-contracts.md), [delivery gates](29-delivery-and-acceptance.md), [source/version register](30-decisions-and-sources.md).
