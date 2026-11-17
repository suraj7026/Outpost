# Chat-bound automations — interactive design preview

An isolated, disconnected prototype for reviewing the chat → automation and automation → dedicated-chat workflows. It does not modify the application, create real schedules, contact an AI model, run commands, or connect to Outpost servers. All state resets on reload.

## Open

Open `index.html` directly in a browser. From the repository root on macOS:

```sh
open mock/automation-chat/index.html
```

It also works when served as static files. HTML, CSS, JavaScript and the existing Outpost Google Sans Flex font are local; no CDN or package install is needed.

## Walkthrough

1. **Chat setup:** the sample owner request leads to an inline draft card. Review the schedule, timezone, destination and server; choose **Create automation**. The composer now has an attached-automation strip.
2. **Scheduled result:** the tour shortcut shows an illustrative scheduled prompt and report in the original conversation. **Simulate next run** appends another occurrence without creating another chat.
3. **Automations → chat:** inspect the original/dedicated destination links. **New automation → Create & open chat** creates a single dedicated conversation without starting a run. Its automation controls offer **Run now**.
4. **Manage:** edit future prompts/timing, pause/resume, run manually, or return to the global list. Previous run prompt snapshots are preserved.
5. **Run states:** choose Report ready, Access blocked, Chat is busy, or Needs permission before simulating. Queued runs have a preview-only release button. Approval is a sample dialog; neither approval nor rejection executes anything.
6. **Follow-ups:** ordinary messages remain in the chat without changing the saved prompt. A small keyword detector opens a schedule review for scheduling phrases; this is not a natural-language scheduling implementation. Review the sample timing manually.

The top tour, scenario selector, simulation controls, placeholder AI replies and reset action are prototype tools, not proposed production controls.

## Proposed production UI changes

- Inline schedule draft/confirmation card with destination **This chat**.
- A **Schedule** composer action and compact attached-automation strip; management stays in a dialog to preserve reading width.
- Distinct scheduled-prompt blocks, timestamps, named automation and per-occurrence status, followed by the normal response/evidence UI.
- Automation rows show the saved prompt, timezone, next run, latest outcome, original/dedicated chat and **Open chat**.
- Page-created automation editor states explicitly that it creates a dedicated conversation; submission navigates there without running.
- Pause stops future occurrences only. Approval and access blockers remain visible inside their destination chat.

## Scope and sample content

Fixtures: Daily server health, Weekly backup check and a prefilled Weekly project briefing. The preview clock starts on 16 November 2026 at 10:42 IST. Simulated scheduled runs advance that clock. Host names echo the user's example; displayed availability and load values (0.42 / 0.18) are fictional, not measured. Outpost 2 is a sample environment. Ask permission is intentionally fixed in this prototype.

This prototype does not validate backend durability, timezone/DST policies, missed-run recovery, model context, authorization or migration. Actual scheduling must use the server's calendar and policy implementations, not this preview's date helper or keyword detector. No production files were changed.

## Validation

```sh
node mock/automation-chat/test.mjs
```

Playwright runs Chromium and WebKit from local files. Tests cover creation, scheduled outcomes, queuing, approval, pause/resume, edits with historical prompt preservation, dedicated chat creation, repeated runs staying in that chat, in-chat creation and filters. Responsive checks use 1440×1000, 768×1000 and 390×844. Results and screenshots are written under `test-results/`.

Latest full test run: **121 passed, 0 failed, 0 blocked**, no JavaScript pageerrors or external/backend requests. Visual screenshots were inspected at desktop/tablet/mobile sizes. Source lint: 0 failures, 0 warnings. Browser design inspection: 0 failures, 1 warning with `font-not-dealt` explicitly allowed to preserve the app's Google Sans Flex instead of an unrelated previously dealt Inter direction. Remaining warning: a high share of 11–12px metadata/navigation in a compact, existing-product-style UI; conversation text is 14–15px.

### Visual review

- The main chat question—where a scheduled prompt and its response appear—is answered by the transcript, not a new dashboard.
- The card, transcript and composer share one width. The automation list uses a broader page grid consistent with the existing design review.
- Color is reserved for state dots; neutral controls and the app's dark surfaces/type are retained. No new aesthetic direction was introduced.
- Run identity, destination links, next-run labels and statuses derive from the same in-memory records. Historical prompts are snapshotted.
- Mobile folds navigation into a bottom bar and retains a scrollable conversation above the composer. Long reports and forms require vertical scrolling, not horizontal scrolling.
- Review tradeoff: the prototype provides both a chat-heading automation action and the composer strip; the header gives discoverability while the strip keeps the upcoming schedule near the input. This can be simplified after UI review.
