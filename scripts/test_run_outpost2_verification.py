"""Local launcher contracts; no sudo, SSH, checker or host operation is invoked."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('run_outpost2_verification', Path(__file__).with_name('run-outpost2-verification.py'))
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class VerificationLauncherTests(unittest.TestCase):
    """Report collisions must never require deleting or overwriting evidence."""

    def setUp(self) -> None:
        """Create only caller-owned temporary files and an inert checker fixture."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.directory.chmod(0o700)
        self.checker = self.directory / runner.CHECKER
        self.code = b'raise RuntimeError("NEVER EXECUTE THIS FIXTURE")\n'
        self.checker.write_bytes(self.code)
        self.checker.chmod(0o600)
        self.expected = hashlib.sha256(self.code).hexdigest()
        self.old = self.directory / 'runtime-verification.txt'
        self.old.write_text('keep original failure\n')
        self.old.chmod(0o600)

    def invoke(self, result: int = 0, failure: BaseException | None = None) -> tuple[int, str, object]:
        """Model the subprocess boundary without executing the supplied command."""
        def run(argv, **kwargs):
            self.assertEqual(argv, ['/usr/bin/sudo', '/usr/bin/python3', '-I', '-B', str(self.checker), '--check'])
            self.assertEqual(kwargs['cwd'], self.directory)
            self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
            self.assertEqual(kwargs['stderr'], subprocess.STDOUT)
            self.assertEqual(kwargs['env'], {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            self.assertEqual(kwargs['timeout'], 1200)
            self.assertFalse(kwargs['check'])
            self.assertNotIn('--start', argv)
            self.assertNotIn('-S', argv)
            kwargs['stdout'].write(b'fixture checker output\n')
            if failure:
                raise failure
            return subprocess.CompletedProcess(argv, result)
        output = io.StringIO()
        with patch.object(runner.subprocess, 'run', side_effect=run) as mocked, contextlib.redirect_stdout(output):
            code = runner.run_check(self.directory, self.expected)
        return code, output.getvalue(), mocked

    def test_repeat_invocations_create_private_unique_reports_and_preserve_original(self) -> None:
        """mkstemp is exclusive; neither an old failure nor the last result is overwritten."""
        before = self.old.stat()
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.invoke()[0], 0)
        reports = list(self.directory.glob('runtime-verification-*.txt'))
        self.assertEqual(len(reports), 2)
        for path in reports:
            self.assertEqual(path.read_bytes(), b'fixture checker output\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_uid, os.geteuid())
        self.assertEqual(self.old.read_text(), 'keep original failure\n')
        self.assertEqual(self.old.stat().st_ino, before.st_ino)
        self.assertEqual(self.old.stat().st_mtime_ns, before.st_mtime_ns)

    def test_checker_failure_is_not_reported_as_success(self) -> None:
        """A private report is retained even when the actual verifier refuses."""
        code, output, call = self.invoke(1)
        self.assertEqual(code, 1)
        self.assertIn('Verification stopped (exit 1)', output)
        self.assertNotIn('Verification passed', output)
        self.assertIn('Report saved:', output)
        self.assertEqual(call.call_count, 1)

    def test_timeout_interrupt_and_launch_error_preserve_output_without_retry(self) -> None:
        """Failure evidence stays available; no force-kill or automatic retry command exists."""
        for failure, expected in ((subprocess.TimeoutExpired('fixture', 1200), 124), (KeyboardInterrupt(), 130), (OSError('fixture'), 1)):
            with self.subTest(failure=type(failure).__name__):
                code, output, call = self.invoke(failure=failure)
                self.assertEqual(code, expected)
                self.assertIn('Verification stopped', output)
                self.assertEqual(call.call_count, 1)
        self.assertEqual(len(list(self.directory.glob('runtime-verification-*.txt'))), 3)
        self.assertTrue(all(path.read_bytes().startswith(b'fixture checker output\n') for path in self.directory.glob('runtime-verification-*.txt')))

    def test_invalid_checker_hash_fails_before_report_or_subprocess(self) -> None:
        """Do not run a stale or partially uploaded checker."""
        with patch.object(runner.subprocess, 'run') as call:
            with self.assertRaisesRegex(runner.Refused, 'checksum'):
                runner.run_check(self.directory, '0' * 64)
            call.assert_not_called()
        self.assertFalse(list(self.directory.glob('runtime-verification-*.txt')))

    def test_root_invocation_is_refused(self) -> None:
        """Reports must remain readable by the SSH operator, not root-only."""
        with patch.object(runner.os, 'geteuid', return_value=0), patch.object(runner.subprocess, 'run') as call:
            with self.assertRaisesRegex(runner.Refused, 'without sudo'):
                runner.run_check(self.directory, self.expected)
            call.assert_not_called()
        self.assertFalse(list(self.directory.glob('runtime-verification-*.txt')))

    def test_symlink_or_shared_checker_is_refused(self) -> None:
        """Never follow a checker link or accept a group-writable replacement."""
        target = self.directory / 'inert-copy'
        self.checker.rename(target)
        self.checker.symlink_to(target)
        with self.assertRaises(OSError):
            runner.run_check(self.directory, self.expected)
        self.checker.unlink()
        target.rename(self.checker)
        self.checker.chmod(0o660)
        with self.assertRaisesRegex(runner.Refused, 'Unsafe checker'):
            runner.run_check(self.directory, self.expected)
        self.assertFalse(list(self.directory.glob('runtime-verification-*.txt')))

    def test_shared_staging_directory_is_refused(self) -> None:
        """The helper writes only inside the previously staged private directory."""
        self.directory.chmod(0o755)
        with self.assertRaisesRegex(runner.Refused, 'private'):
            runner.run_check(self.directory, self.expected)
        self.assertFalse(list(self.directory.glob('runtime-verification-*.txt')))


if __name__ == '__main__':
    unittest.main()
