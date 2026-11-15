"""Hermetic tests: python3 -I -B scripts/test_outpost2_admin_session.py -v.

No terminal prompts, SSH, sudo, production/session paths, or actual subprocesses.
Every session/trust fixture is a disposable directory under the repository (the
system temp ancestry can be world-writable and the macOS socket limit is 104).
The real bootstrap is read only to verify its public source hash. Fake processes
use real local pipes/selectors; integration tests use real private AF_UNIX sockets.
All credential-like test data below is a deliberately synthetic sentinel.
"""
from __future__ import annotations

import base64

import hashlib
import importlib.util
import io
import json
import os

import queue
import shlex
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name('outpost2_admin_session.py')
SPEC = importlib.util.spec_from_file_location('outpost2_admin_session', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
ROOT = SCRIPT.resolve().parent.parent
REAL_BOOTSTRAP = ROOT / 'desktop/src-tauri/src/setup_restart_bootstrap.py'
LOADER = REAL_BOOTSTRAP.read_bytes()
SENTINEL = b'unit-test-only-not-an-actual-credential-7xQ'
SOURCE = b'import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n'
PAYLOAD = b'{"fixture":"not an admin operation"}\n'


def wire_request(**changes) -> dict:
    value = {'op': 'run_python', 'source': base64.b64encode(SOURCE).decode(),
             'payload': base64.b64encode(PAYLOAD).decode(), 'seconds': 3, 'label': 'diagnose'}
    value.update(changes)
    return value


class PipeChild:
    """Popen-shaped fixture with real pipes; never starts a process or shell."""

    def __init__(self, *, stdout=b'fixture output', stderr=b'', code=0,
                 stall=False, closed_input=False, wait_stall=False):
        input_read, input_write = os.pipe()
        output_read, output_write = os.pipe()
        error_read, error_write = os.pipe()
        self.stdin = os.fdopen(input_write, 'wb', buffering=0)
        self.stdout = os.fdopen(output_read, 'rb', buffering=0)
        self.stderr = os.fdopen(error_read, 'rb', buffering=0)
        self.pid = 987654321  # Never used with a real signal call.
        self.returncode = None
        self.frame = bytearray()
        self.finished = threading.Event()
        self.release = threading.Event()
        self.signals = []
        self.waits = []
        self.failure = None
        self.code = code
        self.wait_stall = wait_stall

        def worker():
            try:
                with os.fdopen(input_read, 'rb', buffering=0) as incoming:
                    if not closed_input:
                        while True:
                            chunk = incoming.read(65536)
                            if not chunk:
                                break
                            self.frame.extend(chunk)
                with os.fdopen(output_write, 'wb', buffering=0) as out, os.fdopen(error_write, 'wb', buffering=0) as err:
                    if stall:
                        self.release.wait(3)
                    for stream, data in ((out, stdout), (err, stderr)):
                        offset = 0
                        while offset < len(data):
                            offset += stream.write(data[offset:offset + 32768])
            except BrokenPipeError:
                pass
            except BaseException as error:
                self.failure = type(error).__name__
            finally:
                if wait_stall:
                    self.release.wait(3)
                self.finished.set()
        self.thread = threading.Thread(target=worker, daemon=True)
        self.thread.start()

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if not self.finished.wait(timeout):
            assert timeout is not None
            raise subprocess.TimeoutExpired('fixture-child', timeout)
        self.returncode = self.code
        return self.returncode

    def killpg(self, pid, signum):
        if pid != self.pid:
            raise AssertionError('Attempted to signal something other than the fixture child')
        self.signals.append(signum)
        self.release.set()
        for stream in (self.stdin, self.stdout, self.stderr):
            stream.close()

    def close(self):
        self.release.set()
        for stream in (self.stdin, self.stdout, self.stderr):
            stream.close()
        self.thread.join(4)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='.as-', dir=ROOT)))
        self.root.chmod(0o700)
        self.session = self.root / '.outpost/admin-session'
        self.socket_path = self.session / 'socket'
        self.pin = self.root / 'fixture.known_hosts'
        self.key = self.root / 'fixture.key'
        self.bootstrap = self.root / 'bootstrap.py'
        for name, value in (('REPO', self.root), ('SESSION', self.session), ('SOCKET', self.socket_path),
                            ('PIN', self.pin), ('KEY', self.key), ('BOOTSTRAP', self.bootstrap)):
            self.stack.enter_context(patch.object(m, name, value))
        kind = b'ssh-ed25519'
        wire = struct.pack('!I', len(kind)) + kind + struct.pack('!I', 32) + b'x' * 32
        self.pin_data = m.ALIAS.encode() + b' ' + kind + b' ' + base64.b64encode(wire) + b'\n'
        fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(wire).digest()).decode().rstrip('=')
        self.stack.enter_context(patch.object(m, 'FINGERPRINT', fingerprint))
        self.put(self.pin, self.pin_data)
        self.put(self.key, b'not a usable private key; fixture only\n')
        self.put(self.bootstrap, LOADER)
        self.popen = self.stack.enter_context(patch.object(m.subprocess, 'Popen', side_effect=AssertionError('No subprocesses in tests')))
        self.getpass = self.stack.enter_context(patch.object(m.getpass, 'getpass', side_effect=AssertionError('No real prompts in tests')))
        self.stack.enter_context(patch.object(m.os, 'kill', side_effect=AssertionError('No real signals in tests')))
        self.stack.enter_context(patch.object(m.os, 'killpg', side_effect=AssertionError('No real signals in tests')))
        original_open = os.open

        def guarded_open(path, *args, **kwargs):
            if os.fspath(path) == '/dev/tty':
                raise AssertionError('No controlling TTY access in tests')
            return original_open(path, *args, **kwargs)
        self.stack.enter_context(patch.object(m.os, 'open', side_effect=guarded_open))
        if sys.platform != 'darwin':
            self.stack.enter_context(patch.object(m, '_peer_uid', return_value=os.getuid()))

    def put(self, path, content, mode=0o600):
        path.write_bytes(content)
        path.chmod(mode)

    def broker(self, opened=True):
        broker = m._Broker()
        self.addCleanup(broker.close)
        if opened:
            broker.open()
        return broker

    def make_session(self):
        self.session.mkdir(parents=True, mode=0o700)
        self.session.parent.chmod(0o700)
        self.session.chmod(0o700)

    def local_socket(self, listen=False):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(connection.close)
        previous = os.umask(0o177)
        try:
            connection.bind(str(self.socket_path))
        finally:
            os.umask(previous)
        if listen:
            connection.listen(2)
        return connection

    @contextmanager
    def pipe_child(self, **kwargs):
        child = PipeChild(**kwargs)
        with patch.object(m.subprocess, 'Popen', return_value=child) as popen, patch.object(m.os, 'killpg', side_effect=child.killpg):
            try:
                yield child, popen
            finally:
                child.close()
        self.assertFalse(child.thread.is_alive())
        self.assertIsNone(child.failure)

    def wait_for(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail('Fixture did not reach expected state')
            time.sleep(0.005)


class SchemaTests(Fixture):
    def test_valid_request_and_limits(self):
        request = m._request(wire_request())
        self.assertEqual(request['source'], SOURCE)
        self.assertEqual(request['payload'], PAYLOAD)
        self.assertEqual(m._request({'op': 'status'}), {'op': 'status'})
        self.assertEqual(m._request({'op': 'stop'}), {'op': 'stop'})
        maximum = base64.b64encode(b'x' * m.MAX_BLOB).decode()
        self.assertEqual(len(m._request(wire_request(source=maximum, payload=maximum, seconds=900, label='a' * 64))['source']), m.MAX_BLOB)
        self.assertLess(len(m._encode(wire_request(source=maximum, payload=maximum))), m.MAX_MESSAGE)

    def test_exact_schema_no_target_override(self):
        for request in ([], {}, {'op': 'status', 'host': 'elsewhere'}, {'op': 'stop', 'uid': os.getuid()},
                        wire_request(host='elsewhere'), wire_request(user='root'), wire_request(key='/tmp/x'),
                        wire_request(timeout='/bin/sh'), wire_request(program='/tmp/job'), wire_request(killAfter=0),
                        wire_request(op='shell'), wire_request(op=4), {'op': 'get_password'},
                        {key: value for key, value in wire_request().items() if key != 'payload'}):
            with self.subTest(request_type=type(request).__name__), self.assertRaises(m.AdminSessionError):
                m._request(request)

    def test_strict_seconds_and_label(self):
        for seconds in (True, False, 0, -1, 901, 1.0, '1', None):
            with self.subTest(seconds=seconds), self.assertRaises(m.AdminSessionError):
                m._request(wire_request(seconds=seconds))
        for label in ('', 'a' * 65, 'has spaces', 'newline\n', 'nonascii-é', '\0', [], 4):
            with self.subTest(label=label), self.assertRaises(m.AdminSessionError):
                m._request(wire_request(label=label))

    def test_strict_base64_and_sizes(self):
        for source in ('', 'a', '!!!!', 'eA==\n', 'eB==', 'é', None, [],
                       base64.b64encode(b'x' * (m.MAX_BLOB + 1)).decode()):
            with self.subTest(kind=type(source).__name__), self.assertRaises(m.AdminSessionError):
                m._request(wire_request(source=source))
        self.assertEqual(m._request(wire_request(payload=''))['payload'], b'')
        with self.assertRaises(m.AdminSessionError):
            m._request(wire_request(payload=base64.b64encode(b'x' * (m.MAX_BLOB + 1)).decode()))

    def test_json_rejects_duplicates_constants_and_depth(self):
        for data in (b'{"op":"status","op":"stop"}', b'null', b'[]', b'{"seconds":NaN}',
                     b'{"seconds":Infinity}', b'\xff', b'{', b'[' * 2000 + b']' * 2000):
            with self.subTest(size=len(data)), self.assertRaises(m.AdminSessionError):
                m._json(data)

    def test_frame_round_trip_and_oversize_header(self):
        left, right = socket.socketpair()
        with left, right:
            m._send(left, {'op': 'status'})
            self.assertEqual(m._receive(right, time.monotonic() + 1), {'op': 'status'})
        for size in (0, m.MAX_MESSAGE + 1, 2 ** 32 - 1):
            left, right = socket.socketpair()
            with left, right:
                left.sendall(struct.pack('!I', size))
                with self.assertRaises(m.AdminSessionError):
                    m._receive(right, time.monotonic() + 1)

    def test_socket_read_has_absolute_deadline_and_eof(self):
        left, right = socket.socketpair()
        with left, right:
            left.sendall(b'\0')
            start = time.monotonic()
            with self.assertRaises((m.AdminSessionError, TimeoutError)):
                m._receive(right, start + 0.03)
            self.assertLess(time.monotonic() - start, 0.5)
        left, right = socket.socketpair()
        with left, right:
            left.shutdown(socket.SHUT_WR)
            with self.assertRaises(m.AdminSessionError):
                m._receive(right, time.monotonic() + 1)

    def test_public_api_rejects_invalid_input_before_connecting(self):
        with patch.object(m, '_socket_info') as inspect_socket:
            for source in ('text', bytearray(b'x'), b'', b'x' * (m.MAX_BLOB + 1)):
                with self.assertRaises(m.AdminSessionError):
                    m.run_python(source)
            with self.assertRaises(m.AdminSessionError):
                m.run_python(b'x', seconds=True)
            inspect_socket.assert_not_called()

    def test_cli_does_not_echo_unknown_arguments(self):
        output, error = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(error):
            self.assertEqual(m.main(['serve', SENTINEL.decode()]), 2)
        self.assertNotIn(SENTINEL.decode(), output.getvalue() + error.getvalue())
        self.getpass.assert_not_called()
        self.popen.assert_not_called()


class TrustTests(Fixture):
    def test_real_bootstrap_hash(self):
        self.assertEqual(hashlib.sha256(LOADER).hexdigest(), '11a88641f12ef19dc618facb9e4d7058b35769b83c775a8d6ee1a87c46965392')
        self.assertEqual(m._trust(), LOADER.decode())

    def test_pin_mismatch_and_alias_variants(self):
        variants = [self.pin_data.replace(b' ssh-ed25519 ', b' ssh-rsa '), self.pin_data + self.pin_data,
                    self.pin_data.replace(m.ALIAS.encode(), b'*'),
                    self.pin_data.replace(m.ALIAS.encode(), b'other,' + m.ALIAS.encode()),
                    b'@cert-authority ' + self.pin_data, b'garbage',
                    self.pin_data + b'other ssh-ed25519 AAAA\n']
        for data in variants:
            with self.subTest(size=len(data)), self.assertRaises(m.AdminSessionError):
                m._verify_pin(data)
        with patch.object(m, 'FINGERPRINT', 'SHA256:incorrect'):
            with self.assertRaisesRegex(m.AdminSessionError, '^pin-mismatch$'):
                m._verify_pin(self.pin_data)

    def test_trust_tampering_prevents_process(self):
        password = bytearray(SENTINEL)
        self.put(self.pin, b'wrong pin')
        with self.assertRaises(m.AdminSessionError):
            m._remote(password, SOURCE, PAYLOAD, 3, time.monotonic() + 10)
        self.popen.assert_not_called()
        self.put(self.pin, self.pin_data)
        self.put(self.bootstrap, LOADER + b'\n')
        with self.assertRaisesRegex(m.AdminSessionError, '^bootstrap-mismatch$'):
            m._remote(password, SOURCE, PAYLOAD, 3, time.monotonic() + 10)
        self.popen.assert_not_called()

    def test_each_remote_job_rechecks_pin(self):
        with patch.object(m, '_capture', return_value=(0, bytearray(b'ok'), bytearray())) as capture:
            m._remote(bytearray(SENTINEL), SOURCE, PAYLOAD, 3, time.monotonic() + 10)
            self.put(self.pin, b'changed between jobs')
            with self.assertRaises(m.AdminSessionError):
                m._remote(bytearray(SENTINEL), SOURCE, PAYLOAD, 3, time.monotonic() + 10)
        self.assertEqual(capture.call_count, 1)

    def test_trust_files_cannot_be_symlinks_hardlinks_or_public_keys(self):
        self.key.chmod(0o644)
        with self.assertRaises(m.AdminSessionError):
            m._trust()
        self.key.chmod(0o600)
        os.link(self.key, self.root / 'another-key-link')
        with self.assertRaises(m.AdminSessionError):
            m._trust()
        self.pin.unlink()
        self.pin.symlink_to(self.bootstrap)
        with self.assertRaises((m.AdminSessionError, OSError)):
            m._trusted_file(self.pin, 16384)

    def test_remote_argv_is_fixed_and_only_frame_contains_credential(self):
        captured = []
        frame_references = []
        def capture(argv, frame, deadline):
            captured.append((argv, bytes(frame), deadline))
            frame_references.append(frame)
            return 7, bytearray(b'ordinary stdout'), bytearray(b'ordinary stderr')
        password = bytearray(SENTINEL)
        with patch.object(m, '_capture', side_effect=capture):
            result = m._remote(password, SOURCE, PAYLOAD, 3, time.monotonic() + 30)
        argv, frame, _ = captured[0]
        self.assertEqual(frame, SENTINEL + b'\n' + SOURCE + PAYLOAD)
        self.assertEqual(frame_references, [bytearray()])
        self.assertEqual(password, SENTINEL)
        self.assertEqual(result['exitCode'], 7)
        self.assertNotIn(SENTINEL.decode(), repr(argv) + repr(result))
        self.assertEqual(argv[:9], ['/usr/bin/ssh', '-F', '/dev/null', '-T', '-p', '22', '-i', str(self.key), '-o'])
        self.assertEqual(argv[-2], 'surajadmin2@surajhomeserver2')
        remote = shlex.split(argv[-1])
        self.assertEqual(remote[:6], ['/usr/bin/sudo', '-k', '-S', '-p', '', '--'])
        self.assertEqual(remote[6:10], ['/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '3'])
        self.assertEqual(remote[10:16], ['/usr/bin/python3', '-I', '-B', '-S', '-c', LOADER.decode()])
        self.assertEqual(remote[16:], [str(len(SOURCE)), hashlib.sha256(SOURCE).hexdigest()])
        for option in ('StrictHostKeyChecking=yes', 'BatchMode=yes', 'ControlMaster=no', 'ControlPath=none',
                       'ControlPersist=no', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no',
                       'IdentityAgent=none', 'ConnectionAttempts=1', 'ConnectTimeout=10', 'ProxyCommand=none',
                       'ProxyJump=none', 'HostKeyAlias=' + m.ALIAS):
            self.assertIn(option, argv)

    def test_remote_wrapper_contains_only_fixed_argv_and_metadata_not_canaries(self):
        source = SOURCE + b'# SOURCE-CANARY: never an argv string\n'
        payload = b'PAYLOAD-CANARY: stdin only'
        password = bytearray(b'CREDENTIAL-CANARY: synthetic, not an actual password')
        frames = []
        def capture(argv, frame, deadline):
            frames.append(frame)
            self.assertNotIn(b'CANARY', '\0'.join(argv).encode())
            self.assertEqual(shlex.split(argv[-1]), [
                '/usr/bin/sudo', '-k', '-S', '-p', '', '--',
                '/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '3',
                '/usr/bin/python3', '-I', '-B', '-S', '-c', LOADER.decode(),
                str(len(source)), hashlib.sha256(source).hexdigest(),
            ])
            self.assertEqual(frame, password + b'\n' + source + payload)
            return 0, bytearray(b'fixture output'), bytearray()
        with patch.object(m, '_capture', side_effect=capture):
            m._remote(password, source, payload, 3, time.monotonic() + 30)
        self.assertEqual(frames, [bytearray()])
        m._wipe(password)

    def test_remote_timeout_exits_are_unknown_and_buffers_are_wiped(self):
        for code in (124, 137, 143):
            frames = []
            output, error = bytearray(b'partial output'), bytearray(SENTINEL)
            def capture(argv, frame, deadline, *, frames=frames, result=(code, output, error)):
                frames.append(frame)
                return result
            console = io.StringIO()
            with self.subTest(code=code), patch.object(m, '_capture', side_effect=capture) as capture_mock, \
                    redirect_stdout(console), redirect_stderr(console):
                with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-timeout$'):
                    m._remote(bytearray(SENTINEL), SOURCE, PAYLOAD, 3, time.monotonic() + 30)
            self.assertEqual(capture_mock.call_count, 1)
            self.assertEqual(frames, [bytearray()])
            self.assertEqual(output, bytearray())
            self.assertEqual(error, bytearray())
            self.assertEqual(console.getvalue(), '')

    def test_single_readonly_auth_frame_and_static_failure(self):
        observed = []
        def capture(argv, frame, deadline):
            observed.append((argv, bytes(frame)))
            return 1, bytearray(SENTINEL), bytearray(b'raw failure ' + SENTINEL)
        error_stream = io.StringIO()
        with patch.object(m, '_capture', side_effect=capture), redirect_stderr(error_stream):
            with self.assertRaisesRegex(m.AdminSessionError, '^authentication-failed$'):
                m._remote(bytearray(SENTINEL), None, b'', 30, time.monotonic() + 30)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0][1], SENTINEL + b'\n')
        self.assertEqual(shlex.split(observed[0][0][-1]), ['/usr/bin/sudo', '-k', '-S', '-p', '', '--', '/usr/bin/id', '-u'])
        self.assertEqual(error_stream.getvalue(), '')

    def test_auth_accepts_only_root_uid_output(self):
        for code, output in ((0, b'0\n'), (0, b'501\n'), (1, b'0\n'), (0, b'0\nextra')):
            with patch.object(m, '_capture', return_value=(code, bytearray(output), bytearray())):
                if code == 0 and output == b'0\n':
                    self.assertEqual(m._remote(bytearray(SENTINEL), None, b'', 30, time.monotonic() + 30), {})
                else:
                    with self.assertRaises(m.AdminSessionError):
                        m._remote(bytearray(SENTINEL), None, b'', 30, time.monotonic() + 30)

    def test_exact_credential_output_is_refused_and_wiped(self):
        for where in ('stdout', 'stderr'):
            output = bytearray(b'prefix' + SENTINEL + b'suffix') if where == 'stdout' else bytearray(b'ok')
            error = bytearray(SENTINEL) if where == 'stderr' else bytearray()
            with patch.object(m, '_capture', return_value=(0, output, error)):
                with self.assertRaisesRegex(m.AdminSessionError, '^credential-in-output$'):
                    m._remote(bytearray(SENTINEL), SOURCE, PAYLOAD, 3, time.monotonic() + 10)
            self.assertEqual(output, bytearray())
            self.assertEqual(error, bytearray())

    def test_response_json_is_also_checked(self):
        left, right = socket.socketpair()
        with left, right:
            with self.assertRaises(m.AdminSessionError):
                m._send(left, {'label': SENTINEL.decode()}, bytearray(SENTINEL))
            right.settimeout(0.02)
            with self.assertRaises(TimeoutError):
                right.recv(1)


class FilesystemTests(Fixture):
    def test_private_files_metadata_and_cleanup(self):
        broker = self.broker()
        for path, mode in ((self.session, 0o700), (self.session / 'lock', 0o600),
                           (self.session / 'status.json', 0o600), (self.socket_path, 0o600)):
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), mode)
            self.assertEqual(path.lstat().st_uid, os.getuid())
        value = m.status()
        self.assertEqual(set(value), {'pid', 'state', 'label', 'hash', 'expiry'})
        self.assertEqual(value['state'], 'waiting-for-authorization')
        broker.password = bytearray(SENTINEL)
        broker.update('busy', 'diagnose', hashlib.sha256(SOURCE).hexdigest())
        data = (self.session / 'status.json').read_bytes()
        for forbidden in (SENTINEL, SOURCE, PAYLOAD, b'stdout', b'stderr'):
            self.assertNotIn(forbidden, data)
        broker.close()
        self.assertEqual(broker.password, bytearray())
        self.assertFalse(self.socket_path.exists())
        self.assertTrue((self.session / 'lock').is_file())
        self.assertEqual(m.status()['state'], 'closed')
        broker.close()

    def test_duplicate_lock_preserves_original_socket_and_status(self):
        first = self.broker()
        before = self.socket_path.lstat()
        metadata = m.status()
        second = self.broker(opened=False)
        with self.assertRaisesRegex(m.AdminSessionError, '^already-running$'):
            second.open()
        second.close()
        self.assertEqual(m._identity(before), m._identity(self.socket_path.lstat()))
        self.assertEqual(metadata, m.status())
        self.assertIsNotNone(first.listener)

    def test_stale_socket_removed_only_under_lock(self):
        self.make_session()
        self.local_socket().close()
        broker = self.broker()
        self.assertTrue(stat.S_ISSOCK(self.socket_path.lstat().st_mode))
        self.assertIsNotNone(broker.socket_identity)

    def test_active_socket_without_lock_is_not_unlinked(self):
        self.make_session()
        self.local_socket(listen=True)
        before = self.socket_path.lstat()
        broker = self.broker(opened=False)
        with self.assertRaisesRegex(m.AdminSessionError, '^active-socket$'):
            broker.open()
        broker.close()
        self.assertEqual(m._identity(before), m._identity(self.socket_path.lstat()))

    def test_regular_file_in_socket_slot_never_removed(self):
        self.make_session()
        self.put(self.socket_path, b'preserve unrelated file')
        broker = self.broker(opened=False)
        with self.assertRaises(m.AdminSessionError):
            broker.open()
        broker.close()
        self.assertEqual(self.socket_path.read_bytes(), b'preserve unrelated file')

    def test_directory_modes_and_unsafe_ancestry(self):
        self.make_session()
        for path, bad_mode in ((self.session, 0o755), (self.session.parent, 0o777), (self.root, 0o770)):
            original = stat.S_IMODE(path.stat().st_mode)
            path.chmod(bad_mode)
            try:
                with self.assertRaises(m.AdminSessionError):
                    m._Directory(self.session)
            finally:
                path.chmod(original)

    def test_symlink_directory_is_not_followed(self):
        target = self.root / 'other'
        target.mkdir(mode=0o700)
        (self.root / '.outpost').symlink_to(target, target_is_directory=True)
        with self.assertRaises((m.AdminSessionError, OSError)):
            self.broker(opened=False).open()
        self.assertEqual(list(target.iterdir()), [])

    def test_replaced_ancestor_identity_is_rejected(self):
        broker = self.broker()
        moved = self.root / 'old-outpost'
        self.session.parent.rename(moved)
        self.make_session()
        with self.assertRaises(m.AdminSessionError):
            broker.directory.recheck()
        broker.close()
        self.assertTrue((moved / 'admin-session/socket').exists())

    def test_symlink_and_hardlink_lock_and_status_are_rejected(self):
        self.make_session()
        target = self.root / 'keep'
        self.put(target, b'untouched')
        for name in ('lock', 'status.json'):
            for link_type in ('symlink', 'hardlink'):
                path = self.session / name
                if path.exists() or path.is_symlink():
                    path.unlink()
                if link_type == 'symlink':
                    path.symlink_to(target)
                else:
                    os.link(target, path)
                broker = self.broker(opened=False)
                with self.subTest(name=name, link_type=link_type), self.assertRaises((m.AdminSessionError, OSError)):
                    broker.open()
                broker.close()
                self.assertEqual(target.read_bytes(), b'untouched')
                path.unlink()

    def test_insecure_file_modes_refused_not_chmodded(self):
        self.make_session()
        for name in ('lock', 'status.json'):
            path = self.session / name
            self.put(path, b'preserve', 0o644)
            broker = self.broker(opened=False)
            with self.assertRaises(m.AdminSessionError):
                broker.open()
            broker.close()
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(path.read_bytes(), b'preserve')
            path.unlink()

    def test_socket_symlink_hardlink_and_insecure_mode(self):
        self.make_session()
        target = self.root / 'keep'
        self.put(target, b'untouched')
        self.socket_path.symlink_to(target)
        broker = self.broker(opened=False)
        with self.assertRaisesRegex(m.AdminSessionError, '^unsafe-path$'):
            broker.open()
        broker.close()
        self.socket_path.unlink()
        self.local_socket().close()
        self.socket_path.chmod(0o666)
        broker = self.broker(opened=False)
        with self.assertRaisesRegex(m.AdminSessionError, '^unsafe-path$'):
            broker.open()
        broker.close()
        self.socket_path.chmod(0o600)
        os.link(self.socket_path, self.root / 'socket-hardlink')
        broker = self.broker(opened=False)
        with self.assertRaisesRegex(m.AdminSessionError, '^unsafe-path$'):
            broker.open()
        broker.close()
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_close_does_not_unlink_replacement(self):
        broker = self.broker()
        self.socket_path.unlink()
        self.put(self.socket_path, b'replacement')
        broker.close()
        self.assertEqual(self.socket_path.read_bytes(), b'replacement')

    def test_status_label_cannot_persist_credential(self):
        broker = self.broker()
        broker.password = bytearray(SENTINEL)
        with self.assertRaises(m.AdminSessionError):
            broker.update('busy', SENTINEL.decode(), hashlib.sha256(SOURCE).hexdigest())
        self.assertNotIn(SENTINEL, (self.session / 'status.json').read_bytes())

    def test_status_poll_lock_does_not_close_session(self):
        broker = self.broker()
        fd = os.open(self.session / 'status.json', os.O_RDONLY)
        m.fcntl.flock(fd, m.fcntl.LOCK_SH)
        errors = []
        def update():
            try:
                broker.update('ready')
            except BaseException as error:
                errors.append(type(error).__name__)
        thread = threading.Thread(target=update, daemon=True)
        try:
            thread.start()
            time.sleep(0.02)
            self.assertTrue(thread.is_alive())
        finally:
            os.close(fd)
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(m.status()['state'], 'ready')

    def test_status_lock_wait_is_bounded(self):
        with patch.object(m.fcntl, 'flock', side_effect=BlockingIOError), \
                patch.object(m.time, 'monotonic', side_effect=[0, m.SOCKET_TIMEOUT + 1]):
            with self.assertRaisesRegex(m.AdminSessionError, '^unavailable$'):
                with m._status_lock(123, m.fcntl.LOCK_SH):
                    self.fail('Must not acquire a held lock')

    def test_status_reader_rejects_symlink_and_extra_fields(self):
        broker = self.broker()
        broker.close()
        status_path = self.session / 'status.json'
        self.put(status_path, json.dumps({**broker.meta, 'password': 'synthetic forbidden field'}).encode())
        with self.assertRaises(m.AdminSessionError):
            m.status()
        status_path.unlink()
        status_path.symlink_to(self.bootstrap)
        with self.assertRaises(m.AdminSessionError):
            m.status()

    def test_file_owner_validation(self):
        info = list(self.key.stat())
        info[4] = os.getuid() + 1
        with self.assertRaises(m.AdminSessionError):
            m._safe_file(os.stat_result(info), private=True)
        info = list(self.root.stat())
        info[4] = os.getuid() + 1
        with self.assertRaises(m.AdminSessionError):
            m._safe_dir(os.stat_result(info), private=True)


