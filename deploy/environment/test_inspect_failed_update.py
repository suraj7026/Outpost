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
    def _fixture(self, root: Path):
        environment = '83e163ef-36d3-4a41-90de-1e1f97cc8245'
        operation = '33abaf6c-63dd-4977-a0c9-fba36a2b874b'
        expected, digest = 'host-' + 'a' * 20, 'b' * 64
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
        return environment, operation, expected, digest, installation, request, receipt, write, mapped

    def test_requires_stopped_bound_pre_activation_failure_and_previous_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            environment, operation, expected, digest, installation, request, receipt, write, mapped = self._fixture(root)
            with patch.object(probe, 'Path', side_effect=mapped), patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(stdout='inactive\n')) as command:
                for stage, code in [
                    ('preflight', 'preflight_failed'),
                    ('preflight', 'installation_changed'),
                    ('preflight', 'target_already_exists'),
                    ('preflight', 'release_paths_changed'),
                    ('preflight', 'unsupported_manifest'),
                    ('preflight', 'runtime_pins_mismatch'),
                    ('preflight', 'missing_service_files'),
                    ('staging', 'staging_failed'),
                    ('waiting_for_idle', 'waiting_for_idle_failed'),
                ]:
                    receipt['failureStage'] = stage
                    receipt['failureCode'] = code
                    write()
                    for unit_state in ('inactive', 'failed'):
                        command.return_value.stdout = unit_state + '\n'
                        result = probe.inspect_failed_update(environment, operation, expected, digest)
                        self.assertEqual(result['state'], 'safe_to_recheck', (stage, code, unit_state))
                        self.assertEqual(result['failureStage'], stage)
                        self.assertEqual(result['updaterState'], unit_state)

                receipt['failureStage'] = 'waiting_for_idle'
                receipt['failureCode'] = 'waiting_for_idle_failed'
                write()
                for state in ('active', 'activating', 'deactivating', 'reloading', 'unknown'):
                    command.return_value.stdout = state
                    with self.assertRaises(ValueError):
                        probe.inspect_failed_update(environment, operation, expected, digest)

                command.return_value.stdout = 'inactive'
                for document, key, bad in [
                    (receipt, 'state', 'unknown'),
                    (receipt, 'state', 'needs_attention'),
                    (receipt, 'state', 'rolled_back'),
                    (request, 'sha256', 'wrong'),
                    (installation, 'release', 'other'),
                ]:
                    original = document[key]
                    document[key] = bad
                    write()
                    with self.assertRaises(ValueError):
                        probe.inspect_failed_update(environment, operation, expected, digest)
                    document[key] = original
                    write()

    def test_refuses_post_activation_unknown_and_mismatched_failure_stages(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            environment, operation, expected, digest, _, _, receipt, write, mapped = self._fixture(root)
            with patch.object(probe, 'Path', side_effect=mapped), patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(stdout='inactive\n')):
                for stage, code in [
                    ('activating', 'activating_failed'),
                    ('health_verification', 'health_verification_failed'),
                    ('committing', 'committing_failed'),
                    ('releasing_dispatch', 'releasing_dispatch_failed'),
                    ('final_receipt', 'final_receipt_failed'),
                    ('unknown', 'unknown_failed'),
                    ('needs_attention', 'needs_attention_failed'),
                    (None, 'staging_failed'),
                    ('staging', 'waiting_for_idle_failed'),
                    ('preflight', 'staging_failed'),
                    ('waiting_for_idle', 'preflight_failed'),
                    ('staging', 'activating_failed'),
                ]:
                    receipt['failureStage'] = stage
                    receipt['failureCode'] = code
                    write()
                    with self.assertRaises(ValueError, msg=f'expected refusal for {(stage, code)}'):
                        probe.inspect_failed_update(environment, operation, expected, digest)


if __name__ == '__main__':
    unittest.main()
