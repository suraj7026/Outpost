"""Run locally: python3 -I -B scripts/test_verify_outpost2_node.py -v.

Synthetic temporary trees exercise verify(). If the data-only reference directory
exists, also reauthenticate and parse the real Node archive and all 175 original
npm lock references; no downloaded artifact is ever extracted or executed. The
immutable original fixture is never modified. Tests never use the network, root,
npm, a runtime host, browsers or installed code. Trust-pin replacement is confined
to synthetic tests; production has no pin override or CLI root option.
"""
from __future__ import annotations

import ast
import base64
import hashlib
import importlib.util
import io
import json
import os
import posixpath
import shutil
import stat
import sys
import tarfile
import tempfile
import unittest
import zipfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('verify_outpost2_node', Path(__file__).with_name('verify_outpost2_node.py'))
assert SPEC is not None and SPEC.loader is not None
v = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = v
SPEC.loader.exec_module(v)
ORIGINAL_SHA256, ORIGINAL_SIZE = v.ARCHIVE_SHA256, v.ARCHIVE_SIZE
SECRET = 'DO_NOT_DISCLOSE_PRIVATE_CANARY'


def encoded(value: dict) -> bytes:
    return json.dumps(value, separators=(',', ':')).encode()


def tar_blob(files: dict[str, bytes], top: str = 'package', compression: str = 'gz',
             links: dict[str, str] | None = None, extras: list[tarfile.TarInfo] | None = None,
             executable: tuple[str, ...] = ()) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:xz' if compression == 'xz' else 'w:gz') as archive:
        for name, data in files.items():
            item = tarfile.TarInfo(top + '/' + name if top else './' + name)
            item.size = len(data)
            item.mode = 0o755 if name in executable else 0o644
            archive.addfile(item, io.BytesIO(data))
        for name, target in (links or {}).items():
            item = tarfile.TarInfo(top + '/' + name)
            item.type, item.linkname, item.mode = tarfile.SYMTYPE, target, 0o777
            archive.addfile(item)
        for item in extras or []:
            archive.addfile(item, io.BytesIO(b'x' * item.size))
    return output.getvalue()


