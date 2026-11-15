
"""Collect data-only Outpost2 references; never install or execute artifact code.

Run with an existing local Python 3.11+: python3 -I -B SCRIPT [--offline].
Only this script's fixed python-assets directory is written. No remote commands,
package imports, archive extraction, subprocesses, or authorization are performed.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import pathlib
import posixpath
import re
import stat
import tarfile
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from email.parser import BytesParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / '.outpost/recovery-645f62a9/python-assets'
FIXTURE = ROOT / 'scripts/fixtures/outpost2-original-release.tar.gz'
AUDIT = ROOT / '.outpost/recovery-645f62a9/runtime-audit.json'
FIXTURE_SHA = 'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57'
FIXTURE_SIZE = 223402
CAMOUFOX_SHA = '9f063e2c0356491221a53dc93148174f5fe854382eda9570e30572f10759f577'
UV_COMMIT = 'f675560f322a6ee6490643a2fce3cb520966c402'
METADATA_SHA = '7524ba4266dc1969da646c2281b4c6caf5a332df15b67db3c8e15d3389d7a1cd'
METADATA_URL = f'https://raw.githubusercontent.com/astral-sh/uv/{UV_COMMIT}/crates/uv-python/download-metadata.json'
TAG_SHA = '34a49768faf3ec03ea7303df083564fbb875f1c02d0b59d63d8a8a0afab489b4'
TAG_URL = 'https://api.github.com/repos/astral-sh/uv/git/ref/tags/0.10.9'
RELEASE_SHA = 'fa03b44832eead2a5e127900802fb819b7af9d6dbd2d713b1ecf0474845b3fa0'
RELEASE_URL = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260303'
MAX_TOTAL = 900_000_000  # Strictly below one decimal GB, including cached inputs.
CHUNK = 1 << 20
HOSTS = frozenset({'files.pythonhosted.org', 'api.github.com', 'github.com',
                   'raw.githubusercontent.com', 'release-assets.githubusercontent.com',
                   'objects.githubusercontent.com'})
MARKERS = {"python_full_version < '3.12'": False,
           "python_full_version >= '3.12'": True,
           "sys_platform == 'win32'": False, "sys_platform == 'darwin'": False}


class Refused(Exception):
    """A missing or inconsistent input that must not be guessed around."""


def need(condition: bool, message: str) -> None:
    """Fail closed with an actionable, non-secret diagnostic."""
    if not condition:
        raise Refused(message)


def sha(data: bytes) -> str:
    """Return a SHA-256 hex digest."""
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    """Serialize deterministically, without wall-clock or machine-specific fields."""
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode()


def normalize(name: str) -> str:
    """Normalize distribution names without importing packaging."""
    need(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name) is not None,
         'invalid distribution name')
    return re.sub(r'[-_.]+', '-', name).lower()


def validate_url(url: str) -> None:
    """Permit only public HTTPS artifact/source hosts; never persist signed redirects."""
    parsed = urllib.parse.urlsplit(url)
    need(parsed.scheme == 'https' and parsed.hostname in HOSTS
         and parsed.port in (None, 443) and not parsed.username and not parsed.password
         and not parsed.fragment, 'non-approved artifact URL')


class Redirects(urllib.request.HTTPRedirectHandler):
    """Keep every redirect on the approved HTTPS artifact hosts."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Validate the destination before urllib issues another request."""
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def digest_file(path: pathlib.Path, limit: int = MAX_TOTAL) -> tuple[str, int]:
    """Hash a regular file without following a final-component symlink."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_size <= limit, 'unsafe or oversized file')
        digest, size = hashlib.sha256(), 0
        for block in iter(lambda: stream.read(CHUNK), b''):
            size += len(block)
            need(size <= limit, 'file read limit')
            digest.update(block)
        after = os.fstat(stream.fileno())
        need((before.st_size, before.st_mtime_ns, before.st_ino) ==
             (after.st_size, after.st_mtime_ns, after.st_ino) and size == before.st_size,
             'file changed while hashing')
    return digest.hexdigest(), size


def safe_output_dirs() -> None:
    """Create only the permitted directory hierarchy, rejecting symlink ancestors."""
    for relative in ('.outpost', '.outpost/recovery-645f62a9',
                     '.outpost/recovery-645f62a9/python-assets'):
        directory = ROOT / relative
        if not directory.exists():
            need(directory == OUT, 'missing pre-existing recovery directory')
            directory.mkdir()
        need(stat.S_ISDIR(directory.lstat().st_mode), 'output ancestor is not a real directory')
    for folder in ('wheels', 'model', 'python', 'provenance'):
        directory = OUT / folder
        directory.mkdir(exist_ok=True)
        need(stat.S_ISDIR(directory.lstat().st_mode), 'unsafe output subdirectory')


def publish_bytes(relative: str, data: bytes) -> dict:
    """Publish complete deterministic data without replacing an existing different file."""
    destination = OUT / relative
    digest = sha(data)
    if destination.exists() or destination.is_symlink():
        need(digest_file(destination) == (digest, len(data)), f'existing output differs: {relative}')
    else:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.pending-', delete=False) as temp:
            temporary = pathlib.Path(temp.name)
            try:
                temp.write(data)
                temp.flush()
                os.fsync(temp.fileno())
                os.link(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
    return dict(path=relative, sha256=digest, bytes=len(data))


def document(value: object) -> dict:
    """Store derived data under its content hash."""
    data = canonical(value)
    return publish_bytes(f'provenance/{sha(data)}.json', data)


class Downloads:
    """Bound all response bytes, verify before publication, and support offline rechecking."""

    def __init__(self, offline: bool) -> None:
        """Count already retained data against the same conservative transfer budget."""
        self.offline = offline
        self.network_bytes = 0
        self.existing_bytes = 0
        for directory, folders, files in os.walk(OUT, followlinks=False):
            for name in folders + files:
                path = pathlib.Path(directory) / name
                info = path.lstat()
                need(not stat.S_ISLNK(info.st_mode), 'symlink in output directory')
                if stat.S_ISREG(info.st_mode):
                    self.existing_bytes += info.st_size
                else:
                    need(stat.S_ISDIR(info.st_mode), 'special file in output directory')
        need(self.existing_bytes < MAX_TOTAL, 'existing output exceeds byte budget')
        self.opener = urllib.request.build_opener(Redirects())

    def get(self, relative: str, url: str, expected_sha: str, expected_size: int) -> dict:
        """Download one fixed reference, with no retries or unverified final files."""
        validate_url(url)
        need(not urllib.parse.urlsplit(url).query, 'source URL must not contain credentials or query tokens')
        need(re.fullmatch('[0-9a-f]{64}', expected_sha) is not None
             and type(expected_size) is int and 0 < expected_size < MAX_TOTAL, 'artifact pin schema')
        path = OUT / relative
        ref = dict(path=relative, sha256=expected_sha, bytes=expected_size, url=url)
        if path.exists() or path.is_symlink():
            need(digest_file(path, expected_size) == (expected_sha, expected_size),
                 f'cached artifact mismatch: {relative}')
            return ref
        need(not self.offline, f'offline artifact missing: {relative}')
        need(self.existing_bytes + self.network_bytes + expected_size < MAX_TOTAL, 'transfer byte budget')
        request = urllib.request.Request(url, headers={
            'User-Agent': 'Outpost2-data-reference/1', 'Accept-Encoding': 'identity'})
        started = time.monotonic()
        temporary = None
        try:
            with self.opener.open(request, timeout=60) as response:
                need(response.status == 200, f'HTTP {response.status} from {url}')
                need(response.headers.get('Content-Encoding', 'identity') == 'identity',
                     'unexpected response content encoding')
                length = response.headers.get('Content-Length')
                need(length is None or int(length) == expected_size, f'HTTP size mismatch: {url}')
                digest, received = hashlib.sha256(), 0
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.pending-', delete=False) as temp:
                    temporary = pathlib.Path(temp.name)
                    while True:
                        block = response.read(min(CHUNK, expected_size - received + 1))
                        if not block:
                            break
                        self.network_bytes += len(block)
                        received += len(block)
                        need(self.existing_bytes + self.network_bytes < MAX_TOTAL, 'transfer byte budget')
                        need(received <= expected_size and time.monotonic() - started < 240,
                             'response exceeds size or time budget')
                        digest.update(block)
                        temp.write(block)
                    need(received == expected_size and digest.hexdigest() == expected_sha,
                         f'artifact hash/size mismatch: {url}')
                    temp.flush()
                    os.fsync(temp.fileno())
                os.link(temporary, path)
        except urllib.error.HTTPError as exc:
            raise Refused(f'HTTP {exc.code} blocked/failed for public source {url}') from None
        except urllib.error.URLError as exc:
            raise Refused(f'network blocked/failed for public source {url}: {type(exc.reason).__name__}') from None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print(f'verified {relative}: {expected_size} bytes', flush=True)
        return ref


def fixture_inputs() -> tuple[dict, dict, dict]:
    """Authenticate the original fixture before reading exactly two members in memory."""
    need(digest_file(FIXTURE, FIXTURE_SIZE) == (FIXTURE_SHA, FIXTURE_SIZE), 'original fixture authentication failed')
    data = FIXTURE.read_bytes()
    need(sha(data) == FIXTURE_SHA and len(data) == FIXTURE_SIZE, 'fixture changed')
    contents = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            if name in ('deploy/environment/runtime-pins.json', 'server/browser-engine/uv.lock'):
                need(name not in contents and member.isfile() and member.size < 8 * CHUNK,
                     'original member schema')
                source = archive.extractfile(member)
                if source is None:
                    raise Refused('original member missing')
                with source:
                    contents[name] = source.read(member.size + 1)
                need(len(contents[name]) == member.size, 'original member truncated')
    need(len(contents) == 2, 'original pins or uv.lock absent')
    pins = json.loads(contents['deploy/environment/runtime-pins.json'])
    lock = tomllib.loads(contents['server/browser-engine/uv.lock'].decode())
    need(pins['uvVersion'] == '0.10.9' and pins['pythonVersion'] == '3.13.12', 'unsupported original runtime version')
    inputs = dict(fixture=dict(path=str(FIXTURE.relative_to(ROOT)), sha256=FIXTURE_SHA, bytes=FIXTURE_SIZE),
                  members={name: dict(sha256=sha(value), bytes=len(value)) for name, value in contents.items()},
                  approvedUv=dict(version=pins['uvVersion'], url=pins['uvUrl'], sha256=pins['uvSha256']))
    return pins, lock, inputs


def marker_matches(marker: str | None) -> bool:
    """Evaluate only the authenticated lock's known markers; reject anything new."""
    if marker is None:
        return True
    need(marker in MARKERS, f'unhandled authenticated marker: {marker}')
    return MARKERS[marker]


