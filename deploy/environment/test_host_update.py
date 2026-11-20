"""Synthetic filesystem/failure tests. Never invoke SSH, sudo, systemd or a live host."""
import base64
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import urllib.error
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch
import host_update as update


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('CONFIG', 'DATA', 'PREFIX', 'UNIT_DIRECTORY', 'OPERATIONS'):
            path = self.root / name
            path.mkdir()
            self.patch = patch.object(update, name, path)
            self.patch.start()
            self.addCleanup(self.patch.stop)
        self.source = dict(schema=2, id='host-' + 'a'*20, sequence=1, compatibility='native-v1',
                           layoutVersion=1, protocolVersion=2, rollback=True, piVersion='1.4.0', extensions=[])
        self.target = dict(self.source, id='host-' + 'b'*20, sequence=2)
        self.request = dict(operationId=str(uuid.uuid4()), environmentId=str(uuid.uuid4()), deviceId=str(uuid.uuid4()),
                            releaseId=self.target['id'], expectedRelease=self.source['id'], sha256='a'*64,
                            size=100, target=self.target)
        self.operation = update.OPERATIONS / self.request['operationId']
        self.operation.mkdir()
        (self.operation / 'request.json').write_text(json.dumps(self.request))
        (self.operation / 'status.json').write_text(json.dumps(dict(state='queued')))
        (update.CONFIG / 'installation.json').write_text(json.dumps(dict(environmentId=self.request['environmentId'], release=self.source['id'], fullControl=True)))
        self.updater = update.Updater(self.operation)
        self.updater.previous.mkdir(parents=True)
        (update.PREFIX / 'current').symlink_to(self.updater.previous)
        (self.updater.previous / 'host-manifest.json').write_text(json.dumps(self.source))
        for root in (self.updater.previous, self.operation / 'source'):
            (root / 'deploy/environment').mkdir(parents=True)
            (root / 'deploy/environment/runtime-pins.json').write_text('{"pin":"synthetic"}')
            for entrypoint in ('server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'):
                path = root / entrypoint
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('// service fixture')
        self.history = update.DATA / 'history'
        self.history.write_bytes(b'private-history-canary')
        self.calls = []
        for name in ('run', 'checkpoint', 'stage', 'health', 'release_hold'):
            patcher = patch.object(self.updater, name, side_effect=lambda *args, name=name: self.calls.append((name, args)))
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_packet_and_manifest_binding(self):
        self.assertEqual(update.validate(self.request), self.request)
        self.assertTrue(update.compatible(self.source, self.target))
        for change in ({'sequence': 1}, {'rollback': False}, {'schema': 1}, {'layoutVersion': 2}, {'protocolVersion': 1}):
            self.assertFalse(update.compatible(self.source, dict(self.target, **change)))
        for change in ({'size': True}, {'size': 20*1024*1024}, {'operationId': '../escape'}, {'sha256': 'bad'}, {'releaseId': self.source['id']}):
            with self.assertRaises((ValueError, TypeError)):
                update.validate(dict(self.request, **change))

    def test_stale_or_partial_targets_fail_before_staging(self):
        self.updater.preflight()
        self.updater.release.mkdir()
        with self.assertRaises(ValueError):
            self.updater.preflight()
        self.assertEqual(self.history.read_bytes(), b'private-history-canary')

    def assert_preflight_failure(self, code, message):
        """Known refusals publish safe receipts without touching installation or dispatch."""
        roots = (update.CONFIG, update.DATA, update.PREFIX, update.UNIT_DIRECTORY, self.operation / 'source')

        def snapshot():
            return {str(path): ('link', str(path.readlink())) if path.is_symlink()
                    else ('directory',) if path.is_dir() else ('file', path.read_bytes())
                    for root in roots for path in root.rglob('*')}

        before = snapshot()
        with patch.object(self.updater, 'switch'), patch.object(self.updater, 'rollback') as rollback:
            self.updater.execute()
            self.updater.switch.assert_not_called()
            rollback.assert_not_called()
        self.updater.stage.assert_not_called()
        self.updater.health.assert_not_called()
        self.updater.release_hold.assert_not_called()
        self.updater.run.assert_not_called()
        self.assertFalse(self.updater.switched)
        self.assertFalse(self.updater.committed)
        self.assertEqual(self.calls, [('checkpoint', ('abort',))])
        self.assertEqual(snapshot(), before)
        receipt = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(receipt['state'], 'failed')
        self.assertEqual(receipt['failureStage'], 'preflight')
        self.assertEqual(receipt['failureCode'], code)
        self.assertEqual(receipt['stage'], message)
        self.assertNotIn(str(self.root), json.dumps(receipt))
        self.assertNotIn('private-', json.dumps(receipt))

    def test_runtime_pin_additions_require_separate_migration_before_staging(self):
        """New Camoufox fields are not silently accepted over a deployed browser baseline."""
        pins = dict(pin='synthetic', camoufoxVersion='private-version', camoufoxBuild='private-build',
                    camoufoxUrl='https://example.invalid/private-token', camoufoxSha256='f'*64,
                    camoufoxInterface='private-interface')
        (self.operation / 'source/deploy/environment/runtime-pins.json').write_text(json.dumps(pins))
        (update.DATA / 'coordinator').mkdir()
        (update.DATA / 'coordinator/ledger.sqlite').write_bytes(b'private-dispatch-policy-and-history')
        (update.CONFIG / 'coordinator.env').write_text('PRIVATE_KEY="private-secret"\n')
        (update.UNIT_DIRECTORY / self.updater.units[0]).write_text('private-unit-config')
        self.assert_preflight_failure('runtime_pins_mismatch',
                                     'This release requires a separate browser/runtime migration; no activation occurred')
        self.assertFalse(self.updater.release.exists())

    def test_runtime_pin_guard_remains_byte_equal(self):
        (self.operation / 'source/deploy/environment/runtime-pins.json').write_text('{ "pin": "synthetic" }\n')
        self.assert_preflight_failure('runtime_pins_mismatch',
                                     'This release requires a separate browser/runtime migration; no activation occurred')

    def test_installation_changed_has_specific_receipt(self):
        self.updater.installation['environmentId'] = str(uuid.uuid4())
        self.assert_preflight_failure('installation_changed',
                                     'Installation changed; no activation occurred')

    def test_existing_target_has_specific_receipt(self):
        self.updater.release.mkdir()
        (self.updater.release / 'partial').write_bytes(b'private-partial-release')
        self.assert_preflight_failure('target_already_exists',
                                     'Target release already exists; no activation occurred')

    def test_changed_paths_have_specific_receipt(self):
        (update.PREFIX / 'current').unlink()
        (update.PREFIX / 'current').symlink_to(self.operation / 'source')
        self.assert_preflight_failure('release_paths_changed',
                                     'Release paths changed; no activation occurred')

    def test_unsupported_manifest_has_specific_receipt(self):
        (self.updater.previous / 'host-manifest.json').write_text(json.dumps(dict(self.source, schema=1)))
        self.assert_preflight_failure('unsupported_manifest',
                                     'Release manifests do not support this update; no activation occurred')

    def test_unexpected_preflight_error_is_not_exposed_or_classified_by_text(self):
        with patch.object(self.updater, 'preflight', side_effect=ValueError('Installation changed: private-secret')):
            self.assert_preflight_failure('preflight_failed',
                                         'Update stopped before activation; previous release remains active')

    def test_abort_failure_retains_original_preflight_cause(self):
        (self.operation / 'source/deploy/environment/runtime-pins.json').write_text('private-new-pins')
        self.updater.checkpoint.side_effect = RuntimeError('private-abort-secret')
        self.updater.execute()
        receipt = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(receipt['state'], 'needs_attention')
        self.assertEqual(receipt['failureStage'], 'preflight')
        self.assertEqual(receipt['failureCode'], 'runtime_pins_mismatch')
        self.assertNotIn('private-', json.dumps(receipt))
        self.updater.stage.assert_not_called()
        self.updater.release_hold.assert_not_called()

    def test_stage_failure_keeps_old_release_without_acquiring_or_releasing_a_hold(self):
        self.updater.stage.side_effect = RuntimeError('private-stage-secret')
        self.updater.execute()
        self.assertEqual(self.updater.status['state'], 'failed')
        self.assertEqual(update.PREFIX.joinpath('current').resolve(), self.updater.previous.resolve())
        self.assertEqual(self.calls[-1], ('checkpoint', ('abort',)))
        receipt = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(receipt['failureCode'], 'staging_failed')
        self.assertEqual(receipt['failureStage'], 'staging')
        self.assertNotIn('private-stage-secret', json.dumps(receipt))
        self.updater.release_hold.assert_not_called()
        self.updater.health.assert_not_called()
        self.assertEqual(self.history.read_bytes(), b'private-history-canary')

    def test_runtime_qualification_has_private_unprivileged_cache_context(self):
        with patch.object(update.shutil, 'chown'):
            self.updater.qualify_runtime()
        argv = self.calls[-1][1][0]
        self.assertEqual(argv[:4], ['/usr/sbin/runuser', '-u', 'outpost-build', '--'])
        self.assertIn('JITI_FS_CACHE=false', argv)
        self.assertIn(f'TMPDIR={self.operation}/qualification', argv)

    def test_staging_precedes_any_idle_request(self):
        with patch.object(self.updater, 'switch', side_effect=lambda: self.calls.append(('switch', ()))):
            self.updater.execute()
        self.assertLess(self.calls.index(('stage', ())), self.calls.index(('checkpoint', ('prepare',))))
        self.assertLess(self.calls.index(('checkpoint', ('check',))), self.calls.index(('switch', ())))
        self.assertEqual(self.updater.status['state'], 'complete')

    def assert_no_activation(self):
        """Cancellation must leave the original installation and private data untouched."""
        self.updater.switch.assert_not_called()
        self.updater.health.assert_not_called()
        self.updater.release_hold.assert_not_called()
        self.updater.run.assert_not_called()
        self.assertFalse(self.updater.switched)
        self.assertFalse(self.updater.committed)
        self.assertEqual(self.updater.status['state'], 'failed')
        self.assertEqual(update.PREFIX.joinpath('current').resolve(), self.updater.previous.resolve())
        self.assertEqual(json.loads((update.CONFIG / 'installation.json').read_text())['release'], self.source['id'])
        self.assertEqual(self.history.read_bytes(), b'private-history-canary')

    def test_cancel_before_host_launch_blocks_late_job_at_stage_checkpoint(self):
        """A queued host job cannot stage after its coordinator operation is cancelled."""
        def checkpoint(action):
            self.calls.append(('checkpoint', (action,)))
            if action != 'abort':
                raise subprocess.CalledProcessError(1, ['update-checkpoint', action])

        self.updater.checkpoint.side_effect = checkpoint
        with patch.object(self.updater, 'switch'):
            self.updater.execute()
            self.assert_no_activation()
        self.updater.stage.assert_not_called()
        self.assertEqual(self.calls, [('checkpoint', ('stage',)), ('checkpoint', ('abort',))])

    def test_cancel_during_staging_blocks_prepare_even_when_staging_finishes_late(self):
        """Late successful staging cannot move a cancelled operation into draining."""
        cancelled = False

        def stage():
            nonlocal cancelled
            self.calls.append(('stage', ()))
            cancelled = True

        def checkpoint(action):
            self.calls.append(('checkpoint', (action,)))
            if cancelled and action != 'abort':
                raise subprocess.CalledProcessError(1, ['update-checkpoint', action])

        self.updater.stage.side_effect = stage
        self.updater.checkpoint.side_effect = checkpoint
        with patch.object(self.updater, 'switch'):
            self.updater.execute()
            self.assert_no_activation()
        self.updater.stage.assert_called_once_with()
        self.assertEqual(self.calls, [('checkpoint', ('stage',)), ('stage', ()),
                                     ('checkpoint', ('prepare',)), ('checkpoint', ('abort',))])

    def test_cancel_while_waiting_blocks_activation_on_the_next_checkpoint(self):
        """Cancellation is fatal, not another retryable waiting-for-idle result."""
        cancelled = False

        def cancel(_seconds):
            nonlocal cancelled
            self.assertEqual(self.updater.status['state'], 'waiting_for_idle')
            cancelled = True

        def checkpoint(action):
            self.calls.append(('checkpoint', (action,)))
            if action == 'check':
                raise subprocess.CalledProcessError(1 if cancelled else 2, ['update-checkpoint', action])

        self.updater.checkpoint.side_effect = checkpoint
        with patch.object(self.updater, 'switch'), patch.object(update.time, 'sleep', side_effect=cancel) as sleep, \
                patch.object(update.time, 'monotonic', side_effect=[0, 1, 2, 901]):
            self.updater.execute()
            self.assert_no_activation()
        sleep.assert_called_once_with(2)
        self.assertEqual(self.calls, [('checkpoint', ('stage',)), ('stage', ()), ('checkpoint', ('prepare',)),
                                     ('checkpoint', ('check',)), ('checkpoint', ('check',)), ('checkpoint', ('abort',))])

    def test_rollback_failure_retains_hold(self):
        def switch():
            self.updater.switched = True
            raise RuntimeError('synthetic activation failure')
        with patch.object(self.updater, 'switch', side_effect=switch), patch.object(self.updater, 'rollback', side_effect=RuntimeError('synthetic rollback failure')):
            self.updater.execute()
        self.assertEqual(self.updater.status['state'], 'needs_attention')
        self.updater.release_hold.assert_not_called()
        self.assertEqual(self.history.read_bytes(), b'private-history-canary')

    def test_late_release_failure_never_rolls_back_under_admitted_work(self):
        self.updater.release_hold.side_effect = RuntimeError('reply lost after dispatch resumed')
        with patch.object(self.updater, 'switch', side_effect=lambda: setattr(self.updater, 'switched', True)), patch.object(self.updater, 'rollback') as rollback:
            self.updater.execute()
            rollback.assert_not_called()
        self.assertEqual(self.updater.status['state'], 'needs_attention')
        self.assertEqual(json.loads((update.CONFIG / 'installation.json').read_text())['release'], self.target['id'])

    def test_switch_keeps_browser_configuration_and_credentials(self):
        shutil.copytree(self.operation / 'source', self.updater.release)
        original = str(self.updater.previous)
        (update.CONFIG / 'coordinator.env').write_text(f'OUTPOST_RUNTIME_RELEASE="{self.source["id"]}"\nOUTPOST_CAMOUFOX_PYTHON="{original}/server/browser-engine/.venv/bin/python"\nPRIVATE_KEY="synthetic-secret"\n')
        (update.CONFIG / 'worker.env').write_text(f'OUTPOST_PI_RELEASE_FILE="{original}/pi-release.json"\nPI_CODING_AGENT_DIR="/retained/profile"\n')
        for unit in self.updater.units:
            (update.UNIT_DIRECTORY / unit).write_text(f'ExecStart={original}/node/bin/node\n')
        self.updater.switch()
        text = (update.CONFIG / 'coordinator.env').read_text()
        self.assertIn('PRIVATE_KEY="synthetic-secret"', text)
        self.assertIn(original + '/server/browser-engine/.venv/bin/python', text)
        self.assertIn(self.target['id'], text)
        self.updater.rollback()
        self.assertIn(self.source['id'], (update.CONFIG / 'coordinator.env').read_text())
        self.assertEqual(self.history.read_bytes(), b'private-history-canary')

    def test_missing_worker_entrypoint_fails_preflight_before_staging(self):
        (self.operation / 'source/server/pi-worker/main.ts').unlink()
        self.assert_preflight_failure('missing_service_files',
                                     'Release service entrypoints are missing or unsafe; no activation occurred')

    def test_switch_rechecks_entrypoints_before_backups_or_stop(self):
        shutil.copytree(self.operation / 'source', self.updater.release)
        (self.updater.release / 'server/pi-worker/main.ts').unlink()
        with self.assertRaises(update.PreflightFailure):
            self.updater.switch()
        self.assertFalse((self.operation / 'previous').exists())
        self.updater.run.assert_not_called()
        self.assertFalse(self.updater.switched)

    def test_service_entrypoint_symlink_is_not_accepted(self):
        entrypoint = self.operation / 'source/server/pi-worker/main.ts'
        entrypoint.unlink()
        entrypoint.symlink_to(self.history)
        with self.assertRaises(update.PreflightFailure):
            self.updater.preflight()


