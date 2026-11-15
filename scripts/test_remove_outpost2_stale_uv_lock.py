"""Hermetic tests: python3 -I -B scripts/test_remove_outpost2_stale_uv_lock.py -v.

Only the sibling Python source is read. All cleanup filesystem, process, account,
locking, and signal calls are mocked; no temporary files, unlink, SSH, sudo,
launcher, reset, or operator tests run. The review assumes trusted root and no
parallel manual mutation; one retained test documents the excluded pathname race.
"""
from __future__ import annotations

import errno
import importlib.util
import io
import json
import os
import stat
import unittest
from collections.abc import Iterator
from contextlib import ExitStack, nullcontext, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import TypeVar
from unittest.mock import Mock, call, patch

SCRIPT = Path(__file__).with_name("remove-outpost2-stale-uv-lock.py")
SPEC = importlib.util.spec_from_file_location("remove_outpost2_stale_uv_lock", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)

PARENT_FD, LOCK_FD, SELF_PID = 40, 41, 9000
ROOT_FD, VAR_FD, LIB_FD, SETUP_FD, INSTALL_FD = INSTALL_FDS = (30, 31, 32, 33, 34)
LOCK_NAME = "uv-ba3c823b32647ae1.lock"
LOCK_PATH = "/tmp/" + LOCK_NAME
APPROVAL = "--approved-surajhomeserver2-lock-removal"
SAFE_STATUS = "Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n"
T = TypeVar("T")


def lock_info(**changes: int) -> SimpleNamespace:
    """Use an arbitrary device ID, not an unobserved production device pin."""
    fields = {"st_dev": 73, "st_ino": 427819, "st_mode": stat.S_IFREG | 0o666,
              "st_uid": 993, "st_gid": 979, "st_size": 0, "st_nlink": 1,
              "st_mtime_ns": 100, "st_ctime_ns": 200, "st_atime_ns": 300}
    return SimpleNamespace(**(fields | changes))


def changed(info: SimpleNamespace, **changes: int) -> SimpleNamespace:
    """Copy metadata so earlier observations remain immutable."""
    return SimpleNamespace(**(vars(info) | changes))


def outcome(value: T | BaseException) -> T:
    """Return a synthetic observation or raise its configured failure."""
    if isinstance(value, BaseException):
        raise value
    return value


class IsolatedTests(unittest.TestCase):
    """Replace script dependencies, never delegate an OS call to the host."""

    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.calls = Mock()
        self.output = io.StringIO()
        self.stack.enter_context(redirect_stdout(self.output))
        constants = {name: getattr(os, name) for name in (
            "O_RDONLY", "O_RDWR", "O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC", "O_NONBLOCK",
        )}
        # macOS lacks O_NOATIME. This Linux bit is only passed to a mock.
        constants["O_NOATIME"] = getattr(os, "O_NOATIME", 0x40000)
        self.os = SimpleNamespace(**constants)
        self.fcntl = SimpleNamespace(LOCK_EX=cleanup.fcntl.LOCK_EX, LOCK_NB=cleanup.fcntl.LOCK_NB)
        self.signal = SimpleNamespace(SIGALRM=cleanup.signal.SIGALRM)
        self.pwd, self.grp = SimpleNamespace(), SimpleNamespace()
        for module_name, fake, methods in (
            ("os", self.os, ("open", "stat", "fstat", "unlink", "fsync", "close", "scandir", "getpid", "geteuid")),
            ("fcntl", self.fcntl, ("flock", "lockf")),
            ("signal", self.signal, ("signal", "alarm")),
            ("pwd", self.pwd, ("getpwnam",)),
            ("grp", self.grp, ("getgrnam",)),
        ):
            for method in methods:
                mock = Mock(side_effect=AssertionError(f"Unexpected {module_name}.{method}"))
                setattr(fake, method, mock)
                self.calls.attach_mock(mock, module_name + "_" + method)
            self.stack.enter_context(patch.object(cleanup, module_name, fake))
        self.sys = SimpleNamespace(argv=[str(SCRIPT), APPROVAL], platform="linux")
        self.stack.enter_context(patch.object(cleanup, "sys", self.sys))
        self.texts: dict[str, str | OSError] = {}
        self.directories: dict[str, list[SimpleNamespace] | OSError] = {"/proc": []}
        self.fd_stats: dict[str, SimpleNamespace | OSError] = {}
        self.open = Mock(side_effect=self.read_text)
        self.calls.attach_mock(self.open, "text_open")
        self.stack.enter_context(patch.object(cleanup, "open", self.open, create=True))
        self.os.getpid.side_effect = None
        self.os.getpid.return_value = SELF_PID
        self.os.scandir.side_effect = self.scan
        self.os.stat.side_effect = lambda path: outcome(self.fd_stats[path])

    def read_text(self, path: str) -> io.StringIO:
        """Supply only explicitly configured in-memory text."""
        return io.StringIO(outcome(self.texts[path]))

    def scan(self, path: str) -> nullcontext[Iterator[SimpleNamespace]]:
        """Supply synthetic directory entries, including injected failures."""
        return nullcontext(iter(outcome(self.directories[path])))

    def add_process(self, pid: int = 123, status: str = SAFE_STATUS,
                    descriptors: dict[str, SimpleNamespace | OSError] | None = None) -> None:
        """Add one visible process without inspecting the local /proc."""
        path = f"/proc/{pid}"
        processes = self.directories["/proc"]
        assert isinstance(processes, list)
        processes.append(SimpleNamespace(name=str(pid), path=path))
        self.texts[path + "/status"] = status
        files: list[SimpleNamespace] = []
        self.directories[path + "/fd"] = files
        for name, info in (descriptors or {}).items():
            fd_path = path + "/fd/" + name
            files.append(SimpleNamespace(name=name, path=fd_path))
            self.fd_stats[fd_path] = info


