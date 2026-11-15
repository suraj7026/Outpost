"""One approved Node cache removal; no reset, network, or installed-code imports.

The trusted loader must verify the UV helper against SAFETY_SHA256 and inject it
as outpost2_cleanup_safety before loading this source. Its presence alone is not
hash verification. Trusted root, an idle host and no parallel manual mutation
are operational prerequisites; Linux provides no inode-conditional unlink.
"""
from __future__ import annotations

import errno
import fcntl
import grp
import json
import os
import pwd
import re
import signal
import stat
import sys
from contextlib import ExitStack
from dataclasses import dataclass

SAFETY_SHA256 = "da99c1d4d53f26fbf37f42452ed5b7a31ddd01bb6aa23e793a75db7f1d33b2f2"
_safety = sys.modules.get("outpost2_cleanup_safety")
if _safety is None:
    raise SystemExit("Verified outpost2_cleanup_safety injection required; no filesystem import attempted.")
Refused = _safety.Refused
require = _safety.require
stamp = _safety.stamp
installation_lock = _safety.installation_lock

CACHE_NAME = "node-compile-cache"
CACHE_PATH = "/tmp/" + CACHE_NAME
EXPECTED_INODE = 427044
APPROVAL = "--approved-surajhomeserver2-node-cache-removal"
VERSION = re.compile(r"v24\.22\.1-x64-[0-9a-f]{8}(?:-[0-9]+)?", re.ASCII)
CACHE_FILE = re.compile(r"[0-9a-f]{8}", re.ASCII)
MAX_VERSIONS = 16
MAX_FILES = 4096
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_MOUNT_BYTES = 4 * 1024 * 1024
MAX_PROCESSES = 10000
MAX_REFERENCES = 200000
TIMEOUT_SECONDS = 60
GONE = (errno.ENOENT, errno.ESRCH)


@dataclass
class Entry:
    """An inventoried cache inode held open until the operation finishes."""

    name: str
    parent: int
    fd: int
    info: os.stat_result
    children: tuple[str, ...] | None = None


def metadata_refusal(reason: str, info: os.stat_result) -> None:
    """Report fixed labels and numeric metadata, never untrusted names or data."""
    details = {"mode": oct(info.st_mode), "uid": info.st_uid, "gid": info.st_gid,
               "inode": info.st_ino, "dev": info.st_dev, "links": info.st_nlink, "bytes": info.st_size}
    raise Refused(reason + ": " + json.dumps(details, sort_keys=True))


def validate(info: os.stat_result, device: int, kind: str) -> None:
    """Allow only the observed root and conservative Node-generated entries."""
    valid = info.st_dev == device and info.st_uid == 993 and info.st_gid == 979 and info.st_size >= 0
    if kind == "root":
        valid = valid and (info.st_mode, info.st_ino, info.st_nlink, info.st_size) == (
            stat.S_IFDIR | 0o700, EXPECTED_INODE, 3, 60)
    elif kind == "version":
        valid = valid and info.st_mode in (stat.S_IFDIR | 0o700, stat.S_IFDIR | 0o755) and info.st_nlink == 2
    else:
        valid = valid and info.st_mode in (stat.S_IFREG | 0o600, stat.S_IFREG | 0o644)
        valid = valid and info.st_nlink == 1 and info.st_size <= MAX_FILE_BYTES
    if not valid:
        metadata_refusal("Cache " + kind + " metadata refused", info)


def names(fd: int, limit: int) -> tuple[str, ...]:
    """Bound directory enumeration without following any entry."""
    result = []
    with os.scandir(fd) as entries:
        for entry in entries:
            require(len(result) < limit, "Cache directory entry budget exceeded.")
            require(entry.name not in (".", "..") and "/" not in entry.name, "Invalid directory entry.")
            result.append(entry.name)
    require(len(set(result)) == len(result), "Duplicate directory entry during inspection.")
    return tuple(sorted(result))


def open_entry(owned: ExitStack, parent: int, name: str, info: os.stat_result, directory: bool) -> Entry:
    """Open the verified inode without creation/truncation and hold its locks."""
    flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME | os.O_NONBLOCK
    flags |= os.O_RDONLY | os.O_DIRECTORY if directory else os.O_RDWR
    fd = os.open(name, flags, dir_fd=parent)
    owned.callback(os.close, fd)
    require(stamp(os.fstat(fd)) == stamp(info), "Cache entry changed while opening.")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not directory:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        raise Refused("Cache entry cannot be exclusively locked.") from error
    return Entry(name, parent, fd, info)