class StagingSecurityTests(unittest.TestCase):
    def setUp(self):
        UpdateTests.setUp(self)
        self.source_root = self.operation / 'source'
        (self.updater.previous / 'node/bin').mkdir(parents=True)
        (self.updater.previous / 'node/bin/node').write_bytes(b'trusted node executable')
        (self.updater.previous / 'node/bin/node').chmod(0o755)
        (self.updater.previous / 'node/lib/node_modules/npm/bin').mkdir(parents=True)
        (self.updater.previous / 'node/lib/node_modules/npm/bin/npm-cli.js').write_bytes(b'trusted npm entrypoint')
        self.package_path = 'node_modules/@earendil-works/pi-coding-agent'
        self.archive_bytes = self.package_archive({'package.json': b'{"version":"1.4.0"}',
                                                   'index.js': b'approved dependency bytes', 'bin/cli.js': b'approved cli'})
        self.integrity = 'sha512-' + base64.b64encode(hashlib.sha512(self.archive_bytes).digest()).decode()
        self.lock = {'lockfileVersion': 3, 'packages': {'': {}, self.package_path: {
            'version': '1.4.0', 'integrity': self.integrity, 'bin': {'pi': 'bin/cli.js'}}}}
        (self.source_root / 'package.json').write_text(json.dumps({'dependencies': {'@earendil-works/pi-coding-agent': '1.4.0'}}))
        (self.source_root / 'package-lock.json').write_text(json.dumps(self.lock))
        self.kept = []
        self.addCleanup(lambda: [stream.close() for stream in self.kept])

    @staticmethod
    def package_archive(files, extra=(), wrapper='package'):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(wrapper + '/' + name)
                member.size = len(content)
                member.mode = 0o755 if name.startswith('bin/') else 0o644
                archive.addfile(member, io.BytesIO(content))
            for member in extra:
                archive.addfile(member)
        return output.getvalue()

    def cache(self, payload=None):
        digest = hashlib.sha512(self.archive_bytes).hexdigest()
        path = self.operation / 'build-home/cache/_cacache/content-v2/sha512' / digest[:2] / digest[2:4] / digest[4:]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.archive_bytes if payload is None else payload)
        return path

    def build(self, argv, **kwargs):
        workspace = kwargs['cwd']
        self.assertEqual(workspace, self.operation / 'dependency-build')
        self.assertEqual(argv[0], str(self.updater.previous / 'node/bin/node'))
        self.assertEqual(kwargs['user'], 'outpost-build')
        self.assertIn('--ignore-scripts', argv)
        self.assertFalse(self.updater.release.exists())
        for name in ('package.json', 'package-lock.json'):
            self.assertEqual((workspace / name).stat().st_mode & 0o777, 0o644)
        # Simulate a compromised build account replacing everything it controls and
        # retaining writable FDs. None of these inodes may become final runtime files.
        for name in ('node/bin/node', 'deploy/agent/host-executor.mjs', self.package_path + '/index.js'):
            path = workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'builder injected bytes')
            self.kept.append(path.open('r+b'))
        (workspace / 'package-lock.json').write_text('{"attacker":"lockfile"}')
        self.kept.append(self.cache().open('r+b'))

    def stage(self, build=None):
        with patch.object(update, 'run_as_user', side_effect=build or self.build), \
                patch.object(update.shutil, 'chown') as chown, patch.object(self.updater, 'qualify_runtime'):
            update.Updater.stage(self.updater)
            self.assertEqual({call.args[0] for call in chown.call_args_list},
                             {self.operation / 'build-home', self.operation / 'dependency-build'})

    def test_builder_node_source_dependency_edits_and_retained_fds_are_never_promoted(self):
        self.stage()
        for source in self.kept:
            source.seek(0)
            source.write(b'post-promotion retained fd attack')
            source.flush()
        self.assertEqual((self.updater.release / 'node/bin/node').read_bytes(), b'trusted node executable')
        self.assertEqual((self.updater.release / 'deploy/agent/host-executor.mjs').read_bytes(), b'// service fixture')
        self.assertEqual((self.updater.release / self.package_path / 'index.js').read_bytes(), b'approved dependency bytes')
        self.assertEqual(json.loads((self.updater.release / 'package-lock.json').read_text()), self.lock)
        for name, source in (('node/bin/node', self.updater.previous), ('deploy/agent/host-executor.mjs', self.source_root)):
            self.assertNotEqual((self.updater.release / name).stat().st_ino, (source / name).stat().st_ino)
        self.assertEqual((self.updater.release / 'node_modules/.bin/pi').resolve(),
                         self.updater.release / self.package_path / 'bin/cli.js')
        self.assertEqual((self.updater.previous / 'node/bin/node').read_bytes(), b'trusted node executable')
        self.assertEqual((self.source_root / 'deploy/agent/host-executor.mjs').read_bytes(), b'// service fixture')

    def test_staging_with_root_service_umask_keeps_npm_inputs_readable(self):
        previous = os.umask(0o077)
        try:
            self.stage()
        finally:
            os.umask(previous)

    def test_hostile_symlink_swap_at_ownership_handoff_cannot_overwrite_or_chmod_root_files(self):
        workspace = self.operation / 'dependency-build'
        protected = {}
        for name in ('package.json', 'package-lock.json'):
            path = self.root / ('protected-' + name)
            path.write_bytes(b'private root-only canary')
            path.chmod(0o600)
            protected[name] = path
        handed_off = False
        original_copyfile, original_chmod = shutil.copyfile, Path.chmod

        def handoff(directory, **kwargs):
            nonlocal handed_off
            if directory != workspace:
                return
            # An already-running build-user process attacks immediately at chown,
            # before npm is invoked. Do not assume the workspace is still empty.
            handed_off = True
            for name, victim in protected.items():
                destination = workspace / name
                destination.unlink(missing_ok=True)
                destination.symlink_to(victim)

        def copyfile(source, destination, **kwargs):
            self.assertFalse(handed_off and workspace in Path(destination).parents,
                             'privileged pathname copy after handoff')
            return original_copyfile(source, destination, **kwargs)

        def chmod(path, mode, **kwargs):
            self.assertFalse(handed_off and workspace in path.parents,
                             'privileged pathname chmod after handoff')
            return original_chmod(path, mode, **kwargs)

        def build(argv, **kwargs):
            self.assertTrue(handed_off)
            for name, victim in protected.items():
                self.assertEqual((workspace / name).readlink(), victim)
                self.assertEqual(victim.read_bytes(), b'private root-only canary')
                self.assertEqual(victim.stat().st_mode & 0o777, 0o600)
            self.cache()

        with patch.object(update.shutil, 'chown', side_effect=handoff), \
                patch.object(update.shutil, 'copyfile', side_effect=copyfile), patch.object(Path, 'chmod', chmod), \
                patch.object(update, 'run_as_user', side_effect=build), \
                patch.object(self.updater, 'qualify_runtime'):
            update.Updater.stage(self.updater)
        for victim in protected.values():
            self.assertEqual(victim.read_bytes(), b'private root-only canary')
            self.assertEqual(victim.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.updater.release / 'package-lock.json').read_text()), self.lock)

    def test_inputs_are_fully_populated_and_chmodded_before_any_build_ownership_handoff(self):
        workspace = self.operation / 'dependency-build'

        def handoff(directory, **kwargs):
            for name in ('package.json', 'package-lock.json'):
                self.assertEqual((workspace / name).read_bytes(), (self.source_root / name).read_bytes())
                self.assertEqual((workspace / name).stat().st_mode & 0o777, 0o644)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)

        with patch.object(update.shutil, 'chown', side_effect=handoff), \
                patch.object(update, 'run_as_user', side_effect=self.build), \
                patch.object(self.updater, 'qualify_runtime'):
            update.Updater.stage(self.updater)

    def test_cache_integrity_failure_never_promotes_or_activates(self):
        def build(argv, **kwargs):
            self.build(argv, **kwargs)
            self.cache(b'attacker supplied tarball')
        with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
            self.stage(build)
        self.assertFalse(self.updater.release.exists())
        self.assertEqual((update.PREFIX / 'current').resolve(), self.updater.previous)

    def test_cache_symlink_and_symlink_ancestor_are_refused(self):
        for ancestor in (False, True):
            path = self.cache()
            if ancestor:
                parent = path.parent
                moved = parent.with_name(parent.name + '-moved')
                parent.rename(moved)
                parent.symlink_to(moved)
            else:
                path.unlink()
                path.symlink_to(self.history)
            with self.subTest(ancestor=ancestor), self.assertRaises(OSError):
                update.cached_package(self.operation / 'build-home/cache', self.integrity)
            if ancestor:
                parent.unlink()
                moved.rename(parent)
            else:
                path.unlink()

    def test_dependency_cache_snapshot_is_independent_of_retained_writes(self):
        path = self.cache()
        with path.open('r+b') as writable:
            snapshot = update.cached_package(self.operation / 'build-home/cache', self.integrity)
            writable.seek(0)
            writable.write(b'changed after snapshot')
            writable.flush()
        destination = self.operation / 'safe-package'
        update.unpack_dependency(snapshot, destination)
        self.assertEqual((destination / 'index.js').read_bytes(), b'approved dependency bytes')

    def test_dependency_tar_links_traversal_duplicates_and_bundles_refused(self):
        for name, kind in (('package/../escape', tarfile.DIRTYPE), ('/absolute', tarfile.DIRTYPE),
                           ('package/link', tarfile.SYMTYPE), ('package/link', tarfile.LNKTYPE),
                           ('package/fifo', tarfile.FIFOTYPE), ('package/index.js', tarfile.REGTYPE),
                           ('package/node_modules/bundled', tarfile.DIRTYPE)):
            member = tarfile.TarInfo(name)
            member.type, member.linkname = kind, '/private/secret'
            payload = self.package_archive({'index.js': b'approved'}, [member])
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                update.unpack_dependency(payload, self.operation / 'never-written')
        self.assertFalse((self.operation / 'never-written').exists())

    @unittest.skipUnless(shutil.which('npm'), 'npm required for the offline cache contract test')
    def test_real_offline_npm_cache_is_promoted_by_lock_integrity_not_installed_files(self):
        workspace, cache = self.root / 'offline-npm', self.root / 'offline-cache'
        workspace.mkdir()
        (workspace / 'package.json').write_text('{"name":"qualification","version":"1.0.0","private":true}')
        tarball = self.root / 'dependency.tgz'
        tarball.write_bytes(self.package_archive({'package.json': b'{"name":"qualification-dependency","version":"1.0.0"}',
                                                  'index.js': b'approved from real npm cache'}))
        subprocess.run([shutil.which('npm'), 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
                        '--cache', str(cache), str(tarball)], cwd=workspace,
                       env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(workspace),
                            'NPM_CONFIG_USERCONFIG': str(workspace / 'user-npmrc'),
                            'NPM_CONFIG_GLOBALCONFIG': str(workspace / 'global-npmrc')},
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
        lock = json.loads((workspace / 'package-lock.json').read_text())
        dependency = 'node_modules/qualification-dependency/index.js'
        (workspace / dependency).write_bytes(b'compromised after npm completed')
        destination = self.root / 'verified-real-cache'
        update.promote_dependencies(lock, workspace, cache, destination)
        self.assertEqual((destination / dependency).read_bytes(), b'approved from real npm cache')

    def test_npm_type_packages_strip_one_consistent_nonliteral_wrapper(self):
        for wrapper in ('node', 'pg', 'retry', './node'):
            with self.subTest(wrapper=wrapper):
                destination = self.root / ('wrapper-' + wrapper.replace('/', '-'))
                payload = self.package_archive({'package.json': b'{"name":"@types/fixture"}', 'index.d.ts': b'export {}'}, wrapper=wrapper)
                update.unpack_dependency(payload, destination)
                self.assertEqual((destination / 'index.d.ts').read_bytes(), b'export {}')
                self.assertFalse((destination / wrapper).exists())

    def test_nonliteral_wrapper_rejects_mixed_roots_duplicates_and_traversal(self):
        for name, kind in (('pg/LICENSE', tarfile.REGTYPE), ('./node/index.js', tarfile.REGTYPE),
                           ('node/../escape', tarfile.REGTYPE), ('/node/absolute', tarfile.REGTYPE),
                           ('node/link', tarfile.SYMTYPE), ('node/link', tarfile.LNKTYPE)):
            member = tarfile.TarInfo(name)
            member.type, member.linkname = kind, '../secret'
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                update.unpack_dependency(self.package_archive({'index.js': b'approved'}, [member], wrapper='node'),
                                         self.root / 'not-extracted')
        self.assertFalse((self.root / 'not-extracted').exists())

    def test_identical_normalized_files_are_extracted_once_but_conflicts_are_rejected(self):
        payload = self.package_archive({'./dist/index.js': b'approved', 'dist/index.js': b'approved'})
        destination = self.root / 'identical-normalized'
        update.unpack_dependency(payload, destination)
        self.assertEqual((destination / 'dist/index.js').read_bytes(), b'approved')
        self.assertEqual(len(list(destination.rglob('index.js'))), 1)
        conflict = self.package_archive({'./dist/index.js': b'approved', 'dist/index.js': b'replaced'})
        with self.assertRaises(ValueError):
            update.unpack_dependency(conflict, self.root / 'different-bytes')
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for mode in (0o644, 0o755):
                member = tarfile.TarInfo('package/index.js')
                member.mode, member.size = mode, 4
                archive.addfile(member, io.BytesIO(b'same'))
        with self.assertRaises(ValueError):
            update.unpack_dependency(output.getvalue(), self.root / 'different-mode')
        self.assertFalse((self.root / 'different-bytes').exists())
        self.assertFalse((self.root / 'different-mode').exists())

    def bin_collision(self):
        self.cache()
        lock = {'lockfileVersion': 3, 'packages': {name: {'integrity': self.integrity, 'bin': {'playwright-core': 'bin/cli.js'}}
                for name in ('node_modules/playwright-core', 'node_modules/playwright-camoufox')}}
        workspace = self.root / 'bin-workspace'
        link = workspace / 'node_modules/.bin/playwright-core'
        link.parent.mkdir(parents=True)
        return lock, workspace, link

    def test_collision_uses_only_npm_selected_lockfile_candidate(self):
        lock, workspace, hint = self.bin_collision()
        for index, name in enumerate(('playwright-camoufox', 'playwright-core')):
            with self.subTest(selected=name):
                hint.symlink_to('../' + name + '/bin/cli.js')
                destination = self.root / ('bin-result-' + str(index))
                update.promote_dependencies(lock, workspace, self.operation / 'build-home/cache', destination)
                promoted = destination / 'node_modules/.bin/playwright-core'
                self.assertEqual(promoted.readlink(), hint.readlink())
                self.assertEqual(promoted.resolve().read_bytes(), b'approved cli')
                hint.unlink()
                hint.symlink_to('/etc/passwd')
                self.assertEqual(promoted.resolve(), destination / 'node_modules' / name / 'bin/cli.js')
                hint.unlink()

    def test_collision_rejects_absent_regular_or_unapproved_builder_hint(self):
        lock, workspace, hint = self.bin_collision()
        for index, target in enumerate((None, 'regular', '/etc/passwd', '../unapproved/cli.js',
                                        '../playwright-core/../../../secret', '../playwright-core/index.js')):
            if target == 'regular':
                hint.write_text('arbitrary executable')
            elif target is not None:
                hint.symlink_to(target)
            destination = self.root / ('invalid-bin-' + str(index))
            with self.subTest(target=target), self.assertRaises(ValueError):
                update.promote_dependencies(lock, workspace, self.operation / 'build-home/cache', destination)
            self.assertFalse((destination / 'node_modules/.bin/playwright-core').exists())
            if target is not None:
                hint.unlink()

    def test_dependency_expansion_and_lockfile_path_bounds(self):
        with patch.object(update, 'DEPENDENCY_EXPANDED_LIMIT', 1024), self.assertRaises(ValueError):
            update.unpack_dependency(gzip.compress(b'\0'*2048), self.operation / 'bounded')
        for name in ('../outside', 'node_modules/../../outside', 'node_modules/example/../../../outside'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                update.promote_dependencies({'lockfileVersion': 3, 'packages': {name: {'integrity': self.integrity}}},
                                            self.operation, self.operation, self.operation / 'destination')
        with self.assertRaises(ValueError):
            update.cached_package(self.operation, 'sha1-unqualified')


@unittest.skipUnless(os.environ.get('OUTPOST_TEST_NPM_CACHE') and shutil.which('npm') and shutil.which('node'),
                     'Set OUTPOST_TEST_NPM_CACHE to run both complete cached lockfile qualification regressions')
class LockedPackageQualificationTests(unittest.TestCase):
    """Read the opt-in shared cache only; npm and runtime effects stay in disposable directories."""

    def qualify_lock(self, relative):
        root = Path(__file__).resolve().parents[2]
        package_root = root / relative
        shared_cache = Path(os.environ['OUTPOST_TEST_NPM_CACHE']).resolve()
        lock = json.loads((package_root / 'package-lock.json').read_text())
        with tempfile.TemporaryDirectory(prefix='outpost-locked-qualification-') as temporary:
            directory = Path(temporary).resolve()
            workspace, cache, release = (directory / name for name in ('workspace', 'cache', 'release'))
            workspace.mkdir()
            # Seed only SRI-verified objects into a disposable npm cache. No npm command
            # may write to the developer's existing cache or read their npm credentials.
            for name, package in lock['packages'].items():
                if not name:
                    continue
                try:
                    payload = update.cached_package(shared_cache, package['integrity'])
                except FileNotFoundError:
                    if package.get('optional'):
                        continue
                    self.fail('Required locked package is missing from the opt-in cache: ' + name)
                algorithm, encoded = package['integrity'].split('-', 1)
                digest = base64.b64decode(encoded).hex()
                path = cache / '_cacache/content-v2' / algorithm / digest[:2] / digest[2:4] / digest[4:]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
            for name in ('package.json', 'package-lock.json'):
                shutil.copyfile(package_root / name, workspace / name)
            environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(directory), 'TMPDIR': str(directory),
                           'NPM_CONFIG_USERCONFIG': str(directory / 'user-npmrc'),
                           'NPM_CONFIG_GLOBALCONFIG': str(directory / 'global-npmrc'),
                           'JITI_FS_CACHE': 'false', 'TSX_DISABLE_CACHE': '1', 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1'}
            npm = subprocess.run([shutil.which('npm'), 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
                                  '--cache', str(cache)], cwd=workspace, env=environment,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(npm.returncode, 0, npm.stderr.decode()[-3000:])
            update.promote_dependencies(lock, workspace, cache, release)
            expected = {name for name, package in lock['packages'].items() if name and
                        (not package.get('optional') or (workspace / name).is_dir())}
            for name in expected:
                self.assertTrue((release / name / 'package.json').is_file(), name)
            for name, wrapper in (('@types/node', 'node'), ('@types/pg', 'pg'), ('@types/retry', 'retry')):
                package = lock['packages']['node_modules/' + name]
                payload = update.cached_package(cache, package['integrity'])
                with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
                    self.assertEqual(Path(archive.next().name).parts[0], wrapper)
                installed = release / 'node_modules' / name
                self.assertTrue((installed / 'index.d.ts').is_file(), name)
                self.assertFalse((installed / wrapper).exists(), name)
            bin_path = Path('node_modules/.bin/playwright-core')
            self.assertEqual((release / bin_path).readlink(), (workspace / bin_path).readlink())
            # Copy only first-party runtime source, never the repository's installed
            # node_modules. Both the loader and all imports must use reconstruction.
            shutil.copytree(root / 'server', release / 'server',
                            ignore=shutil.ignore_patterns('node_modules', '.venv', '__pycache__', '*.test.ts'))
            for name in ('package.json', 'package-lock.json'):
                shutil.copyfile(package_root / name, release / name)
            result = subprocess.run([shutil.which('node'), '--import', str(release / 'node_modules/tsx/dist/loader.mjs'),
                                     str(release / 'server/environment/qualify-runtime.ts')], cwd=release, env=environment,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr.decode()[-5000:])
            print(f'\nQualified {relative}/package-lock.json: {len(expected)} reconstructed packages; '
                  f'{len(lock["packages"]) - 1 - len(expected)} optional packages skipped; '
                  f'playwright-core -> {(release / bin_path).readlink()}; real runtime qualifier passed', flush=True)

    def test_root_lockfile_promotion_and_real_runtime_qualification(self):
        self.qualify_lock(Path('.'))

    def test_pi_update_lockfile_promotion_and_real_runtime_qualification(self):
        self.qualify_lock(Path('deploy/pi-update'))


class HealthTests(unittest.TestCase):
    def setUp(self):
        UpdateTests.setUp(self)
        private = update.CONFIG / 'coordinator'
        private.mkdir()
        (private / 'worker-token').write_text('private-worker-token')
        (private / 'host-token').write_text('private-host-token')
        self.clock = 0
        self.samples = []
        self.opener = Mock()
        self.opener.open.side_effect = self.response
        self.stable = tuple((unit, index + 100, 0) for index, unit in enumerate(self.updater.units))

    def response(self, request, timeout):
        url = request if isinstance(request, str) else request.full_url
        if url.endswith('/v2/environment'):
            data = dict(environmentId=self.request['environmentId'], protocolVersion=2, runtime=dict(release=self.target['id']))
        elif url.endswith('/v1'):
            self.assertEqual(request.get_header('Authorization'), 'Bearer private-worker-token')
            data = dict(releaseId=self.target['id'])
        elif url.endswith('/health'):
            data = dict(ready=True, host='local')
        else:
            self.assertEqual(request.get_method(), 'GET')
            self.assertIsNone(request.data)
            self.assertNotIn('/execute', url)
            status = 404 if request.get_header('Authorization') == 'Bearer private-host-token' else 401
            raise urllib.error.HTTPError(url, status, 'fixture', {}, io.BytesIO(b'{}'))
        response = io.BytesIO(json.dumps(data).encode())
        response.headers = {'x-outpost-environment-id': self.request['environmentId']}
        return response

    def sleep(self, seconds):
        self.clock += seconds

    def health(self, sample=None):
        def sample_pids():
            self.samples.append(self.clock)
            return sample() if sample else self.stable
        with patch.object(update.time, 'monotonic', side_effect=lambda: self.clock), \
                patch.object(update.time, 'sleep', side_effect=self.sleep), \
                patch.object(update.urllib.request, 'build_opener', return_value=self.opener), \
                patch.object(self.updater, 'service_pids', side_effect=sample_pids):
            update.Updater.health(self.updater, self.target['id'])

    def test_health_requires_consecutive_stable_pids_and_publishes_safe_evidence(self):
        self.health()
        self.assertEqual(self.clock, 8)
        self.assertGreaterEqual(len(self.samples), 5)
        status = json.loads((self.operation / 'status.json').read_text())
        self.assertEqual(status['health']['stableSeconds'], 8)
        self.assertEqual(len(status['health']['services']), 3)
        self.assertNotIn('private-', json.dumps(status))
        self.assertNotIn('token', json.dumps(status))
        self.assertNotIn('requiredTools', status['health'])

    def test_pid_or_restart_count_change_restarts_stability_window(self):
        changed = tuple((unit, pid + 1, restarts + 1) for unit, pid, restarts in self.stable)
        self.health(lambda: self.stable if self.clock < 4 else changed)
        self.assertEqual(self.clock, 12)

    def test_failed_service_observation_restarts_stability_window(self):
        def sample():
            if self.clock == 4:
                raise subprocess.CalledProcessError(1, ['systemctl'])
            return self.stable
        self.health(sample)
        self.assertEqual(self.clock, 13)

    def test_perpetual_restarts_fail_bounded_without_releasing_hold(self):
        with self.assertRaisesRegex(RuntimeError, 'Health verification failed'):
            self.health(lambda: tuple((unit, pid + self.clock, self.clock) for unit, pid, _ in self.stable))
        self.assertEqual(self.clock, 180)
        self.updater.release_hold.assert_not_called()
        self.assertNotIn('health', self.updater.status)

    def test_host_listener_checks_auth_without_executing_a_command(self):
        self.updater.verify_host_listener(self.opener)
        self.assertEqual(self.opener.open.call_count, 3)
        for call in self.opener.open.call_args_list:
            request = call.args[0]
            if not isinstance(request, str):
                self.assertEqual(request.get_method(), 'GET')
                self.assertIsNone(request.data)

    def test_host_listener_rejects_missing_auth_enforcement(self):
        original = self.response
        def response(request, timeout):
            if not isinstance(request, str) and not request.get_header('Authorization'):
                return io.BytesIO(b'{}')
            return original(request, timeout)
        self.opener.open.side_effect = response
        with self.assertRaisesRegex(ValueError, 'not enforced'):
            self.updater.verify_host_listener(self.opener)

    def test_service_pid_reader_rejects_inactive_zero_pid_and_failed_commands(self):
        valid = b'ActiveState=active\nSubState=running\nMainPID=123\nNRestarts=0\n'
        with patch.object(update.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, valid)) as run:
            self.assertEqual(len(self.updater.service_pids()), 3)
            self.assertEqual(run.call_args.kwargs['timeout'], 5)
        for invalid in (valid.replace(b'active', b'inactive'), valid.replace(b'123', b'0'), valid.replace(b'running', b'auto-restart')):
            with patch.object(update.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, invalid)), self.assertRaises(ValueError):
                self.updater.service_pids()

    def test_catalogue_is_optional_for_ordinary_updates_and_skipped_on_rollback(self):
        self.updater.verify_catalogue(self.target['id'])
        (self.operation / 'authorization.json').write_text(json.dumps({'requiredTools': ['automation.list']}))
        self.updater.verify_catalogue(self.source['id'])
        self.updater.run.assert_not_called()

    def test_catalogue_fixture_is_unprivileged_and_uses_no_production_ledger_or_tokens(self):
        (self.operation / 'authorization.json').write_text(json.dumps({'requiredTools': ['automation.list', 'host.execute']}))
        (update.CONFIG / 'coordinator.env').write_text('OUTPOST_BROWSER_ENABLED="true"\nPRIVATE_KEY="private-canary"\n')
        with patch.object(update.shutil, 'chown'):
            self.updater.verify_catalogue(self.target['id'])
        argv = self.calls[-1][1][0]
        self.assertEqual(argv[:4], ['/usr/sbin/runuser', '-u', 'outpost-build', '--'])
        self.assertIn('new Ledger()', argv[-1])
        self.assertIn('coordinator.gate(task).catalogue()', argv[-1])
        self.assertNotIn(str(update.DATA), argv[-1])
        self.assertNotIn('private-canary', argv[-1])
        self.assertNotIn('private-host-token', argv[-1])
        self.assertFalse(list(self.operation.glob('catalogue-*')))

    @unittest.skipUnless(shutil.which('node'), 'Node required for the actual coordinator fixture')
    def test_health_receipt_records_only_successful_real_catalogue_proof(self):
        root = Path(__file__).resolve().parents[2]
        if not (root / 'node_modules/tsx/dist/loader.mjs').is_file():
            self.skipTest('Local TypeScript dependencies are not installed')
        self.updater.release.symlink_to(root)
        tools = ['automation.list', 'automation.save', 'automation.set_paused']
        (self.operation / 'authorization.json').write_text(json.dumps({'requiredTools': tools}))
        (update.CONFIG / 'coordinator.env').write_text('OUTPOST_BROWSER_ENABLED="true"\n')
        def real_fixture(argv, timeout):
            # Only substitute the local Node executable and privilege drop. Execute
            # the real coordinator fixture and require its actual successful exit.
            self.assertEqual(argv[:4], ['/usr/sbin/runuser', '-u', 'outpost-build', '--'])
            subprocess.run([shutil.which('node'), '--import', str(root / 'node_modules/tsx/dist/loader.mjs'),
                            '--input-type=module', '--eval', argv[-1]],
                           env={'HOME': str(self.root), 'TMPDIR': str(self.root), 'JITI_FS_CACHE': 'false', 'TSX_DISABLE_CACHE': '1'},
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
        with patch.object(self.updater, 'run', side_effect=real_fixture), patch.object(update.shutil, 'chown'):
            self.health()
            receipt = json.loads((self.operation / 'status.json').read_text())
            self.assertEqual(receipt['health']['requiredTools'], tools)
            self.assertEqual(receipt['health']['releaseId'], self.target['id'])
            # A reboot-style new live PID tuple is independently healthy; retained
            # historical PIDs are not an identity constraint on fresh verification.
            self.stable = tuple((unit, pid + 100, 0) for unit, pid, _ in self.stable)
            self.health()
            self.assertEqual(self.updater.status['health']['requiredTools'], tools)
            self.assertEqual(self.updater.status['health']['services'][0]['pid'], self.stable[0][1])
            self.updater.status.pop('health')
            update.atomic_json(self.operation / 'status.json', self.updater.status, 0o644)
            (self.operation / 'authorization.json').write_text(json.dumps({'requiredTools': tools + ['unavailable.tool']}))
            with self.assertRaises(subprocess.CalledProcessError):
                self.health()
            self.assertNotIn('health', json.loads((self.operation / 'status.json').read_text()))
        self.assertIsNone(self.updater.verify_catalogue(self.source['id']))

    @unittest.skipUnless(shutil.which('node'), 'Node required for the actual coordinator fixture')
    def test_actual_coordinator_catalogue_accepts_installed_tools_and_rejects_missing(self):
        root = Path(__file__).resolve().parents[2]
        if not (root / 'node_modules/tsx/dist/loader.mjs').is_file():
            self.skipTest('Local TypeScript dependencies are not installed')
        for tools, expected in ((['automation.list', 'automation.save', 'automation.set_paused', 'recovery.inspect', 'host.execute'], 0),
                                (['unavailable.tool'], 1)):
            with tempfile.TemporaryDirectory() as directory:
                config = dict(root=str(root), temporary=directory, tools=tools, hosts=True, browser=True)
                script = 'const cfg = ' + json.dumps(config) + ';\n' + update.CATALOGUE_FIXTURE
                result = subprocess.run([shutil.which('node'), '--import', str(root / 'node_modules/tsx/dist/loader.mjs'),
                                         '--input-type=module', '--eval', script],
                                        cwd=directory, env={'HOME': directory, 'TMPDIR': directory, 'JITI_FS_CACHE': 'false', 'TSX_DISABLE_CACHE': '1'},
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
                self.assertEqual(result.returncode, expected, result.stderr.decode()[-2000:])



class Spec03StagingGcAndPortsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('CONFIG', 'DATA', 'PREFIX', 'UNIT_DIRECTORY', 'OPERATIONS'):
            path = self.root / name
            path.mkdir()
            patcher = patch.object(update, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.source = dict(schema=2, id='host-' + 'a'*20, sequence=1, compatibility='native-v1',
                           layoutVersion=1, protocolVersion=2, rollback=True, piVersion='1.4.0', extensions=[])
        self.target = dict(self.source, id='host-' + 'b'*20, sequence=2)
        self.request = dict(operationId=str(uuid.uuid4()), environmentId=str(uuid.uuid4()), deviceId=str(uuid.uuid4()),
                            releaseId=self.target['id'], expectedRelease=self.source['id'], sha256='a'*64,
                            size=100, target=self.target)
        self.operation = update.OPERATIONS / self.request['operationId']
        self.operation.mkdir()
        (self.operation / 'request.json').write_text(json.dumps(self.request))
        (self.operation / 'status.json').write_text(json.dumps(dict(state='queued')))
        (self.operation / 'command.log').write_text('command log\n')
        (self.operation / 'launch.log').write_text('launch log\n')
        (update.CONFIG / 'installation.json').write_text(json.dumps(dict(
            environmentId=self.request['environmentId'], release=self.source['id'], fullControl=True)))
        (update.CONFIG / 'coordinator.env').write_text(f'OUTPOST_RUNTIME_RELEASE="{self.source["id"]}"\n')
        (update.CONFIG / 'worker.env').write_text(f'OUTPOST_PI_RELEASE_FILE="{update.PREFIX}/releases/{self.source["id"]}/pi-release.json"\n')
        for unit in ('outpost-native-worker.service', 'outpost-native-coordinator.service', 'outpost-native-host.service'):
            (update.UNIT_DIRECTORY / unit).write_text(f'ExecStart={update.PREFIX}/releases/{self.source["id"]}/node/bin/node\n')
        self.updater = update.Updater(self.operation)
        self.updater.previous.mkdir(parents=True)
        (update.PREFIX / 'current').symlink_to(self.updater.previous)
        (self.updater.previous / 'host-manifest.json').write_text(json.dumps(self.source))
        for root in (self.updater.previous, self.operation / 'source'):
            (root / 'deploy/environment').mkdir(parents=True)
            (root / 'deploy/environment/runtime-pins.json').write_text(json.dumps({
                'nodeVersion': '22.14.0', 'nodeSha256': 'c' * 64,
            }))
            for entrypoint in ('server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'):
                path = root / entrypoint
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('// service fixture')
        (self.updater.previous / 'node/bin').mkdir(parents=True)
        (self.updater.previous / 'node/bin/node').write_bytes(b'trusted node binary')

    def _populate_scratch(self):
        for name in ('build-home', 'dependency-build', 'dependency-snapshot'):
            directory = self.operation / name
            (directory / 'nested').mkdir(parents=True, exist_ok=True)
            (directory / 'nested/file.bin').write_bytes(b'x' * 64)

    def _assert_scratch_cleaned_and_diagnostics_kept(self):
        for name in ('build-home', 'dependency-build', 'dependency-snapshot'):
            self.assertFalse((self.operation / name).exists(), name)
        for name in ('status.json', 'request.json', 'command.log', 'launch.log'):
            self.assertTrue((self.operation / name).is_file(), name)

    def test_scratch_cleaned_after_complete_failed_and_rolled_back(self):
        def fake_stage():
            self._populate_scratch()
            self.updater.release.mkdir(parents=True)
            for entrypoint in ('server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'):
                path = self.updater.release / entrypoint
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('// service fixture')

        # 1. Complete
        with patch.object(self.updater, 'run'), patch.object(self.updater, 'checkpoint'), \
                patch.object(self.updater, 'stage', side_effect=fake_stage), patch.object(self.updater, 'health'), \
                patch.object(self.updater, 'release_hold'):
            self.updater.execute()
        self.assertEqual(json.loads((self.operation / 'status.json').read_text())['state'], 'complete')
        self._assert_scratch_cleaned_and_diagnostics_kept()

        # 2. Failed during stage
        (update.PREFIX / 'current').unlink()
        (update.PREFIX / 'current').symlink_to(self.updater.previous)
        (update.CONFIG / 'installation.json').write_text(json.dumps(dict(
            environmentId=self.request['environmentId'], release=self.source['id'], fullControl=True)))
        shutil.rmtree(self.updater.release)
        self.updater = update.Updater(self.operation)
        def failing_stage():
            self._populate_scratch()
            raise RuntimeError('stage failure')
        with patch.object(self.updater, 'run'), patch.object(self.updater, 'checkpoint'), \
                patch.object(self.updater, 'stage', side_effect=failing_stage):
            self.updater.execute()
        self.assertEqual(json.loads((self.operation / 'status.json').read_text())['state'], 'failed')
        self._assert_scratch_cleaned_and_diagnostics_kept()

        # 3. Rolled back after health failure
        self.updater = update.Updater(self.operation)
        def fail_new_health(release):
            if release == self.target['id']:
                raise RuntimeError('unhealthy target')
        with patch.object(self.updater, 'run'), patch.object(self.updater, 'checkpoint'), \
                patch.object(self.updater, 'stage', side_effect=fake_stage), \
                patch.object(self.updater, 'health', side_effect=fail_new_health), \
                patch.object(self.updater, 'release_hold'):
            self.updater.execute()
        self.assertEqual(json.loads((self.operation / 'status.json').read_text())['state'], 'rolled_back')
        self._assert_scratch_cleaned_and_diagnostics_kept()

    def test_scratch_cleanup_skips_symlinks_without_touching_target(self):
        external = self.root / 'protected-dir'
        external.mkdir()
        canary = external / 'keep.txt'
        canary.write_bytes(b'untouched')
        (self.operation / 'build-home').symlink_to(external)
        (self.operation / 'dependency-build').mkdir()
        self.updater.cleanup_scratch()
        self.assertTrue((self.operation / 'build-home').is_symlink())
        self.assertEqual(canary.read_bytes(), b'untouched')
        self.assertFalse((self.operation / 'dependency-build').exists())

    def test_prune_old_releases_keeps_current_previous_browser_ref_non_host_and_symlinks(self):
        releases = update.PREFIX / 'releases'
        self.updater.release.mkdir(parents=True)
        (update.PREFIX / 'current').unlink()
        (update.PREFIX / 'current').symlink_to(self.updater.release)
        browser_ref = releases / ('host-' + '1'*20)
        old_one = releases / ('host-' + '2'*20)
        old_two = releases / ('host-' + '3'*20)
        custom = releases / 'custom-keep'
        for directory in (browser_ref, old_one, old_two, custom):
            directory.mkdir(parents=True)
            (directory / 'marker').write_text('x')
        external = self.root / 'external-release-target'
        external.mkdir()
        canary = external / 'canary'
        canary.write_bytes(b'protected')
        symlink_entry = releases / ('host-' + '4'*20)
        symlink_entry.symlink_to(external)
        (update.CONFIG / 'coordinator.env').write_text(
            f'OUTPOST_CAMOUFOX_PYTHON="{browser_ref}/browser/bin/python"\n'
            f'XDG_CACHE_HOME="{browser_ref}/browser/cache"\n'
        )
        self.updater.prune_old_releases()
        self.assertTrue(self.updater.release.is_dir())
        self.assertTrue(self.updater.previous.is_dir())
        self.assertTrue(browser_ref.is_dir())
        self.assertTrue(custom.is_dir())
        self.assertFalse(old_one.exists())
        self.assertFalse(old_two.exists())
        self.assertTrue(symlink_entry.is_symlink())
        self.assertEqual(canary.read_bytes(), b'protected')

    def test_shared_node_runtime_symlink_created_and_reused_when_pins_match(self):
        self.updater.release.mkdir(parents=True)
        previous_umask = os.umask(0o077)
        try:
            with patch.object(self.updater, 'run') as run_mock:
                self.updater.prepare_node_runtime(self.operation / 'source')
            shared = update.PREFIX / 'runtimes/node-22.14.0'
            self.assertEqual((update.PREFIX / 'runtimes').stat().st_mode & 0o777, 0o755)
            self.assertTrue(shared.is_dir() and not shared.is_symlink())
            self.assertTrue((self.updater.release / 'node').is_symlink())
            self.assertEqual((self.updater.release / 'node').readlink(), shared)
            self.assertEqual((self.updater.release / 'node/bin/node').read_bytes(), b'trusted node binary')
            self.assertEqual(run_mock.call_count, 1)
            shared_inode = (shared / 'bin/node').stat().st_ino

            # Second release reuses the already-populated shared runtime without re-copying.
            second_id = 'host-' + 'c'*20
            second_release = update.PREFIX / 'releases' / second_id
            second_release.mkdir(parents=True)
            self.updater.previous = self.updater.release
            (self.updater.previous / 'deploy/environment').mkdir(parents=True, exist_ok=True)
            (self.updater.previous / 'deploy/environment/runtime-pins.json').write_text(json.dumps({
                'nodeVersion': '22.14.0', 'nodeSha256': 'c' * 64,
            }))
            self.updater.release = second_release
            with patch.object(self.updater, 'run') as second_run:
                self.updater.prepare_node_runtime(self.operation / 'source')
            self.assertEqual(second_run.call_count, 0)
            self.assertTrue((second_release / 'node').is_symlink())
            self.assertEqual((second_release / 'node').readlink(), shared)
            self.assertEqual((second_release / 'node/bin/node').stat().st_ino, shared_inode)
        finally:
            os.umask(previous_umask)

    def test_shared_node_runtime_refuses_symlinked_runtimes_or_version_dir(self):
        self.updater.release.mkdir(parents=True)
        external = self.root / 'external-node'
        (external / 'bin').mkdir(parents=True)
        (external / 'bin/node').write_bytes(b'evil')
        (update.PREFIX / 'runtimes').symlink_to(external)
        with self.assertRaises(ValueError):
            self.updater.prepare_node_runtime(self.operation / 'source')
        (update.PREFIX / 'runtimes').unlink()
        (update.PREFIX / 'runtimes').mkdir()
        (update.PREFIX / 'runtimes/node-22.14.0').symlink_to(external)
        with self.assertRaises(ValueError):
            self.updater.prepare_node_runtime(self.operation / 'source')

    def test_read_env_port_edge_cases(self):
        env_file = update.CONFIG / 'test.env'
        self.assertEqual(update.read_env_port(env_file, 'PORT', 4518), 4518)
        for content, expected in (
            ('PORT=5518\n', 5518),
            ('PORT="5519"\n', 5519),
            ("PORT='5520'\n", 5520),
            ('# comment\n; another\n  PORT = "6000"  \n', 6000),
            ('PORT=4000\nPORT=5000\n', 5000),
            ('PORT=5000\nPORT=invalid\n', 4518),
            ('PORT=0\n', 4518),
            ('PORT=65536\n', 4518),
            ('PORT=-1\n', 4518),
            ('PORT=4518abc\n', 4518),
            ('OTHER=5518\n', 4518),
            ('PORT=5518\n' + ('# ' + 'a' * 70000), 4518),
        ):
            with self.subTest(content=content[:40]):
                env_file.write_text(content)
                self.assertEqual(update.read_env_port(env_file, 'PORT', 4518), expected)
        real_env = self.root / 'real.env'
        real_env.write_text('PORT=5999\n')
        env_file.unlink()
        env_file.symlink_to(real_env)
        self.assertEqual(update.read_env_port(env_file, 'PORT', 4518), 4518)

    def test_health_and_release_hold_use_configured_env_ports(self):
        (update.CONFIG / 'coordinator.env').write_text('PORT=5518\n')
        (update.CONFIG / 'worker.env').write_text('OUTPOST_PI_WORKER_PORT="5520"\n')
        (update.CONFIG / 'host.env').write_text("OUTPOST_HOST_PORT='5519'\n")
        (update.CONFIG / 'coordinator').mkdir(exist_ok=True)
        (update.CONFIG / 'coordinator/worker-token').write_text('worker-secret\n')
        (update.CONFIG / 'coordinator/host-token').write_text('host-secret\n')
        seen_urls = []
        clock = [0.0]

        class Response:
            def __init__(self, body, headers=None):
                self._body = json.dumps(body).encode()
                self.headers = headers or {}
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, limit):
                return self._body

        class Opener:
            def open(self, req, timeout=None):
                url = req.full_url if hasattr(req, 'full_url') else req
                seen_urls.append(url)
                if url == 'http://127.0.0.1:5518/v2/environment':
                    return Response(
                        {'environmentId': self.request['environmentId'], 'protocolVersion': 2,
                         'runtime': {'release': self.target['id']}},
                        {'x-outpost-environment-id': self.request['environmentId']},
                    )
                if url == 'http://127.0.0.1:5520/v1':
                    payload = json.loads(req.data.decode())
                    kind = payload['request']['type']
                    worker_kinds.append(kind)
                    if kind == 'maintenance.release':
                        return Response({'released': True})
                    return Response({'releaseId': self.target['id']})
                if url == 'http://127.0.0.1:5519/health':
                    return Response({'ready': True, 'host': 'local'})
                if url == 'http://127.0.0.1:5519/outpost-update-auth-probe':
                    code = 404 if req.get_header('Authorization') == 'Bearer host-secret' else 401
                    raise urllib.error.HTTPError(url, code, 'status', {}, io.BytesIO(b''))
                raise AssertionError(f'Unexpected URL: {url}')

        worker_kinds = []
        opener = Opener()
        opener.request = self.request
        opener.target = self.target
        stable = (('outpost-native-worker.service', 101, 0),
                  ('outpost-native-coordinator.service', 102, 0),
                  ('outpost-native-host.service', 103, 0))
        with patch.object(update.urllib.request, 'build_opener', return_value=opener), \
                patch.object(self.updater, 'service_pids', return_value=stable), \
                patch.object(self.updater, 'checkpoint'), \
                patch.object(update.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(update.time, 'sleep', side_effect=lambda s: clock.__setitem__(0, clock[0] + s)):
            self.updater.health(self.target['id'])
            self.updater.release_hold()
        self.assertIn('http://127.0.0.1:5518/v2/environment', seen_urls)
        self.assertIn('http://127.0.0.1:5520/v1', seen_urls)
        self.assertIn('http://127.0.0.1:5519/health', seen_urls)
        self.assertIn('http://127.0.0.1:5519/outpost-update-auth-probe', seen_urls)
        self.assertIn('runtime.inventory', worker_kinds)
        self.assertIn('maintenance.release', worker_kinds)
        self.assertFalse(any(':4518/' in u or ':4519/' in u or ':4520/' in u for u in seen_urls))

if __name__ == '__main__':
    unittest.main()