class ProcessTests(Fixture):
    def test_real_pipes_large_input_nonzero_exit_and_safe_environment(self):
        frame = bytearray(SENTINEL + b'\n' + b'z' * (2 * m.MAX_BLOB))
        expected = bytes(frame)
        with self.pipe_child(stdout=b'out', stderr=b'err', code=7) as (child, popen):
            code, output, error = m._capture(['fixture-only-never-executed'], frame, time.monotonic() + 3)
            self.assertEqual((code, output, error), (7, b'out', b'err'))
            self.assertEqual(child.frame, expected)
            self.assertEqual(child.signals, [])
            kwargs = popen.call_args.kwargs
            self.assertTrue(kwargs['close_fds'])
            self.assertTrue(kwargs['start_new_session'])
            self.assertNotIn('shell', kwargs)
            self.assertNotIn(SENTINEL.decode(), repr(popen.call_args))
            self.assertEqual(set(kwargs['env']), {'HOME', 'PATH', 'LC_ALL'})
            self.assertTrue(child.stdin.closed and child.stdout.closed and child.stderr.closed)
        self.assertEqual(frame, bytearray())

    def test_aggregate_output_limit_not_per_stream(self):
        frame = bytearray(SENTINEL + b'\n')
        with self.pipe_child(stdout=b'a' * m.MAX_BLOB, stderr=b'b' * (m.MAX_BLOB + 1)):
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-output-limit$'):
                m._capture(['fixture'], frame, time.monotonic() + 3)
        self.assertEqual(frame, bytearray())

    def test_exact_output_limit_is_allowed(self):
        with self.pipe_child(stdout=b'a' * m.MAX_BLOB, stderr=b'b' * m.MAX_BLOB):
            _, output, error = m._capture(['fixture'], bytearray(b'frame'), time.monotonic() + 3)
        self.assertEqual(len(output) + len(error), m.MAX_OUTPUT)
        self.assertLess(len(m._encode({'ok': True, 'result': {'exitCode': 0,
                             'stdout': base64.b64encode(output).decode(),
                             'stderr': base64.b64encode(error).decode()}})), m.MAX_MESSAGE)

    def test_timeout_kills_only_owned_child_and_wipes_frame(self):
        frame = bytearray(SENTINEL + b'\n')
        with self.pipe_child(stall=True) as (child, popen):
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-timeout$'):
                m._capture(['fixture'], frame, time.monotonic() + 0.03)
            self.assertEqual(child.signals, [signal.SIGTERM])
            self.assertEqual(popen.call_count, 1)
            self.assertIsNotNone(child.returncode)
        self.assertEqual(frame, bytearray())

    def test_timeout_after_pipe_eof_still_reaps_child(self):
        with self.pipe_child(stdout=b'', wait_stall=True) as (child, _):
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-timeout$'):
                m._capture(['fixture'], bytearray(b'frame'), time.monotonic() + 0.03)
            self.assertEqual(child.signals, [signal.SIGTERM])

    def test_expired_deadline_does_not_launch(self):
        frame = bytearray(SENTINEL)
        with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-timeout$'):
            m._capture(['fixture'], frame, time.monotonic() - 1)
        self.popen.assert_not_called()
        self.assertEqual(frame, bytearray())

    def test_launch_error_is_static_and_wipes_frame(self):
        frame = bytearray(SENTINEL)
        with patch.object(m.subprocess, 'Popen', side_effect=OSError(SENTINEL.decode())):
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-transport$'):
                m._capture(['fixture'], frame, time.monotonic() + 1)
        self.assertEqual(frame, bytearray())

    def test_shutdown_exception_reaps_child(self):
        frame = bytearray(SENTINEL)
        with self.pipe_child(stall=True) as (child, _):
            with patch.object(m.selectors.DefaultSelector, 'select', side_effect=m._Closed):
                with self.assertRaises(m._Closed):
                    m._capture(['fixture'], frame, time.monotonic() + 1)
            self.assertEqual(child.signals, [signal.SIGTERM])
        self.assertEqual(frame, bytearray())

    def test_broken_input_pipe_is_bounded(self):
        with self.pipe_child(closed_input=True, stdout=b'', code=1):
            code, _, _ = m._capture(['fixture'], bytearray(b'x' * m.MAX_BLOB), time.monotonic() + 2)
            self.assertEqual(code, 1)

    def test_remote_timeout_is_capped_by_job_and_session_with_kill_grace(self):
        for seconds, expiry, duration, deadline in (
                (900, 123.9, 18, 123.9), (1, 112, 1, 101),
                (900, 1200, 900, 1000), (180, 290, 180, 280),
                (180, 111.2, 6, 111.2), (1, 106, 1, 101)):
            seen = []
            def capture(argv, frame, local_deadline, *, seen=seen):
                remote = shlex.split(argv[-1])
                seen.append((int(remote[9]), local_deadline))
                self.assertEqual(remote[6:9], ['/usr/bin/timeout', '--signal=TERM', '--kill-after=5'])
                return 0, bytearray(), bytearray()
            with self.subTest(seconds=seconds, expiry=expiry), patch.object(m.time, 'monotonic', return_value=100), \
                    patch.object(m, '_capture', side_effect=capture):
                m._remote(bytearray(SENTINEL), SOURCE, PAYLOAD, seconds, expiry)
            self.assertEqual(seen, [(duration, deadline)])
            self.assertLessEqual(duration, seconds)
            self.assertLessEqual(duration + 5, expiry - 100)

    def test_insufficient_remaining_lifetime_refuses_before_starting_remote_job(self):
        for expiry in (99, 100, 104, 105, 105.999):
            with self.subTest(expiry=expiry), patch.object(m.time, 'monotonic', return_value=100), \
                    patch.object(m, '_capture') as capture:
                with self.assertRaisesRegex(m.AdminSessionError, '^expired$'):
                    m._remote(bytearray(SENTINEL), SOURCE, PAYLOAD, 900, expiry)
                capture.assert_not_called()
        self.popen.assert_not_called()

    def test_kill_escalation_does_not_signal_arbitrary_pid(self):
        child = Mock(pid=987654321, returncode=None)
        child.wait.side_effect = [subprocess.TimeoutExpired('fixture', 0.5), -9]
        with patch.object(m.os, 'killpg') as kill:
            m._kill_child(child)
        self.assertEqual([call.args for call in kill.call_args_list],
                         [(child.pid, signal.SIGTERM), (child.pid, signal.SIGKILL)])
        self.assertEqual(child.wait.call_count, 2)


