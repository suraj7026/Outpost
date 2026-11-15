"""Destructive tests ONLY for the opt-in disposable Docker qualification image.

Run from the workspace: python3 -B scripts/qualify-setup-restart.py
Normal unittest discovery skips this class, including on macOS as root. Each
case needs a fresh container; fixtures use the real '/' and real NSS/systemd.
No FakeRunner, account substitution, ACL substitution or mount-list injection.
Only crash injection, post-scan replacement races and the fresh installer's
preflight safety tripwire are subclassed. No ACL or account audit is substituted.
Neither the real installer stages nor an application are installed.
"""
from __future__ import annotations

import ast
import base64
import copy
import ctypes
import errno
import grp
import hashlib
import importlib.util
import io
import json
import os
import pwd
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import unittest
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType

MARKER = "outpost-disposable-linux-reset-qualification-v1"
SOURCE = Path(__file__).resolve().parent
REPOSITORY = SOURCE.parents[2]
SAFE_CONTAINER = (
    sys.platform == "linux" and os.geteuid() == 0
    and os.environ.get("OUTPOST_RESET_QUALIFICATION") == MARKER
    and Path("/.dockerenv").is_file()
    and Path("/.outpost-reset-qualification").is_file()
    and Path("/.outpost-reset-qualification").read_text().strip() == MARKER
)


def require_container() -> None:
    """Fail before any destructive operation unless all independent guards agree."""
    if not SAFE_CONTAINER or Path("/proc/1/comm").read_text().strip() != "systemd":
        raise RuntimeError("Use the disposable Docker harness; never execute against a host root")
    if Path("/var/run/docker.sock").exists():
        raise RuntimeError("Docker socket passthrough is forbidden")


def module(name: str, path: Path) -> ModuleType:
    """Load trusted copied source without relying on site packages or PYTHONPATH."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load copied qualification source")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


helper = module("qualified_setup_restart", SOURCE / "setup_restart_helper.py")


def run(argv: list[str], *, data: bytes | None = None, seconds: int = 30,
        check: bool = True) -> subprocess.CompletedProcess:
    """All Linux commands are bounded and shell-free."""
    require_container()
    result = subprocess.run(argv, input=data, capture_output=True, timeout=seconds, check=False)
    if check and result.returncode:
        raise AssertionError(f"{argv!r}: exit {result.returncode}\n{result.stdout.decode(errors='replace')}"
                             f"\n{result.stderr.decode(errors='replace')}")
    return result


def write(path: Path | str, content: bytes, mode: int = 0o644) -> Path:
    """Create a fixture only under the guarded container root."""
    require_container()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    path.write_bytes(content)
    path.chmod(mode)
    return path


def snapshot(paths: list[Path]) -> dict:
    """Compare preserved bytes/inodes/ownership/modes, excluding read atimes and link counts."""
    result = {}
    for path in paths:
        info = path.lstat()
        result[str(path)] = (info.st_dev, info.st_ino, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid,
                             path.read_bytes() if path.is_file() else None)
    return result


def packet_result(packet: dict, *, unprivileged: bool = False) -> dict:
    """Exercise the unchanged CLI; return an empty mapping for stop's verified empty stdout."""
    argv = ["/usr/bin/python3", "-I", "-S", "-B", str(SOURCE / "setup_restart_helper.py")]
    if unprivileged:
        argv = ["/usr/bin/setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", *argv]
    result = run(argv, data=helper.encoded(packet), seconds=320)
    if packet["mode"] == "stop":
        if result.stdout:
            raise AssertionError("Stop must not return completion data")
        return {}
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise TypeError("Helper must return a JSON object")
    print("HELPER " + json.dumps(value, sort_keys=True), flush=True)
    return value


def property_value(unit: str, name: str) -> str:
    """Read effective systemd state from PID 1, not a fixture dictionary."""
    return run(["/usr/bin/systemctl", "show", "--property=" + name, "--value", "--", unit]).stdout.decode().strip()


def wait_inactive(unit: str) -> None:
    """Bound cooperative cancellation completion independently of helper success."""
    for _ in range(60):
        if property_value(unit, "ActiveState") in ("inactive", "failed"):
            return
        time.sleep(0.1)
    raise AssertionError("Fixture service did not settle after cooperative cancellation")