class LockIdentityTests(IsolatedTests):
    """Pin the single approved file and compare all significant metadata."""

    def test_fixed_scope_and_exact_identity_accepted(self) -> None:
        self.assertEqual((cleanup.LOCK_NAME, cleanup.LOCK_PATH, cleanup.EXPECTED_INODE, cleanup.APPROVAL),
                         (LOCK_NAME, LOCK_PATH, 427819, APPROVAL))
        cleanup.validate_lock(lock_info(), SimpleNamespace(st_dev=73))
        self.assertEqual(self.calls.mock_calls, [])

    def test_each_wrong_identity_field_rejected(self) -> None:
        cases = {
            "st_mode": [kind | 0o666 for kind in (
                stat.S_IFDIR, stat.S_IFLNK, stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFCHR, stat.S_IFBLK,
            )] + [stat.S_IFREG | mode for mode in (0o600, 0o644, 0o777, 0o1666, 0o2666, 0o4666)],
            "st_uid": (0, 994), "st_gid": (0, 980), "st_ino": (427820,),
            "st_dev": (74,), "st_size": (1,), "st_nlink": (0, 2),
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaisesRegex(
                    cleanup.Refused, "identity or metadata changed"
                ):
                    cleanup.validate_lock(lock_info(**{field: value}), SimpleNamespace(st_dev=73))
        self.assertEqual(self.calls.mock_calls, [])

    def test_stamp_includes_every_identity_field_but_not_atime(self) -> None:
        original = lock_info()
        for field in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
                      "st_size", "st_mtime_ns", "st_ctime_ns"):
            with self.subTest(field=field):
                self.assertNotEqual(cleanup.stamp(original), cleanup.stamp(
                    changed(original, **{field: getattr(original, field) + 1})))
        self.assertEqual(cleanup.stamp(original), cleanup.stamp(changed(original, st_atime_ns=999)))


