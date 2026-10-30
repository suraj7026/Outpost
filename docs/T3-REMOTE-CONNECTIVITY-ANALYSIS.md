# T3 Code rescan — Connect, Tailscale, routing, and workload placement

**Rescan date:** 30 October 2026. **Deliverable:** static feature analysis and proposed Outpost tickets, not a deployment or live security/performance qualification.

## 1. Snapshot and scope

The local T3 checkout is now **`2c119bd975deb06f49505a0af3ec8d272806b923`**, dated 29 October 2026, clean, with zero commits behind its locally recorded `origin/main`. The earlier analysis used `cfafb4bb54d244e4612f5681aad3832ea64cb0fb`, dated 16 October, then 2,585 commits behind recorded origin. The checkout changed between reviews; this rescan did **not** fetch, pull, or modify T3. Recorded remote equality is not proof that upstream has no newer commits.

Outpost remains at `e9af7395c8358dbac6e5d3bd28d598b55204c8d3` plus the ongoing documentation backlog. Existing T3 findings in the main analysis remain tied to their original snapshot unless explicitly revisited here. Relative source links resolve against the current sibling checkout; use the recorded commit to reproduce historical evidence.

T3 Connect is implemented **inside `t3code/infra/relay` and the host/client code**, not a separate local `t3connect` checkout. Tailscale was reviewed through T3's integration package and documentation, not through a standalone Tailscale source audit. No servers, VPN settings, tunnels, services, credentials, or live provider accounts were touched. Referenced tests were inspected or located, not executed.

## 2. The four mechanisms that must not be conflated

| Mechanism | What T3 actually does | What it does not establish |
|---|---|---|
| Connection routing/failover | Chooses a working route to the **same environment**: LAN, VPN/Tailscale, public HTTPS, SSH, or Connect | Moving a task to another machine; replicated application state |
| Host load balancing | Opt-in web/desktop placement of a **new thread** on an eligible environment using CPU/memory headroom and preference | Migrating running threads; GPU scheduling; atomic distributed admission; fixed traffic percentages |
| Peer delegation | Explicit agent-to-agent environment link; a remote thread executes work and a follower returns its result | Shared SQLite state, a filesystem sandbox, or blanket authority across machines |
| Provider/account routing | Provider selection/recovery and optional externally configured proxy; pooled usage visibility | T3's usage hub itself becoming an inference load balancer |

This distinction is particularly important for Outpost: its two privileged execution hosts are not automatically two independent Outpost environments. Keep **one authoritative coordinator/ledger** and add constrained worker placement first. Do not put a round-robin HTTP proxy in front of independent SQLite coordinators and call the result high availability.

## 3. T3 Connect: managed reachability, not the execution authority

### Observed behavior

[T3 Connect architecture](../../t3code/docs/internals/t3-connect.md) separates cloud account identity, environment links, managed tunnel allocation, and environment-local authentication. Clerk provides cloud identity; the relay brokers discovery/bootstrap and manages Cloudflare tunnel/DNS resources. After bootstrap, normal HTTP/WebSocket application traffic uses the environment's tunnel hostname, **not an application-session proxy in the relay Worker**. Traffic still traverses Cloudflare's tunnel infrastructure; bypassing the Worker does not imply that no third party participates in transport.

The environment mints a one-time bootstrap credential bound to the client's DPoP key. The client exchanges it at the environment for its own session. Signed requests/responses bind environment identity, nonce, operation, and client proof key. The relay does not receive the resulting environment session token. However, the relay holds signing authority for mint requests: DPoP does not make a compromised broker harmless. See [CloudLink.ts](../../t3code/apps/server/src/cloud/CloudLink.ts) and [EnvironmentConnector.ts](../../t3code/infra/relay/src/environments/EnvironmentConnector.ts).

Managed endpoints expose a validated loopback origin, not arbitrary caller-provided destinations. Health/mint requests do not follow redirects. Allocation generations fence delayed cleanup against a concurrent relink/restart. Unlink revokes authorization before external tunnel/DNS teardown; failed teardown remains recoverable. See [ManagedEndpointProvider.ts](../../t3code/infra/relay/src/environments/ManagedEndpointProvider.ts) and [reaper](../../t3code/infra/relay/src/environments/ManagedEndpointReaper.ts).

The host uses a pinned `cloudflared` release. The documented managed upgrade starts a replacement connector and waits for registration before stopping the old one. Recovery can replace a reclaimed tunnel while retaining the hostname and environment binding. Linking, connector runtime, service installation, and sign-out have separate lifetimes; a saved login is not a running/reachable server.

