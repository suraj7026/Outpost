# Settings page redesign mock

An interactive mock of the Outpost Settings page, built entirely on the app's
existing component idioms — no new visual language. The layout is the
refinement: settings become sections of icon-led rows with trailing controls,
plus a live window preview.

## What changes versus the current page

- **Sections and rows, not fieldset stacks.** Four groups — Startup, Theme,
  Conversation, Window — using the app's `ui-section` / `ui-row` pattern:
  hairline separators, 34px plain icons, 14px/550 titles, 12px descriptions.
- **Option clusters move into the row.** The existing
  `appearance-width-options` raised well (native radios, active pill fill)
  becomes the trailing control for each choice, instead of a full-width block
  under a paragraph.
- **Switches and slider keep the app's exact styling.** 44x28 switch with the
  muted knob, native `accent-color` slider with a tabular readout. Focus stays
  a surface fill, never an outline (focus.css).
- **Live preview.** The Window group opens with a miniature Outpost window.
  Frosted glass and Glass opacity alter its sidebar material directly;
  Collapse sidebar replays the app's real sidebar motion (520ms spring in,
  240ms ease out, interruptible from the presentation value).
- Whole switch rows are labels, so the entire row toggles the switch.

## Files

- `index.html` — page structure using `ui-section`, `ui-row`,
  `appearance-width-options`, `appearance-toggle`, `appearance-opacity`
- `prototype.css` — app tokens and component values copied from
  `desktop/src/styles.css`, `interface.css`, `appearance-width.css`,
  `focus.css`, `studio.css`
- `prototype.js` — theme, frost, opacity and collapse-preview bindings;
  collapse keyframes mirror `desktop/src/useSidebarMotion.ts`
- `test.mjs` — geometry and behavior assertions (Chromium and WebKit)
- `screenshot.mjs` — renders `visual-review/` captures

## Run

```
node test.mjs
node screenshot.mjs
open index.html
```
