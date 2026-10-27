# Implementation decisions and source register

Status: 27 October 2026. Product choices below are settled by the owner; technical selections still need integration evidence. The specifications are authored Outpost design, not an assertion that a referenced project implements them.

## Decisions already made

Do not reopen Swift Mac/iPhone clients, server-owned shared history, Pi, Ollama Cloud open models, Ubuntu Server without a Linux desktop, the three modes, a smaller Auto reviewer, whole-payment-workflow approval, APNs transport, or agent-first accounts merely because a tool/library example uses another stack.

The [latest owner decisions in the plan](../outpost-plan.md) and [architecture](00-system-architecture.md) override conflicting historical v2 sections and older design exports. All 270 current feature IDs are mapped in [feature-map.md](feature-map.md).

## Remaining implementation inputs

| Decision | Why it matters | Evidence/owner input needed |
|---|---|---|
| Actual server and connectivity | CPU/RAM/storage, virtualization, Linux version, network reachability and isolated worker capacity determine deployment. | Inventory and owner-authorized setup probe. A GPU is not a prerequisite for Cloud inference. |
| Same-server enforcement topology | Protected host services versus root-capable guest governs which restrictions are enforceable. | Virtualization/network/broker tests; explicitly label cooperative host-root deployment if selected. |
| Production default/override policy | The owner chose three modes, but not the initial default or exact workspace/task inheritance. | Owner chooses default and override visibility after a reviewable prototype; mock initial state is illustrative. |
| Cloud operator/reviewer/vision IDs | Account inventory, capability, licence, latency, quota and availability change. | Pinned role qualification on actual account; reviewer failure tests and dangerous false-allow evaluation. |
| Auto launch threshold | A smaller model is not automatically a reliable safety judge. | Held-out action set across coding, browser/personal and operations; explicit acceptable false-allow/prompt behavior before release. |
| Browser viewer/input transport | It must work with a genuinely headless browser on Ubuntu Server without a desktop dependency. | Latency/bandwidth/input-lease prototype on Mac and iPhone; compare direct Playwright versus self-hosted Steel adapter. |
| Dedicated agent accounts | Owner plans to create them; exact providers and scopes are not known yet. | Owner-created fixture/pilot accounts; identify which owner accounts are also delegated and how they are protected. |
| Eligible payment route | Merchant/issuer/provider support and owner eligibility vary. | Supported sandbox flow first; explicit instrument/account and real transaction scope before a pilot purchase. |
| OS versions and distribution | Affects Swift/native APIs, Keychain/authentication, entitlements, signing and APNs environment/topic. | Owner distribution choice and real Mac/iPhone builds. |
| Retention, backups and offline copies | Server-owned history/artifacts may be sensitive; one server is one physical failure domain. | Owner retention preferences, export destination and actual replacement-server restore evidence. |
| Packaging/licensing | Some optional browser/database tools may require a different license/distribution choice. | Pin dependency versions and review actual licenses; do not assume every candidate is permissive open source. |

These are implementation choices and qualification work, not missing feature specifications or reasons to pause the documentation task.

## Source provenance and verification

The parent plan records primary research and local reference snapshots. This specification pass additionally reopened Pi SDK/extensions, Ollama Cloud, Playwright BrowserContext and Steel Browser primary pages. These verified entry points confirm integration context; they do not qualify Outpost, select a release version, prove a safe reviewer or establish managed-cloud parity for self-hosted software.

Apple notification documentation URLs were opened; the web reader exposed JavaScript-only landing pages and Markdown links. Treat the official pages as implementation references and validate concrete sender/token/authentication behavior on the actual Apple documentation and signing environment during implementation. No APNs key, entitlement, token or live delivery has been provisioned here.

A reachability check covered 78 unique external documentation URLs. Two stale paths (Ubuntu package management and Pi custom providers) returned 404 and were replaced with working primary documentation paths. Reachability is not a full API/content review. The remaining links are primary documentation candidates or local references carried into module implementation guidance; they were not all independently content-reviewed in this pass. A link is not a promise that the owner’s platform/account/version supports every feature. Resolve redirects, pin versions, inspect licenses and run relevant conformance tests before dependency adoption.

The local repositories inspected in the parent research are snapshots: Pi `6374c2baf432419ccb4541a99ce4958ecd03dae0`, OpenClaw `12c7926d2502b621f30297ac4f176aa5b6fa2fb8`, t3code `cfafb4bb54d244e4612f5681aad3832ea64cb0fb`. Current upstream documentation may describe later APIs. Use an explicit supported-version matrix rather than mix a current code example with an older pinned runtime.

## Primary reference index

