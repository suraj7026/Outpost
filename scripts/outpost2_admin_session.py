"""Finite, macOS-only Outpost2 sudo session; no installation policy lives here.

Public API: run_python(bytes, payload=b'', seconds=180, label='diagnose') returns
{'exitCode': int, 'stdout': bytes, 'stderr': bytes}; status() returns metadata;
stop() requests shutdown. CLI: serve | status | stop (no credential arguments).
Wire protocol: one 4-byte big-endian length + bounded UTF-8 JSON per connection.

The current UID/private Unix socket is the authorization boundary. Callers may
submit user-authorized, repo-controlled *root* Python jobs, not sandboxed code.
A source hash authenticates framing, not a job's safety or provenance. There is
no credential getter, host override, journal mutation, automatic job or retry.
Exact-credential output suppression is defense in depth, not protection against
malicious authorized code, encoding, or other processes running as this UID.

Mutable credential/frame/output buffers are wiped best-effort. Python strings,
library/OS copies, swap and remote sudo memory cannot be guaranteed wiped.
status.json is metadata, not proof of liveness after a crash. A timeout or lost
connection means UNKNOWN remote outcome: inspect before explicitly retrying.
Sudo must consume a password line; a NOPASSWD policy causes the bootstrap to
reject the shifted frame, not silently execute it. This broker changes no policy.

Foreground Python jobs run under fixed /usr/bin/timeout: TERM after at most the
requested seconds, then KILL after five more seconds. At dispatch, the TERM
allowance is also capped by remaining session lifetime minus that KILL grace;
less than one second of allowance refuses the job. The local IO/child deadline
remains unchanged. The remote duration starts when timeout starts, not when SSH
starts: transport/auth startup and cancellation do not imply instant remote stop.
Trusted same-UID root jobs can detach or defeat this mechanism; it is no sandbox.
Intentionally launched systemd installation jobs need separate status/recovery,
not blanket killing of unrelated services or processes. No automatic retry.
The parent's unprivileged preflight checks the key channel and timeout binary;
this broker adds no remote preflight before the human's entry.
"""
from __future__ import annotations


import base64
import binascii
import ctypes
import errno
import fcntl
import getpass
import hashlib
import hmac
import io
import json
import math
import os
import queue
import re
import resource
import selectors
import shlex
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import threading
import time
import warnings
from contextlib import contextmanager
from pathlib import Path

REPO = Path('/Users/sudarshanrajagopalan/Developer/Outpost')
SESSION = REPO / '.outpost/admin-session'
SOCKET = SESSION / 'socket'
KEY = Path('/Users/sudarshanrajagopalan/.ssh/surajhomeserver2')
PIN = Path('/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop/server-setup/be06c19e-6305-4621-9aa9-8bcce9baf7da.known_hosts')
ALIAS = 'outpost-setup-be06c19e-6305-4621-9aa9-8bcce9baf7da'
FINGERPRINT = 'SHA256:nsTF3++XntFP3pfnvBeVVGsUsSMqgsNazw6lI+nA3UI'
BOOTSTRAP = REPO / 'desktop/src-tauri/src/setup_restart_bootstrap.py'
BOOTSTRAP_SHA256 = '11a88641f12ef19dc618facb9e4d7058b35769b83c775a8d6ee1a87c46965392'
TTL = 2 * 60 * 60
SOCKET_TIMEOUT = 10
MAX_BLOB = 1024 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
MAX_MESSAGE = 3 * 1024 * 1024
MAX_PASSWORD = 1024
LABEL = re.compile(r'[A-Za-z0-9_.-]{1,64}\Z', re.ASCII)
STATES = {'waiting-for-authorization', 'ready', 'busy', 'closed'}
ERRORS = {
    'refused', 'unsafe-path', 'already-running', 'active-socket', 'pin-mismatch',
    'bootstrap-mismatch', 'invalid-request', 'wrong-peer', 'not-ready', 'busy',
    'authentication-failed', 'terminal-unavailable', 'expired', 'closed',
    'unknown-outcome-timeout', 'unknown-outcome-output-limit',
    'unknown-outcome-transport', 'credential-in-output', 'unavailable',
}


class AdminSessionError(Exception):
    """Static, credential-free failure; never includes an underlying exception."""

    def __init__(self, code: str = 'refused') -> None:
        self.code = code if type(code) is str and code in ERRORS else 'refused'
        super().__init__(self.code)


