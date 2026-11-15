"""Fixed Outpost2 fresh-install transport; no local journal or credential writes.

The native caller owns approval, identity and persistence. Stdin is bounded JSON
containing its exact Entry, installer source and password-free request frame.
Only an existing admin-session broker may authorize the single bootstrap call.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tarfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path

REPO = Path('/Users/sudarshanrajagopalan/Developer/Outpost')
FRESH = '2e1c768b-fb41-4f33-912e-a86cbc038098'
OLD_OPERATION = '645f62a9-37c8-413e-b31e-9372bc2ed774'
OLD_ENVIRONMENT = 'cbfedef7-2f91-4b6d-8ba8-d4c1f5ea5a6b'
FINGERPRINT = 'SHA256:nsTF3++XntFP3pfnvBeVVGsUsSMqgsNazw6lI+nA3UI'
TARGET = {'host': 'surajhomeserver2', 'user': 'surajadmin2', 'port': 22,
          'identityFile': '/Users/sudarshanrajagopalan/.ssh/surajhomeserver2'}
INSTALLER_SHA256 = 'd5ce74e40751e1ab9cb736f5e8f72f368f364e9e78d812a61fd952a7e47814ce'
RELEASE = 'host-5954216307cbf96196fc'
ARCHIVE_SHA256 = 'acab95c9d7bbe1113e9bdc31a3fe6f548078b0e9293fae241396b5e31c91e822'
ARCHIVE_SIZE = 229135
MAX_BLOB = 1024 * 1024
MAX_MESSAGE = 3 * MAX_BLOB
MAX_REPLY = 65536
FAILURE = 'Install broker refused or launch outcome unknown; poll the same operation, never automatically relaunch.\n'


class Refused(Exception):
    """Carry no remote output, source, frame or identity material."""


def require(condition: bool) -> None:
    """Fail closed without reflecting submitted content."""
    if not condition:
        raise Refused()


def _pairs(items: list[tuple[str, object]]) -> dict:
    """Reject duplicate fields instead of choosing an ambiguous interpretation."""
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def _constant(_value: str) -> None:
    """Reject non-JSON numeric constants."""
    raise Refused()


def document(raw: bytes) -> dict:
    """Decode a strict object without executing any submitted code."""
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs, parse_constant=_constant)
    require(type(value) is dict)
    return value


def identifier(value: object) -> bool:
    """Require the canonical UUID representation used by the native protocol."""
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def blob(value: object) -> bytes:
    """Decode a canonical bounded base64 blob."""
    require(type(value) is str and len(value) <= 4 * ((MAX_BLOB + 2) // 3))
    decoded = base64.b64decode(value, validate=True)
    require(0 < len(decoded) <= MAX_BLOB and base64.b64encode(decoded).decode('ascii') == value)
    return decoded


def read_regular(path: Path, limit: int) -> bytes:
    """Read owned, non-group-writable regular bytes without following a leaf link."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
                and before.st_nlink == 1 and not before.st_mode & 0o022 and before.st_size <= limit)
        data = source.read(limit + 1)
        after = os.fstat(source.fileno())
        current = path.lstat()
        stamp = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        require(len(data) <= limit and stamp(before) == stamp(after) == stamp(current))
        return data


def validate(envelope: dict, installer: bytes, manifest: dict, now_ms: int) -> tuple[bytes, bytes, dict]:
    """Bind the exact reviewed source, fresh entry, current bundle and request."""
    require(set(envelope) == {'entry', 'source', 'frame'})
    source, frame = blob(envelope['source']), blob(envelope['frame'])
    require(source == installer and hashlib.sha256(source).hexdigest() == INSTALLER_SHA256)
    entry = envelope['entry']
    require(type(entry) is dict and entry.get('id') == FRESH and entry.get('target') == TARGET
            and type(entry['target']['port']) is int
            and entry.get('fingerprint') == FINGERPRINT and entry.get('phase') == 'install_review'
            and entry.get('installation') is None and entry.get('endpoint') is None
            and entry.get('connectionPaused') is False)
    require(type(entry.get('inspection')) is dict and entry['inspection'].get('nativePresent') is False)
    plan = entry.get('plan')
    require(type(plan) is dict and plan.get('browser') is True and plan.get('fullControl') is True
            and type(plan.get('expiresAt')) is int and now_ms <= plan['expiresAt'] <= now_ms + 300000)
    for key in ('planId', 'operationId', 'environmentId', 'deviceId'):
        require(identifier(plan.get(key)))
    require(len({plan['planId'], plan['operationId'], plan['environmentId'], FRESH,
                 OLD_OPERATION, OLD_ENVIRONMENT}) == 6)
    require(manifest.get('id') == RELEASE and manifest.get('sha256') == ARCHIVE_SHA256
            and manifest.get('size') == ARCHIVE_SIZE and type(manifest.get('manifest')) is dict
            and manifest['manifest'].get('id') == RELEASE)
    for key in ('releaseId', 'sha256', 'size', 'nodeVersion'):
        require(plan.get(key) == manifest['id' if key == 'releaseId' else key])
    line, separator, archive = frame.partition(b'\n')
    require(separator == b'\n' and 0 < len(line) < 16385)
    request = document(line)
    expected = {key: plan[key] for key in ('operationId', 'environmentId', 'deviceId', 'publicKey',
                                         'releaseId', 'sha256', 'size', 'browser', 'fullControl')}
    expected.update(label=entry.get('label'), coexistence=True)
    require(request == expected and set(request) == set(expected)
            and all(request[key] is True for key in ('browser', 'fullControl', 'coexistence')))
    require(type(request['size']) is int and len(archive) == ARCHIVE_SIZE
            and hashlib.sha256(archive).hexdigest() == ARCHIVE_SHA256)
    label = request['label']
    require(type(label) is str and 1 <= len(label) <= 80
            and all(ord(char) >= 32 and ord(char) != 127 for char in label))
    require(len(base64.b64decode(request['publicKey'], validate=True)) == 32)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        members = bundle.getmembers()
        require(len(members) <= 4096 and sum(member.size for member in members) <= 32 * MAX_BLOB)
        installers = [member for member in members if member.name.removeprefix('./') == 'deploy/environment/host_install.py']
        require(len(installers) == 1 and installers[0].isfile() and installers[0].size == len(source))
        member_file = bundle.extractfile(installers[0])
        require(member_file is not None)
        with member_file:
            require(member_file.read(MAX_BLOB + 1) == source)
    return source, frame, request