def locked_closure(lock: dict) -> list[dict]:
    """Resolve production dependencies from the authenticated virtual root, not audit labels."""
    packages, selected = lock['package'], {}
    roots = [p for p in packages if p['name'] == 'outpost-browser-engine' and p['source'] == {'virtual': '.'}]
    need(len(roots) == 1, 'ambiguous lock root')
    pending = list(roots[0]['dependencies'])
    while pending:
        dependency = pending.pop()
        if not marker_matches(dependency.get('marker')):
            continue
        matches = [p for p in packages if p['name'] == dependency['name']
                   and ('version' not in dependency or p['version'] == dependency['version'])
                   and ('source' not in dependency or p['source'] == dependency['source'])
                   and all(marker_matches(m) for m in p.get('resolution-markers', []))]
        need(len(matches) == 1, f'ambiguous lock dependency: {dependency["name"]}')
        package = matches[0]
        if package['name'] in selected:
            need(selected[package['name']] == package, 'conflicting locked versions')
            continue
        need(package['source'] == {'registry': 'https://pypi.org/simple'}, 'unexpected lock source')
        selected[package['name']] = package
        pending.extend(package.get('dependencies', []))
    need(len(selected) == 40, 'production lock closure is not the expected 40 distributions')
    return [selected[name] for name in sorted(selected)]