### Webhook exception

The relay does forward automation webhook requests. Optional offline holding stores raw request bodies **and the token-bearing path** in per-environment Durable Object storage, with expiry, quotas, ordering, and retry. [HookInboxObject.ts](../../t3code/infra/relay/src/hooks/HookInboxObject.ts) treats timeouts as potentially executed and reuses delivery IDs; the destination must deduplicate before dispatch. The relay does not replace destination token/signature verification. This adds a deliberate cloud-data-retention boundary, not just transport resilience.

### Outpost recommendation

[OP-036](tickets/OP-036.md): optional managed remote-access broker, after direct/private access works. Reuse Outpost's existing device identity and exact-action semantics; do not replace them with cloud login. Record desired exposure separately from current connector state, implement reversible link/unlink, and surface tunnel/server/auth failures separately. Start with private Tailscale/SSH for the current homelab; the full managed broker is P2 and an explicit operational/security commitment. Offline webhook holding belongs to OP-004, with opt-in retention and durable delivery deduplication.

## 4. Tailscale: private HTTPS and diagnostics, not a new trust domain

[packages/tailscale/src/tailscale.ts](../../t3code/packages/tailscale/src/tailscale.ts) implements bounded CLI status/prefs queries, MagicDNS discovery, tailnet-address extraction, HTTPS capability reporting, `tailscale serve` enable/disable, and endpoint probing. It reports typed sanitized errors instead of copying raw stderr that might contain auth keys. The HTTPS mapping forwards a tailnet HTTPS address to the local service. CLI-created mappings can persist across restarts; ownership and explicit removal matter.

A `100.64.0.0/10` address alone is **not evidence of Tailscale**: other VPNs use shared address space. T3's [route classification](../../t3code/packages/client-runtime/src/connection/routes.ts) distinguishes generic VPN from confirmed Tailscale. Network membership also does not replace environment authentication.

[Troubleshooting](../../t3code/docs/user/t3-connect-troubleshooting.md) explains a useful failure mode: a Tailscale exit node or other VPN can block outbound port 7844 used by both Cloudflare tunnel protocols, while ordinary web traffic still works. A healthy host or tailnet route is not proof its Connect tunnel is healthy. Host-side reachability tests cannot establish reachability from the user's phone.

**Outpost already uses Tailscale for remote administration** in its [homelab deployment](../deploy/homelab/README.md), with cluster traffic on the wired LAN. Its [desktop transport](../desktop/src-tauri/src/transport.rs) accepts HTTPS or loopback HTTP and currently relies on a private SSH tunnel for the deployed server. [OP-035](tickets/OP-035.md) productizes private HTTPS discovery/setup/status and undo; it does not install a second VPN, enable public Funnel, or loosen the HTTPS requirement. Network/exposure changes remain exact approved actions.

## 5. Stable environment identity and multiple routes

[Remote architecture](../../t3code/docs/internals/remote.md) makes environment identity independent of URL. Saved routes are client-local; projects, threads, credentials, and execution remain owned by their environment. Repository grouping correlates checkouts without merging permissions or files.

The current [driver](../../t3code/packages/client-runtime/src/connection/driver.ts) probes direct descriptors without credentials, gives preferred routes a bounded head start, and walks usable routes until one connects. A descriptor ID check reduces accidental credential disclosure to a reused LAN address, but a public ID is not cryptographic server authentication. Outpost should bind route identity to its trusted server key/TLS policy, not trust a copied identifier alone.

The [supervisor](../../t3code/packages/client-runtime/src/connection/supervisor.ts) checks earlier routes on network/lifecycle events and periodic checks, preflights authorization, and applies cooldowns so a flaky preferred route does not repeatedly displace a healthy connection. One environment owns one connection/retry state machine.

[Learned-route handling](../../t3code/packages/client-runtime/src/connection/routes.ts) can add authenticated host-reported LAN/tailnet addresses, remove stale learned addresses, preserve user-managed routes, and associate borrowed credentials with the route that supplied them. Removing that source removes dependent learned routes. It blocks a learned cleartext bearer downgrade outside allowed transport cases. Outpost should keep its stricter HTTPS-or-loopback rule rather than adopt every permitted upstream exception.

Direct and Connect routes can have **different sessions and permissions**. Route failover therefore requires refreshing the active permission view, not merging the union of grants. Renewable HTTP credentials should not tear down a healthy stream unnecessarily; server-side revocation still wins. See [environment authentication](../../t3code/docs/internals/environment-auth.md).

