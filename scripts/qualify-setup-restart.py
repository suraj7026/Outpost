"""Disposable Linux reset qualification; no host mounts, sockets or app installation.

Run: python3 -B scripts/qualify-setup-restart.py
Use --probe-only to check the isolated systemd setup, or --case test_name to select
individual cases. Every case gets a fresh container. Reports go to stdout only.
The image is removed in finally; the stock Ubuntu image/build cache may remain.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shlex
import subprocess
import sys
import tarfile
import time
import uuid
from pathlib import Path

BASE_IMAGE = "ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5"
ROOT = Path(__file__).resolve().parents[1]
TEST = "desktop/src-tauri/src/test_setup_restart_linux.py"
SOURCES = (
    TEST,
    "desktop/src-tauri/src/setup_restart_helper.py",
    "desktop/src-tauri/src/test_setup_restart_helper.py",
    "desktop/src-tauri/src/setup_restart_bootstrap.py",
    "desktop/src-tauri/src/test_setup_restart_bootstrap.py",
    "desktop/src-tauri/src/server_restart.rs",
    "deploy/environment/host_install.py",
    "scripts/repair-outpost2-browser.py",
    "scripts/fixtures/outpost2-original-release.tar.gz",
    "server/browser-engine/launch.py",
)
MARKER = "outpost-disposable-linux-reset-qualification-v1"
DOCKERFILE = f"""FROM {BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive container=docker PYTHONDONTWRITEBYTECODE=1 TMPDIR=/qualification/tmp
RUN apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 update && \
    apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    python3 systemd systemd-sysv dbus acl procps util-linux passwd && \
    rm -rf /var/lib/apt/lists/*
COPY . /qualification/
RUN mkdir /qualification/tmp && printf '%s\\n' '{MARKER}' > /.outpost-reset-qualification && \
    printf '[Unit]\\nDescription=Isolated reset qualification\\nDefaultDependencies=no\\nAllowIsolate=yes\\n' \
    > /etc/systemd/system/qualification.target && chmod 755 /qualification/boot.sh
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/qualification/boot.sh"]
"""
BOOT = """#!/bin/sh
set -eu
if [ "${QUALIFICATION_WRITABLE_CGROUP:-0}" = 1 ]; then
    test "$(cat /proc/self/cgroup)" = '0::/'
    mount --make-rprivate /
    mount -o remount,bind,rw /sys/fs/cgroup
fi
exec /sbin/init --unit=qualification.target --log-target=console
"""


def command(argv: list[str], seconds: int = 30, data: bytes | None = None,
            check: bool = True, show: bool = True) -> subprocess.CompletedProcess:
    """Print exact argv and bound every Docker client process, including cleanup."""
    print("+ " + shlex.join(argv), flush=True)
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=seconds, check=False)
    if show and result.stdout:
        print(result.stdout.decode(errors="replace"), end="", flush=True)
    if check and result.returncode:
        raise RuntimeError(f"Command exited {result.returncode}: {shlex.join(argv)}")
    return result


def build_context() -> tuple[bytes, dict[str, str]]:
    """Copy only required source and pinned nonsecret hotfix fixtures, never app data."""
    files = {path: (ROOT / path).read_bytes() for path in SOURCES}
    hashes = {path: hashlib.sha256(content).hexdigest() for path, content in files.items()}
    files.update({"Dockerfile": DOCKERFILE.encode(), "boot.sh": BOOT.encode()})
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, content in files.items():
            item = tarfile.TarInfo(name)
            item.size, item.mode, item.mtime = len(content), 0o644, 0
            archive.addfile(item, io.BytesIO(content))
    return output.getvalue(), hashes


def main() -> int:
    """Build, probe, execute independent cases and remove every created container."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-only", action="store_true")
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()
    run_id = "outpost-reset-qual-" + uuid.uuid4().hex[:12]
    image = run_id + ":test"
    containers: list[str] = []
    records: list[dict] = []
    context, hashes = build_context()
    print(json.dumps({"sourceSha256": hashes, "baseImage": BASE_IMAGE}, indent=2), flush=True)

    def remove(name: str) -> None:
        """Remove only this run's named container and any anonymous volumes."""
        command(["docker", "rm", "-f", "-v", name], check=False)
        containers.remove(name)

    def launch(suffix: str, elevated: bool, process_audit: bool = False) -> str:
        """Use private namespaces; extra caps are limited to mounts and cross-UID procfs checks."""
        name = run_id + "-" + suffix
        containers.append(name)
        argv = ["docker", "run", "-d", "--name", name, "--label", "outpost.reset.qualification=" + run_id,
                "--network=none", "--cgroupns=private", "--memory=768m", "--cpus=2", "--pids-limit=256",
                "--security-opt=no-new-privileges", "--tmpfs=/run:rw,nosuid,nodev,size=64m",
                "--tmpfs=/tmp:rw,nosuid,nodev,size=32m", "--env", "SYSTEMD_LOG_TARGET=console",
                                "--env", "OUTPOST_RESET_QUALIFICATION=" + MARKER]
        capabilities = []
        if elevated:
            capabilities.append("SYS_ADMIN")
            argv += ["--cap-add=SYS_ADMIN", "--env", "QUALIFICATION_WRITABLE_CGROUP=1"]
        if process_audit:
            capabilities.append("SYS_PTRACE")
            argv += ["--cap-add=SYS_PTRACE"]
        command([*argv, image])
        inspection = json.loads(command(["docker", "inspect", name], show=False).stdout)[0]
        host = inspection["HostConfig"]
        assert not host["Privileged"] and host["NetworkMode"] == "none"
        assert host["CgroupnsMode"] == "private" and host["PidMode"] != "host" and host["IpcMode"] != "host"
        assert not host.get("Binds") and not inspection["Mounts"]
        assert sorted(cap.removeprefix("CAP_") for cap in host.get("CapAdd") or []) == sorted(capabilities)
        print(json.dumps({"isolation": {key: host[key] for key in
              ("Privileged", "NetworkMode", "CgroupnsMode", "PidMode", "IpcMode", "CapAdd", "SecurityOpt", "Tmpfs")}}))
        for _ in range(15):
            result = command(["docker", "exec", name, "/usr/bin/systemctl", "show", "--property=ActiveState",
                              "--value", "qualification.target"], seconds=10, check=False, show=False)
            if result.returncode == 0 and result.stdout.strip() == b"active":
                return name
            time.sleep(0.2)
        command(["docker", "logs", "--tail", "100", name], check=False)
        raise RuntimeError("Isolated systemd did not reach qualification.target")

    try:
        command(["docker", "info", "--format", "{{.OSType}} {{.Architecture}} {{json .SecurityOptions}}"])
        command(["docker", "image", "ls", "--digests"])
        command(["docker", "build", "--pull=false", "--tag", image, "-"], seconds=600, data=context)
        try:
            probe = launch("default-probe", False)
        except RuntimeError as error:
            records.append({"probe": "default-capabilities", "result": str(error)})
            remove(run_id + "-default-probe")
            elevated = True
            probe = launch("private-cgroup-probe", True)
        else:
            elevated = False
        records.append({"probe": "private-cgroup-systemd" if elevated else "default-capabilities", "result": "active"})
        command(["docker", "exec", probe, "/bin/sh", "-c",
                 ("uname -a; systemd --version; python3 --version; cat /proc/self/cgroup; "
                  "findmnt -no TARGET,FSTYPE,OPTIONS /sys/fs/cgroup; dpkg-query -W systemd passwd acl python3")])
        listing = command(["docker", "exec", probe, "/usr/bin/python3", "-I", "-S", "-B",
                           "/qualification/" + TEST, "--list"], show=False)
        available = json.loads(listing.stdout)
        if not args.probe_only:
            for suite, pattern in (("existing-isolated-fixtures", "test_setup_restart_helper.py"),
                                   ("bootstrap-transport-fixtures", "test_setup_restart_bootstrap.py")):
                result = command(["docker", "exec", probe, "/usr/bin/timeout", "--signal=KILL", "120",
                                  "/usr/bin/python3", "-I", "-S", "-B", "-m", "unittest", "discover", "-s",
                                  "/qualification/desktop/src-tauri/src", "-p", pattern, "-v"],
                                 seconds=140, check=False)
                records.append({"suite": suite, "exitCode": result.returncode,
                                "summary": result.stdout.decode(errors="replace").splitlines()[-3:]})
        remove(probe)
        if not args.probe_only:
            names = args.case or available
            if set(names) - set(available):
                raise ValueError("Unknown case: " + repr(set(names) - set(available)))
            for index, test in enumerate(names, 1):
                process_audit = test in {"test_active_owned_units_reset", "test_external_identity_process",
                                         "test_real_reverse_stop_dependencies", "test_component_process_inventory",
                                         "test_uv_locks_external_identity_use_refused",
                                         "test_dracut_nine_external_links_preserved_after_reset",
                                         "test_external_linked_active_reverse_stop_refused_without_hooks",
                                         "test_capsule_exact_prefixed_generic_and_loaded_metadata_preserved_reset",
                                         "test_prefixed_identity_concrete_native_names_and_ids_refused",
                                         "test_escaped_instance_and_benign_alias_metadata_preserved_reset",
                                         "test_nsfs_nonsupport_does_not_skip_external_identity_audit"}
                name = launch(f"case-{index:02d}", elevated, process_audit)
                started = time.monotonic()
                try:
                    result = command(["docker", "exec", name, "/usr/bin/timeout", "--signal=KILL", "360",
                                      "/usr/bin/python3", "-I", "-S", "-B", "/qualification/" + TEST, test],
                                     seconds=380, check=False)
                    reasons = [line for line in result.stdout.decode(errors="replace").splitlines()
                               if line.startswith(("AssertionError:", "qualified_setup_restart.Refused:",
                                                   "PermissionError:", "RuntimeError:"))]
                    records.append({"case": test, "exitCode": result.returncode,
                                    "seconds": round(time.monotonic() - started, 2), "failures": reasons})
                except subprocess.TimeoutExpired:
                    records.append({"case": test, "exitCode": 124, "error": "Docker exec exceeded 380 seconds"})
                finally:
                    remove(name)
    finally:
        for name in containers.copy():
            remove(name)
        command(["docker", "image", "rm", "-f", image], check=False)
        command(["docker", "ps", "-a", "--filter", "label=outpost.reset.qualification=" + run_id])
        changed = [path for path in SOURCES if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != hashes[path]]
        cases = [record for record in records if "case" in record]
        print(json.dumps({"runId": run_id, "results": records, "counts": {
            "run": len(cases), "passed": sum(record["exitCode"] == 0 for record in cases),
            "failed": sum(record["exitCode"] != 0 for record in cases)},
            "sourceChangedDuringRun": changed}, indent=2), flush=True)
    return int(any(record.get("exitCode", 0) != 0 for record in records))


if __name__ == "__main__":
    sys.exit(main())