def bootstrap_source(source: bytes) -> bytes:
    """Restore argv after the broker loader clears it; keep future imports intact."""
    wrapper = (b"import sys\nsys.argv = ['host_install.py', '--bootstrap']\nexec(compile("
               + repr(source).encode('ascii')
               + b", 'host_install.py', 'exec'), {'__name__': '__main__'})\n")
    require(len(wrapper) <= MAX_BLOB)
    return wrapper


def load_broker() -> Callable:
    """Load only the fixed repository broker; do not open a session or prompt."""
    path = REPO / 'scripts/outpost2_admin_session.py'
    code = read_regular(path, MAX_BLOB)
    spec = importlib.util.spec_from_file_location('outpost2_admin_session', path)
    require(spec is not None and spec.loader is not None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(code, str(path), 'exec'), module.__dict__)
    require(module.REPO == REPO and module.KEY == Path(TARGET['identityFile'])
            and module.FINGERPRINT == FINGERPRINT
            and module.ALIAS == 'outpost-setup-be06c19e-6305-4621-9aa9-8bcce9baf7da'
            and module.PIN == Path('/Users/sudarshanrajagopalan/Library/Application Support/dev.outpost.desktop/server-setup/be06c19e-6305-4621-9aa9-8bcce9baf7da.known_hosts'))
    argv = module._ssh_argv(['/usr/bin/true'])  # Pure argv construction, never dispatched.
    require(argv[-2] == 'surajadmin2@surajhomeserver2' and argv[argv.index('-p') + 1] == '22'
            and argv[argv.index('-i') + 1] == TARGET['identityFile'])
    return module.run_python


def dispatch(source: bytes, frame: bytes, request: dict, runner: Callable) -> bytes:
    """Make exactly one broker call; discard all failed/ambiguous output."""
    result = runner(bootstrap_source(source), payload=frame, seconds=90, label='fresh-install')
    require(type(result) is dict and set(result) == {'exitCode', 'stdout', 'stderr'}
            and type(result['exitCode']) is int and result['exitCode'] == 0
            and type(result['stdout']) is bytes and len(result['stdout']) <= MAX_REPLY)
    receipt = document(result['stdout'])
    require(all(receipt.get(key) == request[key] for key in ('operationId', 'environmentId', 'releaseId')))
    return result['stdout']


def main() -> int:
    """All failures are static and nonzero; stdout is only a successful receipt."""
    try:
        require(sys.platform == 'darwin' and sys.flags.isolated and sys.flags.dont_write_bytecode
                and sys.flags.no_site and len(sys.argv) == 1
                and os.environ.get('OUTPOST_OPERATOR_SETUP') == TARGET['host']
                and os.environ.get('OUTPOST_OPERATOR_FRESH') == FRESH)
        raw = sys.stdin.buffer.read(MAX_MESSAGE + 1)
        require(len(raw) <= MAX_MESSAGE)
        source, frame, request = validate(
            document(raw), read_regular(REPO / 'deploy/environment/host_install.py', MAX_BLOB),
            document(read_regular(REPO / 'desktop/src-tauri/resources/host-release.json', 65536)),
            int(time.time() * 1000),
        )
        output = dispatch(source, frame, request, load_broker())
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
        return 0
    except Exception:
        sys.stderr.write(FAILURE)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
