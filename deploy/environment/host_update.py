"""Reviewed native release updates. No fresh installation, enrollment or credential replacement."""
from __future__ import annotations

import base64
import fcntl
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path, PurePosixPath

# The desktop bootstrap preloads this reviewed module; detached jobs import its adjacent file.
from common import (CONFIG, DATA, PREFIX, UNIT_DIRECTORY, OPERATIONS,
                    atomic_json, extract_source, NoRedirect, run_as_user)


CATALOGUE_FIXTURE = r'''
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const { Ledger } = await import(pathToFileURL(cfg.root + '/server/core/ledger.ts').href);
const { Coordinator } = await import(pathToFileURL(cfg.root + '/server/gateway/coordinator.ts').href);
const db = new Ledger();
let coordinator;
try {
  coordinator = new Coordinator(db, cfg.temporary, {
    worker: { request: async () => { throw new Error('fixture must not call worker'); } },
    ...(cfg.hosts ? { hosts: { token: 'synthetic', endpoints: { local: 'http://127.0.0.1:1' } } } : {}),
    ...(cfg.browser ? { browser: {} } : {}),
  });
  const task = randomUUID();
  db.put('task', task, 0, { goal: 'Catalogue qualification only', state: 'paused', profile: 'code' });
  const names = new Set(coordinator.gate(task).catalogue().map(tool => tool.name));
  if (!cfg.tools.every(name => names.has(name))) throw new Error('required catalogue tools missing');
} finally {
  coordinator?.live.close();
  await coordinator?.browsers?.close();
  db.close();
}
'''


PREFLIGHT_FAILURES = {
    'installation_changed': 'Installation changed; no activation occurred',
    'target_already_exists': 'Target release already exists; no activation occurred',
    'release_paths_changed': 'Release paths changed; no activation occurred',
    'unsupported_manifest': 'Release manifests do not support this update; no activation occurred',
    'runtime_pins_mismatch': 'This release requires a separate browser/runtime migration; no activation occurred',
    'missing_service_files': 'Release service entrypoints are missing or unsafe; no activation occurred',
}

SCRATCH_DIRECTORIES = ('build-home', 'dependency-build', 'dependency-snapshot')
ENV_FILE_LIMIT = 65536


class PreflightFailure(ValueError):
    """Identify a known refusal without exposing arbitrary exception text in receipts."""

    def __init__(self, code: str) -> None:
        super().__init__(PREFLIGHT_FAILURES[code])
        self.code = code


