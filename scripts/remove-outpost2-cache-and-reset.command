#!/Users/sudarshanrajagopalan/.pyenv/shims/python3
"""Visible approved Node cache cleanup followed by one guarded reset attempt."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import uuid

ROOT = Path("/Users/sudarshanrajagopalan/Developer/Outpost")
SETUP = Path("/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop/server-setup")
APP = "/Users/sudarshanrajagopalan/Applications/Outpost.app/Contents/MacOS/outpost"
ALIAS = "outpost-setup-be06c19e-6305-4621-9aa9-8bcce9baf7da"
PIN = SETUP / "be06c19e-6305-4621-9aa9-8bcce9baf7da.known_hosts"
HELPER_SHA256 = "f36c624ebc1b1f817dadce8b5dbdfeb0dd04fbadd111cd7c36ecdeca49a422ec"
SAFETY_SHA256 = "da99c1d4d53f26fbf37f42452ed5b7a31ddd01bb6aa23e793a75db7f1d33b2f2"


def guard() -> None:
    """Never begin or continue across an existing reset or running desktop."""
    if json.loads((SETUP / "restart-recovery/journal.json").read_text())["records"]:
        raise RuntimeError("An existing reset must be reconciled; no retry allowed.")
    probe = subprocess.run(["/usr/bin/pgrep", "-fx", APP.replace(".", r"\.")],
                           capture_output=True, timeout=5)
    if probe.returncode != 1:
        raise RuntimeError("Keep the installed Outpost app closed before this operation.")
    processes = subprocess.run(["/bin/ps", "-axo", "comm="], capture_output=True,
                               text=True, check=True, timeout=5).stdout
    if any("/target/debug/deps/outpost-" in line for line in processes.splitlines()):
        raise RuntimeError("Another native operator is running; do not overlap attempts.")


def main() -> int:
    """Use Terminal's protected sudo input; never capture or log credentials."""
    os.umask(0o077)
    os.chdir(ROOT)
    guard()
    alias, kind, public_key = PIN.read_text().strip().split()
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(
        base64.b64decode(public_key, validate=True)).digest()).decode().rstrip("=")
    if (alias != ALIAS or kind != "ssh-ed25519"
            or fingerprint != "SHA256:nsTF3++XntFP3pfnvBeVVGsUsSMqgsNazw6lI+nA3UI"):
        raise RuntimeError("Unexpected SSH pin; no connection attempted.")
    source = (ROOT / "scripts/remove-outpost2-node-cache.py").read_bytes()
    safety = (ROOT / "scripts/remove-outpost2-stale-uv-lock.py").read_bytes()
    if (hashlib.sha256(source).hexdigest() != HELPER_SHA256
            or hashlib.sha256(safety).hexdigest() != SAFETY_SHA256):
        raise RuntimeError("Reviewed helper changed; no operation attempted.")
    payload = base64.b64encode(source).decode("ascii")
    safety_payload = base64.b64encode(safety).decode("ascii")
    loader = (
        "import base64,hashlib,sys,types; "
        "s=base64.b64decode(" + repr(safety_payload) + "); "
        "c=base64.b64decode(" + repr(payload) + "); "
        "assert hashlib.sha256(s).hexdigest()==" + repr(SAFETY_SHA256) + "; "
        "assert hashlib.sha256(c).hexdigest()==" + repr(HELPER_SHA256) + "; "
        "m=types.ModuleType('outpost2_cleanup_safety'); "
        "sys.modules[m.__name__]=m; "
        "exec(compile(s,'<verified-cleanup-safety>','exec'),m.__dict__); "
        "exec(compile(c,'<approved-cache-removal>','exec'))"
    )
    remote = shlex.join(["sudo", "-p", "Server sudo password (approved Node cache only): ",
                         "--", "/usr/bin/python3", "-I", "-B", "-c", loader,
                         "--approved-surajhomeserver2-node-cache-removal"])
    if len(remote.encode()) >= 65536:
        raise RuntimeError("Approved helper command exceeds its transport budget.")
    ssh = ["/usr/bin/ssh", "-F", "/dev/null", "-tt", "-oBatchMode=yes",
           "-oStrictHostKeyChecking=yes", "-oGlobalKnownHostsFile=/dev/null",
           "-oUpdateHostKeys=no", "-oForwardAgent=no", "-oForwardX11=no",
           "-oPermitLocalCommand=no", "-oControlMaster=no", "-oConnectTimeout=10",
           "-oServerAliveInterval=10", "-oServerAliveCountMax=3",
           '-oUserKnownHostsFile="' + str(PIN) + '"', "-oHostKeyAlias=" + ALIAS,
           "-oIdentitiesOnly=yes", "-i", "/Users/sudarshanrajagopalan/.ssh/surajhomeserver2",
           "-p", "22", "surajadmin2@surajhomeserver2", remote]
    evidence = ROOT / ".outpost" / ("approved-node-cache-" + str(uuid.uuid4()) + ".jsonl")
    with evidence.open("x") as record:
        def event(stage: str, **details: object) -> None:
            """Write only locally constructed, credential-free outcome metadata."""
            record.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                                     "stage": stage, **details}) + "\n")
            record.flush()
            os.fsync(record.fileno())
        event("starting", helperSha256=HELPER_SHA256, safetySha256=SAFETY_SHA256,
              path="/tmp/node-compile-cache", host="surajhomeserver2")
        print("Inspecting and removing only the approved build-owned Node cache if all checks pass.", flush=True)
        print("Keep Outpost closed and do not launch other installation/cleanup commands.", flush=True)
        print("Enter the SERVER sudo password in Terminal below. Typing is hidden.", flush=True)
        print("No password is captured by this launcher or written to its evidence log.", flush=True)
        print("Outcome metadata: " + str(evidence), flush=True)
        try:
            with open("/dev/tty", "rb", buffering=0) as keyboard:
                result = subprocess.run(ssh, stdin=keyboard, timeout=300)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            event("outcomeUnknown", resetStarted=False)
            print("Stopped: inspect the cache and reset journal before any retry. No reset started.", file=sys.stderr)
            return 1
        event("remoteExited", exitCode=result.returncode, resetStarted=False)
        if result.returncode != 0:
            print("The cache operation did not confirm success. No reset will start.", file=sys.stderr)
            return 1
        guard()
        event("cacheAbsenceConfirmed", nextStep="existingGuardedReset")
    print("Approved cache is absent. Starting the existing guarded review/reset once.", flush=True)
    os.execv("/bin/bash", ["/bin/bash", str(ROOT / "scripts/reset-outpost2-native.command")])
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("Stopped: " + str(error), file=sys.stderr)
        raise SystemExit(1)
