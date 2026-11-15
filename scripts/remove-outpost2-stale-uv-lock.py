"""One approved lock unlink; no generic paths, credentials, or reset bypasses."""
from __future__ import annotations

import errno
import fcntl
import json
import os
from contextlib import ExitStack, contextmanager
from collections.abc import Iterator
import pwd
import grp
import signal
import stat
import sys

LOCK_NAME = "uv-ba3c823b32647ae1.lock"
LOCK_PATH = "/tmp/" + LOCK_NAME
EXPECTED_INODE = 427819
APPROVAL = "--approved-surajhomeserver2-lock-removal"


class Refused(Exception):
    """A fixed, credential-free safety failure."""


def require(condition: bool, reason: str) -> None:
    """Stop before unlink whenever a required observation is unavailable."""
    if not condition:
        raise Refused(reason)


def stamp(info: os.stat_result) -> tuple[int, ...]:
    """Compare identity and metadata without access-time noise."""
    return tuple(getattr(info, key) for key in (
        "st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    ))


def validate_lock(info: os.stat_result, parent: os.stat_result) -> None:
    """Accept only the previously inspected empty, singly linked build lock."""
    require(
        info.st_mode == stat.S_IFREG | 0o666
        and info.st_uid == 993 and info.st_gid == 979
        and info.st_size == 0 and info.st_nlink == 1
        and info.st_ino == EXPECTED_INODE and info.st_dev == parent.st_dev,
        "Approved lock identity or metadata changed; nothing removed.",
    )


def require_no_users(info: os.stat_result) -> None:
    """Check build identities and all other host processes' open descriptors."""
    processes = descriptors = 0
    with os.scandir("/proc") as entries:
        for entry in entries:
            if not entry.name.isdecimal() or int(entry.name) == os.getpid():
                continue
            processes += 1
            require(processes <= 10000, "Process inspection budget exceeded.")
            try:
                with open(entry.path + "/status") as stream:
                    text = stream.read(65537)
                require(len(text) <= 65536, "Process status exceeds inspection budget.")
                fields = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
                require(all(key in fields for key in ("Uid", "Gid", "Groups")), "Process identity unavailable.")
                require("993" not in fields["Uid"].split()
                        and "979" not in fields["Gid"].split()
                        and "979" not in fields["Groups"].split(),
                        "A process still uses the build identity; nothing removed.")
                with os.scandir(entry.path + "/fd") as files:
                    for opened in files:
                        descriptors += 1
                        require(descriptors <= 200000, "Descriptor inspection budget exceeded.")
                        try:
                            other = os.stat(opened.path)
                        except OSError as error:
                            if error.errno in (errno.ENOENT, errno.ESRCH):
                                continue
                            raise
                        require((other.st_dev, other.st_ino) != (info.st_dev, info.st_ino),
                                "Another process has the approved lock open; nothing removed.")
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ESRCH):
                    raise


def deadline(_signum: int, _frame: object) -> None:
    """Bound the privileged inspection without retrying it."""
    raise Refused("Privileged inspection timed out; verify file state before retrying.")


@contextmanager
def installation_lock() -> Iterator[None]:
    """Serialize cooperating installers without creating or rewriting their lock."""
    with ExitStack() as owned:
        parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        owned.callback(os.close, parent)
        for name in ("var", "lib", "outpost-setup"):
            parent = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            owned.callback(os.close, parent)
            info = os.fstat(parent)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                    "Installation lock parent is not protected.")
        descriptor = os.open("install.lock", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME, dir_fd=parent)
        owned.callback(os.close, descriptor)
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022,
                "Installation lock is not protected.")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise Refused("An installer or reset holds the installation lock; nothing removed.") from error
        yield


def main() -> int:
    """Require explicit approval and exclude cooperating installer activity."""
    require(sys.argv[1:] == [APPROVAL], "Explicit one-file approval flag required.")
    require(sys.platform == "linux" and os.geteuid() == 0, "Linux administrator authorization required.")
    require(pwd.getpwnam("outpost-build").pw_uid == 993
            and grp.getgrnam("outpost-build").gr_gid == 979,
            "Dedicated build identity changed.")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(60)
    try:
        with installation_lock():
            return remove_approved_lock()
    finally:
        signal.alarm(0)


def remove_approved_lock() -> int:
    """Hold both lock families; the administrator must also keep this host idle."""
    parent_fd = os.open("/tmp", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        parent = os.fstat(parent_fd)
        require(parent.st_mode == stat.S_IFDIR | 0o1777 and parent.st_uid == parent.st_gid == 0,
                "Unexpected temporary directory identity.")
        with open("/proc/self/mountinfo") as stream:
            require(all(line.split()[4] != LOCK_PATH for line in stream), "Approved lock is a mountpoint.")
        initial = os.stat(LOCK_NAME, dir_fd=parent_fd, follow_symlinks=False)
        validate_lock(initial, parent)
        descriptor = os.open(LOCK_NAME, os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME,
                             dir_fd=parent_fd)
        try:
            require(stamp(os.fstat(descriptor)) == stamp(initial), "Approved lock changed while opening.")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise Refused("Approved lock cannot be exclusively locked; nothing removed.") from error
            require_no_users(initial)
            require(stamp(os.fstat(descriptor)) == stamp(initial)
                    and stamp(os.stat(LOCK_NAME, dir_fd=parent_fd, follow_symlinks=False)) == stamp(initial),
                    "Approved lock changed during inspection.")
            current_parent = os.stat("/tmp", follow_symlinks=False)
            require((current_parent.st_dev, current_parent.st_ino, current_parent.st_mode, current_parent.st_uid, current_parent.st_gid)
                    == (parent.st_dev, parent.st_ino, parent.st_mode, parent.st_uid, parent.st_gid),
                    "Temporary directory changed during inspection.")
            # Linux has no inode-conditional unlink. Sticky /tmp, idle build identities,
            # the installer lock and held file locks exclude normal competing writers;
            # these checks cannot protect against a concurrent hostile administrator.
            os.unlink(LOCK_NAME, dir_fd=parent_fd)
            os.fsync(parent_fd)
            require(os.fstat(descriptor).st_nlink == 0, "Unlink outcome requires inspection.")
            try:
                os.stat(LOCK_NAME, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise Refused("Approved lock path was recreated; no automatic retry.")
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)
    print(json.dumps({"state": "removed", "path": LOCK_PATH, "inode": EXPECTED_INODE,
                      "privilegedRecheck": True, "resetStarted": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refused as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except (OSError, KeyError, ValueError):
        print("Privileged check or unlink failed; inspect before retrying. No reset started.", file=sys.stderr)
        raise SystemExit(1)
