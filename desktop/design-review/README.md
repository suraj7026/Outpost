# Outpost consistency mock

Open `Outpost-review.html` directly in a browser. It contains the bundled React app and local Google Sans Flex font; no server or internet connection is needed. CSP blocks network connections. No production source, installed app, SSH connection, credential or server data is modified.

## Review scope

- Same composer and unified controls for new tasks and conversations; removed the large question heading.
- Consistent terminal glyph, control sizing, integrated permission shield/select highlight and padded model selector.
- Uniform soft-filled fields and selects; distinct settings hover and selected states.
- Concise connection, provider, Pi, device and recovery pages with secondary detail disclosures.
- Local-only schedule creation/edit/pause/delete and note editing, readable chat lists and sample approval review.

The sidebar exposes all 12 screens for review. Screens reset when navigating away; this is not persistent application state. All sample operations are simulated. Runtime update/restart controls are design proposals and do not establish live server capability.

## Collaboration

GPT-6.1 Sol created settings and completed the workspace/consistency review. GLM-5.3 Flash created and reviewed the composer/terminal and reviewed the combined screens. MiniMax M3.1 Flash contributed an initial workspace draft, but was stopped at the user's request; Sol took over its remaining review and revisions. No subsequent MiniMax work was requested.

Review findings addressed: native select appearance, fragmented hover surfaces, duplicate active-tab styling, composer placement and width, obsolete runtime version examples, confusing permissions, repeated disclaimers, pointer-opened modal focus restoration in WebKit, and selected mobile-tab visibility.

## Build and validation

From `desktop`:

```sh
npx tsc --noEmit --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom --esModuleInterop --skipLibCheck --strict design-review/main.tsx
npx vite build --config design-review/vite.config.ts
node design-review/package-preview.mjs
node design-review/inspect.mjs
node design-review/test.mjs
```

Strict TypeScript and Vite build passed. Combined offline preview passed 238 assertions in Chromium and WebKit, covering 12 routes at 1440/900/430px, document/content overflow, shared composer geometry, control interaction/hover, terminal open/close, schedule and note creation, provider and runtime dialogs, approval review, Escape dismissal and focus restoration. No runtime errors or HTTP requests were observed. Browser screenshots are in `screenshots/`.

Production wiring, live provider entitlements, SSH/runtime management, actual scheduling, native installation, and persistent state are deliberately outside this mock.