def read_env_port(env_file: Path, var_name: str, default: int) -> int:
    """Read a validated TCP port (1-65535) from a systemd EnvironmentFile, or return default."""
    try:
        fd = os.open(env_file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return default
            with os.fdopen(fd, 'rb', closefd=False) as source:
                raw = source.read(ENV_FILE_LIMIT + 1)
        finally:
            os.close(fd)
        if len(raw) > ENV_FILE_LIMIT:
            return default
        text = raw.decode('utf-8')
    except (OSError, UnicodeDecodeError):
        return default
    found: int | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(('#', ';')):
            continue
        key, sep, value = stripped.partition('=')
        if not sep or key.strip() != var_name:
            continue
        candidate = value.strip()
        if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in ('"', "'"):
            candidate = candidate[1:-1]
        if re.fullmatch(r'[0-9]{1,5}', candidate):
            port = int(candidate)
            if 1 <= port <= 65535:
                found = port
                continue
        found = None
    return default if found is None else found


def validate(request: dict) -> dict:
    """Bind a bounded packet to one source, target, installation and operation."""
    if set(request) != {'operationId', 'environmentId', 'deviceId', 'releaseId', 'expectedRelease', 'sha256', 'size', 'target'}:
        raise ValueError('Invalid update request')
    for name in ('operationId', 'environmentId', 'deviceId'):
        if str(uuid.UUID(request[name])) != request[name]:
            raise ValueError('Invalid identity')
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


DEPENDENCY_ARCHIVE_LIMIT = 64 * 1024 * 1024
DEPENDENCY_EXPANDED_LIMIT = 256 * 1024 * 1024
DEPENDENCY_TOTAL_LIMIT = 1024 * 1024 * 1024


def cached_package(cache: Path, integrity: str) -> bytes:
    """Snapshot untrusted npm cache bytes through no-follow FDs, then verify lockfile SRI."""
    match = re.fullmatch(r'(sha512|sha256)-([A-Za-z0-9+/]+={0,2})', integrity)
    if not match:
        raise ValueError('Unsupported locked dependency integrity')
    algorithm, encoded = match.groups()
    expected = base64.b64decode(encoded, validate=True)
    if len(expected) != hashlib.new(algorithm).digest_size:
        raise ValueError('Invalid locked dependency integrity')
    hex_digest = expected.hex()
    path = cache / '_cacache/content-v2' / algorithm / hex_digest[:2] / hex_digest[2:4] / hex_digest[4:]
    # The build account may rename directories, swap symlinks or keep cache FDs open.
    # Open each component relative to an already-open directory and verify a private
    # bytes snapshot, not the builder's mutable path or npm's success exit code.
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        source_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(source_fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > DEPENDENCY_ARCHIVE_LIMIT:
                raise ValueError('Invalid dependency cache object')
            payload = source.read(DEPENDENCY_ARCHIVE_LIMIT + 1)
    finally:
        os.close(fd)
    if len(payload) > DEPENDENCY_ARCHIVE_LIMIT or hashlib.new(algorithm, payload).digest() != expected:
        raise ValueError('Dependency integrity mismatch')
    return payload


def unpack_dependency(payload: bytes, destination: Path) -> int:
    """Strip one consistent npm archive wrapper; extract verified files into fresh root inodes."""
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
        expanded = compressed.read(DEPENDENCY_EXPANDED_LIMIT + 1)
    if len(expanded) > DEPENDENCY_EXPANDED_LIMIT:
        raise ValueError('Dependency expansion limit exceeded')
    members, total, wrapper = {}, 0, None
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for index, member in enumerate(archive):
            path = PurePosixPath(member.name)
            if (not path.parts or path.is_absolute() or '..' in path.parts
                    or '\\' in member.name or any(ord(char) < 32 for char in member.name)
                    or not (member.isdir() or member.isreg()) or member.issparse()):
                raise ValueError('Unsafe dependency archive')
            # npm packages are not required to use the literal "package/" prefix:
            # DefinitelyTyped archives use e.g. "node/", "pg/" and "retry/".
            if wrapper is None:
                wrapper = path.parts[0]
            elif path.parts[0] != wrapper:
                raise ValueError('Mixed dependency archive roots')
            relative = path.relative_to(wrapper)
            if index >= 100000 or (str(relative) == '.' and not member.isdir()):
                raise ValueError('Conflicting dependency archive')
            # npm may place transitive dependencies here later; bundled dependencies are
            # deliberately not accepted without their own lockfile-integrity contract.
            if 'node_modules' in relative.parts:
                raise ValueError('Bundled dependencies require separate qualification')
            if member.isdir():
                if relative in members:
                    raise ValueError('Conflicting dependency archive')
                members[relative] = None
            else:
                with archive.extractfile(member) as source:
                    content = source.read(DEPENDENCY_EXPANDED_LIMIT + 1)
                total += len(content)
                if len(content) != member.size or total > DEPENDENCY_EXPANDED_LIMIT:
                    raise ValueError('Dependency size mismatch')
                value = (content, 0o755 if member.mode & 0o111 else 0o644)
                # Some locked npm archives repeat "./dist/index.js" as "dist/index.js".
                # Coalesce identical verified files, never apply last-entry-wins semantics.
                if relative in members and members[relative] != value:
                    raise ValueError('Conflicting dependency archive')
                members[relative] = value
    for relative in members:
        if any(parent in members and members[parent] is not None for parent in relative.parents):
            raise ValueError('Conflicting dependency parent')
    for relative, value in members.items():
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        if value is None:
            path.mkdir(exist_ok=True, mode=0o755)
        else:
            content, mode = value
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), mode)
                output.write(content)
    return total


