"""Hermetic, non-root tests: python3 -I -B scripts/test_verify_outpost2_python.py -v.

Temporary fake installed trees exercise tamper cases; real pinned UV source
bytes exercise template derivation, and the complete real references exercise
an offline tree plan. No upstream source, installed package/runtime, installer,
subprocess, browser or network is executed. Test-only pin patches never expose
production trust overrides.
"""
from __future__ import annotations

import ast
import base64
import csv
import hashlib
import importlib.util
import io
import json
import os
import posixpath
import re
import stat
import sys
import tarfile
import tempfile
import unittest
import warnings
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('verify_outpost2_python.py')
SPEC = importlib.util.spec_from_file_location('verify_outpost2_python', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
v = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = v
SPEC.loader.exec_module(v)
ROOT = SCRIPT.resolve().parent.parent
TEMPLATES = ROOT / '.outpost/recovery-645f62a9/uv-templates'
REAL_ASSETS = ROOT / '.outpost/recovery-645f62a9/python-assets'
REAL_MANIFEST_SHA256 = '2020eef6970c0ddcd421c04c7784c3e0ee06172be0533a7bec8fa18bc80f2bb5'
STAT_FIELDS = {'path', 'device', 'inode', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'}
with v.Files(TEMPLATES, v.Budget()) as template_reader:
    UPSTREAM = v.load_templates(template_reader)
    template_reader.recheck()


def json_bytes(value) -> bytes:
    return json.dumps(value, sort_keys=True).encode()


def tar_bytes(files: dict[str, bytes], links: dict[str, str] | None = None,
              modes: dict[str, int] | None = None) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data in files.items():
            item = tarfile.TarInfo(name)
            item.size, item.mode = len(data), (modes or {}).get(name, 0o644)
            archive.addfile(item, io.BytesIO(data))
        for name, target in (links or {}).items():
            item = tarfile.TarInfo(name)
            item.type, item.linkname, item.mode = tarfile.SYMTYPE, target, 0o777
            archive.addfile(item)
    return output.getvalue()


def zip_bytes(files: dict[str, bytes], extra: list[tuple[str, bytes]] | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in list(files.items()) + (extra or []):
            item = zipfile.ZipInfo(name)
            item.create_system = 3
            item.external_attr = (stat.S_IFREG | 0o644) << 16
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                archive.writestr(item, data)
    return output.getvalue()


def record_bytes(files: dict[str, bytes], record_path: str) -> bytes:
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    rows = []
    for path, data in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
        rows.append([posixpath.relpath(path, v.SITE), 'sha256=' + digest, str(len(data))])
    rows.append([posixpath.relpath(record_path, v.SITE), '', ''])
    writer.writerows(sorted(rows))
    return output.getvalue().encode()


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.temp = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.root = self.temp / 'root'
        self.assets = self.temp / 'assets'
        self.root.mkdir()
        self.assets.mkdir()
        self.templates = TEMPLATES
        self.release = self.root / v.RELEASE
        self.pins = dict(pythonVersion='3.13.12', uvVersion='0.10.9',
                         uvUrl='https://fixture.invalid/uv.whl', uvSha256=v.sha(b'fake uv, never run'))
        self.model = {name: ('verified model ' + name).encode() for name in sorted(v.MODEL_FILES)}
        self.model_zip = zip_bytes(self.model)
        self.model_pin: dict = dict(url='https://fixture.invalid/model.zip', size=len(self.model_zip),
                              sha256=v.sha(self.model_zip), files=sorted(v.MODEL_FILES),
                              file_sha256={k: v.sha(d) for k, d in self.model.items()},
                              decompressed_sha256={'values.dat': v.sha(b'verified decompressed data')})
        self.wheels: dict = {}
        for name, version in (('camoufox', '0.5.9'), ('fpgen', '1.3.0'), ('playwright', '1.62.0')):
            stem = name + '-' + version
            contents = {name + '/__init__.py': b'raise AssertionError("NEVER IMPORT INSTALLED CODE")\n',
                        stem + '.dist-info/METADATA': f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\n'.encode(),
                        stem + '.dist-info/WHEEL': b'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
                        stem + '.dist-info/RECORD': b'archive RECORD is not content authority\n'}
            self.wheels[name] = dict(version=version, files=contents)
        self.wheels['camoufox']['files']['camoufox/fpgen-model.json'] = json_bytes(self.model_pin)
        self.wheels['camoufox']['files']['camoufox-0.5.9.dist-info/entry_points.txt'] = (
            b'[console_scripts]\ncamoufox=camoufox.__main__:cli\n\n')
        self.wheels['fpgen']['files'].update({'fpgen/data/' + n: b'old wheel model' for n in v.MODEL_FILES})
        self.wheels['playwright']['files'].update({
            'playwright-1.62.0.data/purelib/spread_pure.py': b'pure source, not executed',
            'playwright-1.62.0.data/platlib/spread_native.so': b'fake shared object, not loaded',
            'playwright-1.62.0.data/scripts/plain-script': b'plain authenticated script\n',
            'playwright-1.62.0.data/headers/demo.h': b'header bytes',
            'playwright-1.62.0.data/data/share/demo.txt': b'shared data',
        })
        self.python_files = {'python/bin/python3.13': b'not a real interpreter; never run',
                             'python/lib/python3.13/stdlib.py': b'raise AssertionError("NO EXECUTION")\n',
                             'python/lib/python3.13/prebuilt.pyc': b'archive authenticated bytecode',
                             'python/lib/python3.13/_sysconfigdata__linux_x86_64-linux-gnu.py':
                             b'# system configuration generated and used by the sysconfig module\nbuild_time_vars = {"CC": "clang -pthread", "prefix": "/install", "AR": "/tools/ar"}\n'}
        self.python_links = {'python/bin/python3': 'python3.13'}
        self.python_modes = {'python/bin/python3.13': 0o755}
        self.publish_references()
        self.install()

    def put(self, path: Path, data: bytes, mode: int = 0o644):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    def put_release(self, path: str, data: bytes, mode: int = 0o644):
        self.put(self.release / path, data, mode)

    def pin_constant(self, name: str, value):
        self.stack.enter_context(patch.object(v, name, value))

    def publish_references(self):
        """Synthetic authentication roots are local to the test, never production knobs."""
        artifacts = []
        lock = ['version = 1', '[[package]]', 'name = "outpost-browser-engine"', 'version = "0.1.0"',
                'source = { virtual = "." }', 'dependencies = [{name="camoufox"}, {name="playwright"}]']
        for name, wheel in self.wheels.items():
            record = name + '-' + wheel['version'] + '.dist-info/RECORD'
            wheel['files'][record] = record_bytes({v.SITE + '/' + p: data for p, data in wheel['files'].items()
                                                  if p != record}, v.SITE + '/' + record)
            blob = zip_bytes(wheel['files'], wheel.get('extra'))
            version = wheel['version']
            url = 'https://fixture.invalid/' + name + '-' + version + '-py3-none-any.whl'
            path = 'wheels/' + v.sha(blob) + '.whl'
            self.put(self.assets / path, blob)
            artifacts.append(dict(kind='wheel', name=name, version=version, url=url,
                                  sha256=v.sha(blob), bytes=len(blob), path=path, provenance={}))
            lock.extend(['[[package]]', 'name = ' + json.dumps(name), 'version = ' + json.dumps(version),
                         'source = { registry = "https://pypi.org/simple" }'])
            if name == 'camoufox':
                lock.append('dependencies = [{name="fpgen"}]')
            lock.append('wheels = [{url=' + json.dumps(url) + ', hash="sha256:' + v.sha(blob) +
                        '", size=' + str(len(blob)) + '}]')
        self.source_members = {
            v.PINS: json_bytes(self.pins), v.LOCK: '\n'.join(lock).encode(),
            v.PROJECT: b'[project]\nname="outpost-browser-engine"\ndependencies=["camoufox==0.5.9", "playwright==1.62.0"]\n',
            'deploy/environment/host_install.py': b'raise AssertionError("NEVER RUN INSTALLER")\n',
        }
        source = tar_bytes(self.source_members)
        self.pin_constant('ORIGINAL_SHA256', v.sha(source))
        self.pin_constant('ORIGINAL_SIZE', len(source))
        self.put(self.root / v.OP / 'release.tar.gz', source)
        python_tar = tar_bytes(self.python_files, self.python_links, self.python_modes)
        python_pin = dict(name='cpython', arch={'family': 'x86_64', 'variant': None}, os='linux', libc='gnu',
                          major=3, minor=13, patch=12, prerelease='', variant=None, build='20260303',
                          url='https://fixture.invalid/python.tar.gz', sha256=v.sha(python_tar))
        metadata = json_bytes({v.PYTHON_KEY: python_pin})
        self.pin_constant('UV_METADATA_SHA256', v.sha(metadata))
        self.put(self.assets / ('provenance/' + v.sha(metadata) + '.json'), metadata)
        uv = dict(version='0.10.9', url=self.pins['uvUrl'], sha256=self.pins['uvSha256'])
        provenance = dict(approvedUv=uv, uvTag='0.10.9', uvCommit=v.UV_COMMIT, archivePrefix='python/',
                          expectedManagedDirectory=v.PYTHON_KEY, selectedRecordKey=v.PYTHON_KEY,
                          exactSelectedRecord=python_pin, metadataFile='crates/uv-python/download-metadata.json',
                          metadataFileSha256=v.sha(metadata), metadataPath='provenance/' + v.sha(metadata) + '.json',
                          metadataSourceUrl='https://raw.githubusercontent.com/astral-sh/uv/' + v.UV_COMMIT +
                          '/crates/uv-python/download-metadata.json')
        python_path = 'python/' + v.sha(python_tar) + '.tar.gz'
        self.put(self.assets / python_path, python_tar)
        artifacts.append(dict(kind='managed-python', name='cpython', version='3.13.12',
                              url=python_pin['url'], sha256=v.sha(python_tar), bytes=len(python_tar),
                              path=python_path, provenance=provenance))
        model_path = 'model/' + v.sha(self.model_zip) + '.zip'
        self.put(self.assets / model_path, self.model_zip)
        artifacts.append(dict(kind='fpgen-model', name='fpgen-model', version='fixture',
                              url=self.model_pin['url'], sha256=v.sha(self.model_zip), bytes=len(self.model_zip),
                              path=model_path, provenance={}))
        self.manifest: dict = dict(schemaVersion=1, artifacts=artifacts,
                             target=dict(arch='x86_64', implementation='cpython', libc='gnu', os='linux',
                                         pythonVersion='3.13.12', variant='default'),
                             inputs=dict(fixture=dict(sha256=v.sha(source), bytes=len(source)), approvedUv=uv,
                                         members={p: dict(sha256=v.sha(self.source_members[p]),
                                                          bytes=len(self.source_members[p])) for p in (v.PINS, v.LOCK)}))
        self.sign_manifest()

    def sign_manifest(self):
        blob = json_bytes(self.manifest)
        self.manifest_hash = v.sha(blob)
        self.put(self.assets / 'manifest.json', blob)

    def artifact(self, kind: str, name: str | None = None) -> dict:
        return next(a for a in self.manifest['artifacts'] if a['kind'] == kind and
                    (name is None or a['name'] == name))

    def installed_path(self, name: str) -> str:
        """Independent, explicit mapping for the fixture's spread members."""
        prefix = 'playwright-1.62.0.data/'
        if name.startswith(prefix):
            scheme, rest = name[len(prefix):].split('/', 1)
            return {'purelib': v.SITE, 'platlib': v.SITE, 'scripts': v.VENV + '/bin',
                    'headers': v.VENV + '/include/site/python3.13/playwright', 'data': v.VENV}[scheme] + '/' + rest
        return v.SITE + '/' + name

    def install(self):
        for path, data in self.python_files.items():
            if '_sysconfigdata_' in path:
                data = v.patch_sysconfig(data, UPSTREAM)
            self.put_release(v.PRIVATE + path[len('python'):], data, self.python_modes.get(path, 0o644))
        self.put_release(v.PRIVATE + '/BUILD', b'20260303')
        self.put_release(v.PRIVATE + '/lib/python3.13/EXTERNALLY-MANAGED',
                         b'[externally-managed]\nError=This Python installation is managed by uv and should not be modified.\n')
        self.put_release('python/.gitignore', b'*')
        (self.release / 'python/.temp').mkdir()
        (self.release / v.MINOR_LINK).symlink_to('/' + v.RELEASE + '/' + v.PRIVATE)
        for path, target in self.python_links.items():
            dest = self.release / (v.PRIVATE + path[len('python'):])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(target)
        self.records = {}
        for name, wheel in self.wheels.items():
            info = v.SITE + '/' + name + '-' + wheel['version'] + '.dist-info'
            contents = {}
            for path, data in wheel['files'].items():
                if path.endswith('.dist-info/RECORD'):
                    continue
                mapped = self.installed_path(path)
                self.put_release(mapped, data)
                contents[mapped] = data
            contents[info + '/INSTALLER'] = b'uv'
            contents[info + '/REQUESTED'] = b''
            ini = name + '-' + wheel['version'] + '.dist-info/entry_points.txt'
            if ini in wheel['files']:
                contents.update(v.entrypoints(wheel['files'][ini], UPSTREAM))
            for path, data in contents.items():
                self.put_release(path, data, 0o755 if path.startswith(v.VENV + '/bin/') else 0o644)
            self.records[name] = contents
            self.put_release(info + '/RECORD', record_bytes(contents, info + '/RECORD'))
        for name, data in self.model.items():
            path = self.release / v.MODEL_DIR / name
            self.put(path, data)
            os.utime(path, (v.MODEL_MTIME, v.MODEL_MTIME))
        self.put_release(v.MODEL_DIR + '/.pinned-model', (self.model_pin['sha256'] + '\n').encode())
        for path, data in v.venv_files(UPSTREAM).items():
            self.put_release(path, data)
        for name, target in {'bin/python': '/' + v.RELEASE + '/' + v.PRIVATE + '/bin/python3.13',
                             'bin/python3': 'python', 'bin/python3.13': 'python', 'lib64': 'lib'}.items():
            path = self.release / v.VENV / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)

    def verify(self):
        return v.verify(self.root, assets=self.assets, expected_manifest_sha256=self.manifest_hash,
                        templates=self.templates)

    def refuse(self, reason: str | None = None):
        with self.assertRaises(v.Refused) as caught:
            self.verify()
        if reason:
            self.assertEqual(str(caught.exception), reason)
        return str(caught.exception)

    def record_path(self, name: str) -> str:
        return v.SITE + '/' + name + '-' + self.wheels[name]['version'] + '.dist-info/RECORD'

    def test_complete_inventory_without_executing_code(self):
        result = self.verify()
        self.assertEqual(set(result), {'verifiedFiles', 'verifiedLinks', 'quarantineBytecode', 'assertions', 'summary'})
        self.assertEqual(result['summary']['distributions'], 3)
        self.assertFalse(result['summary']['executionAuthorized'])
        self.assertFalse(result['summary']['recordIsAuthenticityProof'])
        self.assertEqual(len(result['verifiedLinks']), 6)
        self.assertEqual(result['quarantineBytecode'], [])
        records = {r['path']: r for r in result['verifiedFiles']}
        self.assertEqual(records[v.MODEL_DIR + '/values.dat.zst']['sha256'], v.sha(self.model['values.dat.zst']))
        for record in records.values():
            self.assertEqual(set(record), STAT_FIELDS | {'sha256'})
            self.assertFalse(record['path'].startswith('/'))
        self.assertEqual(records[v.PRIVATE + '/lib/python3.13/prebuilt.pyc']['sha256'],
                         v.sha(b'archive authenticated bytecode'))

    def test_all_five_wheel_spread_schemes(self):
        paths = {r['path'] for r in self.verify()['verifiedFiles']}
        expected = {v.SITE + '/spread_pure.py', v.SITE + '/spread_native.so', v.VENV + '/bin/plain-script',
                    v.VENV + '/include/site/python3.13/playwright/demo.h', v.VENV + '/share/demo.txt'}
        self.assertTrue(expected <= paths)
        self.put_release(v.SITE + '/spread_pure.py', b'tampered')
        self.refuse('installed_content_mismatch')

    def test_manifest_hash_precedes_json_use(self):
        self.put(self.assets / 'manifest.json', b'{invalid JSON and path injection')
        self.refuse('manifest_hash_mismatch')

    def test_duplicate_json_keys_refused(self):
        blob = b'{"schemaVersion":1,"schemaVersion":1}'
        self.put(self.assets / 'manifest.json', blob)
        self.manifest_hash = v.sha(blob)
        self.refuse('duplicate_json_key')

    def test_source_archive_pin_is_independent(self):
        path = self.root / v.OP / 'release.tar.gz'
        blob = bytearray(path.read_bytes())
        blob[-1] ^= 1
        self.put(path, bytes(blob))
        self.refuse('original_source_hash_mismatch')

    def test_wheel_hash_checked_before_zip(self):
        item = self.artifact('wheel', 'camoufox')
        self.put(self.assets / item['path'], b'not a wheel')
        self.refuse('artifact_hash_mismatch')

    def test_repinned_manifest_cannot_replace_locked_wheel(self):
        item = self.artifact('wheel', 'camoufox')
        blob = zip_bytes({'evil.py': b'bad code'})
        item.update(sha256=v.sha(blob), bytes=len(blob), path='wheels/' + v.sha(blob) + '.whl')
        self.put(self.assets / item['path'], blob)
        self.sign_manifest()
        self.refuse('wheel_lock_mismatch')

    def test_url_independently_matches_lock(self):
        self.artifact('wheel', 'camoufox')['url'] = 'https://untrusted.invalid/camoufox.whl'
        self.sign_manifest()
        self.refuse('wheel_lock_mismatch')

    def test_artifact_paths_cannot_be_redirected(self):
        self.artifact('wheel', 'camoufox')['path'] = '../elsewhere.whl'
        self.sign_manifest()
        self.refuse('manifest_artifact_path')

    def test_missing_distribution_refused(self):
        self.manifest['artifacts'].remove(self.artifact('wheel', 'fpgen'))
        self.sign_manifest()
        self.refuse('wheel_dependency_set')

    def test_python_provenance_must_be_exact(self):
        self.artifact('managed-python')['provenance']['uvCommit'] = '0' * 40
        self.sign_manifest()
        self.refuse('manifest_python_provenance')

    def test_python_hash_not_just_manifest(self):
        item = self.artifact('managed-python')
        item['sha256'] = '0' * 64
        item['path'] = 'python/' + item['sha256'] + '.tar.gz'
        self.sign_manifest()
        self.refuse('uv_python_pin_mismatch')

    def test_immutable_metadata_hash(self):
        self.put(self.assets / ('provenance/' + v.UV_METADATA_SHA256 + '.json'), b'{}')
        self.refuse('uv_metadata_hash_mismatch')

    def test_tampered_python_file(self):
        self.put_release(v.PRIVATE + '/lib/python3.13/stdlib.py', b'tamper')
        self.refuse('installed_content_mismatch')

    def test_missing_python_file(self):
        (self.release / v.PRIVATE / 'lib/python3.13/stdlib.py').unlink()
        self.refuse('installed_path_missing')

    def test_forged_record_never_authenticates_tampered_source(self):
        path = v.SITE + '/camoufox/__init__.py'
        self.put_release(path, b'malicious source')
        self.records['camoufox'][path] = b'malicious source'
        record = self.record_path('camoufox')
        self.put_release(record, record_bytes(self.records['camoufox'], record))
        self.refuse('record_template_mismatch')

    def test_record_cannot_add_paths(self):
        record = self.record_path('camoufox')
        self.records['camoufox'][v.SITE + '/evil.py'] = b'evil'
        self.put_release(record, record_bytes(self.records['camoufox'], record))
        self.refuse('record_template_mismatch')

    def test_record_cannot_omit_paths(self):
        record = self.record_path('camoufox')
        del self.records['camoufox'][v.SITE + '/camoufox/__init__.py']
        self.put_release(record, record_bytes(self.records['camoufox'], record))
        self.refuse('record_template_mismatch')

    def test_record_cannot_duplicate_paths(self):
        record = self.release / self.record_path('camoufox')
        data = record.read_bytes()
        self.put(record, data + data.splitlines(keepends=True)[0])
        self.refuse('record_template_mismatch')

    def test_installer_metadata_is_not_free_form(self):
        path = self.record_path('camoufox').removesuffix('RECORD') + 'INSTALLER'
        self.put_release(path, b'pip')
        self.refuse('installer_metadata_mismatch')

    def test_requested_is_empty_for_transitive_dependencies_too(self):
        requested = self.record_path('fpgen').removesuffix('RECORD') + 'REQUESTED'
        self.assertIn(requested, {r['path'] for r in self.verify()['verifiedFiles']})
        self.put_release(requested, b'unexpected')
        self.refuse('installer_metadata_mismatch')

    def test_metadata_exceptions_are_fixed_bytes(self):
        self.put_release('python/.lock', b'', 0o666)
        self.put_release(v.VENV + '/.lock', b'', 0o666)
        self.put_release(v.VENV + '/.gitignore', b'*')
        self.put_release(v.VENV + '/CACHEDIR.TAG', v.CACHEDIR)
        self.assertIn('python/.lock', {r['path'] for r in self.verify()['verifiedFiles']})
        self.put_release('python/.lock', b'not empty')
        self.refuse('installed_content_mismatch')

    def test_exact_pyvenv_configuration(self):
        path = self.release / v.VENV / 'pyvenv.cfg'
        self.put(path, path.read_bytes().replace(b'include-system-site-packages = false',
                                               b'include-system-site-packages = true'))
        self.refuse('pyvenv_cfg_template_mismatch')

    def test_activation_tamper_is_refused_not_ignored(self):
        self.put_release(v.VENV + '/bin/activate', b'arbitrary activation code')
        self.refuse('uv_activation_template_mismatch')

    def test_virtualenv_pth_tamper_is_refused_not_ignored(self):
        self.put_release(v.SITE + '/_virtualenv.pth', b'import evil')
        self.refuse('uv_virtualenv_template_mismatch')

    def test_console_entrypoint_exact_template(self):
        path = v.VENV + '/bin/camoufox'
        self.assertIn(path, {r['path'] for r in self.verify()['verifiedFiles']})
        self.put_release(path, b'#!/usr/bin/python3\nimport evil\n', 0o755)
        self.refuse('uv_script_template_mismatch')

    def test_gui_entrypoint_uses_same_posix_interpreter(self):
        gui = v.entrypoints(b'[gui_scripts]\napp = demo:main\n', UPSTREAM)
        cli = v.entrypoints(b'[console_scripts]\napp = demo:main\n', UPSTREAM)
        self.assertEqual(gui, cli)
        self.assertTrue(gui[v.VENV + '/bin/app'].startswith(b'#!' + v.VENV_PYTHON.encode() + b'\n'))

    def test_rewritten_wheel_script_and_record(self):
        self.wheels['playwright']['files']['playwright-1.62.0.data/scripts/plain-script'] = b'#!python\ncode\n'
        self.publish_references()
        path = v.VENV + '/bin/plain-script'
        expected = b'#!' + v.VENV_PYTHON.encode() + b'\ncode\n'
        self.put_release(path, expected, 0o755)
        self.records['playwright'][path] = expected
        record = self.record_path('playwright')
        self.put_release(record, record_bytes(self.records['playwright'], record))
        self.verify()
        self.put_release(path, expected + b'evil\n', 0o755)
        self.refuse('uv_script_template_mismatch')

    def test_unknown_python_code_and_pth_refused(self):
        for extra in ('sitecustomize.py', 'surprise.pth', 'unknown.py', 'orphan.pyc', 'bad.so'):
            with self.subTest(extra=extra):
                path = self.release / v.SITE / extra
                self.put(path, b'untrusted code')
                self.refuse('unexpected_installed_path')
                path.unlink()

    def test_bytecode_only_for_previously_authenticated_sources(self):
        paths = [v.SITE + '/camoufox/__pycache__/__init__.cpython-313.pyc',
                 v.SITE + '/camoufox/__pycache__/__init__.cpython-313.opt-1.pyc',
                 v.PRIVATE + '/lib/python3.13/__pycache__/stdlib.cpython-313.opt-2.pyc']
        for path in paths:
            self.put_release(path, b'arbitrary bytecode never interpreted')
        result = self.verify()
        self.assertEqual({r['path'] for r in result['quarantineBytecode']}, set(paths))
        self.assertTrue(result['summary']['requiresBytecodeQuarantine'])
        self.assertFalse(result['summary']['executionAuthorized'])
        self.assertTrue(all((self.release / p).exists() for p in paths))
        for record in result['quarantineBytecode']:
            self.assertEqual(set(record), STAT_FIELDS | {'sha256'})
            self.assertEqual(record['sha256'], v.sha(b'arbitrary bytecode never interpreted'))
        self.put_release(v.SITE + '/camoufox/__init__.py', b'tampered source')
        self.refuse('installed_content_mismatch')

    def test_sourceless_and_foreign_bytecode_are_not_quarantine(self):
        for name in ('absent.cpython-313.pyc', '__init__.cpython-312.pyc', '__init__.cpython-313.opt-3.pyc'):
            with self.subTest(name=name):
                path = self.release / v.SITE / 'camoufox/__pycache__' / name
                self.put(path, b'untrusted bytecode')
                self.refuse('unexpected_installed_path')
                path.unlink()

    def test_archive_authenticated_bytecode_must_match(self):
        self.put_release(v.PRIVATE + '/lib/python3.13/prebuilt.pyc', b'tampered bytecode')
        self.refuse('installed_content_mismatch')

    def test_symlinked_bytecode_not_quarantined(self):
        path = self.release / v.SITE / 'camoufox/__pycache__/__init__.cpython-313.pyc'
        path.parent.mkdir()
        path.symlink_to('/untrusted/never-follow')
        self.refuse('unsafe_bytecode_type_or_mode')

    def test_venv_link_escape(self):
        path = self.release / v.VENV / 'bin/python'
        path.unlink()
        path.symlink_to('/usr/bin/python3')
        self.refuse('link_target_mismatch')

    def test_reference_link_escape(self):
        self.python_links['python/bin/python3'] = '/usr/bin/python3'
        self.publish_references()
        self.refuse('link_escape')

    def test_symlink_dotdot_is_not_lexically_collapsed(self):
        tree = {v.PRIVATE + '/target': v.regular(b'authenticated'),
                v.PRIVATE + '/one/deep/root': v.Reference('link', target='../..'),
                v.PRIVATE + '/one/link': v.Reference('link', target='deep/root/../../target')}
        v.parents(tree)
        with self.assertRaisesRegex(v.Refused, 'unsafe_link_target'):
            v.validate_links(tree)

    def test_reference_link_cycle(self):
        self.python_links['python/bin/python3'] = 'python3'
        self.publish_references()
        self.refuse('link_cycle')

    def test_symlinked_installed_file_is_not_read(self):
        path = self.release / v.SITE / 'camoufox/__init__.py'
        path.unlink()
        path.symlink_to(self.temp / 'outside-secret')
        self.put(self.temp / 'outside-secret', b'never read this')
        self.refuse('regular_file_required')

    def test_symlinked_ancestor_is_not_followed(self):
        path = self.release / v.SITE / 'camoufox'
        path.rename(path.with_name('camoufox-real'))
        path.symlink_to('camoufox-real', target_is_directory=True)
        self.refuse('unsafe_directory')

    def test_assets_symlink_is_not_followed(self):
        self.assets.rename(self.temp / 'real-assets')
        self.assets.symlink_to(self.temp / 'real-assets', target_is_directory=True)
        self.refuse('symlink_or_nondirectory_ancestor')

    def test_fifo_is_refused_without_opening(self):
        os.mkfifo(self.release / v.SITE / 'evil.py')
        self.refuse('special_file')

    def test_unknown_empty_directory_is_refused(self):
        (self.release / v.SITE / 'unknown').mkdir()
        self.refuse('unexpected_installed_directory')

    def test_model_stamp_must_match(self):
        self.put_release(v.MODEL_DIR + '/.pinned-model', b'forged stamp\n')
        self.refuse('installed_content_mismatch')

    def test_model_override_bytes_are_verified(self):
        path = self.release / v.MODEL_DIR / 'values.dat.zst'
        self.put(path, b'old wheel model')
        self.refuse('installed_content_mismatch')

    def test_model_pin_overrides_manifest(self):
        self.artifact('fpgen-model')['url'] = 'https://untrusted.invalid/model.zip'
        self.sign_manifest()
        self.refuse('model_pin_mismatch')

    def test_model_member_hashes_are_checked(self):
        self.model_pin['file_sha256']['values.dat.zst'] = '0' * 64
        self.wheels['camoufox']['files']['camoufox/fpgen-model.json'] = json_bytes(self.model_pin)
        self.publish_references()
        self.refuse('model_member_hash')

    def test_model_refresh_timestamp_is_pinned(self):
        path = self.release / v.MODEL_DIR / 'values.dat.zst'
        os.utime(path, (1, 1))
        self.refuse('model_refresh_timestamp')

    def test_optional_decompressed_model_hash(self):
        self.put_release(v.MODEL_DIR + '/values.dat', b'verified decompressed data')
        self.assertIn(v.MODEL_DIR + '/values.dat', {r['path'] for r in self.verify()['verifiedFiles']})
        self.put_release(v.MODEL_DIR + '/values.dat', b'foreign decompressed data')
        self.refuse('installed_content_mismatch')

    def test_unknown_model_data_refused(self):
        self.put_release(v.MODEL_DIR + '/fingerprint-network.json', b'unknown preferred data')
        self.refuse('unexpected_installed_path')

    def test_hardlinks_reported_not_detached(self):
        path = self.release / v.SITE / 'camoufox/__init__.py'
        alias = self.temp / 'cache-slot'
        os.link(path, alias)
        before = path.stat()
        result = self.verify()
        record = next(r for r in result['verifiedFiles'] if r['path'] == v.SITE + '/camoufox/__init__.py')
        self.assertEqual(record['nlink'], 2)
        self.assertEqual(path.stat().st_ino, before.st_ino)
        self.assertEqual(alias.stat().st_ino, before.st_ino)
        self.assertTrue(result['summary']['requiresHardlinkIsolation'])

    def test_write_permissions_refused_except_empty_locks(self):
        (self.release / v.SITE / 'camoufox/__init__.py').chmod(0o666)
        self.refuse('unsafe_file_mode')

    def test_archive_traversal_refused(self):
        self.wheels['camoufox']['files']['../evil.py'] = b'bad'
        self.publish_references()
        self.refuse('invalid_path')

    def test_duplicate_zip_members_refused(self):
        self.wheels['camoufox']['extra'] = [('camoufox/__init__.py', b'other bytes')]
        self.publish_references()
        self.refuse('duplicate_archive_path')

    def test_spread_collision_refused(self):
        self.wheels['playwright']['files']['playwright-1.62.0.data/purelib/playwright/__init__.py'] = b'collision'
        self.publish_references()
        self.refuse('reference_path_collision')

    def test_unknown_spread_scheme_refused(self):
        self.wheels['playwright']['files']['playwright-1.62.0.data/unknown/demo.py'] = b'bad'
        self.publish_references()
        self.refuse('wheel_data_scheme')

    def test_no_writable_file_descriptors(self):
        original = os.open
        calls = []

        def guarded(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            calls.append(flags)
            return original(path, flags, *args, **kwargs)

        with patch.object(v.os, 'open', guarded):
            self.verify()
        self.assertTrue(calls)
        self.assertTrue(all(f & os.O_NOFOLLOW for f in calls))

    def test_noatime_only_required_on_content_reads(self):
        original = os.open
        marker = 0x40000000
        seen = set()

        def guarded(path, flags, *args, **kwargs):
            reads_content = not flags & os.O_DIRECTORY or os.fspath(path) == '.'
            self.assertEqual(bool(flags & marker), reads_content)
            seen.add('content' if reads_content else 'ancestor')
            return original(path, flags & ~marker, *args, **kwargs)

        with patch.object(v.os, 'O_NOATIME', marker, create=True), patch.object(v.os, 'open', guarded):
            self.verify()
        self.assertEqual(seen, {'ancestor', 'content'})

    def test_file_change_during_read_refused(self):
        original = os.read
        fired = False
        target = self.release / v.SITE / 'camoufox/__init__.py'
        identity = target.stat().st_ino

        def changing(fd, size):
            nonlocal fired
            data = original(fd, size)
            if not fired and os.fstat(fd).st_ino == identity:
                fired = True
                self.put(target, b'changed during hashing')
            return data

        with patch.object(v.os, 'read', changing):
            self.refuse('filesystem_changed')
        self.assertTrue(fired)

    def test_late_namespace_change_refused(self):
        original = v.Files.recheck
        fired = False

        def changing(files):
            nonlocal fired
            if not fired:
                fired = True
                self.put_release(v.SITE + '/late.py', b'late attacker code')
            return original(files)

        with patch.object(v.Files, 'recheck', changing):
            self.refuse('filesystem_changed')

    def test_archive_decompression_budget(self):
        blob = tar_bytes({'python/big.py': b'x' * 65536})
        self.pin_constant('MAX_EXPANDED', 1024)
        with self.assertRaisesRegex(v.Refused, 'read_budget'):
            v.tar_members(blob, v.Budget())

    def test_wheel_platform_and_abi_bounds(self):
        for filename in ('demo-1-py3-none-win_amd64.whl', 'demo-1-cp314-cp314-linux_x86_64.whl',
                         'demo-1-cp313-cp313t-linux_x86_64.whl', 'demo-1-py3-none-linux_aarch64.whl'):
            with self.subTest(filename=filename), self.assertRaises(v.Refused):
                v.compatible_wheel('https://fixture.invalid/' + filename)

    def test_verifier_can_be_loaded_by_fixed_byte_wrapper(self):
        import types
        module = types.ModuleType('fixed_wrapper_helper_not_registered')
        exec(compile(SCRIPT.read_bytes(), 'fixed-helper', 'exec'), module.__dict__)
        self.assertTrue(callable(module.verify))

    def test_global_read_budget(self):
        self.pin_constant('MAX_BYTES', 1)
        self.refuse('read_budget')

    def test_deadline_budget(self):
        self.pin_constant('MAX_SECONDS', -1)
        self.refuse('time_budget')

    def test_manifest_cannot_supply_generated_code_exceptions(self):
        self.manifest['generatedCode'] = {'activate': 'anything'}
        self.sign_manifest()
        self.refuse('unsupported_reference_contract')

    def copy_templates(self):
        self.templates = self.temp / 'uv-templates'
        self.templates.mkdir()
        for path in TEMPLATES.iterdir():
            if path.is_file():
                self.put(self.templates / path.name, path.read_bytes())

    def test_template_hash_precedes_interpretation(self):
        self.templates = self.temp / 'uv-templates'
        self.templates.mkdir()
        self.put(self.templates / 'manifest.json', b'{ invalid JSON')
        self.refuse('template_manifest_hash_mismatch')

    def test_upstream_source_tamper_refused(self):
        self.copy_templates()
        self.put(self.templates / 'crates__uv-virtualenv__src___virtualenv.py', b'import evil')
        self.refuse('template_source_hash_mismatch')

    def test_template_leaf_symlink_refused(self):
        self.copy_templates()
        path = self.templates / 'crates__uv-virtualenv__src___virtualenv.py'
        path.unlink()
        path.symlink_to(self.temp / 'not-followed')
        self.refuse('regular_file_required')

    def test_virtualenv_source_tamper_refused(self):
        self.put_release(v.SITE + '/_virtualenv.py', UPSTREAM[v.UV_VENV + '_virtualenv.py'] + b'\nimport evil\n')
        self.refuse('uv_virtualenv_template_mismatch')

    def test_generated_source_bytecode_is_quarantine_only(self):
        path = v.SITE + '/__pycache__/_virtualenv.cpython-313.pyc'
        self.put_release(path, b'untrusted generated bytecode')
        result = self.verify()
        self.assertEqual([r['path'] for r in result['quarantineBytecode']], [path])
        self.assertTrue((self.release / path).exists())

    def test_batch_line_endings_are_not_normalized(self):
        path = self.release / v.VENV / 'bin/activate.bat'
        original = path.read_bytes()
        self.assertIn(b'\r\n', original)
        self.put(path, original.replace(b'\r\n', b'\n'))
        self.refuse('uv_activation_template_mismatch')

    def test_wrong_project_prompt_refused(self):
        path = self.release / v.VENV / 'pyvenv.cfg'
        self.put(path, path.read_bytes().replace(b'prompt = outpost-browser-engine', b'prompt = browser-engine'))
        self.refuse('pyvenv_cfg_template_mismatch')

    def test_managed_sysconfig_patch_is_exact(self):
        path = self.release / v.PRIVATE / 'lib/python3.13/_sysconfigdata__linux_x86_64-linux-gnu.py'
        self.put(path, path.read_bytes() + b'import evil\n')
        self.refuse('sysconfig_template_mismatch')

    def test_minor_version_link_is_exact_not_normalized(self):
        path = self.release / v.MINOR_LINK
        path.unlink()
        path.symlink_to(v.PYTHON_KEY)
        self.refuse('link_target_mismatch')

    def test_unexpected_installer_metadata_refused(self):
        for name in ('uv_cache.json', 'uv_build.json', 'direct_url.json'):
            with self.subTest(name=name):
                path = self.release / self.record_path('fpgen').removesuffix('RECORD') / name
                self.put(path, b'{}')
                self.refuse('unsupported_registry_installer_metadata')
                path.unlink()

    def test_assertions_and_file_stats_are_lossless(self):
        result = self.verify()
        self.assertEqual(result['assertions']['root'], str(self.root))
        self.assertEqual(result['assertions']['releasePath'], v.RELEASE)
        for record in result['verifiedFiles'] + result['quarantineBytecode'] + result['verifiedLinks']:
            info = (self.release / record['path']).lstat()
            self.assertEqual({k: record[k] for k in STAT_FIELDS}, v.stat_record(record['path'], info))
        directories = {r['path']: r for r in result['assertions']['ownedDirectories']}
        self.assertIn(v.VENV, directories)
        self.assertIn('python', directories)
        self.assertEqual(set(directories[v.VENV]), STAT_FIELDS)
        self.assertTrue(any(r['path'] == v.RELEASE for r in result['assertions']['ancestors']))

    def test_documented_json_fields_match_helper(self):
        text = (TEMPLATES / 'README.md').read_text()
        match = re.search(r'```json\n(.*?)\n```', text, re.DOTALL)
        if match is None:
            raise AssertionError('README must contain the verification JSON example')
        example = json.loads(match[1])
        result = self.verify()
        self.assertEqual(set(example), set(result))
        self.assertEqual(set(example['summary']), set(result['summary']))
        self.assertEqual(set(example['assertions']), set(result['assertions']))
        for key in ('verifiedFiles', 'verifiedLinks'):
            self.assertEqual(set(example[key][0]), set(result[key][0]))
        self.assertEqual(set(example['quarantineBytecode'][0]), STAT_FIELDS | {'sha256'})
        for key in ('ancestors', 'ownedDirectories'):
            self.assertEqual(set(example['assertions'][key][0]), set(result['assertions'][key][0]))

    def test_no_network_process_or_installed_imports_in_module(self):
        tree = ast.parse(SCRIPT.read_text())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(n.name.split('.')[0] for n in node.names)
            if isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module.split('.')[0])
        self.assertTrue(names <= sys.stdlib_module_names | {'__future__'})
        self.assertFalse(names & {'subprocess', 'socket', 'urllib', 'http', 'ctypes', 'importlib'})
        self.assertNotIn('argparse', names)


class RealUpstreamTests(unittest.TestCase):
    """Real authenticated source/assets, read as DATA; no real installed tree."""

    @classmethod
    def setUpClass(cls):
        cls.plan = v.plan_references(ROOT / 'scripts/fixtures/outpost2-original-release.tar.gz',
                                    assets=REAL_ASSETS, expected_manifest_sha256=REAL_MANIFEST_SHA256,
                                    templates=TEMPLATES)
        cls.nodes = {r['path']: r for r in cls.plan['expected']}

    def test_complete_real_reference_plan(self):
        self.assertEqual(self.plan['summary']['distributions'], 40)
        self.assertEqual(sum(r['kind'] == 'file' for r in self.nodes.values()), 6303)
        self.assertEqual(sum(r['kind'] == 'link' for r in self.nodes.values()), 1052)
        self.assertFalse(self.plan['summary']['executionAuthorized'])
        self.assertNotIn('verifiedFiles', self.plan)
        self.assertNotIn('assertions', self.plan)
        self.assertTrue(all(p == 'python' or p.startswith('python/') or p == v.VENV or
                            p.startswith(v.VENV + '/') for p in self.nodes))

    def test_real_template_source_and_derived_hashes(self):
        golden = {
            'activate': '7a2cea979c01dd191b2f13c8a44e05ec3d51c5f3d46dc1e67815db8758d14a30',
            'activate.csh': 'bfcb5636a7068587d41c229aa9a200841baec8f4f27190e30554c3a2ee6da5e5',
            'activate.fish': '40622f59c985184dead055f94ce751ed1129b8392ef030c2a536c8fb7175259c',
            'activate.nu': '92a1323ccc0e4e30d9c08684370577b90562d6720e4bfa4969916e6e95f209cc',
            'activate.ps1': '767e39d7df8d08e2fa424b52b8f467541c9561effc6c3917b3ceec428cf36f09',
            'activate.bat': 'e0f42cdcbb20dfca0bf67caee0de69c91a7eb497fbaee790e55e0c258e18a861',
            'deactivate.bat': '13ea86073a9ee43a66e3549312599dd47ff315758b4ca5a0406faf041fb82300',
            'pydoc.bat': '2a8eb66d1bc7b73adcd3c6f59e2383e0a7fe9412609c1f9d1870e35035ee6fee',
            'activate_this.py': '5b6f45724a82e26aa5a8e61ecb7e3729868cc053c2350458150386215745f7bd',
        }
        rendered = v.venv_files(UPSTREAM)
        for name, digest in golden.items():
            with self.subTest(name=name):
                self.assertEqual(v.sha(rendered[v.VENV + '/bin/' + name]), digest)
                self.assertEqual(self.nodes[v.VENV + '/bin/' + name]['sha256'], digest)
        self.assertEqual(rendered[v.SITE + '/_virtualenv.py'], UPSTREAM[v.UV_VENV + '_virtualenv.py'])
        self.assertEqual(v.sha(rendered[v.SITE + '/_virtualenv.py']),
                         '6cf30c56faf2a55228914dbbd17f8088ed371ebb08f5e7fa6fd931f913fcaf1d')
        self.assertEqual(rendered[v.SITE + '/_virtualenv.pth'], b'import _virtualenv')
        self.assertEqual(rendered[v.VENV + '/CACHEDIR.TAG'], b'Signature: 8a477f597d28d172789f06886806bc55')
        self.assertEqual(v.sha(rendered[v.VENV + '/pyvenv.cfg']),
                         'd68dfc3f7db0721ed917c239569d724e87ca5b5a63e631b382e257547641612d')

    def test_all_real_console_scripts(self):
        scripts = {
            'camoufox': ('camoufox.__main__', 'cli'),
            'normalizer': ('charset_normalizer.cli', 'cli_detect'),
            'fpgen': ('fpgen.__main__', 'cli'), 'httpx': ('httpx', 'main'),
            'idna': ('idna.cli', 'main'), 'markdown-it': ('markdown_it.cli.parse', 'main'),
            'f2py': ('numpy.f2py.f2py2e', 'main'), 'numpy-config': ('numpy._configtool', 'main'),
            'playwright': ('playwright.__main__', 'main'), 'pygmentize': ('pygments.cmdline', 'main'),
            'rich-click': ('rich_click.cli', 'main'),
        }
        for name, (module, function) in scripts.items():
            with self.subTest(name=name):
                expected = (f'#!{v.VENV_PYTHON}\n# -*- coding: utf-8 -*-\nimport sys\n'
                            f'from {module} import {function}\nif __name__ == "__main__":\n'
                            '    if sys.argv[0].endswith("-script.pyw"):\n'
                            '        sys.argv[0] = sys.argv[0][:-11]\n'
                            '    elif sys.argv[0].endswith(".exe"):\n'
                            '        sys.argv[0] = sys.argv[0][:-4]\n'
                            f'    sys.exit({function}())\n').encode()
                self.assertEqual(self.nodes[v.VENV + '/bin/' + name]['sha256'], v.sha(expected))
                self.assertTrue(self.nodes[v.VENV + '/bin/' + name]['executable'])

    def test_nested_entrypoint_and_extras_match_upstream(self):
        data = b'[console_scripts]\napp = example.module : factory.run [extra-a, extra_b]\n'
        rendered = v.entrypoints(data, UPSTREAM)[v.VENV + '/bin/app']
        self.assertIn(b'from example.module import factory\n', rendered)
        self.assertTrue(rendered.endswith(b'    sys.exit(factory.run())\n'))
        self.assertNotIn(b'extra-a', rendered)

    def test_unsupported_entrypoint_variants_fail_closed(self):
        cases = [b'[console_scripts]\n../app = x:y\n', b'[console_scripts]\npython = x:y\n',
                 b'[console_scripts]\napp = x:main();evil()\n', b'[console_scripts]\npip3 = x:y\n']
        for data in cases:
            with self.subTest(data=data), self.assertRaises(v.Refused):
                v.entrypoints(data, UPSTREAM)

    def test_uv_shebang_consumes_exactly_one_line_terminator(self):
        prefix = b'#!' + v.VENV_PYTHON.encode() + b'\n'
        cases = {b'#!python\nbody': b'body', b'#!pythonw\nbody': b'body',
                 b'#!python -x\r\nbody': b'\nbody', b'#!python\rbody': b'body', b'#!python': b''}
        for source, rest in cases.items():
            self.assertEqual(v.rewrite_script(source, UPSTREAM), prefix + rest)
        self.assertEqual(v.rewrite_script(b'#!/usr/bin/env sh\nbody', UPSTREAM), b'#!/usr/bin/env sh\nbody')
        with patch.object(v, 'VENV_PYTHON', '/unsupported path/python'), self.assertRaisesRegex(v.Refused, 'unsupported_shebang_layout'):
            v.shebang(UPSTREAM)

    def test_real_sysconfig_output_golden(self):
        path = v.PRIVATE + '/lib/python3.13/_sysconfigdata__linux_x86_64-linux-gnu.py'
        self.assertEqual(self.nodes[path]['sha256'], '744798320bda00c1f341dd18a023975edc4d31cea4ec58206792878f3ab6ce30')
        self.assertEqual(self.nodes[path]['size'], 47706)

    def test_sysconfig_derivation_values_without_execution(self):
        source = (b'# system configuration generated and used by the sysconfig module\n'
                  b'build_time_vars = {"CC": "clang  -pthread -isysroot /ignored", "AR": "/tools/ar", '
                  b'"CXX": "clang++ -pthread", "prefix": "/install/lib", "COUNT": -1}\n')
        expected = {'AR': 'ar', 'CC': 'cc -pthread', 'COUNT': -1, 'CXX': 'c++ -pthread',
                    'PYTHON_BUILD_STANDALONE': 1, 'prefix': '/' + v.RELEASE + '/' + v.PRIVATE + '/lib'}
        rendered = v.patch_sysconfig(source, UPSTREAM)
        self.assertEqual(rendered, b'# system configuration generated and used by the sysconfig module\n'
                         b'build_time_vars = ' + json.dumps(expected, sort_keys=True, indent=4).encode() + b'\n')
        with self.assertRaises(v.Refused):
            v.patch_sysconfig(source + b'raise AssertionError("MUST NOT EXECUTE")\n', UPSTREAM)

    def test_pkgconfig_exact_newline_rule(self):
        self.assertEqual(v.patch_pkgconfig(b'prefix=/install\nlibdir=${prefix}/lib\n'),
                         b'prefix=${pcfiledir}/../..\nlibdir=${prefix}/lib')
        unchanged = b'prefix=${pcfiledir}/../..\n'
        self.assertEqual(v.patch_pkgconfig(unchanged), unchanged)

    def test_model_overrides_and_optional_decompressed_bounds(self):
        optional = {r['path']: r for r in self.plan['optional']}
        value = optional[v.MODEL_DIR + '/values.dat']
        self.assertEqual(value['sha256'], '9ce7d16630e91654e73988f7d37e8c99987c09b9c779a7bb9dc7ad6355dcc2f0')
        self.assertEqual(value['size'], -1)
        self.assertEqual(self.nodes[v.MODEL_DIR + '/values.dat.zst']['sha256'],
                         '3da2cf0891a4a85ef6458f0fbdf9346acfcd04e5fd279a0ea22d7919e4eaf122')


if __name__ == '__main__':
    unittest.main()
