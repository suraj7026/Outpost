"""Opt-in publisher-authorized native updates; no passwords or general sudo authority.

Bootstrap contract: privileged, verified bundled Python preloads host_install,
 host_update and this module, then calls enroll(policy, helper_source,
 installer_source, updater_source). helper_source is THIS MODULE, not a launcher.
Policy input has exactly environmentId, deviceId, publisherPublicKey, sshUser.
The public policy file adds schema=1 and sourcesSha256; read it without sudo.
Explicit elevated refresh: reauthorize(policy, expected_policy, helper_source,
installer_source, updater_source). expected_policy is the exact full public policy
reviewed by the caller; identity and publisher must remain unchanged. enroll never
refreshes sources. The policy is the atomic selector for immutable source versions;
pre-commit interruptions keep the old selection. Retry reauthorize only after an
explicit review of the current policy. No refresh is exposed by the sudo helper.

Wire contract: one <=64 KiB UTF-8 JSON line with exactly requestBase64,
authorization={payload,signature,publisherPublicKey}, deviceSignature; then exactly
request.size bytes followed by EOF. Both signatures cover decoded bytes, never
re-serialized JSON. Decoded authorization payload has exactly schema=1, manifest,
sha256, size, runtimePinsSha256, requiredTools. requiredTools names the coordinator
Gate catalogue, not native Pi extension tools; automation.list, automation.save
and automation.set_paused are mandatory. Successful health receipts include
health.requiredTools only after catalogue qualification, bound to health.releaseId.
Their service PIDs are historical activation evidence, not reboot-stable identities.
The existing signed-API maintenance.stage record binds the
archive hash, owner, operation, source and target. It does not store a signature
or full request digest; we retain the latter separately, never invent a hold.
Only the fixed launcher is sudo-granted, with the sudoers empty-arguments match.
The module's --run is internal root/systemd-only, not a launcher argument.
"""
from __future__ import annotations

import base64
import fcntl
import gzip
import hashlib
import io
import json
import math
import os
import pwd
import re
import signal
import sqlite3
import stat
import subprocess
import sys
import tarfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import BinaryIO

# -I excludes both the cwd and script directory. Only this fixed root-owned directory
# may supply modules to the detached runner; bootstrap callers preload bundled modules.
EXECUTING_LIBRARY = Path(__file__).resolve().parent if __name__ == '__main__' else None
if EXECUTING_LIBRARY is not None:
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(EXECUTING_LIBRARY))

import host_update
from host_install import CONFIG, DATA, OPERATIONS, PREFIX, atomic_json

LIBRARY = Path('/usr/local/lib/outpost-updater')
HELPER = Path('/usr/local/libexec/outpost-update')
SUDOERS = Path('/etc/sudoers.d/outpost-update')
HEADER_LIMIT = 64 * 1024
ARTIFACT_LIMIT = 16 * 1024 * 1024
EXPANDED_LIMIT = 128 * 1024 * 1024
FILE_LIMIT = 8192
REQUIRED_TOOLS = frozenset({'automation.list', 'automation.save', 'automation.set_paused'})
RUNNER_LOCK_SECONDS = 30
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8'}
MODULE_NAMES = ('auto_update.py', 'host_install.py', 'host_update.py')
SOURCE_LIMIT = 1024 * 1024
LEGACY_LAUNCHER = b'''#!/usr/bin/python3 -I
import sys
if len(sys.argv) != 1:
    raise SystemExit('No arguments permitted')
sys.path.insert(0, '/usr/local/lib/outpost-updater')
from auto_update import main
raise SystemExit(main([]))
'''
# This dispatcher is deliberately independent of both old and new helper modules.
# Public policy replacement selects a complete version in one atomic operation.
LAUNCHER = b'''#!/usr/bin/python3 -I
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
if len(sys.argv) != 1:
    raise SystemExit('No arguments permitted')
def secure(path, directory=False):
    for item in (*reversed(path.parents), path):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('Unsafe helper path')
        if item != path or directory:
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError('Unsafe helper directory')
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Unsafe helper file')
try:
    root = Path('/usr/local/lib/outpost-updater')
    policy_path = Path('/etc/outpost-native/auto-update.json')
    secure(policy_path)
    with policy_path.open('rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError('Oversized helper policy')
    policy = json.loads(raw)
    hashes = policy['sourcesSha256']
    names = ('auto_update.py', 'host_install.py', 'host_update.py')
    if set(hashes) != set(names) or any(not isinstance(hashes[name], str) or len(hashes[name]) != 64 or any(c not in '0123456789abcdef' for c in hashes[name]) for name in names):
        raise ValueError('Invalid helper policy')
    version = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    versions = root / 'versions'
    if versions.exists() or versions.is_symlink():
        secure(versions, directory=True)
    candidate = versions / version
    if candidate.exists() or candidate.is_symlink():
        root = candidate
    secure(root, directory=True)
    for name in names:
        path = root / name
        secure(path)
        with path.open('rb') as source:
            value = source.read(1048577)
        if len(value) > 1048576 or hashlib.sha256(value).hexdigest() != hashes[name]:
            raise ValueError('Helper policy mismatch')
    os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', str(root / 'auto_update.py')])
except Exception:
    print('{"state":"refused","stage":"Helper policy requires explicit reauthorization"}')
    raise SystemExit(1)
'''
VERIFY = """const fs=require('node:fs'),c=require('node:crypto');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const key=c.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(p.key,'base64')]),format:'der',type:'spki'});
process.exit(c.verify(null,Buffer.from(p.payload,'base64'),key,Buffer.from(p.signature,'base64'))?0:1);
"""
REQUIRED_FILES = {'host-manifest.json', 'package.json', 'package-lock.json',
                  'deploy/environment/runtime-pins.json', 'server/main.ts',
                  'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs',
                  'server/environment/update-checkpoint.ts', 'server/environment/qualify-runtime.ts'}
