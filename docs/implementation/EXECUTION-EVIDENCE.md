# Execution evidence: attempts versus outcomes

## Diagnosis

Read-only comparison of the reported task's ledger, tool projections and Pi session established that the displayed errors belonged to earlier, genuinely failed calls. The `command`-string request was rejected; later argv-based commands succeeded with exit code 0. Two `file.write` attempts omitted `expectedHash`, and one also supplied `content` instead of `text`. Their failure records must not be changed to success just because later work succeeded.

The UI concatenated all unlinked tool streams before all coordinator actions. That grouped old rejected attempts at the top regardless of time. Settled errors were expanded by default and their status used the live-tool success color, making the latest outcome difficult to understand.

A separate projection bug required `details.actionId` to parse a tool result. Pi returns error results with empty details, so the entire parse failed and discarded the error explanation. This did not change the actual execution outcome.

## Repair

- Activity merges coordinator actions and unlinked tool attempts into one **newest-first** timeline, with visible timestamps. An action and its linked stream still appear only once.
- Successful coordinator actions visibly say **Succeeded**. Nonzero exits and uncertain outcomes still say **Needs review**.
- Tool errors say **Failed attempt**, use the danger color plus an icon/text, and start collapsed when settled. Keyboard disclosure reveals the original arguments and available explanation.
- Overview shows active tool streams only, alongside recent action results. A count links the meaning of retained failed attempts to Activity without presenting them as currently running work.
- Missing historical projection detail is described as unavailable in that execution record; no invented diagnosis is attached to an old row.
- Tool-result content and action-link parsing are independent. New SDK error explanations survive even when no coordinator action was admitted. Arbitrary details are not published.

No calls are replayed, no task/action states are reclassified, and no historical records are rewritten. Viewing an execution record cannot trigger a command. Provider verification and host privileges are unchanged.

## Verification

A real SDK/worker fixture uses distinct call IDs for an invalid request and its correction, verifies the failed attempt's public explanation, and confirms successful execution once. Projection tests verify both independent outcomes and exclude unrelated result details.

Browser fixtures cover historical failures followed by success, nonzero exits, linked-stream deduplication, ordering, timestamps, collapsed arguments, keyboard access, truthful colors, no mutations, and narrow layouts in light/dark mode: **84 checks each** in Chromium/WebKit. Studio **179 checks each**, scroll containment **207 checks each**, and live-stream **14 checks** passed. Backend working-tree tests: **310 passed, 1 skipped**, including unrelated untracked diagnostics.

Deployed release: **`evidence-order-20261031T055909Z`**, Pi 1.4.0, shared profile unchanged. Pod `pi-workspace-578c878684-xwvqh` was **3/3 Ready**, zero restarts. The deployed worker projection source matched the local SHA-256 exactly.

The maintenance checkpoint protected **4** review-stage tasks. All **11 task records**, all action/tool-stream records, and credential bytes compared exactly equal before/after rollout; dispatch was restored. The catalogue still exposes the same eight verified ChatGPT models. Private backup: `/home/node/.outpost/backups/evidence-order-20261031T055909Z`; Server-1 record: `~/outpost-rollouts/evidence-order-20261031T055909Z/`. Preserve newer data rather than restoring stale database/profile backups.
