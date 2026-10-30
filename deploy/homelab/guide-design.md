# Offline cluster guide

Approved direction: a standalone interactive HTML guide, not a live dashboard. No server changes, credential handling, application work or remote execution.

## Design contract

- Main question: how do these two particular machines work together, and how can the owner prove it?
- Achromatic ledger, seed 415997956. Blue-grey ground, white surfaces, near-black text/actions; blue only on the topology and illustrative pod placement. Geist embedded from the repository under OFL, system monospace for commands.
- Signature: the main/worker split using the real hostnames, addresses, hardware and negotiated link rates. One connected topology, not generic metric cards.
- Labelled open-plane navigation; three distinct views: connection, tests, Docker/scaling. On mobile, navigation becomes a top row and node details stack. All controls at least 44px high.
- All statuses are labelled as recorded on 28 October 2026. A command illustration is never labelled a live test. Hostname output is explicitly an expected example; actual network-test evidence is a transcript excerpt.
- Four copyable read-only checks, plus the recorded cross-node HTTP proof. Copy fallback handles blocked clipboard access.
- The Docker scenario derives its count from the eight recorded container names. Hypothetical replica placement is labelled, and never represented as automatic balancing or an actual HPA.
- Snapshot guide has no loading or refresh state because it never contacts a server. No application controls or server credentials.
- Finish condition: standalone file works offline; all navigation, diagram selections, step-through, test selections, disclosures and replica controls tested; clipboard success/failure paths exercised; screenshots reviewed at 1440, 768 and 390px with no horizontal page overflow.

UI/UX search suggestions were used for accessibility and honest telemetry labels, not for glassmorphism or marketing layout, which conflict with the chosen app direction. No new visual dependencies installed.

## Final visual review and verification

- The connection map answers the primary question before the supporting facts. Real node identities and link rates provide the guide's distinct visual structure.
- Desktop panel edges align. The initial gap in the summary panel was replaced with the useful entry-point SSH command. The tablet source disclosure now stays within the canvas; mobile nodes and navigation stack without page overflow.
- Colour is limited to connection paths, selected node outlines and recorded success labels. There are no invented charts or changing live indicators.
- Eight Docker markers are derived from the eight recorded names. Illustrative replica totals reconcile at 1, 4 and 6; the zero-worker state has a correct accessible count.
- Diagram nodes, command tracing, all test choices, disclosures, hash routes and scenario controls work. Clipboard denial offers a selected manual-copy field; changing sections dismisses stale copy feedback.
- Offline Chromium testing: 73 assertions passed, including keyboard operation, reduced motion, no-JavaScript fallback, zero external HTTP requests and zero JavaScript errors. Screenshots captured for all three views at 1440, 768 and 390px; inspected desktop, tablet and phone compositions.
- Final design inspector: 0 failures, 0 warnings across 1440, 768 and 390px. Source lint: 0 failures, 0 warnings.
- Remaining boundary: this is intentionally a snapshot document. It does not verify current server health, operate SSH, migrate containers, configure autoscaling or change any application. No server changes were made for the guide.

