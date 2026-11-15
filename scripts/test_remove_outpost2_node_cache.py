"""Offline: python3 -I -B scripts/test_remove_outpost2_node_cache.py -v.

Only repository source/pins are read. Every operational path, process reference,
lock, signal and mutation is simulated in memory; no real cache/proc/network use.
"""
from __future__ import annotations

import errno
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import unittest
from collections.abc import Iterator
from contextlib import (
    ExitStack,
    contextmanager,
    nullcontext,
    redirect_stderr,
    redirect_stdout,
)
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, call, patch

HERE = Path(__file__).parent
SAFETY_HASH = "da99c1d4d53f26fbf37f42452ed5b7a31ddd01bb6aa23e793a75db7f1d33b2f2"
SAFETY_SOURCE = (HERE / "remove-outpost2-stale-uv-lock.py").read_bytes()
assert hashlib.sha256(SAFETY_SOURCE).hexdigest() == SAFETY_HASH, "Safety source changed; review its pin first"
SAFETY_SPEC = importlib.util.spec_from_file_location("outpost2_cleanup_safety", HERE / "remove-outpost2-stale-uv-lock.py")
assert SAFETY_SPEC is not None and SAFETY_SPEC.loader is not None
safety = importlib.util.module_from_spec(SAFETY_SPEC)
# Import the exact verified bytes, never a second read or an installed module.
with patch.object(SAFETY_SPEC.loader, "get_code", return_value=compile(SAFETY_SOURCE, str(SAFETY_SPEC.origin), "exec")):
    SAFETY_SPEC.loader.exec_module(safety)
