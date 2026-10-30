# Two-node homelab management

Installed and verified on 2026-10-28. Scope is **K3s and Ansible management**, not distributed Outpost execution.

| Node | Login | LAN address | Role |
|---|---|---|---|
| surajhomeserver | surajadmin | 192.168.1.37 | K3s control plane and schedulable node; GTX 1650 |
| surajhomeserver2 | surajadmin2 | 192.168.1.61 | K3s worker |

Both hosts run Ubuntu 26.04.1 LTS, x86_64. K3s is pinned to `v1.36.5+k3s1`. The main node has Ansible Core 2.20.1, a matching standalone kubectl, and NVIDIA device plugin v0.20.1. Existing Docker, Ollama, PostgreSQL, MinIO, Cloudflare and GitHub runner services were not migrated or restarted.

## Interactive offline guide

Open [`cluster-guide.html`](cluster-guide.html) directly in a browser. It is one self-contained file with embedded fonts, no external requests, no credentials and no server-execution backend. It includes a selectable connection map, four copyable read-only checks, recorded cross-node HTTP evidence and an illustrative Docker/replica/HPA comparison.

From the repository root on your Mac:

```sh
open deploy/homelab/cluster-guide.html
```

To rebuild from `guide.template.html` and run the browser tests using the existing Playwright dependency:

```sh
node deploy/homelab/build-guide.mjs
node deploy/homelab/test-guide.mjs
```

The results in the guide are recorded snapshots, not live monitoring. Existing Docker containers do **not** become Kubernetes workloads or auto-scale merely because the cluster exists.

## Daily management

Log in once:

```sh
ssh surajadmin@surajhomeserver
cluster status
cluster usage
cluster hosts
cluster run 'free -h'
cluster run 'df -h /'
```

`cluster run` uses Ansible's command module, not a shell: pipes, redirections and shell substitutions are not evaluated. Ordinary shell commands still run only on the machine you logged into.

For direct Kubernetes access:

```sh
kubectl get nodes -o wide
kubectl get pods -A -o wide
kubectl top nodes --show-capacity
kubectl top pods -A
```

For a read-only host/service health playbook:

```sh
cd ~/outpost-cluster
ansible-playbook -i inventory.ini health.yml
```

For privileged host maintenance, use Ansible's `--become --ask-become-pass` options on a deliberately scoped playbook or command. No sudo password is stored, and no passwordless-sudo rule was added. Avoid rebooting or upgrading both machines simultaneously.

Login shells export `KUBECONFIG=$HOME/.kube/config`; `~/.local/bin` supplies `cluster` and the standalone `kubectl`. In an existing shell, run `. ~/.profile`, or invoke `~/.local/bin/cluster` directly. Noninteractive SSH commands can use `~/.local/bin/cluster kubectl ...` without sourcing a profile.

## Files and credentials

On the main node:

- `~/outpost-cluster/`: inventory, playbook, manifests, bootstrap source and staged downloads.
- `~/.local/bin/cluster`: convenience commands.
- `~/.local/bin/kubectl`: checksum-verified Kubernetes client.
- `~/.kube/config`: private cluster-admin credential, mode 0600.
- `~/.ssh/outpost-cluster`: private administration key, mode 0600; never mount it into agent containers.
- `~/.ssh/outpost-cluster-known-hosts`: worker host key obtained through an already authenticated SSH connection.

The worker authorizes this management key only from the main node's LAN/Tailscale addresses, with SSH forwarding and PTY disabled. Ansible remains able to run commands. The main host is managed with Ansible's local connection.

Root-owned K3s configuration is at `/etc/rancher/k3s/config.yaml`. The worker's join token is `/etc/rancher/k3s/join-token`, mode 0600. Temporary user-readable join-token files were removed after joining.

`bootstrap-node.sh` is a one-time, host-specific installer and deliberately refuses an existing installation. Its pinned upstream installer SHA256 is checked before execution. It is **not** an upgrade or rollback script.

## Networking and resources

- Reserve **192.168.1.37** and **192.168.1.61** in the router. These are currently DHCP addresses; router configuration was not changed.
- Cluster traffic uses the wired LAN, not Tailscale. Tailscale remains the remote-administration path.
- Pod CIDR: `10.42.0.0/16`; service CIDR: `10.43.0.0/16`.
- UFW remains enabled on the main node and was enabled on the worker after allowing SSH, Tailscale and required cluster traffic.
- LAN cluster ports are scoped to the peer node. Pod forwarding is permitted. No public ingress, router port forwarding, or public inference endpoint was added.
- Traefik and ServiceLB are disabled to avoid conflicts with existing services.
- K3s uses its own containerd; the existing Docker daemon was not reconfigured.
- Host/Kubernetes reservations: main 3 GiB + 768 MiB; worker 1 GiB + 512 MiB, with an additional 300 MiB hard eviction threshold. These reduce schedulable capacity; they are not limits on existing host services.
- Existing swap remains enabled; kubelet is configured to tolerate it. This does not pool RAM or guarantee that workloads cannot run out of memory.
- GPU pods must request `nvidia.com/gpu: 1` and `runtimeClassName: nvidia`. Host Ollama still runs outside Kubernetes, so Kubernetes does not arbitrate its GPU usage. Avoid simultaneous host inference and GPU jobs without explicit coordination.
- The worker link currently negotiates at **100 Mbps**, versus 1 Gbps on the main node. Check its cable, router port and NIC capability before attempting large data transfers or distributed inference.

## Verification performed

- Both nodes reported `Ready`.
- CoreDNS, local-path provisioner, metrics server and GPU device plugin became ready.
- Ansible ping succeeded against both hosts.
- `health.yml` completed with zero failures and zero unreachable hosts.
- A restricted, non-root pod on the worker resolved cluster DNS and fetched `cluster-network-ok` from a service backed by a pod on the main node.
- A restricted GPU test job reported GTX 1650, 4096 MiB VRAM and driver 615.71.09.
- Temporary network/GPU test resources were deleted after verification.
- All eight pre-existing Docker containers remained running, with their original uptimes.

Actual host reboots, disaster recovery, backup restoration and high availability were **not** tested. K3s services are enabled for startup. A single control plane remains a single point of failure. Local-path storage is node-local, not replicated or pooled, and its PVC size is not an enforced filesystem quota. Automatic cluster backups have not been configured.

Pre-change UFW configuration and iptables snapshots are root-only under `/var/backups/outpost-bootstrap/` on each node. Do not blindly restore old firewall snapshots over a running cluster. Do not run the upstream K3s killall/uninstall scripts casually on these shared hosts: they alter networking, and the shipped killall script can also clear Tailscale advertised routes.

## Application work explicitly stopped

Before the operator narrowed the scope to cluster administration, an Outpost image and deployment were prepared. The deployment was subsequently scaled to **zero**, no application pods remained, and `outpost-port-forward.service` was confirmed **disabled and inactive**. Its namespace, PVC, secret, image and staged files were preserved rather than deleted. Application readiness was not established.

**Do not apply `outpost.yaml`, start the forwarding service, or resume application setup without a new instruction.** The active work completed here is infrastructure management only.
