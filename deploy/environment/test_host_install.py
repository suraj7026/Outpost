"""Local installer contracts. No sudo, SSH, package managers or host services are invoked."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import importlib.util
import io
import itertools
import json
import os
import tarfile
import tempfile
import unittest
import uuid
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('host_install', Path(__file__).with_name('host_install.py'))
assert SPEC and SPEC.loader
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


def request() -> dict:
    """Return a synthetic reviewed operation containing no credentials."""
    return {'operationId': str(uuid.uuid4()), 'environmentId': str(uuid.uuid4()), 'deviceId': str(uuid.uuid4()),
            'publicKey': base64.b64encode(b'x' * 32).decode(), 'label': 'Disposable fixture',
            'releaseId': 'host-' + 'a' * 20, 'sha256': 'b' * 64, 'size': 12, 'browser': False, 'coexistence': True, 'fullControl': False}


class HostInstallationTests(unittest.TestCase):
    """Exercise the installation boundary and filesystem/service declarations."""

    def setUp(self) -> None:
        """Redirect every install-owned path into a disposable local directory."""
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.paths = {name: self.root / name.lower() for name in ('PREFIX', 'DATA', 'CONFIG', 'OPERATIONS', 'UNIT_DIRECTORY')}
        self.patcher = patch.multiple(host, **self.paths)
        self.patcher.start()
        host.OPERATIONS.mkdir()
        host.UNIT_DIRECTORY.mkdir()
        self.request = request()
        self.operation = host.OPERATIONS / self.request['operationId']
        self.operation.mkdir()
        (self.operation / 'source').mkdir()
        (self.operation / 'cancel').touch()
        host.atomic_json(self.operation / 'request.json', self.request)
        host.atomic_json(self.operation / 'status.json', {
            **{key: self.request[key] for key in ('operationId', 'environmentId', 'releaseId')},
            'state': 'queued', 'completedSteps': 0, 'totalSteps': 12, 'stage': host.STAGES[0],
            'startedAt': 1, 'updatedAt': 1, 'log': [], 'error': None,
        }, 0o644)
        self.installer = host.Installer(self.operation)
        self.setup_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        lock_backend = host.installation_lock
        self.lock_patcher = patch.object(host, 'installation_lock',
                                         lambda: lock_backend(root_fd=self.setup_fd, parts=(), owner=os.getuid()))
        self.lock_patcher.start()

    def tearDown(self) -> None:
        """Remove only this test's disposable paths."""
        self.lock_patcher.stop()
        os.close(self.setup_fd)
        self.patcher.stop()
        self.temporary.cleanup()

    def reset_receipt(self, state: str = 'complete') -> tuple[Path, dict]:
        """Create independent previous-operation reset evidence in the fixture only."""
        reset_id = str(uuid.uuid4())
        directory = self.root / 'resets' / reset_id
        directory.mkdir(parents=True, mode=0o711)
        value = {'schemaVersion': 1, 'operationId': str(uuid.uuid4()), 'environmentId': str(uuid.uuid4()),
                 'releaseId': self.request['releaseId'], 'resetId': reset_id, 'state': state,
                 'message': 'Native reset completed. Original operation evidence is retained; a new installation needs separate approval.',
                 'bindingDigest': 'b' * 64, 'snapshotDigest': 'c' * 64}
        host.atomic_json(directory / 'status.json', value, 0o644)
        return directory, value

    def test_unknown_reset_after_native_deletion_blocks_a_fresh_operation(self) -> None:
        """Released install.lock and absent native roots do not clear a recovery hold."""
        directory, _ = self.reset_receipt('unknown')
        evidence = (directory / 'status.json').read_bytes()
        with patch.object(self.installer, 'preflight') as preflight, patch.object(self.installer, 'accounts') as accounts:
            self.installer.execute()
        preflight.assert_not_called()
        accounts.assert_not_called()
        self.assertEqual(self.installer.status['state'], 'failed')
        self.assertEqual(self.installer.status['completedSteps'], 0)
        self.assertIn('reset', self.installer.status['error'].lower())
        self.assertEqual((directory / 'status.json').read_bytes(), evidence)
        self.assertFalse((self.operation / 'diagnostics.json').exists())
        self.assertFalse(host.PREFIX.exists())

    def test_reset_hold_gate_runs_while_the_same_install_lock_is_exclusive(self) -> None:
        """The gate is in execute(), not bypassable by a mocked or altered preflight."""
        gate = host.check_reset_holds
        def checked(descriptor: int, owner: int = 0) -> None:
            with (self.root / 'install.lock').open('rb') as peer, self.assertRaises(BlockingIOError):
                fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            gate(descriptor, owner)
        with patch.object(host, 'check_reset_holds', side_effect=checked) as called, ExitStack() as stack:
            for name in ('preflight', 'accounts', 'runtime', 'dependencies', 'browsers', 'configuration', 'enroll', 'services', 'health'):
                stack.enter_context(patch.object(self.installer, name))
            self.installer.execute()
        called.assert_called_once()
        self.assertEqual(self.installer.status['state'], 'ready')

    def test_only_well_formed_complete_reset_receipts_allow_installation(self) -> None:
        """Failed, malformed, mismatched and absent receipts are all durable holds."""
        directory, good = self.reset_receipt()
        for changes in ({'state': 'unknown'}, {'state': 'failed'}, {'schemaVersion': True}, {'resetId': str(uuid.uuid4())},
                        {'bindingDigest': 'bad'}, {'snapshotDigest': 'bad'}, {'message': 'unknown'}, {'extra': True}):
            with self.subTest(changes=changes):
                host.atomic_json(directory / 'status.json', {**good, **changes}, 0o644)
                with self.assertRaises(RuntimeError):
                    host.check_reset_holds(self.setup_fd, os.getuid())
        (directory / 'status.json').write_bytes(b'{"state":"complete","state":"unknown"}')
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        (directory / 'status.json').unlink()
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        host.atomic_json(directory / 'status.json', good, 0o644)
        host.check_reset_holds(self.setup_fd, os.getuid())

    def test_reset_gate_rejects_links_writable_metadata_and_foreign_owner(self) -> None:
        """Never follow reset evidence symlinks or trust mutable/shared metadata."""
        directory, good = self.reset_receipt()
        status = directory / 'status.json'
        status.chmod(0o666)
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        status.chmod(0o644)
        os.link(status, self.root / 'outside-hardlink')
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        status.unlink()
        status.symlink_to(self.root / 'outside-hardlink')
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        status.unlink()
        host.atomic_json(status, good, 0o644)
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid() + 1)
        status.unlink()
        directory.rmdir()
        directory.symlink_to(self.operation, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())

    def test_reset_gate_rejects_oversized_and_excessive_evidence(self) -> None:
        """Receipt parsing and enumeration are independently bounded under the lock."""
        self.reset_receipt()
        with patch.object(host, 'RESET_RECEIPT_LIMIT', 32), self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        self.reset_receipt()
        self.reset_receipt()
        with patch.object(host, 'RESET_COUNT_LIMIT', 2), self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())
        with patch.object(host.time, 'monotonic', side_effect=[0, 100]), self.assertRaises(RuntimeError):
            host.check_reset_holds(self.setup_fd, os.getuid())

    def test_requests_cannot_supply_commands_paths_or_unreviewed_flags(self) -> None:
        """Reject remote-command injection and accidental privilege expansion."""
        host.validate_request(self.request)
        for key, value in (('operationId', '../../etc'), ('releaseId', 'x;whoami'), ('publicKey', 'secret'), ('size', 40 * 1024 * 1024), ('browser', 'yes'), ('fullControl', 'true'), ('label', 'line\nEnvironment=ROOT=1')):
            with self.assertRaises((ValueError, TypeError)):
                host.validate_request({**self.request, key: value})
        with self.assertRaises(ValueError):
            host.validate_request({**self.request, 'command': 'remove Kubernetes'})
        with self.assertRaises(ValueError):
            host.validate_request({key: value for key, value in self.request.items() if key != 'fullControl'})

    def test_unprivileged_commands_keep_only_the_explicit_private_build_environment(self) -> None:
        """runuser must not replace the private cache home with /nonexistent."""
        with patch.object(host, 'capture_command', return_value=('succeeded', 0)) as launch:
            self.installer.run(['/usr/bin/true'], command_id='dependencies.typescript-version', user='outpost-build')
        argv = launch.call_args.args[0]
        self.assertEqual(argv[:5], ['/usr/sbin/runuser', '--preserve-environment', '-u', 'outpost-build', '--'])
        environment = launch.call_args.kwargs['env']
        self.assertEqual(environment['HOME'], str(self.operation / 'build-home'))
        self.assertEqual(environment['NEEDRESTART_MODE'], 'l')
        self.assertEqual(set(environment), {'PATH', 'HOME', 'LANG', 'DEBIAN_FRONTEND', 'NEEDRESTART_MODE'})

    def test_source_archives_reject_symlinks_and_parent_traversal(self) -> None:
        """A checksum does not excuse unsafe archive paths."""
        for name, kind in (('../outside', tarfile.REGTYPE), ('/etc/unsafe', tarfile.REGTYPE), ('server/link', tarfile.SYMTYPE)):
            archive = self.root / 'unsafe.tar'
            with tarfile.open(archive, 'w') as output:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.linkname = '/etc'
                output.addfile(item, io.BytesIO())
            with self.assertRaises(ValueError):
                host.extract_source(archive, self.root / 'extract')
        self.assertFalse((self.root.parent / 'outside').exists())

    def test_camoufox_install_uses_verified_asset_and_locked_launcher(self) -> None:
        """Browser setup is pinned, private, and separate from inference configuration."""
        self.installer.request['browser'] = True
        self.installer.node.parent.mkdir(parents=True)
        pins_path = self.installer.release / 'deploy/environment/runtime-pins.json'
        pins_path.parent.mkdir(parents=True)
        pins_path.write_bytes(Path(__file__).with_name('runtime-pins.json').read_bytes())
        pins = json.loads(pins_path.read_text())

        def download(url: str, digest: str, destination: Path, max_bytes: int = 256 * 1024 * 1024) -> None:
            """Supply only synthetic verified-package contents; never use the network."""
            with zipfile.ZipFile(destination, 'w') as archive:
                if url == pins['uvUrl']:
                    archive.writestr('uv.data/scripts/uv', b'fixture')
                else:
                    self.assertEqual(url, pins['camoufoxUrl'])
                    self.assertEqual(digest, pins['camoufoxSha256'])
                    self.assertEqual(max_bytes, 2 * 1024 * 1024 * 1024)
                    entry = zipfile.ZipInfo('camoufox')
                    entry.external_attr = 0o100755 << 16
                    archive.writestr(entry, b'fixture')

        with patch.object(self.installer, 'run') as run, patch.object(self.installer, 'download', side_effect=download), patch.object(host.shutil, 'chown') as chown:
            self.installer.browsers()
        chown.assert_called_once_with(self.installer.release / 'browsers/camoufox/fontconfig', user='outpost-build', group='outpost-build')
        calls = [call.args[0] for call in run.call_args_list]
        self.assertEqual(calls[0][-2:], ['install-deps', 'firefox'])
        self.assertIn('--frozen', calls[1])
        self.assertEqual(run.call_args_list[1].kwargs['env']['UV_LINK_MODE'], 'copy',
                         'Sealing the release must not change permissions on UV-cache aliases')
        self.assertTrue(calls[-1][-1].endswith('/browser-engine/launch.py'))
        self.assertEqual([call.kwargs['command_id'] for call in run.call_args_list],
                         ['browser.system-dependencies', 'browser.python-sync', 'browser.validate-launcher'])
        browser = self.installer.release / 'browsers/camoufox/browsers/official' / (pins['camoufoxVersion'] + '-' + pins['camoufoxBuild'])
        self.assertEqual((browser / 'camoufox').stat().st_mode & 0o777, 0o755)
        self.assertEqual(json.loads((browser / 'version.json').read_text())['sha256'], pins['camoufoxSha256'])

    def test_browser_cache_is_traversable_before_check_under_private_umask(self) -> None:
        """The root job's 0077 umask must not hide browser artifacts from service users."""
        self.installer.request['browser'] = True
        self.installer.node.parent.mkdir(parents=True)
        pins_path = self.installer.release / 'deploy/environment/runtime-pins.json'
        pins_path.parent.mkdir(parents=True)
        pins_path.write_bytes(Path(__file__).with_name('runtime-pins.json').read_bytes())
        pins = json.loads(pins_path.read_text())
        cache = self.installer.release / 'browsers'
        browser = cache / 'camoufox/browsers/official' / (pins['camoufoxVersion'] + '-' + pins['camoufoxBuild'])
        private_home = self.operation / 'build-home'
        private_home.mkdir(mode=0o700)
        private_file = private_home / 'private-fixture'
        private_file.write_text('keep private')
        private_file.chmod(0o600)
        checked = False

        def download(url: str, _digest: str, destination: Path, **_options) -> None:
            """Use local archives with explicit and implicitly created nested directories."""
            with zipfile.ZipFile(destination, 'w') as archive:
                if url == pins['uvUrl']:
                    archive.writestr('uv.data/scripts/uv', b'fixture')
                else:
                    executable = zipfile.ZipInfo('camoufox')
                    executable.external_attr = 0o100755 << 16
                    archive.writestr(executable, b'fixture')
                    archive.writestr('explicit/', b'')
                    archive.writestr('implicit/nested/resource.txt', b'fixture')

        def run(argv: list[str], **options) -> None:
            """Check access at the point the installer would drop privileges, not later."""
            nonlocal checked
            if not argv[-1].endswith('/browser-engine/launch.py'):
                return
            checked = True
            self.assertEqual(options['user'], 'outpost-build')
            self.assertEqual(options['env']['XDG_CACHE_HOME'], str(cache))
            self.assertTrue((cache / 'camoufox/fontconfig').is_dir())
            chown.assert_called_once_with(cache / 'camoufox/fontconfig', user='outpost-build', group='outpost-build')
            for directory in [cache, *(path for path in cache.rglob('*') if path.is_dir())]:
                self.assertEqual(directory.stat().st_mode & 0o777, 0o755, str(directory))
            self.assertEqual((browser / 'camoufox').stat().st_mode & 0o777, 0o755)
            self.assertEqual((browser / 'implicit/nested/resource.txt').stat().st_mode & 0o777, 0o644)
            self.assertEqual((browser / 'version.json').stat().st_mode & 0o777, 0o644)
            self.assertEqual(private_home.stat().st_mode & 0o777, 0o700)
            self.assertEqual(private_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual((self.operation / 'request.json').stat().st_mode & 0o777, 0o600)

        original_umask = os.umask(0o077)
        try:
            with patch.object(self.installer, 'run', side_effect=run), patch.object(self.installer, 'download', side_effect=download), patch.object(host.shutil, 'chown') as chown:
                self.installer.browsers()
        finally:
            os.umask(original_umask)
        self.assertTrue(checked, 'The unprivileged launcher check must still run')

    def test_progress_measures_finished_stages_and_does_not_claim_registration(self) -> None:
        """Server readiness is only 10/12; authentication happens later on the Mac."""
        with patch.multiple(self.installer, **{name: lambda: None for name in ('preflight', 'accounts', 'runtime', 'dependencies', 'browsers', 'configuration', 'enroll', 'services', 'health')}):
            self.installer.execute()
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(status['state'], 'ready')
        self.assertEqual(status['completedSteps'], 10)
        self.assertNotIn('password', (self.operation / 'status.json').read_text())
        self.assertEqual((self.operation / 'status.json').stat().st_mode & 0o777, 0o644)

    def test_failure_preserves_partial_files_and_never_removes_legacy_data(self) -> None:
        """Do not turn a failed setup into broad cleanup or fake success."""
        legacy = self.root / 'legacy-ledger'
        legacy.write_text('keep this data')
        with patch.object(self.installer, 'preflight'), patch.object(self.installer, 'accounts', side_effect=RuntimeError('fixture account failure')):
            self.installer.execute()
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(status['state'], 'failed')
        self.assertEqual(status['completedSteps'], 1)
        self.assertEqual(legacy.read_text(), 'keep this data')

    def test_cancel_is_a_boundary_request_not_a_service_uninstall(self) -> None:
        """Cancellation before stage one performs no command."""
        (self.operation / 'cancel').write_text('1')
        with patch.object(self.installer, 'preflight') as preflight:
            self.installer.execute()
            preflight.assert_not_called()
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(status['state'], 'cancelled')
        self.assertEqual(status['completedSteps'], 0)

    def test_units_and_secrets_are_separate_non_root_and_persistent(self) -> None:
        """Render real unit/config files while replacing only OS command execution."""
        with patch.object(self.installer, 'run'), patch.object(host.shutil, 'chown'):
            self.installer.accounts()
            (self.installer.release / 'package.json').write_text(json.dumps({'dependencies': {'@earendil-works/pi-coding-agent': '1.4.0'}}))
            (self.installer.release / 'package-lock.json').write_text('{}')
            self.installer.configuration()
            self.installer.services()
        worker = (host.UNIT_DIRECTORY / 'outpost-native-worker.service').read_text()
        coordinator = (host.UNIT_DIRECTORY / 'outpost-native-coordinator.service').read_text()
        self.assertIn('User=outpost-pi', worker)
        self.assertIn('User=outpost-coord', coordinator)
        self.assertIn('NoNewPrivileges=yes', worker)
        self.assertIn('WantedBy=multi-user.target', coordinator)
        self.assertNotIn('k3s', coordinator + worker)
        self.assertNotIn('sudo', coordinator + worker)
        self.assertNotIn(str(host.DATA / 'coordinator'), worker)
        self.assertEqual((host.CONFIG / 'coordinator.env').stat().st_mode & 0o777, 0o600)
        self.assertEqual((host.DATA / 'coordinator').stat().st_mode & 0o777, 0o700)
        self.assertEqual((host.DATA / 'workspaces').stat().st_mode & 0o7777, 0o2770)
        self.assertNotIn('OUTPOST_PAIRING_TOKEN', (host.CONFIG / 'worker.env').read_text())
        self.assertFalse((host.UNIT_DIRECTORY / host.HOST_UNIT).exists())
        self.assertFalse((host.CONFIG / 'coordinator/host-token').exists())
        self.assertNotIn('OUTPOST_FULL_CONTROL', (host.CONFIG / 'coordinator.env').read_text())

    def test_full_control_installs_separate_root_executor_and_coordinator_only_token(self) -> None:
        """Full authority is explicit; the model worker never receives root credentials."""
        self.request['fullControl'] = True
        host.atomic_json(self.operation / 'request.json', self.request)
        installer = host.Installer(self.operation)
        with patch.object(installer, 'run') as run, patch.object(host.shutil, 'chown'):
            installer.accounts()
            (installer.release / 'package.json').write_text(json.dumps({'dependencies': {'@earendil-works/pi-coding-agent': '1.4.0'}}))
            (installer.release / 'package-lock.json').write_text('{}')
            installer.configuration()
            installer.services()
        unit = (host.UNIT_DIRECTORY / host.HOST_UNIT).read_text()
        self.assertIn('User=root\n', unit)
        self.assertIn('deploy/agent/host-executor.mjs', unit)
        self.assertNotIn('ProtectHome=yes', unit)
        self.assertNotIn('ProtectSystem=strict', unit)
        self.assertIn('OUTPOST_HOST_MODE="native"', (host.CONFIG / 'host.env').read_text())
        self.assertIn('OUTPOST_FULL_CONTROL="true"', (host.CONFIG / 'coordinator.env').read_text())
        self.assertIn('OUTPOST_HOST_ENDPOINTS=', (host.CONFIG / 'coordinator.env').read_text())
        self.assertNotIn('OUTPOST_HOST_', (host.CONFIG / 'worker.env').read_text())
        secret = host.CONFIG / 'coordinator/host-token'
        self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
        self.assertEqual((host.CONFIG / 'host.env').stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(secret.read_text(), (host.CONFIG / 'coordinator/worker-token').read_text())
        self.assertNotIn(secret.read_text(), (self.operation / 'status.json').read_text())
        self.assertIn('Requires=outpost-native-worker.service ' + host.HOST_UNIT, (host.UNIT_DIRECTORY / 'outpost-native-coordinator.service').read_text())
        self.assertEqual(run.call_args.args[0], ['/usr/bin/systemctl', 'enable', '--now', *installer.units])
        with patch.object(installer, 'preflight', side_effect=RuntimeError('fixture')), patch.object(host.subprocess, 'run') as stop:
            installer.execute()
        self.assertEqual(stop.call_args.args[0], ['/usr/bin/systemctl', 'disable', '--now', *installer.units])

    def test_host_readiness_requires_authenticated_root_evidence(self) -> None:
        """A healthy HTTP server or non-root command is not proof of full access."""
        from unittest.mock import MagicMock
        secret = host.CONFIG / 'coordinator/host-token'
        secret.parent.mkdir(parents=True)
        secret.write_text('fixture-host-token')
        opener = MagicMock()
        output = opener.open.return_value.__enter__.return_value
        for value in ({'host': 'local', 'exitCode': 0, 'stdout': '1000\n'},
                      {'host': 'other', 'exitCode': 0, 'stdout': '0\n'},
                      {'host': 'local', 'exitCode': 0, 'stdout': '0\n', 'timedOut': True}):
            output.read.return_value = json.dumps(value).encode()
            with self.assertRaises(ValueError):
                self.installer.verify_host_control(opener)
        output.read.return_value = json.dumps({'host': 'local', 'exitCode': 0, 'stdout': '0\n'}).encode()
        self.installer.verify_host_control(opener)
        sent = opener.open.call_args.args[0]
        self.assertEqual(sent.get_header('Authorization'), 'Bearer fixture-host-token')
        self.assertEqual(json.loads(sent.data)['command'], '/usr/bin/id -u')

    def test_duplicate_bootstrap_only_reads_the_existing_receipt(self) -> None:
        """A lost SSH reply cannot launch a second root operation on explicit retry."""
        packet = request()
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:gz') as archive:
            member = tarfile.TarInfo('deploy/environment/host_install.py')
            member.size = 4
            archive.addfile(member, io.BytesIO(b'pass'))
        payload = content.getvalue()
        packet.update(size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        wire = json.dumps(packet).encode() + b'\n' + payload
        owner = os.geteuid()
        with patch.object(host.os, 'geteuid') as geteuid, patch.object(host.os, 'chown'), patch.object(host, 'capture_command', return_value=('succeeded', 0)) as launch:
            for _ in range(2):
                geteuid.side_effect = itertools.chain([0], itertools.repeat(owner))
                stream = io.TextIOWrapper(io.BytesIO(wire))
                with patch.object(host.sys, 'stdin', stream), patch.object(host.sys, 'stdout', io.StringIO()):
                    host.bootstrap()
            self.assertEqual(launch.call_count, 1)
        status = json.loads((host.OPERATIONS / packet['operationId'] / 'status.json').read_text())
        self.assertEqual(status['state'], 'queued')
        self.assertEqual(status['completedSteps'], 0)

    def test_installer_source_has_no_kubernetes_or_legacy_destructive_commands(self) -> None:
        """Keep the coexistence promise explicit in this narrow installer."""
        source = Path(host.__file__).read_text()
        for forbidden in ('k3s-uninstall', 'k3s-killall', 'kubectl', 'NOPASSWD', 'rmtree('):
            self.assertNotIn(forbidden, source)
        self.assertNotEqual(os.geteuid(), 0, 'These local contract tests should not run as root')


if __name__ == '__main__':
    unittest.main()
