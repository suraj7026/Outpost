# Persistent Pi workspace

Separate infrastructure from the Outpost application. No Outpost source, deployment, credentials or host SSH keys are copied into this workspace. Normal SSH logins are unchanged.

## Architecture

- Entry point: `surajadmin@surajhomeserver`, using its existing kubeconfig.
- Execution: one non-root Kubernetes pod pinned to `surajhomeserver2`.
- Tools: Node 24, Pi 1.4.0, Git, build tools, Python 3, tmux, Playwright 1.64.1 and Chromium. npm dependencies are locked in `package-lock.json`.
- CPU: request 2, limit 4. RAM: request 4 GiB, limit 8 GiB, including browser and memory-backed shared memory.
- Persistent home: `/home/node`, backed by `/srv/remotejobs/pi-workspace` on server 2. `/workspace` is a symlink to `/home/node/projects`.
- Static local PV has `Retain` reclaim policy. Its 30 GiB capacity is a scheduling declaration, **not an enforced disk quota**. Monitor the underlying disk.
- One workspace stays on one node. No pooled memory, live migration or storage replication. Loss of server 2 makes this workspace unavailable.

## Initial provisioning

The container image is built on server 1 and exported/transferred privately; there is no public image registry or public service. A one-time sudo operation on server 2 imports the image into K3s and creates the dedicated data directory. It does not install Docker, change sudo rules, or stop existing services.

On server 2, inspect `~/pi-workspace/bootstrap-worker.sh`, then run:

```bash
sudo bash ~/pi-workspace/bootstrap-worker.sh
```

On server 1:

```bash
~/pi-workspace/provision-main.sh
workspace
```

The provisioning script applies only the dedicated namespace, PV/PVC, network policy and deployment, installs the launcher, waits for readiness and tests Pi/Chromium. If setup fails, inspect `kubectl -n pi-workspace describe pods` and `kubectl -n pi-workspace get events --sort-by=.lastTimestamp`. Do not run cleanup/uninstall scripts for the cluster.

## Everyday use

```bash
ssh surajadmin@surajhomeserver
workspace
cd /workspace
# Clone your own project here; nothing was automatically copied.
pi
```

In Pi, use `/login` to connect your own provider account/API key, then `/model`. Credentials and saved Pi sessions are stored under the persistent `~/.pi/agent`; protect this volume and any backups. Do not paste keys into shell history. OAuth providers needing a localhost callback may require explicit SSH plus pod port forwarding; follow the provider's prompt or use API-key authentication.

- Detach while leaving Pi running: **Ctrl-b**, then **d**.
- Reconnect: `workspace` (same tmux session while the pod remains alive).
- New shell: `workspace shell` (this shell is not tmux-protected).
- Placement/status: `workspace status`.
- Run a command: `workspace exec pi --version` or `workspace exec browser-check`.
- Node identity from inside: `echo "$WORKSPACE_NODE"`.
- Stop all workspace processes while retaining files: `workspace stop` (confirmation required).
- Start without attaching: `workspace start`.

SSH disconnection does not stop tmux. A pod restart, OOM, scale-down or node reboot **does** stop its processes. Persistent files and Pi conversation files survive; use `pi --continue` from the original project directory after reopening. Unsaved browser state and active tool execution do not survive.

`workspace exec` passes arguments literally, like Kubernetes exec. To use pipes or shell syntax, explicitly invoke `workspace exec bash -lc 'YOUR COMMAND'`. Its initial directory is `/home/node`; attached shells start in `/workspace`.

## Browser and development servers

`browser-check` launches headless Chromium and writes `/workspace/browser-check.png`. It does not make a model call. Playwright's default Chromium launch disables Chromium's internal sandbox; this is **container isolation, not a hardened browser sandbox**. Avoid unknown hostile sites and treat workspace credentials as exposed to any code running in the workspace. The container is non-root, has no Linux capabilities, uses RuntimeDefault seccomp and has a read-only root filesystem.