def zip_blob(files: dict[str, bytes], executable: tuple[str, ...] = (),
             extras: list[tuple[zipfile.ZipInfo, bytes]] | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            item = zipfile.ZipInfo(name)
            item.create_system = 3
            item.external_attr = (stat.S_IFREG | (0o755 if name in executable else 0o644)) << 16
            archive.writestr(item, data)
        for item, data in extras or []:
            archive.writestr(item, data)
    return output.getvalue()


def integrity(data: bytes, algorithm: str = 'sha512') -> str:
    return algorithm + '-' + base64.b64encode(hashlib.new(algorithm, data).digest()).decode()


class RuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.op = self.root / v.OP
        self.release = self.root / v.RELEASE
        self.font = b'<fontconfig>synthetic pinned fontconfig</fontconfig>'
        self.stack.enter_context(patch.object(v, 'FONT_SHA256', v.sha(self.font)))
        self.lock = {'name': 'outpost', 'version': '0.1.0', 'lockfileVersion': 3, 'requires': True,
                     'packages': {'': {'name': 'outpost', 'version': '0.1.0', 'dependencies': {'tool': '1.0.0'}}}}
        self.npm_blobs: dict[str, bytes] = {}
        self.present = set()
        self.add_package('node_modules/tool', 'tool', bins={'tool': 'bin/cli.js'},
                         files={'bin/cli.js': b'#!/usr/bin/env node\nthrow Error("NEVER EXECUTE");\n'})
        self.add_package('node_modules/tool/node_modules/@scope/nested', '@scope/nested')
        self.add_package('node_modules/alias', 'actual-package', alias=True,
                         bins={'aliased': './cli.js'}, files={'cli.js': b'#!/usr/bin/env node\n// inert\n'})
        self.add_package('node_modules/@other/os-only', '@other/os-only', optional=True, present=False,
                         extra_lock={'os': ['darwin'], 'cpu': ['arm64']})
        self.node_files = {'bin/node': b'NEVER EXECUTE NODE\n',
                           'lib/node_modules/npm/bin/npm-cli.js': b'throw Error("NEVER EXECUTE NPM");\n',
                           'lib/node_modules/npm/package.json': b'{"name":"npm","version":"fixture"}',
                           'include/node/node.h': b'fixture header\n'}
        self.node_links = {'bin/npm': '../lib/node_modules/npm/bin/npm-cli.js'}
        self.node_blob = tar_blob(self.node_files, top=v.NODE_TOP, compression='xz', links=self.node_links,
                                  executable=('bin/node', 'lib/node_modules/npm/bin/npm-cli.js'))
        for name, data in self.node_files.items():
            self.put(self.release / 'node' / name, data,
                     0o755 if name in ('bin/node', 'lib/node_modules/npm/bin/npm-cli.js') else 0o644)
        for name, target in self.node_links.items():
            (self.release / 'node' / name).symlink_to(target)
        self.uv = b'NEVER EXECUTE UV\n'
        self.uv_blob = zip_blob({v.UV_MEMBER: self.uv, 'uv-0.10.9.data/scripts/uvx': b'unused'},
                                executable=(v.UV_MEMBER,))
        self.put(self.release / 'node/bin/uv', self.uv, 0o755)
        self.browser_files = {'camoufox': b'NEVER EXECUTE BROWSER\n', 'libxul.so': b'fixture library',
                              'fonts/Noto Sans.ttf': b'fixture font', 'version.json': b'overwritten upstream version'}
        self.browser_blob = zip_blob(self.browser_files, executable=('camoufox',))
        for name, data in self.browser_files.items():
            self.put(self.release / v.BROWSER / name, data, 0o755 if name == 'camoufox' else 0o644)
        self.put(self.release / v.FONT, self.font)
        self.refresh()

    def put(self, path: Path, data: bytes, mode: int = 0o644) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    def add_package(self, path: str, name: str, *, bins: dict | str | None = None,
                    files: dict[str, bytes] | None = None, optional: bool = False,
                    present: bool = True, alias: bool = False, extra_lock: dict | None = None,
                    cache_algorithm: str = 'sha512') -> None:
        metadata: dict = {'name': name, 'version': '1.0.0'}
        if bins is not None:
            metadata['bin'] = bins
        contents = {'package.json': encoded(metadata), 'index.js': b'throw Error("NEVER IMPORT");\n', **(files or {})}
        blob = tar_blob(contents)
        self.npm_blobs[path] = blob
        entry: dict = {'version': '1.0.0', 'resolved': 'https://invalid.example/fixture.tgz',
                 'integrity': integrity(blob, cache_algorithm), 'license': 'MIT'}
        if bins is not None:
            entry['bin'] = v.bins(bins, name)
        if alias:
            entry['name'] = name
        if optional:
            entry['optional'] = True
        entry.update(extra_lock or {})
        self.lock['packages'][path] = entry
        if present:
            self.present.add(path)
            for relative, data in contents.items():
                self.put(self.release / path / relative, data)
            self.cache_package(path)
            container, _, _ = v.package_location(path)
            for command, target in v.bins(bins, name).items():
                (self.release / path / target).chmod(0o755)
                link = self.release / container / '.bin' / command
                link.parent.mkdir(parents=True, exist_ok=True)
                if not link.is_symlink():
                    link.symlink_to(os.path.relpath(self.release / path / target, link.parent))

    def cache_package(self, path: str) -> Path:
        _, _, cache = v.sri(self.lock['packages'][path]['integrity'])
        self.put(self.root / cache, self.npm_blobs[path])
        return self.root / cache

    def refresh(self) -> None:
        self.pins = {'nodeVersion': '24.22.1', 'uvVersion': '0.10.9', 'camoufoxVersion': '158.0.1',
                     'camoufoxBuild': 'beta.41', 'camoufoxInterface': 1,
                     'nodeSha256': v.sha(self.node_blob), 'uvSha256': v.sha(self.uv_blob),
                     'camoufoxSha256': v.sha(self.browser_blob)}
        release = tar_blob({v.PINS: encoded(self.pins), 'package-lock.json': encoded(self.lock),
                            'unused-source.py': b'raise AssertionError("NEVER IMPORT")'}, top='')
        self.stack.enter_context(patch.object(v, 'ARCHIVE_SHA256', v.sha(release)))
        self.stack.enter_context(patch.object(v, 'ARCHIVE_SIZE', len(release)))
        self.put(self.op / 'release.tar.gz', release)
        self.put(self.op / 'node.tar.xz', self.node_blob)
        self.put(self.op / 'uv.whl', self.uv_blob)
        self.put(self.op / 'camoufox.zip', self.browser_blob)
        self.put(self.release / v.BROWSER / 'version.json', encoded({
            'version': self.pins['camoufoxVersion'], 'build': self.pins['camoufoxBuild'],
            'interface': self.pins['camoufoxInterface'], 'sha256': self.pins['camoufoxSha256']}))
        self.hidden = {key: self.lock[key] for key in ('name', 'version', 'lockfileVersion', 'requires')}
        self.hidden['packages'] = {p: self.lock['packages'][p] for p in sorted(self.present)}
        self.put(self.release / 'node_modules/.package-lock.json', encoded(self.hidden))

    def refuses(self, code: str | None = None) -> str:
        with self.assertRaises(v.Refused) as caught:
            v.verify(self.root)
        message = str(caught.exception)
        self.assertRegex(caught.exception.code, r'^[a-z_]+$')
        self.assertTrue(message.startswith(caught.exception.code))
        self.assertLessEqual(len(message), 512)
        self.assertNotIn(SECRET, message)
        self.assertNotIn(str(self.root), message)
        self.assertNotIn('https:', message)
        if code is not None:
            self.assertEqual(caught.exception.code, code)
        return message

    def snapshot(self) -> dict:
        result = {}
        for parent, dirs, names in os.walk(self.root, followlinks=False):
            for name in dirs + names:
                path = Path(parent) / name
                info = path.lstat()
                data = path.read_bytes() if stat.S_ISREG(info.st_mode) else (
                    os.readlink(path) if stat.S_ISLNK(info.st_mode) else None)
                result[str(path.relative_to(self.root))] = (v.stamp(info), data)
        return result

    @contextmanager
    def read_only(self):
        original = os.open

        def guarded(path, flags, *args, **kwargs):
            self.assertEqual(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND), 0)
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertTrue(flags & os.O_NONBLOCK)
            if hasattr(os, 'O_NOATIME'):
                self.assertTrue(flags & os.O_NOATIME)
            return original(path, flags, *args, **kwargs)

        with ExitStack() as stack:
            stack.enter_context(patch.object(os, 'open', side_effect=guarded))
            for name in ('system', 'popen', 'execv', 'execve', 'spawnv', 'fork', 'mkdir', 'unlink',
                         'rename', 'replace', 'chmod', 'chown', 'link', 'symlink', 'truncate', 'utime', 'write'):
                stack.enter_context(patch.object(os, name, side_effect=AssertionError('forbidden operation')))
            stack.enter_context(patch('builtins.open', side_effect=AssertionError('unexpected pathname open')))
            yield

    def test_happy_path_is_read_only_streaming_secret_free(self):
        self.put(self.op / 'command.log', SECRET.encode())
        self.put(self.root / 'private-data', SECRET.encode())
        before = self.snapshot()
        with self.read_only():
            result = v.verify(self.root)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(set(result), {'verifiedFiles', 'verifiedLinks', 'summary'})
        records = {entry['path']: entry for entry in result['verifiedFiles']}
        self.assertEqual(records['node/bin/node'], {'path': 'node/bin/node', 'sha256': v.sha(self.node_files['bin/node']),
                                                   'size': len(self.node_files['bin/node']), 'mode': 0o755, 'nlink': 1})
        self.assertIn(v.FONT, records)
        self.assertIn('node_modules/tool/node_modules/@scope/nested/index.js', records)
        self.assertEqual(result['summary']['npm']['packages'], 3)
        self.assertEqual(result['summary']['npm']['absentOptionalPackages'], ['node_modules/@other/os-only'])
        self.assertEqual(len(result['verifiedLinks']), 3)
        self.assertNotIn(SECRET, json.dumps(result))
        for record in result['verifiedFiles']:
            self.assertEqual(set(record), {'path', 'sha256', 'size', 'mode', 'nlink'})
            self.assertLessEqual(len(record['path']), v.MAX_PATH)
            self.assertFalse(record['path'].startswith('/'))

    def test_wrong_original_pin_is_checked_before_parsing(self):
        path = self.op / 'release.tar.gz'
        data = path.read_bytes()
        path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        with patch.object(v, 'tar_entries', side_effect=AssertionError('must not parse')):
            self.refuses('artifact_digest_mismatch')

    def test_wrong_retained_pins(self):
        for name in ('node.tar.xz', 'uv.whl', 'camoufox.zip'):
            with self.subTest(name=name):
                path = self.op / name
                original = path.read_bytes()
                path.write_bytes(b'not an archive ' + SECRET.encode())
                self.refuses('artifact_digest_mismatch')
                path.write_bytes(original)

    def test_wrong_npm_sri_is_checked_before_tar_parse(self):
        cache = self.cache_package('node_modules/tool')
        cache.write_bytes(b'invalid tar ' + SECRET.encode())
        original = v.tar_entries
        parsed = []

        def observed(*args, **kwargs):
            parsed.append(args[4])
            return original(*args, **kwargs)

        with patch.object(v, 'tar_entries', side_effect=observed):
            self.refuses('artifact_digest_mismatch')
        self.assertNotIn('node_modules/tool', parsed)

    def test_missing_nonoptional_cache_refuses(self):
        self.cache_package('node_modules/tool').unlink()
        self.refuses('unreadable_or_invalid_input')

    def test_missing_nonoptional_package_refuses_even_without_cache(self):
        shutil.rmtree(self.release / 'node_modules/tool/node_modules/@scope/nested')
        self.refuses('missing_required_package')

    def test_optional_installed_package_still_requires_valid_cache(self):
        self.add_package('node_modules/optional', 'optional', optional=True)
        self.refresh()
        self.cache_package('node_modules/optional').write_bytes(b'wrong')
        self.refuses('artifact_digest_mismatch')

    def test_optional_missing_requires_explicit_boolean_flag(self):
        entry = self.lock['packages']['node_modules/@other/os-only']
        entry.pop('optional')
        self.refresh()
        self.refuses('missing_required_package')
        entry['optional'] = 1
        self.refresh()
        self.refuses('unsupported_package')

    def test_lock_derived_empty_scope_directory_allowed(self):
        (self.release / 'node_modules/@other').mkdir()
        v.verify(self.root)
        (self.release / 'node_modules/@unlocked').mkdir()
        self.refuses('unexpected_or_missing_path')

    def test_unexpected_files_and_empty_directories_all_scopes(self):
        for tree in v.TREES:
            for mode in (0o644, 0o755):
                with self.subTest(tree=tree, mode=mode):
                    path = self.release / tree / SECRET
                    self.put(path, b'extra code or data', mode)
                    self.refuses('unexpected_or_missing_path')
                    path.unlink()
        path = self.release / v.BROWSER / 'unexpected-directory'
        path.mkdir()
        self.refuses('unexpected_or_missing_path')

    def test_installed_content_tampering(self):
        for relative in ('node/bin/node', 'node/bin/uv', v.BROWSER + '/libxul.so', v.FONT,
                         'node_modules/tool/index.js', 'node_modules/tool/node_modules/@scope/nested/index.js'):
            with self.subTest(path=relative):
                path = self.release / relative
                original = path.read_bytes()
                path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
                self.refuses('file_digest_mismatch')
                path.write_bytes(original)

    def test_unexpected_executable_mode_and_setid(self):
        path = self.release / 'node_modules/tool/index.js'
        for mode in (0o755, 0o4644, 0o2644, 0o666):
            with self.subTest(mode=mode):
                path.chmod(mode)
                self.refuses()
        path.chmod(0o644)
        v.verify(self.root)

    def test_npm_tree_created_under_0077_is_read_only_and_reports_actual_modes(self):
        original = v.verify(self.root)
        npm = self.release / 'node_modules'
        directories, files, links = [], [], []
        for parent, dirs, names in os.walk(npm, followlinks=False):
            directories.append(Path(parent))
            for name in dirs + names:
                path = Path(parent) / name
                info = path.lstat()
                if stat.S_ISREG(info.st_mode):
                    files.append((path, path.read_bytes(), stat.S_IMODE(info.st_mode)))
                elif stat.S_ISLNK(info.st_mode):
                    links.append((path, os.readlink(path)))
        shutil.rmtree(npm)
        previous_umask = os.umask(0o077)
        try:
            for path in sorted(directories, key=lambda p: len(p.parts)):
                path.mkdir(mode=0o755)
            for path, data, mode in files:
                with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), 'wb') as target:
                    target.write(data)
            for path, target in links:
                path.symlink_to(target)
        finally:
            os.umask(previous_umask)
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode) == 0o700 for p in directories))
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode) == mode & ~0o077 for p, _, mode in files))
        snapshot = self.snapshot()
        with self.read_only():
            result = v.verify(self.root)
        self.assertEqual(snapshot, self.snapshot())
        expected = [{**record, 'mode': record['mode'] & ~0o077}
                    if record['path'].startswith('node_modules/') else record
                    for record in original['verifiedFiles']]
        self.assertEqual(result['verifiedFiles'], expected)
        # macOS applies the creation umask to symlink permission metadata too;
        # Linux normally reports 0777. Neither is replaced with a canonical mode.
        expected_links = [{**record, 'mode': stat.S_IMODE((self.release / record['path']).lstat().st_mode)}
                          for record in original['verifiedLinks']]
        self.assertEqual(result['verifiedLinks'], expected_links)
        self.assertEqual(result['summary']['modePolicy'], 'preseal-canonical-or-umask-0077')
        # Restrictive permissions do not waive installed content verification.
        path = npm / 'tool/index.js'
        data = path.read_bytes()
        path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        self.refuses('file_digest_mismatch')

    def test_preseal_policy_accepts_only_two_exact_modes_per_kind(self):
        for canonical, allowed in ((0o755, {0o755, 0o700}), (0o644, {0o644, 0o600})):
            self.assertEqual({mode for mode in range(0o10000) if v.preseal_mode_matches(mode, canonical)}, allowed)
        self.assertFalse(v.preseal_mode_matches(0o777, 0o777))
        self.assertFalse(v.preseal_mode_matches(0o600, 0o666))

    def test_partial_mask_write_setid_and_sticky_modes_refuse(self):
        cases = [('node_modules', 0o755, (0o750, 0o710, 0o705, 0o770, 0o777, 0o1755, 0o2755, 0o4755)),
                 ('node_modules/tool/index.js', 0o644, (0o640, 0o604, 0o444, 0o400, 0o664, 0o666, 0o700, 0o1644, 0o2644, 0o4644)),
                 ('node_modules/tool/bin/cli.js', 0o755, (0o750, 0o740, 0o744, 0o711, 0o701, 0o500, 0o555, 0o775, 0o644, 0o600))]
        for relative, canonical, modes in cases:
            path = self.release / relative
            for mode in modes:
                with self.subTest(path=relative, mode=oct(mode)):
                    try:
                        path.chmod(mode)  # Synthetic TemporaryDirectory fixture only.
                        self.refuses()
                    finally:
                        path.chmod(canonical)

    def test_canonical_and_masked_modes_can_coexist_across_verified_scopes(self):
        modes = {'node': 0o700, 'node/bin/node': 0o700, 'node/bin/uv': 0o700,
                 'node/include/node/node.h': 0o600, 'browsers/camoufox': 0o700,
                 v.BROWSER + '/camoufox': 0o700, v.BROWSER + '/libxul.so': 0o600,
                 v.BROWSER + '/version.json': 0o600, v.FONT: 0o600}
        for relative, mode in modes.items():
            (self.release / relative).chmod(mode)
        snapshot = self.snapshot()
        with self.read_only():
            result = v.verify(self.root)
        self.assertEqual(snapshot, self.snapshot())
        for record in result['verifiedFiles']:
            if record['path'] in modes:
                self.assertEqual(record['mode'], modes[record['path']])

    def test_hardlinks_refused(self):
        os.link(self.release / 'node/bin/node', self.root / 'outside-alias')
        self.refuses('hardlinked_file')

    def test_special_file_never_opened(self):
        path = self.release / 'node_modules/tool/index.js'
        path.unlink()
        os.mkfifo(path)
        self.refuses('special_file')

    def test_cache_parent_symlink_not_followed(self):
        cache = self.cache_package('node_modules/tool')
        moved = self.root / 'moved-cache'
        cache.parent.rename(moved)
        cache.parent.symlink_to(moved)
        self.refuses('not_directory')

    def test_symlink_root_refused(self):
        root_alias = self.root / 'root-alias'
        root_alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(v.Refused, '^unsafe_root$'):
            v.verify(root_alias)

    def test_file_symlink_and_package_directory_symlink_refused(self):
        path = self.release / 'node_modules/tool/index.js'
        original = path.read_bytes()
        path.unlink()
        path.symlink_to('/' + SECRET)
        self.refuses('file_mode_or_type_mismatch')
        path.unlink()
        self.put(path, original)
        package = self.release / 'node_modules/alias'
        shutil.rmtree(package)
        package.symlink_to('/' + SECRET)
        self.refuses('package_not_directory')

    def test_bin_links_exactly_match_verified_metadata(self):
        link = self.release / 'node_modules/.bin/tool'
        for target in ('../alias/cli.js', '/' + SECRET, '../../../../private-data', '../tool/missing'):
            with self.subTest(target=target):
                link.unlink()
                link.symlink_to(target)
                self.refuses('link_target_mismatch')
        link.unlink()
        self.put(link, b'#!/bin/sh\n', 0o755)
        self.refuses('type_mismatch')

    def test_unexpected_and_missing_bin_links(self):
        extra = self.release / 'node_modules/.bin/extra'
        extra.symlink_to('../tool/bin/cli.js')
        self.refuses('unexpected_or_missing_path')
        extra.unlink()
        (self.release / 'node_modules/.bin/tool').unlink()
        self.refuses('unexpected_or_missing_path')

    def test_nested_bin_and_collision_between_verified_aliases(self):
        self.add_package('node_modules/tool/node_modules/deep', 'deep', bins='cli', files={'cli': b'#!/bin/sh\nexit 1\n'})
        self.add_package('node_modules/other', 'other', bins={'tool': 'cli'}, files={'cli': b'#!/bin/sh\nexit 2\n'})
        self.refresh()
        result = v.verify(self.root)
        self.assertIn('node_modules/tool/node_modules/.bin/deep', {r['path'] for r in result['verifiedLinks']})
        link = self.release / 'node_modules/.bin/tool'
        link.unlink()
        link.symlink_to('../other/cli')
        v.verify(self.root)

    def test_bin_shebang_bom_crlf_drift_is_not_blanket_ignored(self):
        path = self.release / 'node_modules/tool/bin/cli.js'
        original = path.read_bytes()
        for data in (b'\xef\xbb\xbf' + original, original.replace(b'\n', b'\r\n', 1),
                     original.replace(b'node', b'evil', 1)):
            with self.subTest(data=data[:20]):
                path.write_bytes(data)
                self.refuses()
        path.write_bytes(original)
        v.verify(self.root)

    def test_normalization_of_pinned_bom_crlf_requires_review(self):
        # The original tar contains CRLF/BOM; rejecting npm's plausible output is
        # intentional until the exact pinned npm source transform is reviewed.
        raw = b'\xef\xbb\xbf#!/usr/bin/env node\r\n// code\r\n'
        self.add_package('node_modules/windows-bin', 'windows-bin', bins='cli.js', files={'cli.js': raw})
        self.refresh()
        v.verify(self.root)
        (self.release / 'node_modules/windows-bin/cli.js').write_bytes(b'#!/usr/bin/env node\n// code\r\n')
        self.refuses('file_size_mismatch')

    def test_version_json_is_exact_derived_output(self):
        path = self.release / v.BROWSER / 'version.json'
        data = json.loads(path.read_bytes())
        data['extra'] = SECRET
        path.write_bytes(encoded(data))
        self.refuses()
        self.refresh()
        data = json.loads(path.read_bytes())
        data['build'] = 'beta.42'
        path.write_bytes(encoded(data))
        self.refuses('file_digest_mismatch')

    def test_generated_lock_validated_not_ignored(self):
        path = self.release / 'node_modules/.package-lock.json'
        original = encoded(self.hidden)
        for transform in (
            lambda d: d.update(extra=SECRET),
            lambda d: d.update(lockfileVersion=2),
            lambda d: d['packages'].pop('node_modules/tool'),
            lambda d: d['packages']['node_modules/tool'].update(version='9.9.9'),
            lambda d: d['packages']['node_modules/tool'].update(integrity='sha512-evil'),
            lambda d: d.update(requires=1),
            lambda d: d['packages'].update({'node_modules/unexpected': {'version': '1'}}),
        ):
            data = json.loads(original)
            transform(data)
            path.write_bytes(encoded(data))
            self.refuses('generated_lock_mismatch')
        path.write_bytes(json.dumps(self.hidden, indent=4).encode())
        v.verify(self.root)

    def test_generated_lock_duplicate_keys_refused(self):
        path = self.release / 'node_modules/.package-lock.json'
        path.write_bytes(b'{"name":"outpost","name":"' + SECRET.encode() + b'"}')
        self.refuses('duplicate_json_key')

    def test_installed_manifest_cannot_authorize_extra_bin(self):
        path = self.release / 'node_modules/tool/package.json'
        value = json.loads(path.read_bytes())
        value['bin']['unauthorized'] = 'index.js'
        path.write_bytes(encoded(value))
        self.refuses()

    def test_cached_and_installed_pins_are_not_trust_anchors(self):
        self.put(self.op / 'source' / v.PINS, b'{"nodeSha256":"forged"}')
        self.put(self.release / v.PINS, b'{"nodeSha256":"forged"}')
        v.verify(self.root)
        (self.release / 'node/bin/node').write_bytes(b'forged')
        self.refuses('file_size_mismatch')

    def replace_tool_tar(self, root: str, extras: list[tarfile.TarInfo] | None = None,
                         replacement_files: dict[str, bytes] | None = None,
                         executable: tuple[str, ...] = ()) -> dict[str, bytes]:
        path = 'node_modules/tool'
        if not hasattr(self, 'original_tool_contents'):
            self.original_tool_contents = {}
            with tarfile.open(fileobj=io.BytesIO(self.npm_blobs[path]), mode='r:gz') as archive:
                for member in archive:
                    if member.isfile():
                        source = archive.extractfile(member)
                        if source is None:
                            raise AssertionError('missing fixture content')
                        with source:
                            self.original_tool_contents[member.name.split('/', 1)[1]] = source.read()
        contents = dict(self.original_tool_contents if replacement_files is None else replacement_files)
        self.npm_blobs[path] = tar_blob(contents, top=root, extras=extras, executable=executable)
        self.lock['packages'][path]['integrity'] = integrity(self.npm_blobs[path])
        self.cache_package(path)
        self.refresh()
        return contents

    def test_npm_legacy_roots_strip_exactly_one_consistent_component(self):
        for prefix in ('node', 'pg', 'retry'):
            with self.subTest(prefix=prefix):
                root = tarfile.TarInfo(prefix)
                root.type, root.mode = tarfile.DIRTYPE, 0o755
                self.replace_tool_tar(prefix, extras=[root])
                result = v.verify(self.root)
                paths = {r['path'] for r in result['verifiedFiles']}
                self.assertIn('node_modules/tool/package.json', paths)
                self.assertNotIn('node_modules/tool/' + prefix + '/package.json', paths)

    def test_npm_identical_regular_dot_duplicates_have_one_verified_record(self):
        before = v.verify(self.root)
        contents = self.replace_tool_tar('legacy')
        contents['./index.js'] = contents['index.js']
        contents['./package.json'] = contents['package.json']
        self.replace_tool_tar('legacy', replacement_files=contents)
        snapshot = self.snapshot()
        with self.read_only():
            result = v.verify(self.root)
        self.assertEqual(snapshot, self.snapshot())
        for name in ('index.js', 'package.json'):
            path = 'node_modules/tool/' + name
            self.assertEqual([r for r in result['verifiedFiles'] if r['path'] == path],
                             [r for r in before['verifiedFiles'] if r['path'] == path])

    def test_npm_duplicate_hash_size_and_execution_mode_collisions_refuse(self):
        contents = self.replace_tool_tar('legacy')
        original = contents['index.js']
        for duplicate, executable in ((bytes([original[0] ^ 1]) + original[1:], ()),
                                      (original + b'extra', ()),
                                      (original, ('./index.js',))):
            with self.subTest(size=len(duplicate), executable=executable):
                contents['./index.js'] = duplicate
                self.replace_tool_tar('legacy', replacement_files=contents, executable=executable)
                message = self.refuses('duplicate_effective_path')
                self.assertEqual(message, 'duplicate_effective_path [component=npm package=node_modules/tool member=index.js]')

    def test_npm_duplicate_captured_metadata_is_compared_not_just_its_hash(self):
        contents = self.replace_tool_tar('legacy')
        original = contents['package.json']
        changed = original.replace(b'1.0.0', b'1.0.1')
        self.assertEqual(len(original), len(changed))
        contents['./package.json'] = changed
        self.replace_tool_tar('legacy', replacement_files=contents)
        content = v.content

        def identical_digest(*args, **kwargs):
            digest, data = content(*args, **kwargs)
            return (v.sha(original), data) if data == changed else (digest, data)

        with patch.object(v, 'content', side_effect=identical_digest):
            self.refuses('duplicate_effective_path')

    def test_npm_duplicate_type_directory_and_link_collisions_refuse(self):
        for kind in (tarfile.DIRTYPE, tarfile.SYMTYPE):
            with self.subTest(kind=kind):
                extra = tarfile.TarInfo('legacy/./index.js')
                extra.type, extra.mode = kind, 0o755
                extra.linkname = 'bin/cli.js' if kind == tarfile.SYMTYPE else ''
                self.replace_tool_tar('legacy', extras=[extra])
                self.refuses('duplicate_effective_path')
        for kind, targets in ((tarfile.DIRTYPE, ('', '')),
                              (tarfile.SYMTYPE, ('index.js', 'index.js')),
                              (tarfile.SYMTYPE, ('index.js', 'bin/cli.js'))):
            with self.subTest(kind=kind, targets=targets):
                extras = []
                for name, target in zip(('legacy/alias', 'legacy/./alias'), targets):
                    item = tarfile.TarInfo(name)
                    item.type, item.mode, item.linkname = kind, 0o755, target
                    extras.append(item)
                self.replace_tool_tar('legacy', extras=extras)
                self.refuses('duplicate_effective_path')

    def test_identical_node_duplicates_still_refuse(self):
        extra = tarfile.TarInfo(v.NODE_TOP + '/include/node/node.h')
        extra.size, extra.mode = 1, 0o644
        self.node_blob = tar_blob({'include/node/node.h': b'x'}, top=v.NODE_TOP, compression='xz', extras=[extra])
        self.refresh()
        self.refuses('duplicate_archive_member')

    def test_npm_identical_duplicate_headers_still_consume_member_budget(self):
        extras = []
        for _ in range(4):
            item = tarfile.TarInfo('package/value')
            item.size, item.mode = 1, 0o644
            extras.append(item)
        data = tar_blob({'value': b'x'}, extras=extras)
        with patch.object(v, 'MAX_MEMBERS', 3), self.assertRaises(v.Refused) as caught:
            reader = v.Reader(io.BytesIO(data), v.Budget())
            v.tar_entries(reader, reader.budget, 'gz', None, 'node_modules/fixture')
        self.assertEqual(caught.exception.code, 'member_limit')

    def test_npm_mixed_roots_absolute_traversal_and_specials_refuse(self):
        cases = [('different/index.js', tarfile.REGTYPE, 'archive_prefix'),
                 ('/' + SECRET, tarfile.REGTYPE, 'unsafe_path'),
                 ('legacy/../' + SECRET, tarfile.REGTYPE, 'unsafe_path'),
                 ('legacy//index.js', tarfile.REGTYPE, 'unsafe_path'),
                 ('./legacy/index.js', tarfile.REGTYPE, 'unsafe_path'),
                 ('legacy/special', tarfile.FIFOTYPE, 'unsupported_tar_member'),
                 ('legacy/hardlink', tarfile.LNKTYPE, 'unsupported_tar_member')]
        for name, kind, code in cases:
            with self.subTest(header=name):
                extra = tarfile.TarInfo(name)
                extra.type, extra.mode = kind, 0o644
                if kind == tarfile.LNKTYPE:
                    extra.linkname = 'legacy/index.js'
                self.replace_tool_tar('legacy', extras=[extra])
                message = self.refuses(code)
                self.assertIn('component=npm package=node_modules/tool', message)

    def test_npm_root_file_not_silently_discarded(self):
        extra = tarfile.TarInfo('legacy')
        extra.mode = 0o644
        self.replace_tool_tar('legacy', extras=[extra])
        self.refuses('archive_root_type')

    def test_npm_sri_failure_context_has_no_unverified_tar_header(self):
        self.cache_package('node_modules/tool').write_bytes(tar_blob({SECRET: SECRET.encode()}, top='legacy'))
        message = self.refuses('artifact_digest_mismatch')
        self.assertEqual(message, 'artifact_digest_mismatch [component=npm package=node_modules/tool]')

    def test_context_is_bounded_and_does_not_echo_host_or_unsafe_header(self):
        for header in ('/' + SECRET, '../' + SECRET, 'legacy/../' + SECRET,
                       'legacy/' + SECRET + '\\n', 'legacy/' + 'x' * 129):
            with self.subTest(header=header):
                error = v.Refused('unsafe_path', component='npm', package='node_modules/tool', member=header)
                self.assertNotIn(SECRET, str(error))
                self.assertEqual(error.member, '')
                self.assertLessEqual(len(str(error)), 512)
        error = v.Refused('unsafe_path', component=SECRET, package=str(self.root), member='safe.js')
        self.assertNotIn(SECRET, str(error))
        self.assertNotIn(str(self.root), str(error))
        error = v.Refused('unsafe_path', component='npm', package='node_modules/' + 'x' * 241)
        self.assertEqual(error.package, '')
        with self.assertRaises(v.Refused) as caught, v.refusal_context('node'):
            raise OSError(SECRET)
        self.assertEqual(str(caught.exception), 'unreadable_or_invalid_input [component=node]')
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_node_tar_requires_exact_prefix(self):
        self.node_blob = tar_blob(self.node_files, top='node-v99-linux-x64', compression='xz')
        self.refresh()
        self.refuses('archive_prefix')

    def test_tar_traversal_special_and_duplicate_members(self):
        for name, kind, mode in ((v.NODE_TOP + '/../escape', tarfile.REGTYPE, 0o644),
                                 ('/' + SECRET, tarfile.REGTYPE, 0o644),
                                 (v.NODE_TOP + '/pipe', tarfile.FIFOTYPE, 0o644),
                                 (v.NODE_TOP + '/hard', tarfile.LNKTYPE, 0o644),
                                 (v.NODE_TOP + '/setid', tarfile.REGTYPE, 0o4755),
                                 (v.NODE_TOP + '/bin/node', tarfile.REGTYPE, 0o644)):
            with self.subTest(name=name):
                extra = tarfile.TarInfo(name)
                extra.type, extra.mode = kind, mode
                if kind == tarfile.LNKTYPE:
                    extra.linkname = v.NODE_TOP + '/bin/node'
                self.node_blob = tar_blob(self.node_files, top=v.NODE_TOP, compression='xz', extras=[extra])
                self.refresh()
                self.refuses()

    def test_authenticated_node_symlink_escape_dangling_and_cycle(self):
        for target in ('/' + SECRET, '../../private-data', '../missing', 'npm'):
            with self.subTest(target=target):
                self.node_blob = tar_blob(self.node_files, top=v.NODE_TOP, compression='xz',
                                          links={'bin/npm': target},
                                          executable=('bin/node', 'lib/node_modules/npm/bin/npm-cli.js'))
                link = self.release / 'node/bin/npm'
                link.unlink()
                link.symlink_to(target)
                self.refresh()
                self.refuses()

    def test_zip_traversal_special_symlink_and_duplicate(self):
        for name, kind in (('../' + SECRET, stat.S_IFREG), ('/absolute', stat.S_IFREG),
                           ('dir/../file', stat.S_IFREG), ('back\\slash', stat.S_IFREG),
                           ('link', stat.S_IFLNK), ('fifo', stat.S_IFIFO), ('camoufox', stat.S_IFREG)):
            with self.subTest(name=name):
                extra = zipfile.ZipInfo(name)
                extra.create_system = 3
                extra.external_attr = (kind | 0o644) << 16
                # Duplicate-name warning is expected for the final hostile case.
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    self.browser_blob = zip_blob(self.browser_files, extras=[(extra, b'bad')])
                self.refresh()
                self.refuses()

    def test_browser_rejects_unexpected_symlink_even_with_safe_target(self):
        (self.release / v.BROWSER / 'extra-link').symlink_to('camoufox')
        self.refuses('unexpected_or_missing_path')

    def test_uv_member_is_exact_not_suffix_match(self):
        self.uv_blob = zip_blob({'other.data/scripts/uv': self.uv})
        self.refresh()
        self.refuses('missing_uv_member')

    def test_bundled_dependency_uses_authenticated_parent_tar(self):
        owner = 'node_modules/bundler'
        child = owner + '/node_modules/bundled'
        metadata = {'name': 'bundler', 'version': '1.0.0', 'bundleDependencies': ['bundled']}
        child_metadata = {'name': 'bundled', 'version': '2.0.0', 'bin': {'bundled': 'cli.js'}}
        contents = {'package.json': encoded(metadata), 'index.js': b'parent',
                    'node_modules/bundled/package.json': encoded(child_metadata),
                    'node_modules/bundled/cli.js': b'#!/usr/bin/env node\n// bundled\n'}
        self.npm_blobs[owner] = tar_blob(contents)
        self.lock['packages'][owner] = {'version': '1.0.0', 'integrity': integrity(self.npm_blobs[owner])}
        self.lock['packages'][child] = {'version': '2.0.0', 'inBundle': True, 'bin': {'bundled': 'cli.js'}}
        self.present.update((owner, child))
        self.cache_package(owner)
        for name, data in contents.items():
            self.put(self.release / owner / name, data, 0o755 if name.endswith('cli.js') else 0o644)
        link = self.release / owner / 'node_modules/.bin/bundled'
        link.parent.mkdir()
        link.symlink_to('../bundled/cli.js')
        self.refresh()
        result = v.verify(self.root)
        self.assertEqual(result['summary']['npm']['packages'], 5)
        (self.release / child / 'cli.js').write_bytes(b'bad')
        self.refuses('file_size_mismatch')

    def test_unproven_bundle_and_unlocked_bundled_code_refused(self):
        self.lock['packages']['node_modules/tool']['inBundle'] = True
        self.refresh()
        self.refuses('unproven_bundle')
        self.lock['packages']['node_modules/tool'].pop('inBundle')
        metadata = {'name': 'tool', 'version': '1.0.0', 'bin': {'tool': 'bin/cli.js'}}
        self.npm_blobs['node_modules/tool'] = tar_blob({'package.json': encoded(metadata),
                                                       'node_modules/unlocked/index.js': b'extra'})
        self.lock['packages']['node_modules/tool']['integrity'] = integrity(self.npm_blobs['node_modules/tool'])
        self.cache_package('node_modules/tool')
        self.refresh()
        self.refuses('unlocked_bundled_content')

    def test_strong_sri_algorithms_and_malformed_forms(self):
        for algorithm in ('sha256', 'sha384'):
            self.add_package('node_modules/' + algorithm, algorithm, cache_algorithm=algorithm)
        self.refresh()
        v.verify(self.root)
        for value in ('sha1-AAAA', 'md5-nope', 'sha512-bad!', 'sha512-YQ==',
                      integrity(b'a') + ' ' + integrity(b'b'), SECRET):
            with self.subTest(value=value):
                self.lock['packages']['node_modules/tool']['integrity'] = value
                self.refresh()
                self.refuses('unsupported_sri')

    def test_path_count_byte_and_time_bounds(self):
        for name, value, code in (('MAX_RECORDS', 3, 'record_limit'), ('MAX_BYTES', 10, 'byte_limit'),
                                  ('MAX_SECONDS', -1, 'time_limit'), ('MAX_MEMBERS', 1, 'member_limit'),
                                  ('MAX_METADATA', 10, 'metadata_limit')):
            with self.subTest(limit=name), patch.object(v, name, value):
                self.refuses(code)

    def test_member_streams_are_read_in_bounded_chunks(self):
        self.browser_files['large-data'] = b'x' * (v.CHUNK * 3 + 5)
        self.browser_blob = zip_blob(self.browser_files, executable=('camoufox',))
        self.put(self.release / v.BROWSER / 'large-data', self.browser_files['large-data'])
        self.refresh()
        original = zipfile.ZipExtFile.read
        calls = []

        def guarded(stream, size=-1):
            calls.append(size)
            self.assertGreaterEqual(size, 0)
            self.assertLessEqual(size, v.CHUNK)
            return original(stream, size)

        with patch.object(zipfile.ZipExtFile, 'read', guarded):
            v.verify(self.root)
        self.assertGreaterEqual(calls.count(v.CHUNK), 3)

    def test_mutation_during_file_read_refused(self):
        original = v.content
        node = self.release / 'node/bin/node'
        wanted = v.sha(node.read_bytes())

        def racing(*args, **kwargs):
            result = original(*args, **kwargs)
            if isinstance(args[0], v.Reader) and result[0] == wanted:
                node.write_bytes(b'X' * len(self.node_files['bin/node']))
            return result

        with patch.object(v, 'content', side_effect=racing):
            self.refuses('changed_during_read')

    def test_late_mutation_and_optional_arrival_refused(self):
        finish = v.Files.finish
        for mutate in (lambda: (self.release / 'node/bin/node').write_bytes(b'late'),
                       lambda: (self.release / 'node_modules/@other/os-only').mkdir(parents=True)):
            def racing(files, action=mutate):
                action()
                finish(files)
            with patch.object(v.Files, 'finish', racing):
                self.refuses('changed_during_read')
            self.put(self.release / 'node/bin/node', self.node_files['bin/node'], 0o755)

    def test_npm_authenticated_symlink_and_shared_sri_blob(self):
        owner = 'node_modules/linker'
        metadata = {'name': 'linker', 'version': '1.0.0'}
        blob = tar_blob({'package.json': encoded(metadata), 'index.js': b'proven target'},
                        links={'alias.js': 'index.js'})
        for path in (owner, 'node_modules/tool/node_modules/linker'):
            self.lock['packages'][path] = {'version': '1.0.0', 'integrity': integrity(blob)}
            self.npm_blobs[path] = blob
            self.present.add(path)
            self.cache_package(path)
            self.put(self.release / path / 'package.json', encoded(metadata))
            self.put(self.release / path / 'index.js', b'proven target')
            (self.release / path / 'alias.js').symlink_to('index.js')
        self.refresh()
        result = v.verify(self.root)
        self.assertIn(owner + '/alias.js', {r['path'] for r in result['verifiedLinks']})
        link = self.release / owner / 'alias.js'
        link.unlink()
        link.symlink_to('../../tool/index.js')
        self.refuses('link_target_mismatch')

    def test_tar_pax_header_bound_checked_before_payload_read(self):
        item = tarfile.TarInfo('pax')
        item.type, item.size = tarfile.XHDTYPE, v.MAX_METADATA + 1
        raw = item.tobuf()
        import gzip
        data = gzip.compress(raw)
        reader = v.Reader(io.BytesIO(data), v.Budget())
        with self.assertRaisesRegex(v.Refused, '^tar_member_limit$'):
            v.tar_entries(reader, reader.budget, 'gz', 'package', 'node_modules/pkg')

    def test_noncanonical_tar_separator_and_zip_null_are_refused(self):
        extra = tarfile.TarInfo(v.NODE_TOP + '//extra')
        self.node_blob = tar_blob(self.node_files, top=v.NODE_TOP, compression='xz', extras=[extra])
        self.refresh()
        self.refuses('unsafe_path')
        self.node_blob = tar_blob(self.node_files, top=v.NODE_TOP, compression='xz', links=self.node_links,
                                  executable=('bin/node', 'lib/node_modules/npm/bin/npm-cli.js'))
        # Replace the equally-sized local AND central names; ZipInfo normally
        # truncates at NUL, so validate orig_filename before accepting its name.
        self.browser_blob = zip_blob({'innocentXsuffix': b'bad'}).replace(b'innocentXsuffix', b'innocent\x00suffix')
        self.refresh()
        self.refuses('unsafe_zip_member')

    def test_zip_central_directory_count_and_size_are_bounded(self):
        import struct
        data = bytearray(self.browser_blob)
        offset = len(data) - 22
        struct.pack_into('<HH', data, offset + 8, 65535, 65535)
        self.browser_blob = bytes(data)
        self.refresh()
        self.refuses('unsupported_zip_directory')
        self.browser_blob = zip_blob(self.browser_files, executable=('camoufox',))
        self.refresh()
        with patch.object(v, 'MAX_ZIP_DIRECTORY', 16):
            self.refuses('read_limit')

    def test_link_resolution_cannot_normalize_away_symlink_or_escape(self):
        tree = {p: v.Entry('directory') for p in ('node', 'node/bin', 'node/lib')}
        tree['node/lib/redirect'] = v.Entry('link', targets=('../bin',))
        tree['node/lib/proven'] = v.Entry('file')
        with self.assertRaisesRegex(v.Refused, '^link_through_link$'):
            v.link_destination('node/bin/tool', '../lib/redirect/../proven', tree)
        with self.assertRaisesRegex(v.Refused, '^escaping_or_dangling_link$'):
            v.link_destination('node/bin/tool', '../../node/lib/proven', tree)

    def test_private_errors_do_not_leak_through_exception_chaining(self):
        with patch.object(v, 'authenticated_inputs', side_effect=ValueError(SECRET)), \
                self.assertRaises(v.Refused) as caught:
            v.verify(self.root)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertIsNone(caught.exception.__cause__)
        self.assertEqual(str(caught.exception), 'unreadable_or_invalid_input')

    def test_unexpected_errors_do_not_disclose_paths_or_contents(self):
        with patch.object(v, 'authenticated_inputs', side_effect=OSError(str(self.root) + '/' + SECRET)):
            self.refuses('unreadable_or_invalid_input')