class ProcessInspectionTests(IsolatedTests):
    """Exercise the actual process scanner with synthetic status and fd data."""

    def test_ignores_self_and_non_process_entries(self) -> None:
        self.directories["/proc"] = [SimpleNamespace(name=name, path="/proc/" + name)
                                     for name in ("self", "thread-self", "123x", str(SELF_PID))]
        cleanup.require_no_users(lock_info())
        self.open.assert_not_called()
        self.os.stat.assert_not_called()
        self.os.scandir.assert_called_once_with("/proc")

    def test_all_uid_gid_slots_and_supplementary_groups_rejected(self) -> None:
        statuses = []
        for field, identity in (("Uid", "993"), ("Gid", "979")):
            for slot in range(4):
                ids = ["0"] * 4
                ids[slot] = identity
                statuses.append(SAFE_STATUS.replace(field + ":\t0\t0\t0\t0", field + ":\t" + "\t".join(ids)))
        statuses.append(SAFE_STATUS.replace("Groups:\t0", "Groups:\t0 979 1000"))
        self.add_process()
        for status in statuses:
            with self.subTest(status=status):
                self.texts["/proc/123/status"] = status
                with self.assertRaisesRegex(cleanup.Refused, "still uses the build identity"):
                    cleanup.require_no_users(lock_info())
        self.os.stat.assert_not_called()

    def test_identity_tokens_and_descriptor_device_inode_pair_are_exact(self) -> None:
        self.add_process(status="Uid: 1993 0 0 0\nGid: 1979 0 0 0\nGroups: 1979\n",
                         descriptors={"4": lock_info(st_ino=427820), "5": lock_info(st_dev=74)})
        cleanup.require_no_users(lock_info())
        self.assertEqual(self.os.stat.call_args_list, [call("/proc/123/fd/4"), call("/proc/123/fd/5")])

    def test_open_descriptor_by_unrelated_identity_rejected(self) -> None:
        self.add_process(descriptors={"4": lock_info()})
        with self.assertRaisesRegex(cleanup.Refused, "has the approved lock open"):
            cleanup.require_no_users(lock_info())
        self.os.stat.assert_called_once_with("/proc/123/fd/4")

    def test_missing_identity_fields_and_oversized_status_rejected(self) -> None:
        self.add_process()
        for field in ("Uid", "Gid", "Groups"):
            with self.subTest(field=field):
                self.texts["/proc/123/status"] = "\n".join(
                    line for line in SAFE_STATUS.splitlines() if not line.startswith(field + ":"))
                with self.assertRaisesRegex(cleanup.Refused, "identity unavailable"):
                    cleanup.require_no_users(lock_info())
        self.texts["/proc/123/status"] = SAFE_STATUS + "x" * 65537
        with self.assertRaisesRegex(cleanup.Refused, "status exceeds inspection budget"):
            cleanup.require_no_users(lock_info())

    def test_only_disappearance_errors_tolerated_at_process_boundaries(self) -> None:
        self.add_process(descriptors={"4": lock_info(st_ino=427820)})
        sites = ((self.texts, "/proc/123/status"), (self.directories, "/proc/123/fd"),
                 (self.fd_stats, "/proc/123/fd/4"))
        for mapping, path in sites:
            for code in (errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM, errno.EIO,
                         errno.ENOTDIR, errno.ELOOP):
                failure = OSError(code, "synthetic failure")
                with self.subTest(path=path, errno=code), patch.dict(mapping, {path: failure}):
                    if code in (errno.ENOENT, errno.ESRCH):
                        cleanup.require_no_users(lock_info())
                    else:
                        with self.assertRaises(OSError) as caught:
                            cleanup.require_no_users(lock_info())
                        self.assertIs(caught.exception, failure)

    def test_status_read_errors_follow_the_same_fail_closed_rule(self) -> None:
        self.add_process()
        for code in (errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM, errno.EIO):
            with self.subTest(errno=code):
                stream = Mock()
                stream.read.side_effect = OSError(code, "synthetic read failure")
                self.open.side_effect = lambda path, stream=stream: nullcontext(stream)
                if code in (errno.ENOENT, errno.ESRCH):
                    cleanup.require_no_users(lock_info())
                else:
                    with self.assertRaises(OSError) as caught:
                        cleanup.require_no_users(lock_info())
                    self.assertEqual(caught.exception.errno, code)
                stream.read.assert_called_once_with(65537)

    def test_missing_process_does_not_skip_later_active_process(self) -> None:
        self.add_process(pid=123)
        self.add_process(pid=124, status=SAFE_STATUS.replace("Uid:\t0", "Uid:\t993", 1))
        self.texts["/proc/123/status"] = FileNotFoundError(errno.ENOENT, "exited")
        with self.assertRaisesRegex(cleanup.Refused, "still uses the build identity"):
            cleanup.require_no_users(lock_info())
        self.assertEqual(self.open.call_args_list, [call("/proc/123/status"), call("/proc/124/status")])

    def test_missing_descriptor_does_not_skip_later_open_lock(self) -> None:
        self.add_process(descriptors={"4": ProcessLookupError(errno.ESRCH, "gone"), "5": lock_info()})
        with self.assertRaisesRegex(cleanup.Refused, "has the approved lock open"):
            cleanup.require_no_users(lock_info())
        self.assertEqual(self.os.stat.call_args_list, [call("/proc/123/fd/4"), call("/proc/123/fd/5")])

    def test_top_level_proc_failure_is_never_a_disappearing_process(self) -> None:
        for code in (errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM):
            with self.subTest(errno=code):
                self.directories["/proc"] = OSError(code, "proc unavailable")
                with self.assertRaises(OSError) as caught:
                    cleanup.require_no_users(lock_info())
                self.assertEqual(caught.exception.errno, code)


class InstallationHostTests(IsolatedTests):
    """Model only the existing installer inode and its fixed parent chain."""

    def setUp(self) -> None:
        super().setUp()
        self.installation_info: dict[int, SimpleNamespace | OSError] = {
            fd: lock_info(st_ino=fd, st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)
            for fd in (VAR_FD, LIB_FD, SETUP_FD)
        }
        self.installation_info[INSTALL_FD] = lock_info(
            st_ino=800, st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_size=17)
        self.reset_installation()

    def reset_installation(self) -> None:
        """Reset mock call state between table cases, never create a real lock."""
        self.calls.reset_mock()
        self.installation_held = False
        self.os.open.side_effect = list(INSTALL_FDS)
        self.os.fstat.side_effect = lambda fd: outcome(self.installation_info[fd])
        self.os.close.side_effect = self.close_installation_descriptor
        self.fcntl.flock.side_effect = self.acquire_installation

    def acquire_installation(self, fd: int, operation: int) -> None:
        """Track the scope of the nonblocking exclusive installer flock."""
        self.assertEqual((fd, operation), (INSTALL_FD, self.fcntl.LOCK_EX | self.fcntl.LOCK_NB))
        self.assertFalse(self.installation_held)
        self.installation_held = True

    def close_installation_descriptor(self, fd: int) -> None:
        """Closing the fake installer descriptor releases only the fake lock."""
        self.assertIn(fd, INSTALL_FDS)
        if fd == INSTALL_FD:
            self.installation_held = False
        else:
            self.assertFalse(self.installation_held)

    def installation_opens(self) -> list[object]:
        """Pin every opened component and its read-only, no-follow flags."""
        flags = self.os.O_RDONLY | self.os.O_DIRECTORY | self.os.O_NOFOLLOW | self.os.O_CLOEXEC
        return [call("/", flags), call("var", flags, dir_fd=ROOT_FD),
                call("lib", flags, dir_fd=VAR_FD), call("outpost-setup", flags, dir_fd=LIB_FD),
                call("install.lock", self.os.O_RDONLY | self.os.O_NOFOLLOW | self.os.O_CLOEXEC | self.os.O_NOATIME,
                     dir_fd=SETUP_FD)]

    def assert_installation_closed(self, opened: tuple[int, ...] = INSTALL_FDS) -> None:
        """Every successfully opened descriptor must close in reverse order."""
        self.assertEqual(self.os.close.call_args_list, [call(fd) for fd in reversed(opened)])
        self.assertFalse(self.installation_held)
        self.os.unlink.assert_not_called()
        self.os.fsync.assert_not_called()