TOOL_FILES = {'automation': 'server/scheduler/tools.ts', 'recovery': 'server/diagnostics/recovery.ts',
              'host': 'server/operations/hosts.ts', 'browser': 'server/browser/direct.ts',
              'file': 'server/artifacts/files.ts', 'command': 'server/processes/runner.ts',
              'system': 'server/operations/machine.ts', 'data': 'server/data/analysis.ts',
              'document': 'server/documents/documents.ts', 'artifact': 'server/artifacts/files.ts'}


def require(condition: bool) -> None:
    """Refuse without reflecting untrusted values or private exception messages."""
    if not condition:
        raise ValueError('Auto-update validation refused')


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def decode(value: str, size: int | None = None) -> bytes:
    require(isinstance(value, str) and len(value) <= HEADER_LIMIT)
    result = base64.b64decode(value, validate=True)
    require(base64.b64encode(result).decode('ascii') == value and (size is None or len(result) == size))
    return result


def parse(raw: bytes, limit: int = HEADER_LIMIT) -> dict:
    """Reject duplicate keys and non-finite numbers at every nesting level."""
    require(len(raw) <= limit)

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result

    def invalid(_value):
        raise ValueError('Invalid JSON constant')

    def finite(value):
        number = float(value)
        require(math.isfinite(number))
        return number

    result = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite)
    require(isinstance(result, dict))
    return result


def identifier(value: str) -> None:
    require(isinstance(value, str) and str(uuid.UUID(value)) == value)


def secure_path(path: Path, *, directory: bool = False) -> None:
    """Every ancestor must be root-owned, non-writable by others and not a link."""
    require(path.is_absolute() and '..' not in path.parts)
    for item in (*reversed(path.parents), path):
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode))
        require(stat.S_ISDIR(info.st_mode) if item != path or directory else stat.S_ISREG(info.st_mode))
        if stat.S_ISREG(info.st_mode):
            require(info.st_nlink == 1)


def secure_mkdir(path: Path, mode: int = 0o755) -> None:
    if not path.exists():
        secure_mkdir(path.parent)
        path.mkdir(mode=mode)
    secure_path(path, directory=True)


def read_public(path: Path) -> dict:
    secure_path(path)
    with path.open('rb') as source:
        return parse(source.read(2 * HEADER_LIMIT + 1), 2 * HEADER_LIMIT)


