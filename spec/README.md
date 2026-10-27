# Outpost specifications

Implementation documentation for the owner-approved product as of **27 October 2026**. These specifications expand [outpost-plan.md](../outpost-plan.md); they do not claim working backend features. The existing [SwiftUI mock](../mock/README.md) is an in-memory visual prototype.

## Read in this order

1. [System architecture and settled product decisions](00-system-architecture.md).
2. [Protocol, server data and cross-module contracts](28-protocol-and-data-contracts.md).
3. The feature modules below for the work being built.
4. [Balanced delivery gates and acceptance](29-delivery-and-acceptance.md).
5. [Remaining implementation decisions and source register](30-decisions-and-sources.md).

## Fixed product direction

- Equally capable coding, browser/personal work and server operations.
- Pi harness and installed/pluggable tools on one persistent Ubuntu Server; no Linux desktop or user terminal console.
- Ollama Cloud open models for operator, smaller Auto reviewer and vision; all execution/state/adapters are self-hosted.
- Exactly three control modes: Full control, Auto and Ask permission. The owner selects the mode; the smaller reviewer in Auto cannot change it.
- Owner approval binds an entire bounded payment workflow, available on either native client.
- Equal Swift Mac/iPhone clients project the same server-owned history, tasks, files, settings and decisions; disconnected views show freshness.
- Direct server-to-Apple APNs is the approved external push transport exception; no hosted Outpost relay.
- Dedicated agent accounts by default, with explicitly scoped owner identities also available.
- Ink colour palette and refined native interaction language remain the visual direction.

## Feature modules

| Module | Role | Feature ownership |
|---|---|---|
| [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md) | Turn an owner’s outcome into durable, steerable work across coding, web/personal work and server operations. Pi supplies the agent loop; Outpost owns product lifecycle and recovery. | TASK-01–10 |
| [02 Server files and artifacts](02-filesystem-and-artifacts.md) | Give the agent a persistent filesystem while giving the owner task-linked evidence and deliverables rather than a general server file console. | FS-01–10 |
| [03 Agent commands and processes](03-commands-and-processes.md) | Let Pi use Ubuntu Server as a real work computer through shell commands, process control and installed headless applications. | RUN-01–10 |
| [04 Sudo and machine administration](04-sudo-and-machine-administration.md) | Allow meaningful administration of the dedicated Ubuntu Server without handing the worker ownership of its own approval keys or authoritative audit. | SYS-01–10 |
| [05 Software and capability installation](05-software-and-capability-installation.md) | Make capabilities installable on the server as new tasks demand, instead of fixing the agent’s tool inventory forever. | PKG-01–10 |
| [06 Headless browser and live takeover](06-headless-browser.md) | Provide real web work from a headless browser on Ubuntu Server, with browser-only viewing and human assistance on either client. | WEB-01–10 |
| [07 Agent and owner identities](07-identities-and-credentials.md) | Give the operator its own accounts by default and carefully scoped access to the owner’s accounts when a task requires them. | ID-01–10 |
| [08 Verification challenges and human assistance](08-verification-and-human-assistance.md) | Keep browser tasks resumable when a CAPTCHA, MFA step, user-presence requirement or ambiguous page needs the owner. | CAP-01–10 |
| [09 Coding and software engineering](09-coding-and-review.md) | Deliver investigated, tested and reviewable software changes as one of three equally important product pillars. | DEV-01–10 |
| [10 Git hosting and delivery](10-github-and-delivery.md) | Use GitHub CLI and equivalent provider adapters from the server for issue-to-PR work and accountable software delivery. | GIT-01–10 |
| [11 Server operations and deployments](11-server-operations-and-deployment.md) | Diagnose and manage real services and deployments as a first-class product pillar, using the same task, policy and evidence paths as coding and browsing. | OPS-01–10 |
| [12 Research and source collection](12-research-and-sources.md) | Research questions on the open web, compare evidence and return inspectable conclusions rather than opaque summaries. | RES-01–10 |
| [13 Documents and deliverables](13-documents-and-deliverables.md) | Produce useful spreadsheets, PDFs, documents and presentations on Ubuntu, with rendered/checked outputs shared through the server. | DOC-01–10 |
| [14 Data analysis and databases](14-data-and-databases.md) | Inspect, transform, reconcile and explain structured data with reproducible computations, including approved database work. | DATA-01–10 |
| [15 Communication and calendar](15-communication-and-calendar.md) | Use installed account adapters for mail, calendar, messages and collaborative systems, with agent-owned identities as the normal sender. | COM-01–10 |
| [16 Personal workflows and errands](16-personal-workflows.md) | Coordinate useful multi-step personal work across websites, files, communications and recurring responsibilities. | LIFE-01–10 |
| [17 Payment workflows and purchases](17-payments-and-purchases.md) | Authorize and carry out an entire bounded payment workflow, including checkout, required authentication handoff, result reconciliation and receipt collection. | PAY-01–10 |
| [18 Scheduling and monitoring](18-schedules-and-monitoring.md) | Keep useful work running on the owner’s server while both clients are closed, and notify only when there is meaningful progress, completion, failure or a decision. | AUTO-01–10 |
| [19 Memory and retrieval](19-memory-and-retrieval.md) | Preserve useful context and preferences across tasks while keeping permissions separate from remembered facts. | MEM-01–10 |
| [20 Specialist workers and coordination](20-specialist-workers.md) | Let a broad task delegate bounded research, code review, data or browser work without losing ownership, policy or resource control. | TEAM-01–10 |
| [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md) | Expose every useful installed capability to Pi through a consistent local adapter/tool surface while keeping integrations pluggable. | EXT-01–10 |
| [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md) | Supply qualified open-model inference for the main Pi operator, an independent smaller Auto reviewer and vision; retain local execution and indexing helpers. | MODEL-01–10 |
| [23 Speech, images and media](23-speech-images-and-media.md) | Process voice notes, images, audio/video and visual evidence using installed tools on the Ubuntu Server, with qualified Cloud vision where needed. | MEDIA-01–10 |
| [24 Swift macOS client](24-swift-macos-client.md) | Provide a calm native Mac window onto the server-owned operator, sharing capabilities and domain state with iPhone. | MAC-01–10 |
| [25 iPhone, shared sync and Apple notifications](25-iphone-sync-and-notifications.md) | Provide an equal native iPhone client and direct server-to-APNs notifications, keeping every authoritative conversation/task/decision on Ubuntu. | PHONE-01–10 |
| [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md) | Make the owner’s three autonomy choices real server-side execution policy, with explicit identity, payment and trust boundaries. | TRUST-01–10 |
| [27 Reliability, backups and resources](27-reliability-backups-and-resources.md) | Keep the single-server operator recoverable and honest through process crashes, network failure, model outages, resource pressure and lost client devices. | REL-01–10 |

All **270 feature IDs across 27 areas** have exactly one owning module. Cross-module dependencies do not create duplicate ownership. Use the [complete feature map](feature-map.md) to find any feature by ID.

## Using these specifications

Each module explains its product role, owner experience, boundaries/dependencies, ten feature requirements, build approach, records/tool/events, control-mode behavior, recovery, acceptance and primary sources. Record implementation changes against stable feature IDs and acceptance evidence. Do not label a module complete from an installed package, a model demo or a mock screen.

Outpost endpoints/table/tool names are proposed contracts. Pin and probe actual upstream Pi/model/browser APIs before writing adapters; current documentation and the older local reference snapshots may differ. Unknown credentials, model IDs, server capacity, payment eligibility and distribution choices remain implementation inputs, not promises.