class InstallationLockTests(InstallationHostTests):
    """Check the installer lock without opening any actual protected path."""

    def test_existing_inode_opened_read_only_and_held_until_context_exit(self) -> None:
        with cleanup.installation_lock():
            self.assertTrue(self.installation_held)
            self.os.close.assert_not_called()
        self.assertEqual(self.os.open.call_args_list, self.installation_opens())
        self.assertEqual(self.os.fstat.call_args_list, [call(fd) for fd in INSTALL_FDS[1:]])
        self.fcntl.flock.assert_called_once_with(INSTALL_FD, self.fcntl.LOCK_EX | self.fcntl.LOCK_NB)
        self.fcntl.lockf.assert_not_called()
        self.os.stat.assert_not_called()
        self.assert_installation_closed()

    def test_each_parent_rejects_wrong_type_owner_or_group_world_writability(self) -> None:
        changes = [{"st_uid": 993}] + [{"st_mode": mode} for mode in (
            stat.S_IFREG | 0o755, stat.S_IFLNK | 0o755, stat.S_IFIFO | 0o755,
            stat.S_IFDIR | 0o775, stat.S_IFDIR | 0o757, stat.S_IFDIR | 0o1777,
        )]
        for fd in (VAR_FD, LIB_FD, SETUP_FD):
            for change in changes:
                self.reset_installation()
                original: SimpleNamespace = outcome(self.installation_info[fd])
                with self.subTest(fd=fd, change=change), patch.dict(
                    self.installation_info, {fd: changed(original, **change)}
                ), self.assertRaisesRegex(cleanup.Refused, "parent is not protected"), cleanup.installation_lock():
                    self.fail("Unsafe parent allowed entry")
                opened = INSTALL_FDS[:INSTALL_FDS.index(fd) + 1]
                self.assertEqual(self.os.open.call_args_list, self.installation_opens()[:len(opened)])
                self.fcntl.flock.assert_not_called()
                self.assert_installation_closed(opened)

    def test_lock_rejects_wrong_type_owner_writable_mode_or_link_count(self) -> None:
        changes = [{"st_uid": 993}, {"st_nlink": 0}, {"st_nlink": 2}]
        changes += [{"st_mode": mode} for mode in (
            stat.S_IFDIR | 0o600, stat.S_IFLNK | 0o600, stat.S_IFIFO | 0o600,
            stat.S_IFSOCK | 0o600, stat.S_IFREG | 0o620, stat.S_IFREG | 0o602,
        )]
        for change in changes:
            self.reset_installation()
            original: SimpleNamespace = outcome(self.installation_info[INSTALL_FD])
            with self.subTest(change=change), patch.dict(
                self.installation_info, {INSTALL_FD: changed(original, **change)}
            ), self.assertRaisesRegex(cleanup.Refused, "Installation lock is not protected"), cleanup.installation_lock():
                self.fail("Unsafe installer inode allowed entry")
            self.fcntl.flock.assert_not_called()
            self.assert_installation_closed()

    def test_protected_modes_and_nonempty_existing_lock_are_not_overrestricted(self) -> None:
        for parent_mode, file_mode in ((0o700, 0o400), (0o750, 0o600), (0o755, 0o644), (0o2750, 0o640)):
            self.reset_installation()
            metadata = {fd: lock_info(st_ino=fd, st_mode=stat.S_IFDIR | parent_mode, st_uid=0, st_gid=979)
                        for fd in (VAR_FD, LIB_FD, SETUP_FD)}
            metadata[INSTALL_FD] = lock_info(st_mode=stat.S_IFREG | file_mode, st_uid=0, st_gid=979, st_size=17)
            with self.subTest(parent_mode=parent_mode, file_mode=file_mode), patch.dict(
                self.installation_info, metadata
            ), cleanup.installation_lock():
                self.assertTrue(self.installation_held)
            self.assertEqual(self.os.open.call_args_list, self.installation_opens())
            self.assert_installation_closed()

    def test_missing_symlink_or_unreadable_component_fails_without_creation_or_retry(self) -> None:
        for index, fd in enumerate(INSTALL_FDS):
            for code in (errno.ENOENT, errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM):
                self.reset_installation()
                failure = OSError(code, "synthetic installer open failure")
                self.os.open.side_effect = [*INSTALL_FDS[:index], failure]
                with self.subTest(fd=fd, errno=code), self.assertRaises(OSError) as caught, cleanup.installation_lock():
                    self.fail("Unopened installer path allowed entry")
                self.assertIs(caught.exception, failure)
                self.assertEqual(self.os.open.call_args_list, self.installation_opens()[:index + 1])
                self.fcntl.flock.assert_not_called()
                self.assert_installation_closed(INSTALL_FDS[:index])

    def test_metadata_failures_close_all_opened_descriptors(self) -> None:
        for index, fd in enumerate(INSTALL_FDS[1:], start=1):
            for code in (errno.EACCES, errno.EPERM, errno.EIO):
                self.reset_installation()
                failure = OSError(code, "synthetic installer fstat failure")
                with self.subTest(fd=fd, errno=code), patch.dict(
                    self.installation_info, {fd: failure}
                ), self.assertRaises(OSError) as caught, cleanup.installation_lock():
                    self.fail("Unknown installer metadata allowed entry")
                self.assertIs(caught.exception, failure)
                self.fcntl.flock.assert_not_called()
                self.assert_installation_closed(INSTALL_FDS[:index + 1])

    def test_busy_denied_or_unsupported_flock_refuses_before_yield(self) -> None:
        for code in (errno.EAGAIN, errno.EACCES, errno.EPERM, errno.ENOSYS, errno.EIO):
            self.reset_installation()
            failure = OSError(code, "synthetic installer flock failure")
            self.fcntl.flock.side_effect = failure
            with self.subTest(errno=code), self.assertRaisesRegex(
                cleanup.Refused, "installer or reset holds the installation lock"
            ) as caught, cleanup.installation_lock():
                self.fail("Unavailable installer lock allowed entry")
            self.assertIs(caught.exception.__cause__, failure)
            self.fcntl.flock.assert_called_once_with(INSTALL_FD, self.fcntl.LOCK_EX | self.fcntl.LOCK_NB)
            self.assert_installation_closed()

    def test_context_body_failure_releases_the_lock_without_suppression(self) -> None:
        failure = RuntimeError("synthetic body failure")
        with self.assertRaises(RuntimeError) as caught, cleanup.installation_lock():
            self.assertTrue(self.installation_held)
            raise failure
        self.assertIs(caught.exception, failure)
        self.assert_installation_closed()