class _Closed(BaseException):
    """Unwind even a blocked password read or an in-progress child on shutdown."""


def _wipe(buffer: bytearray) -> None:
    """Overwrite a mutable buffer without making another copy of its contents."""
    buffer[:] = b'\0' * len(buffer)
    buffer.clear()


def _identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def _safe_dir(info: os.stat_result, private: bool = False) -> None:
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o022
            or (private and (info.st_uid != os.getuid()
                             or stat.S_IMODE(info.st_mode) != 0o700))):
        raise AdminSessionError('unsafe-path')


def _safe_file(info: os.stat_result, private: bool = False) -> None:
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o022
            or (private and stat.S_IMODE(info.st_mode) != 0o600)):
        raise AdminSessionError('unsafe-path')


class _Directory:
    """Hold and recheck a no-follow descriptor chain rooted at /, not cwd."""

    def __init__(self, path: Path, create: bool = False) -> None:
        self.path = path
        self.chain: list[tuple[int, str, int]] = []
        self.fds: list[int] = []
        try:
            if not path.is_absolute() or '..' in path.parts:
                raise AdminSessionError('unsafe-path')
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            fd = os.open('/', flags)
            self.fds.append(fd)
            _safe_dir(os.fstat(fd))
            current = Path('/')
            for name in path.parts[1:]:
                current /= name
                if create and current in (REPO / '.outpost', SESSION):
                    try:
                        os.mkdir(name, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(name, flags, dir_fd=fd)
                self.fds.append(child)
                _safe_dir(os.fstat(child), current == SESSION)
                if current in (REPO, REPO / '.outpost') and os.fstat(child).st_uid != os.getuid():
                    raise AdminSessionError('unsafe-path')
                self.chain.append((fd, name, child))
                fd = child
            self.fd = fd
            self.recheck()
        except BaseException:
            self.close()
            raise

    def recheck(self) -> None:
        """Detect replaced ancestors as well as permission/owner changes."""
        _safe_dir(os.fstat(self.fds[0]))
        current = Path('/')
        for parent, name, child in self.chain:
            current /= name
            linked = os.stat(name, dir_fd=parent, follow_symlinks=False)
            opened = os.fstat(child)
            _safe_dir(linked, current == SESSION)
            if _identity(linked) != _identity(opened):
                raise AdminSessionError('unsafe-path')
            if current in (REPO, REPO / '.outpost') and linked.st_uid != os.getuid():
                raise AdminSessionError('unsafe-path')

    def regular(self, name: str, *, create: bool = False, private: bool = False) -> int:
        """Open without truncation; reject special files, links and unsafe modes."""
        self.recheck()
        flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        flags |= (os.O_RDWR | os.O_CREAT) if create else os.O_RDONLY
        fd = os.open(name, flags, 0o600, dir_fd=self.fd)
        try:
            self.check_file(name, fd, private=private)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def check_file(self, name: str, fd: int, *, private: bool = False) -> None:
        self.recheck()
        opened = os.fstat(fd)
        linked = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        _safe_file(opened, private)
        _safe_file(linked, private)
        if _identity(opened) != _identity(linked):
            raise AdminSessionError('unsafe-path')

    def close(self) -> None:
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()

    def __enter__(self) -> _Directory:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()


def _trusted_file(path: Path, limit: int, *, private: bool = False) -> bytes:
    """Read bounded public trust data; limit=0 checks key metadata, not key bytes."""
    with _Directory(path.parent) as directory:
        fd = directory.regular(path.name, private=private)
        try:
            before = os.fstat(fd)
            data = os.read(fd, limit + 1) if limit else b''
            after = os.fstat(fd)
            directory.check_file(path.name, fd, private=private)
            if (len(data) > limit or before != after
                    or (limit and len(data) != after.st_size)):
                raise AdminSessionError('unsafe-path')
            return data
        finally:
            os.close(fd)


def _verify_pin(data: bytes) -> None:
    """Require one exact alias and the specified SSH wire-key fingerprint."""
    try:
        lines = [line.split() for line in data.splitlines()
                 if line.strip() and not line.lstrip().startswith(b'#')]
        if len(lines) != 1 or len(lines[0]) != 3:
            raise ValueError
        alias, kind, encoded = lines[0]
        wire = base64.b64decode(encoded, validate=True)
        if len(wire) < 4:
            raise ValueError
        size = struct.unpack('!I', wire[:4])[0]
        fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(wire).digest()).decode('ascii').rstrip('=')
        if (alias != ALIAS.encode('ascii') or wire[4:4 + size] != kind
                or kind not in (b'ssh-ed25519', b'ssh-rsa', b'ecdsa-sha2-nistp256',
                                b'ecdsa-sha2-nistp384', b'ecdsa-sha2-nistp521')
                or base64.b64encode(wire) != encoded
                or not hmac.compare_digest(fingerprint, FINGERPRINT)):
            raise ValueError
    except (ValueError, binascii.Error, UnicodeError):
        raise AdminSessionError('pin-mismatch') from None


