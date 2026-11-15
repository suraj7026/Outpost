#!/usr/bin/env bash
# One-operation operator wrapper. Run from the Outpost repository on this Mac.
set -euo pipefail

if [[ ! -f desktop/src-tauri/Cargo.toml || ! -f desktop/src-tauri/src/server_restart_operator.rs ]]; then
  printf '%s\n' 'Run this script from the Outpost repository root on the Mac.' >&2
  exit 1
fi

printf '%s\n' \
  'Target: surajhomeserver2; original operation 645f62a9-37c8-413e-b31e-9372bc2ed774.' \
  'Removes only the verified disposable native installation under /opt/outpost-native,' \
  '/etc/outpost-native and /var/lib/outpost-native, plus verified dedicated identities.' \
  'Preserves original evidence, SSH, Tailscale, Kubernetes and unrelated systems.' \
  'The desktop will close. Two protected native authorization prompts may appear.' \
  'No password belongs in this script or command line. Failed checks are never bypassed.' \
  'After confirmed cleanup, a fresh setup is inspected; installation is not started.'

python3 -B - <<'PY'
from pathlib import Path
import json
import subprocess
import sys
import time

root = Path('/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop/server-setup')
records = json.loads((root / 'restart-recovery/journal.json').read_text())['records']
if records:
    sys.exit('An existing reset must be reconciled in Outpost, not repeated with this script.')
binary = '/Users/sudarshanrajagopalan/Applications/Outpost.app/Contents/MacOS/outpost'
probe = subprocess.run(['/usr/bin/pgrep', '-fx', binary.replace('.', r'\.')], capture_output=True, timeout=5)
if probe.returncode == 0:
    subprocess.run(['/usr/bin/osascript', '-e', 'with timeout of 10 seconds', '-e',
                    'tell application "/Users/sudarshanrajagopalan/Applications/Outpost.app" to quit',
                    '-e', 'end timeout'], check=True, timeout=15)
elif probe.returncode != 1:
    sys.exit('Could not inspect the installed app; no reset will run.')
for _ in range(40):
    probe = subprocess.run(['/usr/bin/pgrep', '-fx', binary.replace('.', r'\.')], capture_output=True, timeout=5)
    if probe.returncode == 1:
        print('Outpost closed normally. The native transaction will validate scope before removal.')
        break
    if probe.returncode != 0:
        sys.exit('Could not verify shutdown; no reset will run.')
    time.sleep(0.25)
else:
    sys.exit('Outpost is still running; no reset will run.')
PY

exec env OUTPOST_OPERATOR_RESET=surajhomeserver2 \
  OUTPOST_OPERATOR_OPERATION=645f62a9-37c8-413e-b31e-9372bc2ed774 \
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline --locked --bin outpost \
  transport::server_setup::restart::tests::operator::outpost2_live_destructive_reset_and_read_only_inspect \
  -- --exact --ignored --nocapture --test-threads=1
