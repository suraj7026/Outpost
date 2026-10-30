# Private Outpost agent: deployed two-server architecture

This supersedes the original sandbox-only workspace description for the Outpost agent. Normal interactive development remains non-root; **the configured agent can deliberately execute arbitrary root commands on both hosts**.

## Current layout

The initial provider-worker release `providers-20261030T200757Z` is now deployed. See [deployment verification, backups and limitations](../../docs/implementation/SERVER-PI-PROVIDERS-STATUS.md). Provider packages and OAuth callback relay remain disabled.

- `surajhomeserver`: K3s control plane, existing Ollama daemon, existing Docker applications/runners, authenticated `host-main` root executor.
- `surajhomeserver2`: K3s worker, persistent `pi-workspace` pod with **three containers** (`workspace`, `coordinator`, and restricted `pi-worker`), local Browser-Use/Chromium, authenticated `host-worker` executor.
- Home volume: `/srv/remotejobs/pi-workspace` on worker → `/home/node` in workspace/coordinator. The Pi worker mounts only profile, sessions, task workspaces and read-only runtime subsets, not the full home or ledger. Projects: `/workspace`. Outpost data: `/home/node/.outpost`.
- Selected runtime: `/home/node/.outpost/releases/providers-20261030T200757Z`, mounted read-only at `/opt/outpost`. Both worker and managed CLI use this release and `/home/node/.pi/agent`. Run `pi --outpost-runtime` for identity. `/home/node/outpost-runtime` is retained as the previous runtime, not the active source.
- Browser-Use 0.13.14: `/home/node/server/browser-use/.venv`, managed with `uv` and the committed lockfile. Only `ChatOllama`; `use_cloud=False` browser configuration.
- Pi 1.4.0 routes through the registered `outpost_action` tool. `tools: ['outpost_action']` is intentional: an empty array also disables custom tools in this SDK version. Startup verifies activation.
- Ollama: `http://192.168.1.37:11434/v1`, default `glm-5.3-flash:cloud`. Exact per-task model names are preserved. No substitute models downloaded.
- Private app path: Tauri/Rust → Mac loopback SSH forward → server-1 user port-forward service → pod loopback 4318. No public root/browser endpoint.

## Authority and limits

Executors run privileged with host PID visibility and use `nsenter` into host PID 1's namespaces/root. They require a private token and are exposed through ClusterIP services and a workspace ingress policy. Missing authentication was tested to return 401. Both nodes returned UID 0 and the expected hostname for authenticated read-only commands.

This is **not** an isolation boundary against the agent. Root can read secrets, alter workloads, escape cooperative timeouts, and tamper with logs. Untrusted websites can influence models. Select Ask Permission when you want per-action review. Full control skips those individual approvals by design. Cloud-selected inference sends task/tool/page context to Ollama Cloud, even though the browser is self-hosted.

Local volumes are retained, not replicated or automatically backed up. Pod replacement preserves files, not running processes. No unrelated Docker application migration or CI deployment was performed. Host executors do not pool RAM; existing Ollama still uses its own node.

## Daily commands (server 1)

```sh
~/.local/bin/cluster status
~/.local/bin/workspace
# Detach tmux without stopping work: Ctrl-b, then d
~/.local/bin/workspace exec hostname
~/.local/bin/kubectl -n pi-workspace logs deploy/pi-workspace -c coordinator --tail=100
systemctl --user status outpost-workspace-forward.service
curl -fsS http://127.0.0.1:4318/health
```

**`workspace stop` and deployment/pod restarts also stop Outpost.** The launcher explicitly selects `-c workspace` for interactive commands and logs. Use `-c coordinator` for agent logs. Avoid running the old `provision-main.sh` or applying the original workspace manifest without reapplying this integration patch: they describe the base workspace, not the complete runtime.

Before a planned restart, use the checkpoint-aware `Tasks.prepareMaintenance()` / `finishMaintenance()` workflow documented in the provider status record; merely seeing no running model is insufficient to preserve review-stage task state. A coordinator-only restart avoids killing the interactive workspace container:

```sh
~/.local/bin/kubectl -n pi-workspace exec deploy/pi-workspace -c coordinator -- /bin/kill -TERM 1
# Kubernetes restarts this container. Do not use rollout restart just to reload TypeScript.
```

Interrupted/uncertain effects are not blindly replayed. Inspect evidence before resuming a recovered task. A restart can mark review-stage tasks interrupted under the existing conservative recovery policy.

## Reprovisioning / source updates

`install.sh` expects staging under `~/outpost-agent` on server 1, `hosts.json` rendered by `render-hosts.mjs`, an existing workspace, its runtime source/dependencies already uploaded, and the original pairing token file. Do not print or commit token files. It creates authenticated executors and patches the workspace deployment, which **replaces the pod**.

The coordinator currently runs TypeScript and dependencies from a versioned persistent release, not an immutable application image. Do not edit the active release in place or upload updates to the old `/home/node/outpost-runtime`. Stage a new release, validate the CLI/worker installation identity and worker-only source subset, prepare the maintenance checkpoint, then activate matching read-only mounts. `provider-worker-patch.mjs RELEASE_ID` renders the patch; review and server-side dry-run it before applying. Python worker source is part of that runtime at `/home/node/outpost-runtime/server/browser-use`. Its `uv` project/virtualenv lives separately at `/home/node/server/browser-use`; keep the project manifest and lockfile synchronized when changing dependencies. Use:

```sh
/home/node/.local/bin/uv sync --frozen --project /home/node/server/browser-use --index-url https://pypi.org/simple
```

The original stopped `outpost/outpost-coordinator` deployment, PVC, image, secret, and `~/outpost-cluster/pre-integration-data.tar.gz` remain for recovery. They are **not** a continuously updated backup of the new ledger. Do not run two coordinators against the same data directory.

## Emergency stop

On server 1:

```sh
# Immediately remove the root executors, and stop the agent/workspace.
~/.local/bin/kubectl -n outpost-hosts scale deployment host-main host-worker --replicas=0
~/.local/bin/kubectl -n pi-workspace scale deployment pi-workspace --replicas=0
systemctl --user stop outpost-workspace-forward.service
```

This does not undo completed actions or guarantee termination of host processes deliberately detached by root. Do not use K3s killall/uninstall on these shared hosts; it can disrupt unrelated networking/services. Restore only after reviewing command evidence and the retained storage. Rotate the executor secret in both namespaces together if exposed.

## Recorded validation, not monitoring

- Signed API → Pi → workspace write/read/command → root `id -u; hostname` on each node → Browser-Use on `https://example.com`: actual evidence recorded.
- Browser completion and agent-reported success were true; visited URLs and three PNG captures were retained. Two model action-format errors occurred before recovery, and remain in the JSON artifact. This is one qualified task/model combination, not universal browser reliability.
- The new Rust client's real signed transport passed task creation, idempotent retry and a second Pi turn reading the previously written file.
- Backend regression suite: 37 tests, including active custom tools, inference errors, host opt-in and browser subprocess failures/cancellation. Browser Python: Ruff passed; three contract tests passed using the persistent `uv` environment.
- These results do not prove PR publishing, GitHub credential setup, interactive browser takeover, physical-iPhone connectivity, restore/reboot resilience or automatic backups.