def _trust() -> str:
    """Revalidate all fixed trust inputs immediately before every SSH child."""
    _verify_pin(_trusted_file(PIN, 16384))
    _trusted_file(KEY, 0, private=True)
    loader = _trusted_file(BOOTSTRAP, 16384)
    if hashlib.sha256(loader).hexdigest() != BOOTSTRAP_SHA256:
        raise AdminSessionError('bootstrap-mismatch')
    return loader.decode('utf-8')


def _ssh_argv(remote: list[str]) -> list[str]:
    """No user config, agents, forwarding, multiplexing or password SSH auth."""
    options = [
        'StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes',
        'IdentityAgent=none', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no',
        'PreferredAuthentications=publickey', 'GlobalKnownHostsFile=/dev/null',
        'UserKnownHostsFile="' + str(PIN) + '"', 'HostKeyAlias=' + ALIAS,
        'UpdateHostKeys=no', 'VerifyHostKeyDNS=no', 'CheckHostIP=no',
        'CanonicalizeHostname=no', 'ClearAllForwardings=yes', 'ForwardAgent=no',
        'ForwardX11=no', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no',
        'PermitLocalCommand=no', 'ProxyCommand=none', 'ProxyJump=none',
        'ConnectionAttempts=1', 'ConnectTimeout=10', 'ServerAliveInterval=5',
        'ServerAliveCountMax=2', 'LogLevel=ERROR', 'RequestTTY=no',
    ]
    argv = ['/usr/bin/ssh', '-F', '/dev/null', '-T', '-p', '22', '-i', str(KEY)]
    for option in options:
        argv.extend(('-o', option))
    return argv + ['surajadmin2@surajhomeserver2', shlex.join(remote)]


def _kill_child(child: subprocess.Popen) -> None:
    """Only signal our unreaped, start_new_session SSH child/process group."""
    if child.returncode is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=2)


def _capture(argv: list[str], frame: bytearray, deadline: float) -> tuple[int, bytearray, bytearray]:
    """Concurrent bounded pipe IO, with deadline and cleanup on every exit path."""
    child = None
    output, error = bytearray(), bytearray()
    complete = False
    view = memoryview(frame)
    try:
        if time.monotonic() >= deadline:
            raise AdminSessionError('unknown-outcome-timeout')
        child = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0, close_fds=True, start_new_session=True,
            env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C',
                 'HOME': '/Users/sudarshanrajagopalan'},
        )
        if child.stdin is None or child.stdout is None or child.stderr is None:
            raise AdminSessionError('unknown-outcome-transport')
        streams = {stream.fileno(): stream for stream in (child.stdin, child.stdout, child.stderr)}
        with selectors.DefaultSelector() as selector:
            for stream, event, buffer in ((child.stdin, selectors.EVENT_WRITE, None),
                                          (child.stdout, selectors.EVENT_READ, output),
                                          (child.stderr, selectors.EVENT_READ, error)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, event, buffer)
            offset = 0
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AdminSessionError('unknown-outcome-timeout')
                for key, event in selector.select(min(remaining, 0.2)):
                    stream = streams[key.fd]
                    if event & selectors.EVENT_WRITE:
                        try:
                            offset += os.write(key.fd, view[offset:offset + 65536])
                        except BlockingIOError:
                            continue
                        except BrokenPipeError:
                            offset = len(frame)
                        if offset == len(frame):
                            selector.unregister(stream)
                            stream.close()
                    else:
                        try:
                            chunk = os.read(key.fd, 65536)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(stream)
                            stream.close()
                        elif len(output) + len(error) + len(chunk) > MAX_OUTPUT:
                            raise AdminSessionError('unknown-outcome-output-limit')
                        else:
                            key.data.extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdminSessionError('unknown-outcome-timeout')
            try:
                code = child.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                raise AdminSessionError('unknown-outcome-timeout') from None
        complete = True
        return code, output, error
    except OSError:
        raise AdminSessionError('unknown-outcome-transport') from None
    finally:
        view.release()
        _wipe(frame)
        try:
            if child is not None:
                _kill_child(child)
        finally:
            if child is not None:
                for stream in (child.stdin, child.stdout, child.stderr):
                    if stream is not None:
                        stream.close()
            if not complete:
                _wipe(output)
                _wipe(error)


