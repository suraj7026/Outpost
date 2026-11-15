"""Synthetic safety checks for the explicit native bridge; no host services or credentials."""
from __future__ import annotations
import hashlib
import json
import sqlite3
import unittest
from unittest.mock import patch
import native_bridge as bridge
import host_update as update
import test_host_update as fixtures


class NativeBridgeTests(unittest.TestCase):
    """Exercise the source/device fences independently of the disposable systemd suite."""

    def setUp(self) -> None:
        self.fixture = fixtures.UpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        for name in ('CONFIG', 'DATA', 'PREFIX', 'UNIT_DIRECTORY', 'OPERATIONS'):
            patcher = patch.object(bridge, name, getattr(update, name))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.operation = self.fixture.operation
        self.previous = self.fixture.updater.previous
        self.source = self.operation / 'source'
        old = dict(self.fixture.source, schema=1)
        (self.previous / 'host-manifest.json').write_text(json.dumps(old))
        for name in ('package.json', 'package-lock.json'):
            for root in (self.previous, self.source):
                (root / name).write_text('{}')
        baseline = {'host-manifest.json': hashlib.sha256((self.previous / 'host-manifest.json').read_bytes()).hexdigest()}
        (self.source / 'bridge-source.json').write_text(json.dumps(dict(id=old['id'], baseline=baseline)))
        (bridge.DATA / 'coordinator').mkdir()
        self.db = sqlite3.connect(bridge.DATA / 'coordinator/ledger.sqlite')
        self.db.executescript('CREATE TABLE installation_identity(environment_id TEXT); CREATE TABLE records(kind TEXT,id TEXT,data TEXT);')
        self.db.execute('INSERT INTO installation_identity VALUES(?)', (self.fixture.request['environmentId'],))
        self.db.execute('INSERT INTO records VALUES(?,?,?)', ('device', self.fixture.request['deviceId'], '{"revoked":false}'))
        self.db.commit()
        self.addCleanup(self.db.close)
        self.updater = bridge.NativeBridge(self.operation)

    def test_exact_source_and_enrolled_device_required(self) -> None:
        self.updater.preflight()
        self.db.execute('UPDATE records SET data=\'{"revoked":true}\'')
        self.db.commit()
        with self.assertRaisesRegex(ValueError, 'binding changed'):
            self.updater.preflight()

    def test_source_drift_and_runtime_changes_rejected(self) -> None:
        (self.source / 'package-lock.json').write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError, 'cannot change'):
            self.updater.preflight()
        (self.source / 'package-lock.json').write_text('{}')
        (self.previous / 'host-manifest.json').write_text(json.dumps(dict(self.fixture.source, schema=1, extra=True)))
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.updater.preflight()

    def test_prepared_legacy_hold_is_restored_on_pre_activation_abort(self) -> None:
        self.updater.legacy_prepared = True
        with patch.object(self.updater, 'ledger') as ledger:
            self.updater.checkpoint('abort')
            self.assertIn('finishMaintenance', ledger.call_args.args[0])
        self.updater.legacy_prepared = False
        with patch.object(self.updater, 'ledger') as ledger:
            self.updater.checkpoint('abort')
            ledger.assert_not_called()


if __name__ == '__main__':
    unittest.main()