def wheel_rank(filename: str) -> tuple[int, int] | None:
    """Prefer exact CPython ABI, then stable ABI, then pure Python; GNU x86_64 only."""
    need(filename.endswith('.whl'), 'non-wheel in wheel records')
    fields = filename[:-4].rsplit('-', 3)
    need(len(fields) == 4, 'invalid wheel filename')
    _, interpreters, abis, platforms = fields
    platform_tags = platforms.split('.')
    native = any(re.fullmatch(r'manylinux(?:1|2010|2014|_2_[0-9]+)_x86_64', p) for p in platform_tags)
    if not native and platform_tags != ['any']:
        return None
    ranks = []
    for interpreter in interpreters.split('.'):
        for abi in abis.split('.'):
            if interpreter == 'cp313' and abi == 'cp313' and native:
                ranks.append((4, 13))
            elif re.fullmatch(r'cp3[0-9]+', interpreter) and abi == 'abi3' and native:
                minor = int(interpreter[3:])
                if minor <= 13:
                    ranks.append((3, minor))
            elif interpreter in ('py3', 'py313', 'cp313') and abi == 'none':
                ranks.append((2 if native else 1, 13 if interpreter != 'py3' else 0))
    return max(ranks) if ranks else None


def choose_wheel(package: dict) -> dict:
    """Select one locked wheel without consulting installed names, versions, or tags."""
    ranked = []
    for wheel in package.get('wheels', []):
        validate_url(wheel['url'])
        need(urllib.parse.urlsplit(wheel['url']).hostname == 'files.pythonhosted.org', 'non-PyPI locked wheel')
        filename = urllib.parse.unquote(wheel['url'].rsplit('/', 1)[-1])
        rank = wheel_rank(filename)
        if rank is not None:
            ranked.append((rank, wheel))
    need(bool(ranked), f'no locked GNU x86_64 CPython 3.13 wheel: {package["name"]}')
    best = max(rank for rank, _ in ranked)
    choices = [wheel for rank, wheel in ranked if rank == best]
    need(len(choices) == 1, f'ambiguous best wheel: {package["name"]}')
    return choices[0]