@unittest.skipUnless(SAFE_CONTAINER, "requires the isolated Docker qualification harness")
class LinuxResetTests(unittest.TestCase):
    """Real root filesystem, actual account tools and live systemd safety qualification."""

    def setUp(self) -> None:
        """Build a failed4/12 installation without running an application or installer."""
        require_container()
        self.assertTrue(all(not Path(path).exists() for path in (*helper.ROOTS, helper.BASE)))
        self.expected = {
            "operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4()),
            "releaseId": "host-" + "a" * 20, "deviceId": str(uuid.uuid4()),
            "publicKey": base64.b64encode(b"q" * 32).decode(), "size": 1, "sha256": "a" * 64,
        }
        self.request = {"mode": "review", "resetId": str(uuid.uuid4()), "expected": self.expected}
        self.operation = Path(helper.OPERATIONS) / self.expected["operationId"]
        self.release = Path(helper.ROOTS[0]) / "releases" / self.expected["releaseId"]
        self.source = {
            "host-manifest.json": helper.encoded({"id": self.expected["releaseId"], "layoutVersion": 1, "protocolVersion": 2}),
            "package.json": b'{"name":"disposable-fixture"}',
            "deploy/environment/host_install.py": b'raise AssertionError("INSTALLED CODE MUST NEVER EXECUTE")\n',
            "server/main.ts": b"throw Error('fixture must not execute');\n",
            "server/pi-worker/main.ts": b"throw Error('fixture must not execute');\n",
            "deploy/agent/host-executor.mjs": b"throw Error('fixture must not execute');\n",
        }
        archive_buffer = io.BytesIO()
        with tarfile.open(fileobj=archive_buffer, mode="w:gz") as archive:
            for name, content in self.source.items():
                item = tarfile.TarInfo(name)
                item.size = len(content)
                archive.addfile(item, io.BytesIO(content))
        archive_bytes = archive_buffer.getvalue()
        self.expected.update(size=len(archive_bytes), sha256=hashlib.sha256(archive_bytes).hexdigest())
        self.original = {**self.expected, "label": "private-fixture-canary", "browser": True,
                         "coexistence": True, "fullControl": False}
        self.progress = {**{key: self.expected[key] for key in helper.IDENTITIES}, "state": "failed",
                         "completedSteps": 4, "totalSteps": 12, "startedAt": 1, "updatedAt": 2,
                         "stage": "Browser runtime", "log": ["private-log-canary"], "error": "fixture failure"}
        run(["/usr/sbin/groupadd", "--system", "outpost-workspaces"])
        for user in helper.USERS:
            run(["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent",
                 "--shell", "/usr/sbin/nologin", user])
        for user in helper.USERS[:2]:
            run(["/usr/sbin/usermod", "--append", "--groups", "outpost-workspaces", user])
        self.identities = {name: pwd.getpwnam(name) for name in helper.USERS}
        self.group_ids = {name: grp.getgrnam(name).gr_gid for name in helper.GROUPS}
        for path in (self.release, Path(helper.ROOTS[1]), Path(helper.ROOTS[2]), self.operation / "build-home"):
            path.mkdir(parents=True, mode=0o755)
        for directory, account in (("worker", "outpost-pi"), ("coordinator", "outpost-coord"), ("workspaces", "outpost-coord")):
            path = Path(helper.ROOTS[2]) / directory
            path.mkdir(mode=0o700)
            identity = self.identities[account]
            os.chown(path, identity.pw_uid, self.group_ids["outpost-workspaces"] if directory == "workspaces" else identity.pw_gid)
            if directory == "workspaces":
                path.chmod(0o2770)
        for name, content in self.source.items():
            write(self.release / name, content)
            write(self.operation / "source" / name, content)
        write(self.release / "node_modules/fixture/index.js", b"must never execute\n")
        write(self.operation / "request.json", helper.encoded(self.original), 0o600)
        write(self.operation / "release.tar.gz", archive_bytes, 0o600)
        write(self.operation / "status.json", helper.encoded(self.progress))
        write(self.operation / "launch.json", b'{"returnCode":0}')
        write(self.operation / "cancel", b"", 0o600)
        write(self.operation / "command.log", b"private-command-canary\n", 0o600)
        write(self.operation / "build-home/cache", b"retained build cache\n", 0o600)
        build = self.identities["outpost-build"]
        for path in (self.release, *self.release.rglob("*"), self.operation / "build-home", self.operation / "build-home/cache"):
            os.chown(path, build.pw_uid, build.pw_gid)
        write(Path(helper.BASE) / "install.lock", b"do-not-truncate\n", 0o600)
        task = write(Path(helper.ROOTS[2]) / "worker/task", b"disposable native task\n", 0o600)
        os.chown(task, self.identities["outpost-pi"].pw_uid, self.identities["outpost-pi"].pw_gid)
        write(Path(helper.ROOTS[1]) / "coordinator.env", b"TOKEN=private-token-canary\n", 0o600)
        self.sentinels = [write(path, b"outside sentinel\n", 0o600) for path in (
            "/etc/kubernetes/qualification", "/var/lib/docker/qualification", "/opt/outpost/qualification",
            "/var/lib/outpost/qualification", "/etc/tailscale/qualification", "/home/ssh/.ssh/id_ed25519",
            "/opt/outpost-native-peer/qualification", "/srv/qualification/outside",
        )]
        peer = Path(helper.OPERATIONS) / str(uuid.uuid4())
        self.sentinels.append(write(peer / "status.json", helper.encoded({"operationId": peer.name, "completedSteps": 0, "state": "failed"})))
        self.evidence_paths = [path for path in self.operation.rglob("*") if path.is_file()]
        self.preserved = snapshot([*self.sentinels, *self.evidence_paths])
        self.lock_stat = (Path(helper.BASE) / "install.lock").stat()
        self.children: list[subprocess.Popen] = []
        self.mounts: list[Path] = []
        self.addCleanup(self.cleanup_processes_and_mounts)
        descriptor = os.open("/", helper.TRAVERSE_FLAGS)
        self.addCleanup(os.close, descriptor)
        self.agent = helper.Helper(helper.Files(descriptor), helper.SystemRunner(), helper.SystemAccounts(), True)

    def cleanup_processes_and_mounts(self) -> None:
        """Reap fixture children and unmount only targets created by this test."""
        for process in self.children:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        for target in reversed(self.mounts):
            run(["/usr/bin/umount", "--", str(target)], check=False)

    def review(self) -> dict:
        """Return an actual CLI review."""
        value = packet_result(self.request)
        self.assertIsInstance(value, dict)
        return value

    def allowed(self) -> dict:
        """A positive precondition must pass before adversarial changes are tested."""
        value = self.review()
        if not value["canReset"]:
            for unit in (*helper.UNITS, "outpost-setup-" + self.expected["operationId"] + ".service"):
                result = run(["/usr/bin/systemctl", "show", "--all", "--no-pager",
                              "--property=" + ",".join(helper.PROPERTIES), "--", unit], check=False)
                values = dict(line.split("=", 1) for line in result.stdout.decode().splitlines())
                print("SYSTEMD_CONTRACT " + json.dumps({"unit": unit, "exitCode": result.returncode,
                      "missing": sorted(set(helper.PROPERTIES) - set(values)), "values": values}), flush=True)
        self.assertTrue(value["canReset"], value["blockers"])
        return value

    def apply(self, review: dict) -> dict:
        """Apply exactly the bound snapshot through the production stdin protocol."""
        return packet_result({**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]})

    def blocked(self, fragment: str) -> dict:
        """Refusal must preserve native state, evidence and real identities without intent."""
        value = self.review()
        self.assertFalse(value["canReset"], value)
        self.assertIn(fragment, " ".join(value["blockers"]))
        self.assertFalse(Path(helper.RESETS).exists())
        self.assertTrue(all(Path(path).exists() for path in helper.ROOTS))
        for name, expected in self.identities.items():
            self.assertEqual(pwd.getpwnam(name), expected)
        self.assertEqual(snapshot(self.sentinels), {str(path): self.preserved[str(path)] for path in self.sentinels})
        return value

    def assert_complete(self, result: dict) -> dict:
        """Assert real deletion, evidence retention and actual user/group disappearance."""
        self.assertEqual(result["state"], "complete", result)
        self.assertTrue(all(not Path(path).exists() for path in helper.ROOTS))
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))
        for name in helper.USERS:
            with self.assertRaises(KeyError):
                pwd.getpwnam(name)
        for name in helper.GROUPS:
            with self.assertRaises(KeyError):
                grp.getgrnam(name)
        lock = Path(helper.BASE) / "install.lock"
        self.assertEqual(lock.stat().st_ino, self.lock_stat.st_ino)
        self.assertEqual(lock.read_bytes(), b"do-not-truncate\n")
        reset = Path(helper.RESETS) / self.request["resetId"]
        audit = json.loads((reset / "audit.json").read_text())
        self.assertEqual(audit["state"], "complete")
        self.assertEqual(stat.S_IMODE((reset / "audit.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((reset / "status.json").stat().st_mode), 0o644)
        steps = [item["step"] for item in audit["steps"]]
        self.assertTrue(all(item["state"] == "complete" for item in audit["steps"]))
        self.assertTrue(all("userdel:" + user in steps for user in helper.USERS))
        self.assertIn("groupdel:outpost-workspaces", steps)
        print("ACTUAL_AUDIT_STEPS " + json.dumps(steps), flush=True)
        return audit

    def services(self, *, active: bool = False) -> None:
        """Load exact owned unit text; optional processes are sleep stubs, never the app."""
        self.original["fullControl"] = True
        self.progress.update(state="ready", completedSteps=10)
        write(self.operation / "request.json", helper.encoded(self.original), 0o600)
        write(self.operation / "status.json", helper.encoded(self.progress))
        write(Path(helper.ROOTS[1]) / "installation.json", helper.encoded({
            "schema": 1, "layoutVersion": 1, "environmentId": self.expected["environmentId"],
            "release": self.expected["releaseId"], "apiPort": 4518,
            "operationId": self.expected["operationId"], "fullControl": True,
        }))
        (Path(helper.ROOTS[0]) / "current").symlink_to(self.release)
        for name, content in helper.unit_texts(self.expected["releaseId"], True).items():
            write(Path(helper.UNIT_DIR) / name, content)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "enable", "--", *helper.UNITS])
        if active:
            write(self.release / "node/bin/node", b"#!/bin/sh\nexec /usr/bin/sleep 240\n", 0o755)
            for name in ("worker", "coordinator", "host"):
                write(Path(helper.ROOTS[1]) / (name + ".env"), b"", 0o600)
            run(["/usr/bin/systemctl", "start", "--", *helper.UNITS])
            for unit in helper.UNITS:
                self.assertEqual(property_value(unit, "ActiveState"), "active")
        self.preserved = snapshot([*self.sentinels, *self.evidence_paths])

    def session_packet(self, packet: dict, scope: str, poison: str = "none") -> dict:
        """Run in a real distinct systemd login-shaped scope, verified from the child's procfs."""
        result = run(["/usr/bin/systemd-run", "--scope", "--quiet", "--collect", "--unit=" + scope,
                      "--slice=user-0.slice", "--", "/usr/bin/python3", "-I", "-S", "-B", str(Path(__file__).resolve()),
                      "--session-packet", scope, poison], data=helper.encoded(packet), seconds=320)
        value = json.loads(result.stdout)
        self.assertIsInstance(value, dict)
        for _ in range(100):
            if not (Path("/run/systemd/transient") / scope).exists():
                break
            time.sleep(0.1)
        else:
            self.fail("Disposable session declaration was not collected after its process exited")
        return value

    def recovery_packet(self, review: dict) -> dict:
        """Use exactly the private native recovery wire contract, with no path overrides."""
        return {**self.request, "mode": "recover_apply", "snapshotDigest": review["snapshotDigest"],
                "recoveryToken": review["recoveryToken"]}

    def test_real_cpu_weight_atomic_rewrites_preserved_through_reset(self) -> None:
        """Real property-file replacement changes inodes, never scope, values or native safety checks."""
        files = {}
        for name, weight in (("besteffort", 1), ("burstable", 100)):
            path = Path("/run/systemd/transient/kubepods-" + name + ".slice.d/50-CPUWeight.conf")
            files[path] = b"# Generated property fixture.\n\n[Slice]\nCPUWeight=" + str(weight).encode() + b"\n"
            write(path, files[path])
        review = self.allowed()
        path = next(iter(files))
        write(path, files[path].replace(b"CPUWeight=1", b"CPUWeight=2"))
        changed = self.apply(review)
        self.assertEqual(changed["state"], "failed", changed)
        self.assertIn("snapshot changed", changed["message"])
        for extra in ("Group=" + str(self.identities["outpost-build"].pw_gid) + "\n",
                      "[Unit]\nRequires=user@" + str(self.identities["outpost-build"].pw_uid) + ".service\n"):
            write(path, files[path] + extra.encode())
            self.assertEqual(self.apply(review)["state"], "failed")
            self.assertFalse(Path(helper.RESETS).exists())
            self.assertTrue(all(Path(root).exists() for root in helper.ROOTS))
        write(path, files[path])
        for path, raw in files.items():
            before = path.lstat()
            temporary = write(path.with_name(".fixture-CPUWeight.next"), raw)
            os.utime(temporary, ns=(before.st_atime_ns, before.st_mtime_ns + 2_000_000_000), follow_symlinks=False)
            os.replace(temporary, path)
            after = path.lstat()
            self.assertNotEqual(before.st_ino, after.st_ino)
            self.assertNotEqual(before.st_mtime_ns, after.st_mtime_ns)
            self.assertEqual((before.st_dev, before.st_mode, before.st_uid, before.st_gid, before.st_nlink, before.st_size),
                             (after.st_dev, after.st_mode, after.st_uid, after.st_gid, after.st_nlink, after.st_size))
        retained = snapshot(list(files))
        self.assertEqual(self.allowed()["snapshotDigest"], review["snapshotDigest"])
        self.assert_complete(self.apply(review))
        self.assertEqual(snapshot(list(files)), retained)
        self.assertEqual({path: path.read_bytes() for path in files}, files)
        print("CPU_WEIGHT_ATOMIC_REWRITE " + json.dumps({"paths": [str(path) for path in files],
              "stableReview": True, "changedValueRefused": True, "nativeReferencesRefused": True,
              "propertiesPreserved": True}), flush=True)

    def test_real_cpu_weight_postscan_acl_replacement_refuses_before_intent(self) -> None:
        """A real same-mode replacement with named native ACLs must fail before any deletion intent."""
        class AfterScanFiles(helper.Files):
            """Inject fixture replacement only after the unchanged real external scan returns."""

            def __init__(self, descriptor: int, after_scan: Callable[[], None]) -> None:
                super().__init__(descriptor)
                self.after_scan = after_scan

            def outside_ownership(self, uids: set[int], gids: set[int], exemptions: list[str], *, reserve_nodes: int = 0) -> None:
                super().outside_ownership(uids, gids, exemptions, reserve_nodes=reserve_nodes)
                if reserve_nodes:
                    self.after_scan()

        def declaration_metadata(directory: Path) -> dict:
            """Verify portable metadata without following links; inode/device/ctime cannot survive a cross-FS copy."""
            result = {}
            for entry in (directory, *sorted(directory.rglob("*"))):
                info = entry.lstat()
                row: dict[str, object] = {"mode": info.st_mode, "uid": info.st_uid, "gid": info.st_gid, "mtimeNs": info.st_mtime_ns,
                       "xattrs": {name: hashlib.sha256(os.getxattr(entry, name, follow_symlinks=False)).hexdigest()
                                  for name in sorted(os.listxattr(entry, follow_symlinks=False))}}
                if stat.S_ISREG(info.st_mode):
                    self.assertEqual(info.st_nlink, 1, "Do not turn an existing linked declaration into trusted metadata")
                    row.update(size=info.st_size, sha256=hashlib.sha256(entry.read_bytes()).hexdigest())
                elif stat.S_ISLNK(info.st_mode):
                    row["target"] = os.readlink(entry)
                else:
                    self.assertTrue(stat.S_ISDIR(info.st_mode), "Unsupported existing transient declaration type")
                result[str(entry.relative_to(directory))] = row
            return result

        transient = Path("/run/systemd/transient")
        transient.mkdir(parents=True, exist_ok=True, mode=0o755)
        with self.agent.fs.directory(str(transient)):
            pass
        original = declaration_metadata(transient)
        self.assertNotIn(str(transient), helper.linux_mounts())
        backing = Path("/srv/qualification/cpu-weight-transient")
        self.assertFalse(backing.exists())
        run(["/usr/bin/cp", "-a", "--", str(transient), str(backing)])
        self.assertEqual(declaration_metadata(backing), original)
        backing_info = backing.lstat()
        probe = backing / ".fixture-acl-support"
        self.assertFalse(probe.exists())
        try:
            write(probe, b"container-owned ACL capability probe\n")
            run(["/usr/bin/setfacl", "-m", "u:" + str(self.identities["outpost-coord"].pw_uid) + ":---,g:"
                 + str(self.group_ids["outpost-workspaces"]) + ":r--,m::r--", str(probe)])
            users, groups = helper.acl_references(os.getxattr(probe, "system.posix_acl_access"))
            self.assertIn(self.identities["outpost-coord"].pw_uid, users)
            self.assertIn(self.group_ids["outpost-workspaces"], groups)
        finally:
            probe.unlink(missing_ok=True)
            os.utime(backing, ns=(backing_info.st_atime_ns, backing_info.st_mtime_ns), follow_symlinks=False)
        self.assertEqual(declaration_metadata(backing), original)
        self.mount(str(backing), transient, bind=True)

        def mount_record() -> list[str]:
            """Identify this exact private-namespace mount before teardown."""
            rows = [line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines()]
            matches = [row for row in rows if len(row) > 6 and row[4] == str(transient)]
            self.assertEqual(len(matches), 1)
            return matches[0]

        mounted = mount_record()
        def unmount_fixture() -> None:
            self.mounts.remove(transient)
            self.assertEqual(mount_record(), mounted, "Do not unmount a replaced or foreign mount")
            run(["/usr/bin/umount", "--", str(transient)])
            self.assertNotIn(str(transient), helper.linux_mounts())
            self.assertEqual(declaration_metadata(transient), original)
            print("CPU_WEIGHT_ACL_FIXTURE_UNMOUNTED " + json.dumps({"target": str(transient),
                  "mountId": mounted[0], "originalDeclarationsRestored": True}), flush=True)
        self.addCleanup(unmount_fixture)
        self.assertEqual(declaration_metadata(transient), original)
        self.assertEqual((transient.stat().st_dev, transient.stat().st_ino), (backing.stat().st_dev, backing.stat().st_ino))
        print("CPU_WEIGHT_ACL_FIXTURE_BACKING " + json.dumps({"source": str(backing), "target": str(transient),
              "mountId": mounted[0], "mountInfo": " ".join(mounted), "realAclProbePassed": True,
              "existingDeclarationCount": len(original) - 1, "existingDeclarationsAndPortableMetadataPreserved": True,
              "hostMountUsed": False}), flush=True)

        files = {}
        for name, weight in (("besteffort", 1), ("burstable", 104)):
            path = Path("/run/systemd/transient/kubepods-" + name + ".slice.d/50-CPUWeight.conf")
            files[path] = b"[Slice]\nCPUWeight=" + str(weight).encode() + b"\n"
            self.assertFalse(path.exists(), "Do not overwrite an existing transient property declaration")
            write(path, files[path])
            self.agent.fs.no_mounts([str(path.parent)])
            self.assertEqual(path.stat().st_dev, backing.stat().st_dev)
        native_paths = [path for root in helper.ROOTS for path in (Path(root), *Path(root).rglob("*"))]
        native = snapshot(native_paths)
        for path, raw in files.items():
            for kind, identity in (("u", self.identities["outpost-coord"].pw_uid),
                                   ("g", self.group_ids["outpost-workspaces"])):
                for permissions in ("r--", "---"):
                    with self.subTest(path=path, kind=kind, permissions=permissions):
                        self.agent.fs.atomic(str(path), raw, 0o644)
                        self.assertEqual(mount_record(), mounted)
                        review = self.allowed()
                        replacements = []
                        def replace(target=path, content=raw, tag=kind, identifier=identity, access=permissions, observed=replacements):
                            before = target.lstat()
                            temporary = write(target.with_name(".fixture-CPUWeight.acl"), content)
                            run(["/usr/bin/setfacl", "-m", tag + ":" + str(identifier) + ":" + access + ",m::r--", str(temporary)])
                            staged = temporary.lstat()
                            self.assertEqual((before.st_dev, before.st_mode, before.st_uid, before.st_gid, before.st_nlink, before.st_size),
                                             (staged.st_dev, staged.st_mode, staged.st_uid, staged.st_gid, staged.st_nlink, staged.st_size))
                            self.assertEqual(temporary.read_bytes(), content)
                            acl = os.getxattr(temporary, "system.posix_acl_access")
                            users, groups = helper.acl_references(acl)
                            self.assertIn(identifier, users if tag == "u" else groups)
                            os.replace(temporary, target)
                            self.assertNotEqual(target.lstat().st_ino, before.st_ino)
                            observed.append(acl)
                        agent = helper.Helper(AfterScanFiles(self.agent.fs.root_fd, replace), helper.SystemRunner(), helper.SystemAccounts(), True)
                        result = agent.handle({**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]})
                        self.assertIsInstance(result, dict)
                        if result is None:
                            self.fail("Apply did not return its result")
                        self.assertEqual(result["state"], "failed", result)
                        self.assertIn("external POSIX ACL", result["message"])
                        self.assertEqual(mount_record(), mounted)
                        self.assertEqual(len(replacements), 1)
                        self.assertFalse(Path(helper.RESETS).exists(), "No audit, intent or public receipt may be created")
                        self.assertEqual(snapshot(native_paths), native)
                        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))
                        for name, expected in self.identities.items():
                            self.assertEqual(pwd.getpwnam(name), expected)
                        for name, gid in self.group_ids.items():
                            self.assertEqual(grp.getgrnam(name).gr_gid, gid)
                        self.assertEqual(os.getxattr(path, "system.posix_acl_access"), replacements[0])
                        print("CPU_WEIGHT_POSTSCAN_ACL_REFUSED " + json.dumps({"path": str(path), "kind": kind,
                              "permissions": permissions, "sameContentAndStableMetadata": True, "externalScanCompletedFirst": True,
                              "noIntentOrDeletion": True, "nativeIdentitiesAndSentinelsPreserved": True}), flush=True)
                        self.agent.fs.atomic(str(path), raw, 0o644)

    def test_real_distinct_current_session_scopes_review_and_apply(self) -> None:
        first = self.session_packet(self.request, "session-42001.scope")
        self.assertTrue(first["canReset"], first)
        second = self.session_packet(self.request, "session-42002.scope")
        self.assertTrue(second["canReset"], second)
        self.assertEqual(first["snapshotDigest"], second["snapshotDigest"])
        result = self.session_packet({**self.request, "mode": "apply", "snapshotDigest": first["snapshotDigest"]}, "session-42003.scope")
        self.assert_complete(result)

    def test_real_current_session_hidden_native_references_refuse(self) -> None:
        for index, poison in enumerate(("name", "numeric", "dependency")):
            review = self.session_packet(self.request, f"session-{42101 + index}.scope", poison)
            self.assertFalse(review["canReset"], review)
            self.assertTrue(review["blockers"])
            self.assertFalse(Path(helper.RESETS).exists())
            self.assertTrue(all(Path(path).exists() for path in helper.ROOTS))
            for name, identity in self.identities.items():
                self.assertEqual(pwd.getpwnam(name), identity)
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_real_other_session_and_current_dropin_changes_remain_bound(self) -> None:
        other = write("/run/systemd/transient/session-42999.scope", b"[Unit]\nDescription=Other session declaration\n")
        review = self.session_packet(self.request, "session-42201.scope")
        self.assertTrue(review["canReset"], review)
        write(other, b"[Unit]\nDescription=Changed other session declaration\n")
        result = self.session_packet({**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]}, "session-42202.scope")
        self.assertEqual(result["state"], "failed", result)
        self.assertIn("snapshot changed", result["message"])
        dropin = write("/run/systemd/transient/session-42203.scope.d/50-fixture.conf", b"[Unit]\nDescription=Bound dropin\n")
        review = self.session_packet(self.request, "session-42203.scope")
        self.assertTrue(review["canReset"], review)
        write(dropin, b"[Scope]\nGroup=outpost-build\n")
        result = self.session_packet({**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]}, "session-42204.scope")
        self.assertEqual(result["state"], "failed", result)
        self.assertFalse(Path(helper.RESETS).exists())
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_real_recovery_barrier_stale_tokens_same_id_completion_and_no_replay(self) -> None:
        normal = self.session_packet(self.request, "session-42301.scope")
        self.assertTrue(normal["canReset"], normal)
        prepared = self.session_packet({**self.request, "mode": "recover_review"}, "session-42302.scope")
        self.assertTrue(prepared["canReset"], prepared)
        self.assertTrue(helper.hex_digest(prepared["recoveryToken"]))
        directory = Path(helper.RESETS) / self.request["resetId"]
        record = json.loads((directory / "recovery.json").read_bytes())
        public = json.loads((directory / "status.json").read_bytes())
        self.assertEqual(record["snapshotDigest"], normal["snapshotDigest"])
        self.assertEqual(prepared["snapshotDigest"], helper.digest({"snapshotDigest": normal["snapshotDigest"],
                                                                  "recoveryToken": prepared["recoveryToken"]}))
        self.assertEqual(set(public), {"schemaVersion", *helper.IDENTITIES, "resetId", "state", "message", "bindingDigest", "snapshotDigest"})
        self.assertEqual(public["state"], "unknown")
        self.assertEqual(public["message"], helper.RECEIPT_MESSAGES["unknown"])
        self.assertEqual(stat.S_IMODE((directory / "recovery.json").stat().st_mode), 0o600)
        status = packet_result({**self.request, "mode": "status"}, unprivileged=True)
        self.assertEqual(status["state"], "unknown")
        self.assertNotIn("recoveryToken", status)
        self.assertEqual(self.apply(normal)["state"], "failed")
        # The older helper's stored-receipt gate sees the same schema/fixed unknown
        # state: even a matching new digest can only return the hold, never delete.
        self.assertEqual(self.apply(prepared)["state"], "unknown")
        self.assertFalse((directory / "audit.json").exists())
        refreshed = self.session_packet({**self.request, "mode": "recover_review"}, "session-42303.scope")
        self.assertTrue(refreshed["canReset"], refreshed)
        self.assertNotEqual(refreshed["recoveryToken"], prepared["recoveryToken"])
        self.assertEqual(packet_result(self.recovery_packet(prepared))["state"], "failed")
        self.assertFalse((directory / "audit.json").exists())
        self.assertTrue(all(Path(path).exists() for path in helper.ROOTS))
        self.assert_complete(self.session_packet(self.recovery_packet(refreshed), "session-42304.scope"))
        fresh = write(Path(helper.ROOTS[2]) / "new-installation-sentinel", b"never replay cleanup\n")
        before = snapshot([fresh, directory / "audit.json", directory / "status.json", directory / "recovery.json"])
        self.assertEqual(packet_result(self.recovery_packet(refreshed))["state"], "complete")
        self.assertEqual(packet_result(self.recovery_packet(prepared))["state"], "failed")
        self.assertFalse(packet_result({**self.request, "mode": "recover_review"})["canReset"])
        self.assertEqual(before, snapshot([fresh, directory / "audit.json", directory / "status.json", directory / "recovery.json"]))

    def test_real_recovery_prior_intent_partial_and_foreign_preparation_refused(self) -> None:
        prepared = packet_result({**self.request, "mode": "recover_review"})
        self.assertTrue(prepared["canReset"], prepared)
        directory = Path(helper.RESETS) / self.request["resetId"]
        private = directory / "recovery.json"
        public = directory / "status.json"
        private_bytes, public_bytes = private.read_bytes(), public.read_bytes()
        cases = (
            ("audit", lambda: write(directory / "audit.json", b'{}', 0o600)),
            ("partial", lambda: public.unlink()),
            ("missing-private", lambda: private.unlink()),
            ("malformed", lambda: write(private, b'{}', 0o600)),
            ("foreign", lambda: write(private, helper.encoded({**json.loads(private_bytes), "resetId": str(uuid.uuid4())}), 0o600)),
            ("linked", lambda: os.link(private, directory / "linked-private")),
        )
        for name, change in cases:
            with self.subTest(name=name):
                change()
                paths = list(directory.iterdir())
                before = snapshot(paths)
                self.assertFalse(packet_result({**self.request, "mode": "recover_review"})["canReset"])
                self.assertEqual(packet_result(self.recovery_packet(prepared))["state"], "failed")
                self.assertEqual(before, snapshot(paths))
                for extra in ("audit.json", "linked-private"):
                    (directory / extra).unlink(missing_ok=True)
                write(private, private_bytes, 0o600)
                write(public, public_bytes)
        self.assertTrue(all(Path(path).exists() for path in helper.ROOTS))
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_real_recovery_changed_snapshot_and_peer_hold_block_before_intent(self) -> None:
        prepared = packet_result({**self.request, "mode": "recover_review"})
        self.assertTrue(prepared["canReset"], prepared)
        task = Path(helper.ROOTS[2]) / "worker/task"
        task.write_bytes(b"changed after preparation\n")
        self.assertEqual(packet_result(self.recovery_packet(prepared))["state"], "failed")
        directory = Path(helper.RESETS) / self.request["resetId"]
        self.assertFalse((directory / "audit.json").exists())
        peer = {**self.request, "resetId": str(uuid.uuid4()), "mode": "recover_review"}
        self.assertFalse(packet_result(peer)["canReset"])
        self.assertFalse((Path(helper.RESETS) / peer["resetId"]).exists())
        refreshed = packet_result({**self.request, "mode": "recover_review"})
        self.assertTrue(refreshed["canReset"], refreshed)
        self.assert_complete(packet_result(self.recovery_packet(refreshed)))

    def test_real_recovery_sigkill_after_cleanup_cannot_replay(self) -> None:
        prepared = packet_result({**self.request, "mode": "recover_review"})
        self.assertTrue(prepared["canReset"], prepared)
        result = run(["/usr/bin/python3", "-I", "-S", "-B", str(Path(__file__).resolve()), "--crash-before-complete"],
                     data=helper.encoded(self.recovery_packet(prepared)), seconds=320, check=False)
        self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr)
        self.assertTrue(all(not Path(path).exists() for path in helper.ROOTS))
        fresh = write(Path(helper.ROOTS[2]) / "never-delete-again", b"new data after ambiguous outcome\n")
        directory = Path(helper.RESETS) / self.request["resetId"]
        paths = [fresh, directory / "status.json", directory / "recovery.json", directory / "audit.json"]
        before = snapshot(paths)
        self.assertEqual(packet_result({**self.request, "mode": "status"}, unprivileged=True)["state"], "unknown")
        self.assertFalse(packet_result({**self.request, "mode": "recover_review"})["canReset"])
        self.assertEqual(packet_result(self.recovery_packet(prepared))["state"], "failed")
        self.assertEqual(before, snapshot(paths))
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_failed_four_reset_preserves_evidence_links_and_outside_data(self) -> None:
        """Root-owned hardlinks lose only the native link; symlink targets are untouched."""
        (Path(helper.ROOTS[2]) / "worker/outside-symlink").symlink_to("/srv/qualification")
        os.link(self.sentinels[-2], Path(helper.ROOTS[2]) / "worker/outside-hardlink")
        before = self.allowed()
        self.assertEqual((before["state"], before["completedSteps"], before["totalSteps"]), ("failed", 4, 12))
        self.assertEqual(before, self.allowed())
        self.assertNotIn("canary", json.dumps(before))
        self.assertFalse(Path(helper.RESETS).exists())
        self.assert_complete(self.apply(before))

    def test_finished_owned_units_reset(self) -> None:
        """Completed metadata and real systemd Requires edges are accepted and removed."""
        self.services()
        self.assertIn(helper.UNITS[1], property_value(helper.UNITS[0], "RequiredBy").split())
        review = self.allowed()
        self.assertEqual(review["services"], list(helper.UNITS))
        audit = self.assert_complete(self.apply(review))
        self.assertEqual([item["step"] for item in audit["steps"] if item["step"].startswith("stop:")],
                         ["stop:" + unit for unit in reversed(helper.UNITS)])
        for unit in helper.UNITS:
            self.assertEqual(property_value(unit, "LoadState"), "not-found")

    def test_active_owned_units_reset(self) -> None:
        """Stop actual sandboxed sleep services and their dedicated-UID cgroups."""
        self.services(active=True)
        self.assert_complete(self.apply(self.allowed()))

    def test_userdel_with_retained_primary_groups(self) -> None:
        """Exercise groupdel for all four groups, not only userdel's implicit private-group removal."""
        login = Path("/etc/login.defs")
        lines = [line for line in login.read_text().splitlines() if not line.lstrip().startswith("USERGROUPS_ENAB")]
        write(login, ("\n".join(lines) + "\nUSERGROUPS_ENAB no\n").encode())
        audit = self.assert_complete(self.apply(self.allowed()))
        self.assertEqual({item["step"] for item in audit["steps"] if item["step"].startswith("groupdel:")},
                         {"groupdel:" + name for name in helper.GROUPS})

    def test_active_installer_block_and_cooperative_stop(self) -> None:
        """A real transient installer stand-in exits only after the helper writes cancel."""
        unit = "outpost-setup-" + self.expected["operationId"] + ".service"
        run(["/usr/bin/systemd-run", "--unit=" + unit, "--property=RuntimeMaxSec=60", "--",
             "/usr/bin/python3", "-I", "-S", "-B", str(Path(__file__)), "--cooperate", str(self.operation)])
        self.assertEqual(property_value(unit, "ActiveState"), "active")
        review = self.blocked("Original installer is active")
        self.assertEqual(review["completedSteps"], 4)
        packet_result({**self.request, "mode": "stop"})
        self.assertEqual((self.operation / "cancel").read_bytes(), b"1")
        wait_inactive(unit)
        self.preserved = snapshot([*self.sentinels, *self.evidence_paths])
        self.assert_complete(self.apply(self.allowed()))

    def test_actual_installation_lock_blocks_without_truncation(self) -> None:
        """Linux flock contention is shared with the current installer's real lock implementation."""
        installer = module("qualification_lock_installer", REPOSITORY / "deploy/environment/host_install.py")
        with installer.installation_lock():
            self.blocked("global installation lock is held")
        self.assert_complete(self.apply(self.allowed()))

    def test_wrong_expected_identity(self) -> None:
        """All seven bound identity fields reject a different saved plan."""
        self.agent.authenticate(self.request)
        for key in sorted(helper.EXPECTED):
            with self.subTest(field=key):
                bad = copy.deepcopy(self.request)
                bad["expected"][key] = ({"operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4()),
                    "deviceId": str(uuid.uuid4()), "releaseId": "host-" + "b" * 20, "sha256": "b" * 64,
                    "size": self.expected["size"] + 1, "publicKey": base64.b64encode(b"z" * 32).decode()})[key]
                value = packet_result(bad)
                self.assertFalse(value["canReset"])
                self.assertFalse(Path(helper.RESETS).exists())
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_wrong_completed_identity(self) -> None:
        """Finished metadata cannot claim another environment's roots."""
        self.services()
        self.allowed()
        metadata = Path(helper.ROOTS[1]) / "installation.json"
        value = json.loads(metadata.read_text())
        value["environmentId"] = str(uuid.uuid4())
        write(metadata, helper.encoded(value))
        self.blocked("Completed installation identity")

    def test_external_linked_foreign_unit(self) -> None:
        """A loaded external native-user declaration still refuses; protected location alone is no longer a blocker."""
        self.allowed()
        marker = Path("/srv/qualification/foreign-stop-ran")
        target = write("/srv/foreign/linked-foreign.service",
                       ("[Service]\nType=oneshot\nUser=outpost-coord\nExecStart=/usr/bin/true\n"
                        "ExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
        link = Path(helper.UNIT_DIR) / target.name
        link.symlink_to(target)
        run(["/usr/bin/systemctl", "daemon-reload"])
        self.assertEqual(Path(property_value(target.name, "FragmentPath")).resolve(), target)
        before = self.declaration_snapshot([link, target])
        review = self.refusal_without_effects("referenced")
        self.assert_metadata_diagnostic(review["blockers"][0], target)
        self.assertEqual(before, self.declaration_snapshot([link, target]))
        self.assertFalse(marker.exists())

    def test_real_reverse_stop_dependencies(self) -> None:
        """Probe all five effective systemd reverse stop edges, not mocked properties."""
        self.services(active=True)
        self.allowed()
        foreign = Path(helper.UNIT_DIR) / "qualification-foreign.service"
        for directive, prop in (("PartOf", "ConsistsOf"), ("BindsTo", "BoundBy"), ("StopPropagatedFrom", "PropagatesStopTo"),
                                ("Requires", "RequiredBy"), ("Requisite", "RequisiteOf")):
            with self.subTest(directive=directive):
                run(["/usr/bin/systemctl", "stop", "--", foreign.name], check=False)
                write(foreign, ("[Unit]\n" + directive + "=" + helper.UNITS[0] + "\n[Service]\nType=simple\nExecStart=/usr/bin/sleep 240\n").encode())
                run(["/usr/bin/systemctl", "daemon-reload"])
                run(["/usr/bin/systemctl", "start", "--", foreign.name])
                self.assertIn(foreign.name, property_value(helper.UNITS[0], prop).split())
                self.blocked("stop would propagate")

    def test_external_access_user_acl(self) -> None:
        """A masked, zero-permission external named-user ACL still blocks UID recycling."""
        self.acl_case(default=False, group=False)

    def test_external_access_group_acl(self) -> None:
        """A masked, zero-permission named-group access ACL blocks GID recycling."""
        self.acl_case(default=False, group=True)

    def test_external_default_user_acl(self) -> None:
        """An inherited default ACL is audited even without a matching inode owner."""
        self.acl_case(default=True, group=False)

    def test_external_default_group_acl(self) -> None:
        """A default named-group ACL is audited using real Linux xattrs."""
        self.acl_case(default=True, group=True)

    def acl_case(self, *, default: bool, group: bool) -> None:
        """Install ACLs with setfacl and positively verify their raw kernel representation."""
        self.allowed()
        target = Path("/srv/qualification/acl")
        target.mkdir()
        identity = self.group_ids["outpost-workspaces"] if group else self.identities["outpost-coord"].pw_uid
        entry = ("d:" if default else "") + ("g:" if group else "u:") + str(identity) + ":---"
        run(["/usr/bin/setfacl", "-m", entry, str(target)])
        raw = os.getxattr(target, "system.posix_acl_default" if default else "system.posix_acl_access")
        users, groups = helper.acl_references(raw)
        self.assertIn(identity, groups if group else users)
        self.blocked("external POSIX ACL")
        self.assertEqual(os.getxattr(target, "system.posix_acl_default" if default else "system.posix_acl_access"), raw)

    def mount(self, source: str, target: Path, *, bind: bool = False) -> None:
        """Mount only container-owned data in its private mount namespace."""
        if bind:
            run(["/usr/bin/mount", "--bind", source, str(target)])
        else:
            run(["/usr/bin/mount", "-t", "tmpfs", "-o", "size=1m,nosuid,nodev,noexec", source, str(target)])
        self.mounts.append(target)
        self.assertIn(str(target), helper.linux_mounts())

    def test_tmpfs_mount_inserted_after_review(self) -> None:
        """A real mounted subtree with escaped spaces invalidates an already approved review."""
        target = Path(helper.ROOTS[2]) / "worker/mount with spaces"
        target.mkdir()
        review = self.allowed()
        self.mount("qualification-tmpfs", target)
        sentinel = write(target / "keep", b"mounted sentinel\n")
        self.blocked("Mounted cleanup")
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertEqual(sentinel.read_bytes(), b"mounted sentinel\n")
        self.assertFalse(Path(helper.RESETS).exists())

    def test_same_device_bind_mount_descriptor_boundary(self) -> None:
        """st_dev equality cannot hide a bind mount from mountinfo or fdinfo mnt_id checks."""
        target = Path(helper.ROOTS[2]) / "worker/bound"
        target.mkdir()
        source = Path("/srv/qualification/bind-source")
        source.mkdir()
        self.allowed()
        self.mount(str(source), target, bind=True)
        self.blocked("Mounted cleanup")
        root_fd = os.open("/", helper.TRAVERSE_FLAGS)
        parent_fd = os.open(target.parent, helper.DIR_FLAGS)
        child_fd = os.open(target, helper.DIR_FLAGS)
        try:
            self.assertEqual(os.fstat(parent_fd).st_dev, os.fstat(child_fd).st_dev)
            with self.assertRaisesRegex(helper.Refused, "Bind-mounted"):
                helper.Files(root_fd).same_mount(parent_fd, child_fd)
        finally:
            for descriptor in (root_fd, parent_fd, child_fd):
                os.close(descriptor)

    def test_mounted_native_root(self) -> None:
        """A bind mount of an otherwise identical cleanup root is not removable."""
        self.allowed()
        target = Path(helper.ROOTS[1])
        self.mount(str(target), target, bind=True)
        self.blocked("Mounted cleanup")

    def test_mounted_owned_unit_file(self) -> None:
        """A file bind mount of exact unit bytes must block before any service stop."""
        self.services()
        self.allowed()
        target = Path(helper.UNIT_DIR) / helper.UNITS[0]
        source = write("/srv/qualification/unit-source", target.read_bytes())
        self.mount(str(source), target, bind=True)
        self.blocked("Mounted cleanup")

    def test_external_account_owned_hardlink(self) -> None:
        """The full-root ownership scan sees a real account-owned external hardlink."""
        self.allowed()
        outside = Path("/srv/qualification/owned-hardlink")
        os.link(Path(helper.ROOTS[2]) / "worker/task", outside)
        self.blocked("owns data outside")
        self.assertEqual(outside.read_bytes(), b"disposable native task\n")

    def test_external_identity_process(self) -> None:
        """Real procfs credentials and cgroups reject a dedicated UID used outside owned services."""
        self.allowed()
        identity = self.identities["outpost-coord"]
        process = subprocess.Popen(["/usr/bin/sleep", "45"], cwd="/", user=identity.pw_uid,
                                   group=identity.pw_gid, extra_groups=[], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(process)
        self.assertIsNone(process.poll())
        self.blocked("processes outside")
        self.assertIsNone(process.poll())

    def test_completed_idempotency_and_unprivileged_status(self) -> None:
        """A lost reply can be reconciled without re-deleting a later installation."""
        review = self.allowed()
        first = self.apply(review)
        self.assert_complete(first)
        new_data = write(Path(helper.ROOTS[0]) / "new-owner", b"later installation must survive\n")
        self.assertEqual(self.apply(review), first)
        self.assertEqual(new_data.read_bytes(), b"later installation must survive\n")
        status = packet_result({**self.request, "mode": "status"}, unprivileged=True)
        self.assertEqual(status, first)
        audit = Path(helper.RESETS) / self.request["resetId"] / "audit.json"
        denied = run(["/usr/bin/setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "/usr/bin/cat", str(audit)], check=False)
        self.assertNotEqual(denied.returncode, 0)
        wrong_snapshot = packet_result({**self.request, "mode": "apply", "snapshotDigest": "f" * 64})
        self.assertEqual(wrong_snapshot["state"], "failed")
        self.assertEqual(new_data.read_bytes(), b"later installation must survive\n")
        installer = module("qualification_completed_gate", REPOSITORY / "deploy/environment/host_install.py")
        with installer.installation_lock() as descriptor:
            installer.check_reset_holds(descriptor)

    def test_sigkill_after_deletion_holds_fresh_installer(self) -> None:
        """SIGKILL before public completion leaves a durable hold after actual filesystem/account deletion."""
        review = self.allowed()
        packet = {**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]}
        crashed = run(["/usr/bin/python3", "-I", "-S", "-B", str(Path(__file__)), "--crash-before-complete"],
                      data=helper.encoded(packet), seconds=320, check=False)
        self.assertEqual(crashed.returncode, -signal.SIGKILL)
        self.assertTrue(all(not Path(path).exists() for path in helper.ROOTS))
        for name in helper.USERS:
            with self.assertRaises(KeyError):
                pwd.getpwnam(name)
        self.assertEqual(packet_result({**self.request, "mode": "status"})["state"], "unknown")
        self.assertEqual(self.apply(review)["state"], "unknown")
        next_request = {**self.request, "resetId": str(uuid.uuid4())}
        self.assertFalse(packet_result(next_request)["canReset"])
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))
        installer = module("qualification_crash_installer", REPOSITORY / "deploy/environment/host_install.py")

        class GuardedInstaller(installer.Installer):
            """Tripwire: never allow a broken fence to run installation stages."""

            def preflight(self) -> None:
                """A fence bypass is a test failure before any app installation is possible."""
                raise AssertionError("Reset hold bypassed: preflight must never be reached")

        fresh = {**self.original, "operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4())}
        operation = Path(helper.OPERATIONS) / fresh["operationId"]
        write(operation / "request.json", helper.encoded(fresh), 0o600)
        write(operation / "status.json", helper.encoded({**self.progress,
              **{key: fresh[key] for key in helper.IDENTITIES}, "state": "queued", "completedSteps": 0}))
        fresh_installer = GuardedInstaller(operation)
        fresh_installer.execute()
        self.assertEqual(fresh_installer.status["state"], "failed")
        self.assertEqual(fresh_installer.status["completedSteps"], 0)
        self.assertIn("Reset recovery hold", fresh_installer.status["error"])
        self.assertTrue(all(not Path(path).exists() for path in helper.ROOTS))

    def test_component_full_root_ownership_and_acl_inventory(self) -> None:
        """Independently qualify the unmodified full-root scan, even if systemd parsing blocks CLI review."""
        users, groups, _ = self.agent.account_inventory()
        try:
            self.agent.fs.outside_ownership({row["uid"] for row in users.values()}, {row["gid"] for row in groups.values()},
                                           [*helper.ROOTS, str(self.operation / "build-home")])
        except helper.Refused:
            for path in (Path("/dev"), *Path("/dev").rglob("*")):
                if path.is_symlink():
                    continue
                for attribute in ("system.posix_acl_access", "system.posix_acl_default"):
                    try:
                        os.getxattr(path, attribute)
                    except OSError as error:
                        if error.errno != errno.ENODATA:
                            print("KERNEL_ACL_UNAVAILABLE " + json.dumps({"path": str(path), "attribute": attribute,
                                                                        "errno": error.errno, "message": str(error)}), flush=True)
            raise

    def test_component_authenticated_descriptor_deletion(self) -> None:
        """Real deletion primitive, NOT successful apply qualification or permission to bypass review."""
        (Path(helper.ROOTS[2]) / "worker/outside-symlink").symlink_to("/srv/qualification")
        os.link(self.sentinels[-2], Path(helper.ROOTS[2]) / "worker/outside-hardlink")
        original, receipt, tree = self.agent.authenticate(self.request)
        users, groups, _ = self.agent.account_inventory()
        layout = self.agent.layout(original, receipt, tree, users, groups)
        for path in helper.ROOTS:
            self.agent.fs.remove_tree(path, self.agent.owner_check(original, users, groups), layout["trees"][path][0][1])
        self.assertTrue(all(not Path(path).exists() for path in helper.ROOTS))
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))
        self.assertFalse(Path(helper.RESETS).exists(), "Component exercise must not manufacture a completed reset")

    def test_component_userdel_and_groupdel(self) -> None:
        """Use the production runner for real accounts, including retained versus auto-removed groups."""
        self.agent.account_inventory()
        login = Path("/etc/login.defs")
        text = login.read_text()
        for retained in (False, True):
            with self.subTest(retain_primary_groups=retained):
                lines = [line for line in text.splitlines() if not line.lstrip().startswith("USERGROUPS_ENAB")]
                write(login, ("\n".join(lines) + "\nUSERGROUPS_ENAB " + ("no" if retained else "yes") + "\n").encode())
                if retained:
                    run(["/usr/sbin/groupadd", "--system", "outpost-workspaces"])
                    for name in helper.USERS:
                        run(["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--home-dir",
                             "/nonexistent", "--shell", "/usr/sbin/nologin", name])
                for name in helper.USERS:
                    self.agent.runner.run(["/usr/sbin/userdel", "--", name])
                    with self.assertRaises(KeyError):
                        pwd.getpwnam(name)
                remaining = {row.gr_name for row in grp.getgrall()} & set(helper.GROUPS)
                self.assertEqual(remaining, set(helper.GROUPS) if retained else {"outpost-workspaces"})
                for name in sorted(remaining):
                    self.agent.runner.run(["/usr/sbin/groupdel", "--", name])
                self.assertFalse({row.gr_name for row in grp.getgrall()} & set(helper.GROUPS))
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_component_acl_kernel_descriptor_matrix(self) -> None:
        """All four named access/default ACL variants are checked on real pinned Linux descriptors."""
        target = Path("/srv/qualification/acl-component")
        target.mkdir()
        for default in (False, True):
            for group in (False, True):
                with self.subTest(default=default, group=group):
                    identity = self.group_ids["outpost-workspaces"] if group else self.identities["outpost-coord"].pw_uid
                    entry = ("d:" if default else "") + ("g:" if group else "u:") + str(identity) + ":---"
                    run(["/usr/bin/setfacl", "-m", entry, str(target)])
                    descriptor = os.open(target, os.O_PATH | os.O_NOFOLLOW)
                    try:
                        with self.assertRaisesRegex(helper.Refused, "external POSIX ACL"):
                            self.agent.fs.check_acl(descriptor, {self.identities["outpost-coord"].pw_uid},
                                                    {self.group_ids["outpost-workspaces"]})
                    finally:
                        os.close(descriptor)
                    run(["/usr/bin/setfacl", "-b", "-k", str(target)])
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def test_component_mount_boundaries(self) -> None:
        """Actual root/subtree/file/evidence mounts and same-device fd mount identities all refuse."""
        targets = [Path(helper.ROOTS[1]), Path(helper.ROOTS[2]) / "worker/mount with spaces",
                   self.operation, write(Path(helper.UNIT_DIR) / "outpost-native-worker.service", b"fixture")]
        targets[1].mkdir()
        for target in targets:
            with self.subTest(target=str(target)):
                self.mount(str(target), target, bind=True)
                with self.assertRaisesRegex(helper.Refused, "Mounted cleanup"):
                    self.agent.fs.no_mounts([str(target)])
                if target.is_dir():
                    parent = os.open(target.parent, helper.DIR_FLAGS)
                    child = os.open(target, helper.DIR_FLAGS)
                    try:
                        self.assertEqual(os.fstat(parent).st_dev, os.fstat(child).st_dev)
                        with self.assertRaisesRegex(helper.Refused, "Bind-mounted"):
                            self.agent.fs.same_mount(parent, child)
                    finally:
                        os.close(parent)
                        os.close(child)
                run(["/usr/bin/umount", "--", str(target)])
                self.mounts.remove(target)
        target = targets[1]
        self.mount("qualification-tmpfs", target)
        sentinel = write(target / "keep", b"mount sentinel")
        with self.assertRaisesRegex(helper.Refused, "Mounted cleanup"):
            self.agent.fs.no_mounts([helper.ROOTS[2]])
        self.assertEqual(sentinel.read_bytes(), b"mount sentinel")

    def test_component_external_linked_unit_refusal(self) -> None:
        """The real configuration scan follows a protected external target and refuses its native identity use."""
        users, groups, _ = self.agent.account_inventory()
        self.agent.other_account_use(users, groups, self.original)
        target = write("/srv/foreign/foreign.service", b"[Service]\nUser=outpost-coord\nExecStart=/usr/bin/true\n")
        (Path(helper.UNIT_DIR) / target.name).symlink_to(target)
        run(["/usr/bin/systemctl", "daemon-reload"])
        self.assertEqual(Path(property_value(target.name, "FragmentPath")).resolve(), target)
        with self.assertRaisesRegex(helper.Refused, "referenced"):
            self.agent.other_account_use(users, groups, self.original)
        self.assertTrue(target.is_file())

    def test_component_systemd_reverse_dependency_matrix(self) -> None:
        """Demonstrate real stop propagation to disposable foreign services, not a passing Helper.units audit."""
        self.services(active=True)
        foreign = Path(helper.UNIT_DIR) / "qualification-foreign.service"
        for directive, prop in (("PartOf", "ConsistsOf"), ("BindsTo", "BoundBy"), ("StopPropagatedFrom", "PropagatesStopTo"),
                                ("Requires", "RequiredBy"), ("Requisite", "RequisiteOf")):
            with self.subTest(directive=directive):
                run(["/usr/bin/systemctl", "stop", "--", foreign.name], check=False)
                write(foreign, ("[Unit]\n" + directive + "=" + helper.UNITS[0] + "\n[Service]\nType=simple\nExecStart=/usr/bin/sleep 240\n").encode())
                run(["/usr/bin/systemctl", "daemon-reload"])
                run(["/usr/bin/systemctl", "start", "--", foreign.name])
                self.assertEqual(property_value(foreign.name, "ActiveState"), "active")
                self.assertIn(foreign.name, property_value(helper.UNITS[0], prop).split())
                print("REAL_REVERSE_EDGE " + prop + "=" + property_value(helper.UNITS[0], prop), flush=True)
                self.agent.runner.run(["/usr/bin/systemctl", "stop", "--", helper.UNITS[0]], 45)
                self.assertEqual(property_value(foreign.name, "ActiveState"), "inactive")
                self.assertEqual(property_value(helper.UNITS[0], "ActiveState"), "inactive")
                if directive != "Requisite":
                    run(["/usr/bin/systemctl", "start", "--", *helper.UNITS])

    def test_component_cooperative_stop(self) -> None:
        """Production stop CLI writes cancel and a real transient process exits without systemctl stop."""
        unit = "outpost-setup-" + self.expected["operationId"] + ".service"
        run(["/usr/bin/systemd-run", "--unit=" + unit, "--property=RuntimeMaxSec=60", "--",
             "/usr/bin/python3", "-I", "-S", "-B", str(Path(__file__)), "--cooperate", str(self.operation)])
        self.assertEqual(property_value(unit, "ActiveState"), "active")
        packet_result({**self.request, "mode": "stop"})
        self.assertEqual((self.operation / "cancel").read_bytes(), b"1")
        wait_inactive(unit)
        self.assertFalse(Path(helper.RESETS).exists())
        self.assertEqual(snapshot(self.sentinels), {str(path): self.preserved[str(path)] for path in self.sentinels})

    def test_component_process_inventory(self) -> None:
        """Read actual cross-UID procfs credentials within the private PID namespace."""
        identity = self.identities["outpost-coord"]
        self.agent.accounts.processes({identity.pw_uid}, {identity.pw_gid}, set())
        process = subprocess.Popen(["/usr/bin/sleep", "45"], cwd="/", user=identity.pw_uid,
                                   group=identity.pw_gid, extra_groups=[], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(process)
        with self.assertRaisesRegex(helper.Refused, "processes outside"):
            self.agent.accounts.processes({identity.pw_uid}, {identity.pw_gid}, set())
        self.assertIsNone(process.poll())

    def test_component_completed_receipt_replay(self) -> None:
        """Synthetic completed-receipt protocol test, explicitly NOT proof that apply can complete."""
        packet = {**self.request, "mode": "apply", "snapshotDigest": "e" * 64}
        with self.agent.fs.lock():
            self.agent.fs.mkdir(helper.RESETS, 0o711)
            self.agent.fs.mkdir(helper.RESETS + "/" + packet["resetId"], 0o711)
            self.agent.publish(packet, "complete")
        before = snapshot([*self.sentinels, *self.evidence_paths, self.release / "package.json"])
        first = packet_result(packet)
        self.assertEqual(first["state"], "complete")
        self.assertEqual(packet_result(packet), first)
        self.assertEqual(packet_result({**self.request, "mode": "status"}, unprivileged=True), first)
        self.assertEqual(before, snapshot([*self.sentinels, *self.evidence_paths, self.release / "package.json"]))
        self.assertTrue(all(Path(path).is_dir() for path in helper.ROOTS))
        self.assertEqual(packet_result({**packet, "snapshotDigest": "f" * 64})["state"], "failed")
        installer = module("component_complete_installer", REPOSITORY / "deploy/environment/host_install.py")
        with installer.installation_lock() as descriptor:
            installer.check_reset_holds(descriptor)

    def test_component_actual_lock_contention(self) -> None:
        """CLI refuses real installer flock contention before the systemd inventory is attempted."""
        installer = module("component_lock_installer", REPOSITORY / "deploy/environment/host_install.py")
        with installer.installation_lock():
            self.blocked("global installation lock is held")
        self.assertEqual((Path(helper.BASE) / "install.lock").stat().st_ino, self.lock_stat.st_ino)

    def test_component_sigkill_receipt_holds_fresh_installer(self) -> None:
        """A genuine killed receipt writer fences Installer.execute; full-apply crash coverage stays separate."""
        packet = {**self.request, "mode": "apply", "snapshotDigest": "e" * 64}
        crashed = run(["/usr/bin/python3", "-I", "-S", "-B", str(Path(__file__)), "--crash-after-intent"],
                      data=helper.encoded(packet), check=False)
        self.assertEqual(crashed.returncode, -signal.SIGKILL)
        self.assertEqual(packet_result({**self.request, "mode": "status"})["state"], "unknown")
        self.assertEqual(packet_result(packet)["state"], "unknown")
        installer = module("component_crash_installer", REPOSITORY / "deploy/environment/host_install.py")

        class GuardedInstaller(installer.Installer):
            """Ensure a broken gate cannot run an installation during qualification."""

            def preflight(self) -> None:
                """Stop before any installation stage if the hold is incorrectly ignored."""
                raise AssertionError("Reset hold bypassed")

        fresh = {**self.original, "operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4())}
        operation = Path(helper.OPERATIONS) / fresh["operationId"]
        write(operation / "request.json", helper.encoded(fresh), 0o600)
        write(operation / "status.json", helper.encoded({**self.progress,
              **{key: fresh[key] for key in helper.IDENTITIES}, "state": "queued", "completedSteps": 0}))
        instance = GuardedInstaller(operation)
        instance.execute()
        self.assertEqual(instance.status["state"], "failed")
        self.assertEqual(instance.status["completedSteps"], 0)
        self.assertIn("Reset recovery hold", instance.status["error"])
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))

    def uv_locks(self) -> list[Path]:
        """Create the two real build-owned empty 0666 locks beneath private 0700 parents."""
        build = self.identities["outpost-build"]
        locks = []
        for relative in ("python/.lock", "server/browser-engine/.venv/.lock"):
            path = write(self.release / relative, b"", 0o666)
            os.chown(path, build.pw_uid, build.pw_gid)
            os.chown(path.parent, build.pw_uid, build.pw_gid)
            path.parent.chmod(0o700)
            locks.append(path)
        print("REAL_UV_LOCK_METADATA " + json.dumps({"uid": build.pw_uid, "gid": build.pw_gid,
              "locks": [{"path": str(path), "mode": oct(stat.S_IMODE(path.stat().st_mode)),
                         "parentMode": oct(stat.S_IMODE(path.parent.stat().st_mode)),
                         "size": path.stat().st_size, "links": path.stat().st_nlink} for path in locks]}), flush=True)
        return locks

    def refusal_without_effects(self, fragment: str) -> dict:
        """Check both real CLI review and apply refuse before intent, with fixture bytes unchanged."""
        paths = [*self.sentinels, *[path for root in (*map(Path, helper.ROOTS), self.operation)
                                  for path in root.rglob("*") if path.is_file() and not path.is_symlink()]]
        before = snapshot(paths)
        review = self.blocked(fragment)
        result = self.apply(review)
        self.assertEqual(result["state"], "failed", result)
        self.assertFalse(Path(helper.RESETS).exists())
        self.assertEqual(before, snapshot(paths))
        for name, identity in self.identities.items():
            self.assertEqual(pwd.getpwnam(name), identity)
        for message in [*review["blockers"], result["message"]]:
            self.assertLessEqual(len(message.encode("utf-8")), 1000)
            self.assertTrue(all(32 <= ord(char) < 127 for char in message))
            self.assertNotIn("secret-payload", message)
        return review

    def assert_metadata_diagnostic(self, message: str, path: Path) -> None:
        """Require actionable lstat fields and a quoted path without leaking file contents."""
        info = path.lstat()
        self.assertIn(json.dumps(str(path), ensure_ascii=True), message)
        self.assertIn(f"; mode=0o{info.st_mode:o} uid={info.st_uid} gid={info.st_gid}", message)
        self.assertLessEqual(len(message.encode("utf-8")), 1000)

    def test_uv_locks_real_private_parents_reset(self) -> None:
        """Actual distinct build UID/GID, private parents and both 0666 locks survive review then only unlink."""
        locks = self.uv_locks()
        build = self.identities["outpost-build"]
        self.assertNotEqual(build.pw_uid, build.pw_gid)
        descriptors = [os.open(path, os.O_RDONLY | os.O_NOFOLLOW) for path in locks]
        try:
            before = [helper.stamp(os.fstat(descriptor)) for descriptor in descriptors]
            review = self.allowed()
            self.assertIn(helper.UV_LOCK_WARNING, review["warnings"])
            self.assertEqual(before, [helper.stamp(os.fstat(descriptor)) for descriptor in descriptors])
            self.assertFalse(Path(helper.RESETS).exists())
            self.assert_complete(self.apply(review))
            for descriptor, original in zip(descriptors, before):
                after = helper.stamp(os.fstat(descriptor))
                self.assertEqual(after[:5], original[:5])
                self.assertEqual((after[5], after[6]), (0, 0))
                self.assertEqual(os.read(descriptor, 1), b"")
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def test_uv_locks_nonempty_or_unsafe_mode_refused(self) -> None:
        """Real nonempty, executable, set-ID and sticky locks are never mistaken for generated empties."""
        locks = self.uv_locks()
        self.allowed()
        for path in locks:
            for mode, content in ((0o666, b"uv-secret-payload"), (0o766, b""), (0o4666, b""),
                                  (0o2666, b""), (0o1666, b"")):
                with self.subTest(path=str(path), mode=oct(mode), nonempty=bool(content)):
                    write(path, content, mode)
                    review = self.refusal_without_effects("Generated uv lock")
                    self.assert_metadata_diagnostic(review["blockers"][0], path)
                    write(path, b"", 0o666)

    def test_uv_locks_shared_or_foreign_parent_refused(self) -> None:
        """Private-directory identity, mode and the file's UID/GID are independently verified against real NSS."""
        locks = self.uv_locks()
        build = self.identities["outpost-build"]
        self.allowed()
        for path in locks:
            for mode in (0o755, 0o750, 0o710, 0o701, 0o770, 0o2700):
                with self.subTest(path=str(path.parent), mode=oct(mode)):
                    path.parent.chmod(mode)
                    review = self.refusal_without_effects("writable" if mode == 0o770 else "private build-owned directory")
                    self.assert_metadata_diagnostic(review["blockers"][0], path.parent)
                    path.parent.chmod(0o700)
            for target in (path, path.parent):
                for uid, gid in ((0, 0), (build.pw_uid, self.group_ids["outpost-workspaces"]),
                                 (self.identities["outpost-pi"].pw_uid, build.pw_gid)):
                    with self.subTest(path=str(target), uid=uid, gid=gid):
                        os.chown(target, uid, gid)
                        review = self.refusal_without_effects("")
                        self.assert_metadata_diagnostic(review["blockers"][0], target)
                        os.chown(target, build.pw_uid, build.pw_gid)

    def test_uv_locks_linked_or_special_inode_refused(self) -> None:
        """Hardlinks, symlinks, directories and FIFOs are refused without following/opening their payloads."""
        locks = self.uv_locks()
        build = self.identities["outpost-build"]
        self.allowed()
        for path in locks:
            outside = Path("/srv/qualification/uv-lock-alias")
            os.link(path, outside)
            outside_before = snapshot([outside])
            self.refusal_without_effects("singly-linked")
            self.assertEqual(outside_before, snapshot([outside]))
            outside.unlink()
            for kind in ("symlink", "directory", "fifo"):
                with self.subTest(path=str(path), kind=kind):
                    path.unlink()
                    if kind == "symlink":
                        path.symlink_to(self.sentinels[-2])
                        os.chown(path, build.pw_uid, build.pw_gid, follow_symlinks=False)
                    elif kind == "directory":
                        path.mkdir(mode=0o700)
                        os.chown(path, build.pw_uid, build.pw_gid)
                    else:
                        os.mkfifo(path, 0o600)
                        os.chown(path, build.pw_uid, build.pw_gid)
                    review = self.refusal_without_effects("Generated uv lock")
                    self.assert_metadata_diagnostic(review["blockers"][0], path)
                    path.rmdir() if kind == "directory" else path.unlink()
                    write(path, b"", 0o666)
                    os.chown(path, build.pw_uid, build.pw_gid)

    def test_uv_locks_wrong_path_or_foreign_release_refused(self) -> None:
        """The exception cannot authorize arbitrary writable siblings or another release's lock."""
        self.uv_locks()
        self.allowed()
        build = self.identities["outpost-build"]
        for relative in ("other/.lock", "python/.lock.extra", "python/child/.lock", ".venv/.lock"):
            with self.subTest(relative=relative):
                path = write(self.release / relative, b"", 0o666)
                os.chown(path, build.pw_uid, build.pw_gid)
                os.chown(path.parent, build.pw_uid, build.pw_gid)
                path.parent.chmod(0o700)
                self.refusal_without_effects("writable")
                path.unlink()
        foreign = write(self.release.parent / ("host-" + "b" * 20) / "python/.lock", b"", 0o666)
        os.chown(foreign, build.pw_uid, build.pw_gid)
        self.refusal_without_effects("ownership")

    def test_uv_locks_external_identity_use_refused(self) -> None:
        """Valid lock metadata never exempts external ownership, named ACLs or actual build-user processes."""
        self.uv_locks()
        self.allowed()
        build = self.identities["outpost-build"]
        outside = write("/srv/qualification/build-external", b"outside identity sentinel")
        os.chown(outside, build.pw_uid, build.pw_gid)
        self.refusal_without_effects("owns data outside")
        os.chown(outside, 0, 0)
        run(["/usr/bin/setfacl", "-m", f"u:{build.pw_uid}:---", str(outside)])
        self.refusal_without_effects("external POSIX ACL")
        run(["/usr/bin/setfacl", "-b", str(outside)])
        process = subprocess.Popen(["/usr/bin/sleep", "45"], cwd="/", user=build.pw_uid,
                                   group=build.pw_gid, extra_groups=[], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(process)
        self.refusal_without_effects("processes outside")
        self.assertIsNone(process.poll())

    def test_uv_locks_changed_after_review_refused(self) -> None:
        """Changed bytes, private-parent access and a same-byte replacement all invalidate an approved snapshot."""
        path = self.uv_locks()[0]
        build = self.identities["outpost-build"]
        for change in ("contents", "parent", "inode"):
            with self.subTest(change=change):
                review = self.allowed()
                if change == "contents":
                    write(path, b"uv-secret-payload", 0o666)
                elif change == "parent":
                    path.parent.chmod(0o755)
                else:
                    path.unlink()
                    write(path, b"", 0o666)
                    os.chown(path, build.pw_uid, build.pw_gid)
                before = snapshot([path, path.parent, *self.sentinels])
                result = self.apply(review)
                self.assertEqual(result["state"], "failed")
                self.assertFalse(Path(helper.RESETS).exists())
                self.assertEqual(before, snapshot([path, path.parent, *self.sentinels]))
                write(path, b"", 0o666)
                path.parent.chmod(0o700)

    @staticmethod
    def audit_json(value: dict) -> bytes:
        """Match the operator script's exact recorded format without importing or running it."""
        return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()

    def recorded_browser_hotfix(self) -> None:
        """Use the authentic original archive and pinned replacement, with real ownership and fresh fixture identities."""
        parsed = ast.parse((REPOSITORY / "scripts/repair-outpost2-browser.py").read_text())
        literals = {node.targets[0].id: node.value for node in parsed.body
                    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
        pins = {name: ast.literal_eval(literals[name]) for name in
                ("ORIGINAL_SHA256", "REPLACEMENT_SHA256", "ARCHIVE_SHA256", "ARCHIVE_SIZE", "RELEASE_ID", "PROVENANCE", "BACKUPS")}
        archive_bytes = (REPOSITORY / "scripts/fixtures/outpost2-original-release.tar.gz").read_bytes()
        replacement = (REPOSITORY / "server/browser-engine/launch.py").read_bytes()
        self.assertEqual(len(archive_bytes), pins["ARCHIVE_SIZE"])
        self.assertEqual(hashlib.sha256(archive_bytes).hexdigest(), pins["ARCHIVE_SHA256"])
        self.assertEqual(hashlib.sha256(replacement).hexdigest(), pins["REPLACEMENT_SHA256"])
        self.assertEqual(pins["ORIGINAL_SHA256"], helper.HOTFIX_ORIGINAL_SHA256)
        self.assertEqual(pins["REPLACEMENT_SHA256"], helper.HOTFIX_REPLACEMENT_SHA256)
        source = {}
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
            for item in archive:
                name = item.name.removeprefix("./").rstrip("/")
                if name in ("", ".") and item.isdir():
                    continue
                self.assertFalse(name.startswith("/"))
                self.assertTrue(all(part not in ("", ".", "..") for part in name.split("/")))
                self.assertTrue(item.isfile() or item.isdir())
                if item.isfile():
                    self.assertNotIn(name, source)
                    payload = archive.extractfile(item)
                    self.assertIsNotNone(payload)
                    if payload is None:
                        self.fail("Authenticated fixture source is unreadable")
                    with payload:
                        source[name] = payload.read()
        original = source["server/browser-engine/launch.py"]
        self.assertEqual(hashlib.sha256(original).hexdigest(), pins["ORIGINAL_SHA256"])
        self.assertEqual(json.loads(source["host-manifest.json"])["id"], pins["RELEASE_ID"])
        require_container()
        self.assertEqual(self.release.parent, Path(helper.ROOTS[0]) / "releases")
        shutil.rmtree(self.release)
        self.release = self.release.parent / pins["RELEASE_ID"]
        self.release.mkdir(mode=0o755)
        self.expected.update(releaseId=pins["RELEASE_ID"], sha256=pins["ARCHIVE_SHA256"], size=pins["ARCHIVE_SIZE"])
        self.original.update(self.expected, browser=True, coexistence=True, fullControl=True)
        self.progress["releaseId"] = self.expected["releaseId"]
        self.source = source
        for name, data in source.items():
            write(self.release / name, data)
            write(self.operation / "source" / name, data)
        write(self.operation / "request.json", helper.encoded(self.original), 0o600)
        write(self.operation / "status.json", helper.encoded(self.progress))
        write(self.operation / "release.tar.gz", archive_bytes, 0o644)
        write(self.operation / "launch.log", b"private-launch-canary\n", 0o600)
        build = self.identities["outpost-build"]
        for path in (self.release, *self.release.rglob("*")):
            os.chown(path, build.pw_uid, build.pw_gid)
        write(self.release / "server/browser-engine/launch.py", replacement, 0o644)
        for path in (Path(helper.BASE), Path(helper.OPERATIONS), self.operation, Path(helper.ROOTS[2])):
            path.chmod(0o711)
        (self.operation / "build-home").chmod(0o700)
        (Path(helper.ROOTS[1]) / "coordinator.env").unlink()
        (Path(helper.ROOTS[2]) / "worker/task").unlink()
        self.hotfix_font = self.release / "browsers/camoufox/fontconfig"
        self.hotfix_font.mkdir(parents=True, mode=0o755)
        os.chown(self.hotfix_font, build.pw_uid, build.pw_gid)
        generated = write(self.hotfix_font / "fonts.conf", b"fixture generated font configuration\n")
        os.chown(generated, build.pw_uid, build.pw_gid)
        self.hotfix_audit = self.operation / ("browser-hotfix-" + str(uuid.uuid4()))
        self.hotfix_audit.mkdir(mode=0o700)
        backups = {}
        for name in pins["BACKUPS"]:
            if name == "launch.py":
                data, uid, gid, mode = original, build.pw_uid, build.pw_gid, 0o644
            else:
                retained = self.operation / name
                info = retained.stat()
                data, uid, gid, mode = retained.read_bytes(), info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)
            write(self.hotfix_audit / name, data, 0o600)
            backups[name] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "uid": uid, "gid": gid, "mode": mode}
        self.hotfix_manifest = {"schema": 1, **{key: self.expected[key] for key in helper.IDENTITIES},
            "auditId": self.hotfix_audit.name, "provenance": pins["PROVENANCE"],
            "originalSha256": pins["ORIGINAL_SHA256"], "replacementSha256": pins["REPLACEMENT_SHA256"],
            "archiveSha256": pins["ARCHIVE_SHA256"], "archiveSize": pins["ARCHIVE_SIZE"], "backups": backups,
            "fontconfig": {"relativePath": "browsers/camoufox/fontconfig", "uid": build.pw_uid, "gid": build.pw_gid, "mode": 0o755}}
        manifest_bytes = self.audit_json(self.hotfix_manifest)
        font = self.hotfix_font.stat()
        self.hotfix_applied = {"schema": 1, "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "launcherSha256": pins["REPLACEMENT_SHA256"],
            "fontconfigIdentity": [font.st_dev, font.st_ino, font.st_mode, font.st_uid, font.st_gid]}
        write(self.hotfix_audit / "manifest.json", manifest_bytes, 0o600)
        write(self.hotfix_audit / "applied.json", self.audit_json(self.hotfix_applied), 0o600)
        self.uv_locks()
        self.evidence_paths = [path for path in self.operation.rglob("*") if path.is_file()]
        self.preserved = snapshot([*self.sentinels, *self.evidence_paths])
        print("AUTHENTIC_HOTFIX_PAYLOADS " + json.dumps({"archiveSha256": pins["ARCHIVE_SHA256"],
              "archiveSize": len(archive_bytes), "originalSha256": pins["ORIGINAL_SHA256"],
              "replacementSha256": pins["REPLACEMENT_SHA256"], "sourceFiles": len(source),
              "buildUid": build.pw_uid, "buildGid": build.pw_gid,
              "auditFormat": "repair-outpost2-browser.py; fresh disposable operation identity; no script execution"}), flush=True)

    def test_recorded_browser_hotfix_real_payload_reset(self) -> None:
        """Complete reset of real pinned archive plus recorded hotfix and both UV locks, retaining the private audit."""
        self.recorded_browser_hotfix()
        before = {str(path): helper.stamp(path.stat()) for path in self.evidence_paths}
        review = self.allowed()
        self.assertIn(helper.HOTFIX_WARNING, review["warnings"])
        self.assertIn(helper.UV_LOCK_WARNING, review["warnings"])
        self.assertEqual(before, {str(path): helper.stamp(path.stat()) for path in self.evidence_paths})
        self.assert_complete(self.apply(review))
        self.assertEqual(before, {str(path): helper.stamp(path.stat()) for path in self.evidence_paths})
        self.assertEqual(stat.S_IMODE(self.hotfix_audit.stat().st_mode), 0o700)
        self.assertEqual(self.hotfix_audit.stat().st_uid, 0)
        for path in self.hotfix_audit.iterdir():
            self.assertEqual((path.stat().st_uid, path.stat().st_gid, stat.S_IMODE(path.stat().st_mode)), (0, 0, 0o600))

    def test_hotfix_missing_partial_or_unrecorded_audit_refused(self) -> None:
        """The known replacement alone, a missing completion record or leftover staging cannot authorize deletion."""
        self.recorded_browser_hotfix()
        self.allowed()
        for name in ("manifest.json", "applied.json", "launch.py"):
            with self.subTest(missing=name):
                path = self.hotfix_audit / name
                content = path.read_bytes()
                path.unlink()
                self.refusal_without_effects("audit contents")
                write(path, content, 0o600)
        staged = write(self.release / "server/browser-engine/.outpost2-launch-incomplete.tmp", b"hotfix-secret-payload", 0o600)
        self.refusal_without_effects("staging")
        staged.unlink()
        unknown = self.operation / "unrecorded-audit"
        self.hotfix_audit.rename(unknown)
        self.refusal_without_effects("")

    def test_hotfix_audit_private_identity_and_links_refused(self) -> None:
        """Real root/private/single-link audit requirements cannot be replaced with build ownership or shared files."""
        self.recorded_browser_hotfix()
        self.allowed()
        build = self.identities["outpost-build"]
        for target in (self.hotfix_audit, self.hotfix_audit / "manifest.json", self.hotfix_audit / "applied.json"):
            with self.subTest(target=str(target)):
                mode = stat.S_IMODE(target.stat().st_mode)
                target.chmod(0o755 if target.is_dir() else 0o644)
                self.refusal_without_effects("permissions")
                target.chmod(mode)
                os.chown(target, build.pw_uid, build.pw_gid)
                self.refusal_without_effects("identity")
                os.chown(target, 0, 0)
                if target.is_file():
                    alias = self.operation / "shared-audit-file"
                    os.link(target, alias)
                    self.refusal_without_effects("links")
                    alias.unlink()

    def test_hotfix_foreign_manifest_or_completion_binding_refused(self) -> None:
        """Self-consistent but foreign manifest fields and a wrong live font inode are not trusted provenance."""
        self.recorded_browser_hotfix()
        self.allowed()
        manifest_file = self.hotfix_audit / "manifest.json"
        applied_file = self.hotfix_audit / "applied.json"
        for field, value in (("environmentId", str(uuid.uuid4())), ("operationId", str(uuid.uuid4())),
                             ("archiveSha256", "b" * 64), ("replacementSha256", "b" * 64), ("path", "/srv/qualification/outside")):
            with self.subTest(field=field):
                raw = self.audit_json({**self.hotfix_manifest, field: value})
                write(manifest_file, raw, 0o600)
                write(applied_file, self.audit_json({**self.hotfix_applied, "manifestSha256": hashlib.sha256(raw).hexdigest()}), 0o600)
                self.refusal_without_effects("manifest")
        write(manifest_file, self.audit_json(self.hotfix_manifest), 0o600)
        wrong = copy.deepcopy(self.hotfix_applied)
        wrong["fontconfigIdentity"][1] += 1
        write(applied_file, self.audit_json(wrong), 0o600)
        self.refusal_without_effects("completion")
        write(applied_file, self.audit_json(self.hotfix_applied), 0o600)
        write(manifest_file, helper.encoded(self.hotfix_manifest), 0o600)
        self.refusal_without_effects("exact recorded format")

    def test_hotfix_other_source_or_unpinned_launcher_refused(self) -> None:
        """No production digest is mocked: both a changed replacement and unrelated authenticated source drift refuse."""
        self.recorded_browser_hotfix()
        self.allowed()
        launcher = self.release / "server/browser-engine/launch.py"
        replacement = launcher.read_bytes()
        write(launcher, b"#" + replacement[1:], 0o644)
        self.refusal_without_effects("reviewed replacement")
        write(launcher, replacement, 0o644)
        other = self.release / "package.json"
        expected = other.read_bytes()
        write(other, b"!" + expected[1:], 0o644)
        review = self.refusal_without_effects("Installed source differs")
        self.assert_metadata_diagnostic(review["blockers"][0], other)
        self.assertIn("expected_sha256=" + hashlib.sha256(expected).hexdigest(), review["blockers"][0])
        self.assertIn("current_sha256=" + hashlib.sha256(other.read_bytes()).hexdigest(), review["blockers"][0])

    def test_hotfix_changed_snapshot_and_mounted_audit_refused(self) -> None:
        """Same-byte audit replacement invalidates the snapshot; an actual audit bind mount also refuses."""
        self.recorded_browser_hotfix()
        review = self.allowed()
        target = self.hotfix_audit / "command.log"
        data = target.read_bytes()
        target.unlink()
        write(target, data, 0o600)
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("snapshot changed", result["message"])
        self.assertFalse(Path(helper.RESETS).exists())
        self.allowed()
        self.mount(str(self.hotfix_audit), self.hotfix_audit, bind=True)
        self.refusal_without_effects("Mounted")

    def test_native_metadata_diagnostic_is_bounded_and_nonsecret(self) -> None:
        """A long/control-containing real Linux path reports bounded quoted metadata without payload bytes."""
        parent = self.release
        for index in range(7):
            parent = parent / (str(index) + "-" + "x" * 200)
        path = write(parent / "unsafe-control-\n\t-file", b"diagnostic-secret-payload", 0o666)
        review = self.refusal_without_effects("writable")
        message = review["blockers"][0]
        self.assertIn("...[truncated]...", message)
        self.assertIn("\\n\\t", message)
        self.assertIn(str(self.release), message)
        info = path.stat()
        self.assertIn(f"; mode=0o{info.st_mode:o} uid={info.st_uid} gid={info.st_gid}", message)
        self.assertEqual(path.read_bytes(), b"diagnostic-secret-payload")

    @staticmethod
    def declaration_snapshot(paths: list[Path]) -> dict:
        """Bind link spelling and no-follow metadata separately from regular target bytes."""
        return {str(path): {"inode": helper.stamp(path.lstat()),
                           "value": os.readlink(path) if path.is_symlink() else path.read_bytes()}
                for path in paths}

    def linked_declaration(self, content: bytes | None = None) -> tuple[Path, Path]:
        """Make a root-controlled declaration outside systemd search directories."""
        target = write("/srv/external/qualification-foreign.service", content or
                       b"[Unit]\nDefaultDependencies=no\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/true\n")
        link = Path(helper.UNIT_DIR) / "qualification-foreign.service"
        link.symlink_to(target)
        return link, target

    def test_dracut_nine_external_links_preserved_after_reset(self) -> None:
        """Exercise the reported Ubuntu 26 nine-link layout without installing/running dracut."""
        self.services(active=True)
        marker = Path("/srv/qualification/dracut-hook-ran")
        names = ("pre-udev", "shutdown", "pre-trigger", "shutdown-onfailure", "cmdline",
                 "pre-pivot", "mount", "pre-mount", "initqueue")
        paths = []
        for name in names:
            unit = "dracut-" + name + ".service"
            directory = "77initqueue" if name == "initqueue" else "77dracut-systemd"
            target = Path("/usr/lib/dracut/modules.d") / directory / unit
            link = Path("/usr/lib/systemd/system") / unit
            self.assertFalse(link.exists() or link.is_symlink())
            self.assertFalse(target.exists())
            write(target, ("[Unit]\nDescription=Vendor linked declaration fixture\nDefaultDependencies=no\n"
                           "[Service]\nType=oneshot\nUser=root\nGroup=root\n"
                           "ExecStart=/usr/bin/touch " + str(marker) + "\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
            link.symlink_to(target)
            self.assertEqual((target.stat().st_uid, target.stat().st_gid, stat.S_IMODE(target.stat().st_mode)), (0, 0, 0o644))
            for parent in target.parents:
                info = parent.stat()
                self.assertEqual((info.st_uid, info.st_gid), (0, 0))
                self.assertFalse(info.st_mode & 0o022)
            paths.extend([link, target])
        run(["/usr/bin/systemctl", "daemon-reload"])
        before = self.declaration_snapshot(paths)
        users, groups, _ = self.agent.account_inventory()
        bound = self.agent.other_account_use(users, groups, self.original)["linkedDeclarations"]
        for link, target in zip(paths[::2], paths[1::2]):
            self.assertEqual(bound[str(link)], {"inode": helper.stamp(link.lstat()), "target": str(target)})
            self.assertEqual(bound[str(target)], {"inode": helper.stamp(target.stat()), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
            self.assertIn("directory", bound[str(target.parent)])
        review = self.allowed()
        self.assertEqual(review["services"], list(helper.UNITS))
        self.assertEqual(review["paths"], list(helper.ROOTS))
        self.assertEqual(before, self.declaration_snapshot(paths))
        self.assertFalse(marker.exists())
        audit = self.assert_complete(self.apply(review))
        self.assertEqual(before, self.declaration_snapshot(paths))
        self.assertFalse(marker.exists())
        self.assertEqual([row["step"] for row in audit["steps"] if row["step"].startswith("stop:")],
                         ["stop:" + unit for unit in reversed(helper.UNITS)])
        self.assertTrue(all("dracut" not in row["step"] for row in audit["steps"]))
        print("DRACUT_LINK_QUALIFICATION " + json.dumps({"links": [str(path) for path in paths[::2]],
              "targets": [str(path) for path in paths[1::2]], "preserved": True, "hooksExecuted": False,
              "targetOwner": [0, 0], "targetMode": "0644", "payloadScope": "safe synthetic declarations at reported Ubuntu 26 paths; not dracut runtime/package qualification"}), flush=True)

    def test_external_linked_partof_refused_without_hooks(self) -> None:
        """An inactive external PartOf declaration is inspected from disk, never executed or ignored."""
        link, target = self.linked_declaration()
        self.allowed()
        marker = Path("/srv/qualification/external-partof-hook-ran")
        write(target, ("[Unit]\nPartOf=" + helper.UNITS[0] + "\n[Service]\nType=oneshot\n"
                       "ExecStart=/usr/bin/touch " + str(marker) + "\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
        before = self.declaration_snapshot([link, target])
        review = self.refusal_without_effects("referenced")
        self.assert_metadata_diagnostic(review["blockers"][0], target)
        self.assertEqual(before, self.declaration_snapshot([link, target]))
        self.assertFalse(marker.exists())

    def test_external_linked_active_reverse_stop_refused_without_hooks(self) -> None:
        """Live foreign stop propagation blocks cleanup without executing the external unit's stop hook."""
        self.services(active=True)
        self.allowed()
        marker = Path("/srv/qualification/external-active-stop-hook-ran")
        link, target = self.linked_declaration(("[Unit]\nPartOf=" + helper.UNITS[0] +
            "\n[Service]\nType=simple\nExecStart=/usr/bin/sleep 240\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "start", "--", link.name])
        self.assertEqual(property_value(link.name, "ActiveState"), "active")
        self.assertIn(link.name, property_value(helper.UNITS[0], "ConsistsOf").split())
        before = self.declaration_snapshot([link, target])
        self.refusal_without_effects("stop would propagate")
        self.assertEqual(property_value(link.name, "ActiveState"), "active")
        self.assertTrue(all(property_value(unit, "ActiveState") == "active" for unit in helper.UNITS))
        self.assertFalse(marker.exists())
        self.assertEqual(before, self.declaration_snapshot([link, target]))

    def test_external_linked_native_names_groups_and_numeric_ids_refused(self) -> None:
        """Root-owned external files cannot hide dormant named or numeric dedicated identities."""
        link, target = self.linked_declaration()
        self.allowed()
        coord = self.identities["outpost-coord"]
        worker = self.identities["outpost-pi"]
        marker = Path("/srv/qualification/external-identity-hook-ran")
        entries = (("User=outpost-coord", "referenced"), ("Group=outpost-pi", "referenced"),
                   ("SupplementaryGroups=outpost-workspaces", "referenced"),
                   (f"User=\"{coord.pw_uid}\"", "numeric identity"), (f"Group={worker.pw_gid}", "numeric identity"),
                   (f"SupplementaryGroups=65534 {self.group_ids['outpost-workspaces']}", "numeric identity"))
        for entry, reason in entries:
            with self.subTest(entry=entry):
                write(target, ("[Service]\nType=oneshot\n" + entry + "\nExecStart=/usr/bin/touch " +
                               str(marker) + "\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
                before = self.declaration_snapshot([link, target])
                review = self.refusal_without_effects(reason)
                self.assert_metadata_diagnostic(review["blockers"][0], target)
                self.assertEqual(before, self.declaration_snapshot([link, target]))
                self.assertFalse(marker.exists())

    def test_external_linked_unsafe_chain_refused(self) -> None:
        """Every real chain hop/ancestor/target must remain protected, including before lexical '..'."""
        link, target = self.linked_declaration()
        intermediate = target.parent / "intermediate.service"
        intermediate.symlink_to(target.name)
        link.unlink()
        link.symlink_to(intermediate)
        self.allowed()
        build = self.identities["outpost-build"]
        for path in (link, intermediate, target, target.parent):
            for uid, gid in ((build.pw_uid, 0), (0, build.pw_gid)):
                with self.subTest(path=str(path), uid=uid, gid=gid):
                    os.chown(path, uid, gid, follow_symlinks=False)
                    review = self.refusal_without_effects("")
                    self.assert_metadata_diagnostic(review["blockers"][0], path)
                    os.chown(path, 0, 0, follow_symlinks=False)
        for path in (target, target.parent):
            mode = stat.S_IMODE(path.stat().st_mode)
            for unsafe in (mode | 0o002, mode | 0o020):
                with self.subTest(path=str(path), mode=oct(unsafe)):
                    path.chmod(unsafe)
                    review = self.refusal_without_effects("Unsafe linked unit")
                    self.assert_metadata_diagnostic(review["blockers"][0], path)
                    path.chmod(mode)
        shortcut = Path("/srv/qualification-external-shortcut")
        shortcut.symlink_to(target.parent, target_is_directory=True)
        for text in (str(shortcut / target.name), str(shortcut) + "/../external/" + target.name):
            with self.subTest(target=text):
                link.unlink()
                link.symlink_to(text)
                review = self.refusal_without_effects("ancestor")
                self.assert_metadata_diagnostic(review["blockers"][0], shortcut)
        link.unlink()
        link.symlink_to(intermediate)
        for path in (target, intermediate):
            alias = Path("/srv/qualification/shared-declaration")
            os.link(path, alias, follow_symlinks=False)
            self.refusal_without_effects("linked")
            alias.unlink()
        intermediate.unlink()
        intermediate.symlink_to(link)
        self.refusal_without_effects("Cyclic")

    def test_external_linked_native_alias_and_scope_refused(self) -> None:
        """A protected external hop is not an exemption for indirect native aliases or cleanup-tree traversal."""
        self.services()
        link, target = self.linked_declaration()
        self.allowed()
        target.unlink()
        target.symlink_to(Path(helper.UNIT_DIR) / helper.UNITS[0])
        self.refusal_without_effects("unexpected alias")
        target.unlink()
        native = write(self.release / "external.service", b"[Service]\nExecStart=/usr/bin/true\n")
        target.symlink_to(native)
        self.refusal_without_effects("native cleanup scope")
        target.unlink()
        write("/opt/qualification-external.service", b"[Service]\nExecStart=/usr/bin/true\n")
        target.symlink_to(helper.ROOTS[0] + "/../qualification-external.service")
        self.refusal_without_effects("native cleanup scope")
        self.assertTrue(link.is_symlink())

    def test_external_linked_changed_snapshot_refused(self) -> None:
        """Target contents/inode, symlink spelling/inode and directory identity bind the approved snapshot."""
        link, target = self.linked_declaration()
        changes = ("contents", "target-inode", "link-inode", "link-spelling", "ancestor-inode")
        for change in changes:
            with self.subTest(change=change):
                review = self.allowed()
                if change == "contents":
                    write(target, target.read_bytes() + b"# root-controlled change\n")
                elif change == "target-inode":
                    data = target.read_bytes()
                    target.rename(target.with_name("retained-target"))
                    write(target, data)
                elif change == "link-inode":
                    link.rename(Path("/srv/qualification/retained-systemd-link"))
                    link.symlink_to(target)
                elif change == "link-spelling":
                    link.unlink()
                    link.symlink_to(str(target.parent) + "/./" + target.name)
                else:
                    previous = target.parent.with_name("previous-external")
                    target.parent.rename(previous)
                    target.parent.mkdir(mode=0o755)
                    (previous / target.name).rename(target)
                before = self.declaration_snapshot([link, target])
                result = self.apply(review)
                self.assertEqual(result["state"], "failed")
                self.assertIn("snapshot changed", result["message"])
                self.assertFalse(Path(helper.RESETS).exists())
                self.assertEqual(before, self.declaration_snapshot([link, target]))
                self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))
                self.assertTrue(all(Path(path).exists() for path in helper.ROOTS))
                for name, identity in self.identities.items():
                    self.assertEqual(pwd.getpwnam(name), identity)

    @staticmethod
    def bootstrap_arguments(source: bytes, metadata: list[str] | None = None) -> list[str]:
        """Mirror server_restart.rs: only the real bootstrap and source length/hash enter argv."""
        loader = (SOURCE / "setup_restart_bootstrap.py").read_bytes()
        code = ('import base64;exec(compile(base64.b64decode("' + base64.b64encode(loader).decode("ascii")
                + '"),"<outpost-restart-bootstrap>","exec"))')
        return ["/usr/bin/python3", "-I", "-B", "-S", "-c", code,
                *(metadata if metadata is not None else [str(len(source)), hashlib.sha256(source).hexdigest()])]

    def bootstrap_packet(self, packet: dict, *, padding: int | None = None, unprivileged: bool = False) -> dict:
        """Pass exact helper bytes followed immediately by JSON/newline through a short shell argv command."""
        source = (SOURCE / "setup_restart_helper.py").read_bytes()
        raw = helper.encoded(packet)
        if padding is not None:
            self.assertLessEqual(len(raw), padding)
            raw += b" " * (padding - len(raw))
        self.assertLess(len(raw), 16 * 1024)
        argv = self.bootstrap_arguments(source)
        self.assertEqual(len(argv), 8)
        command = shlex.join(argv)
        self.assertLess(len(command.encode()) + len("sudo -k -S -p '' -- "), 8192)
        self.assertNotIn(base64.b64encode(source).decode("ascii"), command)
        self.assertNotIn(packet["resetId"], command)
        execution = ["/bin/sh", "-c", command]
        if unprivileged:
            execution = ["/usr/bin/setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", *execution]
        result = run(execution, data=source + raw + b"\n", seconds=340)
        self.assertEqual(result.stderr, b"")
        response = json.loads(result.stdout)
        self.assertIsInstance(response, dict)
        print("BOOTSTRAP_TRANSPORT " + json.dumps({"mode": packet["mode"], "sourceBytes": len(source),
              "sourceSha256": hashlib.sha256(source).hexdigest(), "bootstrapSha256": hashlib.sha256((SOURCE / "setup_restart_bootstrap.py").read_bytes()).hexdigest(),
              "nativeCommandBytes": len(command.encode()), "loaderArgumentBytes": len(argv[5].encode()),
              "packetBytesIncludingNewline": len(raw) + 1, "frameBytes": len(source) + len(raw) + 1,
              "sourceInArgv": False, "packetInArgv": False, "helperReceivedExtraArgv": False,
              "pythonFlags": argv[1:4], "unprivileged": unprivileged, "response": response}), flush=True)
        print("HELPER " + json.dumps(response, sort_keys=True), flush=True)
        return response

    def test_bootstrap_real_helper_status_and_packet_limits(self) -> None:
        """Unchanged 98k-plus helper executes status from stdin, with no helper argv and exact packet boundary."""
        native = (SOURCE / "server_restart.rs").read_text()
        for contract in ("const MAX_HELPER_BYTES: usize = 1024 * 1024;", "const MAX_PACKET: usize = 16 * 1024;",
                         "const MAX_RESTART_COMMAND: usize = 8 * 1024;", "/usr/bin/python3 -I -B -S -c",
                         "STANDARD.encode(BOOTSTRAP), source.len(), Sha256::digest(source)",
                         "payload.extend_from_slice(source);", "payload.extend_from_slice(packet);",
                         "packet.len() >= MAX_PACKET"):
            self.assertIn(contract, native)
        source = (SOURCE / "setup_restart_helper.py").read_bytes()
        self.assertGreater(len(source), 98_000)
        packet = {**self.request, "mode": "status"}
        before = snapshot([*self.sentinels, *self.evidence_paths])
        direct = packet_result(packet)
        normal = self.bootstrap_packet(packet)
        self.assertEqual(normal, direct)
        self.assertEqual(normal["state"], "unknown")
        self.assertEqual(self.bootstrap_packet(packet, padding=16383, unprivileged=True), normal)
        self.assertEqual(before, snapshot([*self.sentinels, *self.evidence_paths]))
        self.assertFalse(Path(helper.RESETS).exists())
        raw = helper.encoded(packet)
        oversized = raw + b" " * (16384 - len(raw)) + b"\n"
        result = run(self.bootstrap_arguments(source), data=source + oversized, seconds=30, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"Setup restart helper refused the request; no verified completion was returned.\n")
        print("BOOTSTRAP_PACKET_LIMIT " + json.dumps({"sourceLimitBytes": 1048576,
              "nativePacketLimitExclusive": 16384, "acceptedPacketBytesIncludingNewline": 16384,
              "rejectedPacketBytesIncludingNewline": len(oversized), "oversizeRejectedByActualHelper": True}), flush=True)

    def test_bootstrap_real_helper_reset_via_stdin(self) -> None:
        """A genuine reset, not a synthetic receipt, traverses the exact production loader and stdin frame."""
        review = self.bootstrap_packet(self.request)
        self.assertTrue(review["canReset"], review["blockers"])
        result = self.bootstrap_packet({**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]})
        self.assert_complete(result)
        self.assertEqual(self.bootstrap_packet({**self.request, "mode": "status"}, unprivileged=True), result)

    def test_bootstrap_corrupt_real_source_frames_refused(self) -> None:
        """Incorrect hashes, truncation and prefix shifts refuse without reaching even read-only helper status."""
        source = (SOURCE / "setup_restart_helper.py").read_bytes()
        packet = helper.encoded({**self.request, "mode": "status"}) + b"\n"
        before = snapshot([*self.sentinels, *self.evidence_paths])
        for label, frame, metadata in (
            ("wrong-hash", source + packet, [str(len(source)), "0" * 64]),
            ("truncated", source[:-1], None), ("shifted-boundary", source[:-1] + packet, None),
            ("changed-source", b"#" + source[1:] + packet, None), ("packet-only", packet, None)):
            with self.subTest(frame=label):
                result = run(self.bootstrap_arguments(source, metadata), data=frame, seconds=30, check=False)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"Setup restart bootstrap refused the frame; no verified completion was returned.\n")
        self.assertEqual(before, snapshot([*self.sentinels, *self.evidence_paths]))
        self.assertFalse(Path(helper.RESETS).exists())

    def test_linux_argument_limit_negative_control(self) -> None:
        """Use only /usr/bin/true to demonstrate Linux E2BIG for the legacy expanded single argument."""
        source = (SOURCE / "setup_restart_helper.py").read_bytes()
        legacy = "/usr/bin/python3 -I -B -S -c 'import base64;exec(base64.b64decode(\"" + base64.b64encode(source).decode("ascii") + "\"))'"
        page_size = os.sysconf("SC_PAGE_SIZE")
        argument_limit = 32 * page_size
        accepted_length = min(argument_limit - 1, os.sysconf("SC_ARG_MAX") // 4)
        run(["/usr/bin/true", "x" * accepted_length], seconds=5)
        rejected_length = max(argument_limit, len(legacy.encode()))
        with self.assertRaises(OSError) as caught:
            run(["/usr/bin/true", "x" * rejected_length], seconds=5)
        self.assertEqual(caught.exception.errno, errno.E2BIG)
        command = shlex.join(self.bootstrap_arguments(source))
        self.assertLess(len(command.encode()), min(argument_limit, 8192))
        print("LINUX_ARGV_LIMIT " + json.dumps({"pageSize": page_size, "maxArgStringBytesIncludingNul": argument_limit,
              "aggregateArgMax": os.sysconf("SC_ARG_MAX"), "acceptedHarmlessArgumentBytes": accepted_length,
              "rejectedHarmlessArgumentBytes": rejected_length, "errno": caught.exception.errno,
              "legacyRemoteCommandBytes": len(legacy.encode()), "legacyExceedsSingleArgumentLimit": len(legacy.encode()) >= argument_limit,
              "nativeBootstrapCommandBytes": len(command.encode()), "negativeControlExecutable": "/usr/bin/true"}), flush=True)

    def real_build_identity_993_979(self) -> None:
        """Create the regression's distinct real UID/GID using only disposable container accounts."""
        require_container()
        build = self.identities["outpost-build"]
        self.assertTrue(all(row.pw_uid != 993 for row in pwd.getpwall() if row.pw_name != build.pw_name))
        self.assertTrue(all(row.gr_gid != 979 for row in grp.getgrall() if row.gr_name != build.pw_name))
        self.assertTrue(all(row.pw_gid != 979 for row in pwd.getpwall() if row.pw_name != build.pw_name))
        owned = []
        for root in (self.release, self.operation / "build-home"):
            for path in (root, *root.rglob("*")):
                info = path.lstat()
                owned.append((path, 993 if info.st_uid == build.pw_uid else info.st_uid,
                              979 if info.st_gid == build.pw_gid else info.st_gid))
        run(["/usr/sbin/groupmod", "--gid", "979", "outpost-build"])
        run(["/usr/sbin/usermod", "--uid", "993", "--gid", "979", "outpost-build"])
        for path, uid, gid in owned:
            os.chown(path, uid, gid, follow_symlinks=False)
        self.identities["outpost-build"] = pwd.getpwnam("outpost-build")
        self.group_ids["outpost-build"] = grp.getgrnam("outpost-build").gr_gid
        self.assertEqual((self.identities["outpost-build"].pw_uid, self.identities["outpost-build"].pw_gid), (993, 979))
        self.preserved = snapshot([*self.sentinels, *self.evidence_paths])
        print("REAL_NATIVE_IDENTITY " + json.dumps({"name": "outpost-build", "uid": 993, "gid": 979}), flush=True)

    def manager_instance_names(self) -> list[str]:
        """Read the actual bounded manager inventory without asking it to load any instance."""
        rows = json.loads(run(list(helper.INSTANCE_LIST_COMMAND)).stdout)
        self.assertIsInstance(rows, list)
        return sorted(row["unit"] for row in rows)

    def observed_instance_properties(self, name: str) -> dict:
        """Retain actual systemd output before the unchanged production validator; never normalize missing fields."""
        raw = run(["/usr/bin/systemctl", "show", "--all", "--no-pager",
                   "--property=" + ",".join(helper.INSTANCE_PROPERTIES), "--", name]).stdout.decode()
        print("SYSTEMD_INSTANCE_PROPERTIES_OBSERVED " + json.dumps({"instance": name, "raw": raw}), flush=True)
        return self.agent.instance_properties(name)

    def instance_template(self, prefix: str, *, user: str = "%i", group: str = "%i", start_hook: bool = False) -> tuple[Path, Path]:
        """Use harmless oneshots, never the real user manager or an installed application."""
        marker = Path("/tmp") / (prefix + "-hook-ran")
        path = Path(helper.UNIT_DIR) / (prefix + "@.service")
        self.assertFalse(path.exists())
        start = "/usr/bin/touch " + str(marker) if start_hook else "/usr/bin/true"
        write(path, ("[Unit]\nDescription=Disposable instance %i\nDefaultDependencies=no\n"
                     "[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=" + user + "\nGroup=" + group +
                     "\nExecStart=" + start + "\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
        return path, marker

    def test_systemd_continued_native_gid_refused(self) -> None:
        """Real GID 979 remains visible across physical lines, comment blocks and CRLF."""
        self.real_build_identity_993_979()
        link, target = self.linked_declaration()
        self.allowed()
        marker = Path("/tmp/continued-gid-hook-ran")
        declarations = (
            "SupplementaryGroups=65534 \\\n    979",
            "SupplementaryGroups=65534 \\\n# skipped \\\n ; skipped too\n  979",
            "SupplementaryGroups=65534 \\\r\n\t# skipped\r\n\t979",
        )
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                write(target, ("[Service]\nType=oneshot\n" + declaration + "\nExecStart=/usr/bin/touch " + str(marker) + "\n").encode())
                run(["/usr/bin/systemctl", "daemon-reload"])
                effective = property_value(link.name, "SupplementaryGroups")
                self.assertIn("979", effective.split())
                before = self.declaration_snapshot([link, target])
                review = self.refusal_without_effects("numeric identity")
                self.assert_metadata_diagnostic(review["blockers"][0], target)
                self.assertEqual(before, self.declaration_snapshot([link, target]))
                self.assertFalse(marker.exists())
                print("SYSTEMD_IDENTITY_AUDIT " + json.dumps({"case": "continued-gid", "nativeUid": 993,
                      "nativeGid": 979, "declaration": declaration, "managerSupplementaryGroups": effective,
                      "refusedBeforeIntent": True, "hooksExecuted": False}), flush=True)
        write(target, b"[Service]\nType=oneshot\nExecStart=/usr/bin/true\n")
        dropin = write(Path(helper.UNIT_DIR) / (link.name + ".d") / "groups.conf",
                       b"[Service]\nSupplementaryGroups=65534 \\\n  979\n")
        run(["/usr/bin/systemctl", "daemon-reload"])
        self.assertIn("979", property_value(link.name, "SupplementaryGroups").split())
        review = self.refusal_without_effects("numeric identity")
        self.assert_metadata_diagnostic(review["blockers"][0], dropin)

    def test_systemd_quoted_native_identity_lists_refused(self) -> None:
        """Actual systemd's quoted lists and single numeric IDs cannot hide a dedicated UID or GID."""
        self.real_build_identity_993_979()
        link, target = self.linked_declaration()
        self.allowed()
        for key, value in (("SupplementaryGroups", '"65534" "979"'),
                           ("SupplementaryGroups", "'65534' '979'"),
                           ("SupplementaryGroups", '"65534" \\\n  "979"'),
                           ("Group", '"979"'), ("User", "'993'")):
            with self.subTest(key=key, value=value):
                write(target, ("[Service]\nType=oneshot\n" + key + "=" + value + "\nExecStart=/usr/bin/true\n").encode())
                run(["/usr/bin/systemctl", "daemon-reload"])
                raw = run(["/usr/bin/systemctl", "show", "--property=" + key, "--value", "--", link.name]).stdout.decode()
                print("SYSTEMD_QUOTED_PROPERTIES_OBSERVED " + json.dumps({"unit": link.name, "property": key,
                      "sourceValue": value, "rawStdout": raw}), flush=True)
                # systemd preserves/escapes quote characters here; do not normalize its properties.
                self.assertIn("993" if key == "User" else "979", raw)
                review = self.refusal_without_effects("numeric identity")
                self.assert_metadata_diagnostic(review["blockers"][0], target)
                print("SYSTEMD_IDENTITY_AUDIT " + json.dumps({"case": "quoted-identity", "property": key,
                      "sourceValue": value, "managerRawStdout": raw, "refusedBeforeIntent": True}), flush=True)

    def test_systemd_unknown_identity_and_activation_syntax_refused(self) -> None:
        """Unverified escapes/specifiers stay refused instead of being partially interpreted."""
        self.real_build_identity_993_979()
        _, target = self.linked_declaration()
        self.allowed()
        for value in (r"\x39\x37\x39", r"\071\067\071", "%U", "%G", "%i", '"65534 65533"'):
            with self.subTest(identity=value):
                write(target, ("[Service]\nGroup=" + value + "\nExecStart=/usr/bin/true\n").encode())
                self.refusal_without_effects("Unsupported systemd identity syntax")
        write(target, b"[Service]\nType=oneshot\nExecStart=/usr/bin/true\n")
        maintenance = Path(helper.UNIT_DIR) / "qualification-maintenance.target"
        for value in ("foreign-worker@%U.service", "foreign-worker@%I.service", "foreign-worker@%i.service", r"foreign-worker@\071\071\063.service"):
            with self.subTest(activation=value):
                write(maintenance, ("[Unit]\nWants=" + value + "\n").encode())
                self.refusal_without_effects("Unsupported systemd activation syntax")

    def test_stock_user_templates_preserved_by_reset(self) -> None:
        """Audit the unmodified installed Ubuntu user@ templates, not synthesized replacements."""
        self.real_build_identity_993_979()
        paths = [Path("/usr/lib/systemd/system/user@.service"), Path("/usr/lib/systemd/system/user-runtime-dir@.service")]
        for path in paths:
            self.assertTrue(path.is_file())
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (0, 0))
            self.assertFalse(path.stat().st_mode & 0o022)
        self.assertIn(b"User=%i", paths[0].read_bytes())
        before = self.declaration_snapshot(paths)
        inventory = self.manager_instance_names()
        users, groups, _ = self.agent.account_inventory()
        configuration = self.agent.other_account_use(users, groups, self.original)
        self.assertTrue({path.name for path in paths} <= set(configuration["unitContexts"]))
        review = self.allowed()
        self.assertEqual(before, self.declaration_snapshot(paths))
        self.assertEqual(inventory, self.manager_instance_names())
        audit = self.assert_complete(self.apply(review))
        self.assertFalse(any(step["step"].startswith("stop:") for step in audit["steps"]))
        self.assertEqual(before, self.declaration_snapshot(paths))
        print("SYSTEMD_TEMPLATE_AUDIT " + json.dumps({"source": "unchanged stock Ubuntu package files",
              "templates": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
              "genericPercentIAllowed": True, "preservedAfterReset": True, "nativeUid": 993, "nativeGid": 979}), flush=True)

    def test_configured_template_native_instances_refused(self) -> None:
        """Configured stock instances and instance-only drop-ins block without loading/running them."""
        self.real_build_identity_993_979()
        self.allowed()
        templates = [Path("/usr/lib/systemd/system/user@.service"), Path("/usr/lib/systemd/system/user-runtime-dir@.service")]
        before = self.declaration_snapshot(templates)
        wants = Path(helper.UNIT_DIR) / "multi-user.target.wants"
        wants.mkdir(exist_ok=True)
        for template in templates:
            for identity in ("993", "979", "outpost-build", "outpost-workspaces"):
                name = template.name.replace("@.", "@" + identity + ".")
                with self.subTest(instance=name):
                    link = wants / name
                    link.symlink_to(template)
                    inventory = self.manager_instance_names()
                    self.assertNotIn(name, inventory)
                    self.refusal_without_effects("native identity")
                    self.assertEqual(inventory, self.manager_instance_names())
                    link.unlink()
        dropin = write(Path(helper.UNIT_DIR) / "user@979.service.d/identity.conf", b"[Service]\nGroup=nogroup\n")
        self.refusal_without_effects("native identity")
        self.assertNotIn("user@979.service", self.manager_instance_names())
        self.assertTrue(dropin.is_file())
        self.assertEqual(before, self.declaration_snapshot(templates))
        print("SYSTEMD_INSTANCE_AUDIT " + json.dumps({"case": "configured", "nativeUid": 993, "nativeGid": 979,
              "configuredIdentityVariants": ["993", "979", "outpost-build", "outpost-workspaces"],
              "managerInventoryUnchanged": True, "stockTemplatesUnchanged": True}), flush=True)

    def loaded_native_instance_refusal(self, *, group: bool) -> None:
        """Keep a real active/exited instance in PID 1 with no corresponding concrete disk entry or live process."""
        self.real_build_identity_993_979()
        prefix = "qualification-group" if group else "qualification-user"
        template, marker = self.instance_template(prefix, user="root" if group else "%i", group="%i" if group else "root")
        self.allowed()
        name = prefix + ("@979.service" if group else "@993.service")
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "start", "--", name])
        self.assertEqual(property_value(name, "ActiveState"), "active")
        self.assertEqual(property_value(name, "SubState"), "exited")
        self.assertEqual(property_value(name, "MainPID"), "0")
        self.assertFalse((Path(helper.UNIT_DIR) / name).exists())
        self.assertFalse((Path("/run/systemd/transient") / name).exists())
        self.assertIn(name, self.manager_instance_names())
        properties = self.observed_instance_properties(name)
        self.assertEqual(properties["Group" if group else "User"], "979" if group else "993")
        before = self.declaration_snapshot([template])
        self.refusal_without_effects("native identity")
        self.assertEqual(before, self.declaration_snapshot([template]))
        self.assertEqual(property_value(name, "ActiveState"), "active")
        self.assertFalse(marker.exists())
        print("SYSTEMD_INSTANCE_AUDIT " + json.dumps({"case": "loaded-native-gid" if group else "loaded-native-uid",
              "instance": name, "properties": properties, "concreteDiskEntry": False, "livePid": 0,
              "refusedBeforeIntent": True, "hooksExecuted": False}), flush=True)

    def test_loaded_template_native_uid_refused(self) -> None:
        """Loaded-only UID 993 is rejected based on manager inventory, not a configured instance or live process."""
        self.loaded_native_instance_refusal(group=False)

    def test_loaded_template_native_gid_refused(self) -> None:
        """Loaded-only GID 979 is rejected even though it differs from the build UID."""
        self.loaded_native_instance_refusal(group=True)

    def test_loaded_benign_template_instance_preserved_after_reset(self) -> None:
        """Real resolved User/Group properties and template source are audited without stopping a benign instance."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("qualification-benign")
        name = "qualification-benign@65534.service"
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "start", "--", name])
        self.assertEqual(property_value(name, "SubState"), "exited")
        self.assertIn(name, self.manager_instance_names())
        properties = self.observed_instance_properties(name)
        self.assertEqual((properties["User"], properties["Group"]), ("65534", "65534"))
        users, groups, _ = self.agent.account_inventory()
        evidence = self.agent.other_account_use(users, groups, self.original)
        self.assertEqual(evidence["loadedInstances"][name], properties)
        before = self.declaration_snapshot([template])
        self.assert_complete(self.apply(self.allowed()))
        self.assertEqual(before, self.declaration_snapshot([template]))
        self.assertEqual(properties, self.agent.instance_properties(name))
        self.assertEqual(property_value(name, "ActiveState"), "active")
        self.assertFalse(marker.exists())
        print("SYSTEMD_INSTANCE_AUDIT " + json.dumps({"case": "loaded-benign-reset", "instance": name,
              "properties": properties, "preservedAfterReset": True, "hooksExecuted": False}), flush=True)

    def test_loaded_inventory_and_stale_declaration_snapshot_refused(self) -> None:
        """A newly loaded instance invalidates approval, and NeedDaemonReload is never hidden or normalized."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("qualification-snapshot")
        name = "qualification-snapshot@65534.service"
        run(["/usr/bin/systemctl", "daemon-reload"])
        review = self.allowed()
        self.assertNotIn(name, self.manager_instance_names())
        run(["/usr/bin/systemctl", "start", "--", name])
        self.assertIn(name, self.manager_instance_names())
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("snapshot changed", result["message"])
        self.assertFalse(Path(helper.RESETS).exists())
        self.allowed()
        write(template, template.read_bytes() + b"# root-controlled update, reload not performed\n")
        self.assertEqual(property_value(name, "NeedDaemonReload"), "yes")
        self.refusal_without_effects("Loaded instance identity or declaration is unverified")
        self.assertEqual(property_value(name, "ActiveState"), "active")
        self.assertFalse(marker.exists())

    def test_unloaded_dependency_only_native_instances_refused(self) -> None:
        """Raw, quoted, continued and escaped native-instance dependencies in unloaded targets cannot hide identity use."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        maintenance = write(Path(helper.UNIT_DIR) / "qualification-maintenance.target",
                            b"[Unit]\nWants=foreign-worker@65534.service\n")
        inventory = self.manager_instance_names()
        self.allowed()
        self.assertEqual(inventory, self.manager_instance_names())
        references = ("foreign-worker@993.service", "foreign-worker@979.service", '"foreign-worker@993.service"',
                      "ordinary.service \\\n# skipped\n ; skipped too\n 'foreign-worker@979.service'",
                      r"foreign-worker@\x39\x39\x33.service", r'"foreign-worker@\x39\x37\x39.service"',
                      r"foreign-worker@outpost\x2dbuild.service")
        for reference in references:
            with self.subTest(reference=reference):
                write(maintenance, ("[Unit]\nWants=" + reference + "\n").encode())
                before = self.declaration_snapshot([template, maintenance])
                review = self.refusal_without_effects("native identity")
                self.assert_metadata_diagnostic(review["blockers"][0], maintenance)
                self.assertEqual(before, self.declaration_snapshot([template, maintenance]))
                self.assertEqual(inventory, self.manager_instance_names())
                self.assertFalse((Path(helper.UNIT_DIR) / "foreign-worker@993.service").exists())
                self.assertFalse((Path(helper.UNIT_DIR) / "foreign-worker@979.service").exists())
                self.assertFalse(marker.exists())
        print("SYSTEMD_INSTANCE_AUDIT " + json.dumps({"case": "unloaded-dependency-only", "references": references,
              "concreteDiskEntries": False, "managerInventoryUnchanged": True, "hooksExecuted": False}), flush=True)

    def test_unloaded_transitive_and_source_context_native_instances_refused(self) -> None:
        """Deferred source-context expansion cannot construct a native UID/GID through unloaded target chains."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        relay = write(Path(helper.UNIT_DIR) / "qualification-relay@.target", b"[Unit]\nWants=foreign-worker@9%i.service\n")
        maintenance = Path(helper.UNIT_DIR) / "qualification-maintenance.target"
        inventory = self.manager_instance_names()
        for suffix in ("93", "79"):
            write(maintenance, ("[Unit]\nWants=qualification-relay@" + suffix + ".target\n").encode())
            self.refusal_without_effects("native identity")
            self.assertEqual(inventory, self.manager_instance_names())
            self.assertFalse(marker.exists())
        maintenance.unlink()
        relay.unlink()
        external = write("/srv/qualification/source-context-template", b"[Unit]\nWants=foreign-worker@%p.service\n")
        source = Path(helper.UNIT_DIR) / "993.target"
        source.symlink_to(external)
        self.refusal_without_effects("native identity")
        self.assertEqual(inventory, self.manager_instance_names())
        self.assertTrue(template.is_file())
        self.assertFalse(marker.exists())
        print("SYSTEMD_INSTANCE_AUDIT " + json.dumps({"case": "transitive-source-context",
              "transitiveNativeIds": [993, 979], "symlinkSourceUnit": source.name, "managerInventoryUnchanged": True,
              "hooksExecuted": False}), flush=True)

    def test_benign_unloaded_dependency_cycle_preserved_after_reset(self) -> None:
        """Bounded transitive auditing accepts benign cycles without asking systemd to load or execute the graph."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        relay = write(Path(helper.UNIT_DIR) / "qualification-relay@.target",
                      b"[Unit]\nWants=foreign-worker@%i.service qualification-loop@%i.target\n")
        loop = write(Path(helper.UNIT_DIR) / "qualification-loop@.target", b"[Unit]\nWants=qualification-relay@%i.target\n")
        maintenance = write(Path(helper.UNIT_DIR) / "qualification-maintenance.target",
                            b"[Unit]\nWants=qualification-relay@65534.target\n")
        paths = [template, relay, loop, maintenance]
        before = self.declaration_snapshot(paths)
        inventory = self.manager_instance_names()
        users, groups, _ = self.agent.account_inventory()
        configuration = self.agent.other_account_use(users, groups, self.original)
        self.assertIn("foreign-worker@65534.service", configuration["unitContexts"])
        self.assertEqual(inventory, self.manager_instance_names())
        self.assert_complete(self.apply(self.allowed()))
        self.assertEqual(before, self.declaration_snapshot(paths))
        self.assertEqual(inventory, self.manager_instance_names())
        self.assertFalse(marker.exists())
        print("SYSTEMD_INSTANCE_AUDIT " + json.dumps({"case": "benign-unloaded-cycle", "preservedAfterReset": True,
              "managerInventoryUnchanged": True, "hooksExecuted": False}), flush=True)

    def test_cron_shell_assignments_preserved_after_reset(self) -> None:
        """Cron shell variables are not systemd identity directives; actual native-account references remain separate."""
        self.real_build_identity_993_979()
        marker = Path("/tmp/qualification-cron-executed")
        content = b"#!/bin/sh\nUser=%i\nGroup=979\nSupplementaryGroups='ordinary shell value'\n/usr/bin/touch /tmp/qualification-cron-executed\nexit 0\n"
        direct = write("/etc/cron.daily/qualification-shell", content, 0o755)
        target = write("/srv/qualification/cron-shell", content, 0o755)
        linked = Path("/etc/cron.hourly/qualification-shell")
        linked.parent.mkdir(exist_ok=True)
        linked.symlink_to(target)
        paths = [direct, linked, target]
        before = self.declaration_snapshot(paths)
        self.assert_complete(self.apply(self.allowed()))
        self.assertEqual(before, self.declaration_snapshot(paths))
        self.assertFalse(marker.exists())
        print("CRON_IDENTITY_QUALIFICATION " + json.dumps({"nativeUid": 993, "nativeGid": 979,
              "shellVariablesNotSystemd": True, "preservedAfterReset": True, "cronExecuted": False}), flush=True)

    def test_cron_literal_native_identity_or_scope_refused(self) -> None:
        """Not parsing cron as systemd never exempts literal native user or native path usage."""
        self.real_build_identity_993_979()
        self.allowed()
        marker = Path("/tmp/qualification-cron-hook-ran")
        for content in (("* * * * * outpost-build /usr/bin/touch " + str(marker) + "\n").encode(),
                        b"#!/bin/sh\ncat /etc/outpost-native/coordinator.env\n"):
            target = write("/etc/cron.d/qualification-native", content)
            before = self.declaration_snapshot([target])
            self.refusal_without_effects("referenced")
            self.assertEqual(before, self.declaration_snapshot([target]))
            self.assertFalse(marker.exists())

    def test_sshd_keygen_exact_plain_template_reference_preserved_reset(self) -> None:
        """Exact reported keygen declaration resolves sshd@ via real systemd without starting SSH or key generation."""
        parsed = ast.parse((SOURCE / "test_setup_restart_helper.py").read_text())
        fixture = next(node for node in ast.walk(parsed) if isinstance(node, ast.FunctionDef)
                       and node.name == "test_sshd_keygen_generic_ordering_and_install_references_are_preserved")
        assignment = next(node for node in fixture.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == "content" for target in node.targets))
        content = ast.literal_eval(assignment.value)
        self.assertIsInstance(content, bytes)
        path = Path("/usr/lib/systemd/system/sshd-keygen.service")
        template = Path("/usr/lib/systemd/system/sshd@.service")
        self.assertFalse(path.exists() or template.exists())
        marker = Path("/tmp/qualification-sshd-hook-ran")
        write(path, content)
        write(template, ("[Unit]\nDefaultDependencies=no\n[Service]\nType=oneshot\nUser=root\nGroup=root\n"
                         "ExecStart=/usr/bin/touch " + str(marker) + "\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
        before = self.declaration_snapshot([path, template])
        keys_before = snapshot(sorted(Path("/etc/ssh").glob("ssh_host_*")))
        run(["/usr/bin/systemctl", "daemon-reload"])
        before_property = property_value(path.name, "Before")
        implicit = "sshd@sshd-keygen.service"
        self.assertIn(implicit, before_property.split())
        self.assertEqual(property_value(path.name, "ActiveState"), "inactive")
        self.assertEqual(property_value(path.name, "ExecMainStartTimestampMonotonic"), "0")
        users, groups, _ = self.agent.account_inventory()
        configuration = self.agent.other_account_use(users, groups, self.original)
        self.assertIn(implicit, configuration["unitContexts"])
        self.assertTrue(any(row[2] == "Before" and row[3] == "sshd@.service" and row[4] == implicit
                            for row in configuration["activationReferences"]))
        self.assertTrue(any(row[2] == "WantedBy" and row[3] == "sshd@.service" and row[4] == implicit
                            for row in configuration["activationReferences"]))
        audit = self.assert_complete(self.apply(self.allowed()))
        self.assertEqual(before, self.declaration_snapshot([path, template]))
        self.assertEqual(keys_before, snapshot(sorted(Path("/etc/ssh").glob("ssh_host_*"))))
        self.assertFalse(marker.exists())
        self.assertEqual(property_value(path.name, "ActiveState"), "inactive")
        self.assertEqual(property_value(path.name, "ExecMainStartTimestampMonotonic"), "0")
        self.assertTrue(all("ssh" not in step["step"] for step in audit["steps"]))
        print("PLAIN_TEMPLATE_PREFIX_QUALIFICATION " + json.dumps({"case": "exact-sshd-keygen-reset",
              "unitSha256": hashlib.sha256(content).hexdigest(), "exactUnitText": content.decode(),
              "sourceUnit": path.name, "managerBefore": before_property, "resolvedInstance": implicit,
              "orderingAndInstallReferencesAudited": True, "filesPreserved": True, "hooksExecuted": False,
              "keygenStartTimestampMonotonic": "0", "sshHostKeysUnchanged": True}), flush=True)

    def test_plain_numeric_prefix_template_references_refused(self) -> None:
        """Real UID 993 and GID 979 cannot hide behind a plain source unit's implicit instance prefix."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        self.allowed()
        inventory = self.manager_instance_names()
        for prefix in ("993", "979"):
            path = Path(helper.UNIT_DIR) / (prefix + ".service")
            for key, section in (("Before", "Unit"), ("Wants", "Unit"), ("WantedBy", "Install")):
                with self.subTest(prefix=prefix, directive=key):
                    write(path, ("[Service]\nType=oneshot\nExecStart=/usr/bin/true\n[" + section + "]\n" +
                                 key + "=foreign-worker@.service\n").encode())
                    before = self.declaration_snapshot([path, template])
                    self.refusal_without_effects("native identity")
                    self.assertEqual(before, self.declaration_snapshot([path, template]))
                    self.assertEqual(inventory, self.manager_instance_names())
                    self.assertFalse(marker.exists())
            path.unlink()
        print("PLAIN_TEMPLATE_PREFIX_QUALIFICATION " + json.dumps({"case": "numeric-prefix-refused",
              "nativeUid": 993, "nativeGid": 979, "prefixes": ["993", "979"],
              "directives": ["Before", "Wants", "WantedBy"], "refusedBeforeIntent": True,
              "managerInventoryUnchanged": True, "hooksExecuted": False}), flush=True)

    def test_plain_alias_template_source_prefix_refused(self) -> None:
        """External fragment basenames cannot replace the native-identity-bearing source alias context."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        fragment = write("/srv/qualification/benign-fragment", b"[Unit]\nBefore=foreign-worker@.service\n")
        self.allowed()
        inventory = self.manager_instance_names()
        for prefix in ("993", "979"):
            alias = Path(helper.UNIT_DIR) / (prefix + ".service")
            alias.symlink_to(fragment)
            before = self.declaration_snapshot([template, fragment, alias])
            review = self.refusal_without_effects("native identity")
            self.assert_metadata_diagnostic(review["blockers"][0], fragment)
            self.assertEqual(before, self.declaration_snapshot([template, fragment, alias]))
            self.assertEqual(inventory, self.manager_instance_names())
            self.assertFalse(marker.exists())
            alias.unlink()
        print("PLAIN_TEMPLATE_PREFIX_QUALIFICATION " + json.dumps({"case": "alias-source-prefix-refused",
              "sourceAliases": ["993.service", "979.service"], "fragment": str(fragment),
              "refusedBeforeIntent": True, "hooksExecuted": False}), flush=True)

    def test_plain_contextless_template_selectors_refused(self) -> None:
        """Ambiguous selectors stay outside the ordering/install prefix-fallback exception."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        path = Path(helper.UNIT_DIR) / "qualification-plain.service"
        self.allowed()
        for key in ("Alias", "Also", "Sockets", "Service", "Unit", "DefaultInstance"):
            with self.subTest(directive=key):
                value = "979" if key == "DefaultInstance" else "foreign-worker@.service"
                write(path, ("[Unit]\n" + key + "=" + value + "\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n").encode())
                before = self.declaration_snapshot([path, template])
                self.refusal_without_effects("Unsupported systemd activation")
                self.assertEqual(before, self.declaration_snapshot([path, template]))
                self.assertFalse(marker.exists())

    def test_plain_template_reference_does_not_hide_explicit_native_use(self) -> None:
        """An accepted symbolic reference neither skips explicit native references nor authorizes a changed snapshot."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("foreign-worker", start_hook=True)
        path = write(Path(helper.UNIT_DIR) / "qualification-plain.service", b"[Unit]\nBefore=foreign-worker@.service\n")
        review = self.allowed()
        write(path, b"[Unit]\nBefore=foreign-worker@.service foreign-worker@979.service\n")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("native identity", result["message"])
        self.assertFalse(Path(helper.RESETS).exists())
        self.refusal_without_effects("native identity")
        write(path, ("[Unit]\nBefore=foreign-worker@.service " + helper.UNITS[0] + "\n").encode())
        self.refusal_without_effects("referenced")
        self.assertTrue(template.is_file())
        self.assertFalse(marker.exists())

    @contextmanager
    def pinned_unit_metadata(self, name: str) -> Iterator[None]:
        """Pin an inactive real manager object through sd-bus LoadUnit/RefUnit, without starting its program."""
        require_container()
        run(["/usr/bin/systemctl", "start", "--", "dbus.service"])
        library = ctypes.CDLL("libsystemd.so.0")
        pointer = ctypes.c_void_p
        library.sd_bus_new.argtypes = [ctypes.POINTER(pointer)]
        library.sd_bus_new.restype = ctypes.c_int
        library.sd_bus_set_address.argtypes = [pointer, ctypes.c_char_p]
        library.sd_bus_set_address.restype = ctypes.c_int
        library.sd_bus_set_bus_client.argtypes = [pointer, ctypes.c_int]
        library.sd_bus_set_bus_client.restype = ctypes.c_int
        library.sd_bus_set_method_call_timeout.argtypes = [pointer, ctypes.c_uint64]
        library.sd_bus_set_method_call_timeout.restype = ctypes.c_int
        library.sd_bus_start.argtypes = [pointer]
        library.sd_bus_start.restype = ctypes.c_int
        library.sd_bus_call_method.argtypes = [pointer, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                                              ctypes.c_char_p, pointer, ctypes.POINTER(pointer), ctypes.c_char_p]
        library.sd_bus_call_method.restype = ctypes.c_int
        library.sd_bus_message_unref.argtypes = [pointer]
        library.sd_bus_message_unref.restype = pointer
        library.sd_bus_flush_close_unref.argtypes = [pointer]
        library.sd_bus_flush_close_unref.restype = pointer
        bus = pointer()
        held = False

        def checked(result: int, operation: str) -> None:
            """Keep native-library errors actionable without weakening the real production validator."""
            self.assertGreaterEqual(result, 0, operation + ": " + (os.strerror(-result) if result < 0 else "ok"))

        def call(method: str) -> None:
            """Each synchronous metadata call has the unchanged five-second test setup deadline."""
            reply = pointer()
            try:
                result = library.sd_bus_call_method(bus, b"org.freedesktop.systemd1", b"/org/freedesktop/systemd1",
                    b"org.freedesktop.systemd1.Manager", method.encode(), None, ctypes.byref(reply), b"s",
                    ctypes.c_char_p(name.encode()))
                checked(result, method)
            finally:
                if reply.value:
                    library.sd_bus_message_unref(reply)

        try:
            checked(library.sd_bus_new(ctypes.byref(bus)), "sd_bus_new")
            # RefUnit needs the unique sender/lifetime tracking supplied by an actual system bus.
            checked(library.sd_bus_set_address(bus, b"unix:path=/run/dbus/system_bus_socket"), "sd_bus_set_address")
            checked(library.sd_bus_set_bus_client(bus, 1), "sd_bus_set_bus_client")
            checked(library.sd_bus_set_method_call_timeout(bus, 5_000_000), "sd_bus_set_method_call_timeout")
            checked(library.sd_bus_start(bus), "sd_bus_start")
            call("LoadUnit")
            call("RefUnit")
            held = True
            self.assertIn(name, self.manager_instance_names())
            yield
        finally:
            try:
                if held:
                    call("UnrefUnit")
            finally:
                if bus.value:
                    library.sd_bus_flush_close_unref(bus)
        for _ in range(40):
            if name not in self.manager_instance_names():
                return
            time.sleep(0.05)
        self.fail("Inactive metadata-only unit reference did not leave the manager inventory")

    def test_capsule_exact_prefixed_generic_and_loaded_metadata_preserved_reset(self) -> None:
        """The exact relevant capsule text and real User=c-demo metadata survive reset without starting a user manager."""
        self.real_build_identity_993_979()
        parsed = ast.parse((SOURCE / "test_setup_restart_helper.py").read_text())
        fixture = next(node for node in ast.walk(parsed) if isinstance(node, ast.FunctionDef)
                       and node.name == "test_capsule_prefixed_instance_identity_is_read_only_and_preserved")
        assignment = next(node for node in fixture.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == "content" for target in node.targets))
        content = ast.literal_eval(assignment.value)
        self.assertIsInstance(content, bytes)
        self.assertIn(b"User=c-%i\nDynamicUser=yes\n", content)
        path = Path("/usr/lib/systemd/system/capsule@.service")
        self.assertFalse(path.exists())
        write(path, content)
        before = self.declaration_snapshot([path])
        self.allowed()
        name = "capsule@demo.service"
        state_paths = [Path("/var/lib/capsules/demo"), Path("/run/capsules/demo")]
        state_before = [item.exists() for item in state_paths]
        with self.pinned_unit_metadata(name):
            properties = self.observed_instance_properties(name)
            self.assertEqual(properties["User"], "c-demo")
            self.assertEqual(property_value(name, "DynamicUser"), "yes")
            self.assertEqual(property_value(name, "ActiveState"), "inactive")
            self.assertEqual(property_value(name, "ExecMainStartTimestampMonotonic"), "0")
            users, groups, _ = self.agent.account_inventory()
            configuration = self.agent.other_account_use(users, groups, self.original)
            self.assertEqual(configuration["loadedInstances"][name], properties)
            audit = self.assert_complete(self.apply(self.allowed()))
            self.assertEqual(before, self.declaration_snapshot([path]))
            self.assertEqual(properties, self.agent.instance_properties(name))
            self.assertEqual(property_value(name, "ExecMainStartTimestampMonotonic"), "0")
            self.assertEqual(state_before, [item.exists() for item in state_paths])
            self.assertTrue(all("capsule" not in step["step"] for step in audit["steps"]))
            print("CAPSULE_IDENTITY_QUALIFICATION " + json.dumps({"case": "exact-generic-and-loaded-reset",
                  "unitSha256": hashlib.sha256(content).hexdigest(), "exactRelevantUnitText": content.decode(),
                  "instance": name, "observedProperties": properties, "dynamicUser": True,
                  "metadataPin": "container-local system bus LoadUnit/RefUnit/UnrefUnit; no capsule StartUnit",
                  "startTimestampMonotonic": "0", "unitPreserved": True,
                  "runtimeStatePathsUnchanged": True, "userManagerStarted": False}), flush=True)

    def test_prefixed_identity_concrete_native_names_and_ids_refused(self) -> None:
        """Reparse complete substituted identities: outpost-build, 979 and 993 remain protected."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("qualification-prefix", start_hook=True)
        reference = Path(helper.UNIT_DIR) / "qualification-prefix.target"
        cases = (("User", "outpost-%i", "build", "outpost-build"), ("Group", "9%i", "79", "979"),
                 ("User", "99%i", "3", "993"), ("Group", "%i9", "97", "979"),
                 ("User", "9%i3", "9", "993"))
        for field, expression, instance, expanded in cases:
            with self.subTest(field=field, expression=expression, instance=instance):
                write(template, ("[Unit]\nDefaultDependencies=no\n[Service]\nType=oneshot\n" + field + "=" + expression +
                                 "\nExecStart=/usr/bin/touch " + str(marker) + "\nExecStop=/usr/bin/touch " + str(marker) + "\n").encode())
                name = "qualification-prefix@" + instance + ".service"
                write(reference, ("[Unit]\nWants=" + name + "\n").encode())
                before = self.declaration_snapshot([template, reference])
                self.refusal_without_effects("identity")
                run(["/usr/bin/systemctl", "daemon-reload"])
                with self.pinned_unit_metadata(name):
                    properties = self.observed_instance_properties(name)
                    self.assertEqual(properties[field], expanded)
                    self.refusal_without_effects("identity")
                    self.assertEqual(property_value(name, "ExecMainStartTimestampMonotonic"), "0")
                    self.assertFalse(marker.exists())
                self.assertEqual(before, self.declaration_snapshot([template, reference]))
                print("CAPSULE_IDENTITY_QUALIFICATION " + json.dumps({"case": "native-expanded-identity-refused",
                      "field": field, "expression": expression, "instance": instance,
                      "managerExpandedIdentity": expanded, "configuredAndLoadedAuditsRefused": True,
                      "hooksExecuted": False}), flush=True)

    def test_prefixed_identity_unknown_syntax_and_expansion_bound_refused(self) -> None:
        """Bounded prefix syntax does not authorize other specifiers, escapes, absent context or overlong identities."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("qualification-prefix", start_hook=True)
        reference = write(Path(helper.UNIT_DIR) / "qualification-prefix.target",
                          b"[Unit]\nWants=qualification-prefix@demo.service\n")
        for value in ("c-%I", "c-%U", "c-%%i", r"c-\x25i", '"c-%i other"'):
            with self.subTest(value=value):
                write(template, ("[Service]\nUser=" + value + "\nExecStart=/usr/bin/true\n").encode())
                self.refusal_without_effects("identity syntax")
        write(template, ("[Service]\nUser=c-" + "%i" * 100 + "\nExecStart=/usr/bin/true\n").encode())
        self.refusal_without_effects("identity syntax")
        write(template, b"[Service]\nUser=c-%i\nExecStart=/usr/bin/true\n")
        write(Path(helper.UNIT_DIR) / "qualification-plain-prefix.service", b"[Service]\nUser=c-%i\nExecStart=/usr/bin/true\n")
        self.refusal_without_effects("identity syntax")
        self.assertTrue(reference.exists())
        self.assertFalse(marker.exists())

    def test_prefixed_identity_changed_scope_rejects_cached_review(self) -> None:
        """A reviewed c-build identity cannot authorize a later outpost-build identity or a different source instance."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("qualification-prefix", user="c-%i", group="root", start_hook=True)
        reference = write(Path(helper.UNIT_DIR) / "qualification-prefix.target",
                          b"[Unit]\nWants=qualification-prefix@build.service\n")
        review = self.allowed()
        write(template, template.read_bytes().replace(b"User=c-%i", b"User=outpost-%i"))
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("identity", result["message"])
        self.assertFalse(Path(helper.RESETS).exists())
        self.refusal_without_effects("identity")
        write(template, b"[Service]\nUser=root\nGroup=9%i\nExecStart=/usr/bin/true\n")
        write(reference, b"[Unit]\nWants=qualification-prefix@8.service\n")
        review = self.allowed()
        write(reference, b"[Unit]\nWants=qualification-prefix@79.service\n")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("identity", result["message"])
        self.assertFalse(Path(helper.RESETS).exists())
        self.assertFalse(marker.exists())

    def test_escaped_instance_and_benign_alias_metadata_preserved_reset(self) -> None:
        """Real Id/list JSON and quoted Names differ by exactly one vector layer, not unit-name unescaping."""
        template, marker = self.instance_template("qualification-filesystem", user="root", group="root", start_hook=True)
        alias_template = Path(helper.UNIT_DIR) / "qualification-filesystem-alias@.service"
        alias_template.symlink_to(template)
        instance = r"dev-disk-by\x2duuid-fixture"
        name = "qualification-filesystem@" + instance + ".service"
        alias = "qualification-filesystem-alias@" + instance + ".service"
        before = self.declaration_snapshot([template, alias_template])
        with self.pinned_unit_metadata(name):
            self.assertEqual(property_value(alias, "Id"), name)
            properties = self.observed_instance_properties(name)
            raw_inventory = run(list(helper.INSTANCE_LIST_COMMAND)).stdout.decode()
            rows = json.loads(raw_inventory)
            self.assertIn(name, [row["unit"] for row in rows])
            self.assertEqual(properties["Id"], name)
            self.assertEqual(properties["Id"].count(chr(92)), 1)
            raw_names = properties["Names"]
            self.assertIn(json.dumps(name), raw_names)
            self.assertIn(json.dumps(alias), raw_names)
            decoded = helper.systemctl_unit_names(raw_names)
            self.assertEqual(set(decoded), {name, alias})
            self.assertEqual(len(decoded), 2)
            self.assertNotIn(name.replace(r"\x2d", "-"), decoded)
            self.assertEqual(property_value(name, "ExecMainStartTimestampMonotonic"), "0")
            users, groups, _ = self.agent.account_inventory()
            configuration = self.agent.other_account_use(users, groups, self.original)
            self.assertEqual(configuration["loadedInstances"][name]["Names"], raw_names)
            self.assertTrue({name, alias} <= set(configuration["unitContexts"]))
            self.assert_complete(self.apply(self.allowed()))
            self.assertEqual(before, self.declaration_snapshot([template, alias_template]))
            self.assertEqual(properties, self.agent.instance_properties(name))
            self.assertEqual(property_value(name, "ExecMainStartTimestampMonotonic"), "0")
            self.assertFalse(marker.exists())
            print("ESCAPED_NAMES_QUALIFICATION " + json.dumps({"case": "metadata-only-escaped-instance-and-benign-alias",
                  "id": properties["Id"], "alias": alias, "rawNames": raw_names,
                  "rawNamesSha256": hashlib.sha256(raw_names.encode()).hexdigest(),
                  "decodedByProduction": decoded, "rawManagerInventoryJson": raw_inventory,
                  "propertiesBeforeAndAfter": properties, "filesPreserved": True, "hooksExecuted": False,
                  "startTimestampMonotonic": "0", "jsonLayerDecodedExactlyOnce": True,
                  "unitNameEscapesPreserved": True}), flush=True)

    def test_configured_escaped_native_instances_still_refused(self) -> None:
        """Configured unit-name escapes cannot conceal dedicated UIDs, GIDs or names after the Names decoder change."""
        self.real_build_identity_993_979()
        template, marker = self.instance_template("qualification-escaped", user="root", group="root", start_hook=True)
        self.allowed()
        inventory = self.manager_instance_names()
        for instance in (r"\x39\x39\x33", r"\x39\x37\x39", r"outpost\x2dbuild", r"outpost\x2dworkspaces"):
            with self.subTest(instance=instance):
                name = "qualification-escaped@" + instance + ".service"
                configured = Path(helper.UNIT_DIR) / name
                configured.symlink_to(template)
                before = self.declaration_snapshot([template, configured])
                self.refusal_without_effects("native identity")
                self.assertEqual(before, self.declaration_snapshot([template, configured]))
                self.assertEqual(inventory, self.manager_instance_names())
                self.assertFalse(marker.exists())
                configured.unlink()
        print("ESCAPED_NAMES_QUALIFICATION " + json.dumps({"case": "configured-native-escapes-refused",
              "nativeUid": 993, "nativeGid": 979,
              "instances": [r"\x39\x39\x33", r"\x39\x37\x39", r"outpost\x2dbuild", r"outpost\x2dworkspaces"],
              "refusedBeforeIntent": True, "managerInventoryUnchanged": True, "hooksExecuted": False}), flush=True)

    def bind_own_network_namespace(self, target: Path) -> tuple[int, dict]:
        """Bind only this container's net namespace; never enter a namespace or access a host namespace/device."""
        require_container()
        own = os.stat("/proc/self/ns/net")
        init = os.stat("/proc/1/ns/net")
        self.assertEqual((own.st_dev, own.st_ino), (init.st_dev, init.st_ino))
        write(target, b"", 0o600)
        self.mount("/proc/self/ns/net", target, bind=True)
        descriptor = os.open(target, os.O_PATH | os.O_NOFOLLOW)
        self.addCleanup(os.close, descriptor)
        info = os.fstat(descriptor)
        self.assertEqual((info.st_dev, info.st_ino), (own.st_dev, own.st_ino))
        self.assertEqual((info.st_uid, info.st_gid), (0, 0))
        fdinfo = Path("/proc/self/fdinfo") / str(descriptor)
        mount_id = next(line.partition(":")[2].strip() for line in fdinfo.read_text().splitlines() if line.startswith("mnt_id:"))
        rows = [line for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[0] == mount_id]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].split()[4], str(target))
        self.assertIn(" - nsfs ", rows[0])
        self.assertEqual(helper.linux_descriptor_filesystem(descriptor), "nsfs")
        errors = {}
        for attribute in ("system.posix_acl_access", "system.posix_acl_default"):
            with self.assertRaises(OSError) as caught:
                os.getxattr("/proc/self/fd/" + str(descriptor), attribute)
            self.assertIn(caught.exception.errno, (errno.EOPNOTSUPP, errno.ENODATA))
            errors[attribute] = caught.exception.errno
        self.assertIn(errno.EOPNOTSUPP, errors.values(), "This fixture must exercise real kernel ACL non-support")
        self.assertEqual(helper.linux_acls(descriptor), (None, None))
        observation = {"source": "/proc/self/ns/net", "namespace": os.readlink("/proc/self/ns/net"),
                       "containerInitNamespace": os.readlink("/proc/1/ns/net"), "target": str(target),
                       "filesystemVerifiedByProduction": "nsfs", "mountId": mount_id, "mountInfo": rows[0],
                       "inodeStamp": helper.stamp(info), "aclErrnos": errors, "aclResult": [None, None],
                       "hostNamespaceUsed": False, "namespaceEntered": False}
        return descriptor, observation

    def test_nsfs_own_namespace_mount_preserved_through_reset(self) -> None:
        """A real outside-scope nsfs bind and adjacent sentinel survive full reset and both ownership/ACL scans."""
        target = Path("/srv/qualification/own-network-namespace")
        descriptor, observed = self.bind_own_network_namespace(target)
        sentinel = write("/srv/qualification/nsfs-outside-sentinel", b"preserve outside nsfs sentinel\n", 0o600)
        sentinel_before = snapshot([sentinel])
        self.assert_complete(self.apply(self.allowed()))
        self.assertEqual(sentinel_before, snapshot([sentinel]))
        self.assertIn(str(target), helper.linux_mounts())
        self.assertEqual(helper.stamp(os.stat(target, follow_symlinks=False)), observed["inodeStamp"])
        self.assertEqual(helper.stamp(os.fstat(descriptor)), observed["inodeStamp"])
        self.assertEqual(helper.linux_descriptor_filesystem(descriptor), "nsfs")
        self.assertEqual(helper.linux_acls(descriptor), (None, None))
        current_rows = [line for line in Path("/proc/self/mountinfo").read_text().splitlines()
                        if line.split()[0] == observed["mountId"]]
        self.assertEqual(current_rows, [observed["mountInfo"]])
        self.assertEqual(os.readlink("/proc/self/ns/net"), observed["namespace"])
        print("NSFS_QUALIFICATION " + json.dumps({**observed, "case": "outside-scope-completed-reset",
              "sentinelPreserved": True, "namespaceMountPreserved": True, "rawAclAbsenceRecheckedAfterReset": True}), flush=True)
        filesystems = {line.split()[-1] for line in Path("/proc/filesystems").read_text().splitlines() if line.split()}
        devices = sorted(str(path) for path in Path("/dev").iterdir() if stat.S_ISBLK(path.lstat().st_mode))
        loop_nodes = sorted(str(path) for path in Path("/dev").glob("loop*"))
        print("FILESYSTEM_QUALIFICATION_GAPS " + json.dumps({"kernelAdvertises": {name: name in filesystems for name in ("nsfs", "squashfs", "vfat")},
              "visibleBlockDeviceNodes": devices, "visibleLoopDeviceNodes": loop_nodes,
              "loopControlPresent": Path("/dev/loop-control").exists(), "deviceNodesOpenedOrCreated": False,
              "sharedLoopDevicesUsed": False, "fuseSubstitutionUsed": False,
              "realFilesystemQualified": ["nsfs"], "realFilesystemNotQualified": ["squashfs", "vfat"],
              "reason": "Kernel SquashFS/VFAT image mounts need block devices. Loop devices are kernel-global, not isolated by the container mount namespace; no host/shared loop or other host block device is permitted. No automatic-loop mount attempts or FUSE stand-ins were used. Policy branches and bad/unknown ACL cases are covered by the helper unit suite, not real SquashFS/VFAT mounts here."}), flush=True)

    def test_nsfs_inside_native_scope_still_refused(self) -> None:
        """The verified no-ACL filesystem exception never permits a mounted native cleanup subtree."""
        target = write(Path(helper.ROOTS[2]) / "worker/namespace", b"", 0o600)
        review = self.allowed()
        descriptor, observed = self.bind_own_network_namespace(target)
        self.blocked("Mounted")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("Mounted", result["message"])
        self.assertFalse(Path(helper.RESETS).exists())
        self.assertEqual(helper.stamp(os.fstat(descriptor)), observed["inodeStamp"])
        self.assertIn(str(target), helper.linux_mounts())
        self.assertEqual(self.preserved, snapshot([*self.sentinels, *self.evidence_paths]))
        print("NSFS_QUALIFICATION " + json.dumps({**observed, "case": "native-scope-mounted-file-refused",
              "refusedBeforeIntent": True, "mountPreserved": True}), flush=True)

    def test_nsfs_nonsupport_does_not_skip_external_identity_audit(self) -> None:
        """Outside namespace handles do not excuse adjacent native-owned data or real named ACL references."""
        target = Path("/srv/qualification/own-network-namespace")
        descriptor, observed = self.bind_own_network_namespace(target)
        self.allowed()
        account = self.identities["outpost-build"]
        outside = write("/srv/qualification/nsfs-adjacent-identity", b"retain external identity data\n", 0o600)
        os.chown(outside, account.pw_uid, account.pw_gid)
        self.refusal_without_effects("owns data outside")
        self.assertEqual((outside.stat().st_uid, outside.stat().st_gid), (account.pw_uid, account.pw_gid))
        os.chown(outside, 0, 0)
        run(["/usr/bin/setfacl", "-m", f"u:{account.pw_uid}:---", str(outside)])
        raw = os.getxattr(outside, "system.posix_acl_access")
        self.refusal_without_effects("external POSIX ACL")
        self.assertEqual(os.getxattr(outside, "system.posix_acl_access"), raw)
        self.assertEqual(outside.read_bytes(), b"retain external identity data\n")
        run(["/usr/bin/setfacl", "-b", str(outside)])
        process = subprocess.Popen(["/usr/bin/sleep", "45"], cwd="/", user=account.pw_uid,
                                   group=account.pw_gid, extra_groups=[], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(process)
        self.refusal_without_effects("processes outside")
        self.assertIsNone(process.poll())
        self.assertEqual(helper.stamp(os.fstat(descriptor)), observed["inodeStamp"])
        self.assertIn(str(target), helper.linux_mounts())
        print("NSFS_QUALIFICATION " + json.dumps({**observed, "case": "external-owner-and-acl-still-audited",
              "nativeUid": account.pw_uid, "nativeGid": account.pw_gid,
              "externalOwnershipRefused": True, "externalNamedAclRefused": True,
              "externalProcessUseRefused": True, "refusedBeforeIntent": True}), flush=True)


def main() -> None:
    """Expose discovery and tightly guarded child processes used by the Docker runner."""
    names = unittest.defaultTestLoader.getTestCaseNames(LinuxResetTests)
    if sys.argv[1:] == ["--list"]:
        print(json.dumps(names))
        return
    require_container()
    signal.alarm(350)
    if len(sys.argv) == 4 and sys.argv[1] == "--session-packet":
        scope, poison = sys.argv[2:]
        if scope not in {f"session-{number}.scope" for number in range(42001, 42400)} or poison not in ("none", "name", "numeric", "dependency"):
            raise RuntimeError("Invalid isolated session fixture")
        if helper.linux_login_scope() != scope:
            raise RuntimeError("Actual kernel cgroup does not prove the requested fixture scope")
        declaration = Path("/run/systemd/transient") / scope
        if not declaration.is_file() or declaration.is_symlink():
            raise RuntimeError("Systemd did not publish the actual transient scope declaration")
        if poison != "none":
            extra = {"name": "[Scope]\nUser=outpost-build\n",
                     "numeric": "[Scope]\nGroup=" + str(grp.getgrnam("outpost-build").gr_gid) + "\n",
                     "dependency": "[Unit]\nRequires=user@" + str(pwd.getpwnam("outpost-build").pw_uid) + ".service\n"}[poison]
            write(declaration, declaration.read_bytes() + extra.encode())
        sys.argv = [str(SOURCE / "setup_restart_helper.py")]
        helper.main()
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--cooperate":
        operation = Path(sys.argv[2])
        if operation.parent != Path(helper.OPERATIONS) or not helper.identifier(operation.name):
            raise RuntimeError("Invalid fixture operation")
        for _ in range(500):
            if (operation / "cancel").read_bytes() == b"1":
                return
            time.sleep(0.1)
        raise RuntimeError("Cooperative fixture exceeded 50 seconds")
    if sys.argv[1:] == ["--crash-after-intent"]:
        descriptor = os.open("/", helper.TRAVERSE_FLAGS)
        agent = helper.Helper(helper.Files(descriptor), helper.SystemRunner(), helper.SystemAccounts(), True)
        packet = helper.read_request(sys.stdin.buffer)
        with agent.fs.lock():
            agent.fs.mkdir(helper.RESETS, 0o711)
            agent.fs.mkdir(helper.RESETS + "/" + packet["resetId"], 0o711)
            agent.publish(packet, "unknown")
            os.kill(os.getpid(), signal.SIGKILL)
        raise AssertionError("SIGKILL did not terminate fixture child")
    if sys.argv[1:] == ["--crash-before-complete"]:
        class CrashBeforeComplete(helper.Helper):
            """Inject genuine process death only at the final publication boundary."""

            def publish(self, request: dict, state: str) -> None:
                """Never let the helper catch the simulated process loss or publish failure."""
                if state == "complete":
                    os.kill(os.getpid(), signal.SIGKILL)
                super().publish(request, state)

        descriptor = os.open("/", helper.TRAVERSE_FLAGS)
        try:
            agent = CrashBeforeComplete(helper.Files(descriptor), helper.SystemRunner(), helper.SystemAccounts(), True)
            print(json.dumps(agent.handle(helper.read_request(sys.stdin.buffer))), flush=True)
        finally:
            os.close(descriptor)
        raise AssertionError("Crash boundary was not reached")
    if len(sys.argv) != 2 or sys.argv[1] not in names:
        raise SystemExit("Select exactly one test; the harness provides a fresh container per case")
    suite = unittest.TestSuite([LinuxResetTests(sys.argv[1])])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())


if __name__ == "__main__":
    main()
