"""Operator-run, ONE-operation continuation; not a resume API.

Root-only, read-only structural AND authenticated-content checks by default.
Module byte pins are reviewed for READ-ONLY --check only, not activation.
Both --start and internal --run remain unconditionally blocked; neither these
pins nor original-plan approval can override that guard. CLI checks require -I -B. No audit inventory or
self-authored RECORD constitutes runtime verification.

Integration contracts (all modules loaded from hash-checked bytes, stdlib only):
  verify_outpost2_node.verify(root=layout.root) -> verifiedFiles/verifiedLinks/summary
  verify_outpost2_python.verify(root=layout.root, assets=fixed_assets,
      expected_manifest_sha256=ASSETS_SHA256, templates=fixed_templates)
      -> verifiedFiles/verifiedLinks/quarantineBytecode/assertions/summary
  normalize_outpost2_runtime.normalize(release, audit, proof) -> dict
The normalizer receives a schemaVersion=1 union of fresh verifier results with
no-follow stat snapshots held unchanged across verification. Python's authenticated
plan_references API distinguishes generated quarantine directories from archive
ones. Saved audit inventory never authorizes mutation. Both verifiers and source
checks run again after every controlled
normalization/sealing action; old inode snapshots are not reused across them.
Reference assets stay at the fixed operator-home paths, hashed on every use.
Start additionally requires the reviewed driver/helper/modules in a root-owned
0700 directory. The driver is caller-trusted code, not self-authenticated by a
recursive embedded hash; its staged bytes are bound by the root-private manifest.
Any continuation-* directory remains a permanent stop/review marker; never delete
one to retry this tool. Dormant continuation code is retained for review/testing,
not authorized execution. No download, accounts, preflight(), or execute() rerun.
"""
from __future__ import annotations

import sys

CLI_FLAG_REFUSAL = 'Use /usr/bin/python3 -I -B for this CLI; no actions performed.'
# Refuse a mis-invoked script before filesystem-backed imports can write pycache.
if __name__ == '__main__' and not (sys.flags.isolated and sys.flags.dont_write_bytecode and sys.dont_write_bytecode):
    raise SystemExit('REFUSED: ' + CLI_FLAG_REFUSAL + ' --start and --run remain disabled.')

import argparse
import fcntl
import hashlib
import io
import json
import os
import platform
import shutil
import signal
import stat
import subprocess
import tarfile
import time
import types
import uuid
from contextlib import contextmanager
from pathlib import Path

HELPER_SHA256 = 'ac2ec0b4c767897fff4f9fbc35c6cd8e17bdf433b507943cbe8b296c02f3095d'
INSTALLER_SHA256 = '67ca1a99f9dfa088df0173387656e7bc224d4e004fe409ab5e31238de2dbbac8'
PLAN_ID = '29be1b0d-e34e-49e2-9a21-2b8fa18216f2'
HOTFIX_AUDIT = 'browser-hotfix-6ed46f6e-34d6-44ae-8395-c3be668f0276'
FONT_SHA256 = '5712114d715c713e302930ed191408ddfedbd5bf7c34c5d380958598595b34d6'
FONT_NAME = 'fonts-5712114d715c.conf'
INSTALLER = Path('deploy/environment/host_install.py')
PREFIX = 'continuation-'
SELF_NAME = 'continue-outpost2-setup.py'
HELPER_NAME = 'repair-outpost2-browser.py'
CLEAN_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
EVIDENCE = {'failure-status.json': 'status.json', 'request.json': 'request.json',
            'command.log': 'command.log', 'launch.log': 'launch.log', 'launch.json': 'launch.json'}
NODE_MODULE = 'verify_outpost2_node.py'
PYTHON_MODULE = 'verify_outpost2_python.py'
NORMALIZER_MODULE = 'normalize_outpost2_runtime.py'
RUNTIME_MODULES = (NODE_MODULE, PYTHON_MODULE, NORMALIZER_MODULE)
# Independently reviewed for READ-ONLY --check only, NOT activation authorization.
# These pins authenticate code bytes; both activation entrypoints remain disabled.
# Disk contents/manifests/CLI flags cannot establish or override this trust.
REVIEWED_MODULE_SHA256: dict[str, str] = {
    NODE_MODULE: 'f20f2da31c76b1d103fd6c0cf5016772adb72aed8a32225a8e1f96a2f0aaf295',
    PYTHON_MODULE: '80d671b799b6a988820df8a68984b2e85f3537fdde22f33e01861918069c07e9',
    NORMALIZER_MODULE: '86bb843149d073c7d1e30f86787f99bda302bcbe0d97dbe9e638ed3d97642839',
}
ASSETS_PATH = '/home/surajadmin2/outpost-browser-repair-645f62a9/python-assets'
TEMPLATES_PATH = '/home/surajadmin2/outpost-browser-repair-645f62a9/uv-templates'
ASSETS_SHA256 = '2020eef6970c0ddcd421c04c7784c3e0ee06172be0533a7bec8fa18bc80f2bb5'
TEMPLATES_SHA256 = '0da48b4c01d04405a9c7109b6db9ffa219dc02e43d784c351022cb0046db3061'
UV_LOCKS = {'python/.lock', 'server/browser-engine/.venv/.lock'}
STAGED = {*EVIDENCE, SELF_NAME, HELPER_NAME, *RUNTIME_MODULES, 'host_install.py', 'evidence.json',
          'runtime-proof.json', 'python-assets-manifest.json', 'uv-templates-manifest.json'}
RUNTIME_DIRS = {'node', 'node_modules', 'python', 'browsers', 'server/browser-engine/.venv'}
ACTIVATION_REFUSAL = ('Runtime content verification and hardlink isolation have not been qualified; '
                      'no services started')


class Refused(RuntimeError):
    """A non-secret operator-facing refusal."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refused(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def refuse_unqualified_runtime() -> None:
    """No flag, approval, environment variable or manifest can enable activation."""
    raise Refused(ACTIVATION_REFUSAL)


def bootstrap_read(path: Path, bound: int) -> tuple[bytes, os.stat_result]:
    """Minimal no-follow reader used BEFORE the pinned Files implementation exists."""
    require(path.is_absolute() and '..' not in path.parts, 'Unsafe code path.')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, 'rb') as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= bound, 'Unsafe code file.')
            data = source.read(bound + 1)
            after = os.fstat(source.fileno())
            named = os.stat(path.name, dir_fd=fd, follow_symlinks=False)
            fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            require(len(data) == info.st_size and all(getattr(info, key) == getattr(after, key) == getattr(named, key) for key in fields),
                    'Code changed while reading.')
            return data, info
    finally:
        os.close(fd)


def byte_module(data: bytes, expected: str, name: str, path: Path) -> types.ModuleType:
    """Compile exactly the bytes hashed, never import from sys.path or reopen code."""
    require(digest(data) == expected, 'Pinned code hash mismatch.')
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module  # dataclasses needs its defining module registered.
    try:
        exec(compile(data, str(path), 'exec'), module.__dict__)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def load_helper(path: Path) -> tuple[types.ModuleType, bytes]:
    data, _ = bootstrap_read(path, 65536)
    return byte_module(data, HELPER_SHA256, '_outpost2_reviewed_guards', path), data


def module_pin(name: str) -> str:
    value = REVIEWED_MODULE_SHA256.get(name)
    require(isinstance(value, str) and len(value) == 64 and all(char in '0123456789abcdef' for char in value),
            'Missing independently reviewed production byte pin: ' + name)
    return value


def load_runtime_modules(*, normalization: bool = False) -> dict:
    """No sys.path imports, cache-based authorization, or caller-selected code paths."""
    result = {}
    names = RUNTIME_MODULES if normalization else RUNTIME_MODULES[:2]
    for name in names:
        expected = module_pin(name)  # Refuse BEFORE reading/executing unknown code.
        path = Path(__file__).absolute().with_name(name)
        data, _ = bootstrap_read(path, 256 * 1024)
        result[name] = {'bytes': data, 'module': byte_module(data, expected, '_outpost2_' + name[:-3], path)}
        api = 'normalize' if name == NORMALIZER_MODULE else 'verify'
        module = result[name]['module']
        require(callable(getattr(module, api, None)) and isinstance(getattr(module, 'Refused', None), type)
                and issubclass(module.Refused, RuntimeError), 'Reviewed module contract unavailable: ' + name)
        if name == PYTHON_MODULE:
            require(callable(getattr(module, 'plan_references', None)), 'Authenticated Python reference-plan API unavailable.')
    return result


def artifact_references() -> dict:
    return {'pythonAssets': {'path': ASSETS_PATH, 'manifestSha256': ASSETS_SHA256},
            'uvTemplates': {'path': TEMPLATES_PATH, 'manifestSha256': TEMPLATES_SHA256}}


def reference_documents(h, layout) -> dict[str, bytes]:
    files = h.Files()
    result = {}
    for name, directory, expected in (('python-assets-manifest.json', ASSETS_PATH, ASSETS_SHA256),
                                       ('uv-templates-manifest.json', TEMPLATES_PATH, TEMPLATES_SHA256)):
        data, _ = files.read(layout.path(directory) / 'manifest.json', 8 * 1024 * 1024, None)
        require(digest(data) == expected, 'Reference manifest pin mismatch.')
        result[name] = data
    files.verify()
    return result


def proc_read(path: Path, bound: int = 65536) -> bytes:
    """procfs reports size zero; still use no-follow, bounded descriptor reads."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        data = stream.read(bound + 1)
    require(len(data) <= bound, 'Process inspection exceeds bound.')
    return data