def zip_data(archive: zipfile.ZipFile, name: str, limit: int) -> bytes:
    """Read a bounded, unique non-symlink ZIP member as bytes only."""
    members = [m for m in archive.infolist() if m.filename == name]
    need(len(members) == 1, f'duplicate or missing ZIP member: {name}')
    member = members[0]
    need(not member.is_dir() and not stat.S_ISLNK(member.external_attr >> 16)
         and 0 <= member.file_size <= limit, 'unsafe ZIP data member')
    with archive.open(member) as stream:
        data = stream.read(limit + 1)
    need(len(data) == member.file_size, 'ZIP size mismatch')
    return data


def wheel_metadata(path: pathlib.Path, package: dict) -> dict:
    """Inspect authenticated wheel identity and tags without executing any of its code."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        metadata = [n for n in names if n.endswith('.dist-info/METADATA')]
        wheels = [n for n in names if n.endswith('.dist-info/WHEEL')]
        need(len(metadata) == len(wheels) == 1, 'ambiguous wheel metadata')
        parsed = BytesParser().parsebytes(zip_data(archive, metadata[0], 2 * CHUNK))
        need(normalize(parsed['Name']) == normalize(package['name'])
             and parsed['Version'] == package['version'], 'wheel identity differs from lock')
        tags = BytesParser().parsebytes(zip_data(archive, wheels[0], CHUNK)).get_all('Tag', [])
        return dict(metadataMember=metadata[0], declaredWheelTags=sorted(tags))


def python_tree(path: pathlib.Path) -> dict:
    """Hash an archive tree in memory, preserving symlink targets without following them."""
    entries: list[dict] = []
    seen: set[str] = set()
    counts = dict(files=0, directories=0, symlinks=0, hardlinks=0, special=0, bytes=0)
    with tarfile.open(path, mode='r|gz') as archive:
        for member in archive:
            name = member.name.rstrip('/')
            need(name == 'python' or name.startswith('python/'), 'unexpected Python archive root')
            need(all(p not in ('', '.', '..') for p in name.split('/')) and name not in seen,
                 'duplicate or unsafe Python member')
            seen.add(name)
            need(len(seen) < 20000, 'Python archive node limit')
            relative = name.removeprefix('python/') if name != 'python' else ''
            row = dict(path=relative, mode=member.mode)
            if member.isdir():
                counts['directories'] += 1
                row['type'] = 'directory'
            elif member.isfile():
                need(not member.issparse() and 0 <= member.size < 256 * CHUNK, 'Python member size/type')
                counts['files'] += 1
                counts['bytes'] += member.size
                need(counts['bytes'] < 512 * CHUNK, 'Python uncompressed byte limit')
                stream = archive.extractfile(member)
                if stream is None:
                    raise Refused('unreadable Python member')
                digest, size = hashlib.sha256(), 0
                with stream:
                    while block := stream.read(CHUNK):
                        size += len(block)
                        need(size <= member.size, 'Python member exceeds size')
                        digest.update(block)
                need(size == member.size, 'truncated Python member')
                row.update(type='file', bytes=size, sha256=digest.hexdigest())
            elif member.issym():
                counts['symlinks'] += 1
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), member.linkname))
                need(not member.linkname.startswith('/') and resolved != '..' and not resolved.startswith('../'),
                     'Python symlink leaves reference root')
                row.update(type='symlink', target=member.linkname)
            else:
                raise Refused('unsupported Python archive special/hardlink member')
            entries.append(row)
    directories = {''}
    explicit_directories = {entry['path'] for entry in entries if entry['type'] == 'directory'}
    directories.update(explicit_directories)
    non_directories = {entry['path'] for entry in entries if entry['type'] != 'directory'}
    for entry in entries:
        parent = posixpath.dirname(entry['path'])
        while parent:
            directories.add(parent)
            parent = posixpath.dirname(parent)
    need(not directories & non_directories, 'archive path descends through a non-directory')
    return {
        'archivePrefix': 'python/',
        'counts': counts,
        'requiredTreeCounts': {**counts, 'directories': len(directories)},
        'impliedDirectories': sorted(directories - explicit_directories),
        'directoryNote': 'Required directories include the root; inferred directory modes are not asserted.',
        'entries': sorted(entries, key=lambda entry: entry['path']),
    }


def model_reference(downloads: Downloads, camoufox: dict) -> tuple[dict, dict]:
    """Derive the fixed model and marker contract from authenticated Camoufox data."""
    need(camoufox['sha256'] == CAMOUFOX_SHA and camoufox['version'] == '0.5.9', 'Camoufox pin mismatch')
    with zipfile.ZipFile(OUT / camoufox['path']) as archive:
        pin_bytes = zip_data(archive, 'camoufox/fpgen-model.json', 65536)
        source = zip_data(archive, 'camoufox/fpgen_model.py', 65536)
    need(sha(pin_bytes) == '23a01058939cd459034397e64af2bde264a464a61dc51bec3ca09d7236e7bf7b'
         and sha(source) == 'ff44518e2f1722e903109679a9c01b35a0404140adb4c69031b8b9e44299d99e',
         'reviewed Camoufox model metadata/source changed')
    pin = json.loads(pin_bytes)
    ref = downloads.get(f'model/{pin["sha256"]}.zip', pin['url'], pin['sha256'], pin['size'])
    members = []
    with zipfile.ZipFile(OUT / ref['path']) as archive:
        for name in sorted(pin['files']):
            data = zip_data(archive, name, 32 * CHUNK)
            need(sha(data) == pin['file_sha256'][name], f'pinned model member mismatch: {name}')
            members.append(dict(path=name, bytes=len(data), sha256=sha(data)))
        need({m.filename for m in archive.infolist() if not m.is_dir()} == set(pin['files']),
             'unaccounted model ZIP files')
    marker = (pin['sha256'] + '\n').encode()
    contract = dict(dataDirectory='lib/python3.13/site-packages/fpgen/data', files=members,
                    marker=dict(path='.pinned-model', text=marker.decode(), bytes=len(marker), sha256=sha(marker),
                                sourceReadSemantics='UTF-8 text stripped equals model archive SHA-256'),
                    optionalDecompressedFiles=pin['decompressed_sha256'],
                    forbiddenUnpinnedDecompressedFiles=['fingerprint-network.json', 'values.json'],
                    pinnedMtime=2145916800, authority='authenticated camoufox wheel; source inspected as data only',
                    note='Data references only; no installed files or marker have been checked or authorized.')
    contract_ref = document(contract)
    ref.update(name='fpgen-model', version=pin['tag'], kind='fpgen-model', provenance=dict(
        camoufoxWheelSha256=CAMOUFOX_SHA, pinMember='camoufox/fpgen-model.json', pinMemberSha256=sha(pin_bytes),
        sourceMember='camoufox/fpgen_model.py', sourceMemberSha256=sha(source), exactPin=pin, contract=contract_ref))
    return ref, contract_ref


def main(offline: bool) -> None:
    """Prepare a deterministic manifest whose use still requires independent verifier approval."""
    safe_output_dirs()
    pins, lock, inputs = fixture_inputs()
    with AUDIT.open('rb') as source:
        audit_bytes = source.read(16 * CHUNK)
    need(len(audit_bytes) < 16 * CHUNK, 'audit size limit')
    audit = json.loads(audit_bytes)
    inputs['audit'] = dict(path=str(AUDIT.relative_to(ROOT)), bytes=len(audit_bytes), sha256=sha(audit_bytes),
                           trust='untrusted labels and inventory only; never used to select artifacts')
    packages = locked_closure(lock)
    downloads = Downloads(offline)
    artifacts, provenance_files = [], []
    for digest, size, url, role in ((TAG_SHA, 325, TAG_URL, 'official-uv-tag-snapshot'),
                                   (METADATA_SHA, 2442653, METADATA_URL, 'immutable-uv-download-metadata'),
                                   (RELEASE_SHA, 1315166, RELEASE_URL, 'official-python-release-snapshot')):
        ref = downloads.get(f'provenance/{digest}.json', url, digest, size)
        ref['role'] = role
        provenance_files.append(ref)
    tag = json.loads((OUT / provenance_files[0]['path']).read_bytes())
    need(tag['ref'] == 'refs/tags/' + pins['uvVersion'] and tag['object'] == dict(
        sha=UV_COMMIT, type='commit', url=f'https://api.github.com/repos/astral-sh/uv/git/commits/{UV_COMMIT}'),
        'official uv tag identity mismatch')
    for package in packages:
        wheel = choose_wheel(package)
        need(re.fullmatch('sha256:[0-9a-f]{64}', wheel['hash']) is not None, 'locked wheel hash schema')
        digest = wheel['hash'][7:]
        ref = downloads.get(f'wheels/{digest}.whl', wheel['url'], digest, wheel['size'])
        metadata = wheel_metadata(OUT / ref['path'], package)
        ref.update(name=package['name'], version=package['version'], kind='wheel', provenance=dict(
            fixtureSha256=FIXTURE_SHA, lockMember='server/browser-engine/uv.lock',
            lockSha256=inputs['members']['server/browser-engine/uv.lock']['sha256'],
            packageSource=package['source'], lockedWheel=wheel,
            filename=wheel['url'].rsplit('/', 1)[-1], **metadata))
        artifacts.append(ref)
    camoufox = next(a for a in artifacts if a['name'] == 'camoufox')
    model, model_contract = model_reference(downloads, camoufox)
    artifacts.append(model)
    provenance_files.append(dict(role='fpgen-model-file-and-marker-contract', **model_contract))
    metadata = json.loads((OUT / f'provenance/{METADATA_SHA}.json').read_bytes())
    key = 'cpython-' + pins['pythonVersion'] + '-linux-x86_64-gnu'
    record = metadata[key]
    need(record['name'] == 'cpython' and record['arch'] == {'family': 'x86_64', 'variant': None}
         and record['variant'] is None and record['os'] == 'linux' and record['libc'] == 'gnu'
         and (record['major'], record['minor'], record['patch'], record['prerelease']) == (3, 13, 12, ''),
         'not the exact default Python record')
    release = json.loads((OUT / f'provenance/{RELEASE_SHA}.json').read_bytes())
    selected = [asset for asset in release['assets'] if asset['browser_download_url'] == record['url']]
    need(len(selected) == 1, 'exact Python release asset missing')
    asset = selected[0]
    need(release['tag_name'] == record['build'] == '20260303'
         and asset['digest'] == 'sha256:' + record['sha256'] and asset['state'] == 'uploaded',
         'Python release digest differs from immutable uv metadata')
    ref = downloads.get(f'python/{record["sha256"]}.tar.gz', record['url'], record['sha256'], asset['size'])
    tree = python_tree(OUT / ref['path'])
    tree_ref = document(tree)
    provenance_files.append(dict(role='managed-python-reference-tree', **tree_ref))
    ref.update(name='cpython', version=pins['pythonVersion'], kind='managed-python', provenance=dict(
        approvedUv=inputs['approvedUv'], uvTag=pins['uvVersion'], uvCommit=UV_COMMIT,
        tagSource=provenance_files[0], metadataSourceUrl=METADATA_URL, metadataFileSha256=METADATA_SHA,
        metadataPath=f'provenance/{METADATA_SHA}.json', metadataFile='crates/uv-python/download-metadata.json',
        selectedRecordKey=key, exactSelectedRecord=record,
        sizeSource=dict(url=RELEASE_URL, sha256=RELEASE_SHA, path=f'provenance/{RELEASE_SHA}.json',
                        assetId=asset['id'], assetName=asset['name'], bytes=asset['size'], digest=asset['digest']),
        referenceTree=tree_ref, archivePrefix='python/',
        expectedManagedDirectory=key,
        trust='official immutable uv source metadata, not an installed receipt'))
    artifacts.append(ref)
    expected = {(a['name'], a['version']) for a in artifacts if a['kind'] == 'wheel'}
    labels = [(normalize(d['name']), d['version']) for d in audit['distributions']]
    missing = sorted(expected - set(labels))
    extra = sorted(set(labels) - expected)
    observed_shape = {k: audit['runtime']['trees']['python'][k] for k in ('files', 'directories', 'symlinks', 'bytes')}
    deltas = {k: observed_shape[k] - tree['requiredTreeCounts'][k] for k in observed_shape}
    unresolved = []
    if missing or extra or len(labels) != len(set(labels)):
        unresolved.append(dict(code='audit-label-set-differs', missing=missing, extra=extra,
                               note='Untrusted inventory cannot change locked selections.'))
    if any(deltas.values()):
        unresolved.append(dict(code='managed-python-inventory-shape-differs',
                               note='Aggregate inventory alone cannot attribute differences. Parent must compare paths, bytes, symlink targets and justified installer transformations; no authorization granted.'))
    manifest = dict(schemaVersion=1, purpose='data-only independent references for parent verification',
        authorization='none; parent must independently pin this manifest SHA-256',
        target=dict(implementation='cpython', pythonVersion=pins['pythonVersion'], os='linux', arch='x86_64', libc='gnu', variant='default'),
        inputs=inputs, selection=dict(root='outpost-browser-engine', dependencyGroup='production',
            source='authenticated uv.lock transitive dependency graph; audit ignored for selection',
            markers=MARKERS, wheelPreference=['cp313-cp313-manylinux_x86_64', 'compatible-cp3-abi3-manylinux_x86_64', 'py3-none-manylinux_x86_64', 'py3-none-any'],
            glibcNote='Selected wheels retain their exact manylinux baseline tags; target host compatibility still requires verifier confirmation.',
            distributionCount=40, auditLabelCount=len(labels), auditLabelSetMatches=not missing and not extra and len(labels)==len(expected)),
        artifacts=sorted(artifacts, key=lambda a: (a['kind'], a['name'], a['version'], a['sha256'])),
        provenanceFiles=sorted(provenance_files, key=lambda p: p['role']),
        totals=dict(artifactCount=len(artifacts), artifactBytes=sum(a['bytes'] for a in artifacts),
                    publicDownloadBytes=sum(a['bytes'] for a in artifacts)+sum(p['bytes'] for p in provenance_files if 'url' in p),
                    transferBudgetBytes=MAX_TOTAL),
        managedPythonShape=dict(referenceArchive=tree['counts'], requiredReferenceTree=tree['requiredTreeCounts'],
            observedAudit=observed_shape, observedMinusRequiredReferenceTree=deltas,
            requiredReferenceTreeIncludesRootDirectory=True,
            observedScope='entire managed python directory; not necessarily the same archive-root scope',
            observedReceiptMetadataCount=len(audit['runtime']['managedPythonMetadata']),
            actualInstalledVersion='3.13.12 reported by task; not executed or independently confirmed here',
            referenceTree=tree_ref, comparison='aggregate only; not file verification'),
        unresolvedInputs=unresolved,
        boundaries=dict(downloadedCodeExecuted=False, downloadedPackagesImported=False, remoteHostAccess=False,
                        serviceChanges=False, archivesExtractedToFilesystem=False, installedStateAuthorized=False))
    result = publish_bytes('manifest.json', canonical(manifest))
    print(json.dumps(dict(manifest=result, totals=manifest['totals'], networkBytesThisRun=downloads.network_bytes,
                          pythonShape=manifest['managedPythonShape'], unresolvedInputs=unresolved), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='Rehash all retained inputs and references without network requests')
    args = parser.parse_args()
    try:
        main(args.offline)
    except (Refused, OSError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
        # No raw URL-bearing network exceptions: signed redirect queries must never be logged.
        if isinstance(error, Refused):
            parser.exit(1, f'Refused: {error}\n')
        parser.exit(1, f'Refused: {type(error).__name__}; no authorization or runtime changes performed\n')