REFERENCE_DIR = Path(__file__).resolve().parents[1] / '.outpost/recovery-645f62a9/node-archive-references'
DUPLICATE_REFERENCES = {
    'node_modules/gaxios/node_modules/agent-base': '7.1.4',
    'node_modules/gaxios/node_modules/https-proxy-agent': '7.0.6',
}


def immutable_documents() -> tuple[dict, dict]:
    """Reauthenticate the original fixture; never trust downloaded JSON reports."""
    data = (Path(__file__).with_name('fixtures') / 'outpost2-original-release.tar.gz').read_bytes()
    if len(data) != ORIGINAL_SIZE or hashlib.sha256(data).hexdigest() != ORIGINAL_SHA256:
        raise AssertionError('immutable fixture mismatch')
    documents = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            if member.isfile() and name in (v.PINS, 'package-lock.json'):
                source = archive.extractfile(member)
                if source is None:
                    raise AssertionError('missing immutable fixture content')
                with source:
                    documents[name] = source.read()
    return json.loads(documents[v.PINS]), json.loads(documents['package-lock.json'])


def reference_tree(stream, compression: str, destination: str) -> tuple[dict, set, dict]:
    """Independent, data-only strip-one reference; report collisions, never extract.

    This deliberately does not call the verifier's path/parser/manifest helpers.
    Files are streamed, and the resulting content/type ledger is compared to the
    production parser. Literal dot aliases are normalized just as pinned npm's
    path.resolve does, making duplicate effective paths visible independently.
    """
    tree, roots, headers = {}, set(), {}

    def put(path, value):
        if path in tree and tree[path] != value:
            raise AssertionError('conflicting authenticated reference entries')
        tree[path] = value
        parent = posixpath.dirname(path)
        while parent:
            tree.setdefault(parent, ('directory', '', 0, 0o755, ()))
            parent = posixpath.dirname(parent)

    with tarfile.open(fileobj=stream, mode='r|xz' if compression == 'xz' else 'r|gz') as archive:
        for member in archive:
            raw = member.name.rstrip('/') if member.isdir() else member.name
            parts = raw.split('/')
            if raw.startswith('/') or '..' in parts or '\\' in raw:
                raise AssertionError('unsafe reference header')
            roots.add(parts[0])
            relative = posixpath.normpath('/'.join(parts[1:]))
            if relative == '.':
                if not member.isdir():
                    raise AssertionError('non-directory archive root')
                continue
            headers.setdefault(relative, []).append(raw)
            if len(headers[relative]) > 1 and not member.isfile():
                raise AssertionError('non-regular duplicate reference entry')
            path = destination + '/' + relative
            if member.isfile():
                digest = hashlib.sha256()
                source = archive.extractfile(member)
                if source is None:
                    raise AssertionError('missing authenticated reference content')
                with source:
                    while block := source.read(1024 * 1024):
                        digest.update(block)
                put(path, ('file', digest.hexdigest(), member.size, 0o755 if member.mode & 0o111 else 0o644, ()))
            elif member.isdir():
                put(path, ('directory', '', 0, 0o755, ()))
            elif member.issym():
                put(path, ('link', '', 0, 0o777, (member.linkname,)))
            else:
                raise AssertionError('unsupported reference member')
    return tree, roots, {path: names for path, names in headers.items() if len(names) != 1}