SCRIPT = HERE / "remove-outpost2-node-cache.py"
SOURCE = SCRIPT.read_bytes()
SPEC = importlib.util.spec_from_file_location("outpost2_node_cache_test_target", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LOADER = SPEC.loader
CODE = compile(SOURCE, str(SCRIPT), "exec")
cache = importlib.util.module_from_spec(SPEC)
with patch.dict(sys.modules, {"outpost2_cleanup_safety": safety, SPEC.name: cache}), patch.object(LOADER, "get_code", return_value=CODE):
    LOADER.exec_module(cache)

VERSION_NAME = "v24.22.1-x64-a1b2c3d4-0"
SAFE_STATUS = "Uid: 0 0 0 0\nGid: 0 0 0 0\nGroups: 0\n"
SECRET = "PRIVATE_NAME_OR_CONTENT_DO_NOT_PRINT"
TMP_FD, CACHE_FD, VERSION_FD, FILE_A_FD, FILE_B_FD = (40, 41, 42, 43, 44)


def info(inode: int, mode: int, **changes: int) -> SimpleNamespace:
    """Create synthetic stat data with no dependency on local ownership."""
    values = {"st_dev": 73, "st_ino": inode, "st_mode": mode, "st_uid": 993, "st_gid": 979,
              "st_nlink": 1, "st_size": 20, "st_mtime_ns": 100, "st_ctime_ns": 200, "st_atime_ns": 300}
    return SimpleNamespace(**(values | changes))


@dataclass
class Node:
    """One entry in this test's fixed cache tree, not a host filesystem adapter."""

    fd: int
    info: SimpleNamespace
    children: dict[str, Node] | None = None


@dataclass
class Host:
    """In-memory OS boundary that rejects unconfigured paths and real actions."""

    opened: set[int] = field(default_factory=set)
    events: list[str] = field(default_factory=list)
    installer_held: bool = False

    def __post_init__(self) -> None:
        self.file_a = Node(FILE_A_FD, info(501, stat.S_IFREG | 0o600))
        self.file_b = Node(FILE_B_FD, info(502, stat.S_IFREG | 0o644, st_size=30))
        self.version = Node(VERSION_FD, info(500, stat.S_IFDIR | 0o755, st_nlink=2, st_size=80),
                            {"1234abcd": self.file_a, "5678efab": self.file_b})
        self.root = Node(CACHE_FD, info(427044, stat.S_IFDIR | 0o700, st_nlink=3, st_size=60),
                         {VERSION_NAME: self.version})
        self.tmp = Node(TMP_FD, info(2, stat.S_IFDIR | 0o1777, st_uid=0, st_gid=0), {"node-compile-cache": self.root})
        self.nodes = {node.fd: node for node in (self.tmp, self.root, self.version, self.file_a, self.file_b)}
        self.texts: dict[str, str | OSError] = {"/proc/self/mountinfo": "36 25 0:32 / /tmp rw - tmpfs tmpfs rw\n"}
        self.proc_entries: list[SimpleNamespace] = []
        self.proc_fds: dict[str, list[SimpleNamespace] | OSError] = {}
        self.references: dict[str, SimpleNamespace | OSError] = {}
        self.out, self.err = io.StringIO(), io.StringIO()
        self.sys = SimpleNamespace(argv=[str(SCRIPT), cache.APPROVAL], platform="linux", stderr=self.err)
        constants = {name: getattr(os, name) for name in (
            "O_RDONLY", "O_RDWR", "O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC", "O_NONBLOCK",
        )}
        constants["O_NOATIME"] = getattr(os, "O_NOATIME", 0x40000)
        self.os = SimpleNamespace(**constants)
        for name, function in (("open", self.open_fd), ("close", self.close_fd), ("fstat", self.fstat),
                               ("stat", self.stat), ("scandir", self.scandir), ("unlink", self.unlink), ("rmdir", self.rmdir)):
            setattr(self.os, name, Mock(side_effect=function))
        self.os.fsync = Mock()
        self.os.getpid = Mock(return_value=9000)
        self.os.geteuid = Mock(return_value=0)
        self.fcntl = SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=Mock(), lockf=Mock())
        self.signal = SimpleNamespace(SIGALRM=14, signal=Mock(), alarm=Mock())
        self.pwd = SimpleNamespace(getpwnam=Mock(return_value=SimpleNamespace(pw_uid=993, pw_gid=979)))
        self.grp = SimpleNamespace(getgrnam=Mock(return_value=SimpleNamespace(gr_gid=979)))
        self.open_text = Mock(side_effect=self.read_text)

    def child(self, parent: int, name: str) -> Node:
        """Resolve only an already-opened fake directory."""
        assert parent in self.opened
        children = self.nodes[parent].children
        assert children is not None
        if name not in children:
            raise FileNotFoundError(errno.ENOENT, "synthetic missing entry")
        return children[name]

    def open_fd(self, name: str, flags: int, *, dir_fd: int | None = None) -> int:
        """No call is ever forwarded to the real os.open."""
        assert flags & self.os.O_NOFOLLOW and flags & self.os.O_CLOEXEC and flags & self.os.O_NOATIME
        assert not flags & (os.O_CREAT | os.O_TRUNC | os.O_APPEND | os.O_EXCL)
        if dir_fd is None:
            assert name == "/tmp"
            node = self.tmp
        else:
            node = self.child(dir_fd, name)
        assert node.fd not in self.opened
        if node.children is None:
            assert flags & self.os.O_RDWR and flags & self.os.O_NONBLOCK
        else:
            assert flags & self.os.O_DIRECTORY and not flags & self.os.O_RDWR
        self.opened.add(node.fd)
        self.events.append("open:" + str(node.fd))
        return node.fd

    def close_fd(self, fd: int) -> None:
        """Retain detached node metadata but close the fake descriptor."""
        assert fd in self.opened
        self.opened.remove(fd)
        self.events.append("close:" + str(fd))

    def fstat(self, fd: int) -> SimpleNamespace:
        """Return a snapshot, not a mutable reference to live fake metadata."""
        assert fd in self.opened
        return SimpleNamespace(**vars(self.nodes[fd].info))

    def stat(self, path: str, *, dir_fd: int | None = None, follow_symlinks: bool = True) -> SimpleNamespace:
        """Follow only configured proc references; never follow cache paths."""
        if dir_fd is not None:
            assert not follow_symlinks
            result = self.child(dir_fd, path).info
        elif path == "/tmp":
            assert not follow_symlinks
            result = self.tmp.info
        else:
            assert path.startswith("/proc/") and follow_symlinks
            result = self.references[path]
        if isinstance(result, OSError):
            raise result
        return SimpleNamespace(**vars(result))

    def scandir(self, path: int | str):
        """Return only in-memory listings for cache directories or fake proc."""
        self.events.append("scan:" + str(path))
        if isinstance(path, int):
            assert path in self.opened
            children = self.nodes[path].children
            assert children is not None
            result = [SimpleNamespace(name=name) for name in children]
        elif path == "/proc":
            result = self.proc_entries
        else:
            result = self.proc_fds[path]
        if isinstance(result, OSError):
            raise result
        return nullcontext(iter(result))

    def read_text(self, path: str, *, encoding: str) -> io.StringIO:
        """No data or executable contents can be read from cache files."""
        assert encoding == "utf-8"
        self.events.append("read:" + path)
        text = self.texts[path]
        if isinstance(text, OSError):
            raise text
        return io.StringIO(text)

    def detach(self, name: str, parent: int, directory: bool) -> None:
        """Model removal while checking that all prechecks preceded mutation."""
        assert self.installer_held
        assert self.events.count("read:/proc/self/mountinfo") >= 2
        assert self.events.count("scan:/proc") >= 1
        assert self.events.count("scan:" + str(CACHE_FD)) >= 3
        assert self.events.count("scan:" + str(VERSION_FD)) >= 3
        node = self.child(parent, name)
        assert (node.children is not None) == directory
        if directory and node.children:
            raise OSError(errno.ENOTEMPTY, "synthetic nonempty directory")
        children = self.nodes[parent].children
        assert children is not None
        del children[name]
        node.info.st_nlink = 0
        node.info.st_ctime_ns += 1
        self.nodes[parent].info.st_mtime_ns += 1
        self.nodes[parent].info.st_ctime_ns += 1
        if directory:
            self.nodes[parent].info.st_nlink -= 1
        self.events.append(("rmdir:" if directory else "unlink:") + name)

    def unlink(self, name: str, *, dir_fd: int) -> None:
        """Simulate unlink only; never use the real syscall."""
        self.detach(name, dir_fd, False)

    def rmdir(self, name: str, *, dir_fd: int) -> None:
        """Simulate rmdir only; never use the real syscall."""
        self.detach(name, dir_fd, True)

    @contextmanager
    def installation_lock(self) -> Iterator[None]:
        """The previously tested shared lock is substituted at its boundary."""
        assert not self.installer_held
        self.installer_held = True
        self.events.append("installer:enter")
        try:
            yield
        finally:
            assert not self.opened
            self.installer_held = False
            self.events.append("installer:exit")

    def add_process(self, pid: int = 123, status: str = SAFE_STATUS) -> None:
        """Provide a process with harmless reference targets by default."""
        path = f"/proc/{pid}"
        self.proc_entries.append(SimpleNamespace(name=str(pid), path=path))
        self.texts[path + "/status"] = status
        self.proc_fds[path + "/fd"] = [SimpleNamespace(path=path + "/fd/4")]
        for suffix in ("cwd", "root", "exe", "fd/4"):
            self.references[path + "/" + suffix] = info(999, stat.S_IFREG | 0o600, st_uid=0, st_gid=0)

    def run(self) -> int:
        """Exercise the real entrypoint with captured, bounded output."""
        with redirect_stdout(self.out), redirect_stderr(self.err):
            return cache.entrypoint()


