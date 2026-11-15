#!/bin/bash
# One explicitly guarded recovery of the existing reset, never a new reset/reinstall.
set -uo pipefail
umask 077
cd /Users/sudarshanrajagopalan/Developer/Outpost || exit 1
export PATH="/Users/sudarshanrajagopalan/.cargo/bin:/Users/sudarshanrajagopalan/.pyenv/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

python3 -B - <<'PY' || exit 1
from pathlib import Path
import hashlib
import json
import subprocess

reset_id = '5e5f59b9-ccaa-4402-ac8d-10fd315978d4'
root = Path('/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop/server-setup')
records = json.loads((root / 'restart-recovery/journal.json').read_text())['records']
if set(records) != {reset_id}:
    raise SystemExit('The exact held reset is required. Do not use this launcher for another operation.')
record = records[reset_id]
if (record['remoteComplete'] or record['localComplete']
        or record['fresh']['id'] != '2e1c768b-fb41-4f33-912e-a86cbc038098'):
    raise SystemExit('The held reset changed or completed. Check its outcome instead of running cleanup.')
digest = hashlib.sha256(Path('desktop/src-tauri/src/setup_restart_helper.py').read_bytes()).hexdigest()
qualification = json.loads(Path('scripts/fixtures/linux-qualification-final-18.json').read_text())
if (digest != 'b47fca46be69ab592314a69b24c96b51e467a8def0ecb2d2e5db8d9aa794fc8d'
        or qualification.get('qualificationPassed') is not True
        or qualification.get('testedHelperSha256') != digest
        or qualification.get('sourcesUnchangedDuringRun') is not True):
    raise SystemExit('The exact qualified helper is required; recovery will not run.')
binary = '/Users/sudarshanrajagopalan/Applications/Outpost.app/Contents/MacOS/outpost'
probe = subprocess.run(['/usr/bin/pgrep', '-fx', binary.replace('.', r'\.')], capture_output=True, timeout=5)
if probe.returncode != 1:
    raise SystemExit('Keep the installed Outpost app closed while recovering this reset.')
processes = subprocess.run(['/bin/ps', '-axo', 'comm='], capture_output=True, text=True, check=True, timeout=5).stdout
if any('/target/debug/deps/outpost-' in line for line in processes.splitlines()):
    raise SystemExit('Another native operator is running; do not overlap recovery attempts.')
print('Verified exact held reset and qualified helper; existing journal and fences are retained.')
PY

log=$(/usr/bin/mktemp .outpost/recover-outpost2-terminal.XXXXXX) || exit 1
printf '%s\n' \
  'Recover the SAME held reset on surajhomeserver2; no installation will start.' \
  'Recovery refuses any prior deletion intent or partial native reset.' \
  'Keep Outpost closed and do not start another setup or cleanup command.' \
  'First dialog: explicitly click Prepare held reset review.' \
  'Second dialog, only if all checks pass: explicitly click Remove native installation.' \
  'BOTH dialogs default to Cancel. Enter the password only in the protected dialogs.' \
  "Private progress log: $log"

env OUTPOST_OPERATOR_RESET=surajhomeserver2 \
  OUTPOST_OPERATOR_OPERATION=645f62a9-37c8-413e-b31e-9372bc2ed774 \
  OUTPOST_OPERATOR_RECOVER=surajhomeserver2 \
  OUTPOST_OPERATOR_RESET_ID=5e5f59b9-ccaa-4402-ac8d-10fd315978d4 \
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline --locked --bin outpost \
  transport::server_setup::restart::tests::operator::recovery::outpost2_live_recover_held_reset_and_read_only_inspect \
  -- --exact --ignored --nocapture --test-threads=1 2>&1 | /usr/bin/tee "$log"
statuses=("${PIPESTATUS[@]}")
status=${statuses[0]}
if [[ $status -eq 0 && ${statuses[1]} -ne 0 ]]; then status=1; fi
if [[ $status -eq 0 ]]; then
  printf '%s\n' 'Same-reset recovery and fresh read-only inspection completed. No installation started.' | /usr/bin/tee -a "$log"
else
  printf '%s\n' 'Stopped. Preserve this reset and its recovery hold; do not rerun cleanup automatically. Check the same reset outcome.' | /usr/bin/tee -a "$log"
fi
printf 'Recovery launcher exit code: %s\n' "$status" | /usr/bin/tee -a "$log"
exit "$status"
