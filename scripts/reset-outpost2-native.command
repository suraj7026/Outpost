#!/bin/bash
# Visible launcher for the existing one-operation reset; never retries it.
set -uo pipefail
umask 077

cd /Users/sudarshanrajagopalan/Developer/Outpost || exit 1
export PATH="/Users/sudarshanrajagopalan/.cargo/bin:/Users/sudarshanrajagopalan/.pyenv/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log=$(/usr/bin/mktemp .outpost/reset-outpost2-terminal.XXXXXX) || exit 1
printf '%s\n' \
  'Outpost 2 native reset — one guarded attempt, no reinstall.' \
  'Keep Outpost closed until this command finishes.' \
  'Enter the server sudo password only in the protected native dialogs.' \
  'First: Review removal scope. Then, only after a passing review: Remove native installation.' \
  'The removal dialog defaults to Cancel; explicitly click the named removal button.' \
  "Private progress log: $log"

/bin/bash scripts/reset-outpost2-native.sh 2>&1 | /usr/bin/tee "$log"
statuses=("${PIPESTATUS[@]}")
status=${statuses[0]}
if [[ $status -eq 0 && ${statuses[1]} -ne 0 ]]; then
  status=1
fi
if [[ $status -eq 0 ]]; then
  printf '%s\n' 'Guarded reset and fresh read-only inspection completed. No installation was started.' | /usr/bin/tee -a "$log"
else
  printf '%s\n' 'Stopped. Do not assume cleanup completed or rerun automatically; check the result and durable reset journal.' | /usr/bin/tee -a "$log"
fi
printf 'Launcher exit code: %s\n' "$status" | /usr/bin/tee -a "$log"
exit "$status"
