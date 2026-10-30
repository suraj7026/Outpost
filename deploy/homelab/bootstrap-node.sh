#!/usr/bin/env bash
set -euo pipefail
umask 077

# One-time bootstrap for these two existing Ubuntu hosts, not a general installer.
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
role=${1:?Expected server or agent}
staging=${2:?Expected absolute staging directory}
version='v1.36.5+k3s1'
installer_hash='46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad'
[[ ! -e /etc/rancher/k3s/config.yaml && ! -e /usr/local/bin/k3s ]] || {
  echo 'Existing K3s detected; inspect it instead of rerunning bootstrap.' >&2; exit 1;
}
case "$role:$(hostname)" in
  server:surajhomeserver)
    ip=192.168.1.37; peer=192.168.1.61; interface=enp7s0
    system_memory=3Gi; kube_memory=768Mi; service=k3s
    ;;
  agent:surajhomeserver2)
    ip=192.168.1.61; peer=192.168.1.37; interface=enp3s0
    system_memory=1Gi; kube_memory=512Mi; service=k3s-agent
    [[ -s "$staging/.join-token" ]] || { echo 'Missing private join token.' >&2; exit 1; }
    ;;
  *) echo 'Role/hostname mismatch.' >&2; exit 1 ;;
esac
ip -4 addr show dev "$interface" | grep -Fq "$ip/24"
printf '%s  %s\n' "$installer_hash" "$staging/install.sh" | sha256sum --check
backup="/var/backups/outpost-bootstrap/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup"
cp -a /etc/ufw "$backup/"
iptables-save > "$backup/iptables.rules"
ip6tables-save > "$backup/ip6tables.rules"
systemctl list-units --type=service --state=running --no-pager > "$backup/services.txt"

# Preserve existing rules. Never disable UFW or change Docker's configuration.
ufw allow OpenSSH
ufw allow in on tailscale0
ufw allow in on "$interface" from "$peer" to "$ip" port 8472 proto udp comment 'Outpost K3s overlay'
ufw allow in on "$interface" from "$peer" to "$ip" port 10250 proto tcp comment 'Outpost K3s metrics'
ufw allow from 10.42.0.0/16 comment 'Outpost K3s pods'
ufw route allow from 10.42.0.0/16 comment 'Outpost K3s pod forwarding'
ufw route allow to 10.42.0.0/16 comment 'Outpost K3s pod return traffic'
if [[ $role == server ]]; then
  ufw allow in on "$interface" from "$peer" to "$ip" port 6443 proto tcp comment 'Outpost K3s API'
fi
ufw --force enable

install -d -m 711 /etc/rancher/k3s
cat > /etc/rancher/k3s/config.yaml <<EOF
node-name: $(hostname)
node-ip: $ip
flannel-iface: $interface
kubelet-arg:
  - fail-swap-on=false
  - system-reserved=cpu=500m,memory=$system_memory
  - kube-reserved=cpu=500m,memory=$kube_memory
  - eviction-hard=memory.available<300Mi,nodefs.available<10%,imagefs.available<15%
node-label:
  - outpost.local/pool=$role
EOF
if [[ $role == server ]]; then
  cat >> /etc/rancher/k3s/config.yaml <<'EOF'
disable:
  - traefik
  - servicelb
secrets-encryption: true
write-kubeconfig-mode: '0600'
tls-san:
  - surajhomeserver
  - 192.168.1.37
  - 100.124.35.7
EOF
else
  install -m 600 "$staging/.join-token" /etc/rancher/k3s/join-token
  cat >> /etc/rancher/k3s/config.yaml <<'EOF'
server: https://192.168.1.37:6443
token-file: /etc/rancher/k3s/join-token
EOF
fi
# Starting separately avoids the installer's broad iptables save/restore pass.
INSTALL_K3S_VERSION="$version" INSTALL_K3S_SKIP_START=true sh "$staging/install.sh" "$role"
systemctl start "$service"
systemctl is-active "$service"
printf 'Bootstrap finished. Firewall backup: %s\n' "$backup"
