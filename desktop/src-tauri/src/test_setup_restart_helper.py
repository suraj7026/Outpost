"""Local-only restart fixtures. No sudo, real account changes, SSH or host systemctl.

Run: PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_setup_restart_helper
from this directory. A passing suite is NOT destructive Linux qualification.
"""
from __future__ import annotations

import ast
import base64
import copy
import errno
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import signal
import stat
import struct
import sys
import tarfile
import tempfile
import unittest
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import setup_restart_helper as helper


class FakeAccounts:
    """An isolated account database; no pwd/grp/process reads reach the host."""

    def __init__(self) -> None:
        self.users = [{"name": name, "uid": 901 + index, "gid": 901 + index,
                       "home": "/nonexistent", "shell": "/usr/sbin/nologin"} for index, name in enumerate(helper.USERS)]
        self.groups = [{"name": name, "gid": 901 + index, "members": []} for index, name in enumerate(helper.USERS)]
        self.groups.append({"name": "outpost-workspaces", "gid": 904, "members": ["outpost-coord", "outpost-pi"]})
        self.foreign_process = False
        self.calls = []

    def snapshot(self) -> tuple[list[dict], list[dict]]:
        """Return copies so orchestration cannot accidentally mutate its own evidence."""
        return copy.deepcopy((self.users, self.groups))

    def processes(self, uids: set[int], gids: set[int], allowed_units: set[str]) -> None:
        """Record scope and simulate an unrelated process without using procfs."""
        self.calls.append((uids, gids, allowed_units))
        helper.require(not self.foreign_process, "Dedicated account has processes outside the verified native services.")


class FakeRunner:
    """Fixed-command simulation; effects are confined to FakeAccounts and unit states."""

    def __init__(self, accounts: FakeAccounts) -> None:
        self.accounts = accounts
        self.calls = []
        self.states = {}
        self.instances = {}
        self.instance_inventory: bytes | None = None
        self.fail: Callable[[list[str]], bool] | None = None
        self.before_effect: Callable[[list[str]], None] | None = None

    def state(self, unit: str, present: bool = False, active: bool = False) -> dict:
        """Use the complete production property schema even for missing services."""
        return {key: {"Id": unit, "Names": unit, "LoadState": "loaded" if present else "not-found", "ActiveState": "active" if active else "inactive",
                      "SubState": "running" if active else "dead", "FragmentPath": helper.UNIT_DIR + "/" + unit if present else "",
                      "NeedDaemonReload": "no", "ControlPID": "0"}.get(key, "") for key in helper.PROPERTIES}

    def run(self, argv: list[str], seconds: int = 10) -> bytes:
        """Fail if orchestration ever attempts an unreviewed command."""
        self.calls.append(argv)
        if argv[:2] == ["/usr/bin/systemctl", "list-units"]:
            if argv != list(helper.INSTANCE_LIST_COMMAND):
                raise AssertionError("Unexpected instance inventory command")
            return self.instance_inventory if self.instance_inventory is not None else json.dumps([
                {"unit": name, "load": value["LoadState"], "active": "inactive", "sub": "dead", "description": "fixture"}
                for name, value in self.instances.items()]).encode()
        if argv[:2] == ["/usr/bin/systemctl", "show"]:
            unit = argv[-1]
            if "--property=" + ",".join(helper.INSTANCE_PROPERTIES) in argv:
                return "\n".join(key + "=" + value for key, value in self.instances[unit].items()).encode()
            return "\n".join(key + "=" + value for key, value in self.states.get(unit, self.state(unit)).items()).encode()
        if self.before_effect:
            self.before_effect(argv)
        if self.fail and self.fail(argv):
            raise OSError("private-command-secret-canary")
        if argv[:2] == ["/usr/bin/systemctl", "stop"]:
            unit = argv[-1]
            self.states[unit]["ActiveState"] = "inactive"
            self.states[unit]["SubState"] = "dead"
        elif argv == ["/usr/bin/systemctl", "daemon-reload"]:
            for unit in helper.UNITS:
                self.states[unit] = self.state(unit)
        elif argv[:2] == ["/usr/sbin/userdel", "--"]:
            name = argv[-1]
            self.accounts.users = [row for row in self.accounts.users if row["name"] != name]
            for group in self.accounts.groups:
                group["members"] = [member for member in group["members"] if member != name]
        elif argv[:2] == ["/usr/sbin/groupdel", "--"]:
            self.accounts.groups = [row for row in self.accounts.groups if row["name"] != argv[-1]]
        else:
            raise AssertionError("Unexpected host command: " + repr(argv))
        return b""

    def effects(self) -> list[list[str]]:
        """Distinguish read-only show calls from actual requested mutations."""
        return [call for call in self.calls if call[1] not in ("show", "list-units")]


def acl_bytes(*named: tuple[int, int, int], mode: int = 0o750) -> bytes:
    """Encode Linux v2 ACLs with matching base/mask mode; named tuples are (tag, permissions, identity)."""
    entries = [(1, (mode >> 6) & 7, 0xffffffff), *[row for row in named if row[0] == 2],
               (4, (mode >> 3) & 7, 0xffffffff), *[row for row in named if row[0] == 8]]
    if named:
        entries.append((16, (mode >> 3) & 7, 0xffffffff))
    entries.append((32, mode & 7, 0xffffffff))
    return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)