def _remote(password: bytearray, source: bytes | None, payload: bytes,
            seconds: int, expiry: float) -> dict:
    """Send password only on stdin; source=None is the single read-only auth check."""
    loader = _trust()
    now = time.monotonic()
    deadline = min(expiry, now + seconds)
    remote = ['/usr/bin/sudo', '-k', '-S', '-p', '', '--']
    if source is None:
        remote += ['/usr/bin/id', '-u']
    else:
        remote_seconds = min(seconds, math.floor(expiry - now - 5))
        if remote_seconds < 1:
            raise AdminSessionError('expired')
        remote += ['/usr/bin/timeout', '--signal=TERM', '--kill-after=5', str(remote_seconds),
                   '/usr/bin/python3', '-I', '-B', '-S', '-c', loader,
                   str(len(source)), hashlib.sha256(source).hexdigest()]
    frame = bytearray(password)
    output, error = bytearray(), bytearray()
    try:
        frame.extend(b'\n')
        if source is not None:
            frame.extend(source)
            frame.extend(payload)
        code, output, error = _capture(_ssh_argv(remote), frame, deadline)
        if source is None:
            if code != 0 or output.strip() != b'0':
                raise AdminSessionError('authentication-failed')
            return {}
        # GNU timeout's deadline status and SIGKILL/SIGTERM exits are inconclusive,
        # even if a trusted job deliberately returned the same numeric exit code.
        if code in (124, 137, 143):
            raise AdminSessionError('unknown-outcome-timeout')
        if password and (password in output or password in error):
            raise AdminSessionError('credential-in-output')
        return {'exitCode': code, 'stdout': base64.b64encode(output).decode('ascii'),
                'stderr': base64.b64encode(error).decode('ascii')}
    finally:
        _wipe(frame)
        _wipe(output)
        _wipe(error)


def _read_password() -> bytearray:
    """One getpass entry, real controlling TTY only; no echo-on fallback."""
    password = bytearray()
    fd = None
    tty = None
    saved = None
    previous_stdin = sys.stdin
    success = False
    try:
        fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC | os.O_NOFOLLOW)
        if not os.isatty(fd) or not stat.S_ISCHR(os.fstat(fd).st_mode):
            raise AdminSessionError('terminal-unavailable')
        saved = termios.tcgetattr(fd)
        hidden = saved[:]
        hidden[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(fd, termios.TCSAFLUSH, hidden)
        if termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ECHONL):
            raise AdminSessionError('terminal-unavailable')
        tty = io.TextIOWrapper(io.FileIO(fd, 'w+'), encoding='utf-8', line_buffering=True)
        sys.stdin = tty  # Even getpass's fd fallback can only refer to this TTY.
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            text = getpass.getpass(
                'SERVER sudo password (typing hidden; leave this Terminal open): ', stream=tty)
        try:
            password.extend(text.encode('utf-8'))
        finally:
            del text
        if not 1 <= len(password) <= MAX_PASSWORD or any(c in password for c in (0, 10, 13)):
            raise AdminSessionError('authentication-failed')
        success = True
        return password
    except (OSError, termios.error, getpass.GetPassWarning, EOFError, UnicodeError):
        raise AdminSessionError('terminal-unavailable') from None
    finally:
        sys.stdin = previous_stdin
        try:
            try:
                if saved is not None and fd is not None:
                    termios.tcsetattr(fd, termios.TCSAFLUSH, saved)
            finally:
                if tty is not None:
                    tty.close()
                elif fd is not None:
                    os.close(fd)
        except BaseException:
            _wipe(password)
            raise AdminSessionError('terminal-unavailable') from None
        if not success:
            _wipe(password)