[OP-034](tickets/OP-034.md) combines stable server identity, route catalogue, safe route switching, permission refresh, and stage-specific diagnostics. It extends OP-018 synchronization rather than creating a separate reconnect loop. Pending signed commands must remain attached to their logical server/action identity across route changes, with no silent resubmission of unknown effects.

## 6. Actual host load balancing: exact behavior and limits

This is implemented code, not just a proposal:

- [chooseLoadBalancedEnvironment](../../t3code/packages/client-runtime/src/load-balancing.ts) selects the maximum score:

  `preferenceWeight × cpuCount × (1 − cpuUtilization) × availableMemoryFraction`

- It excludes missing samples, non-positive/non-finite weights, stale data older than 15 seconds, timestamps over 5 seconds in the future, unknown CPU load, CPU utilization at least 95%, invalid capacities, and available memory at most 5%. Client receipt time is preferred over host sample time to avoid comparing unsynchronized clocks.
- [HostResources.ts](../../t3code/apps/server/src/resourceTelemetry/HostResources.ts) samples CPU deltas over 200 ms, caches results for 5 seconds, and obtains available memory using Linux `MemAvailable`, macOS `vm_stat`, or the platform fallback. These are upstream implementation choices, not validated Outpost thresholds.
- [Draft routing](../../t3code/apps/web/src/components/chat/useDraftEnvironmentRouting.ts) filters connected grouped-project environments for an enabled/installed/authenticated/available selected provider and compatible referenced-thread locality. It pins the chosen draft environment once resolved.
- [The hook](../../t3code/apps/web/src/hooks/useLoadBalancedEnvironment.ts) is mounted for unresolved automatic drafts, avoiding constant idle polling. [Settings](../../t3code/apps/web/src/components/settings/LoadBalancingSettings.tsx) map Manual only / Less often / Normal / Prefer to weights 0 / 25 / 50 / 100.
- [User documentation](../../t3code/docs/user/remote-access.md) explicitly says auto-balance is off by default, preferences are per-client, existing threads stay put, and mobile remains manual. Attachments and explicit branch/worktree choices constrain or lock placement. No eligible capacity means ask for manual selection rather than silently choosing a saturated machine.

This is a **client-side new-thread placement heuristic**, not a transactionally reserved fleet scheduler. Two clients can observe the same free headroom. CPU/memory utilization is not GPU/VRAM availability, model-server concurrency, account quota, or permission to run a task. It also does not synchronize branches, uncommitted changes, dependencies, or secrets across grouped checkouts.

**Outpost adaptation: [OP-037](tickets/OP-037.md).** Keep selection/admission server-owned. Offer Manual only / Prefer / Auto controls but combine metrics with explicit capability/workspace eligibility, queued reservations, model/browser/host concurrency, data locality, and optional verified GPU telemetry. Pin running tasks; switching ownership requires a separately designed handoff, not route failover. Begin with the two known worker hosts and one coordinator. Never use host count as evidence that coordinator HA exists.

## 7. Linked environments and remote subagents

[PeerLinks.ts](../../t3code/apps/server/src/peer/PeerLinks.ts), [PeerForwarding.ts](../../t3code/apps/server/src/peer/PeerForwarding.ts), and [RemoteDelegation.ts](../../t3code/apps/server/src/peer/RemoteDelegation.ts) implement explicit environment links and remote tasks. Links are a beta with feature gates on both ends. The caller's modes narrow the destination link grant; forwarding namespaces idempotency keys so different agents sharing one link cannot collide. Waits are chunked for tunnel idle limits.

Restricted links stamp launched threads and descendants with immutable origin and constrain mutations to work created by that link; project setup scripts are skipped for restricted work. Full-access links are deliberately not confined, and the documentation says reads are not fenced by that origin rule. **Routing is not isolation:** agents execute as the destination environment's OS user.

Remote delegation resolves a unique matching repository project or requires an explicit destination; missing and ambiguous matches fail instead of choosing arbitrarily. A follower reconnects to remote work after restart and wakes the parent through the ordinary completion machinery. This does not mean live process migration. The inspected `delegate_task` path rejects `isolation: "worktree"` for remote delegation; a different explicit remote thread-launch/workspace strategy is needed. Do not assume all local subagent isolation flags work remotely.

