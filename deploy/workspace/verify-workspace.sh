#!/usr/bin/env bash
# Only --restart deliberately replaces the pod, terminating active agents/browsers.
set -euo pipefail
[[ $(hostname -s) == surajhomeserver ]] || { printf 'Run on server 1.\n' >&2; exit 1; }
[[ $# == 0 || ( $# == 1 && $1 == --restart ) ]] || { printf 'Usage: verify-workspace.sh [--restart]\n' >&2; exit 2; }
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
ws="$HOME/.local/bin/workspace"
k() { "$HOME/.local/bin/kubectl" -n pi-workspace "$@"; }
"$ws" start
"$ws" exec bash -ceu '
  test "$WORKSPACE_NODE" = surajhomeserver2
  test "$(id -u)" = 1000
  test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token
  test ! -e "$HOME/.kube/config"
  test ! -e "$HOME/.ssh/outpost-cluster"
  test ! -w /usr/local/bin
  grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
  read -r memory_limit < /sys/fs/cgroup/memory.max
  test "$memory_limit" = 8589934592
  test "$(pi --version)" = 1.4.0
  tmux has-session -t main
  printf "Placement, UID, credential isolation, capabilities, root filesystem, memory limit, Pi and tmux: OK\n"
  curl --fail --silent --show-error --max-time 20 https://registry.npmjs.org/-/ping
  printf "\nPublic HTTPS/DNS: OK\n"
  if curl -k --silent --output /dev/null --connect-timeout 3 --max-time 4 https://192.168.1.37:6443/version; then
    printf "ERROR: unexpected access to the control-plane LAN API\n" >&2
    exit 1
  fi
  if curl -k --silent --output /dev/null --connect-timeout 3 --max-time 4 https://10.43.0.1/version; then
    printf "ERROR: unexpected access to the Kubernetes service API\n" >&2
    exit 1
  fi
  printf "Control-plane LAN and service API connection attempts blocked: OK\n"
'
"$ws" exec browser-check
"$ws" exec node -e '
const {chromium} = require("playwright");
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.goto("https://example.com", {waitUntil: "domcontentloaded", timeout: 30000});
    const title = await page.title();
    if (title !== "Example Domain") throw new Error(`Unexpected title: ${title}`);
    console.log("Live HTTPS page in Chromium: OK");
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
'
if [[ ${1:-} == --restart ]]; then
  marker=$("$ws" exec bash -ceu 'file=$(mktemp /workspace/.persistence-check.XXXXXX); printf "workspace-persistence-ok\n" > "$file"; printf "%s" "$file"')
  agent_marker=$("$ws" exec bash -ceu 'file=$(mktemp "$HOME/.pi/agent/.persistence-check.XXXXXX"); printf "agent-home-persistence-ok\n" > "$file"; printf "%s" "$file"')
  old_uid=$(k get pods -l app=pi-workspace -o jsonpath='{.items[0].metadata.uid}')
  k rollout restart deployment/pi-workspace
  k rollout status deployment/pi-workspace --timeout=180s
  new_uid=$(k get pods -l app=pi-workspace --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.uid}')
  [[ -n "$new_uid" && "$new_uid" != "$old_uid" ]]
  "$ws" exec bash -ceu '
    test "$(< "$1")" = workspace-persistence-ok
    test "$(< "$2")" = agent-home-persistence-ok
    test -s /workspace/browser-check.png
    test "$WORKSPACE_NODE" = surajhomeserver2
    tmux has-session -t main
    rm -- "$1" "$2"
    printf "New pod; workspace files, agent home and browser screenshot persisted: OK\n"
  ' _ "$marker" "$agent_marker"
fi
"$ws" status
printf '\nWorkspace verification passed. Model authentication/inference is not tested.\n'