def quiescent_processes(h, layout) -> None:
    """Fail closed on live service UIDs or another root process using our paths.

    Scope root cmdline/exe/cwd/open FDs to this operation, release, native config
    and data only; do not stop or inspect unrelated application contents. This is
    writer exclusion evidence, not protection against a hostile root racing us.
    """
    service_uids = {h.pwd.getpwnam(name).pw_uid for name in ('outpost-build', 'outpost-coord', 'outpost-pi')}
    require(len(service_uids) == 3 and 0 not in service_uids, 'Unsafe service identities.')
    scopes = tuple(str(path) for path in (layout.operation, layout.release,
                   layout.path('/etc/outpost-native'), layout.path('/var/lib/outpost-native')))
    proc = layout.path('/proc')
    with h.Files().directory(proc) as fd:
        pids = [name for name in os.listdir(fd) if name.isascii() and name.isdigit()]
    require(len(pids) <= 65536, 'Process inventory exceeds bound.')
    for pid in pids:
        if int(pid) == os.getpid():
            continue
        process = proc / pid
        try:
            status = proc_read(process / 'status').decode('ascii')
            uid_lines = [line for line in status.splitlines() if line.startswith('Uid:')]
            require(len(uid_lines) == 1, 'Cannot establish process credentials.')
            uids = [int(value) for value in uid_lines[0].split()[1:]]
            require(len(uids) == 4, 'Cannot establish process credentials.')
            require(not service_uids.intersection(uids), 'A build/coordinator/worker UID process is present; no mutation permitted.')
            if 0 not in uids:
                continue
            paths = [os.fsdecode(value) for value in proc_read(process / 'cmdline').split(b'\0')]
            for name in ('exe', 'cwd'):
                try:
                    paths.append(os.readlink(process / name))
                except FileNotFoundError:
                    pass  # Kernel threads/exiting processes need not have exe/cwd.
            with h.Files().directory(process / 'fd') as fd:
                descriptors = os.listdir(fd)
                require(len(descriptors) <= 65536, 'Root process descriptor inventory exceeds bound.')
                for name in descriptors:
                    try:
                        paths.append(os.readlink(name, dir_fd=fd))
                    except FileNotFoundError:
                        pass
            require(not any(scope in value for scope in scopes for value in paths),
                    'Another scoped root process is using native preconfiguration paths.')
        except FileNotFoundError:
            continue  # A process that has exited is no longer a live writer.


def stat_record(path: str, info) -> dict:
    return {'path': path, 'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'nlink': info.st_nlink, 'size': info.st_size,
            'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns}


def capture_runtime(h, layout) -> dict:
    """Metadata is only a snapshot bridge around verifiers, never content authority."""
    files = h.Files()
    leaves, directories, targets, ancestors = {}, {}, {}, {}
    count = 0
    for tree in sorted(RUNTIME_DIRS):
        pending = [layout.release / tree]
        while pending:
            path = pending.pop()
            relative = str(path.relative_to(layout.release))
            with files.directory(path) as fd:
                directories[relative] = stat_record(relative, os.fstat(fd))
                for name in os.listdir(fd):
                    count += 1
                    require(count <= 100000, 'Runtime snapshot exceeds bound.')
                    child = path / name
                    key = str(child.relative_to(layout.release))
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(child)
                    else:
                        require(stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode), 'Special runtime file.')
                        leaves[key] = stat_record(key, info)
                        if stat.S_ISLNK(info.st_mode):
                            targets[key] = os.readlink(name, dir_fd=fd)
        parent = (layout.release / tree).parent
        while True:
            key = str(parent.relative_to(layout.root))
            with files.directory(parent) as fd:
                ancestors[key] = stat_record(key, os.fstat(fd))
            if parent == layout.root:
                break
            parent = parent.parent
    files.verify()
    return {'leaves': leaves, 'directories': directories, 'targets': targets, 'ancestors': ancestors}


def validate_runtime_proof(h, proof: dict, *, normalized: bool) -> None:
    """Validate the in-process verifier contracts, never accept an operator JSON proof."""
    require(type(proof) is dict and set(proof) == {'node', 'python', 'snapshot'}, 'Runtime proof unavailable.')
    node, python = proof['node'], proof['python']
    require(type(node) is dict and set(node) == {'verifiedFiles', 'verifiedLinks', 'summary'}, 'Incomplete Node proof.')
    require(type(python) is dict and set(python) == {'verifiedFiles', 'verifiedLinks', 'quarantineBytecode', 'assertions', 'summary'},
            'Incomplete Python proof.')
    require(node['summary'].get('archiveSha256') == h.ARCHIVE_SHA256
            and node['summary'].get('scope') == ['node', 'node_modules', 'browsers'], 'Node proof provenance mismatch.')
    summary = python['summary']
    require(summary.get('sourceSha256') == h.ARCHIVE_SHA256 and summary.get('releaseId') == h.RELEASE_ID
            and summary.get('manifestSha256') == ASSETS_SHA256 and summary.get('templateManifestSha256') == TEMPLATES_SHA256
            and summary.get('executionAuthorized') is False and summary.get('recordIsAuthenticityProof') is False,
            'Python proof provenance mismatch.')
    seen = set()
    for name in ('node', 'python'):
        result = proof[name]
        scopes = ('node', 'node_modules', 'browsers') if name == 'node' else ('python', 'server/browser-engine/.venv')
        for kind in ('verifiedFiles', 'verifiedLinks', *(() if name == 'node' else ('quarantineBytecode',))):
            records = result[kind]
            require(type(records) is list and len(records) <= 100000, 'Invalid proof record list.')
            require(result['summary'].get(kind) == len(records), 'Incomplete runtime proof count.')
            for record in records:
                path = record['path']
                require(isinstance(path, str) and all(part not in ('', '.', '..') for part in path.split('/'))
                        and any(path.startswith(scope + '/') for scope in scopes) and path not in seen, 'Unsafe/overlapping proof path.')
                seen.add(path)
                require(type(record['nlink']) is int and 1 <= record['nlink'] <= 2, 'Unsupported/unaccounted runtime link count.')
                if normalized or name == 'node' or kind == 'verifiedLinks':
                    require(record['nlink'] == 1, 'Runtime hardlink isolation is incomplete.')
                if kind != 'verifiedLinks':
                    require(type(record['size']) is int and record['size'] >= 0
                            and isinstance(record['sha256'], str) and len(record['sha256']) == 64
                            and all(char in '0123456789abcdef' for char in record['sha256']),
                            'Invalid verified content record.')
                    if path in UV_LOCKS:
                        require(name == 'python' and kind == 'verifiedFiles' and record['size'] == 0
                                and record['sha256'] == digest(b'') and record['nlink'] == 1, 'Unsafe UV lock proof.')
    require(bool(node['verifiedFiles']) and bool(python['verifiedFiles']) and type(python['assertions']) is dict,
            'Empty runtime proof.')
    require(summary.get('hardlinkedFiles') == sum(record['nlink'] > 1 for record in python['verifiedFiles']), 'Hardlink summary mismatch.')
    if normalized:
        require(not python['quarantineBytecode'], 'Generated bytecode quarantine is incomplete.')