[OP-038](tickets/OP-038.md) extends Outpost's OP-026–OP-029 subagent contracts with explicit remote identity, least-privileged delegated grants, destination admission, correlated receipts, bounded result following, and cancellation. It is separate from OP-015's generic execution-node capability and OP-037's single-coordinator host placement. Full independent-environment federation is P2, not necessary to balance the current two hosts.

## 8. SSH/bootstrap, background service, and operational protection

[SSH ownership](../../t3code/packages/ssh/src/tunnel.ts) distinguishes a server launched by the client from one merely discovered: cleanup must not kill someone else's server. Reconnection restores the forward before application transport. T3 documents remote runtime download and verification; exact platform support should not be broadened by assumption.

[Background services](../../t3code/docs/user/background-service.md) separate install/status/restart/uninstall from Connect login. Updates can be staged without immediately restarting active work; uninstall retains user data. Linux services can survive logout with appropriate user-service configuration; macOS services require a logged-in awake user. These are not interchangeable availability guarantees.

The current Linux [service protection](../../t3code/apps/server/src/cloud/serviceProtection.ts) addresses agent-induced memory pressure and can include the server, SSH, and Tailscale so administrative access survives. It is an explicit privileged change with undo, not an automatic reason to rewrite system cgroups or firewall settings. T3 also supports a remote-only desktop; Outpost already has a server-owned desktop architecture, so copying a toggle for disabling a bundled local server is unnecessary today.

[OP-039](tickets/OP-039.md) covers ownership-safe tunnel/service management, staged updates, resource-protection plans, and redacted connection diagnostics. Reuse Outpost's existing deployment/service owners; do not start competing daemons from the client.

## 9. Provider hubs, pooled limits, and inference routing

[Usage documentation](../../t3code/docs/user/usage.md) and [UsageLimitSources.ts](../../t3code/apps/server/src/usage/UsageLimitSources.ts) show an explicit CLIProxyAPI usage-source integration with an environment-owned URL/management key, account reads, serialized refresh, and optional reset-credit redemption. The documentation explicitly states: **this supplies usage information; configure the provider separately to send agent requests through the hub**.

The same account reported by multiple hosts/hubs should count once. Cost estimates remain distinct from subscription billing; missing/stale windows and exhausted weekly allowances affect what capacity can truthfully be shown. T3 also has draft-provider fallback presentation in [ChatView.ts](../../t3code/apps/web/src/components/ChatView.tsx); that should not be conflated with a claim that all live inference requests automatically rebalance among accounts.

[OP-040](tickets/OP-040.md) adds optional hub/endpoint inventory, deduplicated pooled-quota visibility, and explicitly approved inference-pool policy. It extends OP-003 and OP-033, not host placement. Outpost must record resolved endpoint/account/model, respect provider terms and data boundaries, and never rotate accounts to evade access restrictions or replay uncertain tool effects after a provider failure. Proxy load balancing itself remains external or a separately reviewed adapter, not a feature proven by T3's usage integration.

## 10. Priorities, exclusions, and qualification

**P1:** OP-034 stable identity/routes, OP-035 private Tailscale HTTPS, OP-037 server-owned worker placement, OP-039 ownership-safe operations. Develop telemetry and admission first; controls must not make remote access less secure than today's signed commands/private tunnel.

**P2:** OP-036 managed Connect-style broker, OP-038 independent-environment delegation, OP-040 optional provider hubs/pooling. These are real product/operations expansions; do not make Cloudflare, Clerk, T3 accounts, or subscription proxies requirements for basic Outpost use.

Merge related findings into OP-004 (offline webhook delivery), OP-012 (remote browser control/ownership), OP-013/OP-017 (staged diagnostics/metrics), OP-018 (route-aware synchronization), and OP-033 (cross-account totals), rather than duplicating their implementation effort.

Before implementation, decide the server identity/pinning scheme, allowed transports, service owner, resource reservation model, workspace readiness contract, remote authority envelope, and optional broker data-retention policy. Before release, exercise route flapping, wrong-host addresses, credential expiry, cross-route permission changes, concurrent placement, stale telemetry, partitioned workers, service update interruption, and webhook timeout/deduplication. Existing upstream tests are useful fixtures, not proof that Outpost passes these cases.

Do **not** claim transparent running-task migration, replicated SQLite HA, automatic GPU scheduling, guaranteed exactly-once external effects, or provider-pool balancing based on these sources. No live traffic benchmarks, broker deployment, VPN configuration, or failover rehearsals were performed in this rescan.