def release_path(installation: dict) -> Path:
    """Only the explicitly managed current symlink may redirect release lookup."""
    require(installation.get('schema') == 1 and installation.get('layoutVersion') == 1)
    name = installation.get('release')
    require(isinstance(name, str) and re.fullmatch(r'host-[a-f0-9]{20}', name) is not None)
    root = PREFIX / 'releases' / name
    secure_path(root, directory=True)
    current = PREFIX / 'current'
    info = current.lstat()
    require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and current.readlink() == root)
    # Imported code and the interpreter must not be writable by an enrolled SSH user.
    def unreadable(error):
        raise error

    for parent, directories, files in os.walk(root, followlinks=False, onerror=unreadable):
        for entry in directories + files:
            path = Path(parent) / entry
            info = path.lstat()
            require(info.st_uid == 0)
            if path.is_symlink():
                resolved = path.resolve(strict=True)
                # Directory links cannot hide an uninspected external dependency tree.
                require(not resolved.is_dir() or resolved == root or root in resolved.parents)
                secure_path(resolved, directory=resolved.is_dir())
            else:
                require(not info.st_mode & 0o022 and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)))
                if path.is_file():
                    require(info.st_nlink == 1)
    secure_path(root / 'node/bin/node')
    return root


@contextmanager
def ledger(environment: str):
    """Read the coordinator-owned ledger, including WAL, without initializing it."""
    secure_path(DATA, directory=True)
    owner = pwd.getpwnam('outpost-coord').pw_uid
    directory = DATA / 'coordinator'
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, owner) and not info.st_mode & 0o022)
    path = directory / 'ledger.sqlite'
    for item in (path, path.with_name(path.name + '-wal'), path.with_name(path.name + '-shm')):
        if item == path or item.exists() or item.is_symlink():
            info = item.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, owner) and not info.st_mode & 0o022 and info.st_nlink == 1)
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        require(connection.execute('SELECT environment_id FROM installation_identity WHERE singleton=1').fetchone() == (environment,))
        yield connection
    finally:
        connection.close()


def record(connection, kind: str, key: str) -> dict:
    row = connection.execute('SELECT data FROM records WHERE kind=? AND id=? AND length(data)<=?',
                             (kind, key, HEADER_LIMIT)).fetchone()
    require(row is not None)
    return parse(row[0].encode('utf-8'))


def device_key(connection, device: str) -> str:
    value = record(connection, 'device', device)
    require(value.get('revoked') is False)
    decode(value.get('publicKey'), 32)
    return value['publicKey']


