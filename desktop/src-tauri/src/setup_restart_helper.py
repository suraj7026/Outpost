"""Desktop-bundled native reset boundary; never import or execute installed code.

Wire: one UTF-8 JSON object terminated by EOF (<=16 KiB), no argv. Exact fields:
mode, resetId, expected:{operationId,environmentId,releaseId,sha256,size,deviceId,
publicKey}; apply additionally requires snapshotDigest (64 lowercase hex digits).
recover_review uses the base fields; recover_apply also requires recoveryToken
(64 lowercase hex digits). Only successful recover_review adds recoveryToken to
its review response. Recovery preparation is durable metadata, not deletion intent.
Review returns schemaVersion/identities/resetId/snapshotDigest/paths/services/
accounts/preserved/warnings/blockers/canReset/state/completedSteps/totalSteps.
Apply/status return schemaVersion/identities/resetId/state/message. Stop succeeds
with no stdout; it requests cooperative cancellation, NOT confirmed inactivity.
Malformed/unauthorized requests and failed stop exit 1 with a fixed stderr line;
valid review/apply/status results exit 0, including blocked/unknown/failed results.
No passwords, caller paths, owner overrides or commands are accepted on the wire.

A complete receipt is replayable only for the same expected identity and snapshot.
An incomplete/missing receipt in an existing reset directory is a recovery hold,
including under a different reset ID. Status reads only public metadata, not the
original request, archive or private audit. Native Rust owns authorization, expiry,
host confirmation, connection fencing and the decision to start a NEW install.

Production invocation must use /usr/bin/python3 -I -S with this bundled source
(e.g. -c), not a helper from the installed tree. Isolation must be selected BEFORE
Python starts, to exclude user modules, PYTHONPATH and site startup code. Requires
Linux, root for every mode except status, and the installer's systemd layout.
Timeouts include stdin (10s); review/apply and their recovery variants use 120/300
seconds, and stop/status use 30/10 seconds. Native, configuration
and deletion phases retain independent 500,000-node limits; read-only external
identity scans have 2,000,000 nodes each. Pre-intent external inventory reserves
four nodes for the reset receipts (five for recovery, including recovery.json). Occupied stage-0/1 scope has no creation proof and
requires manual recovery. Linked unit declarations are read-only audited through
bounded, root-protected chains; they never expand cleanup scope. Unavailable POSIX
ACL audits fail closed, except explicit kernel non-support on descriptor-verified
memory/device filesystems. The updated installer independently enforces reset holds.
The injected root descriptor, runner, ACL reader and account database are test-only APIs.
"""
from __future__ import annotations

import base64
import errno
import fcntl
import grp
import gzip
import hashlib
import io
import json
import os
import posixpath
import pwd
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import BinaryIO, NoReturn, Protocol

ROOTS = ("/opt/outpost-native", "/etc/outpost-native", "/var/lib/outpost-native")
BASE = "/var/lib/outpost-setup"
OPERATIONS = BASE + "/operations"
RESETS = BASE + "/resets"
UNIT_DIR = "/etc/systemd/system"
UNITS = tuple("outpost-native-" + name + ".service" for name in ("worker", "coordinator", "host"))
USERS = ("outpost-coord", "outpost-pi", "outpost-build")
GROUPS = (*USERS, "outpost-workspaces")
IDENTITIES = ("operationId", "environmentId", "releaseId")
EXPECTED = {*IDENTITIES, "sha256", "size", "deviceId", "publicKey"}
MAX_INPUT = 16 * 1024
MAX_OUTPUT = 48 * 1024
# Native bounded_text/parse_result accept at most 1000 UTF-8 bytes, without controls.
MAX_DIAGNOSTIC = 1000
MAX_METADATA = 64 * 1024
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_EXPANDED = 40 * 1024 * 1024
MAX_NODES = 500_000
MAX_EXTERNAL_NODES = 2_000_000
# New entries visible to the post-scan: resets/, <resetId>/, audit.json, status.json.
# Atomic temporary files are gone before that scan. Do not credit native deletions.
RESET_RECEIPT_NODE_RESERVE = 4
RECOVERY_RECEIPT_NODE_RESERVE = 5
MAX_CGROUP = 16 * 1024
MAX_DEPTH = 128
MAX_UNIT_LINK_STEPS = 16
MAX_UNIT_PATH = 4096
MAX_UNIT_INSTANCES = 256
MAX_UNIT_REFERENCES = 4096
ACTIVATION_KEYS = frozenset(("Wants", "Requires", "Requisite", "BindsTo", "PartOf", "Upholds", "Conflicts", "Before", "After",
                             "OnFailure", "OnSuccess", "PropagatesReloadTo", "ReloadPropagatedFrom", "PropagatesStopTo", "StopPropagatedFrom",
                             "JoinsNamespaceOf", "RequiresOverridable", "RequisiteOverridable", "WantedBy", "RequiredBy", "UpheldBy",
                             "Also", "Alias", "Sockets", "Service", "Unit", "DefaultInstance"))
IMPLICIT_INSTANCE_KEYS = ACTIVATION_KEYS - frozenset(("Alias", "Also", "Sockets", "Service", "Unit", "DefaultInstance"))
INSTANCE_LIST_COMMAND = ("/usr/bin/systemctl", "list-units", "--all", "--plain", "--no-legend", "--no-pager", "--full",
                         "--output=json", "--type=service,socket,mount,swap", "--", "*@*")
INSTANCE_PROPERTIES = ("Id", "Names", "LoadState", "FragmentPath", "SourcePath", "DropInPaths", "NeedDaemonReload",
                       "User", "Group", "SupplementaryGroups")
MODE_SECONDS = {"review": 120, "apply": 300, "recover_review": 120, "recover_apply": 300, "stop": 30, "status": 10}
PRESERVED = [OPERATIONS, "SSH settings and keys", "Tailscale", "Kubernetes", "Docker and legacy installations",
             "Shared OS packages", "All paths outside the enumerated native scope"]
WARNINGS = ["Deletes native tasks, credentials, configuration and data in the three native roots.",
            "An existing native server will go offline. This does not authorize a new installation.",
            "Original operation evidence and its build-home are retained; dedicated users are removed without deleting homes."]
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
TRAVERSE_FLAGS = getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
UV_LOCKS = ("python/.lock", "server/browser-engine/.venv/.lock")
UV_LOCK_WARNING = "Recognized generated uv lock files will be unlinked; their contents and permissions will not be changed."
HOTFIX_LAUNCHER = "server/browser-engine/launch.py"
HOTFIX_PREFIX = "browser-hotfix-"
# The one reviewed HOME-allowlist change in scripts/repair-outpost2-browser.py.
HOTFIX_ORIGINAL_SHA256 = "1b53161569e3d26424f6f6b36e565209cc639dc934056f47cb902ef998f52a00"
HOTFIX_REPLACEMENT_SHA256 = "467d6f496c9d0ab06ba10799269e13f4cf8738ea6bdb01f4293412ffa50a07b2"
HOTFIX_PROVENANCE = ("Operator-approved local HOME allowlist launcher hotfix; original bundle plus "
                     "documented hotfix, not a byte-identical release. No resume or qualification.")
HOTFIX_BACKUPS = {"launch.py": 16384, "status.json": 65536, "request.json": 16384,
                  "command.log": 8 * 1024 * 1024, "launch.log": 1024 * 1024}
HOTFIX_WARNING = ("Source is the original archive plus the recorded browser launcher hotfix, not a byte-identical release. "
                  "This is deletion provenance, not runtime verification or permission to resume installation.")


class Refused(Exception):
    """A nonsecret reason, optionally with bounded filesystem metadata, for the public protocol."""


class Deadline(Exception):
    """The bounded helper operation expired; an existing intent remains a hold."""


def require(condition: bool, message: str) -> None:
    """Fail closed without incorporating remote file contents in errors."""
    if not condition:
        raise Refused(message)


def refuse_path(reason: str, path: str, info: os.stat_result | None,
                hashes: tuple[str, str] | None = None) -> NoReturn:
    """Append escaped path/lstat metadata to a fixed reason, never file contents."""
    metadata = (f"; mode=0o{info.st_mode:o} uid={info.st_uid} gid={info.st_gid}" if info is not None
                else "; mode=unavailable uid=unavailable gid=unavailable")
    if hashes is not None:
        metadata += f"; expected_sha256={hashes[0]} current_sha256={hashes[1]}"
    budget = MAX_DIAGNOSTIC - len(reason + " path=" + metadata)
    quoted = json.dumps(path, ensure_ascii=True)
    if len(quoted) > budget:
        def shortened(keep: int) -> str:
            """Quote raw fragments separately so truncation cannot split an escape sequence."""
            return (json.dumps(path[:keep], ensure_ascii=True) + "...[truncated]..."
                    + json.dumps(path[len(path) - keep:], ensure_ascii=True))

        # Reserve the reason, metadata and digests; retain both the root and basename end.
        low, high = 0, min(len(path) // 2, budget // 2)
        while low < high:
            keep = (low + high + 1) // 2
            if len(shortened(keep)) <= budget:
                low = keep
            else:
                high = keep - 1
        quoted = shortened(low)
    raise Refused(reason + " path=" + quoted + metadata)


def encoded(value: object) -> bytes:
    """Canonical encoding for identity bindings and durable receipts."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def digest(value: object) -> str:
    """Hash canonical structured data without disclosing it."""
    return hashlib.sha256(encoded(value)).hexdigest()


def document(raw: bytes) -> dict:
    """Reject duplicate keys, nonobjects and nonfinite JSON values."""
    def pairs(items: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON fields are not allowed.")
            result[key] = value
        return result

    def constant(_value: str) -> None:
        raise Refused("Nonfinite JSON values are not allowed.")

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    require(isinstance(value, dict), "A JSON object is required.")
    return value


def identifier(value: object) -> bool:
    """Accept only canonical UUIDs, never path components supplied verbatim."""
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def hex_digest(value: object) -> bool:
    """Recognize the native plan's canonical SHA-256 encoding."""
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def systemd_logical_lines(text: str) -> list[str]:
    """Join odd trailing backslashes as spaces; comments skip, but blank lines finish a continuation."""
    text = text.removeprefix("\ufeff").replace("\r\n", "\n")
    require("\ufeff" not in text and all(ord(char) >= 32 or char in "\t\n" for char in text),
            "Unsupported configuration control characters require manual review.")
    physical = text.split("\n")
    if text.endswith("\n"):
        physical.pop()  # A terminating newline is not another empty physical line.
    result, pending = [], []
    for line in physical:
        if line.lstrip(" \t").startswith(("#", ";")):
            continue
        trailing = len(line) - len(line.rstrip("\\"))
        if trailing % 2:
            pending.append(line[:-1] + " ")
            continue
        pending.append(line)
        joined = "".join(pending)
        pending.clear()
        if joined.strip(" \t"):
            result.append(joined)
    # systemd also accepts an unfinished continuation at EOF; refuse rather than infer its intent.
    require(not pending, "Incomplete systemd line continuation requires manual recovery.")
    return result


def systemd_unit_name(value: object) -> bool:
    """Validate manager/disk unit names, not paths or systemctl arguments supplied by a caller."""
    return (isinstance(value, str) and 0 < len(value) <= 255 and value.count("@") <= 1 and not value.startswith("@")
            and re.fullmatch(r"(?:[A-Za-z0-9:_.@-]|\\x[0-9a-fA-F]{2})+\.(service|socket|mount|swap|target|timer|path|slice|scope|automount|device)", value) is not None)


def systemd_template(unit: str | None) -> tuple[str, str] | None:
    """Return a template name and its escaped instance; an empty instance denotes a generic template."""
    if unit is None or "@" not in unit:
        return None
    stem, _, suffix = unit.rpartition(".")
    prefix, _, instance = stem.partition("@")
    return prefix + "@." + suffix, instance


def systemctl_unit_names(value: str) -> list[str]:
    """Decode systemctl's quoted string-vector layer, retaining unit-name hex escapes for identity checks."""
    reason = "Systemctl unit-name list is malformed."
    require(isinstance(value, str) and len(value.encode("utf-8")) <= MAX_METADATA
            and all(ord(char) >= 32 or char == "\t" for char in value), reason)
    decoder = json.JSONDecoder()
    names, position = [], 0
    while position < len(value):
        if value[position] in " \t":
            position += 1
            continue
        if value[position] == '"':
            try:
                name, end = decoder.raw_decode(value, position)
            except (ValueError, RecursionError):
                raise Refused(reason) from None
        else:
            end = position
            while end < len(value) and value[end] not in " \t":
                end += 1
            name = value[position:end]
        require(isinstance(name, str) and systemd_unit_name(name), reason)
        require(end == len(value) or value[end] in " \t", reason)
        names.append(name)
        require(len(names) <= MAX_UNIT_INSTANCES, "Systemctl unit-name list exceeds its budget.")
        position = end
    return names


def systemd_unescape_component(value: str) -> str:
    """Decode systemd unit-name hex escapes for comparison only; never use the result as an I/O path."""
    reason = "Unsupported escaped systemd unit name requires manual review."
    result = bytearray()
    position = 0
    while position < len(value):
        char = value[position]
        if char == "\\":
            escape = value[position:position + 4]
            require(re.fullmatch(r"\\x[0-9a-fA-F]{2}", escape) is not None, reason)
            byte = bytes.fromhex(escape[2:])[0]
            # Do not infer a second escape/specifier pass or accept hidden line/token terminators.
            require(byte >= 32 and byte not in (127, ord("\\"), ord("%")), reason)
            result.append(byte)
            position += 4
        else:
            require(32 <= ord(char) < 127, reason)
            result.append(ord("/") if char == "-" else ord(char))
            position += 1
    try:
        return result.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused(reason) from None


def systemd_activation_words(value: str, *, single: bool) -> list[str]:
    """Bounded whole-item quoting with retained unit-name escapes, not shell/C-string interpretation."""
    reason = "Unsupported systemd activation syntax requires manual review."
    value = value.strip(" \t")
    word = re.compile(r'''(?:"([^"]*)"|'([^']*)'|([^ \t'"]+))(?=[ \t]|$)''')
    words = []
    position = 0
    while position < len(value):
        match = word.match(value, position)
        if match is None:
            raise Refused(reason)
        item = next(group for group in match.groups() if group is not None)
        require(0 < len(item) <= 255 and re.fullmatch(r"(?:[A-Za-z0-9:_.@%-]|\\x[0-9a-fA-F]{2})+", item) is not None, reason)
        # Accept unit-name hex escapes only for ordinary name characters, not encoded separators or specifiers.
        require(all(chr(bytes.fromhex(code)[0]) in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_.-"
                    for code in re.findall(r"\\x([0-9a-fA-F]{2})", item)), reason)
        systemd_unescape_component(item)  # Validate escapes without changing the manager's retained spelling.
        words.append(item)
        require(len(words) <= MAX_UNIT_REFERENCES, "Systemd activation references exceed their budget.")
        position = match.end()
        while position < len(value) and value[position] in " \t":
            position += 1
    require(not single or len(words) <= 1, reason)
    return words


def systemd_activation_value(word: str, unit: str | None) -> str | None:
    """Resolve only unit-name-derived specifiers; defer instance-dependent values of generic templates."""
    reason = "Unsupported systemd activation syntax requires manual review."
    specs = re.findall(r"%(.)", word)
    require(word.count("%") == len(specs) and all(spec in ("i", "n", "N", "p") for spec in specs), reason)
    if not specs:
        return word
    require(unit is not None and systemd_unit_name(unit), reason)
    if unit is None:
        raise Refused(reason)
    context = systemd_template(unit)
    stem = unit.rsplit(".", 1)[0]
    values = {"n": unit, "N": stem, "p": stem.partition("@")[0], "i": context[1] if context else None}
    if context is not None and not context[1]:
        for spec in ("i", "n", "N"):
            values[spec] = None
    if any(values[spec] is None for spec in specs):
        require(context is not None and not context[1], reason)
        return None
    return re.sub(r"%([inNp])", lambda match: values[match[1]] or "", word)


def systemd_identity_values(value: str, *, single: bool, allow_instance: bool = False) -> list[str]:
    """Parse plain identities or bounded %i substitutions for a separately verified template context."""
    reason = "Unsupported systemd identity syntax requires manual review."
    value = value.strip(" \t")
    require("\\" not in value and (allow_instance or "%" not in value), reason)
    word = re.compile(r'''(?:"([^"]*)"|'([^']*)'|([^ \t'"]+))(?=[ \t]|$)''')
    values = []
    position = 0
    while position < len(value):
        match = word.match(value, position)
        if match is None:
            raise Refused(reason)
        item = next(group for group in match.groups() if group is not None)
        templated = (allow_instance and "%i" in item and len(item) <= 255
                     and re.fullmatch(r"(?:[A-Za-z0-9_.-]|%i)+", item) is not None)
        require(templated or re.fullmatch(r"(?:0|[1-9][0-9]{0,9}|[A-Za-z_][A-Za-z0-9_.-]{0,254}[$]?)", item) is not None, reason)
        if not templated and item[0].isdigit():
            require(int(item) < 2**32 - 1, reason)
        values.append(item)
        position = match.end()
        while position < len(value) and value[position] in " \t":
            position += 1
    require(not single or len(values) <= 1, reason)
    return values


def validate(value: dict) -> dict:
    """Validate the complete wire request before opening files or starting a runner."""
    mode = value.get("mode")
    require(isinstance(mode, str) and mode in MODE_SECONDS, "Invalid reset mode.")
    extra = {"snapshotDigest", "recoveryToken"} if mode == "recover_apply" else ({"snapshotDigest"} if mode == "apply" else set())
    require(set(value) == {"mode", "resetId", "expected"} | extra,
            "Invalid reset request fields.")
    require(identifier(value["resetId"]), "Invalid reset identity.")
    expected = value["expected"]
    require(isinstance(expected, dict) and set(expected) == EXPECTED, "Invalid expected identity fields.")
    require(all(identifier(expected[key]) for key in ("operationId", "environmentId", "deviceId")), "Invalid operation identity.")
    require(isinstance(expected["releaseId"], str) and re.fullmatch(r"host-[a-f0-9]{20}", expected["releaseId"]) is not None,
            "Invalid release identity.")
    require(hex_digest(expected["sha256"]), "Invalid archive digest.")
    require(type(expected["size"]) is int and 0 < expected["size"] <= MAX_ARCHIVE, "Invalid archive size.")
    key = expected["publicKey"]
    require(isinstance(key, str) and len(key) == 44, "Invalid device key.")
    decoded = base64.b64decode(key, validate=True)
    require(len(decoded) == 32 and base64.b64encode(decoded).decode() == key, "Invalid device key.")
    if mode in ("apply", "recover_apply"):
        require(hex_digest(value["snapshotDigest"]), "Invalid snapshot digest.")
    if mode == "recover_apply":
        require(hex_digest(value["recoveryToken"]), "Invalid recovery token.")
    return value


def stamp(info: os.stat_result | None) -> list[int]:
    """Bind inode, ownership and changes, but exclude access times changed by review."""
    if info is None:
        raise Refused("A reviewed filesystem entry disappeared.")
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def beneath(path: str, parent: str) -> bool:
    """Match a component boundary, not a sibling sharing the same prefix."""
    return path == parent or path.startswith(parent + "/")


def linux_mounts() -> set[str]:
    """Include bind/file mounts as well as ordinary filesystem mount points."""
    def unescape(value: str) -> str:
        return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)

    with open("/proc/self/mountinfo", "rb") as source:
        raw = source.read(2 * 1024 * 1024 + 1)
    require(len(raw) <= 2 * 1024 * 1024, "Mount inventory exceeds its budget.")
    rows = [line.split() for line in raw.decode().splitlines()]
    require(all(len(row) > 6 for row in rows), "Mount inventory is unavailable.")
    return {unescape(row[4]) for row in rows}


