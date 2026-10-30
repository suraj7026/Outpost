#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { printf 'Run this script with sudo on server 2.\n' >&2; exit 1; }
[[ $(hostname -s) == surajhomeserver2 ]] || { printf 'Wrong host; expected surajhomeserver2.\n' >&2; exit 1; }
[[ $(findmnt -n -o TARGET --target /srv/remotejobs) == /srv/remotejobs ]] || {
  printf '/srv/remotejobs must be mounted before setup.\n' >&2; exit 1;
}
cd -- "$(dirname -- "$(readlink -f -- "$0")")"
sha256sum -c image.tar.sha256
[[ ! -L /srv/remotejobs/pi-workspace ]] || { printf 'Refusing a symlink as workspace storage.\n' >&2; exit 1; }
if [[ ! -d /srv/remotejobs/pi-workspace ]]; then
  install -d -o 1000 -g 1000 -m 0700 /srv/remotejobs/pi-workspace
elif [[ $(stat -c %u:%g /srv/remotejobs/pi-workspace) != 1000:1000 ]]; then
  printf 'Existing storage has unexpected ownership; inspect before proceeding.\n' >&2
  exit 1
fi
/usr/local/bin/k3s ctr images import image.tar
printf '\nWorker ready. On server 1, run ~/pi-workspace/provision-main.sh, then workspace.\n'
