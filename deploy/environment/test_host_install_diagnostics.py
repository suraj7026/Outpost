"""Future-helper diagnostics contracts using only disposable local Python children."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

import host_install as host


class InstallerDiagnosticsTests(unittest.TestCase):
    """Keep command provenance private, bounded and independent of public receipts."""

    def setUp(self) -> None:
        """Construct a fully identified operation without touching installation paths."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        paths = {name: self.root / name.lower() for name in ('PREFIX', 'OPERATIONS')}
        patcher = patch.multiple(host, PREFIX=paths['PREFIX'], OPERATIONS=paths['OPERATIONS'])
        patcher.start()
        self.addCleanup(patcher.stop)
        host.OPERATIONS.mkdir()
        self.request = {
            'operationId': str(uuid.uuid4()), 'environmentId': str(uuid.uuid4()),
            'deviceId': str(uuid.uuid4()), 'publicKey': base64.b64encode(b'x' * 32).decode(),
            'label': 'Private fixture label', 'releaseId': 'host-' + 'a' * 20,
            'sha256': 'b' * 64, 'size': 12, 'browser': True, 'coexistence': True, 'fullControl': False,
        }
        self.operation = host.OPERATIONS / self.request['operationId']
        self.operation.mkdir(mode=0o711)
        self.status = {
            **{key: self.request[key] for key in ('operationId', 'environmentId', 'releaseId')},
            'state': 'queued', 'completedSteps': 0, 'totalSteps': 12, 'stage': host.STAGES[0],
            'startedAt': 1, 'updatedAt': 1, 'log': [], 'error': None,
        }
        host.atomic_json(self.operation / 'request.json', self.request)
        host.atomic_json(self.operation / 'status.json', self.status, 0o644)
        (self.operation / 'cancel').touch(mode=0o600)
        self.installer = host.Installer(self.operation)
        self.installer.release.mkdir(parents=True)

    def fixture(self, code: str, **options) -> None:
        """Execute a local child through the actual installer pipe/cancellation path."""
        self.installer.run([sys.executable, '-c', code], command_id='browser.python-sync', **options)

    def diagnostics(self) -> dict:
        """Read the private sidecar, never an augmented public receipt."""
        return json.loads((self.operation / 'diagnostics.json').read_text())

    def execute_browser(self, code: str, **options) -> None:
        """Reach the real 4/12 failure boundary with no host provisioning effects."""
        with ExitStack() as stack:
            for name in ('preflight', 'accounts', 'runtime', 'dependencies'):
                stack.enter_context(patch.object(self.installer, name))
            stack.enter_context(patch.object(self.installer, 'browsers', side_effect=lambda: self.fixture(code, **options)))
            stack.enter_context(patch.object(self.installer, 'configuration', side_effect=AssertionError('Must stop at 4/12')))
            self.installer.execute()

    def test_private_versioned_identity_and_no_public_or_metadata_secrets(self) -> None:
        """Argv, environment, stdin and echoed secrets stay out of metadata/receipts."""
        original = os.umask(0)
        try:
            self.fixture(
                'import os,sys; print("argv-canary"); print(os.environ["SECRET"]); print(sys.stdin.read())',
                input_data=b'stdin-canary', env={'SECRET': 'environment-canary'},
            )
        finally:
            os.umask(original)
        sidecar = self.diagnostics()
        self.assertEqual(sidecar['schema'], 1)
        for key in ('operationId', 'environmentId', 'releaseId'):
            self.assertEqual(sidecar[key], self.request[key])
        command = sidecar['commands'][-1]
        self.assertEqual(command['commandId'], 'browser.python-sync')
        self.assertEqual(command['stageId'], 'browser-runtime')
        self.assertEqual(command['substageId'], 'python-sync')
        self.assertEqual(command['outcome'], 'succeeded')
        self.assertEqual(command['exitCode'], 0)
        self.assertGreaterEqual(command['finishedAt'], command['startedAt'])
        self.assertGreaterEqual(sidecar['updatedAt'], command['finishedAt'])
        self.assertEqual(sidecar['logs'], {'command.log': command['sequence'], 'failed-command.log': None})
        public = (self.operation / 'status.json').read_text()
        metadata = (self.operation / 'diagnostics.json').read_text()
        for secret in ('argv-canary', 'environment-canary', 'stdin-canary', 'Private fixture label'):
            self.assertNotIn(secret, public + metadata)
        self.assertEqual(set(json.loads(public)), set(self.status))
        for name in ('command.log', 'diagnostics.json'):
            self.assertEqual(stat.S_IMODE((self.operation / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.operation / 'status.json').stat().st_mode), 0o644)
        self.assertIn(b'stdin-canary', (self.operation / 'command.log').read_bytes())

    def test_nonzero_exit_at_four_of_twelve_preserves_original_failure_after_cleanup(self) -> None:
        """Later commands cannot relabel or overwrite the original browser failure."""
        self.execute_browser('import sys; print("original failure"); sys.exit(12)')
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(set(status), set(self.status))
        self.assertEqual((status['state'], status['completedSteps'], status['totalSteps']), ('failed', 4, 12))
        self.assertEqual(status['stage'], 'Browser runtime')
        self.assertIn('exit 12', status['error'])
        first = self.diagnostics()['failedCommand']
        self.assertEqual((first['commandId'], first['completedSteps'], first['exitCode']), ('browser.python-sync', 4, 12))
        self.assertEqual(first['outcome'], 'failed')
        evidence = (self.operation / 'failed-command.log').read_bytes()
        self.fixture('print("cleanup output")')
        with self.assertRaises(RuntimeError):
            self.fixture('import sys; print("secondary failure"); sys.exit(4)')
        sidecar = self.diagnostics()
        self.assertEqual(sidecar['failedCommand'], first)
        self.assertEqual(sidecar['logs']['failed-command.log'], first['sequence'])
        self.assertEqual(sidecar['logs']['command.log'], 3)
        self.assertEqual((self.operation / 'failed-command.log').read_bytes(), evidence)
        self.assertIn(b'original failure', evidence)
        self.assertIn(b'secondary failure', (self.operation / 'command.log').read_bytes())
        self.assertEqual(stat.S_IMODE((self.operation / 'failed-command.log').stat().st_mode), 0o600)

    def test_timeout_is_failed_not_user_cancelled_and_keeps_partial_output(self) -> None:
        """A deadline is not evidence that the user asked to stop installation."""
        self.execute_browser('import time; print("before timeout", flush=True); time.sleep(30)', timeout=0.2)
        status = json.loads((self.operation / 'status.json').read_text())
        failure = self.diagnostics()['failedCommand']
        self.assertEqual((status['state'], status['completedSteps']), ('failed', 4))
        self.assertEqual(failure['outcome'], 'timed_out')
        self.assertLess(failure['exitCode'], 0)
        self.assertIn('timed out', status['error'])
        self.assertEqual((self.operation / 'cancel').read_bytes(), b'')
        self.assertIn(b'before timeout', (self.operation / 'failed-command.log').read_bytes())

    def test_user_cancellation_is_distinct_from_timeout(self) -> None:
        """A fixture writes only its operation's cancellation marker after output."""
        code = 'import pathlib,time; print("before cancel", flush=True); pathlib.Path(' + repr(str(self.operation / 'cancel')) + ').write_text("1"); time.sleep(30)'
        self.execute_browser(code, timeout=5)
        failure = self.diagnostics()['failedCommand']
        self.assertEqual(failure['outcome'], 'cancelled')
        self.assertLess(failure['exitCode'], 0)
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('cancelled', 4))
        self.assertIn(b'before cancel', (self.operation / 'failed-command.log').read_bytes())

    def test_preexisting_cancel_never_starts_or_replaces_evidence(self) -> None:
        """A boundary cancellation is not a command attempt or a replay."""
        self.fixture('print("previous output")')
        before = {name: (self.operation / name).read_bytes() for name in ('diagnostics.json', 'command.log')}
        (self.operation / 'cancel').write_text('1')
        with patch.object(host.subprocess, 'Popen') as launch, self.assertRaises(InterruptedError):
            self.fixture('raise AssertionError("must not run")')
        launch.assert_not_called()
        for name, content in before.items():
            self.assertEqual((self.operation / name).read_bytes(), content)

    def test_flood_has_hard_live_disk_bound_and_exact_tail_metadata(self) -> None:
        """UTF-8 byte floods cannot transiently grow the retained files past their cap."""
        sizes = []
        stop = threading.Event()

        def sample() -> None:
            """Observe disk use while the child, not just the final assertion, is active."""
            while not stop.wait(0.001):
                sizes.append(sum(path.stat().st_size for path in self.operation.glob('*command.log')))

        monitor = threading.Thread(target=sample)
        monitor.start()
        try:
            with self.assertRaises(RuntimeError):
                self.fixture('import os,sys; data=("é"*4096).encode(); [os.write(1,data) for _ in range(256)]; os.write(2,b"END"); sys.exit(1)')
        finally:
            stop.set()
            monitor.join(timeout=2)
        retained = (self.operation / 'failed-command.log').read_bytes()
        self.assertEqual(len(retained), host.COMMAND_LOG_LIMIT)
        self.assertEqual(retained[-3:], b'END')
        self.assertTrue(sizes)
        self.assertLessEqual(max(sizes), 2 * host.COMMAND_LOG_LIMIT)
        output = self.diagnostics()['failedCommand']['output']
        self.assertEqual(output, {
            'retention': 'tail', 'limitBytes': host.COMMAND_LOG_LIMIT,
            'bytesSeen': 2097155, 'bytesRetained': host.COMMAND_LOG_LIMIT,
            'bytesDropped': 2097155 - host.COMMAND_LOG_LIMIT, 'truncated': True, 'streamComplete': True,
        })

    def test_history_eviction_preserves_failed_record_and_bounds_sidecar(self) -> None:
        """Metadata retention never forgets which command owns failed-command.log."""
        with self.assertRaises(RuntimeError):
            self.fixture('raise SystemExit(1)')
        failure = self.diagnostics()['failedCommand']
        with patch.object(host, 'DIAGNOSTIC_COMMAND_LIMIT', 3):
            for _ in range(5):
                self.fixture('pass')
        sidecar = self.diagnostics()
        self.assertEqual(sidecar['commandCount'], 6)
        self.assertEqual(sidecar['omittedCommandCount'], 3)
        self.assertEqual([record['sequence'] for record in sidecar['commands']], [4, 5, 6])
        self.assertEqual(sidecar['failedCommand'], failure)
        self.assertLessEqual((self.operation / 'diagnostics.json').stat().st_size, host.DIAGNOSTICS_LIMIT)
        self.assertEqual(sorted(path.name for path in self.operation.glob('*.log')), ['command.log', 'failed-command.log'])

    def test_running_sidecar_is_published_before_child_and_not_claimed_complete(self) -> None:
        """Abrupt job termination leaves explicitly incomplete, not successful, evidence."""
        code = 'import json,pathlib; d=json.loads(pathlib.Path(' + repr(str(self.operation / 'diagnostics.json')) + ').read_text()); c=d["commands"][-1]; assert c["outcome"]=="running" and c["finishedAt"] is None and c["exitCode"] is None and not c["output"]["streamComplete"]'
        self.fixture(code)

    def test_spawn_failure_does_not_leak_argv_into_receipt(self) -> None:
        """Even OS errors must not interpolate command arguments into public errors."""
        with patch.object(self.installer, 'browsers', side_effect=lambda: self.installer.run([str(self.root / 'argv-secret-canary')], command_id='browser.python-sync')), ExitStack() as stack:
            for name in ('preflight', 'accounts', 'runtime', 'dependencies'):
                stack.enter_context(patch.object(self.installer, name))
            self.installer.execute()
        failure = self.diagnostics()['failedCommand']
        self.assertEqual(failure['outcome'], 'start_failed')
        self.assertIsNone(failure['exitCode'])
        self.assertNotIn('argv-secret-canary', (self.operation / 'status.json').read_text())
        self.assertNotIn('argv-secret-canary', (self.operation / 'diagnostics.json').read_text())

    def test_large_stdin_and_inherited_stdout_do_not_escape_deadline(self) -> None:
        """Blocked input and a descendant holding the pipe both remain interruptible."""
        for code, options in (
            ('import time; time.sleep(30)', {'input_data': b'x' * 1048576}),
            ('import os,time; pid=os.fork(); time.sleep(30) if pid == 0 else None', {}),
        ):
            with self.subTest(code=code):
                started = time.monotonic()
                with self.assertRaises(TimeoutError):
                    self.fixture(code, timeout=0.2, **options)
                self.assertLess(time.monotonic() - started, 7)
                self.assertEqual(self.diagnostics()['commands'][-1]['outcome'], 'timed_out')

    def test_unsafe_log_files_are_not_followed_or_truncated(self) -> None:
        """Refuse symlinks, hardlinks and FIFOs without blocking or altering targets."""
        target = self.root / 'private-target'
        target.write_bytes(b'unchanged')
        log = self.operation / 'command.log'
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    log.symlink_to(target)
                elif kind == 'hardlink':
                    os.link(target, log)
                else:
                    os.mkfifo(log)
                try:
                    with patch.object(host.subprocess, 'Popen') as launch, self.assertRaises((OSError, ValueError)):
                        self.fixture('pass')
                    launch.assert_not_called()
                    self.assertEqual(target.read_bytes(), b'unchanged')
                finally:
                    log.unlink()

    def test_maintenance_dependency_builder_needs_no_request_or_status(self) -> None:
        """Exercise the exact object.__new__ shape used by Updater.stage with local children."""
        builder = object.__new__(host.Installer)
        builder.operation, builder.release = self.operation, self.installer.release
        builder.node, builder.environment = self.installer.node, self.installer.environment
        capture = host.capture_command
        identifiers = []
        original_run = builder.run

        def local_run(argv: list[str], **options) -> None:
            """Replace privileged argv, but keep real instrumentation and pipe handling."""
            identifiers.append(options['command_id'])
            options.pop('user', None)
            original_run([sys.executable, '-c', 'print("staged locally")'], **options)

        with patch.object(builder, 'run', side_effect=local_run), patch.object(host, 'capture_command', wraps=capture) as captured:
            builder.dependencies()
        self.assertEqual(captured.call_count, 3)
        self.assertEqual(identifiers, ['dependencies.build-ownership', 'dependencies.npm-ci', 'dependencies.typescript-version'])
        self.assertFalse((self.operation / 'diagnostics.json').exists())
        self.assertIn(b'staged locally', (self.operation / 'command.log').read_bytes())

    def test_failed_bootstrap_replay_is_read_only_including_sidecar(self) -> None:
        """Resending the exact request cannot restart a failed-at-4/12 operation."""
        payload = b'fixture only'
        self.request.update(size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        host.atomic_json(self.operation / 'request.json', self.request)
        self.execute_browser('raise SystemExit(1)')
        names = ('diagnostics.json', 'failed-command.log', 'command.log', 'status.json')
        before = {name: (self.operation / name).read_bytes() for name in names}
        wire = json.dumps(self.request).encode() + b'\n' + payload
        with (
            patch.object(host.os, 'geteuid', return_value=0), patch.object(host.subprocess, 'Popen') as launch,
            patch.object(host.sys, 'stdin', io.TextIOWrapper(io.BytesIO(wire))), patch.object(host.sys, 'stdout', io.StringIO()),
        ):
            host.bootstrap()
        launch.assert_not_called()
        for name, content in before.items():
            self.assertEqual((self.operation / name).read_bytes(), content)

    def test_stopped_execute_never_replays_or_replaces_provenance(self) -> None:
        """Even a direct detached-job invocation cannot reset a stopped operation."""
        self.execute_browser('raise SystemExit(1)')
        names = ('diagnostics.json', 'failed-command.log', 'command.log', 'status.json')
        before = {name: (self.operation / name).read_bytes() for name in names}
        # A second object may have been initialized before the first job finished.
        stale = host.Installer(self.operation)
        stale.status['state'] = 'queued'
        with patch.object(stale, 'preflight') as preflight, patch.object(host.subprocess, 'Popen') as launch:
            stale.execute()
        preflight.assert_not_called()
        launch.assert_not_called()
        for name, content in before.items():
            self.assertEqual((self.operation / name).read_bytes(), content)

    def test_preflight_failure_has_identity_but_no_invented_failed_command(self) -> None:
        """No subprocess failure is fabricated for a filesystem/platform check."""
        with patch.object(self.installer, 'preflight', side_effect=ValueError('Fixture preflight failure')):
            self.installer.execute()
        sidecar = self.diagnostics()
        self.assertEqual(sidecar['commands'], [])
        self.assertEqual(sidecar['commandCount'], 0)
        self.assertIsNone(sidecar['failedCommand'])
        self.assertFalse((self.operation / 'failed-command.log').exists())

    def test_cleanup_timeout_keeps_original_receipt_and_failure(self) -> None:
        """Best-effort service cleanup cannot replace the installation error."""
        self.installer.activated = True
        with patch.object(host.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['cleanup-secret-canary'], 45)) as cleanup:
            self.execute_browser('import sys; print("original evidence"); sys.exit(4)')
        cleanup.assert_called_once()
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('failed', 4))
        self.assertIn('exit 4', status['error'])
        self.assertNotIn('cleanup-secret-canary', json.dumps(status))
        self.assertEqual(self.diagnostics()['failedCommand']['exitCode'], 4)
        self.assertIn(b'original evidence', (self.operation / 'failed-command.log').read_bytes())

    def test_health_command_timeout_or_cancel_is_not_replayed(self) -> None:
        """Only network readiness checks, not subprocess effects, are polled."""
        token = self.root / 'config/coordinator/worker-token'
        token.parent.mkdir(parents=True)
        token.write_text('private fixture token')
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.headers = {'x-outpost-environment-id': self.request['environmentId']}
        identity = {'environmentId': self.request['environmentId'], 'protocolVersion': 2,
                    'runtime': {'release': self.request['releaseId']}}
        for error in (TimeoutError('fixture deadline'), InterruptedError('fixture cancellation')):
            with self.subTest(error=error):
                response.read.side_effect = [json.dumps(identity).encode(), json.dumps({'releaseId': self.request['releaseId']}).encode()]
                with (
                    patch.object(host, 'CONFIG', token.parent.parent), patch.object(host.urllib.request, 'build_opener', return_value=opener),
                    patch.object(self.installer, 'run', side_effect=error) as run, self.assertRaises(type(error)),
                ):
                    self.installer.health()
                run.assert_called_once()
                self.assertEqual(run.call_args.kwargs['command_id'], 'health.services-active')

    def test_timeout_escalates_when_child_ignores_sigterm(self) -> None:
        """A stubborn local child is killed and reaped without relabeling the deadline."""
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.fixture('import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ignoring TERM", flush=True); time.sleep(30)', timeout=0.3)
        self.assertLess(time.monotonic() - started, 8)
        command = self.diagnostics()['failedCommand']
        self.assertEqual((command['outcome'], command['exitCode']), ('timed_out', -9))
        self.assertIn(b'ignoring TERM', (self.operation / 'failed-command.log').read_bytes())

    def test_launch_capture_has_private_hard_bound(self) -> None:
        """The short launcher cannot bypass the budget by writing straight to disk."""
        path = self.operation / 'launch.log'
        with host.private_log(path, exclusive=True) as output:
            log = host.BoundedLog(output, host.LAUNCH_LOG_LIMIT)
            outcome, code = host.capture_command([sys.executable, '-c', 'import os; [os.write(1,b"x"*8192) for _ in range(64)]'], log, timeout=5)
        self.assertEqual((outcome, code), ('succeeded', 0))
        self.assertEqual(path.stat().st_size, host.LAUNCH_LOG_LIMIT)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertTrue(log.metadata()['truncated'])

    def test_identifier_is_reviewed_and_not_derived_from_child_input(self) -> None:
        """Arbitrary labels cannot smuggle raw commands or secrets into metadata."""
        with patch.object(host.subprocess, 'Popen') as launch, self.assertRaises(ValueError):
            self.installer.run([sys.executable, '-c', 'pass'], command_id='secret arbitrary argv')
        launch.assert_not_called()
        self.assertFalse((self.operation / 'diagnostics.json').exists())

    def test_private_mode_precedes_reused_log_and_sidecar_temporary_writes(self) -> None:
        """A permissive umask or stale temp file cannot expose new secret output."""
        for name in ('command.log', 'diagnostics.json.tmp'):
            path = self.operation / name
            path.write_text('stale fixture data')
            path.chmod(0o644)
        dump = host.json.dump

        def private_dump(value: object, output, **options) -> None:
            """Observe the file mode before serialization, not only after replacement."""
            self.assertEqual(stat.S_IMODE(os.fstat(output.fileno()).st_mode), 0o600)
            dump(value, output, **options)

        code = 'import pathlib,stat; assert stat.S_IMODE(pathlib.Path(' + repr(str(self.operation / 'command.log')) + ').stat().st_mode)==0o600; print("secret fixture")'
        with patch.object(host.json, 'dump', side_effect=private_dump):
            self.fixture(code)
        self.assertEqual(stat.S_IMODE((self.operation / 'diagnostics.json').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
