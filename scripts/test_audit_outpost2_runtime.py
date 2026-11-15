"""Hermetic, non-root tests: python3 -I -B scripts/test_audit_outpost2_runtime.py -v.

All host files are synthesized under TemporaryDirectory; no existing fixtures,
production data, installed package code, sudo, browser, network or subprocesses.
"""
from __future__ import annotations

import ast
import base64

import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from contextlib import ExitStack, contextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('audit-outpost2-runtime.py')
SPEC = importlib.util.spec_from_file_location('audit_outpost2_runtime', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)
SECRET = 'DO_NOT_EMIT_PRIVATE_CANARY'
ORIGINAL_PINS = (a.ARCHIVE_SHA256, a.ARCHIVE_SIZE, a.INSTALLER_SHA256, a.LAUNCHER_SHA256, a.FONT_SHA256)


def bundle(contents: dict, extra=None) -> bytes:
    """Construct tar bytes, never extract and never execute their fake code."""
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data in contents.items():
            info = tarfile.TarInfo('./' + name)
            info.size, info.mode = len(data), 0o644
            archive.addfile(info, io.BytesIO(data))
        if extra is not None:
            archive.addfile(extra)
    return output.getvalue()


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.op, self.release = self.root / a.OP, self.root / a.RELEASE
        self.home = self.root / a.HOME
        self.installer = b'raise AssertionError("DO NOT EXECUTE INSTALLER")\n'
        self.launcher = b'raise AssertionError("DO NOT EXECUTE LAUNCHER")\n'
        self.font = b'<fontconfig>fixture only</fontconfig>'
        self.blob = b'authenticated npm fixture'
        sri = 'sha512-' + base64.b64encode(hashlib.sha512(self.blob).digest()).decode()
        absent = 'sha256-' + base64.b64encode(hashlib.sha256(b'missing').digest()).decode()
        pins = {k: a.sha(v) for k, v in (('nodeSha256', b'node'), ('uvSha256', b'uv'), ('camoufoxSha256', b'camoufox'))}
        pins['pythonVersion'] = '3.13.12'
        lock = dict(lockfileVersion=3, packages={'': {}, 'node_modules/fixture': {'integrity': sri},
                    'node_modules/duplicate': {'integrity': sri}, 'node_modules/missing': {'integrity': absent},
                    'node_modules/unsupported': {'integrity': 'md5-nope'}})
        uv = ('version = 1\n[[package]]\nname = "demo-pkg"\nversion = "1.0"\nwheels = [\n'
              '{url = "https://user:' + SECRET + '@invalid/demo_pkg-1.0-py2.py3-none-any.whl", '
              'hash = "sha256:' + a.sha(b'wheel') + '", size = 5},\n'
              '{url = "https://invalid/demo_pkg-1.0-cp311-cp311-win_amd64.whl", '
              'hash = "sha256:' + a.sha(b'other') + '", size = 5}]\n').encode()
        self.contents = {a.INSTALLER: self.installer, a.LAUNCHER: b'original launcher',
                         a.PINS: json.dumps(pins).encode(), 'package-lock.json': json.dumps(lock).encode(),
                         'server/browser-engine/uv.lock': uv, 'package.json': b'{"name":"fixture"}'}
        self.archive = bundle(self.contents)
        for key, value in (('ARCHIVE_SHA256', a.sha(self.archive)), ('ARCHIVE_SIZE', len(self.archive)),
                           ('INSTALLER_SHA256', a.sha(self.installer)), ('LAUNCHER_SHA256', a.sha(self.launcher)),
                           ('FONT_SHA256', a.sha(self.font))):
            self.stack.enter_context(patch.object(a, key, value))
        self.put(self.op / 'release.tar.gz', self.archive)
        self.request = dict(a.IDS, sha256=a.ARCHIVE_SHA256, size=a.ARCHIVE_SIZE, browser=True,
                            coexistence=True, fullControl=True, publicKey=SECRET, label=SECRET)
        self.status = dict(a.IDS, state='failed', completedSteps=4, totalSteps=12, stage='Browser runtime',
                           log=[SECRET], error=SECRET)
        self.save_state()
        self.put(self.op / 'cancel', b'')
        for name, data in self.contents.items():
            self.put(self.op / 'source' / name, data)
            self.put(self.release / name, self.launcher if name == a.LAUNCHER else data)
        self.put(self.release / a.FONT, self.font)
        for name in a.TREES:
            (self.release / name).mkdir(parents=True, exist_ok=True)
        for name, data in (('node.tar.xz', b'node'), ('uv.whl', b'uv'), ('camoufox.zip', b'camoufox')):
            self.put(self.op / name, data)
        self.npm_path = self.cache_blob('sha512', self.blob)
        self.put(self.npm_path, self.blob)
        self.put(self.home / 'cache/downloads/demo_pkg-1.0-py2.py3-none-any.whl', b'wheel')
        (self.home / 'cache/wheels-v5/demo.whl').mkdir(parents=True)
        self.put(self.home / 'cache/archive-v0/demo/pkg.py', b'raise AssertionError("NO IMPORT")')
        self.package = self.release / a.VENV / 'lib/python3.13/site-packages/demo/pkg.py'
        self.package.parent.mkdir(parents=True)
        os.link(self.home / 'cache/archive-v0/demo/pkg.py', self.package)
        self.put(self.release / 'node/bin/node', b'not executable code')
        os.link(self.release / 'node/bin/node', self.release / 'node/bin/node-alias')
        self.put(self.release / 'python/bin/python3', b'not executable code')
        os.link(self.release / 'python/bin/python3', self.root / 'private-alias')
        self.put(self.release / 'python/cpython-3.13/uv-receipt.json',
                 json.dumps({'url': 'https://user:' + SECRET + '@invalid', 'metadata': {'token': SECRET}}).encode())
        self.put(self.release / 'python/cpython-3.13/PYTHON.json', b'{"build":123}')
        self.dist = self.release / a.VENV / 'lib/python3.13/site-packages/demo_pkg-1.0.dist-info'
        self.put(self.dist / 'METADATA', ('Name: demo-pkg\nVersion: 1.0\nSummary: ' + SECRET + '\n\n' + SECRET).encode())
        self.put(self.dist / 'WHEEL', ('Wheel-Version: 1.0\nTag: py3-none-any\nGenerator: ' + SECRET + '\n').encode())
        self.put(self.dist / 'direct_url.json', ('{"token":"' + SECRET + '"}').encode())
        self.put(self.release / a.VENV / 'lib/python3.13/site-packages/evil.pth', b'import evil')
        (self.release / a.VENV / 'bin').mkdir()
        (self.release / a.VENV / 'bin/python').symlink_to('/' + a.RELEASE + '/python/bin/python3')
        self.put(self.root / 'private-data/secret', SECRET.encode())
        (self.release / 'node/escape').symlink_to(self.root / 'private-data', target_is_directory=True)
        (self.home / 'cache/escape').symlink_to(self.root / 'private-data', target_is_directory=True)
        # Private log files are deliberately unreadable as ordinary file content.
        os.mkfifo(self.op / 'command.log')
        os.mkfifo(self.op / 'launch.log')

    def put(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def save_state(self):
        self.put(self.op / 'request.json', json.dumps(self.request).encode())
        self.put(self.op / 'status.json', json.dumps(self.status).encode())

    def cache_blob(self, algorithm, data):
        digest = hashlib.new(algorithm, data).hexdigest()
        return self.root / a.CACHES[0] / algorithm / digest[:2] / digest[2:4] / digest[4:]

    def run_audit(self, **kwargs):
        return a.audit(root=str(self.root), getuid=lambda: 0, check=lambda info: True, **kwargs)

    def files(self, budget=None):
        return a.Files(budget or a.Budget(), str(self.root), lambda info: True)

    def snapshot(self):
        result = {}
        for parent, dirs, names in os.walk(self.root, followlinks=False):
            for name in dirs + names:
                path = Path(parent) / name
                info = path.lstat()
                value = path.read_bytes() if stat.S_ISREG(info.st_mode) else os.readlink(path) if stat.S_ISLNK(info.st_mode) else None
                result[str(path.relative_to(self.root))] = (a.stamp(info), value)
        return result

    @contextmanager
    def read_only(self):
        """Fail at the syscall boundary if the audit tries to modify or execute."""
        original = os.open
        opened = []

        def guarded(path, flags, *args, **kwargs):
            self.assertEqual(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND), 0)
            self.assertTrue(flags & os.O_NOFOLLOW)
            if hasattr(os, 'O_NOATIME'):
                self.assertTrue(flags & os.O_NOATIME)
            opened.append(str(path))
            return original(path, flags, *args, **kwargs)

        with ExitStack() as stack:
            stack.enter_context(patch.object(os, 'open', side_effect=guarded))
            for name in ('system', 'popen', 'execv', 'execve', 'spawnv', 'fork', 'mkdir', 'unlink', 'rename',
                         'replace', 'chmod', 'chown', 'link', 'symlink', 'truncate', 'utime', 'write', 'readlink'):
                stack.enter_context(patch.object(os, name, side_effect=AssertionError('forbidden operation')))
            stack.enter_context(patch('builtins.open', side_effect=AssertionError('unexpected high-level file read')))
            stack.enter_context(patch('io.open', side_effect=AssertionError('unexpected high-level file read')))
            yield opened

    def test_inventory_is_read_only_secret_free_and_does_not_execute_code(self):
        before = self.snapshot()
        with self.read_only() as opened:
            result = self.run_audit()
        self.assertEqual(result['result'], 'inventory_complete', result)
        self.assertEqual(before, self.snapshot())
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertTrue(all(name not in opened for name in ('command.log', 'launch.log', 'direct_url.json', 'evil.pth', 'secret')))
        self.assertEqual(result['notice'], a.NOTICE)
        self.assertEqual(result['state']['completedSteps'], 4)
        self.assertEqual(result['authentication']['verifiedSourceFiles']['release'], len(self.contents))
        self.assertTrue(all(v['status'] == 'verified' for v in result['retainedArtifacts'].values()))
        receipts = result['runtime']['managedPythonMetadata']
        self.assertEqual({r['file'] for r in receipts}, {'cpython-3.13/PYTHON.json', 'cpython-3.13/uv-receipt.json'})
        self.assertEqual(next(r['keys'] for r in receipts if r['file'].endswith('uv-receipt.json')), ['metadata', 'url'])

    def test_hardlinks_are_aggregated_and_classified_only_in_scoped_caches(self):
        result = self.run_audit()['hardlinks']
        self.assertEqual(result['inodes'], 3)
        self.assertEqual(result['knownCacheInodes'], 1)
        self.assertEqual(result['releaseOnlyInodes'], 1)
        self.assertEqual(result['unaccountedInodes'], 1)
        self.assertEqual(result['releaseAliases'], 4)
        self.assertEqual(result['knownCacheAliases'], 1)
        self.assertEqual(result['unaccountedLinks'], 1)
        self.assertLessEqual(len(result['examples']), 5)

    def test_npm_sri_and_uv_cache_counts(self):
        result = self.run_audit()
        npm = result['npmIntegrity']
        self.assertEqual((npm['verifiedHash'], npm['missing'], npm['unsupported'], npm['mismatch']), (1, 1, 1, 0))
        self.assertEqual(npm['packageReferences'], 4)
        self.assertEqual(npm['uniqueSupportedBlobs'], 2)
        self.assertLessEqual(len(npm['examples']), 5)
        cache = result['caches']['uvCache']
        self.assertEqual((cache['regularWheels'], cache['wheelNamedDirectories']), (1, 1))
        self.assertEqual(cache['directories'], ['archive-v0', 'downloads', 'wheels-v5'])
        self.assertEqual(cache['topLevel']['directories'], 3)
        self.assertEqual(cache['counts']['symlinks'], 1)
        self.assertLessEqual(len(cache['wheelExamples']), 5)
        self.npm_path.write_bytes(b'tampered')
        self.assertEqual(self.run_audit()['npmIntegrity']['mismatch'], 1)

    def test_distribution_metadata_matches_compressed_lock_wheel_tags(self):
        row = self.run_audit()['distributions'][0]
        self.assertEqual((row['name'], row['version'], row['wheelTags']), ('demo-pkg', '1.0', ['py3-none-any']))
        self.assertTrue(row['authenticatedLockMatch'])
        self.assertEqual(row['candidateCount'], 1)
        self.assertEqual(row['candidateWheels'][0], dict(file='demo_pkg-1.0-py2.py3-none-any.whl', sha256=a.sha(b'wheel'), bytes=5))
        self.put(self.dist / 'METADATA', b'Name: https://user:password@invalid\nVersion: 1.0\n')
        row = self.run_audit()['distributions'][0]
        self.assertEqual(row['name'], '[redacted]')
        self.assertFalse(row['authenticatedLockMatch'])

    def test_specials_permissions_symlinks_and_no_outside_reads(self):
        os.mkfifo(self.release / 'node/fifo')
        self.put(self.release / 'node/setid', b'x')
        (self.release / 'node/setid').chmod(0o6666)
        with self.read_only() as opened:
            result = self.run_audit()
        counts = result['runtime']['trees']['node']
        self.assertEqual((counts['special'], counts['setid'], counts['worldWritable'], counts['symlinks']), (1, 1, 1, 1))
        self.assertNotIn('fifo', opened)
        self.assertNotIn('secret', opened)
        symlink = result['runtime']['venvSymlinks'][0]
        self.assertFalse(symlink['followed'])
        self.assertEqual(symlink['path'], 'bin/python')
        self.assertNotIn('target', symlink)
        for path in ('node/fifo', 'node/escape/secret'):
            with self.assertRaises(a.Refused):
                self.files().content(a.RELEASE + '/' + path, 1024)

    def test_ancestor_and_leaf_symlinks_are_rejected(self):
        target = self.op / 'uv.whl'
        target.unlink()
        target.symlink_to(self.root / 'private-data/secret')
        result = self.run_audit()
        self.assertEqual((result['phase'], result['reason']), ('retained_artifacts', 'not_regular'))
        target.unlink()
        self.put(target, b'uv')
        (self.home / 'cache/downloads').rename(self.home / 'downloads-real')
        (self.home / 'cache/downloads').symlink_to(self.home / 'downloads-real')
        with self.assertRaisesRegex(a.Refused, 'not_directory'):
            self.files().content(a.HOME + '/cache/downloads/demo_pkg-1.0-py2.py3-none-any.whl', 1024)

    def test_archive_tamper_is_rejected_before_parsing(self):
        self.put(self.op / 'release.tar.gz', b'x' * len(self.archive))
        with patch.object(a.gzip, 'GzipFile', side_effect=AssertionError('must not parse unauthenticated bytes')):
            result = self.run_audit()
        self.assertEqual(result['reason'], 'archive_pin_mismatch')
        self.assertNotIn('authentication', result)
        self.assertNotIn('runtime', result)

    def test_installer_launcher_font_and_source_tamper(self):
        for path in (self.op / 'source' / a.INSTALLER, self.release / a.LAUNCHER,
                     self.release / a.FONT, self.release / 'package.json'):
            original = path.read_bytes()
            with self.subTest(path=path.name):
                self.put(path, b'tampered')
                result = self.run_audit()
                self.assertEqual(result['result'], 'incomplete')
                self.assertEqual(result['phase'], 'authentication')
                self.assertNotIn('runtime', result)
            self.put(path, original)
        with patch.object(a, 'INSTALLER_SHA256', '0' * 64):
            self.assertEqual(self.run_audit()['reason'], 'installer_pin_mismatch')

    def test_retained_artifact_tamper_does_not_claim_tree_verified(self):
        self.put(self.op / 'uv.whl', b'bad')
        result = self.run_audit()
        self.assertEqual(result['retainedArtifacts']['uv.whl']['status'], 'mismatch')
        self.assertEqual(result['result'], 'inventory_complete')
        self.assertIn('does not certify', result['notice'])
        (self.op / 'camoufox.zip').unlink()
        self.assertEqual(self.run_audit()['retainedArtifacts']['camoufox.zip']['status'], 'missing')

    def test_identity_state_and_continuation_guards(self):
        for key, value in (('operationId', 'wrong'), ('environmentId', 'wrong'), ('releaseId', 'wrong'),
                           ('state', 'ready'), ('completedSteps', True), ('totalSteps', 13)):
            original = self.status[key]
            with self.subTest(key=key):
                self.status[key] = value
                self.save_state()
                result = self.run_audit()
                self.assertEqual(result['phase'], 'state')
                self.assertNotIn('state', result)
                self.assertNotIn(SECRET, json.dumps(result))
            self.status[key] = original
        self.save_state()
        (self.op / 'continuation-unknown').mkdir()
        self.assertEqual(self.run_audit()['reason'], 'continuation_or_pending_state')

    def test_root_and_protected_control_check_are_injectable_not_cli_options(self):
        with patch.object(a.Files, 'content', side_effect=AssertionError('must refuse before access')):
            result = a.audit(root=str(self.root), getuid=lambda: 501)
        self.assertEqual(result['reason'], 'root_required')
        result = a.audit(root=str(self.root), getuid=lambda: 0, check=lambda info: False)
        self.assertEqual(result['reason'], 'untrusted_control_file')
        for args in (['--root', str(self.root)], ['--command', 'true'], ['--help']):
            output = io.StringIO()
            with redirect_stdout(output), patch.object(a, 'audit', side_effect=AssertionError('no audit')):
                self.assertEqual(a.main(args), 2)
            self.assertNotIn(str(self.root), output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['result'], 'refused')

    def test_shared_node_byte_time_and_file_limits(self):
        for budget, reason in ((a.Budget(nodes=2), 'node_limit'), (a.Budget(byte_limit=16), 'byte_limit'),
                               (a.Budget(clock=lambda: 0, seconds=0), 'time_limit')):
            with self.subTest(reason=reason):
                self.assertEqual(self.run_audit(budget=budget)['reason'], reason)
        ticks = iter(range(10000))
        self.assertEqual(self.run_audit(budget=a.Budget(clock=lambda: next(ticks), seconds=20))['reason'], 'time_limit')
        with patch.object(a, 'MAX_ARTIFACT', 3):
            self.assertEqual(self.run_audit()['reason'], 'file_size_limit')
        with patch.object(a, 'MAX_DISTRIBUTIONS', 0):
            self.assertEqual(self.run_audit()['reason'], 'distribution_limit')
        with patch.object(a, 'MAX_EXPANDED', 64):
            self.assertEqual(self.run_audit()['reason'], 'archive_expansion_limit')

    def test_archive_links_traversal_duplicates_and_specials_are_refused(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('package.json', tarfile.REGTYPE), ('link', tarfile.SYMTYPE),
                           ('hardlink', tarfile.LNKTYPE), ('fifo', tarfile.FIFOTYPE)):
            extra = tarfile.TarInfo('./' + name if not name.startswith('/') else name)
            extra.type = kind
            extra.linkname = 'package.json'
            data = bundle(self.contents, extra)
            self.put(self.op / 'release.tar.gz', data)
            with self.subTest(name=name), patch.object(a, 'ARCHIVE_SHA256', a.sha(data)), patch.object(a, 'ARCHIVE_SIZE', len(data)):
                with self.assertRaises(a.Refused):
                    a.authenticate(self.files())

    def test_changed_file_and_hardlink_rechecks(self):
        original_read = os.read
        changed = False

        def racing_read(fd, size):
            nonlocal changed
            data = original_read(fd, size)
            if not changed:
                changed = True
                self.put(self.op / 'uv.whl', b'changed while reading')
            return data

        with patch.object(os, 'read', side_effect=racing_read):
            with self.assertRaises(a.Refused):
                self.files().content(a.OP + '/uv.whl', 1024)
        files = self.files()
        _, links, _ = a.inventory(files)
        a.cache_inventory(files, links)
        os.link(self.package, self.root / 'new-alias')
        with self.assertRaisesRegex(a.Refused, 'hardlink_changed'):
            a.hardlinks(files, links)

    def test_missing_caches_leave_links_unaccounted(self):
        (self.home / 'cache').rename(self.home / 'not-in-scope')
        result = self.run_audit()
        self.assertEqual(result['caches']['uvCache']['status'], 'missing')
        self.assertEqual(result['hardlinks']['unaccountedLinks'], 2)
        self.assertEqual(result['hardlinks']['knownCacheAliases'], 0)

    def test_duplicate_json_and_metadata_symlinks_fail_closed(self):
        self.put(self.op / 'status.json', b'{"state":"failed","state":"ready"}')
        self.assertEqual(self.run_audit()['reason'], 'duplicate_json_key')
        self.save_state()
        (self.dist / 'METADATA').unlink()
        (self.dist / 'METADATA').symlink_to(self.root / 'private-data/secret')
        result = self.run_audit()
        self.assertEqual(result['reason'], 'not_regular')
        self.assertNotIn(SECRET, json.dumps(result))

    def test_nonregular_hardlinks_are_counted_without_reading_targets(self):
        source = self.release / 'node/escape'
        os.link(source, self.home / 'cache/link-alias', follow_symlinks=False)
        with self.read_only():
            result = self.run_audit()
        self.assertEqual(result['result'], 'inventory_complete', result)
        self.assertEqual(result['hardlinks']['nonRegularInodes'], 1)
        self.assertEqual(result['hardlinks']['knownCacheInodes'], 2)
        self.assertEqual(result['runtime']['trees']['node']['hardlinkedNonDirectories'], 3)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_stream_hash_reads_in_chunks_and_counts_bytes(self):
        data = b'abcd' * (1024 * 1024)
        self.put(self.op / 'node.tar.xz', data)
        files = self.files()
        original = os.read
        sizes = []

        def read(fd, size):
            sizes.append(size)
            return original(fd, size)

        with patch.object(os, 'read', side_effect=read):
            digest, info = files.content(a.OP + '/node.tar.xz', len(data), algorithm='sha256')
        self.assertEqual(digest, a.sha(data))
        self.assertEqual(info.st_size, len(data))
        self.assertEqual(files.budget.bytes, len(data))
        self.assertGreater(len(sizes), 3)
        self.assertLessEqual(max(sizes), 1024 * 1024)

    def test_cli_output_bound_and_hard_deadline_are_guarded_without_host_access(self):
        for scenario in ('output', 'deadline', 'success'):
            output = io.StringIO()
            with ExitStack() as stack:
                stack.enter_context(patch.object(sys, 'platform', 'linux'))
                stack.enter_context(patch.object(os, 'O_NOATIME', 0, create=True))
                signal_mock = stack.enter_context(patch.object(a.signal, 'signal'))
                timer = stack.enter_context(patch.object(a.signal, 'setitimer'))

                def fake_audit(scenario=scenario, signal_mock=signal_mock):
                    if scenario == 'deadline':
                        signal_mock.call_args_list[0].args[1](None, None)
                    return dict(notice=a.NOTICE, result='inventory_complete',
                                extra=SECRET * a.MAX_OUTPUT if scenario == 'output' else '')

                stack.enter_context(patch.object(a, 'audit', side_effect=fake_audit))
                with redirect_stdout(output):
                    code = a.main([])
                result = json.loads(output.getvalue())
                self.assertLessEqual(len(output.getvalue()), a.MAX_OUTPUT + 1)
                self.assertNotIn(SECRET, output.getvalue())
                self.assertEqual(code, 0 if scenario == 'success' else 1)
                if scenario != 'success':
                    self.assertEqual(result['reason'], 'time_limit' if scenario == 'deadline' else 'output_size_limit')
                timer.assert_any_call(a.signal.ITIMER_REAL, a.MAX_SECONDS)
                timer.assert_any_call(a.signal.ITIMER_REAL, 0)

    def test_disappearing_cache_is_not_misreported_as_missing(self):
        files = self.files()
        info = (self.home / 'cache').stat()

        def disappear(path):
            yield '', info, -1
            raise FileNotFoundError(SECRET)

        with patch.object(files, 'walk', side_effect=disappear):
            with self.assertRaisesRegex(a.Refused, 'cache_changed'):
                a.cache_inventory(files, {})

    def test_production_constants_and_static_no_execution_surface(self):
        self.assertEqual(ORIGINAL_PINS, (
            'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57', 223402,
            '67ca1a99f9dfa088df0173387656e7bc224d4e004fe409ab5e31238de2dbbac8',
            '467d6f496c9d0ab06ba10799269e13f4cf8738ea6bdb01f4293412ffa50a07b2',
            '5712114d715c713e302930ed191408ddfedbd5bf7c34c5d380958598595b34d6'))
        self.assertEqual((a.MAX_SECONDS, a.MAX_NODES, a.MAX_ARTIFACT), (120, 250000, 2 * 1024 ** 3))
        tree = ast.parse(SCRIPT.read_bytes())
        imports = {n.name.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for n in node.names}
        imports |= {node.module.split('.')[0] for node in ast.walk(tree)
                            if isinstance(node, ast.ImportFrom) and node.module is not None}
        self.assertLessEqual(imports, {'__future__', 'base64', 'gzip', 'hashlib', 'io', 'json', 'os', 're',
                                      'signal', 'stat', 'sys', 'tarfile', 'time', 'contextlib', 'tomllib', 'typing'})
        forbidden = {'exec', 'eval', 'compile', '__import__', 'extract', 'extractall', 'resolve',
                     'write_bytes', 'write_text', 'getenv', 'environ', 'import_module'}
        used = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
                and not (isinstance(n.value, ast.Name) and n.value.id == 're' and n.attr == 'compile')}
        used |= {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        self.assertFalse(used & forbidden)


if __name__ == '__main__':
    if os.geteuid() == 0:
        raise SystemExit('Run fixture tests as a non-root user.')
    unittest.main()
