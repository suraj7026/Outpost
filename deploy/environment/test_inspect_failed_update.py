"""Exercise the read-only recovery probe against isolated host fixtures."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('inspect_failed_update.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class RecoveryProbeTests(unittest.TestCase):
    def test_requires_stopped_bound_pre_activation_failure_and_previous_release(self):
        environment = '83e163ef-36d3-4a41-90de-1e1f97cc8245'
        operation = '33abaf6c-63dd-4977-a0c9-fba36a2b874b'
        expected, digest = 'host-' + 'a' * 20, 'b' * 64
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            base = root / 'var/lib/outpost-setup'
            op = base / 'operations' / operation
            op.mkdir(parents=True)
            (base / 'install.lock').touch()
            config = root / 'etc/outpost-native'
            config.mkdir(parents=True)
            release = root / 'opt/outpost-native/releases' / expected
            release.mkdir(parents=True)
            (release.parent.parent / 'current').symlink_to(release)
            installation = {'environmentId': environment, 'release': expected}
            request = {'environmentId': environment, 'operationId': operation, 'expectedRelease': expected, 'sha256': digest, 'releaseId': 'target'}
            receipt = {'environmentId': environment, 'operationId': operation, 'state': 'failed', 'failureStage': 'waiting_for_idle', 'failureCode': 'waiting_for_idle_failed', 'releaseId': 'target'}
            def write():
                (op / 'status.json').write_text(json.dumps(receipt))
                (op / 'request.json').write_text(json.dumps(request))
                (config / 'installation.json').write_text(json.dumps(installation))
            def mapped(value):
                return root / str(value).lstrip('/') if str(value).startswith(('/var/', '/opt/', '/etc/')) else Path(value)
            write()
            with patch.object(probe, 'Path', side_effect=mapped), patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(stdout='inactive\n')) as command:
                self.assertEqual(probe.inspect_failed_update(environment, operation, expected, digest)['state'], 'safe_to_recheck')
                for state in ('active', 'activating', 'deactivating', 'reloading', 'unknown'):
                    command.return_value.stdout = state
                    with self.assertRaises(ValueError):
                        probe.inspect_failed_update(environment, operation, expected, digest)
                command.return_value.stdout = 'inactive'
                for document, key, bad in [(receipt, 'state', 'unknown'), (receipt, 'failureStage', 'activating'), (request, 'sha256', 'wrong'), (installation, 'release', 'other')]:
                    original = document[key]
                    document[key] = bad
                    write()
                    with self.assertRaises(ValueError):
                        probe.inspect_failed_update(environment, operation, expected, digest)
                    document[key] = original
                    write()


if __name__ == '__main__':
    unittest.main()