def policy_input(policy: dict) -> dict:
    require(isinstance(policy, dict) and set(policy) == {'environmentId', 'deviceId', 'publisherPublicKey', 'sshUser'})
    identifier(policy['environmentId'])
    identifier(policy['deviceId'])
    decode(policy['publisherPublicKey'], 32)
    require(isinstance(policy['sshUser'], str) and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', policy['sshUser']) is not None)
    require(pwd.getpwnam(policy['sshUser']).pw_uid != 0)
    return dict(policy)


@contextmanager
def installation_lock(wait_seconds: float = 0):
    secure_mkdir(OPERATIONS, 0o711)
    path = OPERATIONS.parent / 'install.lock'
    fd = os.open(path, os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    try:
        secure_path(path)
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not wait_seconds:
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError('Installation lock wait expired') from None
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def write_new(path: Path, content: bytes, mode: int) -> None:
    """Never truncate or follow an unexpected file on enrollment or intake."""
    secure_path(path.parent, directory=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as output:
        os.fchmod(output.fileno(), mode)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def source_policy(policy: dict, helper_source: bytes, installer_source: bytes, updater_source: bytes) -> tuple[dict, dict]:
    sources = dict(zip(MODULE_NAMES, (helper_source, installer_source, updater_source)))
    for name, value in sources.items():
        require(isinstance(value, bytes) and 0 < len(value) <= SOURCE_LIMIT)
        compile(value, name, 'exec')
    return sources, {'schema': 1, **policy, 'sourcesSha256': {name: digest(value) for name, value in sources.items()}}


def validate_public_policy(value: dict) -> dict:
    require(isinstance(value, dict) and set(value) == {'schema', 'environmentId', 'deviceId', 'publisherPublicKey', 'sshUser', 'sourcesSha256'})
    require(type(value['schema']) is int and value['schema'] == 1)
    policy_input({name: value[name] for name in ('environmentId', 'deviceId', 'publisherPublicKey', 'sshUser')})
    hashes = value['sourcesSha256']
    require(isinstance(hashes, dict) and set(hashes) == set(MODULE_NAMES))
    require(all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in hashes.values()))
    return value


def version_id(policy: dict) -> str:
    return digest(json.dumps(policy['sourcesSha256'], sort_keys=True, separators=(',', ':')).encode())


def active_library(policy: dict) -> Path:
    """A content-derived version path, never a caller-specified executable location."""
    validate_public_policy(policy)
    versions = LIBRARY / 'versions'
    if versions.exists() or versions.is_symlink():
        secure_path(versions, directory=True)
    candidate = versions / version_id(policy)
    root = candidate if candidate.exists() or candidate.is_symlink() else LIBRARY
    secure_path(root, directory=True)
    return root


def verify_sources(root: Path, policy: dict) -> None:
    for name in MODULE_NAMES:
        path = root / name
        secure_path(path)
        with path.open('rb') as source:
            value = source.read(SOURCE_LIMIT + 1)
        require(len(value) <= SOURCE_LIMIT and digest(value) == policy['sourcesSha256'][name])


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def replace_launcher() -> None:
    """Atomic replacement only at the fixed root-owned executable path."""
    temporary = HELPER.with_name(HELPER.name + '.refresh')
    if temporary.exists() or temporary.is_symlink():
        secure_path(temporary)
        require(temporary.stat().st_size <= SOURCE_LIMIT)
        temporary.unlink()
    write_new(temporary, LAUNCHER, 0o755)
    os.replace(temporary, HELPER)
    sync_directory(HELPER.parent)


def no_active_update(policy: dict) -> None:
    """Never refresh around a queued/uncertain host job or an unreleased ledger hold."""
    with ledger(policy['environmentId']) as connection:
        device_key(connection, policy['deviceId'])
        for kind, terminal in (('runtime_update', {'finished', 'cancelled'}), ('maintenance_checkpoint', {'completed'})):
            row = connection.execute('SELECT substr(data,1,?) FROM records WHERE kind=? AND id=?',
                                                 (HEADER_LIMIT + 1, kind, 'server')).fetchone()
            if row is not None:
                require(parse(row[0].encode()).get('state') in terminal)
    deadline = time.monotonic() + 5
    with os.scandir(OPERATIONS) as entries:
        for count, entry in enumerate(entries, 1):
            require(count <= 4096 and time.monotonic() < deadline)
            identifier(entry.name)
            operation = OPERATIONS / entry.name
            secure_path(operation, directory=True)
            status = read_public(operation / 'status.json')
            require(status.get('operationId') == entry.name)
            require(status.get('state') in {'ready', 'complete', 'failed', 'cancelled', 'rolled_back'})


def bounded_entries(path: Path, maximum: int) -> list[Path]:
    secure_path(path, directory=True)
    result = []
    with os.scandir(path) as entries:
        for entry in entries:
            require(len(result) < maximum)
            result.append(path / entry.name)
    return result


def remove_staged_version(path: Path) -> None:
    """Remove only protected staging/retired files, never follow or recursively delete paths."""
    entries = bounded_entries(path, 4)
    require(all(entry.name in (*MODULE_NAMES, 'policy.json') for entry in entries))
    for entry in entries:
        secure_path(entry)
        require(entry.stat().st_size <= SOURCE_LIMIT)
    for entry in entries:
        entry.unlink()
    path.rmdir()
    sync_directory(path.parent)


def verify_version(path: Path, policy: dict) -> None:
    secure_path(path, directory=True)
    require({entry.name for entry in bounded_entries(path, 4)} == {*MODULE_NAMES, 'policy.json'})
    require(read_public(path / 'policy.json') == policy and path.name == version_id(policy))
    verify_sources(path, policy)


def stage_version(sources: dict, public: dict, previous: dict) -> Path:
    """Retain current + candidate only; retry safely after any pre-commit interruption."""
    versions = LIBRARY / 'versions'
    secure_mkdir(versions)
    destination = versions / version_id(public)
    current = active_library(previous)
    # At most two complete versions and one fixed staging slot, each <=3 MiB + policy.
    entries = bounded_entries(versions, 3)
    for entry in entries:
        if entry.name in ('.staging', '.retired'):
            continue
        require(re.fullmatch(r'[a-f0-9]{64}', entry.name) is not None)
        policy = validate_public_policy(read_public(entry / 'policy.json'))
        require(all(policy[key] == previous[key] for key in ('environmentId', 'deviceId', 'publisherPublicKey', 'sshUser')))
        verify_version(entry, policy)
    for entry in entries:
        if entry.name in ('.staging', '.retired'):
            remove_staged_version(entry)
    for entry in entries:
        if entry.name not in ('.staging', '.retired') and entry not in (current, destination):
            # A crash during unlink must not leave an incomplete content-addressed
            # version that looks committed. Only this fixed retirement slot is resumable.
            retired = versions / '.retired'
            os.rename(entry, retired)
            sync_directory(versions)
            remove_staged_version(retired)
    if destination.exists() or destination.is_symlink():
        verify_version(destination, public)
        return destination
    staging = versions / '.staging'
    staging.mkdir(mode=0o755)
    staging.chmod(0o755)
    for name, content in sources.items():
        write_new(staging / name, content, 0o644)
    write_new(staging / 'policy.json', json.dumps(public, separators=(',', ':')).encode(), 0o644)
    sync_directory(staging)
    os.rename(staging, destination)
    sync_directory(versions)
    verify_version(destination, public)
    return destination


def reauthorize(policy: dict, expected_policy: dict, helper_source: bytes, installer_source: bytes, updater_source: bytes) -> dict:
    """Explicit root bootstrap refresh; never called by receive(), main() or enroll()."""
    require(os.geteuid() == 0)
    policy = policy_input(policy)
    expected_policy = validate_public_policy(expected_policy)
    sources, public = source_policy(policy, helper_source, installer_source, updater_source)
    with installation_lock():
        current = validate_public_policy(read_public(CONFIG / 'auto-update.json'))
        require(current == expected_policy and all(current[key] == value for key, value in policy.items()))
        installation = read_public(CONFIG / 'installation.json')
        require(installation['environmentId'] == policy['environmentId'])
        release_path(installation)
        no_active_update(current)
        verify_sources(active_library(current), current)
        rule = f'{policy["sshUser"]} ALL=(root) NOPASSWD: {HELPER} ""\n'.encode('ascii')
        for item, mode in ((HELPER, 0o755), (SUDOERS, 0o440)):
            secure_path(item)
            require(stat.S_IMODE(item.stat().st_mode) == mode)
        require(HELPER.read_bytes() in (LEGACY_LAUNCHER, LAUNCHER) and SUDOERS.read_bytes() == rule)
        if current != public:
            stage_version(sources, public, current)
        # The dispatcher can still select legacy flat modules under the OLD policy.
        # If the process dies here, nothing has switched and explicit retry is safe.
        if HELPER.read_bytes() != LAUNCHER:
            replace_launcher()
        no_active_update(current)
        if current != public:
            atomic_json(CONFIG / 'auto-update.json', public, 0o644)
        return public


def enroll(policy: dict, helper_source: bytes, installer_source: bytes, updater_source: bytes) -> dict:
    """One-time elevated bootstrap only; not an operation offered by the helper."""
    require(os.geteuid() == 0)
    policy = policy_input(policy)
    sources, public = source_policy(policy, helper_source, installer_source, updater_source)
    rule = f'{policy["sshUser"]} ALL=(root) NOPASSWD: {HELPER} ""\n'.encode('ascii')
    with installation_lock():
        installation = read_public(CONFIG / 'installation.json')
        require(installation['environmentId'] == policy['environmentId'])
        release_path(installation)
        with ledger(policy['environmentId']) as connection:
            device_key(connection, policy['deviceId'])
        path = CONFIG / 'auto-update.json'
        if path.exists() or path.is_symlink():
            require(read_public(path) == public)
            root = active_library(public)
            verify_sources(root, public)
            for name, value in sources.items():
                require((root / name).read_bytes() == value)
            for item, values, mode in ((HELPER, (LEGACY_LAUNCHER, LAUNCHER), 0o755), (SUDOERS, (rule,), 0o440)):
                secure_path(item)
                require(item.read_bytes() in values and stat.S_IMODE(item.stat().st_mode) == mode)
            require(stat.S_IMODE(path.stat().st_mode) == 0o644)
            return public
        # Partial/conflicting enrollment is deliberately not repaired unattended.
        require(not any(item.exists() or item.is_symlink() for item in (LIBRARY, HELPER, SUDOERS)))
        for directory in (LIBRARY, HELPER.parent, SUDOERS.parent):
            secure_mkdir(directory)
        for name, value in sources.items():
            write_new(LIBRARY / name, value, 0o644)
        write_new(HELPER, LAUNCHER, 0o755)
        atomic_json(path, public, 0o644)
        # Validate before installing the grant. A failed bootstrap has no sudo authority.
        candidate = LIBRARY / 'sudoers.pending'
        write_new(candidate, rule, 0o440)
        subprocess.run(['/usr/sbin/visudo', '-cf', str(candidate)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV, timeout=10, check=True)
        write_new(SUDOERS, rule, 0o440)
        candidate.unlink()
    return public


def verify_signature(node: Path, key: str, payload: bytes, signature: str) -> None:
    decode(key, 32)
    decode(signature, 64)
    secure_path(node)
    packet = {'key': key, 'payload': base64.b64encode(payload).decode('ascii'), 'signature': signature}
    result = subprocess.run([str(node), '--input-type=commonjs', '-e', VERIFY], input=json.dumps(packet).encode(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV, cwd='/', timeout=10, check=False)
    require(result.returncode == 0)


def manifest(value: dict) -> dict:
    """Mirror ReleaseManifest's strict supported schema, including integer semantics."""
    require(isinstance(value, dict) and set(value) == {'schema', 'id', 'protocolVersion', 'layoutVersion', 'compatibility',
                                                      'sequence', 'piVersion', 'extensions', 'rollback'})
    for key, expected in (('schema', 2), ('protocolVersion', 2), ('layoutVersion', 1)):
        require(type(value[key]) is int and value[key] == expected)
    require(value['rollback'] is True and value['compatibility'] == 'native-v1')
    require(isinstance(value['id'], str) and re.fullmatch(r'host-[a-f0-9]{20}', value['id']) is not None)
    require(type(value['sequence']) is int and 0 < value['sequence'] <= 9007199254740991)
    require(isinstance(value['piVersion'], str) and 0 < len(value['piVersion']) <= 64)
    require(isinstance(value['extensions'], list) and len(value['extensions']) <= 64)
    for extension in value['extensions']:
        require(isinstance(extension, dict) and set(extension) == {'name', 'version'})
        for key, maximum in (('name', 128), ('version', 64)):
            require(isinstance(extension[key], str) and 0 < len(extension[key]) <= maximum)
    return value


def verify_header(header: dict) -> tuple[dict, dict, dict, Path]:
    require(set(header) == {'requestBase64', 'authorization', 'deviceSignature'})
    request_bytes = decode(header['requestBase64'])
    request = host_update.validate(parse(request_bytes))
    manifest(request['target'])
    policy = read_public(CONFIG / 'auto-update.json')
    require(policy.get('schema') == 1)
    policy_input({key: policy[key] for key in ('environmentId', 'deviceId', 'publisherPublicKey', 'sshUser')})
    require(request['environmentId'] == policy['environmentId'] and request['deviceId'] == policy['deviceId'])
    installation = read_public(CONFIG / 'installation.json')
    require(installation['environmentId'] == request['environmentId'])
    current = release_path(installation)
    authorization = header['authorization']
    require(isinstance(authorization, dict) and set(authorization) == {'payload', 'signature', 'publisherPublicKey'})
    require(authorization['publisherPublicKey'] == policy['publisherPublicKey'])
    payload = decode(authorization['payload'])
    verify_signature(current / 'node/bin/node', policy['publisherPublicKey'], payload, authorization['signature'])
    signed = parse(payload)
    require(set(signed) == {'schema', 'manifest', 'sha256', 'size', 'runtimePinsSha256', 'requiredTools'})
    require(type(signed['schema']) is int and signed['schema'] == 1)
    require(manifest(signed['manifest']) == request['target'] and signed['sha256'] == request['sha256'])
    require(type(signed['size']) is int and signed['size'] == request['size'])
    require(isinstance(signed['runtimePinsSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', signed['runtimePinsSha256']) is not None)
    tools = signed['requiredTools']
    require(isinstance(tools, list) and len(tools) <= 128)
    require(all(isinstance(tool, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,127}', tool) for tool in tools))
    require(len(set(tools)) == len(tools) and REQUIRED_TOOLS.issubset(tools))
    with ledger(policy['environmentId']) as connection:
        key = device_key(connection, request['deviceId'])
    verify_signature(current / 'node/bin/node', key, request_bytes, header['deviceSignature'])
    return request, signed, installation, current


def require_staging(request: dict, signed: dict, installation: dict, current: Path) -> None:
    require(installation['release'] == request['expectedRelease'])
    source = manifest(read_public(current / 'host-manifest.json'))
    require(source['id'] == request['expectedRelease'] and host_update.compatible(source, request['target']))
    require(digest((current / 'deploy/environment/runtime-pins.json').read_bytes()) == signed['runtimePinsSha256'])
    target = PREFIX / 'releases' / request['releaseId']
    require(not target.exists() and not target.is_symlink())
    with ledger(request['environmentId']) as connection:
        device_key(connection, request['deviceId'])
        staged = record(connection, 'runtime_update', 'server')
        require(staged.get('state') == 'staging' and staged.get('owner') == request['deviceId'])
        require(all(staged.get(key) == request[key] for key in ('operationId', 'expectedRelease', 'sha256', 'target')))


def archive(payload: bytes, request: dict, signed: dict) -> dict[str, bytes | None]:
    """Validate all members before writing any; never use tar.extract/extractall."""
    require(len(payload) == request['size'] and digest(payload) == request['sha256'])
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
        expanded = compressed.read(EXPANDED_LIMIT + 1)
    require(len(expanded) <= EXPANDED_LIMIT)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as source:
        for member in source:
            require(len(files) < FILE_LIMIT)
            name = member.name
            require(not name.startswith('/') and '\\' not in name and not any(ord(char) < 32 for char in name))
            path = PurePosixPath(name)
            require('..' not in path.parts and (member.isdir() or member.isreg()) and not member.issparse())
            name = str(path)
            require(name not in files and (name != '.' or member.isdir()))
            require(member.size <= EXPANDED_LIMIT and member.size >= 0)
            if member.isdir():
                files[name] = None
            else:
                with source.extractfile(member) as contents:
                    files[name] = contents.read(member.size + 1)
                require(len(files[name]) == member.size)
    for name in files:
        require(all(str(parent) not in files or files[str(parent)] is None for parent in PurePosixPath(name).parents))
    required = set(REQUIRED_FILES)
    if signed['requiredTools']:
        required.update({'server/gateway/coordinator.ts', 'server/policy/trust.ts', 'server/core/ledger.ts'})
        required.update(TOOL_FILES[tool.split('.')[0]] for tool in signed['requiredTools'] if tool.split('.')[0] in TOOL_FILES)
    require(all(isinstance(files.get(name), bytes) and files[name] for name in required))
    require(parse(files['host-manifest.json']) == request['target'])
    require(digest(files['deploy/environment/runtime-pins.json']) == signed['runtimePinsSha256'])
    package, lock = parse(files['package.json']), parse(files['package-lock.json'], EXPANDED_LIMIT)
    require(isinstance(lock.get('packages'), dict) and lock.get('lockfileVersion') in (2, 3))
    dependencies = package.get('dependencies', {})
    require(dependencies.get('@earendil-works/pi-coding-agent') == request['target']['piVersion'])
    require(all(dependencies.get(ext['name']) == ext['version'] for ext in request['target']['extensions']))
    return files


def trusted_library() -> Path:
    policy = validate_public_policy(read_public(CONFIG / 'auto-update.json'))
    root = active_library(policy)
    require(EXECUTING_LIBRARY is None or EXECUTING_LIBRARY == root)
    verify_sources(root, policy)
    return root


def safe_receipt(operation: Path, request: dict) -> dict:
    """Allowlist receipt fields; never expose command output or authorization data."""
    status = read_public(operation / 'status.json')
    require(all(status.get(key) == request[key] for key in ('operationId', 'environmentId', 'releaseId')))
    allowed = ('operationId', 'environmentId', 'releaseId', 'state', 'stage', 'updatedAt', 'failureCode', 'failureStage')
    result = {key: status[key] for key in allowed if key in status}
    if isinstance(status.get('health'), dict):
        health = status['health']
        result['health'] = {key: health[key] for key in ('releaseId', 'stableSeconds', 'requiredTools') if key in health}
        if isinstance(health.get('services'), list):
            result['health']['services'] = [{key: service[key] for key in ('unit', 'pid', 'restarts') if key in service}
                                            for service in health['services'] if isinstance(service, dict)]
    require(len(json.dumps(result)) <= HEADER_LIMIT)
    return result


def receive(stream: BinaryIO) -> dict:
    """Persist one authorized packet and launch once; ambiguous outcomes are inspect-only."""
    require(os.geteuid() == 0)
    line = stream.readline(HEADER_LIMIT + 1)
    require(len(line) <= HEADER_LIMIT and line.endswith(b'\n'))
    header = parse(line)
    with installation_lock():
        runner = trusted_library()
        request, signed, installation, current = verify_header(header)
        payload = stream.read(request['size'] + 1)
        require(len(payload) == request['size'] and digest(payload) == request['sha256'])
        operation = OPERATIONS / request['operationId']
        if operation.exists() or operation.is_symlink():
            secure_path(operation, directory=True)
            require(read_public(operation / 'request.json') == request)
            metadata = read_public(operation / 'authorization.json')
            require(metadata['requestSha256'] == digest(decode(header['requestBase64'])) and metadata['header'] == header)
            return safe_receipt(operation, request)
        require_staging(request, signed, installation, current)
        files = archive(payload, request, signed)
        operation.mkdir(mode=0o711)
        atomic_json(operation / 'request.json', request)
        atomic_json(operation / 'authorization.json', {'schema': 1, 'requestSha256': digest(decode(header['requestBase64'])),
                    'requiredTools': signed['requiredTools'], 'header': header})
        write_new(operation / 'release.tar.gz', payload, 0o600)
        source = operation / 'source'
        source.mkdir(mode=0o755)
        for name, content in files.items():
            if name == '.':
                continue
            path = source / name
            secure_mkdir(path.parent)
            if content is None:
                secure_mkdir(path)
            else:
                write_new(path, content, 0o644)
        status = {key: request[key] for key in ('operationId', 'environmentId', 'releaseId')}
        status.update(state='queued', stage='Verified release received', updatedAt=int(time.time() * 1000))
        atomic_json(operation / 'status.json', status, 0o644)
        try:
            with os.fdopen(os.open(operation / 'launch.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as log:
                result = subprocess.run(['/usr/bin/systemd-run', '--unit=outpost-update-' + request['operationId'],
                                         '--property=Type=exec', '--property=RuntimeMaxSec=2700',
                                         '--property=KillMode=control-group', '--property=UMask=0077',
                                         '/usr/bin/python3', '-I', str(runner / 'auto_update.py'), '--run', str(operation)],
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=ENV, cwd='/', timeout=20, check=False)
            require(result.returncode == 0)
        except (OSError, ValueError, subprocess.SubprocessError):
            status.update(state='unknown', stage='Launch not confirmed; inspect the retained receipt')
            atomic_json(operation / 'status.json', status, 0o644)
        return status


class AuthorizedUpdater(host_update.Updater):
    """Revalidate under Updater's installation lock, before any stage or hold changes."""

    def preflight(self) -> None:
        trusted_library()
        metadata = read_public(self.operation / 'authorization.json')
        request, signed, installation, current = verify_header(metadata['header'])
        require(request == self.request and metadata['requestSha256'] == digest(decode(metadata['header']['requestBase64'])))
        require(metadata['requiredTools'] == signed['requiredTools'])
        require_staging(request, signed, installation, current)
        super().preflight()


def run_operation(value: str) -> None:
    require(os.geteuid() == 0)
    operation = Path(value)
    require(operation.parent == OPERATIONS and str(operation) == value)
    identifier(operation.name)
    secure_path(operation, directory=True)
    # systemd can exec us before receive() releases its intake lock. Claim only after
    # acquisition, and retain this same lock through execution (never reacquire LOCK_NB).
    with installation_lock(wait_seconds=RUNNER_LOCK_SECONDS):
        write_new(operation / 'runner.started', b'', 0o600)
        AuthorizedUpdater(operation).execute_locked()


def intake_timeout(_signal, _frame) -> None:
    raise TimeoutError('Auto-update intake deadline exceeded')


def main(argv: list[str] | None = None) -> int:
    """No privileged repair/enroll/reset command is reachable through stdin or argv."""
    args = sys.argv[1:] if argv is None else argv
    try:
        if args:
            require(len(args) == 2 and args[0] == '--run')
            run_operation(args[1])
        else:
            # A client that withholds EOF must not retain the installation lock forever.
            previous = signal.signal(signal.SIGALRM, intake_timeout)
            signal.alarm(120)
            try:
                print(json.dumps(receive(sys.stdin.buffer), separators=(',', ':')))
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous)
        return 0
    except Exception:
        print('{"state":"refused","stage":"Auto-update refused; inspect existing operation if submitted"}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
