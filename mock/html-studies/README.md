# Outpost workspace studies

Open `index.html` in a browser. Five options live in the same HTML file, with a Compare view and light/dark appearance previews. No install or build is required; bundled Geist fonts work offline. Avenir Next and system fonts use local fonts with cross-platform fallbacks.

- **Soft studio:** Geist, 22 px panels, familiar split workspace.
- **Focus:** system sans, 28 px panels, conversation with expandable evidence.
- **Horizon:** Avenir Next, 20 px panels, top navigation and task shelf.
- **Editorial:** Georgia headings and Avenir Next UI, 18 px panels, open columns.
- **Dock:** system sans, 24 px panels, task list beside conversation and evidence.

All use the existing Graphite / Ink palette. Task selection, review tabs, tool disclosure, sample replies, sample approvals with undo, attachments, pause feedback and new sample tasks are interactive. Navigation to other product areas opens the task picker; it does not implement those areas. All information is illustrative. No agent, shell, payment, account or external action runs. The existing SwiftUI mock is unchanged.

Design basis: design-taste-frontend, UI Taste and Anthropic frontend-design. The palette is retained from the source design; the five layout and radius variations deliberately fulfill the requested comparison rather than enforcing one dealt shell.

See [Apple design review](APPLE-DESIGN-REVIEW.md) for measured contrast, interaction checks, applied refinements, and verification limits.