def acl_references(raw: bytes) -> tuple[set[int], set[int]]:
    """Decode bounded Linux v2 POSIX ACLs, including masked/zero-permission references."""
    require(28 <= len(raw) <= MAX_METADATA and (len(raw) - 4) % 8 == 0 and struct.unpack_from("<I", raw)[0] == 2,
            "Malformed POSIX ACL audit data.")
    users, groups = set(), set()
    singleton = set()
    order = []
    ranks = {1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5}
    for tag, permissions, identity in struct.iter_unpack("<HHI", raw[4:]):
        require(tag in ranks and permissions <= 7, "Malformed POSIX ACL entry.")
        order.append(ranks[tag])
        if tag in (2, 8):
            selected = users if tag == 2 else groups
            require(identity != 0xffffffff and identity not in selected, "Malformed POSIX ACL identity.")
            selected.add(identity)
        else:
            require(identity == 0xffffffff and tag not in singleton, "Malformed POSIX ACL base entry.")
            singleton.add(tag)
    require({1, 4, 32} <= singleton and order == sorted(order) and (not (users or groups) or 16 in singleton),
            "Incomplete POSIX ACL audit data.")
    return users, groups


# Exact kernel filesystem types only: SquashFS/VFAT/nsfs have no POSIX ACL interface.
# This normalizes only a verified inode's EOPNOTSUPP, never skips its ownership or returned ACL data.
ACL_NONSUPPORT_FILESYSTEMS = frozenset({"tmpfs", "devtmpfs", "devpts", "mqueue", "hugetlbfs", "squashfs", "vfat", "nsfs"})


def linux_descriptor_filesystem(descriptor: int) -> str:
    """Bind a live descriptor to its kernel mount record, never infer from a pathname.

    Mount IDs distinguish stacked/bind mounts sharing a device. Missing/detached,
    ambiguous, changed or unreadable mount evidence is not an ACL exemption.
    """
    require(sys.platform == "linux", "POSIX ACL filesystem identity requires Linux.")

    def mount_id() -> int:
        with open(f"/proc/self/fdinfo/{descriptor}", "rb") as source:
            raw = source.read(4097)
        require(len(raw) <= 4096, "POSIX ACL descriptor metadata exceeds its budget.")
        values = [line.partition(b":")[2].strip() for line in raw.splitlines() if line.startswith(b"mnt_id:")]
        require(len(values) == 1 and re.fullmatch(rb"[0-9]+", values[0]) is not None,
                "POSIX ACL descriptor mount identity is unavailable.")
        return int(values[0])

    try:
        before = os.fstat(descriptor)
        expected_mount = mount_id()
        with open("/proc/self/mountinfo", "rb") as source:
            raw = source.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, "POSIX ACL mount inventory exceeds its budget.")
        matches = []
        for line in raw.splitlines():
            fields = line.split()
            separator = fields.index(b"-")
            require(separator >= 6 and len(fields) == separator + 4
                    and re.fullmatch(rb"[0-9]+", fields[0]) is not None
                    and re.fullmatch(rb"[0-9]+", fields[1]) is not None
                    and re.fullmatch(rb"[0-9]+:[0-9]+", fields[2]) is not None,
                    "POSIX ACL mount inventory is malformed.")
            if int(fields[0]) == expected_mount:
                matches.append((fields[2], fields[separator + 1].decode("ascii")))
        require(len(matches) == 1, "POSIX ACL descriptor mount is missing or ambiguous.")
        device, filesystem = matches[0]
        require(device == f"{os.major(before.st_dev)}:{os.minor(before.st_dev)}".encode("ascii"),
                "POSIX ACL descriptor device does not match its mount.")
        after = os.fstat(descriptor)
        require(mount_id() == expected_mount and (before.st_dev, before.st_ino, before.st_mode) == (after.st_dev, after.st_ino, after.st_mode),
                "POSIX ACL filesystem identity changed during audit.")
        return filesystem
    except (OSError, ValueError, IndexError):
        raise Refused("POSIX ACL filesystem identity is unavailable; manual recovery required.") from None


def login_scope_from_cgroup(raw: bytes) -> str | None:
    """Recognize only an exact systemd login-scope path; unsupported evidence stays bound."""
    if len(raw) > MAX_CGROUP or any(byte < 32 and byte != 10 or byte == 127 for byte in raw):
        return None
    rows = raw.splitlines()
    if not rows or len(rows) > 128:
        return None
    paths = []
    hierarchies = set()
    for row in rows:
        match = re.fullmatch(rb"([0-9]{1,10}):([a-zA-Z0-9_=,-]*):(/[^\x00-\x20\x7f]*)", row)
        if match is None or match[1] in hierarchies:
            return None
        hierarchies.add(match[1])
        if (match[1] == b"0" and match[2] == b"") or b"name=systemd" in match[2].split(b","):
            paths.append(match[3])
    if len(paths) != 1:
        return None
    scope = re.fullmatch(rb"/user\.slice/user-(?:0|[1-9][0-9]{0,19})\.slice/(session-(?:c?[1-9][0-9]{0,19})\.scope)", paths[0])
    return scope[1].decode("ascii") if scope is not None else None


def linux_login_scope() -> str | None:
    """Use bounded kernel evidence, never a caller field, environment or guessed session."""
    try:
        descriptor = os.open("/proc/self/cgroup", READ_FLAGS)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022
                    or linux_descriptor_filesystem(descriptor) != "proc"):
                return None
            raw = bytearray()
            while len(raw) <= MAX_CGROUP:
                block = os.read(descriptor, MAX_CGROUP + 1 - len(raw))
                if not block:
                    break
                raw.extend(block)
            if stamp(before) != stamp(os.fstat(descriptor)):
                return None
            return login_scope_from_cgroup(bytes(raw))
        finally:
            os.close(descriptor)
    except (OSError, Refused):
        return None


def linux_acls(descriptor: int) -> tuple[bytes | None, bytes | None]:
    """Read ACL xattrs from a pinned inode without opening devices or following user links.

    Linux fgetxattr rejects O_PATH descriptors. The kernel's /proc/self/fd magic
    link references that already-open inode even if its directory entry is renamed.
    No caller-controlled path is resolved here; callers reject symlink inodes.
    ENODATA means the requested ACL is absent. EOPNOTSUPP means absence only on
    the exact descriptor's verified allowlisted kernel filesystem. Present
    ACLs are always returned for validation; support is never cached across inodes
    or attributes. Ownership, process and mount checks are independent of this.
    """
    require(sys.platform == "linux", "POSIX ACL audit is unavailable on this platform.")
    values = []
    for name in ("system.posix_acl_access", "system.posix_acl_default"):
        try:
            raw = os.getxattr(f"/proc/self/fd/{descriptor}", name)
        except OSError as error:
            if error.errno == errno.EOPNOTSUPP:
                filesystem = linux_descriptor_filesystem(descriptor)
                require(filesystem in ACL_NONSUPPORT_FILESYSTEMS,
                        "POSIX ACL non-support is unverified for filesystem " + json.dumps(filesystem[:80], ensure_ascii=True) + ".")
            elif error.errno != errno.ENODATA:
                raise Refused("POSIX ACL audit is unavailable; manual recovery required.") from None
            values.append(None)
        else:
            require(len(raw) <= MAX_METADATA, "POSIX ACL audit exceeds its budget.")
            values.append(raw)
    return values[0], values[1]