def inventory(owned: ExitStack, parent: int, initial: os.stat_result, device: int) -> list[Entry]:
    """Inventory the fixed Node layout; descriptor exhaustion refuses before mutation."""
    validate(initial, device, "root")
    root = open_entry(owned, parent, CACHE_NAME, initial, True)
    root.children = names(root.fd, MAX_VERSIONS)
    require(initial.st_nlink == 2 + len(root.children), "Cache root link count does not match its layout.")
    entries = [root]
    file_count = byte_count = 0
    for name in root.children:
        info = os.stat(name, dir_fd=root.fd, follow_symlinks=False)
        if len(name) > 128 or VERSION.fullmatch(name) is None:
            metadata_refusal("Unexpected cache version layout", info)
        validate(info, device, "version")
        version = open_entry(owned, root.fd, name, info, True)
        version.children = names(version.fd, MAX_FILES)
        entries.append(version)
        for filename in version.children:
            info = os.stat(filename, dir_fd=version.fd, follow_symlinks=False)
            if CACHE_FILE.fullmatch(filename) is None:
                metadata_refusal("Unexpected cache file layout", info)
            validate(info, device, "file")
            file_count += 1
            byte_count += info.st_size
            require(file_count <= MAX_FILES and byte_count <= MAX_TOTAL_BYTES, "Cache inventory budget exceeded.")
            entries.append(open_entry(owned, version.fd, filename, info, False))
    return entries


def require_no_mounts() -> None:
    """Reject mounts at or below the cache, including escaped mountinfo paths."""
    with open("/proc/self/mountinfo", encoding="utf-8") as stream:
        text = stream.read(MAX_MOUNT_BYTES + 1)
    require(0 < len(text) <= MAX_MOUNT_BYTES, "Mount inventory unavailable or over budget.")
    for line in text.splitlines():
        fields = line.split()
        require(len(fields) >= 10 and "-" in fields[6:], "Malformed mount inventory.")
        path = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
        require(path.startswith("/"), "Malformed mount path.")
        require(path != CACHE_PATH and not path.startswith(CACHE_PATH + "/"), "Mount at or below approved cache.")


def require_no_users(identities: set[tuple[int, int]]) -> None:
    """Inspect identities and fd/cwd/root/exe targets without reading argv/data."""
    processes = references = 0

    def inspect(path: str) -> None:
        nonlocal references
        references += 1
        require(references <= MAX_REFERENCES, "Process reference budget exceeded.")
        try:
            info = os.stat(path)
        except OSError as error:
            if error.errno in GONE:
                return
            raise
        require((info.st_dev, info.st_ino) not in identities, "A process references an inventoried cache inode.")

    with os.scandir("/proc") as processes_dir:
        for process in processes_dir:
            if not process.name.isdecimal() or int(process.name) == os.getpid():
                continue
            processes += 1
            require(processes <= MAX_PROCESSES, "Process inspection budget exceeded.")
            try:
                with open(process.path + "/status", encoding="utf-8") as stream:
                    text = stream.read(65537)
                require(len(text) <= 65536, "Process status budget exceeded.")
                fields = {}
                for line in text.splitlines():
                    key, separator, value = line.partition(":")
                    if separator and key in ("Uid", "Gid", "Groups"):
                        require(key not in fields, "Duplicate process identity field.")
                        fields[key] = value.split()
                require(set(fields) == {"Uid", "Gid", "Groups"}, "Process identity unavailable.")
                require(len(fields["Uid"]) == len(fields["Gid"]) == 4
                        and all(value.isascii() and value.isdecimal() for values in fields.values() for value in values),
                        "Malformed process identity.")
                require(993 not in map(int, fields["Uid"]) and 979 not in map(int, fields["Gid"])
                        and 979 not in map(int, fields["Groups"]), "A process still uses the build identity.")
                for name in ("cwd", "root", "exe"):
                    inspect(process.path + "/" + name)
                with os.scandir(process.path + "/fd") as descriptors:
                    for descriptor in descriptors:
                        inspect(descriptor.path)
            except OSError as error:
                if error.errno not in GONE:
                    raise


def anchor(info: os.stat_result) -> tuple[int, ...]:
    """Directory attributes unaffected by this operation's child deletions."""
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid


def check_parent(fd: int, initial: os.stat_result) -> None:
    """Bind /tmp's current pathname and held descriptor to the approved parent."""
    require(anchor(os.fstat(fd)) == anchor(initial)
            and anchor(os.stat("/tmp", follow_symlinks=False)) == anchor(initial), "Temporary directory changed.")


def recheck(entries: list[Entry]) -> None:
    """Compare every identity and complete listing before any mutation."""
    for entry in entries:
        require(stamp(os.fstat(entry.fd)) == stamp(entry.info)
                and stamp(os.stat(entry.name, dir_fd=entry.parent, follow_symlinks=False)) == stamp(entry.info),
                "Cache metadata changed during inspection.")
        if entry.children is not None:
            require(names(entry.fd, MAX_VERSIONS if entry is entries[0] else MAX_FILES) == entry.children,
                    "Cache listing changed during inspection.")


