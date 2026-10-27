# 06. Headless browser and live takeover

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **WEB-01 through WEB-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Provide real web work from a headless browser on Ubuntu Server, with browser-only viewing and human assistance on either client.

## What the owner sees

Show live page frames, URL, task, active identity, current input owner and saved screenshots/downloads. The same browser session is accessible from Mac or iPhone; there is no Linux desktop, VNC session or generic remote computer surface.

## Responsibility and boundary

Browser/context/tab lifecycle; semantic observation; screenshots; navigation/actions; downloads; browser-only input lease and crash recovery.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [02 Server files and artifacts](02-filesystem-and-artifacts.md), [07 Agent and owner identities](07-identities-and-credentials.md), [08 Verification challenges and human assistance](08-verification-and-human-assistance.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
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

## How to build it

1. Start with pinned Playwright/Chromium headless on the server. Evaluate self-hosted Steel behind an adapter; its container must pass the same lifecycle and credential tests as direct Chromium.

2. Use fresh observation IDs for actions, track navigation/popups/downloads and publish screenshots as artifacts. Build an authenticated browser-only viewing/input path; choose a transport after measuring latency, bandwidth and exact headless input support.

3. Implement a server-exclusive input lease: agent, Mac or iPhone. Taking over suspends agent input; return control re-observes before continuing. Persist permitted profile state and recover crashes without assuming arbitrary sessions are serializable.

## Data and integration contracts

**Server-owned records:** browser_sessions; browser_tabs; browser_observations; browser_input_leases; browser_checkpoints; downloads.

**Proposed Pi/tool or client command surface:** `browser.open; browser.observe; browser.act; browser.capture; browser.download; browser.takeover; browser.return_control`.

**Proposed durable events:** `browser.started; browser.observed; input.owner_changed; download.completed; browser.recovered`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Do not expose raw CDP, authenticated script execution or cookies from a protected owner profile to an unrestricted worker while promising brokered account controls.
- Choose the identity explicitly before navigation. Mask sensitive frames and avoid storing credentials/OTP images in ordinary screenshots or cloud prompts.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

On a browser crash preserve evidence/downloads, revoke input leases and restart only a qualified profile. Account expiry or provider reauthentication yields a clear login wait, not a claim of universal session restoration.

## Acceptance and proof

- Watch and take over the same headless page from either client; race takeover requests and prove one input owner.
- Complete navigation, file upload and download, then crash/recover Chromium with preserved task/evidence links.
- Revalidate stale locators/frames after navigation and prove a protected identity cannot be accessed through a raw worker debug endpoint.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Playwright browser contexts](https://playwright.dev/docs/api/class-browsercontext)
- [Playwright screenshots](https://playwright.dev/docs/screenshots)
- [Steel Browser](https://github.com/steel-dev/steel-browser)
- [Steel self-hosted MCP limitations](https://github.com/steel-dev/steel-mcp-server)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
