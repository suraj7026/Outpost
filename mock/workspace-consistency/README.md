# Consistent workspace — actual-app preview

Open `index.html` in a browser:

```sh
open mock/workspace-consistency/index.html
```

This is a self-contained, offline mock built from the real Outpost React app and its bundled fonts. It does not modify the installed app or connect to any server.

## Proposed changes

- Settings, Machines, Library, Automations, Memory, and All chats share a centered 1,040px page with matching padding and heading positions.
- Settings text starts on the same vertical line as Startup and the other sections. Its icon sits in the left gutter. All six pages use matching bare header icons without background tiles or borders.
- Approvals is removed from the preview navigation. Relevant chats show attention counts in the sidebar and explicit approval/dispatch states in All chats.
- All chats offers a Needs attention filter. A chat's attention badge opens the existing exact-action review dialog; approval is not equivalent to execution.
- Library, Memory, and All chats use consistent, full-column rows inside the centered page, rather than spanning the entire window.

## Shared popup and control treatment

`controls.css` applies common button heights, field sizes, radii, typography, padding, and action alignment throughout the mock. `popup-consistency.js` decorates actual dialogs with consistent close controls and puts approval actions together in the footer (proxies call the original sample-only handlers). Compact dialogs share a 600px maximum width; specialized setup/browser/image viewers retain their larger working areas. Long schedule forms scroll inside a fixed header/footer. Standalone fields fill their column, and two-column fields collapse on small screens.

Tested popup flows: exact-action approval, model picker, new schedule, new shared note, and new server note. The schedule is also checked at a short 900×600 viewport and the shared-note form at 390px. OS-owned select menus and native system dialogs are outside the HTML mock's styling scope.

## Interactions and safety

Navigation, search, filtering, settings controls, server-note scope, and exact-action review use actual components. Two servers, six conversations, three files, and three shared notes are sample data. Approvals, dispatch, and shared-note changes are simulated in memory only; refreshing resets them. Download buttons download sample Markdown through the browser. Starting a task or opening a terminal is intercepted with a preview-only notice. Other unsupported native actions are denied. No credentials are loaded.

Mock-specific styling and DOM decoration live entirely in this folder. They demonstrate the proposal; production integration would move the attention calculations and rendering into the existing React chat components.

## Build and validation

```sh
node mock/workspace-consistency/build.mjs
node mock/workspace-consistency/check.mjs
```

The check verifies the same page width and heading X-coordinate across six pages; bare header icons; shared popup geometry and aligned, visible footer actions; Settings/Startup text alignment; removal of the Approvals destination; attention filtering; navigation into the correct chat and its real review dialog; no document overflow at smaller widths; and no unexpected native calls or external requests. Screenshots for each page and the approval flow are saved beside the HTML.
