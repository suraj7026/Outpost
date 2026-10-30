# Browser agents in Outpost

## Existing integration, not a new deployment

Outpost already contains Browser-Use 0.13.14, pinned in `server/browser-use/pyproject.toml` and its lockfile. `server/browser-use/worker.py` uses local headless Chromium (`use_cloud=False`) and `ChatOllama`, with the exact task-selected model. The coordinator registers `browser.run` when both inference and the browser interpreter are configured. See `server/browser/browser-use.ts` and `server/gateway/coordinator.ts`.

The worker returns observed URLs, errors, step count, duration and screenshots. The TypeScript adapter publishes screenshots and JSON as task artifacts. The desktop image viewer now opens those PNG artifacts without downloading them first.

`deploy/agent/README.md` documents an earlier live deployment and example.com verification. This review did not rerun a live provider/browser task or redeploy the server. Runtime configuration and an earlier successful task are not proof that every model/site combination works.

## Recommendation and alternatives

- **Keep Browser-Use** for goal-driven navigation that must interpret pages. Replacing it is unnecessary for image viewing. Cloud-selected inference still sends page/task context to Ollama Cloud even though Chromium is self-hosted.
- **Playwright** is the existing deterministic alternative (`server/browser/browser.ts`): preferable for known selectors, repeatable flows and fixture tests. It is browser automation, not by itself a reasoning agent.
- **Stagehand** is an agent-oriented alternative with TypeScript APIs for acting, observing and extracting. Adopting it would require integration with Outpost's action gate, artifact flow and exact Ollama model validation; it is not a drop-in replacement already enabled here.

A live browser pane/manual takeover is a separate feature. The current Browser-Use worker does not stream its browser video or individual nested steps, and the separate Playwright lease implementation does not fence that worker's actual input. A takeover feature must enforce exclusive human/agent control in the real worker, refresh observations after hand-back, and preserve approvals and session isolation. A screenshot viewer must not be presented as live takeover.

The current administrative browser worker disables Chromium's sandbox. Self-hosting alone does not make untrusted web pages or browser profiles safe from the agent. Any expanded browsing capability needs a deliberate isolation and authority review.

Sources reviewed: [Browser Use product map](https://browser-use.com/llms-full.txt), [Stagehand](https://www.stagehand.dev/), repository integration and deployment documentation. No hosted-browser subscription or third-party account was created.
