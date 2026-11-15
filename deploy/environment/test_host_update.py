"""Synthetic filesystem/failure tests. Never invoke SSH, sudo, systemd or a live host."""
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
import host_update as update


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
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

    def test_stage_failure_keeps_old_release_without_acquiring_or_releasing_a_hold(self):
        self.updater.stage.side_effect = RuntimeError('synthetic stage failure')
        self.updater.execute()
        self.assertEqual(self.updater.status['state'], 'failed')
        self.assertEqual(update.PREFIX.joinpath('current').resolve(), self.updater.previous.resolve())
        self.assertEqual(self.calls[-1], ('checkpoint', ('abort',)))
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


if __name__ == '__main__':
    unittest.main()
