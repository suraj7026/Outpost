"""Reviewed native release updates. No fresh installation, enrollment or credential replacement."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

# The desktop bootstrap preloads this reviewed module; detached jobs import its adjacent file.
from host_install import (CONFIG, DATA, PREFIX, UNIT_DIRECTORY, OPERATIONS, Installer,
                          atomic_json, extract_source, NoRedirect)
import urllib.request


def validate(request: dict) -> dict:
    """Bind a bounded packet to one source, target, installation and operation."""
    if set(request) != {'operationId', 'environmentId', 'deviceId', 'releaseId', 'expectedRelease', 'sha256', 'size', 'target'}:
        raise ValueError('Invalid update request')
    for name in ('operationId', 'environmentId', 'deviceId'):
        if str(uuid.UUID(request[name])) != request[name]:
            raise ValueError('Invalid identity')
    import re
    for name in ('releaseId', 'expectedRelease'):
        if not re.fullmatch(r'host-[a-f0-9]{20}', request[name]):
            raise ValueError('Invalid release')
    if not re.fullmatch(r'[a-f0-9]{64}', request['sha256']) or type(request['size']) is not int or not 0 < request['size'] <= 16 * 1024 * 1024:
        raise ValueError('Invalid artifact')
    if request['target'].get('id') != request['releaseId']:
        raise ValueError('Target mismatch')
    return request


def compatible(source: dict, target: dict) -> bool:
    """Content hashes are not versions; require ordered, qualified manifests."""
    return (source.get('schema') == target.get('schema') == 2 and source.get('compatibility') == target.get('compatibility') == 'native-v1'
            and source.get('layoutVersion') == target.get('layoutVersion') == 1
            and source.get('protocolVersion') == target.get('protocolVersion') == 2
            and source.get('rollback') is True and target.get('rollback') is True
            and type(source.get('sequence')) is int and type(target.get('sequence')) is int
            and target['sequence'] > source['sequence'] and source['id'] != target['id'])


def bootstrap(runner: str = 'host_update.py') -> None:
    """Persist one packet before launching a detached root job. Replays only read its receipt."""
    if os.geteuid() != 0:
        raise ValueError('Root authorization required')
    request = validate(json.loads(sys.stdin.buffer.readline(16385)))
    payload = sys.stdin.buffer.read(request['size'] + 1)
    if len(payload) != request['size'] or hashlib.sha256(payload).hexdigest() != request['sha256']:
        raise ValueError('Artifact checksum mismatch')
    OPERATIONS.mkdir(parents=True, exist_ok=True, mode=0o711)
    operation = OPERATIONS / request['operationId']
    try:
        operation.mkdir(mode=0o711)
    except FileExistsError:
        if json.loads((operation / 'request.json').read_text()) != request:
            raise ValueError('Operation conflict')
        print((operation / 'status.json').read_text())
        return
    atomic_json(operation / 'request.json', request)
    (operation / 'release.tar.gz').write_bytes(payload)
    source = operation / 'source'
    source.mkdir(mode=0o755)
    extract_source(operation / 'release.tar.gz', source)
    if json.loads((source / 'host-manifest.json').read_text()) != request['target']:
        raise ValueError('Target manifest mismatch')
    status = {'operationId': request['operationId'], 'environmentId': request['environmentId'], 'releaseId': request['releaseId'],
              'state': 'queued', 'stage': 'Verified release received', 'updatedAt': int(time.time()*1000)}
    atomic_json(operation / 'status.json', status, 0o644)
    with (operation / 'launch.log').open('xb') as log:
        result = subprocess.run(['/usr/bin/systemd-run', '--unit=outpost-update-' + request['operationId'], '--property=Type=exec',
                                 '--property=RuntimeMaxSec=2700', '--property=KillMode=control-group', '--property=UMask=0077',
                                 '/usr/bin/python3', str(source / 'deploy/environment' / runner), '--run', str(operation)],
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=20, check=False)
    if result.returncode:
        status.update(state='unknown', stage='Launch not confirmed; inspect the retained receipt')
        atomic_json(operation / 'status.json', status, 0o644)
    print(json.dumps(status))


class Updater:
    """Staged, serialized update with a retained release and health-checked rollback."""

    def __init__(self, operation: Path) -> None:
        self.operation = operation
        self.request = validate(json.loads((operation / 'request.json').read_text()))
        self.release = PREFIX / 'releases' / self.request['releaseId']
        self.previous = PREFIX / 'releases' / self.request['expectedRelease']
        self.status = json.loads((operation / 'status.json').read_text())
        self.switched = False
        self.committed = False
        self.installation = json.loads((CONFIG / 'installation.json').read_text())
        self.units = ['outpost-native-worker.service', 'outpost-native-coordinator.service']
        if self.installation.get('fullControl'):
            self.units.append('outpost-native-host.service')

    def publish(self, state: str, stage: str) -> None:
        """Expose only fixed, nonsecret stage messages."""
        self.status.update(state=state, stage=stage, updatedAt=int(time.time()*1000))
        atomic_json(self.operation / 'status.json', self.status, 0o644)

    def run(self, argv: list[str], timeout: int = 60) -> None:
        """Fixed argv, bounded execution, root-only output."""
        with (self.operation / 'command.log').open('ab') as output:
            subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=output, timeout=timeout, check=True,
                           env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/nonexistent'})

    def checkpoint(self, action: str) -> None:
        """First-party ledger command validates the approved source/target/operation binding."""
        root = self.release if self.switched else self.previous
        self.run(['/usr/sbin/runuser', '-u', 'outpost-coord', '--', str(root / 'node/bin/node'), '--import',
                  str(root / 'node_modules/tsx/dist/loader.mjs'), str(root / 'server/environment/update-checkpoint.ts'),
                  action, str(DATA / 'coordinator'), self.request['environmentId'], self.request['operationId'], self.request['sha256']], 30)

    def preflight(self) -> None:
        """Refuse stale identities, unqualified layouts, changed runtime pins and partial targets."""
        if self.installation['environmentId'] != self.request['environmentId'] or self.installation['release'] != self.request['expectedRelease']:
            raise ValueError('Installation changed')
        if (PREFIX / 'current').resolve() != self.previous.resolve() or self.release.exists():
            raise ValueError('Release paths changed or target already exists')
        source = json.loads((self.previous / 'host-manifest.json').read_text())
        if not compatible(source, self.request['target']):
            raise ValueError('Unsupported update path')
        if (self.previous / 'deploy/environment/runtime-pins.json').read_bytes() != (self.operation / 'source/deploy/environment/runtime-pins.json').read_bytes():
            raise ValueError('Runtime/OS changes require separate maintenance qualification')
        self.checkpoint('stage')

    def wait_for_idle(self) -> None:
        """Request draining only after staging, then let the running coordinator acquire its hold."""
        self.checkpoint('prepare')
        self.publish('waiting_for_idle', 'Release staged; waiting for existing work and sign-ins')
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            try:
                self.checkpoint('check')
                return
            except subprocess.CalledProcessError as error:
                if error.returncode != 2:
                    raise
                time.sleep(2)
        raise TimeoutError('Idle deadline exceeded')

    def stage(self) -> None:
        """Install only locked dependencies; retain existing browser runtime and OS libraries."""
        shutil.copytree(self.operation / 'source', self.release)
        shutil.copytree(self.previous / 'node', self.release / 'node', symlinks=True)
        (self.operation / 'cancel').touch(mode=0o600)
        home = self.operation / 'build-home'
        home.mkdir(mode=0o700)
        shutil.chown(home, user='outpost-build', group='outpost-build')
        # Reuse only the dependency installer, never its fresh-install/configuration/enrollment steps.
        builder = object.__new__(Installer)
        builder.operation, builder.release = self.operation, self.release
        builder.node = self.release / 'node/bin/node'
        builder.environment = {'PATH': str(self.release / 'node/bin') + ':/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8'}
        builder.dependencies()
        package = json.loads((self.release / 'package.json').read_text())
        if package['dependencies']['@earendil-works/pi-coding-agent'] != self.request['target']['piVersion']:
            raise ValueError('Pi version does not match reviewed release')
        for extension in self.request['target']['extensions']:
            if package['dependencies'].get(extension['name']) != extension['version']:
                raise ValueError('Extension version does not match reviewed release')
        atomic_json(self.release / 'pi-release.json', {'id': self.request['releaseId'], 'piVersion': self.request['target']['piVersion'],
                    'lockHash': hashlib.sha256((self.release / 'package-lock.json').read_bytes()).hexdigest(), 'profile': str(DATA / 'worker/profile')}, 0o644)
        self.run(['/bin/chown', '-R', 'root:root', str(self.release)])
        self.run(['/bin/chmod', '-R', 'a+rX,go-w', str(self.release)])
        self.qualify_runtime()

    def qualify_runtime(self) -> None:
        """Smoke-test as an unprivileged identity without poisoning another user's SDK cache."""
        temporary = self.operation / 'qualification'
        temporary.mkdir(mode=0o700)
        shutil.chown(temporary, user='outpost-build', group='outpost-build')
        self.run(['/usr/sbin/runuser', '-u', 'outpost-build', '--', '/usr/bin/env', f'TMPDIR={temporary}',
                  f'HOME={temporary}', 'JITI_FS_CACHE=false', str(self.release / 'node/bin/node'), '--import',
                  str(self.release / 'node_modules/tsx/dist/loader.mjs'), str(self.release / 'server/environment/qualify-runtime.ts')], 120)

    def switch(self) -> None:
        """Back up only runtime config/unit bytes, never credentials or ledger data."""
        backup = self.operation / 'previous'
        backup.mkdir(mode=0o700, exist_ok=True)
        files = [CONFIG / 'worker.env', CONFIG / 'coordinator.env', *(UNIT_DIRECTORY / name for name in self.units)]
        for path in files:
            shutil.copy2(path, backup / path.name)
        self.switched = True  # Recovery must run after any partial config/unit replacement.
        self.run(['/usr/bin/systemctl', 'stop', *self.units])
        for path in files:
            text = path.read_text()
            if path.suffix == '.env':
                lines = text.splitlines()
                lines = [line.replace(str(self.previous), str(self.release)).replace(self.request['expectedRelease'], self.request['releaseId'])
                         if line.startswith(('OUTPOST_PI_RELEASE_FILE=', 'OUTPOST_RUNTIME_RELEASE=')) else line for line in lines]
                text = '\n'.join(lines) + '\n'
            else:
                text = text.replace(str(self.previous), str(self.release))
            temporary = path.with_suffix(path.suffix + '.update')
            temporary.write_text(text)
            temporary.chmod(path.stat().st_mode & 0o777)
            os.replace(temporary, path)
        link = PREFIX / 'current.update'
        link.symlink_to(self.release)
        os.replace(link, PREFIX / 'current')
        self.run(['/usr/bin/systemctl', 'daemon-reload'])
        self.run(['/usr/bin/systemctl', 'start', *self.units])

    def health(self, release: str) -> None:
        """Check identity, running release, services and authenticated worker without inference."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                with opener.open('http://127.0.0.1:4518/v2/environment', timeout=2) as response:
                    value = json.loads(response.read(32768))
                    if value.get('environmentId') != self.request['environmentId'] or value.get('runtime', {}).get('release') != release:
                        raise ValueError('Unexpected environment or release')
                token = (CONFIG / 'coordinator/worker-token').read_text().strip()
                packet = {'type': 'management', 'owner': self.request['deviceId'], 'request': {'type': 'runtime.inventory'}}
                request = urllib.request.Request('http://127.0.0.1:4520/v1', data=json.dumps(packet).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with opener.open(request, timeout=3) as response:
                    if json.loads(response.read(32768)).get('releaseId') != release:
                        raise ValueError('Worker release mismatch')
                self.run(['/usr/bin/systemctl', 'is-active', '--quiet', *self.units])
                return
            except (OSError, ValueError):
                time.sleep(1)
        raise RuntimeError('Health verification failed')

    def release_hold(self) -> None:
        """Release the worker and coordinator only after independently verified health."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        packet = {'type': 'management', 'owner': self.request['deviceId'], 'request': {'type': 'maintenance.release', 'operationId': self.request['operationId']}}
        request = urllib.request.Request('http://127.0.0.1:4520/v1', data=json.dumps(packet).encode(), headers={
            'Authorization': 'Bearer ' + (CONFIG / 'coordinator/worker-token').read_text().strip(), 'Content-Type': 'application/json'})
        with opener.open(request, timeout=5) as response:
            if not json.loads(response.read(32768)).get('released'):
                raise ValueError('Worker hold not released')
        self.checkpoint('finish')

    def rollback(self) -> None:
        """Restore runtime files, verify previous health, then restore prior dispatch policy."""
        self.run(['/usr/bin/systemctl', 'stop', *self.units])
        for path in [CONFIG / 'worker.env', CONFIG / 'coordinator.env', *(UNIT_DIRECTORY / name for name in self.units)]:
            shutil.copy2(self.operation / 'previous' / path.name, path)
        link = PREFIX / 'current.rollback'
        link.symlink_to(self.previous)
        os.replace(link, PREFIX / 'current')
        self.run(['/usr/bin/systemctl', 'daemon-reload'])
        self.run(['/usr/bin/systemctl', 'start', *self.units])
        self.health(self.request['expectedRelease'])
        self.switched = False
        self.release_hold()

    def execute(self) -> None:
        """Never auto-resume an interrupted transaction or discard partial staging."""
        with (OPERATIONS.parent / 'install.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                self.preflight()
                self.publish('staging', 'Installing qualified locked dependencies')
                self.stage()
                self.wait_for_idle()
                self.publish('activating', 'Activating the reviewed release')
                self.switch()
                self.health(self.request['releaseId'])
                self.installation['release'] = self.request['releaseId']
                atomic_json(CONFIG / 'installation.json', self.installation, 0o644)
                # Once dispatch may be released, a late receipt/transport failure must
                # never restart services underneath newly admitted work.
                self.committed = True
                self.release_hold()
                self.publish('complete', 'Release and authenticated worker health verified')
            except Exception:
                if self.committed:
                    self.publish('needs_attention', 'Healthy release retained; dispatch release or final receipt needs reconciliation')
                    return
                try:
                    if self.switched:
                        self.publish('recovering', 'Restoring the previous release')
                        self.rollback()
                        self.installation['release'] = self.request['expectedRelease']
                        atomic_json(CONFIG / 'installation.json', self.installation, 0o644)
                        self.publish('rolled_back', 'Previous release health verified; credentials and history retained')
                    else:
                        # No activation occurred. Abort only an unheld operation;
                        # never clear a worker hold whose acquisition was ambiguous.
                        self.checkpoint('abort')
                        self.publish('failed', 'Update stopped before activation; previous release remains active')
                except Exception:
                    self.publish('needs_attention', 'Recovery could not be verified. Maintenance hold and private diagnostics retained')


if __name__ == '__main__':
    if sys.argv[1:] == ['--bootstrap']:
        bootstrap()
    elif len(sys.argv) == 3 and sys.argv[1] == '--run' and os.geteuid() == 0:
        operation = Path(sys.argv[2])
        if operation.parent != OPERATIONS or str(uuid.UUID(operation.name)) != operation.name:
            raise ValueError('Invalid operation directory')
        Updater(operation).execute()
    else:
        raise SystemExit('Use the reviewed native update protocol')