| Reference | Used by | Verification in this pass |
|---|---|---|
| [Pi SDK](https://pi.dev/docs/latest/sdk) | 01, 20, 21 | Primary page reopened |
| [Pi RPC reference](https://pi.dev/docs/latest/rpc) | 01 | Official reference; qualify at dependency pinning |
| [Pi local SDK reference](../../pi/packages/coding-agent/docs/sdk.md) | 01 | Local reference |
| [Linux filesystem hierarchy](https://refspecs.linuxfoundation.org/FHS_3.0/fhs/index.html) | 02 | Official reference; qualify at dependency pinning |
| [Python pathlib](https://docs.python.org/3/library/pathlib.html) | 02 | Official reference; qualify at dependency pinning |
| [Pi tools and extensions](https://pi.dev/docs/latest/extensions) | 02, 20, 21 | Primary page reopened |
| [Node child_process](https://nodejs.org/api/child_process.html) | 03 | Official reference; qualify at dependency pinning |
| [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html) | 03 | Official reference; qualify at dependency pinning |
| [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) | 03, 26 | Official reference; qualify at dependency pinning |
| [Ubuntu Server documentation](https://documentation.ubuntu.com/server/) | 04 | Official reference; qualify at dependency pinning |
| [sudo manual](https://www.sudo.ws/docs/man/sudo.man/) | 04 | Official reference; qualify at dependency pinning |
| [systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) | 04 | Official reference; qualify at dependency pinning |
| [Ubuntu package management](https://documentation.ubuntu.com/server/how-to/software/package-management/) | 05 | Corrected primary path; page inspected |
| [Python virtual environments](https://docs.python.org/3/library/venv.html) | 05 | Official reference; qualify at dependency pinning |
| [Pi packages](https://pi.dev/docs/latest/packages) | 05 | Official reference; qualify at dependency pinning |
| [Playwright browser contexts](https://playwright.dev/docs/api/class-browsercontext) | 06 | Primary page reopened |
| [Playwright screenshots](https://playwright.dev/docs/screenshots) | 06 | Official reference; qualify at dependency pinning |
| [Steel Browser](https://github.com/steel-dev/steel-browser) | 06 | Primary page reopened |
| [Steel self-hosted MCP limitations](https://github.com/steel-dev/steel-mcp-server) | 06, 08 | Official reference; qualify at dependency pinning |
| [OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html) | 07 | Official reference; qualify at dependency pinning |
| [Chrome DevTools connection](https://developer.chrome.com/docs/devtools/agents/get-started/configuration) | 07 | Official reference; qualify at dependency pinning |
| [Chrome debugging profile changes](https://developer.chrome.com/blog/remote-debugging-port) | 07 | Official reference; qualify at dependency pinning |
| [Local t3code browser import reference](../../t3code/docs/user/browser-import.md) | 07 | Local reference |
| [Playwright authentication](https://playwright.dev/docs/auth) | 08 | Official reference; qualify at dependency pinning |
| [Apple notification handling](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions) | 08, 25 | Official reference; qualify at dependency pinning |
| [Git worktrees](https://git-scm.com/docs/git-worktree) | 09 | Official reference; qualify at dependency pinning |
| [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) | 09 | Official reference; qualify at dependency pinning |
| [t3code source control reference](https://github.com/pingdotgg/t3code/blob/cfafb4bb54d244e4612f5681aad3832ea64cb0fb/docs/user/source-control.md) | 09 | Official reference; qualify at dependency pinning |
| [OpenCode permissions reference](https://opencode.ai/docs/permissions/) | 09, 26 | Official reference; qualify at dependency pinning |
| [GitHub CLI manual](https://cli.github.com/manual/) | 10 | Official reference; qualify at dependency pinning |
| [GitHub REST documentation](https://docs.github.com/en/rest) | 10 | Official reference; qualify at dependency pinning |
| [Git push](https://git-scm.com/docs/git-push) | 10 | Official reference; qualify at dependency pinning |
| [systemd journalctl](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html) | 11 | Official reference; qualify at dependency pinning |
| [Docker Engine API](https://docs.docker.com/reference/api/engine/) | 11 | Official reference; qualify at dependency pinning |
| [OpenClaw elevated execution reference](https://docs.openclaw.ai/tools/elevated) | 11 | Official reference; qualify at dependency pinning |
| [SearXNG documentation](https://docs.searxng.org/) | 12 | Official reference; qualify at dependency pinning |
| [Playwright browser automation](https://playwright.dev/docs/intro) | 12 | Official reference; qualify at dependency pinning |
| [OpenClaw memory reference](https://docs.openclaw.ai/concepts/memory) | 12, 19 | Official reference; qualify at dependency pinning |
| [LibreOffice headless options](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) | 13 | Official reference; qualify at dependency pinning |
| [Docling documentation](https://docling-project.github.io/docling/) | 13 | Official reference; qualify at dependency pinning |
| [openpyxl documentation](https://openpyxl.readthedocs.io/en/stable/) | 13 | Official reference; qualify at dependency pinning |
| [python-pptx documentation](https://python-pptx.readthedocs.io/en/latest/) | 13 | Official reference; qualify at dependency pinning |
| [DuckDB documentation](https://duckdb.org/docs/) | 14 | Official reference; qualify at dependency pinning |
| [pandas documentation](https://pandas.pydata.org/docs/) | 14 | Official reference; qualify at dependency pinning |
| [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html) | 14 | Official reference; qualify at dependency pinning |
| [Gmail API](https://developers.google.com/workspace/gmail/api/guides) | 15 | Official reference; qualify at dependency pinning |
| [Google Calendar API](https://developers.google.com/workspace/calendar/api/guides/overview) | 15, 16 | Official reference; qualify at dependency pinning |
| [Microsoft Graph mail](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview) | 15 | Official reference; qualify at dependency pinning |
| [Playwright input actions](https://playwright.dev/docs/input) | 16 | Official reference; qualify at dependency pinning |
| [Model Context Protocol](https://modelcontextprotocol.io/specification/latest) | 16, 21 | Official reference; qualify at dependency pinning |
| [Stripe PaymentIntent lifecycle — merchant integration reference](https://docs.stripe.com/api/payment_intents) | 17 | Official reference; qualify at dependency pinning |
| [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) | 17 | Official reference; qualify at dependency pinning |
| [AP2 protocol — optional interoperability](https://ap2-protocol.org/) | 17 | Official reference; qualify at dependency pinning |
| [UCP payment flow — optional interoperability](https://developers.google.com/merchant/ucp/faq) | 17 | Official reference; qualify at dependency pinning |
| [systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) | 18 | Official reference; qualify at dependency pinning |
| [OpenClaw cron reference](https://docs.openclaw.ai/automation/cron-jobs) | 18 | Official reference; qualify at dependency pinning |
| [Apple remote notifications](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server) | 18, 25 | Official reference; qualify at dependency pinning |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | 19 | Official reference; qualify at dependency pinning |
| [Ollama embedding capability reference — local helper qualification](https://docs.ollama.com/capabilities/embeddings) | 19 | Official reference; qualify at dependency pinning |
| [OpenClaw subagents reference](https://docs.openclaw.ai/tools/subagents) | 20 | Official reference; qualify at dependency pinning |
| [OpenCode plugin reference](https://opencode.ai/docs/plugins/) | 21 | Official reference; qualify at dependency pinning |
| [Ollama Cloud](https://docs.ollama.com/cloud) | 22 | Primary page reopened |
| [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) | 22 | Official reference; qualify at dependency pinning |
| [Ollama structured output limitations](https://docs.ollama.com/capabilities/structured-outputs) | 22 | Official reference; qualify at dependency pinning |
| [Pi custom providers](https://pi.dev/docs/latest/custom-provider) | 22 | Corrected primary path; page inspected |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 23 | Official reference; qualify at dependency pinning |
| [FFmpeg documentation](https://ffmpeg.org/documentation.html) | 23 | Official reference; qualify at dependency pinning |
| [Tesseract documentation](https://tesseract-ocr.github.io/) | 23 | Official reference; qualify at dependency pinning |
| [Ollama vision](https://docs.ollama.com/capabilities/vision) | 23 | Official reference; qualify at dependency pinning |
| [SwiftUI documentation](https://developer.apple.com/documentation/swiftui) | 24 | Official reference; qualify at dependency pinning |
| [Apple Keychain services](https://developer.apple.com/documentation/security/keychain-services) | 24 | Official reference; qualify at dependency pinning |
| [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication) | 24, 26 | Official reference; qualify at dependency pinning |
| [Local Ink design assets](../Ink%20design%20system%20implementation/Index.dc.html) | 24 | Local reference |
| [Refined mock design contract](../mock/docs/design.md) | 24 | Local reference |
| [ActivityKit](https://developer.apple.com/documentation/activitykit) | 25 | Official reference; qualify at dependency pinning |
| [Apple background execution guidance](https://developer.apple.com/documentation/backgroundtasks) | 25 | Official reference; qualify at dependency pinning |
| [OpenClaw approvals reference](https://docs.openclaw.ai/tools/exec-approvals) | 26 | Official reference; qualify at dependency pinning |
| [SQLite WAL](https://www.sqlite.org/wal.html) | 27 | Official reference; qualify at dependency pinning |
| [SQLite online backup](https://www.sqlite.org/backup.html) | 27 | Official reference; qualify at dependency pinning |
| [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) | 27 | Official reference; qualify at dependency pinning |
| [WireGuard](https://www.wireguard.com/quickstart/) | 27 | Official reference; qualify at dependency pinning |

## Scope and evidence honesty

- Proposal: Outpost records, endpoints, mode gate, workflow mandates, shared reducers, task orchestration and module implementation approach.
- Existing reference: upstream projects/documentation and the pinned local source snapshots, subject to compatibility checks.
- Existing implementation: only the current native SwiftUI mock with in-memory sample data, described in [mock/README.md](../mock/README.md).
- Not done by this documentation: server provisioning, provider/model benchmarking, real iOS build, two physical-client sync, APNs delivery, account creation/import, real CAPTCHA assistance or payment execution.

Use [delivery/acceptance](29-delivery-and-acceptance.md) to convert proposals into verified capabilities and attach evidence to stable feature IDs. Update this source/version register with the exact pinned references used for each implementation gate.