class Files:
    """Descriptor-anchored filesystem with an injected root and mount inventory.

    The production constructor receives only an already-open '/', UID 0 and Linux
    mount inspection. No path or policy override is reachable from stdin.
    """

    def __init__(self, root_fd: int, owner: int = 0, mounts: Callable[[], set[str]] = linux_mounts,
                 mount_ids: bool = True,
                 acl_reader: Callable[[int], tuple[bytes | None, bytes | None]] = linux_acls) -> None:
        self.root_fd = root_fd
        self.owner = owner
        self.mounts = mounts
        self.mount_ids = mount_ids
        self.acl_reader = acl_reader
        self.nodes = 0
        self.node_limit = MAX_NODES
        self.phase_name = "local"

    def refuse_budget(self) -> NoReturn:
        """Report only a fixed phase label and numerical accounting, never host paths or contents."""
        raise Refused("Filesystem inventory exceeds its budget; manual review required. "
                      f"phase={self.phase_name} count={self.nodes} limit={self.node_limit}")

    def tick(self) -> None:
        """Charge one entry against the current phase's fixed allowance."""
        self.nodes += 1
        if self.nodes > self.node_limit:
            self.refuse_budget()

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        """Select a fixed internal policy and restore all accounting on exit; deadlines remain global."""
        require(type(name) is str and name in ("local", "inspection", "native-inventory", "native-deletion",
                                               "unit-configuration", "account-configuration",
                                               "external-identity-pre", "external-identity-post"),
                "Invalid filesystem inventory phase.")
        previous = self.nodes, self.node_limit, self.phase_name
        try:
            self.nodes = 0
            self.node_limit = MAX_EXTERNAL_NODES if name in ("external-identity-pre", "external-identity-post") else MAX_NODES
            self.phase_name = name
            yield
        finally:
            self.nodes, self.node_limit, self.phase_name = previous

    def protected(self, info: os.stat_result, directory: bool, private: bool = False) -> None:
        """Require trusted ancestors and immutable-to-unprivileged metadata."""
        kind = stat.S_ISDIR if directory else stat.S_ISREG
        require(kind(info.st_mode) and info.st_uid == self.owner and not info.st_mode & (0o077 if private else 0o022),
                "Unsafe path ownership, permissions or file type.")
        if not directory:
            require(info.st_nlink == 1, "Linked metadata is not trusted.")

    def parts(self, path: str) -> list[str]:
        """Internal paths must remain normalized and absolute."""
        require(path.startswith("/") and all(part not in ("", ".", "..") for part in path.split("/")[1:]),
                "Invalid internal path.")
        return path[1:].split("/")

    @contextmanager
    def directory(self, path: str, trusted: bool = True, listing: bool = False) -> Iterator[int]:
        """Open every ancestor separately; never resolve a symlink."""
        descriptor = os.dup(self.root_fd)
        try:
            if trusted:
                self.protected(os.fstat(descriptor), True)
            if path != "/":
                parts = self.parts(path)
                for index, part in enumerate(parts):
                    flags = DIR_FLAGS if listing and index == len(parts) - 1 else TRAVERSE_FLAGS
                    child = os.open(part, flags, dir_fd=descriptor)
                    os.close(descriptor)
                    descriptor = child
                    if trusted:
                        self.protected(os.fstat(descriptor), True)
            elif listing:
                child = os.open(".", DIR_FLAGS, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            yield descriptor
        finally:
            os.close(descriptor)

    @contextmanager
    def parent(self, path: str, trusted: bool = True) -> Iterator[tuple[int, str]]:
        """Anchor a basename under its checked parent."""
        self.parts(path)
        parent, _, name = path.rpartition("/")
        with self.directory(parent or "/", trusted) as descriptor:
            yield descriptor, name

    def info(self, path: str, trusted: bool = True) -> os.stat_result | None:
        """lstat only; a missing ancestor means absent, not a followed link."""
        try:
            with self.parent(path, trusted) as (parent, name):
                return os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def names(self, path: str, trusted: bool = True) -> list[str]:
        """Bound directory entry counts before allocating a sorted listing."""
        with self.directory(path, trusted, listing=True) as descriptor:
            result = []
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    self.tick()
                    result.append(entry.name)
            return sorted(result)

    def read(self, path: str, limit: int = MAX_METADATA, private: bool = False,
             trusted: bool = True) -> bytes:
        """Read checked regular files; reject changes, links and special-file opens."""
        with self.parent(path, trusted) as (parent, name):
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if trusted:
                self.protected(before, False, private)
            require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, "Unsafe or oversized file.")
            descriptor = os.open(name, READ_FLAGS, dir_fd=parent)
            try:
                require(stamp(before) == stamp(os.fstat(descriptor)), "File changed during review.")
                data = bytearray()
                while len(data) <= limit:
                    block = os.read(descriptor, min(65536, limit + 1 - len(data)))
                    if not block:
                        break
                    data.extend(block)
                require(len(data) <= limit and stamp(before) == stamp(os.fstat(descriptor)), "File changed during review.")
                return bytes(data)
            finally:
                os.close(descriptor)

    def json(self, path: str, private: bool = False) -> dict:
        """Parse bounded protected JSON."""
        return document(self.read(path, private=private))

    def link(self, path: str, trusted: bool = True) -> str:
        """Read link text, never the linked object."""
        with self.parent(path, trusted) as (parent, name):
            return os.readlink(name, dir_fd=parent)

    def no_mounts(self, paths: tuple[str, ...] | list[str]) -> None:
        """Refuse mount points at or below any cleanup/evidence root."""
        require(not any(beneath(mount, path) for mount in self.mounts() for path in paths),
                "Mounted cleanup or evidence subtree requires manual recovery.")

    def same_mount(self, parent: int, child: int) -> None:
        """Catch mount races, including same-device bind mounts, on opened directories."""
        require(os.fstat(parent).st_dev == os.fstat(child).st_dev, "Mounted native subtree is not removable.")
        if self.mount_ids:
            def mount_id(descriptor: int) -> str:
                with open(f"/proc/self/fdinfo/{descriptor}", encoding="ascii") as source:
                    rows = source.read(4096).splitlines()
                matches = [row.split(":", 1)[1].strip() for row in rows if row.startswith("mnt_id:")]
                require(len(matches) == 1, "Descriptor mount identity is unavailable.")
                return matches[0]
            require(mount_id(parent) == mount_id(child), "Bind-mounted native subtree is not removable.")

    def inventory(self, path: str, owner_check: Callable[[str, os.stat_result], None]) -> list:
        """Snapshot one native root with an independent traversal allowance."""
        with self.phase("native-inventory"):
            return self._inventory(path, owner_check)

    def _inventory(self, path: str, owner_check: Callable[[str, os.stat_result], None]) -> list:
        """Snapshot every entry without following links or opening file payloads."""
        result = []

        def visit(parent: int, name: str, current: str, depth: int) -> None:
            self.tick()
            require(depth <= MAX_DEPTH, "Native tree depth exceeds its budget.")
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            owner_check(current, info)
            row = [current, stamp(info)]
            if stat.S_ISLNK(info.st_mode):
                row.append(os.readlink(name, dir_fd=parent))
            result.append(row)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=parent)
                try:
                    require(stamp(info) == stamp(os.fstat(child)), "Native directory changed during review.")
                    self.same_mount(parent, child)
                    with os.scandir(child) as entries:
                        names = []
                        for entry in entries:
                            self.tick()
                            names.append(entry.name)
                    for item in sorted(names):
                        visit(child, item, current + "/" + item, depth + 1)
                    require(stamp(info) == stamp(os.fstat(child)), "Native directory changed during review.")
                finally:
                    os.close(child)
        with self.parent(path) as (parent, name):
            try:
                visit(parent, name, path, 0)
            except FileNotFoundError:
                require(not result, "Native tree changed during review.")
                result.append([path, None])
        return result

    def atomic(self, path: str, value: bytes, mode: int = 0o600) -> None:
        """Create a fresh inode; never truncate/chmod an existing hardlink target."""
        with self.parent(path) as (parent, name):
            temporary = ".reset-" + uuid.uuid4().hex
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
            try:
                os.fchmod(descriptor, mode)
                with os.fdopen(descriptor, "wb", closefd=False) as output:
                    output.write(value)
                    output.flush()
                    os.fsync(descriptor)
                os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                self.sync(parent)
            finally:
                os.close(descriptor)
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass

    def sync(self, descriptor: int) -> None:
        """O_PATH is sufficient for traversal but needs a read descriptor for fsync."""
        readable = os.open(".", DIR_FLAGS, dir_fd=descriptor)
        try:
            os.fsync(readable)
        finally:
            os.close(readable)

    def mkdir(self, path: str, mode: int, existing: bool = False) -> None:
        """Create only a fixed, protected reset directory and durably link it."""
        with self.parent(path) as (parent, name):
            created = False
            try:
                os.mkdir(name, mode, dir_fd=parent)
                created = True
            except FileExistsError:
                require(existing, "Reset identity already exists; check outcome.")
            with self.directory(path, listing=True) as child:
                self.protected(os.fstat(child), True)
                if created:
                    os.fchmod(child, mode)  # A sudo/root 0077 umask must not hide public status.
                    os.fsync(child)
                require(stat.S_IMODE(os.fstat(child).st_mode) == mode, "Reset directory permissions require manual recovery.")
            self.sync(parent)

    @contextmanager
    def lock(self, create: bool = False) -> Iterator[None]:
        """Use the installer's inode, never replace/unlink/truncate the global lock."""
        path = BASE + "/install.lock"
        with self.parent(path) as (parent, name):
            try:
                descriptor = os.open(name, READ_FLAGS, dir_fd=parent)
            except FileNotFoundError:
                if not create:
                    raise Refused("Global installation lock is unavailable; review again after launch settles.")
                descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                self.sync(parent)
            try:
                self.protected(os.fstat(descriptor), False)
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Refused("The global installation lock is held; stop and review again.") from None
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(stamp(info) == stamp(os.fstat(descriptor)), "Installation lock identity changed.")
                yield
            finally:
                os.close(descriptor)

    def unlink(self, path: str, expected: os.stat_result | None = None) -> None:
        """Unlink an anchored entry, without chmod, chown or writing its inode."""
        self.no_mounts([path])
        with self.parent(path) as (parent, name):
            if expected is not None:
                require(stamp(expected) == stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)), "Cleanup entry changed.")
            os.unlink(name, dir_fd=parent)
            self.sync(parent)

    def remove_tree(self, path: str, owner_check: Callable[[str, os.stat_result], None], expected_root: list | None = None) -> None:
        """Use the same independent root budget as inventory(), not the preflight's residue."""
        with self.phase("native-deletion"):
            self._remove_tree(path, owner_check, expected_root)

    def _remove_tree(self, path: str, owner_check: Callable[[str, os.stat_result], None], expected_root: list | None = None) -> None:
        """Delete only a literal fixed root through anchored directory descriptors."""
        require(path in ROOTS, "Invalid cleanup root.")
        self.no_mounts([path])

        def remove(parent: int, name: str, current: str, depth: int) -> None:
            self.tick()
            require(depth <= MAX_DEPTH, "Cleanup depth exceeds its budget.")
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if depth == 0 and expected_root is not None:
                require(stamp(info) == expected_root, "Reviewed native root identity changed before deletion.")
            owner_check(current, info)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=parent)
                try:
                    require(stamp(info) == stamp(os.fstat(child)), "Cleanup directory changed.")
                    self.same_mount(parent, child)
                    with os.scandir(child) as entries:
                        names = []
                        for entry in entries:
                            self.tick()
                            names.append(entry.name)
                    for item in names:
                        remove(child, item, current + "/" + item, depth + 1)
                    now = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    require((now.st_dev, now.st_ino) == (info.st_dev, info.st_ino), "Cleanup directory was replaced.")
                    os.rmdir(name, dir_fd=parent)
                finally:
                    os.close(child)
            else:
                # Symlinks and multiply-linked files are unlinked, NEVER opened or repaired.
                now = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(stamp(now) == stamp(info), "Cleanup file changed.")
                os.unlink(name, dir_fd=parent)
        with self.parent(path) as (parent, name):
            present = self.info(path)
            require(expected_root is None or present is not None, "Reviewed native root disappeared before deletion.")
            if present is not None:
                remove(parent, name, path, 0)
                self.sync(parent)

    def check_acl(self, descriptor: int, uids: set[int], gids: set[int]) -> tuple[bytes | None, bytes | None]:
        """Return the exact validated ACL bytes; a failed audit never proves absence."""
        try:
            attributes = self.acl_reader(descriptor)
        except OSError:
            raise Refused("POSIX ACL audit is unavailable; manual recovery required.") from None
        require(len(attributes) == 2, "POSIX ACL audit is incomplete.")
        for raw in attributes:
            if raw is not None:
                named_users, named_groups = acl_references(raw)
                require(not (uids & named_users or gids & named_groups), "Dedicated identity is referenced by an external POSIX ACL.")
        return attributes

    def outside_ownership(self, uids: set[int], gids: set[int], exemptions: list[str], *, reserve_nodes: int = 0) -> None:
        """Pre-intent callers reserve future entries; the post-scan gets the full budget."""
        require(type(reserve_nodes) is int and reserve_nodes >= 0, "Invalid filesystem inventory receipt reserve.")
        with self.phase("external-identity-pre" if reserve_nodes else "external-identity-post"):
            self.nodes = reserve_nodes
            if self.nodes > self.node_limit:
                self.refuse_budget()
            self._outside_ownership(uids, gids, exemptions)

    def _outside_ownership(self, uids: set[int], gids: set[int], exemptions: list[str]) -> None:
        """Refuse account-owned data or ACL references in every reachable persistent tree.

        proc/sys are kernel interfaces, audited separately for process use. Any
        inaccessible/deep/oversized tree blocks rather than claiming a clean scan.
        Symlink entries are checked, but never traversed. Other mounted filesystems
        are scanned too; there is no st_dev shortcut hiding external account use.
        """
        if not uids and not gids:
            return

        def walk(descriptor: int, path: str, depth: int) -> None:
            require(depth <= MAX_DEPTH, "Other-use inventory exceeds its depth budget.")
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    self.tick()
                    child_path = path + "/" + entry.name
                    if any(beneath(child_path, skip) for skip in ["/proc", "/sys", *exemptions]):
                        continue
                    info = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
                    if info.st_uid in uids or info.st_gid in gids:
                        refuse_path("Dedicated account owns data outside this installation.", child_path, info)
                    if stat.S_ISLNK(info.st_mode):
                        continue  # Linux POSIX ACLs do not apply to symlink inodes.
                    directory = stat.S_ISDIR(info.st_mode)
                    path_flags = getattr(os, "O_PATH", None)
                    require(directory or path_flags is not None or stat.S_ISREG(info.st_mode), "Safe POSIX ACL descriptor audit is unavailable.")
                    flags = DIR_FLAGS if directory else (path_flags | os.O_NOFOLLOW if path_flags is not None else READ_FLAGS)
                    child = os.open(entry.name, flags, dir_fd=descriptor)
                    try:
                        require(stamp(info) == stamp(os.fstat(child)), "Other-use inventory changed.")
                        try:
                            self.check_acl(child, uids, gids)
                        except Refused as error:
                            refuse_path(str(error), child_path, info)
                        require(stamp(info) == stamp(os.fstat(child)), "Other-use ACL inventory changed.")
                        if directory:
                            walk(child, child_path, depth + 1)
                    finally:
                        os.close(child)
        with self.directory("/", listing=True) as root:
            self.check_acl(root, uids, gids)
            walk(root, "", 0)


class Runner(Protocol):
    """Injected, bounded fixed-command backend; tests must never run host commands."""

    def run(self, argv: list[str], seconds: int = 10) -> bytes:
        """Return bounded stdout or fail without exposing process output."""
        ...


class SystemRunner:
    """Run only OS tools, with a clean environment and bounded capture/reaping."""

    def run(self, argv: list[str], seconds: int = 10) -> bytes:
        """No shell, sudo, inherited credentials, installed Node or Python code."""
        allowed = {"/usr/bin/systemctl", "/usr/sbin/userdel", "/usr/sbin/groupdel"}
        require(argv[0] in allowed, "Unreviewed command.")
        process = None
        # Do not deliver the mode deadline between fork/exec and recording ownership
        # of the returned child. Unmasking may immediately raise inside this try.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
        try:
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C", "SYSTEMD_PAGER": "cat"})
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            output = bytearray()
            end = time.monotonic() + seconds
            if process.stdout is None:
                raise Refused("Host command capture is unavailable.")
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout.fileno(), selectors.EVENT_READ)
                while selector.get_map():
                    require(time.monotonic() < end, "Host command timed out; check restart outcome.")
                    for key, _ in selector.select(min(0.1, max(0, end - time.monotonic()))):
                        block = os.read(key.fd, 4096)
                        if not block:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(block)
                            require(len(output) <= MAX_METADATA, "Host command exceeded its output budget.")
                require(process.wait(timeout=max(0.01, end - time.monotonic())) == 0, "Host command failed; manual review may be required.")
            return bytes(output)
        finally:
            signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
            try:
                if process is not None:
                    try:
                        if process.poll() is None:
                            process.kill()  # Only this helper's child, never an installation PID.
                        process.wait(timeout=5)
                    finally:
                        if process.stdout is not None:
                            process.stdout.close()
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


class Accounts(Protocol):
    """Read-only identity/process inventory, separate from all mutation commands."""

    def snapshot(self) -> tuple[list[dict], list[dict]]:
        """Return NSS users and groups including aliases/memberships."""
        ...

    def processes(self, uids: set[int], gids: set[int], allowed_units: set[str]) -> None:
        """Refuse dedicated identities used outside the exact runtime cgroups."""
        ...


class SystemAccounts:
    """Linux NSS and proc inventory; no account database mutation here."""

    def snapshot(self) -> tuple[list[dict], list[dict]]:
        """Keep all entries so aliases and foreign group users cannot be hidden."""
        return ([{"name": user.pw_name, "uid": user.pw_uid, "gid": user.pw_gid, "home": user.pw_dir, "shell": user.pw_shell}
                 for user in pwd.getpwall()],
                [{"name": group.gr_name, "gid": group.gr_gid, "members": sorted(group.gr_mem)} for group in grp.getgrall()])

    def processes(self, uids: set[int], gids: set[int], allowed_units: set[str]) -> None:
        """Inspect real/effective/saved IDs and supplementary groups, not command text."""
        for pid in os.listdir("/proc"):
            if not pid.isdecimal():
                continue
            try:
                with open(f"/proc/{pid}/status", encoding="ascii") as source:
                    rows = dict(line.split(":", 1) for line in source.read(MAX_METADATA).splitlines() if ":" in line)
                used_users = set(map(int, rows["Uid"].split()))
                used_groups = set(map(int, (rows["Gid"] + " " + rows.get("Groups", "")).split()))
                native_process = False
                for source in ("exe", "cwd"):
                    try:
                        target = os.readlink(f"/proc/{pid}/{source}")
                        native_process |= any(beneath(target.removesuffix(" (deleted)"), root) for root in ROOTS)
                    except FileNotFoundError:
                        pass  # Kernel threads and exited processes have no executable/cwd.
                if not (uids & used_users or gids & used_groups or native_process):
                    continue
                with open(f"/proc/{pid}/cgroup", encoding="ascii") as source:
                    groups = [line.strip().split(":", 2)[2] for line in source.read(MAX_METADATA).splitlines()]
                require(bool(groups) and all(any(beneath(path, "/system.slice/" + unit) for unit in allowed_units) for path in groups),
                        "Dedicated account has processes outside the verified native services.")
            except FileNotFoundError:
                continue  # An exited process cannot be killed or justify account ownership.


