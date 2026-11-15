"""Durable, root-owned native host installation. Never edits Kubernetes or legacy data."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import platform
import pwd
import re
import secrets
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

PREFIX = Path('/opt/outpost-native')
DATA = Path('/var/lib/outpost-native')
CONFIG = Path('/etc/outpost-native')
OPERATIONS = Path('/var/lib/outpost-setup/operations')
UNIT_DIRECTORY = Path('/etc/systemd/system')
UNITS = ('outpost-native-worker.service', 'outpost-native-coordinator.service')
HOST_UNIT = 'outpost-native-host.service'
STAGES = ('Preflight', 'Service accounts', 'Private Node runtime', 'Locked server dependencies',
          'Browser runtime', 'Protected configuration', 'Device enrollment', 'Persistent services',
          'Health verification', 'Server ready', 'Private connection', 'Authenticated registration')

COMMAND_LOG_LIMIT = 256 * 1024
LAUNCH_LOG_LIMIT = 64 * 1024
DIAGNOSTIC_COMMAND_LIMIT = 32
DIAGNOSTICS_LIMIT = 32 * 1024
RESET_RECEIPT_LIMIT = 64 * 1024
RESET_COUNT_LIMIT = 4096
RESET_GATE_SECONDS = 10
RESET_COMPLETE_MESSAGE = 'Native reset completed. Original operation evidence is retained; a new installation needs separate approval.'
# Reviewed identifiers, never inferred from argv or supplied by the setup request.
COMMAND_STAGES = {
    'accounts.workspace-group': 'service-accounts',
    **{f'accounts.create-{user}': 'service-accounts' for user in ('outpost-coord', 'outpost-pi', 'outpost-build')},
    **{f'accounts.workspace-{user}': 'service-accounts' for user in ('outpost-coord', 'outpost-pi')},
    'dependencies.build-ownership': 'server-dependencies',
    'dependencies.npm-ci': 'server-dependencies',
    'dependencies.typescript-version': 'server-dependencies',
    'browser.system-dependencies': 'browser-runtime',
    'browser.python-sync': 'browser-runtime',
    'browser.validate-launcher': 'browser-runtime',
    'configuration.release-ownership': 'protected-configuration',
    'configuration.release-permissions': 'protected-configuration',
    'enrollment.initialize': 'device-enrollment',
    'services.verify-units': 'persistent-services',
    'services.daemon-reload': 'persistent-services',
    'services.enable': 'persistent-services',
    'health.services-active': 'health-verification',
}


@contextmanager
def private_log(path: Path, *, exclusive: bool = False) -> Iterator[BinaryIO]:
    """Open only an owned regular file, private before writing, without following links."""
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    descriptor = os.open(path, flags | (os.O_EXCL if exclusive else 0), 0o600)
    with os.fdopen(descriptor, 'w+b', buffering=0) as output:
        info = os.fstat(output.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise ValueError('Unsafe private diagnostic log')
        os.fchmod(output.fileno(), 0o600)
        output.truncate(0)
        yield output
        os.fsync(output.fileno())


class BoundedLog:
    """Retain a byte tail; the child never receives the log descriptor or disk budget."""

    def __init__(self, output: BinaryIO, limit: int) -> None:
        """Bind a parent-owned output file and its maximum retained byte count."""
        self.output = output
        self.limit = limit
        self.tail = bytearray()
        self.bytes_seen = 0
        self.complete = False

    def append(self, chunk: bytes) -> None:
        """Bound memory and every disk write, including between polling intervals."""
        self.bytes_seen += len(chunk)
        self.tail.extend(chunk)
        del self.tail[:max(0, len(self.tail) - self.limit)]
        self.output.seek(0)
        self.output.write(self.tail)
        self.output.truncate()

    def metadata(self) -> dict:
        """Counts cover observed pipe bytes; incomplete streams can have unread output."""
        return {'retention': 'tail', 'limitBytes': self.limit, 'bytesSeen': self.bytes_seen,
                'bytesRetained': len(self.tail), 'bytesDropped': self.bytes_seen - len(self.tail),
                'truncated': self.bytes_seen > len(self.tail) or not self.complete, 'streamComplete': self.complete}


def signal_group(process: subprocess.Popen, sig: int) -> None:
    """Signal descendants even when their original group leader has already exited."""
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def capture_command(argv: list[str], log: BoundedLog, *, timeout: float,
                    cwd: Path | None = None, env: dict[str, str] | None = None,
                    input_data: bytes | None = None, cancelled: Callable[[], bool] | None = None) -> tuple[str, int | None]:
    """Drain merged output and stdin without blocking cancellation or trusting child text."""
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if input_data else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, bufsize=0)
    except (OSError, subprocess.SubprocessError):
        return 'start_failed', None
    stdout, stdin = process.stdout, process.stdin
    assert stdout is not None  # Popen was explicitly given stdout=PIPE.
    outcome = None
    deadline = time.monotonic() + timeout
    terminate_at = None
    drain_until = None
    try:
        with selectors.DefaultSelector() as selector:
            os.set_blocking(stdout.fileno(), False)
            selector.register(stdout, selectors.EVENT_READ)
            pending = memoryview(input_data or b'')
            if stdin:
                os.set_blocking(stdin.fileno(), False)
                selector.register(stdin, selectors.EVENT_WRITE)
            while process.poll() is None or selector.get_map():
                now = time.monotonic()
                if outcome is None:
                    if cancelled is not None and cancelled():
                        outcome = 'cancelled'
                    elif now >= deadline:
                        outcome = 'timed_out'
                    if outcome is not None:
                        signal_group(process, signal.SIGTERM)
                        terminate_at = now + 5
                if terminate_at is not None and now >= terminate_at:
                    signal_group(process, signal.SIGKILL)
                    terminate_at = None
                    drain_until = now + 1
                if drain_until is not None and now >= drain_until:
                    break  # An escaped descendant may still hold the pipe open.
                for key, _ in selector.select(timeout=0.05):
                    if key.fileobj is stdout:
                        try:
                            chunk = os.read(key.fd, 64 * 1024)
                        except BlockingIOError:
                            continue
                        if chunk:
                            log.append(chunk)
                        else:
                            log.complete = True
                            selector.unregister(stdout)
                    elif stdin is not None:
                        try:
                            written = os.write(key.fd, pending[:4096])
                            pending = pending[written:]
                        except BlockingIOError:
                            continue
                        except BrokenPipeError:
                            pending = memoryview(b'')
                        if not pending:
                            selector.unregister(stdin)
                            stdin.close()
    except OSError:
        outcome = outcome or 'capture_failed'
    finally:
        if outcome is not None or process.poll() is None:
            signal_group(process, signal.SIGKILL)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            outcome = outcome or 'capture_failed'
        stdout.close()
        if stdin and not stdin.closed:
            stdin.close()
    return outcome or ('failed' if process.returncode else 'succeeded'), process.returncode


def atomic_json(path: Path, value: object, mode: int = 0o600) -> None:
    """Persist a complete receipt before publishing the next stage."""
    temporary = path.with_name(path.name + '.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode), 'w') as target:
        os.fchmod(target.fileno(), mode)
        json.dump(value, target, separators=(',', ':'))
        target.flush()
        os.fsync(target.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def validate_request(value: dict) -> dict:
    """Accept only this installation protocol; no arbitrary paths, ports or commands."""
    required = {'operationId', 'environmentId', 'deviceId', 'publicKey', 'label', 'releaseId', 'sha256', 'size', 'browser', 'coexistence', 'fullControl'}
    if set(value) != required:
        raise ValueError('Invalid installation request fields')
    for key in ('operationId', 'environmentId', 'deviceId'):
        if str(uuid.UUID(value[key])) != value[key]:
            raise ValueError('Invalid installation identity')
    if not re.fullmatch(r'host-[a-f0-9]{20}', value['releaseId']) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256']):
        raise ValueError('Invalid release digest')
    if type(value['size']) is not int or not 0 < value['size'] <= 16 * 1024 * 1024:
        raise ValueError('Release size exceeds limit')
    if any(type(value[key]) is not bool for key in ('browser', 'coexistence', 'fullControl')):
        raise ValueError('Explicit installation choices required')
    if not isinstance(value['label'], str) or not 1 <= len(value['label']) <= 80 or any(ord(c) < 32 or ord(c) == 127 for c in value['label']):
        raise ValueError('Invalid environment label')
    if len(base64.b64decode(value['publicKey'], validate=True)) != 32:
        raise ValueError('Invalid device public key')
    return value


def extract_source(archive: Path, destination: Path) -> None:
    """Extract only bounded regular source files under a newly created directory."""
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if len(members) > 4096 or sum(item.size for item in members) > 32 * 1024 * 1024:
            raise ValueError('Release exceeds extraction limits')
        for item in members:
            if not (item.isfile() or item.isdir()) or item.name.startswith('/') or '..' in Path(item.name).parts:
                raise ValueError('Unsafe release member')
        source.extractall(destination, members=members, filter='data')


def bootstrap() -> None:
    """Read the reviewed packet over SSH, persist it and start one root-owned job."""
    if os.geteuid() != 0 or sys.version_info < (3, 12):
        raise RuntimeError('Administrative setup requires root and Python 3.12 or later')
    request = validate_request(json.loads(sys.stdin.buffer.readline(16385)))
    payload = sys.stdin.buffer.read(request['size'] + 1)
    if len(payload) != request['size'] or hashlib.sha256(payload).hexdigest() != request['sha256']:
        raise ValueError('Release transfer checksum mismatch')
    OPERATIONS.mkdir(parents=True, mode=0o711, exist_ok=True)
    os.chmod(OPERATIONS.parent, 0o711)
    os.chmod(OPERATIONS, 0o711)
    operation = OPERATIONS / request['operationId']
    try:
        operation.mkdir(mode=0o711)
    except FileExistsError:
        if json.loads((operation / 'request.json').read_text()) != request:
            raise ValueError('Operation identity already belongs to a different request')
        print((operation / 'status.json').read_text())
        return  # A repeated launch can only read its existing receipt, never execute again.
    operation.chmod(0o711)
    atomic_json(operation / 'request.json', request)
    (operation / 'release.tar.gz').write_bytes(payload)
    (operation / 'cancel').touch(mode=0o600)
    os.chown(operation / 'cancel', int(os.environ.get('SUDO_UID', '0')), -1)
    source = operation / 'source'
    source.mkdir(mode=0o755)
    extract_source(operation / 'release.tar.gz', source)
    status = {'operationId': request['operationId'], 'environmentId': request['environmentId'], 'releaseId': request['releaseId'],
              'state': 'queued', 'completedSteps': 0, 'totalSteps': len(STAGES), 'stage': STAGES[0],
              'startedAt': int(time.time() * 1000), 'updatedAt': int(time.time() * 1000), 'log': ['Verified release received. Installation queued.'], 'error': None}
    atomic_json(operation / 'status.json', status, 0o644)
    command = ['/usr/bin/systemd-run', '--unit=outpost-setup-' + request['operationId'],
               '--property=Type=exec', '--property=RuntimeMaxSec=2700', '--property=KillMode=control-group',
               '--property=UMask=0077', '/usr/bin/python3', str(source / 'deploy/environment/host_install.py'), '--run', str(operation)]
    with private_log(operation / 'launch.log', exclusive=True) as output:
        outcome, return_code = capture_command(command, BoundedLog(output, LAUNCH_LOG_LIMIT), timeout=20)
    if return_code is None:
        raise RuntimeError('Setup service launch could not start; check status before retrying')
    atomic_json(operation / 'launch.json', {'returnCode': return_code}, 0o644)
    if outcome != 'succeeded':
        status.update(state='unknown', error=f'Setup service launch was not confirmed (exit {return_code}). Check status; an administrator can inspect launch.log. Do not assume no steps ran.')
    print(json.dumps(status))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward internal service authentication to another listener or origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Reject all redirects, including loopback ones."""
        return


