"""ONE-operation, operator-local inventory; never an installer or continuation.

Run from the directory containing the staged file:
    sudo /usr/bin/python3 -I -B ./audit-outpost2-runtime.py
No arguments, environment configuration, installed imports, processes or network.
Linux O_NOATIME prevents read-induced atime updates; no writable descriptors are
opened. Limits cover the entire run, not each tree. Optimistic stat rechecks are
not an atomic snapshot or protection against a hostile root/mount administrator.
Only stdout is written. Exit 0 means inventory completed, NOT runtime approval;
exit 1 means a guarded/incomplete inventory, exit 2 means invocation refused.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import re
import signal
import stat
import sys
import tarfile
import time
from contextlib import contextmanager
from typing import overload

if sys.version_info >= (3, 11):
    import tomllib

OPERATION_ID = '645f62a9-37c8-413e-b31e-9372bc2ed774'
ENVIRONMENT_ID = 'cbfedef7-2f91-4b6d-8ba8-d4c1f5ea5a6b'
RELEASE_ID = 'host-fa9eb6b5d217af95b920'
IDS = dict(operationId=OPERATION_ID, environmentId=ENVIRONMENT_ID, releaseId=RELEASE_ID)
OP = 'var/lib/outpost-setup/operations/' + OPERATION_ID
RELEASE = 'opt/outpost-native/releases/' + RELEASE_ID
HOME = OP + '/build-home'
ARCHIVE_SHA256 = 'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57'
ARCHIVE_SIZE = 223402
INSTALLER_SHA256 = '67ca1a99f9dfa088df0173387656e7bc224d4e004fe409ab5e31238de2dbbac8'
LAUNCHER_SHA256 = '467d6f496c9d0ab06ba10799269e13f4cf8738ea6bdb01f4293412ffa50a07b2'
FONT_SHA256 = '5712114d715c713e302930ed191408ddfedbd5bf7c34c5d380958598595b34d6'
INSTALLER = 'deploy/environment/host_install.py'
LAUNCHER = 'server/browser-engine/launch.py'
FONT = 'browsers/camoufox/fontconfig/fonts-5712114d715c.conf'
PINS = 'deploy/environment/runtime-pins.json'
VENV = 'server/browser-engine/.venv'
TREES = ('node', 'node_modules', 'python', VENV, 'browsers')
CACHES = (HOME + '/.npm/_cacache/content-v2', HOME + '/cache')
NOTICE = 'READ-ONLY inventory; does not certify runtime contents or authorize continuation'
MAX_SECONDS = 120
MAX_NODES = 250000
MAX_ARTIFACT = 2 * 1024 ** 3
MAX_BYTES = 8 * 1024 ** 3
MAX_METADATA = 256 * 1024
MAX_EXPANDED = 32 * 1024 ** 2
MAX_DISTRIBUTIONS = 256
MAX_OUTPUT = 256 * 1024
TOKEN = r'[A-Za-z0-9][A-Za-z0-9._+\-]{0,95}'
DIST = re.compile(r'lib/python[0-9]+\.[0-9]+/site-packages/[^/]+\.dist-info')


class Refused(Exception):
    """Only fixed, non-secret reason codes may cross the output boundary."""


def need(condition: bool, code: str) -> None:
    if not condition:
        raise Refused(code)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stamp(info: os.stat_result) -> tuple:
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid',
                 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def label(value: object, pattern: str = TOKEN) -> str:
    """Host labels are inert, narrow ASCII text, never paths or instructions."""
    return value if isinstance(value, str) and re.fullmatch(pattern, value) else '[redacted]'


def relative_label(value: str) -> str:
    parts = value.split('/')
    return value if len(value) <= 240 and all(
        p not in ('', '.', '..') and re.fullmatch(r'[A-Za-z0-9_.+\-]{1,200}', p)
        for p in parts) else '[redacted]'


def document(data: bytes) -> dict:
    def unique(pairs: list) -> dict:
        result = {}
        for key, value in pairs:
            need(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    value = json.loads(data, object_pairs_hook=unique)
    need(type(value) is dict, 'json_object_required')
    return value


def protected(info: os.stat_result) -> bool:
    return info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022


class Budget:
    """Shared limits; injectable monotonic clock makes deadline tests hermetic."""

    def __init__(self, clock=time.monotonic, seconds=MAX_SECONDS, nodes=MAX_NODES, byte_limit=MAX_BYTES):
        self.clock, self.deadline = clock, clock() + seconds
        self.node_limit, self.byte_limit = nodes, byte_limit
        self.nodes = self.bytes = 0

    def tick(self, nodes=0, size=0) -> None:
        self.nodes += nodes
        self.bytes += size
        need(self.clock() < self.deadline, 'time_limit')
        need(self.nodes <= self.node_limit, 'node_limit')
        need(self.bytes <= self.byte_limit, 'byte_limit')


class Files:
    """Descriptor-relative, no-follow reads. Root/check injection is TEST ONLY."""

    def __init__(self, budget: Budget, root='/', check=protected):
        need(root.startswith('/') and '..' not in root.split('/'), 'unsafe_root')
        self.root, self.budget, self.check = root.rstrip('/'), budget, check
        self.flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | getattr(os, 'O_NOATIME', 0)

    @contextmanager
    def directory(self, path: str):
        need(not path.startswith('/') and all(p not in ('.', '..') for p in path.split('/')), 'unsafe_path')
        fd = os.open('/', self.flags | os.O_DIRECTORY)
        chain = []
        try:
            for part in (self.root + '/' + path).split('/'):
                if not part:
                    continue
                self.budget.tick()
                before = os.stat(part, dir_fd=fd, follow_symlinks=False)
                need(stat.S_ISDIR(before.st_mode), 'not_directory')
                child = os.open(part, self.flags | os.O_DIRECTORY, dir_fd=fd)
                chain.append((fd, part, before))
                fd = child
                need(stamp(before) == stamp(os.fstat(fd)), 'directory_changed')
            yield fd
            for parent, name, before in chain:
                need(stamp(before) == stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'directory_changed')
        finally:
            os.close(fd)
            for parent, _, _ in reversed(chain):
                os.close(parent)

    def info(self, path: str) -> os.stat_result:
        parent, _, name = path.rpartition('/')
        with self.directory(parent) as fd:
            self.budget.tick(nodes=1)
            return os.stat(name, dir_fd=fd, follow_symlinks=False)

    def entries(self, path: str) -> list[str]:
        names = []
        with self.directory(path) as fd, os.scandir(fd) as entries:
            before = os.fstat(fd)
            for entry in entries:
                self.budget.tick(nodes=1)
                names.append(entry.name)
            need(stamp(before) == stamp(os.fstat(fd)), 'directory_changed')
        return sorted(names)

    @overload
    def content(self, path: str, bound: int, *, algorithm: None = None, trusted: bool = False) -> tuple[bytes, os.stat_result]: ...

    @overload
    def content(self, path: str, bound: int, *, algorithm: str, trusted: bool = False) -> tuple[str, os.stat_result]: ...

    def content(self, path: str, bound: int, *, algorithm: str | None = None, trusted: bool = False) -> tuple[bytes | str, os.stat_result]:
        """Hash large files incrementally; never open a known special file."""
        parent, _, name = path.rpartition('/')
        self.budget.tick(nodes=1)
        with self.directory(parent) as directory:
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            need(stat.S_ISREG(before.st_mode), 'not_regular')
            need(0 <= before.st_size <= bound, 'file_size_limit')
            need(not trusted or self.check(before), 'untrusted_control_file')
            fd = os.open(name, self.flags, dir_fd=directory)
            try:
                need(stamp(before) == stamp(os.fstat(fd)), 'file_changed')
                hasher = hashlib.new(algorithm) if algorithm else None
                output = bytearray()
                size = 0
                while True:
                    self.budget.tick()
                    block = os.read(fd, min(1024 * 1024, bound - size + 1))
                    if not block:
                        break
                    size += len(block)
                    self.budget.tick(size=len(block))
                    need(size <= bound, 'file_size_limit')
                    if hasher is not None:
                        hasher.update(block)
                    else:
                        output.extend(block)
                need(size == before.st_size and stamp(before) == stamp(os.fstat(fd)) ==
                     stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'file_changed')
                return (hasher.hexdigest() if hasher is not None else bytes(output)), before
            finally:
                os.close(fd)

    def walk(self, path: str):
        """Yield relative name, lstat, parent fd. Never follow links/cross devices."""
        def descend(fd, prefix, device, depth):
            need(depth <= 64, 'depth_limit')
            before = os.fstat(fd)
            with os.scandir(fd) as entries:
                for entry in entries:
                    self.budget.tick(nodes=1)
                    info = entry.stat(follow_symlinks=False)
                    name = prefix + entry.name
                    need(info.st_dev == device, 'mount_boundary')
                    yield name, info, fd
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(entry.name, self.flags | os.O_DIRECTORY, dir_fd=fd)
                        try:
                            need(stamp(info) == stamp(os.fstat(child)), 'directory_changed')
                            yield from descend(child, name + '/', device, depth + 1)
                            need(stamp(info) == stamp(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)), 'directory_changed')
                        finally:
                            os.close(child)
            need(stamp(before) == stamp(os.fstat(fd)), 'directory_changed')
        with self.directory(path) as fd:
            info = os.fstat(fd)
            self.budget.tick(nodes=1)
            yield '', info, fd
            yield from descend(fd, '', info.st_dev, 0)


def state(files: Files) -> dict:
    """Never publish request fields, history, errors, timestamps or raw receipts."""
    request = document(files.content(OP + '/request.json', 16384, trusted=True)[0])
    receipt = document(files.content(OP + '/status.json', 65536, trusted=True)[0])
    for value in (request, receipt):
        need(all(value.get(k) == v for k, v in IDS.items()), 'identity_mismatch')
    need(request.get('sha256') == ARCHIVE_SHA256 and type(request.get('size')) is int
         and request['size'] == ARCHIVE_SIZE and all(request.get(k) is True for k in
         ('browser', 'coexistence', 'fullControl')), 'request_mismatch')
    need(receipt.get('state') == 'failed' and type(receipt.get('completedSteps')) is int
         and receipt['completedSteps'] == 4 and type(receipt.get('totalSteps')) is int
         and receipt['totalSteps'] == 12 and receipt.get('stage') == 'Browser runtime', 'state_mismatch')
    need(files.content(OP + '/cancel', 1)[0] == b'', 'cancel_changed')
    names = files.entries(OP)
    need(not any(n.startswith('continuation-') for n in names) and 'status.json.tmp' not in names,
         'continuation_or_pending_state')
    for path in ('opt/outpost-native/current', RELEASE + '/pi-release.json'):
        try:
            files.info(path)
        except FileNotFoundError:
            continue
        raise Refused('already_published')
    return dict(IDS, state='failed', completedSteps=4, totalSteps=12, stage='Browser runtime')


def authenticate(files: Files) -> tuple[dict, dict, dict, dict]:
    """Pin compressed bytes BEFORE parsing; bounded expansion, no extraction."""
    data = files.content(OP + '/release.tar.gz', ARCHIVE_SIZE, trusted=True)[0]
    need(len(data) == ARCHIVE_SIZE and sha(data) == ARCHIVE_SHA256, 'archive_pin_mismatch')
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        expanded = stream.read(MAX_EXPANDED + 1)
    files.budget.tick(size=len(expanded))
    need(len(expanded) <= MAX_EXPANDED, 'archive_expansion_limit')
    tree, seen = {}, set()
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for member in archive:
            files.budget.tick(nodes=1)
            need(len(seen) < 4096, 'archive_member_limit')
            name = member.name.removeprefix('./').rstrip('/')
            if name == '.':
                name = ''
            need((name == '' and member.isdir()) or (bool(name) and not name.startswith('/') and
                 all(p not in ('', '.', '..') for p in name.split('/'))), 'archive_path')
            need(name not in seen and (member.isdir() or member.isfile()), 'archive_member_type')
            need(0 <= member.size <= 8 * 1024 ** 2, 'archive_member_size')
            seen.add(name)
            if member.isfile():
                source = archive.extractfile(member)
                if source is None:
                    raise Refused('archive_truncated')
                with source:
                    tree[name] = source.read(member.size + 1)
                need(len(tree[name]) == member.size, 'archive_truncated')
    need(INSTALLER in tree and sha(tree[INSTALLER]) == INSTALLER_SHA256, 'installer_pin_mismatch')
    pins = document(tree[PINS])
    lock = document(tree['package-lock.json'])
    uv = tomllib.loads(tree['server/browser-engine/uv.lock'].decode('utf-8'))
    counts = {}
    for prefix in (OP + '/source', RELEASE):
        for name, content in tree.items():
            expected = LAUNCHER_SHA256 if prefix == RELEASE and name == LAUNCHER else sha(content)
            actual, _ = files.content(prefix + '/' + name, max(len(content), 16384), algorithm='sha256')
            need(actual == expected, 'source_pin_mismatch')
        counts['release' if prefix == RELEASE else 'retained_source'] = len(tree)
    need(files.content(RELEASE + '/' + FONT, MAX_METADATA, algorithm='sha256')[0] == FONT_SHA256, 'font_pin_mismatch')
    return pins, lock, uv, dict(archiveSha256=ARCHIVE_SHA256, archiveBytes=ARCHIVE_SIZE,
                              installerSha256=INSTALLER_SHA256, launcherSha256=LAUNCHER_SHA256,
                              fontconfigSha256=FONT_SHA256, verifiedSourceFiles=counts)


def artifacts(files: Files, pins: dict) -> dict:
    result = {}
    for name, key in (('node.tar.xz', 'nodeSha256'), ('uv.whl', 'uvSha256'), ('camoufox.zip', 'camoufoxSha256')):
        expected = pins.get(key)
        need(isinstance(expected, str) and re.fullmatch('[0-9a-f]{64}', expected) is not None, 'runtime_pin_schema')
        try:
            actual, info = files.content(OP + '/' + name, MAX_ARTIFACT, algorithm='sha256')
            result[name] = dict(status='verified' if actual == expected else 'mismatch',
                                bytes=info.st_size, sha256=actual, expectedSha256=expected)
        except FileNotFoundError:
            result[name] = dict(status='missing', expectedSha256=expected)
    return result


def counters() -> dict:
    return dict(files=0, bytes=0, directories=0, symlinks=0, special=0, setid=0,
                    worldWritable=0, hardlinkedFiles=0, hardlinkedNonDirectories=0)


def count(total: dict, info: os.stat_result) -> None:
    kind = ('files' if stat.S_ISREG(info.st_mode) else 'directories' if stat.S_ISDIR(info.st_mode)
            else 'symlinks' if stat.S_ISLNK(info.st_mode) else 'special')
    total[kind] += 1
    total['hardlinkedNonDirectories'] += kind != 'directories' and info.st_nlink > 1
    if kind == 'files':
        total['bytes'] += info.st_size
        total['hardlinkedFiles'] += info.st_nlink > 1
    # Symlink mode bits do not grant target access and are usually 0777.
    if kind != 'symlinks':
        total['setid'] += bool(info.st_mode & 0o6000)
        total['worldWritable'] += bool(info.st_mode & 0o002)


def receipt_keys(files: Files, path: str, name: str) -> dict:
    result: dict = dict(file=relative_label(name))
    try:
        value = document(files.content(path, MAX_METADATA)[0])
        keys = sorted(value)
        result.update(keys=[label(k, r'[A-Za-z_][A-Za-z0-9_.\-]{0,63}') for k in keys[:32]],
                      omittedKeys=max(0, len(keys) - 32))
    except (ValueError, UnicodeError):
        result['status'] = 'invalid_json'
    return result


def inventory(files: Files) -> tuple[dict, dict, list[str]]:
    result: dict = dict(trees={}, venvSymlinks=[], managedPythonMetadata=[], labels='untrusted text; not provenance')
    links, distributions = {}, []
    for tree in TREES:
        total = counters()
        for name, info, _ in files.walk(RELEASE + '/' + tree):
            count(total, info)
            path = RELEASE + '/' + tree + ('/' + name if name else '')
            if not stat.S_ISDIR(info.st_mode) and info.st_nlink > 1:
                group = links.setdefault((info.st_dev, info.st_ino), dict(info=info, release=[], cache=[]))
                need(stamp(group['info']) == stamp(info), 'hardlink_changed')
                group['release'].append(path)
            if tree == VENV and stat.S_ISLNK(info.st_mode) and len(result['venvSymlinks']) < 5:
                # readlink() can update symlink atime; omit optional target text.
                result['venvSymlinks'].append(dict(path=relative_label(name), followed=False))
            if tree == VENV and stat.S_ISDIR(info.st_mode) and DIST.fullmatch(name):
                need(len(distributions) < MAX_DISTRIBUTIONS, 'distribution_limit')
                distributions.append(path)
            base = name.rsplit('/', 1)[-1].lower()
            if tree == 'python' and stat.S_ISREG(info.st_mode) and (base in ('python.json', 'build-info.json')
                    or base.endswith('.json') and ('receipt' in base or 'metadata' in base)):
                need(len(result['managedPythonMetadata']) < 32, 'receipt_limit')
                result['managedPythonMetadata'].append(receipt_keys(files, path, name))
        result['trees'][tree] = total
    return result, links, distributions


def cache_inventory(files: Files, links: dict) -> dict:
    result = {}
    for root in CACHES:
        total = counters()
        section: dict = dict(status='present', counts=total, topLevel=counters(), directories=[],
                       regularWheels=0, wheelNamedDirectories=0, wheelSymlinks=0, wheelExamples=[])
        started = False
        try:
            for name, info, _ in files.walk(root):
                started = True
                count(total, info)
                if name and '/' not in name:
                    count(section['topLevel'], info)
                    if stat.S_ISDIR(info.st_mode):
                        need(len(section['directories']) < 64, 'cache_directory_limit')
                        section['directories'].append(label(name))
                if name.endswith('.whl'):
                    kind = 'regularWheels' if stat.S_ISREG(info.st_mode) else 'wheelNamedDirectories' if stat.S_ISDIR(info.st_mode) else 'wheelSymlinks' if stat.S_ISLNK(info.st_mode) else None
                    if kind:
                        section[kind] += 1
                        if len(section['wheelExamples']) < 5:
                            section['wheelExamples'].append(dict(path=relative_label(name), kind=kind))
                key = info.st_dev, info.st_ino
                if not stat.S_ISDIR(info.st_mode) and key in links:
                    need(stamp(links[key]['info']) == stamp(info), 'hardlink_changed')
                    links[key]['cache'].append(root + '/' + name)
            section['directories'].sort()
        except FileNotFoundError:
            # A disappearing child is not a genuinely absent cache root.
            need(not started, 'cache_changed')
            try:
                files.info(root)
            except FileNotFoundError:
                section['status'] = 'missing'
            else:
                raise Refused('cache_changed')
        result['npmContent' if root == CACHES[0] else 'uvCache'] = section
    return result


def hardlinks(files: Files, links: dict) -> dict:
    result: dict = dict(inodes=len(links), nonRegularInodes=0, uniqueBytes=0, releaseAliases=0, knownCacheAliases=0,
                  unaccountedLinks=0, knownCacheInodes=0, releaseOnlyInodes=0, unaccountedInodes=0, examples=[])
    for group in links.values():
        info = group['info']
        for path in group['release'] + group['cache']:
            need(stamp(files.info(path)) == stamp(info), 'hardlink_changed')
        releases, caches = len(group['release']), len(group['cache'])
        unknown = info.st_nlink - releases - caches
        need(unknown >= 0, 'hardlink_alias_overcount')
        kind = 'unaccounted' if unknown else 'knownCache' if caches else 'releaseOnly'
        result[kind + 'Inodes'] += 1
        result['uniqueBytes'] += info.st_size
        result['nonRegularInodes'] += not stat.S_ISREG(info.st_mode)
        result['releaseAliases'] += releases
        result['knownCacheAliases'] += caches
        result['unaccountedLinks'] += unknown
        if len(result['examples']) < 5:
            result['examples'].append(dict(classification=kind, nlink=info.st_nlink,
                releaseAliases=releases, knownCacheAliases=caches, unaccountedLinks=unknown,
                release=relative_label(group['release'][0][len(RELEASE) + 1:]),
                cache=relative_label(group['cache'][0][len(HOME) + 1:]) if caches else None))
    result['scope'] = 'release runtime trees plus build-home/.npm/_cacache/content-v2 and build-home/cache only; no other alias search'
    return result


def npm_integrity(files: Files, lock: dict) -> dict:
    """Counts unique content-addressed blobs, not installed Node package proofs."""
    packages = lock.get('packages')
    if not isinstance(packages, dict) or len(packages) > 10000:
        raise Refused('npm_lock_schema')
    blobs = {}
    result: dict = dict(packageReferences=0, verifiedHash=0, missing=0, mismatch=0, unsupported=0, examples=[])
    for name, package in packages.items():
        files.budget.tick()
        if not name:
            continue
        result['packageReferences'] += 1
        integrity = package.get('integrity', '') if isinstance(package, dict) else ''
        candidates = []
        if isinstance(integrity, str) and len(integrity) <= 2048:
            for token in integrity.split()[:8]:
                algorithm, _, encoded = token.partition('-')
                if algorithm in ('sha256', 'sha384', 'sha512'):
                    try:
                        value = base64.b64decode(encoded, validate=True)
                    except ValueError:
                        continue
                    if len(value) == hashlib.new(algorithm).digest_size:
                        candidates.append((algorithm, value.hex()))
        if not candidates:
            result['unsupported'] += 1
            if len(result['examples']) < 5:
                result['examples'].append(dict(package=label(name, r'[A-Za-z0-9_@./+\-]{1,160}'), status='unsupported'))
            continue
        strongest = max(algorithm for algorithm, _ in candidates)
        for algorithm, digest in candidates:
            if algorithm == strongest:
                blobs.setdefault((algorithm, digest), name)
    for (algorithm, digest), name in sorted(blobs.items()):
        path = CACHES[0] + '/' + algorithm + '/' + digest[:2] + '/' + digest[2:4] + '/' + digest[4:]
        try:
            actual, _ = files.content(path, 512 * 1024 ** 2, algorithm=algorithm)
            status = 'verifiedHash' if actual == digest else 'mismatch'
        except FileNotFoundError:
            status = 'missing'
        result[status] += 1
        if len(result['examples']) < 5:
            result['examples'].append(dict(package=label(name, r'[A-Za-z0-9_@./+\-]{1,160}'), status=status))
    result['uniqueSupportedBlobs'] = len(blobs)
    return result


def headers(data: bytes, keys: tuple[str, ...]) -> dict:
    result = {key: [] for key in keys}
    for line in data.decode('utf-8').splitlines():
        if not line:
            break
        key, separator, value = line.partition(':')
        if separator and key in result:
            need(len(result[key]) < 32, 'metadata_header_limit')
            result[key].append(value.strip())
    return result


def tags(value: str) -> set[str]:
    parts = value.split('-')
    if len(parts) != 3 or not all(re.fullmatch(r'[A-Za-z0-9_.]{1,160}', p) for p in parts):
        return set()
    groups = [p.split('.') for p in parts]
    need(all(len(g) <= 16 for g in groups), 'wheel_tag_limit')
    return {a + '-' + b + '-' + c for a in groups[0] for b in groups[1] for c in groups[2]}


def distributions(files: Files, paths: list[str], lock: dict) -> list[dict]:
    """Read only METADATA Name/Version and WHEEL Tag; never RECORD/direct_url/imports."""
    packages = lock.get('package')
    if not isinstance(packages, list) or len(packages) > 2048:
        raise Refused('uv_lock_schema')
    canonical = lambda text: re.sub(r'[-_.]+', '-', text).lower()
    result = []
    for path in sorted(paths):
        row: dict = dict(metadata=relative_label(path[len(RELEASE + '/' + VENV) + 1:]))
        try:
            meta = headers(files.content(path + '/METADATA', MAX_METADATA)[0], ('Name', 'Version'))
            wheel = headers(files.content(path + '/WHEEL', 32768)[0], ('Tag',))
        except FileNotFoundError:
            row['status'] = 'missing_metadata'
            result.append(row)
            continue
        name = label(meta['Name'][0]) if len(meta['Name']) == 1 else '[redacted]'
        version = label(meta['Version'][0]) if len(meta['Version']) == 1 else '[redacted]'
        installed_tags = set()
        for tag in wheel['Tag']:
            installed_tags.update(tags(tag))
        row.update(name=name, version=version, wheelTags=[label(t, r'[A-Za-z0-9_.\-]{1,200}') for t in wheel['Tag']],
                   authenticatedLockMatch=False, candidateWheels=[], candidateCount=0)
        for package in packages:
            files.budget.tick()
            if canonical(str(package.get('name', ''))) != canonical(name) or package.get('version') != version:
                continue
            row['authenticatedLockMatch'] = True
            wheels = package.get('wheels', [])
            need(isinstance(wheels, list) and len(wheels) <= 2048, 'uv_wheel_limit')
            for item in wheels:
                filename = str(item.get('url', '')).rsplit('/', 1)[-1]
                if not filename.endswith('.whl') or relative_label(filename) == '[redacted]':
                    continue
                wheel_tags = filename[:-4].rsplit('-', 3)
                if len(wheel_tags) != 4 or not (installed_tags & tags('-'.join(wheel_tags[-3:]))):
                    continue
                digest, size = item.get('hash', ''), item.get('size')
                need(isinstance(digest, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', digest) is not None
                     and type(size) is int and 0 < size <= MAX_ARTIFACT, 'uv_wheel_schema')
                row['candidateCount'] += 1
                if len(row['candidateWheels']) < 5:
                    row['candidateWheels'].append(dict(file=filename, sha256=digest[7:], bytes=size))
        row['omittedCandidates'] = max(0, row['candidateCount'] - 5)
        result.append(row)
    return result


def audit(*, root='/', getuid=os.geteuid, check=protected, budget=None) -> dict:
    """Test-only injection; production CLI cannot select paths, pins or limits."""
    budget = budget if budget is not None else Budget()
    files = Files(budget, root, check)
    result: dict = dict(notice=NOTICE, result='incomplete', phase='privilege',
                  limits=dict(seconds=MAX_SECONDS, nodes=MAX_NODES, bytes=MAX_BYTES, pinnedArtifactBytes=MAX_ARTIFACT))
    try:
        need(getuid() == 0, 'root_required')
        result['phase'] = 'state'
        result['state'] = state(files)
        result['phase'] = 'authentication'
        pins, node_lock, uv_lock, result['authentication'] = authenticate(files)
        result['phase'] = 'retained_artifacts'
        result['retainedArtifacts'] = artifacts(files, pins)
        result['phase'] = 'runtime_inventory'
        result['runtime'], links, paths = inventory(files)
        result['phase'] = 'cache_inventory'
        result['caches'] = cache_inventory(files, links)
        result['phase'] = 'npm_integrity'
        result['npmIntegrity'] = npm_integrity(files, node_lock)
        result['phase'] = 'distribution_metadata'
        result['distributionMetadataTrust'] = 'untrusted labels only; lock match is not installed-file verification'
        result['distributions'] = distributions(files, paths, uv_lock)
        result['phase'] = 'final_rechecks'
        result['hardlinks'] = hardlinks(files, links)
        state(files)
        authenticate(files)
        budget.tick()
        result.update(result='inventory_complete', phase='complete', verificationNeeded=[
            'Retained archive hashes do not verify installed runtime trees.',
            'Compare installed Node/browser files with authenticated archives and account for generated files.',
            'Obtain npm SRI blobs and uv.lock candidate wheels; verify installed files, not just metadata/RECORD.',
            'Obtain independently authenticated managed-Python distribution provenance; receipt keys are not proof.',
            'Review external cache aliases and resolve unaccounted links before any seal; no services or live probe were queried.'])
    except Refused as error:
        result['reason'] = str(error)
    except (OSError, ValueError, KeyError, TypeError, RecursionError, tarfile.TarError, EOFError):
        result['reason'] = 'unreadable_changed_or_malformed_input'
    result['budgetUsed'] = dict(nodes=budget.nodes, bytes=budget.bytes)
    return result


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv or not sys.flags.isolated or not sys.dont_write_bytecode or sys.version_info < (3, 11) or sys.platform != 'linux' or not hasattr(os, 'O_NOATIME'):
        print(json.dumps(dict(notice=NOTICE, result='refused', reason='requires_linux_python311_isolated_no_bytecode_no_arguments'), separators=(',', ':')))
        return 2

    def expired(signum, frame):
        raise Refused('time_limit')

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)
    try:
        result = audit()
    except Refused:
        result = dict(notice=NOTICE, result='incomplete', phase='deadline', reason='time_limit')
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    output = json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    if len(output) > MAX_OUTPUT:
        result = dict(notice=NOTICE, result='incomplete', phase='output', reason='output_size_limit')
        output = json.dumps(result, separators=(',', ':'))
    print(output)
    return 0 if result['result'] == 'inventory_complete' else 1


if __name__ == '__main__':
    sys.exit(main())
