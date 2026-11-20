# Subagent run UI — actual-app mock

```sh
node mock/subagent-runs/build.mjs
open mock/subagent-runs/index.html
```

This self-contained preview renders the current Outpost app shell, sidebar, parent conversation, and composer with synthetic native IPC. Only the subagent card and run inspector are proposed UI. Nothing is installed, committed, sent to a model, or executed on a server.

## Design

- A compact expandable row carries status, assignment title, model, duration, and disclosure.
- Expanded content shows the returned summary, changed files, and validation; controls copy the summary or open the run.
- Open run docks a full-height inspector alongside the parent chat. Activity shows the assignment, user-facing messages, and individually expandable tool inputs/outputs. Result shows the returned report.
- Expand run opens a larger modal view. Escape returns to the side panel; closing the panel returns focus to the originating control.
- The sidebar's Preview state selector demonstrates Completed, Running, Needs attention, and Stopped. Stop subagent changes only the sample state.
- Uses actual Outpost tokens: sidebar #0F0F0F, workspace #1E1E1E, neutral raised surfaces, Google Sans Flex, and Lucide icons. Status colors have meaning; the surrounding UI stays neutral.

The example assignment and results are based on the reference supplied for the design. Timings, live output, and failure details are illustrative. This is not a fresh test report or a real subagent execution. The mock shows ordinary recorded messages and tool activity, not hidden model reasoning. Clipboard operations may be unavailable for local HTML in some browsers; an explicit notice is shown in that case.

## Validation

```sh
node mock/subagent-runs/check.mjs
```

Checks collapsed/expanded states, result/activity switching, tool-output disclosure, full-run modal, sample state changes, stop simulation, focus return, responsive layout, and reduced motion. All external HTTP requests and unexpected native commands are rejected during the test. Screenshots are generated beside the HTML.