def bounded_verifier_reason(error: Exception) -> str:
    """Only bounded reason-code tokens, never paths, terminal controls or raw OS text."""
    reason = str(error)[:129]
    if not reason or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in reason):
        return 'invalid_refusal_reason'
    return reason[:128] + ('...' if len(reason) > 128 else '')


def verify_runtime(h, layout, *, modules: dict, normalized: bool = False) -> dict:
    """Each call rehashes reference manifests and all verifier-selected artifacts."""
    quiescent_processes(h, layout)
    reference_documents(h, layout)
    before = capture_runtime(h, layout)
    identities = {(row['device'], row['inode']) for row in before['leaves'].values()}
    require(len(identities) == len(before['leaves']), 'Multiple internal runtime aliases are unsupported.')
    proof = {'snapshot': before}
    for key, name in (('node', NODE_MODULE), ('python', PYTHON_MODULE)):
        module = modules[name]['module']
        kwargs = {} if key == 'node' else {'assets': layout.path(ASSETS_PATH),
                  'expected_manifest_sha256': ASSETS_SHA256, 'templates': layout.path(TEMPLATES_PATH)}
        try:
            proof[key] = module.verify(root=layout.root, **kwargs)
        except module.Refused as error:
            raise Refused(name + ' refused: ' + bounded_verifier_reason(error)) from None
        except Exception:
            raise Refused(name + ' refused: unexpected_verifier_error') from None
    validate_runtime_proof(h, proof, normalized=normalized)
    assertions = proof['python']['assertions']
    require(assertions['root'] == str(layout.root) and assertions['releasePath'] == str(layout.release.relative_to(layout.root)),
            'Python proof targets a different host/release.')
    require({row['path']: row for row in assertions['ancestors']} == before['ancestors'], 'Verifier ancestor snapshots differ.')
    expected_dirs = {key: value for key, value in before['directories'].items()
                     if key in ('python', 'server/browser-engine/.venv') or key.startswith(('python/', 'server/browser-engine/.venv/'))}
    require({row['path']: row for row in assertions['ownedDirectories']} == expected_dirs, 'Python directory snapshots differ.')
    require(capture_runtime(h, layout) == before, 'Runtime namespace changed across content verification.')
    quiescent_processes(h, layout)
    return proof


@contextmanager
def install_lock(h, layout):
    files = h.Files()
    path = layout.path('/var/lib/outpost-setup/install.lock')
    with files.regular(path) as (fd, info):
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022, 'Unsafe original install lock.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Original install lock held; review before retrying.') from None
        require(h.stamp(files.read(path, 4096)[1]) == h.stamp(info), 'Original lock changed.')
        yield


def check_units(h, *, worker: bool = False) -> None:
    """The worker must itself be the original native-liveness setup unit."""
    fields = {'LoadState', 'ActiveState', 'MainPID', 'ControlPID', 'Job', 'FragmentPath', 'DropInPaths'}
    for unit in h.UNITS:
        reply = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--no-pager',
                                '--property=' + ','.join(sorted(fields))],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=CLEAN_ENV, timeout=5, check=False)
        require(reply.returncode == 0 and len(reply.stdout) <= 8192, 'Cannot establish unit state.')
        pairs = [line.split('=', 1) for line in reply.stdout.decode().splitlines()]
        values = dict(pairs)
        require(len(pairs) == len(fields) and set(values) == fields, 'Ambiguous unit state.')
        require(values['ControlPID'] == '0' and values['Job'] in ('', '0') and not values['DropInPaths'],
                'Unit has a control process, job, or drop-in.')
        if worker and unit == h.UNITS[0]:
            require(values['LoadState'] == 'loaded' and values['ActiveState'] == 'active'
                    and values['MainPID'] == str(os.getpid())
                    and values['FragmentPath'] == '/run/systemd/transient/' + unit,
                    '--run must be the original setup unit main process.')
        else:
            require(values['LoadState'] == 'not-found' and values['ActiveState'] == 'inactive'
                    and values['MainPID'] == '0' and not values['FragmentPath'],
                    'Setup/native units must be not-found/inactive, with no jobs.')


def absent_if_parent_exists(files, path: Path) -> None:
    """Missing ancestors are OK; existing ancestors must never be symlinks."""
    try:
        files.absent(path)
    except FileNotFoundError:
        # directory() already checked every ancestor that exists.
        pass


def unit_paths(files, layout, h, *, worker: bool) -> None:
    for base in ('/etc/systemd/system', '/run/systemd/system', '/run/systemd/transient',
                 '/usr/local/lib/systemd/system', '/usr/lib/systemd/system',
                 '/etc/systemd/system.control', '/run/systemd/system.control',
                 '/run/systemd/generator', '/run/systemd/generator.early', '/run/systemd/generator.late'):
        directory = layout.path(base)
        for name in ('service.d', 'outpost-.service.d', 'outpost-native-.service.d', 'outpost-setup-.service.d'):
            absent_if_parent_exists(files, directory / name)
        for unit in h.UNITS:
            if not (worker and unit == h.UNITS[0] and base == '/run/systemd/transient'):
                absent_if_parent_exists(files, directory / unit)
            absent_if_parent_exists(files, directory / (unit + '.d'))


def host_checks(files, layout) -> dict:
    require(sys.version_info >= (3, 12) and platform.machine() == 'x86_64', 'Requires x86_64 and Python 3.12+.')
    os_release = dict(line.split('=', 1) for line in files.read(layout.path('/usr/lib/os-release'), 16384)[0].decode().splitlines() if '=' in line)
    require(os_release.get('ID', '').strip('"') == 'ubuntu'
            and int(os_release.get('VERSION_ID', '0').strip('"').split('.')[0]) >= 24, 'Requires Ubuntu 24+.')
    with files.directory(layout.path('/run/systemd/system')):
        pass
    for path in ('/.dockerenv', '/run/.containerenv'):
        files.absent(layout.path(path))
    capacity = {path: shutil.disk_usage(layout.path(path)).free for path in ('/var/lib', '/opt')}
    require(capacity['/var/lib'] >= 10 * 1024 ** 3 and capacity['/opt'] >= 5 * 1024 ** 3, 'Insufficient free disk space.')
    # procfs files report size zero; they are not regular retained evidence.
    with layout.path('/proc/meminfo').open() as source:
        memory = next(int(line.split()[1]) * 1024 for line in source.read(65536).splitlines() if line.startswith('MemTotal:'))
    require(memory >= 3 * 1024 ** 3, 'Browser installation needs at least 3 GiB RAM.')
    for name in ('tcp', 'tcp6', 'udp', 'udp6'):
        with layout.path('/proc/net/' + name).open() as source:
            lines = source.read(4 * 1024 * 1024 + 1)
        require(len(lines) <= 4 * 1024 * 1024, 'Socket table exceeds bound.')
        for line in lines.splitlines()[1:]:
            require(int(line.split()[1].rsplit(':', 1)[1], 16) not in (4518, 4519, 4520), 'A native port is in use.')
    return {'freeBytes': capacity, 'memoryBytes': memory}


