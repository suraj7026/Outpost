"""Hermetic bridge tests: no broker import, socket, SSH, Keychain or installer execution."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import tarfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name('outpost2_install_broker.py')
SPEC = importlib.util.spec_from_file_location('install_bridge_test', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
SOURCE = b"from __future__ import annotations\nimport sys\nassert sys.argv == ['host_install.py', '--bootstrap']\nassert __name__ == '__main__'\n"


def fixture() -> tuple[dict, dict, bytes]:
    """Use a synthetic archive and public identity, never native metadata."""
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        info = tarfile.TarInfo('./deploy/environment/host_install.py')
        info.size = len(SOURCE)
        archive.addfile(info, io.BytesIO(SOURCE))
    data = output.getvalue()
    manifest = {'id': m.RELEASE, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
                'nodeVersion': 'fixture', 'manifest': {'id': m.RELEASE}}
    plan = {'planId': '11111111-1111-4111-8111-111111111111',
            'operationId': '22222222-2222-4222-8222-222222222222',
            'environmentId': '33333333-3333-4333-8333-333333333333',
            'deviceId': '44444444-4444-4444-8444-444444444444',
            'publicKey': base64.b64encode(bytes(32)).decode(), 'releaseId': m.RELEASE,
            'sha256': manifest['sha256'], 'size': len(data), 'nodeVersion': 'fixture',
            'expiresAt': 300000, 'browser': True, 'fullControl': True}
    request = {key: plan[key] for key in ('operationId', 'environmentId', 'deviceId', 'publicKey', 'releaseId',
                                        'sha256', 'size', 'browser', 'fullControl')}
    request.update(label='Synthetic fixture', coexistence=True)
    frame = json.dumps(request).encode() + b'\n' + data
    entry = {'id': m.FRESH, 'target': dict(m.TARGET), 'fingerprint': m.FINGERPRINT,
             'phase': 'install_review', 'installation': None, 'endpoint': None, 'connectionPaused': False,
             'inspection': {'nativePresent': False}, 'plan': plan, 'label': request['label']}
    envelope = {'entry': entry, 'source': base64.b64encode(SOURCE).decode(), 'frame': base64.b64encode(frame).decode()}
    return envelope, manifest, frame


class BridgeTests(unittest.TestCase):
    """Only injected fake runners can dispatch in these tests."""

    def setUp(self) -> None:
        """Pin synthetic fixture bytes independently of the reviewed live bundle."""
        self.envelope, self.manifest, self.frame = fixture()
        for name, value in [('INSTALLER_SHA256', hashlib.sha256(SOURCE).hexdigest()),
                            ('ARCHIVE_SHA256', self.manifest['sha256']), ('ARCHIVE_SIZE', self.manifest['size'])]:
            patcher = patch.object(m, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def validate(self) -> tuple[bytes, bytes, dict]:
        """Exercise the complete validator with fixed synthetic time."""
        return m.validate(self.envelope, SOURCE, self.manifest, 1)

    def test_exact_frame_is_preserved_and_only_bootstrap_argv_is_selected(self) -> None:
        """Future imports compile independently; wrapper does not rewrite the frame."""
        source, frame, request = self.validate()
        self.assertEqual(frame, self.frame)
        receipt = json.dumps({key: request[key] for key in ('operationId', 'environmentId', 'releaseId')}).encode()
        runner = Mock(return_value={'exitCode': 0, 'stdout': receipt, 'stderr': b''})
        self.assertEqual(m.dispatch(source, frame, request, runner), receipt)
        runner.assert_called_once_with(m.bootstrap_source(SOURCE), payload=frame, seconds=90, label='fresh-install')
        with patch('sys.argv', ['-c']):
            # Execute ONLY the tiny in-memory fixture, never the actual installer.
            exec(compile(m.bootstrap_source(SOURCE), '<synthetic wrapper>', 'exec'), {})

    def test_all_existing_receipts_are_refused(self) -> None:
        """Even an unknown or authorizing native receipt must only be polled."""
        for state in ('unknown', 'authorizing', 'queued', 'failed', 'ready', 'complete'):
            self.envelope['entry']['installation'] = {'state': state}
            with self.assertRaises(m.Refused):
                self.validate()

    def test_target_capability_identity_source_and_expiry_binding(self) -> None:
        """No dynamic host, legacy operation, downgraded capability or expired plan."""
        original = json.dumps(self.envelope)
        changes = [(['target', 'host'], 'other-host'), (['target', 'port'], 2222),
                   (['fingerprint'], 'different'), (['id'], m.OLD_OPERATION),
                   (['plan', 'operationId'], m.OLD_OPERATION), (['plan', 'environmentId'], m.OLD_ENVIRONMENT),
                   (['plan', 'browser'], False), (['plan', 'fullControl'], False),
                   (['plan', 'expiresAt'], 0), (['plan', 'deviceId'], 'bad'),
                   (['plan', 'publicKey'], base64.b64encode(b'changed').decode()),
                   (['inspection', 'nativePresent'], True), (['connectionPaused'], True)]
        for path, value in changes:
            self.envelope = json.loads(original)
            current = self.envelope['entry']
            for key in path[:-1]:
                current = current[key]
            current[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(m.Refused):
                self.validate()
        self.envelope = json.loads(original)
        self.envelope['source'] = base64.b64encode(b'other Python').decode()
        with self.assertRaises(m.Refused):
            self.validate()

    def test_password_prefix_corrupt_archive_and_duplicate_fields_fail(self) -> None:
        """Nothing except JSON-newline-exact-archive is accepted."""
        for frame in (b'not-a-password\n' + self.frame, self.frame + b'extra', self.frame[:-1]):
            self.envelope['frame'] = base64.b64encode(frame).decode()
            with self.assertRaises((m.Refused, ValueError)):
                self.validate()
        with self.assertRaises(m.Refused):
            m.document(b'{"entry":1,"entry":2}')
        with self.assertRaises(m.Refused):
            m.document(b'{"value":NaN}')
        with self.assertRaises(m.Refused):
            m.blob(base64.b64encode(b'x' * (m.MAX_BLOB + 1)).decode())

    def test_loss_nonzero_and_mismatched_receipt_never_retry_or_echo(self) -> None:
        """Failures discard stdout/stderr and invoke the runner once only."""
        source, frame, request = self.validate()
        for result in ({'exitCode': 1, 'stdout': b'private canary', 'stderr': b'secret'},
                       {'exitCode': 0, 'stdout': b'{}', 'stderr': b''},
                       {'exitCode': 0, 'stdout': b'not-json', 'stderr': b''}):
            runner = Mock(return_value=result)
            with self.assertRaises((m.Refused, ValueError)):
                m.dispatch(source, frame, request, runner)
            self.assertEqual(runner.call_count, 1)
        runner = Mock(side_effect=TimeoutError('synthetic unknown outcome'))
        with self.assertRaises(TimeoutError):
            m.dispatch(source, frame, request, runner)
        self.assertEqual(runner.call_count, 1)


if __name__ == '__main__':
    unittest.main()
