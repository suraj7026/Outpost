#!/usr/bin/env bash
# Run from the staged agent directory on server 1 after uploading the runtime.
set -euo pipefail
umask 077
[[ $(hostname -s) == surajhomeserver ]] || { echo 'Run on server 1' >&2; exit 1; }
cd -- "$(dirname -- "$(readlink -f -- "$0")")"
export KUBECONFIG="$HOME/.kube/config"
k="$HOME/.local/bin/kubectl"
"$k" create namespace outpost-hosts --dry-run=client -o yaml | "$k" apply -f -
"$k" label namespace outpost-hosts pod-security.kubernetes.io/enforce=privileged --overwrite
if [[ ! -f host-token ]]; then openssl rand -hex 32 > host-token; fi
chmod 600 host-token
"$k" -n outpost-hosts create secret generic executor-auth --from-file=token=host-token --dry-run=client -o yaml | "$k" apply -f -
"$k" -n pi-workspace create secret generic outpost-runtime --from-file=host-token=host-token --from-file=pairing-token="$HOME/outpost-cluster/pairing-token" --dry-run=client -o yaml | "$k" apply -f -
"$k" -n outpost-hosts create configmap host-executor --from-file=host-executor.mjs --dry-run=client -o yaml | "$k" apply -f -
# node is not required on the host; the manifest is rendered on the development machine.
"$k" apply -f hosts.json
"$k" apply -f network.yaml
"$k" -n outpost-hosts rollout status deployment/host-main --timeout=180s
"$k" -n outpost-hosts rollout status deployment/host-worker --timeout=180s
"$k" -n pi-workspace patch deployment pi-workspace --type=strategic --patch-file coordinator-patch.json
"$k" -n pi-workspace rollout status deployment/pi-workspace --timeout=180s
mkdir -p "$HOME/.config/systemd/user"
cp outpost-workspace-forward.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now outpost-workspace-forward.service
printf 'Runtime deployed. Complete the private Mac tunnel and client pairing.\n'