class TerminalAndLifetimeTests(Fixture):
    def test_no_tty_fails_before_getpass(self):
        with patch.object(m.os, 'open', side_effect=OSError('fixture unavailable')):
            with self.assertRaisesRegex(m.AdminSessionError, '^terminal-unavailable$'):
                m._read_password()
        self.getpass.assert_not_called()

    @contextmanager
    def fake_terminal(self, *, attributes=None, set_error=None):
        # No PTY is opened. Use a duplicated regular fixture FD and fake termios.
        fd = os.open(self.key, os.O_RDONLY)
        info = list(os.fstat(fd))
        info[0] = stat.S_IFCHR | 0o600
        saved = [0, 0, 0, m.termios.ECHO | m.termios.ECHONL, 0, 0, []]
        hidden = [0, 0, 0, 0, 0, 0, []]
        with patch.object(m.os, 'open', return_value=fd), patch.object(m.os, 'isatty', return_value=True), \
                patch.object(m.os, 'fstat', return_value=os.stat_result(info)), \
                patch.object(m.termios, 'tcgetattr', side_effect=attributes or [saved, hidden]), \
                patch.object(m.termios, 'tcsetattr', side_effect=set_error) as setter:
            yield setter

    def test_echo_disable_failure_never_prompts_or_falls_back(self):
        with self.fake_terminal(set_error=m.termios.error('cannot hide')):
            with self.assertRaisesRegex(m.AdminSessionError, '^terminal-unavailable$'):
                m._read_password()
        self.getpass.assert_not_called()

    def test_echo_verification_failure_never_prompts(self):
        echo = [0, 0, 0, m.termios.ECHO, 0, 0, []]
        with self.fake_terminal(attributes=[echo, echo]):
            with self.assertRaises(m.AdminSessionError):
                m._read_password()
        self.getpass.assert_not_called()

    def test_one_entry_restores_terminal_and_stdin(self):
        stdin = sys.stdin
        with self.fake_terminal() as setter, patch.object(m.getpass, 'getpass', return_value=SENTINEL.decode()) as entry:
            password = m._read_password()
        self.assertEqual(password, SENTINEL)
        self.assertIsInstance(password, bytearray)
        self.assertIs(sys.stdin, stdin)
        self.assertEqual(entry.call_count, 1)
        self.assertIn('SERVER sudo password', entry.call_args.args[0])
        self.assertIn('typing hidden', entry.call_args.args[0])
        self.assertIn('leave this Terminal open', entry.call_args.args[0])
        self.assertEqual(setter.call_count, 2)
        self.assertTrue(setter.call_args.args[2][3] & m.termios.ECHO)
        m._wipe(password)

    def test_getpass_fallback_warning_is_fatal(self):
        def warn(*args, **kwargs):
            m.warnings.warn('fixture fallback', m.getpass.GetPassWarning)
            self.fail('getpass warning was not promoted to failure')
        with self.fake_terminal(), patch.object(m.getpass, 'getpass', side_effect=warn):
            with self.assertRaisesRegex(m.AdminSessionError, '^terminal-unavailable$'):
                m._read_password()

    def test_invalid_password_line_fails_without_second_entry(self):
        for text in ('', 'line\nbreak', 'line\rbreak', 'nul\0byte', 'x' * (m.MAX_PASSWORD + 1)):
            with self.fake_terminal(), patch.object(m.getpass, 'getpass', return_value=text) as entry:
                with self.assertRaises(m.AdminSessionError):
                    m._read_password()
                self.assertEqual(entry.call_count, 1)

    def test_prompt_interrupt_restores_echo(self):
        with self.fake_terminal() as setter, patch.object(m.getpass, 'getpass', side_effect=m._Closed):
            with self.assertRaises(m._Closed):
                m._read_password()
        self.assertTrue(setter.call_args.args[2][3] & m.termios.ECHO)

    def test_restore_failure_wipes_successfully_entered_buffer(self):
        seen = []
        wipe = m._wipe
        def observe(buffer):
            seen.append(buffer)
            wipe(buffer)
        with self.fake_terminal(set_error=[None, m.termios.error('restore failed')]), \
                patch.object(m.getpass, 'getpass', return_value=SENTINEL.decode()), \
                patch.object(m, '_wipe', side_effect=observe):
            with self.assertRaisesRegex(m.AdminSessionError, '^terminal-unavailable$'):
                m._read_password()
        self.assertEqual(seen, [bytearray()])

    def test_absolute_two_hour_alarm_and_restoration(self):
        handlers = {}
        def set_handler(number, handler):
            handlers[number] = handler
            return signal.SIG_DFL
        with patch.object(m.signal, 'getitimer', return_value=(0, 0)), \
                patch.object(m.signal, 'signal', side_effect=set_handler), patch.object(m.signal, 'setitimer') as timer:
            with m._lifetime():
                self.assertEqual(timer.call_args.args, (signal.ITIMER_REAL, 7200))
                for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
                    with self.assertRaises(m._Closed):
                        handlers[number](number, None)
            self.assertEqual(timer.call_args.args, (signal.ITIMER_REAL, 0))
            self.assertTrue(all(handler == signal.SIG_DFL for handler in handlers.values()))

    def test_serve_disables_core_dumps_before_broker(self):
        order = []
        broker = Mock()
        broker.run.side_effect = lambda: order.append('run')
        with patch.object(m.sys, 'platform', 'darwin'), patch.object(m.os, 'getuid', return_value=501), \
                patch.object(m.os, 'geteuid', return_value=501), patch.object(m, '_check_peer'), \
                patch.object(m.resource, 'setrlimit', side_effect=lambda *args: order.append(('core', args))), \
                patch.object(m, '_Broker', return_value=broker), patch.object(m, '_lifetime', return_value=ExitStack()):
            m.serve()
        self.assertEqual(order[0], ('core', (m.resource.RLIMIT_CORE, (0, 0))))
        self.assertEqual(order[1], 'run')
        broker.close.assert_called_once()

    def test_non_macos_serve_refuses_before_prompt(self):
        with patch.object(m.sys, 'platform', 'linux'):
            with self.assertRaises(m.AdminSessionError):
                m.serve()
        self.getpass.assert_not_called()
        self.popen.assert_not_called()


