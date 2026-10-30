# Ink refinement — 27 October 2026

Outpost is a personal workstation for delegating work to an agent with its own Ubuntu computer. This prototype should make starting work and resolving a decision easy to find. The interface uses sample data and never executes the displayed operations.

## Design contract

Retain the original Ink colours exactly: canvas #0F1011, surface #16171A, raised #1C1D21, border #26282C, text #EDEDEF, secondary #A1A3A8, with the original light equivalents. Keep Geist for interface text and Geist Mono for code, paths and technical values. Red remains reserved for failures/destructive actions; diff colours retain their existing meaning.

Use a quiet navigation rail and one framed workspace. Avoid a grid of equally weighted cards: use open lists for ongoing work and tools, and enclosure for an editable composer, code, or an authorization boundary. The home screen is left aligned with a single large task entry area, then ongoing work beside decisions. At narrower widths those areas stack. Approval review uses a request list beside the exact action and consequence, with one primary decision.

Scale: 34 pt home headline, 30 pt page titles, 25 pt decision title, 14 pt supporting body, 12–13 pt controls, 10–11 pt quiet metadata. Use consistent 7–12 pt radii by role. Keep routine navigation and state changes immediate; no decorative entrance animations.

Carry the same component vocabulary into the workbench, browser, server, accounts, automations, files, memory, model settings, catalogue and iPhone preview. Retain all 270 planned feature entries and the existing mock interactions.

## Verification

The native release build succeeds. The revised home and approvals were visually inspected in dark mode, the capability list and home in light mode, and the coding workbench and 375 pt phone preview were inspected in the running app. A phone approval reduced the desktop pending badge from four to three. The 1080 × 760 compact home layout was also inspected and correctly stacks work above decisions. All effects remain in memory. The mock is not a production macOS or iOS client.

## Owner decisions applied

The three control modes are visible in the shared toolbar and phone header and detailed in Settings. Agent-first accounts, headless-browser-only access, whole-payment-workflow approval from either preview and Apple notification settings replace the earlier assumptions. These are mock controls; no server persistence, reviewer or APNs integration is connected. The production target is documented in ../../spec/README.md.
