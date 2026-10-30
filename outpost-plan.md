# Outpost: Plan, Build Guide and Design System

Working name. Version 3 research and feature expansion, October 27, 2026. Updated with the owner’s October 27 product decisions: Ollama Cloud inference, self-hosted Ubuntu execution, native synchronized clients and Apple push notifications.

## Owner decisions — October 27, 2026

This section records the latest explicit owner answers and overrides earlier recommendations wherever they conflict. See [spec/README.md](spec/README.md) for the modular implementation specifications and complete feature ownership map. The native app in `mock/` remains an in-memory design prototype; these documents do not claim a working server or real device synchronization.

1. **An equally capable mix.** Coding, browsing/personal work and server administration are first-release product pillars. Build them in shared vertical slices and evaluate each pillar at every pilot gate; do not deliver a coding-only product and leave the others as future placeholders.
2. **Exactly three user-facing control modes.** **Full control** executes work under the owner’s task/resource grants without routine permission prompts. **Auto** uses a separate, smaller qualified open model on Ollama Cloud to assess each proposed work action and either allow it or ask the owner. **Ask permission** obtains owner permission before every proposed work/tool action, including reads; display the command/click/API/file operation and its effect. Infrastructure bookkeeping and internal inference are not disguised as work actions and do not each trigger a prompt. All three are server-owned policy choices, shared by both clients. The owner can change modes; the agent and reviewer cannot promote themselves to a more permissive mode.
3. **Approve the entire payment workflow.** One explicit authorization binds the workflow’s merchant/payee, purpose, items, account, maximum total/currency, permitted recurrence, expiry and included steps through payment, verification and receipt collection. Execute the approved workflow without asking again for every ordinary step; material changes require a renewed workflow approval. This workflow authorization remains required in all control modes. Required issuer/bank/user-presence authentication still hands off to the owner. The smaller reviewer cannot create a payment mandate.
4. **Ubuntu Server only.** No Linux desktop environment, generic remote desktop, VNC session or desktop-app automation is in scope. Pi uses server-side shell, files, APIs, installed tools and a headless browser. The owner can watch and take over that browser on either client. Other work is presented as understandable progress, completed actions, checks, screenshots, documents and downloadable/shareable artifacts. Agent PTY capability is internal; there is no user terminal or general server-filesystem console in the product.
5. **Mac and iPhone are equal clients of one server.** Conversations, messages, tool history, decisions, tasks, files, memory and authoritative settings persist on Ubuntu. Both clients project the same ordered server events and can start/steer tasks, view evidence, use browser handoff, approve workflows and change modes. UI layout may differ by device; domain state and authority do not. When disconnected, show an explicit stale/offline state and reconcile on reconnect rather than claim impossible instantaneous synchronization.
6. **Apple push notifications are approved.** APNs is the explicit external transport exception in addition to Ollama Cloud inference. The Ubuntu notifier talks directly to Apple; no hosted Outpost relay or notification SaaS is introduced. Notifications point into server-owned records; lock-screen payloads do not contain secrets, detailed commands or payment credentials. Push is a wake-up hint, not the source of history or approval truth.
7. **Agent identities first; owner identities also supported.** Use dedicated agent-owned accounts by default and allow selected owner accounts with explicit scope. The owner will create the agent accounts; no real accounts have been created by planning. Always show which identity is active. There is no silent fallback from an agent account to the owner’s more privileged account. Chrome/credential import remains selected and consented.

Implementation choices still to qualify include server capacity, the actual Cloud operator/reviewer/vision model IDs, issuer-supported payment routes, minimum OS versions and distribution. These do not reopen the product choices above.

## v3 direction: the agent's own computer

The user-approved product direction below supersedes conflicting choices in the September v2 plan. The completed v3 research and feature catalogue is below; the detailed v2 plan remains as historical background.

- **Product:** a personal agent operating a dedicated, persistent Ubuntu server on the owner's behalf. Treat that server as the agent's own computer: browser, files, development tools, installed applications, running services, and ongoing jobs. Chat, Cowork, and Code are views of one capable operator, not boundaries on what it can do.
- **Clients:** equal native Swift applications on macOS and iOS, with all authoritative history and task state stored on the server. Replace the planned Tauri desktop with SwiftUI and AppKit where needed. Preserve multi-device continuity and approvals. Refer to `Ink design system implementation/` for visual design and the local `../t3code` repository for interaction and workflow references.
- **Harness:** Pi is the agent harness. Outpost supplies the product, durable task orchestration, tools, policy, approvals, browser and machine integration, and native clients around Pi. OpenCode and OpenClaw are capability and architecture references; they do not replace Pi as the chosen harness.
- **Inference:** Ollama Cloud models are the primary inference path. Retain the open-model requirement and qualify the selected hosted models for tools, coding, vision, context and licensing. A local inference GPU is not required. Do not silently switch to another provider.
- **Hosting:** everything except Ollama Cloud inference and the owner-approved Apple push transport is self-hosted on the same Ubuntu server: Pi, orchestration, browsers, filesystem, tools, MCP adapters, search, documents, memory, secrets, approvals, payments broker, scheduler, database, logs and viewer transport. Native Mac/iPhone apps are controllers. GitHub, websites, mail services and payment networks are external task destinations, not outsourced Outpost infrastructure.
- **Pi access:** every installed work capability is discoverable and callable through Pi tools, local adapters, skills or its shell, subject to the owner's action-specific approvals. Self-hosted secret and approval services expose scoped operations, not unrestricted secret export or policy bypass.
- **Extensibility:** the agent can acquire additional tools and software, including GitHub CLI, language runtimes, browsers, connectors, skills, and service integrations. Installation and elevated changes need explicit policy and provenance.
- **Authority:** the agent can administer its Ubuntu machine with sudo under Full control, Auto or Ask permission. Auto uses a smaller qualified reviewer model; payments receive whole-workflow owner approval. Selected owner-identity access and trust changes remain explicitly scoped. The plan must distinguish machine administration from authority to change Outpost's approval system.
- **Browser:** self-hosted headless Chromium/Playwright or evaluated Steel, with persistent identities, browser-only viewing/takeover and CAPTCHA handoff. No Linux GUI desktop or generic remote desktop.
- **Sensitive workflows:** design an explicit, approved route for connecting selected local Chrome accounts or credentials, authentication challenges, and payments. Do not assume browser profiles, passkeys, or financial authorization can simply be copied to Linux.
- **Scope:** be ambitious and thorough. Include capabilities beyond Pi, OpenCode, and OpenClaw, with staged delivery, dependencies, and verifiable completion criteria.

### Read the expanded plan

The v3 expansion contains **270 proposed features across 27 areas**, with priorities, dependencies, acceptance criteria, **nine delivery gates** and **22 end-to-end scenarios**. Nothing in the feature catalogue is presented as already implemented.