class MainBoundaryTests(InstallationHostTests):
    """Use the real lock context and a removal spy; every OS call stays mocked."""

    def setUp(self) -> None:
        super().setUp()
        for mock in (self.os.geteuid, self.signal.signal, self.signal.alarm,
                     self.pwd.getpwnam, self.grp.getgrnam):
            mock.side_effect = None
        self.os.geteuid.return_value = 0
        self.pwd.getpwnam.return_value = SimpleNamespace(pw_uid=993)
        self.grp.getgrnam.return_value = SimpleNamespace(gr_gid=979)
        self.remove = Mock(side_effect=self.removal)
        self.calls.attach_mock(self.remove, "remove_approved_lock")
        self.stack.enter_context(patch.object(cleanup, "remove_approved_lock", self.remove))

    def removal(self) -> int:
        """Check that removal starts while the installer descriptor is held."""
        self.assertTrue(self.installation_held)
        self.os.close.assert_not_called()
        return 0

    def assert_refuses_before_removal(self, exception: type[Exception] = cleanup.Refused,
                                     message: str = "") -> None:
        """The delegated removal must not run after any failed prerequisite."""
        with self.assertRaisesRegex(exception, message):
            cleanup.main()
        self.remove.assert_not_called()
        self.os.unlink.assert_not_called()
        self.assertFalse(self.installation_held)
        self.assertEqual(self.output.getvalue(), "")

    def test_success_holds_installer_lock_across_removal_and_cancels_alarm_last(self) -> None:
        self.assertEqual(cleanup.main(), 0)
        self.remove.assert_called_once_with()
        self.calls.assert_has_calls([
            call.fcntl_flock(INSTALL_FD, self.fcntl.LOCK_EX | self.fcntl.LOCK_NB),
            call.remove_approved_lock(), *[call.os_close(fd) for fd in reversed(INSTALL_FDS)], call.signal_alarm(0),
        ])
        self.assert_installation_closed()
        self.signal.signal.assert_called_once_with(self.signal.SIGALRM, cleanup.deadline)
        self.assertEqual(self.signal.alarm.call_args_list, [call(60), call(0)])
        self.pwd.getpwnam.assert_called_once_with("outpost-build")
        self.grp.getgrnam.assert_called_once_with("outpost-build")

    def test_approval_must_be_exact_and_cannot_supply_another_path(self) -> None:
        for args in ([], ["--yes"], [APPROVAL, "/tmp/other"], [APPROVAL, APPROVAL]):
            with self.subTest(args=args):
                self.sys.argv = [str(SCRIPT)] + args
                self.assert_refuses_before_removal(message="approval flag required")
        self.os.open.assert_not_called()
        self.signal.alarm.assert_not_called()

    def test_requires_linux_root_and_matching_named_accounts(self) -> None:
        for platform, euid, uid, gid in (("darwin", 0, 993, 979), ("linux", 501, 993, 979),
                                         ("linux", 0, 994, 979), ("linux", 0, 993, 980)):
            with self.subTest(platform=platform, euid=euid, uid=uid, gid=gid):
                self.sys.platform = platform
                self.os.geteuid.return_value = euid
                self.pwd.getpwnam.return_value.pw_uid = uid
                self.grp.getgrnam.return_value.gr_gid = gid
                self.assert_refuses_before_removal()
        self.os.open.assert_not_called()
        self.signal.alarm.assert_not_called()

    def test_missing_account_fails_before_filesystem_access(self) -> None:
        self.pwd.getpwnam.side_effect = KeyError("outpost-build")
        self.assert_refuses_before_removal(KeyError)
        self.os.open.assert_not_called()

    def test_held_installer_lock_stops_removal_and_cancels_alarm(self) -> None:
        self.fcntl.flock.side_effect = BlockingIOError(errno.EAGAIN, "installer active")
        self.assert_refuses_before_removal(message="installer or reset holds the installation lock")
        self.assert_installation_closed()
        self.signal.alarm.assert_called_with(0)

    def test_missing_installer_lock_is_not_created_and_stops_removal(self) -> None:
        self.os.open.side_effect = [*INSTALL_FDS[:-1], FileNotFoundError(errno.ENOENT, "installer lock missing")]
        self.assert_refuses_before_removal(FileNotFoundError)
        self.assertEqual(self.os.open.call_args_list, self.installation_opens())
        self.assert_installation_closed(INSTALL_FDS[:-1])
        self.fcntl.flock.assert_not_called()
        self.signal.alarm.assert_called_with(0)

    def test_unprotected_installer_parents_or_lock_stop_removal(self) -> None:
        for fd in INSTALL_FDS[1:]:
            self.reset_installation()
            original: SimpleNamespace = outcome(self.installation_info[fd])
            with self.subTest(fd=fd), patch.dict(self.installation_info, {fd: changed(original, st_uid=993)}):
                self.assert_refuses_before_removal(message="not protected")
            self.assert_installation_closed(INSTALL_FDS[:INSTALL_FDS.index(fd) + 1])
            self.signal.alarm.assert_called_with(0)

    def test_removal_exception_releases_installer_lock_and_cancels_alarm(self) -> None:
        failure = cleanup.Refused("synthetic removal refusal")

        def refuse() -> None:
            self.assertTrue(self.installation_held)
            self.os.close.assert_not_called()
            raise failure

        self.remove.side_effect = refuse
        with self.assertRaises(cleanup.Refused) as caught:
            cleanup.main()
        self.assertIs(caught.exception, failure)
        self.remove.assert_called_once_with()
        self.assert_installation_closed()
        self.signal.alarm.assert_called_with(0)
        self.assertEqual(self.output.getvalue(), "")

    def test_timeout_during_installer_acquisition_closes_descriptors_and_cancels_alarm(self) -> None:
        self.fcntl.flock.side_effect = lambda fd, operation: cleanup.deadline(0, None)
        self.assert_refuses_before_removal(message="timed out")
        self.assert_installation_closed()
        self.signal.alarm.assert_called_with(0)


