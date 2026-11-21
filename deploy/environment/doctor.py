#!/usr/bin/env python3
"""Inspect a native Outpost installation without running deployed code or systemd."""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import time
import tomllib
from pathlib import Path

from common import CONFIG, DATA, PREFIX, UNIT_DIRECTORY

READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
MAX_METADATA = 2 * 1024 * 1024


def metadata(path: Path) -> str:
    """Read bounded, non-secret metadata without following a leaf symlink."""
    with os.fdopen(os.open(path, READ_FLAGS), 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('not a regular file')
        raw = stream.read(MAX_METADATA + 1)
        if len(raw) > MAX_METADATA:
            raise ValueError('metadata too large')
        return raw.decode('utf-8')


def executable(path: Path, prefix: Path) -> bool:
    """Allow in-prefix runtime links, including shared Node and Python."""
    target = path.resolve(strict=True)
    info = target.stat()
    return (target.is_relative_to(prefix) and stat.S_ISREG(info.st_mode)
            and bool(info.st_mode & 0o111) and not info.st_mode & 0o022)


def env_mode(config: Path, name: str, uid: int, fix: bool) -> bool:
    """Only tighten known env files in a protected directory, never read their contents."""
    directory = os.open(config, READ_FLAGS | os.O_DIRECTORY)
    try:
        parent = os.fstat(directory)
        if parent.st_uid != uid or parent.st_mode & 0o022:
            return False
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1:
            return False
        mode = stat.S_IMODE(info.st_mode)
        if mode == 0o600:
            return True
        if not fix or mode & 0o600 != 0o600:
            return False
        fd = os.open(name, READ_FLAGS, dir_fd=directory)
        try:
            if os.fstat(fd) != info:
                return False
            os.fchmod(fd, 0o600)
            return True
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def inspect(root: Path, browser: bool, full_control: bool, uv_dirs: list[Path],
            stale_seconds: int, fix: bool, uid: int) -> list[str]:
    """Return actionable findings for the selected native installation profile."""
    findings: list[str] = []

    def check(label, predicate):
        try:
            if predicate():
                return
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            pass
        findings.append(label)

    prefix, config, data, units = (root / path.relative_to('/') for path in (PREFIX, CONFIG, DATA, UNIT_DIRECTORY))
    current = prefix / 'current'
    try:
        release = current.resolve(strict=True)
        if (not current.is_symlink() or not release.is_dir()
                or release.parent != prefix / 'releases' or release.stat().st_mode & 0o022):
            raise ValueError('not a protected native release')
    except (OSError, ValueError, RuntimeError):
        findings.append('current: expected a valid symlink to a protected directory under releases/')
        release = None

    if release is not None:
        check('Node: missing, broken, insecure or non-executable node/bin/node',
              lambda: executable(release / 'node/bin/node', prefix))
        if browser:
            project = release / 'server/browser-engine'
            check('Python: missing, broken, insecure or non-executable browser venv interpreter',
                  lambda: executable(project / '.venv/bin/python', prefix))
            check('uv: missing, broken, insecure or non-executable node/bin/uv',
                  lambda: executable(release / 'node/bin/uv', prefix))
            check('uv.lock: missing or invalid browser dependency lock',
                  lambda: bool(tomllib.loads(metadata(project / 'uv.lock')).get('package')))

            def browser_cache() -> bool:
                pins = json.loads(metadata(release / 'deploy/environment/runtime-pins.json'))
                slot = pins['camoufoxVersion'] + '-' + pins['camoufoxBuild']
                if not re.fullmatch(r'[A-Za-z0-9.-]+', slot) or slot in ('.', '..'):
                    return False
                cache = release / 'browsers/camoufox/browsers/official' / slot
                if cache.resolve(strict=True) != cache:
                    return False
                version = json.loads(metadata(cache / 'version.json'))
                return (all(version[key] == pins[pin] for key, pin in (
                    ('version', 'camoufoxVersion'), ('build', 'camoufoxBuild'),
                    ('interface', 'camoufoxInterface'), ('sha256', 'camoufoxSha256')))
                    and executable(cache / 'camoufox-bin', cache))

            check('Browser cache: missing executable or metadata does not match Camoufox pins', browser_cache)

    for name, mode in [('coordinator', 0o700), ('worker', 0o700), ('workspaces', 0o2770)]:
        def data_mode() -> bool:
            info = (data / name).lstat()
            return stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == mode
        check(f'Data permissions: {name} must be a directory with mode {mode:04o}', data_mode)


    for name, user, entry in [('worker', 'outpost-pi', 'server/pi-worker/main.ts'),
                              ('coordinator', 'outpost-coord', 'server/main.ts'),
                              *([('host', 'root', 'deploy/agent/host-executor.mjs')] if full_control else [])]:
        check(f'Config permissions: {name}.env must be a protected, singly linked 0600 file',
              lambda: env_mode(config, f'{name}.env', uid, fix))

        def unit_valid() -> bool:
            unit = units / f'outpost-native-{name}.service'
            if unit.lstat().st_mode & 0o022 or release is None:
                return False
            args = '' if name == 'host' else ' --import tsx'
            # A fixture mirrors absolute installed paths, not the fixture's temporary prefix.
            installed = Path('/') / release.relative_to(root)
            required = {'User': [user], 'EnvironmentFile': [f'{CONFIG}/{name}.env'],
                        'ExecStart': [f'{installed}/node/bin/node{args} {installed}/{entry}']}
            service = False
            values: dict[str, list[str]] = {key: [] for key in required}
            for line in metadata(unit).splitlines():
                line = line.strip()
                if line.startswith('['):
                    service = line == '[Service]'
                key, sep, value = line.partition('=')
                if service and sep and key.strip() in values:
                    values[key.strip()].append(value.strip())
            return values == required

        check(f'Systemd unit: {name} missing, unsafe or does not match the active release', unit_valid)

    cutoff = time.time() - stale_seconds
    for index, directory in enumerate(uv_dirs, 1):
        try:
            if not stat.S_ISDIR(directory.lstat().st_mode):
                raise ValueError('not a directory')
            for lock in sorted(directory.glob('uv-*.lock')):
                info = lock.lstat()
                if stat.S_ISLNK(info.st_mode):
                    findings.append(f'uv lock directory {index}: unexpected symlink')
                elif stat.S_ISREG(info.st_mode) and info.st_size == 0 and info.st_mtime <= cutoff:
                    findings.append(f'uv lock directory {index}: old empty lock candidate; review for active use (not removed)')
        except (OSError, ValueError):
            findings.append(f'uv lock directory {index}: unable to inspect')
    return findings


def main() -> int:
    """Run the check or the explicitly requested limited permissions repair."""
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--fix', action='store_true', help='only tighten protected native env files to 0600')
    parser.add_argument('--root', type=Path, default=Path('/'), help='alternate fixture filesystem root')
    parser.add_argument('--browser', action='store_true', help='check the optional Camoufox installation')
    parser.add_argument('--full-control', action='store_true', help='check the optional host executor unit')
    parser.add_argument('--uv-lock-dir', action='append', type=Path, default=[], help='inspect a known uv lock directory (repeatable; nonrecursive)')
    parser.add_argument('--stale-seconds', type=int, default=86400)
    args = parser.parse_args()
    if args.stale_seconds <= 0 or not args.root.is_dir():
        parser.error('use a positive stale threshold and an existing root directory')
    root = args.root.resolve()
    if args.fix and root == Path('/') and os.geteuid() != 0:
        parser.error('permission repair on the installed filesystem requires root')
    findings = inspect(root, args.browser, args.full_control, args.uv_lock_dir,
                       args.stale_seconds, args.fix,
                       0 if root == Path('/') else os.geteuid())
    for finding in findings:
        print(f'FAIL {finding}')
    print(f'Native doctor: {len(findings)} finding(s)')
    return int(bool(findings))


if __name__ == '__main__':
    raise SystemExit(main())