def reset_metadata(info: os.stat_result) -> tuple:
    """Exclude atime while binding a reset evidence inode against replacement/change."""
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def reset_protected(info: os.stat_result, owner: int, directory: bool) -> None:
    """The reset fence trusts only root-owned, non-writable, non-linked metadata."""
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022 or (not directory and info.st_nlink != 1):
        raise RuntimeError('Reset recovery hold: unsafe reset evidence; manual recovery required')


@contextmanager
def installation_lock(*, root_fd: int | None = None, parts: tuple[str, ...] = (),
                      owner: int | None = None) -> Iterator[int]:
    """Anchor the shared installation lock without following links or truncating it.

    Production's root-only entrypoints use the fixed OPERATIONS.parent and UID 0.
    Keeping that module-level filesystem backend injectable also supports existing
    unprivileged fixtures; no bootstrap request can select a path, descriptor or UID.
    """
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    owner = os.geteuid() if owner is None else owner
    directory = os.open(OPERATIONS.parent, flags) if root_fd is None else os.dup(root_fd)
    lock = None
    try:
        reset_protected(os.fstat(directory), owner, True)
        for part in parts:
            if not part or part in ('.', '..') or '/' in part:
                raise RuntimeError('Invalid fixed installation lock scope')
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
            reset_protected(os.fstat(directory), owner, True)
        try:
            before = os.stat('install.lock', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            lock = os.open('install.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            os.fsync(directory)
        else:
            reset_protected(before, owner, False)
            lock = os.open('install.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            if reset_metadata(before) != reset_metadata(os.fstat(lock)):
                raise RuntimeError('Installation lock changed; no installation started')
        reset_protected(os.fstat(lock), owner, False)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        linked = os.stat('install.lock', dir_fd=directory, follow_symlinks=False)
        if (linked.st_dev, linked.st_ino) != (os.fstat(lock).st_dev, os.fstat(lock).st_ino):
            raise RuntimeError('Installation lock was replaced; no installation started')
        yield directory
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def check_reset_holds(setup_fd: int, owner: int = 0) -> None:
    """Read a bounded, descriptor-anchored reset fence UNDER installation_lock.

    An absent resets directory means no reset has claimed an identity. Once a
    reset directory exists, only a fully validated root-owned complete receipt
    releases its hold. Missing, malformed, failed and unknown receipts all block.
    No private audit, original archive, helper or runtime code is executed here.
    """
    deadline = time.monotonic() + RESET_GATE_SECONDS
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK

    def budget() -> None:
        if time.monotonic() >= deadline:
            raise RuntimeError('Reset recovery hold: evidence audit timed out')

    def identifier(value: object) -> bool:
        try:
            return isinstance(value, str) and str(uuid.UUID(value)) == value
        except ValueError:
            return False

    def pairs(items: list[tuple[str, object]]) -> dict:
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('Duplicate receipt field')
            value[key] = item
        return value

    def invalid_constant(_value: str) -> None:
        raise ValueError('Nonfinite receipt value')

    try:
        budget()
        reset_protected(os.fstat(setup_fd), owner, True)
        try:
            resets = os.open('resets', directory_flags, dir_fd=setup_fd)
        except FileNotFoundError:
            return
        try:
            before = os.fstat(resets)
            reset_protected(before, owner, True)
            with os.scandir(resets) as entries:
                for count, entry in enumerate(entries, 1):
                    budget()
                    if count > RESET_COUNT_LIMIT or not identifier(entry.name):
                        raise RuntimeError('Reset recovery hold: unrecognized or excessive reset evidence')
                    operation = os.open(entry.name, directory_flags, dir_fd=resets)
                    try:
                        reset_protected(os.fstat(operation), owner, True)
                        info = os.stat('status.json', dir_fd=operation, follow_symlinks=False)
                        reset_protected(info, owner, False)
                        if info.st_size > RESET_RECEIPT_LIMIT:
                            raise RuntimeError('Reset recovery hold: oversized reset receipt')
                        receipt_fd = os.open('status.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=operation)
                        try:
                            if reset_metadata(info) != reset_metadata(os.fstat(receipt_fd)):
                                raise RuntimeError('Reset recovery hold: receipt changed')
                            with os.fdopen(receipt_fd, 'rb', closefd=False) as source:
                                raw = source.read(RESET_RECEIPT_LIMIT + 1)
                            budget()
                            if len(raw) > RESET_RECEIPT_LIMIT or reset_metadata(info) != reset_metadata(os.fstat(receipt_fd)):
                                raise RuntimeError('Reset recovery hold: receipt changed or exceeds its budget')
                        finally:
                            os.close(receipt_fd)
                        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid_constant)
                        keys = {'schemaVersion', 'operationId', 'environmentId', 'releaseId', 'resetId', 'state',
                                'message', 'bindingDigest', 'snapshotDigest'}
                        if not (isinstance(value, dict) and set(value) == keys and type(value['schemaVersion']) is int
                                and value['schemaVersion'] == 1 and value['state'] == 'complete'
                                and value['resetId'] == entry.name and all(identifier(value[key]) for key in ('operationId', 'environmentId'))
                                and isinstance(value['releaseId'], str) and re.fullmatch(r'host-[a-f0-9]{20}', value['releaseId'])
                                and all(isinstance(value[key], str) and re.fullmatch(r'[a-f0-9]{64}', value[key]) for key in ('bindingDigest', 'snapshotDigest'))
                                and value['message'] == RESET_COMPLETE_MESSAGE):
                            raise RuntimeError('Reset recovery hold: no verified complete receipt; manual recovery required')
                    finally:
                        os.close(operation)
            if reset_metadata(before) != reset_metadata(os.fstat(resets)):
                raise RuntimeError('Reset recovery hold: evidence inventory changed')
        finally:
            os.close(resets)
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        raise RuntimeError('Reset recovery hold: missing, malformed or unreadable evidence; manual recovery required') from None


class Installer:
    """One serialized install, with bounded commands and non-secret stage receipts."""

    def __init__(self, operation: Path) -> None:
        self.operation = operation
        self.request = validate_request(json.loads((operation / 'request.json').read_text()))
        self.status = json.loads((operation / 'status.json').read_text())
        self.release = PREFIX / 'releases' / self.request['releaseId']
        self.node = self.release / 'node/bin/node'
        self.environment = {'PATH': str(self.release / 'node/bin') + ':/usr/sbin:/usr/bin:/sbin:/bin',
                            'HOME': str(operation / 'build-home'), 'LANG': 'C.UTF-8', 'DEBIAN_FRONTEND': 'noninteractive',
                            'NEEDRESTART_MODE': 'l'}
        self.activated = False
        self.units = (*UNITS, HOST_UNIT) if self.request['fullControl'] else UNITS
        self.diagnostics = {
            'schema': 1, **{key: self.request[key] for key in ('operationId', 'environmentId', 'releaseId')},
            'startedAt': self.status['startedAt'], 'updatedAt': int(time.time() * 1000),
            'commandCount': 0, 'omittedCommandCount': 0, 'commands': [], 'failedCommand': None,
            'logs': {'command.log': None, 'failed-command.log': None},
        }

    def publish(self, completed: int, message: str, state: str = 'running', error: str | None = None) -> None:
        """Report completed stages, never a fabricated duration-based percentage."""
        self.status.update(state=state, completedSteps=completed, stage=STAGES[min(completed, 11)],
                           updatedAt=int(time.time() * 1000), error=error)
        self.status['log'] = (self.status['log'] + [message])[-80:]
        atomic_json(self.operation / 'status.json', self.status, 0o644)

    def cancelled(self) -> bool:
        """The SSH account can request cancellation without acquiring runtime root."""
        with (self.operation / 'cancel').open('rb') as source:
            return source.read(1) == b'1'

    def save_diagnostics(self) -> None:
        """Bound private provenance independently of the strict public receipt schema."""
        diagnostics = self.diagnostics
        diagnostics['updatedAt'] = int(time.time() * 1000)
        diagnostics['commands'] = diagnostics['commands'][-DIAGNOSTIC_COMMAND_LIMIT:]
        while True:
            diagnostics['omittedCommandCount'] = diagnostics['commandCount'] - len(diagnostics['commands'])
            if len(json.dumps(diagnostics, separators=(',', ':')).encode()) <= DIAGNOSTICS_LIMIT:
                break
            if not diagnostics['commands']:
                raise ValueError('Diagnostic metadata exceeds its bound')
            diagnostics['commands'].pop(0)
        atomic_json(self.operation / 'diagnostics.json', diagnostics)

    def run(self, argv: list[str], *, command_id: str, user: str | None = None, input_data: bytes | None = None,
            timeout: float = 900, env: dict[str, str] | None = None) -> None:
        """Execute reviewed argv with private, bounded evidence and fixed public errors."""
        if command_id not in COMMAND_STAGES:
            raise ValueError('Unreviewed diagnostic command identifier')
        if self.cancelled():
            raise InterruptedError('Setup cancellation requested')
        command = ['/usr/sbin/runuser', '--preserve-environment', '-u', user, '--', *argv] if user else argv
        # host_update stages dependencies on object.__new__(Installer), without an install receipt.
        diagnostics = getattr(self, 'diagnostics', None)
        with private_log(self.operation / 'command.log') as output:
            log = BoundedLog(output, COMMAND_LOG_LIMIT)
            record = {'commandId': command_id, 'stageId': COMMAND_STAGES[command_id], 'substageId': command_id.split('.', 1)[1],
                      'startedAt': int(time.time() * 1000), 'finishedAt': None, 'outcome': 'running', 'exitCode': None,
                      'output': log.metadata()}
            if diagnostics is not None:
                diagnostics['commandCount'] += 1
                record.update(sequence=diagnostics['commandCount'], completedSteps=self.status.get('completedSteps', 0))
                diagnostics['commands'].append(record)
                diagnostics['logs']['command.log'] = record['sequence']
                self.save_diagnostics()
            outcome, return_code = capture_command(command, log, cwd=self.release, env=env or self.environment,
                                                   input_data=input_data, timeout=timeout, cancelled=self.cancelled)
            record.update(finishedAt=int(time.time() * 1000), outcome=outcome, exitCode=return_code, output=log.metadata())
            if outcome != 'succeeded':
                try:
                    with private_log(self.operation / 'failed-command.log', exclusive=True) as failed:
                        failed.write(log.tail)
                except FileExistsError:
                    pass  # Never replace original failure evidence with a later/cleanup failure.
                else:
                    if diagnostics is not None:
                        diagnostics['failedCommand'] = record
                        diagnostics['logs']['failed-command.log'] = record['sequence']
            if diagnostics is not None:
                self.save_diagnostics()
        if outcome == 'cancelled':
            raise InterruptedError('Setup cancellation requested; private diagnostics retained')
        if outcome == 'timed_out':
            raise TimeoutError('Setup command timed out; inspect private diagnostics before retrying')
        if outcome == 'failed':
            raise RuntimeError(f'Setup command failed (exit {return_code}); root-only failed-command.log contains diagnostics')
        if outcome != 'succeeded':
            raise RuntimeError('Setup command could not start or capture output; inspect private diagnostics before retrying')

    def download(self, url: str, digest: str, destination: Path, max_bytes: int = 256 * 1024 * 1024) -> None:
        """Download an exact trusted artifact; never execute an unchecked response."""
        if not url.startswith('https://') or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid pinned artifact')
        checksum = hashlib.sha256()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=30) as response, destination.open('wb') as output:
            size = 0
            while chunk := response.read(1024 * 1024):
                if self.cancelled():
                    raise InterruptedError('Download cancelled')
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError('Artifact exceeds download bound')
                output.write(chunk)
                checksum.update(chunk)
        if checksum.hexdigest() != digest:
            raise ValueError('Pinned artifact checksum mismatch')

    def preflight(self) -> None:
        """Recheck conflicts under the installation lock, not only during UI discovery."""
        metadata = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
        if metadata.get('ID', '').strip('"') != 'ubuntu' or platform.machine() != 'x86_64' or not Path('/run/systemd/system').is_dir():
            raise ValueError('This installer requires Ubuntu x86_64 with systemd')
        if int(metadata.get('VERSION_ID', '"0"').strip('"').split('.')[0]) < 24:
            raise ValueError('Ubuntu 24.04 or later is required')
        if shutil.disk_usage('/var/lib').free < 10 * 1024 ** 3 or shutil.disk_usage('/opt').free < 5 * 1024 ** 3:
            raise ValueError('Insufficient disk space on installation volumes')
        memory = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))
        if memory < (3 if self.request['browser'] else 2) * 1024 ** 3:
            raise ValueError('Insufficient usable RAM: 2 GiB required, or 3 GiB with the browser runtime')
        for path in (PREFIX, DATA, CONFIG, *(UNIT_DIRECTORY / name for name in (*UNITS, HOST_UNIT))):
            if path.exists() or path.is_symlink():
                raise ValueError('Native installation paths already exist; reuse or recovery review is required')
        signals = ('/etc/rancher/k3s', '/var/lib/kubelet', '/etc/kubernetes', '/var/lib/docker', '/var/lib/containerd', '/srv/remotejobs/pi-workspace', '/opt/outpost', '/var/lib/outpost')
        if any(Path(path).exists() for path in signals) and not self.request['coexistence']:
            raise ValueError('Existing deployment requires explicit independent-installation consent')
        if Path('/.dockerenv').exists() or Path('/run/.containerenv').exists():
            raise ValueError('Install on the host, not inside a container')
        for port in ((4518, 4519, 4520) if self.request['fullControl'] else (4518, 4520)):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        for name in ('outpost-coord', 'outpost-pi', 'outpost-build'):
            try:
                pwd.getpwnam(name)
            except KeyError:
                continue
            raise ValueError('Dedicated service account already exists; review before installation')

    def accounts(self) -> None:
        """Create separate coordinator/worker identities without broad sudo rules."""
        PREFIX.mkdir(mode=0o755)
        (PREFIX / 'releases').mkdir(mode=0o755)
        DATA.mkdir(mode=0o711)
        CONFIG.mkdir(mode=0o755)
        self.release.mkdir(mode=0o755)
        for path, mode in ((PREFIX, 0o755), (PREFIX / 'releases', 0o755), (DATA, 0o711), (CONFIG, 0o755), (self.release, 0o755)):
            path.chmod(mode)
        self.run(['/usr/sbin/groupadd', '--system', 'outpost-workspaces'], command_id='accounts.workspace-group')
        for user in ('outpost-coord', 'outpost-pi', 'outpost-build'):
            self.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', user], command_id=f'accounts.create-{user}')
        for user in ('outpost-coord', 'outpost-pi'):
            self.run(['/usr/sbin/usermod', '--append', '--groups', 'outpost-workspaces', user], command_id=f'accounts.workspace-{user}')
        for name, user in (('coordinator', 'outpost-coord'), ('worker', 'outpost-pi')):
            path = DATA / name
            path.mkdir(mode=0o700)
            shutil.chown(path, user=user, group=user)
        shared = DATA / 'workspaces'
        shared.mkdir(mode=0o2770)
        shutil.chown(shared, user='outpost-coord', group='outpost-workspaces')
        shared.chmod(0o2770)
        home = self.operation / 'build-home'
        home.mkdir(mode=0o700)
        shutil.chown(home, user='outpost-build', group='outpost-build')
        shutil.copytree(self.operation / 'source', self.release, dirs_exist_ok=True)

    def runtime(self) -> None:
        """Install pinned private Node without changing host Node or package sources."""
        pins = json.loads((self.release / 'deploy/environment/runtime-pins.json').read_text())
        archive = self.operation / 'node.tar.xz'
        self.download(pins['nodeUrl'], pins['nodeSha256'], archive)
        with tarfile.open(archive) as source:
            source.extractall(self.release, filter='data')
        (self.release / f"node-v{pins['nodeVersion']}-linux-x64").rename(self.release / 'node')

    def dependencies(self) -> None:
        """Install lockfile-integrity checked dependencies as an unprivileged build user."""
        self.run(['/bin/chown', '-R', 'outpost-build:outpost-build', str(self.release)], command_id='dependencies.build-ownership')
        self.run([str(self.node), str(self.release / 'node/lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], command_id='dependencies.npm-ci', user='outpost-build', timeout=1200)
        self.run([str(self.node), str(self.release / 'node_modules/typescript/bin/tsc'), '--version'], command_id='dependencies.typescript-version', user='outpost-build')

    def browsers(self) -> None:
        """Provision the pinned Camoufox engine without a separate inference worker."""
        if not self.request['browser']:
            return
        # The release is sealed root-owned later; it must not share inodes with the build cache.
        env = {**self.environment, 'XDG_CACHE_HOME': str(self.release / 'browsers'),
               'UV_PYTHON_INSTALL_DIR': str(self.release / 'python'), 'UV_CACHE_DIR': str(self.operation / 'build-home/cache'),
               'UV_LINK_MODE': 'copy'}
        self.run([str(self.node), str(self.release / 'node_modules/playwright-camoufox/cli.js'), 'install-deps', 'firefox'], command_id='browser.system-dependencies', timeout=900)
        pins = json.loads((self.release / 'deploy/environment/runtime-pins.json').read_text())
        wheel = self.operation / 'uv.whl'
        self.download(pins['uvUrl'], pins['uvSha256'], wheel)
        with zipfile.ZipFile(wheel) as source:
            name = next(name for name in source.namelist() if name.endswith('.data/scripts/uv'))
            uv = self.release / 'node/bin/uv'
            uv.write_bytes(source.read(name))
            uv.chmod(0o755)
        self.run([str(uv), 'sync', '--frozen', '--no-dev', '--project', str(self.release / 'server/browser-engine'), '--python', pins['pythonVersion']], command_id='browser.python-sync', user='outpost-build', env=env, timeout=1200)
        archive = self.operation / 'camoufox.zip'
        self.download(pins['camoufoxUrl'], pins['camoufoxSha256'], archive, max_bytes=2 * 1024 * 1024 * 1024)
        browser = self.release / 'browsers/camoufox/browsers/official' / (pins['camoufoxVersion'] + '-' + pins['camoufoxBuild'])
        browser.mkdir(parents=True, mode=0o755)
        with zipfile.ZipFile(archive) as source:
            if sum(item.file_size for item in source.infolist()) > 6 * 1024 * 1024 * 1024:
                raise ValueError('Browser archive exceeds extraction bound')
            for item in source.infolist():
                target = browser / item.filename
                if not target.resolve().is_relative_to(browser.resolve()):
                    raise ValueError('Browser archive path escapes its installation')
                source.extract(item, browser)
                if target.is_file():
                    target.chmod(0o755 if (item.external_attr >> 16) & 0o111 else 0o644)
        atomic_json(browser / 'version.json', {'version': pins['camoufoxVersion'], 'build': pins['camoufoxBuild'],
                    'interface': pins['camoufoxInterface'], 'sha256': pins['camoufoxSha256']}, 0o644)
        # Camoufox generates its pinned font configuration during the unprivileged check.
        # Only this cache directory is writable by the build user; configuration() seals it.
        fontconfig = self.release / 'browsers/camoufox/fontconfig'
        fontconfig.mkdir(mode=0o755)
        shutil.chown(fontconfig, user='outpost-build', group='outpost-build')
        # mkdir(parents=True) and ZIP extraction inherit the root job's 0077 umask.
        # Publish traversal only for downloaded browser artifacts before dropping privileges.
        for directory, _, _ in os.walk(self.release / 'browsers'):
            Path(directory).chmod(0o755)
        self.run([str(self.release / 'server/browser-engine/.venv/bin/python'), str(self.release / 'server/browser-engine/launch.py')], command_id='browser.validate-launcher', user='outpost-build', env=env)

    def configuration(self) -> None:
        """Write separate runtime credentials; only the coordinator can call the root executor."""
        self.run(['/bin/chown', '-R', 'root:root', str(self.release)], command_id='configuration.release-ownership')
        self.run(['/bin/chmod', '-R', 'a+rX,go-w', str(self.release)], command_id='configuration.release-permissions')
        profile = DATA / 'worker/profile'
        atomic_json(self.release / 'pi-release.json', {'id': self.request['releaseId'], 'piVersion': json.loads((self.release / 'package.json').read_text())['dependencies']['@earendil-works/pi-coding-agent'],
                    'lockHash': hashlib.sha256((self.release / 'package-lock.json').read_bytes()).hexdigest(), 'profile': str(profile)}, 0o644)
        token = secrets.token_hex(32)
        for user, name in (('outpost-coord', 'coordinator'), ('outpost-pi', 'worker')):
            path = CONFIG / name
            path.mkdir(mode=0o700)
            shutil.chown(path, user=user, group=user)
            secret = path / 'worker-token'
            secret.write_text(token)
            secret.chmod(0o600)
            shutil.chown(secret, user=user, group=user)
        worker = {'PI_CODING_AGENT_DIR': str(profile), 'OUTPOST_PI_RELEASE_FILE': str(self.release / 'pi-release.json'),
                  'OUTPOST_PI_WORKSPACES': str(DATA / 'workspaces'), 'OUTPOST_PI_SESSIONS': str(DATA / 'worker/sessions'),
                  'OUTPOST_PI_WORKER_TOKEN_FILE': str(CONFIG / 'worker/worker-token'), 'OUTPOST_PI_WORKER_PORT': '4520', 'OUTPOST_WORKSPACE_SHARED': 'true'}
        coordinator = {'OUTPOST_DATA': str(DATA / 'coordinator'), 'OUTPOST_WORKSPACE_ROOT': str(DATA / 'workspaces'),
                       'OUTPOST_PI_WORKER_URL': 'http://127.0.0.1:4520', 'OUTPOST_PI_WORKER_TOKEN_FILE': str(CONFIG / 'coordinator/worker-token'),
                       'PORT': '4518', 'OUTPOST_ENVIRONMENT_LABEL': self.request['label'], 'OUTPOST_RUNTIME_RELEASE': self.request['releaseId'],
                       'OUTPOST_ALLOW_LEGACY_PROTOCOL': 'false', 'OUTPOST_EXECUTABLES': '/bin/ls:/usr/bin/id:/usr/bin/uname:/usr/bin/git'}
        if self.request['fullControl']:
            secret = CONFIG / 'coordinator/host-token'
            secret.write_text(secrets.token_hex(32))
            secret.chmod(0o600)
            shutil.chown(secret, user='outpost-coord', group='outpost-coord')
            coordinator.update(OUTPOST_FULL_CONTROL='true', OUTPOST_HOST_TOKEN_FILE=str(secret),
                               OUTPOST_HOST_ENDPOINTS=json.dumps({'local': 'http://127.0.0.1:4519'}))
        if self.request['browser']:
            coordinator.update(OUTPOST_BROWSER_ENABLED='true', OUTPOST_CAMOUFOX_PYTHON=str(self.release / 'server/browser-engine/.venv/bin/python'),
                               XDG_CACHE_HOME=str(self.release / 'browsers'))
        configurations = [('worker', worker), ('coordinator', coordinator)]
        if self.request['fullControl']:
            configurations.append(('host', {'OUTPOST_HOST_TOKEN_FILE': str(CONFIG / 'coordinator/host-token'),
                                             'OUTPOST_HOST_MODE': 'native', 'OUTPOST_HOST_NAME': 'local', 'OUTPOST_HOST_PORT': '4519'}))
        for name, values in configurations:
            # Quoted systemd environment syntax; reject control characters in reviewed input.
            text = ''.join(key + '=' + json.dumps(value, ensure_ascii=False) + '\n' for key, value in values.items())
            path = CONFIG / (name + '.env')
            path.write_text(text)
            path.chmod(0o600)  # systemd reads these as root, not as the service account.
        (PREFIX / 'current').symlink_to(self.release)

    def enroll(self) -> None:
        """Pre-enroll the installing device without exposing a reusable bootstrap token."""
        public = {key: self.request[key] for key in ('environmentId', 'deviceId', 'publicKey')}
        public['name'] = 'Outpost'
        self.run([str(self.node), '--import', 'tsx', str(self.release / 'server/environment/initialize.ts')], command_id='enrollment.initialize', user='outpost-coord',
                 input_data=json.dumps(public).encode(), env={**self.environment, 'HOME': str(DATA / 'coordinator'), 'OUTPOST_DATA': str(DATA / 'coordinator')})

    def services(self) -> None:
        """Enable non-root services and, only with reviewed consent, a root executor."""
        for name, user, source, private in (('worker', 'outpost-pi', 'server/pi-worker/main.ts', 'worker'), ('coordinator', 'outpost-coord', 'server/main.ts', 'coordinator')):
            after = 'After=network-online.target\nWants=network-online.target\n'
            if name == 'coordinator':
                dependencies = 'outpost-native-worker.service' + (' ' + HOST_UNIT if self.request['fullControl'] else '')
                after += f'After={dependencies}\nRequires={dependencies}\n'
            unit = '[Unit]\nDescription=Outpost native ' + name + '\n' + after + '[Service]\nType=simple\n'
            unit += f'User={user}\nGroup={user}\nSupplementaryGroups=outpost-workspaces\nUMask=0007\n'
            unit += f'WorkingDirectory={self.release}\nEnvironmentFile={CONFIG}/{name}.env\n'
            unit += f'Environment="PATH={self.release}/node/bin:/usr/bin:/bin" "HOME={DATA}/{private}"\n'
            unit += f'ExecStart={self.node} --import tsx {self.release}/{source}\n'
            unit += 'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\n'
            unit += f'ReadWritePaths={DATA}/{private} {DATA}/workspaces\n'
            unit += 'TasksMax=512\nLimitNOFILE=8192\nMemoryHigh=30%\nMemoryMax=40%\nCPUQuota=200%\n[Install]\nWantedBy=multi-user.target\n'
            path = UNIT_DIRECTORY / f'outpost-native-{name}.service'
            with path.open('x') as output:
                output.write(unit)
            path.chmod(0o644)
        if self.request['fullControl']:
            unit = ('[Unit]\nDescription=Outpost full server control\nAfter=network-online.target\nWants=network-online.target\n'
                    '[Service]\nType=simple\nUser=root\nGroup=root\nUMask=0077\nWorkingDirectory=/\n'
                    f'EnvironmentFile={CONFIG}/host.env\n'
                    f'ExecStart={self.node} {self.release}/deploy/agent/host-executor.mjs\n'
                    'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\n'
                    '[Install]\nWantedBy=multi-user.target\n')
            path = UNIT_DIRECTORY / HOST_UNIT
            with path.open('x') as output:
                output.write(unit)
            path.chmod(0o644)
        self.run(['/usr/bin/systemd-analyze', 'verify', *(str(UNIT_DIRECTORY / name) for name in self.units)], command_id='services.verify-units')
        self.run(['/usr/bin/systemctl', 'daemon-reload'], command_id='services.daemon-reload')
        self.activated = True
        self.run(['/usr/bin/systemctl', 'enable', '--now', *self.units], command_id='services.enable', timeout=60)

    def health(self) -> None:
        """Require the enrolled identity, runtime services and approved host authority."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        expected = self.request['environmentId']
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.cancelled():
                raise InterruptedError('Verification cancelled')
            try:
                with opener.open('http://127.0.0.1:4518/v2/environment', timeout=2) as response:
                    value = json.loads(response.read(32768))
                    if not isinstance(value, dict) or value.get('environmentId') != expected or value.get('protocolVersion') != 2 or value.get('runtime', {}).get('release') != self.request['releaseId'] or response.headers.get('x-outpost-environment-id') != expected:
                        raise ValueError('Installation identity mismatch')
                token = (CONFIG / 'coordinator/worker-token').read_text()
                request = urllib.request.Request('http://127.0.0.1:4520/v1', data=json.dumps({'type': 'management', 'owner': self.request['deviceId'], 'request': {'type': 'runtime.inventory'}}).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with opener.open(request, timeout=10) as response:
                    if json.loads(response.read(32768)).get('releaseId') != self.request['releaseId']:
                        raise ValueError('Worker release mismatch')
                if self.request['fullControl']:
                    self.verify_host_control(opener)
            except (OSError, json.JSONDecodeError) as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                time.sleep(1)
            else:
                # HTTP readiness may be polled; a failed/timed-out command must not be replayed.
                self.run(['/usr/bin/systemctl', 'is-active', '--quiet', *self.units], command_id='health.services-active', timeout=10)
                atomic_json(CONFIG / 'installation.json', {'schema': 1, 'layoutVersion': 1, 'environmentId': expected, 'release': self.request['releaseId'], 'apiPort': 4518, 'operationId': self.request['operationId'], 'fullControl': self.request['fullControl']}, 0o644)
                return
        raise RuntimeError('Services did not become ready; original installations are unchanged')

    def verify_host_control(self, opener) -> None:
        """Read-only authenticated execution must demonstrate real root authority."""
        token = (CONFIG / 'coordinator/host-token').read_text().strip()
        request = urllib.request.Request('http://127.0.0.1:4519/execute',
                                         data=json.dumps({'command': '/usr/bin/id -u', 'timeoutMs': 5000, 'taskId': self.request['operationId']}).encode(),
                                         headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(request, timeout=10) as response:
            result = json.loads(response.read(32768))
        if (result.get('host') != 'local' or result.get('exitCode') != 0 or result.get('stdout', '').strip() != '0'
                or result.get('timedOut') or result.get('outputLimitReached')):
            raise ValueError('Full server control verification failed; executor did not demonstrate root access')

    def execute(self) -> None:
        """Run once, recording partial failure without deleting user data or retrying effects."""
        completed = 0
        try:
            with installation_lock() as setup_fd:
                self.status = json.loads((self.operation / 'status.json').read_text())
                if self.status['state'] != 'queued':
                    return  # No resume/replay, including resetting retained diagnostic provenance.
                check_reset_holds(setup_fd, os.fstat(setup_fd).st_uid)
                self.save_diagnostics()
                for step in (self.preflight, self.accounts, self.runtime, self.dependencies, self.browsers, self.configuration, self.enroll, self.services, self.health):
                    self.publish(completed, STAGES[completed] + ' started.')
                    if self.cancelled():
                        raise InterruptedError('Setup cancelled')
                    step()
                    completed += 1
                    self.publish(completed, STAGES[completed - 1] + ' completed.')
                self.publish(10, 'Server ready. Connect and verify this Mac before setup is complete.', 'ready')
        except (OSError, ValueError, RuntimeError, KeyError, StopIteration, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
            if self.activated:
                # Only this fresh installation's units; no legacy service or data is touched.
                try:
                    subprocess.run(['/usr/bin/systemctl', 'disable', '--now', *self.units], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45, check=False)
                except (OSError, subprocess.SubprocessError):
                    pass  # Cleanup must not suppress the original failed/cancelled receipt.
            self.publish(completed, 'Setup stopped. Partial native files are retained for review; existing deployments were not changed.',
                         'cancelled' if isinstance(error, InterruptedError) else 'failed', str(error)[:400])


if __name__ == '__main__':
    if sys.argv[1:] == ['--bootstrap']:
        bootstrap()
    elif len(sys.argv) == 3 and sys.argv[1] == '--run' and os.geteuid() == 0:
        operation_path = Path(sys.argv[2])
        if operation_path.parent != OPERATIONS or str(uuid.UUID(operation_path.name)) != operation_path.name:
            raise ValueError('Invalid operation directory')
        Installer(operation_path).execute()
    else:
        raise SystemExit('Use the reviewed native setup protocol')