| Start here | Contents |
|---|---|
| [Product and changes from v2](#v31-product-definition-and-scope) | What is fixed, what is retained, and what the new direction replaces. |
| [Research and reuse](#v32-research-findings-and-reuse-decisions) | Pi, Ollama, OpenCode, OpenClaw, t3code and open browser tooling. |
| [Architecture](#v33-architecture-choices) and [authority](#v34-authority-approvals-and-sensitive-actions) | The agent's own computer, sudo, protected approval/account authority and recovery. |
| [Feature catalogue](#v35-detailed-feature-catalogue) | All 270 capabilities, grouped by the work the operator should perform. |
| [Open-model strategy](#v36-open-model-strategy-and-hardware-decisions) | Candidate models, hardware questions and conformance tests. |
| [Browser, credentials and payments](#v37-browser-credential-and-purchasing-workflow-designs) | Sensitive workflows and practical handoff/automation routes. |
| [Native UI](#v38-native-ui-and-inkt3code-adaptation) | Ink/t3code adaptation and the expanded Mac/iPhone screen map. |
| [Capability packs](#v39-installable-capability-packs) and [durable contracts](#v310-durable-architecture-and-protocol-additions) | Installable tools, ownership, state and protocol changes. |
| [Roadmap](#v311-delivery-roadmap-and-milestone-gates) and [acceptance scenarios](#v312-scenario-based-acceptance-suite) | Build sequence, first backlog and proof that the product works. |
| [Decisions](#v313-decisions-and-remaining-uncertainty) and [sources](#v314-primary-source-index) | Fixed requirements, recommended choices, unknowns and primary evidence. |

### Research checkpoint — October 27, 2026

Research was recorded in this file as it proceeded; the expansion is complete below. A native SwiftUI design mock now exists in `mock/`; production server/client integration has not begun.

1. The design archive was extracted to `Ink design system implementation/`: 93 files covering the design system, desktop and mobile screens, components, assets, and screenshots.
2. The extracted `outpost.css` still carries pre-v2 `text-3` and light `danger` values. The corrected tokens in the written plan take precedence for implementation.
3. Local reference repositories at `../pi`, `../openclaw`, and `../t3code` were inspected alongside current primary documentation.
4. Pi's local README describes an embeddable TypeScript SDK and an RPC mode, plus extensions, skills, prompt templates, and packages. It explicitly leaves features such as subagents and plan mode to extensions or its host application. Outpost must plan those product capabilities itself rather than assume they are built in. Sources: [Pi repository](https://github.com/earendil-works/pi), local `../pi/packages/coding-agent/README.md`.
5. The one-time continuation ran on **October 27, 2026, at 9:05 pm Asia/Kolkata**, verified that the research expansion was already complete, and deleted its automation without duplicating finished work.
6. **Steel self-hosting is not Steel Cloud parity.** Steel's own MCP documentation describes self-hosted operation without its managed profiles, credentials, proxies, or CAPTCHA solving. Outpost must implement browser identity persistence and a pluggable challenge/handoff service rather than assume those features come free with the container. Source: [Steel MCP server](https://github.com/steel-dev/steel-mcp-server).
7. **Root and enforceable approvals require separate trust domains on the same server.** Pi's security documentation says its tools and extensions run with the launching account's permissions, and project trust is not a sandbox. Keep the coordinator, brokers and audit on the Ubuntu host and give the agent root inside an Ubuntu workspace VM on that server. If root also covers the protected host, controls on that host become cooperative. Source: [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md); this host/guest separation is an Outpost architecture proposal.
8. **Chrome continuity needs several routes.** Google's current DevTools documentation supports consent-based attachment to an existing Chrome session; the older debugging-port route requires a separate profile. T3 Code's local browser-import documentation describes a one-time cookie copy, not continuous identity sync. Outpost should offer OAuth, a fresh server login, a selected local-browser bridge, and a separately approved credential import. Sources: [Chrome DevTools connection configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration), [Chrome debugging changes](https://developer.chrome.com/blog/remote-debugging-port), local `../t3code/docs/user/browser-import.md`.
9. **Ollama transport must be tested through Pi.** Ollama documents both its native API and OpenAI compatibility, but OpenClaw's provider guide explicitly uses the native `/api/chat` route to avoid tool-call problems in its integration. An Outpost adapter must pass streaming, tools, tool results, images, context, and cancellation conformance tests; a reachable endpoint alone does not establish compatibility. Sources: [Ollama compatibility](https://docs.ollama.com/openai), [OpenClaw Ollama](https://docs.openclaw.ai/providers/ollama).
10. **Latest hosting decision supersedes local-only inference.** Use Ollama Cloud for the model, with the inference credential and gateway hosted on the Ubuntu server. All other Outpost runtime services stay on that server; managed browser/solver/search/vault/queue/relay services are excluded from the default deployment. Cloud prompts may include selected task text, files, tool results and images, so this is a self-hosted execution system with cloud inference, not an entirely on-device processing claim. Apple push transport is now a separately approved exception; the notifier remains self-hosted.

---

## V3.1 Product definition and scope

**Outpost is a personal operator with its own Ubuntu computer.** Give it an outcome, let it choose between a terminal, browser, files, installed software, and connected services, and follow its work from native Mac and iPhone apps. It can maintain state, acquire capabilities, return tomorrow, ask for authority at the right moment, and show evidence of what it completed.

The ambition is broad capability with bounded authority: an operator that can fix code, use a logged-in website, install a tool, manage a service, research an issue, produce a report, and prepare or execute an approved purchase in one task. The product should not require the user to preselect a separate agent for each medium.

### What remains from v2

Keep the durable event log, reconnect/replay, commands with idempotency keys, simultaneous devices, first-valid approval resolution, checkpoints, file artifacts, device revocation, private connectivity, native phone approvals, and the Ink visual language. Use a self-hosted WireGuard endpoint rather than require hosted network coordination. Preserve Chat, Cowork, and Code as useful starting profiles.

### What v3 changes

| v2 choice | v3 direction | Consequence |
|---|---|---|
| Tauri/React desktop | SwiftUI macOS app, AppKit for specialist views | Native navigation, keyboard behavior, accessibility, windows, Keychain, and local consent UI. Windows/Linux desktop apps are not in this Swift deliverable. |
| Build a native agent loop plus optional ACP engines | Embed Pi behind an Outpost runtime adapter | Reuse the harness; implement Outpost-specific policies, orchestration, and tools around it. ACP becomes an optional interoperability feature. |
| Multi-provider routing as the first milestone | Ollama Cloud models, with self-hosted Pi and tools | Hosted inference is explicit; no local GPU requirement, hosted agent service or silent provider change. |
| A sandbox per repo or docs folder is the main world | Persistent Ubuntu machine with projects, applications, identities, and services | Work can span sessions and survive laptop sleep. Disposable containers remain useful inside the machine. |
| Mostly coding, chat, and documents | General computer work, operations, web administration, personal workflows, and automation | The task, not its initial mode, determines the tools it needs. |
| Vault and policy beside the agent on one server | Separate protected control and sensitive execution domains | Required if unrestricted workspace root and meaningful protected approvals are both desired. |
| Hosted infrastructure options | All Outpost services on one Ubuntu server | Host/guest boundaries separate authority without adding another server; no managed browser, CAPTCHA solver, search backend, vault or orchestration service. |
| Providers settings is central | Machine, capabilities, accounts, approvals, automations, and model health are central | Expand the screen map without making infrastructure terminology dominate normal tasks. |
| 18-week v2 calendar | Gate-based v3 roadmap | The old estimate does not price this larger product and must not be presented as a current delivery promise. |

### Planning assumptions

1. One owner initially; multiple concurrent tasks and paired devices. Design authorization records so future collaborators are possible without requiring a multi-tenant service now.
2. macOS and iOS are the primary clients. A small emergency web console or CLI may exist later; a React app is not a prerequisite for the native apps.
3. The agent normally executes on Ubuntu. The Mac is a controller and optional consented local companion, not a hidden execution dependency.
4. Ollama Cloud supplies inference. Ubuntu capacity is selected for Pi, browsers, tools, builds, documents, storage and local helper services; local GPU inference is optional and is not a prerequisite.
5. No tools, passwords, browser profiles, payment methods, or accounts are installed, migrated, or used by preparing this plan.
6. All feature catalogue entries below are **proposed Outpost behavior**, not claims that the current repository implements them. Research findings explicitly identify existing upstream capabilities.
7. The same-server requirement covers runtime infrastructure. The agent can still call GitHub, browse public websites and use owner-authorized external accounts or payment rails as the work itself. All adapters, browser sessions and authority checks for that work run locally on the Ubuntu server.

## V3.2 Research findings and reuse decisions

Research date: **October 27, 2026**. Local source snapshots inspected: Pi `6374c2baf432419ccb4541a99ce4958ecd03dae0` (October 14), OpenClaw `12c7926d2502b621f30297ac4f176aa5b6fa2fb8` (October 14), and t3code `cfafb4bb54d244e4612f5681aad3832ea64cb0fb` (October 16). These are reference snapshots, not claims that they are upstream's latest commits. Current official documentation was also consulted; pin actual dependencies during the first integration spike.

### Pi: the execution harness

Pi exposes a TypeScript SDK with session creation, streamed events, tools, resource loading, cancellation, steering/follow-up input, and persisted session branches. Its SDK describes `SessionManager` as authoritative for finalized model context. Its extension system can register tools/providers and intercept or block tool calls. SDK integrations must explicitly wire the relevant built-in MCP/resource extensions rather than assume the CLI's entire startup environment appears automatically. Sources: [Pi SDK](https://pi.dev/docs/latest/sdk), [extensions](https://pi.dev/docs/latest/extensions), local `../pi/packages/coding-agent/docs/sdk.md` and `extensions.md`.

**Reuse:** the model/tool loop, context compaction mechanisms, session machinery, event interface, skills/resources, and provider extension surface. **Build:** durable jobs, machine provisioning, protected authority, app approvals, browser adapters, independent verification, and product UI. Keep Pi behind a versioned adapter so an upstream session/event change does not break Swift clients.

Pi's tool-call hook is useful for product-level approval flow; it is not a privilege boundary against code that can execute outside that hook. Its security guide explicitly distinguishes project trust from isolation. Source: [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

### Ollama Cloud: hosted inference, self-hosted execution

Use the selected Ollama Cloud model for reasoning while Pi and every work tool remain on Ubuntu. Tool calling and vision still need qualification per hosted model. Cloud support differs from local Ollama: the current structured-output guide explicitly says Ollama Cloud does not support that feature. Validate generated data and tool arguments locally rather than depend on cloud-enforced JSON schemas. Sources: [tools](https://docs.ollama.com/capabilities/tool-calling), [vision](https://docs.ollama.com/capabilities/vision), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

Pi's inspected `models.md` gives an Ollama-compatible-endpoint example using `openai-completions`; OpenClaw's current Ollama guide instead insists on its native transport for that integration. These are different integration choices, not proof that either route universally works or fails. **Decision:** first run Pi/Ollama conformance tests; prefer the simplest route that preserves tools and streams, and implement a native Pi provider extension if required. Sources: [Pi models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), [Ollama compatibility](https://docs.ollama.com/openai), [OpenClaw Ollama](https://docs.openclaw.ai/providers/ollama).

Choose the Cloud transport in V3.6, verify the account's available models/limits, and keep any Ollama gateway on the Ubuntu server. Cloud privacy, availability, quotas and provider-side model changes replace local VRAM sizing as the main inference dependencies. The earlier instruction to disable cloud features no longer applies to the primary path.

### OpenCode: coding capabilities to reproduce around Pi

Relevant precedents include granular allow/ask/deny permissions, planning and execution agents, custom tools/plugins, MCP, language-server diagnostics, headless HTTP APIs, and session operations. Treat these as design references, not an instruction to run a second competing main harness. OpenCode's site distinguishes v1 and v2 documentation, so copied configuration examples must be version-labelled. Sources: [permissions](https://opencode.ai/docs/permissions/), [agents](https://opencode.ai/docs/agents/), [plugins](https://opencode.ai/docs/plugins/), [LSP](https://opencode.ai/docs/lsp/), [server](https://opencode.ai/docs/server/).

**Outpost implication:** first-class coding tools, semantic diagnostics, plans, worktree isolation, code review, and change checkpoints belong in the product even when the underlying runner is Pi. Optional OpenCode/ACP import or delegation can follow; it must retain the same Outpost authority boundaries.

### OpenClaw: always-on operator capabilities to learn from

The inspected repository separates browser control, elevated execution, execution approvals, memory, scheduled jobs, subagents, channels, and paired nodes. Especially useful patterns are persisted background work, human handoff, task-specific permissions, observable remote execution, and memory that remains distinct from enforceable policy. Sources: [browser](https://docs.openclaw.ai/tools/browser), [execution approvals](https://docs.openclaw.ai/tools/exec-approvals), [elevated execution](https://docs.openclaw.ai/tools/elevated), [memory](https://docs.openclaw.ai/concepts/memory), [automations](https://docs.openclaw.ai/automation/cron-jobs), [subagents](https://docs.openclaw.ai/tools/subagents), [nodes](https://docs.openclaw.ai/nodes).

**Outpost implication:** include proactive work, scheduled missions, retrievable history, specialized workers, optional messaging channels, and extra machines. Do not import all of OpenClaw's feature surface, runtime, defaults, or credentials as one dependency.

### t3code: interaction and durable orchestration references

The inspected code/docs describe server-owned execution, normalized command/event boundaries, durable intent with an outbox, turn-specific diffs, checkpoint/conversation coordination, multiple remote environments, and source-control review workflows. These directly reinforce Outpost's existing continuity design. Its browser import is documented as a one-time cookie transfer with platform limitations. Sources: [architecture at the inspected commit](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/internals/overview.md), [source control](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/source-control.md), [browser import](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/browser-import.md).

**Reuse the ideas:** projects and tasks in the sidebar; review beside conversation; file/diff/browser/read-only activity work surfaces; queue and steering; explicit machine ownership; clear reconnect states. **Build in Swift:** do not embed t3code's Electron app or treat its React components as native Swift controls. Source reuse, if later chosen, requires checking the actual licence of the copied revision and retaining notices.

### Browser infrastructure shortlist

| Candidate | Verified role | Outpost recommendation and limitations |
|---|---|---|
| [Playwright](https://playwright.dev/docs/auth) + Chromium | Browser contexts, navigation, interaction, test automation, reusable authenticated state | Baseline adapter and test harness. Outpost still supplies identity management, streaming viewer, policy, and durable job ownership. Auth state is a credential. |
| [Steel Browser](https://github.com/steel-dev/steel-browser) | Apache-2.0 self-hostable browser infrastructure and CDP-compatible control | Evaluate alongside plain Chromium for the first browser worker. Avoid assuming the managed cloud's full feature set is in the self-hosted image. |
| [Steel MCP](https://github.com/steel-dev/steel-mcp-server) | MCP integration with explicit self-hosted feature differences | Self-host the adapter and browser on Ubuntu. Implement needed identity persistence and challenge handoff locally; do not enable Steel Cloud as a fallback. |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Agent-friendly CLI with snapshots, element references, sessions and browser actions | Evaluate as Pi's compact browser tool interface. Keep sensitive-session access behind Outpost rather than expose unrestricted CDP. |
| [Browser Use](https://github.com/browser-use/browser-use) | Open-source browser automation library; supports local browser/model configurations | Only a self-hosted library/worker on Ubuntu is eligible, using the approved Ollama Cloud model if reasoning is needed; exclude its hosted browser/agent offerings. |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | Browser workflow system with vision and structured extraction; repository identifies AGPL-3.0 core and cloud-only anti-bot measures | Only its self-hosted runtime is eligible. Cloud-only anti-bot features are excluded; licence and integration still need evaluation. |
| [Browserless](https://docs.browserless.io/) | Managed and self-hosted browser deployment options; inspected repository identifies SSPL-1.0 or commercial licensing | Research reference only for now; managed hosting is excluded and licensing prevents treating it as the permissive open-source baseline. |

**Initial browser direction:** Pi remains the decision-maker; Outpost exposes deterministic observe/act tools over Playwright/Chromium and, if selected, a self-hosted Steel instance on the same Ubuntu server. The viewer and protected authenticated-browser worker are also local server services. Select the implementation after testing identity, downloads, memory, crash recovery, parallel sessions and viewer latency; no hosted browser fallback is planned.

### New capabilities beyond the reference products

Plan transaction-bound purchasing, account-by-account delegation, a machine software inventory, capability installation with rollback, a cross-project task graph, independent result checks, reproducible task recipes, source-backed research dossiers, approved operating procedures, and external recovery of the agent's machine. These are Outpost proposals; they are not attributed as existing features of Pi or the other references.

## V3.3 Architecture choices

### Three approaches considered

| Approach | Benefits | Trade-offs | Decision |
|---|---|---|---|
| **Outpost control plane + Pi workers + persistent Ubuntu machine** | Preserves the chosen harness, native product design, durable tasks, and clear authority boundaries; broad machine access | Requires building orchestration, brokers, and native surfaces | **Recommended.** |
| Adapt or fork OpenClaw into the product | Many operator concepts and integrations already exist | Couples Outpost to a much larger system, migration surface, permission model, and release cadence; native product still needs substantial work | Mine patterns or isolated adapters; reconsider only if a spike demonstrates a clear maintenance win. |
| A raw Pi process with SSH/VNC and unrestricted root | Fast personal proof of concept, maximum access | Approval hooks and credentials share the environment the agent can alter; poor transaction recovery and multi-device semantics | Useful disposable spike; not the authority model for sensitive production use. |

### Recommended trust domains

```text
Swift macOS client                  Swift iPhone client
          authenticated commands, events, approvals over private link
                                      |
ONE UBUNTU SERVER                     |
  Protected host services: Outpost coordinator, SQLite, scheduler,
  approvals, local vault, account/payment broker, audit, snapshots,
  protected browser/viewer, search, and inference gateway
                    |                               |
         local authenticated tool APIs          HTTPS model requests
                    |                               |
  Agent Ubuntu workspace VM on this server      Ollama Cloud
    Pi harness + registered capability tools    (hosted inference)
    files, shell, Git/gh, browser, runtimes
    docs/data/media tools, MCP adapters
    running applications + approved guest sudo
```

All execution and durable data boxes run on the same Ubuntu server. A server-hosted notifier also sends notifications to Apple APNs, the owner-approved push transport exception. The host/guest division is an authority boundary, not another hosting provider or machine. Prefer an Ubuntu workspace VM on the host where virtualization is supported; brokered local tool APIs expose host capabilities to Pi. If the agent also gets unrestricted root over the hypervisor/control-plane host, those protections become cooperative. A Docker group membership or privileged container may convey host-level power and cannot automatically count as a lesser permission.

### Same-server hosting and Pi exposure contract

| Service | Runs where | Exposed to Pi as |
|---|---|---|
| Main model/vision inference | Ollama Cloud, through an Ubuntu-hosted credential gateway | Pi provider adapter with approved models and request limits. |
| Pi sessions and orchestration | Ubuntu server, isolated worker plus protected coordinator | Session runtime, task state, plan, queue, cancellation and delegation tools. |
| Browser and live viewer | Chromium/Playwright or self-hosted Steel on Ubuntu | Observe/act, tabs, downloads, screenshot and takeover tools; protected identities use brokered actions. |
| Files, shell, code and processes | Agent workspace on Ubuntu | File tools, shell/PTY, Git/gh, runtime tools and process/service handles. |
| Capabilities, skills and MCP adapters | Ubuntu server | Local discovery, install/update, typed tools and approved skill resources. |
| Search, parsing and retrieval | Self-hosted search/parser/index services on Ubuntu | Search/fetch/extract/retrieve tools; public search engines remain upstream data sources. |
| Documents, data, OCR, speech and media | Installed server tools or local workers | Structured jobs, progress and file/artifact results; no hosted conversion or speech service. |
| Secrets, accounts, payments and approvals | Protected Ubuntu host services | Scoped account/action/approval/payment requests; no general-purpose plaintext vault access. |
| Database, memory, scheduler and audit | SQLite/files/local services on Ubuntu | Task/memory/schedule/evidence APIs with appropriate authorization. |
| Private networking and streaming | Server-hosted WireGuard and authenticated local viewer endpoints | Health/status and owner-approved network operations; no required hosted tunnel, relay or coordination service. |
| Backups and restore | Encrypted server storage/separate local volume, with owner-exportable offline copies | Backup health and approved snapshot/restore operations; no required hosted object store. |

All useful work services must be discoverable through the capability registry and reachable through Pi's approved tool surface. A local HTTP, Unix-socket, stdio MCP or CLI boundary is an implementation choice, not a reason to keep a capability unavailable to the harness. Tool discovery loads only relevant definitions into model context.

External websites, GitHub, mail/calendar accounts, merchant APIs and banks are **task targets**. Their adapters and credentials remain local; interacting with them does not outsource the agent harness or browser. Hosted CAPTCHA solvers, remote browser fleets, managed search APIs, hosted vaults, workflow SaaS, telemetry backends and vector databases are not default Outpost dependencies. Public upstream search engines and package registries remain network data/download targets.

For remote Mac/iPhone access, use the server's own [WireGuard endpoint](https://www.wireguard.com/quickstart/) with authenticated Outpost traffic. A reachable server address/port or owner-managed networking is required; do not silently add a hosted relay when direct reachability fails. Server-side work and the approval inbox persist while clients are disconnected.

**iPhone notifications — approved exception:** use APNs for remote notifications, sent directly by the Ubuntu notifier with server-held signing material. Register/revoke device tokens, honor notification preferences, deduplicate notices by server event and deep-link into the current server record. Push delivery may be delayed or absent; reconnect/cursor replay remains authoritative. Live Activities are optional and do not authorize lock-screen payment execution. Source: [Apple remote notification server](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server).

One physical server is a shared failure domain: loss of the host takes down coordination, tools and local copies together. Host snapshots protect against guest damage; disaster recovery from host/disk loss requires an owner-kept offline/exported backup. Do not describe another folder on the same disk as independent recovery.

**Owner-selected control modes:** Full control, Auto and Ask permission. They are distinct from the execution privilege (ordinary agent user versus scoped sudo/root) and task profile (Code, Browser, Operations, Cowork or Research).

- **Full control:** authorize work within the owner-selected resource/task scope without routine prompts; retain observable intent, results, stop/revoke and owner-only protection of the control plane. Full control does not itself create a payment workflow authorization or grant an owner identity.
- **Auto:** send a structured proposed action, target, identity, tool arguments, expected effects and relevant task scope to a smaller qualified Ollama Cloud reviewer. Accept only validated `allow` or `ask` decisions. Enforce deterministic identity, mandate, grant and protected-resource checks first. Reviewer timeout, unavailable model, invalid output or uncertainty means ask; do not silently allow or promote the main model to reviewer. Record concise classification evidence and model/version metadata, not hidden reasoning. The actual small model is selected by evaluation, not assumed available.
- **Ask permission:** put each actual work action into the persistent inbox before execution, including file reads, page navigation, edits, commands and API calls. Approval is bound to exact arguments and target. Changed actions need a new request. Do not silently batch broad sequences into an opaque single step; the explicitly approved payment workflow is the defined workflow-level exception.

The selected mode is stored on the server with a policy version. Define its default and per-task overrides explicitly during implementation; the mock may start in Ask permission without treating that as an owner-selected production default. A mode change takes effect at the next action boundary; recheck queued actions and cancel dispatch that has not started when authority is tightened. Explain that changing mode cannot retract an effect already executed. A workspace sudo operation still runs through the protected privilege path. An agent/root process cannot change the owner’s mode or sign its own approvals.

The machine is the agent’s Ubuntu Server workspace. The owner retains control over identities, whole-payment-workflow mandates, protected policy and destruction/reprovisioning of that workspace.

### Ownership of state

| State | Authority | Recovery requirement |
|---|---|---|
| User goals, accepted commands, approvals, grants, scheduler state | Protected Outpost ledger on the Ubuntu host | Transactional updates and idempotent commands; local encrypted backups plus owner-exportable offline copies. |
| Pi conversation branch, tool history, compaction | Pi session manager through Outpost's pinned adapter | Checkpoint/export with a verified mapping to Outpost task/run identifiers. |
| Client transcript and task UI | Rebuildable Mac/iPhone projections of the same server-owned Outpost events | Rebuildable from cursor replay and snapshots. |
| Files and installed applications | Ubuntu machine volumes and package inventory | File checkpoints plus machine snapshots; ordinary Git undo is not a system rollback. |
| Credentials and sensitive browser identities | Separate account/browser broker | Encrypted persistence, scoped access, revocation; do not copy into guest-wide configuration. |
| Orders, messages, deployments, cloud resources | External provider | Read-after-write checks, operation IDs, reconcile uncertain outcomes. |
| Approval/audit evidence | Protected store outside workspace root | Workspace cannot silently erase the authoritative record. |

Do not keep three independently mutable versions of conversation truth. Preserve Pi's native session data for model context and map it to Outpost's durable product event stream. The old Open Responses-only canonical-history requirement becomes an export/interoperability goal; it must not overwrite Pi's actual session and compaction semantics. Never replay a financial action merely because a UI event was replayed.

### Server implementation recommendation

Use a TypeScript/Node control and worker-adapter layer to match Pi's supported SDK; run Pi in isolated worker processes, not inside the root or account broker. Python remains valuable for documents, data, OCR, and specialist browser services. This replaces v2's default Python agent loop recommendation; record the final language/process decision after the Pi spike. A Python coordinator with an isolated Pi RPC worker is viable if measured benefits justify the extra boundary.

Use Swift packages for protocol models, connection/replay logic, design tokens, and shared domain projections across Mac and iPhone. Keep event schemas language-neutral and generated; no TypeScript code needs to run in the Swift apps. Browser transport and full-screen streaming may use a narrowly scoped WKWebView or native video view without turning the whole app into a web wrapper.

## V3.4 Authority, approvals, and sensitive actions

### Permission vocabulary

`allow`, `ask`, and `deny` apply to **capabilities and resources**, not just tool names. An approval request must describe the real side effect even when it was reached through shell, Python, an MCP connector, a browser click, a nested tool, or a scheduled job.

| Class | Examples | Proposed default |
|---|---|---|
| Read and explore | Read project files, public web research, inspect logs, view connected read-only resources | Full control: within grant; Auto: reviewer; Ask permission: ask for each action. |
| Reversible workspace work | Edit code/documents, run tests, create a branch, download public files | Apply selected control mode and checkpoint changes. |
| Acquire ordinary tools | Add a project-local dependency or approved capability pack | Allow within a bounded installation grant; request permission if it adds trust, spend, privileged services, or new external access. |
| Change the machine | apt packages, services, firewall, users, mounts, kernel, reboot | Ask or use a previously approved, specific maintenance procedure. |
| Act as the owner | Send/publish, change external records, merge/deploy, upload private files | Ask unless the current task or an explicit standing rule authorizes that exact class and target. |
| Use a sensitive identity | First login, password retrieval, cookie transfer, financial portal, OAuth scope expansion | Ask; bind permission to account, destination, purpose, and lifetime. |
| Move money or create recurring commitments | Purchase, subscription, payout, refund, paid provisioning | Transaction-specific approval or a separately configured bounded mandate. Neither Auto nor Full control creates a payment-workflow mandate. |
| Change trust itself | New approving device, vault export, payment limit increase, policy bypass, control-plane update | Owner-only operation on a protected client; cannot be authorized by the agent granting itself a tool permission. |

This table describes action classes, not a fourth mode. Full control, Auto and Ask permission determine whether each ordinary action runs or prompts. In Ask permission, even reads and routine shell commands require action approval. A whole-payment-workflow mandate is an explicit authorization for the included checkout sequence rather than a prompt for each of its steps. Permission to use an account once is different from permission to send every future message from it.

### Approval object requirements

- Bind to task/run, machine, account, target resource, normalized operation, and current policy version.
- Include exact command or structured action, arguments, working directory, executable/script identity, affected paths or recipients, and environment differences when material.
- For external sends, show final recipients, content, and attachments. For a purchase, show merchant, items, quantity, currency, total including tax/shipping, delivery address summary, recurrence, cancellation terms available, and expiry.
- Permit approve once, deny, approve this bounded plan, or create an explicit reusable rule. Show exactly what a reusable rule covers; provide an expiry and revocation list.
- Revalidate content and authority at execution time. Changing the approved command, script, cart, recipient, account, or amount invalidates the approval.
- First valid response wins across Mac and phone. Expired or already-resolved actions are visibly rejected. Revocation prevents future starts, but cannot undo a side effect already executed.
- Require device unlock/local authentication for high-impact decisions. A push is a prompt to inspect the request, not unrestricted payment authority from the lock screen.
- Keep a server-side record of intent, decision, execution, and verification. Redact secrets from the record without losing the action's meaning.
- Separate `waiting_for_approval`, `waiting_for_login`, `waiting_for_human`, `waiting_for_payment_auth`, and `blocked_by_policy`; each needs a clear next action.

### Enforcement limits that affect implementation

Prompt instructions, regex checks for the word `sudo`, and a Pi extension alone cannot enforce this policy against unrestricted shell or root. Protect sensitive effects through separate services with explicit interfaces. On ordinary authenticated websites, browser semantics are sometimes ambiguous: a click may send data or trigger a charge. Use narrow provider/API operations for strong guarantees, protected sensitive-browser workflows with constrained actions, and manual final interaction where reliable classification is unavailable.

Do not expose raw CDP, browser cookie export, arbitrary JavaScript, unrestricted authenticated HTTP, or vault plaintext to the root-capable worker while claiming sensitive actions remain fully brokered. If the user chooses to place a logged-in profile inside the agent's machine, state plainly that machine root can access and use that identity; approval checks there are behavioral controls. The UI must show which account is **delegated to the machine** and which is **protected by the broker**.

## V3.5 Detailed feature catalogue

Priority denotes sequencing, not a restriction on the vision: **C** = core operator product; **E** = expansion after the core works; **A** = ambitious extension requiring additional integrations or evidence. These labels do not mean all C features ship in the first milestone. The gate-based roadmap below orders them. Each capability inherits V3.4's authorization rules.

### 1. Goals, tasks, and execution continuity

Depends on: Pi adapter, durable ledger, connection protocol, workspace identity.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| TASK-01 | Outcome-based requests | Accept a goal in natural language; identify deliverables, relevant machine/accounts, constraints, and completion evidence before substantial work. | C |
| TASK-02 | One task across tools | Continue from research to browser, terminal, code, documents, and service management without making the owner recreate the request in another mode. | C |
| TASK-03 | Visible working plan | Show a concise editable plan with completed, active, blocked, and deferred steps; distinguish an estimate from an execution guarantee. | C |
| TASK-04 | Durable run lifecycle | Persist queued, running, waiting, verifying, completed, failed, interrupted, and cancelled states independently of connected clients. | C |
| TASK-05 | Steering and queued follow-ups | Let the user correct the active goal or queue another instruction; show when the correction was accepted and prevent obsolete work continuing silently. | C |
| TASK-06 | Pause, cancel, and resume | Stop at a safe boundary when possible; record subprocesses and external effects that cannot be instantly cancelled; resume from a durable checkpoint. | C |
| TASK-07 | Independent conversations | Support concurrent tasks on one machine with explicit file/service locks, resource quotas, and account identity; do not confuse shared OS access with isolation. | C |
| TASK-08 | Task branches and retries | Fork a task from a checkpoint, retry a failed step, compare outcomes, and retain abandoned branches without repeating irreversible actions. | E |
| TASK-09 | Long-running missions | Work for hours or days through waits, provider failures, machine restarts, and human approval; use structured checkpoints instead of relying on one context window. | E |
| TASK-10 | Evidence-based handoff | Finish with changed files, URLs, service state, command/test results, receipts, remaining blockers, and a clear statement of what was actually verified. | C |

**Acceptance:** start a mixed browser/file task on Mac, disconnect both clients, reconnect on iPhone, steer it, restart a worker, and obtain one consistent outcome with no repeated external effect.

### 2. Persistent filesystem and knowledge workspace

Depends on: provisioned Ubuntu machine, artifact service, backup/checkpoint support.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| FS-01 | Personal home directory | Maintain an agent home with projects, documents, downloads, outputs, scratch, and task state; survive reboots and app updates. | C |
| FS-02 | Full file operations | Read, write, edit, move, copy, rename, archive, extract, and search files; surface symlinks, permissions, encoding, and size limits. | C |
| FS-03 | Fast discovery | Use ripgrep/glob and indexed metadata, then scoped semantic retrieval where useful; search hidden files only when relevant and authorized. | C |
| FS-04 | Reliable transfers | Resumable upload/download with checksums, progress, cancellation, conflict choices, and destination visibility on both clients. | C |
| FS-05 | Structured artifacts | Attach files and directories to tasks with type, size, provenance, version, preview, and final/intermediate status. | C |
| FS-06 | Version and restore | Checkpoint task-owned files and offer restore previews; distinguish file restore, Git restore, and whole-machine recovery. | C |
| FS-07 | Shared and isolated folders | Reuse common reference material while isolating unrelated work; warn before two tasks modify the same shared asset. | C |
| FS-08 | Storage services and connectors | Keep artifact/object storage on the Ubuntu server, optionally through a self-hosted compatible service. External Drive/NAS/account connectors are explicit task targets, not required backend storage. | E |
| FS-09 | File intake pipeline | Detect duplicates, classify documents, extract metadata/OCR, quarantine suspicious inputs, and create searchable local indexes. | E |
| FS-10 | Storage lifecycle | Show disk use, temporary-file retention, trash, backups, and artifacts pinned against cleanup; require approval for broad destructive cleanup. | C |

**Acceptance:** upload a large file from iPhone, interrupt transfer, resume, process it, download the result on Mac, and restore a changed source without corrupting unrelated files.

### 3. Terminal, processes, and installed applications

Depends on: execution service, process supervisor, streaming output, privilege policy.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| RUN-01 | Noninteractive shell | Execute commands with explicit cwd, arguments, environment, timeout, exit code, and bounded model-facing output; retain complete logs as artifacts. | C |
| RUN-02 | Agent-only interactive PTY | Handle REPLs, prompts, SSH and terminal programs inside the server worker. Return captured activity/evidence to clients; do not expose a user terminal console. | E |
| RUN-03 | Background processes | Start, attach, inspect, signal, and stop long processes; track descendants and distinguish command completion from a service remaining healthy. | C |
| RUN-04 | Resource supervision | Limit CPU, RAM, disk, process count, runtime, browser slots, and GPU concurrency per task; explain queueing and out-of-memory failures. | C |
| RUN-05 | Cancellation propagation | Propagate aborts through Pi, tool calls, subprocess groups, browsers, and downloads; record orphan cleanup rather than falsely claiming immediate cancellation. | C |
| RUN-06 | Structured command tools | Offer typed wrappers for common operations while retaining general shell; sensitive wrappers enforce resource and argument restrictions outside the guest. | C |
| RUN-07 | Remote SSH operations | Connect to explicitly enrolled hosts using scoped credentials; preserve host-key checking and show which machine every command targets. | E |
| RUN-08 | Headless application automation | Use CLI/API and headless conversion interfaces for installed software; return logs, screenshots and artifacts. Linux desktop environments and generic desktop automation are out of scope. | E |
| RUN-09 | Environment profiles | Select language/runtime/tool versions and task-specific env without leaking one project's credentials or dependency state into another. | C |
| RUN-10 | Reusable procedures | Save a verified sequence as a versioned recipe with parameters, prerequisites, permissions, rollback notes, and tests. | E |

**Acceptance:** run a build and dev server, reconnect to their output, cancel the build's child processes, and keep the independent dev server correctly tracked.

### 4. Sudo and administration of the Ubuntu machine

Depends on: same-server host/guest authority boundary, privileged executor, host-owned snapshots and owner recovery access.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| SYS-01 | Machine inventory | Inspect OS, architecture, CPU/GPU, RAM, storage, ports, users, network, running services, and installed tool versions. | C |
| SYS-02 | Approved sudo | Request a scoped administrative action with a reason and impact preview; execute it through the protected privilege path and return the result. | C |
| SYS-03 | Root maintenance lease | Allow the owner to grant broad root over the agent's Ubuntu workspace for a bounded maintenance window, clearly showing reduced internal enforcement. | E |
| SYS-04 | Service management | Create/update/restart/stop task-owned systemd services, inspect journals, set restart policy, and verify health; system-wide changes follow admin policy. | C |
| SYS-05 | Package and runtime maintenance | Install, pin, update, and remove OS packages or runtimes, including approved non-default repositories; preserve inventory and rollback information. | C |
| SYS-06 | Users and permissions | Manage task accounts, groups, file ownership, SSH access and service identities through explicitly scoped admin operations. | E |
| SYS-07 | Network administration | Diagnose DNS/routes/TLS/firewall; preview externally reachable ports and protect the remote recovery channel before applying changes. | E |
| SYS-08 | Reboot-aware work | Plan updates and reboots, save state, warn affected tasks, boot automatically, and verify workers/services rejoin. | E |
| SYS-09 | Storage administration | Manage task volumes, mounts, quotas, logs and image cleanup; require stronger approval for formatting, destructive migrations, or broad deletions. | E |
| SYS-10 | External rescue | Restore a snapshot, replace a broken guest, revoke its broker credentials, or attach recovery media without relying on the damaged agent OS. | C |

**Acceptance:** approve an installation and service restart from iPhone; reject an altered command; deliberately break the guest in a test and recover it from outside the guest.

### 5. Software acquisition and capability installation

Depends on: package inventory, extension manifests, administrative grants, trusted sources.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| PKG-01 | Missing-tool discovery | Recognize when a task needs a tool; inspect available versions and trusted installation routes before proposing an installation. | C |
| PKG-02 | Standard package ecosystems | Support apt, project-local pip/uv, npm/pnpm, containers, and language-native tooling; prefer isolated project installs where appropriate. | C |
| PKG-03 | Capability catalogue | Show available packs, installed state, dependencies, permissions, licences, external services, disk footprint, and required secrets. | E |
| PKG-04 | Install plans | Present exact source/version, packages, elevated steps, new services/ports, estimated resource use, and any recurring spend. | C |
| PKG-05 | Installation grants | Approve a bounded installation plan once instead of prompting for every harmless substep; reject changes that expand its scope. | C |
| PKG-06 | Version and provenance record | Track package/image digests, source URLs, maintainer identity where available, install scripts, dependency lockfiles, and the task that requested them. | C |
| PKG-07 | Health and smoke checks | Run a capability's declared test after installation and before advertising it as usable; surface missing accounts separately from missing software. | C |
| PKG-08 | Update and rollback | Review capability updates, stage them, compare changed permissions, roll back failures, and uninstall without losing unrelated user data. | E |
| PKG-09 | Agent-authored tools | Let Pi build a new adapter or recipe in a staging area; require checks and owner approval before giving it new trust, privileged execution, or secrets. | E |
| PKG-10 | Rebuildable machine | Export an environment manifest and reconstruct tools on a replacement Ubuntu machine; exclude secret values and verify application data restoration separately. | E |

**Acceptance:** ask for a task requiring `gh` or a document converter on a clean guest; Outpost proposes, installs, verifies, uses, and inventories it under one approved plan.

### 6. Headless browser operation, viewing and takeover

Depends on: browser worker, page observation/actions, live viewer, artifact store.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| WEB-01 | Headless server browser | Run Chromium headlessly on Ubuntu Server; preserve task ownership, tabs, downloads and process health. Viewing/takeover is browser-scoped and does not require a Linux desktop. | C |
| WEB-02 | Observe-act-verify tools | Navigate, inspect semantic snapshots, click, type, select, scroll, upload, download, and verify the changed state using fresh page references. | C |
| WEB-03 | Visual perception | Use screenshots and an evaluated open vision model for image/canvas-based interfaces; fall back to human takeover when perception is insufficient. | E |
| WEB-04 | Durable browser identities | Reuse explicitly chosen identities across tasks while isolating accounts and preventing concurrent mutation of the same profile. | C |
| WEB-05 | Live browser viewer | Watch the server browser on Mac/iPhone with URL, active account, task, and current action; do not confuse a remote frame with a locally authenticated website. | C |
| WEB-06 | Human takeover | Pause agent input, give the owner exclusive control, handle login/challenges or delicate interactions, then explicitly return control. | C |
| WEB-07 | Multi-tab research | Organize tabs by task, handle popups/frames/dialogs, retain useful pages, and close abandoned sessions under resource policy. | C |
| WEB-08 | Reliable page data | Extract tables, forms, text, links, PDFs, and screenshots with source and timestamp; preserve original downloads alongside transformed data. | C |
| WEB-09 | Debug and test websites | Inspect console/network/errors, emulate viewports, capture traces, run browser tests, and compare visual states on task-owned apps. | C |
| WEB-10 | Browser session recovery | Persist permitted task/identity state and restore browser sessions after crashes or restarts; retain downloads/evidence and reacquire human control safely. No Linux desktop fallback. | C |

**Acceptance:** complete a multi-page form with an upload, retrieve a file, survive a browser restart, and let the owner take over and return control without concurrent clicks. The viewer/input path is scoped to the headless browser; a general-purpose Linux desktop/VNC service is excluded.

### 7. Accounts, local Chrome, passwords, and authentication

Depends on: protected identity broker, device trust, browser ownership, native consent.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| ID-01 | Account inventory | Show connected services, account identity, scopes, profile location, last use, expiry, and whether an identity is broker-protected or delegated to the machine. | C |
| ID-02 | OAuth and delegated access | Prefer official OAuth/device flows and narrow service credentials where supported; separate read, draft, send, admin, and billing privileges. | C |
| ID-03 | Fresh server login | Open a selected account in the protected server browser and let the owner sign in; persist only the state required for the delegated workflow. | C |
| ID-04 | Local Chrome companion | Consent-based Mac bridge for selected local tabs or an approved browser session; visible connection indicator, short lease, revocation, and no open public debugging port. | E |
| ID-05 | Selected credential migration | Preview and approve chosen account credentials, transfer them encrypted to a protected vault, and report exactly what was imported; avoid an automatic whole-password-store export. | E |
| ID-06 | Selected session transfer | Copy supported origin-scoped session state only after explicit review; record expiry and source; detect reauthentication requirements rather than promise transparent cross-OS login. | E |
| ID-07 | Secret-use requests | Resolve opaque secret references for an approved origin/purpose; keep plaintext out of Pi prompts, ordinary logs, task files, screenshots, and shell history wherever the broker controls them. | C |
| ID-08 | MFA, OTP, and passkeys | Hand off user presence, hardware key, passkey and financial challenges; support narrow one-time code input without storing authenticator recovery material in the agent home. | C |
| ID-09 | Account lifecycle | Refresh scoped tokens, detect logout/expiry, revoke grants, disconnect accounts, rotate exposed credentials, and show affected tasks. | C |
| ID-10 | Agent-first identity separation | Default to dedicated agent-owned accounts created by the owner; support separately scoped owner identities, explicit selection per task and no silent fallback to a more privileged owner account. | C |

**Acceptance:** connect one GitHub identity and one ordinary web account, complete work, revoke access from iPhone, and demonstrate subsequent protected use fails. Test Chrome transfer independently on the actual Mac/browser version.

Google documents password CSV import/export, but that is not a portable dump of all browser authentication. Treat any export as plaintext secret material and perform selection/filtering in the trusted client, with encrypted temporary handling and deletion. Do not promise forensic erasure from SSDs or backups. Sources: [Google Password Manager import/export](https://support.google.com/chrome/answer/13068232), [Chrome connection configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration), [Playwright authentication](https://playwright.dev/docs/auth).

### 8. CAPTCHA, verification, and human assistance

Depends on: browser challenge detection, takeover, notifications, optional solver adapter.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| CAP-01 | Challenge recognition | Distinguish CAPTCHA, login, MFA, permission denial, rate limit, paywall, and page failure; choose the correct waiting state. | C |
| CAP-02 | Resume after a challenge | Preserve task/tab/form state, request help once, and resume from a verified page state after resolution. | C |
| CAP-03 | Self-hosted solver plugins | Expose installed local challenge helpers to Pi for supported authorized workflows; any model reasoning uses the approved Ollama Cloud route. No hosted CAPTCHA-solving vendor is a default dependency. | E |
| CAP-04 | Local solving experiments | Evaluate open OCR/vision models for supported non-sensitive challenge tasks; label measured coverage and failure rates, not "solves any CAPTCHA." | A |
| CAP-05 | Challenge budget | Bound local solver attempts, runtime and Ollama Cloud inference use; stop and request human help when the approved budget or capability is exhausted. | E |
| CAP-06 | Human challenge UI | Open the exact live browser state on Mac or phone; pause competing input and confirm a resolution before the agent continues. | C |
| CAP-07 | Challenge memory | Record that a site/account often needs help and prefer a stable authorized session or official API where possible; do not store reusable challenge secrets. | E |
| CAP-08 | Respect explicit denial | If a service denies access or forbids the workflow, stop or use an authorized alternative; do not turn challenge handling into evasion of an access restriction. | C |
| CAP-09 | Challenge observability | Show site, challenge class, elapsed wait, attempts, cost, and what is needed from the owner; redact sensitive challenge content in retained logs. | C |
| CAP-10 | Provider conformance | Test timeout, cancellation, unsupported challenge, duplicate callbacks and failed solutions; solver success alone never proves the intended task succeeded. | E |

**Acceptance:** use controlled challenge fixtures and a permitted real workflow; verify supported local assistance and reliable phone takeover. Steel's [managed CAPTCHA API](https://docs.steel.dev/overview/captchas-api/overview) is a research reference, excluded by the current hosting rule. Unsupported challenges require human takeover; no universal coverage is promised.

### 9. Coding and software engineering

Depends on: filesystem tools, shell, Pi/Ollama tool reliability, worktrees, diagnostics.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| DEV-01 | Repository understanding | Inspect project instructions, architecture, build/test commands, dependency graph, and recent changes before modifying code. | C |
| DEV-02 | Reproduce and debug | Reproduce failures, gather logs/stack traces, create a minimal case where helpful, and test the suspected cause before declaring a fix. | C |
| DEV-03 | Precise edits | Use patches/unique-match edits with conflict detection; preserve unrelated changes and reject stale edits rather than overwrite silently. | C |
| DEV-04 | Semantic code tools | LSP diagnostics, symbols, definitions/references, rename/refactor assistance, and code-aware search through installable language packs. | E |
| DEV-05 | Build and test | Discover and run appropriate unit/integration/end-to-end checks; retain outputs and distinguish failure, skipped checks, and passing checks. | C |
| DEV-06 | Feature implementation | Implement UI/backend/scripts, update relevant docs, handle migrations, and produce a reviewable change set with acceptance evidence. | C |
| DEV-07 | Browser-driven development | Start preview servers, inspect pages, exercise flows, collect console/network evidence, and iterate on screenshots within the same task. | C |
| DEV-08 | Code review | Review local diffs or PRs for correctness, tests, security, performance and regressions; attach evidence to precise changed locations. | E |
| DEV-09 | Change checkpoints | View changes per turn and full branch; undo files and coordinate Pi context so an abandoned edit is not still assumed to exist. | C |
| DEV-10 | Platform-specific build handoff | Ubuntu handles Linux-capable builds. Xcode/iOS signing needs the owner's Mac as an explicit local-client handoff, not a required second Outpost backend or hosted build service. | A |

**Acceptance:** reproduce a real bug, fix it in an isolated worktree, run checks, inspect the app, undo one turn correctly, and deliver a reviewable diff with honest verification limits.

### 10. GitHub, Git hosting, and delivery

Depends on: Git, installable `gh`, brokered identities, provider adapters, task approvals.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| GIT-01 | GitHub CLI | Install and use `gh` for authorized repository, issue, PR, checks, release and API work; show account/repository context before mutations. | C |
| GIT-02 | Repository lifecycle | Clone, initialize, fork and publish repositories; ask before changing visibility, deleting a repository, or exposing private material. | C |
| GIT-03 | Branches and worktrees | Isolate task branches, manage remotes/upstreams, preserve dirty worktrees, and clean up only after a verified handoff or owner rule. | C |
| GIT-04 | Commits and PRs | Generate useful commit messages and PR descriptions, attach issues/evidence, request reviewers, and keep final titles aligned with actual scope. | C |
| GIT-05 | CI investigation | Read checks, bounded logs/artifacts, and annotations; diagnose failures, propose reruns where authorized, and fix them without fabricated success. | C |
| GIT-06 | Review-response work | Incorporate reviewer comments, track resolved/unresolved items, and prepare responses for approved submission. | E |
| GIT-07 | Merge and release | Prepare merge/release summaries and artifacts; execute merges, tags, production deployments or rollback only under applicable authority. | E |
| GIT-08 | Conflicts and history | Rebase/merge with conflict resolution; preview force-push/reset/history-rewrite effects and retain a recovery reference. | C |
| GIT-09 | Git hosting adapters | Optional GitLab, Forgejo/Gitea and other hosts through their APIs/CLIs; retain host/account-specific authorization. | E |
| GIT-10 | Repository event tasks | Turn approved issue/PR/CI webhooks into scoped tasks, deduplicate events, and avoid executing instructions embedded in untrusted comments as owner authority. | E |

**Acceptance:** solve an issue through `gh`, prepare a PR, diagnose its CI, and require an explicit merge decision. [GitHub CLI](https://cli.github.com/manual/gh) is a tool, not an authorization boundary. A short-lived [GitHub App installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) is an option; once any token is delegated into the root-capable guest, it can be used outside `gh` until expiry/revocation.

### 11. Server operations, deployments, and cloud resources

Depends on: machine access, secrets broker, typed external operations, monitoring.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| OPS-01 | Diagnose running services | Inspect health, processes, logs, ports, queues, dependency failures and disk pressure; correlate evidence before changing the service. | C |
| OPS-02 | Container operations | Build images, run Compose/Podman/Docker workloads, inspect logs and health, and manage task-owned volumes/networks under explicit host authority. | C |
| OPS-03 | Deployment workflow | Build, stage, test, compare versions and deploy; capture rollout/rollback evidence and actual environment ownership. | E |
| OPS-04 | Infrastructure as code | Prepare and explain Terraform/OpenTofu/Ansible changes, review plans, and apply only within an approved resource/cost scope. | E |
| OPS-05 | Cloud and hosting adapters | Install provider CLIs/connectors for explicitly connected accounts; inspect resources, troubleshoot builds, manage approved changes and record provider operation IDs. | E |
| OPS-06 | Domain/DNS/TLS work | Inspect and prepare domain records and certificates; show mail/verification impacts and request approval for public routing or domain purchases. | E |
| OPS-07 | Databases and migrations | Run authorized queries, inspect plans, back up and restore, prepare migrations, and distinguish production from disposable development data. | E |
| OPS-08 | Incident procedures | Execute a preapproved playbook, gather an incident timeline, apply bounded remediation, and escalate instead of widening authority when it fails. | E |
| OPS-09 | Cost-aware resource lifecycle | Estimate provisioning charges, enforce external limits where available, tag ownership, track expiry, and clean up only resources covered by the task. | E |
| OPS-10 | Agent self-maintenance | Diagnose its own worker/browser/tool failures and prepare updates; a separate trusted supervisor owns coordinator updates, credential policy and recovery. | C |

**Acceptance:** diagnose a broken task-owned web service, show evidence, stage a fix, request the production change, verify service health, and roll back in a rehearsal.

### 12. Web research and information gathering

Depends on: search/fetch adapters, browser, source storage, document parsing.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| RES-01 | Self-hosted search | Run a search adapter/metasearch service on Ubuntu, expose it to Pi, and query public upstream sources under their access limits; no managed search API is required. | C |
| RES-02 | Source-grounded answers | Record source URL/title, access time, relevant evidence, publication date when available, and confidence; distinguish observation from inference. | C |
| RES-03 | Deep research tasks | Decompose questions, compare sources, follow citations, track unresolved claims, and deliver a report with a supporting evidence folder. | E |
| RES-04 | Structured extraction | Extract public or authorized account data into tables/JSON/CSV with schemas, deduplication, unit/currency normalization, and validation. | C |
| RES-05 | Responsible crawling | Scope domains/pages, rate-limit, checkpoint, honor applicable access restrictions, and stop on explicit blocks rather than silently escalating methods. | E |
| RES-06 | Change monitoring | Watch selected pages, docs, releases, prices or public records; retain before/after evidence and alert only on user-defined meaningful change. | E |
| RES-07 | Mixed-source research | Combine repo files, PDFs, spreadsheets, browser pages and connected knowledge sources with provenance for each claim. | C |
| RES-08 | Comparison dossiers | Build vendor/tool/travel/product comparisons including total costs, availability uncertainty, trade-offs, and links without making a purchase. | E |
| RES-09 | Reproducible datasets | Retain extraction code, source versions, filters and refresh procedures; show gaps and failed pages instead of hiding incomplete coverage. | E |
| RES-10 | Research-to-action handoff | Turn a verified finding into a proposed code change, server action, draft communication or purchase plan while preserving the next action's approval boundary. | E |

**Acceptance:** research a real technical choice, produce a cited report and structured comparison, refresh one changed source, and explain which conclusions changed. [SearXNG](https://docs.searxng.org/) is a self-hosted search candidate; upstream engine blocking and availability still need measurement.

### 13. Documents, spreadsheets, presentations, and files as deliverables

Depends on: artifact service, file tools, open document toolchain, rendering and validation.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| DOC-01 | Read heterogeneous documents | Parse PDF, office files, HTML, Markdown, text and scanned images; retain page/sheet/section references and mark extraction failures. | C |
| DOC-02 | Write reports and documents | Produce DOCX, PDF, Markdown and HTML with headings, tables, citations, charts and reusable owner templates. | C |
| DOC-03 | Spreadsheet work | Create and edit XLSX/CSV, formulas, formatting and charts; recalculate with a compatible engine and check representative formula results. | C |
| DOC-04 | Slide decks | Generate PPTX and rendered previews from research, data or a reference deck; inspect layouts instead of claiming a saved file is presentation-ready. | E |
| DOC-05 | PDF workflows | Merge/split, extract, annotate, fill supported forms, redact where technically validated, and generate PDFs while preserving original evidence. | E |
| DOC-06 | Render and inspect | Render final documents to pages/slides and check clipping, pagination, fonts, charts and missing content; store previews beside the original artifact. | C |
| DOC-07 | Revision and review | Compare document versions, apply requested changes, show meaningful diffs or redlines when supported, and retain a recoverable earlier version. | E |
| DOC-08 | Batch transformations | Convert, rename, classify, summarize and organize large document collections with restartable progress and per-file failures. | E |
| DOC-09 | Template library | Owner-approved branding, layouts, writing conventions, spreadsheets and reports that can be selected per task without granting new external authority. | E |
| DOC-10 | Delivery workflow | Package outputs, show provenance and unresolved issues, then download/share/upload/send only under the destination's applicable permission. | C |

**Acceptance:** turn two CSVs and a source PDF into a calculated spreadsheet and formatted report; render and inspect both, and show every failed or uncertain source extraction. [Docling](https://github.com/docling-project/docling) is an evaluated ingestion/OCR candidate; document generation and final visual QA remain separate work.

### 14. Data analysis and databases

Depends on: Python/SQL tools, data intake, resource limits, secrets and data access scopes.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| DATA-01 | Local analysis | Use Python, pandas/Polars, SQL or DuckDB-style tooling for cleaning, joining, aggregation, validation and reproducible calculations. | C |
| DATA-02 | Data quality reports | Identify missing values, duplicate records, schema drift, inconsistent units, outliers and rejected rows with counts and reproducible checks. | C |
| DATA-03 | Charts and explanations | Produce appropriate charts/tables with labelled units, filters, assumptions and a link to the data and calculation used. | C |
| DATA-04 | Query connected databases | Connect to approved databases with read-only roles by default; show database/environment, row limits and query cost controls. | E |
| DATA-05 | Approved data mutations | Preview update/delete scope, take a viable backup where possible, use transactions, verify counts, and require write authority distinct from read access. | E |
| DATA-06 | Data pipelines | Build restartable import/export and transformation jobs with checkpoints, schemas, lineage and explicit destination permissions. | E |
| DATA-07 | API datasets | Paginate, respect rate limits, resume extraction, reconcile totals, and preserve source IDs rather than silently drop failed pages. | E |
| DATA-08 | Notebook and script outputs | Deliver runnable scripts/notebooks, dependency manifests and a concise method, with sensitive values represented as references. | E |
| DATA-09 | Large-data execution | Stream or chunk oversized inputs, estimate disk/RAM, avoid loading everything into model context, and fail clearly when resources are insufficient. | E |
| DATA-10 | Business/finance preparation | Prepare reconciliations, invoice summaries, expense categorization and operational reports with traceable calculations; submissions or transfers use separate authority. | E |

**Acceptance:** analyze a deliberately messy dataset, reconcile input/output counts, reproduce the totals with code, and reject an unauthorized production write.

### 15. Email, calendar, messaging, and collaboration

Depends on: service connectors, scoped accounts, approval previews, external effect reconciliation.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| COM-01 | Email reading and triage | Search/summarize approved mailboxes, extract action items and attachments, and organize labels under configured authority. | E |
| COM-02 | Draft and send mail | Draft context-aware replies, show exact recipients/content/attachments, and send only with current-task or standing send authorization. | E |
| COM-03 | Calendar assistance | Find availability, propose times, prepare events and handle recurrence/time zones; distinguish a private reminder from sending attendees invitations. | E |
| COM-04 | Chat integrations | Optional Telegram, Slack, Discord, Matrix or other official connectors with explicit channel, sender identity and outbound scope. | E |
| COM-05 | Meeting preparation | Compile agendas, relevant files, prior decisions, open questions and follow-up drafts from authorized sources. | E |
| COM-06 | Contact and relationship context | Store owner-reviewed contact identities and preferred channels; disambiguate similar names before an external send. | E |
| COM-07 | Task intake from messages | Turn approved incoming requests into queued work; treat third-party content as data and never as automatic authority to spend or elevate. | E |
| COM-08 | Notification routing | Persist completion/failure/action-required notices in the server inbox and stream them to connected clients; optional owner-connected channels are task destinations, not a hosted notification backend. | C |
| COM-09 | Shared systems administration | Optional ticketing, project boards, CRM, knowledge bases and business tools through installable adapters, with audit and resource-specific permission. | A |
| COM-10 | Delivery reconciliation | Detect whether a send or update already succeeded before retrying; retain provider IDs and mark uncertain outcomes for inspection. | E |

**Acceptance:** summarize a mailbox, draft a reply with the right attachment, approve the exact send from phone, and prove a network retry does not create a second message. Official [Gmail](https://developers.google.com/workspace/gmail/api/guides) and [Calendar](https://developers.google.com/workspace/calendar/api/guides/overview) APIs are integration options; account policies and permitted scopes still apply.

### 16. Personal administration and delegated errands

Depends on: research, authenticated browsing, document tools, purchasing authority where applicable.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| LIFE-01 | Account administration | Retrieve statements/invoices, inspect settings, prepare profile updates, and execute approved account changes through supported sites/APIs. | E |
| LIFE-02 | Travel and appointments | Research options, compare complete prices and constraints, prepare booking details, then stop for required booking/payment confirmation. | E |
| LIFE-03 | Forms and applications | Assemble required documents, fill authorized forms, show declarations and final fields, and obtain permission for submission or attestation. | E |
| LIFE-04 | Shopping and procurement | Compare stock/specifications, construct a cart, calculate total cost, and ask for the transaction-specific purchase described in PAY. | E |
| LIFE-05 | Subscription management | Inventory explicitly connected subscriptions, track renewal dates, flag price changes, and prepare or perform approved cancellations. | E |
| LIFE-06 | Returns and support | Gather order evidence, prepare support tickets, request approved returns/refunds, and track response/status without inventing a successful resolution. | E |
| LIFE-07 | Personal file organization | Organize receipts, records, photos and downloads; show proposed mass changes and preserve originals/backups. | E |
| LIFE-08 | Deadline preparation | Track renewals, application deadlines and owner-defined obligations; collect required material and remind only under an approved schedule. | E |
| LIFE-09 | Multi-step errands | Combine research, document preparation, browser actions, correspondence and payment preparation under one visible task and authority envelope. | A |
| LIFE-10 | Home and lab integrations | Optional enrolled home-server, NAS or device APIs; expose device state and require specific approval for changes with physical consequences. | A |

**Acceptance:** complete a realistic invoice retrieval and subscription-review task with an account login handoff, clear recommendations and no unauthorized cancellation or charge.

### 17. Payments, purchases, budgets, and receipts

Depends on: protected account/payment broker, exact approval binding, provider support, reconciliation.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| PAY-01 | Purchase preparation | Research, select items, prepare a cart and calculate total including currency, tax, shipping, deposits and recurring terms before requesting payment. | E |
| PAY-02 | Whole payment workflow approval | On either native client, approve merchant/payee, purpose, items, funding alias, maximum total/currency, delivery, recurrence, expiry and included checkout-to-receipt steps; require current owner authentication. | E |
| PAY-03 | Authorized workflow execution and handoff | Execute the owner-approved payment workflow through a supported broker/provider route; do not repeat prompts for included routine steps. Hand off issuer authentication or unsupported final checkout, and reconcile the real result. | E |
| PAY-04 | Brokered payment method | Use tokenized/provider-supported payment credentials outside the root-capable machine; never place the owner's general-purpose card or wallet secrets in Pi context. | E |
| PAY-05 | Bounded virtual instrument | Optional provider-issued virtual card or delegated instrument with available merchant/category/amount/time controls; only if the owner's location and account are eligible. | A |
| PAY-06 | Standing purchase mandate | Explicit opt-in rules for narrow repeat purchases: supplier, purpose, per-order/cumulative budget, currency, frequency, expiry and allowed recurrence; owner can revoke. | A |
| PAY-07 | Step-up authentication | Pause for bank/card/UPI/wallet authentication where required; the owner completes PIN, biometrics, passkey or OTP in the appropriate trusted interface. | E |
| PAY-08 | No duplicate purchases | Maintain a purchase ledger and operation key, reserve concurrent budget, verify provider/order state after timeouts, and never blindly replay a checkout click. | E |
| PAY-09 | Receipts and aftercare | Save invoices/receipts, record order and subscription IDs, track delivery/refund state, and prepare approved cancellation or return actions. | E |
| PAY-10 | Spending control centre | Show pending/committed/settled spend, recurring commitments, budget reservations, failed attempts and disputed or unknown outcomes; reconcile against provider records. | E |

**Acceptance:** use a test merchant to approve a precise order, reject a changed amount, expire stale approval, simulate a timeout after payment, and recover one real order rather than charge twice. Qualify a supported workflow route on fixtures before real purchases; retain owner checkout handoff where provider authentication or unsupported automation requires it.

A merchant's Stripe PaymentIntent API is not a universal API for paying arbitrary shops. Issuing a virtual instrument is a separate product with eligibility requirements; India is not in the local-issuance country list on the cited page, so this must not be assumed to be an available personal payment route for the owner. Stripe documents controls and also notes aggregation delays and possible later fees/overcapture, so do not describe issuer spending limits as a mathematically exact total-loss guarantee. Sources: [PaymentIntents](https://docs.stripe.com/api/payment_intents), [Issuing controls](https://docs.stripe.com/issuing/controls/spending-controls), [Issuing availability](https://docs.stripe.com/issuing/global), [idempotency](https://docs.stripe.com/api/idempotent_requests).

[AP2](https://ap2-protocol.org/) and [UCP](https://developers.google.com/merchant/ucp/faq) are future interoperability candidates for structured checkout and payment mandates. They do not create a funded account or guarantee merchant acceptance. Pin the actual protocol revision; current AP2 terminology differs from some older tutorials. Owner signing authority must stay on a trusted client/broker, not a key the agent can generate and self-approve with.

### 18. Scheduling, monitoring, and proactive work

Depends on: durable tasks, scheduler, stored authority, quiet notification rules.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| AUTO-01 | One-time and recurring work | Natural-language schedules, explicit time zone, next-run preview, start/end dates, and support for one-off, interval and calendar schedules. | C |
| AUTO-02 | Meaningful monitors | Watch a URL, repo, service, folder, CI run, invoice or other resource; wake the model only when a condition or useful interval warrants it. | E |
| AUTO-03 | Durable scheduling semantics | Record scheduled occurrence IDs, missed-run policy, retries and deduplication; define catch-up behavior after outages and daylight-saving changes. | C |
| AUTO-04 | Webhook and event triggers | Authenticate incoming events, deduplicate/replay safely, rate-limit, and map them to a constrained task rather than unrestricted prompt execution. | E |
| AUTO-05 | Heartbeat goals | Periodically inspect an owner-authorized objective and continue useful work; remain quiet on unchanged/non-actionable state. | E |
| AUTO-06 | Bounded automatic remediation | Run a tested procedure only on specified services/resources, with rate/attempt limits, rollback and escalation. | E |
| AUTO-07 | Approval while unattended | Persist requests, notify once under policy, stop at the protected step, and expire or reschedule safely when no owner responds. | C |
| AUTO-08 | Resource and spend budgets | Limit model runtime, browser slots, API fees, cloud use and purchase authority per automation; prevent overlapping instances unless explicitly allowed. | E |
| AUTO-09 | Automation management | List, explain, test, pause, resume, edit and delete automations; show their permissions, last results, next run and change history. | C |
| AUTO-10 | Schedules are explicit authority | A memory note or generated plan does not silently create recurring work; scheduler/standing grants require an owner-authorized operation and record. | C |

**Acceptance:** monitor a CI failure, notify on a meaningful transition, survive a scheduler restart, and execute a one-time follow-up exactly once at the scheduling level. External effects still need provider reconciliation.

### 19. Memory, personal knowledge, and retrieval

Depends on: task/artifact storage, source identities, local search/embedding support.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| MEM-01 | Explicit durable memory | Save owner preferences, project conventions, decisions and known service facts with source, date, scope and correction history. | C |
| MEM-02 | Episodic task history | Search previous work, results, errors and supporting artifacts; summarize what happened without replacing retained evidence. | C |
| MEM-03 | Local semantic retrieval | Use approved local embeddings plus keyword search; keep indexes rebuildable and respect source/account boundaries. | E |
| MEM-04 | Task working state | Save current plan, facts, files, active processes, pending decisions and next action before context compaction or a long wait. | C |
| MEM-05 | Provenance and freshness | Mark direct observation, owner instruction, imported note and inference; revalidate stale operational facts before consequential action. | C |
| MEM-06 | Inspect, correct, and forget | Provide a memory browser, edit/supersede/delete actions and deletion propagation to indexes; explain retained audit/backup limits. | E |
| MEM-07 | Knowledge collections | Index selected repos, folders and connected sources into named collections with update schedules and access scopes. | E |
| MEM-08 | Procedure learning | Propose a reusable skill from a successful task, include prerequisites and verification, and request review before expanding its authority. | E |
| MEM-09 | Memory never grants permission | Keep remembered preferences and past approvals separate from live policy/grants; a retrieved page cannot promote itself into owner instructions. | C |
| MEM-10 | Controlled consolidation | Deduplicate and condense notes in the background, preserve source links, flag contradictions, and keep an owner-readable change history. | A |

**Acceptance:** resume a task after compaction using its recorded facts, correct an obsolete preference, remove an indexed memory, and reject a retrieved instruction attempting to grant sudo or payment authority.

### 20. Specialized workers and coordinated parallel work

Depends on: resource scheduler, scoped tool loadouts, task graph, authority inheritance.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| TEAM-01 | Worker roles | Optional coding, browser, research, document, operations and verification workers, all implemented on Pi-compatible integration paths where practical. | E |
| TEAM-02 | Bounded delegation | Parent assigns a concrete deliverable, resources, budget, deadline and tool loadout; child authority is a subset of the parent's current grant. | E |
| TEAM-03 | Task dependency graph | Model prerequisites, parallel steps and joins; persist progress and avoid declaring a mission done while required children remain unresolved. | E |
| TEAM-04 | Workspace coordination | Separate worktrees or folders, account/profile leases, service locks, and explicit merge/handoff of shared results. | E |
| TEAM-05 | Cloud-capacity-aware queue | Schedule Pi model calls within Ollama Cloud account limits and task budgets; show quota/backoff state and separately bound local browser/tool workers. | C |
| TEAM-06 | Independent verification | Run deterministic checks or a separately scoped verifier; label model-based review as supporting judgment, not proof of correctness. | E |
| TEAM-07 | Budget inheritance | Charge nested tools/workers to the initiating task, prevent recursive runaway spawning, and cap depth/concurrency. | E |
| TEAM-08 | Worker recovery | Replace a crashed worker, attach its durable state, and reconcile outstanding effects before retrying the assigned step. | E |
| TEAM-09 | Owner-visible delegation | Show what each worker is doing, machine/account used, pending approval and final artifact; hide noisy internal chatter by default. | E |
| TEAM-10 | Same-server worker expansion | Scale isolated worker processes, containers or VMs on the same Ubuntu server with capability discovery, leases and quotas. A multi-server fleet is outside the current hosting scope. | A |

**Acceptance:** coordinate a code worker and a browser verifier on separate task resources; prove they cannot inherit broader credentials, conflict over a profile, or exceed the parent's spend grant. Pi's minimal harness does not itself supply this complete orchestration layer.

### 21. Plugins, skills, MCP, and reusable capabilities

Depends on: capability registry, Pi resource loader, protected service boundaries, package lifecycle.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| EXT-01 | Pi extension support | Load approved, pinned extensions and skills through the chosen SDK adapter; expose compatible configuration and clear runtime failures. | C |
| EXT-02 | Self-hosted MCP connectors | Run MCP adapters/servers on Ubuntu over stdio or local authenticated transport, expose them to Pi, and mediate their authorized calls to external task services. | E |
| EXT-03 | Simple CLI adapters | Wrap an installed CLI with structured inputs/results, help/discovery, exit handling and capability metadata without needing a new full plugin framework. | C |
| EXT-04 | Capability manifest | Declare tools, dependencies, executable hashes, data destinations, secrets, permissions, update source, licences and smoke tests. | E |
| EXT-05 | Dynamic tool discovery | Search/load only tools relevant to the current step; keep hundreds of integrations from overwhelming a smaller model's context. | C |
| EXT-06 | Capability packs | Bundle software, skills, schemas and tests for coding, browser work, documents, operations, communications or data analysis. | E |
| EXT-07 | In-process trust distinction | Treat Pi extensions as executable trusted code; run less-trusted connectors in separate processes/containers with mediated resources. | C |
| EXT-08 | Permissions on upgrade | Compare changed capabilities/scopes, require owner approval for escalation, and pin the version used by existing jobs until a compatible transition. | E |
| EXT-09 | Local interoperability adapters | Optional ACP engines and agent adapters run on Ubuntu and are exposed to Pi; task import/export or authorized protocol exchange does not outsource execution or expand authority. | A |
| EXT-10 | Owner's private registry | Save verified packs/recipes, stage new versions, inspect provenance and roll back; avoid automatic execution of arbitrary marketplace content. | E |

**Acceptance:** install a pack, discover and run one tool, upgrade it with a changed permission request, reject the escalation, and keep the existing version working. MCP revision compatibility belongs in the adapter; [the current specification](https://modelcontextprotocol.io/specification/latest) should not be hand-implemented from a stale summary.

### 22. Ollama Cloud and open-model operations

Depends on: Ollama Cloud account/access, server-hosted credential gateway, model registry, Pi adapter conformance and quota telemetry.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| MODEL-01 | Ollama Cloud primary path | Route Pi through the server-hosted gateway to approved Cloud models; keep the cloud credential out of clients/guest-wide config and make hosted inference visible. | C |
| MODEL-02 | Cloud capability probes | Test tools/results, streaming, images, context and cancellation on the actual hosted route. Validate data locally; do not assume Cloud-enforced structured output. | C |
| MODEL-03 | Operator, reviewer and vision roles | Qualify Cloud operator/coding, a separate smaller safety reviewer for Auto, and vision roles; self-host embedding/indexing helpers. Reviewer failure or uncertain classification asks the owner. | C |
| MODEL-04 | Explicit model inventory | Record hosted API ID, licence/source, observed version/digest if available, effective capabilities/context, qualification date and fallback list; do not invent provider-hidden runtime details. | C |
| MODEL-05 | Cloud health and usage | Show availability, latency, throughput, task usage, quota/rate limits where exposed, request failures, retries and budget state; unknown usage remains unknown. | C |
| MODEL-06 | Context management | Retrieve relevant files, truncate verbose output, summarize with provenance, preserve durable task state and reserve space for tool results. | C |
| MODEL-07 | Task-based evaluations | Measure coding, browser, document and operations success with deterministic validators; report failure modes and human intervention rate. | C |
| MODEL-08 | Approved Cloud fallback | Retry transient failures or select another qualified open model on Ollama Cloud within the task's data/budget scope. Otherwise pause; no silent provider or local-runtime switch. | E |
| MODEL-09 | Hosted model changes | Requalify changed IDs/behavior and retirements, keep alternative qualified models, and avoid promising rollback to cloud revisions the provider no longer serves. | E |
| MODEL-10 | Efficient execution modes | Small tool loadouts, locally validated structured data, deterministic recipes, context budgets and concurrency matched to Cloud quotas plus local tool capacity. | E |

**Acceptance:** execute tool round-trip and browser/code fixtures repeatedly through Pi's actual Ollama Cloud route; verify key handling, latency, tool correctness, quota recovery and no replayed sensitive effects.

### 23. Voice, images, video, and media work

Depends on: file/artifact tools, optional local specialist models and multimedia packages.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| MEDIA-01 | Voice task input | Record a voice note in the client, transcribe locally or on the owner's server, show the text, and treat ambiguous sensitive instructions as needing clarification. | E |
| MEDIA-02 | Spoken updates | Optional local speech output for progress and answers; provide transcript, mute, interruption and privacy controls. | A |
| MEDIA-03 | Screenshot understanding | Attach images or selected screen regions for analysis; explicitly confirm destination when local content leaves the Mac. | E |
| MEDIA-04 | OCR and scanned records | Extract text/tables from images and scans with coordinates/confidence where available and an owner-visible correction path. | E |
| MEDIA-05 | Image transformations | Resize, crop, annotate, compress, convert and organize assets using installed tools; preserve originals and check the visual result. | E |
| MEDIA-06 | Open image-generation tools | Optional self-hosted generation/editing worker when hardware and model licence allow; separately label generated imagery and required GPU resources. | A |
| MEDIA-07 | Audio/video processing | Use installable media tools for clipping, transcoding, subtitles, transcription, frame extraction and exports with input/output provenance. | E |
| MEDIA-08 | Meeting recordings | Process owner-supplied/authorized recordings into notes and action items; meeting capture itself requires a separate consented integration. | E |
| MEDIA-09 | Multimodal deliverables | Combine screenshots, charts, recordings and text into reports, tutorials or demos with reviewable intermediate artifacts. | A |
| MEDIA-10 | Media resource budgets | Queue large jobs, estimate storage/runtime, set retention and cancellation rules, and avoid starving the main operator's inference. | E |

**Acceptance:** turn an uploaded voice request and screen recording into a transcript, action list and clipped demonstration, with inspection of each deliverable. [whisper.cpp](https://github.com/ggml-org/whisper.cpp) is a local speech candidate; an ASR tool is separate from Ollama's main LLM provider.

### 24. Native Swift macOS experience

Depends on: shared Swift protocol/state packages, Ink tokens, native specialist components.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| MAC-01 | Native app shell | SwiftUI/AppKit windows, menus, keyboard navigation, drag/drop and accessibility; retain the Ink hierarchy and restrained visual language. | C |
| MAC-02 | Projects and tasks sidebar | Group projects, recent tasks, needs-you requests and running work; support search, pin/archive, unread/completion states and machine context. | C |
| MAC-03 | Conversation and plan | Stream readable messages and public progress, show tool rows and task steps, and support steering, attachments, model/profile choices and cancellation. | C |
| MAC-04 | Contextual evidence surfaces | Present task plans, changed files/diffs, live browser, read-only action evidence, screenshots and generated outputs. No user shell, arbitrary server filesystem console or Linux desktop viewer. | C |
| MAC-05 | Code review surface | Turn/branch diffs, file tree, changed-file summary, checkpoint restore, checks and PR context in the style of t3code's workflow. | C |
| MAC-06 | Machine and capabilities | Health, installed tools, service/process inventory, resource queue, storage and capability installation/update screens. | C |
| MAC-07 | Approvals and accounts | Trusted decision centre with exact action previews, account scope, grants, revocation, and device authentication for high-impact actions. | C |
| MAC-08 | Local companion | Optional selected-tab/file/screen bridge, share extension or share-sheet intake where supported, and clear revocable consent for each local capability. | E |
| MAC-09 | Automation and memory tools | Native lists/editors for schedules, monitors, stored procedures, memory inspection, evidence history and configuration changes. | E |
| MAC-10 | Native quality | Dark/light parity, Dynamic Type where applicable, VoiceOver, visible focus, reduced motion, keyboard shortcuts and usable large transcripts. | C |

**Acceptance:** run an entire bug-fix/browser task from a keyboard on Mac, inspect evidence in adjacent panes, approve from phone, and observe the resolved state on Mac. Prototype native diff/code and read-only activity rendering; a client terminal emulator is not required or in scope.

### 25. iPhone, continuity, and remote control

Depends on: shared Swift packages, paired device auth, reconnect/resume, notifications.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| PHONE-01 | Native sessions and inbox | Needs you, running and recent work with mode/profile icon, task title, machine/account summary and accessible touch targets. | C |
| PHONE-02 | Equal client continuity | Read and create the same server-owned conversations/tasks, steer/cancel, change control mode, review evidence and approve workflows from either device; reconnect without missing or duplicated committed content. | C |
| PHONE-03 | Equal native approvals | Review exact actions, scope and whole payment workflow details on either client; authenticate sensitive decisions and resolve once on the server. No Mac-only payment approval dependency. | C |
| PHONE-04 | Server inbox and Apple push | Persist notices on Ubuntu, stream to active clients and send APNs notifications directly from the Ubuntu notifier; deep-link and replay server state when the app opens. Push is not authoritative or guaranteed immediate. | C |
| PHONE-05 | Browser takeover | Inspect and interact with the live remote browser using zoom/touch/keyboard; display the account and return-control action clearly. | E |
| PHONE-06 | File and voice intake | Upload from Files/share sheet/camera/voice, with destination and local/server processing visibility, then preview and share returned artifacts. | E |
| PHONE-07 | Pairing and revocation | QR/fingerprint confirmation, Keychain-held device identity, last seen, lost-device revoke, and explicit re-pair after trust changes. | C |
| PHONE-08 | Readable offline history | Cache selected transcripts/artifacts with local protection, mark staleness, and avoid queuing offline financial approvals as if still current. | E |
| PHONE-09 | Lock-screen notifications and status | Use the owner-approved APNs exception for privacy-preserving alerts; optional Live Activities show status/freshness. Require the unlocked app for sensitive approval or payment authorization. | E |
| PHONE-10 | Remote emergency controls | Revoke a task's external grants, stop workers, pause automations, and ask the trusted supervisor to recover the guest, even if its agent process is stuck. | E |

**Acceptance:** close the Mac, open the iPhone app to retrieve the persistent request, inspect and approve the exact action, background/reopen, and reconcile one outcome. High-impact decisions require the unlocked app. Test the direct Ubuntu-to-APNs path and the server inbox independently; dropped pushes must not lose requests.

### 26. Trust, privacy, policy, and audit

Depends on: separate protected authority, broker interfaces, signed/device-bound decisions.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| TRUST-01 | Three modes and scoped authority | Persist Full control, Auto and Ask permission on the server with scope, policy version, expiry and revocation. Auto uses a smaller independent reviewer; Ask permission gates every work action; protected trust changes stay owner-only. | C |
| TRUST-02 | External effect mediation | Broker protected account, payment, production and trust changes; prevent alternate shell/HTTP/MCP paths from silently gaining those credentials. | C |
| TRUST-03 | Instruction provenance | Distinguish owner instructions from pages, files, tool output and messages; untrusted content cannot create policy, schedules or new approving devices. | C |
| TRUST-04 | Sensitive-data minimization | Redact secrets, OTPs and private payment details across text, structured tool results, screenshots, traces, exports and crash reports. | C |
| TRUST-05 | Protected audit trail | Record intent, authority, approval, execution, provider IDs and verification outside the machine's root-accessible storage. | C |
| TRUST-06 | Reauthentication and exact binding | Require current owner presence for high-impact grants; reject altered requests, stale carts, changed destinations and replayed decision signatures. | C |
| TRUST-07 | Data boundaries | Per-project/account retrieval scope, controlled file uploads, SSRF protection for broker services, and explicit routes to approved private-network resources. | C |
| TRUST-08 | Revocation and emergency stop | Revoke future capabilities and sessions promptly; distinguish revocation from refunding money or undoing an already completed action. | C |
| TRUST-09 | Plugin and dependency trust | Pinned dependencies/images, staged updates, extension provenance, permission diffs and no automatic promotion of agent-written trusted code. | C |
| TRUST-10 | Owner visibility and export | Inspect active permissions, external identities, task evidence, retained data and exports; provide deletion/retention controls with backup/audit limitations explained. | E |

**Acceptance:** a test page/file/plugin attempts to read protected secrets, alter approval policy and trigger an unapproved purchase; all protected effects fail and appear in the authoritative audit. This test must run with the guest root-capable to exercise the real boundary.

### 27. Reliability, backup, resource economics, and recovery

Depends on: supervisor, durable storage, metrics, deterministic test harness.

| ID | Capability | Required behavior | Priority |
|---|---|---|---|
| REL-01 | Health and diagnosis | Surface control plane, Pi, machine, browser, model, broker and storage health separately; show actionable reasons and affected tasks. | C |
| REL-02 | Transactional outbox | Persist accepted intent before work, dispatch effects with deduplication, record actual completion and reconcile uncertain outcomes on recovery. | C |
| REL-03 | End-to-end identity | Carry task/run/tool/effect/approval IDs across workers and clients; show a unified timeline without exposing secrets or hidden model reasoning. | C |
| REL-04 | Backup and restore | Server-local ledger/account/workspace backups and host-owned guest snapshots, plus owner-exportable offline copies and tested restoration. No hosted backup backend is required. | C |
| REL-05 | Safe upgrades | Pin compatible versions, drain or interrupt work predictably, back up before migrations, and roll back worker/client incompatibilities. | C |
| REL-06 | Resource economics | Track server resources, Ollama Cloud usage/limits, browser/tool work and authorized external purchases separately; do not assume Cloud inference is unlimited or free. | E |
| REL-07 | Deterministic fixtures | Script Pi/model/tool outputs for reconnect, parallel approvals, malformed actions, crashes, timeouts and duplicate events without paid live dependencies. | C |
| REL-08 | Real model/site evaluations | Version a representative suite, measure completion and intervention, and rerun before changing the model, browser or privileged integrations. | C |
| REL-09 | Graceful degradation | Continue safe local work during a connector outage, queue model-limited tasks, stop protected actions when authority is unavailable and explain the limit. | C |
| REL-10 | Long-term portability | Export tasks, artifacts, environment manifests, memory and compatible Pi sessions; move machines without losing permission history or silently retaining revoked secrets. | E |

**Acceptance:** kill Pi, browser, guest and coordinator at controlled points; resume safely; restore onto a clean machine; compare final task state and protected effects with the durable ledger.

## V3.6 Open-model strategy and hardware decisions

### Ollama Cloud is the primary model service

Pi, execution and all supporting Outpost services are self-hosted on Ubuntu; the model runs on Ollama Cloud. This supersedes the earlier local-only inference requirement. Preserve the owner's open-model requirement by checking each selected model's licence/source; inclusion in a cloud catalogue is not by itself an open-source qualification.

| Connection | Integration decision |
|---|---|
| Direct Cloud API | Prefer a server-hosted inference gateway calling Ollama Cloud. The documented native route is `https://ollama.com/api/chat`; the compatible base is `https://ollama.com/v1`. Direct access uses bearer API-key authentication and does not require a local Ollama daemon. |
| Pi integration | Start with Pi's supported compatible-endpoint adapter behind the local gateway. If conformance fails, add a native Ollama Cloud provider extension. The worker never needs the long-lived Cloud key. |
| Optional local gateway daemon | A signed-in Ollama daemon may proxy Cloud models from Ubuntu if it measurably improves compatibility. It still performs hosted inference and does not create a local-only privacy guarantee. |
| Model discovery | Resolve supported API IDs from the provider catalogue/list API and retain exact returned IDs. Do not assume CLI `:cloud` or `-cloud` aliases are valid direct API names. |

Sources: [Cloud usage and catalogue](https://docs.ollama.com/cloud), [authentication](https://docs.ollama.com/api/authentication), [compatible API](https://docs.ollama.com/openai). Recheck capabilities and account availability during implementation; no Cloud account or key has been connected by editing this plan.

### Cloud model selection by role

| Role | Starting candidate or selection rule | What must be established |
|---|---|---|
| Main operator/coding | Qualify tools/coding-capable open models actually available in the [Ollama Cloud catalogue](https://ollama.com/search?c=cloud) and owner's account. Do not retain a locally sized 30B model as a mandatory default. | Correct Pi tools, coding/operations/browser planning, context, latency, task success and permitted usage. Select the exact ID after the benchmark. |
| Vision specialist | Qualify a Cloud model with image input and reliable grounding; share the main model if it passes both roles. | Correct screenshot/image transport through Pi, real page grounding and budget/latency. No vision GPU is required on Ubuntu. |
| Auto safety reviewer | A separate smaller qualified open model served by Ollama Cloud; selected from the account’s actual inventory. | Calibrated allow/ask decisions, dangerous false-allow rate, prompt-injection resistance, timeout/malformed-output fallback and held-out operations across all three product pillars. |
| Embeddings | An owner-selected local embedding/indexing helper on Ubuntu, or keyword retrieval initially. | Retrieval quality, licence, CPU/RAM footprint and rebuildability; no additional hosted embedding/vector service. |
| Speech | An optional local ASR worker such as whisper.cpp, independent of the main reasoning provider. | Actual speech languages, transcription quality, latency, storage and privacy. |
| Verification | Deterministic Ubuntu tools first; an approved Ollama Cloud model may add review. | A model agreeing with its own answer does not substitute for tests, receipts or observed outcomes. |

The previously researched [Qwen coding](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/main/README.md) and [vision](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/raw/main/README.md) cards remain optional local-reference evidence, not proof those exact models are served by Ollama Cloud or the current shortlist. Cloud catalogue membership, model capability and licence each need independent qualification; marketing rankings do not select Outpost's default.

Record the model source/licence, API ID, observed version information, capabilities and evaluation date. A permissive weights licence alone does not establish complete training-system openness. Provider-hidden quantization/template/hardware fields remain unknown; do not invent reproducibility or rollback guarantees for an unpinned hosted revision.

### Privacy, credentials and usage

- Store the Cloud key in the self-hosted protected vault/gateway, outside the guest, source control, Swift clients and ordinary task logs. Pi gets a scoped local inference identity with task/model/usage limits.
- Make the route visible in settings and task metadata. Cloud inference sends selected prompts/context, tool results and images to Ollama; the browser, tools and filesystem continue to operate on Ubuntu. Ollama states that Cloud prompts/responses are processed to answer requests and are not used for training; review its current policy rather than equate this with zero retention. Source: [Cloud data handling](https://docs.ollama.com/cloud).
- Minimize model context and redact credentials/payment secrets before transmission. Connecting Cloud authorizes the selected normal inference path, not export of an entire vault or browser profile. A task explicitly marked unsuitable for Cloud must pause or use approved deterministic local tools; no other hosted model is substituted.
- Meter requests and available usage data per task/automation. Enforce local budgets and concurrency; read actual account/plan limits rather than assume token pricing or unlimited access. Handle retirement and unavailable model IDs through the qualified fallback list.
- Support bounded backoff for rate limits and transient cloud failures; preserve task state and reconcile tool effects before resuming. The error guide documents `429`, `502` and errors inside an already-started stream. Source: [Ollama API errors](https://docs.ollama.com/api/errors).
- If the provider is unavailable, Ubuntu services, schedules and evidence remain local and durable. New reasoning waits; already-running local jobs can continue when their authority permits.

### Ubuntu sizing is for execution and self-hosted services

Inventory Ubuntu version, CPU/architecture, RAM, storage, virtualization/KVM, bandwidth, uptime and externally reachable networking. Budget separately for host coordination/brokers, agent workspace, browser sessions, builds/document tools, local search/indexing, and artifacts/snapshots. A capable local LLM GPU and downloaded main-model weights are not launch prerequisites.

Any optional local OCR/embedding/speech/media model runs on this same Ubuntu server and must fit its available CPU/RAM/GPU. Start with CPU-capable helpers or omit optional features when needed; do not introduce a hosted helper service or second GPU host by default. The owner may choose local Ollama inference later, but it is an explicit optional configuration, not the current primary route.

Run a local job scheduler for browser/tool capacity and a separate Cloud request queue. Increase concurrency only after observing account limits, latency and task success. Display “waiting for Cloud quota” separately from “waiting for browser/tool capacity.” Effective context and capability limits are measured on the hosted route, not inferred from local Ollama defaults.

### Required Pi/Ollama Cloud conformance tests

| Test | Passing behavior |
|---|---|
| Plain streaming | Text chunks arrive and a finalized message is persisted once. |
| Single tool round-trip | Tool name/arguments parse, correct result returns to the model, final answer reflects it. |
| Multiple tools | Ordering and IDs remain correct; supported parallelism does not lose or cross-wire results. |
| Partial tool arguments | A streamed/incomplete JSON fragment is never executed before validation. |
| Invalid/unknown tools | Reject with a structured error; do not guess a shell equivalent. |
| Error and denied tools | Preserve the denial/failure, stop retry loops, and let the model propose an authorized alternative. |
| Image input/results | Correct image reaches a vision-capable model; unsupported models are not silently asked to infer unseen content. |
| Structured data | Do not require unsupported Cloud schema-enforced generation; validate returned JSON locally, bound retries and reject malformed money/targets/actions. |
| Context pressure | Compaction/retrieval preserves the goal and exact outstanding side-effect state. |
| Cancellation/timeout | Stop local consumption, mark the run correctly and reject late tools; do not assume a cancelled connection refunds provider usage. |
| Worker/provider restart | Restore supported Pi state and reconcile outstanding operations before continuing. |
| Model change/retirement | Keep the API ID/observed version and compatibility visible; qualify alternatives and do not replay unsound provider-specific state. |
| Cloud route and secret handling | Only the local gateway possesses the long-lived key; inference reaches the approved Ollama endpoint and task-scoped context excludes protected secrets. |
| Quotas and outages | Exercise 429, provider failure, mid-stream error, retries and unavailable IDs without duplicating tools or protected effects. |
| Hosting boundary | Browser/search/vault/storage/queue/tools stay on Ubuntu; no managed helper appears as an unnoticed fallback. |
| Multilingual/real content | Evaluate actual owner task language, paths, documents and websites, not only English toy prompts. |

Log Pi/gateway versions, Cloud route/model ID, observed version/digest if exposed, tool loadout, request parameters, context use, latency and available usage. Record local hardware only for local tools; qualify again when hosted behavior or material components change.

### Ambition with measurable limits

Use a small, repeatable pilot suite first, then expand to at least 50 representative tasks covering code, browser work, operations, documents and long workflows. Repeat selected tasks to expose nondeterminism. Record completion rate, correct tool calls, unwanted side effects, owner interventions, end-to-end latency, tokens, compute and fees. Define a feature's acceptable intervention rate before enabling unattended use; purchasing and trust changes require zero unauthorized protected effects in the test suite, regardless of overall task success.

Smaller models benefit from short tool descriptions, a limited current tool set, explicit resource identity, structured observations, deterministic calculations and short verified steps. Build these improvements into the harness integration rather than substitute increasingly elaborate prompts for authority checks.

## V3.7 Browser, credential, and purchasing workflow designs

### Browser classes

| Class | Location and authority | Suitable work |
|---|---|---|
| Public/task browser | Agent's Ubuntu machine; root can inspect its state | Public research, task-owned app testing, downloads and low-value task identities explicitly delegated to the machine. |
| Protected account browser | Separate worker under control-plane/broker authority; no raw privileged connection in the guest | Owner accounts that need scoped actions, controlled credential use, reviewed external sends and sensitive tasks. |
| Local Chrome bridge | Mac companion with explicit session/tab consent; availability depends on the Mac and browser | Existing logins, local-only pages, owner-assisted authentication and workflows that cannot migrate to the server. |
| Human payment/authentication view | Trusted client or approved protected browser handoff | Final checkout, bank/MFA/passkey challenges and actions whose semantics cannot be safely enforced automatically. |

A remote browser frame displayed inside the Swift app is still the server's browser. A web page opened locally in WKWebView is a different session with different cookies and passkeys. Do not conflate them. A browser context/profile isolates identity state but is not automatically a hostile-code or OS-root security boundary.

### Local Chrome integration, in order of preference

1. **Official API/OAuth:** connect the service with scoped access; many tasks need no password migration.
2. **New protected server session:** the owner signs in via takeover, then grants a defined use. Best for an always-on agent that should not depend on a laptop.
3. **Consented Mac bridge:** attach to an approved existing Chrome session/tab using supported Chrome facilities or an extension/native companion; show live control and an immediate disconnect. Verify the actual installed Chrome version and its consent granularity. Do not claim a whole-browser debugging connection is tab-only unless the companion enforces that limit.
4. **Selected credential import:** the owner exports or selects credentials in the trusted client, reviews accounts, and imports selected entries into the protected broker. Source data never becomes a general task attachment.
5. **Selected cookie/session import:** optional best-effort portability for supported origins. Test account state, expiry, partitioning, storage and reauthentication individually; do not blindly copy a Chrome profile directory across operating systems.

Password export, cookie transfer, OAuth, passkey use and vault access are separate features. A passkey may be device-bound or use a supported credential-manager transfer flow; the product must detect the supported route rather than assume it can export arbitrary private keys. A bank or account provider may demand new-device verification even when cookies import successfully.

Use a self-hosted secret service on Ubuntu, such as [OpenBao](https://openbao.org/docs/), or a small protected encrypted store initially. The vault and credential broker must be local server components; hosted password-manager automation is not a runtime dependency. Any owner password-manager import is a selected, approved intake flow. A vault alone does not restrict use of retrieved plaintext; scoped brokered actions provide the relevant boundary.

### CAPTCHA and verification sequence

Observe challenge → classify → check the task's local-helper/handoff policy → attempt supported self-hosted assistance within a limit, or ask the owner → verify the intended page state → resume. Optional image reasoning follows the approved Ollama Cloud route; the solver code and browser remain on Ubuntu. If unsupported or declined, preserve state and report the block. No hosted CAPTCHA vendor, identity/proxy cycling or escalating spend is an automatic fallback.

### Payment sequence

1. Pi prepares the cart/order and an evidence-backed purchase proposal.
2. The protected broker retrieves or independently verifies merchant, account, final price and transaction details where the provider permits it.
3. Either native client displays the exact whole-workflow proposal, maximum total, recurrence, expiry and included steps, then obtains an authenticated owner decision. Local authentication protects a signing key/decision; the server verifies a signature over the exact operation, nonce and expiry rather than trust a client-provided `biometricPassed` flag.
4. The broker persists the workflow mandate, revalidates its scope before every side effect and reserves the approved budget transactionally and selects an allowed payment route: owner-completed checkout, supported delegated provider action, or a bounded instrument.
5. The owner completes required issuer/wallet authentication. The agent never asks to copy a payment PIN or recovery seed into its machine.
6. Execute once under the provider's supported idempotency semantics. If a browser or network timeout leaves the result unknown, query/reconcile first.
7. Changed merchant, items, identity, currency, allowed recurrence or amount above the approved limit require a renewed workflow authorization. Do not silently split charges or create another mandate.
8. Store provider/order IDs, invoice and status. Release or adjust the budget reservation from authoritative results and later settlement events.

For an unsupported merchant, prepare the order and give the owner a controlled final handoff. The payment proposal, mandate, budget ledger, credentials and broker all run on Ubuntu and are exposed to Pi through approved tools. The merchant, issuer/bank and payment rails are external transaction counterparties, not self-hosted components; a local broker cannot replace them. Tokens, virtual cards, AP2, UCP and browser checkout are distinct integrations.

## V3.8 Native UI and Ink/t3code adaptation

### Existing references inspected

The archive's Index lists eight desktop screens and six phone screens plus a design-system page. The Home, Code approval and mobile sessions screenshots were visually inspected, alongside the HTML/CSS and t3code's architecture/source-control/browser-import documentation. Preserve the quiet sidebar, centered conversation, adjacent work pane, dense tool rows and prominent “Needs you” signal. Improve cramped metadata and small screenshot-scale controls during native implementation; the static export is a reference, not an accessibility test pass.

### Primary product navigation

- **Tasks:** the normal entry point, grouped by projects/missions and status. Profiles are Chat, Cowork, Code, Browser and Operations presets; switching a preset does not move the underlying task to another product.
- **Needs you:** one inbox for approvals, authentication, browser takeover, missing information, payment confirmation and recoverable blockers.
- **Machine:** health, installed capabilities, active processes/services, files, resource queue, snapshots and recovery.
- **Automations:** scheduled work, monitors, explicit standing procedures and their authority.
- **Library:** artifacts, source dossiers, reusable procedures/templates and inspectable memory.
- **Settings:** accounts, models, devices, policy, privacy and optional integrations.

“Browse”, “Code” and “Manage the server” can appear as useful Home shortcuts. Normal users should not have to reason about SDKs, workers, RPC or container runtimes to start a task.

### Screen map

| Surface | Existing reference | v3 additions or adaptation |
|---|---|---|
| Home | D1 | Outcome composer, active tasks, suggested installed capabilities, real machine/model availability. |
| Task workbench | D2/D4/D5 | One conversation with contextual Changed files/Diff/Browser/Activity/Outputs/Preview surfaces and a visible plan. |
| Action approval | D3 | Exact authority, account/machine, changed content and reusable-rule scope; distinct browser/login/payment variants. |
| Model settings | D6 | Ollama Cloud account/route, hosted-processing disclosure, exact model ID/licence, qualification, usage/quota and provider health; optional local helper status is separate. |
| Machine/devices | D7 | Separate machine health, capabilities, processes/services, resource queue, snapshots and paired devices. |
| Connect | D8 | Trusted coordinator pairing, fingerprint and device key; do not pair directly to an unauthenticated Pi or browser port. |
| Phone inbox | M1 | Needs you split by action type, running tasks and recent work; concise metadata that does not wrap unpredictably. |
| Phone task | M2 | Continuity, plan, evidence, steering and artifact access. |
| Phone decision | M3 | Command/content/cart previews, local authentication when required and clear expiry. |
| Phone review | M4 | Readable diffs and selected document previews; no claim that mobile can replace a full IDE. |
| Lock screen | M5 | APNs alerts and optional Live Activity status with freshness; open the unlocked app to inspect/authorize sensitive actions. |
| Pair device | M6 | QR, coordinator identity, revocation and recovery. |
| Browser workbench | New | Live viewport, URL/account, observation state, takeover/return-control, downloads and failure diagnostics. |
| Capability centre | New | Search/install/update/uninstall packs, dependencies, permission changes, licences and health. |
| Account centre | New | Scoped identities, protected/delegated distinction, login handoff, local Chrome bridge and import review. |
| Approvals inbox | New | Pending decisions, expiry, decision history, active grants and revocation. |
| Automation editor | New | Trigger, next run, task, resources, authority, budget, quiet notification rules and dry run. |
| Spending/receipts | New | Purchase proposals, reservations, settled spend, recurring commitments, receipts and uncertain outcomes. |
| Memory/library | New | Search, source/date, edits/forget, artifact collections and reusable verified procedures. |
| Audit/recovery | New | Protected operation timeline, diagnostics bundle, snapshots, restore preview and emergency controls. |

### Swift implementation direction

Use shared `OutpostProtocol`, `OutpostSync`, `OutpostDomain` and `OutpostDesign` packages; macOS and iOS own their platform navigation and views. Native specialist text/diff and read-only activity views can bridge AppKit/UIKit. Do not add a user terminal emulator or generic remote-desktop view. Keep remote browser transport in a dedicated component with authenticated short-lived viewer tickets.

The token generator produces Swift assets and any viewer-only CSS from one design source. Follow the corrected v2 `text-3`, `danger`, `control-border` and disabled-token rules; do not import the archive's older CSS values as production truth. Use semantic controls, native focus/selection, screen-reader labels, reduced motion and platform-sized hit targets. Ink's visual restraint takes precedence over introducing a new accent colour or glass-heavy restyling.

Do not display hidden model reasoning as task progress. Show public plans, observed actions, tool status, evidence, waits and completion. Unavailable capabilities need a usable next action: install, connect account, request permission, wait for capacity or hand off.

## V3.9 Installable capability packs

These are proposed pack boundaries and candidate tools, not installed software or a completed licence/security audit. Prefer project-local installs and stable vendor/package sources; pin actual versions during implementation.

| Pack | Candidate contents | Authority and verification |
|---|---|---|
| Base machine | Git, ripgrep, shell/process tools, archive utilities, HTTPS tooling | Machine inventory and command smoke tests; no account authority implied. |
| JavaScript/web | Node, pnpm/npm, language server, test tools, Playwright | Project lockfile/build/test checks; browser observations on the running app. |
| Python/data | Python, uv, data/SQL/chart libraries, notebook tooling | Isolated environment and reproducible calculation checks. |
| Other languages | Owner-selected Rust/Go/Java/.NET/PHP/etc. SDKs and diagnostics | Install-on-demand; test an actual project, not only `--version`. |
| GitHub | `gh`, Git authentication helper, protected API adapter | Account/repo scopes, read/write split, PR/checks integration and token-expiry tests. |
| Browser | Chromium/Playwright, optional Steel or agent-browser adapter, viewer | Task/account isolation, takeover, downloads and crash recovery. |
| Documents | Docling or other parser, office/PDF generation and rendering utilities | Extraction quality, formulas/recalculation, rendered visual checks and licence inventory. |
| Server operations | Service/container tooling, health probes, typed privileged operations | Explicit machine scope, before/after state and restore rehearsal. |
| Cloud/hosting | Chosen vendor CLI/API adapters, infrastructure tooling | Owner account, cost limits, plan/apply separation and provider operation IDs. |
| Search/research | Self-hosted SearXNG/local search adapter and extraction/citation tools | Exposed to Pi; upstream-source limits, provenance and refresh checks; no managed search API backend. |
| Communications | Selected email/calendar/chat APIs or protocols | Read/draft/send scopes, recipient previews and retry reconciliation. |
| Accounts/secrets | Protected secret store, OAuth adapters, browser identity manager | Owner consent, per-origin/purpose access, revocation and no guest vault export. |
| Purchasing | Test merchant, approval/budget ledger, optional payment provider adapter | Separate payment authority, duplicate prevention and settlement reconciliation. |
| Speech/media | Local ASR, selected media conversion/inspection tools | File consent, processing quality, resource budget and no unapproved upload. |
| Browser session recovery | Browser checkpoint/identity lease and browser-only viewer/input adapter | Recover headless sessions without a Linux desktop; verify exclusive takeover and retained evidence. |
| Same-server workers | Local worker processes, containers and workspace VMs | Capability advertisement, per-worker identity, grants, resource quotas and owner visibility; no second backend machine required. |
| Inference gateway | Local credential/rate-limit adapter for Ollama Cloud | Pi provider access, protected key, allowed model IDs, context filtering, quotas and outage handling. |

A capability is “ready” only when software, account access, policy, hardware and its smoke test all pass. “Installed”, “connected” and “authorized for this task” are separate states.

## V3.10 Durable architecture and protocol additions

### Domain records to add to v2

| Record | Purpose and essential fields |
|---|---|
| `machines` | Persistent computer identity, OS, capability inventory, protected/delegated authority mode, health and last seen. |
| `tasks`, `runs`, `steps` | Goal, constraints, project/profile, machine, lifecycle, parent/dependencies, deadlines, verification and owner. |
| `pi_sessions`, `session_checkpoints` | Pi version/branch/session identity, Outpost run mapping, exported state hash and last reconciled event. |
| `operations`, `effect_outbox`, `effect_receipts` | Durable intent, parameters/hash, dispatch attempts, provider IDs, result, verification and unknown/uncertain outcome. |
| `capabilities`, `installations` | Manifests, versions/digests, permissions, dependencies, source, licence and health test. |
| `accounts`, `identities`, `credential_refs` | Provider/account identity, scopes, protected/delegated status, origin/profile and secret reference; no plaintext in the task database. |
| `grants`, `approval_requests`, `approval_decisions` | Issuer, resource/action constraints, policy version, expiry/revocation, canonical request hash and device-signed decision. |
| `browser_sessions`, `control_leases` | Task/identity, worker, current tabs, stream ticket, human/agent input ownership and lease expiry. |
| `processes`, `services`, `resource_leases` | Execution handle, PID/group identity, host, owner task, health, ports, log/artifact handles and quotas. |
| `automations`, `occurrences` | Trigger/time zone, task/authority template, next run, occurrence key, catch-up/concurrency policy and results. |
| `artifacts`, `sources`, `evidence` | Content identity, source URL/path, timestamps, type, retention, visibility and link to claims or verification. |
| `purchase_proposals`, `budget_reservations`, `orders` | Exact cart hash/currency/total, approval, instrument alias, provider operation/order ID and settlement state. |
| `memory_items`, `index_entries` | Scope/source/date, owner-approved versus inferred content, freshness, correction/supersession and deletion state. |
| `audit_events`, `snapshots` | Protected authority/effect history, machine restore points, backup identities and retention. |

Separate storage domains can implement these logical records. The table is a conceptual contract, not final SQL or a requirement to split every concern into a network service.

### Event and command requirements

- Keep session-level ordered events, plus a durable task/inbox feed cursor so reconnecting clients discover new approvals and tasks they were not already viewing.
- Add server-owned control-mode changes, reviewer classifications, workflow mandates, device-notification registration/delivery and agent-versus-owner identity events.
- Add task/run/step lifecycle, capability install/health, machine/process/service, identity/grant, browser takeover, automation occurrence, purchase and reconciliation events.
- Preserve ephemeral text/progress/video separately from durable facts; bounded backpressure drops transient updates first, then disconnects for cursor recovery rather than lose committed events.
- Persist command acceptance and effect intent atomically. Acknowledgement means accepted, not completed. Emit and render completed/verified separately.
- Use a supported Pi session manager/export/import path. Pi's files and the Outpost ledger are not one atomic database transaction; recovery must reconcile the mapping and last finalized messages instead of claiming dual writes are atomic.
- The protected executor records an approved operation before dispatch. Browser clicks, sends, installs and purchases with uncertain results require operation-specific reconciliation. Never claim universal exactly-once execution over arbitrary external systems.
- Bind device signatures to challenge, request hash, action and expiry; negotiate protocol versions/capabilities and reject stale or revoked device authority.
- Broker identity and machine identity are separate. A Pi worker token may request a proposal; it cannot impersonate an owner decision or mint a broader grant.
- When ordinary guest root is unrestricted, do not trust guest-only logs/health as proof of sensitive external outcomes. Use broker/provider evidence for those claims.

### Full root and return to restricted operation

An unrestricted root session can install persistence or change local policy. Ending its nominal lease does not prove root access or installed backdoors have disappeared. To regain a stronger machine-level restriction, restore/reprovision a known-good guest from the protected supervisor, or explicitly accept the machine as a trusted cooperative environment. Preserve selected data after inspection. External account limits, payment mandates, owner signing keys and protected audit remain outside guest root throughout.

## V3.11 Delivery roadmap and milestone gates

This is a feature programme with independently reviewable slices, not one implementation ticket. Build the smallest complete operator path first, then expand its capability catalogue. The original calendar is historical: estimate implementation only after the model, browser, native client and root-boundary spikes produce measurements.

| Gate | Deliverable | Feature families advanced | Exit test |
|---|---|---|---|
| **G0 — Prove the foundation** | Pin Pi/gateway, qualify Ollama Cloud, inventory Ubuntu, prove same-server host/guest authority and prototype native/browser control | MODEL, TRUST, REL, WEB, SYS, MAC | Pi completes tools through the Cloud route; all tools/brokers remain on Ubuntu; guest root cannot mint owner approvals or read the host's test secret; Swift replays a task. |
| **G1 — Persistent native operator** | Control plane, task ledger/outbox, Pi worker, workspace files, basic shell, Mac workbench and minimal Swift iPhone continuity | TASK, FS, RUN, MODEL, MAC, PHONE, REL | Start work on Mac, close it, continue on iPhone, kill/restart Pi and coordinator, and reconcile one transcript and correct operation state. |
| **G2 — A usable desk** | Public browser with live viewer and takeover, uploads/downloads, task artifact previews, process inventory | WEB, CAP, FS, RES, RUN | Research a question in a real browser, download and transform a file, let the owner take over, and produce verified artifacts across a browser restart. |
| **G3 — Real coding and machine work** | Git/gh, project worktrees, diagnostics/tests/diffs, capability installation, scoped sudo and service operations | DEV, GIT, PKG, SYS, OPS, EXT | Fix a real repository issue, install a missing tool under a bounded grant, run the app/tests, approve a machine change from phone, and recover the guest in a rehearsal. |
| **G4 — Protected identities and rich phone control** | Account broker, protected browser, selected fresh logins, phone approval inbox and takeover, grant revocation | ID, TRUST, PHONE, WEB, CAP | Retrieve an invoice from an authorized account, resolve a login/challenge on phone, approve an exact external mutation, then revoke the account and demonstrate further protected use fails. |
| **G5 — Knowledge work and reliable delegation** | Document/data packs, source-backed research, first email/calendar adapters, schedules and monitoring, inspectable memory | DOC, DATA, RES, COM, LIFE, AUTO, MEM | Produce a validated report from mixed sources, draft and approve one external send, and run a scheduled monitor without duplicate effects or routine notification noise. |
| **G6 — Controlled commerce** | Purchase proposals, authenticated native decisions, whole-workflow mandates on both clients, supported execution/handoff, receipts, budget ledger and one evaluated provider path | PAY, ID, TRUST, LIFE | Test changed-cart rejection, concurrent budgets, stale approval, post-charge timeout and settlement reconciliation; then complete one owner-authorized low-risk real purchase. |
| **G7 — Broader autonomy** | Specialists, capability registry, verified recipes, proactive missions, more integrations, voice/media and additional headless browser adapters | TEAM, EXT, AUTO, MEDIA, WEB | Complete a multi-day mixed-medium task under bounded authority, recover a failed worker, and deliver independently checked outputs within budget. |
| **G8 — Hardened single-server release** | Same-server worker isolation/scaling, operational runbooks, offline backup/export, recovery and distribution | TEAM, DEV, REL, SYS, MAC, PHONE | Restore the self-hosted stack onto a replacement Ubuntu server, revoke a lost client, pair cleanly, rehearse upgrades and rerun the pilot suite against Ollama Cloud. |

The capability order can change when actual owner tasks reveal value, but durable recovery, exact authority binding and open-model qualification do not become optional shortcuts. Every pilot gate must demonstrate a coding task, a browser/personal task and a server-administration task through the same durable path. Depth grows across the three pillars together; no coding-only launch. Browser and phone prototypes start early because login/handoff latency is a product risk, not finishing polish.

### Mandatory owner-decision integration work

Before a pilot, implement and demonstrate: server-owned three-mode policy plus reviewer fail-to-ask; headless-browser-only viewer/takeover; agent-versus-owner identity selection; equal Mac/iPhone task/history/decision projections; direct APNs plus inbox recovery; whole-payment-workflow authorization on either client; and one end-to-end task from each of coding, browser/personal work and server operations. These requirements are specified in `spec/` and supersede older narrower milestone wording.

### First implementation backlog after the research plan

Dependency abbreviations in this table refer to the corresponding `V3-` ticket, not the historical v2 backlog.

| ID | Task | Dependencies | Reviewable result |
|---|---|---|---|
| V3-P0-01 | Inspect Ubuntu capacity/network/virtualization and confirm Ollama Cloud access | Server/account targets selected | Execution capacity, same-server host/guest options, Cloud account/model/quota availability; no local inference GPU prerequisite. |
| V3-P0-02 | Pin Pi SDK, define worker boundary and record versions | None | A short ADR, package licence/version record and an adapter contract. |
| V3-P0-03 | Run Pi/Ollama Cloud transport and tool conformance | P0-01, P0-02 | Captured route/model ID, tool/stream/quota/secret-handling results; compatible adapter versus native extension decision. |
| V3-P0-04 | Benchmark available Cloud main and vision models | P0-03 | Task success, latency, usage/limits and intervention results; local tool resource use recorded separately. |
| V3-P0-05 | Prototype Playwright/Chromium and self-hosted Steel | None | Comparison of downloads, profile behavior, concurrency, resource use, takeover and recovery; explicitly separate hosted-only features. |
| V3-P0-06 | Prototype Swift event/replay and specialist panes | Schema draft | Mac/iPhone minimal clients with a streamed task, tool row, replay and a native approval interaction. |
| V3-P0-07 | Prove same-server host/guest authority and capability exposure | P0-01 | Guest root cannot access host-held key/test secret; signed exact approval, host audit and usable Pi tools to every permitted capability. |
| V3-P0-08 | Write superseding ADRs and revise estimates | P0-03 through P0-07 | Settled process topology, storage mapping, browser worker, model choice and a measured next-slice estimate. |
| V3-P1-01 | Task/operation schema and versioned Swift/TS contracts | P0-08 | Generated contracts and shared fixtures for task, operation, approval and transcript state. |
| V3-P1-02 | Ledger, outbox and recovery | P1-01 | Persisted accepted intent, dispatch receipt, uncertainty state and deterministic restart tests. |
| V3-P1-03 | Pi worker integration | P1-01, P0-03 | Session manager mapping, tools, compaction, steering, cancellation, finalization and crash recovery. |
| V3-P1-04 | Device pairing and approval path | P0-07, P1-02 | Revocable devices, challenge/signature checks and first-valid exact approvals. |
| V3-P1-05 | Workspace/file/process service | P1-02 | Persistent files, artifact handles, shell supervision, output limits and checkpoints. |
| V3-P1-06 | Native Mac workbench | P0-06, P1-01 | Ink shell, task list, composer, plan/progress and files/output panes. |
| V3-P1-07 | Minimal iPhone client | P1-04, P1-01 | Task continuity, approval inbox, reconnect and clear offline state. |
| V3-P1-08 | G1 continuity/chaos recording | P1-02 through P1-07 | Recorded acceptance demo and test results, including uncertainty reconciliation rather than blind action replay. |

These are planning tickets only. Server access, production credentials, payment providers and Apple signing/distribution choices have not been exercised in this research task.

### Cut or defer, without shrinking the final vision

If a milestone slips, defer secondary self-hosted browser implementations, extra messaging channels, automatic credential migration, local Live Activities, specialist parallelism or automatic payments. Multi-server fleets and Linux GUI desktops are outside scope. Direct APNs delivery belongs in the synchronized-client baseline. Preserve Pi's browser/shell/file access, takeover, Cloud model qualification, operation recovery and approvals. Owner-completed checkout and fresh server login remain useful while more advanced automation matures.

## V3.12 Scenario-based acceptance suite

These are product acceptance scenarios, not claims of successful experiments. Each is implemented first on fixtures/test accounts, then rehearsed on authorized real resources.

| Scenario | Tools and work | Owner intervention | Completion evidence |
|---|---|---|---|
| 1. Fix a bug while the Mac sleeps | Repo inspection, Pi edits, tests, browser verification, Git/gh | Approve applicable push/PR/deploy step | Reproduced failure, passing checks, diff, PR/branch link and actual CI state. |
| 2. Rebuild a missing development environment | Detect missing runtimes, install a pack, restore dependencies | One bounded installation/admin grant | Inventory changes and a working project build. |
| 3. Investigate a broken server application | Logs, process/port health, code/config diagnosis | Approve production restart/change | Before/after health and rollback reference. |
| 4. Research and write a recommendation | Search, pages, PDFs, comparisons and source validation | Clarification only when a missing constraint changes the outcome | Cited report, evidence folder and explicit unresolved claims. |
| 5. Download a private invoice | Protected browser/account, login handoff, PDF download | Approve account use; complete MFA if needed | Correct account/month invoice, source and no credential leakage. |
| 6. Create a spreadsheet and board report | CSV/PDF intake, calculations, DOCX/XLSX, rendering | Approve external delivery only if requested | Reconciled totals, usable files and inspected previews. |
| 7. Review and respond to a PR | gh/API, checkout, semantic inspection and tests | Approve submitted review/comment under policy | Findings tied to code, test evidence and provider review ID. |
| 8. Monitor a service and repair a known fault | Health trigger and an approved restart procedure | Approve initial recurring procedure, escalate novel remediation | Trigger evidence, bounded execution, verified recovery and concise notification. |
| 9. Use an existing local Chrome account | Consented bridge and selected local page | Native Chrome/Outpost consent and any account step-up | Verified result, visible machine/account, clean disconnect and no claimed server independence. |
| 10. Transfer selected credentials | Trusted client import preview, encrypted broker intake | Approve exact accounts and destinations | Import receipt and source-temp cleanup report, without secrets in task history. |
| 11. Encounter a CAPTCHA | Detect, optional local helper/approved Ollama vision, takeover | Resolve the challenge when local assistance cannot | Intended page verified; no hosted solver dependency and unsupported cases remain blocked. |
| 12. Prepare and buy an item | Research, cart, purchase proposal, trusted checkout | Exact authenticated purchase decision and issuer step-up | One order, receipt, correct total/currency and no duplicate after retry. |
| 13. Cancel a subscription | Protected account, terms/status inspection and cancellation flow | Approve exact subscription/cancellation effect | Provider confirmation and renewal/benefit-end status, not only a clicked button. |
| 14. Schedule and send a report | Data refresh, artifact build, scoped send | Approve schedule and bounded destination/content procedure | Correct occurrence, one verified send and file version. |
| 15. Process a voice request | Speech transcription, task execution and artifact creation | Resolve ambiguous sensitive instruction before action | Transcript, resulting deliverable and explicit approval record. |
| 16. Exercise all three control modes | Full control, smaller Auto reviewer, per-action Ask permission | Owner selects/changes mode; workflow authorization remains explicit | Same allowed tool succeeds under Full control, is reviewed under Auto, and waits before every step under Ask permission; reviewer failure asks and queued work rechecks a tightened policy. |
| 17. Complete a long mixed task | Research, code/data worker, browser and documents | Only missing authority or material decisions | Dependency-complete task graph, artifacts and independent checks. |
| 18. Recover from a full disk or broken guest | External supervisor, snapshots, restore/reprovision | Approve destructive replacement/data selection | Healthy replacement, restored files and revalidated grants. |
| 19. Lose a phone | Device revocation, session/token checks | Authenticate on remaining trusted device/recovery route | Lost device cannot approve, reconnect or access protected cached/server data beyond documented local-cache limits. |
| 20. Malicious page tries to spend or elevate | Untrusted text, protected broker and policy | No action granted by the page | No protected effect, recorded rejection, legitimate task remains resumable. |
| 21. Network drops after a charge/send/deploy | Durable operation receipt and provider reconciliation | Inspect only if authoritative result cannot be recovered | Outcome known or explicitly uncertain; no blind duplicate execution. |
| 22. Update Pi/model/browser | Staged version changes and benchmark suite | Approve trust/permission changes | Compatibility report, known-good rollback and no silent capability regression. |

Additionally, G0/G8 exercise a **hosting-boundary check**: enumerate running services and outbound destinations; demonstrate that Pi can discover/call all permitted local capabilities, that inference reaches only the approved Ollama Cloud route, and that no hosted browser/search/vault/scheduler/solver/vector/logging/relay service was introduced. External task counterparties are identified separately. This is a cross-cutting check, not another capability catalogue entry.

### Cross-cutting release checks

- **Sync:** shared Swift/server golden fixtures; reconnect mid-stream, duplicate events, slow consumers, multiple devices, clock skew and inbox catch-up.
- **Pi state:** finalized messages, queued steering, session branch/compaction, restored tool result IDs, and task/operation mapping across crashes.
- **Privilege:** root guest, package/install scripts, nested tools, direct network attempts, trusted-code updates and external grant expiry/revocation.
- **Sensitive data:** secret text and structured payloads, screenshots, browser traces, errors, file outputs, exports, local caches and diagnostic bundles.
- **Payments/sends:** wrong account/target/currency, changed cart/content, concurrent budget use, repeat taps, stale signatures, late settlement and uncertain outcomes.
- **Browser:** identity isolation, profile locks, input ownership, upload/download checksums, dialogs/frames, login/challenge and worker restart.
- **Native clients:** dark/light, grayscale states, VoiceOver, keyboard/focus, text scaling, touch targets, long content, narrow windows, disconnected and degraded states.
- **Operations:** model/browser saturation, full disk, ledger backup/restore, broken guest recovery, migrations, lost device and an unavailable coordinator.

No claim of a general-purpose autonomous operator is accepted from a single impressive demo. Retain failure cases and intervention counts in a versioned evaluation report.

## V3.13 Decisions and remaining uncertainty

### Fixed by the owner

- Swift Mac/iPhone clients sharing authoritative server history and the same domain capabilities.
- Ubuntu Server only: browser viewing/takeover and returned evidence/artifacts, with no Linux desktop or user terminal.
- Apple push notifications via APNs, sent by the self-hosted notifier.
- Agent-owned identities by default; explicitly scoped owner accounts also supported.
- One whole-payment-workflow approval, valid for its bounded included steps.
- Pi as the agent harness.
- Ollama Cloud models as the primary inference path, preserving the open-model requirement.
- A dedicated persistent Ubuntu machine is the agent's workspace.
- Apart from Ollama Cloud inference and approved Apple push transport, Outpost infrastructure is self-hosted on that same Ubuntu server and its work capabilities are exposed to Pi. External sites/accounts/payment rails are authorized task targets, not outsourced backend services.
- An equally capable first-release mix of coding, browsing/personal work and server management; tools remain installable/pluggable.
- Sudo capability governed by Full control, Auto (smaller reviewer model), or Ask permission (every work action).
- CAPTCHA assistance, payment methods and explicit approval for sensitive local Chrome/credential integration belong in the feature scope.
- Ink is the visual reference; t3code, OpenCode, Pi and OpenClaw are important workflow/capability references, not limits on ambition.

### Recommended by this research, subject to implementation evidence

- TypeScript/Node around Pi, with Python/specialist subprocesses as needed and Swift shared packages for clients.
- Protected host-side control/approval/account authority with a root-capable Ubuntu workspace VM on the same physical server; no extra control-plane machine.
- Playwright/Chromium with an evaluated Steel or agent-browser adapter as the initial browser path; Pi retains the main planning loop.
- Fresh protected server login and official API/OAuth before automated password/session migration.
- Whole-payment-workflow approval followed by supported execution, with issuer-authentication/unsupported-checkout handoff where required.
- Worktree/task isolation, deterministic checks, capability manifests and staged updates.

### Inputs needed before implementation choices become final

1. The actual Ubuntu server's CPU/RAM/disk, virtualization and reachable networking for execution/tool workloads; a main-model GPU is not required.
2. The same-server host/guest boundary for protected coordinator/brokers versus agent sudo. If all services share unrestricted host root, record the weaker enforcement honestly.
3. The Ollama Cloud account/limits and exact hosted operator/vision IDs that pass the Pi benchmark; provider-hidden runtime details are not assumed.
4. The first real accounts/sites/projects to qualify, and which identities the owner is willing to delegate to machine root versus keep protected.
5. A payment route the owner is actually eligible to use, with supported instrument controls and merchant flow; no provider has been activated or endorsed as universally available.
6. Mac/iPhone minimum OS and distribution/signing choices. Apple push transport is explicitly approved; qualify entitlements, device token lifecycle and direct server sending for the chosen distribution.
7. Open-source versus private product distribution, which affects review of optional AGPL/SSPL/commercial components. Browserless's inspected repository identifies **SSPL-1.0 or commercial licensing**; it must not be labelled a permissive open-source default.

These are follow-on implementation inputs, not blockers to the feature research. The plan deliberately avoids promising unlimited website access, universal CAPTCHA success, exportable passkeys, portable browser login, arbitrary merchant payment APIs, or frontier-model reliability on unspecified hardware.

### Research completion status

The v3 feature expansion is a research-backed product plan with **270 feature entries in 27 areas**, a revised architecture, native screen map, capability packs, model conformance criteria, a gate-based roadmap, an initial backlog and **22 end-to-end acceptance scenarios**. The latest revision makes Ollama Cloud the primary inference path and self-hosts all remaining Outpost infrastructure on the single Ubuntu server, with the explicit Apple push transport exception, with capabilities exposed to Pi. The original v2 text is retained below for traceability; v3 supersedes every conflicting choice or estimate.

Sources were checked through current primary documentation and the pinned local reference repositories. No dependency was installed, application built, model benchmark executed, server modified, account migrated, browser session attached, payment made or CAPTCHA solved as part of this planning work. Those experiments belong to the specified gates. The 9:05 pm continuation verified this completion status and removed the one-time automation.

## V3.14 Primary source index

This index groups the supporting sources already used above. Technical recommendations are Outpost proposals inferred from those capabilities; upstream documentation is not evidence that an Outpost integration has passed tests.

| Area | Primary sources |
|---|---|
| Pi integration | [Repository](https://github.com/earendil-works/pi), [SDK](https://pi.dev/docs/latest/sdk), [extensions](https://pi.dev/docs/latest/extensions), [model endpoints](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), [security boundary](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md). |
| Ollama | [Cloud](https://docs.ollama.com/cloud), [authentication](https://docs.ollama.com/api/authentication), [Cloud catalogue](https://ollama.com/search?c=cloud), [API errors](https://docs.ollama.com/api/errors), [tools](https://docs.ollama.com/capabilities/tool-calling), [vision](https://docs.ollama.com/capabilities/vision), [structured-output Cloud limitation](https://docs.ollama.com/capabilities/structured-outputs), [API compatibility](https://docs.ollama.com/openai). Local-only/context guidance is optional-local reference, not the deployment default. |
| Earlier local model cards | [Qwen coding card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/main/README.md), [Qwen vision card](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/raw/main/README.md). Retained research references, not a claim of Cloud availability or current defaults. |
| OpenCode | [Permissions](https://opencode.ai/docs/permissions/), [agents](https://opencode.ai/docs/agents/), [plugins](https://opencode.ai/docs/plugins/), [LSP](https://opencode.ai/docs/lsp/), [headless server](https://opencode.ai/docs/server/). |
| OpenClaw | [Browser](https://docs.openclaw.ai/tools/browser), [Chrome integration](https://docs.openclaw.ai/tools/chrome-extension), [approvals](https://docs.openclaw.ai/tools/exec-approvals), [elevated execution](https://docs.openclaw.ai/tools/elevated), [memory](https://docs.openclaw.ai/concepts/memory), [scheduled work](https://docs.openclaw.ai/automation/cron-jobs), [subagents](https://docs.openclaw.ai/tools/subagents), [nodes](https://docs.openclaw.ai/nodes), [Ollama](https://docs.openclaw.ai/providers/ollama). Local reference commit is recorded in V3.2. |
| t3code at inspected revision | [Architecture](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/internals/overview.md), [source control](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/source-control.md), [browser import](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/browser-import.md), [keybindings/queue and steering](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/keybindings.md). Relevant local sidebar, terminal drawer and mobile composer components were also inspected. |
| Browser infrastructure | [Steel Browser](https://github.com/steel-dev/steel-browser), [Steel MCP/self-hosted differences](https://github.com/steel-dev/steel-mcp-server), [Steel CAPTCHA API](https://docs.steel.dev/overview/captchas-api/overview), [Playwright auth](https://playwright.dev/docs/auth), [agent-browser](https://github.com/vercel-labs/agent-browser), [Browser Use](https://github.com/browser-use/browser-use), [Skyvern](https://github.com/Skyvern-AI/skyvern), [Browserless licensing](https://github.com/browserless/browserless). |
| Chrome and credentials | [Current Chrome DevTools connection configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration), [debugging-port changes](https://developer.chrome.com/blog/remote-debugging-port), [password import/export](https://support.google.com/chrome/answer/13068232), [OpenBao](https://openbao.org/docs/), [1Password automation](https://developer.1password.com/docs/cli/secrets-scripts). |
| GitHub | [CLI manual](https://cli.github.com/manual/gh), [GitHub App token scope/lifetime](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). |
| Purchasing | [Stripe PaymentIntents](https://docs.stripe.com/api/payment_intents), [Issuing controls](https://docs.stripe.com/issuing/controls/spending-controls), [Issuing geography](https://docs.stripe.com/issuing/global), [idempotency](https://docs.stripe.com/api/idempotent_requests), [AP2](https://ap2-protocol.org/), [UCP FAQ](https://developers.google.com/merchant/ucp/faq). |
| Native components and networking | [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication), [ActivityKit](https://developer.apple.com/documentation/activitykit), [remote ActivityKit/APNs transport](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications), [self-hosted WireGuard endpoint](https://www.wireguard.com/quickstart/). APNs transport is owner-approved; the notification sender remains on Ubuntu. |
| Other capability candidates | [SearXNG](https://docs.searxng.org/), [Docling](https://github.com/docling-project/docling), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [noVNC](https://github.com/novnc/noVNC), [Gmail API](https://developers.google.com/workspace/gmail/api/guides), [Calendar API](https://developers.google.com/workspace/calendar/api/guides/overview), [MCP specification](https://modelcontextprotocol.io/specification/latest). |

## v2 baseline — September 25, 2026

**Historical reference.** The v3 sections above supersede conflicting platform, harness, inference, isolation, history-format, feature-scope and delivery-calendar assumptions below. Retaining this text preserves the original research, Ink specification and design handoff without presenting them as current implementation status.

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