class RestartTests(unittest.TestCase):
    """Real temporary descriptor traversal, fake service/account state, no host effects."""

    def setUp(self) -> None:
        """Construct the actual failed4/12 layout and a separately pinned archive."""
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.owner = os.getuid()
        self.accounts = FakeAccounts()
        self.runner = FakeRunner(self.accounts)
        self.mounts = set()
        self.expected = {"operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4()), "releaseId": "host-" + "a" * 20,
                         "deviceId": str(uuid.uuid4()), "publicKey": base64.b64encode(b"x" * 32).decode(), "size": 1, "sha256": "a" * 64}
        self.request = {"mode": "review", "resetId": str(uuid.uuid4()), "expected": self.expected}
        self.operation = helper.OPERATIONS + "/" + self.expected["operationId"]
        self.release = helper.ROOTS[0] + "/releases/" + self.expected["releaseId"]
        self.source = {"host-manifest.json": helper.encoded({"id": self.expected["releaseId"], "layoutVersion": 1, "protocolVersion": 2, "schema": 1}),
                       "package.json": b'{"name":"fixture"}', "package-lock.json": b'{"lockfileVersion":3}',
                       "deploy/environment/host_install.py": b'raise RuntimeError("MUST NEVER EXECUTE")\n',
                       "server/main.ts": b"throw Error('MUST NEVER EXECUTE');\n"}
        self.install_request = {**self.expected, "label": "fixture-secret-label", "browser": True, "coexistence": True, "fullControl": False}
        self.progress = {**{key: self.expected[key] for key in helper.IDENTITIES}, "state": "failed", "completedSteps": 4,
                         "totalSteps": 12, "stage": "Browser runtime", "updatedAt": 100, "startedAt": 1, "log": ["private-log-canary"], "error": "private-error-canary"}
        for path in ("/opt", "/etc", "/var/lib", helper.UNIT_DIR, self.operation, self.operation + "/source", self.operation + "/build-home",
                     self.release, helper.ROOTS[1], helper.ROOTS[2] + "/coordinator", helper.ROOTS[2] + "/worker", helper.ROOTS[2] + "/workspaces"):
            self.directory(path)
        self.archive(self.source)
        self.write(self.operation + "/status.json", helper.encoded(self.progress), 0o644)
        self.write(self.operation + "/launch.json", b'{"returnCode":0}', 0o644)
        self.write(self.operation + "/cancel", b"", 0o600)
        self.write(self.operation + "/command.log", b"private-command-canary", 0o600)
        self.write(self.operation + "/build-home/cache", b"preserved cache", 0o600)
        self.write(helper.BASE + "/install.lock", b"", 0o600)
        self.local_accounts()
        for name, value in self.source.items():
            self.write(self.release + "/" + name, value)
            self.write(self.operation + "/source/" + name, value)
        self.write(self.release + "/node_modules/example/index.js", b"never run")
        self.write(helper.ROOTS[2] + "/worker/task", b"disposable task", 0o600)
        self.write(helper.ROOTS[1] + "/coordinator.env", b"TOKEN=private-token-canary", 0o600)
        for path in ("/etc/kubernetes/config", "/var/lib/docker/keep", "/opt/outpost/keep", "/var/lib/outpost/keep", "/etc/tailscale/keep",
                     "/home/ssh/.ssh/id_ed25519", "/opt/outpost-native-peer/keep"):
            self.write(path, b"unrelated-data", 0o600)
        self.root_fd = os.open(self.root, helper.DIR_FLAGS)
        self.fs = helper.Files(self.root_fd, self.owner, lambda: self.mounts, mount_ids=False, acl_reader=lambda _fd: (None, None))
        self.agent = helper.Helper(self.fs, self.runner, self.accounts, privileged=True)
        # Any accidental production runner/database use is a test failure, not a host action.
        self.guards = [patch.object(helper, "linux_login_scope", return_value=None),
                       patch.object(helper.subprocess, "Popen", side_effect=AssertionError("real process forbidden")),
                       patch.object(helper.pwd, "getpwall", side_effect=AssertionError("host users forbidden")),
                       patch.object(helper.grp, "getgrall", side_effect=AssertionError("host groups forbidden"))]
        for guard in self.guards:
            guard.start()

    def tearDown(self) -> None:
        """Release only the temporary local fixture."""
        for guard in reversed(self.guards):
            guard.stop()
        os.close(self.root_fd)
        self.temporary.cleanup()

    def path(self, path: str) -> Path:
        """Map fixed host paths into the private fixture."""
        return self.root / path.lstrip("/")

    def directory(self, path: str) -> None:
        """Use protected owned ancestors, never chown the local host."""
        self.path(path).mkdir(parents=True, exist_ok=True, mode=0o755)

    def write(self, path: str, value: bytes, mode: int = 0o644) -> None:
        """Publish test files with explicit modes."""
        self.directory(path.rpartition("/")[0])
        self.path(path).write_bytes(value)
        self.path(path).chmod(mode)

    def local_accounts(self) -> None:
        """Mirror the fake NSS backend in fixed, disposable local database files."""
        users = "".join(f'{row["name"]}:x:{row["uid"]}:{row["gid"]}::{row["home"]}:{row["shell"]}\n' for row in self.accounts.users)
        groups = "".join(f'{row["name"]}:x:{row["gid"]}:{",".join(row["members"])}\n' for row in self.accounts.groups)
        self.write("/etc/passwd", users.encode())
        self.write("/etc/group", groups.encode())

    def archive(self, members: dict[str, bytes]) -> None:
        """Build and pin harmless tar bytes rather than importing an installer."""
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, value in members.items():
                item = tarfile.TarInfo("./" + name)
                item.size = len(value)
                archive.addfile(item, io.BytesIO(value))
        raw = output.getvalue()
        self.expected.update(sha256=hashlib.sha256(raw).hexdigest(), size=len(raw))
        self.install_request.update(self.expected)
        self.write(self.operation + "/request.json", helper.encoded(self.install_request), 0o600)
        self.write(self.operation + "/release.tar.gz", raw, 0o600)

    def response(self, packet: dict) -> dict:
        """Require the JSON response expected for every mode except stop."""
        response = self.agent.handle(packet)
        if response is None:
            self.fail("Expected a JSON helper response")
        return response

    def review(self) -> dict:
        """Review through the same validated boundary used by stdin."""
        return self.response(self.request)

    def external_inventory_nodes(self) -> int:
        """Measure actual fixture traversal entries without any future-receipt charge."""
        uids = {row["uid"] for row in self.accounts.users}
        gids = {row["gid"] for row in self.accounts.groups}
        with self.fs.phase("external-identity-post"):
            self.fs._outside_ownership(uids, gids, [*helper.ROOTS, self.operation + "/build-home"])
            return self.fs.nodes

    def apply(self, review: dict | None = None) -> dict:
        """Apply the exact prior snapshot, not a caller-provided target list."""
        review = review or self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        return self.response({**self.request, "mode": "apply", "snapshotDigest": review["snapshotDigest"]})

    def blocked(self, fragment: str = "") -> dict:
        """Safety blockers must cause no mutation or private-text disclosure."""
        review = self.review()
        self.assertFalse(review["canReset"], review)
        self.assertTrue(review["blockers"])
        self.assertIn(fragment, " ".join(review["blockers"]))
        self.assertEqual(self.runner.effects(), [])
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertNotIn("canary", json.dumps(review))
        return review

    def assert_path_refusal(self, message: str, reason: str, path: str, info: os.stat_result,
                            truncated: bool = False) -> None:
        """Check native's byte/control limits and lossless quoting of displayed path parts."""
        self.assertTrue(message.startswith(reason + " path="), message)
        self.assertLessEqual(len(message.encode("utf-8")), 1000)
        self.assertTrue(all(32 <= ord(char) < 127 for char in message), message)
        self.assertIn(f"; mode=0o{info.st_mode:o} uid={info.st_uid} gid={info.st_gid}", message)
        rendered = message[len(reason + " path="):]
        first, end = json.JSONDecoder().raw_decode(rendered)
        if truncated:
            marker = "...[truncated]..."
            self.assertTrue(rendered[end:].startswith(marker), message)
            last, _ = json.JSONDecoder().raw_decode(rendered[end + len(marker):])
            self.assertTrue(first and last)
            self.assertTrue(path.startswith(first) and path.endswith(last))
            self.assertLess(len(first) + len(last), len(path))
        else:
            self.assertEqual(first, path)
            self.assertTrue(rendered[end:].startswith("; mode="), message)

    def services(self, full_control: bool = False, active: bool = False) -> None:
        """Install literal fixture unit files and the installer-created wants links."""
        self.install_request["fullControl"] = full_control
        self.write(self.operation + "/request.json", helper.encoded(self.install_request), 0o600)
        for name, content in helper.unit_texts(self.expected["releaseId"], full_control).items():
            self.write(helper.UNIT_DIR + "/" + name, content)
            self.directory(helper.UNIT_DIR + "/multi-user.target.wants")
            self.path(helper.UNIT_DIR + "/multi-user.target.wants/" + name).symlink_to(helper.UNIT_DIR + "/" + name)
            self.runner.states[name] = self.runner.state(name, True, active)

    @contextmanager
    def virtual_owners(self, paths: dict[str, tuple[int, int]]):
        """Inject only inode ownership; all traversal, modes and file bytes remain real/local."""
        real_stat, real_fstat = os.stat, os.fstat
        owners = {(info.st_dev, info.st_ino): owner for path, owner in paths.items()
                  for info in [real_stat(self.path(path), follow_symlinks=False)]}
        def changed(info):
            if (info.st_dev, info.st_ino) not in owners:
                return info
            fields = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
            fields["st_uid"], fields["st_gid"] = owners[info.st_dev, info.st_ino]
            return SimpleNamespace(**fields)
        with (patch.object(helper.os, "stat", side_effect=lambda *args, **kwargs: changed(real_stat(*args, **kwargs))),
              patch.object(helper.os, "fstat", side_effect=lambda fd: changed(real_fstat(fd)))):
            yield

    def generated_locks(self) -> dict[str, tuple[int, int]]:
        """Create the two disposable UV artifacts with virtual build UID/GID ownership."""
        owners = {}
        for name in ("python/.lock", "server/browser-engine/.venv/.lock"):
            path = self.release + "/" + name
            self.write(path, b"", 0o666)
            parent = path.rpartition("/")[0]
            self.path(parent).chmod(0o700)
            owners.update({path: (903, 903), parent: (903, 903)})
        return owners

    def recorded_hotfix(self) -> dict[str, tuple[int, int]]:
        """Use real pinned payload bytes, but a freshly authenticated archive and fake UUIDs."""
        repository = Path(__file__).resolve().parents[3]
        with tarfile.open(repository / "scripts/fixtures/outpost2-original-release.tar.gz") as archive:
            source = archive.extractfile("./server/browser-engine/launch.py")
            if source is None:
                self.fail("Pinned original launcher fixture is unavailable")
            original = source.read()
        replacement = (repository / "server/browser-engine/launch.py").read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), "1b53161569e3d26424f6f6b36e565209cc639dc934056f47cb902ef998f52a00")
        self.assertEqual(hashlib.sha256(replacement).hexdigest(), "467d6f496c9d0ab06ba10799269e13f4cf8738ea6bdb01f4293412ffa50a07b2")
        name = "server/browser-engine/launch.py"
        self.install_request.update(browser=True, coexistence=True, fullControl=True)
        self.source[name] = original
        self.archive(self.source)
        self.path(self.operation + "/release.tar.gz").chmod(0o644)
        self.write(self.operation + "/source/" + name, original)
        self.write(self.release + "/" + name, replacement)
        self.write(self.operation + "/launch.log", b"private-launch-canary", 0o600)
        self.hotfix_audit = self.operation + "/browser-hotfix-" + str(uuid.uuid4())
        self.directory(self.hotfix_audit)
        self.path(self.hotfix_audit).chmod(0o700)
        font = self.release + "/browsers/camoufox/fontconfig"
        self.directory(font)
        # A subsequent probe legitimately creates this file; it is NOT runtime-qualified here.
        self.write(font + "/fonts.conf", b"generated-font-private-canary")
        owners = {self.release + "/" + name: (903, 903), font: (903, 903), font + "/fonts.conf": (903, 903)}
        backups = {}
        for backup in ("launch.py", "status.json", "request.json", "command.log", "launch.log"):
            if backup == "launch.py":
                data, uid, gid, mode = original, 903, 903, 0o644
            else:
                retained = self.path(self.operation + "/" + backup)
                data, info = retained.read_bytes(), retained.stat()
                uid, gid, mode = info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)
            self.write(self.hotfix_audit + "/" + backup, data, 0o600)
            backups[backup] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "uid": uid, "gid": gid, "mode": mode}
        self.hotfix_manifest = {"schema": 1, **{key: self.expected[key] for key in helper.IDENTITIES},
                               "auditId": self.hotfix_audit.rsplit("/", 1)[1],
                               "provenance": "Operator-approved local HOME allowlist launcher hotfix; original bundle plus "
                                             "documented hotfix, not a byte-identical release. No resume or qualification.",
                               "originalSha256": hashlib.sha256(original).hexdigest(), "replacementSha256": hashlib.sha256(replacement).hexdigest(),
                               "archiveSha256": self.expected["sha256"], "archiveSize": self.expected["size"], "backups": backups,
                               "fontconfig": {"relativePath": "browsers/camoufox/fontconfig", "uid": 903, "gid": 903, "mode": 0o755}}
        info = self.path(font).stat()
        self.hotfix_applied = {"schema": 1, "manifestSha256": "", "launcherSha256": hashlib.sha256(replacement).hexdigest(),
                              "fontconfigIdentity": [info.st_dev, info.st_ino, info.st_mode, 903, 903]}
        self.write_hotfix_records()
        return owners

    def write_hotfix_records(self) -> None:
        """Recompute the raw manifest binding for tamper tests, without using repair code."""
        raw = (json.dumps(self.hotfix_manifest, sort_keys=True, indent=2) + "\n").encode()
        self.hotfix_applied["manifestSha256"] = hashlib.sha256(raw).hexdigest()
        self.write(self.hotfix_audit + "/manifest.json", raw, 0o600)
        self.write(self.hotfix_audit + "/applied.json", (json.dumps(self.hotfix_applied, sort_keys=True, indent=2) + "\n").encode(), 0o600)

    def session(self, name: str, content: bytes | None = None) -> str:
        """A protected fixture declaration, never a real login or systemd mutation."""
        path = "/run/systemd/transient/" + name
        self.write(path, content or b"[Unit]\nDescription=Session fixture\nAfter=systemd-logind.service\n[Scope]\nUser=1000\n")
        return path

    def recover_review(self) -> dict:
        """Request preparation through the validated production wire shape."""
        return self.response({**self.request, "mode": "recover_review"})

    def recovery_packet(self, review: dict) -> dict:
        """Keep the token separate from the token-bound digest."""
        return {**self.request, "mode": "recover_apply", "snapshotDigest": review["snapshotDigest"],
                "recoveryToken": review["recoveryToken"]}

    def cpu_weight_dropins(self) -> dict[str, bytes]:
        """Create only the two approved transient property declarations in the private fixture."""
        files = {}
        for name, weight in (("besteffort", 1), ("burstable", 100)):
            path = "/run/systemd/transient/kubepods-" + name + ".slice.d/50-CPUWeight.conf"
            files[path] = b"# Generated property fixture.\n\n[Slice]\nCPUWeight=" + str(weight).encode() + b"\n"
            self.write(path, files[path])
        return files

    @contextmanager
    def cpu_weight_postscan_acl(self, path: str, reader: Callable[[int], tuple[bytes | None, bytes | None]]):
        """Attach mocked ACLs only to a real same-byte replacement after the external scan."""
        outside = self.fs.outside_ownership
        raw = self.path(path).read_bytes()
        replacements = set()
        calls = []
        def after_audit(*args, **kwargs):
            outside(*args, **kwargs)
            if kwargs.get("reserve_nodes"):
                before = helper.stamp(self.fs.info(path))
                self.fs.atomic(path, raw, 0o644)
                current = helper.stamp(self.fs.info(path))
                self.assertNotEqual(current[1], before[1])
                self.assertEqual([current[0], *current[2:7]], [before[0], *before[2:7]])
                replacements.add((current[0], current[1]))
        def acl(descriptor):
            info = os.fstat(descriptor)
            if (info.st_dev, info.st_ino) in replacements:
                if not self.fs.phase_name.startswith("external-identity-"):
                    self.assertEqual(os.lseek(descriptor, 0, os.SEEK_CUR), len(raw))
                    calls.append(descriptor)
                return reader(descriptor)
            return None, None
        with (patch.object(self.fs, "outside_ownership", side_effect=after_audit),
              patch.object(self.fs, "acl_reader", side_effect=acl)):
            yield calls

    def test_cpu_weight_postscan_native_acls_refuse_before_intent_even_with_zero_permissions(self) -> None:
        files = self.cpu_weight_dropins()
        reviewed = self.review()
        self.assertTrue(reviewed["canReset"], reviewed)
        for path in files:
            for position in (0, 1):
                for tag, identity in ((2, 901), (8, 904)):
                    for permissions in (4, 0):
                        raw = acl_bytes((tag, permissions, identity), mode=0o644)
                        attributes = (raw, None) if position == 0 else (None, raw)
                        with self.subTest(path=path, position=position, tag=tag, permissions=permissions):
                            with self.cpu_weight_postscan_acl(path, lambda _fd, values=attributes: values) as calls:
                                result = self.apply(reviewed)
                            self.assertEqual(result["state"], "failed", result)
                            self.assertIn("external POSIX ACL", result["message"])
                            self.assertEqual(len(calls), 1)
                            with self.assertRaises(OSError):
                                os.fstat(calls[0])
                            self.assertFalse(self.path(helper.RESETS).exists())
                            self.assertTrue(all(self.path(root).is_dir() for root in helper.ROOTS))
                            self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_nonnative_acl_changes_are_snapshot_bound(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        reviewed = self.review()
        self.assertTrue(reviewed["canReset"], reviewed)
        for position in (0, 1):
            for tag in (2, 8):
                for permissions in (4, 0):
                    raw = acl_bytes((tag, permissions, 12345), mode=0o644)
                    attributes = (raw, None) if position == 0 else (None, raw)
                    with self.subTest(position=position, tag=tag, permissions=permissions):
                        with self.cpu_weight_postscan_acl(path, lambda _fd, values=attributes: values):
                            changed = self.review()
                            self.assertTrue(changed["canReset"], changed)
                            self.assertNotEqual(changed["snapshotDigest"], reviewed["snapshotDigest"])
                            result = self.apply(reviewed)
                        self.assertEqual(result["state"], "failed", result)
                        self.assertIn("snapshot changed", result["message"])
                        self.assertFalse(self.path(helper.RESETS).exists())
                        self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_postscan_unavailable_or_malformed_acl_refuses(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        reviewed = self.review()
        for reader in (Mock(side_effect=OSError(errno.EACCES, "private-acl-canary")),
                       Mock(side_effect=OSError(errno.EIO, "private-acl-canary")),
                       Mock(return_value=(b"malformed", None)), Mock(return_value=(None,)),
                       Mock(return_value=(None, b""))):
            with self.subTest(reader=reader), self.cpu_weight_postscan_acl(path, reader):
                result = self.apply(reviewed)
            self.assertEqual(result["state"], "failed", result)
            self.assertIn("ACL", result["message"])
            self.assertNotIn("canary", result["message"])
            self.assertFalse(self.path(helper.RESETS).exists())
            self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_descriptor_acl_nonsupport_uses_existing_policy(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        reviewed = self.review()
        for filesystem, number, allowed in (("tmpfs", errno.EOPNOTSUPP, True), ("ext4", errno.EOPNOTSUPP, False),
                                             ("tmpfs", errno.EACCES, False), ("tmpfs", errno.EIO, False)):
            with (self.subTest(filesystem=filesystem, number=number),
                  self.cpu_weight_postscan_acl(path, helper.linux_acls), patch.object(helper.sys, "platform", "linux"),
                  patch.object(helper.os, "getxattr", side_effect=OSError(number, "private-acl-canary"), create=True),
                  patch.object(helper, "linux_descriptor_filesystem", return_value=filesystem)):
                result = self.review()
            self.assertEqual(result["canReset"], allowed, result)
            if allowed:
                self.assertEqual(result["snapshotDigest"], reviewed["snapshotDigest"])
            self.assertNotIn("canary", str(result))
        with (self.cpu_weight_postscan_acl(path, helper.linux_acls), patch.object(helper.sys, "platform", "linux"),
              patch.object(helper.os, "getxattr", side_effect=[acl_bytes((2, 0, 901), mode=0o644),
                                                             OSError(errno.EOPNOTSUPP, "unsupported")], create=True),
              patch.object(helper, "linux_descriptor_filesystem", return_value="tmpfs")):
            self.blocked("external POSIX ACL")
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_pinned_descriptor_refuses_content_and_acl_read_races(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        raw = files[path]
        read = os.read
        outside = self.fs.outside_ownership
        for stage in ("content", "acl", "acl-inplace"):
            active = []
            changed = []
            def after_audit(*args, tracked=active, **kwargs):
                outside(*args, **kwargs)
                info = helper.stamp(self.fs.info(path))
                tracked.append((info[0], info[1]))
            def content(descriptor, count, when=stage, tracked=active, mutations=changed):
                result = read(descriptor, count)
                info = os.fstat(descriptor)
                if when == "content" and result and (info.st_dev, info.st_ino) in tracked and not mutations:
                    self.fs.atomic(path, raw, 0o644)
                    mutations.append(when)
                return result
            def acl(descriptor, when=stage, tracked=active, mutations=changed):
                info = os.fstat(descriptor)
                if when.startswith("acl") and (info.st_dev, info.st_ino) in tracked and not mutations:
                    if when == "acl":
                        self.fs.atomic(path, raw, 0o644)
                    else:
                        os.utime(self.path(path), ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000), follow_symlinks=False)
                    mutations.append(when)
                return None, None
            with (self.subTest(stage=stage), patch.object(self.fs, "outside_ownership", side_effect=after_audit),
                  patch.object(helper.os, "read", side_effect=content), patch.object(self.fs, "acl_reader", side_effect=acl)):
                self.blocked("changed")
            self.assertEqual(changed, [stage])

    def test_cpu_weight_identical_atomic_rewrites_preserve_review_and_recovery_binding(self) -> None:
        files = self.cpu_weight_dropins()
        normal = self.review()
        self.assertTrue(normal["canReset"], normal)
        before = {path: helper.stamp(self.fs.info(path)) for path in files}
        for path, raw in files.items():
            self.fs.atomic(path, raw, 0o644)
            self.assertNotEqual(before[path][1], helper.stamp(self.fs.info(path))[1])
        self.assertEqual(self.review()["snapshotDigest"], normal["snapshotDigest"])
        prepared = self.recover_review()
        self.assertTrue(prepared["canReset"], prepared)
        for path, raw in files.items():
            self.fs.atomic(path, raw, 0o644)
        retained = {path: helper.stamp(self.fs.info(path)) for path in files}
        result = self.response(self.recovery_packet(prepared))
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual({path: helper.stamp(self.fs.info(path)) for path in files}, retained)
        self.assertEqual({path: self.path(path).read_bytes() for path in files}, files)

    def test_cpu_weight_identical_replacement_after_audit_keeps_snapshot_and_applies(self) -> None:
        files = self.cpu_weight_dropins()
        reviewed = self.review()
        self.assertTrue(reviewed["canReset"], reviewed)
        outside = self.fs.outside_ownership
        replacements = []
        def after_audit(*args, **kwargs):
            outside(*args, **kwargs)
            if kwargs.get("reserve_nodes"):
                for path, raw in files.items():
                    before = helper.stamp(self.fs.info(path))
                    self.fs.atomic(path, raw, 0o644)
                    self.assertNotEqual(helper.stamp(self.fs.info(path))[1], before[1])
                    replacements.append(path)
        with patch.object(self.fs, "outside_ownership", side_effect=after_audit):
            repeated = self.review()
            self.assertTrue(repeated["canReset"], repeated)
            self.assertEqual(repeated["snapshotDigest"], reviewed["snapshotDigest"])
            result = self.apply(reviewed)
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual(replacements, [*files, *files])
        self.assertEqual({path: self.path(path).read_bytes() for path in files}, files)

    def test_cpu_weight_post_audit_body_or_metadata_drift_is_refused_not_adopted(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        original = files[path]
        target = self.path(path)
        link = self.path("/fixture-property-hardlink")
        self.write("/fixture-property-target", original)
        outside = self.fs.outside_ownership
        real_stat, real_fstat = os.stat, os.fstat
        device = real_stat(target).st_dev
        overrides = {}
        def changed(info):
            values = overrides.get((info.st_dev, info.st_ino))
            if values is None:
                return info
            return SimpleNamespace(**{**{key: getattr(info, key) for key in dir(info) if key.startswith("st_")}, **values})
        native_user = b"[Slice]\nCPUWeight=1\nUser=outpost-build\n".ljust(len(original), b" ")
        native_dependency = b"[Unit]\nRequires=outpost-native-worker.service\n".ljust(len(original), b" ")
        cases = (
            ("value", original.replace(b"CPUWeight=1", b"CPUWeight=2"), {}, 0o644),
            ("comment", original.replace(b"fixture", b"Fixture"), {}, 0o644),
            ("native-user", native_user, {}, 0o644),
            ("native-dependency", native_dependency, {}, 0o644),
            ("size", original + b"# extra\n", {}, 0o644),
            ("mode", original, {}, 0o600), ("writable", original, {}, 0o666),
            ("uid", original, {"st_uid": 777}, 0o644),
            ("gid", original, {"st_gid": 777}, 0o644),
            ("device", original, {"st_dev": device + 1}, 0o644),
            ("hardlink", original, {}, 0o644), ("symlink", original, {}, 0o644),
            ("directory", original, {}, 0o644), ("mount", original, {}, 0o644),
        )
        for kind, payload, fields, mode in cases:
            with self.subTest(kind=kind):
                overrides.clear()
                self.mounts.clear()
                link.unlink(missing_ok=True)
                if stat.S_ISDIR(target.lstat().st_mode):
                    target.rmdir()
                else:
                    target.unlink()
                self.write(path, original)
                if kind in ("value", "comment", "native-user", "native-dependency"):
                    self.assertEqual(len(payload), len(original))
                mutated = []
                def after_audit(*args, case=kind, body=payload, metadata=fields, file_mode=mode, mutations=mutated, **kwargs):
                    outside(*args, **kwargs)
                    self.fs.atomic(path, body, file_mode)
                    if case == "hardlink":
                        os.link(target, link)
                    elif case == "symlink":
                        target.unlink()
                        target.symlink_to("/fixture-property-target")
                    elif case == "directory":
                        target.unlink()
                        target.mkdir()
                    elif case == "mount":
                        self.mounts.add(path)
                    if metadata:
                        info = real_stat(target)
                        overrides[info.st_dev, info.st_ino] = metadata
                    mutations.append(case)
                with (patch.object(self.fs, "outside_ownership", side_effect=after_audit),
                      patch.object(helper.os, "stat", side_effect=lambda *args, **kwargs: changed(real_stat(*args, **kwargs))),
                      patch.object(helper.os, "fstat", side_effect=lambda fd: changed(real_fstat(fd)))):
                    result = self.review()
                self.assertEqual(mutated, [kind])
                self.assertFalse(result["canReset"], result)
                if kind in ("value", "comment", "native-user", "native-dependency"):
                    self.assertIn("changed during verification", result["blockers"][0])
                self.assertFalse(self.path(helper.RESETS).exists())
                self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_post_audit_replacement_still_requires_strict_grammar(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        outside = self.fs.outside_ownership
        for raw in (b"[Unit]\nCPUWeight=1\n", b"[Slice]\nCPUWeight=0\n", b"[Slice]\nCPUWeight=10001\n",
                    b"[Slice]\nCPUWeight=1\nCPUAccounting=yes\n", b"[Slice]\nCPUWeight=1\nCPUWeight=1\n"):
            with self.subTest(raw=raw):
                self.fs.atomic(path, raw, 0o644)
                self.assertTrue(self.review()["canReset"])
                def after_audit(*args, body=raw, **kwargs):
                    outside(*args, **kwargs)
                    self.fs.atomic(path, body, 0o644)
                with patch.object(self.fs, "outside_ownership", side_effect=after_audit):
                    self.blocked("changed after audit")

    def test_cpu_weight_projection_retains_hash_and_all_stable_metadata(self) -> None:
        files = self.cpu_weight_dropins()
        users, groups, _ = self.agent.account_inventory()
        audited = self.agent.other_account_use(users, groups, self.install_request)
        for path in files:
            self.assertEqual(audited["linkedDeclarations"][path]["inode"], helper.stamp(self.fs.info(path)))
        with self.fs.lock():
            _, details = self.agent.inspect(self.request)
        for path, raw in files.items():
            info = self.fs.info(path)
            if info is None:
                self.fail("Fixture property disappeared")
            self.assertEqual(details["configuration"]["linkedDeclarations"][path], {
                "sha256": hashlib.sha256(raw).hexdigest(),
                "stableMetadata": [info.st_dev, info.st_mode, info.st_uid, info.st_gid, info.st_nlink, info.st_size],
                "aclDigest": helper.digest([None, None]),
            })
            self.assertEqual(details["configuration"][path], hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_integer_boundaries_and_logical_whitespace_qualify(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        for raw in (b"[Slice]\nCPUWeight=1\n", b"[Slice]\nCPUWeight=10000\n",
                    b"# comment\n\n [Slice] \n\tCPUWeight \t=\t100 \n",
                    b"[Slice]\r\nCPUWeight=100\r\n", b"[Slice]\nCPUWeight=\\\n 100\n"):
            with self.subTest(raw=raw):
                self.fs.atomic(path, raw, 0o644)
                review = self.review()
                self.assertTrue(review["canReset"], review)
                self.fs.atomic(path, raw, 0o644)
                self.assertEqual(self.review()["snapshotDigest"], review["snapshotDigest"])
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_content_value_mode_and_ownership_changes_cannot_reuse_review(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        original = files[path]
        review = self.review()
        for raw, mode in ((original.replace(b"CPUWeight=1", b"CPUWeight=2"), 0o644),
                          (original.replace(b"fixture", b"Fixture"), 0o644),
                          (original + b"# extra comment\n", 0o644), (original, 0o600), (original, 0o666)):
            with self.subTest(raw=raw, mode=mode):
                self.fs.atomic(path, raw, mode)
                self.assertEqual(self.apply(review)["state"], "failed")
        self.fs.atomic(path, original, 0o644)
        for owner in ((777, os.getgid()), (self.owner, 777)):
            with self.subTest(owner=owner), self.virtual_owners({path: owner}):
                self.assertEqual(self.apply(review)["state"], "failed")
        os.link(self.path(path), self.path("/outside-property-hardlink"))
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertEqual(self.runner.effects(), [])
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_cpu_weight_device_identity_remains_snapshot_bound(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        review = self.review()
        real_stat, real_fstat = os.stat, os.fstat
        target = real_stat(self.path(path))
        def changed(info):
            if (info.st_dev, info.st_ino) != (target.st_dev, target.st_ino):
                return info
            fields = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
            fields["st_dev"] += 1
            return SimpleNamespace(**fields)
        with (patch.object(helper.os, "stat", side_effect=lambda *args, **kwargs: changed(real_stat(*args, **kwargs))),
              patch.object(helper.os, "fstat", side_effect=lambda fd: changed(real_fstat(fd)))):
            result = self.apply(review)
        self.assertEqual(result["state"], "failed", result)
        self.assertIn("snapshot changed", result["message"])
        self.assertEqual(self.runner.effects(), [])
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_cpu_weight_malformed_or_extra_logical_content_never_gets_semantic_projection(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        invalid = (b"", b"CPUWeight=100\n", b"[Unit]\nCPUWeight=100\n", b"CPUWeight=100\n[Slice]\n",
                   b"[Slice]\n[Slice]\nCPUWeight=100\n", b"[Slice]\nCPUWeight=100\nCPUWeight=100\n",
                   b"[Slice]\nCPUWeight=100\nCPUAccounting=yes\n", b"[slice]\nCPUWeight=100\n",
                   *(b"[Slice]\nCPUWeight=" + value + b"\n" for value in
                     (b"0", b"10001", b"idle", b"infinity", b'"100"', b"+100", b"1 00", b"%i", b"100#comment")))
        for raw in invalid:
            with self.subTest(raw=raw):
                self.fs.atomic(path, raw, 0o644)
                review = self.review()
                self.assertTrue(review["canReset"], review)
                self.fs.atomic(path, raw, 0o644)
                result = self.apply(review)
                self.assertEqual(result["state"], "failed", result)
                self.assertIn("snapshot changed", result["message"])
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertEqual(self.runner.effects(), [])

    def test_cpu_weight_hidden_native_references_still_fail_existing_audits(self) -> None:
        path = next(iter(self.cpu_weight_dropins()))
        for suffix in (b"User=outpost-build\n", b"Group=903\n", b"SupplementaryGroups=outpost-workspaces\n",
                       b"[Unit]\nRequires=user@903.service\n", b"[Unit]\nAfter=outpost-native-worker.service\n",
                       b"[Unit]\nRequires=user@\\\n 903.service\n"):
            with self.subTest(suffix=suffix):
                self.fs.atomic(path, b"[Slice]\nCPUWeight=100\n" + suffix, 0o644)
                self.blocked()
        self.fs.atomic(path, b"[Slice]\nCPUWeight=100\\", 0o644)
        self.blocked("continuation")

    def test_cpu_weight_mounted_files_and_aliased_targets_do_not_qualify(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        for mount in (path, path.rpartition("/")[0]):
            with self.subTest(mount=mount):
                self.mounts.add(mount)
                self.blocked("Mounted")
                self.mounts.remove(mount)
        self.directory(helper.UNIT_DIR + "/foreign.service.d")
        self.path(helper.UNIT_DIR + "/foreign.service.d/50-property.conf").symlink_to(path)
        review = self.review()
        self.assertTrue(review["canReset"], review)
        with self.fs.lock():
            _, details = self.agent.inspect(self.request)
        self.assertIn(path, details["configuration"]["linkedTargets"])
        self.assertIn("inode", details["configuration"]["linkedDeclarations"][path])
        self.fs.atomic(path, files[path], 0o644)
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertEqual(self.runner.effects(), [])
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_cpu_weight_symlinks_and_unrelated_dropins_keep_full_inode_binding(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        raw = files[path]
        external = "/etc/systemd/property-fixture.conf"
        self.write(external, raw)
        self.path(path).unlink()
        self.path(path).symlink_to(external)
        unrelated = (external, "/run/systemd/transient/kubepods-besteffort.slice.d/60-CPUWeight.conf",
                     "/run/systemd/transient/kubepods-guaranteed.slice.d/50-CPUWeight.conf",
                     helper.UNIT_DIR + "/kubepods-besteffort.slice.d/50-CPUWeight.conf")
        for other in unrelated:
            with self.subTest(path=other):
                self.write(other, raw)
                review = self.review()
                self.assertTrue(review["canReset"], review)
                self.fs.atomic(other, raw, 0o644)
                self.assertEqual(self.apply(review)["state"], "failed")
        self.assertEqual(self.runner.effects(), [])
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_cpu_weight_read_races_keep_full_inode_checks_and_projection_waits_for_audits(self) -> None:
        files = self.cpu_weight_dropins()
        path = next(iter(files))
        read = self.fs.read
        def replaced(current, *args, **kwargs):
            raw = read(current, *args, **kwargs)
            if current == path:
                self.fs.atomic(path, raw, 0o644)
            return raw
        with patch.object(self.fs, "read", side_effect=replaced):
            self.blocked("changed")
        with patch.object(self.agent, "normalize_cpu_weights", wraps=self.agent.normalize_cpu_weights) as normalize:
            self.accounts.foreign_process = True
            self.blocked("processes")
            self.accounts.foreign_process = False
            with patch.object(self.fs, "outside_ownership", side_effect=helper.Refused("external audit refused")):
                self.blocked("external audit refused")
            normalize.assert_not_called()

    def test_distinct_current_sessions_and_nss_order_share_snapshot_after_full_audit(self) -> None:
        first = self.session("session-101.scope")
        with patch.object(helper, "linux_login_scope", return_value="session-101.scope"):
            review = self.review()
        self.assertTrue(review["canReset"], review)
        self.path(first).unlink()
        self.session("session-202.scope", b"[Unit]\nDescription=Session 202 of user fixture\nAfter=systemd-logind.service\n[Scope]\nUser=1000\n")
        self.accounts.users.reverse()
        self.accounts.groups.reverse()
        self.accounts.groups[0]["members"].reverse()
        with patch.object(helper, "linux_login_scope", return_value="session-202.scope"):
            second = self.review()
            self.assertEqual(review["snapshotDigest"], second["snapshotDigest"])
            self.assertEqual(self.apply(review)["state"], "complete")
        self.assertTrue(self.path("/run/systemd/transient/session-202.scope").exists())

    def test_current_scope_native_identity_or_dependency_is_never_normalized_before_audit(self) -> None:
        for text in (b"[Scope]\nUser=outpost-build\n", b"[Scope]\nGroup=903\n",
                     b"[Unit]\nRequires=user@903.service\n", b"[Unit]\nAfter=outpost-native-worker.service\n"):
            with self.subTest(text=text):
                self.session("session-101.scope", text)
                with patch.object(helper, "linux_login_scope", return_value="session-101.scope"):
                    self.blocked()

    def test_other_sessions_dropins_and_unsupported_provenance_remain_bound(self) -> None:
        own = self.session("session-101.scope")
        other = self.session("session-202.scope")
        dropin = own + ".d/50-fixture.conf"
        self.write(dropin, b"[Unit]\nDescription=first\n")
        with patch.object(helper, "linux_login_scope", return_value="session-101.scope"):
            baseline = self.review()
            for path in (other, dropin):
                self.write(path, b"[Unit]\nDescription=changed\n")
                result = self.apply(baseline)
                self.assertEqual(result["state"], "failed", result)
                self.assertIn("snapshot changed", result["message"])
        with patch.object(helper, "linux_login_scope", return_value=None):
            review = self.review()
            self.write(own, b"[Unit]\nDescription=unsupported scope change\n")
            self.assertEqual(self.apply(review)["state"], "failed")
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertEqual(self.runner.effects(), [])

    def test_current_session_dropin_native_use_and_mounted_declaration_refuse(self) -> None:
        own = self.session("session-101.scope")
        dropin = own + ".d/50-fixture.conf"
        self.write(dropin, b"[Scope]\nSupplementaryGroups=outpost-workspaces\n")
        with patch.object(helper, "linux_login_scope", return_value="session-101.scope"):
            self.blocked("referenced")
            self.path(dropin).unlink()
            self.mounts.add(own)
            self.blocked("Mounted")

    def test_linked_current_session_declaration_remains_bound(self) -> None:
        own = self.session("session-101.scope")
        self.path(helper.UNIT_DIR + "/fixture.scope").symlink_to(own)
        with patch.object(helper, "linux_login_scope", return_value="session-101.scope"):
            review = self.review()
            self.assertTrue(review["canReset"], review)
            self.write(own, b"[Unit]\nDescription=changed linked session\n")
            self.assertEqual(self.apply(review)["state"], "failed")
        self.assertEqual(self.runner.effects(), [])

    def test_normalization_waits_for_external_and_process_audits_and_rechecks_scope(self) -> None:
        self.session("session-101.scope")
        with patch.object(helper, "linux_login_scope", return_value="session-101.scope") as scope:
            self.accounts.foreign_process = True
            self.blocked("processes")
            scope.assert_not_called()
            self.accounts.foreign_process = False
            with patch.object(self.fs, "outside_ownership", side_effect=helper.Refused("external audit refused")):
                self.blocked("external audit refused")
            scope.assert_not_called()
        with patch.object(helper, "linux_login_scope", side_effect=["session-101.scope", "session-202.scope"]):
            self.blocked("scope changed")

    def test_nss_canonicalization_keeps_duplicate_and_alias_checks(self) -> None:
        baseline = self.review()
        self.accounts.users.append(copy.deepcopy(self.accounts.users[0]))
        self.blocked("Duplicate")
        self.accounts.users[-1]["name"] = "foreign-alias"
        self.blocked("alias")
        self.assertEqual(self.apply(baseline)["state"], "failed")

    def test_reset_parent_permissions_block_review_and_apply_before_mutation(self) -> None:
        review = self.review()
        self.directory(helper.RESETS)
        self.path(helper.RESETS).chmod(0o755)
        for value in (self.review(), self.recover_review()):
            self.assertFalse(value["canReset"], value)
            self.assertIn("permissions", value["blockers"][0])
        result = self.apply(review)
        self.assertEqual(result["state"], "failed", result)
        self.assertIn("permissions", result["message"])
        self.assertEqual(list(self.path(helper.RESETS).iterdir()), [])
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_preparation_barrier_blocks_normal_and_older_apply_and_status_is_public(self) -> None:
        normal = self.review()
        prepared = self.recover_review()
        self.assertTrue(prepared["canReset"], prepared)
        self.assertTrue(helper.hex_digest(prepared["recoveryToken"]))
        directory = helper.RESETS + "/" + self.request["resetId"]
        record = self.fs.json(directory + "/recovery.json", private=True)
        self.assertEqual(record["expected"], self.expected)
        self.assertEqual(record["snapshotDigest"], normal["snapshotDigest"])
        self.assertEqual(prepared["snapshotDigest"], helper.digest({"snapshotDigest": normal["snapshotDigest"],
                                                                  "recoveryToken": prepared["recoveryToken"]}))
        self.assertEqual(self.fs.names(directory), ["recovery.json", "status.json"])
        public = self.agent.stored(self.request)
        if public is None:
            self.fail("Preparation did not publish the public barrier")
        self.assertEqual(public["state"], "unknown")
        self.assertEqual(public["message"], helper.RECEIPT_MESSAGES["unknown"])
        self.assertNotIn("recoveryToken", public)
        self.assertEqual(stat.S_IMODE(self.path(directory + "/recovery.json").stat().st_mode), 0o600)
        self.assertEqual(self.apply(normal)["state"], "failed")
        # This is the older apply's exact existing-receipt fast path: even if the
        # caller supplies the new bound digest it can return only the stored hold.
        self.assertEqual(self.apply(prepared)["state"], "unknown")
        self.assertFalse(self.review()["canReset"])
        before = self.path(directory + "/recovery.json").read_bytes()
        self.agent.privileged = False
        with patch.object(self.fs, "json", wraps=self.fs.json) as reads, patch.object(self.fs, "atomic") as writes:
            status = self.response({**self.request, "mode": "status"})
        self.assertEqual(status["state"], "unknown")
        self.assertEqual([call.args[0] for call in reads.call_args_list], [directory + "/status.json"])
        self.assertNotIn("recoveryToken", status)
        writes.assert_not_called()
        self.assertEqual(self.path(directory + "/recovery.json").read_bytes(), before)
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_refresh_invalidates_stale_token_then_shared_cleanup_is_one_shot(self) -> None:
        first = self.recover_review()
        second = self.recover_review()
        self.assertTrue(second["canReset"], second)
        self.assertNotEqual(first["recoveryToken"], second["recoveryToken"])
        self.assertEqual(self.response(self.recovery_packet(first))["state"], "failed")
        directory = helper.RESETS + "/" + self.request["resetId"]
        self.assertFalse(self.path(directory + "/audit.json").exists())
        self.assertEqual(self.runner.effects(), [])
        with patch.object(self.agent, "cleanup", wraps=self.agent.cleanup) as cleanup:
            result = self.response(self.recovery_packet(second))
        cleanup.assert_called_once()
        self.assertEqual(result["state"], "complete", result)
        self.assertNotIn("recoveryToken", result)
        self.assertEqual(result["resetId"], self.request["resetId"])
        audit = self.fs.json(directory + "/audit.json", private=True)
        self.assertEqual(audit["state"], "complete")
        self.assertTrue(all(row["state"] == "complete" for row in audit["steps"]))
        self.directory(helper.ROOTS[2])
        self.write(helper.ROOTS[2] + "/new-data", b"not replayable")
        effects = list(self.runner.effects())
        self.assertEqual(self.response(self.recovery_packet(second))["state"], "complete")
        self.assertEqual(self.response(self.recovery_packet(first))["state"], "failed")
        self.assertFalse(self.recover_review()["canReset"])
        self.assertEqual(self.runner.effects(), effects)
        self.assertEqual(self.path(helper.ROOTS[2] + "/new-data").read_bytes(), b"not replayable")

    def test_recovery_writes_intent_before_effect_and_never_replays_failed_cleanup(self) -> None:
        self.services()
        prepared = self.recover_review()
        directory = helper.RESETS + "/" + self.request["resetId"]
        def before_effect(_argv):
            self.assertEqual(self.fs.json(directory + "/status.json")["state"], "unknown")
            audit = self.fs.json(directory + "/audit.json", private=True)
            self.assertEqual(audit["steps"][0]["state"], "started")
            self.assertFalse(self.recover_review()["canReset"])  # The global lock is still held.
        self.runner.before_effect = before_effect
        self.runner.fail = lambda _argv: True
        self.assertEqual(self.response(self.recovery_packet(prepared))["state"], "failed")
        before = self.path(directory + "/audit.json").read_bytes()
        effects = list(self.runner.effects())
        self.assertFalse(self.recover_review()["canReset"])
        self.assertEqual(self.response(self.recovery_packet(prepared))["state"], "failed")
        self.assertEqual(self.path(directory + "/audit.json").read_bytes(), before)
        self.assertEqual(self.runner.effects(), effects)

    def test_recovery_prior_audit_partial_or_malformed_preparations_are_never_repaired(self) -> None:
        prepared = self.recover_review()
        directory = helper.RESETS + "/" + self.request["resetId"]
        record_path, status_path = directory + "/recovery.json", directory + "/status.json"
        record, public = self.path(record_path).read_bytes(), self.path(status_path).read_bytes()
        mutations = [
            ("audit", lambda: self.write(directory + "/audit.json", b"{}", 0o600)),
            ("extra", lambda: self.write(directory + "/.reset-partial", b"partial", 0o600)),
            ("missing-private", lambda: self.path(record_path).unlink()),
            ("missing-public", lambda: self.path(status_path).unlink()),
            ("bad-private", lambda: self.write(record_path, b"{}", 0o600)),
            ("bad-public", lambda: self.write(status_path, b"{}")),
            ("foreign", lambda: self.write(record_path, helper.encoded({**json.loads(record), "expected": {**self.expected, "deviceId": str(uuid.uuid4())}}), 0o600)),
            ("public-private", lambda: self.path(record_path).chmod(0o644)),
            ("failed", lambda: self.agent.publish(self.recovery_packet(prepared), "failed")),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                mutate()
                before = {path.name: path.read_bytes() for path in self.path(directory).iterdir()}
                self.assertFalse(self.recover_review()["canReset"])
                self.assertEqual(self.response(self.recovery_packet(prepared))["state"], "failed")
                self.assertEqual(before, {path.name: path.read_bytes() for path in self.path(directory).iterdir()})
                for extra in ("audit.json", ".reset-partial"):
                    self.path(directory + "/" + extra).unlink(missing_ok=True)
                self.write(record_path, record, 0o600)
                self.write(status_path, public)
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_other_hold_still_blocks_and_preparation_requires_existing_lock(self) -> None:
        self.path(helper.BASE + "/install.lock").unlink()
        self.assertFalse(self.recover_review()["canReset"])
        self.assertFalse(self.path(helper.RESETS).exists())
        self.write(helper.BASE + "/install.lock", b"unchanged", 0o600)
        prepared = self.recover_review()
        peer = str(uuid.uuid4())
        self.fs.mkdir(helper.RESETS + "/" + peer, 0o711)
        self.agent.publish({**self.recovery_packet(prepared), "resetId": peer}, "unknown")
        self.assertFalse(self.recover_review()["canReset"])
        self.assertEqual(self.response(self.recovery_packet(prepared))["state"], "failed")
        self.assertEqual(self.path(helper.BASE + "/install.lock").read_bytes(), b"unchanged")
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_snapshot_change_requires_refresh_before_any_intent(self) -> None:
        prepared = self.recover_review()
        self.write(helper.ROOTS[2] + "/worker/task", b"changed native state", 0o600)
        result = self.response(self.recovery_packet(prepared))
        self.assertEqual(result["state"], "failed", result)
        self.assertIn("snapshot changed", result["message"])
        self.assertFalse(self.path(helper.RESETS + "/" + self.request["resetId"] + "/audit.json").exists())
        refreshed = self.recover_review()
        self.assertTrue(refreshed["canReset"], refreshed)
        self.assertEqual(self.response(self.recovery_packet(refreshed))["state"], "complete")

    def test_interrupted_preparation_publication_returns_no_token_and_retains_hold(self) -> None:
        with patch.object(self.agent, "publish", side_effect=helper.Deadline()):
            result = self.recover_review()
        self.assertFalse(result["canReset"], result)
        self.assertNotIn("recoveryToken", result)
        directory = helper.RESETS + "/" + self.request["resetId"]
        self.assertEqual(self.fs.names(directory), ["recovery.json"])
        self.assertFalse(self.recover_review()["canReset"])
        self.assertFalse(self.review()["canReset"])
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_budget_reserves_extra_file_without_double_charging_preparation(self) -> None:
        before = self.external_inventory_nodes()
        self.assertEqual(helper.RESET_RECEIPT_NODE_RESERVE, 4)
        self.assertEqual(helper.RECOVERY_RECEIPT_NODE_RESERVE, 5)
        with patch.object(helper, "MAX_EXTERNAL_NODES", before + 4):
            self.assertTrue(self.review()["canReset"])
            self.assertFalse(self.recover_review()["canReset"])
        self.assertFalse(self.path(helper.RESETS).exists())
        with patch.object(helper, "MAX_EXTERNAL_NODES", before + 5):
            prepared = self.recover_review()
            self.assertTrue(prepared["canReset"], prepared)
            refreshed = self.recover_review()
            self.assertTrue(refreshed["canReset"], refreshed)
            self.assertEqual(self.response(self.recovery_packet(refreshed))["state"], "complete")

    def test_recovery_empty_old_hold_and_symlink_preparations_remain_untouched(self) -> None:
        self.fs.mkdir(helper.RESETS, 0o711)
        directory = helper.RESETS + "/" + self.request["resetId"]
        self.fs.mkdir(directory, 0o711)
        self.assertFalse(self.recover_review()["canReset"])
        self.assertEqual(self.fs.names(directory), [])
        self.agent.publish({**self.request, "snapshotDigest": "a" * 64}, "unknown")
        public = self.path(directory + "/status.json").read_bytes()
        self.assertFalse(self.recover_review()["canReset"])
        self.assertEqual(self.path(directory + "/status.json").read_bytes(), public)
        # Even a correctly-shaped private record behind a link cannot confer recovery.
        record = {**self.agent.base(self.request), "expected": self.expected, "snapshotDigest": "b" * 64, "recoveryToken": "c" * 64}
        self.write("/outside-recovery-record", helper.encoded(record), 0o600)
        self.path(directory + "/recovery.json").symlink_to(self.path("/outside-recovery-record"))
        self.assertFalse(self.recover_review()["canReset"])
        self.assertEqual(self.path("/outside-recovery-record").read_bytes(), helper.encoded(record))
        self.assertTrue(self.path(directory + "/recovery.json").is_symlink())
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_refresh_is_locked_and_partial_refresh_invalidates_old_token(self) -> None:
        prepared = self.recover_review()
        directory = helper.RESETS + "/" + self.request["resetId"]
        before = self.path(directory + "/recovery.json").read_bytes()
        with self.fs.lock():
            self.assertFalse(self.recover_review()["canReset"])
            self.assertEqual(self.response(self.recovery_packet(prepared))["state"], "failed")
        self.assertEqual(self.path(directory + "/recovery.json").read_bytes(), before)
        with patch.object(self.agent, "publish", side_effect=OSError("private-publication-canary")):
            partial = self.recover_review()
        self.assertFalse(partial["canReset"])
        self.assertNotIn("recoveryToken", partial)
        self.assertNotIn("canary", str(partial))
        self.assertNotEqual(self.path(directory + "/recovery.json").read_bytes(), before)
        self.assertEqual(self.response(self.recovery_packet(prepared))["state"], "failed")
        self.assertFalse(self.recover_review()["canReset"])
        self.assertFalse(self.path(directory + "/audit.json").exists())
        self.assertEqual(self.runner.effects(), [])

    def test_recovery_wire_is_exact_privileged_and_has_fixed_budgets(self) -> None:
        self.assertEqual(helper.MODE_SECONDS["recover_review"], 120)
        self.assertEqual(helper.MODE_SECONDS["recover_apply"], 300)
        for mode in ("review", "apply", "status", "stop", "recover_review"):
            packet = {**self.request, "mode": mode, "recoveryToken": "a" * 64}
            if mode == "apply":
                packet["snapshotDigest"] = "b" * 64
            self.assertRaises(helper.Refused, self.agent.handle, packet)
        for token in ("A" * 64, "a" * 63, None, 7):
            self.assertRaises(helper.Refused, self.agent.handle, {**self.request, "mode": "recover_apply", "snapshotDigest": "b" * 64, "recoveryToken": token})
        self.agent.privileged = False
        self.assertRaises(helper.Refused, self.agent.handle, {**self.request, "mode": "recover_review"})
        self.assertRaises(helper.Refused, self.agent.handle, {**self.request, "mode": "recover_apply", "snapshotDigest": "b" * 64, "recoveryToken": "a" * 64})
        self.assertEqual(self.runner.calls, [])

    def test_failed_four_review_is_read_only_bound_and_nonsecret(self) -> None:
        """The legacy operation needs no completed installation metadata."""
        before = {str(path): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) for path in self.root.rglob("*") if path.is_file()}
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual((review["state"], review["completedSteps"], review["totalSteps"]), ("failed", 4, 12))
        self.assertEqual(review["paths"], list(helper.ROOTS))
        self.assertEqual(review["services"], [])
        self.assertIn("group:outpost-workspaces", review["accounts"])
        self.assertEqual(len(review["snapshotDigest"]), 64)
        self.assertEqual(review, self.review())
        after = {str(path): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertNotIn("canary", json.dumps(review))
        self.assertNotIn("fixture-secret-label", json.dumps(review))
        self.assertEqual(self.runner.effects(), [])

    def test_apply_preserves_evidence_peers_and_shared_data(self) -> None:
        """Only exact native roots/accounts disappear, never homes or peer paths."""
        evidence = self.path(self.operation + "/request.json").read_bytes()
        review = self.review()
        result = self.apply(review)
        self.assertEqual(result["state"], "complete", result)
        for root in helper.ROOTS:
            self.assertFalse(self.path(root).exists())
        self.assertEqual(self.path(self.operation + "/request.json").read_bytes(), evidence)
        self.assertEqual(self.path(self.operation + "/build-home/cache").read_bytes(), b"preserved cache")
        for path in ("/etc/kubernetes/config", "/var/lib/docker/keep", "/opt/outpost/keep", "/var/lib/outpost/keep", "/etc/tailscale/keep",
                     "/home/ssh/.ssh/id_ed25519", "/opt/outpost-native-peer/keep"):
            self.assertEqual(self.path(path).read_bytes(), b"unrelated-data")
        self.assertFalse(self.accounts.users)
        self.assertFalse(self.accounts.groups)
        for command in self.runner.effects():
            self.assertNotIn("-r", command)
            self.assertNotIn("--remove", command)
        self.assertEqual(stat.S_IMODE(self.path(helper.RESETS + "/" + self.request["resetId"] + "/audit.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path(helper.RESETS + "/" + self.request["resetId"] + "/status.json").stat().st_mode), 0o644)

    def test_completed_full_control_units_are_verified_stopped_and_removed(self) -> None:
        """A completed owned install is supported, including the optional root executor."""
        self.services(full_control=True, active=True)
        self.progress.update(state="ready", completedSteps=10)
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.write(helper.ROOTS[1] + "/installation.json", helper.encoded({"schema": 1, "layoutVersion": 1, "environmentId": self.expected["environmentId"],
                   "release": self.expected["releaseId"], "apiPort": 4518, "operationId": self.expected["operationId"], "fullControl": True}))
        self.path(helper.ROOTS[0] + "/current").symlink_to(self.release)
        review = self.review()
        self.assertEqual(review["services"], list(helper.UNITS), review)
        result = self.apply(review)
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual([call[-1] for call in self.runner.effects() if call[1] == "stop"], list(reversed(helper.UNITS)))
        self.assertFalse(any(call[1] in ("disable", "kill") for call in self.runner.effects()))

    def test_receipt_and_audit_exist_before_first_destructive_effect(self) -> None:
        """Every mutation sees durable metadata and a private started-step audit."""
        self.services()
        reset = helper.RESETS + "/" + self.request["resetId"]
        def inspect_effect(_command: list[str]) -> None:
            self.assertEqual(json.loads(self.path(reset + "/status.json").read_text())["state"], "unknown")
            audit = json.loads(self.path(reset + "/audit.json").read_text())
            self.assertEqual(audit["steps"][-1]["state"], "started")
            self.assertEqual(audit["expected"], self.expected)
        self.runner.before_effect = inspect_effect
        self.assertEqual(self.apply()["state"], "complete")

    def test_completed_apply_is_idempotent_even_if_new_native_data_exists(self) -> None:
        """A lost reply must never cause deletion of a later installation."""
        review = self.review()
        first = self.apply(review)
        calls = copy.deepcopy(self.runner.effects())
        self.write(helper.ROOTS[0] + "/new-owner", b"do not delete")
        second = self.apply(review)
        self.assertEqual(first, second)
        self.assertEqual(first["state"], "complete", first)
        self.assertEqual(calls, self.runner.effects())
        self.assertTrue(self.path(helper.ROOTS[0] + "/new-owner").exists())

    def test_partial_failure_is_durable_and_never_replayed(self) -> None:
        """A failure after deletion begins blocks both the same and a different reset ID."""
        self.runner.fail = lambda argv: argv[0] == "/usr/sbin/userdel"
        review = self.review()
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        calls = copy.deepcopy(self.runner.effects())
        self.assertEqual(self.apply(review), result)
        self.assertEqual(calls, self.runner.effects())
        self.request["resetId"] = str(uuid.uuid4())
        new_review = self.review()
        self.assertFalse(new_review["canReset"])
        self.assertIn("incomplete reset", " ".join(new_review["blockers"]))
        self.assertNotIn("private-command-secret-canary", json.dumps(result))

    def test_missing_public_receipt_is_unknown_and_holds_new_resets(self) -> None:
        """A crash after mkdir must not be interpreted as no reset or successful cleanup."""
        directory = helper.RESETS + "/" + self.request["resetId"]
        self.directory(directory)
        response = self.response({**self.request, "mode": "status"})
        self.assertEqual(response["state"], "unknown")
        self.assertFalse(self.review()["canReset"])

    def test_status_is_unprivileged_and_does_not_open_original_or_private_audit(self) -> None:
        """Status survives archived/unreadable original evidence and cannot execute tools."""
        review = self.review()
        self.assertEqual(self.apply(review)["state"], "complete")
        self.agent.privileged = False
        original_read = self.fs.read
        def limited(path: str, *args, **kwargs) -> bytes:
            self.assertEqual(path, helper.RESETS + "/" + self.request["resetId"] + "/status.json")
            return original_read(path, *args, **kwargs)
        with patch.object(self.fs, "read", side_effect=limited), patch.object(self.runner, "run", side_effect=AssertionError("status must not run tools")):
            result = self.response({**self.request, "mode": "status"})
        self.assertEqual(result["state"], "complete")
        other = copy.deepcopy(self.request)
        other["expected"]["deviceId"] = str(uuid.uuid4())
        self.assertEqual(self.response({**other, "mode": "status"})["state"], "unknown")

    def test_snapshot_change_in_native_data_refuses_before_intent(self) -> None:
        """A reviewed digest does not authorize changed contents or identities."""
        review = self.review()
        self.write(helper.ROOTS[2] + "/worker/new-task", b"changed")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("snapshot changed", result["message"])
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertEqual(self.runner.effects(), [])

    def test_global_lock_blocks_review_and_apply_without_truncation(self) -> None:
        """The installer and reset helper contend on exactly the same inode."""
        review = self.review()
        lock = self.path(helper.BASE + "/install.lock")
        with lock.open("rb") as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.blocked("lock is held")
            result = self.apply(review)
            self.assertEqual(result["state"], "failed")
        self.assertEqual(lock.read_bytes(), b"")

    def test_active_installer_blocks_even_with_terminal_progress(self) -> None:
        """Do not trust a stale failed status while the setup unit is active."""
        name = "outpost-setup-" + self.expected["operationId"] + ".service"
        self.runner.states[name] = self.runner.state(name, True, True)
        self.blocked("installer is active")

    def test_stop_only_requests_original_cancellation(self) -> None:
        """A malicious setup ExecStop is never called; no arbitrary process is killed."""
        name = "outpost-setup-" + self.expected["operationId"] + ".service"
        self.runner.states[name] = {**self.runner.state(name, True, True), "ExecStop": "/malicious/untrusted"}
        evidence = self.path(self.operation + "/request.json").read_bytes()
        self.assertIsNone(self.agent.handle({**self.request, "mode": "stop"}))
        self.assertEqual(self.path(self.operation + "/cancel").read_bytes(), b"1")
        self.assertEqual(self.path(self.operation + "/request.json").read_bytes(), evidence)
        self.assertEqual(self.runner.effects(), [])
        self.blocked("installer is active")

    def test_stop_rejects_linked_marker_without_outside_mutation(self) -> None:
        """No writable metadata hardlink can turn cancellation into an outside write."""
        marker = self.path(self.operation + "/cancel")
        outside = self.path("/outside-cancel")
        os.link(marker, outside)
        with self.assertRaises(helper.Refused):
            self.agent.handle({**self.request, "mode": "stop"})
        self.assertEqual(outside.read_bytes(), b"")
        marker.unlink()
        marker.symlink_to(outside)
        with self.assertRaises(helper.Refused):
            self.agent.handle({**self.request, "mode": "stop"})
        self.assertEqual(outside.read_bytes(), b"")

    def test_symlinks_inside_native_tree_are_only_unlinked(self) -> None:
        """Absolute, relative and peer-target symlinks are never followed by cleanup."""
        outside = self.path("/home/ssh/.ssh/id_ed25519")
        before = outside.read_bytes(), stat.S_IMODE(outside.stat().st_mode)
        self.path(self.release + "/node_modules/escape").symlink_to(outside)
        self.path(helper.ROOTS[2] + "/worker/peer").symlink_to(self.path("/opt/outpost-native-peer"), target_is_directory=True)
        self.assertEqual(self.apply()["state"], "complete")
        self.assertEqual((outside.read_bytes(), stat.S_IMODE(outside.stat().st_mode)), before)
        self.assertTrue(self.path("/opt/outpost-native-peer/keep").exists())

    def test_hardlinks_are_unlinked_without_outside_content_or_permission_mutation(self) -> None:
        """No recursive chmod/chown/truncate is used, including on hardlinked files."""
        outside = self.path("/home/ssh/.ssh/id_ed25519")
        before = outside.read_bytes(), outside.stat().st_mode, outside.stat().st_uid, outside.stat().st_gid
        os.link(outside, self.path(helper.ROOTS[2] + "/worker/hardlink"))
        self.assertEqual(self.apply()["state"], "complete")
        self.assertEqual((outside.read_bytes(), outside.stat().st_mode, outside.stat().st_uid, outside.stat().st_gid), before)
        self.assertEqual(outside.stat().st_nlink, 1)

    def test_ancestor_symlink_is_refused(self) -> None:
        """Even a symlink to the same legitimate directory is not traversed."""
        path = self.path("/opt")
        path.rename(self.path("/real-opt"))
        path.symlink_to(self.path("/real-opt"), target_is_directory=True)
        self.blocked()

    def test_native_root_symlink_is_refused(self) -> None:
        """A fixed root itself must be a directory owned by the installer."""
        path = self.path(helper.ROOTS[0])
        path.rename(self.path("/opt/real-native"))
        path.symlink_to(self.path("/opt/real-native"), target_is_directory=True)
        review = self.blocked("owned directory")
        self.assert_path_refusal(review["blockers"][0], "Native root is not an owned directory.", helper.ROOTS[0], path.lstat())

    def test_source_symlink_and_metadata_hardlink_are_refused(self) -> None:
        """Source provenance must come from a regular, anchored release copy."""
        path = self.path(self.release + "/package.json")
        path.unlink()
        path.symlink_to(self.path(self.operation + "/source/package.json"))
        self.blocked()
        path.unlink()
        self.write(self.release + "/package.json", self.source["package.json"])
        os.link(self.path(self.operation + "/request.json"), self.path("/request-hardlink"))
        self.blocked("Linked metadata")

    def test_mounted_root_subtree_and_file_are_refused(self) -> None:
        """Injected bind mounts on the same device are still blockers."""
        for mount in (helper.ROOTS[0], self.release + "/node_modules", helper.ROOTS[2] + "/worker/task", self.operation):
            with self.subTest(mount=mount):
                self.mounts = {mount}
                self.blocked("Mounted")

    def test_mount_inserted_after_review_refuses_apply(self) -> None:
        """Review approval does not authorize a subsequently mounted subtree."""
        review = self.review()
        self.mounts = {self.release + "/node_modules"}
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertTrue(self.path(helper.ROOTS[2] + "/worker/task").exists())

    def test_foreign_request_archive_and_completed_identity_are_refused(self) -> None:
        """All three identities, digest, size and installing device must authenticate."""
        for field in helper.EXPECTED:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.request)
                if field == "size":
                    changed["expected"][field] += 1
                elif field == "releaseId":
                    changed["expected"][field] = "host-" + "b" * 20
                elif field == "sha256":
                    changed["expected"][field] = "b" * 64
                elif field == "publicKey":
                    changed["expected"][field] = base64.b64encode(b"y" * 32).decode()
                else:
                    changed["expected"][field] = str(uuid.uuid4())
                self.assertFalse(self.response(changed)["canReset"])
        self.write(self.operation + "/release.tar.gz", b"changed", 0o600)
        self.blocked("archive does not match")
        self.archive(self.source)
        self.write(helper.ROOTS[1] + "/installation.json", b'{"environmentId":"foreign"}')
        self.blocked("Completed installation identity")

    def test_unexpected_root_entries_and_foreign_release_are_refused(self) -> None:
        """Root ownership alone is not a broad claim over arbitrary data."""
        self.write(helper.ROOTS[0] + "/foreign-data", b"not an installation")
        self.blocked("Unexpected native root entries")
        self.path(helper.ROOTS[0] + "/foreign-data").unlink()
        self.directory(helper.ROOTS[0] + "/releases/host-" + "b" * 20)
        self.blocked("Another release")

    def test_foreign_source_and_unsafe_archive_are_refused(self) -> None:
        """Never run or accept an installed helper merely because root owns it."""
        self.write(self.release + "/deploy/environment/host_install.py", b"arbitrary modified helper")
        self.blocked("Installed source differs")
        self.archive({**self.source, "../escape": b"payload"})
        self.blocked("unsafe or duplicate")

    def test_world_writable_native_path_and_metadata_are_refused(self) -> None:
        """Native source cannot be claimed through writable ancestors/files."""
        self.path(self.release).chmod(0o777)
        review = self.blocked("writable")
        self.assert_path_refusal(review["blockers"][0], "Native path is writable by unexpected identities.",
                                 self.release, self.path(self.release).stat())
        self.path(self.release).chmod(0o755)
        self.path(self.operation + "/request.json").chmod(0o644)
        self.blocked("permissions")

    def test_writable_file_diagnostic_is_read_only_and_nonsecret(self) -> None:
        """Both world and disallowed group writes identify the exact offending inode."""
        path = self.release + "/.venv/.lock"
        for mode in (0o666, 0o660):
            with self.subTest(mode=oct(mode)):
                self.write(path, b"private-lock-content-canary", mode)
                before = self.path(path).stat()
                review = self.blocked("writable")
                self.assert_path_refusal(review["blockers"][0], "Native path is writable by unexpected identities.", path, before)
                self.assertEqual(helper.stamp(self.path(path).stat()), helper.stamp(before))
                self.assertEqual(self.path(path).read_bytes(), b"private-lock-content-canary")

    def test_foreign_owner_diagnostic_has_path_and_metadata(self) -> None:
        """Inject foreign UID/GID independently, without any chown or real account changes."""
        path = self.release + "/node_modules/example/index.js"
        self.write(path, b"private-foreign-content-canary")
        before = self.path(path).stat()
        real_stat = os.stat
        for uid, gid in ((self.owner + 10000, before.st_gid), (self.owner, before.st_gid + 10000)):
            with self.subTest(uid=uid, gid=gid):
                foreign = os.stat_result((before.st_mode, before.st_ino, before.st_dev, before.st_nlink, uid, gid,
                                          before.st_size, before.st_atime, before.st_mtime, before.st_ctime))
                def changed(*args, foreign=foreign, **kwargs):
                    info = real_stat(*args, **kwargs)
                    return foreign if (info.st_dev, info.st_ino) == (before.st_dev, before.st_ino) else info
                with patch.object(helper.os, "stat", side_effect=changed):
                    review = self.blocked("unexpected ownership")
                self.assert_path_refusal(review["blockers"][0], "Native path has unexpected ownership.", path, foreign)
        self.assertEqual(helper.stamp(self.path(path).stat()), helper.stamp(before))

    def test_special_file_diagnostic_has_path_and_metadata(self) -> None:
        """A FIFO is refused by lstat, never opened for diagnostic contents."""
        path = self.release + "/node_modules/pipe"
        os.mkfifo(self.path(path), 0o600)
        review = self.blocked("unexpected special file")
        self.assert_path_refusal(review["blockers"][0], "Native path has an unexpected special file.", path, self.path(path).stat())

    def test_owner_diagnostic_escapes_controls_and_bounds_long_paths(self) -> None:
        """Quotes, controls, bidi, non-BMP and undecodable filename bytes stay inert."""
        checker = self.agent.owner_check(self.install_request, {row["name"]: row for row in self.accounts.users},
                                         {row["name"]: row for row in self.accounts.groups})
        name = 'bad\n\r\t\x1b[31m\x7f\x85\u202e\U0001f4a5\udcff"\\; uid=0'
        for suffix, truncated in ((name, False), (("nested" * 40 + "/") * 12 + name, True), ((name + "/") * 128, True)):
            path = self.release + "/" + suffix
            for mode, uid, gid, reason in (
                (stat.S_IFREG | 0o666, 903, 903, "Native path is writable by unexpected identities."),
                (stat.S_IFREG | 0o644, self.owner + 10000, 903, "Native path has unexpected ownership."),
                (stat.S_IFIFO | 0o600, 903, 903, "Native path has an unexpected special file."),
            ):
                with self.subTest(truncated=truncated, reason=reason):
                    info = os.stat_result((mode, 0, 0, 1, uid, gid, 0, 0, 0, 0))
                    with self.assertRaises(helper.Refused) as raised:
                        checker(path, info)
                    message = helper.public_error(raised.exception)
                    self.assert_path_refusal(message, reason, path, info, truncated)
                    self.assertEqual(json.loads(helper.encoded({"blockers": [message]}))["blockers"], [message])
        self.assertFalse(self.runner.calls)

    def test_source_drift_diagnostic_has_hashes_not_contents(self) -> None:
        """Even escaped/truncated paths leave both full SHA-256 digests and metadata intact."""
        expected = b"expected-source-secret-canary"
        current = b"modified-source-secret-canary"
        reason = "Installed source differs from the authenticated archive."
        for name, truncated in (("diagnostic.py", False), ("/".join(["\u00e9" * 80] * 2) + '/bad\n\x1b\u202e"\\.py', True)):
            with self.subTest(truncated=truncated):
                path = self.release + "/" + name
                self.archive({**self.source, name: expected})
                self.write(path, current)
                before = self.path(path).stat()
                review = self.blocked(reason)
                message = review["blockers"][0]
                self.assert_path_refusal(message, reason, path, before, truncated)
                self.assertIn("expected_sha256=" + hashlib.sha256(expected).hexdigest(), message)
                self.assertIn("current_sha256=" + hashlib.sha256(current).hexdigest(), message)
                self.assertEqual(helper.stamp(self.path(path).stat()), helper.stamp(before))
                self.assertEqual(self.path(path).read_bytes(), current)
                self.path(path).unlink()

    def test_source_drift_diagnostics_preserve_read_budget(self) -> None:
        """Additional hash context never permits reading a source beyond its existing limit."""
        path = self.release + "/package.json"
        self.write(path, self.source["package.json"] + b"private-oversized-canary")
        self.blocked("Unsafe or oversized file.")

    def test_build_ownership_is_location_specific(self) -> None:
        """Model build-owned inode metadata without chown or root locally."""
        checker = self.agent.owner_check(self.install_request, {row["name"]: row for row in self.accounts.users},
                                         {row["name"]: row for row in self.accounts.groups})
        info = os.stat_result((stat.S_IFREG | 0o644, 0, 0, 1, 903, 903, 0, 0, 0, 0))
        checker(self.release + "/node_modules/build-file", info)
        with self.assertRaises(helper.Refused):
            checker(helper.ROOTS[1] + "/coordinator.env", info)
        with self.assertRaises(helper.Refused):
            checker(helper.ROOTS[2] + "/worker/task", info)
        with self.assertRaises(helper.Refused):
            checker(self.release + "/node_modules/build-file", os.stat_result((stat.S_IFREG | 0o644, 0, 0, 1, 777, 777, 0, 0, 0, 0)))

    def test_account_other_use_aliases_homes_groups_and_processes_block(self) -> None:
        """Dedicated names are insufficient if UID/group membership/use has changed."""
        original_users, original_groups = self.accounts.snapshot()
        mutations = [lambda: self.accounts.users[0].update(shell="/bin/sh"),
                     lambda: self.accounts.users[0].update(home="/home/person"),
                     lambda: self.accounts.users.append({**self.accounts.users[0], "name": "foreign"}),
                     lambda: self.accounts.groups[3]["members"].append("foreign"),
                     lambda: self.accounts.groups.append({"name": "sudo", "gid": 27, "members": ["outpost-coord"]}),
                     lambda: setattr(self.accounts, "foreign_process", True)]
        for mutate in mutations:
            self.accounts.users, self.accounts.groups = copy.deepcopy((original_users, original_groups))
            self.accounts.foreign_process = False
            mutate()
            self.blocked()

    def test_outside_ownership_scan_checks_peer_paths_and_hardlinks(self) -> None:
        """The real descriptor scanner cannot exempt a prefix peer or unrelated home."""
        with self.assertRaisesRegex(helper.Refused, "outside this installation"):
            self.fs.outside_ownership({self.owner}, set(), list(helper.ROOTS))
        # Even the top-level peer itself is not part of the fixed native scope.
        self.assertFalse(helper.beneath("/opt/outpost-native-peer", "/opt/outpost-native"))

    def test_systemd_omitted_empty_stop_arrays_allow_verified_owned_units(self) -> None:
        """systemd 255 omits empty exec arrays even with show --all."""
        self.services(full_control=True, active=True)
        for name in helper.UNITS:
            self.runner.states[name].pop("ExecStop")
            self.runner.states[name].pop("ExecStopPost")
        review = self.review()
        self.assertTrue(review["canReset"], review)
        value = self.agent.service(helper.UNITS[0])
        self.assertEqual(value["ExecStop"], "")
        self.assertEqual(value["ExecStopPost"], "")
        self.assertEqual(self.apply(review)["state"], "complete")

    def test_no_other_missing_service_properties_are_defaulted(self) -> None:
        """Identity, hooks, state and reverse-stop dependency properties remain mandatory."""
        self.services()
        name = helper.UNITS[0]
        original = copy.deepcopy(self.runner.states[name])
        for missing in set(helper.PROPERTIES) - {"ExecStop", "ExecStopPost"}:
            with self.subTest(property=missing):
                self.runner.states[name] = {key: value for key, value in original.items() if key != missing}
                with self.assertRaisesRegex(helper.Refused, "identity is unavailable"):
                    self.agent.service(name)
        self.assertEqual(self.runner.effects(), [])

    def test_omitted_stop_fields_do_not_hide_actual_hooks_or_foreign_fragments(self) -> None:
        """Normalization never relaxes loaded-hook, actual-template or fragment checks."""
        self.services()
        name = helper.UNITS[0]
        value = self.runner.states[name]
        value.pop("ExecStop")
        value["ExecStopPost"] = "/srv/foreign/hook"
        self.blocked("unsafe hooks")
        value.pop("ExecStopPost")
        value["FragmentPath"] = "/srv/foreign/worker.service"
        self.blocked("unsafe hooks")
        value["FragmentPath"] = helper.UNIT_DIR + "/" + name
        self.write(value["FragmentPath"], helper.unit_texts(self.expected["releaseId"], False)[name] + b"ExecStop=/srv/foreign/hook\n")
        self.blocked("not the original")

    def test_unit_execstop_override_and_changed_loaded_state_are_refused(self) -> None:
        """Neither a modified unit nor a cached unsafe hook may be executed."""
        self.services()
        unit = helper.UNITS[0]
        original = self.path(helper.UNIT_DIR + "/" + unit).read_bytes()
        self.write(helper.UNIT_DIR + "/" + unit, original + b"ExecStop=/untrusted/evil\n")
        self.blocked("not the original")
        self.write(helper.UNIT_DIR + "/" + unit, original)
        self.runner.states[unit]["ExecStop"] = "/untrusted/evil"
        self.blocked("unsafe hooks")
        self.runner.states[unit]["ExecStop"] = ""
        self.directory(helper.UNIT_DIR + "/" + unit + ".d")
        self.blocked("overrides")

    def test_service_alias_and_foreign_enablement_block(self) -> None:
        """Only the installer's exact multi-user wants link is removable."""
        self.services()
        self.path(helper.UNIT_DIR + "/innocent.service").symlink_to(helper.UNIT_DIR + "/" + helper.UNITS[0])
        self.blocked("unexpected alias")
        self.path(helper.UNIT_DIR + "/innocent.service").unlink()
        link = self.path(helper.UNIT_DIR + "/multi-user.target.wants/" + helper.UNITS[0])
        link.unlink()
        link.symlink_to("/foreign/service")
        self.blocked("enablement is not owned")

    def test_peer_operation_with_claimed_native_files_blocks_legacy_review(self) -> None:
        """Two failed installations cannot claim the same fixed roots by name."""
        peer = str(uuid.uuid4())
        self.write(helper.OPERATIONS + "/" + peer + "/status.json", helper.encoded({**self.progress, "operationId": peer}))
        self.blocked("Another operation")

    def test_peer_preflight_failure_is_preserved_and_not_reset(self) -> None:
        """A peer that never reached native scope is neither deleted nor rewritten."""
        peer = str(uuid.uuid4())
        path = helper.OPERATIONS + "/" + peer + "/status.json"
        raw = helper.encoded({**self.progress, "operationId": peer, "completedSteps": 0})
        self.write(path, raw)
        self.assertEqual(self.apply()["state"], "complete")
        self.assertEqual(self.path(path).read_bytes(), raw)

    def test_stale_running_progress_requires_settled_launch_and_inactive_unit(self) -> None:
        """A dead original can be reset without rewriting its retained receipt."""
        self.progress["state"] = "running"
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.assertTrue(self.review()["canReset"])
        self.path(self.operation + "/launch.json").unlink()
        self.blocked()

    def test_preflight_failure_without_native_roots_can_be_receipted(self) -> None:
        """An empty owned scope still needs verified reset completion before new setup."""
        for root in helper.ROOTS:
            self.fs.remove_tree(root, self.agent.owner_check(self.install_request, {}, {}))
        self.accounts.users, self.accounts.groups = [], []
        self.local_accounts()
        self.progress.update(state="failed", completedSteps=0)
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.assertEqual(self.apply()["state"], "complete")

    def test_fixed_protocol_rejects_paths_extra_fields_and_boolean_size(self) -> None:
        """A caller cannot expand scope, spoof owner IDs or choose arbitrary commands."""
        variants = [{**self.request, "paths": ["/etc"]}, {**self.request, "owner": self.owner}, {**self.request, "command": "id"},
                    {**self.request, "resetId": "../peer"}, {**self.request, "mode": "uninstall"},
                    {**self.request, "expected": {**self.expected, "size": True}},
                    {**self.request, "expected": {**self.expected, "path": "/etc"}},
                    {**self.request, "mode": "apply"}, {**self.request, "snapshotDigest": "a" * 64}]
        for value in variants:
            with self.subTest(value=value), self.assertRaises(helper.SAFE_ERRORS):
                self.agent.handle(value)
        self.assertFalse(self.runner.calls)

    def test_privilege_is_not_inferred_from_sudo_environment(self) -> None:
        """No sudo environment flag can turn an unprivileged helper into a resetter."""
        self.agent.privileged = False
        with patch.dict(os.environ, {"SUDO_UID": "0", "SUDO_USER": "root"}):
            for mode in ("review", "stop", "apply"):
                packet = {**self.request, "mode": mode}
                if mode == "apply":
                    packet["snapshotDigest"] = "a" * 64
                with self.assertRaisesRegex(helper.Refused, "Root authorization"):
                    self.agent.handle(packet)
        self.assertFalse(self.runner.calls)
        self.assertEqual(self.response({**self.request, "mode": "status"})["state"], "unknown")

    def test_input_output_and_inventory_budgets_are_fixed(self) -> None:
        """Resource budgets do not rely on a sudo timeout or transport behavior."""
        self.assertEqual(helper.read_request(io.BytesIO(helper.encoded(self.request))), self.request)
        for raw in (b" " * (helper.MAX_INPUT + 1), b'{"mode":"review","mode":"status"}', b'[]', b'{"x":NaN}', helper.encoded(self.request) + b"{}"):
            with self.assertRaises(helper.SAFE_ERRORS):
                helper.read_request(io.BytesIO(raw))
        with patch.object(helper, "MAX_NODES", 2):
            self.assertFalse(self.review()["canReset"])
        self.assertLess(len(helper.encoded(self.review())), helper.MAX_OUTPUT)
        self.assertEqual(helper.MODE_SECONDS, {"review": 120, "apply": 300, "recover_review": 120, "recover_apply": 300, "stop": 30, "status": 10})

    def test_deadline_after_intent_preserves_recovery_hold(self) -> None:
        """A budget interruption cannot be mistaken for an untouched/clean host."""
        with patch.object(self.fs, "remove_tree", side_effect=helper.Deadline()):
            result = self.apply()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.response({**self.request, "mode": "status"})["state"], "failed")
        self.assertTrue(self.path(helper.ROOTS[0]).exists())

    def test_failed_receipt_publication_is_unknown_not_complete(self) -> None:
        """If durable outcome publication fails, only status reconciliation can decide."""
        original = self.fs.atomic
        def fail_status(path: str, value: bytes, mode: int = 0o600) -> None:
            if path.endswith("/status.json"):
                raise OSError("receipt unavailable")
            original(path, value, mode)
        with patch.object(self.fs, "atomic", side_effect=fail_status):
            result = self.apply()
        self.assertEqual(result["state"], "unknown")
        self.assertTrue(self.path(helper.ROOTS[0]).exists())

    def test_public_status_traversal_survives_private_root_umask(self) -> None:
        """New directories have explicit 0711 modes, not umask-masked 0700."""
        review = self.review()
        old = os.umask(0o077)
        try:
            result = self.apply(review)
        finally:
            os.umask(old)
        self.assertEqual(result["state"], "complete", result)
        for path in (helper.RESETS, helper.RESETS + "/" + self.request["resetId"]):
            self.assertEqual(stat.S_IMODE(self.path(path).stat().st_mode), 0o711)
        self.assertEqual(stat.S_IMODE(self.path(helper.RESETS + "/" + self.request["resetId"] + "/status.json").stat().st_mode), 0o644)

    def test_foreign_service_and_cron_use_block_account_deletion(self) -> None:
        """Dormant system configuration counts as other use even without a live PID."""
        for path, content in ((helper.UNIT_DIR + "/foreign.service", b"[Service]\nUser=outpost-coord\nExecStart=/bin/true\n"),
                              (helper.UNIT_DIR + "/foreign.service", b"[Service]\nUser=901\nExecStart=/bin/true\n"),
                              (helper.UNIT_DIR + "/foreign.service", b"[Unit]\nBindsTo=outpost-native-worker.service\n"),
                              ("/etc/cron.d/foreign", b"* * * * * outpost-build /bin/true\n")):
            with self.subTest(path=path, content=content):
                self.write(path, content)
                self.blocked()
                self.path(path).unlink()

    def test_userdel_hooks_and_nss_only_accounts_are_refused(self) -> None:
        """Account cleanup cannot execute configured hooks or operate on remote NSS users."""
        self.write("/etc/login.defs", b"USERDEL_CMD /usr/local/bin/unsafe-hook\n")
        self.blocked("deletion command")
        self.path("/etc/login.defs").unlink()
        self.write("/etc/shadow-maint/userdel-pre.d/unsafe", b"never execute")
        self.blocked("deletion hooks")
        self.path("/etc/shadow-maint/userdel-pre.d/unsafe").unlink()
        self.write("/etc/passwd", b"")
        self.blocked("inventories disagree")

    def test_preflight_failure_without_existing_lock_is_read_only_reviewable(self) -> None:
        """A settled original failure can be reviewed before the lock was ever created."""
        self.path(helper.BASE + "/install.lock").unlink()
        review = self.review()
        self.assertTrue(review["canReset"], review)
        self.assertFalse(self.path(helper.BASE + "/install.lock").exists())
        self.assertEqual(self.apply(review)["state"], "complete")

    def test_active_review_retains_verified_scope_and_original_progress(self) -> None:
        """Blocked review still describes exactly what would be removed after stopping."""
        self.services()
        unit = "outpost-setup-" + self.expected["operationId"] + ".service"
        self.runner.states[unit] = self.runner.state(unit, True, True)
        result = self.review()
        self.assertFalse(result["canReset"])
        self.assertEqual(result["services"], list(helper.UNITS[:2]))
        self.assertIn("user:outpost-build", result["accounts"])
        self.assertEqual(result["completedSteps"], 4)

    def test_cli_sets_own_deadlines_and_never_launches_sudo(self) -> None:
        """Exercise stdout framing and privilege checks with only injected backends."""
        request = {**self.request, "mode": "status"}
        output = io.BytesIO()
        descriptor = os.dup(self.root_fd)
        response = self.agent.status(request)
        fake = Mock()
        fake.handle.return_value = response
        with (patch.object(helper.sys, "argv", ["setup_restart_helper.py"]), patch.object(helper.sys, "platform", "linux"),
              patch.object(helper.sys, "flags", SimpleNamespace(isolated=1, no_site=1)),
              patch.object(helper.sys, "stdin", Mock(buffer=io.BytesIO(helper.encoded(request)))),
              patch.object(helper.sys, "stdout", Mock(buffer=output)), patch.object(helper.os, "open", return_value=descriptor),
              patch.object(helper.os, "geteuid", return_value=1000), patch.object(helper, "Helper", return_value=fake),
              patch.object(helper.signal, "signal"), patch.object(helper.signal, "alarm") as alarm):
            helper.main()
        self.assertEqual(json.loads(output.getvalue()), response)
        self.assertEqual(output.getvalue().count(b"\n"), 1)
        self.assertEqual([call.args[0] for call in alarm.call_args_list], [10, 10, 0])
        self.assertFalse(self.runner.calls)

    def test_cli_stdin_timeout_has_no_host_access_or_private_diagnostics(self) -> None:
        """An input timeout cannot depend on sudo or leak exception text."""
        error = io.StringIO()
        with (patch.object(helper.sys, "argv", ["setup_restart_helper.py"]), patch.object(helper.sys, "stderr", error),
              patch.object(helper, "read_request", side_effect=helper.Deadline()), patch.object(helper.os, "open") as opened,
              patch.object(helper.signal, "signal"), patch.object(helper.signal, "alarm"), self.assertRaises(SystemExit) as raised):
            helper.main()
        self.assertEqual(raised.exception.code, 1)
        opened.assert_not_called()
        self.assertEqual(error.getvalue(), "Setup restart helper refused the request; no verified completion was returned.\n")

    def test_generated_uv_locks_are_read_only_reviewable_then_only_unlinked(self) -> None:
        """Mode 0666 and the already corrected 0600 lock both remain unchanged until unlink."""
        owners = self.generated_locks()
        second = self.release + "/server/browser-engine/.venv/.lock"
        self.path(second).chmod(0o600)
        paths = [self.release + "/" + name for name in helper.UV_LOCKS]
        descriptors = [os.open(self.path(path), os.O_RDONLY) for path in paths]
        try:
            with self.virtual_owners(owners):
                before = [helper.stamp(os.fstat(fd)) for fd in descriptors]
                review = self.review()
                self.assertTrue(review["canReset"], review["blockers"])
                self.assertIn(helper.UV_LOCK_WARNING, review["warnings"])
                self.assertEqual(before, [helper.stamp(os.fstat(fd)) for fd in descriptors])
                self.assertFalse(self.runner.effects())
                self.assertEqual(self.apply(review)["state"], "complete")
                for fd, previous in zip(descriptors, before):
                    now = helper.stamp(os.fstat(fd))
                    self.assertEqual(now[:5], previous[:5])
                    self.assertEqual((now[5], now[6]), (0, 0))
        finally:
            for fd in descriptors:
                os.close(fd)

    def test_generated_uv_lock_uses_account_uid_and_gid_independently(self) -> None:
        """The reported build identity has distinct UID/GID; neither is a name-derived pin."""
        owners = self.generated_locks()
        build = next(row for row in self.accounts.users if row["name"] == "outpost-build")
        build.update(uid=993, gid=979)
        next(row for row in self.accounts.groups if row["name"] == "outpost-build")["gid"] = 979
        self.local_accounts()
        with self.virtual_owners({path: (993, 979) for path in owners}):
            review = self.review()
            self.assertTrue(review["canReset"], review["blockers"])
            self.assertEqual(self.apply(review)["state"], "complete")

    def test_generated_uv_lock_parent_is_opened_nofollow_and_lock_stamp_rechecked(self) -> None:
        owners = self.generated_locks()
        path = self.release + "/python/.lock"
        with self.virtual_owners(owners):
            info = self.fs.info(path, trusted=False)
            self.assertIsNotNone(info)
            if info is None:
                self.fail("Fixture lock is missing")
            self.write(path, b"concurrent-change-canary", 0o666)
            with self.assertRaisesRegex(helper.Refused, "changed during"):
                self.agent.generated_uv_lock(path, info, 903, 903)
            self.write(path, b"", 0o666)
            info = self.fs.info(path, trusted=False)
            if info is None:
                self.fail("Fixture lock is missing")
            parent = self.path(self.release + "/python")
            moved = self.path(self.release + "/moved-python")
            parent.rename(moved)
            parent.symlink_to(moved, target_is_directory=True)
            with self.assertRaises(helper.SAFE_ERRORS):
                self.agent.generated_uv_lock(path, info, 903, 903)

    def test_generated_uv_lock_requires_empty_singleton_nonexecutable_file(self) -> None:
        owners = self.generated_locks()
        for name in helper.UV_LOCKS:
            path = self.release + "/" + name
            for mode, contents in ((0o666, b"not-empty-canary"), (0o766, b""), (0o4666, b""), (0o2666, b""), (0o1666, b"")):
                with self.subTest(name=name, mode=oct(mode)):
                    self.write(path, contents, mode)
                    with self.virtual_owners(owners):
                        self.blocked("Generated uv lock")
            self.write(path, b"", 0o666)
            alias = self.path("/lock-alias")
            os.link(self.path(path), alias)
            with self.virtual_owners(owners):
                self.blocked("singly-linked")
            alias.unlink()

    def test_generated_uv_lock_rejects_symlink_directory_and_fifo(self) -> None:
        owners = self.generated_locks()
        path = self.release + "/python/.lock"
        self.path(path).unlink()
        for kind in ("link", "directory", "fifo"):
            with self.subTest(kind=kind):
                if kind == "link":
                    self.path(path).symlink_to(self.path(self.release + "/server/browser-engine/.venv/.lock"))
                elif kind == "directory":
                    self.path(path).mkdir()
                else:
                    os.mkfifo(self.path(path), 0o600)
                with self.virtual_owners(owners):
                    self.blocked("Generated uv lock")
                if kind == "directory":
                    self.path(path).rmdir()
                else:
                    self.path(path).unlink()

    def test_generated_uv_lock_and_parent_require_exact_build_identity_and_private_mode(self) -> None:
        owners = self.generated_locks()
        path, parent = self.release + "/python/.lock", self.release + "/python"
        for target in (path, parent):
            for owner in ((self.owner, os.fstat(self.root_fd).st_gid), (903, 904), (777, 903)):
                with self.subTest(target=target, owner=owner), self.virtual_owners({**owners, target: owner}):
                    review = self.blocked()
                    self.assertIn(json.dumps(target), review["blockers"][0])
        for mode in (0o755, 0o750, 0o710, 0o701, 0o770, 0o2700):
            self.path(parent).chmod(mode)
            with self.subTest(mode=oct(mode)), self.virtual_owners(owners):
                self.blocked("writable" if mode == 0o770 else "private build-owned directory")

    def test_generated_uv_lock_parent_symlink_and_missing_build_account_refuse(self) -> None:
        owners = self.generated_locks()
        parent = self.path(self.release + "/python")
        moved = self.path(self.release + "/real-python")
        parent.rename(moved)
        parent.symlink_to(moved, target_is_directory=True)
        with self.virtual_owners({self.release + "/real-python": (903, 903),
                                  self.release + "/real-python/.lock": (903, 903),
                                  self.release + "/server/browser-engine/.venv": (903, 903),
                                  self.release + "/server/browser-engine/.venv/.lock": (903, 903)}):
            self.blocked()
        parent.unlink()
        moved.rename(parent)
        self.accounts.users = [row for row in self.accounts.users if row["name"] != "outpost-build"]
        self.accounts.groups = [row for row in self.accounts.groups if row["name"] != "outpost-build"]
        with self.virtual_owners(owners):
            self.blocked()

    def test_uv_lock_exception_does_not_cover_other_paths_or_releases(self) -> None:
        owners = self.generated_locks()
        checker = self.agent.owner_check(self.install_request, {row["name"]: row for row in self.accounts.users},
                                         {row["name"]: row for row in self.accounts.groups})
        info = os.stat_result((stat.S_IFREG | 0o666, 0, 0, 1, 903, 903, 0, 0, 0, 0))
        for path in (self.release + "/other/.lock", self.release + "/python/.lock.extra", self.release + "/python/child/.lock",
                     self.release + "/.venv/.lock", helper.ROOTS[0] + "/releases/host-" + "b" * 20 + "/python/.lock"):
            with self.subTest(path=path), self.assertRaises(helper.Refused):
                checker(path, info)
        path = self.release + "/python/other"
        for mode in (0o666, 0o660):
            self.write(path, b"", mode)
            with self.virtual_owners({**owners, path: (903, 903)}):
                self.blocked("writable")

    def test_generated_uv_lock_checks_survive_review_apply_and_delete_races(self) -> None:
        owners = self.generated_locks()
        path = self.release + "/python/.lock"
        with self.virtual_owners(owners):
            review = self.review()
            self.assertTrue(review["canReset"], review["blockers"])
            self.write(path, b"changed-after-review-canary", 0o666)
            result = self.apply(review)
            self.assertEqual(result["state"], "failed")
            self.assertFalse(self.path(helper.RESETS).exists())
            self.assertFalse(self.runner.effects())
            self.write(path, b"", 0o666)
            review = self.review()
            remove = self.fs.remove_tree
            def changed(*args):
                self.write(path, b"changed-at-delete-canary", 0o666)
                return remove(*args)
            with patch.object(self.fs, "remove_tree", side_effect=changed):
                self.assertEqual(self.apply(review)["state"], "failed")
            self.assertEqual(self.path(path).read_bytes(), b"changed-at-delete-canary")

    def test_recorded_browser_hotfix_and_locks_allow_scoped_reset_with_audit_preserved(self) -> None:
        """Fresh fake identities exercise the real format/payloads, not a private JSON bypass."""
        owners = {**self.recorded_hotfix(), **self.generated_locks()}
        before = {str(path): (path.read_bytes(), helper.stamp(path.stat()))
                  for path in self.path(self.operation).rglob("*") if path.is_file()}
        with self.virtual_owners(owners):
            review = self.review()
            self.assertTrue(review["canReset"], review["blockers"])
            self.assertIn(helper.HOTFIX_WARNING, review["warnings"])
            self.assertIn(helper.UV_LOCK_WARNING, review["warnings"])
            self.assertNotIn("canary", json.dumps(review))
            self.assertTrue(all(len(text.encode()) <= 1000 for text in review["warnings"]))
            self.assertEqual(self.apply(review)["state"], "complete")
        after = {str(path): (path.read_bytes(), helper.stamp(path.stat()))
                 for path in self.path(self.operation).rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(any(self.path(path).exists() for path in helper.ROOTS))

    def test_browser_hotfix_constants_match_operator_script_without_importing_it(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        parsed = ast.parse((repository / "scripts/repair-outpost2-browser.py").read_text())
        literals = {node.targets[0].id: node.value for node in parsed.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
        for ours, theirs in ((helper.HOTFIX_ORIGINAL_SHA256, "ORIGINAL_SHA256"), (helper.HOTFIX_REPLACEMENT_SHA256, "REPLACEMENT_SHA256"),
                              (helper.HOTFIX_PREFIX, "AUDIT_PREFIX"), (helper.HOTFIX_PROVENANCE, "PROVENANCE"),
                              (tuple(helper.HOTFIX_BACKUPS), "BACKUPS")):
            self.assertEqual(ours, ast.literal_eval(literals[theirs]))
        launcher = literals["LAUNCHER"]
        if not isinstance(launcher, ast.Call):
            self.fail("Operator launcher constant is no longer a literal Path")
        self.assertEqual(helper.HOTFIX_LAUNCHER, ast.literal_eval(launcher.args[0]))

    def test_browser_hotfix_requires_the_recorded_choices_and_failed_stage(self) -> None:
        owners = self.recorded_hotfix()
        with self.virtual_owners(owners):
            for choice in ("browser", "coexistence", "fullControl"):
                changed = {**self.install_request, choice: False}
                self.write(self.operation + "/request.json", helper.encoded(changed), 0o600)
                self.blocked("recorded failed browser stage")
            self.write(self.operation + "/request.json", self.path(self.hotfix_audit + "/request.json").read_bytes(), 0o600)
            for key, value in (("state", "interrupted"), ("completedSteps", 3), ("stage", "Other"), ("extra", "unknown")):
                self.write(self.operation + "/status.json", helper.encoded({**self.progress, key: value}))
                self.blocked("recorded failed browser stage")

    def test_browser_hotfix_rechecks_audit_and_launcher_after_initial_reads(self) -> None:
        owners = self.recorded_hotfix()
        read = self.fs.read
        with self.virtual_owners(owners):
            for target in (self.hotfix_audit + "/request.json", self.release + "/server/browser-engine/launch.py"):
                saved = self.path(target).read_bytes()
                mode = stat.S_IMODE(self.path(target).stat().st_mode)
                def changed(path, *args, target=target, mode=mode, **kwargs):
                    data = read(path, *args, **kwargs)
                    if path == self.hotfix_audit + "/applied.json":
                        self.write(target, b"concurrent-change-canary", mode)
                    return data
                with patch.object(self.fs, "read", side_effect=changed):
                    self.blocked("changed during verification")
                self.write(target, saved, mode)
            hotfix = self.agent.browser_hotfix
            def reverted(*args):
                evidence = hotfix(*args)
                self.write(self.release + "/server/browser-engine/launch.py", self.source["server/browser-engine/launch.py"])
                return evidence
            with patch.object(self.agent, "browser_hotfix", side_effect=reverted):
                self.blocked("changed during source verification")

    def test_browser_hotfix_never_uses_manifest_paths_or_reads_special_audit_files(self) -> None:
        owners = self.recorded_hotfix()
        read = self.fs.read
        with self.virtual_owners(owners):
            self.hotfix_manifest["fontconfig"]["relativePath"] = "/outside/private-key"
            self.write_hotfix_records()
            with patch.object(self.fs, "read", wraps=read) as reads:
                self.blocked("manifest")
            self.assertNotIn("/outside/private-key", [call.args[0] for call in reads.call_args_list])
            path = self.hotfix_audit + "/applied.json"
            self.path(path).unlink()
            os.mkfifo(self.path(path), 0o600)
            self.hotfix_manifest["fontconfig"]["relativePath"] = "browsers/camoufox/fontconfig"
            raw = (json.dumps(self.hotfix_manifest, sort_keys=True, indent=2) + "\n").encode()
            self.write(self.hotfix_audit + "/manifest.json", raw, 0o600)
            with patch.object(self.fs, "read", wraps=read) as reads:
                self.blocked("file identity")
            self.assertNotIn(path, [call.args[0] for call in reads.call_args_list])

    def test_browser_hotfix_requires_single_canonical_audit_and_exact_file_set(self) -> None:
        owners = self.recorded_hotfix()
        with self.virtual_owners(owners):
            for name in ("extra.json", "launch.py.tmp"):
                self.write(self.hotfix_audit + "/" + name, b"private-extra-canary", 0o600)
                self.blocked("audit contents")
                self.path(self.hotfix_audit + "/" + name).unlink()
            for name in (*helper.HOTFIX_BACKUPS, "manifest.json", "applied.json"):
                target = self.path(self.hotfix_audit + "/" + name)
                data = target.read_bytes()
                target.unlink()
                self.blocked("audit contents")
                self.write(self.hotfix_audit + "/" + name, data, 0o600)
            extra = self.operation + "/browser-hotfix-" + str(uuid.uuid4())
            self.directory(extra)
            self.blocked("multiple")
            self.path(extra).rmdir()
            original = self.path(self.hotfix_audit)
            invalid = self.path(self.operation + "/browser-hotfix-not-a-uuid")
            original.rename(invalid)
            self.blocked("Unknown")
            invalid.rename(original)

    def test_browser_hotfix_rejects_manifest_field_and_nested_binding_tampering(self) -> None:
        owners = self.recorded_hotfix()
        original = copy.deepcopy(self.hotfix_manifest)
        changes = [(key, "foreign") for key in helper.IDENTITIES]
        changes += [("schema", True), ("auditId", "browser-hotfix-" + str(uuid.uuid4())), ("provenance", "approved"),
                    ("archiveSha256", "b" * 64), ("archiveSize", self.expected["size"] + 1),
                    ("originalSha256", "b" * 64), ("replacementSha256", "b" * 64), ("path", "/outside")]
        with self.virtual_owners(owners):
            for key, value in changes:
                with self.subTest(key=key):
                    self.hotfix_manifest = {**original, key: value}
                    self.write_hotfix_records()
                    self.blocked("manifest")
            for key, value in (("relativePath", "../../outside"), ("uid", self.owner), ("gid", 904), ("mode", 0o777)):
                self.hotfix_manifest = copy.deepcopy(original)
                self.hotfix_manifest["fontconfig"][key] = value
                self.write_hotfix_records()
                self.blocked("manifest")
            for key, value in (("sha256", "b" * 64), ("size", 0), ("uid", 777), ("gid", 777), ("mode", 0o666), ("path", "/outside")):
                self.hotfix_manifest = copy.deepcopy(original)
                self.hotfix_manifest["backups"]["launch.py"][key] = value
                self.write_hotfix_records()
                self.blocked("manifest")

    def test_browser_hotfix_rejects_applied_hash_identity_schema_and_raw_manifest_changes(self) -> None:
        owners = self.recorded_hotfix()
        original = copy.deepcopy(self.hotfix_applied)
        changes = [("schema", True), ("manifestSha256", "b" * 64), ("launcherSha256", "b" * 64),
                   ("fontconfigIdentity", []), ("extra", "private-extra-canary")]
        for index in range(5):
            identity = original["fontconfigIdentity"][:]
            identity[index] += 1
            changes.append(("fontconfigIdentity", identity))
        with self.virtual_owners(owners):
            for key, value in changes:
                with self.subTest(key=key, value=value):
                    changed = {**original, key: value}
                    self.write(self.hotfix_audit + "/applied.json", (json.dumps(changed, sort_keys=True, indent=2) + "\n").encode(), 0o600)
                    self.blocked("completion")
            self.write_hotfix_records()
            raw = self.path(self.hotfix_audit + "/manifest.json").read_bytes()
            self.write(self.hotfix_audit + "/manifest.json", raw + b" ", 0o600)
            self.blocked("manifest")
            self.write(self.hotfix_audit + "/manifest.json", raw.replace(b'"schema": 1', b'"schema": 1, "schema": 1'), 0o600)
            self.blocked("manifest")

    def test_browser_hotfix_rejects_arbitrary_private_json_and_self_consistent_new_payload(self) -> None:
        owners = self.recorded_hotfix()
        path = self.release + "/server/browser-engine/launch.py"
        with self.virtual_owners(owners):
            payload = b"raise RuntimeError('private-new-payload-canary')\n"
            self.write(path, payload)
            self.hotfix_manifest["replacementSha256"] = hashlib.sha256(payload).hexdigest()
            self.hotfix_applied["launcherSha256"] = hashlib.sha256(payload).hexdigest()
            self.write_hotfix_records()
            self.blocked("reviewed replacement")
            self.write(path, (Path(__file__).resolve().parents[3] / "server/browser-engine/launch.py").read_bytes())
            self.write(self.hotfix_audit + "/manifest.json", b'{"approved":true}', 0o600)
            self.blocked("manifest")

    def test_browser_hotfix_backups_and_retained_metadata_must_match(self) -> None:
        owners = self.recorded_hotfix()
        with self.virtual_owners(owners):
            for name in helper.HOTFIX_BACKUPS:
                path = self.hotfix_audit + "/" + name
                data = self.path(path).read_bytes()
                self.write(path, b"tampered-backup-canary", 0o600)
                self.blocked("backup")
                self.write(path, data, 0o600)
            for name in ("request.json", "status.json", "command.log", "launch.log", "release.tar.gz", "source/server/browser-engine/launch.py"):
                path = self.operation + "/" + name
                mode = stat.S_IMODE(self.path(path).stat().st_mode)
                self.path(path).chmod(0o400 if mode == 0o600 else 0o600)
                self.blocked()
                self.path(path).chmod(mode)
            for name in ("command.log", "launch.log"):
                path = self.operation + "/" + name
                self.write(path, b"changed-retained-canary", 0o600)
                self.blocked("backup")
                self.write(path, self.path(self.hotfix_audit + "/" + name).read_bytes(), 0o600)

    def test_browser_hotfix_audit_requires_root_private_unlinked_nofollow_entries(self) -> None:
        owners = self.recorded_hotfix()
        for name in (*helper.HOTFIX_BACKUPS, "manifest.json", "applied.json"):
            path = self.hotfix_audit + "/" + name
            with self.subTest(name=name):
                self.path(path).chmod(0o644)
                with self.virtual_owners(owners):
                    self.blocked("permissions")
                self.path(path).chmod(0o600)
                with self.virtual_owners({**owners, path: (903, 903)}):
                    self.blocked()
                with self.virtual_owners({**owners, path: (self.owner, os.fstat(self.root_fd).st_gid + 10000)}):
                    self.blocked()
                alias = self.path("/audit-alias")
                os.link(self.path(path), alias)
                with self.virtual_owners(owners):
                    self.blocked("links")
                alias.unlink()
                self.path(path).rename(alias)
                self.path(path).symlink_to(alias)
                with self.virtual_owners(owners):
                    self.blocked()
                self.path(path).unlink()
                alias.rename(self.path(path))
        for mode in (0o755, 0o710, 0o770):
            self.path(self.hotfix_audit).chmod(mode)
            with self.virtual_owners(owners):
                self.blocked()
        self.path(self.hotfix_audit).chmod(0o700)
        with self.virtual_owners({**owners, self.hotfix_audit: (903, 903)}):
            self.blocked()
        alias = self.path(self.operation + "/moved-audit")
        self.path(self.hotfix_audit).rename(alias)
        self.path(self.hotfix_audit).symlink_to(alias, target_is_directory=True)
        with self.virtual_owners(owners):
            self.blocked()

    def test_browser_hotfix_missing_unrecorded_partial_or_other_source_drift_refuses(self) -> None:
        owners = self.recorded_hotfix()
        with self.virtual_owners(owners):
            path = self.release + "/server/browser-engine/.outpost2-launch-incomplete.tmp"
            self.write(path, b"private-stage-canary", 0o600)
            self.blocked("staging")
            self.path(path).unlink()
            source = self.release + "/package.json"
            self.write(source, b"{}")
            self.blocked("Installed source differs")
            self.write(source, self.source["package.json"])
            launcher = self.release + "/server/browser-engine/launch.py"
            self.write(launcher, self.source["server/browser-engine/launch.py"])
            self.blocked("reviewed replacement")
        self.write(launcher, (Path(__file__).resolve().parents[3] / "server/browser-engine/launch.py").read_bytes())
        audit = self.path(self.hotfix_audit)
        audit.rename(self.path(self.operation + "/unrecognized-backup"))
        with self.virtual_owners(owners):
            self.blocked()

    def test_browser_hotfix_requires_original_source_backup_and_current_launcher_identity(self) -> None:
        owners = self.recorded_hotfix()
        original = self.path(self.operation + "/source/server/browser-engine/launch.py")
        saved = original.read_bytes()
        original.write_bytes(b"private-source-drift-canary")
        with self.virtual_owners(owners):
            self.blocked("retained source")
        original.write_bytes(saved)
        launcher = self.release + "/server/browser-engine/launch.py"
        for uid, gid in ((self.owner, os.fstat(self.root_fd).st_gid), (903, 904)):
            with self.virtual_owners({**owners, launcher: (uid, gid)}):
                self.blocked()
        os.link(self.path(launcher), self.path("/launcher-alias"))
        with self.virtual_owners(owners):
            self.blocked("links")

    def test_browser_hotfix_fontconfig_directory_identity_is_required_not_runtime_qualification(self) -> None:
        owners = self.recorded_hotfix()
        font = self.release + "/browsers/camoufox/fontconfig"
        self.path(font).chmod(0o700)
        with self.virtual_owners(owners):
            self.blocked("directory identity")
        self.path(font).chmod(0o755)
        with self.virtual_owners({**owners, font: (self.owner, os.fstat(self.root_fd).st_gid)}):
            self.blocked("directory identity")
        original = self.path(font)
        moved = self.path(self.release + "/browsers/camoufox/old-fontconfig")
        original.rename(moved)
        original.symlink_to(moved, target_is_directory=True)
        with self.virtual_owners({self.release + "/server/browser-engine/launch.py": (903, 903)}):
            self.blocked()

    def test_browser_hotfix_still_requires_inactivity_accounts_mounts_and_same_snapshot(self) -> None:
        owners = {**self.recorded_hotfix(), **self.generated_locks()}
        with self.virtual_owners(owners):
            setup = "outpost-setup-" + self.expected["operationId"] + ".service"
            self.runner.states[setup] = self.runner.state(setup, True, True)
            review = self.blocked("installer is active")
            self.assertIn(helper.HOTFIX_WARNING, review["warnings"])
            self.runner.states.clear()
            self.accounts.foreign_process = True
            self.blocked("processes")
            self.accounts.foreign_process = False
            for path in (self.hotfix_audit, self.hotfix_audit + "/manifest.json", self.release + "/python/.lock"):
                self.mounts = {path}
                self.blocked("Mounted")
            self.mounts.clear()
            review = self.review()
            self.assertTrue(review["canReset"], review["blockers"])
            # Same bytes, fresh inode: evidence identity is part of the snapshot too.
            path = self.hotfix_audit + "/command.log"
            data = self.path(path).read_bytes()
            self.path(path).unlink()
            self.write(path, data, 0o600)
            self.assertEqual(self.apply(review)["state"], "failed")
            self.assertFalse(self.path(helper.RESETS).exists())
            self.assertFalse(self.runner.effects())
            self.assertTrue(self.path(self.release).exists())

    def test_complete_legacy_build_owned_release_with_injected_metadata(self) -> None:
        """Exercise full review/apply with root/build ownership without local chown."""
        real_stat, real_fstat = os.stat, os.fstat
        build_inodes = {(path.stat().st_dev, path.stat().st_ino) for path in self.path(self.release).rglob("*")}
        build_inodes.add((self.path(self.release).stat().st_dev, self.path(self.release).stat().st_ino))
        class BuildInfo:
            """Read-through stat metadata changing only the injected ownership."""
            st_uid = 903
            st_gid = 903
            def __init__(self, info):
                self.info = info
            def __getattr__(self, name):
                return getattr(self.info, name)
        def changed(info):
            return BuildInfo(info) if (info.st_dev, info.st_ino) in build_inodes else info
        with (patch.object(helper.os, "stat", side_effect=lambda *args, **kwargs: changed(real_stat(*args, **kwargs))),
              patch.object(helper.os, "fstat", side_effect=lambda *args, **kwargs: changed(real_fstat(*args, **kwargs)))):
            result = self.apply()
        self.assertEqual(result["state"], "complete", result)
        self.assertTrue(self.path(self.operation + "/build-home/cache").exists())

    def test_replaced_root_after_intent_is_not_deleted(self) -> None:
        """A root at the same spelling cannot inherit a prior inode's authorization."""
        original = self.fs.remove_tree
        replaced = False
        def replace(path, checker, metadata=None):
            nonlocal replaced
            if not replaced:
                replaced = True
                self.path(path).rename(self.path("/opt/original-retained"))
                self.write(path + "/foreign", b"retain replacement")
            original(path, checker, metadata)
        with patch.object(self.fs, "remove_tree", side_effect=replace):
            result = self.apply()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.path(helper.ROOTS[0] + "/foreign").read_bytes(), b"retain replacement")
        self.assertTrue(self.path("/opt/original-retained").exists())

    def test_directory_symlink_swap_during_deletion_cannot_escape(self) -> None:
        """Race an entry after lstat but before its anchored open."""
        outside = self.path("/opt/outpost-native-peer")
        target = self.path(self.release + "/node_modules")
        real_open = os.open
        swapped = False
        def raced(name, flags, *args, **kwargs):
            nonlocal swapped
            if name == "node_modules" and flags & os.O_DIRECTORY and not swapped:
                swapped = True
                target.rename(self.path(self.release + "/held-modules"))
                target.symlink_to(outside, target_is_directory=True)
            return real_open(name, flags, *args, **kwargs)
        def remove(path, checker, metadata=None):
            with patch.object(helper.os, "open", side_effect=raced):
                return real_remove(path, checker, metadata)
        real_remove = self.fs.remove_tree
        with patch.object(self.fs, "remove_tree", side_effect=remove):
            result = self.apply()
        self.assertEqual(result["state"], "failed")
        self.assertTrue(swapped)
        self.assertEqual((outside / "keep").read_bytes(), b"unrelated-data")

    def test_mount_race_at_opened_directory_is_refused(self) -> None:
        """The descriptor mount check runs during deletion, not only at review."""
        real_remove = self.fs.remove_tree
        def remove(path, checker, metadata=None):
            with patch.object(self.fs, "same_mount", side_effect=helper.Refused("Bind-mounted native subtree is not removable.")):
                return real_remove(path, checker, metadata)
        with patch.object(self.fs, "remove_tree", side_effect=remove):
            result = self.apply()
        self.assertEqual(result["state"], "failed")
        self.assertTrue(self.path(self.release + "/package.json").exists())

    def test_delete_failure_mid_tree_retains_hold_and_original_evidence(self) -> None:
        """A partial unlink is not rolled back or replayed and never reported complete."""
        real_unlink = os.unlink
        def fail(name, *args, **kwargs):
            if name == "package.json":
                raise OSError("injected deletion failure")
            return real_unlink(name, *args, **kwargs)
        review = self.review()
        with patch.object(helper.os, "unlink", side_effect=fail):
            result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.apply(review), result)
        self.assertTrue(self.path(self.operation + "/release.tar.gz").exists())
        self.assertTrue(self.path(self.operation + "/request.json").exists())
        self.assertEqual(self.path("/var/lib/docker/keep").read_bytes(), b"unrelated-data")

    def test_nonzero_systemd_job_blocks_but_zero_job_is_inactive(self) -> None:
        """systemctl's numeric zero Job property is not an active installer."""
        name = "outpost-setup-" + self.expected["operationId"] + ".service"
        self.runner.states[name] = {**self.runner.state(name), "Job": "0"}
        self.assertTrue(self.review()["canReset"])
        self.runner.states[name]["Job"] = "123"
        self.blocked("installer is active")

    def test_completed_receipt_rejects_different_snapshot_without_mutations(self) -> None:
        """A reset ID cannot be rebound to another approval, even after completion."""
        self.assertEqual(self.apply()["state"], "complete")
        effects = self.runner.effects()
        result = self.response({**self.request, "mode": "apply", "snapshotDigest": "f" * 64})
        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.runner.effects(), effects)

    def test_mounted_unit_file_blocks_review_before_service_stop(self) -> None:
        """Service files, not only data roots, are subject to mount refusals."""
        self.services(active=True)
        self.mounts.add(helper.UNIT_DIR + "/" + helper.UNITS[0])
        self.blocked("Mounted")

    def test_utf16_request_is_not_part_of_utf8_wire_protocol(self) -> None:
        """Do not let json.loads silently broaden the declared encoding contract."""
        raw = json.dumps(self.request).encode("utf-16")
        with self.assertRaises(helper.SAFE_ERRORS):
            helper.read_request(io.BytesIO(raw))

    def test_cli_refuses_nonisolated_interpreter_before_host_access(self) -> None:
        """Native must select -I -S before Python can import attacker-controlled modules."""
        error = io.StringIO()
        with (patch.object(helper.sys, "argv", ["setup_restart_helper.py"]), patch.object(helper.sys, "stderr", error),
              patch.object(helper.sys, "stdin", Mock(buffer=io.BytesIO(helper.encoded(self.request)))),
              patch.object(helper.sys, "flags", SimpleNamespace(isolated=0, no_site=0)), patch.object(helper.os, "open") as opened,
              patch.object(helper.signal, "signal"), patch.object(helper.signal, "alarm"), self.assertRaises(SystemExit) as raised):
            helper.main()
        self.assertEqual(raised.exception.code, 1)
        opened.assert_not_called()

    def test_preflight_failure_never_claims_preexisting_native_scope(self) -> None:
        """A genuine failed0 receipt may be reporting an occupied installation."""
        self.progress.update(state="failed", completedSteps=0)
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.blocked("creation")
        result = self.response({**self.request, "mode": "apply", "snapshotDigest": "a" * 64})
        self.assertEqual(result["state"], "failed")
        self.assertTrue(self.path(self.release + "/package.json").exists())
        self.assertEqual(len(self.accounts.users), 3)
        self.assertEqual(self.runner.effects(), [])

    def test_preflight_cannot_claim_accounts_when_native_roots_are_absent(self) -> None:
        """Names and no-login settings do not prove the failed operation created users."""
        for root in helper.ROOTS:
            self.fs.remove_tree(root, self.agent.owner_check(self.install_request, {}, {}))
        self.progress.update(state="failed", completedSteps=0)
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.blocked("creation")

    def test_partial_accounts_cannot_claim_a_preexisting_workspace_group(self) -> None:
        """groupadd can fail before creating anything, after the roots were created."""
        self.accounts.users = []
        self.accounts.groups = [{"name": "outpost-workspaces", "gid": 904, "members": []}]
        self.local_accounts()
        self.progress.update(state="failed", completedSteps=1)
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.blocked("creation")
        self.assertEqual(self.accounts.groups[0]["gid"], 904)

    def test_empty_stage_one_evidence_only_reset_is_allowed(self) -> None:
        """Refusing ambiguous creation does not strand an actually empty scope."""
        for root in helper.ROOTS:
            self.fs.remove_tree(root, self.agent.owner_check(self.install_request, {}, {}))
        self.accounts.users, self.accounts.groups = [], []
        self.local_accounts()
        self.progress.update(state="failed", completedSteps=1)
        self.write(self.operation + "/status.json", helper.encoded(self.progress))
        self.assertEqual(self.apply()["state"], "complete")

    def test_external_linked_unit_cannot_hide_stop_hook_or_dormant_account_use(self) -> None:
        """An external linked declaration is not skipped just because it is a link."""
        self.services(active=True)
        target = "/srv/foreign/foreign.service"
        self.path(helper.UNIT_DIR + "/foreign.service").symlink_to(target)
        for content in (b"[Unit]\nPartOf=outpost-native-worker.service\n[Service]\nExecStop=/srv/foreign/hook\n",
                        b"[Service]\nUser=outpost-coord\nExecStart=/bin/true\n"):
            self.write(target, content)
            review = self.blocked("referenced")
            self.assert_path_refusal(review["blockers"][0], "Dedicated identity or native service is referenced by unrelated configuration.",
                                     target, self.path(target).stat())
            self.assertEqual(self.path(target).read_bytes(), content)

    def external_unit(self, target: str = "/srv/external/foreign.service", content: bytes = b"[Service]\nUser=nobody\nExecStart=/bin/true\n") -> str:
        """A root-controlled link into a protected tree outside all unit search directories."""
        self.write(target, content)
        source = helper.UNIT_DIR + "/foreign.service"
        self.path(source).symlink_to(target)
        return source

    def test_dracut_external_declarations_are_audited_and_preserved_by_reset(self) -> None:
        """All nine vendor links are read, never stopped/executed/deleted or silently skipped."""
        self.services(active=True)
        names = ("pre-udev", "shutdown", "pre-trigger", "shutdown-onfailure", "cmdline", "pre-pivot", "mount", "pre-mount", "initqueue")
        paths = []
        self.directory("/usr/lib/systemd/system")
        for name in names:
            unit = "dracut-" + name + ".service"
            module = "77initqueue" if name == "initqueue" else "77dracut-systemd"
            target = "/usr/lib/dracut/modules.d/" + module + "/" + unit
            self.write(target, b"[Service]\nType=oneshot\nExecStart=/bin/true\nExecStop=/never-execute-foreign-hook\n")
            link = "/usr/lib/systemd/system/" + unit
            self.path(link).symlink_to(target)
            paths += [link, target]
        before = {path: (helper.stamp(self.path(path).lstat()), os.readlink(self.path(path)) if self.path(path).is_symlink()
                         else self.path(path).read_bytes()) for path in paths}
        with patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        read_paths = {call.args[0] for call in reads.call_args_list}
        self.assertTrue(set(paths[1::2]) <= read_paths)
        self.assertEqual(review["services"], list(helper.UNITS[:2]))
        self.assertEqual(self.apply(review)["state"], "complete")
        after = {path: (helper.stamp(self.path(path).lstat()), os.readlink(self.path(path)) if self.path(path).is_symlink()
                        else self.path(path).read_bytes()) for path in paths}
        self.assertEqual(before, after)
        self.assertTrue(all(call[-1] in helper.UNITS for call in self.runner.calls if call[:2] == ["/usr/bin/systemctl", "stop"]))
        self.assertTrue(all("dracut" not in arg for call in self.runner.calls for arg in call))

    def test_external_unit_scans_names_numeric_ids_and_native_dependencies(self) -> None:
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        self.services(active=True)
        declarations = ["User=outpost-coord", "Group=outpost-pi", "SupplementaryGroups=outpost-workspaces",
                        'User="901"', "Group=902", "SupplementaryGroups=65534 904", "PartOf=" + helper.UNITS[0],
                        "Requires=" + helper.UNITS[1], "BindsTo=" + helper.UNITS[0], "After=" + helper.UNITS[1]]
        for line in declarations:
            with self.subTest(line=line):
                self.write(target, ("[Service]\n" + line + "\n# private-content-canary\n").encode())
                review = self.blocked()
                self.assertIn("numeric identity" if any(number in line for number in ("901", "902", "904")) else "referenced", review["blockers"][0])
                self.assertIn("path=" + json.dumps(target), review["blockers"][0])
                self.assertIn("mode=0o100644", review["blockers"][0])

    def use_distinct_build_ids(self) -> None:
        """Model the actual separate build UID and primary GID without host account changes."""
        next(row for row in self.accounts.users if row["name"] == "outpost-build").update(uid=993, gid=979)
        next(row for row in self.accounts.groups if row["name"] == "outpost-build")["gid"] = 979
        self.local_accounts()

    def test_external_identity_continuations_cannot_hide_distinct_uid_or_gid(self) -> None:
        self.use_distinct_build_ids()
        self.services(active=True)
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        declarations = ["SupplementaryGroups=65534 \\\n    979", "SupplementaryGroups=65534 \\\n    993",
                        "User=\\\n  993", "Group=\\\n  979", "SupplementaryGroups\\\n =65534 \\\n  979",
                        "SupplementaryGroups=65534 \\\n# ignored \\\n ; ignored too\n  979",
                        "SupplementaryGroups=65534 \\\r\n\t# ignored\r\n\t979"]
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                self.write(target, ("[Service]\n" + declaration + "\n# private-content-canary\n").encode())
                review = self.blocked("numeric identity")
                self.assert_path_refusal(review["blockers"][0], "Dedicated numeric identity is used by another service.",
                                         target, self.path(target).stat())

    def test_identity_scan_uses_logical_lines_for_direct_units_and_dropins(self) -> None:
        self.use_distinct_build_ids()
        for path in (helper.UNIT_DIR + "/foreign.service", helper.UNIT_DIR + "/foreign.service.d/accounts.conf"):
            with self.subTest(path=path):
                self.write(path, b"[Service]\nSupplementaryGroups=65534 \\\n  979\n")
                self.blocked("numeric identity")
                self.path(path).unlink()

    def test_blank_line_ends_continuation_before_a_fresh_numeric_assignment(self) -> None:
        """Ignoring blank lines while joining would conceal User=/Group= inside Description=."""
        self.use_distinct_build_ids()
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        for empty in ("", " \t"):
            for assignment in ("User=993", "Group=979", 'SupplementaryGroups="65534" "979"'):
                with self.subTest(empty=empty, assignment=assignment):
                    self.write(target, ("[Service]\nDescription=ordinary \\\n# comment\n" + empty + "\n" + assignment + "\n").encode())
                    self.blocked("numeric identity")

    def test_quoted_identity_lists_and_single_ids_are_not_shell_split(self) -> None:
        self.use_distinct_build_ids()
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        declarations = ['SupplementaryGroups="65534" "979"', "SupplementaryGroups='65534' '979'",
                        'SupplementaryGroups="979" "65534"', 'SupplementaryGroups="65534" 979',
                        'SupplementaryGroups=65534 "979"', 'SupplementaryGroups="65534" \\\n  "979"',
                        "User='993'", 'Group="979"', 'SupplementaryGroups="65534 979"']
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                self.write(target, ("[Service]\n" + declaration + "\n").encode())
                self.blocked()

    def test_identity_c_escapes_specifiers_and_unknown_syntax_fail_closed(self) -> None:
        self.use_distinct_build_ids()
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        values = [r"\x39\x37\x39", r"\071\067\071", r"\u0039\u0037\u0039", r"\U00000039\U00000037\U00000039",
                  r'"\x39\x37\x39"', r"65534\s979", r"65534\t979", r"\q979", r"outpost\x2dbuild", "%U", "%G", "%i", "%%",
                  "${UID}", "+979", "0979", "0x3d3", "4294967295", "9" * 20, '"65534', "'65534", '"65534"junk',
                  "'65534''65533'", '"65534\' 65533', '"65534 65533"', '""', "65534,65533", "65534 # comment", "65534;comment",
                  "65534\u0085979", "65534\u00a065533", "65534\u2028979", "65534\\ "]
        for key in ("User", "Group", "SupplementaryGroups"):
            for value in values:
                with self.subTest(key=key, value=value):
                    self.write(target, ("[Service]\n" + key + "=" + value + "\n# private-content-canary\n").encode())
                    self.blocked("Unsupported systemd identity syntax")
        for declaration in ("User", "Group 65534", "SupplementaryGroups+=65534", '"User"=65534'):
            self.write(target, ("[Service]\n" + declaration + "\n").encode())
            self.blocked("Unsupported systemd identity syntax")

    def test_malformed_config_continuations_and_control_separators_fail_closed(self) -> None:
        self.use_distinct_build_ids()
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        for body in ("SupplementaryGroups=65534 " + chr(92), "SupplementaryGroups=65534 \\\n# ignored\n",
                     "User=65534\x00Group=979", "Description=ordinary\vUser=993", "Description=ordinary\fGroup=979",
                     "Description=ordinary\rUser=993", "Description=ordinary\n\ufeffUser=993"):
            with self.subTest(body=body):
                self.write(target, ("[Service]\n" + body).encode())
                self.blocked()

    def test_supported_benign_identity_syntax_remains_read_only_and_resettable(self) -> None:
        self.use_distinct_build_ids()
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        content = ("\ufeff[Service]\r\n# User=993\r\n; Group=979\r\nUser='nobody'\r\nGroup=\"65534\"\r\n"
                   "SupplementaryGroups=\r\nSupplementaryGroups='65534' \\\r\n  # skipped comment \\\r\n"
                   "  ; skipped too\r\n  \"65533\"\r\nDescription=ordinary \\\r\n \t\r\nGroup=nogroup\r\n"
                   "User=\r\nExecStart=/bin/true\r\n").encode()
        self.write(target, content)
        before = helper.stamp(self.path(target).stat()), helper.stamp(self.path(source).lstat())
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(before, (helper.stamp(self.path(target).stat()), helper.stamp(self.path(source).lstat())))
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(content, self.path(target).read_bytes())
        self.assertEqual(before, (helper.stamp(self.path(target).stat()), helper.stamp(self.path(source).lstat())))

    def test_identity_parser_keeps_literal_references_and_conservative_physical_guards(self) -> None:
        self.use_distinct_build_ids()
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        for body in ("User=993\nUser=nobody", "Group=979\nGroup=", "SupplementaryGroups=979\nSupplementaryGroups=",
                     "Description=ordinary \\\nUser=993", "Description=ordinary \\\nGroup=979", "Group=65534\u00a0979", "User=outpost-build",
                     "SupplementaryGroups=outpost-workspaces", "PartOf=\\\n outpost-native-worker.service",
                     "Requires=other.service \\\n # ignored\n outpost-native-coordinator.service"):
            with self.subTest(body=body):
                self.write(target, ("[Service]\n" + body + "\n").encode())
                self.blocked()

    def test_changed_continued_identity_after_review_refuses_before_effects(self) -> None:
        self.use_distinct_build_ids()
        self.services(active=True)
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.write(target, b"[Service]\nSupplementaryGroups=65534 \\\n 979\n")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("numeric identity", result["message"])
        self.assertFalse(self.runner.effects())
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertTrue(self.path(self.release).exists())

    def stock_user_templates(self) -> tuple[str, str]:
        """Protected stock-shaped templates, including runtime-dir's non-identity %i uses."""
        user = "/usr/lib/systemd/system/user@.service"
        runtime = "/usr/lib/systemd/system/user-runtime-dir@.service"
        self.write(user, b"[Unit]\nDescription=User Manager for UID %i\nBindsTo=user-runtime-dir@%i.service\n"
                        b"[Service]\nUser=%i\nPAMName=systemd-user\nExecStart=/usr/lib/systemd/systemd --user\nSlice=user-%i.slice\n")
        self.write(runtime, b"[Unit]\nDescription=User Runtime Directory /run/user/%i\n[Service]\nType=oneshot\n"
                           b"ExecStart=/usr/lib/systemd/systemd-user-runtime-dir start %i\n"
                           b"ExecStop=/usr/lib/systemd/systemd-user-runtime-dir stop %i\nRemainAfterExit=yes\nSlice=user-%i.slice\n")
        return user, runtime

    def loaded_instance(self, name: str, fragment: str, *, user: str = "1000", group: str = "1000", dropins: str = "") -> None:
        """Model already-loaded, inactive units; never invoke a real service manager."""
        self.runner.instances[name] = {"Id": name, "Names": name, "LoadState": "loaded", "FragmentPath": fragment,
                                       "SourcePath": "", "DropInPaths": dropins, "NeedDaemonReload": "no",
                                       "User": user, "Group": group, "SupplementaryGroups": ""}

    def test_capsule_prefixed_instance_identity_is_read_only_and_preserved(self) -> None:
        """systemd 259's User=c-%i is ordinary bounded substitution, not an unknown identity."""
        self.use_distinct_build_ids()
        path = "/usr/lib/systemd/system/capsule@.service"
        content = (b"[Unit]\nDescription=Capsule Service Manager for %i\nAfter=dbus.service systemd-oomd.service\n"
                   b"[Service]\nUser=c-%i\nDynamicUser=yes\nType=notify-reload\n"
                   b"ExecStart=/usr/lib/systemd/systemd --user --unit=capsule@%i.target\n"
                   b"Environment=HOME=/var/lib/capsules/%i\nStateDirectory=capsules/%i\nRuntimeDirectory=capsules/%i\n")
        self.write(path, content)
        self.assertTrue(self.review()["canReset"])
        self.write(helper.UNIT_DIR + "/ordinary.target", b"[Unit]\nWants=capsule@demo.service\n")
        self.loaded_instance("capsule@demo.service", path, user="c-demo", group="c-demo")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(self.path(path).read_bytes(), content)
        self.assertFalse(any(call[:2] == ["/usr/bin/systemctl", "stop"] for call in self.runner.calls))

    def test_identity_substitution_cannot_construct_native_names_or_numeric_ids(self) -> None:
        """Audit the fully substituted identity, including dependency-only instances and quoted lists."""
        self.use_distinct_build_ids()
        template = "/usr/lib/systemd/system/foreign@.service"
        reference = helper.UNIT_DIR + "/ordinary.target"
        for field, value, instance in (("User", "outpost-%i", "build"), ("Group", "outpost-%i", "workspaces"),
                                       ("User", "99%i", "3"), ("Group", "%i9", "97"),
                                       ("User", "9%i3", "9"), ("SupplementaryGroups", '65534 "9%i"', "79")):
            with self.subTest(field=field, value=value):
                self.write(template, ("[Service]\n" + field + "=" + value + "\nExecStart=/srv/never-run\n").encode())
                self.write(reference, ("[Unit]\nWants=foreign@" + instance + ".service\n").encode())
                self.blocked("identity")
        self.assertFalse(self.runner.effects())

    def test_identity_substitution_requires_context_and_valid_bounded_result(self) -> None:
        """Unresolved specifiers, unsafe tokens, and overlong results cannot become guessed identities."""
        self.use_distinct_build_ids()
        path = "/usr/lib/systemd/system/foreign@.service"
        reference = helper.UNIT_DIR + "/ordinary.target"
        for value in ("c-%I", "c-%U", "c-%%i", r"c-\x25i", '"c-%i other"'):
            self.write(path, ("[Service]\nUser=" + value + "\n").encode())
            self.blocked("identity syntax")
        self.write(path, b"[Service]\nUser=c-%i\n")
        plain = helper.UNIT_DIR + "/plain.service"
        self.write(plain, b"[Service]\nUser=c-%i\n")
        self.blocked("identity syntax")
        self.path(plain).unlink()
        self.write(path, ("[Service]\nUser=c-" + "%i" * 100 + "\n").encode())
        self.write(reference, b"[Unit]\nWants=foreign@longinstance.service\n")
        self.blocked("identity syntax")
        self.write(path, b"[Service]\nUser=c-%i\n")
        self.loaded_instance("foreign@longinstance.service", path, user="c-%i", group="")
        self.blocked("identity syntax")

    def test_changed_identity_substitution_cannot_reuse_review(self) -> None:
        self.use_distinct_build_ids()
        path = "/usr/lib/systemd/system/foreign@.service"
        self.write(path, b"[Service]\nUser=c-%i\n")
        self.write(helper.UNIT_DIR + "/ordinary.target", b"[Unit]\nWants=foreign@build.service\n")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.write(path, b"[Service]\nUser=outpost-%i\n")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("identity", result["message"])
        self.assertFalse(self.runner.effects())
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_stock_generic_templates_are_not_claimed_to_use_every_identity(self) -> None:
        self.use_distinct_build_ids()
        paths = self.stock_user_templates()
        before = {path: (self.path(path).read_bytes(), helper.stamp(self.path(path).stat())) for path in paths}
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(before, {path: (self.path(path).read_bytes(), helper.stamp(self.path(path).stat())) for path in paths})
        self.assertFalse(any(call[:2] == ["/usr/bin/systemctl", "stop"] for call in self.runner.calls))
        self.assertIn(list(helper.INSTANCE_LIST_COMMAND), self.runner.calls)

    def test_stock_loaded_benign_instances_and_dropins_are_read_only_audited(self) -> None:
        self.use_distinct_build_ids()
        user, runtime = self.stock_user_templates()
        dropin = "/usr/lib/systemd/system/user@.service.d/identity.conf"
        self.write(dropin, b"[Service]\nGroup=\"%i\"\nSupplementaryGroups='65534' \\\n '%i'\n")
        self.loaded_instance("user@1000.service", user, dropins=dropin)
        self.loaded_instance("user-runtime-dir@1000.service", runtime, user="", group="")
        with patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertTrue({user, runtime, dropin} <= {call.args[0] for call in reads.call_args_list})
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertTrue(all(self.path(path).exists() for path in (user, runtime, dropin)))
        self.assertFalse(any(call[:2] == ["/usr/bin/systemctl", "stop"] for call in self.runner.calls))

    def test_configured_template_instances_cannot_name_native_ids_or_accounts(self) -> None:
        self.use_distinct_build_ids()
        user, runtime = self.stock_user_templates()
        self.directory(helper.UNIT_DIR + "/multi-user.target.wants")
        for template in (user, runtime):
            for identity in ("993", "979", "outpost-build", "outpost-workspaces"):
                name = self.path(template).name.replace("@.", "@" + identity + ".")
                link = helper.UNIT_DIR + "/multi-user.target.wants/" + name
                with self.subTest(name=name):
                    self.path(link).symlink_to(template)
                    self.blocked("native identity")
                    self.path(link).unlink()
        for path in (helper.UNIT_DIR + "/user@993.service", helper.UNIT_DIR + "/user@979.service.d/override.conf"):
            self.write(path, b"[Service]\nUser=nobody\n")
            self.blocked("native identity")
            self.path(path).unlink()

    def test_external_template_symlink_uses_source_instance_not_target_basename(self) -> None:
        self.use_distinct_build_ids()
        external = "/srv/external/shared-template"
        self.write(external, b"[Service]\nUser=\"%i\"\n")
        generic = helper.UNIT_DIR + "/example@.service"
        self.path(generic).symlink_to(external)
        self.assertTrue(self.review()["canReset"])
        for identity in ("1000", "993", "979", "outpost-build"):
            source = helper.UNIT_DIR + "/example@" + identity + ".service"
            self.path(source).symlink_to(external)
            if identity == "1000":
                self.assertTrue(self.review()["canReset"])
            else:
                self.blocked("native identity")
            self.path(source).unlink()
        self.path(generic).unlink()
        plain = helper.UNIT_DIR + "/not-an-instance.service"
        self.path(plain).symlink_to(external)
        self.blocked("Unsupported systemd identity syntax")

    def test_generic_template_names_do_not_bypass_content_or_metadata_guards(self) -> None:
        self.use_distinct_build_ids()
        user, _ = self.stock_user_templates()
        original = self.path(user).read_bytes()
        for body in (b"User=993", b"Group=979", b"User=outpost-build", b"PartOf=outpost-native-worker.service",
                     b"SupplementaryGroups=65534 \\\n 979", br"User=\x39\x39\x33", b"User=%I", b"User=prefix-%I"):
            with self.subTest(body=body):
                self.write(user, b"[Service]\n" + body + b"\n")
                self.blocked()
        self.write(user, original, 0o666)
        self.blocked()
        self.path(user).chmod(0o644)
        with self.virtual_owners({user: (self.owner + 10000, os.fstat(self.root_fd).st_gid)}):
            self.blocked()

    def test_systemctl_quoted_escaped_instance_names_are_decoded_once_and_preserved(self) -> None:
        """systemd 259 quotes strv Names while scalar Id retains the unit-name backslashes."""
        name = r"systemd-fsck@dev-disk-by\x2duuid-fixture.service"
        template = "/usr/lib/systemd/system/systemd-fsck@.service"
        content = b"[Service]\nUser=root\nExecStart=/srv/never-run-fsck\n"
        self.write(template, content)
        self.loaded_instance(name, template, user="root", group="root")
        self.runner.instances[name]["Names"] = json.dumps(name)
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(self.path(template).read_bytes(), content)
        self.assertFalse(any("/srv/never-run-fsck" in call for call in self.runner.calls))

    def test_quoted_names_still_detect_hidden_native_identity_aliases(self) -> None:
        self.use_distinct_build_ids()
        name = "foreign@benign.service"
        template = "/usr/lib/systemd/system/foreign@.service"
        self.write(template, b"[Service]\nUser=root\n")
        for alias in (r"foreign@\x39\x39\x33.service", r"foreign@outpost\x2dbuild.service", "foreign@979.service"):
            self.loaded_instance(name, template, user="root", group="root")
            self.runner.instances[name]["Names"] = json.dumps(name) + " " + json.dumps(alias)
            self.blocked("native identity")
        self.assertFalse(self.runner.effects())

    def test_malformed_missing_duplicate_and_control_bearing_name_vectors_refuse(self) -> None:
        name = "foreign@benign.service"
        template = "/usr/lib/systemd/system/foreign@.service"
        self.write(template, b"[Service]\nUser=root\n")
        for value in ("", '"foreign@benign.service"junk', "'foreign@benign.service'", json.dumps([name]),
                      json.dumps(name) + " " + name, json.dumps("other@benign.service"),
                      '"foreign@benign.service', json.dumps("foreign@bad\nvalue.service"),
                      json.dumps("foreign@bad\u202evalue.service")):
            with self.subTest(value=value):
                self.loaded_instance(name, template, user="root", group="root")
                self.runner.instances[name]["Names"] = value
                self.blocked()
        self.assertFalse(self.runner.effects())

    def test_native_service_names_accept_only_the_single_verified_name_after_decoding(self) -> None:
        self.services(active=True)
        for unit in helper.UNITS[:2]:
            self.runner.states[unit]["Names"] = json.dumps(unit)
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.runner.states[helper.UNITS[0]]["Names"] += " " + json.dumps("unrelated.service")
        self.blocked("unsafe")
        self.assertFalse(self.runner.effects())

    def test_loaded_instances_are_checked_without_any_configured_instance_link(self) -> None:
        self.use_distinct_build_ids()
        user, runtime = self.stock_user_templates()
        for template in (user, runtime):
            for identity in ("993", "979", "outpost-build", "outpost-workspaces"):
                name = self.path(template).name.replace("@.", "@" + identity + ".")
                self.loaded_instance(name, template, user="", group="")
                self.blocked("native identity")
                self.runner.instances.clear()
        # An arbitrary manager-known external template has no filename-based exception either.
        external = "/srv/external/loaded-template"
        self.write(external, b"[Service]\nUser=%i\n")
        self.loaded_instance("external@993.service", external, user="", group="")
        self.blocked("native identity")

    def test_loaded_effective_identities_aliases_and_hidden_dependencies_refuse(self) -> None:
        self.use_distinct_build_ids()
        user, _ = self.stock_user_templates()
        name = "user@1000.service"
        for field, value in (("User", "993"), ("Group", "979"), ("SupplementaryGroups", '65534 "979"'),
                             ("User", "outpost-build"), ("Group", "outpost-workspaces"), ("Names", name + " user@993.service")):
            self.loaded_instance(name, user)
            self.runner.instances[name][field] = value
            self.blocked("native identity")
        self.loaded_instance(name, user)
        dropin = "/srv/external/loaded-only.conf"
        self.write(dropin, b"[Unit]\nPartOf=outpost-native-worker.service\n")
        self.runner.instances[name]["DropInPaths"] = dropin
        self.blocked("referenced")
        self.write(dropin, b"[Service]\nSupplementaryGroups=65534 \\\n979\n")
        self.blocked("numeric identity")

    def test_concrete_unresolvable_instance_identity_and_loaded_fields_refuse(self) -> None:
        self.use_distinct_build_ids()
        user, _ = self.stock_user_templates()
        for identity in (r"\x39\x37\x39", "0979", "path-with-dashes"):
            name = "user@" + identity + ".service"
            path = helper.UNIT_DIR + "/" + name
            self.path(path).symlink_to(user)
            if identity == "path-with-dashes":
                self.assertTrue(self.review()["canReset"])
            else:
                self.blocked("native identity" if identity == r"\x39\x37\x39" else "Unsupported systemd identity syntax")
            self.path(path).unlink()
        name = "user@1000.service"
        for field, value in (("User", "%i"), ("Group", r"\x39\x37\x39"), ("NeedDaemonReload", "yes"),
                             ("SourcePath", "/unverified/generator"), ("FragmentPath", ""), ("Id", "different@1000.service")):
            self.loaded_instance(name, user)
            self.runner.instances[name][field] = value
            self.blocked()
        self.loaded_instance(name, user)
        del self.runner.instances[name]["SupplementaryGroups"]
        self.blocked()
        self.loaded_instance(name, user)
        self.runner.instances[name]["Names"] = name + " user@.service"
        self.blocked("uninstantiated template")

    def test_loaded_inventory_is_bounded_complete_and_snapshot_bound(self) -> None:
        user, _ = self.stock_user_templates()
        for raw in (b"not-json", b"{}", b'[{}]', b'[{"unit":"user@1000.service","unit":"user@993.service","load":"loaded"}]',
                    b'[{"unit":"user@1000.service","load":"not-found"}]',
                    b'[{"unit":"user@1000.service","load":"loaded","description":NaN}]',
                    json.dumps([{"unit": "user@1000.service", "load": "loaded"}] * 2).encode(),
                    b" " * (helper.MAX_METADATA + 1)):
            self.runner.instance_inventory = raw
            self.blocked()
        self.runner.instance_inventory = None
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.loaded_instance("user@1000.service", user)
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertFalse(self.path(helper.RESETS).exists())
        self.assertFalse(self.runner.effects())
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.runner.instances["user@1000.service"]["Group"] = "65534"
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_loaded_only_external_template_is_audited_without_any_disk_unit_context(self) -> None:
        """The manager inventory is mandatory even when UNIT_SEARCH contains no templates."""
        self.use_distinct_build_ids()
        fragment = "/srv/external/manager-only-template"
        self.write(fragment, b"[Service]\nUser=%i\n")
        self.loaded_instance("manager-only@1000.service", fragment)
        with patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertIn(fragment, [call.args[0] for call in reads.call_args_list])
        self.runner.instances.clear()
        self.loaded_instance("manager-only@979.service", fragment, user="", group="")
        self.blocked("native identity")
        self.runner.instances.clear()
        self.loaded_instance("manager-only@1000.service", fragment)
        self.write(fragment, b"[Service]\nSupplementaryGroups=65534 \\\n979\n")
        self.blocked("numeric identity")

    def test_instance_only_dropin_cannot_hide_unresolvable_inherited_identity(self) -> None:
        """An instance can exist via drop-ins alone, with its identity inherited from the template."""
        self.use_distinct_build_ids()
        self.stock_user_templates()
        dropin = helper.UNIT_DIR + "/user@0979.service.d/override.conf"
        self.write(dropin, b"[Service]\nGroup=nobody\n")
        self.blocked("Unsupported systemd identity syntax")

    def test_loaded_and_configured_instance_counts_are_bounded(self) -> None:
        self.stock_user_templates()
        self.runner.instance_inventory = json.dumps([
            {"unit": f"user@{10000 + index}.service", "load": "loaded"} for index in range(helper.MAX_UNIT_INSTANCES + 1)
        ]).encode()
        self.assertLess(len(self.runner.instance_inventory), helper.MAX_METADATA)
        self.blocked("budget")
        self.runner.instance_inventory = None
        for index in range(helper.MAX_UNIT_INSTANCES + 1):
            self.write(helper.UNIT_DIR + f"/user@{10000 + index}.service", b"[Service]\nUser=nobody\n")
        self.blocked("budget")

    def test_loaded_instance_source_changes_and_inventory_races_fail_before_effects(self) -> None:
        user, _ = self.stock_user_templates()
        name = "user@1000.service"
        self.loaded_instance(name, user)
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.path(user).rename(self.path("/retained-user-template"))
        self.write(user, self.path("/retained-user-template").read_bytes())
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertFalse(self.path(helper.RESETS).exists())
        run = self.runner.run
        def changed(argv, *args, **kwargs):
            raw = run(argv, *args, **kwargs)
            if argv[:2] == ["/usr/bin/systemctl", "show"] and argv[-1] == name:
                self.loaded_instance("user@1001.service", user, user="1001", group="1001")
            return raw
        with patch.object(self.runner, "run", side_effect=changed):
            self.blocked("inventory changed")

    def test_cron_scripts_are_not_parsed_as_systemd_identity_directives(self) -> None:
        self.use_distinct_build_ids()
        content = b"#!/bin/sh\nUser=%i\nGroup=979\nSupplementaryGroups='arbitrary shell value'\n"
        direct = "/etc/cron.daily/ordinary"
        linked = "/etc/cron.hourly/ordinary"
        target = "/srv/cron/ordinary"
        self.write(direct, content)
        self.write(target, content)
        self.directory("/etc/cron.hourly")
        self.path(linked).symlink_to(target)
        self.write("/etc/cron.d/ordinary", b"User=%i\n* * * * * root /bin/true\n")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(self.path(direct).read_bytes(), content)
        self.assertEqual(self.path(target).read_bytes(), content)

    def test_cron_literal_native_account_or_scope_use_still_blocks(self) -> None:
        for content in (b"* * * * * outpost-build /bin/true\n", b"#!/bin/sh\ncat /etc/outpost-native/worker.env\n"):
            self.write("/etc/cron.d/foreign", content)
            self.blocked("referenced")

    def dependency_template(self) -> str:
        """Unloaded template with real identity syntax and hooks that must never execute."""
        self.use_distinct_build_ids()
        template = "/usr/lib/systemd/system/foreign-worker@.service"
        self.write(template, b"[Service]\nUser=%i\nExecStart=/srv/never-run-start\nExecStop=/srv/never-run-stop\n")
        return template

    def test_sshd_keygen_generic_ordering_and_install_references_are_preserved(self) -> None:
        """Ubuntu 26 resolves sshd@.service against the plain source prefix sshd-keygen."""
        path = "/usr/lib/systemd/system/sshd-keygen.service"
        template = "/usr/lib/systemd/system/sshd@.service"
        content = (b"[Unit]\nDescription=Generate sshd host keys on first boot\nConditionFirstBoot=yes\n"
                   b"ConditionPathIsReadWrite=/etc/ssh\nConditionPathIsSymbolicLink=!/etc/ssh\n"
                   b"Before=ssh.service sshd.service sshd@.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\n"
                   b"ExecStart=ssh-keygen -A\n\n[Install]\nWantedBy=ssh.service sshd.service sshd@.service ssh.socket\n")
        self.write(path, content)
        self.write(template, b"[Service]\nUser=root\nExecStart=/srv/never-run-ssh\n")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(self.path(path).read_bytes(), content)
        self.assertTrue(self.path(template).is_file())
        self.assertFalse(any("ssh-keygen" in call or "/srv/never-run-ssh" in call for call in self.runner.calls))

    def test_plain_unit_generic_references_remain_audited_not_skipped(self) -> None:
        """A symbolic ordering/install target never exempts concrete references or template identities."""
        template = self.dependency_template()
        path = helper.UNIT_DIR + "/ordinary.service"
        for key in sorted(helper.IMPLICIT_INSTANCE_KEYS):
            with self.subTest(key=key):
                self.write(path, ("[Unit]\n" + key + '=ordinary.target "foreign-worker@.service"\n').encode())
                self.assertTrue(self.review()["canReset"])
                self.write(path, ("[Unit]\n" + key + '=foreign-worker@.service \\\n "foreign-worker@979.service"\n').encode())
                self.blocked("native identity")
                self.write(path, ("[Unit]\n" + key + "=foreign-worker@.service outpost-native-worker.service\n").encode())
                self.blocked("referenced")
        self.write(path, b"[Unit]\nBefore=foreign-worker@.service\n")
        self.write(template, b"[Service]\nUser=993\nExecStart=/srv/never-run\n")
        self.blocked("numeric identity")
        self.write(template, b"[Service]\nUser=%i\n[Install]\nDefaultInstance=979\n")
        self.blocked("native identity")
        self.assertFalse(self.runner.effects())

    def test_plain_unit_unresolved_activation_and_specifiers_remain_blocked(self) -> None:
        """The exception is ordering/install metadata, not guessing an executable service instance."""
        self.dependency_template()
        path = helper.UNIT_DIR + "/ordinary.service"
        for key in ("Service", "Unit", "Sockets", "Alias", "Also"):
            with self.subTest(key=key):
                self.write(path, ("[Unit]\n" + key + "=foreign-worker@.service\n").encode())
                self.blocked("Unsupported systemd activation")
        for key in ("Before", "After", "WantedBy", "RequiredBy", "UpheldBy"):
            self.write(path, ("[Unit]\n" + key + "=foreign-worker@%i.service\n").encode())
            self.blocked("Unsupported systemd activation")

    def test_plain_source_prefix_cannot_hide_native_instance_identity(self) -> None:
        """A bare template dependency from 993.service implicitly selects worker@993.service."""
        self.dependency_template()
        for prefix in ("993", "979", r"\x39\x39\x33", r"outpost\x2dbuild"):
            path = helper.UNIT_DIR + "/" + prefix + ".service"
            for key in sorted(helper.IMPLICIT_INSTANCE_KEYS):
                with self.subTest(prefix=prefix, key=key):
                    self.write(path, ("[Unit]\n" + key + "=foreign-worker@.service\n").encode())
                    self.blocked("native identity")
            self.path(path).unlink()
        self.assertFalse(self.runner.effects())

    def test_plain_source_alias_uses_source_prefix_not_fragment_filename(self) -> None:
        """An external fragment cannot conceal the UID-bearing identity of the source alias."""
        self.dependency_template()
        fragment = "/srv/external/benign-fragment"
        alias = helper.UNIT_DIR + "/993.service"
        self.write(fragment, b"[Unit]\nBefore=foreign-worker@.service\n")
        self.path(alias).symlink_to(fragment)
        self.blocked("native identity")
        self.assertFalse(self.runner.effects())

    def test_generic_reference_change_to_native_instance_refuses_before_cleanup(self) -> None:
        """Symbolic references remain snapshot-bound, and later identities cannot inherit old consent."""
        self.dependency_template()
        path = helper.UNIT_DIR + "/ordinary.service"
        self.write(path, b"[Unit]\nBefore=foreign-worker@.service\n")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.write(path, b"[Unit]\nBefore=foreign-worker@979.service\n")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("native identity", result["message"])
        self.assertFalse(self.runner.effects())
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_unloaded_dependency_only_instance_blocks_before_any_effect(self) -> None:
        template = self.dependency_template()
        target = helper.UNIT_DIR + "/maintenance.target"
        self.write(target, b"[Unit]\nWants=foreign-worker@993.service\n")
        before = self.path(template).read_bytes(), self.path(target).read_bytes()
        self.assertFalse(self.runner.instances)
        self.assertFalse(self.path(helper.UNIT_DIR + "/foreign-worker@993.service").exists())
        review = self.blocked("native identity")
        self.assertIn('path="' + target + '"', review["blockers"][0])
        self.assertEqual(before, (self.path(template).read_bytes(), self.path(target).read_bytes()))
        self.assertFalse(any("foreign-worker@993.service" in call for call in self.runner.calls))

    def test_dependency_and_activation_fields_collect_quoted_continued_and_escaped_instances(self) -> None:
        self.dependency_template()
        path = helper.UNIT_DIR + "/maintenance.target"
        keys = ("Wants", "Requires", "Requisite", "BindsTo", "PartOf", "Upholds", "Conflicts", "Before", "After",
                "OnFailure", "OnSuccess", "PropagatesReloadTo", "ReloadPropagatedFrom", "PropagatesStopTo", "StopPropagatedFrom",
                "JoinsNamespaceOf", "WantedBy", "RequiredBy", "UpheldBy", "Also", "Alias", "Sockets", "Service", "Unit")
        for key in keys:
            with self.subTest(key=key):
                self.write(path, ("[Unit]\n" + key + "=foreign-worker@979.service\n").encode())
                self.blocked("native identity")
        references = ['"foreign-worker@993.service"', "'foreign-worker@979.service'",
                      'ordinary.service "foreign-worker@993.service"', "ordinary.service \\\n # ignored\n ; ignored too\n 'foreign-worker@979.service'",
                      r"foreign-worker@\x39\x39\x33.service", r'"foreign-worker@\x39\x37\x39.service"',
                      r"foreign-worker@outpost\x2dbuild.service", r"foreign-worker@outpost\x2dworkspaces.service"]
        for reference in references:
            with self.subTest(reference=reference):
                self.write(path, ("[Unit]\nWants=" + reference + "\n# private-content-canary\n").encode())
                self.blocked("native identity")

    def test_dependency_references_feed_inherited_identity_audit(self) -> None:
        self.dependency_template()
        self.write(helper.UNIT_DIR + "/maintenance.target", b"[Unit]\nWants=foreign-worker@0979.service\n")
        self.blocked("Unsupported systemd identity syntax")

    def test_dependency_only_transitive_specifiers_cannot_construct_native_identity(self) -> None:
        self.dependency_template()
        self.write(helper.UNIT_DIR + "/relay@.target", b"[Unit]\nWants=foreign-worker@9%i.service\n")
        self.write(helper.UNIT_DIR + "/maintenance.target", b"[Unit]\nWants=relay@93.target\n")
        self.blocked("native identity")

    def test_dependency_specifiers_use_symlink_source_unit_context(self) -> None:
        self.dependency_template()
        external = "/srv/external/reference-template"
        self.write(external, b"[Unit]\nWants=foreign-worker@%p.service\n")
        source = helper.UNIT_DIR + "/993.target"
        self.path(source).symlink_to(external)
        self.blocked("native identity")
        self.path(source).unlink()
        self.write(external, b"[Unit]\nWants=foreign-worker@9%i.service\n")
        self.path(helper.UNIT_DIR + "/relay@93.target").symlink_to(external)
        self.blocked("native identity")

    def test_default_instance_cannot_hide_an_explicit_native_identity(self) -> None:
        template = self.dependency_template()
        for value in ("993", "979", r"\x39\x37\x39", r"outpost\x2dbuild"):
            self.write(template, ("[Service]\nUser=%i\n[Install]\nDefaultInstance=" + value + "\n").encode())
            self.blocked("native identity")

    def test_unknown_activation_syntax_is_refused_not_skipped(self) -> None:
        self.dependency_template()
        path = helper.UNIT_DIR + "/maintenance.target"
        values = ["foreign-worker@%i.service", "foreign-worker@%U.service", "foreign-worker@%I.service", "foreign-worker@%x.service",
                  "foreign-worker@%.service", "foreign-worker@%%i.service", r"foreign-worker@\071\071\063.service",
                  r"foreign-worker@\u0039\u0039\u0033.service", r"foreign-worker@\x3.service", r"foreign-worker@\x00evil.service",
                  r"foreign-worker@\x25i.service", r"foreign-worker@\x5cx39.service", r"foreign-worker\x40993.service",
                  r"ordinary.service\x20foreign-worker@993.service", r"foreign-worker@\x22993\x22.service", '"foreign-worker@1000.service',
                  '"ordinary.service"junk', "'ordinary.service''second.service'", '"ordinary.service second.service"',
                  "foreign-worker@*.service", "foreign-worker@1000", "/srv/foreign.service", "ordinary.service # inline", "ordinary.service;hook"]
        for value in values:
            with self.subTest(value=value):
                self.write(path, ("[Unit]\nWants=" + value + "\n").encode())
                self.blocked()
        for line in ("Wants", "Wants+=ordinary.service", '"Wants"=ordinary.service', "Unit=one.service two.service"):
            self.write(path, ("[Unit]\n" + line + "\n").encode())
            self.blocked("Unsupported systemd activation syntax")
        self.write(helper.UNIT_DIR + "/relay@.service", b"[Unit]\nRequires=foreign-worker@%U.service\n[Service]\nUser=nobody\n")
        self.path(path).unlink()
        self.blocked("Unsupported systemd activation syntax")

    def test_benign_dependency_instances_cycles_and_stock_templates_remain_preserved(self) -> None:
        self.dependency_template()
        self.stock_user_templates()
        self.write(helper.UNIT_DIR + "/relay@.target", b"[Unit]\nWants=foreign-worker@%i.service loop@%i.target\n")
        self.write(helper.UNIT_DIR + "/loop@.target", b"[Unit]\nWants=relay@%i.target\n")
        path = helper.UNIT_DIR + "/maintenance.target"
        self.write(path, b"[Unit]\nWants=\"relay@1000.target\" \\\n # ignored\n 'foreign-worker@1001.service'\n"
                         br"After=dev-disk-by\x2duuid-test.device" + b"\n")
        before = self.path(path).read_bytes()
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.assertEqual(self.apply(review)["state"], "complete")
        self.assertEqual(before, self.path(path).read_bytes())
        self.assertTrue(self.path("/usr/lib/systemd/system/foreign-worker@.service").exists())
        self.assertFalse(any("/srv/never-run" in " ".join(call) or "foreign-worker@1000.service" in call for call in self.runner.calls))

    def test_dependency_collection_and_recursive_instantiation_are_bounded(self) -> None:
        self.dependency_template()
        path = helper.UNIT_DIR + "/maintenance.target"
        self.write(path, b"[Unit]\nWants=first.service second.service third.service\n")
        with patch.object(helper, "MAX_UNIT_REFERENCES", 2):
            self.blocked("budget")
        self.write(helper.UNIT_DIR + "/loop@.target", b"[Unit]\nWants=loop@x%i.target\n")
        self.write(path, b"[Unit]\nWants=loop@safe.target\n")
        with patch.object(helper, "MAX_UNIT_INSTANCES", 4):
            self.blocked("budget")

    def test_changed_dependency_reference_after_review_refuses_before_effects(self) -> None:
        self.dependency_template()
        self.services(active=True)
        path = helper.UNIT_DIR + "/maintenance.target"
        self.write(path, b"[Unit]\nWants=foreign-worker@1000.service\n")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.write(path, b"[Unit]\nWants=foreign-worker@993.service\n")
        result = self.apply(review)
        self.assertEqual(result["state"], "failed")
        self.assertIn("native identity", result["message"])
        self.assertFalse(self.runner.effects())
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_external_link_chain_is_protected_and_each_hop_is_scanned_through(self) -> None:
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        self.path(source).unlink()
        intermediate = "/srv/external/intermediate.service"
        self.path(source).symlink_to(intermediate)
        self.path(intermediate).symlink_to("foreign.service")
        self.assertTrue(self.review()["canReset"])
        self.write(target, b"[Unit]\nRequires=outpost-native-worker.service\n")
        self.blocked("referenced")
        self.write(target, b"[Service]\nUser=nobody\n")
        for path in (source, intermediate, target, "/srv", "/srv/external"):
            for owner in ((self.owner + 10000, os.fstat(self.root_fd).st_gid), (self.owner, os.fstat(self.root_fd).st_gid + 10000)):
                with self.subTest(path=path, owner=owner), self.virtual_owners({path: owner}):
                    review = self.blocked()
                    self.assertIn("path=" + json.dumps(path), review["blockers"][0])
        for path in (target, "/srv", "/srv/external"):
            mode = stat.S_IMODE(self.path(path).stat().st_mode)
            for unsafe in (mode | 0o002, mode | 0o020):
                self.path(path).chmod(unsafe)
                review = self.blocked()
                self.assertIn("path=" + json.dumps(path), review["blockers"][0])
            self.path(path).chmod(mode)

    def test_external_unit_rejects_unverified_symlink_ancestors_even_before_dotdot(self) -> None:
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        self.path("/srv/shortcut").symlink_to("external", target_is_directory=True)
        for text in ("/srv/shortcut/foreign.service", "/srv/shortcut/../external/foreign.service"):
            with self.subTest(text=text):
                self.path(source).unlink()
                self.path(source).symlink_to(text)
                review = self.blocked("ancestor")
                self.assertIn('path="/srv/shortcut"', review["blockers"][0])
        # The same spelling with a real protected directory is resolved safely.
        self.path("/srv/shortcut").unlink()
        self.directory("/srv/shortcut")
        self.assertTrue(self.review()["canReset"])

    def test_external_unit_rejects_fifo_directory_hardlink_missing_and_device_targets(self) -> None:
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        self.path(target).unlink()
        self.blocked("Missing linked unit")
        os.mkfifo(self.path(target), 0o600)
        with patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            self.blocked("regular")
        self.assertNotIn(target, [call.args[0] for call in reads.call_args_list])
        self.path(target).unlink()
        self.directory(target)
        self.blocked("regular")
        self.path(target).rmdir()
        self.write(target, b"[Service]\nUser=nobody\n")
        os.link(self.path(target), self.path("/foreign-alias"))
        self.blocked("singly-linked")
        self.path("/foreign-alias").unlink()
        real_stat = os.stat
        inode = real_stat(self.path(target)).st_ino
        def device(*args, **kwargs):
            info = real_stat(*args, **kwargs)
            if info.st_ino != inode:
                return info
            fields = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
            fields.update(st_mode=stat.S_IFCHR | 0o644, st_rdev=os.makedev(1, 5))
            return SimpleNamespace(**fields)
        with patch.object(helper.os, "stat", side_effect=device), patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            self.blocked("regular")
        self.assertNotIn(target, [call.args[0] for call in reads.call_args_list])

    def test_external_link_cycle_hop_path_and_file_size_budgets(self) -> None:
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        self.path(target).unlink()
        self.path(target).symlink_to(source)
        self.blocked("Cyclic")
        self.path(target).unlink()
        for index in range(16):
            path = target if index == 0 else f"/srv/external/hop-{index}.service"
            self.path(path).symlink_to(f"hop-{index + 1}.service")
        self.write("/srv/external/hop-16.service", b"[Service]\nUser=nobody\n")
        self.blocked("Too many")
        self.path(source).unlink()
        self.path(source).symlink_to("/srv/external/hop-16.service")
        self.assertTrue(self.review()["canReset"])
        with patch.object(helper.os, "readlink", return_value="/" + "a" * 4096):
            self.blocked("path budget")
        last = "/srv/external/hop-16.service"
        self.write(last, b"#" + b"x" * (helper.MAX_METADATA - 1))
        self.assertTrue(self.review()["canReset"])
        self.write(last, b"#" + b"x" * helper.MAX_METADATA)
        self.blocked("size budget")

    def test_external_declaration_change_after_review_refuses_before_effects(self) -> None:
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        self.services(active=True)
        for change in ("contents", "file-inode", "link-inode", "link-text", "ancestor-inode"):
            with self.subTest(change=change):
                review = self.review()
                self.assertTrue(review["canReset"], review["blockers"])
                if change == "contents":
                    self.write(target, b"[Service]\nUser=nobody\n# changed\n")
                elif change == "file-inode":
                    saved = self.path(target).read_bytes()
                    self.path(target).rename(self.path("/retained-declaration"))
                    self.write(target, saved)
                elif change == "link-inode":
                    self.path(source).rename(self.path("/retained-link"))
                    self.path(source).symlink_to(target)
                elif change == "link-text":
                    self.path(source).unlink()
                    self.path(source).symlink_to("/srv/external/./foreign.service")
                else:
                    self.path("/srv/external").rename(self.path("/srv/previous"))
                    self.directory("/srv/external")
                    self.path("/srv/previous/foreign.service").rename(self.path(target))
                result = self.apply(review)
                self.assertEqual(result["state"], "failed")
                self.assertIn("snapshot", result["message"].lower())
                self.assertFalse(self.runner.effects())
                self.assertFalse(self.path(helper.RESETS).exists())
                self.assertTrue(self.path(self.release).exists())

    def test_external_link_cannot_claim_native_scope_or_hide_an_indirect_native_alias(self) -> None:
        source = self.external_unit()
        native = self.release + "/external.service"
        self.write(native, b"[Service]\nUser=nobody\n")
        self.path(source).unlink()
        self.path(source).symlink_to(native)
        self.blocked("native cleanup scope")
        # A path that would become dangling after deletion is unsafe even if '..' exits that scope.
        self.write("/opt/external.service", b"[Service]\nUser=nobody\n")
        self.path(source).unlink()
        self.path(source).symlink_to(helper.ROOTS[0] + "/../external.service")
        self.blocked("native cleanup scope")
        self.services(active=True)
        self.path(source).unlink()
        self.path(source).symlink_to("/srv/external/indirect.service")
        self.path("/srv/external/indirect.service").symlink_to(helper.UNIT_DIR + "/" + helper.UNITS[0])
        self.blocked("unexpected alias")

    def test_linked_unit_mask_is_explicit_verified_dev_null_and_never_read(self) -> None:
        self.write("/dev/null", b"", 0o666)
        source = helper.UNIT_DIR + "/masked.service"
        self.path(source).symlink_to("/dev/null")
        self.blocked("mask")
        real_stat = os.stat
        inode = real_stat(self.path("/dev/null")).st_ino
        def null_device(*args, **kwargs):
            info = real_stat(*args, **kwargs)
            if info.st_ino != inode:
                return info
            fields = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
            fields.update(st_mode=stat.S_IFCHR | 0o666, st_rdev=os.makedev(1, 3))
            return SimpleNamespace(**fields)
        # A fake device cannot pass the separate descriptor ACL audit on macOS.
        # Exercise the real configuration resolver without weakening that audit.
        with patch.object(helper.os, "stat", side_effect=null_device), patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            evidence = self.agent.other_account_use({row["name"]: row for row in self.accounts.users},
                                                    {row["name"]: row for row in self.accounts.groups}, self.install_request)
        self.assertEqual(evidence["linkedDeclarations"]["/dev/null"]["device"], os.makedev(1, 3))
        self.assertNotIn("/dev/null", [call.args[0] for call in reads.call_args_list])
        self.path("/dev/null").unlink()
        self.path("/dev/null").symlink_to("/srv/unverified-null")
        self.blocked("mask")

    def test_controlled_usrmerge_alias_is_bound_but_other_directory_links_are_refused(self) -> None:
        target = "/usr/lib/systemd/system/foreign-target.service"
        source = self.external_unit(target)
        self.path("/lib").symlink_to("usr/lib", target_is_directory=True)
        self.path(source).unlink()
        self.path(source).symlink_to("/lib/systemd/system/foreign-target.service")
        review = self.review()
        self.assertTrue(review["canReset"], review["blockers"])
        self.path("/lib").rename(self.path("/previous-lib"))
        self.path("/lib").symlink_to("usr/lib", target_is_directory=True)
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertFalse(self.path(helper.RESETS).exists())
        self.path("/lib").unlink()
        self.path("/lib").symlink_to("/unverified/lib", target_is_directory=True)
        self.blocked("search directory")

    def test_external_link_replacement_during_target_read_is_refused(self) -> None:
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        read = self.fs.read
        def replaced(path, *args, **kwargs):
            raw = read(path, *args, **kwargs)
            if path == target:
                self.path(source).rename(self.path("/retained-link-during-read"))
                self.path(source).symlink_to(target)
            return raw
        with patch.object(self.fs, "read", side_effect=replaced):
            review = self.blocked("changed during review")
        self.assertIn("path=" + json.dumps(source), review["blockers"][0])

    def test_external_link_replacement_during_readlink_is_refused(self) -> None:
        target = "/srv/external/foreign.service"
        source = self.external_unit(target)
        readlink = os.readlink
        count = 0
        def replaced(name, *args, **kwargs):
            nonlocal count
            text = readlink(name, *args, **kwargs)
            if name == "foreign.service":
                count += 1
                # units() reads once; replace during linked()'s descriptor-anchored read.
                if count == 2:
                    self.path(source).rename(self.path("/retained-link-during-readlink"))
                    self.path(source).symlink_to(target)
            return text
        with patch.object(helper.os, "readlink", side_effect=replaced):
            review = self.blocked("changed during review")
        self.assertIn("path=" + json.dumps(source), review["blockers"][0])

    def test_external_ancestor_swap_to_symlink_before_open_is_not_followed(self) -> None:
        target = "/srv/external/foreign.service"
        self.external_unit(target)
        opened = os.open
        swapped = False
        def raced(name, flags, *args, **kwargs):
            nonlocal swapped
            if name == "external" and flags == helper.TRAVERSE_FLAGS and not swapped:
                swapped = True
                self.path("/srv/external").rename(self.path("/srv/held"))
                self.path("/srv/external").symlink_to("held", target_is_directory=True)
            return opened(name, flags, *args, **kwargs)
        with patch.object(helper.os, "open", side_effect=raced), patch.object(self.fs, "read", wraps=self.fs.read) as reads:
            review = self.blocked("ancestor")
        self.assertIn('path="/srv/external"', review["blockers"][0])
        self.assertNotIn(target, [call.args[0] for call in reads.call_args_list])

    def test_linked_unit_refusals_escape_path_metadata_without_file_contents(self) -> None:
        target = '/srv/external/bad\n\r\x1b[31m\u202e"\\.service'
        self.external_unit(target, b"private-declaration-canary")
        self.path(target).chmod(0o666)
        review = self.blocked("Unsafe linked unit")
        self.assert_path_refusal(review["blockers"][0], "Unsafe linked unit declaration ownership or permissions.", target, self.path(target).stat())

    def test_effective_reverse_stop_dependencies_must_remain_inside_owned_units(self) -> None:
        """Loaded transient/runtime dependencies cannot hide behind clean disk files."""
        self.services(active=True)
        for prop in ("ConsistsOf", "BoundBy", "PropagatesStopTo", "RequiredBy", "RequisiteOf"):
            with self.subTest(property=prop):
                self.runner.states[helper.UNITS[0]][prop] = "foreign.service"
                self.blocked("stop")
                self.runner.states[helper.UNITS[0]][prop] = ""

    def test_reverse_stop_dependency_change_after_review_prevents_stop(self) -> None:
        """A cached safe review cannot authorize a newly attached foreign service."""
        self.services(active=True)
        review = self.review()
        self.runner.states[helper.UNITS[0]]["ConsistsOf"] = "foreign.service"
        self.assertEqual(self.apply(review)["state"], "failed")
        self.assertEqual(self.runner.effects(), [])

    def test_owned_coordinator_reverse_dependency_is_supported(self) -> None:
        """The installer's own Requires edge is not mistaken for foreign use."""
        self.services(active=True)
        self.runner.states[helper.UNITS[0]]["RequiredBy"] = helper.UNITS[1]
        self.assertEqual(self.apply()["state"], "complete")

    def budget_state(self) -> tuple[int, int, str]:
        """Capture the complete scoped traversal state, not just its node count."""
        return self.fs.nodes, self.fs.node_limit, self.fs.phase_name

    def assert_budget_message(self, message: str, phase: str, count: int, limit: int) -> None:
        """The public refusal identifies only a fixed phase and numerical accounting."""
        self.assertEqual(message, "Filesystem inventory exceeds its budget; manual review required. "
                                 f"phase={phase} count={count} limit={limit}")
        self.assertLessEqual(len(message.encode("utf-8")), 1000)
        self.assertTrue(all(32 <= ord(char) < 127 for char in message))

    def test_external_identity_scan_allows_between_old_and_new_caps_without_files(self) -> None:
        """Simulate 750k visits in pre/post scans; no large fixture or host traversal is needed."""
        visited = 750_000
        observed = []
        def scan(*_args):
            for _ in range(visited):
                self.fs.tick()
            observed.append(self.budget_state())
        for reserve in (0, helper.RESET_RECEIPT_NODE_RESERVE):
            with self.subTest(reserve=reserve), patch.object(self.fs, "_outside_ownership", side_effect=scan):
                self.fs.outside_ownership({901}, {904}, [], reserve_nodes=reserve)
        self.assertEqual(helper.MAX_NODES, 500_000)
        self.assertEqual(helper.MAX_EXTERNAL_NODES, 2_000_000)
        self.assertEqual(observed, [(visited, 2_000_000, "external-identity-post"),
                                    (visited + 4, 2_000_000, "external-identity-pre")])
        self.assertEqual(self.budget_state(), (0, 500_000, "local"))
        self.assertFalse(self.runner.calls)
        self.assertFalse(self.path(helper.RESETS).exists())

    def test_native_inventory_still_refuses_at_500001_without_large_files(self) -> None:
        def inventory(*_args):
            for _ in range(750_000):
                self.fs.tick()
        self.fs.nodes = 17
        before = self.budget_state()
        with patch.object(self.fs, "_inventory", side_effect=inventory), self.assertRaises(helper.Refused) as raised:
            self.fs.inventory(helper.ROOTS[0], lambda *_args: None)
        self.assert_budget_message(str(raised.exception), "native-inventory", 500_001, 500_000)
        self.assertEqual(self.budget_state(), before)
        self.assertTrue(self.path(helper.ROOTS[0]).exists())

    def test_native_configuration_and_deletion_wrappers_never_inherit_external_cap(self) -> None:
        """Each real wrapper selects its local cap, even inside a larger external scope."""
        def exhausted(*_args):
            self.assertEqual(self.fs.node_limit, 500_000)
            self.fs.nodes = 500_000
            self.fs.tick()
        cases = ((self.fs, "_inventory", "native-inventory", lambda: self.fs.inventory(helper.ROOTS[0], lambda *_args: None)),
                 (self.fs, "_remove_tree", "native-deletion", lambda: self.fs.remove_tree(helper.ROOTS[0], lambda *_args: None)),
                 (self.agent, "_units", "unit-configuration", lambda: self.agent.units(self.install_request)),
                 (self.agent, "_other_account_use", "account-configuration", lambda: self.agent.other_account_use({}, {}, self.install_request)),
                 (self.agent, "_inspect", "inspection", lambda: self.agent.inspect(self.request)))
        with self.fs.phase("external-identity-post"):
            self.fs.nodes = 750_000
            outer = self.budget_state()
            for owner, method, label, invoke in cases:
                with self.subTest(phase=label), patch.object(owner, method, side_effect=exhausted):
                    with self.assertRaises(helper.Refused) as raised:
                        invoke()
                    self.assert_budget_message(str(raised.exception), label, 500_001, 500_000)
                    self.assertEqual(self.budget_state(), outer)
        self.assertEqual(self.budget_state(), (0, 500_000, "local"))
        self.assertTrue(all(self.path(root).exists() for root in helper.ROOTS))
        self.assertFalse(self.runner.effects())

    def test_nested_phase_state_restores_after_normal_exit_deadline_and_io_error(self) -> None:
        self.fs.nodes = 23
        initial = self.budget_state()
        for error in (None, helper.Deadline(), OSError("private-error-canary")):
            with self.subTest(error=type(error).__name__):
                with self.fs.phase("account-configuration"):
                    self.fs.tick()
                    outer = self.budget_state()
                    try:
                        with self.fs.phase("external-identity-pre"):
                            self.assertEqual(self.budget_state(), (0, 2_000_000, "external-identity-pre"))
                            self.fs.tick()
                            external = self.budget_state()
                            with self.fs.phase("native-inventory"):
                                self.assertEqual(self.budget_state(), (0, 500_000, "native-inventory"))
                                self.fs.tick()
                            self.assertEqual(self.budget_state(), external)
                            if error is not None:
                                raise error
                    except (helper.Deadline, OSError) as raised:
                        self.assertIs(raised, error)
                    self.assertEqual(self.budget_state(), outer)
                self.assertEqual(self.budget_state(), initial)

    def test_external_reserve_and_postscan_boundaries_cannot_overflow(self) -> None:
        self.fs.nodes = 31
        before = self.budget_state()
        with patch.object(helper, "MAX_EXTERNAL_NODES", 4):
            with patch.object(self.fs, "_outside_ownership") as scan:
                self.fs.outside_ownership({901}, {904}, [], reserve_nodes=4)
                scan.assert_called_once()
            with patch.object(self.fs, "_outside_ownership", side_effect=lambda *_args: self.fs.tick()):
                with self.assertRaises(helper.Refused) as raised:
                    self.fs.outside_ownership({901}, {904}, [], reserve_nodes=4)
                self.assert_budget_message(str(raised.exception), "external-identity-pre", 5, 4)
            with patch.object(self.fs, "_outside_ownership") as scan:
                with self.assertRaises(helper.Refused) as raised:
                    self.fs.outside_ownership({901}, {904}, [], reserve_nodes=5)
                self.assert_budget_message(str(raised.exception), "external-identity-pre", 5, 4)
                scan.assert_not_called()
            def post(*_args):
                self.assertEqual(self.budget_state(), (0, 4, "external-identity-post"))
                for _ in range(4):
                    self.fs.tick()
                self.assertEqual(self.fs.nodes, 4)
                self.fs.tick()
            with patch.object(self.fs, "_outside_ownership", side_effect=post), self.assertRaises(helper.Refused) as raised:
                self.fs.outside_ownership({901}, {904}, [])
            self.assert_budget_message(str(raised.exception), "external-identity-post", 5, 4)
        self.assertEqual(self.budget_state(), before)
        for reserve in (-1, True, 1.0, "4"):
            with self.subTest(reserve=reserve), patch.object(self.fs, "_outside_ownership") as scan:
                self.assertRaises(helper.Refused, self.fs.outside_ownership, {901}, {904}, [], reserve_nodes=reserve)
                scan.assert_not_called()
                self.assertEqual(self.budget_state(), before)

    def test_phase_labels_are_fixed_and_do_not_disclose_untrusted_text(self) -> None:
        initial = self.budget_state()
        phase = Mock(wraps=self.fs.phase)
        for label in ("external-anything", "native-inventory\nprivate-label-canary", "/host/private-canary", None):
            with self.subTest(label=label), self.assertRaises(helper.Refused) as raised, phase(label):
                self.fail("Invalid phase entered")
            self.assertEqual(str(raised.exception), "Invalid filesystem inventory phase.")
            phase.assert_called_with(label)
            self.assertEqual(self.budget_state(), initial)

    def test_wire_cannot_supply_budget_phase_or_force_override(self) -> None:
        for field, value in (("budget", 2_000_000), ("maxExternalNodes", 2_000_000), ("phase", "external-identity-post"), ("force", True)):
            with self.subTest(field=field), self.assertRaisesRegex(helper.Refused, "request fields"):
                self.agent.handle({**self.request, field: value})
        self.assertFalse(self.runner.calls)

    def test_request_dispatch_has_local_cap_and_restores_outer_scope(self) -> None:
        def status(_request):
            self.assertEqual(self.budget_state(), (0, 500_000, "local"))
            self.fs.tick()
            raise helper.Deadline()
        with self.fs.phase("external-identity-post"):
            self.fs.nodes = 800_000
            before = self.budget_state()
            with patch.object(self.agent, "status", side_effect=status), self.assertRaises(helper.Deadline):
                self.agent.handle({**self.request, "mode": "status"})
            self.assertEqual(self.budget_state(), before)

    def test_exact_external_inventory_limit_refuses_before_intent_or_deletion(self) -> None:
        """Three excluded native roots become four receipt entries: the old postscan grew by one."""
        for index in range(128):
            self.write(f"/external-budget/file-{index}", b"unrelated")
        cached = self.review()
        self.assertTrue(cached["canReset"], cached)
        self.assertEqual(cached["services"], [])
        self.assertFalse(self.path(helper.RESETS).exists())
        before = self.external_inventory_nodes()
        with patch.object(helper, "MAX_EXTERNAL_NODES", before):
            review = self.review()
            # A previously approved review must also be refused during apply's
            # pre-intent revalidation, not turn into a post-deletion recovery hold.
            result = self.apply(cached)
        self.assertTrue(all(self.path(root).is_dir() for root in helper.ROOTS), result)
        self.assertFalse(self.path(helper.RESETS).exists(), result)
        self.assertEqual(self.runner.effects(), [])
        self.assertFalse(review["canReset"], review)
        self.assertIn("budget", " ".join(review["blockers"]))
        self.assertEqual(result["state"], "failed")
        self.assertIn("budget", result["message"])
        self.assert_budget_message(review["blockers"][0], "external-identity-pre", before + 1, before)
        self.assert_budget_message(result["message"], "external-identity-pre", before + 1, before)

    def test_exact_receipt_reserve_completes_with_full_postscan_budget(self) -> None:
        """The reserve is consumed only before intent, not charged again after deletion."""
        for index in range(128):
            self.write(f"/external-budget/file-{index}", b"unrelated")
        before = self.external_inventory_nodes()
        self.assertEqual(helper.RESET_RECEIPT_NODE_RESERVE, 4)
        scans = []
        outside = self.fs._outside_ownership
        def scan(*args):
            initial = self.budget_state()
            outside(*args)
            scans.append((initial, self.fs.nodes))
        with (patch.object(helper, "MAX_EXTERNAL_NODES", before + helper.RESET_RECEIPT_NODE_RESERVE),
              patch.object(self.fs, "_outside_ownership", side_effect=scan)):
            review = self.review()
            self.assertTrue(review["canReset"], review)
            result = self.apply(review)
        self.assertEqual(result["state"], "complete", result)
        limit = before + helper.RESET_RECEIPT_NODE_RESERVE
        self.assertEqual([initial for initial, _ in scans], [(4, limit, "external-identity-pre"),
                                                            (4, limit, "external-identity-pre"),
                                                            (0, limit, "external-identity-post")])
        self.assertTrue(all(count <= limit for _, count in scans))
        self.assertTrue(all(not self.path(root).exists() for root in helper.ROOTS))
        self.assertEqual(self.path("/external-budget/file-127").read_bytes(), b"unrelated")

    def test_receipt_reserve_covers_all_four_entries_without_native_root_credit(self) -> None:
        """Even with native files already absent, four reserved entries suffice exactly."""
        for root in helper.ROOTS:
            self.fs.remove_tree(root, self.agent.owner_check(self.install_request, {}, {}))
        for index in range(128):
            self.write(f"/external-budget/file-{index}", b"unrelated")
        cached = self.review()
        self.assertTrue(cached["canReset"], cached)
        before = self.external_inventory_nodes()
        identities = self.accounts.snapshot()
        with patch.object(helper, "MAX_EXTERNAL_NODES", before + helper.RESET_RECEIPT_NODE_RESERVE - 1):
            review = self.review()
            refused = self.apply(cached)
        self.assertFalse(review["canReset"], review)
        self.assertEqual(refused["state"], "failed")
        limit = before + helper.RESET_RECEIPT_NODE_RESERVE - 1
        self.assert_budget_message(review["blockers"][0], "external-identity-pre", limit + 1, limit)
        self.assert_budget_message(refused["message"], "external-identity-pre", limit + 1, limit)
        self.assertFalse(self.path(helper.RESETS).exists(), refused)
        self.assertEqual(self.accounts.snapshot(), identities)
        self.assertEqual(self.runner.effects(), [])
        with patch.object(helper, "MAX_EXTERNAL_NODES", before + helper.RESET_RECEIPT_NODE_RESERVE):
            result = self.apply()
        self.assertEqual(result["state"], "complete", result)

    def test_unchanged_near_limit_review_and_apply_use_independent_phase_budgets(self) -> None:
        """Scale the external allowance to fixtures; repeated scans must not share a counter."""
        for index in range(320):
            self.write(f"/external-inventory/file-{index}", b"unrelated")
        with patch.object(helper, "MAX_EXTERNAL_NODES", 600):
            review = self.review()
            self.assertTrue(review["canReset"], review)
            result = self.apply(review)
        self.assertEqual(result["state"], "complete", result)
        self.assertTrue(self.path("/external-inventory/file-319").exists())

    def test_external_access_and_default_acl_references_block_reset(self) -> None:
        """Root-owned external data can still grant these dedicated identities access."""
        path = "/external-acl/data"
        self.write(path, b"keep outside data")
        inode = self.path(path).stat().st_ino
        for position, tag, identity in ((0, 2, 901), (0, 8, 904), (1, 2, 901), (1, 8, 904)):
            raw = acl_bytes((tag, 0, identity))
            attributes = (raw, None) if position == 0 else (None, raw)
            def read(descriptor: int, values: tuple[bytes | None, bytes | None] = attributes) -> tuple[bytes | None, bytes | None]:
                return values if os.fstat(descriptor).st_ino == inode else (None, None)
            self.fs.acl_reader = read
            self.blocked("ACL")
            self.assertEqual(self.path(path).read_bytes(), b"keep outside data")

    def test_unavailable_external_acl_audit_refuses_before_intent(self) -> None:
        """EACCES/unsupported audits are not interpreted as no ACL references."""
        for number in (errno.EACCES, errno.ENOTSUP, errno.EIO):
            self.fs.acl_reader = Mock(side_effect=OSError(number, "private ACL canary"))
            self.blocked("ACL")

    def test_known_acl_non_support_does_not_skip_ownership_process_or_mount_audits(self) -> None:
        """Known filesystem entries are still traversed; only the ACL absence is normalized."""
        self.write("/dev/shm/retained", b"external data")
        target = self.path("/dev/shm/retained").stat()
        original_stat = os.stat
        def foreign_owner(*args, **kwargs):
            info = original_stat(*args, **kwargs)
            if (info.st_dev, info.st_ino) == (target.st_dev, target.st_ino):
                return SimpleNamespace(st_uid=901, st_gid=info.st_gid, st_mode=info.st_mode)
            return info
        self.fs.acl_reader = helper.linux_acls
        for filesystem in ("tmpfs", "squashfs", "vfat", "nsfs"):
            with (self.subTest(filesystem=filesystem), patch.object(helper.sys, "platform", "linux"),
                  patch.object(helper.os, "getxattr", side_effect=OSError(errno.EOPNOTSUPP, "unsupported"), create=True),
                  patch.object(helper, "linux_descriptor_filesystem", return_value=filesystem)):
                self.assertTrue(self.review()["canReset"])
                with patch.object(helper.os, "stat", side_effect=foreign_owner):
                    self.blocked("outside this installation")
                self.accounts.foreign_process = True
                self.blocked("processes outside")
                self.accounts.foreign_process = False
                self.mounts.add(self.release + "/node_modules")
                self.blocked("Mounted")
                self.mounts.discard(self.release + "/node_modules")
        self.assertEqual(self.path("/dev/shm/retained").read_bytes(), b"external data")

    def test_internal_linked_declaration_is_authenticated_instead_of_skipped(self) -> None:
        """A root-owned internal alias is allowed only after checking its actual declaration."""
        self.services()
        target = "/usr/lib/systemd/system/foreign.service"
        self.write(target, b"[Service]\nUser=outpost-coord\nExecStart=/bin/true\n")
        self.path(helper.UNIT_DIR + "/foreign.service").symlink_to(target)
        self.blocked("referenced")
        self.write(target, b"[Service]\nUser=nobody\nExecStart=/bin/true\n")
        self.assertTrue(self.review()["canReset"])

    def test_crash_after_delete_before_complete_receipt_fences_new_installer(self) -> None:
        """Exercise the real helper receipt and installer gate together on temporary files."""
        class Crash(BaseException):
            """Model process loss without allowing the helper's failure-publication handler."""
        publish = self.agent.publish
        def crash(request, state):
            if state == "complete":
                raise Crash()
            publish(request, state)
        with patch.object(self.agent, "publish", side_effect=crash), self.assertRaises(Crash):
            self.apply()
        self.assertTrue(all(not self.path(root).exists() for root in helper.ROOTS))
        self.assertEqual(self.response({**self.request, "mode": "status"})["state"], "unknown")
        source = Path(__file__).resolve().parents[3] / "deploy/environment/host_install.py"
        spec = importlib.util.spec_from_file_location("reset_fence_installer_fixture", source)
        if spec is None or spec.loader is None:
            self.fail("Could not load the trusted repository installer")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        fresh = {**self.install_request, "operationId": str(uuid.uuid4()), "environmentId": str(uuid.uuid4())}
        operation = helper.OPERATIONS + "/" + fresh["operationId"]
        self.write(operation + "/request.json", helper.encoded(fresh), 0o600)
        self.write(operation + "/status.json", helper.encoded({**self.progress, **{key: fresh[key] for key in helper.IDENTITIES},
                                                              "state": "queued", "completedSteps": 0}))
        with (patch.object(installer, "OPERATIONS", self.path(helper.OPERATIONS)),
              patch.object(installer, "PREFIX", self.path(helper.ROOTS[0]))):
            fresh_installer = installer.Installer(self.path(operation))
            with patch.object(fresh_installer, "preflight", side_effect=AssertionError("reset fence bypassed")) as preflight:
                fresh_installer.execute()
        preflight.assert_not_called()
        self.assertEqual(fresh_installer.status["state"], "failed")
        self.assertEqual(fresh_installer.status["completedSteps"], 0)
        self.assertIn("Reset recovery hold", fresh_installer.status["error"])

    def test_repository_installer_unit_template_parity(self) -> None:
        """Compare trusted repository declarations; no installed copy or command runs."""
        source = Path(__file__).resolve().parents[3] / "deploy/environment/host_install.py"
        spec = importlib.util.spec_from_file_location("repository_installer_fixture", source)
        if spec is None or spec.loader is None:
            self.fail("Repository installer could not be loaded for parity testing")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        for full in (False, True):
            output = self.root / ("parity-full" if full else "parity-basic")
            output.mkdir()
            instance = SimpleNamespace(request={"fullControl": full}, release=Path(self.release), node=Path(self.release + "/node/bin/node"),
                                       units=helper.UNITS if full else helper.UNITS[:2], run=lambda *_args, **_kwargs: None)
            with patch.object(installer, "UNIT_DIRECTORY", output):
                installer.Installer.services(instance)
            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, helper.unit_texts(self.expected["releaseId"], full))


class CgroupTests(unittest.TestCase):
    """Kernel provenance parsing is bounded and cannot be selected on the wire."""

    def test_exact_unified_and_legacy_systemd_login_scopes(self) -> None:
        for raw, scope in ((b"0::/user.slice/user-1000.slice/session-123.scope\n", "session-123.scope"),
                           (b"7:cpu,cpuacct:/\n1:name=systemd:/user.slice/user-0.slice/session-c42.scope\n", "session-c42.scope")):
            self.assertEqual(helper.login_scope_from_cgroup(raw), scope)

    def test_unsupported_ambiguous_or_oversized_evidence_is_not_normalized(self) -> None:
        for raw in (b"", b"0::/system.slice/ssh.service\n", b"0::/session-123.scope\n",
                    b"0::/user.slice/user-1000.slice/session-123.scope/child\n",
                    b"0::/user.slice/user-1000.slice/../session-123.scope\n",
                    b"0::/user.slice/user-1000.slice/session-123.scope\n0::/\n",
                    b"0::/user.slice/user-1000.slice/session-123.scope\n1:name=systemd:/other\n",
                    b"0::/user.slice/user-1000.slice/session-123.scope\x00\n",
                    b"0::/user.slice/user-1000.slice/session-123.scope\r\n",
                    b"malformed\n", b"x" * (helper.MAX_CGROUP + 1), b"1:cpu:/\n" * 129):
            with self.subTest(raw=raw[:100]):
                self.assertIsNone(helper.login_scope_from_cgroup(raw))

    def test_reader_requires_descriptor_verified_proc_and_bounded_read(self) -> None:
        info = SimpleNamespace(st_dev=9, st_ino=11, st_mode=stat.S_IFREG | 0o444, st_uid=0, st_gid=0,
                               st_nlink=1, st_size=0, st_mtime_ns=0, st_ctime_ns=0)
        raw = b"0::/user.slice/user-1000.slice/session-123.scope\n"
        with (patch.object(helper.os, "open", return_value=42) as opened,
              patch.object(helper.os, "fstat", return_value=info), patch.object(helper.os, "close") as closed,
              patch.object(helper, "linux_descriptor_filesystem", return_value="proc") as filesystem,
              patch.object(helper.os, "read", side_effect=[raw, b""]) as read):
            self.assertEqual(helper.linux_login_scope(), "session-123.scope")
            opened.assert_called_once_with("/proc/self/cgroup", helper.READ_FLAGS)
            filesystem.assert_called_once_with(42)
            self.assertEqual(read.call_args_list[0].args, (42, helper.MAX_CGROUP + 1))
            closed.assert_called_once_with(42)
        with (patch.object(helper.os, "open", return_value=42), patch.object(helper.os, "fstat", return_value=info),
              patch.object(helper.os, "close"), patch.object(helper, "linux_descriptor_filesystem", return_value="tmpfs"),
              patch.object(helper.os, "read") as read):
            self.assertIsNone(helper.linux_login_scope())
            read.assert_not_called()
        with patch.object(helper.os, "open", side_effect=FileNotFoundError()):
            self.assertIsNone(helper.linux_login_scope())


class SystemdSyntaxTests(unittest.TestCase):
    """Pure parser regressions independent of filesystem or native account fixtures."""

    def test_comment_blocks_skip_but_blank_lines_finish_continuations(self) -> None:
        slash = chr(92)
        first = "SupplementaryGroups=65534 " + slash
        third = "Description=ordinary " + slash
        text = "\n".join(["[Service]", first, "# comment " + slash, " \t; comment", "    979", third, "", "User=993", ""])
        self.assertEqual(helper.systemd_logical_lines(text),
                         ["[Service]", first[:-1] + " " + "    979", third[:-1] + " ", "User=993"])
        self.assertEqual(helper.systemd_logical_lines(third + "\n \t\nGroup=979\n"), [third[:-1] + "  \t", "Group=979"])
        self.assertEqual(helper.systemd_logical_lines("# comment " + slash + "\nUser=nobody\n"), ["User=nobody"])

    def test_trailing_backslash_parity_and_whitespace_are_not_guessed(self) -> None:
        for count in (1, 2, 3, 4):
            with self.subTest(count=count):
                first = "Description=value " + chr(92) * count
                expected = [first[:-1] + " User=993"] if count % 2 else [first, "User=993"]
                self.assertEqual(helper.systemd_logical_lines(first + "\nUser=993\n"), expected)
        first = "Description=value " + chr(92) + " \t"
        self.assertEqual(helper.systemd_logical_lines(first + "\nGroup=979\n"), [first, "Group=979"])

    def test_crlf_bom_and_incomplete_input_have_explicit_policy(self) -> None:
        self.assertEqual(helper.systemd_logical_lines("\ufeff[Service]\r\nUser=nobody\r\n"), ["[Service]", "User=nobody"])
        for ending in ("", "\n", "\n# comment\n", "\n ; comment\n"):
            with self.subTest(ending=ending), self.assertRaisesRegex(helper.Refused, "Incomplete"):
                helper.systemd_logical_lines("Group=65534 " + chr(92) + ending)
        for text in ("User=nobody\0Group=979", "Description=x\vUser=993", "Description=x\rGroup=979", "[Service]\n\ufeffGroup=979"):
            with self.subTest(text=text), self.assertRaisesRegex(helper.Refused, "Unsupported"):
                helper.systemd_logical_lines(text)

    def test_identity_grammar_only_accepts_unambiguous_whole_items(self) -> None:
        self.assertEqual(helper.systemd_identity_values('  "65534" \'65533\' nogroup\t', single=False), ["65534", "65533", "nogroup"])
        self.assertEqual(helper.systemd_identity_values("root", single=True), ["root"])
        self.assertEqual(helper.systemd_identity_values("'993'", single=True), ["993"])
        self.assertEqual(helper.systemd_identity_values("", single=True), [])
        self.assertEqual(helper.systemd_identity_values("0 4294967294 _apt systemd-network", single=False), ["0", "4294967294", "_apt", "systemd-network"])
        for value in ('"65534 65533"', "65534 65533", '"65534"junk', "'65534''65533'", r"\x39\x37\x39", "%G", "65534\u00a065533"):
            with self.subTest(value=value), self.assertRaisesRegex(helper.Refused, "Unsupported systemd identity syntax"):
                helper.systemd_identity_values(value, single=True)


    def test_activation_words_keep_unit_escapes_and_whole_item_quotes(self) -> None:
        raw = r'''"ordinary.service" 'foreign-worker@\x39\x39\x33.service' '''
        self.assertEqual(helper.systemd_activation_words(raw, single=False), ["ordinary.service", r"foreign-worker@\x39\x39\x33.service"])
        self.assertTrue(helper.systemd_unit_name(r"dev-disk-by\x2duuid-test.device"))
        for value in (r"worker@\071.service", r"worker\x40993.service", '"one.service two.service"', '"one.service"suffix'):
            with self.subTest(value=value), self.assertRaises(helper.Refused):
                helper.systemd_activation_words(value, single=False)
        with self.assertRaises(helper.Refused):
            helper.systemd_activation_words("one.service two.service", single=True)

    def test_activation_specifiers_use_source_context_without_guessing_environment(self) -> None:
        self.assertEqual(helper.systemd_activation_value("worker@9%i.service", "relay@93.target"), "worker@993.service")
        self.assertIsNone(helper.systemd_activation_value("worker@%i.service", "relay@.target"))
        self.assertIsNone(helper.systemd_activation_value("worker@%n.service", "relay@.target"))
        self.assertEqual(helper.systemd_activation_value("worker@%p.service", "relay@.target"), "worker@relay.service")
        self.assertEqual(helper.systemd_activation_value("hook@%N.service", "maintenance.target"), "hook@maintenance.service")
        self.assertEqual(helper.systemd_activation_value("hook@%n.service", "maintenance.target"), "hook@maintenance.target.service")
        self.assertEqual(helper.systemd_activation_value("ordinary.service", None), "ordinary.service")
        for word, unit in (("worker@%i.service", None), ("worker@%i.service", "maintenance.target"),
                           ("worker@%U.service", "relay@.target"), ("worker@%%i.service", "relay@.target")):
            with self.subTest(word=word, unit=unit), self.assertRaises(helper.Refused):
                helper.systemd_activation_value(word, unit)

    def test_unit_unescape_distinguishes_path_separators_from_escaped_hyphens(self) -> None:
        self.assertEqual(helper.systemd_unescape_component("outpost-build"), "outpost/build")
        self.assertEqual(helper.systemd_unescape_component(r"outpost\x2dbuild"), "outpost-build")
        self.assertEqual(helper.systemd_unescape_component(r"\x39\x39\x33"), "993")
        for value in (r"\q993", r"\x00", r"\x5c", r"\x25i", r"\x0a"):
            with self.subTest(value=value), self.assertRaises(helper.Refused):
                helper.systemd_unescape_component(value)


class AclTests(unittest.TestCase):
    """Binary ACL decoding needs neither Linux nor installed service accounts."""

    def test_named_uid_gid_references_include_zero_permission_entries(self) -> None:
        self.assertEqual(helper.acl_references(acl_bytes((2, 0, 901), (8, 5, 904))), ({901}, {904}))
        self.assertEqual(helper.acl_references(acl_bytes()), (set(), set()))

    def test_malformed_binary_acl_is_never_treated_as_empty(self) -> None:
        for raw in (b"", b"\x02\x00", struct.pack("<I", 9), acl_bytes()[:-1],
                    struct.pack("<I", 2) + struct.pack("<HHI", 99, 7, 901), acl_bytes((2, 8, 901))):
            with self.subTest(raw=raw), self.assertRaises(helper.Refused):
                helper.acl_references(raw)

    def test_known_filesystems_can_explicitly_lack_posix_acls(self) -> None:
        """Kernel EOPNOTSUPP on a verified known filesystem is distinct from an unreadable ACL."""
        for filesystem in ("tmpfs", "devtmpfs", "devpts", "mqueue", "hugetlbfs", "squashfs", "vfat", "nsfs"):
            with (self.subTest(filesystem=filesystem), patch.object(helper.sys, "platform", "linux"),
                  patch.object(helper.os, "getxattr", side_effect=OSError(errno.EOPNOTSUPP, "unsupported"), create=True) as read,
                  patch.object(helper, "linux_descriptor_filesystem", return_value=filesystem) as identity):
                self.assertEqual(helper.linux_acls(123), (None, None))
                self.assertEqual(read.call_count, 2)
                self.assertEqual(identity.call_count, 2)
                self.assertEqual([call.args[1] for call in read.call_args_list], ["system.posix_acl_access", "system.posix_acl_default"])

    def test_non_acl_filesystems_never_hide_returned_named_acls(self) -> None:
        """A verified type only interprets EOPNOTSUPP; real ACL bytes must still be inspected."""
        for filesystem in ("squashfs", "vfat", "nsfs"):
            for raw in (acl_bytes((2, 0, 901)), acl_bytes((8, 5, 904))):
                for values in ([raw, OSError(errno.EOPNOTSUPP, "unsupported")], [OSError(errno.EOPNOTSUPP, "unsupported"), raw]):
                    with (self.subTest(filesystem=filesystem), patch.object(helper.sys, "platform", "linux"),
                          patch.object(helper.os, "getxattr", side_effect=values, create=True),
                          patch.object(helper, "linux_descriptor_filesystem", return_value=filesystem),
                          self.assertRaisesRegex(helper.Refused, "external POSIX ACL")):
                        helper.Files(123, acl_reader=helper.linux_acls).check_acl(123, {901}, {904})

    def test_hugetlbfs_named_acls_are_not_hidden_by_attribute_nonsupport(self) -> None:
        """Future/present ACL data still blocks deletion, regardless of the other attribute."""
        for raw in (acl_bytes((2, 0, 901)), acl_bytes((8, 5, 904))):
            for access in (True, False):
                unsupported = OSError(errno.EOPNOTSUPP, "unsupported")
                values = [raw, unsupported] if access else [unsupported, raw]
                files = helper.Files(123, acl_reader=helper.linux_acls)
                with (self.subTest(raw=raw, access=access), patch.object(helper.sys, "platform", "linux"),
                      patch.object(helper.os, "getxattr", side_effect=values, create=True) as read,
                      patch.object(helper, "linux_descriptor_filesystem", return_value="hugetlbfs") as identity,
                      self.assertRaisesRegex(helper.Refused, "external POSIX ACL")):
                    files.check_acl(123, {901}, {904})
                self.assertEqual(read.call_count, 2)
                identity.assert_called_once_with(123)

    def test_enodata_needs_no_filesystem_exception_but_unverified_non_support_is_refused(self) -> None:
        with patch.object(helper.sys, "platform", "linux"):
            with (patch.object(helper.os, "getxattr", side_effect=OSError(errno.ENODATA, "absent"), create=True),
                  patch.object(helper, "linux_descriptor_filesystem", side_effect=AssertionError("No identity lookup needed"))):
                self.assertEqual(helper.linux_acls(123), (None, None))
            for filesystem in ("overlay", "ext4", "xfs", "btrfs", "erofs", "nfs", "fuse.tmpfs", "fuse.hugetlbfs", "fuse.squashfs", "fuse.vfat", "nsfs.fake", "squashfs.fake", "hugetlbfs.fake", "ramfs", "unknown"):
                with (self.subTest(filesystem=filesystem),
                      patch.object(helper.os, "getxattr", side_effect=OSError(errno.EOPNOTSUPP, "unsupported"), create=True),
                      patch.object(helper, "linux_descriptor_filesystem", return_value=filesystem),
                      self.assertRaises(helper.Refused)):
                    helper.linux_acls(123)

    def test_virtual_filesystem_does_not_excuse_access_or_io_errors(self) -> None:
        for number in (errno.EACCES, errno.EPERM, errno.EIO, errno.EBADF, errno.ENOENT):
            with (self.subTest(errno=number), patch.object(helper.sys, "platform", "linux"),
                  patch.object(helper.os, "getxattr", side_effect=OSError(number, "unavailable"), create=True),
                  patch.object(helper, "linux_descriptor_filesystem", return_value="tmpfs") as identity,
                  self.assertRaises(helper.Refused)):
                helper.linux_acls(123)
            identity.assert_not_called()

    def test_one_unsupported_attribute_never_discards_present_or_malformed_acls(self) -> None:
        """Each attribute is read; no filesystem-wide or inode-wide exemption is cached."""
        for raw in (acl_bytes((2, 0, 901)), acl_bytes((8, 5, 904)), b"malformed"):
            for first in (True, False):
                missing = OSError(errno.EOPNOTSUPP, "unsupported")
                values = [raw, missing] if first else [missing, raw]
                files = helper.Files(123, acl_reader=helper.linux_acls)
                with (self.subTest(raw=raw, first=first), patch.object(helper.sys, "platform", "linux"),
                      patch.object(helper.os, "getxattr", side_effect=values, create=True) as read,
                      patch.object(helper, "linux_descriptor_filesystem", return_value="tmpfs"),
                      self.assertRaises(helper.Refused)):
                    files.check_acl(123, {901}, {904})
                self.assertEqual(read.call_count, 2)

    def descriptor_filesystem(self, mountinfo: bytes, fdinfo: tuple[bytes, bytes] | None = None,
                              after: os.stat_result | None = None) -> str:
        """Inject kernel metadata, never read the test machine's actual proc filesystem."""
        before = os.stat_result((stat.S_IFDIR | 0o755, 99, os.makedev(0, 7), 1, 0, 0, 0, 0, 0, 0))
        records = iter(fdinfo or (b"pos:\t0\nmnt_id:\t42\n", b"pos:\t0\nmnt_id:\t42\n"))
        def source(path, mode):
            self.assertEqual(mode, "rb")
            if path == "/proc/self/fdinfo/123":
                return io.BytesIO(next(records))
            self.assertEqual(path, "/proc/self/mountinfo")
            return io.BytesIO(mountinfo)
        with (patch.object(helper.sys, "platform", "linux"), patch("builtins.open", side_effect=source),
              patch.object(helper.os, "fstat", side_effect=[before, after or before])):
            return helper.linux_descriptor_filesystem(123)

    def test_filesystem_identity_uses_descriptor_mount_id_not_mountpoint_name(self) -> None:
        for filesystem in ("tmpfs", "devtmpfs", "devpts", "mqueue", "hugetlbfs", "squashfs", "vfat", "nsfs", "overlay"):
            metadata = f"42 1 0:7 / /arbitrary/path rw shared:9 - {filesystem} source rw\n".encode()
            self.assertEqual(self.descriptor_filesystem(metadata), filesystem)
        # A persistent filesystem mounted under /dev is still persistent; a same-device
        # virtual mount elsewhere must not be mistaken for this descriptor's mount.
        records = b"41 1 0:7 / /elsewhere rw - tmpfs tmpfs rw\n42 1 0:7 / /dev/shm rw - overlay overlay rw\n"
        self.assertEqual(self.descriptor_filesystem(records), "overlay")

    def test_missing_ambiguous_malformed_or_mismatched_mount_evidence_is_refused(self) -> None:
        valid = b"42 1 0:7 / /dev rw - tmpfs tmpfs rw\n"
        for raw in (b"", valid + valid, valid.replace(b"42 1", b"43 1"), valid.replace(b"0:7", b"0:8"),
                    b"malformed\n", b"42 1 device / /dev rw - tmpfs tmpfs rw\n", b"x" * (2 * 1024 * 1024 + 1)):
            with self.subTest(metadata=raw[:100]), self.assertRaises(helper.Refused):
                self.descriptor_filesystem(raw)
        for raw in (b"pos:\t0\n", b"mnt_id:\t42\nmnt_id:\t43\n", b"mnt_id:\tnot-a-number\n", b"x" * 4097):
            with self.subTest(fdinfo=raw[:100]), self.assertRaises(helper.Refused):
                self.descriptor_filesystem(valid, (raw, raw))

    def test_changed_descriptor_or_mount_id_is_refused(self) -> None:
        valid = b"42 1 0:7 / /dev rw - tmpfs tmpfs rw\n"
        with self.assertRaises(helper.Refused):
            self.descriptor_filesystem(valid, (b"mnt_id:\t42\n", b"mnt_id:\t43\n"))
        changed = os.stat_result((stat.S_IFDIR | 0o755, 100, os.makedev(0, 7), 1, 0, 0, 0, 0, 0, 0))
        with self.assertRaises(helper.Refused):
            self.descriptor_filesystem(valid, after=changed)

    def test_unavailable_mount_verification_does_not_normalize_unsupported_acl(self) -> None:
        with (patch.object(helper.sys, "platform", "linux"),
              patch.object(helper.os, "getxattr", side_effect=OSError(errno.EOPNOTSUPP, "unsupported"), create=True),
              patch.object(helper, "linux_descriptor_filesystem", side_effect=helper.Refused("Mount verification unavailable")),
              self.assertRaises(helper.Refused)):
            helper.linux_acls(123)

    @unittest.skipUnless(sys.platform == "linux", "Real POSIX ACL xattrs require Linux")
    def test_real_linux_access_and_default_acl_fixtures(self) -> None:
        """Only temporary fixture inodes are changed; no useradd, setfacl or root needed."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "outside"
            target.mkdir()
            descriptor = os.open(root, helper.DIR_FLAGS)
            try:
                files = helper.Files(descriptor, os.getuid(), lambda: set(), mount_ids=False)
                for attribute, tag, identity in (("system.posix_acl_access", 2, 901), ("system.posix_acl_default", 8, 904)):
                    try:
                        os.setxattr(target, attribute, acl_bytes((tag, 5, identity)))
                    except OSError as error:
                        if error.errno == errno.ENOTSUP:
                            self.skipTest("Temporary filesystem does not support POSIX ACL fixtures")
                        raise
                    with self.assertRaisesRegex(helper.Refused, "ACL"):
                        files.outside_ownership({901}, {904}, [])
                    os.removexattr(target, attribute)
            finally:
                os.close(descriptor)


class RunnerTests(unittest.TestCase):
    """Bounded OS-tool capture tests use fake processes and local pipes only."""

    def test_runner_output_budget_kills_only_its_own_child_and_reaps(self) -> None:
        """No installed process ID, unit kill, shell or sudo is involved."""
        reader, writer = os.pipe()
        os.write(writer, b"too much")
        os.close(writer)
        with os.fdopen(reader, "rb") as output:
            process = Mock(stdout=output)
            process.poll.return_value = None
            process.wait.return_value = 0
            with (patch.object(helper.subprocess, "Popen", return_value=process) as launch, patch.object(helper, "MAX_METADATA", 2),
                  self.assertRaisesRegex(helper.Refused, "output budget")):
                helper.SystemRunner().run(["/usr/bin/systemctl", "show", "--", helper.UNITS[0]])
            process.kill.assert_called_once_with()
            process.wait.assert_called_once()
            self.assertEqual(launch.call_args.kwargs["env"]["PATH"], "/usr/sbin:/usr/bin:/sbin:/bin")
            self.assertNotIn("shell", launch.call_args.kwargs)

    def test_deadline_immediately_after_spawn_reaps_and_closes_child(self) -> None:
        """Even the first post-Popen clock read is inside the cleanup region."""
        output = io.BytesIO()
        process = Mock(stdout=output)
        process.poll.return_value = None
        process.wait.return_value = 0
        with (patch.object(helper.subprocess, "Popen", return_value=process),
              patch.object(helper.time, "monotonic", side_effect=helper.Deadline()), self.assertRaises(helper.Deadline)):
            helper.SystemRunner().run(["/usr/bin/systemctl", "show", "--", helper.UNITS[0]])
        process.kill.assert_called_once_with()
        process.wait.assert_called_once()
        self.assertTrue(output.closed)

    def test_deadline_during_spawn_is_deferred_until_child_is_registered(self) -> None:
        """Deliver a real local signal while returning a fake child; no process is spawned."""
        output = io.BytesIO()
        process = Mock(stdout=output)
        process.poll.return_value = None
        process.wait.return_value = 0
        delivered = []
        def deadline(_signum, _frame):
            delivered.append(True)
            raise helper.Deadline()
        def spawn(*_args, **_kwargs):
            signal.raise_signal(signal.SIGALRM)
            self.assertFalse(delivered, "SIGALRM was not blocked during child creation")
            return process
        previous = signal.signal(signal.SIGALRM, deadline)
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        try:
            with patch.object(helper.subprocess, "Popen", side_effect=spawn), self.assertRaises(helper.Deadline):
                helper.SystemRunner().run(["/usr/bin/systemctl", "show", "--", helper.UNITS[0]])
        finally:
            signal.signal(signal.SIGALRM, previous)
            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        process.kill.assert_called_once_with()
        process.wait.assert_called_once()
        self.assertTrue(output.closed)

    def test_installed_executables_and_sudo_are_never_allowed(self) -> None:
        """The runner cannot become an arbitrary execution backdoor."""
        for command in ("sudo", "/opt/outpost-native/current/node/bin/node", "/bin/sh", "/usr/bin/python3"):
            with self.assertRaises(helper.Refused):
                helper.SystemRunner().run([command])


if __name__ == "__main__":
    unittest.main()