CommonJS scripts can `require('playwright')` through the image's `NODE_PATH`. For project-local ESM imports, install the matching Playwright dependency in the project. Pi has its normal shell tool; no browser MCP integration is installed automatically.

For a development server listening on port 3000 inside the pod:

```bash
# Server 1; keep this running:
workspace forward 3000
# Your Mac, in a second terminal; then browse http://localhost:3000:
ssh -N -L 3000:127.0.0.1:3000 surajadmin@surajhomeserver
```

No public ingress or LAN listener is created. Use `kubectl -n pi-workspace cp` on server 1 to explicitly transfer selected files; never mount the host home or Docker socket into the workspace.

## Boundaries and persistence

- No Kubernetes token, kubeconfig, host home, Docker socket, sudo privileges, SSH agent forwarding or existing model credentials are mounted into the pod.
- Network policy denies incoming pod traffic and permits cluster DNS plus public IPv4 egress; private/LAN/Tailscale ranges are excluded. **Kubernetes NetworkPolicy cannot reliably isolate traffic to the pod's own host node**, and is not a full VM/firewall boundary. Ollama on server 1 is not enabled by this policy.
- Anything installed under `/home/node` persists. `npm install -g` uses `~/.local`; Python projects can use venvs under `/workspace`. System packages require rebuilding the image, not sudo inside the workspace.
- `/tmp`, the container filesystem, and shared memory are not persistent.
- Node-local files survive pod replacement, not disk failure. No automated backups are configured. Keep repositories pushed to your own remotes and back up private state separately using encrypted storage.
- Credentials entered through Pi are accessible to Pi and other processes with the same UID. The credential store is not separated from the agent's tools.

## Build and update

Build on server 1 from this directory:

```bash
docker build -t homelab-pi-workspace:1.4.0-1 .
docker save homelab-pi-workspace:1.4.0-1 -o image.tar
sha256sum image.tar > image.tar.sha256
```

Transfer `image.tar`, `image.tar.sha256` and `bootstrap-worker.sh` to server 2 over the dedicated administrative SSH connection. Verify the checksum and run the worker bootstrap script there. For future image updates use a **new unique tag**, change `workspace.yaml`, and import it before applying the deployment. Replacement terminates active workspace processes: save/detach deliberately first. Do not rebuild a mutable tag and expect Kubernetes to refresh it automatically (`imagePullPolicy: Never`).

## Verification

Provisioning was completed and these checks passed (recorded results, not live monitoring):

- Pod Ready on server 2; persistent claim Bound, Retain policy preserved.
- Pi 1.4.0, non-root UID 1000, no effective Linux capabilities, read-only root filesystem, no mounted Kubernetes token/host administrative key, 8 GiB memory limit.
- Public DNS/HTTPS and Chromium loading `https://example.com`.
- Connection attempts to the control-plane LAN/API Service blocked from the workspace. This does not prove complete network isolation; see boundaries above.
- Project files, agent-home test file and browser screenshot survived a deliberate pod replacement.
- Interactive SSH → `workspace` → tmux attachment, Ctrl-b d detachment, and reconnection to the same shell PID. The launcher falls back to xterm-256color for an unset/dumb terminal type.
- Existing eight Docker containers retained their uptime; Outpost deployment remained scaled to zero.

Model authentication and actual model inference were **not** tested: no provider credentials were copied or configured.

Run launcher unit/syntax checks locally with `node deploy/workspace/test-workspace.mjs`. On server 1, run `~/pi-workspace/verify-workspace.sh` for live workspace checks. Use `--restart` **only when you are ready to terminate active workspace processes**; that option also checks persistence across pod replacement. Initial live-check output is recorded in `~/pi-workspace/verification.log`.

## Recovery / rollback

To stop this workspace, scale only `deployment/pi-workspace` in namespace `pi-workspace` to zero. Leave its PVC and PV in place. Removing the namespace/PVC disconnects retained storage and requires deliberate PV rebinding; do not use that as the normal stop operation. Removing the launcher does not stop the pod. Never delete `/srv/remotejobs/pi-workspace` as part of routine cleanup.
