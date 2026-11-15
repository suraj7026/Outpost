"""Explicit one-time schema-1 native bridge. Never a container migration or fresh installer.

Root authorization must disclose that legacy in-progress provider sign-ins are cancelled.
The old server lacks the admission/flow-drain protocol. Task work is checkpointed and
rechecked after stopping admission; credentials, browser code and dependency pins stay put.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from host_update import Updater, bootstrap
from host_install import CONFIG, DATA, PREFIX, UNIT_DIRECTORY, OPERATIONS, atomic_json, NoRedirect


class NativeBridge(Updater):
    """A source-hash-qualified adapter to the regular retained-release activation engine."""

    def __init__(self, operation: Path) -> None:
        super().__init__(operation)
        self.checkpointed = False
        self.legacy_prepared = False
        self.credentials: dict[str, bytes | None] = {}

    def node(self, source: str, release: Path) -> None:
        """Run fixed administrative ledger code as its existing non-root owner."""
        self.run(['/usr/sbin/runuser', '-u', 'outpost-coord', '--', str(release / 'node/bin/node'),
                  '--import', str(release / 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', source])

    def ledger(self, source: str, release: Path) -> None:
        """Scope every checkpoint operation to the retained coordinator ledger."""
        self.node(f"import {{Ledger}} from '{release}/server/core/ledger.ts';"
                  f"import {{Tasks}} from '{release}/server/tasks/tasks.ts';"
                  f"const db=new Ledger('{DATA}/coordinator/ledger.sqlite');try{{{source}}}finally{{db.close();}}", release)

    def preflight(self) -> None:
        """Match the entire reviewed source inventory and installation before any staging."""
        if self.installation['environmentId'] != self.request['environmentId'] or self.installation['release'] != self.request['expectedRelease']:
            raise ValueError('Installation changed')
        if (PREFIX / 'current').resolve() != self.previous.resolve() or self.release.exists():
            raise ValueError('Release paths changed')
        manifest = json.loads((self.previous / 'host-manifest.json').read_text())
        baseline = json.loads((self.operation / 'source/bridge-source.json').read_text())
        if manifest.get('schema') != 1 or manifest.get('layoutVersion') != 1 or manifest.get('protocolVersion') != 2 or baseline['id'] != manifest['id']:
            raise ValueError('Unsupported legacy installation')
        for name, digest in baseline['baseline'].items():
            path = self.previous / name
            if not path.resolve().is_relative_to(self.previous.resolve()) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('Reviewed source changed')
        for name in ('package.json', 'package-lock.json', 'deploy/environment/runtime-pins.json'):
            if (self.previous / name).read_bytes() != (self.operation / 'source' / name).read_bytes():
                raise ValueError('Bridge cannot change dependency or runtime pins')
        connection = sqlite3.connect(f'file:{DATA}/coordinator/ledger.sqlite?mode=ro', uri=True)
        try:
            identity = connection.execute('SELECT environment_id FROM installation_identity').fetchone()[0]
            device = connection.execute("SELECT data FROM records WHERE kind='device' AND id=?", (self.request['deviceId'],)).fetchone()
            if identity != self.request['environmentId'] or not device or json.loads(device[0]).get('revoked') is not False:
                raise ValueError('Installation/device binding changed')
        finally:
            connection.close()

    def stage(self) -> None:
        """Reuse immutable installed dependencies; preserve the old browser implementation."""
        shutil.copytree(self.operation / 'source', self.release)
        for name in ('node', 'node_modules'):
            (self.release / name).symlink_to(self.previous / name)
        atomic_json(self.release / 'pi-release.json', {'id': self.request['releaseId'], 'piVersion': self.request['target']['piVersion'],
                    'lockHash': hashlib.sha256((self.release / 'package-lock.json').read_bytes()).hexdigest(), 'profile': str(DATA / 'worker/profile')}, 0o644)
        self.qualify_runtime()

    def wait_for_idle(self) -> None:
        """Preserve all task work; cancel legacy ephemeral sign-ins only with explicit root approval."""
        self.publish('waiting_for_idle', 'Waiting for idle before the explicitly approved native bridge')
        deadline = time.monotonic() + 900
        while True:
            try:
                self.ledger("try{new Tasks(db).prepareMaintenance();}catch(e){process.exitCode=String(e.code).endsWith('_active')||e.code==='maintenance_work_unsettled'?2:1;}", self.previous)
                break
            except subprocess.CalledProcessError as error:
                if error.returncode != 2 or time.monotonic() >= deadline:
                    raise
                time.sleep(2)
        self.legacy_prepared = True
        backup = self.operation / 'previous'
        backup.mkdir(mode=0o700)
        for path in [CONFIG / 'worker.env', CONFIG / 'coordinator.env', *(UNIT_DIRECTORY / name for name in self.units)]:
            shutil.copy2(path, backup / path.name)
        self.switched = True  # Any error after stopping admission restores the old services.
        self.run(['/usr/bin/systemctl', 'stop', 'outpost-native-coordinator.service'])
        self.run(['/usr/bin/systemctl', 'stop', 'outpost-native-worker.service'])
        # Check again after admission stopped, so a task queued in the checkpoint/stop gap is never discarded.
        self.ledger("if(db.list('task').some(t=>['running','queued'].includes(t.data.state)))throw Error('work_changed');new Tasks(db).recover();", self.previous)
        self.credentials = {name: (DATA / 'worker/profile' / name).read_bytes() if (DATA / 'worker/profile' / name).exists() else None
                            for name in ('auth.json', 'settings.json', 'models.json')}
        operation = {key: self.request[key] for key in ('operationId', 'expectedRelease', 'target', 'sha256')}
        operation.update(owner=self.request['deviceId'], state='prepared')
        self.ledger("const old=db.get('runtime_update','server');if(old&&!['finished','cancelled'].includes(old.data.state))throw Error('maintenance_conflict');"
                    f"db.put('runtime_update','server',old?.revision??0,{json.dumps(operation)});"
                    "const cp=db.need('maintenance_checkpoint','server');db.put('maintenance_checkpoint','server',cp.revision,{...cp.data,expiresAt:Date.now()+10800000});", self.release)
        self.checkpointed = True
        hold = DATA / 'worker/profile/.outpost-maintenance.json'
        with hold.open('x') as output:
            output.write(json.dumps({'owner': self.request['deviceId'], 'operationId': self.request['operationId']}))
        shutil.chown(hold, user='outpost-pi', group='outpost-pi')
        hold.chmod(0o600)
        self.checkpoint('check')

    def checkpoint(self, action: str) -> None:
        """Use the qualified new helper, including when recovering the legacy release."""
        if not self.checkpointed:
            if action == 'abort':
                if self.legacy_prepared:
                    self.ledger('const tasks=new Tasks(db);tasks.recover();tasks.finishMaintenance();', self.previous)
                return
            raise ValueError('Bridge checkpoint not established')
        self.run(['/usr/sbin/runuser', '-u', 'outpost-coord', '--', str(self.release / 'node/bin/node'), '--import',
                  str(self.release / 'node_modules/tsx/dist/loader.mjs'), str(self.release / 'server/environment/update-checkpoint.ts'),
                  action, str(DATA / 'coordinator'), self.request['environmentId'], self.request['operationId'], self.request['sha256']])

    def health(self, release: str) -> None:
        """Verify legacy/new processes without resolving or probing production provider credentials."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                with opener.open('http://127.0.0.1:4518/v2/environment', timeout=2) as response:
                    value = json.loads(response.read(32768))
                if value.get('environmentId') != self.request['environmentId'] or value.get('runtime', {}).get('release') != release:
                    raise ValueError('Identity mismatch')
                self.run(['/usr/bin/systemctl', 'is-active', '--quiet', *self.units])
                for name in self.units[:2]:
                    pid = subprocess.check_output(['/usr/bin/systemctl', 'show', '-p', 'MainPID', '--value', name], timeout=5).decode().strip()
                    if Path(f'/proc/{pid}/cwd').resolve() != (PREFIX / 'releases' / release).resolve():
                        raise ValueError('Runtime process mismatch')
                for name, before in self.credentials.items():
                    path = DATA / 'worker/profile' / name
                    if (path.read_bytes() if path.exists() else None) != before:
                        raise ValueError('Provider state changed during bridge')
                return
            except (OSError, ValueError, subprocess.CalledProcessError):
                time.sleep(1)
        raise RuntimeError('Bridge health failed')

    def release_hold(self) -> None:
        """Restore the prior dispatch policy only after successful activation or recovery."""
        hold = DATA / 'worker/profile/.outpost-maintenance.json'
        if hold.exists():
            value = json.loads(hold.read_text())
            if value != {'owner': self.request['deviceId'], 'operationId': self.request['operationId']}:
                raise ValueError('Hold changed')
            hold.unlink()
        if self.checkpointed:
            self.checkpoint('finish')
        else:
            self.ledger('const tasks=new Tasks(db);tasks.recover();tasks.finishMaintenance();', self.previous)


if __name__ == '__main__':
    if sys.argv[1:] == ['--bootstrap']:
        bootstrap('native_bridge.py')
    elif len(sys.argv) == 3 and sys.argv[1] == '--run' and os.geteuid() == 0:
        operation = Path(sys.argv[2])
        if operation.parent != OPERATIONS or str(uuid.UUID(operation.name)) != operation.name:
            raise ValueError('Invalid operation directory')
        NativeBridge(operation).execute()
    else:
        raise SystemExit('Use only the explicitly reviewed schema-1 native bridge')
