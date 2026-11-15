"""Offline tests: real temporary files/flock, virtual ownership and mocked systemd.

Run: python3 -B -m unittest discover -s scripts -p test_repair_outpost2_browser.py -v
No root, network, browser, installer, or build is needed.
"""

from __future__ import annotations

import gzip
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('repair_outpost2_browser', Path(__file__).with_name('repair-outpost2-browser.py'))
assert SPEC and SPEC.loader
repair = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = repair
SPEC.loader.exec_module(repair)
PRODUCTION_ARCHIVE_SHA256 = repair.ARCHIVE_SHA256
PRODUCTION_ARCHIVE_SIZE = repair.ARCHIVE_SIZE
# The retained original is not available here. Inject only fixture pins in tests;
# the rebuilt local archive must never define the helper's production identity.
FIXTURE_ARCHIVE = (ROOT / 'desktop/src-tauri/resources/host-release.tar.gz').read_bytes()
PAYLOAD = (ROOT / 'server/browser-engine/launch.py').read_bytes()
with tarfile.open(fileobj=io.BytesIO(FIXTURE_ARCHIVE)) as bundle:
    member = bundle.extractfile('./server/browser-engine/launch.py')
    assert member is not None
    ORIGINAL = member.read()


class RepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(repair, 'ARCHIVE_SHA256', repair.digest(FIXTURE_ARCHIVE)))
        self.stack.enter_context(patch.object(repair, 'ARCHIVE_SIZE', len(FIXTURE_ARCHIVE)))
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.layout = repair.Layout(self.root)
        self.operation = self.layout.operation
        self.release = self.layout.release
        self.target = self.release / repair.LAUNCHER
        self.lock = self.layout.path('/var/lib/outpost-setup/install.lock')
        self.owners = {}
        self.chowns = []
        self.chmods = []
        self.real_stat, self.real_fstat = os.stat, os.fstat
        real_chmod = os.fchmod
        self.users = {name: SimpleNamespace(pw_uid=uid, pw_gid=uid) for name, uid in
                      (('outpost-build', 1001), ('outpost-coord', 1002), ('outpost-pi', 1003))}

        def virtual(info):
            values = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
            values['st_uid'], values['st_gid'] = self.owners.get((info.st_dev, info.st_ino), (0, 0))
            return SimpleNamespace(**values)

        def chown(fd, uid, gid):
            info = self.real_fstat(fd)
            key = (info.st_dev, info.st_ino)
            self.chowns.append((key, uid, gid))
            self.owners[key] = (uid, gid)

        def chmod(fd, mode):
            info = self.real_fstat(fd)
            self.chmods.append(((info.st_dev, info.st_ino), mode))
            real_chmod(fd, mode)

        for name, replacement in (('geteuid', lambda: 0), ('fstat', lambda fd: virtual(self.real_fstat(fd))),
                                  ('stat', lambda *a, **kw: virtual(self.real_stat(*a, **kw))),
                                  ('fchown', chown), ('fchmod', chmod)):
            self.stack.enter_context(patch.object(repair.os, name, replacement))
        self.stack.enter_context(patch.object(repair.pwd, 'getpwnam', side_effect=self.users.__getitem__))
        self.stack.enter_context(patch.object(repair.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=2001)))
        self.systemctl = self.stack.enter_context(patch.object(repair.subprocess, 'run', side_effect=self.unit_reply))
        self.mkdir(self.operation, 0o711)
        self.operation.parent.chmod(0o711)
        self.operation.parent.parent.chmod(0o711)
        self.mkdir(self.release, 0o755, 1001)
        self.release.parent.chmod(0o755)
        self.release.parent.parent.chmod(0o755)
        self.mkdir(self.layout.path('/etc/outpost-native'), 0o755)
        self.mkdir(self.layout.path('/etc/systemd/system'), 0o755)
        data = self.layout.path('/var/lib/outpost-native')
        self.mkdir(data, 0o711)
        self.mkdir(data / 'coordinator', 0o700, 1002)
        self.mkdir(data / 'worker', 0o700, 1003)
        self.mkdir(data / 'workspaces', 0o2770, 1002, 2001)
        self.mkdir(self.operation / 'build-home', 0o700, 1001)
        self.put(self.operation / 'build-home/fpgen-dataset', b'already downloaded', uid=1001)
        self.put(self.lock, b'original lock contents')
        self.put(self.operation / 'cancel', b'', uid=501)
        self.put(self.operation / 'release.tar.gz', FIXTURE_ARCHIVE, 0o644)
        self.put(self.operation / 'source' / repair.LAUNCHER, ORIGINAL, 0o644)
        self.put(self.target, ORIGINAL, 0o644, 1001)
        self.own(self.target.parent, 1001)
        self.put(self.operation / 'command.log', b'private original command failure\n')
        self.put(self.operation / 'launch.log', b'private original systemd launch\n')
        self.request = dict(repair.IDENTITIES, deviceId='de305d54-75b4-431b-adb2-eb6b9e546014',
                            publicKey='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', label='Outpost 2',
                            sha256=repair.ARCHIVE_SHA256, size=repair.ARCHIVE_SIZE,
                            browser=True, coexistence=True, fullControl=True)
        self.status = dict(repair.IDENTITIES, state='failed', completedSteps=4, totalSteps=12,
                           stage='Browser runtime', startedAt=100, updatedAt=200,
                           log=['Browser runtime started.'], error='retained private error')
        self.put(self.operation / 'request.json', repair.encoded(self.request))
        self.put(self.operation / 'status.json', repair.encoded(self.status), 0o644)
        self.mkdir(self.release / 'browsers', 0o755)
        self.mkdir(self.release / 'browsers/camoufox', 0o755)
        self.put(self.release / 'browsers/camoufox/firefox', b'never execute or chown', 0o755)
        self.payload = self.root / 'provided-launch.py'
        self.put(self.payload, PAYLOAD, 0o644, 501)

    def unit_reply(self, command, **kwargs):
        self.assertEqual(command[0:2], ['/usr/bin/systemctl', 'show'])
        self.assertIn(command[2], repair.UNITS)
        self.assertEqual(kwargs['timeout'], 5)
        return subprocess.CompletedProcess(command, 0, b'LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlPID=0\nJob=\n')

    def own(self, path, uid, gid=None):
        info = self.real_stat(path, follow_symlinks=False)
        self.owners[info.st_dev, info.st_ino] = (uid, uid if gid is None else gid)

    def mkdir(self, path, mode, uid=0, gid=None):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(mode)
        self.own(path, uid, gid)

    def put(self, path, data, mode=0o600, uid=0):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        self.own(path, uid)

    def snapshot(self):
        result = {}
        for path in self.root.rglob('*'):
            info = self.real_stat(path, follow_symlinks=False)
            contents = os.readlink(path) if stat.S_ISLNK(info.st_mode) else path.read_bytes() if stat.S_ISREG(info.st_mode) else None
            result[str(path.relative_to(self.root))] = (info.st_ino, info.st_mode, self.owners.get((info.st_dev, info.st_ino), (0, 0)), contents)
        return result

    def run_repair(self, **kwargs):
        return repair.repair(layout=self.layout, **kwargs)

    def apply(self):
        return self.run_repair(apply=True, launcher=self.payload)

    def refused_unchanged(self):
        before = self.snapshot()
        with self.assertRaises((repair.Refused, OSError, ValueError, SyntaxError)):
            self.apply()
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.chowns)
        self.assertFalse(self.chmods)

    def audit(self):
        matches = list(self.operation.glob(repair.AUDIT_PREFIX + '*'))
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_payload_and_parent_verified_original_archive_are_pinned(self):
        self.assertEqual(repair.digest(ORIGINAL), repair.ORIGINAL_SHA256)
        self.assertEqual(repair.digest(PAYLOAD), repair.REPLACEMENT_SHA256)
        self.assertEqual(PRODUCTION_ARCHIVE_SHA256, 'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57')
        self.assertEqual(PRODUCTION_ARCHIVE_SIZE, 223402)

    def test_rebuilt_archive_matching_its_request_is_not_original_plan(self):
        self.assertNotEqual(repair.digest(FIXTURE_ARCHIVE), PRODUCTION_ARCHIVE_SHA256)
        self.assertEqual(self.request['sha256'], repair.digest(FIXTURE_ARCHIVE))
        self.assertEqual(self.request['size'], len(FIXTURE_ARCHIVE))
        with patch.object(repair, 'ARCHIVE_SHA256', PRODUCTION_ARCHIVE_SHA256), patch.object(repair, 'ARCHIVE_SIZE', PRODUCTION_ARCHIVE_SIZE):
            self.refused_unchanged()

    def test_recompressed_archive_and_rebound_request_refused(self):
        recompressed = gzip.compress(gzip.decompress(FIXTURE_ARCHIVE), mtime=1)
        self.assertEqual(gzip.decompress(recompressed), gzip.decompress(FIXTURE_ARCHIVE))
        self.assertNotEqual(repair.digest(recompressed), repair.ARCHIVE_SHA256)
        self.put(self.operation / 'release.tar.gz', recompressed, 0o644)
        self.refused_unchanged()
        rebound = dict(self.request, sha256=repair.digest(recompressed), size=len(recompressed))
        self.put(self.operation / 'request.json', repair.encoded(rebound))
        self.refused_unchanged()

    def test_original_full_control_and_coexistence_flags_required(self):
        for key in ('fullControl', 'coexistence'):
            for value in (False, 1, 'true', None):
                with self.subTest(key=key, value=value):
                    self.put(self.operation / 'request.json', repair.encoded(dict(self.request, **{key: value})))
                    self.refused_unchanged()
            missing = dict(self.request)
            del missing[key]
            self.put(self.operation / 'request.json', repair.encoded(missing))
            self.refused_unchanged()

    def test_retained_archive_requires_exact_0644_root_permissions(self):
        path = self.operation / 'release.tar.gz'
        for mode in (0o600, 0o640, 0o660, 0o666):
            with self.subTest(mode=mode):
                path.chmod(mode)
                self.refused_unchanged()
        path.chmod(0o644)
        self.own(path, 501)
        self.refused_unchanged()
        self.own(path, 0, 501)
        self.refused_unchanged()

    def test_default_check_is_read_only(self):
        before = self.snapshot()
        self.assertIn('Check passed', self.run_repair())
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.systemctl.call_count, 4)
        self.assertFalse(self.chowns or self.chmods)

    def test_cli_defaults_to_check_and_has_no_target_or_resume_switch(self):
        with patch.object(repair, 'repair', return_value='checked') as run, redirect_stdout(io.StringIO()):
            self.assertEqual(repair.main([]), 0)
            run.assert_called_once_with(apply=False, launcher=None)
        for flag in ('--resume', '--operation', '--root', '--host'):
            with self.subTest(flag=flag), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                repair.main([flag])

    def test_root_required_even_for_check(self):
        with patch.object(repair.os, 'geteuid', return_value=501):
            with self.assertRaises(repair.Refused):
                self.run_repair()
            self.refused_unchanged()
        self.systemctl.assert_not_called()

    def test_apply_requires_explicit_payload(self):
        before = self.snapshot()
        with self.assertRaises(repair.Refused):
            self.run_repair(apply=True)
        self.assertEqual(before, self.snapshot())

    def test_payload_bad_hash_oversize_symlink_and_hardlink_refused(self):
        for data in (b'raise RuntimeError("never execute")', b'x' * 16385):
            self.payload.write_bytes(data)
            self.refused_unchanged()
        self.payload.unlink()
        self.payload.symlink_to(self.target)
        self.refused_unchanged()
        self.payload.unlink()
        os.link(self.target, self.payload)
        self.refused_unchanged()

    def test_compile_validation_precedes_any_writes(self):
        bad = b'if :\n'
        self.payload.write_bytes(bad)
        with patch.object(repair, 'REPLACEMENT_SHA256', repair.digest(bad)):
            self.refused_unchanged()

    def test_payload_is_read_once_and_not_reopened_at_patch(self):
        original = repair.inactive_units
        def change_payload():
            original()
            self.payload.write_bytes(b'concurrent edit to provided payload')
        with patch.object(repair, 'inactive_units', side_effect=change_payload):
            self.apply()
        self.assertEqual(self.target.read_bytes(), PAYLOAD)

    def test_request_bindings_and_browser_archive_fields(self):
        for key, value in (('operationId', 'other'), ('environmentId', 'other'), ('releaseId', 'other'),
                           ('browser', False), ('browser', 1), ('sha256', '0' * 64), ('size', 1)):
            with self.subTest(key=key, value=value):
                self.put(self.operation / 'request.json', repair.encoded(dict(self.request, **{key: value})))
                self.refused_unchanged()
        self.put(self.operation / 'request.json', b'{"browser":true,"browser":false}')
        self.refused_unchanged()

    def test_exact_failed_stage_and_status_identity(self):
        for key, value in (('state', 'running'), ('completedSteps', 5), ('completedSteps', True),
                           ('totalSteps', 13), ('stage', 'Protected configuration'), ('environmentId', 'other')):
            with self.subTest(key=key):
                self.put(self.operation / 'status.json', repair.encoded(dict(self.status, **{key: value})), 0o644)
                self.refused_unchanged()

    def test_cancelled_or_unknown_marker_refused(self):
        for contents in (b'1', b'0', b'unknown'):
            self.put(self.operation / 'cancel', contents, uid=501)
            self.refused_unchanged()

    def test_archive_source_and_release_drift(self):
        for path in (self.operation / 'release.tar.gz', self.operation / 'source' / repair.LAUNCHER, self.target):
            original = path.read_bytes()
            path.write_bytes(original[:-1] + b'!')
            self.refused_unchanged()
            path.write_bytes(original)

    def test_lock_is_original_nonblocking_not_truncated(self):
        with self.lock.open('rb') as stream:
            repair.fcntl.flock(stream.fileno(), repair.fcntl.LOCK_EX | repair.fcntl.LOCK_NB)
            self.refused_unchanged()
        self.assertEqual(self.lock.read_bytes(), b'original lock contents')

    def test_missing_nonroot_and_unsafe_lock_refused(self):
        self.own(self.lock, 501)
        self.refused_unchanged()
        self.own(self.lock, 0)
        self.lock.chmod(0o666)
        self.refused_unchanged()
        self.lock.unlink()
        self.refused_unchanged()
        os.mkfifo(self.lock)
        self.refused_unchanged()

    def test_lock_symlink_and_hardlink_refused(self):
        self.lock.unlink()
        self.lock.symlink_to(self.operation / 'command.log')
        self.refused_unchanged()
        self.lock.unlink()
        os.link(self.operation / 'command.log', self.lock)
        self.refused_unchanged()

    def test_symlink_ancestor_refused(self):
        source = self.operation / 'source'
        source.rename(self.operation / 'retained-source')
        source.symlink_to(self.operation / 'retained-source', target_is_directory=True)
        self.refused_unchanged()

    def test_hardlinked_launcher_or_status_and_fifo_log_refused(self):
        link = self.root / 'second-link'
        for path in (self.target, self.operation / 'status.json'):
            os.link(path, link)
            self.refused_unchanged()
            link.unlink()
        log = self.operation / 'command.log'
        log.unlink()
        os.mkfifo(log)
        self.refused_unchanged()

    def test_existing_configuration_data_current_or_receipt_refused(self):
        for path in (self.layout.path('/etc/outpost-native/coordinator.env'),
                     self.layout.path('/var/lib/outpost-native/coordinator/history'),
                     self.layout.path('/var/lib/outpost-native/worker/profile'),
                     self.layout.path('/var/lib/outpost-native/workspaces/user-work'),
                     self.layout.path('/opt/outpost-native/current'), self.release / 'pi-release.json'):
            self.put(path, b'concurrent user work')
            self.refused_unchanged()
            path.unlink()

    def test_directory_ownership_and_unrepaired_permissions_refused(self):
        path = self.layout.path('/var/lib/outpost-native/worker')
        self.own(path, 1002)
        self.refused_unchanged()
        self.own(path, 1003)
        (self.release / 'browsers').chmod(0o700)
        self.refused_unchanged()

    def test_existing_unaudited_fontconfig_refused(self):
        self.mkdir(self.layout.fontconfig, 0o755, 1001)
        self.refused_unchanged()

    def test_uncertain_or_active_units_refused(self):
        for value in (b'LoadState=loaded\nActiveState=active\nMainPID=1\nControlPID=0\nJob=\n',
                      b'LoadState=loaded\nActiveState=failed\nMainPID=0\nControlPID=0\nJob=\n',
                      b'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlPID=0\nJob=42\n', b''):
            self.systemctl.side_effect = None
            self.systemctl.return_value = subprocess.CompletedProcess([], 0, value)
            self.refused_unchanged()
        self.systemctl.return_value = subprocess.CompletedProcess([], 1, b'')
        self.refused_unchanged()

    def test_apply_backups_private_before_patch_and_permission_scope(self):
        before = self.snapshot()
        existing_inodes = {(self.real_stat(path).st_dev, self.real_stat(path).st_ino) for path in self.root.rglob('*')}
        real_replace = os.replace
        def checked_replace(*args, **kwargs):
            audit = self.audit()
            manifest = json.loads((audit / 'manifest.json').read_bytes())
            self.assertEqual(manifest['originalSha256'], repair.ORIGINAL_SHA256)
            self.assertEqual(manifest['replacementSha256'], repair.REPLACEMENT_SHA256)
            self.assertIn('not a byte-identical', manifest['provenance'])
            self.assertEqual((audit / 'launch.py').read_bytes(), ORIGINAL)
            self.assertFalse((audit / 'applied.json').exists())
            for name in repair.BACKUPS:
                self.assertEqual(stat.S_IMODE((audit / name).stat().st_mode), 0o600)
            real_replace(*args, **kwargs)
        old_mask = os.umask(0o077)
        try:
            with patch.object(repair.os, 'replace', side_effect=checked_replace):
                self.assertIn('Applied:', self.apply())
        finally:
            os.umask(old_mask)
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        audit = self.audit()
        self.assertEqual(stat.S_IMODE(audit.stat().st_mode), 0o700)
        for child in audit.iterdir():
            self.assertEqual(repair.metadata(child.stat()), {'uid': 0, 'gid': 0, 'mode': 0o600})
        self.assertEqual(repair.metadata(self.layout.fontconfig.stat()), {'uid': 1001, 'gid': 1001, 'mode': 0o755})
        self.assertEqual(repair.metadata(self.target.stat()), {'uid': 1001, 'gid': 1001, 'mode': 0o644})
        after = self.snapshot()
        target_key = str(self.target.relative_to(self.root))
        for name, value in before.items():
            if name != target_key:
                self.assertEqual(after[name], value, name)
        self.assertTrue(all(key not in existing_inodes for key, *_ in self.chowns + self.chmods))
        self.assertEqual({p.name for p in audit.iterdir()}, {*repair.BACKUPS, 'manifest.json', 'applied.json'})
        self.assertFalse(list(self.target.parent.glob('.outpost2-launch-*')))

    def test_verified_rerun_is_read_only(self):
        self.apply()
        before = self.snapshot()
        self.chowns.clear()
        self.chmods.clear()
        self.assertIn('Already applied', self.apply())
        self.assertIn('Already applied', self.run_repair())
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.chowns or self.chmods)

    def test_patched_launcher_without_audit_refused(self):
        self.target.write_bytes(PAYLOAD)
        self.refused_unchanged()

    def test_partial_audit_or_unknown_staging_never_reused(self):
        audit = self.operation / (repair.AUDIT_PREFIX + 'd1c61714-85df-4afb-99bb-12b53c377a3b')
        self.mkdir(audit, 0o700)
        self.put(audit / 'request.json', b'do not overwrite')
        self.refused_unchanged()

    def test_unknown_staging_file_never_overwritten(self):
        self.put(self.target.with_name('.outpost2-launch-unknown.tmp'), b'keep')
        self.refused_unchanged()

    def test_corrupt_or_nonprivate_audit_fails_closed(self):
        self.apply()
        self.chowns.clear()
        self.chmods.clear()
        audit = self.audit()
        for path in (audit / 'launch.py', audit / 'manifest.json', audit / 'applied.json', audit / 'request.json'):
            original = path.read_bytes()
            path.write_bytes(b'altered')
            self.refused_unchanged()
            path.write_bytes(original)
        (audit / 'command.log').chmod(0o644)
        self.refused_unchanged()

    def test_unknown_audit_content_or_extra_audit_refused(self):
        self.apply()
        self.chowns.clear()
        self.chmods.clear()
        unknown = self.audit() / 'unknown'
        self.put(unknown, b'keep')
        self.refused_unchanged()
        unknown.unlink()
        self.mkdir(self.operation / (repair.AUDIT_PREFIX + 'extra'), 0o700)
        self.refused_unchanged()

    def test_concurrent_changes_after_audit_preserved_without_patch(self):
        original_units = repair.inactive_units
        calls = 0
        def concurrent_edit():
            nonlocal calls
            original_units()
            calls += 1
            if calls == 2:
                self.target.write_bytes(b'user changed launcher')
                (self.operation / 'status.json').write_bytes(b'user changed status')
        with patch.object(repair, 'inactive_units', side_effect=concurrent_edit), self.assertRaises(repair.Refused):
            self.apply()
        self.assertEqual(self.target.read_bytes(), b'user changed launcher')
        self.assertEqual((self.operation / 'status.json').read_bytes(), b'user changed status')
        self.assertEqual((self.audit() / 'launch.py').read_bytes(), ORIGINAL)
        self.assertFalse(self.layout.fontconfig.exists())
        self.assertFalse((self.audit() / 'applied.json').exists())
        self.assertTrue(list(self.target.parent.glob('.outpost2-launch-*')))

    def test_cancel_during_review_preserved_without_patch(self):
        original_units = repair.inactive_units
        def cancel():
            original_units()
            (self.operation / 'cancel').write_bytes(b'1')
        with patch.object(repair, 'inactive_units', side_effect=cancel), self.assertRaises(repair.Refused):
            self.apply()
        self.assertEqual(self.target.read_bytes(), ORIGINAL)
        self.assertFalse(list(self.operation.glob(repair.AUDIT_PREFIX + '*')))

    def test_failed_replace_retains_evidence_no_cleanup_or_resume(self):
        with patch.object(repair.os, 'replace', side_effect=OSError('simulated failure')), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(self.target.read_bytes(), ORIGINAL)
        self.assertEqual((self.audit() / 'launch.py').read_bytes(), ORIGINAL)
        self.assertTrue(self.layout.fontconfig.is_dir())
        self.assertFalse((self.audit() / 'applied.json').exists())
        self.assertTrue(list(self.target.parent.glob('.outpost2-launch-*')))
        self.chowns.clear()
        self.chmods.clear()
        self.refused_unchanged()

    def test_lock_swap_before_evidence_read_refuses_without_effects(self):
        real_flock = repair.fcntl.flock
        def swap(fd, flags):
            real_flock(fd, flags)
            self.lock.rename(self.lock.with_name('retained-old.lock'))
            self.put(self.lock, b'replacement lock')
        with patch.object(repair.fcntl, 'flock', side_effect=swap), self.assertRaises(repair.Refused):
            self.apply()
        self.assertFalse(list(self.operation.glob(repair.AUDIT_PREFIX + '*')))
        self.assertFalse(self.layout.fontconfig.exists())
        self.assertEqual(self.target.read_bytes(), ORIGINAL)
        self.assertFalse(self.chowns or self.chmods)

    def test_native_unit_files_or_dropins_refused_even_if_inactive(self):
        for unit in repair.UNITS[1:]:
            path = self.layout.path('/etc/systemd/system') / unit
            self.put(path, b'other native configuration')
            self.refused_unchanged()
            path.unlink()
            directory = path.with_name(unit + '.d')
            directory.mkdir()
            self.refused_unchanged()
            directory.rmdir()

    def test_unknown_request_fields_and_unsafe_evidence_modes_refused(self):
        self.put(self.operation / 'request.json', repair.encoded(dict(self.request, resume=True)))
        self.refused_unchanged()
        self.put(self.operation / 'request.json', repair.encoded(self.request))
        for name in ('request.json', 'command.log', 'launch.log'):
            path = self.operation / name
            path.chmod(0o644)
            self.refused_unchanged()
            path.chmod(0o600)

    def test_changed_fontconfig_or_new_staging_refuses_audited_rerun(self):
        self.apply()
        self.chowns.clear()
        self.chmods.clear()
        cache = self.layout.fontconfig / 'generated-config'
        self.put(cache, b'operator check output', uid=1001)
        self.refused_unchanged()
        cache.unlink()
        self.put(self.target.with_name('.outpost2-launch-unknown.tmp'), b'keep')
        self.refused_unchanged()

    def test_concurrent_workspace_write_and_directory_swap_preserved(self):
        original_units = repair.inactive_units
        def user_work():
            original_units()
            self.put(self.layout.path('/var/lib/outpost-native/workspaces/user-file'), b'keep', uid=1002)
            engine = self.target.parent
            engine.rename(engine.with_name('retained-engine'))
            engine.mkdir()
            self.put(engine / 'launch.py', b'user launcher', 0o644, 1001)
        with patch.object(repair, 'inactive_units', side_effect=user_work), self.assertRaises(repair.Refused):
            self.apply()
        self.assertEqual(self.target.read_bytes(), b'user launcher')
        self.assertEqual(self.target.parent.with_name('retained-engine').joinpath('launch.py').read_bytes(), ORIGINAL)
        self.assertFalse(list(self.operation.glob(repair.AUDIT_PREFIX + '*')))
        self.assertFalse(self.chowns or self.chmods)

    def test_unit_probe_timeout_is_bounded_and_read_only(self):
        self.systemctl.side_effect = subprocess.TimeoutExpired('systemctl', 5)
        before = self.snapshot()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.apply()
        self.assertEqual(before, self.snapshot())

    def test_output_prints_full_bounded_command_but_does_not_run_it(self):
        output = io.StringIO()
        with patch.object(repair, 'repair', return_value='Applied') as run, redirect_stdout(output):
            self.assertEqual(repair.main(['--apply', '--launcher', str(self.payload)]), 0)
        run.assert_called_once_with(apply=True, launcher=self.payload)
        text = output.getvalue()
        self.assertIn('/usr/bin/timeout --signal=TERM --kill-after=5s 120s', text)
        self.assertIn('/usr/sbin/runuser -u outpost-build -- /usr/bin/env -i', text)
        self.assertIn(str(repair.Layout().release / repair.LAUNCHER), text)
        self.assertIn('HOME=' + str(repair.Layout().operation / 'build-home'), text)
        self.assertNotIn('<operation>', text)
        self.systemctl.assert_not_called()

    def test_cli_never_prints_host_exception_or_secret_evidence(self):
        output = io.StringIO()
        with patch.object(repair, 'repair', side_effect=OSError('SECRET private path/content')), redirect_stderr(output):
            self.assertEqual(repair.main([]), 1)
        self.assertNotIn('SECRET', output.getvalue())
        self.assertIn('retained', output.getvalue())


if __name__ == '__main__':
    unittest.main()