class SessionTests(Fixture):
    def test_macos_peer_uid_uses_real_libc(self):
        if sys.platform != 'darwin':
            self.skipTest('native getpeereid is macOS-only')
        left, right = socket.socketpair()
        with left, right:
            self.assertEqual(m._peer_uid(left), os.getuid())
            self.assertEqual(m._peer_uid(right), os.getuid())

    def test_libc_peer_lookup_failure_is_closed(self):
        if sys.platform != 'darwin':
            self.skipTest('native getpeereid is macOS-only')
        left, right = socket.socketpair()
        libc = Mock()
        libc.getpeereid.return_value = -1
        with left, right, patch.object(m.ctypes, 'CDLL', return_value=libc):
            with self.assertRaisesRegex(m.AdminSessionError, '^wrong-peer$'):
                m._peer_uid(left)

    def test_lost_response_is_unknown_outcome_not_retryable_schema_error(self):
        self.broker()
        with patch.object(m, '_receive', side_effect=m.AdminSessionError('invalid-request')), \
                patch.object(m, '_send') as send:
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-transport$'):
                m.run_python(SOURCE, seconds=1)
            self.assertEqual(send.call_count, 1)

    def test_client_checks_server_peer_before_sending_job(self):
        self.broker()
        with patch.object(m, '_peer_uid', return_value=os.getuid() + 1), patch.object(m, '_send') as send:
            with self.assertRaisesRegex(m.AdminSessionError, '^wrong-peer$'):
                m.run_python(SOURCE)
            send.assert_not_called()

    def test_wrong_peer_rejected_before_request_read(self):
        broker = self.broker()
        left, right = socket.socketpair()
        with left, right, patch.object(m, '_peer_uid', return_value=os.getuid() + 1), patch.object(m, '_receive') as read:
            with self.assertRaisesRegex(m.AdminSessionError, '^wrong-peer$'):
                broker.accept_one(right)
            read.assert_not_called()

    def test_socket_and_status_exist_before_one_credential_entry(self):
        broker = self.broker(opened=False)
        calls = []
        console = io.StringIO()
        password = bytearray(SENTINEL)
        def entry():
            self.assertEqual(console.getvalue(), '')
            self.assertTrue(self.socket_path.exists())
            self.assertEqual(m.status()['state'], 'waiting-for-authorization')
            calls.append('entry')
            return password
        def remote(secret, source, payload, seconds, expiry):
            self.assertEqual(console.getvalue(), '')
            self.assertEqual(secret, SENTINEL)
            self.assertIsNone(source)
            calls.append('auth')
            broker.closing.set()
            return {}
        with patch.object(m, '_read_password', side_effect=entry), patch.object(m, '_remote', side_effect=remote), \
                redirect_stdout(console):
            broker.run()
        broker.close()
        self.assertEqual(calls, ['entry', 'auth'])
        self.assertEqual(password, bytearray())
        self.assertEqual(console.getvalue(),
                         'Authorization accepted. Leave this window open. Ctrl+C closes it. '
                         'Expires 2h after session start.\n')
        self.assertNotIn(SENTINEL.decode(), console.getvalue())

    def test_failed_auth_has_no_retry_and_cleanup(self):
        broker = self.broker(opened=False)
        password = bytearray(SENTINEL)
        console = io.StringIO()
        with patch.object(m, '_read_password', return_value=password) as entry, \
                patch.object(m, '_remote', side_effect=m.AdminSessionError('authentication-failed')) as remote, \
                redirect_stdout(console):
            with self.assertRaises(m.AdminSessionError):
                broker.run()
        broker.close()
        entry.assert_called_once()
        remote.assert_called_once()
        self.assertEqual(console.getvalue(), '')
        self.assertEqual(password, bytearray())
        self.assertEqual(m.status()['state'], 'closed')

    def test_expiry_after_entry_never_authenticates(self):
        broker = self.broker(opened=False)
        broker.deadline = time.monotonic() - 1
        with patch.object(m, '_read_password', return_value=bytearray(SENTINEL)), patch.object(m, '_remote') as remote:
            with self.assertRaises(m._Closed):
                broker.run()
        remote.assert_not_called()
        broker.close()
        self.assertEqual(broker.password, bytearray())

    @contextmanager
    def running(self, remote, entry=None, expected_errors=()):
        broker = self.broker(opened=False)
        failures = []
        def run():
            try:
                broker.run()
            except m._Closed:
                pass
            except BaseException as error:
                failures.append(type(error).__name__)
            finally:
                broker.close()
        with patch.object(m, '_read_password', side_effect=entry or (lambda: bytearray(SENTINEL))), \
                patch.object(m, '_remote', side_effect=remote), patch.object(broker, 'interrupt', side_effect=broker.closing.set):
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                yield broker, failures
            finally:
                broker.closing.set()
                thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, list(expected_errors))

    def test_job_timeout_sends_unknown_outcome_then_closes_and_wipes(self):
        calls = []
        def remote(secret, source, payload, seconds, expiry):
            calls.append(source)
            if source is None:
                return {}
            raise m.AdminSessionError('unknown-outcome-timeout')
        with self.running(remote, expected_errors=('AdminSessionError',)) as (broker, _):
            self.wait_for(lambda: broker.meta['state'] == 'ready')
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-timeout$'):
                m.run_python(SOURCE, seconds=1)
            self.wait_for(lambda: broker.closing.is_set())
        self.assertEqual(calls, [None, SOURCE])
        self.assertEqual(broker.password, bytearray())
        self.assertEqual(m.status()['state'], 'closed')

    def test_actual_remote_timeout_response_closes_session_without_retry(self):
        real_remote = m._remote
        frames = []
        def capture(argv, frame, deadline):
            frames.append(frame)
            command = shlex.split(argv[-1])
            if command[-2:] == ['/usr/bin/id', '-u']:
                return 0, bytearray(b'0\n'), bytearray()
            self.assertEqual(command[6:10], ['/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '10'])
            return 124, bytearray(b'incomplete'), bytearray(SENTINEL)
        console = io.StringIO()
        with patch.object(m, '_capture', side_effect=capture) as capture_mock, redirect_stdout(console), \
                self.running(real_remote, expected_errors=('AdminSessionError',)) as (broker, _):
            self.wait_for(lambda: broker.meta['state'] == 'ready')
            with self.assertRaisesRegex(m.AdminSessionError, '^unknown-outcome-timeout$'):
                m.run_python(SOURCE, PAYLOAD, seconds=10)
            self.wait_for(lambda: broker.closing.is_set())
        self.assertEqual(capture_mock.call_count, 2)  # One id probe, one job; never retried.
        self.assertEqual(frames, [bytearray(), bytearray()])
        self.assertEqual(broker.password, bytearray())
        self.assertEqual(m.status()['state'], 'closed')
        self.assertNotIn(SENTINEL.decode(), console.getvalue())
        self.assertEqual(console.getvalue().count('Authorization accepted.'), 1)

    def test_importable_client_runs_sequential_jobs_with_no_retained_output(self):
        calls = []
        def remote(secret, source, payload, seconds, expiry):
            self.assertEqual(secret, SENTINEL)
            calls.append((source, payload, seconds))
            if source is None:
                return {}
            return {'exitCode': 7, 'stdout': base64.b64encode(b'fixture reply').decode(), 'stderr': ''}
        with self.running(remote) as (broker, _):
            self.wait_for(lambda: broker.meta['state'] == 'ready')
            for _ in range(2):
                self.assertEqual(m.run_python(SOURCE, PAYLOAD, seconds=3),
                                 {'exitCode': 7, 'stdout': b'fixture reply', 'stderr': b''})
                self.wait_for(lambda: broker.meta['state'] == 'ready')
            self.assertTrue(broker.jobs.empty())
            self.assertEqual(set(broker.meta), {'pid', 'state', 'label', 'hash', 'expiry'})
            self.assertNotIn('fixture reply', repr(broker.meta))
            self.assertEqual(m.stop(), {'stopping': True})
        self.assertEqual(len(calls), 3)
        self.assertIsNone(calls[0][0])
        self.assertEqual(calls[1:], [(SOURCE, PAYLOAD, 3), (SOURCE, PAYLOAD, 3)])
        self.assertEqual(m.status()['state'], 'closed')

    def test_status_and_stop_while_waiting_for_human_no_remote_action(self):
        release = threading.Event()
        self.addCleanup(release.set)
        remote = Mock(side_effect=AssertionError('No remote action before human entry'))
        def entry():
            release.wait(3)
            return bytearray(SENTINEL)
        with self.running(remote, entry) as (broker, _):
            self.wait_for(lambda: broker.thread is not None and broker.thread.is_alive())
            self.assertEqual(m.status()['state'], 'waiting-for-authorization')
            with self.assertRaises(m.AdminSessionError):
                m.run_python(SOURCE, seconds=1)
            self.assertEqual(m.stop(), {'stopping': True})
            release.set()
        remote.assert_not_called()
        self.assertEqual(broker.password, bytearray())

    def test_busy_rejects_second_job_and_stop_remains_responsive(self):
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        results = queue.Queue()
        def remote(secret, source, payload, seconds, expiry):
            if source is None:
                return {}
            entered.set()
            release.wait(3)
            return {'exitCode': 0, 'stdout': '', 'stderr': ''}
        def client():
            try:
                results.put(m.run_python(SOURCE, seconds=3, label='held-job'))
            except m.AdminSessionError:
                results.put('closed')
        with self.running(remote) as (broker, _):
            self.wait_for(lambda: broker.meta['state'] == 'ready')
            worker = threading.Thread(target=client, daemon=True)
            worker.start()
            self.assertTrue(entered.wait(2))
            self.assertEqual(m.status()['state'], 'busy')
            self.assertEqual(m.status()['label'], 'held-job')
            with self.assertRaises(m.AdminSessionError):
                m.run_python(SOURCE, seconds=1)
            self.assertEqual(m.stop(), {'stopping': True})
            release.set()
            worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertFalse(results.empty())
        self.assertEqual(broker.password, bytearray())

    def test_interrupt_targets_only_broker_pid(self):
        broker = self.broker()
        with patch.object(m.os, 'kill') as kill:
            broker.interrupt()
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)
        self.assertTrue(broker.closing.is_set())


if __name__ == '__main__':
    unittest.main()
