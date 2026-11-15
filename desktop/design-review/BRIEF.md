# Outpost consistency review — mock only

One offline interactive mock, no production edits, network APIs, real SSH, credentials or server mutations. User wants existing Graphite design language, not a rebrand. Reuse Google Sans Flex from ../src/assets/fonts/GoogleSansFlex.woff2, existing OutpostMark from ../src/OutpostMark, React and lucide-react. All sample data labeled by shell as Preview / Sample data. Shell written by coordinator.

## Shared contract
Import from ./ui: Button, IconButton, SelectField, Field, Section, EmptyState, Badge, Modal, useNotice.
- Button: React button props plus variant?: 'primary'|'secondary'|'ghost'|'danger', children. Default secondary. 36px height, 12px inline padding, radius 8, icon-text gap 8.
- IconButton: button props plus label:string, children, active?:boolean. 36x36, SVG 18px; label used for aria-label and title. Neutral rounded rectangle radius 8, same hover/focus.
- SelectField: native select props plus label?:string, icon?:ReactNode; children option nodes. Full wrapper includes icon, label/value, chevron and unified hover/focus. 40px standard fields, compact prop?:boolean gives 36px inline composer control. No browser arrows. Do not separate icon hover surface from selector.
- Field: input props plus label:string. 40px high soft raised fill, 1px transparent border at rest, visible focus outline; shared radius8. Textarea class 'text-field' with label wrapper .field.
- Section: title:string, description?:string, action?:ReactNode, children. Compact heading then children, no giant prose column. Background transparent, row separators.
- EmptyState: icon:ReactNode,title:string,description:string,action?:ReactNode. Calm compact centered empty state, no gigantic cards.
- Badge: children, tone?:'neutral'|'success'|'warning'.
- Modal: title:string,onClose:()=>void,children; real dialog focus trap and Escape handled centrally. Body use .form-grid, .field, .dialog-actions classes. Button type=submit as needed.
- useNotice(): (message:string)=>void for preview feedback. No native alert/confirm.
Shared classes .row (flex gap12 align-center padding16 0 border-bottom), .grow (flex1 min-width0), .muted, .small, .stack (grid gap16), .inline (flex gap8 align-center wrap), .form-grid (grid gap16), .dialog-actions (flex justify-end gap8 margin-top24), .text-field (textarea soft fill border radius8), .two-col (two equal columns gap24), .list-title (font14 weight550), .detail-text (font12 muted).
Tokens --bg:#101112; --surface:#16171a; --raised:#1c1d21; --active:#292b30; --line:#292b30; --text:#ededef; --muted:#a1a3a8; --positive:#a3bda9; --warning:#d6b78b; --danger:#f3a49e. Font14, body line1.6, heading24, section16. 8px spacing system. Use single consistent TerminalSquare/SquareTerminal Lucide icon for ALL terminal instances. ALL controls have meaningful labels.

## Division
GPT-6.1 Sol: SettingsPages.tsx + settings.css; default export SettingsPages({tab:string}), tabs general, connection, models, runtime, devices, recovery. Shell supplies sidebar/settings tabs/header.
GLM-5.3 Flash: ComposerPages.tsx + composer.css; default export ComposerPages({mode:'new'|'chat'}). Own shared composer and terminal mock, no giant new-task question heading. Reuse exact same composer both screens. Shell owns navigation.
MiniMax M3.1 Flash: WorkspacePages.tsx + workspace.css; default export WorkspacePages({page:'automations'|'memory'|'chats'|'approvals'}). Own headings/actions per workspace page; usable schedule creation and friendly list/empty states.
Coordinator: ui.tsx, styles.css, App.tsx, main.tsx, index.html, Vite build/standalone file, screenshots/tests, review integration.

## User issues
Terminal icon inconsistent weight/container. Model hover padding too tight. Full control shield separate from native select highlight. Home/chat composers different. Settings fields mixed heights/native selects/outlines. Provider page text wall, tab hover looks like multiple active selections. Pi settings lacks understandable management. Device/recovery pages overwhelming jargon. Automations no schedule action. Memory needs clear shared vs server scope. All chats overexposes UUIDs/internal state. Approval empty state unhelpful. Remove 'What should I run next?' text.

## Safety
Settings mocks must preserve critical safety info in confirmations/details (credential location, revoke/self-revoke warning, unknown outcome, queued-work resume). Pi controls are design proposals, do NOT imply arbitrary extension install/upgrade is currently available. Simulate actions explicitly. Schedules choose server, prompt, frequency/time/timezone, permission; saving preview only. Do not claim disabled controls work on live servers. Keep all sample data fake. No real keys/hosts.