@contextmanager
def fake_host() -> Iterator[Host]:
    """Patch whole dependency objects; an unknown OS method cannot escape."""
    host = Host()
    with ExitStack() as stack:
        for name in ("os", "fcntl", "signal", "pwd", "grp", "sys", "installation_lock"):
            stack.enter_context(patch.object(cache, name, getattr(host, name)))
        stack.enter_context(patch.object(cache, "open", host.open_text, create=True))
        yield host


class NodeCacheTests(unittest.TestCase):
    """Test the approved shape and every pre-mutation refusal boundary."""

    def assert_refused(self, host: Host, reason: str = "") -> None:
        """No precheck failure may reach even a simulated mutation."""
        self.assertEqual(host.run(), 1)
        host.os.unlink.assert_not_called()
        host.os.rmdir.assert_not_called()
        self.assertFalse(host.opened)
        self.assertFalse(host.installer_held)
        self.assertEqual(host.out.getvalue(), "")
        report = json.loads(host.err.getvalue())
        self.assertEqual(report["state"], "refused_or_uncertain")
        self.assertFalse(report["resetStarted"])
        self.assertIn(reason, report["reason"])
        self.assertNotIn(SECRET, host.err.getvalue())

    def test_injected_primitives_and_runtime_pins_match(self) -> None:
        self.assertIs(cache.require, safety.require)
        self.assertIs(cache.Refused, safety.Refused)
        self.assertIs(cache.stamp, safety.stamp)
        self.assertIs(cache.installation_lock, safety.installation_lock)
        self.assertEqual(cache.SAFETY_SHA256, SAFETY_HASH)
        pins = json.loads((HERE.parent / "deploy/environment/runtime-pins.json").read_text())
        self.assertEqual(pins["nodeVersion"], "24.22.1")
        self.assertTrue(pins["nodeUrl"].endswith("node-v24.22.1-linux-x64.tar.xz"))
        self.assertEqual(cache.CACHE_PATH, "/tmp/node-compile-cache")
        self.assertEqual(cache.EXPECTED_INODE, 427044)

    def test_missing_injection_refuses_without_module_search(self) -> None:
        with patch.dict(sys.modules):
            sys.modules.pop("outpost2_cleanup_safety", None)
            with patch.object(LOADER, "get_code", return_value=CODE), self.assertRaisesRegex(
                SystemExit, "no filesystem import attempted"
            ):
                LOADER.exec_module(ModuleType("no_injected_safety"))

    def test_success_counts_two_passes_locks_and_descriptor_relative_removal(self) -> None:
        with fake_host() as host:
            self.assertEqual(host.run(), 0)
            self.assertEqual(json.loads(host.out.getvalue()), {
                "state": "removed", "path": "/tmp/node-compile-cache", "inode": 427044,
                "directories": 2, "files": 2, "bytes": 50, "resetStarted": False,
            })
            self.assertEqual(host.err.getvalue(), "")
            self.assertEqual(host.os.unlink.call_args_list, [call("5678efab", dir_fd=VERSION_FD), call("1234abcd", dir_fd=VERSION_FD)])
            self.assertEqual(host.os.rmdir.call_args_list, [call(VERSION_NAME, dir_fd=CACHE_FD), call("node-compile-cache", dir_fd=TMP_FD)])
            self.assertEqual(host.fcntl.flock.call_args_list, [call(fd, 6) for fd in (CACHE_FD, VERSION_FD, FILE_A_FD, FILE_B_FD)])
            self.assertEqual(host.fcntl.lockf.call_args_list, [call(FILE_A_FD, 6), call(FILE_B_FD, 6)])
            self.assertEqual(host.signal.alarm.call_args_list, [call(60), call(0)])
            self.assertEqual(host.os.close.call_args_list, [call(fd) for fd in (FILE_B_FD, FILE_A_FD, VERSION_FD, CACHE_FD, TMP_FD)])
            self.assertEqual(host.events[-1], "installer:exit")

    def test_absent_is_rechecked_and_does_not_mutate(self) -> None:
        with fake_host() as host:
            assert host.tmp.children is not None
            host.tmp.children.clear()
            self.assertEqual(host.run(), 0)
            self.assertEqual(json.loads(host.out.getvalue()), {
                "state": "absent", "path": cache.CACHE_PATH, "directories": 0, "files": 0, "bytes": 0, "resetStarted": False,
            })
            host.os.unlink.assert_not_called()
            host.os.rmdir.assert_not_called()
            self.assertIn("scan:/proc", host.events)
            self.assertEqual(host.events.count("read:/proc/self/mountinfo"), 2)

    def test_missing_root_errors_other_than_enoent_are_not_absence(self) -> None:
        for code in (errno.ESRCH, errno.EACCES, errno.EPERM, errno.EIO):
            with self.subTest(errno=code), fake_host() as host:
                host.os.stat.side_effect = OSError(code, SECRET)
                self.assert_refused(host)

    def test_absent_root_reappearance_is_not_reported_as_absent(self) -> None:
        with fake_host() as host:
            assert host.tmp.children is not None
            host.tmp.children.clear()

            def reappear(identities: set) -> None:
                assert host.tmp.children is not None
                host.tmp.children[cache.CACHE_NAME] = host.root

            with patch.object(cache, "require_no_users", side_effect=reappear):
                self.assert_refused(host, "exists after removal/absence check")

    def test_approval_root_linux_and_all_account_mappings_required(self) -> None:
        cases = ("approval", "extra-path", "platform", "euid", "uid", "primary-gid", "group-gid", "missing-account")
        for case in cases:
            with self.subTest(case=case), fake_host() as host:
                if case == "approval":
                    host.sys.argv = ["helper"]
                elif case == "extra-path":
                    host.sys.argv.append("/tmp/other")
                elif case == "platform":
                    host.sys.platform = "darwin"
                elif case == "euid":
                    host.os.geteuid.return_value = 501
                elif case == "uid":
                    host.pwd.getpwnam.return_value.pw_uid = 0
                elif case == "primary-gid":
                    host.pwd.getpwnam.return_value.pw_gid = 0
                elif case == "group-gid":
                    host.grp.getgrnam.return_value.gr_gid = 0
                else:
                    host.pwd.getpwnam.side_effect = KeyError(SECRET)
                self.assert_refused(host)
                host.os.open.assert_not_called()

    def test_busy_installer_prevents_any_cache_access(self) -> None:
        with fake_host() as host, patch.object(cache, "installation_lock", side_effect=cache.Refused("Installer busy")):
            self.assert_refused(host, "Installer busy")
            host.os.open.assert_not_called()
            host.signal.alarm.assert_called_with(0)

    def test_parent_must_be_sticky_root_owned_directory(self) -> None:
        for field_name, value in (("st_mode", stat.S_IFDIR | 0o777), ("st_uid", 993), ("st_gid", 979)):
            with self.subTest(field=field_name), fake_host() as host:
                setattr(host.tmp.info, field_name, value)
                self.assert_refused(host, "temporary directory identity")

    def test_observed_root_identity_is_pinned(self) -> None:
        for field_name, value in (("st_ino", 427045), ("st_mode", stat.S_IFDIR | 0o755),
                                          ("st_mode", stat.S_IFLNK | 0o700), ("st_mode", stat.S_IFREG | 0o700), ("st_uid", 0),
                                  ("st_gid", 0), ("st_dev", 74), ("st_nlink", 2), ("st_size", 61)):
            with self.subTest(field=field_name), fake_host() as host:
                setattr(host.root.info, field_name, value)
                self.assert_refused(host, "root metadata refused")
                self.assertEqual(host.os.open.call_count, 1)

    def test_version_and_file_metadata_fail_closed(self) -> None:
        for target in ("version", "file_a"):
            changes = [("st_uid", 0), ("st_gid", 0), ("st_dev", 74), ("st_nlink", 0), ("st_nlink", 3)]
            if target == "file_a":
                changes.append(("st_nlink", 2))
            changes += [("st_mode", kind | 0o600) for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFCHR, stat.S_IFBLK)]
            changes += [("st_mode", (stat.S_IFDIR if target == "version" else stat.S_IFREG) | mode)
                        for mode in (0o666, 0o777, 0o4755, 0o2644)]
            for field_name, value in changes:
                with self.subTest(target=target, field=field_name, value=value), fake_host() as host:
                    setattr(getattr(host, target).info, field_name, value)
                    self.assert_refused(host, "metadata refused")

    def test_unexpected_names_or_nested_layout_report_no_untrusted_names(self) -> None:
        for target, name in (("root", SECRET), ("root", "v24.22.2-x64-12345678"),
                             ("root", "v24.22.1-arm64-12345678"), ("root", "v24.22.1-x64-12345678-x"),
                             ("version", SECRET), ("version", "1234567g")):
            with self.subTest(target=target, name=name), fake_host() as host:
                node = getattr(host, target)
                original = next(iter(node.children))
                node.children[name] = node.children.pop(original)
                self.assert_refused(host, "Unexpected cache")
                self.assertIn('"uid"', json.loads(host.err.getvalue())["reason"])
        with fake_host() as host:
            host.file_a.info.st_mode = stat.S_IFDIR | 0o700
            self.assert_refused(host, "file metadata refused")

    def test_version_suffix_optional_and_conservative_permissions_accepted(self) -> None:
        for name in ("v24.22.1-x64-12345678", "v24.22.1-x64-12345678-12"):
            with self.subTest(name=name), fake_host() as host:
                assert host.root.children is not None
                host.root.children = {name: host.version}
                host.version.info.st_mode = stat.S_IFDIR | 0o700
                self.assertEqual(host.run(), 0)

    def test_all_inventory_and_descriptor_budgets_precede_mutation(self) -> None:
        for setting, limit in (("MAX_VERSIONS", 0), ("MAX_FILES", 1), ("MAX_TOTAL_BYTES", 49), ("MAX_FILE_BYTES", 19)):
            with self.subTest(setting=setting), fake_host() as host, patch.object(cache, setting, limit):
                self.assert_refused(host)
        with fake_host() as host:
            host.os.open.side_effect = OSError(errno.EMFILE, SECRET)
            self.assert_refused(host)

    def test_mounts_at_or_below_cache_refused_and_lookalike_prefix_allowed(self) -> None:
        for path in (cache.CACHE_PATH, cache.CACHE_PATH + "/" + VERSION_NAME, cache.CACHE_PATH + r"/private\040mount"):
            with self.subTest(path=path), fake_host() as host:
                host.texts["/proc/self/mountinfo"] = f"36 25 0:32 / {path} rw - tmpfs tmpfs rw\n"
                self.assert_refused(host, "Mount at or below")
        with fake_host() as host:
            host.texts["/proc/self/mountinfo"] = "36 25 0:32 / /tmp/node-compile-cache-other rw - tmpfs tmpfs rw\n"
            self.assertEqual(host.run(), 0)

    def test_mount_inventory_empty_malformed_oversized_or_denied_blocks(self) -> None:
        for value in ("", SECRET, "x" * 1025, PermissionError(errno.EACCES, SECRET)):
            with self.subTest(kind=type(value).__name__), fake_host() as host, patch.object(cache, "MAX_MOUNT_BYTES", 1024):
                host.texts["/proc/self/mountinfo"] = value
                self.assert_refused(host)

    def test_either_file_lock_family_failure_blocks_and_closes_every_fd(self) -> None:
        for family in ("flock", "lockf"):
            for code in (errno.EAGAIN, errno.EACCES, errno.ENOSYS):
                with self.subTest(family=family, errno=code), fake_host() as host:
                    getattr(host.fcntl, family).side_effect = OSError(code, SECRET)
                    self.assert_refused(host, "cannot be exclusively locked")

    def test_all_uid_gid_slots_and_supplementary_groups_block(self) -> None:
        statuses = [SAFE_STATUS.replace("Groups: 0", "Groups: 0 979")]
        for field_name, identity in (("Uid", "993"), ("Gid", "979")):
            for slot in range(4):
                ids = ["0"] * 4
                ids[slot] = identity
                statuses.append(SAFE_STATUS.replace(field_name + ": 0 0 0 0", field_name + ": " + " ".join(ids)))
        for status in statuses:
            with self.subTest(status=status), fake_host() as host:
                host.add_process(status=status)
                self.assert_refused(host, "build identity")

    def test_fd_cwd_root_exe_references_to_any_inventoried_inode_block(self) -> None:
        for target in ("root", "version", "file_a"):
            for suffix in ("fd/4", "cwd", "root", "exe"):
                with self.subTest(target=target, suffix=suffix), fake_host() as host:
                    host.add_process()
                    host.references["/proc/123/" + suffix] = getattr(host, target).info
                    self.assert_refused(host, "references an inventoried")

    def test_reference_comparison_is_exact_device_inode_and_self_is_skipped(self) -> None:
        with fake_host() as host:
            host.add_process(status=SAFE_STATUS.replace("Groups: 0", "Groups: 1979"))
            host.references["/proc/123/cwd"] = info(427044, stat.S_IFDIR | 0o700, st_dev=74)
            host.proc_entries += [SimpleNamespace(name=name, path="/proc/" + name) for name in ("self", "9000", "123x")]
            self.assertEqual(host.run(), 0)

    def test_only_enoent_esrch_are_tolerated_for_disappearing_proc_entries(self) -> None:
        for site in ("status", "fd", "fd/4", "cwd", "root", "exe"):
            for code in (errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM, errno.EIO, errno.ENOTDIR):
                with self.subTest(site=site, errno=code), fake_host() as host:
                    host.add_process()
                    failure = OSError(code, SECRET)
                    if site == "status":
                        host.texts["/proc/123/status"] = failure
                    elif site == "fd":
                        host.proc_fds["/proc/123/fd"] = failure
                    else:
                        host.references["/proc/123/" + site] = failure
                    if code in (errno.ENOENT, errno.ESRCH):
                        self.assertEqual(host.run(), 0)
                    else:
                        self.assert_refused(host)

    def test_gone_process_or_fd_does_not_hide_later_active_reference(self) -> None:
        for gone in ("process", "fd"):
            with self.subTest(gone=gone), fake_host() as host:
                host.add_process()
                host.add_process(pid=124)
                if gone == "process":
                    host.texts["/proc/123/status"] = FileNotFoundError(errno.ENOENT, "gone")
                else:
                    host.references["/proc/123/fd/4"] = ProcessLookupError(errno.ESRCH, "gone")
                host.references["/proc/124/exe"] = host.file_a.info
                self.assert_refused(host, "references an inventoried")

    def test_proc_root_failure_is_never_tolerated_as_disappearance(self) -> None:
        for code in (errno.ENOENT, errno.ESRCH, errno.EACCES):
            with self.subTest(errno=code), fake_host() as host:
                scan = host.scandir

                def fail_proc(path: int | str, code: int = code, scan=scan):
                    if path == "/proc":
                        raise OSError(code, SECRET)
                    return scan(path)

                host.os.scandir.side_effect = fail_proc
                self.assert_refused(host)

    def test_process_identity_and_scan_budgets_fail_closed(self) -> None:
        for text in ("Uid: 0 0 0 0\n", SAFE_STATUS + "Uid: 0 0 0 0\n", SAFE_STATUS.replace("Uid: 0 0 0 0", "Uid:"),
                     SAFE_STATUS.replace("Gid: 0 0 0 0", "Gid: invalid"), SAFE_STATUS + "x" * 65537):
            with self.subTest(length=len(text)), fake_host() as host:
                host.add_process(status=text)
                self.assert_refused(host)
        for setting in ("MAX_PROCESSES", "MAX_REFERENCES"):
            with self.subTest(setting=setting), fake_host() as host, patch.object(cache, setting, 0):
                host.add_process()
                self.assert_refused(host, "budget exceeded")

    def test_first_and_second_rechecks_detect_metadata_listing_and_path_changes(self) -> None:
        original_recheck = cache.recheck
        for phase in (1, 2):
            for change in ("metadata", "listing", "replacement"):
                with self.subTest(phase=phase, change=change), fake_host() as host:
                    passes = 0

                    def mutate(entries: list, phase: int = phase, change: str = change) -> None:
                        nonlocal passes
                        passes += 1
                        if passes == phase:
                            if change == "metadata":
                                host.file_a.info.st_ctime_ns += 1
                            elif change == "listing":
                                assert host.version.children is not None
                                host.version.children["deadbeef"] = host.file_a
                            else:
                                assert host.version.children is not None
                                host.version.children["1234abcd"] = Node(90, info(900, stat.S_IFREG | 0o600))
                        original_recheck(entries)

                    with patch.object(cache, "recheck", side_effect=mutate):
                        self.assert_refused(host, "changed during inspection")

    def test_second_mount_check_and_parent_recheck_precede_deletion(self) -> None:
        for change in ("mount", "parent"):
            with self.subTest(change=change), fake_host() as host:
                def change_after_scan(identities: set, change: str = change) -> None:
                    if change == "mount":
                        host.texts["/proc/self/mountinfo"] = f"36 25 0:32 / {cache.CACHE_PATH}/new rw - tmpfs tmpfs rw\n"
                    else:
                        host.tmp.info.st_ino += 1
                with patch.object(cache, "require_no_users", side_effect=change_after_scan):
                    self.assert_refused(host)

    def test_permission_failures_and_opened_inode_changes_block(self) -> None:
        for operation in ("stat", "fstat", "open", "scandir"):
            with self.subTest(operation=operation), fake_host() as host:
                getattr(host.os, operation).side_effect = PermissionError(errno.EACCES, SECRET)
                self.assert_refused(host)
        with fake_host() as host:
            original = host.fstat

            def changed_open(fd: int) -> SimpleNamespace:
                result = original(fd)
                if fd == CACHE_FD:
                    result.st_ino += 1
                return result

            host.os.fstat.side_effect = changed_open
            self.assert_refused(host, "changed while opening")

    def test_timeout_before_mutation_closes_descriptors_and_cancels_alarm(self) -> None:
        with fake_host() as host, patch.object(cache, "require_no_users", side_effect=lambda identities: cache.deadline(0, None)):
            self.assert_refused(host, "timed out")
            host.signal.alarm.assert_called_with(0)

    def test_partial_unlink_rmdir_or_fsync_failure_is_nonzero_without_retry(self) -> None:
        for operation in ("unlink", "rmdir", "fsync"):
            with self.subTest(operation=operation), fake_host() as host:
                if operation == "unlink":
                    calls = 0

                    def fail_second(name: str, *, dir_fd: int) -> None:
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            raise PermissionError(errno.EPERM, SECRET)
                        host.unlink(name, dir_fd=dir_fd)

                    host.os.unlink.side_effect = fail_second
                else:
                    getattr(host.os, operation).side_effect = OSError(errno.EIO, SECRET)
                self.assertEqual(host.run(), 1)
                self.assertEqual(host.out.getvalue(), "")
                self.assertNotIn(SECRET, host.err.getvalue())
                self.assertEqual(json.loads(host.err.getvalue())["state"], "refused_or_uncertain")
                self.assertLessEqual(host.os.unlink.call_count, 2)
                self.assertLessEqual(host.os.rmdir.call_count, 1)
                self.assertFalse(host.opened)
                self.assertFalse(host.installer_held)

    def test_timeout_after_first_mutation_is_uncertain_and_never_retried(self) -> None:
        with fake_host() as host:
            host.os.fsync.side_effect = lambda fd: cache.deadline(0, None)
            self.assertEqual(host.run(), 1)
            host.os.unlink.assert_called_once()
            host.os.rmdir.assert_not_called()
            self.assertEqual(host.out.getvalue(), "")
            self.assertIn("timed out", json.loads(host.err.getvalue())["reason"])
            self.assertFalse(host.opened)
            host.signal.alarm.assert_called_with(0)

    def test_close_failure_after_removal_does_not_print_success(self) -> None:
        with fake_host() as host:
            def fail_close(fd: int) -> None:
                host.close_fd(fd)
                if fd == FILE_B_FD:
                    raise OSError(errno.EIO, SECRET)

            host.os.close.side_effect = fail_close
            self.assertEqual(host.run(), 1)
            self.assertEqual(host.os.unlink.call_count, 2)
            self.assertEqual(host.os.rmdir.call_count, 2)
            self.assertEqual(host.out.getvalue(), "")
            self.assertNotIn(SECRET, host.err.getvalue())
            self.assertFalse(host.opened)

    def test_post_unlink_recreation_or_nonzero_links_is_uncertain_no_retry(self) -> None:
        for change in ("recreated", "linked"):
            with self.subTest(change=change), fake_host() as host:
                def uncertain_unlink(name: str, *, dir_fd: int, change: str = change) -> None:
                    node = host.child(dir_fd, name)
                    host.unlink(name, dir_fd=dir_fd)
                    if change == "linked":
                        node.info.st_nlink = 1
                    else:
                        children = host.nodes[dir_fd].children
                        assert children is not None
                        children[name] = Node(90, info(900, stat.S_IFREG | 0o600))
                host.os.unlink.side_effect = uncertain_unlink
                self.assertEqual(host.run(), 1)
                host.os.unlink.assert_called_once()
                host.os.rmdir.assert_not_called()
                self.assertEqual(host.out.getvalue(), "")
                self.assertFalse(host.opened)


if __name__ == "__main__":
    unittest.main()
