# 21. Extensions, skills and MCP

Status: implementation specification, not implemented capability. Owner decisions: 27 October 2026. Feature owner: **EXT-01 through EXT-10**.

Read [system architecture](00-system-architecture.md), [shared contracts](28-protocol-and-data-contracts.md) and [delivery/acceptance](29-delivery-and-acceptance.md) first. Proposed tool names, events and record names below belong to Outpost; they are not claims about upstream APIs.

## Role in Outpost

Expose every useful installed capability to Pi through a consistent local adapter/tool surface while keeping integrations pluggable.

## What the owner sees

Owners discover capabilities by outcome, inspect tools/permissions/health and install or update them. The UI distinguishes installed, connected and authorized.

## Responsibility and boundary

Capability manifests; Pi extension/provider integration; MCP process lifecycle; skill/procedure resources; registry and tool discovery.

Dependencies: [03 Agent commands and processes](03-commands-and-processes.md), [05 Software and capability installation](05-software-and-capability-installation.md), [07 Agent and owner identities](07-identities-and-credentials.md), [22 Ollama Cloud models and Auto reviewer](22-models-and-auto-reviewer.md), [26 Control modes, approvals and trust](26-control-modes-approvals-and-trust.md), [27 Reliability, backups and resources](27-reliability-backups-and-resources.md).

## Complete feature requirements

C = core foundation; E = expansion depth; A = advanced depth. These labels sequence implementation within a balanced product; they do not defer an entire pillar of the first release.

| Feature | Name | Required behavior | Stage |
|---|---|---|---|
| EXT-01 | Pi extension support | Load approved, pinned extensions and skills through the chosen SDK adapter; expose compatible configuration and clear runtime failures. | C |
| EXT-02 | Self-hosted MCP connectors | Run MCP adapters/servers on Ubuntu over stdio or local authenticated transport, expose them to Pi, and mediate their authorized calls to external task services. | E |
| EXT-03 | Simple CLI adapters | Wrap an installed CLI with structured inputs/results, help/discovery, exit handling and capability metadata without needing a new full plugin framework. | C |
| EXT-04 | Capability manifest | Declare tools, dependencies, executable hashes, data destinations, secrets, permissions, update source, licences and smoke tests. | E |
| EXT-05 | Dynamic tool discovery | Search/load only tools relevant to the current step; keep hundreds of integrations from overwhelming a smaller model's context. | C |
| EXT-06 | Capability packs | Bundle software, skills, schemas and tests for coding, browser work, documents, operations, communications or data analysis. | E |
| EXT-07 | In-process trust distinction | Treat Pi extensions as executable trusted code; run less-trusted connectors in separate processes/containers with mediated resources. | C |
| EXT-08 | Permissions on upgrade | Compare changed capabilities/scopes, require owner approval for escalation, and pin the version used by existing jobs until a compatible transition. | E |
| EXT-09 | Local interoperability adapters | Optional ACP engines and agent adapters run on Ubuntu and are exposed to Pi; task import/export or authorized protocol exchange does not outsource execution or expand authority. | A |
| EXT-10 | Owner's private registry | Save verified packs/recipes, stage new versions, inspect provenance and roll back; avoid automatic execution of arbitrary marketplace content. | E |

## How to build it

1. Specify a manifest with versions/digests, executable/image source, schemas, resources, identities, data destinations, required privileges, license and smoke tests. Use proposed Outpost contracts rather than hardcoding one vendor’s CLI configuration.

2. Implement a pinned Pi extension/tool adapter and a local MCP compatibility bridge as required by that Pi version. Keep adapter lifecycle/cancellation/errors visible to the coordinator and load relevant tools into model context.

3. Stage extension updates, validate schema/permission diffs and run conformance probes before activation. Support versioned owner recipes and inspectable adapter health.

## Data and integration contracts

**Server-owned records:** capability_manifests; tool_descriptors; adapter_versions; mcp_connections; skill_versions; health_probes.

**Proposed Pi/tool or client command surface:** `capability.discover; tool.describe; adapter.connect; adapter.probe; skill.load; capability.update`.

**Proposed durable events:** `capability.registered; tool.available; adapter.unhealthy; scope.change_requested; capability.retired`.

Use the shared envelope for task/run/operation identifiers, actor/identity, policy version, idempotency, timestamps and evidence links. Keep secrets behind references. A command acknowledgement means accepted; only the module’s verified result may produce its completed event. Client view preferences are local; business state is not.

## Control modes and sensitive effects

- Tool descriptions, MCP output and skill text do not confer authority. All effectful calls enter the same mode/identity/workflow gate, including nested connectors.
- An agent-authored extension cannot become trusted control-plane code merely by being written to a directory. Privilege-expanding updates remain owner-controlled.

All actual agent work passes through the common mode gate; no shell, browser, nested plugin or schedule gets an alternative approval path. A separately owner-approved payment workflow covers its bounded included steps. The mode/reviewer cannot create such a mandate.

## Failure and recovery

An adapter failure marks its tools unavailable with a reconnect/install next step. Keep last-known-good versions and prevent partial activation of a schema incompatible with queued actions.

## Acceptance and proof

- Install a pack and invoke one newly discovered Pi tool in a real fixture task.
- Upgrade an adapter with changed permissions; decline the escalation and keep the previous version usable.
- Crash an MCP subprocess mid-call and recover without losing cancellation or replaying an external action.

Retain fixture inputs, selected versions, operation/event evidence, expected outcomes and known limitations. Test relevant cases on both clients and repeat sensitive effects only after authoritative reconciliation. Mock screenshots alone do not satisfy these checks.

## Sources and implementation references

These are primary documentation or explicitly pinned local/product references. They inform implementation; the Outpost architecture above is a proposal, not a claim that an upstream package provides this module. See the [source register](30-decisions-and-sources.md) for verification and version rules.

- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [MCP specification](https://modelcontextprotocol.io/specification/latest)
- [OpenCode plugin reference](https://opencode.ai/docs/plugins/)

Product source: [current Outpost plan](../outpost-plan.md). UI source: [native mock](../mock/README.md).