class RemovalBoundaryTests(IsolatedTests):
    """Run the removal helper's real checks against an in-memory host model."""

    def setUp(self) -> None:
        super().setUp()
        self.parent = lock_info(st_ino=2, st_mode=stat.S_IFDIR | 0o1777, st_uid=0, st_gid=0)
        self.current_parent = self.parent
        self.path_info: SimpleNamespace | OSError = lock_info()
        self.descriptor_info = lock_info()
        self.removed: SimpleNamespace | None = None
        self.texts["/proc/self/mountinfo"] = "36 25 0:32 / /tmp rw - tmpfs tmpfs rw\n"
        self.os.open.side_effect = [PARENT_FD, LOCK_FD]
        self.os.stat.side_effect = self.stat_path
        self.os.fstat.side_effect = self.stat_descriptor
        self.os.unlink.side_effect = self.fake_unlink
        for mock in (self.os.fsync, self.os.close, self.fcntl.flock, self.fcntl.lockf):
            mock.side_effect, mock.return_value = None, None

    def stat_path(self, path: str, **kwargs: object) -> object:
        """Fail on any unconfigured path instead of consulting the filesystem."""
        if path == LOCK_NAME:
            self.assertEqual(kwargs, {"dir_fd": PARENT_FD, "follow_symlinks": False})
            return outcome(self.path_info)
        if path == "/tmp":
            self.assertEqual(kwargs, {"follow_symlinks": False})
            return outcome(self.current_parent)
        self.assertEqual(kwargs, {})
        return outcome(self.fd_stats[path])

    def stat_descriptor(self, fd: int) -> object:
        """Report only the two fake descriptors, never real process FDs."""
        return outcome({PARENT_FD: self.parent, LOCK_FD: self.descriptor_info}[fd])

    def fake_unlink(self, path: str, *, dir_fd: int) -> None:
        """Model pathname deletion without calling any real unlink function."""
        self.assertEqual((path, dir_fd), (LOCK_NAME, PARENT_FD))
        self.removed = outcome(self.path_info)
        self.path_info = FileNotFoundError(errno.ENOENT, "synthetically removed")
        if (self.removed.st_dev, self.removed.st_ino) == (self.descriptor_info.st_dev, self.descriptor_info.st_ino):
            self.descriptor_info = changed(self.descriptor_info, st_nlink=0)

    def assert_refuses_before_unlink(self, exception: type[Exception] = cleanup.Refused,
                                    message: str = "") -> None:
        """A failed precondition must never reach even the mocked unlink."""
        with self.assertRaisesRegex(exception, message):
            cleanup.remove_approved_lock()
        self.os.unlink.assert_not_called()
        self.os.fsync.assert_not_called()
        self.assertEqual(self.output.getvalue(), "")

    def test_success_unlinks_only_approved_name_after_checks_and_both_locks(self) -> None:
        self.assertEqual(cleanup.remove_approved_lock(), 0)
        flags = self.os
        self.assertEqual(self.os.open.call_args_list, [
            call("/tmp", flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW | flags.O_CLOEXEC),
            call(LOCK_NAME, flags.O_RDWR | flags.O_NONBLOCK | flags.O_NOFOLLOW | flags.O_CLOEXEC | flags.O_NOATIME,
                 dir_fd=PARENT_FD),
        ])
        exclusive = self.fcntl.LOCK_EX | self.fcntl.LOCK_NB
        self.calls.assert_has_calls([
            call.os_fstat(LOCK_FD), call.fcntl_flock(LOCK_FD, exclusive), call.fcntl_lockf(LOCK_FD, exclusive),
            call.os_scandir("/proc"), call.os_fstat(LOCK_FD),
            call.os_stat(LOCK_NAME, dir_fd=PARENT_FD, follow_symlinks=False),
            call.os_stat("/tmp", follow_symlinks=False), call.os_unlink(LOCK_NAME, dir_fd=PARENT_FD),
            call.os_fsync(PARENT_FD), call.os_fstat(LOCK_FD),
            call.os_stat(LOCK_NAME, dir_fd=PARENT_FD, follow_symlinks=False),
            call.os_close(LOCK_FD), call.os_close(PARENT_FD),
        ])
        self.os.unlink.assert_called_once_with(LOCK_NAME, dir_fd=PARENT_FD)

        self.assertEqual(json.loads(self.output.getvalue()), {
            "state": "removed", "path": LOCK_PATH, "inode": 427819,
            "privilegedRecheck": True, "resetStarted": False,
        })


    def test_wrong_parent_identity_rejected_and_parent_closed(self) -> None:
        self.parent = changed(self.parent, st_mode=stat.S_IFDIR | 0o777)
        self.assert_refuses_before_unlink(message="temporary directory identity")
        self.os.close.assert_called_once_with(PARENT_FD)

    def test_mountpoint_rejected(self) -> None:
        self.texts["/proc/self/mountinfo"] = f"36 25 0:32 / {LOCK_PATH} rw - tmpfs tmpfs rw\n"
        self.assert_refuses_before_unlink(message="is a mountpoint")
        self.assertEqual(self.os.open.call_count, 1)

    def test_wrong_initial_lock_rejected_before_opening_it(self) -> None:
        self.path_info = lock_info(st_ino=427820)
        self.assert_refuses_before_unlink(message="identity or metadata changed")
        self.assertEqual(self.os.open.call_count, 1)

    def test_opened_descriptor_must_match_initial_stamp(self) -> None:
        self.descriptor_info = changed(self.descriptor_info, st_ctime_ns=201)
        self.assert_refuses_before_unlink(message="changed while opening")
        self.fcntl.flock.assert_not_called()
        self.assertEqual(self.os.close.call_args_list, [call(LOCK_FD), call(PARENT_FD)])

    def test_either_lock_family_failure_stops_before_scan(self) -> None:
        for name in ("flock", "lockf"):
            for code in (errno.EAGAIN, errno.EACCES, errno.EPERM, errno.ENOSYS):
                with self.subTest(lock=name, errno=code):
                    self.os.open.side_effect = [PARENT_FD, LOCK_FD]
                    mock = getattr(self.fcntl, name)
                    mock.side_effect = OSError(code, "synthetic lock failure")
                    self.assert_refuses_before_unlink(message="cannot be exclusively locked")
                    mock.side_effect = None
        self.os.scandir.assert_not_called()

    def test_active_build_identity_stops_removal(self) -> None:
        self.add_process(status=SAFE_STATUS.replace("Groups:\t0", "Groups:\t979"))
        self.assert_refuses_before_unlink(message="still uses the build identity")
        self.assertEqual(self.os.close.call_args_list, [call(LOCK_FD), call(PARENT_FD)])

    def test_open_lock_descriptor_stops_removal(self) -> None:
        self.add_process(descriptors={"4": lock_info()})
        self.assert_refuses_before_unlink(message="has the approved lock open")

    def test_permission_failures_at_every_read_boundary_stop_removal(self) -> None:
        self.add_process(descriptors={"4": lock_info(st_ino=427820)})
        for mapping, path in ((self.texts, "/proc/self/mountinfo"), (self.directories, "/proc"),
                              (self.texts, "/proc/123/status"), (self.directories, "/proc/123/fd"),
                              (self.fd_stats, "/proc/123/fd/4")):
            for code in (errno.EACCES, errno.EPERM):
                failure = OSError(code, "synthetic permission failure")
                with self.subTest(path=path, errno=code), patch.dict(mapping, {path: failure}):
                    self.os.open.side_effect = [PARENT_FD, LOCK_FD]
                    self.assert_refuses_before_unlink(OSError)

    def test_permission_failures_on_open_and_stat_stop_removal(self) -> None:
        for name in ("open", "stat", "fstat"):
            original = getattr(self.os, name).side_effect
            for code in (errno.EACCES, errno.EPERM):
                with self.subTest(operation=name, errno=code):
                    self.os.open.side_effect = [PARENT_FD, LOCK_FD]
                    getattr(self.os, name).side_effect = OSError(code, "synthetic permission failure")
                    self.assert_refuses_before_unlink(OSError)
                    getattr(self.os, name).side_effect = original

    def test_final_descriptor_and_path_stamp_rechecked(self) -> None:
        for location in ("descriptor", "path"):
            with self.subTest(location=location):
                self.os.open.side_effect = [PARENT_FD, LOCK_FD]
                original = lock_info()
                self.path_info = self.descriptor_info = original
                self.os.fstat.side_effect = [self.parent, original,
                                             changed(original, st_mtime_ns=101) if location == "descriptor" else original]
                self.os.stat.side_effect = [original, changed(original, st_ctime_ns=201)]
                self.assert_refuses_before_unlink(message="changed during inspection")

    def test_final_parent_identity_rechecked(self) -> None:
        for field in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid"):
            with self.subTest(field=field):
                self.os.open.side_effect = [PARENT_FD, LOCK_FD]
                self.current_parent = changed(self.parent, **{field: getattr(self.parent, field) + 1})
                self.assert_refuses_before_unlink(message="Temporary directory changed")

    def test_timeout_stops_before_unlink_and_cleans_up(self) -> None:
        self.os.scandir.side_effect = lambda path: cleanup.deadline(0, None)
        self.assert_refuses_before_unlink(message="timed out")
        self.assertEqual(self.os.close.call_args_list, [call(LOCK_FD), call(PARENT_FD)])

    def test_unlink_failure_is_not_retried_or_reported_as_success(self) -> None:
        self.os.unlink.side_effect = PermissionError(errno.EPERM, "synthetic unlink failure")
        with self.assertRaises(PermissionError):
            cleanup.remove_approved_lock()
        self.os.unlink.assert_called_once_with(LOCK_NAME, dir_fd=PARENT_FD)
        self.os.fsync.assert_not_called()
        self.assertEqual(self.output.getvalue(), "")
        self.assertEqual(self.os.close.call_args_list, [call(LOCK_FD), call(PARENT_FD)])

    def test_fsync_failure_after_unlink_is_not_retried(self) -> None:
        self.os.fsync.side_effect = OSError(errno.EIO, "synthetic fsync failure")
        with self.assertRaises(OSError):
            cleanup.remove_approved_lock()
        self.os.unlink.assert_called_once_with(LOCK_NAME, dir_fd=PARENT_FD)
        self.assertIsNotNone(self.removed)
        self.assertEqual(self.output.getvalue(), "")

    def test_recreated_path_after_unlink_is_not_removed_again(self) -> None:
        def recreate(path: str, *, dir_fd: int) -> None:
            self.fake_unlink(path, dir_fd=dir_fd)
            self.path_info = lock_info(st_ino=427820)

        self.os.unlink.side_effect = recreate
        with self.assertRaisesRegex(cleanup.Refused, "path was recreated; no automatic retry"):
            cleanup.remove_approved_lock()
        self.os.unlink.assert_called_once_with(LOCK_NAME, dir_fd=PARENT_FD)
        self.assertEqual(self.output.getvalue(), "")

    def test_manual_replacement_at_unlink_is_detected_only_after_removal(self) -> None:
        """Document the excluded parallel-manual-mutation case, not a blocker."""
        replacement = lock_info(st_ino=427820)

        def replace_then_unlink(path: str, *, dir_fd: int) -> None:
            self.path_info = replacement
            self.fake_unlink(path, dir_fd=dir_fd)

        self.os.unlink.side_effect = replace_then_unlink
        with self.assertRaisesRegex(cleanup.Refused, "Unlink outcome requires inspection"):
            cleanup.remove_approved_lock()
        self.assertIs(self.removed, replacement)
        self.assertEqual(self.descriptor_info.st_nlink, 1)
        self.os.unlink.assert_called_once_with(LOCK_NAME, dir_fd=PARENT_FD)
        self.assertEqual(self.output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
