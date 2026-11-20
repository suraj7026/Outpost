"""Shared low-churn native host primitives for installation and updates."""
from __future__ import annotations

import json
import os
import selectors
import signal
import stat
import subprocess
import tarfile
import time
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

PREFIX = Path('/opt/outpost-native')
DATA = Path('/var/lib/outpost-native')
CONFIG = Path('/etc/outpost-native')
OPERATIONS = Path('/var/lib/outpost-setup/operations')
UNIT_DIRECTORY = Path('/etc/systemd/system')

COMMAND_LOG_LIMIT = 256 * 1024


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


def run_as_user(argv: list[str], *, user: str | None, cwd: Path, env: dict[str, str],
                operation: Path, timeout: float = 900, input_data: bytes | None = None,
                cancelled: Callable[[], bool] | None = None) -> None:
    """Execute reviewed argv as an unprivileged user with private, bounded logs."""
    def is_cancelled() -> bool:
        if cancelled is not None:
            return cancelled()
        cancel_file = operation / 'cancel'
        if not cancel_file.exists():
            return False
        with cancel_file.open('rb') as source:
            return source.read(1) == b'1'

    if is_cancelled():
        raise InterruptedError('Setup cancellation requested')
    command = ['/usr/sbin/runuser', '--preserve-environment', '-u', user, '--', *argv] if user else argv
    with private_log(operation / 'command.log') as output:
        log = BoundedLog(output, COMMAND_LOG_LIMIT)
        outcome, return_code = capture_command(command, log, cwd=cwd, env=env,
                                               input_data=input_data, timeout=timeout, cancelled=is_cancelled)
        if outcome != 'succeeded':
            try:
                with private_log(operation / 'failed-command.log', exclusive=True) as failed:
                    failed.write(log.tail)
            except FileExistsError:
                pass
    if outcome == 'cancelled':
        raise InterruptedError('Setup cancellation requested; private diagnostics retained')
    if outcome == 'timed_out':
        raise TimeoutError('Setup command timed out; inspect private diagnostics before retrying')
    if outcome == 'failed':
        raise RuntimeError(f'Setup command failed (exit {return_code}); root-only failed-command.log contains diagnostics')
    if outcome != 'succeeded':
        raise RuntimeError('Setup command could not start or capture output; inspect private diagnostics before retrying')


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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward internal service authentication to another listener or origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Reject all redirects, including loopback ones."""
        return
