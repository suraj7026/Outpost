"""Offline, read-only verifier for ONE retained Outpost runtime (stdlib only).

API: verify(root=Path('/')) -> {verifiedFiles, verifiedLinks, summary}.
The root argument is a test seam, NOT a CLI option. Import from a trusted wrapper
using isolated Python; this module never imports or executes installed code.
Only node/, node_modules/ and browsers/ are covered. Source, Python, ownership,
operation authorization and the installation lock remain the parent's concern.

Trust flows from the fixed original release digest to its runtime pins and npm
lock, then from authenticated retained archives to installed bytes. The audit
and installed package metadata are never trust anchors. Generated JSON is
validated against derived expectations, not accepted on its own hash.

All opens are read-only/no-follow/nonblocking; Linux also uses O_NOATIME (no
permission-error fallback). readlink may update symlink atime. Stat rechecks are
optimistic, not a snapshot or protection from hostile root/mount manipulation.
The parent must exclude writers for the entire verification and subsequent use.
Hardlinked files, ambiguous archive layouts, ZIP64, npm lifecycle output and
bin content normalization are deliberately refused rather than guessed.
Authenticated npm tars use pinned npm's strip-one layout, with one safe common
root (not necessarily "package"). Repeated effective paths are accepted ONLY for
regular files with identical size, SHA-256, captured metadata and canonical mode;
all other collisions refuse. Node and ZIP duplicate rules are unchanged.
BOM/CRLF differences need a separately reviewed, pinned npm transform before they
can be accepted; arbitrary executable drift must never be waived.

This is a PRE-SEAL integrity check. The authenticated installer starts the job
with UMask=0077, then later configuration() seals with a+rX,go-w. Accept only
canonical 0755/0644 or exactly 0700/0600, and report actual modes without chmod.
Success is NOT a sealed/readable-runtime assertion: the parent's later sealed
gate and real coordinator probe must establish that separately.
"""
from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import io
import json
import lzma
import os
import posixpath
import re
import stat
import struct
import tarfile
import time
import zipfile
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import IO, Self, cast

OP = 'var/lib/outpost-setup/operations/645f62a9-37c8-413e-b31e-9372bc2ed774'
RELEASE = 'opt/outpost-native/releases/host-fa9eb6b5d217af95b920'
CACHE = OP + '/build-home/.npm/_cacache/content-v2'
ARCHIVE_SHA256 = 'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57'
ARCHIVE_SIZE = 223402
PINS = 'deploy/environment/runtime-pins.json'
NODE_TOP = 'node-v24.22.1-linux-x64'
BROWSER = 'browsers/camoufox/browsers/official/158.0.1-beta.41'
FONT = 'browsers/camoufox/fontconfig/fonts-5712114d715c.conf'
FONT_SHA256 = '5712114d715c713e302930ed191408ddfedbd5bf7c34c5d380958598595b34d6'
UV_MEMBER = 'uv-0.10.9.data/scripts/uv'
TREES = ('node', 'node_modules', 'browsers')
CHUNK = 1024 * 1024
MAX_SECONDS = 600
MAX_BYTES = 32 * 1024 ** 3  # Includes repeated archive reads and expanded bytes.
MAX_FILE = 6 * 1024 ** 3
MAX_ARTIFACT = 2 * 1024 ** 3
MAX_RECORDS = 100000
MAX_MEMBERS = 60000
MAX_PACKAGES = 2048
MAX_METADATA = 2 * 1024 ** 2
MAX_CAPTURED = 32 * 1024 ** 2
MAX_ZIP_DIRECTORY = 16 * 1024 ** 2
MAX_PATH = 512
PRESEAL_UMASK = 0o077  # Original authenticated host_install.py job, not this process's umask.


class Refused(RuntimeError):
    """Fixed code plus bounded provenance labels, never raw filesystem errors.

    Context callers supply fixed component names, authenticated lock keys and
    authenticated tar header names ONLY. No installed-tree name is diagnostic
    context. Header labels contain only a safe basename, never its full path.
    """

    def __init__(self, code: str, *, component: str = '', package: str = '', member: str = '') -> None:
        self.code = code if re.fullmatch(r'[a-z_]{1,64}', code) else 'unreadable_or_invalid_input'
        self.component = component if component in ('release', 'node', 'uv', 'camoufox', 'npm') else ''
        self.package = diagnostic_package(package) if self.component == 'npm' else ''
        self.member = diagnostic_member(member)
        fields = [name + '=' + value for name, value in (
            ('component', self.component), ('package', self.package), ('member', self.member)) if value]
        super().__init__(self.code + (' [' + ' '.join(fields) + ']' if fields else ''))

    def in_context(self, component: str = '', package: str = '', member: str = '') -> Refused:
        return Refused(self.code, component=self.component or component,
                       package=self.package or package, member=self.member or member)


INPUT_ERRORS = (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError,
                EOFError, tarfile.TarError, zipfile.BadZipFile, zipfile.LargeZipFile,
                lzma.LZMAError, zlib.error, struct.error, RuntimeError)