def require_absent(parent: int, name: str) -> None:
    """Never reinterpret errors or recreation as a successful removal."""
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError as error:
        if error.errno == errno.ENOENT:
            return
        raise
    raise Refused("Cache pathname exists after removal/absence check; inspect before any manual retry.")


def delete_inventoried(entries: list[Entry], parent: int, parent_info: os.stat_result) -> None:
    """Delete only held, rechecked entries; never recurse into discovered names."""
    directories = {entry.fd: entry for entry in entries if entry.children is not None}
    for entry in reversed(entries):
        check_parent(parent, parent_info)
        for directory in directories.values():
            if directory.fd == entry.parent or directory is entries[0]:
                require(anchor(os.fstat(directory.fd)) == anchor(directory.info)
                        and anchor(os.stat(directory.name, dir_fd=directory.parent, follow_symlinks=False)) == anchor(directory.info),
                        "Cache directory anchor changed; outcome uncertain.")
        current = os.stat(entry.name, dir_fd=entry.parent, follow_symlinks=False)
        if entry.children is None:
            require(stamp(current) == stamp(entry.info) and stamp(os.fstat(entry.fd)) == stamp(entry.info),
                    "Cache file changed before unlink; outcome uncertain.")
            # The installer lock and idle-host checks exclude cooperating writers,
            # not hostile root or parallel manual pathname mutation.
            os.unlink(entry.name, dir_fd=entry.parent)
        else:
            require(anchor(current) == anchor(entry.info) and not names(entry.fd, MAX_FILES),
                    "Cache directory not empty or changed; outcome uncertain.")
            os.rmdir(entry.name, dir_fd=entry.parent)
        os.fsync(entry.parent)
        require(os.fstat(entry.fd).st_nlink == 0, "Removal link count uncertain; inspect before any manual retry.")
        require_absent(entry.parent, entry.name)


def remove_cache() -> dict[str, object]:
    """Inventory, check twice, and remove the one fixed approved cache tree."""
    with ExitStack() as owned:
        parent = os.open("/tmp", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME)
        owned.callback(os.close, parent)
        parent_info = os.fstat(parent)
        require(parent_info.st_mode == stat.S_IFDIR | 0o1777 and parent_info.st_uid == parent_info.st_gid == 0,
                "Unexpected temporary directory identity.")
        require_no_mounts()
        try:
            initial = os.stat(CACHE_NAME, dir_fd=parent, follow_symlinks=False)
        except OSError as error:
            if error.errno != errno.ENOENT:
                raise
            require_no_users(set())
            require_no_mounts()
            check_parent(parent, parent_info)
            require_absent(parent, CACHE_NAME)
            return {"state": "absent", "path": CACHE_PATH, "directories": 0, "files": 0, "bytes": 0, "resetStarted": False}
        entries = inventory(owned, parent, initial, parent_info.st_dev)
        recheck(entries)
        require_no_users({(entry.info.st_dev, entry.info.st_ino) for entry in entries})
        require_no_mounts()
        check_parent(parent, parent_info)
        recheck(entries)
        result = {"state": "removed", "path": CACHE_PATH, "inode": EXPECTED_INODE,
                  "directories": sum(entry.children is not None for entry in entries),
                  "files": sum(entry.children is None for entry in entries),
                  "bytes": sum(entry.info.st_size for entry in entries if entry.children is None), "resetStarted": False}
        delete_inventoried(entries, parent, parent_info)
        return result


def deadline(_signum: int, _frame: object) -> None:
    """A timeout may occur after mutation; never suggest an automatic retry."""
    raise Refused("Cache operation timed out; state requires inspection before any manual retry.")


def main() -> int:
    """Require cache-only approval and serialize with the verified installer lock."""
    require(sys.argv[1:] == [APPROVAL], "Explicit cache-only approval flag required.")
    require(sys.platform == "linux" and os.geteuid() == 0, "Linux administrator authorization required.")
    account = pwd.getpwnam("outpost-build")
    require(account.pw_uid == 993 and account.pw_gid == 979 and grp.getgrnam("outpost-build").gr_gid == 979,
            "Dedicated build account mapping changed.")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(TIMEOUT_SECONDS)
    try:
        with installation_lock():
            result = remove_cache()
    finally:
        signal.alarm(0)
    print(json.dumps(result, sort_keys=True))
    return 0


def entrypoint() -> int:
    """Keep OS paths, process details and raw exception messages out of output."""
    try:
        return main()
    except Refused as error:
        reason = str(error)
    except (OSError, KeyError, ValueError, OverflowError):
        reason = "Cache inspection/removal failed; inspect state before any manual retry."
    print(json.dumps({"state": "refused_or_uncertain", "reason": reason, "resetStarted": False}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(entrypoint())