def tree_values(tree: dict) -> dict:
    return {path: (entry.kind, entry.digest, entry.size, entry.mode, entry.targets)
            for path, entry in tree.items()}


class RealArchiveReferenceTests(unittest.TestCase):
    """Offline optional reference suite; present-but-incomplete references FAIL."""

    @classmethod
    def setUpClass(cls):
        if not REFERENCE_DIR.is_dir():
            raise unittest.SkipTest('data-only Node/npm reference directory is unavailable')
        cls.pins, cls.lock = immutable_documents()
        cls.workspace = Path(__file__).resolve().parents[1]
        cls.refs = REFERENCE_DIR.relative_to(cls.workspace).as_posix()

    def test_authenticated_node_tree_and_pinned_npm_strip_one_source(self):
        captures = {'lib/node_modules/npm/package.json',
                    'lib/node_modules/npm/node_modules/pacote/lib/fetcher.js',
                    'lib/node_modules/npm/node_modules/tar/dist/commonjs/unpack.js'}
        with v.Files(self.workspace, v.Budget()) as files, \
                v.artifact(files, self.refs + '/node.tar.xz', self.pins['nodeSha256']) as stream:
            expected, roots, duplicates = reference_tree(stream, 'xz', 'node')
            self.assertEqual(roots, {v.NODE_TOP})
            self.assertFalse(duplicates)
            stream.seek(0)
            actual = v.tar_entries(stream, files.budget, 'xz', v.NODE_TOP, 'node', captures)
        self.assertEqual(tree_values(actual), expected)
        self.assertEqual(len(actual), 5888)
        self.assertEqual(sum(e.kind == 'file' for e in actual.values()), 4797)
        self.assertEqual(sum(e.kind == 'link' for e in actual.values()), 3)
        npm = actual['node/lib/node_modules/npm/package.json'].data
        self.assertEqual(json.loads(npm)['version'], '11.19.1')
        fetcher = actual['node/lib/node_modules/npm/node_modules/pacote/lib/fetcher.js'].data
        self.assertEqual(hashlib.sha256(fetcher).hexdigest(),
                         '97dbf9a402ad3329c517aa35928da4c115a2e3a77b51f513729a8e253ee1144a')
        self.assertIn(b'strip: 1,', fetcher)
        unpack = actual['node/lib/node_modules/npm/node_modules/tar/dist/commonjs/unpack.js'].data
        self.assertEqual(hashlib.sha256(unpack).hexdigest(),
                         '03515ed98f5df6ec0f23177b7016274f8cdc91b038d0dcd036f438a70e614eed')
        self.assertIn(b'parts.splice(0, this.strip)', unpack)

    def test_all_175_authenticated_package_tree_references(self):
        packages = {p: e for p, e in self.lock['packages'].items() if p}
        self.assertEqual(len(packages), 175)
        accepted, duplicate_references, unique_sri, prefixes = 0, set(), set(), {}
        for path, entry in packages.items():
            with self.subTest(package=path, version=entry['version']), v.Files(self.workspace, v.Budget()) as files:
                algorithm, digest, _ = v.sri(entry['integrity'])
                unique_sri.add(entry['integrity'])
                with v.artifact(files, self.refs + '/npm-' + algorithm + '-' + digest + '.tgz', digest, algorithm) as stream:
                    expected, roots, duplicates = reference_tree(stream, 'gz', path)
                    self.assertEqual(len(roots), 1)
                    prefixes[path] = next(iter(roots))
                    stream.seek(0)
                    if path in DUPLICATE_REFERENCES:
                        self.assertEqual(entry['version'], DUPLICATE_REFERENCES[path])
                        self.assertEqual(duplicates, {'dist/index.js': ['package/./dist/index.js', 'package/dist/index.js']})
                        duplicate_references.add(path)
                    else:
                        self.assertFalse(duplicates)
                    actual = v.tar_entries(stream, files.budget, 'gz', None, path, package_json=True)
                self.assertEqual(tree_values(actual), expected)
                metadata = json.loads(actual[path + '/package.json'].data)
                self.assertEqual(metadata['version'], entry['version'])
                self.assertEqual(metadata['name'], entry.get('name', v.package_location(path)[1]))
                declared = v.bins(metadata.get('bin'), metadata['name'])
                self.assertEqual(declared, v.bins(entry.get('bin'), metadata['name']))
                for target in declared.values():
                    self.assertEqual(actual[path + '/' + target].kind, 'file')
                accepted += 1
        self.assertEqual(accepted, 175)
        self.assertEqual(duplicate_references, set(DUPLICATE_REFERENCES))
        self.assertEqual(len(unique_sri), 174)
        self.assertEqual({p: root for p, root in prefixes.items() if root != 'package'}, {
            'node_modules/@types/node': 'node', 'node_modules/@types/pg': 'pg',
            'node_modules/@types/retry': 'retry'})


