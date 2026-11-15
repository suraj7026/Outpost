"""Read-only host preflight. Emits bounded non-secret facts, never installs anything."""
from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import urllib.error
import urllib.request
from pathlib import Path


def os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    """Read distribution metadata without executing shell expressions."""
    try:
        with path.open() as source:
            text = source.read(16384)
        values = dict(line.split("=", 1) for line in text.splitlines()
                      if "=" in line and not line.startswith("#"))
        return {key: values.get(key, "").strip('"\'')[:80] for key in ("ID", "VERSION_ID")}
    except (OSError, ValueError):
        return {"ID": "", "VERSION_ID": ""}


def descriptor(port: int = 4318) -> tuple[str, dict[str, object] | None]:
    """Inspect only loopback, without proxy variables, redirects or credentials."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        """Reject redirects to any other service or origin."""
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass
    except ConnectionRefusedError:
        return "absent", None
    except OSError:
        return "unreachable", None
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(f"http://127.0.0.1:{port}/v2/environment", timeout=3) as response:
            raw = response.read(32769)
            if len(raw) > 32768:
                return "ambiguous", None
            value = json.loads(raw)
            if not isinstance(value, dict) or value.get("protocolVersion") != 2:
                return "legacy_or_other", None
            return "environment", {
                "environmentId": value.get("environmentId"),
                "release": value.get("runtime", {}).get("release"),
            }
    except urllib.error.HTTPError as error:
        error.close()
        return "legacy_or_other", None
    except (OSError, ValueError, AttributeError):
        return "legacy_or_other", None


def inspect(root: Path = Path("/")) -> dict[str, object]:
    """Report independent runtime and migration signals; absence is conservative."""
    release = os_release(root / "etc/os-release")
    markers = [name for name in (
        "etc/rancher/k3s", "var/lib/rancher/k3s", "usr/local/bin/k3s",
        "srv/remotejobs/pi-workspace", "home/node/.outpost", "opt/outpost",
        "var/lib/outpost", "etc/outpost", "etc/kubernetes", "var/lib/kubelet",
        "var/lib/docker", "var/lib/containerd", "etc/systemd/system/outpost.service",
        "etc/systemd/system/outpost-coordinator.service", "etc/systemd/system/outpost-pi-worker.service",
        "opt/outpost-native", "etc/outpost-native", "var/lib/outpost-native",
    ) if (root / name).exists() or (root / name).is_symlink()]
    container = (root / ".dockerenv").exists() or (root / "run/.containerenv").exists()
    native_present = any((root / name).exists() or (root / name).is_symlink() for name in ('opt/outpost-native', 'etc/outpost-native', 'var/lib/outpost-native'))
    api_port = 4518 if native_present else 4318
    status, environment = descriptor(api_port) if root == Path("/") else ("not_probed", None)
    free = shutil.disk_usage(root).free
    memory = 0
    try:
        with (root / "proc/meminfo").open() as source:
            text = source.read(32768)
        for line in text.splitlines():
            if line.startswith("MemTotal:"):
                memory = int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    sudo = "not_available"
    if root == Path("/") and shutil.which("sudo"):
        try:
            result = subprocess.run(["sudo", "-n", "-l"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
            sudo = "policy_readable" if result.returncode == 0 else "authentication_or_admin_required"
        except (OSError, subprocess.TimeoutExpired):
            sudo = "unknown"
    return {"version": 1, "os": release["ID"], "osVersion": release["VERSION_ID"],
            "architecture": platform.machine(), "systemd": (root / "run/systemd/system").is_dir(),
            "uid": os.getuid(), "freeBytes": free, "memoryBytes": memory,
            "markers": markers, "container": container, "sudo": sudo,
            "api": status, "environment": environment, "apiPort": api_port, "nativePresent": native_present}


if __name__ == "__main__":
    print(json.dumps(inspect(), separators=(",", ":")))
