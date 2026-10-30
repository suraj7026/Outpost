# Outpost Ink mock

A native macOS SwiftUI UI prototype using the existing Ink design. All task, model, browser, server, account and payment information is sample data. There is no backend, network client, shell executor, credential collection or payment integration.

## Open

Run the build script, then open the application:

    ./build.sh
    open "build/Outpost Mock.app"

Requires macOS 14+ and Xcode command-line tools to build.

## Explore

- Home and task list, plus a conversation workbench with Plan, Files, Diff, Browser, Activity and Outputs.
- Approval inbox, headless browser control/login/challenge handoff, machine processes/services/storage/snapshots/network, and capability installation.
- Accounts and Chrome pairing/import, spending and purchase approval, automations, library/templates/procedures, and memory.
- Settings for Ollama Cloud, Full control/Auto/Ask permission, Apple push notification previews, devices and audit.
- All 270 features across 27 areas from the current plan in a searchable catalogue; each feature links to its related workflow.
- An interactive iPhone preview with shared task/approval state.

Use **⌘K** for screen/task/feature search, **⌘N** for a new sample task, **⌘⇧I** for iPhone preview and **⌘⇧T** for light/dark appearance. The Preview menu includes compact/spacious window sizes and resets shared in-memory data. Closing and reopening the app also starts fresh.

Fonts are bundled for offline use. Geist and Geist Mono licences are included in the Resources directory. SF Symbols are provided by macOS.

The phone is a SwiftUI preview inside the Mac app, not a separately packaged iPhone app. This is a design review artifact, not the production client or a claim that server capabilities are implemented.

The refined Ink direction is documented in [docs/design.md](docs/design.md): a quieter navigation rail, open task lists, a dedicated decision view, and a grouped tool catalogue. The original colour tokens are preserved.

Latest product decisions are specified in [../spec/README.md](../spec/README.md). The three control modes, agent-first accounts, browser-only access and whole-payment-workflow approvals are represented by mock controls; no reviewer, APNs or server sync is connected. Both device previews share in-memory state only.