def unit_texts(release_id: str, full_control: bool) -> dict[str, bytes]:
    """Reproduce the current installer's exact declarations, not installed helpers."""
    release = ROOTS[0] + "/releases/" + release_id
    node = release + "/node/bin/node"
    config, data = ROOTS[1], ROOTS[2]
    result = {}
    for name, user, source in (("worker", "outpost-pi", "server/pi-worker/main.ts"), ("coordinator", "outpost-coord", "server/main.ts")):
        after = "After=network-online.target\nWants=network-online.target\n"
        if name == "coordinator":
            dependencies = UNITS[0] + (" " + UNITS[2] if full_control else "")
            after += f"After={dependencies}\nRequires={dependencies}\n"
        unit = "[Unit]\nDescription=Outpost native " + name + "\n" + after + "[Service]\nType=simple\n"
        unit += f"User={user}\nGroup={user}\nSupplementaryGroups=outpost-workspaces\nUMask=0007\n"
        unit += f"WorkingDirectory={release}\nEnvironmentFile={config}/{name}.env\n"
        unit += f'Environment="PATH={release}/node/bin:/usr/bin:/bin" "HOME={data}/{name}"\n'
        unit += f"ExecStart={node} --import tsx {release}/{source}\n"
        unit += "Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\n"
        unit += f"ReadWritePaths={data}/{name} {data}/workspaces\n"
        unit += "TasksMax=512\nLimitNOFILE=8192\nMemoryHigh=30%\nMemoryMax=40%\nCPUQuota=200%\n[Install]\nWantedBy=multi-user.target\n"
        result[f"outpost-native-{name}.service"] = unit.encode()
    if full_control:
        result[UNITS[2]] = ("[Unit]\nDescription=Outpost full server control\nAfter=network-online.target\nWants=network-online.target\n"
                           "[Service]\nType=simple\nUser=root\nGroup=root\nUMask=0077\nWorkingDirectory=/\n"
                           f"EnvironmentFile={config}/host.env\nExecStart={node} {release}/deploy/agent/host-executor.mjs\n"
                           "Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\n"
                           "[Install]\nWantedBy=multi-user.target\n").encode()
    return result


UNIT_SEARCH = (UNIT_DIR, "/etc/systemd/system.control", "/run/systemd/system.control", "/run/systemd/transient",
               "/run/systemd/generator.early", "/run/systemd/system", "/run/systemd/generator",
               "/usr/local/lib/systemd/system", "/usr/lib/systemd/system", "/run/systemd/generator.late")
STOP_DEPENDENCIES = ("ConsistsOf", "BoundBy", "PropagatesStopTo", "RequiredBy", "RequisiteOf")
PROPERTIES = ("Id", "Names", "LoadState", "ActiveState", "SubState", "FragmentPath", "SourcePath", "DropInPaths",
              "NeedDaemonReload", "ExecStop", "ExecStopPost", "OnFailure", "OnSuccess", "Job", "ControlPID", *STOP_DEPENDENCIES)