def archive_tree(h, data: bytes) -> dict:
    """No extraction; reject duplicate aliases, links, special files and traversal."""
    tree = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        require(len(members) <= 4096 and sum(m.size for m in members) <= 32 * 1024 * 1024, 'Archive exceeds limits.')
        for member in members:
            raw = member.name.removeprefix('./').rstrip('/')
            name = '' if raw in ('', '.') else raw
            require(not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')) if name else member.isdir(), 'Unsafe archive path.')
            require(name not in tree and (member.isdir() or member.isfile()) and member.mode in (0o600, 0o644, 0o700, 0o755), 'Unsafe archive member.')
            stream = archive.extractfile(member) if member.isfile() else None
            tree[name] = (member.mode, stream.read() if stream else None)
        require('' in tree, 'Archive root missing.')
    for name in tree:
        if name:
            parent = str(Path(name).parent)
            require(('' if parent == '.' else parent) in tree, 'Archive parent missing.')
    require(digest(tree[str(INSTALLER)][1]) == INSTALLER_SHA256, 'Original installer archive pin mismatch.')
    require(digest(tree[str(h.LAUNCHER)][1]) == h.ORIGINAL_SHA256, 'Original launcher archive pin mismatch.')
    return tree


def verify_managed(h, files, layout, tree: dict, build, *, sealed: bool = False) -> None:
    for root, release in ((layout.operation / 'source', False), (layout.release, True)):
        uid, gid = (0, 0) if sealed or not release else (build.pw_uid, build.pw_gid)
        for name, (mode, content) in tree.items():
            path = root / name
            if content is None:
                children = {Path(key).name for key in tree if key and str(Path(key).parent) == (name or '.')}
                if release:
                    children |= {Path(key).name for key in RUNTIME_DIRS if str(Path(key).parent) == (name or '.')}
                    if not name and sealed:
                        children.add('pi-release.json')
                actual = files.entries(path, uid, gid, mode if name else None)
                require(actual == children, 'Unexpected archive-managed directory contents.')
            else:
                actual, info = files.read(path, max(len(content), 16384), uid)
                expected = h.REPLACEMENT_SHA256 if release and name == str(h.LAUNCHER) else digest(content)
                require(digest(actual) == expected and h.metadata(info) == {'uid': uid, 'gid': gid, 'mode': mode}, 'Archive-managed source/release drift.')


def runtime_paths(h, files, layout, build, proof: dict, *, sealed: bool = False, normalized: bool = False) -> None:
    """Ownership/namespace checks supplement, never replace, authenticated bytes.

    Unnormalized Python hardlinks/pycs are inventory only. Execution requires a
    fresh normalized proof. Only the two Python-authenticated empty UV locks may
    have mode 0666 before sealing; after sealing EVERY non-link is go-w/root-owned.
    """
    validate_runtime_proof(h, proof, normalized=normalized or sealed)
    records, links = {}, {}
    for result in (proof['node'], proof['python']):
        records.update((record['path'], record) for record in result['verifiedFiles'])
        links.update((record['path'], record) for record in result['verifiedLinks'])
    records.update((record['path'], record) for record in proof['python']['quarantineBytecode'])
    python_files = {record['path']: record for record in proof['python']['verifiedFiles']}
    count, observed = 0, set()
    allowed = {(0, 0)} if sealed else {(0, 0), (build.pw_uid, build.pw_gid)}
    for relative in sorted(RUNTIME_DIRS):
        pending = [layout.release / relative]
        while pending:
            path = pending.pop()
            with files.directory(path) as fd:
                directory_info = os.fstat(fd)
                require((directory_info.st_uid, directory_info.st_gid) in allowed and not directory_info.st_mode & 0o7022, 'Unsafe runtime directory.')
                for name in os.listdir(fd):
                    count += 1
                    require(count <= 150000, 'Runtime tree exceeds bound.')
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    child = path / name
                    relative_name = str(child.relative_to(layout.release))
                    require((info.st_uid, info.st_gid) in allowed, 'Unexpected runtime owner.')
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(child)
                        continue
                    observed.add(relative_name)
                    record = (links if stat.S_ISLNK(info.st_mode) else records).get(relative_name)
                    require(record is not None and stat.S_IMODE(info.st_mode) == record['mode'] and info.st_nlink == record['nlink'],
                            'Runtime namespace/metadata changed after content verification.')
                    if stat.S_ISLNK(info.st_mode):
                        require(info.st_nlink == 1 and os.readlink(name, dir_fd=fd) == record['target'], 'Runtime link changed.')
                        resolved = child.resolve(strict=True)
                        require(resolved.is_relative_to(layout.release) and resolved != layout.release, 'Runtime symlink escapes release.')
                    else:
                        require(stat.S_ISREG(info.st_mode) and info.st_size == record['size'] and not info.st_mode & 0o7000, 'Unsafe runtime file.')
                        empty_uv_lock = (not sealed and relative_name in UV_LOCKS and relative_name in python_files
                                         and record['size'] == 0 and record['sha256'] == digest(b'')
                                         and record['mode'] in (0o644, 0o666))
                        require(not info.st_mode & 0o022 or empty_uv_lock, 'Runtime write permissions are not authenticated.')
                        if normalized or sealed:
                            require(info.st_nlink == 1, 'Runtime hardlink isolation is incomplete.')
                        if 'inode' in record:
                            fields = {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid,
                                      'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns}
                            require(all(record[key] == value for key, value in fields.items()), 'Python proof snapshot changed.')
    require(observed == set(records) | set(links), 'Runtime proof does not cover the complete installed tree.')
    for relative in ('node/bin/node', 'server/browser-engine/.venv/bin/python'):
        path = (layout.release / relative).resolve(strict=True)
        require(path.is_relative_to(layout.release), 'Runtime executable escapes release.')
        with files.regular(path) as (_, info):
            require(info.st_mode & 0o111 and (info.st_uid, info.st_gid) in allowed, 'Runtime executable unavailable.')


def hotfix_audit(h, files, layout, backups, build) -> None:
    """Independent audit validation: NOT helper.verified_audit's empty-font rule."""
    audit = layout.operation / HOTFIX_AUDIT
    require(files.entries(audit, 0, 0, 0o700) == {*h.BACKUPS, 'manifest.json', 'applied.json'}, 'Incomplete hotfix audit.')
    originals = dict(backups)
    for name in h.BACKUPS:
        data, info = files.read(audit / name, 8 * 1024 * 1024)
        require(h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Hotfix evidence not private.')
        if name == 'launch.py':
            require(digest(data) == h.ORIGINAL_SHA256, 'Original hotfix backup mismatch.')
            originals[name] = (data, backups[name][1])
        else:
            require(data == backups[name][0], 'Original request/identity/failure evidence changed since hotfix.')
    manifest = h.encoded(h.manifest(audit, originals, build))
    require(files.read(audit / 'manifest.json', 16384)[0] == manifest, 'Hotfix manifest mismatch.')
    require(digest(backups['launch.py'][0]) == h.REPLACEMENT_SHA256, 'Corrected launcher pin mismatch.')
    require(files.entries(layout.fontconfig, build.pw_uid, build.pw_gid, 0o755) == {FONT_NAME}, 'Unexpected fontconfig contents.')
    font, info = files.read(layout.fontconfig / FONT_NAME, 1024 * 1024, build.pw_uid)
    require(digest(font) == FONT_SHA256 and h.metadata(info) == {'uid': build.pw_uid, 'gid': build.pw_gid, 'mode': 0o644}, 'Fontconfig pin/permissions mismatch.')
    with files.directory(layout.fontconfig) as fd:
        identity = list(h.identity(os.fstat(fd)))
    expected = {'schema': 1, 'manifestSha256': digest(manifest), 'launcherSha256': h.REPLACEMENT_SHA256, 'fontconfigIdentity': identity}
    require(files.read(audit / 'applied.json', 16384)[0] == h.encoded(expected), 'Hotfix applied receipt mismatch.')
    for name in ('manifest.json', 'applied.json'):
        require(h.metadata(files.reads[audit / name][1]) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Hotfix audit not private.')


def inspect(h, files, layout, *, audit: Path | None = None, modules: dict | None = None) -> dict:
    # All reviewed Files/Layout/failed-state guards are retained. Only the unit
    # guard is substituted, to recognize this worker as the original setup unit.
    previous = h.inactive_units
    h.inactive_units = lambda: check_units(h, worker=audit is not None)
    try:
        backups, build = h.inspect(files, layout)
    finally:
        h.inactive_units = previous
    names = files.listings[layout.operation]
    markers = {name for name in names if name.startswith(PREFIX)}
    require(markers == ({audit.name} if audit else set()), 'Existing continuation marker: manual review; no second start.')
    expected = {'source', 'build-home', 'release.tar.gz', 'request.json', 'status.json', 'cancel',
                'command.log', 'launch.log', 'launch.json', 'node.tar.xz', 'uv.whl', 'camoufox.zip', HOTFIX_AUDIT} | markers
    require(names == expected, 'Unexpected operation paths; review retained files before continuation.')
    files.absent(layout.operation / 'status.json.tmp')
    for name in ('node.tar.xz', 'uv.whl', 'camoufox.zip'):
        with files.regular(layout.operation / name) as (_, info):
            require(h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Unsafe retained download artifact.')
    hotfix_audit(h, files, layout, backups, build)
    status = h.document(backups['status.json'][0])
    require(type(status['startedAt']) is int and type(status['updatedAt']) is int
            and 0 < status['startedAt'] <= status['updatedAt'] and isinstance(status['log'], list)
            and len(status['log']) <= 48 and all(isinstance(item, str) for item in status['log'])
            and isinstance(status['error'], str), 'Unexpected original receipt history.')
    launch, info = files.read(layout.operation / 'launch.json', 4096)
    require(h.document(launch) == {'returnCode': 0} and h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o644}, 'Original launch receipt mismatch.')
    tree = archive_tree(h, files.reads[layout.operation / 'release.tar.gz'][0])
    verify_managed(h, files, layout, tree, build)
    unit_paths(files, layout, h, worker=audit is not None)
    capacity = host_checks(files, layout)
    modules = modules if modules is not None else load_runtime_modules()
    proof = verify_runtime(h, layout, modules=modules)
    runtime_paths(h, files, layout, build, proof)
    files.verify()
    return {'backups': backups, 'build': build, 'tree': tree, 'status': status, 'capacity': capacity,
            'runtime': proof, 'modules': modules}


def verify_release_state(h, layout, review: dict, *, sealed: bool) -> dict:
    """Fresh snapshots after controlled mutations, including re-hashing code/references."""
    if 'stagedCode' in review:
        files = h.Files()
        for name, expected in review['stagedCode'].items():
            data, info = files.read(review['audit'] / name, 256 * 1024)
            require(digest(data) == expected and h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Staged execution code changed.')
    modules = load_runtime_modules()
    files = h.Files()
    verify_managed(h, files, layout, review['tree'], review['build'], sealed=sealed)
    proof = verify_runtime(h, layout, modules=modules, normalized=True)
    runtime_paths(h, files, layout, review['build'], proof, sealed=sealed, normalized=True)
    uid, gid = (0, 0) if sealed else (review['build'].pw_uid, review['build'].pw_gid)
    require(files.entries(layout.fontconfig, uid, gid, 0o755) == {FONT_NAME}, 'Fontconfig contents changed.')
    font, info = files.read(layout.fontconfig / FONT_NAME, 1024 * 1024, uid)
    require(digest(font) == FONT_SHA256 and h.metadata(info) == {'uid': uid, 'gid': gid, 'mode': 0o644}, 'Fontconfig drift.')
    files.verify()
    return proof


def normalization_proof(h, layout, review: dict, proof: dict, modules: dict) -> dict:
    """Construct the normalizer's EXACT union schema from authenticated sources."""
    validate_runtime_proof(h, proof, normalized=False)
    snapshot = proof['snapshot']
    python = proof['python']
    module = modules[PYTHON_MODULE]['module']
    plan = module.plan_references(layout.operation / 'release.tar.gz', assets=layout.path(ASSETS_PATH),
                                 expected_manifest_sha256=ASSETS_SHA256, templates=layout.path(TEMPLATES_PATH))
    require(plan['summary']['sourceSha256'] == h.ARCHIVE_SHA256
            and plan['summary']['manifestSha256'] == ASSETS_SHA256
            and plan['summary']['templateManifestSha256'] == TEMPLATES_SHA256, 'Reference plan provenance mismatch.')
    authenticated_dirs = {row['path'] for row in plan['expected'] if row['kind'] == 'dir'}
    quarantine_dirs = {str(Path(row['path']).parent) for row in python['quarantineBytecode']} - authenticated_dirs
    verified, links = [], []
    for key, target in (('verifiedFiles', verified), ('verifiedLinks', links), ('quarantineBytecode', None)):
        for row in python[key]:
            require({name: row[name] for name in snapshot['leaves'][row['path']]} == snapshot['leaves'][row['path']],
                    'Python proof no longer matches captured snapshot.')
        if target is not None:
            target.extend(dict(row) for row in python[key])
    for key, target in (('verifiedFiles', verified), ('verifiedLinks', links)):
        for row in proof['node'][key]:
            captured = snapshot['leaves'][row['path']]
            require(all(captured[name] == row[name] for name in ('mode', 'nlink'))
                    and (key == 'verifiedLinks' or captured['size'] == row['size']), 'Node proof snapshot mismatch.')
            if key == 'verifiedLinks':
                require(snapshot['targets'][row['path']] == row['target'], 'Node proof link changed.')
                target.append(dict(captured, target=row['target'], sha256=digest(os.fsencode(row['target']))))
            else:
                target.append(dict(captured, sha256=row['sha256']))
    require(set(snapshot['leaves']) == {row['path'] for row in verified + links + python['quarantineBytecode']},
            'Normalization proof is missing installed leaves.')
    require(capture_runtime(h, layout) == snapshot, 'Normalization snapshot changed.')
    quiescent_processes(h, layout)
    return {'schemaVersion': 1, 'operationId': h.OPERATION_ID, 'releaseId': h.RELEASE_ID,
            'buildUid': review['build'].pw_uid, 'buildGid': review['build'].pw_gid,
            'verifiedFiles': verified, 'verifiedLinks': links, 'quarantineBytecode': python['quarantineBytecode'],
            'quarantineDirectories': sorted(quarantine_dirs),
            'assertions': {'root': str(layout.root), 'releasePath': str(layout.release.relative_to(layout.root)),
                           'ancestors': list(snapshot['ancestors'].values()), 'ownedDirectories': list(snapshot['directories'].values())}}


def normalize_runtime(h, layout, audit: Path, review: dict) -> None:
    """No installed execution until normalization AND fresh full verification pass."""
    modules = load_runtime_modules(normalization=True)
    proof = verify_runtime(h, layout, modules=modules)
    combined = normalization_proof(h, layout, review, proof, modules)
    event(h, audit, 'Runtime normalization', 'authenticated proof captured; no runtime executed')
    h.Files().create(audit / 'pre-normalization-proof.json', h.encoded(combined))
    result = modules[NORMALIZER_MODULE]['module'].normalize(layout.release, audit, combined)
    require(type(result) is dict and result.get('schemaVersion') == 1 and result.get('status') == 'normalized'
            and result.get('operationId') == h.OPERATION_ID and result.get('releaseId') == h.RELEASE_ID
            and result.get('auditId') == audit.name and result.get('executionAuthorized') is False
            and result.get('requiresReverification') is True and result.get('requiresExplicitSeal') is True
            and result.get('isolatedFiles') == sum(row['nlink'] > 1 for row in combined['verifiedFiles'])
            and result.get('quarantinedBytecode') == len(combined['quarantineBytecode'])
            and result.get('removedGeneratedDirectories') == len(combined['quarantineDirectories']),
            'Normalizer did not return its successful non-execution contract.')
    h.Files().create(audit / 'normalization-result.json', h.encoded(result))
    fresh = verify_release_state(h, layout, review, sealed=False)
    h.Files().create(audit / 'post-normalization-proof.json', h.encoded(fresh))
    review['runtime'] = fresh
    event(h, audit, 'Runtime normalization', 'verified: zero runtime hardlinks and zero generated bytecode')


def manifest(h, audit: Path, payloads: dict[str, bytes]) -> dict:
    return {'schema': 1, **h.IDENTITIES, 'auditId': audit.name, 'approvedOriginalPlan': PLAN_ID,
            'persistentRootExecutorApproved': True, 'helperSha256': HELPER_SHA256,
            'archiveSha256': h.ARCHIVE_SHA256, 'archiveSize': h.ARCHIVE_SIZE,
            'installerSha256': INSTALLER_SHA256, 'launcherSha256': h.REPLACEMENT_SHA256,
            'hotfixAudit': HOTFIX_AUDIT, 'fontconfigSha256': FONT_SHA256,
            'runtimeModuleSha256': {name: module_pin(name) for name in RUNTIME_MODULES},
            'artifactReferences': artifact_references(),
            'staged': {name: {'sha256': digest(data), 'size': len(data)} for name, data in payloads.items()}}



def stage(h, files, layout, review: dict, helper_bytes: bytes, code: bytes) -> Path:
    # Check EVERY prerequisite before even creating the permanent marker.
    modules = load_runtime_modules(normalization=True)
    references = reference_documents(h, layout)
    validate_runtime_proof(h, review['runtime'], normalized=False)
    payloads = {name: files.reads[layout.operation / original][0] for name, original in EVIDENCE.items()}
    payloads.update({name: modules[name]['bytes'] for name in RUNTIME_MODULES})
    payloads.update(references)
    payloads['runtime-proof.json'] = h.encoded(review['runtime'])
    audit = layout.operation / (PREFIX + str(uuid.uuid4()))
    payloads.update({SELF_NAME: code, HELPER_NAME: helper_bytes,
                     'host_install.py': review['tree'][str(INSTALLER)][1],
                     'evidence.json': h.encoded({'checkedAt': int(time.time() * 1000), 'capacity': review['capacity'],
                                                'note': 'Original failure and identity retained; browser runtime not yet qualified.'})})
    provenance = h.encoded(manifest(h, audit, payloads))
    quiescent_processes(h, layout)
    files.verify()
    files.mkdir(audit, 0, 0, 0o700)  # Permanent marker; never reused/deleted automatically.
    for name, data in payloads.items():
        files.create(audit / name, data)
    files.create(audit / 'manifest.json', provenance)
    files.mkdir(audit / 'launch', 0, 0, 0o700)
    files.create(audit / 'launch' / 'command.log', b'')
    files.verify()
    return audit


def launch_command(h, audit: Path) -> list[str]:
    return ['/usr/bin/systemd-run', '--unit=' + h.UNITS[0], '--property=Type=exec',
            '--property=User=root', '--property=Group=root', '--property=UMask=0077',
            '--property=KillMode=control-group', '--property=RuntimeMaxSec=900',
            '--property=TimeoutStopSec=45', '--property=Restart=no',
            '/usr/bin/python3', '-I', '-B', str(audit / SELF_NAME), '--run', audit.name.removeprefix(PREFIX)]


def launch(h, audit: Path) -> str:
    """The parent releases its lock BEFORE launch; the worker never waits for it."""
    result = {'state': 'ambiguous', 'returnCode': None}
    try:
        with h.Files().regular(audit / 'launch' / 'command.log') as (_, info):
            require(h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o600} and info.st_size == 0, 'Launch log already used.')
        fd = os.open(audit / 'launch' / 'command.log', os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
        with os.fdopen(fd, 'wb') as output:
            reply = subprocess.run(launch_command(h, audit), stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                   env=CLEAN_ENV, timeout=20, check=False)
            output.flush()
            os.fsync(output.fileno())
        result = {'state': 'submitted' if reply.returncode == 0 else 'ambiguous', 'returnCode': reply.returncode}
    except (OSError, subprocess.SubprocessError):
        pass
    h.Files().create(audit / 'launch' / 'result.json', h.encoded(result))
    return result['state']


def private_driver_bytes(h) -> bytes:
    path = Path(__file__).absolute()
    files = h.Files()
    files.entries(path.parent, 0, 0, 0o700)
    code, info = files.read(path, 128 * 1024)
    require(info.st_gid == 0 and not info.st_mode & 0o022,
            'Install the reviewed driver/helper/module bundle in a root-owned 0700 directory before start.')
    files.verify()
    return code


def operator(h, helper_bytes: bytes, *, start: bool, approval: str | None, layout=None) -> str:
    if start:
        refuse_unqualified_runtime()
    require(os.geteuid() == 0, 'Root required, including read-only --check.')
    require((start and approval == PLAN_ID) or (not start and approval is None), 'Start requires explicit approval of the exact original plan, including persistent root authority.')
    layout = layout or h.Layout()
    with install_lock(h, layout):
        files = h.Files()
        review = inspect(h, files, layout)
        if not start:
            node, python = review['runtime']['node'], review['runtime']['python']
            source_files = sum(content is not None for _, content in review['tree'].values())
            hardlinks = sum(record['nlink'] > 1 for record in python['verifiedFiles'])
            return ('Structural and full content checks passed; read-only inventory only, NOT ready-to-start or runtime readiness.\n'
                    f'Source/release: {source_files} archive-managed files each (declared launcher hotfix).\n'
                    f'Node/browser/npm: files={len(node["verifiedFiles"])}; symlinks={len(node["verifiedLinks"])}.\n'
                    f'Python: files={len(python["verifiedFiles"])}; symlinks={len(python["verifiedLinks"])}; '
                    f'hardlinkedFiles={hardlinks}; quarantineBytecode={len(python["quarantineBytecode"])}.\n'
                    'No actions performed: no staging, normalization, runtime execution, service changes or receipt writes.\n'
                    'Both --start and --run are disabled unconditionally, even with original-plan approval.\n'
                    f'Unit: {h.UNITS[0]}\nStatus: {layout.operation / "status.json"}')
        code = private_driver_bytes(h)
        require(digest(helper_bytes) == HELPER_SHA256, 'Helper bytes changed.')
        check_units(h)
        files.verify()
        audit = stage(h, files, layout, review, helper_bytes, code)
    outcome = launch(h, audit)
    return (f'Launch {outcome}. Root authority: original plan includes persistent root executor.\n'
            f'Unit: {h.UNITS[0]}\nAudit: {audit}\nStatus: {layout.operation / "status.json"}\n'
            f'Progress: systemctl status {h.UNITS[0]} --no-pager; read status.json and private audit events/command logs.\n'
            'Do not start again or remove the marker. 10/12 ready still requires native Mac connection/registration.')


def validate_stage(h, layout, audit: Path, files) -> dict[str, bytes]:
    names = files.entries(audit, 0, 0, 0o700)
    require(names == STAGED | {'manifest.json', 'launch'}, 'Incomplete or already-claimed continuation audit.')
    # Launch logging/result writes can race worker startup, but never this directory's identity.
    with files.directory(audit / 'launch') as fd:
        require(h.metadata(os.fstat(fd)) == {'uid': 0, 'gid': 0, 'mode': 0o700}, 'Launch evidence not private.')
    payloads = {}
    for name in STAGED | {'manifest.json'}:
        data, info = files.read(audit / name, (32 if name == 'runtime-proof.json' else 8) * 1024 * 1024)
        require(h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o600}, 'Staged evidence/code must be root-private.')
        if name != 'manifest.json':
            payloads[name] = data
    require(files.reads[audit / 'manifest.json'][0] == h.encoded(manifest(h, audit, payloads)), 'Continuation manifest mismatch.')
    require(digest(payloads[HELPER_NAME]) == HELPER_SHA256 and digest(payloads['host_install.py']) == INSTALLER_SHA256, 'Staged code pin mismatch.')
    for name in RUNTIME_MODULES:
        require(digest(payloads[name]) == module_pin(name), 'Staged runtime module pin mismatch.')
    require(digest(payloads['python-assets-manifest.json']) == ASSETS_SHA256
            and digest(payloads['uv-templates-manifest.json']) == TEMPLATES_SHA256, 'Staged artifact-reference pin mismatch.')
    for name, original in EVIDENCE.items():
        require(payloads[name] == files.read(layout.operation / original, 8 * 1024 * 1024)[0], 'Original evidence changed during lock handoff.')
    files.verify()
    return payloads


def event(h, audit: Path, step: str, outcome: str, *, details: dict | None = None) -> None:
    value = {'at': int(time.time() * 1000), 'step': step, 'outcome': outcome}
    if details is not None:
        value['details'] = details
    h.Files().create(audit / ('event-' + str(uuid.uuid4()) + '.json'), h.encoded(value))


def probe_code(release: Path) -> str:
    # engine.ts strips PYTHONDONTWRITEBYTECODE from its child environment. Add -B
    # to ONLY its exact fixed Python/launcher invocation in this one probe process,
    # preserving execFile's promisified stdout/stderr contract. No release edit.
    return ('import assert from "node:assert/strict";\n'
            'import childProcess from "node:child_process";\n'
            'import { promisify } from "node:util";\n'
            'import { syncBuiltinESMExports } from "node:module";\n'
            'const python = ' + json.dumps(str(release / 'server/browser-engine/.venv/bin/python')) + ';\n'
            'const launcher = ' + json.dumps(str(release / 'server/browser-engine/launch.py')) + ';\n'
            'const originalExecFile = childProcess.execFile;\n'
            'const originalAsyncExecFile = promisify(originalExecFile);\n'
            'let launcherCalls = 0;\n'
            'function argsFor(file, args) {\n'
            ' if (file !== python) return args;\n'
            ' assert.deepEqual(args, [launcher]); launcherCalls++; return ["-B", launcher];\n'
            '}\n'
            'function execFile(file, args, ...rest) { return originalExecFile(file, argsFor(file, args), ...rest); }\n'
            'execFile[promisify.custom] = (file, args, ...rest) => originalAsyncExecFile(file, argsFor(file, args), ...rest);\n'
            'childProcess.execFile = execFile; syncBuiltinESMExports();\n'
            'const { openBrowser } = await import(' + json.dumps((release / 'server/browser/engine.ts').as_uri()) + ');\n'
            'const browser = await openBrowser();\n'
            'try {\n'
            ' assert.equal(launcherCalls, 1);\n'
            ' const page = await browser.newPage();\n'
            ' await page.route("**/*", route => route.abort());\n'
            ' await page.setContent("<!doctype html><title>Outpost offline readiness</title><main id=proof>local DOM</main>", {timeout:15000});\n'
            ' assert.equal(await page.title(), "Outpost offline readiness");\n'
            ' assert.equal(await page.locator("#proof").textContent(), "local DOM");\n'
            ' const png = await page.screenshot({type:"png", timeout:15000});\n'
            ' assert.ok(png.length > 32);\n'
            ' assert.deepEqual([...png.subarray(0,8)], [137,80,78,71,13,10,26,10]);\n'
            ' console.log("OUTPOST_OFFLINE_BROWSER_OK");\n'
            '} finally { await browser.close(); }\n')


def probe_command(h, layout, audit: Path) -> list[str]:
    release = layout.release
    data = layout.path('/var/lib/outpost-native')
    properties = ['Type=exec', 'User=outpost-coord', 'Group=outpost-coord',
                  'SupplementaryGroups=outpost-workspaces', 'UMask=0007',
                  'WorkingDirectory=' + str(release), 'NoNewPrivileges=yes', 'PrivateTmp=yes',
                  'ProtectSystem=strict', 'ProtectHome=yes',
                  f'ReadWritePaths={data}/coordinator {data}/workspaces',
                  'TasksMax=512', 'LimitNOFILE=8192', 'MemoryHigh=30%', 'MemoryMax=40%', 'CPUQuota=200%',
                  'KillMode=control-group', 'RuntimeMaxSec=120', 'TimeoutStopSec=30', 'Restart=no',
                  'IPAddressDeny=any', 'BindsTo=' + h.UNITS[0], 'After=' + h.UNITS[0]]
    return ['/usr/bin/systemd-run', '--wait', '--pipe', '--quiet', '--unit=' + probe_unit(audit),
            *('--property=' + value for value in properties),
            '/usr/bin/env', '-i', f'PATH={release}/node/bin:/usr/bin:/bin', f'HOME={data}/coordinator',
            'LANG=C.UTF-8', f'XDG_CACHE_HOME={release}/browsers',
            str(release / 'node/bin/node'), '--import', 'tsx', '--input-type=module', '--eval', probe_code(release)]


def probe_unit(audit: Path) -> str:
    return 'outpost2-browser-check-' + audit.name.removeprefix(PREFIX) + '.service'


def continuation_installer(original, h, layout, audit: Path, review: dict):
    """Keep original run's environment/cwd, cancellation, timeout and pg cleanup."""
    class Continuation(original.Installer):
        def __init__(self):
            super().__init__(layout.operation)
            require(self.status == review['status'], 'Receipt changed before worker initialization.')
            require(self.request == h.document(review['backups']['request.json'][0]), 'Enrollment identity changed.')
            self.completed = 4
            self.browser_ok = False
            self.health_ok = False
            self.ready_commit_started = False
            self.command_number = 0
            self.last_command = None
            h.Files().mkdir(audit / 'commands', 0, 0, 0o700)

        def cancelled(self):
            data, info = h.Files().read(layout.operation / 'cancel', 1, None)
            require(stat.S_IMODE(info.st_mode) == 0o600, 'Cancellation marker changed.')
            return data != b''

        def run(self, argv, *, user=None, input_data=None, timeout=900, env=None):
            self.command_number += 1
            command_dir = audit / 'commands' / f'{self.command_number:04d}'
            files = h.Files()
            files.mkdir(command_dir, 0, 0, 0o700)
            files.create(command_dir / 'command.log', b'')
            files.create(command_dir / 'command.json', h.encoded({'argv': argv, 'user': user, 'timeout': min(timeout, 180)}))
            self.last_command = command_dir / 'command.log'
            self.operation = command_dir
            try:
                return super().run(argv, user=user, input_data=input_data, timeout=min(timeout, 180), env=env)
            finally:
                self.operation = layout.operation

        def publish(self, completed, message, state='running', error=None):
            require(not self.ready_commit_started and self.status['state'] != 'ready', 'Ready publication is final; no retry or downgrade permitted.')
            require(completed == self.completed and 4 <= completed <= 10, 'Unverified progress refused.')
            require(state in ('running', 'failed', 'cancelled', 'ready'), 'Completion is not available to this tool.')
            require(completed != 10 or (state == 'ready' and self.browser_ok and self.health_ok), 'Ready requires real browser and health gates.')
            require(state != 'ready' or completed == 10, 'Premature readiness refused.')
            require(len(self.status['log']) < 80, 'Refusing to discard original receipt history.')
            files = h.Files()
            current, info = files.read(layout.operation / 'status.json', 65536)
            require(h.document(current) == self.status and h.metadata(info) == {'uid': 0, 'gid': 0, 'mode': 0o644}, 'Public receipt changed concurrently.')
            files.absent(layout.operation / 'status.json.tmp')
            if state == 'ready':
                self.ready_commit_started = True
            super().publish(completed, message, state, error)

        def forbidden(self, *args, **kwargs):
            raise Refused('Completed install steps/download/execute are prohibited.')

        preflight = accounts = runtime = dependencies = browsers = download = execute = forbidden

    return Continuation()


def launcher_check(installer, h, layout) -> None:
    env = {**installer.environment, 'XDG_CACHE_HOME': str(layout.release / 'browsers'),
           'UV_PYTHON_INSTALL_DIR': str(layout.release / 'python'), 'UV_CACHE_DIR': str(layout.operation / 'build-home/cache')}
    installer.run([str(layout.release / 'server/browser-engine/.venv/bin/python'), '-B', str(layout.release / h.LAUNCHER)],
                  user='outpost-build', env=env, timeout=120)
    # launch.py redirects GPU diagnostics to stderr; validate the actual final JSON,
    # not the earlier operator's supplied successful output.
    output = h.Files().read(installer.last_command, 4 * 1024 * 1024)[0]
    options = h.document(output.splitlines()[-1])
    require(set(options) == {'executable_path', 'args', 'env', 'firefox_user_prefs', 'headless'}
            and options['headless'] is True and isinstance(options['args'], list)
            and all(isinstance(arg, str) and arg != '--no-sandbox' for arg in options['args'])
            and isinstance(options['firefox_user_prefs'], dict) and isinstance(options['env'], dict)
            and all(isinstance(value, str) and key.startswith(('CAMOU_', 'FONTCONFIG_')) for key, value in options['env'].items()),
            'Corrected full launch_options check failed.')
    executable = Path(options['executable_path'])
    require(executable.is_absolute() and executable.resolve(strict=True).is_relative_to(layout.release / 'browsers/camoufox'), 'Unexpected browser executable.')


def run_steps(installer, h, layout, audit: Path, review: dict) -> None:
    require(not installer.ready_commit_started and installer.status['state'] != 'ready', 'Ready publication is final; no rerun permitted.')
    step = 'Runtime normalization'
    probe_started = False
    try:
        if installer.cancelled():
            raise InterruptedError('Setup cancellation requested before normalization')
        normalize_runtime(h, layout, audit, review)
        for step, completed, action in (
            ('Browser runtime', 5, lambda: launcher_check(installer, h, layout)),
            ('Protected configuration', 6, installer.configuration),
            ('Device enrollment', 7, installer.enroll),
            ('Sealed coordinator browser', 7, None),
            ('Persistent services', 8, installer.services),
            ('Health verification', 9, installer.health),
        ):
            event(h, audit, step, 'started')
            installer.publish(installer.completed, step + ' continuation started.')
            if installer.cancelled():
                raise InterruptedError('Setup cancellation requested')
            if action is None:
                verify_release_state(h, layout, review, sealed=True)
                probe_started = True
                installer.run(probe_command(h, layout, audit), timeout=165, env=CLEAN_ENV)
                output = h.Files().read(installer.last_command, 4 * 1024 * 1024)[0]
                require(output.splitlines().count(b'OUTPOST_OFFLINE_BROWSER_OK') == 1, 'Missing actual browser DOM/PNG proof.')
                verify_release_state(h, layout, review, sealed=True)
                installer.browser_ok = True
            else:
                if step == 'Persistent services':
                    check_units(h, worker=True)
                    unit_paths(h.Files(), layout, h, worker=True)
                action()
                if completed in (5, 6):
                    verify_release_state(h, layout, review, sealed=completed == 6)
            if step == 'Health verification':
                installer.health_ok = True
            installer.completed = completed
            event(h, audit, step, 'passed')
            installer.publish(completed, step + ' completed.')
        if installer.cancelled():
            raise InterruptedError('Setup cancellation requested before ready')
        step = 'Ready commit intent'
        event(h, audit, step, 'Browser and health gates passed; ready publication next, not yet committed.')
    except Exception as error:
        # This handler is strictly BEFORE the final ready publication attempt.
        try:
            event(h, audit, step, 'failed: ' + type(error).__name__)
        except OSError:
            pass  # A full disk must not prevent the original activation cleanup.
        if probe_started:
            try:
                subprocess.run(['/usr/bin/systemctl', 'stop', probe_unit(audit)], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=CLEAN_ENV, timeout=40, check=False)
            except (OSError, subprocess.SubprocessError):
                pass  # RuntimeMaxSec and BindsTo still bound the separate probe cgroup.
        cleanup_note = ''
        if installer.activated:
            # Exactly the original fresh-install cleanup; never legacy/outpost1 units.
            cleanup = {'units': list(h.UNITS[1:]), 'returnCode': None, 'exception': None}
            try:
                reply = subprocess.run(['/usr/bin/systemctl', 'disable', '--now', *h.UNITS[1:]], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=CLEAN_ENV, timeout=45, check=False)
                cleanup['returnCode'] = reply.returncode
            except (OSError, subprocess.SubprocessError) as cleanup_error:
                cleanup['exception'] = type(cleanup_error).__name__
            outcome = 'command completed (exit 0)'
            if cleanup['returnCode'] != 0:
                outcome = 'unconfirmed; inspect exact three native units'
                cleanup_note = ' Native unit cleanup unconfirmed; inspect exact three native units.'
            try:
                event(h, audit, 'Native unit cleanup', outcome, details=cleanup)
            except OSError:
                cleanup_note += ' Private cleanup evidence could not be persisted; review manually.'
        installer.publish(installer.completed, 'Continuation stopped; private audit/commands and partial native files retained. No automatic retry.',
                          'cancelled' if isinstance(error, InterruptedError) else 'failed',
                          f'{step} failed ({type(error).__name__}); inspect root-only continuation audit. Do not retry or remove marker.' + cleanup_note)
        raise
    # Final irreversible commit, deliberately OUTSIDE the failure/disable handler.
    # atomic_json may raise after rename, when a Mac can already have observed ready.
    # A failed/ambiguous commit therefore retains evidence; never downgrade or disable.
    installer.completed = 10
    installer.publish(10, 'Server ready. Connect and verify this Mac before setup is complete.', 'ready')


def worker(h, audit_id: str, *, layout=None) -> None:
    refuse_unqualified_runtime()
    require(os.geteuid() == 0, 'Worker requires root.')
    require(str(uuid.UUID(audit_id)) == audit_id, 'Worker accepts only an audit UUID.')
    layout = layout or h.Layout()
    audit = layout.operation / (PREFIX + audit_id)
    require(Path(__file__).absolute() == audit / SELF_NAME and sys.flags.isolated and sys.dont_write_bytecode,
            'Internal worker requires its staged script and /usr/bin/python3 -I -B.')
    with install_lock(h, layout):
        files = h.Files()
        payloads = validate_stage(h, layout, audit, files)
        check_units(h, worker=True)
        modules = load_runtime_modules(normalization=True)
        review = inspect(h, h.Files(), layout, audit=audit, modules=modules)
        review['audit'] = audit
        review['stagedCode'] = {name: digest(payloads[name]) for name in (SELF_NAME, HELPER_NAME, 'host_install.py', *RUNTIME_MODULES)}
        h.Files().create(audit / 'worker.json', h.encoded({'pid': os.getpid(), 'startedAt': int(time.time() * 1000)}))
        installer = None
        try:
            original = byte_module(payloads['host_install.py'], INSTALLER_SHA256, '_outpost2_original_installer', audit / 'host_install.py')
            installer = continuation_installer(original, h, layout, audit, review)
            previous_handlers = {}
            def interrupted(signum, frame):
                signal.signal(signum, signal.SIG_IGN)
                raise InterruptedError('Continuation interrupted; review retained audit')
            try:
                for sig in (signal.SIGTERM, signal.SIGINT):
                    previous_handlers[sig] = signal.signal(sig, interrupted)
                run_steps(installer, h, layout, audit, review)
            finally:
                for sig, handler in previous_handlers.items():
                    signal.signal(sig, handler)
        except Exception as error:
            if installer is None or not installer.ready_commit_started:
                event(h, audit, 'Worker', 'stopped: ' + type(error).__name__ + '; no automatic retry')
            raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='read-only host/content checks (default); Python -I -B and root required; not ready-to-start')
    mode.add_argument('--start', action='store_true', help='disabled pending verified runtime content and hardlink isolation')
    mode.add_argument('--run', metavar='AUDIT_UUID', help=argparse.SUPPRESS)
    parser.add_argument('--approve-original-plan', metavar=PLAN_ID)
    args = parser.parse_args(argv)
    try:
        if args.start or args.run is not None:
            refuse_unqualified_runtime()
        require(sys.flags.isolated and sys.flags.dont_write_bytecode and sys.dont_write_bytecode, CLI_FLAG_REFUSAL)
        require(os.geteuid() == 0, 'Root required, including read-only --check.')
        require(not args.run or args.approve_original_plan is None, 'Internal worker does not accept approval overrides.')
        h, helper_bytes = load_helper(Path(__file__).absolute().with_name(HELPER_NAME))
        if args.run:
            worker(h, args.run)
        else:
            print(operator(h, helper_bytes, start=args.start, approval=args.approve_original_plan))
        return 0
    except Exception as error:
        if isinstance(error, Refused) or ('h' in locals() and isinstance(error, h.Refused)):
            print('REFUSED: ' + str(error), file=sys.stderr)
        else:
            print('REFUSED: unsafe, unavailable or invalid input.', file=sys.stderr)
        if not args.start and args.run is None:
            print('Read-only check stopped; no actions performed. --start and --run remain disabled.', file=sys.stderr)
        else:
            print('REFUSED/STOPPED: guards, launch or runtime gate failed. Root: inspect retained status, audit events and private command logs. No automatic retry/cleanup of evidence; never delete a continuation marker to retry. If killed, use original setup unit liveness/native interrupted detection.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
