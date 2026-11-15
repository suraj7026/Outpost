#!/bin/bash
# One protected local entry; no password in this launcher, arguments, environment or logs.
set -euo pipefail
cd /Users/sudarshanrajagopalan/Developer/Outpost
umask 077

/Users/sudarshanrajagopalan/.pyenv/shims/python3 -I -B - <<'PY'
from pathlib import Path
import hashlib
source = Path('scripts/outpost2_admin_session.py').read_bytes()
if hashlib.sha256(source).hexdigest() != '6ed8911158af5e90773edf51f761da27bce4618f6e1907fb6bd0cb9653e7312d':
    raise SystemExit('The reviewed authorization helper changed; no password will be requested.')
PY

printf '%s\n' \
  'Outpost 2 — temporary administrator session' \
  'Target: surajadmin2@surajhomeserver2 (verified SSH key).' \
  'Enter the SERVER sudo password once at the prompt below. Typing is hidden.' \
  'This authorizes the agent to diagnose, recover and set up Outpost 2 on this host.' \
  'No cleanup or installation starts merely by opening this window.' \
  'The password stays in this process memory; it is not written to a file or log.' \
  'Leave this window open. Ctrl+C closes access. The session expires after two hours.' \
  'Do not run the old cleanup/reset scripts in parallel.'

exec /Users/sudarshanrajagopalan/.pyenv/shims/python3 -I -B scripts/outpost2_admin_session.py serve