class ImmutableArchiveTests(unittest.TestCase):
    def test_real_immutable_archive_and_lock_shapes(self):
        fixture = Path(__file__).with_name('fixtures') / 'outpost2-original-release.tar.gz'
        data = fixture.read_bytes()
        self.assertEqual(len(data), ORIGINAL_SIZE)
        self.assertEqual(hashlib.sha256(data).hexdigest(), ORIGINAL_SHA256)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / v.OP / 'release.tar.gz'
            path.parent.mkdir(parents=True)
            path.write_bytes(data)
            with v.Files(root, v.Budget()) as files:
                pins, lock = v.authenticated_inputs(files)
                files.finish()
        packages = lock['packages']
        self.assertEqual(len(packages) - 1, 175)
        self.assertEqual(pins['nodeVersion'], '24.22.1')
        self.assertEqual(pins['uvVersion'], '0.10.9')
        self.assertEqual(sum(p.get('optional') is True for p in packages.values()), 28)
        self.assertEqual(packages['node_modules/playwright-camoufox']['name'], 'playwright-core')
        self.assertIn('node_modules/gaxios/node_modules/agent-base', packages)
        for path, entry in packages.items():
            if path:
                v.package_location(path)
                v.sri(entry['integrity'])
                v.bins(entry.get('bin'), entry.get('name', v.package_location(path)[1]))

    def test_original_job_umask_and_later_configuration_seal_are_authenticated(self):
        data = (Path(__file__).with_name('fixtures') / 'outpost2-original-release.tar.gz').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), ORIGINAL_SHA256)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            member = next(m for m in archive if m.name.removeprefix('./') == 'deploy/environment/host_install.py')
            source = archive.extractfile(member)
            self.assertIsNotNone(source)
            assert source is not None
            with source:
                installer = source.read().decode()
        self.assertIn("'--property=UMask=0077'", installer)
        configuration = installer[installer.index('    def configuration(self)'):]
        self.assertIn("self.run(['/bin/chmod', '-R', 'a+rX,go-w', str(self.release)])", configuration)
        self.assertLess(installer.index('    def dependencies(self)'), installer.index('    def configuration(self)'))

    def test_module_has_no_execution_network_or_cli_entrypoint(self):
        source = Path(__file__).with_name('verify_outpost2_node.py').read_text()
        tree = ast.parse(source)
        imports = {node.names[0].name.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.Import)}
        self.assertFalse(imports & {'subprocess', 'socket', 'requests', 'urllib', 'argparse'})
        calls = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertFalse(calls & {'eval', 'exec', 'compile', '__import__', 'print'})
        self.assertNotIn('__main__', source)
        self.assertEqual(v.verify.__defaults__, (Path('/'),))


if __name__ == '__main__':
    unittest.main()
