# 22. Ollama Cloud models and Auto reviewer

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **MODEL-01 through MODEL-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Supply qualified open-model inference for the main Pi operator, an independent smaller Auto reviewer and vision; retain local execution and indexing helpers.

## What the owner sees

Both clients display the same model roles, selected control mode, provider health, quota waits and usage. Small reviewer decisions are concise public classifications, not hidden reasoning dumps.

## Responsibility and boundary

Server credential gateway; Pi provider adapter; role registry; model qualification; request budgets/concurrency; context management and reviewer conformance.

Dependencies: [01 Tasks and the Pi runtime](01-tasks-and-pi-runtime.md), [21 Extensions, skills and MCP](21-extensions-skills-and-mcp.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| MODEL-01 | Ollama Cloud primary path | Route Pi through the server-hosted gateway to approved Cloud models; keep the cloud credential out of clients/guest-wide config and make hosted inference visible. | C |
| MODEL-02 | Cloud capability probes | Test tools/results, streaming, images, context and cancellation on the actual hosted route. Validate data locally; do not assume Cloud-enforced structured output. | C |
| MODEL-03 | Operator, reviewer and vision roles | Qualify Cloud operator/coding, a separate smaller safety reviewer for Auto, and vision roles; self-host embedding/indexing helpers. Reviewer failure or uncertain classification asks the owner. | C |
| MODEL-04 | Explicit model inventory | Record hosted API ID, licence/source, observed version/digest if available, effective capabilities/context, qualification date and fallback list; do not invent provider-hidden runtime details. | C |
| MODEL-05 | Cloud health and usage | Show availability, latency, throughput, task usage, quota/rate limits where exposed, request failures, retries and budget state; unknown usage remains unknown. | C |
| MODEL-06 | Context management | Retrieve relevant files, truncate verbose output, summarize with provenance, preserve durable task state and reserve space for tool results. | C |
| MODEL-07 | Task-based evaluations | Measure coding, browser, document and operations success with deterministic validators; report failure modes and human intervention rate. | C |
| MODEL-08 | Approved Cloud fallback | Retry transient failures or select another qualified open model on Ollama Cloud within the task's data/budget scope. Otherwise pause; no silent provider or local-runtime switch. | E |
| MODEL-09 | Hosted model changes | Requalify changed IDs/behavior and retirements, keep alternative qualified models, and avoid promising rollback to cloud revisions the provider no longer serves. | E |
| MODEL-10 | Efficient execution modes | Small tool loadouts, locally validated structured data, deterministic recipes, context budgets and concurrency matched to Cloud quotas plus local tool capacity. | E |

## How to build it

1. Use the server-hosted gateway and actual Ollama Cloud account inventory. Do not hardcode a model ID, infer a hidden quantization/runtime revision or assume Cloud catalog membership from a public weight card.

2. Test the pinned Pi transport for streaming, tools/results, vision, cancellation and locally validated output. Assign operator/coding, smaller reviewer and vision roles only after task-based qualification; the reviewer is a separate role and not the action-producing session judging itself.

3. Evaluate structured proposed actions against deterministic restrictions first, then the reviewer. Locally validate allow/ask output, scope/expiry and policy hash; record model ID/qualification and a brief rationale. Timeout, invalid output, unfamiliar effect or uncertainty asks the owner.

## Data and integration contracts

**Server-owned records:** model_roles; model_qualifications; inference_requests; usage_observations; safety_reviews; provider_failures.

**Proposed Pi/tool or client command surface:** `model.list; model.qualify; inference.request; action.review; usage.inspect; model.fallback`.

**Proposed durable events:** `model.qualified; inference.queued; inference.completed; review.allowed; review.ask; provider.unavailable`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- An LLM reviewer is a fallible classifier, not the security boundary. It cannot grant an owner identity, authorize money, change mode or bypass protected policy.
- Cloud prompts can contain selected files/results/screenshots. Keep credentials/OTP/payment secrets out of inference and make hosted processing explicit. No silent switch to another provider or hosted agent service.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

Persist queue/budget state and distinguish Cloud quota waits from local capacity waits. Requalify retired/changed hosted models and use only owner-qualified fallbacks; absent a valid reviewer, Auto asks rather than assumes allow.

## Acceptance and proof

- Pass the full operator tool/vision/cancellation suite on the chosen route and all three task pillars.
- Measure dangerous false allows and ordinary false prompts on held-out actions, prompt-injection fixtures, long outputs and ambiguous shell/API/browser effects.
- Simulate reviewer outage/malformed responses and verify no affected action starts automatically; verify no self-promotion or payment mandate appears.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Ollama Cloud](https://docs.ollama.com/cloud)
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling)
- [Ollama structured output limitations](https://docs.ollama.com/capabilities/structured-outputs)
- [Pi custom providers](https://pi.dev/docs/latest/custom-provider)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
