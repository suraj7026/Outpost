#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname -s) == surajhomeserver ]] || { printf 'Run on surajhomeserver.\n' >&2; exit 1; }
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
cd -- "$(dirname -- "$(readlink -f -- "$0")")"
kubectl="$HOME/.local/bin/kubectl"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/outpost-cluster-known-hosts" \
  -i "$HOME/.ssh/outpost-cluster" surajadmin2@192.168.1.61 \
  'test -d /srv/remotejobs/pi-workspace && test -w /srv/remotejobs/pi-workspace' || {
    printf 'Complete ~/pi-workspace/bootstrap-worker.sh on server 2 first.\n' >&2
    exit 1
  }
"$kubectl" apply -f namespace.yaml
"$kubectl" apply --dry-run=server -f workspace.yaml >/dev/null
"$kubectl" apply -f workspace.yaml
install -m 0755 workspace "$HOME/.local/bin/workspace"
"$HOME/.local/bin/workspace" start
"$HOME/.local/bin/workspace" exec pi --version
"$HOME/.local/bin/workspace" exec browser-check
"$HOME/.local/bin/workspace" status
printf '\nReady. Run workspace, then cd /workspace and pi. Use /login inside Pi.\n'