class Helper:
    """Authenticated review and one-shot reset orchestration over injected backends."""

    def __init__(self, files: Files, runner: Runner, accounts: Accounts, privileged: bool) -> None:
        self.fs, self.runner, self.accounts, self.privileged = files, runner, accounts, privileged

    def base(self, request: dict) -> dict:
        """Public identity envelope; never include the installing device's key."""
        return {"schemaVersion": 1, **{key: request["expected"][key] for key in IDENTITIES}, "resetId": request["resetId"]}

    def result(self, request: dict, state: str, message: str) -> dict:
        """Produce the only apply/status response shape."""
        return {**self.base(request), "state": state, "message": message}

    def service(self, name: str) -> dict[str, str]:
        """Query only fixed units or the authenticated canonical operation UUID."""
        require(name in UNITS or re.fullmatch(r"outpost-setup-[a-f0-9-]{36}\.service", name) is not None, "Invalid service identity.")
        raw = self.runner.run(["/usr/bin/systemctl", "show", "--all", "--no-pager", "--property=" + ",".join(PROPERTIES), "--", name])
        result = {}
        for line in raw.decode("utf-8").splitlines():
            key, sep, value = line.partition("=")
            require(bool(sep) and key in PROPERTIES and key not in result, "Service inventory is malformed.")
            result[key] = value
        # systemd 255 omits empty exec arrays even with --all. Nothing else is
        # optional; units() still authenticates the actual fragment and template.
        for key in ("ExecStop", "ExecStopPost"):
            result.setdefault(key, "")
        require(set(result) == set(PROPERTIES) and result["Id"] == name, "Service identity is unavailable.")
        return result

    def loaded_instances(self) -> list[str]:
        """Read all manager-known execution-unit instances, including inactive ones, without loading new units."""
        raw = self.runner.run(list(INSTANCE_LIST_COMMAND))
        require(len(raw) <= MAX_METADATA, "Loaded instance inventory exceeds its output budget.")
        def unique(items: list[tuple[str, object]]) -> dict:
            result = {}
            for key, value in items:
                require(key not in result, "Loaded instance inventory has duplicate fields.")
                result[key] = value
            return result
        def constant(_value: str) -> NoReturn:
            raise Refused("Loaded instance inventory contains nonfinite JSON values.")
        rows = json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant)
        require(isinstance(rows, list) and len(rows) <= MAX_UNIT_INSTANCES, "Loaded instance inventory is unavailable or exceeds its budget.")
        names = []
        for row in rows:
            require(isinstance(row, dict) and row.get("load") == "loaded" and systemd_unit_name(row.get("unit")),
                    "Loaded instance inventory contains an unverified unit.")
            name = row["unit"]
            context = systemd_template(name)
            require(context is not None and bool(context[1]) and name.rsplit(".", 1)[-1] in ("service", "socket", "mount", "swap"),
                    "Loaded instance inventory contains an unsupported unit.")
            names.append(name)
        require(len(names) == len(set(names)), "Loaded instance inventory contains duplicate units.")
        return sorted(names)

    def instance_properties(self, name: str) -> dict[str, str]:
        """Query only a validated name previously enumerated by the bounded read-only manager inventory."""
        require(systemd_unit_name(name) and systemd_template(name) is not None, "Invalid loaded instance name.")
        raw = self.runner.run(["/usr/bin/systemctl", "show", "--all", "--no-pager", "--property=" + ",".join(INSTANCE_PROPERTIES), "--", name])
        require(len(raw) <= MAX_METADATA, "Loaded instance properties exceed their budget.")
        values = {}
        for line in raw.decode("utf-8").splitlines():
            key, separator, value = line.partition("=")
            require(bool(separator) and key in INSTANCE_PROPERTIES and key not in values, "Loaded instance properties are malformed.")
            values[key] = value
        require(set(values) == set(INSTANCE_PROPERTIES) and values["Id"] == name and values["LoadState"] == "loaded"
                and values["NeedDaemonReload"] == "no" and values["SourcePath"] == "" and bool(values["FragmentPath"]),
                "Loaded instance identity or declaration is unverified.")
        return values

    def inactive(self, service: dict) -> bool:
        """Absence/inactivity must be positively observed, not guessed from errors."""
        return (service["LoadState"] in ("loaded", "not-found") and service["ActiveState"] in ("inactive", "failed")
                and service["SubState"] in ("dead", "failed") and service["Job"] in ("", "0") and service["ControlPID"] == "0")

    def authenticate(self, request: dict) -> tuple[dict, dict, dict[str, bytes]]:
        """Bind root-owned request/status and pinned archive BEFORE parsing its members."""
        expected = request["expected"]
        operation = OPERATIONS + "/" + expected["operationId"]
        self.fs.no_mounts([operation])
        original = self.fs.json(operation + "/request.json", private=True)
        require(set(original) == EXPECTED | {"label", "browser", "coexistence", "fullControl"}
                and all(type(original.get(key)) is type(value) and original.get(key) == value for key, value in expected.items()),
                "Original installation request does not match the saved plan.")
        require(all(type(original[key]) is bool for key in ("browser", "coexistence", "fullControl")), "Original choices are invalid.")
        label = original["label"]
        require(isinstance(label, str) and 1 <= len(label) <= 80 and all(ord(c) >= 32 and ord(c) != 127 for c in label), "Original label is invalid.")
        receipt = self.fs.json(operation + "/status.json")
        require(all(receipt.get(key) == expected[key] for key in IDENTITIES), "Original receipt identity does not match.")
        require(receipt.get("state") in ("queued", "running", "unknown", "ready", "failed", "cancelled", "interrupted")
                and type(receipt.get("completedSteps")) is int and 0 <= receipt["completedSteps"] <= 10
                and type(receipt.get("totalSteps")) is int and receipt["totalSteps"] == 12, "Original progress is invalid.")
        require(receipt["state"] != "ready" or receipt["completedSteps"] == 10, "Original ready receipt is inconsistent.")
        raw = self.fs.read(operation + "/release.tar.gz", MAX_ARCHIVE)
        require(len(raw) == expected["size"] and hashlib.sha256(raw).hexdigest() == expected["sha256"], "Original archive does not match the saved plan.")
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as archive:
            expanded = archive.read(MAX_EXPANDED + 1)
        require(len(expanded) <= MAX_EXPANDED, "Archive expansion exceeds its budget.")
        tree = {}
        seen = set()
        total = 0
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
            for item in archive:
                name = item.name.removeprefix("./").rstrip("/")
                if name in ("", ".") and item.isdir():
                    continue
                require(bool(name) and not name.startswith("/") and all(part not in ("", ".", "..") for part in name.split("/"))
                        and name not in seen and (item.isfile() or item.isdir()), "Archive has unsafe or duplicate members.")
                seen.add(name)
                total += item.size
                require(0 <= item.size <= 32 * 1024 * 1024 and len(seen) <= 4096 and total <= 32 * 1024 * 1024, "Archive member budget exceeded.")
                if item.isfile():
                    source = archive.extractfile(item)
                    if source is None:
                        raise Refused("Archive member is unreadable.")
                    with source:
                        tree[name] = source.read(item.size + 1)
        require("host-manifest.json" in tree, "Archive lacks native release identity.")
        manifest = document(tree["host-manifest.json"])
        require(manifest.get("id") == expected["releaseId"] and type(manifest.get("layoutVersion")) is int and manifest["layoutVersion"] == 1
                and type(manifest.get("protocolVersion")) is int and manifest["protocolVersion"] == 2, "Archive layout or release identity is unsupported.")
        return original, receipt, tree

    def account_inventory(self) -> tuple[dict, dict, dict]:
        """Validate exact dedicated identities, UID aliases and all memberships."""
        users, groups = self.accounts.snapshot()
        require(len(users) <= 65536 and len(groups) <= 65536, "Account inventory exceeds its budget.")
        # Canonicalize order, never deduplicate: aliases and duplicate identities must still fail.
        users = sorted(users, key=encoded)
        groups = sorted(({**row, "members": sorted(row["members"])} for row in groups), key=encoded)
        selected = {name: [row for row in users if row["name"] == name] for name in USERS}
        selected_groups = {name: [row for row in groups if row["name"] == name] for name in GROUPS}
        require(all(len(rows) <= 1 for rows in (*selected.values(), *selected_groups.values())), "Duplicate dedicated identities.")
        known_users = {name: rows[0] for name, rows in selected.items() if rows}
        known_groups = {name: rows[0] for name, rows in selected_groups.items() if rows}
        for name, user in known_users.items():
            require(0 < user["uid"] < 1000 and user["home"] == "/nonexistent" and user["shell"] == "/usr/sbin/nologin",
                    "Dedicated account is not the installer's system/no-login identity.")
            require(name in known_groups and known_groups[name]["gid"] == user["gid"], "Dedicated primary group does not match.")
            require(sum(row["uid"] == user["uid"] for row in users) == 1, "Dedicated UID has another account alias.")
            require(all(group["name"] in (name, "outpost-workspaces") for group in groups if name in group["members"]),
                    "Dedicated account belongs to an unrelated group.")
            if name == "outpost-build":
                require(all(name not in group["members"] for group in groups if group["name"] != name), "Build account has unexpected supplementary use.")
        for name, group in known_groups.items():
            require(0 < group["gid"] < 1000 and sum(row["gid"] == group["gid"] for row in groups) == 1, "Dedicated GID has another identity.")
            allowed = {"outpost-coord", "outpost-pi"} if name == "outpost-workspaces" else {name}
            require(set(group["members"]) <= allowed and all(user["name"] in allowed for user in users if user["gid"] == group["gid"]),
                    "Dedicated group is used by another account.")
        return known_users, known_groups, {"users": users, "groups": groups}

    def generated_uv_lock(self, path: str, info: os.stat_result, uid: int | None, gid: int | None) -> None:
        """Validate an exact caller-selected generated lock, without opening or repairing it."""
        if not (uid is not None and gid is not None and stat.S_ISREG(info.st_mode) and info.st_size == 0
                and info.st_nlink == 1 and not info.st_mode & 0o7111 and (info.st_uid, info.st_gid) == (uid, gid)):
            refuse_path("Generated uv lock is not an empty, singly-linked build-owned regular file.", path, info)
        parent = path.rpartition("/")[0]
        before = self.fs.info(parent, trusted=False)
        with self.fs.directory(parent, trusted=False) as descriptor:
            found = os.fstat(descriptor)
            if not (stat.S_ISDIR(found.st_mode) and stat.S_IMODE(found.st_mode) == 0o700
                    and (found.st_uid, found.st_gid) == (uid, gid)):
                refuse_path("Generated uv lock parent is not a private build-owned directory.", parent, found)
            require(stamp(before) == stamp(found)
                    and stamp(info) == stamp(os.stat(".lock", dir_fd=descriptor, follow_symlinks=False)),
                    "Generated uv lock or parent changed during verification.")

    def owner_check(self, original: dict, users: dict, groups: dict) -> Callable[[str, os.stat_result], None]:
        """Location-specific ownership, not a broad allowlist of arbitrary owners."""
        root = self.fs.owner
        release = ROOTS[0] + "/releases/" + original["releaseId"]
        uids = {name: row["uid"] for name, row in users.items()}
        gids = {name: row["gid"] for name, row in groups.items()}
        uv_locks = {release + "/" + name for name in UV_LOCKS}

        def check(path: str, info: os.stat_result) -> None:
            allowed_users, allowed_groups = {root}, {os.fstat(self.fs.root_fd).st_gid}
            writable_group = False
            if beneath(path, release):
                allowed_users |= {uids[name] for name in ("outpost-build",) if name in uids}
                allowed_groups |= {gids[name] for name in ("outpost-build",) if name in gids}
            for directory, account in (("coordinator", "outpost-coord"), ("worker", "outpost-pi"), ("workspaces", "outpost-coord")):
                if beneath(path, ROOTS[2] + "/" + directory) or beneath(path, ROOTS[1] + "/" + directory):
                    allowed_users |= {uids[account]} if account in uids else set()
                    allowed_groups |= {gids[account]} if account in gids else set()
                    if directory == "workspaces":
                        allowed_users |= {uids["outpost-pi"]} if "outpost-pi" in uids else set()
                        allowed_groups |= {gids[name] for name in ("outpost-pi", "outpost-workspaces") if name in gids}
                        writable_group = True
                    elif path.startswith(ROOTS[2] + "/"):
                        allowed_groups |= {gids["outpost-workspaces"]} if "outpost-workspaces" in gids else set()
                        writable_group = True
            generated_lock = path in uv_locks
            if generated_lock:
                self.generated_uv_lock(path, info, uids.get("outpost-build"), gids.get("outpost-build"))
            if info.st_uid not in allowed_users or info.st_gid not in allowed_groups:
                refuse_path("Native path has unexpected ownership.", path, info)
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
                refuse_path("Native path has an unexpected special file.", path, info)
            if not generated_lock and not stat.S_ISLNK(info.st_mode) and (info.st_mode & 0o002 or (not writable_group and info.st_mode & 0o020)):
                refuse_path("Native path is writable by unexpected identities.", path, info)
            if path in ROOTS and not (stat.S_ISDIR(info.st_mode) and info.st_uid == root):
                refuse_path("Native root is not an owned directory.", path, info)
        return check

    def browser_hotfix(self, original: dict, receipt: dict, tree: dict[str, bytes], users: dict) -> dict | None:
        """Recognize only the recorded HOME hotfix; audit data never supplies an I/O path."""
        operation = OPERATIONS + "/" + original["operationId"]
        release = ROOTS[0] + "/releases/" + original["releaseId"]
        engine = release + "/server/browser-engine"
        if self.fs.info(engine, trusted=False) is not None:
            require(not any(name.startswith(".outpost2-launch-") for name in self.fs.names(engine, trusted=False)),
                    "Partial browser hotfix staging requires manual recovery.")
        audits = [name for name in self.fs.names(operation) if name.startswith(HOTFIX_PREFIX)]
        if not audits:
            return None
        require(len(audits) == 1 and identifier(audits[0][len(HOTFIX_PREFIX):]), "Unknown or multiple browser hotfix audits.")
        require(all(original[key] is True for key in ("browser", "coexistence", "fullControl"))
                and receipt["state"] == "failed" and receipt["completedSteps"] == 4 and receipt.get("stage") == "Browser runtime"
                and set(receipt) == {*IDENTITIES, "state", "completedSteps", "totalSteps", "stage", "startedAt", "updatedAt", "log", "error"},
                "Browser hotfix is not bound to the recorded failed browser stage.")
        require("outpost-build" in users and HOTFIX_LAUNCHER in tree
                and hashlib.sha256(tree[HOTFIX_LAUNCHER]).hexdigest() == HOTFIX_ORIGINAL_SHA256,
                "Browser hotfix original launcher is not the authenticated source.")
        build = users["outpost-build"]
        root, root_gid = self.fs.owner, os.fstat(self.fs.root_fd).st_gid
        audit = operation + "/" + audits[0]
        self.fs.no_mounts([operation, release])
        evidence = {}

        def directory(path: str, uid: int, gid: int, mode: int, trusted: bool = True) -> os.stat_result:
            """Bind no-follow metadata to the opened directory, including its recorded identity."""
            info = self.fs.info(path, trusted=trusted)
            if info is None:
                raise Refused("Browser hotfix directory is missing.")
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid
                    and stat.S_IMODE(info.st_mode) == mode, "Browser hotfix directory identity or permissions changed.")
            with self.fs.directory(path, trusted=trusted) as descriptor:
                require(stamp(info) == stamp(os.fstat(descriptor)), "Browser hotfix directory changed during verification.")
            evidence[path] = [stamp(info)]
            return info

        def read(path: str, limit: int, uid: int, gid: int, mode: int, trusted: bool = True) -> bytes:
            """Read bounded singleton files, retaining only stamps and digests in the snapshot."""
            info = self.fs.info(path, trusted=trusted)
            require(info is not None and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                    and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (uid, gid, mode),
                    "Browser hotfix file identity, links or permissions changed.")
            data = self.fs.read(path, limit, private=mode == 0o600, trusted=trusted)
            require(stamp(info) == stamp(self.fs.info(path, trusted=trusted)), "Browser hotfix file changed during verification.")
            evidence[path] = [stamp(info), hashlib.sha256(data).hexdigest()]
            return data

        directory(audit, root, root_gid, 0o700)
        names = {*HOTFIX_BACKUPS, "manifest.json", "applied.json"}
        require(set(self.fs.names(audit)) == names, "Incomplete or unknown browser hotfix audit contents.")
        archive = read(operation + "/release.tar.gz", MAX_ARCHIVE, root, root_gid, 0o644)
        require(len(archive) == original["size"] and hashlib.sha256(archive).hexdigest() == original["sha256"],
                "Browser hotfix retained archive changed.")
        require(read(operation + "/source/" + HOTFIX_LAUNCHER, 16384, root, root_gid, 0o644) == tree[HOTFIX_LAUNCHER],
                "Browser hotfix retained source differs from the authenticated archive.")
        launcher = read(release + "/" + HOTFIX_LAUNCHER, 16384, build["uid"], build["gid"], 0o644, trusted=False)
        require(hashlib.sha256(launcher).hexdigest() == HOTFIX_REPLACEMENT_SHA256, "Browser hotfix launcher is not the reviewed replacement.")
        backups = {}
        for name, limit in HOTFIX_BACKUPS.items():
            data = read(audit + "/" + name, limit, root, root_gid, 0o600)
            if name == "launch.py":
                require(data == tree[HOTFIX_LAUNCHER], "Browser hotfix original backup differs from the authenticated archive.")
                uid, gid, mode = build["uid"], build["gid"], 0o644
            else:
                uid, gid, mode = root, root_gid, 0o644 if name == "status.json" else 0o600
                retained = read(operation + "/" + name, limit, uid, gid, mode)
                require(data == retained, "Browser hotfix backup no longer matches retained operation evidence.")
                if name in ("request.json", "status.json"):
                    require(encoded(document(retained)) == encoded(original if name == "request.json" else receipt),
                            "Browser hotfix operation evidence changed during verification.")
            backups[name] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "uid": uid, "gid": gid, "mode": mode}
        font = directory(release + "/browsers/camoufox/fontconfig", build["uid"], build["gid"], 0o755, trusted=False)
        # Generated font files may exist now; only deletion provenance, NOT runtime contents, is verified.
        manifest = {"schema": 1, **{key: original[key] for key in IDENTITIES}, "auditId": audits[0], "provenance": HOTFIX_PROVENANCE,
                    "originalSha256": HOTFIX_ORIGINAL_SHA256, "replacementSha256": HOTFIX_REPLACEMENT_SHA256,
                    "archiveSha256": original["sha256"], "archiveSize": original["size"], "backups": backups,
                    "fontconfig": {"relativePath": "browsers/camoufox/fontconfig", "uid": build["uid"], "gid": build["gid"], "mode": 0o755}}
        raw = read(audit + "/manifest.json", 16384, root, root_gid, 0o600)
        require(raw == (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode(), "Browser hotfix manifest is not the exact recorded format or binding.")
        applied = {"schema": 1, "manifestSha256": hashlib.sha256(raw).hexdigest(), "launcherSha256": HOTFIX_REPLACEMENT_SHA256,
                   "fontconfigIdentity": [font.st_dev, font.st_ino, font.st_mode, font.st_uid, font.st_gid]}
        require(read(audit + "/applied.json", 16384, root, root_gid, 0o600)
                == (json.dumps(applied, sort_keys=True, indent=2) + "\n").encode(), "Browser hotfix completion or Fontconfig identity does not match.")
        require(set(self.fs.names(audit)) == names and [name for name in self.fs.names(operation) if name.startswith(HOTFIX_PREFIX)] == audits,
                "Browser hotfix audit set changed during verification.")
        for path, recorded in evidence.items():
            require(stamp(self.fs.info(path, trusted=False)) == recorded[0], "Browser hotfix evidence changed during verification.")
        return evidence

    def layout(self, original: dict, receipt: dict, tree: dict[str, bytes], users: dict, groups: dict) -> dict:
        """Authenticate legacy partial and completed layouts, including source provenance."""
        release = ROOTS[0] + "/releases/" + original["releaseId"]
        if receipt["completedSteps"] < 2:
            require(not users and not groups and all(self.fs.info(root) is None for root in ROOTS)
                    and all(self.fs.info(UNIT_DIR + "/" + unit) is None for unit in UNITS),
                    "Native creation is not proven before the accounts stage completes; occupied scope requires manual recovery.")
        self.fs.no_mounts(list(ROOTS))
        allowed = {ROOTS[0]: {"releases", "current"}, ROOTS[1]: {"worker", "coordinator", "worker.env", "coordinator.env", "installation.json"},
                   ROOTS[2]: {"worker", "coordinator", "workspaces"}}
        if original["fullControl"]:
            allowed[ROOTS[1]].add("host.env")
        checker = self.owner_check(original, users, groups)
        inventories = {}
        for root in ROOTS:
            inventories[root] = self.fs.inventory(root, checker)
            if self.fs.info(root) is not None:
                require(set(self.fs.names(root)) <= allowed[root], "Unexpected native root entries; ownership is ambiguous.")
        if self.fs.info(ROOTS[0] + "/releases") is not None:
            require(set(self.fs.names(ROOTS[0] + "/releases")) <= {original["releaseId"]}, "Another release occupies the native scope.")
        current = self.fs.info(ROOTS[0] + "/current")
        if current is not None:
            require(stat.S_ISLNK(current.st_mode) and self.fs.link(ROOTS[0] + "/current") == release, "Native current release does not match.")
        metadata = self.fs.info(ROOTS[1] + "/installation.json")
        if metadata is not None:
            installed = self.fs.json(ROOTS[1] + "/installation.json")
            require(encoded(installed) == encoded({"schema": 1, "layoutVersion": 1, "environmentId": original["environmentId"], "release": original["releaseId"],
                                                   "apiPort": 4518, "operationId": original["operationId"], "fullControl": original["fullControl"]}),
                    "Completed installation identity does not match the original operation.")
        hotfix = self.browser_hotfix(original, receipt, tree, users)
        warnings = []
        uv_locks = {release + "/" + name for name in UV_LOCKS}
        if any(row[0] in uv_locks for rows in inventories.values() for row in rows):
            warnings.append(UV_LOCK_WARNING)
        if hotfix is not None:
            warnings.append(HOTFIX_WARNING)
        if self.fs.info(release, trusted=False) is not None:
            for name, content in tree.items():
                path = release + "/" + name
                info = self.fs.info(path, trusted=False)
                if info is None:
                    require(receipt["completedSteps"] <= 1, "Installed source is missing; ownership is ambiguous.")
                    continue
                recorded_hotfix = hotfix is not None and name == HOTFIX_LAUNCHER
                current = self.fs.read(path, 16384 if recorded_hotfix else len(content), trusted=False)
                if hotfix is not None and recorded_hotfix:
                    require(hashlib.sha256(current).hexdigest() == HOTFIX_REPLACEMENT_SHA256
                            and stamp(self.fs.info(path, trusted=False)) == hotfix[path][0],
                            "Recorded browser hotfix launcher changed during source verification.")
                elif current != content:
                    refuse_path("Installed source differs from the authenticated archive.", path, info,
                                (hashlib.sha256(content).hexdigest(), hashlib.sha256(current).hexdigest()))
        else:
            require(receipt["completedSteps"] <= 1 or not any(self.fs.info(root) for root in ROOTS), "Expected native release is absent.")
        return {"trees": inventories, "completedMetadata": metadata is not None, "browserHotfix": hotfix, "warnings": warnings}

    def units(self, original: dict) -> dict:
        """Bound each independent service safety pass, including pre-stop rechecks."""
        with self.fs.phase("unit-configuration"):
            return self._units(original)

    def _units(self, original: dict) -> dict:
        """Reject overrides/aliases and require exact owned files plus safe loaded state."""
        expected = unit_texts(original["releaseId"], original["fullControl"])
        found, links, states = {}, {}, {}
        for directory in UNIT_SEARCH:
            if self.fs.info(directory) is None:
                continue
            for override in ("service.d", "outpost-.service.d", "outpost-native-.service.d", *(unit + ".d" for unit in UNITS)):
                require(self.fs.info(directory + "/" + override) is None, "Native service overrides require manual recovery.")
            for unit in UNITS:
                path = directory + "/" + unit
                info = self.fs.info(path)
                if info is not None:
                    self.fs.no_mounts([path])
                    require(directory == UNIT_DIR and unit in expected and self.fs.read(path) == expected[unit], "Service unit is not the original owned declaration.")
                    found[unit] = stamp(info)
            # Aliases/extra enablement links could reactivate the service later.
            for name in self.fs.names(directory):
                path = directory + "/" + name
                info = self.fs.info(path)
                if info is not None and stat.S_ISLNK(info.st_mode):
                    target = self.fs.link(path)
                    require(target.rsplit("/", 1)[-1] not in UNITS, "Native service has an unexpected alias.")
                if name.endswith((".wants", ".requires")):
                    for unit in UNITS:
                        link = path + "/" + unit
                        entry = self.fs.info(link)
                        if entry is None:
                            continue
                        self.fs.no_mounts([link])
                        require(directory == UNIT_DIR and name == "multi-user.target.wants" and unit in found
                                and stat.S_ISLNK(entry.st_mode) and entry.st_uid == self.fs.owner
                                and self.fs.link(link) == UNIT_DIR + "/" + unit, "Native service enablement is not owned.")
                        links[link] = stamp(entry)
        for unit in UNITS:
            value = self.service(unit)
            if unit not in found:
                require(value["LoadState"] == "not-found" and self.inactive(value), "A non-owned native unit is loaded.")
            else:
                require(value["LoadState"] == "loaded" and value["FragmentPath"] == UNIT_DIR + "/" + unit and systemctl_unit_names(value["Names"]) == [unit]
                        and not any(value[key] for key in ("SourcePath", "DropInPaths", "ExecStop", "ExecStopPost", "OnFailure", "OnSuccess"))
                        and value["Job"] in ("", "0") and value["ControlPID"] == "0" and value["NeedDaemonReload"] == "no", "Loaded service has unsafe hooks, overrides or pending changes.")
                require(value["ActiveState"] in ("active", "inactive", "failed"), "Native service is transitioning; review again.")
            states[unit] = value
        for value in states.values():
            require(all(set(value[prop].split()) <= set(found) for prop in STOP_DEPENDENCIES),
                    "Native stop would propagate to a non-owned unit; manual recovery required.")
        return {"files": found, "links": links, "states": states}

    def stored(self, request: dict) -> dict | None:
        """Read ONLY the public metadata receipt; usable by unprivileged SSH accounts."""
        directory = RESETS + "/" + request["resetId"]
        if self.fs.info(directory) is None:
            return None
        self.fs.no_mounts([directory])
        value = self.fs.json(directory + "/status.json")
        require(set(value) == {"schemaVersion", *IDENTITIES, "resetId", "state", "message", "bindingDigest", "snapshotDigest"}
                and all(value.get(key) == expected for key, expected in self.base(request).items())
                and value["bindingDigest"] == digest(request["expected"]) and hex_digest(value["snapshotDigest"])
                and type(value["schemaVersion"]) is int and value["state"] in RECEIPT_MESSAGES
                and value["message"] == RECEIPT_MESSAGES[value["state"]],
                "Reset receipt is not authenticated for this identity.")
        return value

    def reset_parent(self) -> None:
        """Review must enforce the same existing-parent prerequisites as metadata creation."""
        self.fs.no_mounts([RESETS])
        info = self.fs.info(RESETS)
        if info is not None:
            self.fs.protected(info, True)
            require(stat.S_IMODE(info.st_mode) == 0o711, "Reset directory permissions require manual recovery.")

    def recovery_record(self, request: dict) -> dict:
        """Read private binding data without interpreting it as permission to replay intent."""
        path = RESETS + "/" + request["resetId"] + "/recovery.json"
        info = self.fs.info(path)
        require(info is not None and stat.S_IMODE(info.st_mode) == 0o600, "Recovery preparation permissions are unverified.")
        value = self.fs.json(path, private=True)
        require(set(value) == {*self.base(request), "expected", "snapshotDigest", "recoveryToken"}
                and all(type(value.get(key)) is type(expected) and value.get(key) == expected for key, expected in self.base(request).items())
                and encoded(value["expected"]) == encoded(request["expected"])
                and hex_digest(value["snapshotDigest"]) and hex_digest(value["recoveryToken"]),
                "Recovery preparation is not authenticated for this identity.")
        require(stamp(self.fs.info(path)) == stamp(info), "Recovery preparation changed during verification.")
        return value

    def preparation(self, request: dict) -> dict | None:
        """Only an exact preparation-only directory can be refreshed or consumed, under lock."""
        directory = RESETS + "/" + request["resetId"]
        info = self.fs.info(directory)
        if info is None:
            return None
        self.fs.protected(info, True)
        require(stat.S_IMODE(info.st_mode) == 0o711, "Recovery directory permissions are unverified.")
        self.fs.no_mounts([directory])
        require(self.fs.names(directory) == ["recovery.json", "status.json"],
                "Existing reset intent, partial or unrecognized evidence forbids recovery replay.")
        record = self.recovery_record(request)
        status_info = self.fs.info(directory + "/status.json")
        require(status_info is not None and stat.S_IMODE(status_info.st_mode) == 0o644,
                "Recovery public receipt permissions are unverified.")
        public = self.stored(request)
        require(public is not None and public["state"] == "unknown"
                and public["snapshotDigest"] == self.recovery_digest(record),
                "Recovery preparation and public barrier do not match.")
        require(stamp(self.fs.info(directory)) == stamp(info) and stamp(self.fs.info(directory + "/status.json")) == stamp(status_info),
                "Recovery preparation changed during verification.")
        return record

    def recovery_digest(self, record: dict) -> str:
        """A normal review digest can never authorize a prepared recovery."""
        return digest({"snapshotDigest": record["snapshotDigest"], "recoveryToken": record["recoveryToken"]})

    def holds_and_peers(self, request: dict, completed_metadata: bool) -> list:
        """Do not let a new ID bypass an unfinished reset or claim a peer's native tree."""
        completed = set()
        history = []
        if self.fs.info(RESETS) is not None:
            for name in self.fs.names(RESETS):
                require(identifier(name), "Unrecognized reset evidence requires manual recovery.")
                path = RESETS + "/" + name
                self.fs.no_mounts([path])
                if name == request["resetId"] and request["mode"] in ("recover_review", "recover_apply"):
                    require(self.preparation(request) is not None, "Recovery preparation disappeared during inspection.")
                    continue
                value = self.fs.json(path + "/status.json")
                require(value.get("schemaVersion") == 1 and value.get("resetId") == name and value.get("state") == "complete"
                        and identifier(value.get("operationId")) and hex_digest(value.get("bindingDigest")), "An incomplete reset requires manual recovery; replay is blocked.")
                require(name != request["resetId"] and value["operationId"] != request["expected"]["operationId"],
                        "This operation was already reset; check its outcome instead of claiming new native files.")
                completed.add(value["operationId"])
                history.append([name, value])
        for name in self.fs.names(OPERATIONS):
            require(identifier(name), "Unrecognized operation evidence requires manual recovery.")
            if name == request["expected"]["operationId"]:
                continue
            value = self.fs.json(OPERATIONS + "/" + name + "/status.json")
            require(value.get("operationId") == name and type(value.get("completedSteps")) is int, "Peer operation evidence is ambiguous.")
            if name not in completed:
                require(value.get("state") in ("failed", "cancelled", "interrupted", "ready"), "A peer installation may still be active.")
                require(completed_metadata or value["completedSteps"] == 0, "Another operation may own the native installation.")
            history.append([name, value])
        return history

    def other_account_use(self, users: dict, groups: dict, original: dict) -> dict:
        """Configuration rechecks receive the same allowance as the initial review."""
        with self.fs.phase("account-configuration"):
            return self._other_account_use(users, groups, original)

    def _other_account_use(self, users: dict, groups: dict, original: dict) -> dict:
        """Check local account origins and dormant service/cron use, not just live PIDs.

        Configuration is read only from fixed OS directories and protected linked declarations. Unexpected references
        block cleanup; this is intentionally stricter than parsing shell/systemd
        substitutions or assuming an inactive foreign service is harmless.
        """
        evidence = {}
        for path, selected, fields in (("/etc/passwd", users, 7), ("/etc/group", groups, 4)):
            raw = self.fs.read(path)
            rows = [line.split(":") for line in raw.decode().splitlines() if line and not line.startswith("#")]
            require(all(len(row) == fields for row in rows), "Local account database is malformed.")
            evidence[path] = hashlib.sha256(raw).hexdigest()
            names = USERS if fields == 7 else GROUPS
            require({row[0] for row in rows if row[0] in names} == set(selected), "Local account and NSS inventories disagree.")
            for name, account in selected.items():
                matches = [row for row in rows if row[0] == name]
                require(len(matches) == 1, "Dedicated identity is not a unique local account.")
                row = matches[0]
                if fields == 7:
                    require((row[2], row[3], row[5], row[6]) == (str(account["uid"]), str(account["gid"]), account["home"], account["shell"]),
                            "Local account and NSS identity disagree.")
                else:
                    require(row[2] == str(account["gid"]) and sorted(filter(None, row[3].split(","))) == sorted(account["members"]),
                            "Local group and NSS identity disagree.")
        tokens = [*USERS, *GROUPS, *ROOTS, *UNITS]
        numbers = {str(row["uid"]) for row in users.values()} | {str(row["gid"]) for row in groups.values()}
        setup_unit = "outpost-setup-" + original["operationId"] + ".service"

        linked_evidence = {}
        linked_targets = set()
        root_gid = os.fstat(self.fs.root_fd).st_gid
        loaded_names = self.loaded_instances()
        unit_contexts, concrete_units = set(), set()
        template_expressions = {}
        template_activations = {}
        activation_references = set()

        def register_unit(unit: str | None, path: str | None = None, info: os.stat_result | None = None) -> tuple[str, str] | None:
            """A configured/loaded instance is distinct from an uninstantiated template."""
            if unit is None:
                return None
            require(systemd_unit_name(unit), "Unsupported systemd unit context.")
            context = systemd_template(unit)
            if context is not None:
                unit_contexts.add(unit)
                if context[1]:
                    concrete_units.add(unit)
                    require(len(concrete_units) <= MAX_UNIT_INSTANCES, "Configured instance inventory exceeds its budget.")
                    try:
                        unescaped = systemd_unescape_component(context[1])
                    except Refused as error:
                        if path is not None:
                            refuse_path(str(error), path, info)
                        raise
                    if {context[1], unescaped} & (numbers | set(USERS) | set(GROUPS)):
                        if path is not None:
                            refuse_path("Systemd instance names a native identity.", path, info)
                        raise Refused("Loaded systemd instance names a native identity.")
            return context

        def audit_identity(key: str, value: str, unit: str | None, path: str, info: os.stat_result, *, defer: bool = True) -> None:
            """Resolve bounded %i substitutions using the source instance, then revalidate the complete identity."""
            context = register_unit(unit, path, info)
            try:
                identities = systemd_identity_values(value, single=key != "SupplementaryGroups", allow_instance=context is not None)
                if any("%i" in item for item in identities):
                    if context is None:
                        raise Refused("Systemd identity has no resolvable unit context.")
                    if (info.st_uid, info.st_gid) != (self.fs.owner, root_gid) or info.st_mode & 0o022 or info.st_nlink != 1:
                        raise Refused("Templated identity declaration is not protected root metadata.")
                    if context[1]:
                        instance = systemd_identity_values(context[1], single=True)[0]
                        expanded, expanded_bytes = [], 0
                        for item in identities:
                            require(len(item) + item.count("%i") * (len(instance) - 2) <= 255,
                                    "Unsupported systemd identity syntax requires manual review.")
                            resolved = item.replace("%i", instance)
                            expanded_bytes += len(resolved) + 1
                            require(expanded_bytes <= MAX_METADATA, "Expanded systemd identities exceed their budget.")
                            expanded.append(resolved)
                        identities = systemd_identity_values(" ".join(expanded), single=key != "SupplementaryGroups")
                    else:
                        if defer:
                            template_expressions.setdefault(context[0], []).append((path, info, key, value))
                        identities = [item for item in identities if "%i" not in item]
            except Refused as error:
                refuse_path(str(error), path, info)
            if set(identities) & numbers:
                refuse_path("Dedicated numeric identity is used by another service.", path, info)
            if set(identities) & (set(USERS) | set(GROUPS)):
                refuse_path("Dedicated identity or native service is referenced by unrelated configuration.", path, info)

        def audit_activation(key: str, value: str, unit: str | None, path: str, info: os.stat_result, *, defer: bool = True) -> None:
            """Collect declarations, never load/start referenced units; explicit native instances fail immediately."""
            context = register_unit(unit, path, info)
            reason = "Unsupported systemd activation syntax requires manual review."
            try:
                words = systemd_activation_words(value, single=key in ("Unit", "Service", "DefaultInstance"))
                resolved = [(word, systemd_activation_value(word, unit)) for word in words]
            except Refused as error:
                refuse_path(str(error), path, info)
            for word, target in resolved:
                if key == "DefaultInstance":
                    if context is None or target is None:
                        refuse_path(reason, path, info)
                    target = context[0].replace("@.", "@" + target + ".", 1)
                if target is not None:
                    if not systemd_unit_name(target):
                        refuse_path(reason, path, info)
                    target_context = systemd_template(target)
                    if target_context is not None and not target_context[1]:
                        if context is None:
                            if unit is None or key not in IMPLICIT_INSTANCE_KEYS:
                                refuse_path(reason, path, info)
                            # systemd resolves a plain unit's template dependency using its prefix.
                            # Audit that concrete identity too; keeping only the template would hide UID use.
                            target = target.replace("@.", "@" + unit.rsplit(".", 1)[0] + ".", 1)
                        else:
                            target = target.replace("@.", "@" + context[1] + ".", 1) if context[1] else None
                if target is None:
                    if not defer or context is None or context[1]:
                        refuse_path(reason, path, info)
                    template_activations.setdefault(context[0], {})[path, key, value] = (path, info, key, value)
                else:
                    if not systemd_unit_name(target):
                        refuse_path(reason, path, info)
                    try:
                        systemd_activation_words(target, single=True)  # Source specifiers can also introduce escapes.
                        unescaped = systemd_unescape_component(target)
                    except Refused as error:
                        refuse_path(str(error), path, info)
                    if target in UNITS or unescaped in UNITS:
                        refuse_path("Native service is referenced by an unrelated activation declaration.", path, info)
                    register_unit(target, path, info)
                activation_references.add((path, unit or "", key, word, target or ""))
                if len(activation_references) > MAX_UNIT_REFERENCES:
                    refuse_path("Systemd activation references exceed their budget.", path, info)

        def remember(path: str, info: os.stat_result, value: dict) -> None:
            """Bind each chain inode once per scan; raw link spelling is significant too."""
            if linked_evidence.setdefault(path, value) != value:
                refuse_path("Linked unit evidence changed during review.", path, info)

        def inspect_file(path: str, expected: os.stat_result | None = None, *, unit: str | None = None, systemd: bool = True) -> None:
            info = self.fs.info(path)
            if info is None:
                refuse_path("Configuration declaration disappeared during review.", path, None)
            if expected is not None and stamp(info) != stamp(expected):
                refuse_path("Linked unit declaration changed before reading.", path, info)
            try:
                raw = self.fs.read(path)
            except Refused as error:
                refuse_path(str(error), path, info)
            except OSError:
                refuse_path("Configuration declaration could not be read safely.", path, info)
            after = self.fs.info(path)
            if after is None or stamp(info) != stamp(after):
                refuse_path("Configuration declaration changed during review.", path, after)
            evidence[path] = hashlib.sha256(raw).hexdigest()
            if expected is not None or systemd:
                remember(path, info, {"inode": stamp(info), "sha256": evidence[path]})
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                refuse_path("Configuration declaration is not valid UTF-8.", path, info)
            # Literal native references remain forbidden in both units and cron scripts.
            active = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(("#", ";")))
            if any(token in active for token in tokens):
                refuse_path("Dedicated identity or native service is referenced by unrelated configuration.", path, info)
            if not systemd:
                return  # Cron environment/shell syntax is not a systemd identity declaration.
            register_unit(unit, path, info)
            # Keep the conservative physical numeric guard in addition to logical unit parsing.
            for line in active.splitlines():
                key, _, value = line.partition("=")
                if key.strip() in ("User", "Group", "SupplementaryGroups") and set(value.strip().strip('"').split()) & numbers:
                    refuse_path("Dedicated numeric identity is used by another service.", path, info)
            try:
                logical = systemd_logical_lines(text)
            except Refused as error:
                refuse_path(str(error), path, info)
            for line in logical:
                if any(token in line for token in tokens):
                    refuse_path("Dedicated identity or native service is referenced by unrelated configuration.", path, info)
                key, separator, value = line.partition("=")
                key = key.strip(" \t")
                if key in ACTIVATION_KEYS:
                    if not separator:
                        refuse_path("Unsupported systemd activation syntax requires manual review.", path, info)
                    audit_activation(key, value, unit, path, info)
                    continue
                if key.strip("\"'") in ACTIVATION_KEYS or any(key.startswith(name + ending) for name in ACTIVATION_KEYS for ending in (" ", "\t", "+", "\\")):
                    refuse_path("Unsupported systemd activation syntax requires manual review.", path, info)
                if key not in ("User", "Group", "SupplementaryGroups"):
                    if key.strip("\"'") in ("User", "Group", "SupplementaryGroups") or re.match(r"^(User|Group|SupplementaryGroups)[ \t+\\\\]", key):
                        refuse_path("Unsupported systemd identity syntax requires manual review.", path, info)
                    continue
                if not separator:
                    refuse_path("Unsupported systemd identity syntax requires manual review.", path, info)
                audit_identity(key, value, unit, path, info)

        def entry(parent: int, name: str, path: str) -> os.stat_result:
            """Obtain only no-follow metadata, including for missing-target diagnostics."""
            try:
                return os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                refuse_path("Missing linked unit declaration requires manual recovery.", path, None)
            except OSError:
                refuse_path("Linked unit metadata is unavailable.", path, None)

        def link_text(parent: int, name: str, path: str, info: os.stat_result, chain: dict | None) -> str:
            """Symlink mode bits do not confer write access; ownership and protected parents do."""
            if not (stat.S_ISLNK(info.st_mode) and info.st_nlink == 1 and (info.st_uid, info.st_gid) == (self.fs.owner, root_gid)):
                refuse_path("Unowned or multiply-linked unit declaration.", path, info)
            try:
                text = os.readlink(name, dir_fd=parent)
            except OSError:
                refuse_path("Linked unit declaration could not be read safely.", path, entry(parent, name, path))
            after = entry(parent, name, path)
            if stamp(info) != stamp(after):
                refuse_path("Linked unit declaration changed during review.", path, after)
            if not text or "\0" in text or len(os.fsencode(text)) > MAX_UNIT_PATH:
                refuse_path("Linked unit declaration exceeds its path budget or has an invalid target.", path, info)
            remember(path, info, {"inode": stamp(info), "target": text})
            if chain is not None:
                chain[path] = text
            return text

        @contextmanager
        def linked_parent(path: str, chain: dict | None = None) -> Iterator[tuple[int, str, str]]:
            """Verify every traversed directory before resolving '..'; never lexically hide a link."""
            if not path.startswith("/") or "\0" in path or len(os.fsencode(path)) > MAX_UNIT_PATH:
                refuse_path("Linked unit declaration exceeds its path budget or has an invalid target.", path, None)
            pending = path[1:].split("/")
            if len(pending) > MAX_DEPTH or pending[-1] in ("", ".", ".."):
                refuse_path("Linked unit path exceeds its depth budget or is not a regular declaration.", path, None)
            descriptors = [os.dup(self.fs.root_fd)]
            components = []
            try:
                root = os.fstat(descriptors[0])
                if not (stat.S_ISDIR(root.st_mode) and (root.st_uid, root.st_gid) == (self.fs.owner, root_gid) and not root.st_mode & 0o022):
                    refuse_path("Unsafe linked unit ancestor.", "/", root)
                remember("/", root, {"directory": [root.st_dev, root.st_ino, root.st_mode, root.st_uid, root.st_gid]})
                while len(pending) > 1:
                    self.fs.tick()
                    part = pending.pop(0)
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if components:
                            os.close(descriptors.pop())
                            components.pop()
                        continue
                    current = "/" + "/".join([*components, part])
                    info = entry(descriptors[-1], part, current)
                    if any(beneath(current, root) for root in ROOTS):
                        refuse_path("Linked unit declaration traverses native cleanup scope.", current, info)
                    if current == "/lib" and pending[:2] == ["systemd", "system"] and stat.S_ISLNK(info.st_mode):
                        if link_text(descriptors[-1], part, current, info, chain) not in ("usr/lib", "/usr/lib"):
                            refuse_path("Unverified linked unit search directory.", current, info)
                        pending = ["usr", "lib", *pending]
                        continue
                    if not (stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (self.fs.owner, root_gid) and not info.st_mode & 0o022):
                        refuse_path("Unsafe linked unit ancestor.", current, info)
                    try:
                        child = os.open(part, TRAVERSE_FLAGS, dir_fd=descriptors[-1])
                    except OSError:
                        refuse_path("Linked unit ancestor could not be opened safely.", current, entry(descriptors[-1], part, current))
                    descriptors.append(child)
                    found = os.fstat(child)
                    if stamp(info) != stamp(found):
                        refuse_path("Linked unit ancestor changed during review.", current, found)
                    remember(current, found, {"directory": [found.st_dev, found.st_ino, found.st_mode, found.st_uid, found.st_gid]})
                    components.append(part)
                current = "/" + "/".join([*components, pending[0]])
                if len(components) >= MAX_DEPTH or len(os.fsencode(current)) > MAX_UNIT_PATH:
                    refuse_path("Linked unit declaration exceeds its path budget.", current, None)
                yield descriptors[-1], pending[0], current
            finally:
                for descriptor in reversed(descriptors):
                    os.close(descriptor)

        def linked(path: str, *, unit: str | None = None, systemd: bool = True) -> None:
            """Read external declarations; never add them to owned services or cleanup paths."""
            origin, seen, chain = path, set(), {}
            last_path, last_info = path, None
            for _ in range(MAX_UNIT_LINK_STEPS):
                self.fs.tick()
                with linked_parent(path, chain) as (parent, name, current):
                    info = entry(parent, name, current)
                    last_path, last_info = current, info
                    if current in seen:
                        refuse_path("Cyclic linked unit declaration requires manual recovery.", current, info)
                    seen.add(current)
                    if any(beneath(current, root) for root in ROOTS):
                        refuse_path("Linked unit declaration targets native cleanup scope.", current, info)
                    if current == "/dev/null":
                        if not (stat.S_ISCHR(info.st_mode) and info.st_rdev == os.makedev(1, 3) and info.st_nlink == 1
                                and (info.st_uid, info.st_gid) == (self.fs.owner, root_gid)):
                            refuse_path("Unverified linked unit mask; expected the root-owned null device.", current, info)
                        remember(current, info, {"inode": stamp(info), "device": info.st_rdev})
                        break  # Explicit mask only: never open/read the device.
                    if stat.S_ISLNK(info.st_mode):
                        text = link_text(parent, name, current, info, chain)
                        path = posixpath.join(posixpath.dirname(current), text)
                        continue
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        refuse_path("Linked unit target is not a singly-linked regular declaration.", current, info)
                    if (info.st_uid, info.st_gid) != (self.fs.owner, root_gid) or info.st_mode & 0o022:
                        refuse_path("Unsafe linked unit declaration ownership or permissions.", current, info)
                    if info.st_size > MAX_METADATA:
                        refuse_path("Linked unit declaration exceeds its size budget.", current, info)
                    if current in {UNIT_DIR + "/" + unit for unit in UNITS}:
                        if origin != UNIT_DIR + "/multi-user.target.wants/" + name or chain != {origin: current}:
                            refuse_path("Native service has an unexpected alias.", current, info)
                        # Only the exact enablement already authenticated by units() is exempt from the foreign-use scan.
                        remember(current, info, {"inode": stamp(info)})
                    else:
                        linked_targets.add(current)
                        inspect_file(current, info, unit=unit, systemd=systemd)
                    break
            else:
                refuse_path("Too many linked unit declarations.", last_path, last_info)
            # Include usr-merge aliases as well as final-component links, and detect swaps during the read.
            for link, expected in chain.items():
                with linked_parent(link) as (parent, name, current):
                    found = entry(parent, name, current)
                    if link_text(parent, name, current, found, None) != expected:
                        refuse_path("Linked unit declaration changed during review.", current, found)

        def walk(path: str, depth: int = 0, *, unit: str | None = None, systemd: bool = True) -> None:
            require(depth <= MAX_DEPTH, "Configuration inventory exceeds its depth budget.")
            for name in self.fs.names(path):
                child = path + "/" + name
                info = self.fs.info(child)
                if info is None:
                    raise Refused("Configuration inventory changed during review.")
                if path == UNIT_DIR and name in UNITS:
                    continue  # Exact contents are separately authenticated by units().
                if path == "/run/systemd/transient" and name == setup_unit:
                    continue  # Never stop this unit; its inactivity is independently checked.
                context = unit
                if systemd:
                    candidate = name[:-2] if stat.S_ISDIR(info.st_mode) and name.endswith(".d") else name
                    if systemd_unit_name(candidate):
                        context = candidate
                    register_unit(context, child, info)
                if stat.S_ISDIR(info.st_mode):
                    walk(child, depth + 1, unit=context, systemd=systemd)
                elif stat.S_ISREG(info.st_mode):
                    inspect_file(child, unit=context, systemd=systemd)
                elif stat.S_ISLNK(info.st_mode):
                    linked(child, unit=context, systemd=systemd)
        for directory in (*UNIT_SEARCH, "/etc/cron.d", "/etc/cron.hourly", "/etc/cron.daily", "/etc/cron.weekly", "/etc/cron.monthly"):
            if self.fs.info(directory) is not None:
                walk(directory, systemd=directory in UNIT_SEARCH)
        if self.fs.info("/etc/crontab") is not None:
            inspect_file("/etc/crontab", systemd=False)

        loaded = {}
        for name in loaded_names:
            register_unit(name)
            properties = self.instance_properties(name)
            aliases = systemctl_unit_names(properties["Names"])
            require(name in aliases and len(aliases) <= MAX_UNIT_INSTANCES and len(aliases) == len(set(aliases)),
                    "Loaded instance aliases are unverified.")
            for alias in aliases:
                alias_context = register_unit(alias)
                require(alias_context is None or bool(alias_context[1]), "Loaded instance aliases contain an uninstantiated template.")
            for key in ("User", "Group", "SupplementaryGroups"):
                identities = systemd_identity_values(properties[key], single=key != "SupplementaryGroups")
                require(not set(identities) & (numbers | set(USERS) | set(GROUPS)), "Loaded service uses a native identity.")
            fragment = properties["FragmentPath"]
            require(fragment.startswith("/") and not any(char in fragment for char in "\\\"'\r\n\0"),
                    "Loaded instance fragment path is unresolvable.")
            linked(fragment, unit=name)
            dropins = properties["DropInPaths"].split()
            require(len(dropins) <= MAX_DEPTH and not any(char in properties["DropInPaths"] for char in "\\\"'\r\n\0")
                    and all(path.startswith("/") for path in dropins), "Loaded instance drop-in paths are unresolvable.")
            for path in dropins:
                linked(path, unit=name)
            loaded[name] = properties

        # Include unloaded dependency-only instances. Bound the fixed point; do not ask systemd to load a graph.
        audited = set()
        while concrete_units - audited:
            name = min(concrete_units - audited)
            audited.add(name)
            context = systemd_template(name)
            if context is not None:
                for path, info, key, value in template_expressions.get(context[0], []):
                    require(stamp(self.fs.info(path)) == stamp(info), "Templated identity declaration changed during review.")
                    audit_identity(key, value, name, path, info, defer=False)
                for path, info, key, value in template_activations.get(context[0], {}).values():
                    require(stamp(self.fs.info(path)) == stamp(info), "Templated activation declaration changed during review.")
                    audit_activation(key, value, name, path, info, defer=False)
        require(self.loaded_instances() == loaded_names, "Loaded instance inventory changed during review.")
        evidence["activationReferences"] = sorted(activation_references)
        evidence["unitContexts"] = sorted(unit_contexts)
        evidence["loadedInstances"] = loaded
        evidence["linkedDeclarations"] = linked_evidence
        evidence["linkedTargets"] = sorted(linked_targets)
        return evidence

    def normalize_session(self, configuration: dict) -> None:
        """After all audits, omit only our protected direct login declaration and its references."""
        scope = linux_login_scope()
        if scope is None:
            return
        path = "/run/systemd/transient/" + scope
        declarations = configuration["linkedDeclarations"]
        evidence = declarations.get(path)
        if evidence is None or set(evidence) != {"inode", "sha256"} or path in configuration["linkedTargets"]:
            return
        info = self.fs.info(path)
        if info is None or stamp(info) != evidence["inode"]:
            raise Refused("Current login declaration changed after audit.")
        self.fs.protected(info, False)
        require(info.st_gid == os.fstat(self.fs.root_fd).st_gid, "Current login declaration group is unverified.")
        self.fs.no_mounts([path])
        require(linux_login_scope() == scope, "Current login scope changed during audit.")
        del configuration[path]
        del declarations[path]
        configuration["activationReferences"] = [row for row in configuration["activationReferences"]
                                                  if not (row[0] == path and row[1] == scope)]

    def normalize_cpu_weights(self, configuration: dict, uids: set[int], gids: set[int]) -> None:
        """Project only audited CPUWeight rewrites, binding one current inode's bytes and ACLs."""
        declarations = configuration["linkedDeclarations"]
        for path in ("/run/systemd/transient/kubepods-besteffort.slice.d/50-CPUWeight.conf",
                     "/run/systemd/transient/kubepods-burstable.slice.d/50-CPUWeight.conf"):
            evidence = declarations.get(path)
            if evidence is None or set(evidence) != {"inode", "sha256"} or path in configuration["linkedTargets"]:
                continue
            info = self.fs.info(path)
            if info is None:
                raise Refused("CPUWeight property declaration changed after audit.")
            current, audited = stamp(info), evidence["inode"]
            stable = [current[0], *current[2:7]]
            require(stable == [audited[0], *audited[2:7]], "CPUWeight property metadata changed after audit.")
            self.fs.protected(info, False)
            if info.st_gid != os.fstat(self.fs.root_fd).st_gid:
                require(current == audited, "CPUWeight property declaration changed after audit.")
                continue
            self.fs.no_mounts([path.rpartition("/")[0]])
            require(info.st_size <= MAX_METADATA, "CPUWeight property declaration exceeds its read budget.")
            with self.fs.parent(path) as (parent, name):
                descriptor = os.open(name, READ_FLAGS, dir_fd=parent)
                try:
                    require(stamp(os.fstat(descriptor)) == current, "CPUWeight property declaration changed before reading.")
                    data = bytearray()
                    while len(data) <= MAX_METADATA:
                        block = os.read(descriptor, min(65536, MAX_METADATA + 1 - len(data)))
                        if not block:
                            break
                        data.extend(block)
                    raw = bytes(data)
                    require(len(raw) <= MAX_METADATA and stamp(os.fstat(descriptor)) == current
                            and stamp(self.fs.info(path)) == current and hashlib.sha256(raw).hexdigest() == evidence["sha256"],
                            "CPUWeight property declaration changed during verification.")
                    # A same-byte replacement may inherit new named ACLs after the
                    # external scan. Audit and fingerprint this held inode, not a reopen.
                    attributes = self.fs.check_acl(descriptor, uids, gids)
                    self.fs.no_mounts([path.rpartition("/")[0]])
                    require(stamp(os.fstat(descriptor)) == current and stamp(self.fs.info(path)) == current,
                            "CPUWeight property declaration changed during ACL verification.")
                finally:
                    os.close(descriptor)
            logical = [line.strip(" \t") for line in systemd_logical_lines(raw.decode("utf-8"))]
            weight = (re.fullmatch(r"CPUWeight[ \t]*=[ \t]*([1-9][0-9]{0,4})", logical[1])
                      if len(logical) == 2 and logical[0] == "[Slice]" else None)
            if weight is None or int(weight[1]) > 10000:
                require(current == audited, "CPUWeight property declaration changed after audit.")
                continue
            declarations[path] = {"sha256": evidence["sha256"], "stableMetadata": stable,
                                  "aclDigest": digest([None if value is None else hashlib.sha256(value).hexdigest() for value in attributes])}

    def inspect(self, request: dict, public: dict | None = None) -> tuple[dict, dict]:
        """A review and its apply revalidation start with identical phase allowances."""
        with self.fs.phase("inspection"):
            return self._inspect(request, public)

    def _inspect(self, request: dict, public: dict | None = None) -> tuple[dict, dict]:
        """Build a bound, read-only review; caller holds the global lock when available."""
        public = {} if public is None else public
        self.reset_parent()
        original, receipt, tree = self.authenticate(request)
        public.update({key: receipt[key] for key in ("state", "completedSteps", "totalSteps")})
        operation = OPERATIONS + "/" + original["operationId"]
        users, groups, account_state = self.account_inventory()
        public["accounts"] = (["user:" + name for name in USERS if name in users]
                              + ["group:" + name for name in GROUPS if name in groups])
        layout = self.layout(original, receipt, tree, users, groups)
        public["warnings"] = [*WARNINGS, *layout["warnings"]]
        unit_state = self.units(original)
        public["services"] = [unit for unit in UNITS if unit in unit_state["files"]]
        setup = self.service("outpost-setup-" + original["operationId"] + ".service")
        require(self.inactive(setup), "Original installer is active or unconfirmed; stop it and review again.")
        if receipt["state"] in ("queued", "running", "unknown"):
            require(self.fs.json(operation + "/launch.json").get("returnCode") == 0, "Original launch has not settled; stop and review again.")
        history = self.holds_and_peers(request, layout["completedMetadata"])
        configuration = self.other_account_use(users, groups, original)
        uids, gids = {row["uid"] for row in users.values()}, {row["gid"] for row in groups.values()}
        self.accounts.processes(uids, gids, set(unit_state["files"]))
        reserve = RESET_RECEIPT_NODE_RESERVE
        if request["mode"] in ("recover_review", "recover_apply"):
            # Count already-present, verified preparation nodes in the scan, not twice
            # in the reserve. Never credit removed native roots against future metadata.
            reserve = RECOVERY_RECEIPT_NODE_RESERVE - int(self.fs.info(RESETS) is not None)
            if self.fs.info(RESETS + "/" + request["resetId"]) is not None:
                reserve -= 3  # Verified reset directory, recovery.json and status.json.
        self.fs.outside_ownership(uids, gids, [*ROOTS, operation + "/build-home"], reserve_nodes=reserve)
        # userdel may otherwise invoke administrator-configured hooks.
        for path in ("/etc/shadow-maint/userdel-pre.d", "/etc/shadow-maint/userdel-post.d", "/etc/shadow-maint/userdel.d"):
            if self.fs.info(path) is not None:
                require(not self.fs.names(path), "Account deletion hooks require manual recovery.")
        if self.fs.info("/etc/login.defs") is not None:
            require(not re.search(rb"(?m)^\s*USERDEL_CMD\s+\S", self.fs.read("/etc/login.defs")), "Account deletion command requires manual recovery.")
        self.normalize_session(configuration)
        self.normalize_cpu_weights(configuration, uids, gids)
        snapshot = {"expected": request["expected"], "resetId": request["resetId"], "request": original,
                    "receipt": receipt, "layout": layout, "units": unit_state, "accounts": account_state,
                    "setup": setup, "history": history, "configuration": configuration, "mounts": sorted(self.fs.mounts())}
        public = {**self.base(request), "snapshotDigest": digest(snapshot), "paths": list(ROOTS),
                  "services": [unit for unit in UNITS if unit in unit_state["files"]],
                  "accounts": ["user:" + name for name in USERS if name in users] + ["group:" + name for name in GROUPS if name in groups],
                  "preserved": PRESERVED, "warnings": public["warnings"], "blockers": [], "canReset": True,
                  **{key: receipt[key] for key in ("state", "completedSteps", "totalSteps")}}
        return public, {"original": original, "users": users, "groups": groups, "units": unit_state,
                        "configuration": configuration, "trees": layout["trees"]}

    def blocked_review(self, request: dict) -> dict:
        """Keep blocked ordinary/recovery reviews identical, with no usable token."""
        return {**self.base(request), "snapshotDigest": digest({"request": request, "blocked": True}),
                "paths": list(ROOTS), "services": [], "accounts": [], "preserved": PRESERVED, "warnings": WARNINGS,
                "blockers": [], "canReset": False, "state": "unknown", "completedSteps": 0, "totalSteps": 12}

    def review(self, request: dict) -> dict:
        """No mkdir, writes, account changes or service mutations, even on refusal."""
        response = self.blocked_review(request)
        try:
            # Preserve authenticated progress even if a later safety check blocks reset.
            _, progress, _ = self.authenticate(request)
            response.update({key: progress[key] for key in ("state", "completedSteps", "totalSteps")})
            if self.fs.info(BASE + "/install.lock") is None:
                response, _ = self.inspect(request, response)
            else:
                with self.fs.lock():
                    response, _ = self.inspect(request, response)
        except SAFE_ERRORS as error:
            response["blockers"] = [public_error(error)]
        return response

    def recover_review(self, request: dict) -> dict:
        """Publish a durable same-ID barrier only after a fresh, complete safety inspection."""
        response = self.blocked_review(request)
        try:
            with self.fs.lock():
                self.reset_parent()
                previous = self.preparation(request)
                review, _ = self.inspect(request, response)
                record = {**self.base(request), "expected": request["expected"], "snapshotDigest": review["snapshotDigest"],
                          "recoveryToken": os.urandom(32).hex()}
                require(previous is None or record["recoveryToken"] != previous["recoveryToken"], "Recovery token refresh did not produce a new identity.")
                self.fs.mkdir(RESETS, 0o711, existing=True)
                directory = RESETS + "/" + request["resetId"]
                if previous is None:
                    self.fs.mkdir(directory, 0o711)
                else:
                    require(self.preparation(request) == previous, "Recovery preparation changed before refresh.")
                # Interrupted creation/refresh leaves partial or mismatched metadata:
                # neither old tokens nor ordinary apply may repair or consume it.
                self.fs.atomic(directory + "/recovery.json", encoded(record))
                bound = self.recovery_digest(record)
                self.publish({**request, "snapshotDigest": bound}, "unknown")
                require(self.preparation(request) == record, "Recovery preparation publication is unconfirmed.")
                return {**review, "snapshotDigest": bound, "recoveryToken": record["recoveryToken"]}
        except SAFE_ERRORS as error:
            response["blockers"] = [public_error(error)]
        return response

    def recover_apply(self, request: dict) -> dict:
        """Consume one exact preparation; any prior intent is a permanent replay barrier."""
        try:
            with self.fs.lock():
                self.reset_parent()
                previous = self.stored(request)
                record = self.recovery_record(request)
                require(record["recoveryToken"] == request["recoveryToken"]
                        and self.recovery_digest(record) == request["snapshotDigest"], "Recovery token or snapshot does not match preparation.")
                if previous is None or previous["snapshotDigest"] != request["snapshotDigest"]:
                    raise Refused("Recovery public barrier does not match preparation.")
                if previous["state"] == "complete":
                    return self.result(request, "complete", previous["message"])
                require(self.preparation(request) == record, "Recovery preparation is unavailable.")
                review, details = self.inspect(request)
                require(review["snapshotDigest"] == record["snapshotDigest"], "Review snapshot changed; obtain a new recovery review before applying.")
                require(self.preparation(request) == record, "Recovery preparation changed before intent.")
                review["snapshotDigest"] = request["snapshotDigest"]
                return self.cleanup(request, review, details)
        except SAFE_ERRORS as error:
            return self.result(request, "failed", public_error(error))

    def status(self, request: dict) -> dict:
        """Never infer completion from missing roots or read private original evidence."""
        try:
            value = self.stored(request)
            if value is not None:
                return self.result(request, value["state"], value["message"])
        except SAFE_ERRORS:
            pass
        return self.result(request, "unknown", "No verified reset receipt is available; do not start another installation.")

    def stop(self, request: dict) -> None:
        """Only replace the authenticated original cooperative cancellation marker.

        No systemctl stop is needed, so unsafe setup-unit ExecStop hooks can never
        run. Replacing with a fresh inode also avoids modifying an outside hardlink.
        """
        original, _, _ = self.authenticate(request)
        path = OPERATIONS + "/" + original["operationId"] + "/cancel"
        info = self.fs.info(path)
        if info is None:
            raise Refused("Original cancellation marker is missing.")
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 1, "Original cancellation marker is not verified.")
        identities, _ = self.accounts.snapshot()
        marker_users = [user for user in identities if user["uid"] == info.st_uid]
        require(info.st_gid == os.fstat(self.fs.root_fd).st_gid and (info.st_uid == self.fs.owner
                or (info.st_uid >= 1000 and len(marker_users) == 1 and marker_users[0]["name"] not in USERS)),
                "Original cancellation marker ownership is not verified.")
        require(self.fs.read(path, 1, trusted=False) in (b"", b"1"), "Original cancellation marker is invalid.")
        require(stamp(info) == stamp(self.fs.info(path)), "Cancellation marker changed.")
        self.fs.atomic(path, b"1")

    def publish(self, request: dict, state: str) -> None:
        """Public metadata is world-readable; the original evidence remains private."""
        value = {**self.result(request, state, RECEIPT_MESSAGES[state]), "bindingDigest": digest(request["expected"]),
                 "snapshotDigest": request["snapshotDigest"]}
        self.fs.atomic(RESETS + "/" + request["resetId"] + "/status.json", encoded(value), 0o644)

    def apply(self, request: dict) -> dict:
        """One-shot reset under the install lock, with intent fsynced before effects."""
        try:
            previous = self.stored(request)
            if previous is not None:
                require(previous["snapshotDigest"] == request["snapshotDigest"], "Reset snapshot identity does not match.")
                return self.result(request, previous["state"], previous["message"])
            self.authenticate(request)  # Even creating a previously absent lock requires authenticated evidence.
            with self.fs.lock(create=True):
                previous = self.stored(request)
                if previous is not None:
                    require(previous["snapshotDigest"] == request["snapshotDigest"], "Reset snapshot identity does not match.")
                    return self.result(request, previous["state"], previous["message"])
                review, details = self.inspect(request)
                require(review["snapshotDigest"] == request["snapshotDigest"], "Review snapshot changed; obtain a new review before applying.")
                self.fs.mkdir(RESETS, 0o711, existing=True)
                self.fs.mkdir(RESETS + "/" + request["resetId"], 0o711)
                return self.cleanup(request, review, details)
        except SAFE_ERRORS as error:
            return self.result(request, "failed", public_error(error))

    def cleanup(self, request: dict, review: dict, details: dict) -> dict:
        """The sole deletion engine; publish intent durably before every native effect."""
        try:
            audit_path = RESETS + "/" + request["resetId"] + "/audit.json"
            audit = {**self.base(request), "expected": request["expected"], "snapshotDigest": request["snapshotDigest"],
                     "review": review, "steps": [], "state": "unknown"}
            self.fs.atomic(audit_path, encoded(audit))
            self.publish(request, "unknown")

            def step(name: str, action: Callable[[], object]) -> None:
                audit["steps"].append({"step": name, "state": "started"})
                self.fs.atomic(audit_path, encoded(audit))
                action()
                audit["steps"][-1]["state"] = "complete"
                self.fs.atomic(audit_path, encoded(audit))

            original, users, groups = details["original"], details["users"], details["groups"]
            unit_state = details["units"]
            # Exact disk AND loaded declarations were verified, including empty stop hooks.
            # Recheck immediately before stop, never execute an installed helper.
            require(self.units(original) == unit_state, "Service snapshot changed before cleanup.")
            for unit in reversed(UNITS):
                if unit in unit_state["files"]:
                    current = self.units(original)
                    require(current["files"] == unit_state["files"] and current["links"] == unit_state["links"],
                            "Service ownership changed before stop.")
                    step("stop:" + unit, lambda unit=unit: self.runner.run(["/usr/bin/systemctl", "stop", "--", unit], 45))
                    require(self.inactive(self.service(unit)), "Native service did not become inactive.")
            uids, gids = {row["uid"] for row in users.values()}, {row["gid"] for row in groups.values()}
            self.accounts.processes(uids, gids, set())
            require(self.inactive(self.service("outpost-setup-" + original["operationId"] + ".service")), "Original installer became active.")
            for path, metadata in unit_state["links"].items():
                info = self.fs.info(path)
                require(stamp(info) == metadata, "Service enablement changed.")
                step("unlink:" + path, lambda path=path, info=info: self.fs.unlink(path, info))
            for unit, metadata in unit_state["files"].items():
                path = UNIT_DIR + "/" + unit
                info = self.fs.info(path)
                require(stamp(info) == metadata, "Service declaration changed.")
                step("unlink:" + unit, lambda path=path, info=info: self.fs.unlink(path, info))
            if unit_state["files"]:
                step("daemon-reload", lambda: self.runner.run(["/usr/bin/systemctl", "daemon-reload"]))
            checker = self.owner_check(original, users, groups)
            for path in ROOTS:
                root_metadata = details["trees"][path][0][1]
                if root_metadata is None:
                    require(self.fs.info(path) is None, "An absent native root appeared after review.")
                    continue
                step("remove:" + path, lambda path=path, metadata=root_metadata: self.fs.remove_tree(path, checker, metadata))
            self.accounts.processes(uids, gids, set())
            self.fs.outside_ownership(uids, gids, [OPERATIONS + "/" + original["operationId"] + "/build-home"])
            require(self.account_inventory()[:2] == (users, groups), "Dedicated account identity changed.")
            # Recheck dormant uses immediately before deleting identities as well.
            self.other_account_use(users, groups, original)
            for name in USERS:
                if name in users:
                    step("userdel:" + name, lambda name=name: self.runner.run(["/usr/sbin/userdel", "--", name]))
            remaining_users, remaining_groups = self.accounts.snapshot()
            require(not any(row["name"] in USERS for row in remaining_users), "Dedicated user removal is unconfirmed.")
            for name in GROUPS:
                remaining = [row for row in remaining_groups if row["name"] == name]
                if remaining:
                    require(name in groups and len(remaining) == 1 and remaining[0]["gid"] == groups[name]["gid"]
                            and not remaining[0]["members"] and not any(row["gid"] == remaining[0]["gid"] for row in remaining_users),
                            "Dedicated group identity changed during removal.")
                    step("groupdel:" + name, lambda name=name: self.runner.run(["/usr/sbin/groupdel", "--", name]))
            final_users, final_groups = self.accounts.snapshot()
            require(not any(row["name"] in USERS for row in final_users) and not any(row["name"] in GROUPS for row in final_groups),
                    "Account removal is unconfirmed.")
            require(all(self.fs.info(path) is None for path in ROOTS), "Native path removal is unconfirmed.")
            for unit in UNITS:
                state = self.service(unit)
                require(self.fs.info(UNIT_DIR + "/" + unit) is None and state["LoadState"] == "not-found" and self.inactive(state),
                        "Service removal is unconfirmed.")
            audit["state"] = "complete"
            self.fs.atomic(audit_path, encoded(audit))
            self.publish(request, "complete")
            return self.result(request, "complete", RECEIPT_MESSAGES["complete"])
        except SAFE_ERRORS:
            try:
                self.publish(request, "failed")
            except SAFE_ERRORS:
                return self.result(request, "unknown", RECEIPT_MESSAGES["unknown"])
            return self.result(request, "failed", RECEIPT_MESSAGES["failed"])

    def handle(self, value: dict) -> dict | None:
        """Single entry point for tests and CLI; privilege is never inferred from sudo env."""
        request = validate(value)
        require(request["mode"] == "status" or self.privileged, "Root authorization is required for this mode.")
        with self.fs.phase("local"):
            return getattr(self, request["mode"])(request)