def promote_dependencies(lock: dict, workspace: Path, cache: Path, destination: Path) -> None:
    """Reconstruct the dependency tree from signed lockfile hashes, never builder-owned files."""
    if lock.get('lockfileVersion') not in (2, 3) or not isinstance(lock.get('packages'), dict):
        raise ValueError('Unsupported dependency lockfile')
    total, binaries = 0, {}
    for name, package in sorted(lock['packages'].items()):
        if not name:
            continue
        if (not re.fullmatch(r'node_modules/(?:@[^/]+/)?[^/]+(?:/node_modules/(?:@[^/]+/)?[^/]+)*', name)
                or any(part in ('.', '..') for part in PurePosixPath(name).parts)
                or package.get('link') or 'integrity' not in package):
            raise ValueError('Unsupported locked dependency path')
        # npm selects optional platform packages. This hint can only omit an optional
        # package; it never authenticates any promoted bytes. Required entries fail closed.
        if package.get('optional') and not (workspace / name).is_dir():
            continue
        root = destination / name
        root.mkdir(parents=True, exist_ok=True, mode=0o755)
        total += unpack_dependency(cached_package(cache, package['integrity']), root)
        if total > DEPENDENCY_TOTAL_LIMIT:
            raise ValueError('Dependency tree limit exceeded')
        for executable, target in package.get('bin', {}).items():
            relative = PurePosixPath(target)
            if (not re.fullmatch(r'[A-Za-z0-9_.-]+', executable) or executable in ('.', '..')
                    or relative.is_absolute() or '..' in relative.parts or '\\' in target):
                raise ValueError('Unsafe dependency executable')
            parts = PurePosixPath(name).parts
            index = max(i for i, part in enumerate(parts) if part == 'node_modules')
            link = destination.joinpath(*parts[:index + 1]) / '.bin' / executable
            binaries.setdefault(link, set()).add(root / relative)
    for link, candidates in sorted(binaries.items()):
        allowed = {}
        for target in sorted(candidates):
            if not target.is_file() or target.is_symlink():
                raise ValueError('Missing dependency executable')
            target.chmod(0o755)
            allowed[os.path.relpath(target, link.parent)] = target
        if len(allowed) == 1:
            selected = next(iter(allowed))
        else:
            # Aliases may export the same bin (playwright-camoufox/playwright-core).
            # Read npm's choice as an untrusted string, never resolve/follow it. It
            # may only select an already verified, signed-lockfile-declared target.
            try:
                selected = os.readlink(workspace / link.relative_to(destination))
            except OSError:
                raise ValueError('Missing npm executable selection') from None
            if selected not in allowed:
                raise ValueError('Unapproved npm executable selection')
        link.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        link.symlink_to(selected)


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
            raise PreflightFailure('installation_changed')
        if (PREFIX / 'current').resolve() != self.previous.resolve():
            raise PreflightFailure('release_paths_changed')
        if self.release.exists():
            raise PreflightFailure('target_already_exists')
        source = json.loads((self.previous / 'host-manifest.json').read_text())
        if not compatible(source, self.request['target']):
            raise PreflightFailure('unsupported_manifest')
        if (self.previous / 'deploy/environment/runtime-pins.json').read_bytes() != (self.operation / 'source/deploy/environment/runtime-pins.json').read_bytes():
            raise PreflightFailure('runtime_pins_mismatch')
        self.verify_service_files(self.operation / 'source')
        self.checkpoint('stage')

    def verify_service_files(self, root: Path) -> None:
        """Fail before stopping services, including releases missing the Pi worker entrypoint."""
        for name in ('server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs'):
            path = root / name
            if not path.is_file() or any(part.is_symlink() for part in (path, *path.parents) if part == root or root in part.parents):
                raise PreflightFailure('missing_service_files')

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

    def prepare_node_runtime(self, source: Path) -> None:
        """Share an immutable Node runtime across releases when nodeSha256 is unchanged."""
        prev_pins = json.loads((self.previous / 'deploy/environment/runtime-pins.json').read_text())
        new_pins = json.loads((source / 'deploy/environment/runtime-pins.json').read_text())
        version = new_pins.get('nodeVersion')
        sha256 = new_pins.get('nodeSha256')
        if (isinstance(version, str) and re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,2}', version)
                and isinstance(sha256, str) and re.fullmatch(r'[a-f0-9]{64}', sha256)
                and prev_pins.get('nodeVersion') == version and prev_pins.get('nodeSha256') == sha256):
            runtimes = PREFIX / 'runtimes'
            if runtimes.is_symlink():
                raise ValueError('Unsafe runtimes directory')
            runtimes.mkdir(mode=0o755, exist_ok=True)
            if not runtimes.is_dir():
                raise ValueError('Unsafe runtimes directory')
            runtimes.chmod(0o755)
            shared = runtimes / f'node-{version}'
            if not shared.exists() and not shared.is_symlink():
                staging = runtimes / f".node-{version}.{self.request['operationId']}.tmp"
                if staging.exists() or staging.is_symlink():
                    raise ValueError('Conflicting runtime staging path')
                try:
                    shutil.copytree(self.previous / 'node', staging, symlinks=True)
                    self.run(['/bin/chmod', '-R', 'a+rX,go-w', str(staging)])
                    os.rename(staging, shared)
                except Exception:
                    if staging.exists() and not staging.is_symlink():
                        shutil.rmtree(staging, ignore_errors=True)
                    raise
            if shared.is_symlink() or not shared.is_dir() or (shared / 'bin/node').is_symlink() or not (shared / 'bin/node').is_file():
                raise ValueError('Unsafe shared Node runtime')
            (self.release / 'node').symlink_to(shared)
            return
        shutil.copytree(self.previous / 'node', self.release / 'node', symlinks=True)

    def stage(self) -> None:
        """Build in disposable user storage; promote only verified bytes into fresh root inodes."""
        source = self.operation / 'source'
        if any((source / name).exists() or (source / name).is_symlink() for name in ('node', 'node_modules')):
            raise ValueError('Release source contains reserved runtime paths')
        package = json.loads((source / 'package.json').read_text())
        lock = json.loads((source / 'package-lock.json').read_text())
        (self.operation / 'cancel').touch(mode=0o600)
        home, workspace = self.operation / 'build-home', self.operation / 'dependency-build'
        for directory in (home, workspace):
            directory.mkdir(mode=0o700)
        for name in ('package.json', 'package-lock.json'):
            shutil.copyfile(source / name, workspace / name)
            (workspace / name).chmod(0o644)  # The service's root UMask=0077 must not hide inputs from npm.
        # chown is the trust handoff, not npm's launch: an existing build-user process
        # can replace children immediately. No privileged pathname writes below these
        # directories are permitted after this point.
        for directory in (home, workspace):
            shutil.chown(directory, user='outpost-build', group='outpost-build')
        run_as_user(
            [str(self.previous / 'node/bin/node'),
             str(self.previous / 'node/lib/node_modules/npm/bin/npm-cli.js'),
             'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', str(home / 'cache')],
            user='outpost-build',
            cwd=workspace,
            env={'PATH': str(self.previous / 'node/bin') + ':/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8'},
            operation=self.operation,
            timeout=1200,
        )
        snapshot = self.operation / 'dependency-snapshot'
        snapshot.mkdir(mode=0o755)
        promote_dependencies(lock, workspace, home / 'cache', snapshot)
        shutil.copytree(source, self.release)
        self.prepare_node_runtime(source)
        (snapshot / 'node_modules').rename(self.release / 'node_modules')
        if package['dependencies']['@earendil-works/pi-coding-agent'] != self.request['target']['piVersion']:
            raise ValueError('Pi version does not match reviewed release')
        for extension in self.request['target']['extensions']:
            if package['dependencies'].get(extension['name']) != extension['version']:
                raise ValueError('Extension version does not match reviewed release')
        atomic_json(self.release / 'pi-release.json', {'id': self.request['releaseId'], 'piVersion': self.request['target']['piVersion'],
                    'lockHash': hashlib.sha256((self.release / 'package-lock.json').read_bytes()).hexdigest(), 'profile': str(DATA / 'worker/profile')}, 0o644)
        # Every final inode was created by root; changing ownership of builder
        # inodes here would not revoke descriptors retained by that account.
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
        self.verify_service_files(self.release)
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

    def verify_catalogue(self, release: str) -> list[str] | None:
        """Use the actual coordinator Gate in an isolated fixture, never a production task."""
        metadata = self.operation / 'authorization.json'
        # Ordinary updates have no publisher requirements; rollback must not demand new tools.
        if release != self.request['releaseId'] or not metadata.exists():
            return
        tools = json.loads(metadata.read_text())['requiredTools']
        if not tools:
            return
        if not isinstance(tools, list) or len(tools) > 128 or not all(isinstance(tool, str) and len(tool) <= 128 for tool in tools):
            raise ValueError('Invalid required tools')
        root = PREFIX / 'releases' / release
        browser = 'OUTPOST_BROWSER_ENABLED="true"' in (CONFIG / 'coordinator.env').read_text().splitlines()
        with tempfile.TemporaryDirectory(prefix='catalogue-', dir=self.operation) as directory:
            shutil.chown(directory, user='outpost-build', group='outpost-build')
            options = {'root': str(root), 'temporary': directory, 'tools': tools,
                       'hosts': bool(self.installation.get('fullControl')), 'browser': browser}
            script = 'const cfg = ' + json.dumps(options) + ';\n' + CATALOGUE_FIXTURE
            self.run(['/usr/sbin/runuser', '-u', 'outpost-build', '--', '/usr/bin/env',
                      f'HOME={directory}', f'TMPDIR={directory}', 'JITI_FS_CACHE=false', 'TSX_DISABLE_CACHE=1',
                      str(root / 'node/bin/node'), '--import', str(root / 'node_modules/tsx/dist/loader.mjs'),
                      '--input-type=module', '--eval', script], 60)
        return list(tools)

    def service_pids(self) -> tuple[tuple[str, int, int], ...]:
        """Check active/running state and retain PID plus restart count for every unit."""
        result = []
        for unit in self.units:
            process = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--no-pager',
                                      '--property=ActiveState,SubState,MainPID,NRestarts'],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/nonexistent'},
                                     timeout=5, check=True)
            if len(process.stdout) > 4096:
                raise ValueError('Unexpected service status')
            properties = dict(line.split('=', 1) for line in process.stdout.decode().splitlines() if '=' in line)
            pid, restarts = int(properties.get('MainPID', '0')), int(properties.get('NRestarts', '-1'))
            if properties.get('ActiveState') != 'active' or properties.get('SubState') != 'running' or pid <= 0 or restarts < 0:
                raise ValueError('Service is not durably running')
            result.append((unit, pid, restarts))
        return tuple(result)

    def verify_host_listener(self, opener) -> None:
        """Test listener and token enforcement without ever sending an executable command."""
        host_port = read_env_port(CONFIG / 'host.env', 'OUTPOST_HOST_PORT', 4519)
        with opener.open(f'http://127.0.0.1:{host_port}/health', timeout=2) as response:
            value = json.loads(response.read(32768))
            if value.get('ready') is not True or value.get('host') != 'local':
                raise ValueError('Host listener mismatch')
        token = (CONFIG / 'coordinator/host-token').read_text().strip()
        if not token:
            raise ValueError('Missing host authentication')
        for supplied, expected in (('', 401), ('Bearer ' + token, 404)):
            request = urllib.request.Request(f'http://127.0.0.1:{host_port}/outpost-update-auth-probe',
                                             headers={'Authorization': supplied})
            try:
                with opener.open(request, timeout=2):
                    raise ValueError('Host authentication not enforced')
            except urllib.error.HTTPError as error:
                try:
                    if error.code != expected:
                        raise ValueError('Host authentication mismatch') from None
                finally:
                    error.close()

    def health(self, release: str) -> None:
        """Require eight consecutive seconds of authenticated readiness and stable service PIDs."""
        verified_tools = self.verify_catalogue(release)
        coordinator_port = read_env_port(CONFIG / 'coordinator.env', 'PORT', 4518)
        worker_port = read_env_port(CONFIG / 'worker.env', 'OUTPOST_PI_WORKER_PORT', 4520)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        deadline = time.monotonic() + 180
        previous, stable_since, observations = None, None, 0
        while time.monotonic() < deadline:
            try:
                with opener.open(f'http://127.0.0.1:{coordinator_port}/v2/environment', timeout=2) as response:
                    value = json.loads(response.read(32768))
                    if (value.get('environmentId') != self.request['environmentId'] or value.get('protocolVersion') != 2
                            or response.headers.get('x-outpost-environment-id') != self.request['environmentId']
                            or value.get('runtime', {}).get('release') != release):
                        raise ValueError('Unexpected environment or release')
                token = (CONFIG / 'coordinator/worker-token').read_text().strip()
                packet = {'type': 'management', 'owner': self.request['deviceId'], 'request': {'type': 'runtime.inventory'}}
                request = urllib.request.Request(f'http://127.0.0.1:{worker_port}/v1', data=json.dumps(packet).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with opener.open(request, timeout=3) as response:
                    if json.loads(response.read(32768)).get('releaseId') != release:
                        raise ValueError('Worker release mismatch')
                if self.installation.get('fullControl'):
                    self.verify_host_listener(opener)
                pids = self.service_pids()
                now = time.monotonic()
                if pids != previous:
                    previous, stable_since, observations = pids, now, 0
                observations += 1
                if observations >= 5 and now - stable_since >= 8:
                    self.status['health'] = {'releaseId': release, 'stableSeconds': int(now - stable_since),
                                            'services': [{'unit': unit, 'pid': pid, 'restarts': restarts} for unit, pid, restarts in pids]}
                    if verified_tools is not None:
                        self.status['health']['requiredTools'] = verified_tools
                    atomic_json(self.operation / 'status.json', self.status, 0o644)
                    return
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                previous, stable_since, observations = None, None, 0
            time.sleep(1)
        raise RuntimeError('Health verification failed')

    def release_hold(self) -> None:
        """Release the worker and coordinator only after independently verified health."""
        worker_port = read_env_port(CONFIG / 'worker.env', 'OUTPOST_PI_WORKER_PORT', 4520)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        packet = {'type': 'management', 'owner': self.request['deviceId'], 'request': {'type': 'maintenance.release', 'operationId': self.request['operationId']}}
        request = urllib.request.Request(f'http://127.0.0.1:{worker_port}/v1', data=json.dumps(packet).encode(), headers={
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

    def cleanup_scratch(self) -> None:
        """Delete disposable build scratch directories while retaining receipts and logs."""
        for name in SCRATCH_DIRECTORIES:
            path = self.operation / name
            try:
                info = path.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                continue
            try:
                shutil.rmtree(path)
            except OSError:
                pass

    def _referenced_releases(self) -> set[str]:
        """Retain any release still referenced by coordinator.env (e.g. shared browser runtime)."""
        referenced: set[str] = set()
        env_path = CONFIG / 'coordinator.env'
        try:
            fd = os.open(env_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    return referenced
                with os.fdopen(fd, 'rb', closefd=False) as source:
                    raw = source.read(ENV_FILE_LIMIT + 1)
            finally:
                os.close(fd)
            if len(raw) > ENV_FILE_LIMIT:
                return referenced
            text = raw.decode('utf-8')
        except (OSError, UnicodeDecodeError):
            return referenced
        releases_prefix = str(PREFIX / 'releases') + '/'
        for match in re.finditer(re.escape(releases_prefix) + r'(host-[a-f0-9]{20})(?:/|["\'\s]|$)', text):
            referenced.add(match.group(1))
        return referenced

    def prune_old_releases(self) -> None:
        """Retain current and previous releases; remove older host-* release directories safely."""
        try:
            if PREFIX.is_symlink():
                return
            releases_dir = PREFIX / 'releases'
            if not releases_dir.exists() or releases_dir.is_symlink() or not releases_dir.is_dir():
                return
            keep = {self.release.name, self.previous.name}
            current = PREFIX / 'current'
            if current.exists() or current.is_symlink():
                try:
                    resolved = current.resolve(strict=True)
                    if resolved.parent == releases_dir.resolve(strict=True):
                        keep.add(resolved.name)
                except OSError:
                    return
            keep.update(self._referenced_releases())
            with os.scandir(releases_dir) as entries:
                for entry in entries:
                    if not re.fullmatch(r'host-[a-f0-9]{20}', entry.name) or entry.name in keep:
                        continue
                    try:
                        info = os.lstat(entry.path)
                    except OSError:
                        continue
                    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                        continue
                    try:
                        shutil.rmtree(entry.path)
                    except OSError:
                        pass
        except OSError:
            pass

    def execute(self) -> None:
        """Never auto-resume an interrupted transaction or discard partial staging."""
        with (OPERATIONS.parent / 'install.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.execute_locked()

    def execute_locked(self) -> None:
        """Execute while the caller retains the shared installation lock for the entire transaction."""
        failure_stage = 'preflight'
        try:
            self.preflight()
            failure_stage = 'staging'
            self.publish('staging', 'Installing qualified locked dependencies')
            self.stage()
            failure_stage = 'waiting_for_idle'
            self.wait_for_idle()
            failure_stage = 'activating'
            self.publish('activating', 'Activating the reviewed release')
            self.switch()
            failure_stage = 'health_verification'
            self.health(self.request['releaseId'])
            failure_stage = 'committing'
            self.installation['release'] = self.request['releaseId']
            atomic_json(CONFIG / 'installation.json', self.installation, 0o644)
            # Once dispatch may be released, a late receipt/transport failure must
            # never restart services underneath newly admitted work.
            self.committed = True
            failure_stage = 'releasing_dispatch'
            self.release_hold()
            failure_stage = 'final_receipt'
            self.publish('complete', 'Release and authenticated worker health verified')
            self.cleanup_scratch()
            self.prune_old_releases()
        except Exception as error:
            code = error.code if failure_stage == 'preflight' and isinstance(error, PreflightFailure) else failure_stage + '_failed'
            # Legacy abort records cancellation on the coordinator; retain the actual
            # host failure independently, including when abort or rollback also fails.
            self.status.update(failureCode=code, failureStage=failure_stage)
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
                    self.cleanup_scratch()
                else:
                    # No activation occurred. Abort only an unheld operation;
                    # never clear a worker hold whose acquisition was ambiguous.
                    self.checkpoint('abort')
                    self.publish('failed', PREFLIGHT_FAILURES.get(code, 'Update stopped before activation; previous release remains active'))
                    self.cleanup_scratch()
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