def _peer_uid(connection: socket.socket) -> int:
    """Use macOS libc getpeereid, never Linux SO_PEERCRED or a claimed JSON UID."""
    if sys.platform != 'darwin':
        raise AdminSessionError('wrong-peer')
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    getpeereid = libc.getpeereid
    getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
    getpeereid.restype = ctypes.c_int
    uid, gid = ctypes.c_uint(), ctypes.c_uint()
    if getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
        raise AdminSessionError('wrong-peer')
    return uid.value


def _check_peer(connection: socket.socket) -> None:
    if _peer_uid(connection) != os.getuid():
        raise AdminSessionError('wrong-peer')


def _pairs(items: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            raise AdminSessionError('invalid-request')
        result[key] = value
    return result


def _json(data: bytes) -> dict:
    def reject_constant(unused: str) -> None:
        raise AdminSessionError('invalid-request')
    try:
        value = json.loads(data, object_pairs_hook=_pairs,
                           parse_constant=reject_constant)
        if type(value) is not dict:
            raise ValueError
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise AdminSessionError('invalid-request') from None


def _encode(value: dict) -> bytes:
    data = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')
    if len(data) > MAX_MESSAGE:
        raise AdminSessionError('invalid-request')
    return data


def _receive(connection: socket.socket, deadline: float) -> dict:
    def exact(size: int) -> bytes:
        result = bytearray()
        while len(result) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdminSessionError('invalid-request')
            connection.settimeout(remaining)
            chunk = connection.recv(size - len(result))
            if not chunk:
                raise AdminSessionError('invalid-request')
            result.extend(chunk)
        return bytes(result)
    size = struct.unpack('!I', exact(4))[0]
    if not 0 < size <= MAX_MESSAGE:
        raise AdminSessionError('invalid-request')
    return _json(exact(size))


def _send(connection: socket.socket, value: dict, password: bytearray | None = None) -> None:
    data = _encode(value)
    if password and password in data:
        raise AdminSessionError('credential-in-output')
    connection.settimeout(SOCKET_TIMEOUT)
    connection.sendall(struct.pack('!I', len(data)) + data)


def _blob(value: object, *, nonempty: bool = False) -> bytes:
    try:
        if type(value) is not str or len(value) > 4 * ((MAX_BLOB + 2) // 3):
            raise ValueError
        result = base64.b64decode(value, validate=True)
        if (len(result) > MAX_BLOB or (nonempty and not result)
                or base64.b64encode(result).decode('ascii') != value):
            raise ValueError
        return result
    except (ValueError, binascii.Error, UnicodeError):
        raise AdminSessionError('invalid-request') from None


def _request(value: dict) -> dict:
    if type(value) is not dict or type(value.get('op')) is not str:
        raise AdminSessionError('invalid-request')
    if value['op'] in ('status', 'stop') and set(value) == {'op'}:
        return value
    if (set(value) != {'op', 'source', 'payload', 'seconds', 'label'}
            or value['op'] != 'run_python' or type(value['seconds']) is not int
            or not 1 <= value['seconds'] <= 900 or type(value['label']) is not str
            or not LABEL.fullmatch(value['label'])):
        raise AdminSessionError('invalid-request')
    return {**value, 'source': _blob(value['source'], nonempty=True),
            'payload': _blob(value['payload'])}


def _metadata(value: dict) -> dict:
    if (set(value) != {'pid', 'state', 'label', 'hash', 'expiry'}
            or type(value['pid']) is not int or value['pid'] <= 0
            or type(value['state']) is not str or value['state'] not in STATES
            or type(value['label']) is not str
            or (value['label'] != '' and not LABEL.fullmatch(value['label']))
            or type(value['hash']) is not str
            or (value['hash'] != '' and not re.fullmatch('[0-9a-f]{64}', value['hash']))
            or type(value['expiry']) not in (int, float)
            or not 0 < value['expiry'] < 1e12 or not math.isfinite(value['expiry'])):
        raise AdminSessionError('invalid-request')
    return value


def _socket_info(directory: _Directory) -> os.stat_result:
    directory.recheck()
    info = os.stat('socket', dir_fd=directory.fd, follow_symlinks=False)
    if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
        raise AdminSessionError('unsafe-path')
    return info


@contextmanager
def _status_lock(fd: int, operation: int):
    """Allow brief concurrent polls, but never wait indefinitely on a file lock."""
    deadline = time.monotonic() + SOCKET_TIMEOUT
    while True:
        try:
            fcntl.flock(fd, operation | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise AdminSessionError('unavailable') from None
            time.sleep(0.005)
    try:
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)


class _Broker:
    """One main-thread credential/job owner and one bounded local control thread."""

    def __init__(self) -> None:
        self.password = bytearray()
        self.deadline = time.monotonic() + TTL
        self.meta = {'pid': os.getpid(), 'state': 'waiting-for-authorization',
                     'label': '', 'hash': '', 'expiry': time.time() + TTL}
        self.directory: _Directory | None = None
        self.lock_fd: int | None = None
        self.status_fd: int | None = None
        self.listener: socket.socket | None = None
        self.socket_identity: tuple[int, int] | None = None
        self.control_connection: socket.socket | None = None
        self.thread: threading.Thread | None = None
        self.guard = threading.RLock()
        self.closing = threading.Event()
        self.jobs: queue.Queue[tuple[socket.socket, dict]] = queue.Queue(maxsize=1)

    def open(self) -> None:
        """Lock and bind before prompting. Never remove an active or alien socket."""
        if len(os.fsencode(SOCKET)) >= 104:
            raise AdminSessionError('unsafe-path')
        self.directory = _Directory(SESSION, create=True)
        self.lock_fd = self.directory.regular('lock', create=True, private=True)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.lock_fd)
            self.lock_fd = None
            raise AdminSessionError('already-running') from None
        self.directory.check_file('lock', self.lock_fd, private=True)
        try:
            old = _socket_info(self.directory)
        except FileNotFoundError:
            old = None
        if old is not None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(SOCKET_TIMEOUT)
                outcome = probe.connect_ex(str(SOCKET))
            if outcome != errno.ECONNREFUSED:
                raise AdminSessionError('active-socket')
            if _identity(_socket_info(self.directory)) != _identity(old):
                raise AdminSessionError('unsafe-path')
            os.unlink('socket', dir_fd=self.directory.fd)
        self.status_fd = self.directory.regular('status.json', create=True, private=True)
        self.directory.recheck()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        previous = os.umask(0o177)
        try:
            self.listener.bind(str(SOCKET))
        finally:
            os.umask(previous)
        self.socket_identity = _identity(_socket_info(self.directory))
        self.listener.listen(8)
        self.listener.settimeout(0.2)
        self.update('waiting-for-authorization')

    def update(self, state: str, label: str = '', digest: str = '') -> None:
        """Only five metadata fields persist; flock makes file polling consistent."""
        with self.guard:
            directory, lock_fd, status_fd = self.directory, self.lock_fd, self.status_fd
            if directory is None or lock_fd is None or status_fd is None:
                raise AdminSessionError('closed')
            value = {**self.meta, 'state': state, 'label': label, 'hash': digest}
            data = _encode(_metadata(value))
            if self.password and self.password in data:
                raise AdminSessionError('credential-in-output')
            directory.check_file('lock', lock_fd, private=True)
            directory.check_file('status.json', status_fd, private=True)
            with _status_lock(status_fd, fcntl.LOCK_EX):
                directory.check_file('status.json', status_fd, private=True)
                os.lseek(status_fd, 0, os.SEEK_SET)
                offset = 0
                while offset < len(data):
                    offset += os.write(status_fd, data[offset:])
                os.ftruncate(status_fd, len(data))
                self.meta = value

    def interrupt(self) -> None:
        """Signal this broker only, including when main is blocked in getpass."""
        self.closing.set()
        os.kill(os.getpid(), signal.SIGTERM)

    def accept_one(self, connection: socket.socket) -> bool:
        """Transfer a single job to main; controls remain responsive during work."""
        _check_peer(connection)
        request = _request(_receive(connection, min(self.deadline, time.monotonic() + SOCKET_TIMEOUT)))
        if self.closing.is_set():
            raise AdminSessionError('closed')
        if request['op'] == 'status':
            with self.guard:
                _send(connection, {'ok': True, 'result': self.meta.copy()}, self.password)
        elif request['op'] == 'stop':
            try:
                _send(connection, {'ok': True, 'result': {'stopping': True}}, self.password)
            finally:
                self.interrupt()
        else:
            with self.guard:
                if self.meta['state'] != 'ready':
                    raise AdminSessionError('busy' if self.meta['state'] == 'busy' else 'not-ready')
                self.update('busy', request['label'], hashlib.sha256(request['source']).hexdigest())
                self.jobs.put_nowait((connection, request))
            return True
        return False

    def controls(self) -> None:
        """No unbounded threads/queues; malformed callers receive static failures."""
        try:
            listener = self.listener
            if listener is None:
                raise AdminSessionError('closed')
            while not self.closing.is_set():
                try:
                    connection, _ = listener.accept()
                except TimeoutError:
                    continue
                transferred = False
                with self.guard:
                    self.control_connection = connection
                try:
                    transferred = self.accept_one(connection)
                except (AdminSessionError, OSError, ValueError):
                    try:
                        _send(connection, {'ok': False, 'error': 'refused'}, self.password)
                    except (AdminSessionError, OSError):
                        pass
                finally:
                    with self.guard:
                        self.control_connection = None
                    if not transferred:
                        connection.close()
        except BaseException:
            if not self.closing.is_set():
                self.interrupt()

    def run(self) -> None:
        """Collect once, verify once, then execute one explicitly submitted job at a time."""
        self.open()
        self.thread = threading.Thread(target=self.controls, name='outpost-local-control', daemon=True)
        self.thread.start()
        if self.closing.is_set() or time.monotonic() >= self.deadline:
            raise _Closed()
        self.password = _read_password()
        if self.closing.is_set() or time.monotonic() >= self.deadline:
            raise _Closed()
        _remote(self.password, None, b'', 30, self.deadline)
        print('Authorization accepted. Leave this window open. Ctrl+C closes it. '
              'Expires 2h after session start.', flush=True)
        self.update('ready')
        while not self.closing.is_set():
            if time.monotonic() >= self.deadline:
                raise _Closed()
            try:
                connection, request = self.jobs.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                result = _remote(self.password, request['source'], request['payload'],
                                 request['seconds'], self.deadline)
                _send(connection, {'ok': True, 'result': result}, self.password)
            except AdminSessionError as error:
                try:
                    _send(connection, {'ok': False, 'error': error.code}, self.password)
                except (AdminSessionError, OSError):
                    pass
                raise
            finally:
                connection.close()
                del request
                result = None
            self.update('ready')

    def close(self) -> None:
        """Stop controls, publish closed metadata, unlink only the socket we bound."""
        self.closing.set()
        try:
            if self.listener is not None:
                self.listener.close()
            with self.guard:
                if self.control_connection is not None:
                    try:
                        self.control_connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
            if self.thread is not None:
                self.thread.join(timeout=SOCKET_TIMEOUT + 1)
            while not self.jobs.empty():
                connection, request = self.jobs.get_nowait()
                connection.close()
                del request
            if self.status_fd is not None and self.lock_fd is not None:
                try:
                    self.update('closed')
                except (AdminSessionError, OSError):
                    pass
            if self.socket_identity is not None and self.directory is not None:
                try:
                    if _identity(_socket_info(self.directory)) == self.socket_identity:
                        os.unlink('socket', dir_fd=self.directory.fd)
                except (AdminSessionError, OSError):
                    pass
        finally:
            _wipe(self.password)
            for fd in (self.status_fd, self.lock_fd):
                if fd is not None:
                    os.close(fd)
            self.status_fd = self.lock_fd = None
            self.socket_identity = None
            if self.directory is not None:
                self.directory.close()
                self.directory = None


def _client(request: dict, seconds: int = SOCKET_TIMEOUT) -> dict:
    _request(request)
    try:
        with _Directory(SESSION) as directory, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            before = _socket_info(directory)
            connection.settimeout(SOCKET_TIMEOUT)
            connection.connect(str(SOCKET))
            _check_peer(connection)
            if _identity(_socket_info(directory)) != _identity(before):
                raise AdminSessionError('unsafe-path')
            _send(connection, request)
            response = _receive(connection, time.monotonic() + seconds + SOCKET_TIMEOUT)
        if set(response) == {'ok', 'error'} and response['ok'] is False:
            raise AdminSessionError(response['error'] if type(response['error']) is str else 'refused')
        if set(response) != {'ok', 'result'} or response['ok'] is not True or type(response['result']) is not dict:
            raise AdminSessionError('refused')
        return response['result']
    except AdminSessionError as error:
        if request['op'] == 'run_python' and error.code == 'invalid-request':
            raise AdminSessionError('unknown-outcome-transport') from None
        raise
    except (OSError, ValueError):
        raise AdminSessionError('unknown-outcome-transport' if request['op'] == 'run_python' else 'unavailable') from None


def run_python(source: bytes, payload: bytes = b'', seconds: int = 180, label: str = 'diagnose') -> dict:
    """Run one authorized job. Failure/lost response never causes an automatic retry."""
    if type(source) is not bytes or type(payload) is not bytes or len(source) > MAX_BLOB or len(payload) > MAX_BLOB:
        raise AdminSessionError('invalid-request')
    request = {'op': 'run_python', 'source': base64.b64encode(source).decode('ascii'),
               'payload': base64.b64encode(payload).decode('ascii'), 'seconds': seconds, 'label': label}
    result = _client(request, seconds)
    if set(result) != {'exitCode', 'stdout', 'stderr'} or type(result['exitCode']) is not int:
        raise AdminSessionError('refused')
    try:
        output = base64.b64decode(result['stdout'], validate=True)
        error = base64.b64decode(result['stderr'], validate=True)
        if len(output) + len(error) > MAX_OUTPUT:
            raise ValueError
    except (ValueError, TypeError, binascii.Error):
        raise AdminSessionError('refused') from None
    return {'exitCode': result['exitCode'], 'stdout': output, 'stderr': error}


def status() -> dict:
    """Read locked metadata even while the human prompt is open; never returns output."""
    try:
        with _Directory(SESSION) as directory:
            fd = directory.regular('status.json', private=True)
            try:
                with _status_lock(fd, fcntl.LOCK_SH):
                    data = os.read(fd, 4097)
                    directory.check_file('status.json', fd, private=True)
                    if len(data) > 4096:
                        raise AdminSessionError('refused')
                    return _metadata(_json(data))
            finally:
                os.close(fd)
    except OSError:
        raise AdminSessionError('unavailable') from None


def stop() -> dict:
    """Request shutdown over the UID-authenticated Unix socket, including while busy."""
    result = _client({'op': 'stop'})
    if result != {'stopping': True}:
        raise AdminSessionError('refused')
    return result


@contextmanager
def _lifetime():
    """Hard absolute alarm also interrupts getpass, subprocesses and socket writes."""
    def closed(signum: int, frame: object) -> None:
        raise _Closed()
    old_handlers = {}
    started = time.monotonic()
    old_timer = signal.getitimer(signal.ITIMER_REAL)
    try:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
            old_handlers[signum] = signal.signal(signum, closed)
        signal.setitimer(signal.ITIMER_REAL, TTL)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)
        if old_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.001, old_timer[0] - (time.monotonic() - started)), old_timer[1])


def serve() -> None:
    """Only a reviewed launcher/human should call this; importing does nothing."""
    if sys.platform != 'darwin' or os.getuid() != os.geteuid() or os.geteuid() == 0:
        raise AdminSessionError('refused')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Fail before prompting if libc peer authentication is unavailable.
    probe, other = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    with probe, other:
        _check_peer(probe)
    broker = _Broker()
    previous_umask = os.umask(0o077)
    try:
        with _lifetime():
            try:
                broker.run()
            except _Closed:
                pass
            finally:
                broker.close()
    except AdminSessionError:
        raise
    except BaseException:
        raise AdminSessionError('refused') from None
    finally:
        os.umask(previous_umask)


def main(argv: list[str] | None = None) -> int:
    """No argparse error echo: arbitrary unexpected arguments are never printed."""
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1 or arguments[0] not in ('serve', 'status', 'stop'):
        print('Usage: outpost2_admin_session.py serve|status|stop', file=sys.stderr)
        return 2
    try:
        if arguments[0] == 'serve':
            serve()
        else:
            print(json.dumps(status() if arguments[0] == 'status' else stop(), sort_keys=True))
        return 0
    except BaseException:
        print('Admin session unavailable or closed; no verified job outcome. Do not auto-retry.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