RECEIPT_MESSAGES = {
    "unknown": "Reset started; completion is unconfirmed. Recovery hold: do not replay deletion or start installation.",
    "failed": "Reset is incomplete. Recovery hold: manual recovery is required; deletion will not be replayed.",
    "complete": "Native reset completed. Original operation evidence is retained; a new installation needs separate approval.",
}
SAFE_ERRORS = (Refused, Deadline, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError,
               EOFError, tarfile.TarError, subprocess.SubprocessError)


def public_error(error: Exception) -> str:
    """Only messages authored in this module may cross the trust boundary."""
    if isinstance(error, Refused):
        return str(error)
    if isinstance(error, Deadline):
        return "Reset helper budget expired; check outcome before any further action."
    return "Unsafe, changed or unavailable host evidence; manual review is required."


def read_request(source: BinaryIO) -> dict:
    """Bound the entire stdin packet, including trailing data; native must close stdin."""
    raw = source.read(MAX_INPUT + 1)
    require(len(raw) <= MAX_INPUT, "Reset request exceeds its input budget.")
    return validate(document(raw))


def main() -> None:
    """No CLI path knobs, sudo invocation or diagnostics containing private evidence."""
    def expired(_signum: int, _frame: object) -> None:
        raise Deadline()

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(10)
    root = None
    try:
        require(len(sys.argv) == 1, "Command-line arguments are not accepted.")
        request = read_request(sys.stdin.buffer)
        require(sys.flags.isolated == 1 and sys.flags.no_site == 1, "Invoke the bundled helper with Python -I -S.")
        require(sys.platform == "linux", "This helper requires Linux qualification.")
        require(request["mode"] == "status" or os.geteuid() == 0, "Root authorization is required for this mode.")
        signal.alarm(MODE_SECONDS[request["mode"]])
        root = os.open("/", TRAVERSE_FLAGS)
        response = Helper(Files(root), SystemRunner(), SystemAccounts(), os.geteuid() == 0).handle(request)
        if response is not None:
            output = encoded(response) + b"\n"
            require(len(output) <= MAX_OUTPUT, "Reset reply exceeds its output budget.")
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
    except SAFE_ERRORS:
        sys.stderr.write("Setup restart helper refused the request; no verified completion was returned.\n")
        raise SystemExit(1) from None
    finally:
        signal.alarm(0)
        if root is not None:
            os.close(root)


if __name__ == "__main__":
    main()
