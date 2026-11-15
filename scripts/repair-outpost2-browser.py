
"""Operator-run repair for ONE failed installation; not an installer or resume API.

Run as root: --check (the default), optionally --launcher /path/to/launch.py;
--apply requires --launcher. The supplied file is read once, never imported.
Only the release launcher, a new fontconfig directory, and private operation
audit/staging files are written. No browser, installer, or service is started.
Incomplete audits/staging files are retained for manual review, never cleaned up.
The release identity thereafter means original bundle + documented local hotfix,
NOT byte-identical source; future maintenance may correctly reject source drift.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import grp
import hashlib
import json
import os
import pwd
import stat
import subprocess
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

OPERATION_ID = '645f62a9-37c8-413e-b31e-9372bc2ed774'
ENVIRONMENT_ID = 'cbfedef7-2f91-4b6d-8ba8-d4c1f5ea5a6b'
RELEASE_ID = 'host-fa9eb6b5d217af95b920'
ORIGINAL_SHA256 = '1b53161569e3d26424f6f6b36e565209cc639dc934056f47cb902ef998f52a00'
REPLACEMENT_SHA256 = '467d6f496c9d0ab06ba10799269e13f4cf8738ea6bdb01f4293412ffa50a07b2'
# Parent-verified original plan 29be1b0d-e34e-49e2-9a21-2b8fa18216f2, not the rebuilt bundle.
ARCHIVE_SHA256 = 'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57'
ARCHIVE_SIZE = 223402
LAUNCHER = Path('server/browser-engine/launch.py')
AUDIT_PREFIX = 'browser-hotfix-'
PROVENANCE = ('Operator-approved local HOME allowlist launcher hotfix; original bundle plus '
              'documented hotfix, not a byte-identical release. No resume or qualification.')
IDENTITIES = {'operationId': OPERATION_ID, 'environmentId': ENVIRONMENT_ID, 'releaseId': RELEASE_ID}
UNITS = (f'outpost-setup-{OPERATION_ID}.service', 'outpost-native-worker.service',
         'outpost-native-coordinator.service', 'outpost-native-host.service')
BACKUPS = ('launch.py', 'status.json', 'request.json', 'command.log', 'launch.log')


class Refused(RuntimeError):
    """A fixed, non-secret refusal suitable for operator output."""


def require(condition: bool, message: str) -> None:
    """Fail without interpolating host data or exception text."""
    if not condition:
        raise Refused(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def metadata(info: os.stat_result) -> dict:
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)


def stamp(info: os.stat_result) -> tuple:
    return (*identity(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def encoded(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def document(data: bytes) -> dict:
    """Reject ambiguous duplicate fields as well as malformed JSON."""
    def unique(pairs: list) -> dict:
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON field.')
            result[key] = value
        return result
    value = json.loads(data, object_pairs_hook=unique)
    require(type(value) is dict, 'Expected a JSON object.')
    return value


@dataclass(frozen=True)
class Layout:
    """Root remapping is for local tests only; there is no CLI path override."""
    root: Path = Path('/')

    def path(self, absolute: str) -> Path:
        return self.root / absolute.lstrip('/')

    @property
    def operation(self) -> Path:
        return self.path('/var/lib/outpost-setup/operations') / OPERATION_ID

    @property
    def release(self) -> Path:
        return self.path('/opt/outpost-native/releases') / RELEASE_ID

    @property
    def fontconfig(self) -> Path:
        return self.release / 'browsers/camoufox/fontconfig'


class Files:
    """Descriptor-relative, no-follow I/O with optimistic evidence rechecks.

    The install lock serializes cooperating installers. Rechecks detect other
    edits; this is not a defense against a hostile root process racing rename.
    """
    def __init__(self) -> None:
        self.dirs: dict[Path, tuple] = {}
        self.reads: dict[Path, tuple[bytes, os.stat_result]] = {}
        self.listings: dict[Path, set[str]] = {}
        self.missing: set[Path] = set()

    @contextmanager
    def directory(self, path: Path):
        require(path.is_absolute() and '..' not in path.parts, 'Unsafe path.')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        current = Path('/')
        try:
            for part in path.parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
                current /= part
                found = identity(os.fstat(fd))
                require(self.dirs.setdefault(current, found) == found, 'Directory changed during review.')
            yield fd
        finally:
            os.close(fd)

    @contextmanager
    def regular(self, path: Path):
        with self.directory(path.parent) as parent:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Unsafe regular file.')
                yield fd, info
                require(stamp(os.fstat(fd)) == stamp(info) == stamp(os.stat(path.name, dir_fd=parent, follow_symlinks=False)),
                        'File changed during review.')
            finally:
                os.close(fd)

    def read(self, path: Path, bound: int, owner: int | None = 0) -> tuple[bytes, os.stat_result]:
        with self.regular(path) as (fd, info):
            require(owner is None or info.st_uid == owner, 'Unexpected file owner.')
            require(info.st_size <= bound, 'File exceeds reviewed size bound.')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                data = stream.read(bound + 1)
            require(len(data) == info.st_size and len(data) <= bound, 'File changed or exceeds bound.')
        previous = self.reads.setdefault(path, (data, info))
        require(previous[0] == data and stamp(previous[1]) == stamp(info), 'Retained evidence changed.')
        return data, info

    def entries(self, path: Path, uid: int, gid: int | None = None, mode: int | None = None) -> set[str]:
        with self.directory(path) as fd:
            info = os.fstat(fd)
            require(info.st_uid == uid and (gid is None or info.st_gid == gid), 'Unexpected directory owner.')
            require(mode is None or stat.S_IMODE(info.st_mode) == mode, 'Unexpected directory permissions.')
            names = set(os.listdir(fd))
        require(self.listings.setdefault(path, names) == names, 'Directory contents changed.')
        return names

    def absent(self, path: Path) -> None:
        with self.directory(path.parent) as fd:
            try:
                os.stat(path.name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                self.missing.add(path)
            else:
                raise Refused('Unexpected existing path; nothing will be removed.')

    def verify(self) -> None:
        """Recheck evidence and guarded directory contents immediately before effects."""
        for path in list(self.dirs):
            with self.directory(path):
                pass
        for path, (data, info) in list(self.reads.items()):
            self.read(path, len(data), info.st_uid)
        for path, names in self.listings.items():
            with self.directory(path) as fd:
                require(set(os.listdir(fd)) == names, 'Directory contents changed.')
        for path in list(self.missing):
            self.absent(path)

    def mkdir(self, path: Path, uid: int, gid: int, mode: int) -> None:
        """Set ownership/permissions ONLY on this exclusively created directory."""
        with self.directory(path.parent) as parent:
            os.mkdir(path.name, 0o700, dir_fd=parent)
            fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                os.fchown(fd, uid, gid)
                os.fchmod(fd, mode)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)
        self.missing.discard(path)
        if path.parent in self.listings:
            self.listings[path.parent] = self.listings[path.parent] | {path.name}

    def create(self, path: Path, data: bytes, *, uid: int = 0, gid: int = 0, mode: int = 0o600) -> None:
        """Never truncate or reuse any existing backup or staging file."""
        with self.directory(path.parent) as parent:
            fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fchown(stream.fileno(), uid, gid)
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            os.fsync(parent)
        if path.parent in self.listings:
            self.listings[path.parent] = self.listings[path.parent] | {path.name}
        self.read(path, len(data), uid)


def inactive_units() -> None:
    """Only query systemd; errors and ambiguous/transitional states refuse repair."""
    for unit in UNITS:
        reply = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--no-pager',
                                '--property=LoadState,ActiveState,MainPID,ControlPID,Job'],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, timeout=5, check=False)
        require(reply.returncode == 0 and len(reply.stdout) <= 4096, 'Cannot establish inactive units.')
        values = dict(line.split('=', 1) for line in reply.stdout.decode().splitlines())
        require(set(values) == {'LoadState', 'ActiveState', 'MainPID', 'ControlPID', 'Job'}
                and values['LoadState'] in ('loaded', 'not-found') and values['ActiveState'] == 'inactive'
                and values['MainPID'] == values['ControlPID'] == '0' and values['Job'] in ('', '0'),
                'Setup/native units must be inactive or absent, without pending jobs.')


def inspect(files: Files, layout: Layout) -> tuple[dict, pwd.struct_passwd]:
    """Check only the retained failed-before-configuration state we reviewed."""
    build = pwd.getpwnam('outpost-build')
    coord = pwd.getpwnam('outpost-coord')
    worker = pwd.getpwnam('outpost-pi')
    shared = grp.getgrnam('outpost-workspaces')
    require(len({build.pw_uid, coord.pw_uid, worker.pw_uid, 0}) == 4, 'Unexpected service accounts.')
    operation, release = layout.operation, layout.release
    for path in (operation.parent.parent, operation.parent, operation):
        files.entries(path, 0, mode=0o711)
    require(files.entries(layout.path('/opt/outpost-native'), 0, mode=0o755) == {'releases'}, 'Unexpected native prefix.')
    require(files.entries(release.parent, 0, mode=0o755) == {RELEASE_ID}, 'Unexpected native releases.')
    files.entries(release, build.pw_uid, build.pw_gid, 0o755)
    require(not files.entries(layout.path('/etc/outpost-native'), 0, mode=0o755), 'Configuration is not empty.')
    data = layout.path('/var/lib/outpost-native')
    require(files.entries(data, 0, mode=0o711) == {'coordinator', 'worker', 'workspaces'}, 'Unexpected native data.')
    for name, uid, gid, mode in (('coordinator', coord.pw_uid, coord.pw_gid, 0o700),
                                 ('worker', worker.pw_uid, worker.pw_gid, 0o700),
                                 ('workspaces', coord.pw_uid, shared.gr_gid, 0o2770)):
        require(not files.entries(data / name, uid, gid, mode), 'Native data directory is not empty.')
    files.absent(layout.path('/opt/outpost-native/current'))
    files.absent(release / 'pi-release.json')
    for unit in UNITS[1:]:
        files.absent(layout.path('/etc/systemd/system') / unit)
        files.absent(layout.path('/etc/systemd/system') / (unit + '.d'))
    cancel, cancel_info = files.read(operation / 'cancel', 1, None)
    require(not cancel and stat.S_IMODE(cancel_info.st_mode) == 0o600, 'Cancellation marker must be empty and private.')
    request = document(files.read(operation / 'request.json', 16384)[0])
    status = document(files.read(operation / 'status.json', 65536)[0])
    require(set(request) == {*IDENTITIES, 'deviceId', 'publicKey', 'label', 'sha256', 'size', 'browser', 'coexistence', 'fullControl'},
            'Unexpected request schema.')
    require(set(status) == {*IDENTITIES, 'state', 'completedSteps', 'totalSteps', 'stage', 'startedAt', 'updatedAt', 'log', 'error'},
            'Unexpected status schema.')
    require(isinstance(request['deviceId'], str) and str(uuid.UUID(request['deviceId'])) == request['deviceId']
            and isinstance(request['publicKey'], str) and len(base64.b64decode(request['publicKey'], validate=True)) == 32
            and all(request[key] is True for key in ('coexistence', 'fullControl'))
            and isinstance(request['label'], str) and 1 <= len(request['label']) <= 80
            and all(32 <= ord(char) != 127 for char in request['label']), 'Unexpected request fields.')
    for value in (request, status):
        require(all(value.get(key) == expected for key, expected in IDENTITIES.items()), 'Operation identities do not match.')
    require(request.get('browser') is True and request.get('sha256') == ARCHIVE_SHA256
            and type(request.get('size')) is int and request['size'] == ARCHIVE_SIZE, 'Unexpected reviewed browser request.')
    require(status.get('state') == 'failed' and type(status.get('completedSteps')) is int
            and status['completedSteps'] == 4 and type(status.get('totalSteps')) is int
            and status['totalSteps'] == 12 and status.get('stage') == 'Browser runtime', 'Not the reviewed failed 4/12 state.')
    archive = files.read(operation / 'release.tar.gz', ARCHIVE_SIZE)[0]
    require(len(archive) == request['size'] and digest(archive) == request['sha256'], 'Retained archive mismatch.')
    source = files.read(operation / 'source' / LAUNCHER, 16384)[0]
    require(digest(source) == ORIGINAL_SHA256, 'Retained source launcher mismatch.')
    for path, mode in ((operation / 'release.tar.gz', 0o644), (operation / 'source' / LAUNCHER, 0o644)):
        require(metadata(files.reads[path][1]) == {'uid': 0, 'gid': 0, 'mode': mode}, 'Unexpected retained artifact permissions.')
    launcher = files.read(release / LAUNCHER, 16384, build.pw_uid)
    require(metadata(launcher[1]) == {'uid': build.pw_uid, 'gid': build.pw_gid, 'mode': 0o644}, 'Unexpected launcher permissions.')
    backups = {'launch.py': launcher}
    for name, bound in (('status.json', 65536), ('request.json', 16384), ('command.log', 8 * 1024 * 1024), ('launch.log', 1024 * 1024)):
        backups[name] = files.read(operation / name, bound)
        require(metadata(backups[name][1]) == {'uid': 0, 'gid': 0, 'mode': 0o644 if name == 'status.json' else 0o600},
                'Unexpected retained evidence permissions.')
    # Existing extraction ancestors are checked, never chmodded/chowned.
    for path in (release / 'browsers', release / 'browsers/camoufox'):
        files.entries(path, 0, mode=0o755)
    files.entries(operation / 'build-home', build.pw_uid, build.pw_gid, 0o700)
    inactive_units()
    return backups, build


def manifest(audit: Path, backups: dict, build: pwd.struct_passwd) -> dict:
    """Immutable provenance, durably recorded before any artifact mutation."""
    return dict(schema=1, **IDENTITIES, auditId=audit.name, provenance=PROVENANCE,
                originalSha256=ORIGINAL_SHA256, replacementSha256=REPLACEMENT_SHA256,
                archiveSha256=ARCHIVE_SHA256, archiveSize=ARCHIVE_SIZE,
                fontconfig={'relativePath': 'browsers/camoufox/fontconfig', 'uid': build.pw_uid, 'gid': build.pw_gid, 'mode': 0o755},
                backups={name: dict(sha256=digest(data), size=len(data), **metadata(info))
                         for name, (data, info) in backups.items()})


def verified_audit(files: Files, layout: Layout, backups: dict, build: pwd.struct_passwd, audit: Path) -> None:
    """No repair/reuse of an incomplete, altered, or unknown audit."""
    suffix = audit.name.removeprefix(AUDIT_PREFIX)
    require(str(uuid.UUID(suffix)) == suffix, 'Unknown audit directory.')
    require(files.entries(audit, 0, 0, 0o700) == {*BACKUPS, 'manifest.json', 'applied.json'}, 'Incomplete or unknown audit contents.')
    original_backups = dict(backups)
    for name in BACKUPS:
        data, info = files.read(audit / name, 8 * 1024 * 1024)
        require(metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Audit is not private.')
        if name == 'launch.py':
            require(digest(data) == ORIGINAL_SHA256, 'Original launcher backup mismatch.')
            original_backups[name] = (data, backups[name][1])
        else:
            require(data == backups[name][0], 'Audit evidence no longer matches retained operation.')
    expected = encoded(manifest(audit, original_backups, build))
    require(files.read(audit / 'manifest.json', 16384)[0] == expected, 'Hotfix provenance mismatch.')
    require(not files.entries(layout.fontconfig, build.pw_uid, build.pw_gid, 0o755), 'Audited fontconfig directory changed; review manually.')
    with files.directory(layout.fontconfig) as fd:
        directory_id = list(identity(os.fstat(fd)))
    completion = {'schema': 1, 'manifestSha256': digest(expected), 'launcherSha256': REPLACEMENT_SHA256, 'fontconfigIdentity': directory_id}
    require(files.read(audit / 'applied.json', 16384)[0] == encoded(completion), 'Hotfix completion mismatch.')
    for name in ('manifest.json', 'applied.json'):
        require(metadata(files.reads[audit / name][1]) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Audit is not private.')


def repair(*, apply: bool = False, launcher: Path | None = None, layout: Layout = Layout()) -> str:
    """Testable local entry point; all production identities/paths/payloads are pinned."""
    require(os.geteuid() == 0, 'Root is required, including for --check.')
    require(not apply or launcher is not None, '--apply requires --launcher.')
    replacement = None
    if launcher is not None:
        # A separate reader deliberately does not reopen a caller-supplied payload.
        replacement = Files().read(launcher.absolute(), 16384, None)[0]
        require(digest(replacement) == REPLACEMENT_SHA256, 'Replacement payload hash mismatch.')
        compile(replacement, '<reviewed-launcher>', 'exec')
    files = Files()
    lock_path = layout.path('/var/lib/outpost-setup/install.lock')
    with files.regular(lock_path) as (lock, info):
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) & 0o022 == 0, 'Unsafe original install lock.')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Original install lock is held; no changes made.') from None
        require(stamp(files.read(lock_path, 4096)[1]) == stamp(info), 'Original install lock was replaced.')
        backups, build = inspect(files, layout)
        engine_entries = files.entries((layout.release / LAUNCHER).parent, build.pw_uid, build.pw_gid)
        require(not any(name.startswith('.outpost2-launch-') for name in engine_entries), 'Retained staging file requires manual review.')
        audits = sorted(name for name in files.listings[layout.operation] if name.startswith(AUDIT_PREFIX))
        current_hash = digest(backups['launch.py'][0])
        if audits:
            require(len(audits) == 1 and current_hash == REPLACEMENT_SHA256, 'Partial or mismatching audit; manual review required.')
            verified_audit(files, layout, backups, build, layout.operation / audits[0])
            files.verify()
            return 'Already applied; exact hotfix and private audit verified. No changes made.'
        require(current_hash == ORIGINAL_SHA256, 'Release launcher is not the pinned original.')
        files.absent(layout.fontconfig)
        files.verify()
        if not apply:
            return 'Check passed; no changes made. This is not runtime qualification or permission to resume.'
        if replacement is None:
            raise Refused('--apply requires --launcher.')
        audit = layout.operation / (AUDIT_PREFIX + str(uuid.uuid4()))
        files.mkdir(audit, 0, 0, 0o700)
        for name, (data, _) in backups.items():
            files.create(audit / name, data)
        provenance = encoded(manifest(audit, backups, build))
        files.create(audit / 'manifest.json', provenance)
        staged = (layout.release / LAUNCHER).with_name('.outpost2-launch-' + audit.name + '.tmp')
        files.create(staged, replacement, **metadata(backups['launch.py'][1]))
        inactive_units()
        files.verify()
        files.mkdir(layout.fontconfig, build.pw_uid, build.pw_gid, 0o755)
        require(not files.entries(layout.fontconfig, build.pw_uid, build.pw_gid, 0o755), 'Fontconfig directory changed.')
        files.verify()
        target = layout.release / LAUNCHER
        with files.directory(target.parent) as parent:
            files.read(staged, 16384, build.pw_uid)
            files.read(target, 16384, build.pw_uid)
            os.replace(staged.name, target.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        del files.reads[target], files.reads[staged]
        files.listings[target.parent] = files.listings[target.parent] - {staged.name}
        require(digest(files.read(target, 16384, build.pw_uid)[0]) == REPLACEMENT_SHA256, 'Post-patch launcher mismatch.')
        with files.directory(layout.fontconfig) as fd:
            directory_id = list(identity(os.fstat(fd)))
        files.create(audit / 'applied.json', encoded({'schema': 1, 'manifestSha256': digest(provenance),
                     'launcherSha256': REPLACEMENT_SHA256, 'fontconfigIdentity': directory_id}))
        files.verify()
        return ('Applied: original bundle plus documented local hotfix (not byte-identical). '
                'Receipt unchanged; no resume or runtime qualification. Audit: ' + str(audit))


def main(argv: list[str] | None = None) -> int:
    """No remote target, alternative operation, resume, or policy switches."""
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='read-only preflight (default)')
    mode.add_argument('--apply', action='store_true', help='apply only this audited hotfix')
    parser.add_argument('--launcher', type=Path, help='provided fixed launcher; required with --apply')
    args = parser.parse_args(argv)
    try:
        print(repair(apply=args.apply, launcher=args.launcher))
    except Refused as error:
        print('REFUSED: ' + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, SyntaxError, subprocess.SubprocessError):
        print('REFUSED: unsafe/unavailable or changed host evidence. Any partial audit/staging files are retained; review manually. No retry or cleanup was attempted.', file=sys.stderr)
        return 1
    if args.apply:
        release, operation = Layout().release, Layout().operation
        print('NOT RUN: separately review this full-launcher check and capture output privately in NEW files, not retained logs. '
              'It can start a GPU probe and write cache/config; it is not general runtime qualification. '
              'Do not invoke the installer or change the failed receipt. Subsequent cache changes require manual review, not another repair.')
        print(f'cd {release} && sudo /usr/bin/timeout --signal=TERM --kill-after=5s 120s '
              f'/usr/sbin/runuser -u outpost-build -- /usr/bin/env -i '
              f'HOME={operation}/build-home XDG_CACHE_HOME={release}/browsers '
              f'PATH={release}/node/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 '
              f'UV_PYTHON_INSTALL_DIR={release}/python UV_CACHE_DIR={operation}/build-home/cache '
              f'{release}/server/browser-engine/.venv/bin/python -B {release / LAUNCHER}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