def need(condition: object, code: str) -> None:
    if not condition:
        raise Refused(code)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stamp(info: os.stat_result) -> tuple:
    return tuple(getattr(info, name) for name in (
        'st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
        'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def safe_path(value: str) -> str:
    """No normalization of untrusted archive names, except at explicit roots."""
    need(isinstance(value, str) and 0 < len(value) <= MAX_PATH, 'unsafe_path')
    need('\\' not in value and ':' not in value and
         all(ord(c) >= 32 and ord(c) != 127 for c in value), 'unsafe_path')
    parts = value.split('/')
    need(len(parts) <= 64 and all(p not in ('', '.', '..') and len(p) <= 255
                                  for p in parts), 'unsafe_path')
    return value


def diagnostic_package(value: str) -> str:
    """Only caller-provided authenticated lock keys are eligible for display."""
    if not value or len(value) > 240 or not value.startswith('node_modules/'):
        return ''
    try:
        safe_path(value)
    except Refused:
        return ''
    return value if re.fullmatch(r'[A-Za-z0-9_@./+~-]+', value) else ''


def diagnostic_member(value: str) -> str:
    """Validate the entire authenticated header before exposing its basename."""
    if not value or len(value) > MAX_PATH:
        return ''
    parts = value.removesuffix('/').split('/')
    if any(part in ('', '..') for part in parts):
        return ''
    name = '/'.join(part for part in parts if part != '.')
    try:
        safe_path(name)
    except Refused:
        return ''
    basename = name.rsplit('/', 1)[-1]
    return basename if re.fullmatch(r'[A-Za-z0-9_@.+~-]{1,128}', basename) else ''


@contextmanager
def refusal_context(component: str, package: str = '') -> Iterator[None]:
    """Attach provenance even to failures before the SRI-authenticated parse."""
    try:
        yield
    except Refused as error:
        raise error.in_context(component, package) from None
    except INPUT_ERRORS:
        raise Refused('unreadable_or_invalid_input', component=component, package=package) from None


def document(data: bytes) -> dict:
    """Bounded JSON without duplicate keys, non-finite numbers or nonobjects."""
    need(len(data) <= MAX_METADATA, 'metadata_limit')

    def unique(pairs: list) -> dict:
        result = {}
        for key, value in pairs:
            need(key not in result, 'duplicate_json_key')
            result[key] = value
        return result

    def invalid(_: str) -> None:
        raise Refused('invalid_json')

    value = json.loads(data, object_pairs_hook=unique, parse_constant=invalid)
    need(type(value) is dict, 'invalid_json')
    return value


class Budget:
    """One shared resource budget, including decompression and final rechecks."""

    def __init__(self) -> None:
        self.deadline = time.monotonic() + MAX_SECONDS
        self.bytes = self.members = self.captured = 0

    def tick(self, size: int = 0, members: int = 0) -> None:
        self.bytes += size
        self.members += members
        need(time.monotonic() < self.deadline, 'time_limit')
        need(self.bytes <= MAX_BYTES, 'byte_limit')
        need(self.members <= MAX_RECORDS * 4, 'record_limit')

    def capture(self, size: int) -> None:
        self.captured += size
        need(size <= MAX_METADATA and self.captured <= MAX_CAPTURED, 'metadata_limit')


class Reader(io.BufferedIOBase):
    """Account for every read without buffering entire artifacts or members."""

    def __init__(self, stream: IO[bytes] | io.BufferedIOBase, budget: Budget) -> None:
        self.stream, self.budget = stream, budget

    def read(self, size: int | None = -1) -> bytes:
        self.budget.tick()
        # zipfile reads the bounded central directory in one call. Member hashing
        # and tar decompression use fixed chunks; no unbounded read is allowed.
        if size is None or size == -1:
            offset = self.stream.tell()
            size = self.stream.seek(0, 2) - offset
            self.stream.seek(offset)
        need(0 <= size <= MAX_ZIP_DIRECTORY, 'read_limit')
        data = self.stream.read(size)
        self.budget.tick(len(data))
        return data

    def seek(self, offset: int, whence: int = 0) -> int:
        self.budget.tick()
        return self.stream.seek(offset, whence)

    def tell(self) -> int:
        return self.stream.tell()

    def seekable(self) -> bool:
        return self.stream.seekable()

    def readable(self) -> bool:
        return True


class Files:
    """Descriptor-relative paths, bounded snapshots, and end-of-run rechecks."""

    def __init__(self, root: Path, budget: Budget) -> None:
        need(isinstance(root, Path) and root.is_absolute() and '..' not in root.parts,
             'unsafe_root')
        self.root, self.budget = root, budget
        self.flags = (os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC |
                      getattr(os, 'O_NOATIME', 0))
        self.seen: dict[str, tuple | None] = {}
        self.anchors: list[tuple[int, str, tuple]] = []
        self.fd = -1

    def __enter__(self) -> Self:
        fd = os.open('/', self.flags | os.O_DIRECTORY)
        try:
            for part in self.root.parts[1:]:
                self.budget.tick()
                before = os.stat(part, dir_fd=fd, follow_symlinks=False)
                need(stat.S_ISDIR(before.st_mode), 'unsafe_root')
                child = os.open(part, self.flags | os.O_DIRECTORY, dir_fd=fd)
                self.anchors.append((fd, part, stamp(before)))
                fd = child
                need(stamp(os.fstat(fd)) == stamp(before), 'changed_during_read')
            self.fd = fd
            self.remember('', os.fstat(fd))
            return self
        except BaseException:
            os.close(fd)
            for parent, _, _ in reversed(self.anchors):
                os.close(parent)
            raise

    def __exit__(self, *args: object) -> None:
        os.close(self.fd)
        for parent, _, _ in reversed(self.anchors):
            os.close(parent)

    def remember(self, path: str, info: os.stat_result | None) -> None:
        value = stamp(info) if info is not None else None
        need(path not in self.seen or self.seen[path] == value, 'changed_during_read')
        self.seen[path] = value
        need(len(self.seen) <= MAX_RECORDS, 'record_limit')
        self.budget.tick()

    @contextmanager
    def directory(self, path: str) -> Iterator[int]:
        if path:
            safe_path(path)
        fd = os.dup(self.fd)
        prefix = ''
        try:
            self.remember('', os.fstat(fd))
            for part in path.split('/') if path else ():
                prefix = prefix + '/' + part if prefix else part
                before = os.stat(part, dir_fd=fd, follow_symlinks=False)
                need(stat.S_ISDIR(before.st_mode), 'not_directory')
                child = os.open(part, self.flags | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
                need(stamp(before) == stamp(os.fstat(fd)), 'changed_during_read')
                self.remember(prefix, before)
            yield fd
            self.remember(path, os.fstat(fd))
        finally:
            os.close(fd)

    def info(self, path: str, missing: bool = False) -> os.stat_result | None:
        safe_path(path)
        parent, _, name = path.rpartition('/')
        try:
            with self.directory(parent) as fd:
                result = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            if not missing:
                raise
            result = None
        self.remember(path, result)
        return result

    @contextmanager
    def regular(self, path: str, limit: int = MAX_FILE) -> Iterator[tuple[Reader, os.stat_result]]:
        safe_path(path)
        parent, _, name = path.rpartition('/')
        with self.directory(parent) as directory:
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            need(stat.S_ISREG(before.st_mode), 'not_regular')
            need(before.st_nlink == 1 and not before.st_mode & 0o6000, 'unsafe_file')
            need(0 <= before.st_size <= limit, 'file_limit')
            self.remember(path, before)
            fd = os.open(name, self.flags, dir_fd=directory)
            with os.fdopen(fd, 'rb', buffering=0) as stream:
                need(stamp(before) == stamp(os.fstat(stream.fileno())), 'changed_during_read')
                yield Reader(stream, self.budget), before
                need(stamp(before) == stamp(os.fstat(stream.fileno())) ==
                     stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'changed_during_read')

    def read(self, path: str, limit: int = MAX_METADATA) -> bytes:
        with self.regular(path, limit) as (stream, info):
            data = stream.read(info.st_size)
            need(len(data) == info.st_size, 'changed_during_read')
            return data

    def link(self, path: str) -> str:
        parent, _, name = safe_path(path).rpartition('/')
        with self.directory(parent) as fd:
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            need(stat.S_ISLNK(before.st_mode) and before.st_nlink == 1, 'unsafe_link')
            self.remember(path, before)
            target = os.readlink(name, dir_fd=fd)
            self.remember(path, os.stat(name, dir_fd=fd, follow_symlinks=False))
            need(0 < len(target) <= MAX_PATH, 'unsafe_link')
            return target

    def inventory(self, tree: str) -> dict[str, os.stat_result]:
        result = {}

        def descend(fd: int, path: str, depth: int, device: int) -> None:
            need(depth <= 64, 'depth_limit')
            before = os.fstat(fd)
            self.remember(RELEASE + '/' + path, before)
            result[path] = before
            with os.scandir(fd) as entries:
                for entry in entries:
                    self.budget.tick(members=1)
                    relative = safe_path(path + '/' + entry.name)
                    info = entry.stat(follow_symlinks=False)
                    need(info.st_dev == device, 'mount_boundary')
                    need(not info.st_mode & 0o6000, 'unsafe_mode')
                    need(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or
                         stat.S_ISLNK(info.st_mode), 'special_file')
                    if not stat.S_ISDIR(info.st_mode):
                        need(info.st_nlink == 1, 'hardlinked_file')
                    if not stat.S_ISLNK(info.st_mode):
                        need(not info.st_mode & 0o022, 'unsafe_mode')
                    self.remember(RELEASE + '/' + relative, info)
                    result[relative] = info
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(entry.name, self.flags | os.O_DIRECTORY, dir_fd=fd)
                        try:
                            need(stamp(info) == stamp(os.fstat(child)), 'changed_during_read')
                            descend(child, relative, depth + 1, device)
                        finally:
                            os.close(child)
            self.remember(RELEASE + '/' + path, os.fstat(fd))

        with self.directory(RELEASE + '/' + tree) as fd:
            descend(fd, tree, 0, os.fstat(fd).st_dev)
        return result

    def finish(self) -> None:
        """Also catches mutations after an early file read and optional arrivals."""
        for path, expected in list(self.seen.items()):
            self.budget.tick()
            if not path:
                need(stamp(os.fstat(self.fd)) == expected, 'changed_during_read')
            else:
                self.info(path, missing=expected is None)
        for parent, name, expected in self.anchors:
            need(stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected,
                 'changed_during_read')


@dataclass(frozen=True)
class Entry:
    """Expected content derived from an authenticated artifact, never the tree."""

    kind: str
    digest: str = ''
    size: int | None = 0
    mode: int = 0o644
    targets: tuple[str, ...] = ()
    data: bytes | None = None
    owner: str = ''


def add(tree: dict[str, Entry], path: str, entry: Entry) -> None:
    safe_path(path)
    parent = posixpath.dirname(path)
    if parent:
        if parent not in tree:
            add(tree, parent, Entry('directory', mode=0o755))
        need(tree[parent].kind == 'directory', 'archive_path_conflict')
    if path in tree:
        need(entry.kind == tree[path].kind == 'directory', 'duplicate_path')
    else:
        tree[path] = entry
    need(len(tree) <= MAX_RECORDS, 'record_limit')


def content(stream: IO[bytes] | io.BufferedIOBase, size: int, budget: Budget,
            capture: bool = False, algorithm: str = 'sha256') -> tuple[str, bytes | None]:
    need(0 <= size <= MAX_FILE, 'file_limit')
    if capture:
        budget.capture(size)
    digest = hashlib.new(algorithm)
    pieces = []
    remaining = size
    while remaining:
        budget.tick()
        block = stream.read(min(CHUNK, remaining))
        need(block and len(block) <= remaining, 'truncated_content')
        budget.tick(len(block))
        digest.update(block)
        if capture:
            pieces.append(block)
        remaining -= len(block)
    need(not stream.read(1), 'content_size_mismatch')
    return digest.hexdigest(), b''.join(pieces) if capture else None


@contextmanager
def artifact(files: Files, path: str, digest: str, algorithm: str = 'sha256',
             size: int | None = None) -> Iterator[Reader]:
    """Hash BEFORE parsing, and retain the same checked descriptor throughout."""
    need(isinstance(digest, str) and re.fullmatch('[0-9a-f]+', digest), 'invalid_pin')
    with files.regular(path, MAX_ARTIFACT) as (stream, info):
        need(size is None or info.st_size == size, 'artifact_size_mismatch')
        actual, _ = content(stream, info.st_size, files.budget, algorithm=algorithm)
        need(actual == digest, 'artifact_digest_mismatch')
        stream.seek(0)
        yield stream


class BoundedTarInfo(tarfile.TarInfo):
    """Bound extension records before tarfile allocates PAX/GNU payloads."""

    @classmethod
    def frombuf(cls, buf: bytes | bytearray, encoding: str, errors: str) -> tarfile.TarInfo:
        member = super().frombuf(buf, encoding, errors)
        extension = member.type in (tarfile.XHDTYPE, tarfile.XGLTYPE,
                                    tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)
        need(0 <= member.size <= (MAX_METADATA if extension else MAX_FILE), 'tar_member_limit')
        need(not member.issparse(), 'unsupported_tar_member')
        return member


def npm_member_path(name: str, root: str | None) -> tuple[str, str]:
    """Model authenticated npm 11.19.1/pacote strip:1, without npm's overwrites.

    tar's CHECKPATH strips exactly one component before path.resolve removes
    literal dot components. Reject absolute/traversing/empty components BEFORE
    that operation. In particular, do not discard a leading './' and then strip
    a second component. The caller checks repeated regular-file entries for
    exact content/type/canonical-mode equality; no last-entry-wins behavior.
    """
    need(0 < len(name) <= MAX_PATH and len(name.split('/')) <= 64, 'unsafe_path')
    parts = name.split('/')
    prefix = safe_path(parts[0])
    for part in parts[1:]:
        if part != '.':
            safe_path(part)
    need(root is None or root == prefix, 'archive_prefix')
    return prefix, '/'.join(part for part in parts[1:] if part != '.')


def tar_entries(stream: Reader, budget: Budget, compression: str, top: str | None,
                destination: str, captures: set[str] | None = None,
                package_json: bool = False) -> dict[str, Entry]:
    """Stream authenticated tar bytes; top=None selects npm's guarded strip-one.

    Node always passes the exact NODE_TOP. The release uses top=''. No disk
    extraction occurs. Hash/SRI authentication belongs to the enclosing artifact
    context and MUST complete before calling this parser.
    """
    result: dict[str, Entry] = {}
    seen: set[str] = set()
    member_count = 0
    npm_root = None
    header = ''
    component = 'npm' if top is None else 'node' if top == NODE_TOP else 'release' if top == '' else ''
    with refusal_context(component, destination if top is None else ''):
        try:
            # LZMAFile's IO annotation excludes valid BufferedIOBase subclasses.
            with (gzip.GzipFile(fileobj=stream) if compression == 'gz' else lzma.LZMAFile(cast(IO[bytes], stream))) as expanded, \
                    tarfile.open(fileobj=Reader(expanded, budget), mode='r|', tarinfo=BoundedTarInfo) as archive:
                while True:
                    header = ''  # Never misattribute a failed next-header parse.
                    member = archive.next()
                    if member is None:
                        break
                    header = member.name
                    budget.tick(members=1)
                    member_count += 1
                    need(member_count <= MAX_MEMBERS, 'member_limit')
                    name = member.name if top is None else member.name.removeprefix('./')
                    if member.isdir():
                        name = name.removesuffix('/')
                    if top is None:
                        npm_root, name = npm_member_path(name, npm_root)
                    elif top:
                        need(name == top or name.startswith(top + '/'), 'archive_prefix')
                        name = '' if name == top else name[len(top) + 1:]
                    elif name == '.':
                        name = ''
                    duplicate = name in seen
                    need(not duplicate or (top is None and bool(name)),
                         'duplicate_effective_path' if top is None else 'duplicate_archive_member')
                    seen.add(name)
                    need(not member.mode & 0o6000 and not member.sparse, 'unsafe_archive_mode')
                    if not name:
                        need(member.isdir(), 'archive_root_type')
                        continue
                    safe_path(name)
                    path = destination + '/' + name if destination else name
                    if member.isdir():
                        entry = Entry('directory', mode=0o755)
                    elif member.isfile():
                        keep = name in (captures or ()) or (package_json and
                               (name == 'package.json' or name.endswith('/package.json')))
                        source = archive.extractfile(member)
                        if source is None:
                            raise Refused('truncated_content')
                        with source:
                            digest, data = content(source, member.size, budget, capture=keep)
                        entry = Entry('file', digest, member.size,
                                      0o755 if member.mode & 0o111 else 0o644, data=data, owner=destination)
                    elif member.issym():
                        need(member.size == 0, 'unsupported_tar_member')
                        entry = Entry('link', mode=0o777, targets=(member.linkname,), owner=destination)
                    else:
                        raise Refused('unsupported_tar_member')
                    if duplicate:
                        # Both streams have been read. Entry equality includes
                        # size, digest, canonical execution mode and any captured
                        # metadata bytes. Never overwrite the first proof, and
                        # never extend this exception to links or directories.
                        need(entry.kind == 'file' and result.get(path) == entry, 'duplicate_effective_path')
                    else:
                        add(result, path, entry)
        except Refused as error:
            raise error.in_context(member=header) from None
        except INPUT_ERRORS:
            raise Refused('unreadable_or_invalid_input', member=header) from None
    return result


def zip_directory(stream: Reader) -> int:
    """Bound zipfile's eager central-directory allocation before constructing it."""
    end = stream.seek(0, 2)
    start = max(0, end - 65557)
    stream.seek(start)
    tail = stream.read(end - start)
    index = tail.rfind(b'PK\x05\x06')
    need(index >= 0 and len(tail) - index >= 22, 'invalid_zip')
    _, disk, directory_disk, local_count, count, size, offset, comment = struct.unpack(
        '<4s4H2LH', tail[index:index + 22])
    need(disk == directory_disk == 0 and local_count == count and count < 65535 and
         count <= MAX_MEMBERS and size <= MAX_ZIP_DIRECTORY and
         offset + size == start + index and len(tail) == index + 22 + comment,
         'unsupported_zip_directory')
    stream.seek(0)
    return count


def zip_entries(stream: Reader, budget: Budget, destination: str,
                selected: str | None = None) -> dict[str, Entry]:
    count = zip_directory(stream)
    result: dict[str, Entry] = {}
    seen = set()
    with zipfile.ZipFile(stream) as archive:
        need(len(archive.infolist()) == count, 'invalid_zip_directory')
        for member in archive.infolist():
            budget.tick(members=1)
            need(member.orig_filename == member.filename, 'unsafe_zip_member')
            name = member.filename.removesuffix('/') if member.is_dir() else member.filename
            safe_path(name)
            need(name not in seen, 'duplicate_archive_member')
            seen.add(name)
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            need(not mode & 0o6000 and kind in (0, stat.S_IFDIR, stat.S_IFREG),
                 'unsafe_zip_member')
            need(not member.flag_bits & 1 and member.compress_type in
                 (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'unsupported_zip_member')
            need((member.is_dir() and kind != stat.S_IFREG and member.file_size == 0) or
                 (not member.is_dir() and kind != stat.S_IFDIR), 'unsafe_zip_member')
            if selected is not None and name != selected:
                continue
            path = destination if selected is not None else destination + '/' + name
            if member.is_dir():
                need(selected is None, 'unsafe_zip_member')
                add(result, path, Entry('directory', mode=0o755))
            else:
                with archive.open(member) as source:
                    digest, _ = content(source, member.file_size, budget)
                add(result, path, Entry('file', digest, member.file_size,
                                        0o755 if mode & 0o111 else 0o644))
    need(selected is None or destination in result, 'missing_uv_member')
    return result


def merge(tree: dict[str, Entry], additions: dict[str, Entry]) -> None:
    for path, entry in additions.items():
        add(tree, path, entry)


def authenticated_inputs(files: Files) -> tuple[dict, dict]:
    with refusal_context('release'), artifact(files, OP + '/release.tar.gz', ARCHIVE_SHA256, size=ARCHIVE_SIZE) as stream:
        entries = tar_entries(stream, files.budget, 'gz', '', '', {PINS, 'package-lock.json'})
    need(PINS in entries and 'package-lock.json' in entries, 'missing_release_metadata')
    pins = document(entries[PINS].data or b'')
    lock = document(entries['package-lock.json'].data or b'')
    need(pins.get('nodeVersion') == '24.22.1' and pins.get('uvVersion') == '0.10.9' and
         pins.get('camoufoxVersion') == '158.0.1' and pins.get('camoufoxBuild') == 'beta.41' and
         type(pins.get('camoufoxInterface')) is int and pins['camoufoxInterface'] == 1,
         'unsupported_runtime_pins')
    for key in ('nodeSha256', 'uvSha256', 'camoufoxSha256'):
        need(isinstance(pins.get(key), str) and re.fullmatch('[0-9a-f]{64}', pins[key]),
             'invalid_pin')
    need(type(lock.get('lockfileVersion')) is int and lock['lockfileVersion'] == 3 and
         type(lock.get('packages')) is dict and '' in lock['packages'] and
         len(lock['packages']) <= MAX_PACKAGES, 'unsupported_lock')
    return pins, lock


def package_location(path: str) -> tuple[str, str, str]:
    """Return node_modules container, package name and containing package root."""
    parts = safe_path(path).split('/')
    offset = 0
    parent = ''
    while offset < len(parts):
        start = offset
        need(parts[offset] == 'node_modules', 'invalid_package_path')
        offset += 1
        need(offset < len(parts), 'invalid_package_path')
        if parts[offset].startswith('@'):
            need(len(parts[offset]) > 1 and offset + 1 < len(parts), 'invalid_package_path')
            offset += 2
        else:
            offset += 1
        name = '/'.join(parts[start + 1:offset])
        need(all(re.fullmatch(r'@?[A-Za-z0-9_~][A-Za-z0-9._~+-]*', p)
                 for p in name.split('/')), 'invalid_package_path')
        container = '/'.join(parts[:start + 1])
        if offset == len(parts):
            return container, name, parent
        parent = '/'.join(parts[:offset])
    raise Refused('invalid_package_path')


def sri(value: object) -> tuple[str, str, str]:
    """This lock uses single, canonical strong SRI values; no weak fallback."""
    if not isinstance(value, str) or len(value) > 256 or '-' not in value:
        raise Refused('unsupported_sri')
    algorithm, encoded = value.split('-', 1)
    need(algorithm in ('sha256', 'sha384', 'sha512'), 'unsupported_sri')
    try:
        digest = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise Refused('unsupported_sri') from None
    need(len(digest) == hashlib.new(algorithm).digest_size and
         base64.b64encode(digest).decode('ascii') == encoded, 'unsupported_sri')
    hexed = digest.hex()
    return algorithm, hexed, CACHE + '/' + algorithm + '/' + hexed[:2] + '/' + hexed[2:4] + '/' + hexed[4:]


def bins(value: object, name: str) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, str):
        value = {name.rsplit('/', 1)[-1]: value}
    if not isinstance(value, dict) or len(value) > 128:
        raise Refused('unsupported_package_bin')
    result = {}
    for key, target in value.items():
        need(isinstance(key, str) and key not in ('.', '..') and
             re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}', key), 'unsupported_package_bin')
        if not isinstance(target, str):
            raise Refused('unsupported_package_bin')
        result[key] = safe_path(target.removeprefix('./'))
    return result


def bundled_names(metadata: dict) -> set[str]:
    value = metadata.get('bundleDependencies', metadata.get('bundledDependencies', []))
    if value is True:
        value = list(metadata.get('dependencies', {}))
    if value is False:
        value = []
    need(type(value) is list and all(isinstance(x, str) for x in value), 'unsupported_bundle')
    return set(value)


def npm_tree(files: Files, lock: dict, installed: dict[str, os.stat_result]) -> tuple[dict[str, Entry], dict, dict]:
    packages = {path: entry for path, entry in lock['packages'].items() if path}
    for path, entry in packages.items():
        package_location(path)
        need(type(entry) is dict and isinstance(entry.get('version'), str) and
             not entry.get('link'), 'unsupported_package')
        need('optional' not in entry or type(entry['optional']) is bool, 'unsupported_package')
    result: dict[str, Entry] = {'node_modules': Entry('directory', mode=0o755)}
    present, absent, manifests = {}, [], {}
    candidates: dict[str, set[str]] = {}
    for path in sorted(packages, key=lambda p: (p.count('/'), p)):
        entry = packages[path]
        container, name, parent = package_location(path)
        if path not in installed:
            files.info(RELEASE + '/' + path, missing=True)
            need(entry.get('optional') is True, 'missing_required_package')
            need(not any(p == path or p.startswith(path + '/') for p in result), 'missing_bundled_package')
            absent.append(path)
            continue
        need(stat.S_ISDIR(installed[path].st_mode), 'package_not_directory')
        need(not parent or parent in present, 'missing_parent_package')
        if entry.get('inBundle') is True:
            proof = result.get(path + '/package.json')
            if proof is None or proof.owner not in manifests or not path.startswith(proof.owner + '/node_modules/'):
                raise Refused('unproven_bundle')
            relative = path[len(proof.owner) + 1:]
            parts = relative.split('/')
            direct = '/'.join(parts[1:3]) if parts[1].startswith('@') else parts[1]
            need(direct in bundled_names(manifests[proof.owner]), 'undeclared_bundle')
        else:
            with refusal_context('npm', path):
                algorithm, digest, cache = sri(entry.get('integrity'))
                with artifact(files, cache, digest, algorithm) as stream:
                    additions = tar_entries(stream, files.budget, 'gz', None, path, package_json=True)
            # node_modules trees inside a tar must be represented by inBundle
            # lock entries. A parent tar cannot silently replace a nested install.
            for child in additions:
                if child.startswith(path + '/node_modules/'):
                    owners = [p for p in packages if child == p or child.startswith(p + '/')]
                    owner = max(owners, key=len, default=path)
                    if additions[child].kind != 'directory':
                        need(owner != path and packages[owner].get('inBundle') is True,
                             'unlocked_bundled_content')
                need('/.bin/' not in child and not child.endswith('/.bin'), 'archive_bin_directory')
            merge(result, additions)
        manifest_entry = result.get(path + '/package.json')
        if manifest_entry is None or manifest_entry.kind != 'file' or manifest_entry.data is None:
            raise Refused('missing_package_manifest')
        metadata = document(manifest_entry.data)
        need(metadata.get('version') == entry['version'] and
             metadata.get('name') == entry.get('name', name), 'package_identity_mismatch')
        manifests[path] = metadata
        declared = bins(metadata.get('bin'), metadata['name'])
        need(declared == bins(entry.get('bin'), metadata['name']), 'package_bin_mismatch')
        for command, relative in declared.items():
            target = path + '/' + relative
            need(target in result and result[target].kind == 'file', 'missing_bin_target')
            result[target] = replace(result[target], mode=0o755)
            link = container + '/.bin/' + command
            candidates.setdefault(link, set()).add(posixpath.relpath(target, container + '/.bin'))
        present[path] = entry
    for path, targets in candidates.items():
        add(result, path, Entry('link', mode=0o777, targets=tuple(sorted(targets))))
    # Empty scope directories can remain after npm removes optional packages.
    # Permit ONLY scaffolding derived from lock paths, and only if present.
    for path in packages:
        parent = posixpath.dirname(path)
        while parent and parent not in packages:
            if parent in installed and stat.S_ISDIR(installed[parent].st_mode):
                add(result, parent, Entry('directory', mode=0o755))
            parent = posixpath.dirname(parent)
    hidden = {key: lock[key] for key in ('name', 'version') if key in lock}
    hidden.update(lockfileVersion=3, requires=True, packages=present)
    return result, hidden, {'packages': len(present), 'absentOptionalPackages': sorted(absent),
                            'binContentPolicy': 'exact-archive-bytes'}


def link_destination(path: str, target: str, tree: dict[str, Entry], depth: int = 0) -> str:
    """Resolve only the proved manifest, never follow a filesystem symlink."""
    need(depth < 40 and isinstance(target, str) and 0 < len(target) <= MAX_PATH and
         not target.startswith('/') and '\\' not in target and ':' not in target and
         all(ord(c) >= 32 and ord(c) != 127 for c in target), 'unsafe_link_target')
    # Do not normpath away a symlink followed by /..: the kernel resolves the
    # symlink BEFORE the parent component, which can change the destination.
    parts = posixpath.dirname(path).split('/')
    for component in target.split('/'):
        parent = '/'.join(parts)
        need(parent in tree and tree[parent].kind == 'directory', 'link_through_link')
        if component == '..':
            need(len(parts) > 1, 'escaping_or_dangling_link')
            parts.pop()
        elif component != '.':
            parts.append(safe_path(component))
    resolved = safe_path('/'.join(parts))
    need(resolved in tree, 'escaping_or_dangling_link')
    entry = tree[resolved]
    if entry.kind == 'link':
        need(len(entry.targets) == 1, 'ambiguous_link_chain')
        return link_destination(resolved, entry.targets[0], tree, depth + 1)
    return resolved


def preseal_mode_matches(actual: int, canonical: int) -> bool:
    """Allow only the original job's exact pre-seal or canonical permissions.

    This does not establish readability by service accounts. The authenticated
    configuration step's later a+rX,go-w seal and the parent's gate/probe remain
    mandatory; compare() preserves the actual mode in every returned record.
    """
    return canonical in (0o644, 0o755) and actual in (canonical, canonical & ~PRESEAL_UMASK)


def compare(files: Files, expected: dict[str, Entry], installed: dict[str, os.stat_result]) -> tuple[list[dict], list[dict]]:
    need(set(expected) == set(installed), 'unexpected_or_missing_path')
    records, links = [], []
    for path in sorted(expected):
        files.budget.tick()
        entry, info = expected[path], installed[path]
        mode = stat.S_IMODE(info.st_mode)
        if entry.kind == 'directory':
            need(stat.S_ISDIR(info.st_mode) and preseal_mode_matches(mode, 0o755), 'directory_mode_mismatch')
        elif entry.kind == 'link':
            need(stat.S_ISLNK(info.st_mode), 'type_mismatch')
            target = files.link(RELEASE + '/' + path)
            need(target in entry.targets, 'link_target_mismatch')
            destination = link_destination(path, target, expected)
            links.append({'path': path, 'target': target, 'resolvedPath': destination,
                          'mode': mode, 'nlink': info.st_nlink})
        else:
            need(stat.S_ISREG(info.st_mode) and preseal_mode_matches(mode, entry.mode), 'file_mode_or_type_mismatch')
            need(entry.size is None or entry.size == info.st_size, 'file_size_mismatch')
            need(path != FONT or info.st_size <= MAX_METADATA, 'metadata_limit')
            with files.regular(RELEASE + '/' + path) as (stream, before):
                digest, _ = content(stream, before.st_size, files.budget)
            need(digest == entry.digest, 'file_digest_mismatch')
            records.append({'path': path, 'sha256': digest, 'size': info.st_size,
                            'mode': mode, 'nlink': info.st_nlink})
    return records, links


def _verify(root: Path) -> dict:
    budget = Budget()
    with Files(root, budget) as files:
        pins, lock = authenticated_inputs(files)
        with refusal_context('node'), artifact(files, OP + '/node.tar.xz', pins['nodeSha256']) as stream:
            expected = tar_entries(stream, budget, 'xz', NODE_TOP, 'node')
        with refusal_context('uv'), artifact(files, OP + '/uv.whl', pins['uvSha256']) as stream:
            uv = zip_entries(stream, budget, 'node/bin/uv', UV_MEMBER)
            uv['node/bin/uv'] = replace(uv['node/bin/uv'], mode=0o755)
            merge(expected, uv)
        with refusal_context('camoufox'), artifact(files, OP + '/camoufox.zip', pins['camoufoxSha256']) as stream:
            browser = zip_entries(stream, budget, BROWSER)
        version = json.dumps({'version': pins['camoufoxVersion'], 'build': pins['camoufoxBuild'],
                              'interface': pins['camoufoxInterface'], 'sha256': pins['camoufoxSha256']},
                             separators=(',', ':')).encode()
        version_path = BROWSER + '/version.json'
        if version_path in browser:
            need(browser[version_path].kind == 'file', 'invalid_browser_version')
            del browser[version_path]
        add(browser, version_path, Entry('file', sha(version), len(version)))
        merge(expected, browser)
        add(expected, FONT, Entry('file', FONT_SHA256, size=None))
        installed = {}
        for tree in TREES:
            installed.update(files.inventory(tree))
        npm, hidden, npm_summary = npm_tree(files, lock, installed)
        merge(expected, npm)
        hidden_path = 'node_modules/.package-lock.json'
        hidden_bytes = files.read(RELEASE + '/' + hidden_path)
        need(json.dumps(document(hidden_bytes), sort_keys=True) == json.dumps(hidden, sort_keys=True),
             'generated_lock_mismatch')
        add(expected, hidden_path, Entry('file', sha(hidden_bytes), len(hidden_bytes)))
        records, links = compare(files, expected, installed)
        files.finish()
        return {'verifiedFiles': records, 'verifiedLinks': links, 'summary': {
            'scope': list(TREES), 'archiveSha256': ARCHIVE_SHA256, 'verifiedFiles': len(records),
            'verifiedLinks': len(links), 'verifiedBytes': sum(r['size'] for r in records),
            'npm': npm_summary, 'modePolicy': 'preseal-canonical-or-umask-0077',
            'snapshot': 'optimistic-stat-rechecks', 'bytesRead': budget.bytes}}


def verify(root: Path = Path('/')) -> dict:
    """Verify or raise Refused with a fixed code; no CLI, logging or side effects."""
    try:
        return _verify(root)
    except Refused:
        raise
    except INPUT_ERRORS:
        raise Refused('unreadable_or_invalid_input') from None
