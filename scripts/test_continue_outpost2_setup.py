"""Offline continuation tests. No sudo, real systemd, browser, SSH or network.

python3 -I -B -m unittest discover -s scripts -p test_continue_outpost2_setup.py -v
The installer/source fixture must be the exact original archive in scripts/fixtures;
there is no mutable-bundle fallback or production archive-pin rebinding. The
reviewed launcher is embedded and hash-checked; only synthetic font data is rebound.
Activation stays blocked. Tests of dormant code use temporary files and explicit,
local mocks of the refusal function; no production opt-out exists.
"""
from __future__ import annotations

import fcntl
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
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name('continue-outpost2-setup.py').absolute()
SPEC = importlib.util.spec_from_file_location('continue_outpost2_setup', SCRIPT)
assert SPEC and SPEC.loader
c = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = c
SPEC.loader.exec_module(c)
PRIVATE_DRIVER_BYTES = c.private_driver_bytes
h, HELPER = c.load_helper(SCRIPT.with_name(c.HELPER_NAME))
FIXTURE = SCRIPT.parent / 'fixtures/outpost2-original-release.tar.gz'
# Fixed, reviewed hotfix bytes; never read the mutable working-tree launcher.
LAUNCHER = b'''"""Emit local launch settings for the coordinator-owned Camoufox process."""
from __future__ import annotations

import contextlib
import json
import os
import sys
from pathlib import Path

from camoufox.addons import DefaultAddons
from camoufox.pkgman import selected_launch_path
from camoufox.utils import launch_options

BROWSER_VERSION = "official/158.0.1-beta.41"


def main() -> None:
    """Resolve launch settings for the pinned installed browser.

    Camoufox's launch_options may provision its pinned fpgen model and start a
    host GPU probe before returning these settings.
    """
    # Firefox's profile service needs HOME even with an explicit GPU probe profile.
    probe_env = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "LANG", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME")
        if os.environ.get(key)
    }
    if not probe_env.get("HOME"):
        raise RuntimeError(
            "Camoufox requires a non-empty HOME; set it to the coordinator user's "
            "home directory before starting browser work"
        )
    with contextlib.redirect_stdout(sys.stderr):
        executable = selected_launch_path(BROWSER_VERSION)
        if not Path(executable).is_file():
            raise RuntimeError("The pinned Camoufox browser is not installed")
        options = launch_options(
            executable_path=executable,
            headless=True,
            os={"darwin": "macos", "linux": "linux", "win32": "windows"}[sys.platform],
            enable_cache=True,
            exclude_addons=list(DefaultAddons),
            humanize=False,
            env=probe_env,
        )
    # Never pass the coordinator's credentials into a browser process.
    options["env"] = {
        key: str(value) for key, value in options["env"].items()
        if key.startswith("CAMOU_") or key.startswith("FONTCONFIG_")
    }
    print(json.dumps(options))


if __name__ == "__main__":
    main()
'''
assert c.digest(LAUNCHER) == h.REPLACEMENT_SHA256
PRODUCTION_ARCHIVE = h.ARCHIVE_SHA256
PRODUCTION_FONT = c.FONT_SHA256
FONT = b'<fontconfig>fixture only</fontconfig>\n'


def load_original_fixture():
    try:
        data = FIXTURE.read_bytes()
    except FileNotFoundError:
        raise FileNotFoundError(f'Required original fixture missing: {FIXTURE}; expected 223402 bytes, SHA-256 {h.ARCHIVE_SHA256}. No fallback is allowed.') from None
    if len(data) != h.ARCHIVE_SIZE or c.digest(data) != h.ARCHIVE_SHA256:
        raise AssertionError('Immutable original archive fixture size/hash mismatch; do not rebind production pins.')
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        installer = archive.extractfile('./deploy/environment/host_install.py').read()
        launcher = archive.extractfile('./server/browser-engine/launch.py').read()
    if c.digest(installer) != c.INSTALLER_SHA256 or c.digest(launcher) != h.ORIGINAL_SHA256:
        raise AssertionError('Immutable original installer/launcher fixture pin mismatch.')
    return data, installer, launcher


class ActivationGuardTests(unittest.TestCase):
    """These safety tests run even while the parent-provided archive is missing."""

    def test_cli_start_and_internal_run_refuse_before_loading_or_dispatch(self):
        for argv in (['--start'], ['--start', '--approve-original-plan', c.PLAN_ID],
                     ['--run', str(c.uuid.uuid4())], ['--run', ''],
                     ['--run', str(c.uuid.uuid4()), '--approve-original-plan', c.PLAN_ID]):
            with self.subTest(argv=argv), ExitStack() as stack:
                load = stack.enter_context(patch.object(c, 'load_helper'))
                operator = stack.enter_context(patch.object(c, 'operator'))
                worker = stack.enter_context(patch.object(c, 'worker'))
                stack.enter_context(patch.object(c.os, 'geteuid', return_value=0))
                stderr = stack.enter_context(redirect_stderr(io.StringIO()))
                self.assertEqual(c.main(argv), 1)
                self.assertIn(c.ACTIVATION_REFUSAL, stderr.getvalue())
                load.assert_not_called()
                operator.assert_not_called()
                worker.assert_not_called()

    def test_direct_entry_points_refuse_before_lock_files_or_services(self):
        for uid in (0, 501):
            with self.subTest(uid=uid), ExitStack() as stack:
                stack.enter_context(patch.object(c.os, 'geteuid', return_value=uid))
                boundaries = [stack.enter_context(patch.object(c, name)) for name in
                              ('install_lock', 'inspect', 'stage', 'launch', 'validate_stage', 'run_steps')]
                system = stack.enter_context(patch.object(c.subprocess, 'run'))
                process = stack.enter_context(patch.object(c.subprocess, 'Popen'))
                for attempt in (lambda: c.operator(None, b'', start=True, approval=c.PLAN_ID),
                                lambda: c.worker(None, str(c.uuid.uuid4())),
                                lambda: c.worker(None, '../../bypass')):
                    with self.assertRaises(c.Refused) as failure:
                        attempt()
                    self.assertEqual(str(failure.exception), c.ACTIVATION_REFUSAL)
                for boundary in [*boundaries, system, process]:
                    boundary.assert_not_called()

    def test_cli_check_requires_actual_isolation_and_no_bytecode_flags(self):
        for argv in ([], ['--check']):
            for isolated, flag_no_bytecode, runtime_no_bytecode in ((0, 0, False), (0, 1, True), (1, 0, True), (1, 1, False)):
                with self.subTest(argv=argv, flags=(isolated, flag_no_bytecode, runtime_no_bytecode)), ExitStack() as stack:
                    stack.enter_context(patch.object(c.sys, 'flags', SimpleNamespace(isolated=isolated, dont_write_bytecode=flag_no_bytecode)))
                    stack.enter_context(patch.object(c.sys, 'dont_write_bytecode', runtime_no_bytecode))
                    stack.enter_context(patch.object(c.os, 'geteuid', return_value=0))
                    load = stack.enter_context(patch.object(c, 'load_helper'))
                    operation = stack.enter_context(patch.object(c, 'operator'))
                    stderr = stack.enter_context(redirect_stderr(io.StringIO()))
                    self.assertEqual(c.main(argv), 1)
                    self.assertIn(c.CLI_FLAG_REFUSAL, stderr.getvalue())
                    self.assertIn('Read-only check stopped; no actions performed.', stderr.getvalue())
                    load.assert_not_called()
                    operation.assert_not_called()

    def test_script_flag_gate_precedes_filesystem_backed_imports(self):
        code = compile(SCRIPT.read_bytes(), str(SCRIPT), 'exec')
        original_import = __import__
        def guarded_import(name, *args, **kwargs):
            self.assertIn(name, ('sys', '__future__'), 'Filesystem-backed import before flag refusal')
            return original_import(name, *args, **kwargs)
        with patch.object(sys, 'flags', SimpleNamespace(isolated=0, dont_write_bytecode=0)), patch.object(sys, 'dont_write_bytecode', False), patch('builtins.__import__', side_effect=guarded_import):
            with self.assertRaises(SystemExit) as failure:
                exec(code, {'__name__': '__main__', '__file__': str(SCRIPT)})
        self.assertIn(c.CLI_FLAG_REFUSAL, str(failure.exception))

    def test_immutable_fixture_rejects_changed_bytes_without_extracting(self):
        for data in (b'', b'x' * 223402):
            with self.subTest(size=len(data)), patch.object(Path, 'read_bytes', return_value=data), patch.object(tarfile, 'open') as archive:
                with self.assertRaisesRegex(AssertionError, 'fixture size/hash mismatch'):
                    load_original_fixture()
                archive.assert_not_called()
        self.assertEqual(h.ARCHIVE_SHA256, PRODUCTION_ARCHIVE)
        self.assertEqual(h.ARCHIVE_SIZE, 223402)


class ModuleLoadingTests(unittest.TestCase):
    def test_reviewed_read_only_pins_match_exact_module_bytes(self):
        expected = {
            c.NODE_MODULE: 'f20f2da31c76b1d103fd6c0cf5016772adb72aed8a32225a8e1f96a2f0aaf295',
            c.PYTHON_MODULE: '80d671b799b6a988820df8a68984b2e85f3537fdde22f33e01861918069c07e9',
            c.NORMALIZER_MODULE: '86bb843149d073c7d1e30f86787f99bda302bcbe0d97dbe9e638ed3d97642839',
        }
        self.assertEqual(c.REVIEWED_MODULE_SHA256, expected)
        for name, digest in expected.items():
            self.assertEqual(c.digest(SCRIPT.with_name(name).read_bytes()), digest)
        with self.assertRaisesRegex(c.Refused, c.ACTIVATION_REFUSAL):
            c.refuse_unqualified_runtime()

    def test_missing_production_pins_refuse_before_read_or_import(self):
        with patch.object(c, 'REVIEWED_MODULE_SHA256', {}), patch.object(c, 'bootstrap_read') as read, patch.object(c, 'byte_module') as load:
            with self.assertRaisesRegex(c.Refused, 'Missing independently reviewed'):
                c.load_runtime_modules(normalization=True)
            read.assert_not_called()
            load.assert_not_called()

    def test_only_exact_pinned_module_bytes_are_loaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            data = b'class Refused(RuntimeError): pass\ndef verify(**kwargs): return {}\ndef plan_references(*args, **kwargs): return {}\ndef normalize(*args): return {}\n'
            for name in c.RUNTIME_MODULES:
                (directory / name).write_bytes(data)
            pins = {name: c.digest(data) for name in c.RUNTIME_MODULES}
            with patch.object(c, '__file__', str(directory / c.SELF_NAME)), patch.object(c, 'REVIEWED_MODULE_SHA256', pins):
                modules = c.load_runtime_modules(normalization=True)
                self.assertEqual(set(modules), set(c.RUNTIME_MODULES))
                self.assertEqual(modules[c.NODE_MODULE]['bytes'], data)
                (directory / c.NODE_MODULE).write_bytes(b'raise AssertionError("must never execute")')
                with self.assertRaisesRegex(c.Refused, 'hash mismatch'):
                    c.load_runtime_modules()
                (directory / c.NODE_MODULE).unlink()
                (directory / c.NODE_MODULE).symlink_to(directory / c.PYTHON_MODULE)
                with self.assertRaises(OSError):
                    c.load_runtime_modules()

    def test_assets_paths_and_approval_have_no_cli_override(self):
        for flag in ('--assets', '--templates', '--module-sha256', '--allow-start'):
            with self.subTest(flag=flag), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                c.main([flag, 'no'])
        self.assertEqual(c.artifact_references(), {
            'pythonAssets': {'path': '/home/surajadmin2/outpost-browser-repair-645f62a9/python-assets',
                             'manifestSha256': '2020eef6970c0ddcd421c04c7784c3e0ee06172be0533a7bec8fa18bc80f2bb5'},
            'uvTemplates': {'path': '/home/surajadmin2/outpost-browser-repair-645f62a9/uv-templates',
                            'manifestSha256': '0da48b4c01d04405a9c7109b6db9ffa219dc02e43d784c351022cb0046db3061'}})


class CommitBoundaryTests(unittest.TestCase):
    """Pure state-machine regressions, independent of the pending archive fixture."""

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.events = []
        self.layout = h.Layout()
        self.audit = self.layout.operation / ('continuation-' + str(c.uuid.uuid4()))
        self.installer = SimpleNamespace(completed=4, status={'state': 'failed', 'completedSteps': 4},
                                        ready_commit_started=False, browser_ok=False, health_ok=False, activated=False,
                                        last_command=self.audit / 'mock-command.log', cancelled=Mock(return_value=False),
                                        configuration=Mock(), enroll=Mock(), health=Mock(), run=Mock())
        self.installer.services = lambda: setattr(self.installer, 'activated', True)
        self.installer.publish = self.publish
        files = Mock()
        files.read.return_value = (b'OUTPOST_OFFLINE_BROWSER_OK\n', None)
        self.helper = SimpleNamespace(UNITS=h.UNITS, Files=Mock(return_value=files))
        for name in ('normalize_runtime', 'launcher_check', 'verify_release_state', 'check_units', 'unit_paths'):
            self.stack.enter_context(patch.object(c, name))
        self.stack.enter_context(patch.object(c, 'event', side_effect=self.record_event))
        self.system = self.stack.enter_context(patch.object(c.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)))
        self.stack.enter_context(patch.object(c.subprocess, 'Popen', side_effect=AssertionError('No real processes')))

    def publish(self, completed, message, state='running', error=None):
        self.installer.status.update(state=state, completedSteps=completed, error=error)
        if state == 'ready':
            self.installer.ready_commit_started = True

    def record_event(self, helper, audit, step, outcome, **kwargs):
        self.assertNotEqual(self.installer.status['state'], 'ready', 'Audit write occurred after final commit')
        self.events.append((step, outcome, kwargs.get('details')))

    def run_steps(self):
        c.run_steps(self.installer, self.helper, self.layout, self.audit, {})

    def test_ready_publication_is_the_last_fallible_action(self):
        self.run_steps()
        self.assertEqual(self.installer.status['state'], 'ready')
        self.assertEqual(self.installer.status['completedSteps'], 10)
        self.assertEqual(self.events[-1][0], 'Ready commit intent')
        self.system.assert_not_called()

    def test_audit_failure_before_commit_cannot_publish_ready(self):
        def fail_intent(helper, audit, step, outcome, **kwargs):
            if step == 'Ready commit intent' and outcome.startswith('Browser and health'):
                raise OSError('audit unavailable')
            self.record_event(helper, audit, step, outcome, **kwargs)
        with patch.object(c, 'event', side_effect=fail_intent), self.assertRaises(OSError):
            self.run_steps()
        self.assertEqual((self.installer.status['state'], self.installer.completed), ('failed', 9))
        self.assertFalse(self.installer.ready_commit_started)
        self.assertIn(['/usr/bin/systemctl', 'disable', '--now', *h.UNITS[1:]], [call.args[0] for call in self.system.call_args_list])

    def test_exception_after_visible_ready_never_disables_or_downgrades(self):
        def ambiguous(completed, message, state='running', error=None):
            self.publish(completed, message, state, error)
            if state == 'ready':
                raise OSError('ready visible, durability confirmation failed')
        self.installer.publish = ambiguous
        with self.assertRaises(OSError):
            self.run_steps()
        self.assertEqual((self.installer.status['state'], self.installer.completed), ('ready', 10))
        self.assertEqual(self.events[-1][0], 'Ready commit intent')
        self.system.assert_not_called()
        with self.assertRaises(c.Refused):
            self.run_steps()
        self.system.assert_not_called()

    def test_nonzero_cleanup_is_recorded_as_unconfirmed(self):
        self.installer.health.side_effect = RuntimeError('health failed')
        self.system.return_value = subprocess.CompletedProcess([], 17)
        with self.assertRaises(RuntimeError):
            self.run_steps()
        self.assertEqual((self.installer.status['state'], self.installer.completed), ('failed', 8))
        self.assertIn('cleanup unconfirmed', self.installer.status['error'])
        cleanup = [entry for entry in self.events if entry[0] == 'Native unit cleanup']
        self.assertEqual(len(cleanup), 1)
        self.assertIn('unconfirmed', cleanup[0][1])
        self.assertEqual(cleanup[0][2], {'units': list(h.UNITS[1:]), 'returnCode': 17, 'exception': None})


class Input(io.BytesIO):
    def close(self):
        self.saved = self.getvalue()
        super().close()


class Process:
    """A completed subprocess double: it never executes its supplied argv."""
    pid = 123456
    returncode = 0

    def __init__(self, argv, **kwargs):
        self.argv, self.kwargs = argv, kwargs
        self.stdin = Input()

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode


class ContinuationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle, cls.installer, cls.old_launcher = load_original_fixture()

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.layout = h.Layout(self.root)
        self.op, self.release = self.layout.operation, self.layout.release
        self.owners = {}
        self.real_stat, self.real_fstat = os.stat, os.fstat
        self.users = {name: SimpleNamespace(pw_uid=uid, pw_gid=uid) for name, uid in
                      (('outpost-build', 1001), ('outpost-coord', 1002), ('outpost-pi', 1003))}

        def virtual(info):
            values = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
            values['st_uid'], values['st_gid'] = self.owners.get((info.st_dev, info.st_ino), (0, 0))
            return SimpleNamespace(**values)

        def chown(fd, uid, gid):
            info = self.real_fstat(fd)
            self.owners[info.st_dev, info.st_ino] = (uid, gid)

        self.stack.enter_context(patch.object(os, 'stat', side_effect=lambda *a, **kw: virtual(self.real_stat(*a, **kw))))
        self.stack.enter_context(patch.object(os, 'fstat', side_effect=lambda fd: virtual(self.real_fstat(fd))))
        self.stack.enter_context(patch.object(os, 'fchown', side_effect=chown))
        self.stack.enter_context(patch.object(os, 'geteuid', return_value=0))
        self.stack.enter_context(patch.object(h.pwd, 'getpwnam', side_effect=self.users.__getitem__))
        self.stack.enter_context(patch.object(h.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=2001)))

        self.stack.enter_context(patch.object(c, 'FONT_SHA256', c.digest(FONT)))
        self.stack.enter_context(patch.object(c.platform, 'machine', return_value='x86_64'))
        self.disk = self.stack.enter_context(patch.object(c.shutil, 'disk_usage', return_value=SimpleNamespace(free=20 * 1024 ** 3)))
        self.system = self.stack.enter_context(patch.object(c.subprocess, 'run', side_effect=self.system_reply))
        self.popen = self.stack.enter_context(patch.object(c.subprocess, 'Popen', side_effect=AssertionError('Unexpected process execution')))
        self.worker_unit = False
        self.unit_bad = None
        self.mkdir(self.op, 0o711)
        self.op.parent.chmod(0o711)
        self.op.parent.parent.chmod(0o711)
        self.mkdir(self.release, 0o755, 1001)
        self.release.parent.chmod(0o755)
        self.release.parent.parent.chmod(0o755)
        self.mkdir(self.layout.path('/etc/outpost-native'), 0o755)
        self.mkdir(self.layout.path('/etc/systemd/system'), 0o755)
        self.mkdir(self.layout.path('/run/systemd/system'), 0o755)
        data = self.layout.path('/var/lib/outpost-native')
        self.mkdir(data, 0o711)
        self.mkdir(data / 'coordinator', 0o700, 1002)
        self.mkdir(data / 'worker', 0o700, 1003)
        self.mkdir(data / 'workspaces', 0o2770, 1002, 2001)
        self.mkdir(self.op / 'build-home', 0o700, 1001)
        self.put(self.op.parent.parent / 'install.lock', b'original lock')
        self.put(self.op / 'cancel', b'', uid=501)
        self.put(self.op / 'release.tar.gz', self.bundle, 0o644)
        for name in ('node.tar.xz', 'uv.whl', 'camoufox.zip'):
            self.put(self.op / name, b'retained download')
        with tarfile.open(fileobj=io.BytesIO(self.bundle)) as archive:
            for member in archive.getmembers():
                name = member.name.removeprefix('./')
                if name == '.':
                    continue
                for root, uid in ((self.op / 'source', 0), (self.release, 1001)):
                    if member.isdir():
                        self.mkdir(root / name, member.mode, uid)
                    else:
                        self.put(root / name, archive.extractfile(member).read(), member.mode, uid)
        self.put(self.release / h.LAUNCHER, LAUNCHER, 0o644, 1001)
        for relative in c.RUNTIME_DIRS:
            self.mkdir(self.release / relative, 0o755, 0 if relative == 'browsers' else 1001)
        self.mkdir(self.release / 'browsers/camoufox', 0o755)
        self.mkdir(self.layout.fontconfig, 0o755, 1001)
        self.put(self.layout.fontconfig / c.FONT_NAME, FONT, 0o644, 1001)
        self.put(self.release / 'browsers/camoufox/firefox', b'not executable by tests', 0o755)
        self.mkdir(self.release / 'node/bin', 0o755, 1001)
        self.put(self.release / 'node/bin/node', b'not a real Node', 0o755, 1001)
        self.mkdir(self.release / 'python/bin', 0o755, 1001)
        self.put(self.release / 'python/bin/python3', b'not a real Python', 0o755, 1001)
        self.mkdir(self.release / 'server/browser-engine/.venv/bin', 0o755, 1001)
        (self.release / 'server/browser-engine/.venv/bin/python').symlink_to(self.release / 'python/bin/python3')
        self.put(self.op / 'command.log', b'original private failure output\n')
        self.put(self.op / 'launch.log', b'original private launch output\n')
        self.put(self.op / 'launch.json', h.encoded({'returnCode': 0}), 0o644)
        self.request = dict(h.IDENTITIES, deviceId='de305d54-75b4-431b-adb2-eb6b9e546014',
                            publicKey='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', label='Outpost 2',
                            sha256=h.ARCHIVE_SHA256, size=h.ARCHIVE_SIZE, browser=True, coexistence=True, fullControl=True)
        self.status = dict(h.IDENTITIES, state='failed', completedSteps=4, totalSteps=12, stage='Browser runtime',
                           startedAt=100, updatedAt=200, log=['Original history.', 'Browser runtime started.'], error='retained failure')
        self.put(self.op / 'request.json', h.encoded(self.request))
        self.put(self.op / 'status.json', h.encoded(self.status), 0o644)
        self.hotfix = self.op / c.HOTFIX_AUDIT
        self.mkdir(self.hotfix, 0o700)
        backups = {'launch.py': (self.old_launcher, os.stat(self.release / h.LAUNCHER))}
        for name in h.BACKUPS[1:]:
            backups[name] = ((self.op / name).read_bytes(), os.stat(self.op / name))
        for name, (data, _) in backups.items():
            self.put(self.hotfix / name, data)
        manifest = h.encoded(h.manifest(self.hotfix, backups, self.users['outpost-build']))
        self.put(self.hotfix / 'manifest.json', manifest)
        self.put(self.hotfix / 'applied.json', h.encoded({'schema': 1, 'manifestSha256': c.digest(manifest),
                 'launcherSha256': h.REPLACEMENT_SHA256, 'fontconfigIdentity': list(h.identity(os.stat(self.layout.fontconfig)))}))
        self.put(self.layout.path('/usr/lib/os-release'), b'ID=ubuntu\nVERSION_ID="24.04"\n', 0o644)
        self.put(self.layout.path('/proc/meminfo'), b'MemTotal: 8388608 kB\n')
        for name in ('tcp', 'tcp6', 'udp', 'udp6'):
            self.put(self.layout.path('/proc/net/' + name), b'header\n')
        self.original = c.byte_module(self.installer, c.INSTALLER_SHA256, '_test_original_installer', self.op / 'source' / c.INSTALLER)
        for name, value in (('PREFIX', self.layout.path('/opt/outpost-native')), ('DATA', self.layout.path('/var/lib/outpost-native')),
                            ('CONFIG', self.layout.path('/etc/outpost-native')), ('UNIT_DIRECTORY', self.layout.path('/etc/systemd/system')),
                            ('OPERATIONS', self.op.parent)):
            setattr(self.original, name, value)
        self.network = self.stack.enter_context(patch.object(self.original.urllib.request, 'build_opener', side_effect=AssertionError('No test network allowed')))
        self.generated_bytecode = set()
        self.asset_bytes = b'{"fixture":"assets"}\n'
        self.template_bytes = b'{"fixture":"templates"}\n'
        self.put(self.layout.path(c.ASSETS_PATH) / 'manifest.json', self.asset_bytes)
        self.put(self.layout.path(c.TEMPLATES_PATH) / 'manifest.json', self.template_bytes)
        self.stack.enter_context(patch.object(c, 'ASSETS_SHA256', c.digest(self.asset_bytes)))
        self.stack.enter_context(patch.object(c, 'TEMPLATES_SHA256', c.digest(self.template_bytes)))
        self.module_bytes = {name: ('# inert fixture contract: ' + name + '\n').encode() for name in c.RUNTIME_MODULES}
        self.stack.enter_context(patch.object(c, 'REVIEWED_MODULE_SHA256', {name: c.digest(data) for name, data in self.module_bytes.items()}))
        self.node_verify = Mock(side_effect=lambda **kwargs: self.fixture_verifier('node', **kwargs))
        self.python_verify = Mock(side_effect=lambda **kwargs: self.fixture_verifier('python', **kwargs))
        self.normalizer = Mock(side_effect=self.fixture_normalizer)
        self.modules = {
            c.NODE_MODULE: {'bytes': self.module_bytes[c.NODE_MODULE], 'module': SimpleNamespace(verify=self.node_verify, Refused=c.Refused)},
            c.PYTHON_MODULE: {'bytes': self.module_bytes[c.PYTHON_MODULE], 'module': SimpleNamespace(verify=self.python_verify, plan_references=self.fixture_plan, Refused=c.Refused)},
            c.NORMALIZER_MODULE: {'bytes': self.module_bytes[c.NORMALIZER_MODULE], 'module': SimpleNamespace(normalize=self.normalizer, Refused=c.Refused)},
        }
        self.load_modules = self.stack.enter_context(patch.object(c, 'load_runtime_modules', return_value=self.modules))
        self.stack.enter_context(patch.object(c, 'private_driver_bytes', return_value=SCRIPT.read_bytes()))

    def fixture_verifier(self, kind, *, root, **kwargs):
        """Inert integration contract double, NOT a substitute for real verifier tests."""
        self.assertEqual(root, self.root)
        if kind == 'python':
            self.assertEqual(kwargs, {'assets': self.layout.path(c.ASSETS_PATH), 'expected_manifest_sha256': c.ASSETS_SHA256,
                                      'templates': self.layout.path(c.TEMPLATES_PATH)})
        else:
            self.assertEqual(kwargs, {})
        snapshot = c.capture_runtime(h, self.layout)
        scopes = ('node/', 'node_modules/', 'browsers/') if kind == 'node' else ('python/', 'server/browser-engine/.venv/')
        verified, links, quarantine = [], [], []
        for path, info in snapshot['leaves'].items():
            if not path.startswith(scopes):
                continue
            if path in snapshot['targets']:
                row = dict(info, target=snapshot['targets'][path], sha256=c.digest(os.fsencode(snapshot['targets'][path])))
                if kind == 'node':
                    row = {key: row[key] for key in ('path', 'mode', 'nlink', 'target')}
                    row['resolvedPath'] = path
                links.append(row)
            else:
                row = dict(info, sha256=c.digest((self.release / path).read_bytes()))
                if kind == 'node':
                    row = {key: row[key] for key in ('path', 'size', 'mode', 'nlink', 'sha256')}
                (quarantine if path in self.generated_bytecode else verified).append(row)
        summary = {'verifiedFiles': len(verified), 'verifiedLinks': len(links)}
        result = {'verifiedFiles': verified, 'verifiedLinks': links, 'summary': summary}
        if kind == 'node':
            summary.update(archiveSha256=h.ARCHIVE_SHA256, scope=['node', 'node_modules', 'browsers'])
        else:
            summary.update(sourceSha256=h.ARCHIVE_SHA256, releaseId=h.RELEASE_ID, manifestSha256=c.ASSETS_SHA256,
                           templateManifestSha256=c.TEMPLATES_SHA256, executionAuthorized=False, recordIsAuthenticityProof=False,
                           hardlinkedFiles=sum(row['nlink'] > 1 for row in verified), quarantineBytecode=len(quarantine))
            result.update(quarantineBytecode=quarantine, assertions={
                'root': str(self.root), 'releasePath': str(self.release.relative_to(self.root)),
                'ancestors': list(snapshot['ancestors'].values()),
                'ownedDirectories': [row for path, row in snapshot['directories'].items()
                                     if path in ('python', 'server/browser-engine/.venv') or path.startswith(scopes)]})
        return result

    def fixture_plan(self, archive, **kwargs):
        self.assertEqual(archive, self.op / 'release.tar.gz')
        python = self.fixture_verifier('python', root=self.root, **kwargs)
        generated_dirs = {str(Path(path).parent) for path in self.generated_bytecode}
        return {'summary': python['summary'], 'expected': [dict(path=row['path'], kind='dir')
                for row in python['assertions']['ownedDirectories'] if row['path'] not in generated_dirs], 'optional': []}

    def fixture_normalizer(self, release, audit, proof):
        self.assertEqual(release, self.release)
        self.assertEqual(audit.parent, self.op)
        self.assertEqual(set(proof), {'schemaVersion', 'operationId', 'releaseId', 'buildUid', 'buildGid',
                                     'verifiedFiles', 'verifiedLinks', 'quarantineBytecode', 'quarantineDirectories', 'assertions'})
        return dict(schemaVersion=1, status='normalized', operationId=h.OPERATION_ID, releaseId=h.RELEASE_ID,
                    auditId=audit.name, executionAuthorized=False, requiresReverification=True, requiresExplicitSeal=True,
                    isolatedFiles=sum(row['nlink'] > 1 for row in proof['verifiedFiles']),
                    quarantinedBytecode=len(proof['quarantineBytecode']), removedGeneratedDirectories=len(proof['quarantineDirectories']))

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

    def system_reply(self, argv, **kwargs):
        if argv[:2] == ['/usr/bin/systemctl', 'show']:
            self.assertIn(argv[2], h.UNITS)
            self.assertEqual(kwargs['timeout'], 5)
            values = dict(LoadState='not-found', ActiveState='inactive', MainPID='0', ControlPID='0', Job='', FragmentPath='', DropInPaths='')
            if self.worker_unit and argv[2] == h.UNITS[0]:
                values.update(LoadState='loaded', ActiveState='active', MainPID=str(os.getpid()), FragmentPath='/run/systemd/transient/' + h.UNITS[0])
            if self.unit_bad:
                values.update(self.unit_bad)
            return subprocess.CompletedProcess(argv, 0, ''.join(f'{key}={value}\n' for key, value in values.items()).encode())
        if argv[0] == '/usr/bin/systemd-run':
            return subprocess.CompletedProcess(argv, 0)
        if argv[:2] in (['/usr/bin/systemctl', 'stop'], ['/usr/bin/systemctl', 'disable']):
            return subprocess.CompletedProcess(argv, 0)
        self.fail('Unexpected system command: ' + repr(argv))

    def check(self, **kwargs):
        return c.operator(h, HELPER, start=False, approval=None, layout=self.layout, **kwargs)

    def start(self):
        return c.operator(h, HELPER, start=True, approval=c.PLAN_ID, layout=self.layout)

    def inspect(self, **kwargs):
        files = h.Files()
        return files, c.inspect(h, files, self.layout, **kwargs)

    def stage(self):
        files, review = self.inspect()
        audit = c.stage(h, files, self.layout, review, HELPER, SCRIPT.read_bytes())
        return audit, review

    def snapshot(self):
        return {str(path.relative_to(self.root)): (self.real_stat(path, follow_symlinks=False).st_ino,
                self.real_stat(path, follow_symlinks=False).st_mode,
                os.readlink(path) if path.is_symlink() else path.read_bytes() if path.is_file() else None)
                for path in self.root.rglob('*')}

    def refusal(self):
        before = self.snapshot()
        with self.assertRaises((c.Refused, h.Refused, OSError, ValueError)):
            self.check()
        self.assertEqual(before, self.snapshot())
        self.popen.assert_not_called()

    def adapter(self):
        audit, review = self.stage()
        adapter = c.continuation_installer(self.original, h, self.layout, audit, review)
        return adapter, audit, review

    def fake_process(self, argv, **kwargs):
        process = Process(argv, **kwargs)
        self.processes.append(process)
        actual = argv[argv.index('--') + 1:] if argv[0] == '/usr/sbin/runuser' else argv
        if actual[:2] == ['/bin/chown', '-R']:
            for path in [self.release, *self.release.rglob('*')]:
                self.own(path, 0)
        if actual[:2] == ['/bin/chmod', '-R']:
            for path in [self.release, *self.release.rglob('*')]:
                if not path.is_symlink():
                    mode = stat.S_IMODE(os.stat(path).st_mode)
                    path.chmod((mode | 0o444 | (0o111 if path.is_dir() or mode & 0o111 else 0)) & ~0o022)
        if actual[0] == '/usr/bin/systemd-run':
            kwargs['stdout'].write(b'OUTPOST_OFFLINE_BROWSER_OK\n')
        elif str(self.release / h.LAUNCHER) in actual:
            options = {'executable_path': str(self.release / 'browsers/camoufox/firefox'), 'headless': True,
                       'args': [], 'env': {'CAMOU_CONFIG_1': '{}'}, 'firefox_user_prefs': {}}
            kwargs['stdout'].write(b'GPU diagnostics\n' + json.dumps(options).encode() + b'\n')
        else:
            kwargs['stdout'].write(b'private mocked command output\n')
        kwargs['stdout'].flush()
        return process

    def wire_real_methods(self, adapter):
        self.worker_unit = True
        self.processes = []
        self.popen.side_effect = self.fake_process
        self.stack.enter_context(patch.object(self.original.shutil, 'chown', side_effect=lambda path, user, group: self.own(path, self.users[user].pw_uid)))
        adapter.health = Mock()  # HTTP/root proof are never executed locally.

    def test_production_pins_and_original_api_not_latest_worktree(self):
        self.assertEqual(c.digest(HELPER), 'ac2ec0b4c767897fff4f9fbc35c6cd8e17bdf433b507943cbe8b296c02f3095d')
        self.assertEqual(c.digest(self.installer), c.INSTALLER_SHA256)
        self.assertEqual(c.digest(LAUNCHER), h.REPLACEMENT_SHA256)
        self.assertEqual(PRODUCTION_ARCHIVE, 'f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57')
        self.assertEqual(PRODUCTION_FONT, '5712114d715c713e302930ed191408ddfedbd5bf7c34c5d380958598595b34d6')
        self.assertEqual(c.digest(self.bundle), PRODUCTION_ARCHIVE)
        self.assertEqual(len(self.bundle), 223402)
        self.put(self.op / 'release.tar.gz', self.bundle + b'changed', 0o644)
        self.refusal()

    def test_verified_bytes_never_execute_changed_helper(self):
        code = self.root / 'bad-helper.py'
        self.put(code, b'raise AssertionError("must not execute")')
        with self.assertRaisesRegex(c.Refused, 'hash'):
            c.load_helper(code)
        with self.assertRaisesRegex(c.Refused, 'hash'):
            c.byte_module(self.installer + b'\n', c.INSTALLER_SHA256, '_bad_original', code)
        code.unlink()
        code.symlink_to(SCRIPT.with_name(c.HELPER_NAME))
        with self.assertRaises(OSError):
            c.load_helper(code)

    def test_check_is_read_only_and_never_calls_empty_font_helper(self):
        before = self.snapshot()
        with patch.object(h, 'verified_audit', side_effect=AssertionError('Empty-font API prohibited')):
            message = self.check()
            self.assertIn('Structural and full content checks passed', message)
            self.assertIn('read-only', message)
            self.assertIn('NOT ready-to-start', message)
            self.assertIn('Source/release: 108 archive-managed files each (declared launcher hotfix).', message)
            node = self.fixture_verifier('node', root=self.root)
            python = self.fixture_verifier('python', root=self.root, assets=self.layout.path(c.ASSETS_PATH),
                expected_manifest_sha256=c.ASSETS_SHA256, templates=self.layout.path(c.TEMPLATES_PATH))
            self.assertIn(f'Node/browser/npm: files={len(node["verifiedFiles"])}; symlinks={len(node["verifiedLinks"])}.', message)
            self.assertIn(f'Python: files={len(python["verifiedFiles"])}; symlinks={len(python["verifiedLinks"])}; hardlinkedFiles=0; quarantineBytecode=0.', message)
            self.assertIn('No actions performed: no staging, normalization, runtime execution, service changes or receipt writes.', message)
            self.assertIn('Both --start and --run are disabled unconditionally', message)
        self.assertEqual(before, self.snapshot())
        self.popen.assert_not_called()
        self.assertTrue(all(call.args[0][:2] == ['/usr/bin/systemctl', 'show'] for call in self.system.call_args_list))

    def test_read_only_summary_reports_pending_actions_without_performing_them(self):
        source = self.release / 'server/browser-engine/.venv/lib/summary.py'
        self.put(source, b'authenticated fixture source', 0o644, 1001)
        alias = self.op / 'build-home/cache/summary.py'
        alias.parent.mkdir(parents=True, exist_ok=True)
        os.link(source, alias)
        pyc = source.parent / '__pycache__/summary.cpython-313.pyc'
        self.put(pyc, b'generated fixture bytecode', 0o644, 1001)
        self.generated_bytecode.add(str(pyc.relative_to(self.release)))
        before = self.snapshot()
        message = self.check()
        self.assertIn('hardlinkedFiles=1; quarantineBytecode=1.', message)
        self.assertIn('No actions performed', message)
        self.assertEqual(before, self.snapshot())
        self.normalizer.assert_not_called()
        self.popen.assert_not_called()

    def test_cli_verifier_refusals_identify_module_bound_reason_and_never_fix(self):
        operator = c.operator
        before = self.snapshot()
        for name, verifier, error, reason in (
            (c.NODE_MODULE, self.node_verify, c.Refused('file_digest_mismatch'), 'file_digest_mismatch'),
            (c.PYTHON_MODULE, self.python_verify, c.Refused('installed_content_mismatch'), 'installed_content_mismatch'),
            (c.PYTHON_MODULE, self.python_verify, c.Refused('x' * 10000), 'x' * 128 + '...'),
            (c.PYTHON_MODULE, self.python_verify, c.Refused('bad\nPRIVATE_CANARY\x1b[2J'), 'invalid_refusal_reason'),
            (c.PYTHON_MODULE, self.python_verify, ValueError('/private/PRIVATE_CANARY'), 'unexpected_verifier_error'),
        ):
            original = verifier.side_effect
            try:
                verifier.side_effect = error
                with self.subTest(module=name, reason=reason), ExitStack() as stack:
                    stack.enter_context(patch.object(c.sys, 'flags', SimpleNamespace(isolated=1, dont_write_bytecode=1)))
                    stack.enter_context(patch.object(c.sys, 'dont_write_bytecode', True))
                    stack.enter_context(patch.object(c, 'load_helper', return_value=(h, HELPER)))
                    stack.enter_context(patch.object(c, 'operator', side_effect=lambda helper, data, **kwargs: operator(helper, data, layout=self.layout, **kwargs)))
                    stdout = stack.enter_context(redirect_stdout(io.StringIO()))
                    stderr = stack.enter_context(redirect_stderr(io.StringIO()))
                    self.assertEqual(c.main(['--check']), 1)
                    self.assertIn(f'REFUSED: {name} refused: {reason}\n', stderr.getvalue())
                    self.assertIn('Read-only check stopped; no actions performed.', stderr.getvalue())
                    self.assertNotIn('PRIVATE_CANARY', stderr.getvalue())
                    self.assertNotIn('\x1b', stderr.getvalue())
                    self.assertLess(len(stderr.getvalue()), 400)
                    self.assertEqual(stdout.getvalue(), '')
                    self.assertEqual(before, self.snapshot())
                    self.normalizer.assert_not_called()
                    self.popen.assert_not_called()
            finally:
                verifier.side_effect = original

    def test_root_and_precise_explicit_approval(self):
        with patch.object(os, 'geteuid', return_value=501):
            with self.assertRaises(c.Refused):
                self.check()
        for approval in (None, '', 'yes', 'another-plan'):
            with self.subTest(approval=approval), self.assertRaises(c.Refused):
                c.operator(h, HELPER, start=True, approval=approval, layout=self.layout)
        with self.assertRaises(c.Refused):
            c.operator(h, HELPER, start=False, approval=c.PLAN_ID, layout=self.layout)

    def test_cli_default_and_restricted_surface(self):
        with patch.object(c.sys, 'flags', SimpleNamespace(isolated=1, dont_write_bytecode=1)), patch.object(c.sys, 'dont_write_bytecode', True), patch.object(c, 'load_helper', return_value=(h, HELPER)), patch.object(c, 'operator', return_value='checked') as operation, redirect_stdout(io.StringIO()):
            self.assertEqual(c.main([]), 0)
        operation.assert_called_once_with(h, HELPER, start=False, approval=None)
        for flag in ('--resume', '--root', '--command', '--host', '--target', '--operation', '--installer', '--launcher'):
            with self.subTest(flag=flag), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                c.main([flag, 'no'])

    def test_request_identity_flags_and_failed_count_pinned(self):
        for key, value in (('browser', False), ('fullControl', False), ('coexistence', False),
                           ('deviceId', str(c.uuid.uuid4())), ('publicKey', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB=')):
            self.put(self.op / 'request.json', h.encoded(dict(self.request, **{key: value})))
            self.refusal()
        self.put(self.op / 'request.json', h.encoded(self.request))
        for key, value in (('state', 'running'), ('state', 'ready'), ('completedSteps', 5), ('completedSteps', 12), ('totalSteps', 10), ('stage', 'Device enrollment')):
            self.put(self.op / 'status.json', h.encoded(dict(self.status, **{key: value})), 0o644)
            self.refusal()

    def test_cancellation_config_data_current_and_unit_paths(self):
        mutations = [(self.op / 'cancel', b'1', 0o600),
                     (self.layout.path('/etc/outpost-native/unexpected'), b'x', 0o600),
                     (self.layout.path('/var/lib/outpost-native/coordinator/unexpected'), b'x', 0o600),
                     (self.release / 'pi-release.json', b'{}', 0o644),
                     (self.layout.path('/etc/systemd/system') / h.UNITS[1], b'x', 0o644)]
        for path, data, mode in mutations:
            self.put(path, data, mode)
            self.refusal()
            if path.name == 'cancel':
                self.put(path, b'', 0o600, 501)
            else:
                path.unlink()
        current = self.release.parent.parent / 'current'
        current.symlink_to(self.release)
        self.refusal()

    def test_dropins_vendor_units_and_active_jobs_refuse(self):
        for suffix in ('outpost-native-coordinator.service', 'outpost-native-coordinator.service.d', 'service.d', 'outpost-.service.d'):
            path = self.layout.path('/usr/lib/systemd/system') / suffix
            self.put(path, b'unexpected')
            self.refusal()
            path.unlink()
        for values in ({'ActiveState': 'active'}, {'LoadState': 'loaded'}, {'Job': '12'}, {'DropInPaths': '/etc/unexpected'}, {'MainPID': '123'}):
            self.unit_bad = values
            self.refusal()

    def test_host_capacity_platform_and_ports(self):
        self.disk.return_value = SimpleNamespace(free=1)
        self.refusal()
        self.disk.return_value = SimpleNamespace(free=20 * 1024 ** 3)
        with patch.object(c.platform, 'machine', return_value='arm64'):
            self.refusal()
        self.put(self.layout.path('/usr/lib/os-release'), b'ID=ubuntu\nVERSION_ID="22.04"\n')
        self.refusal()
        self.put(self.layout.path('/usr/lib/os-release'), b'ID=ubuntu\nVERSION_ID="24.04"\n')
        for port in (4518, 4519, 4520):
            self.put(self.layout.path('/proc/net/tcp6'), f'header\n 0: 00000000:{port:04X} ignored\n'.encode())
            self.refusal()

    def test_source_release_drift_and_unexpected_paths(self):
        for root in (self.op / 'source', self.release):
            target = root / 'package.json'
            before = target.read_bytes()
            target.write_bytes(before + b'\n')
            self.refusal()
            target.write_bytes(before)
            self.put(root / 'server/unexpected.ts', b'x', 0o644, 1001 if root == self.release else 0)
            self.refusal()
            (root / 'server/unexpected.ts').unlink()
        self.put(self.op / 'unexpected.log', b'x')
        self.refusal()

    def test_symlinks_hardlinks_and_bad_modes(self):
        source = self.op / 'source/package.json'
        original = source.read_bytes()
        source.unlink()
        source.symlink_to(self.release / 'package.json')
        self.refusal()
        source.unlink()
        os.link(self.release / 'package.json', source)
        self.refusal()
        source.unlink()
        self.put(source, original, 0o644)
        (self.release / 'node/escape').symlink_to(self.op / 'request.json')
        self.refusal()
        (self.release / 'node/escape').unlink()
        (self.op / 'release.tar.gz').chmod(0o600)
        self.refusal()

    def test_font_and_hotfix_audit_are_exact_not_blanket_exceptions(self):
        font = self.layout.fontconfig / c.FONT_NAME
        font.write_bytes(FONT + b'changed')
        self.refusal()
        font.write_bytes(FONT)
        self.put(self.layout.fontconfig / 'extra.conf', b'x', 0o644, 1001)
        self.refusal()
        (self.layout.fontconfig / 'extra.conf').unlink()
        font.chmod(0o666)
        self.refusal()
        font.chmod(0o644)
        self.put(self.hotfix / 'applied.json', b'{}')
        self.refusal()

    def test_archive_duplicate_traversal_and_symlink_members(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('./x', tarfile.SYMTYPE), ('./x', tarfile.REGTYPE)):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
                for _ in range(2):
                    member = tarfile.TarInfo(name)
                    member.type, member.mode = kind, 0o644
                    member.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                    archive.addfile(member, io.BytesIO())
            with self.assertRaises(c.Refused):
                c.archive_tree(h, buffer.getvalue())

    def test_existing_marker_even_incomplete_blocks_check_and_start(self):
        self.mkdir(self.op / 'continuation-incomplete', 0o700)
        self.refusal()
        with self.assertRaises(c.Refused):
            self.start()
        self.assertFalse(any(call.args[0][0] == '/usr/bin/systemd-run' for call in self.system.call_args_list))

    def test_original_flock_nonblocking_and_unchanged(self):
        lock_path = self.op.parent.parent / 'install.lock'
        before = lock_path.read_bytes()
        with lock_path.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(c.Refused):
                self.check()
        self.assertEqual(lock_path.read_bytes(), before)

    def test_staging_private_no_overwrite_and_manifest_validated(self):
        before = {name: (self.op / name).read_bytes() for name in c.EVIDENCE.values()}
        audit, _ = self.stage()
        payloads = c.validate_stage(h, self.layout, audit, h.Files())
        self.assertEqual(payloads[c.HELPER_NAME], HELPER)
        self.assertEqual(payloads['host_install.py'], self.installer)
        self.assertEqual(payloads[c.SELF_NAME], SCRIPT.read_bytes())
        for path in [audit, *audit.rglob('*')]:
            self.assertEqual(h.metadata(os.stat(path)), {'uid': 0, 'gid': 0, 'mode': 0o700 if path.is_dir() else 0o600})
        for name, data in before.items():
            self.assertEqual((self.op / name).read_bytes(), data)
        with self.assertRaises(FileExistsError):
            h.Files().create(audit / c.SELF_NAME, b'never overwrite')
        self.put(audit / c.SELF_NAME, b'changed')
        with self.assertRaises(c.Refused):
            c.validate_stage(h, self.layout, audit, h.Files())

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_dormant_launch_uses_original_unit_isolated_staged_code_and_releases_lock(self):
        real_reply = self.system_reply
        def launch_reply(argv, **kwargs):
            if argv[0] == '/usr/bin/systemd-run':
                with c.install_lock(h, self.layout):
                    pass
            return real_reply(argv, **kwargs)
        self.system.side_effect = launch_reply
        message = self.start()
        self.assertIn('Root authority', message)
        command = next(call.args[0] for call in self.system.call_args_list if call.args[0][0] == '/usr/bin/systemd-run')
        self.assertIn('--unit=' + h.UNITS[0], command)
        for prop in ('Type=exec', 'UMask=0077', 'KillMode=control-group', 'RuntimeMaxSec=900'):
            self.assertIn('--property=' + prop, command)
        index = command.index('/usr/bin/python3')
        self.assertEqual(command[index + 1:index + 3], ['-I', '-B'])
        self.assertTrue(command[index + 3].startswith(str(self.op / 'continuation-')))
        self.assertEqual(command[-2], '--run')
        with self.assertRaises(c.Refused):
            self.start()

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_dormant_ambiguous_launch_keeps_marker_original_receipt_and_no_retry(self):
        def timeout(argv, **kwargs):
            if argv[0] == '/usr/bin/systemd-run':
                raise subprocess.TimeoutExpired(argv, 20)
            return self.system_reply(argv, **kwargs)
        self.system.side_effect = timeout
        self.assertIn('ambiguous', self.start())
        audit = next(self.op.glob('continuation-*'))
        self.assertEqual(json.loads((audit / 'launch/result.json').read_text())['state'], 'ambiguous')
        self.assertEqual(json.loads((self.op / 'status.json').read_text()), self.status)
        with self.assertRaises(c.Refused):
            self.start()

    def test_handoff_request_change_and_already_claimed_audit_refused(self):
        audit, _ = self.stage()
        self.put(self.op / 'request.json', h.encoded(dict(self.request, deviceId=str(c.uuid.uuid4()))))
        with self.assertRaises(c.Refused):
            c.validate_stage(h, self.layout, audit, h.Files())
        self.put(self.op / 'request.json', h.encoded(self.request))
        self.put(audit / 'worker.json', b'{}')
        with self.assertRaises(c.Refused):
            c.validate_stage(h, self.layout, audit, h.Files())

    def test_worker_recognizes_only_self_as_original_setup_unit(self):
        self.worker_unit = True
        c.check_units(h, worker=True)
        with self.assertRaises(c.Refused):
            c.check_units(h)
        self.unit_bad = {'MainPID': '1'}
        with self.assertRaises(c.Refused):
            c.check_units(h, worker=True)
        with self.assertRaises((c.Refused, ValueError)):
            c.worker(h, '../../another')
        with self.assertRaises(c.Refused):
            c.worker(h, str(c.uuid.uuid4()))

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_dormant_worker_revalidates_after_handoff_before_installer(self):
        audit, _ = self.stage()
        self.worker_unit = True
        (self.op / 'source/package.json').write_bytes(b'drift after launch')
        with patch.object(c, '__file__', str(audit / c.SELF_NAME)), patch.object(c.sys, 'flags', SimpleNamespace(isolated=1)), patch.object(c.sys, 'dont_write_bytecode', True):
            with self.assertRaises(c.Refused):
                c.worker(h, audit.name.removeprefix(c.PREFIX), layout=self.layout)
        self.assertFalse((audit / 'worker.json').exists())
        self.assertFalse((audit / 'commands').exists())
        self.assertEqual(json.loads((self.op / 'status.json').read_text()), self.status)

    def test_command_log_redirect_restores_operation_and_enrollment_identity(self):
        adapter, audit, _ = self.adapter()
        self.wire_real_methods(adapter)
        before = (self.op / 'command.log').read_bytes()
        adapter.enroll()
        adapter.run(['/bin/true'])
        self.assertEqual(adapter.operation, self.op)
        self.assertEqual((self.op / 'command.log').read_bytes(), before)
        self.assertEqual(len(list((audit / 'commands').glob('*/command.log'))), 2)
        enrollment = json.loads(self.processes[0].stdin.saved)
        self.assertEqual(enrollment, {key: self.request[key] for key in ('environmentId', 'deviceId', 'publicKey')} | {'name': 'Outpost'})
        self.assertEqual(self.processes[0].kwargs['cwd'], self.release)
        self.assertEqual(self.processes[0].kwargs['env']['HOME'], str(self.layout.path('/var/lib/outpost-native/coordinator')))
        self.assertTrue(self.processes[0].kwargs['start_new_session'])
        self.put(self.op / 'cancel', b'1', uid=501)
        with self.assertRaises(InterruptedError):
            adapter.run(['/bin/false'])
        self.assertEqual(adapter.operation, self.op)
        self.assertEqual((self.op / 'command.log').read_bytes(), before)

    def test_command_failure_timeout_and_cleanup_preserved(self):
        adapter, _, _ = self.adapter()
        process = Process([], stdout=io.BytesIO())
        process.returncode = 3
        self.popen.side_effect = lambda *a, **kw: process
        with self.assertRaises(RuntimeError):
            adapter.run(['/bin/false'])
        self.assertEqual(adapter.operation, self.op)
        process.returncode = None
        process.poll = Mock(side_effect=[None, 0])
        process.wait = Mock(return_value=0)
        with patch.object(self.original.time, 'monotonic', side_effect=[0, 2]), patch.object(self.original.os, 'killpg') as kill:
            with self.assertRaises(InterruptedError):
                adapter.run(['/bin/sleep', '10'], timeout=1)
        kill.assert_called_once_with(process.pid, c.signal.SIGTERM)
        self.assertEqual(adapter.operation, self.op)

    def test_actual_remaining_methods_progress_gates_and_preserved_history(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        before = {name: (self.op / name).read_bytes() for name in ('request.json', 'command.log', 'launch.log', 'release.tar.gz')}
        publications = []
        publish = adapter.publish
        def record(*args, **kwargs):
            publications.append((args[0], args[2] if len(args) > 2 else 'running'))
            return publish(*args, **kwargs)
        adapter.publish = record
        events = []
        original_event = c.event
        def before_ready(*args, **kwargs):
            self.assertNotEqual(json.loads((self.op / 'status.json').read_text())['state'], 'ready', 'Fallible audit write after ready')
            events.append(args[2])
            return original_event(*args, **kwargs)
        with patch.object(c, 'event', side_effect=before_ready):
            c.run_steps(adapter, h, self.layout, audit, review)
        self.assertEqual(events[-1], 'Ready commit intent')
        status = json.loads((self.op / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps'], status['totalSteps']), ('ready', 10, 12))
        self.assertEqual(status['startedAt'], self.status['startedAt'])
        self.assertEqual(status['log'][:len(self.status['log'])], self.status['log'])
        self.assertEqual(set(status), set(self.status))
        self.assertGreater(status['updatedAt'], self.status['updatedAt'])
        self.assertEqual([n for n, _ in publications], [4, 5, 5, 6, 6, 7, 7, 7, 7, 8, 8, 9, 10])
        self.assertEqual(publications[-1], (10, 'ready'))
        for name, data in before.items():
            self.assertEqual((self.op / name).read_bytes(), data)
        adapter.health.assert_called_once()
        commands = [process.argv for process in self.processes]
        self.assertTrue(any(command[:3] == ['/usr/bin/systemctl', 'enable', '--now'] for command in commands))
        self.assertFalse(any('install-deps' in command or 'ci' in command or 'sync' in command for command in commands))
        self.assertTrue((self.layout.path('/etc/systemd/system') / h.UNITS[3]).exists())
        self.assertEqual(json.loads((audit / 'request.json').read_text()), self.request)

    def test_each_gate_failure_has_truthful_count_no_later_steps_or_fake_ready(self):
        # Each subcase needs its own filesystem: this tool deliberately has no resume.
        for target, expected, activated in (('launcher', 4, False), ('configuration', 5, False),
                                             ('enroll', 6, False), ('probe', 7, False), ('services', 7, True), ('health', 8, True)):
            with self.subTest(target=target):
                case = ContinuationTests('runTest')
                case.setUp()
                try:
                    adapter, audit, review = case.adapter()
                    case.wire_real_methods(adapter)
                    def fail(*args, **kwargs):
                        if target == 'services':
                            adapter.activated = True
                        raise RuntimeError('mock failure')
                    with ExitStack() as patches:
                        if target == 'launcher':
                            patches.enter_context(patch.object(c, 'launcher_check', side_effect=fail))
                        elif target == 'probe':
                            real_run = adapter.run
                            def run(argv, **kwargs):
                                if argv[0] == '/usr/bin/systemd-run':
                                    fail()
                                return real_run(argv, **kwargs)
                            adapter.run = run
                        else:
                            setattr(adapter, target, fail)
                        with self.assertRaises(RuntimeError):
                            c.run_steps(adapter, h, case.layout, audit, review)
                    status = json.loads((case.op / 'status.json').read_text())
                    self.assertEqual((status['state'], status['completedSteps']), ('failed', expected))
                    self.assertNotIn('Server ready.', '\n'.join(status['log']))
                    cleanup = [call.args[0] for call in case.system.call_args_list if call.args[0][:2] == ['/usr/bin/systemctl', 'disable']]
                    self.assertEqual(cleanup, [['/usr/bin/systemctl', 'disable', '--now', *h.UNITS[1:]]] if activated else [])
                finally:
                    case.doCleanups()

    def test_fake_completion_and_completed_step_reruns_are_impossible(self):
        adapter, _, _ = self.adapter()
        for completed, state in ((12, 'complete'), (10, 'ready'), (9, 'ready'), (5, 'running')):
            with self.assertRaises(c.Refused):
                adapter.publish(completed, 'fake', state)
        adapter.completed = 10
        with self.assertRaises(c.Refused):
            adapter.publish(10, 'fake', 'ready')
        for method in ('preflight', 'accounts', 'runtime', 'dependencies', 'browsers', 'download', 'execute'):
            with self.assertRaises(c.Refused):
                getattr(adapter, method)()
        self.assertEqual(json.loads((self.op / 'status.json').read_text()), self.status)

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_dormant_worker_holds_lock_through_health_and_cannot_be_reentered(self):
        audit, _ = self.stage()
        self.worker_unit = True
        real_adapter = c.continuation_installer
        def make_adapter(*args):
            adapter = real_adapter(*args)
            self.wire_real_methods(adapter)
            def health():
                with self.assertRaises(c.Refused):
                    with c.install_lock(h, self.layout):
                        self.fail('Worker released its lock early')
            adapter.health.side_effect = health
            return adapter
        with patch.object(c, '__file__', str(audit / c.SELF_NAME)), patch.object(c.sys, 'flags', SimpleNamespace(isolated=1)), patch.object(c.sys, 'dont_write_bytecode', True), patch.object(c, 'byte_module', return_value=self.original), patch.object(c, 'continuation_installer', side_effect=make_adapter):
            c.worker(h, audit.name.removeprefix(c.PREFIX), layout=self.layout)
            with self.assertRaises(c.Refused):
                c.worker(h, audit.name.removeprefix(c.PREFIX), layout=self.layout)
        self.assertEqual(json.loads((self.op / 'status.json').read_text())['completedSteps'], 10)
        with c.install_lock(h, self.layout):
            pass

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_dormant_worker_signal_publishes_last_success_and_only_native_cleanup(self):
        audit, _ = self.stage()
        self.worker_unit = True
        real_adapter = c.continuation_installer
        previous = c.signal.getsignal(c.signal.SIGTERM)
        def make_adapter(*args):
            adapter = real_adapter(*args)
            self.wire_real_methods(adapter)
            adapter.health.side_effect = lambda: c.signal.getsignal(c.signal.SIGTERM)(c.signal.SIGTERM, None)
            return adapter
        with patch.object(c, '__file__', str(audit / c.SELF_NAME)), patch.object(c.sys, 'flags', SimpleNamespace(isolated=1)), patch.object(c.sys, 'dont_write_bytecode', True), patch.object(c, 'byte_module', return_value=self.original), patch.object(c, 'continuation_installer', side_effect=make_adapter):
            with self.assertRaises(InterruptedError):
                c.worker(h, audit.name.removeprefix(c.PREFIX), layout=self.layout)
        status = json.loads((self.op / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('cancelled', 8))
        self.assertIs(c.signal.getsignal(c.signal.SIGTERM), previous)
        self.assertIn(['/usr/bin/systemctl', 'disable', '--now', *h.UNITS[1:]], [call.args[0] for call in self.system.call_args_list])

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_dormant_incomplete_staging_retains_marker_and_cannot_launch(self):
        create = h.Files.create
        def interrupted(files, path, data, **kwargs):
            if path.name == c.SELF_NAME:
                raise OSError('simulated interrupted write')
            return create(files, path, data, **kwargs)
        with patch.object(h.Files, 'create', interrupted), self.assertRaises(OSError):
            self.start()
        self.assertEqual(len(list(self.op.glob('continuation-*'))), 1)
        self.assertEqual(json.loads((self.op / 'status.json').read_text()), self.status)
        self.assertFalse(any(call.args[0][0] == '/usr/bin/systemd-run' for call in self.system.call_args_list))
        with self.assertRaises(c.Refused):
            self.start()

    def test_start_and_valid_staged_worker_still_refuse_without_mutation(self):
        before = self.snapshot()
        with self.assertRaisesRegex(c.Refused, c.ACTIVATION_REFUSAL):
            self.start()
        self.assertEqual(before, self.snapshot())
        self.system.assert_not_called()
        audit, _ = self.stage()  # Private temporary fixture, not a real operation.
        c.validate_stage(h, self.layout, audit, h.Files())
        before = self.snapshot()
        self.system.reset_mock()
        with patch.object(c, '__file__', str(audit / c.SELF_NAME)), patch.object(c.sys, 'flags', SimpleNamespace(isolated=1)), patch.object(c.sys, 'dont_write_bytecode', True):
            with self.assertRaisesRegex(c.Refused, c.ACTIVATION_REFUSAL):
                c.worker(h, audit.name.removeprefix(c.PREFIX), layout=self.layout)
        self.assertEqual(before, self.snapshot())
        self.system.assert_not_called()
        self.popen.assert_not_called()
        self.assertFalse((audit / 'worker.json').exists())

    def test_audit_failure_before_ready_never_publishes_ready(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        original_event = c.event
        def fail_commit_audit(helper, path, step, outcome, **kwargs):
            if step == 'Ready commit intent' and outcome.startswith('Browser and health'):
                raise OSError('simulated final audit failure')
            return original_event(helper, path, step, outcome, **kwargs)
        with patch.object(c, 'event', side_effect=fail_commit_audit), self.assertRaises(OSError):
            c.run_steps(adapter, h, self.layout, audit, review)
        status = json.loads((self.op / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('failed', 9))
        self.assertFalse(adapter.ready_commit_started)
        self.assertNotIn('Server ready.', '\n'.join(status['log']))
        self.assertIn(['/usr/bin/systemctl', 'disable', '--now', *h.UNITS[1:]], [call.args[0] for call in self.system.call_args_list])

    def test_ready_commit_exception_after_rename_never_downgrades_or_disables(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        atomic_json = self.original.atomic_json
        def after_replace(path, value, mode=0o600):
            atomic_json(path, value, mode)
            if value.get('state') == 'ready':
                raise OSError('simulated directory fsync failure after rename')
        with patch.object(self.original, 'atomic_json', side_effect=after_replace), self.assertRaises(OSError):
            c.run_steps(adapter, h, self.layout, audit, review)
        published = (self.op / 'status.json').read_bytes()
        status = json.loads(published)
        self.assertEqual((status['state'], status['completedSteps']), ('ready', 10))
        self.assertTrue(adapter.ready_commit_started)
        self.assertFalse(any(call.args[0][:2] == ['/usr/bin/systemctl', 'disable'] for call in self.system.call_args_list))
        before = self.snapshot()
        adapter.completed = 9
        with self.assertRaises(c.Refused):
            adapter.publish(9, 'forbidden rollback', 'failed')
        with self.assertRaises(c.Refused):
            c.run_steps(adapter, h, self.layout, audit, review)
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.op / 'status.json').read_bytes(), published)

    def test_cleanup_nonzero_is_private_evidence_not_silent_success(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        adapter.health.side_effect = RuntimeError('health did not pass')
        real_reply = self.system_reply
        def fail_cleanup(argv, **kwargs):
            if argv[:2] == ['/usr/bin/systemctl', 'disable']:
                self.assertEqual(argv, ['/usr/bin/systemctl', 'disable', '--now', *h.UNITS[1:]])
                return subprocess.CompletedProcess(argv, 17)
            return real_reply(argv, **kwargs)
        self.system.side_effect = fail_cleanup
        with self.assertRaises(RuntimeError):
            c.run_steps(adapter, h, self.layout, audit, review)
        status = json.loads((self.op / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('failed', 8))
        self.assertIn('Native unit cleanup unconfirmed', status['error'])
        cleanup = [(path, json.loads(path.read_text())) for path in audit.glob('event-*.json') if json.loads(path.read_text())['step'] == 'Native unit cleanup']
        self.assertEqual(len(cleanup), 1)
        path, evidence = cleanup[0]
        self.assertIn('unconfirmed', evidence['outcome'])
        self.assertEqual(evidence['details'], {'units': list(h.UNITS[1:]), 'returnCode': 17, 'exception': None})
        self.assertEqual(h.metadata(os.stat(path)), {'uid': 0, 'gid': 0, 'mode': 0o600})

    def test_sealing_gate_detects_source_mutation_before_enrollment(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        configure = adapter.configuration
        def drift():
            configure()
            (self.release / 'server/browser/engine.ts').write_bytes(b'changed during configuration')
        adapter.configuration = drift
        adapter.enroll = Mock()
        with self.assertRaises(c.Refused):
            c.run_steps(adapter, h, self.layout, audit, review)
        adapter.enroll.assert_not_called()
        self.assertEqual(json.loads((self.op / 'status.json').read_text())['completedSteps'], 5)

    def test_probe_zero_exit_without_proof_cannot_activate(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        fake = self.fake_process
        def no_proof(argv, **kwargs):
            if argv[0] == '/usr/bin/systemd-run':
                return Process(argv, **kwargs)
            return fake(argv, **kwargs)
        self.popen.side_effect = no_proof
        adapter.services = Mock()
        with self.assertRaises(c.Refused):
            c.run_steps(adapter, h, self.layout, audit, review)
        adapter.services.assert_not_called()
        self.assertEqual(json.loads((self.op / 'status.json').read_text())['completedSteps'], 7)

    def test_cancellation_after_health_still_cannot_publish_ready(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        adapter.health.side_effect = lambda: self.put(self.op / 'cancel', b'1', uid=501)
        with self.assertRaises(InterruptedError):
            c.run_steps(adapter, h, self.layout, audit, review)
        status = json.loads((self.op / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('cancelled', 9))

    def test_cleanup_timeout_does_not_discard_failure_receipt(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        adapter.health.side_effect = RuntimeError('health did not pass')
        real_reply = self.system_reply
        def timeout(argv, **kwargs):
            if argv[:2] in (['/usr/bin/systemctl', 'stop'], ['/usr/bin/systemctl', 'disable']):
                raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
            return real_reply(argv, **kwargs)
        self.system.side_effect = timeout
        with self.assertRaises(RuntimeError):
            c.run_steps(adapter, h, self.layout, audit, review)
        status = json.loads((self.op / 'status.json').read_text())
        self.assertEqual((status['state'], status['completedSteps']), ('failed', 8))
        self.assertTrue(any('unconfirmed' in path.read_text() for path in audit.glob('event-*.json')))

    def test_start_driver_requires_root_owned_private_parent(self):
        directory = self.root / 'incoming-code'
        self.mkdir(directory, 0o700, 501)
        path = directory / c.SELF_NAME
        self.put(path, b'# inert fixture driver', 0o600)
        with patch.object(c, '__file__', str(path)):
            with self.assertRaises(h.Refused):
                PRIVATE_DRIVER_BYTES(h)
            self.own(directory, 0)
            directory.chmod(0o755)
            with self.assertRaises(h.Refused):
                PRIVATE_DRIVER_BYTES(h)
            directory.chmod(0o700)
            self.assertEqual(PRIVATE_DRIVER_BYTES(h), b'# inert fixture driver')
            path.chmod(0o666)
            with self.assertRaises(c.Refused):
                PRIVATE_DRIVER_BYTES(h)

    def test_full_verifiers_run_read_only_under_original_lock(self):
        def locked(kind, **kwargs):
            with self.assertRaises(c.Refused):
                with c.install_lock(h, self.layout):
                    self.fail('Verifier called without original lock')
            return self.fixture_verifier(kind, **kwargs)
        self.node_verify.side_effect = lambda **kwargs: locked('node', **kwargs)
        self.python_verify.side_effect = lambda **kwargs: locked('python', **kwargs)
        before = self.snapshot()
        self.check()
        self.assertEqual(before, self.snapshot())
        self.node_verify.assert_called_once_with(root=self.root)
        self.python_verify.assert_called_once_with(root=self.root, assets=self.layout.path(c.ASSETS_PATH),
            expected_manifest_sha256=c.ASSETS_SHA256, templates=self.layout.path(c.TEMPLATES_PATH))
        self.normalizer.assert_not_called()

    @patch.object(c, 'refuse_unqualified_runtime', new=lambda: None)
    def test_bad_proof_or_reference_never_creates_a_marker(self):
        before = self.snapshot()
        self.python_verify.side_effect = c.Refused('content_mismatch')
        with self.assertRaisesRegex(c.Refused, 'content_mismatch'):
            self.start()
        self.assertEqual(before, self.snapshot())
        self.normalizer.assert_not_called()
        self.popen.assert_not_called()
        self.python_verify.side_effect = lambda **kwargs: self.fixture_verifier('python', **kwargs)
        self.put(self.layout.path(c.ASSETS_PATH) / 'manifest.json', b'changed')
        before = self.snapshot()
        with self.assertRaisesRegex(c.Refused, 'Reference manifest pin'):
            self.start()
        self.assertEqual(before, self.snapshot())
        self.assertFalse(list(self.op.glob('continuation-*')))

    def test_service_uid_processes_and_scoped_root_writers_refuse(self):
        proc = self.layout.path('/proc/424242')
        self.mkdir(proc / 'fd', 0o700)
        self.put(proc / 'cmdline', b'/usr/bin/sleep\0')
        for uid in (1001, 1002, 1003):
            self.put(proc / 'status', ('Name: fixture\nUid: ' + ' '.join([str(uid)] * 4) + '\n').encode())
            self.refusal()
        self.put(proc / 'status', b'Name: fixture\nUid: 0 0 0 0\n')
        self.put(proc / 'cmdline', b'/bin/chown\0' + os.fsencode(self.release) + b'\0')
        self.refusal()
        self.put(proc / 'cmdline', b'/usr/bin/sleep\0')
        (proc / 'fd/3').symlink_to(self.op / 'command.log')
        self.refusal()
        (proc / 'fd/3').unlink()
        self.assertIn('content checks passed', self.check())

    def test_runtime_mutation_during_verification_is_detected(self):
        original = self.node_verify.side_effect
        def mutate(**kwargs):
            (self.release / 'node/bin/node').write_bytes(b'concurrent mutation')
            return original(**kwargs)
        self.node_verify.side_effect = mutate
        with self.assertRaisesRegex(c.Refused, 'changed across content verification'):
            self.check()
        self.assertFalse(list(self.op.glob('continuation-*')))
        self.popen.assert_not_called()

    def test_empty_uv_locks_only_and_postseal_write_immutability(self):
        for name in c.UV_LOCKS:
            self.put(self.release / name, b'', 0o666, 1001)
        self.check()
        lock = self.release / 'python/.lock'
        lock.write_bytes(b'not empty')
        self.refusal()
        lock.write_bytes(b'')
        unknown = self.release / 'python/unapproved.lock'
        self.put(unknown, b'', 0o666, 1001)
        self.refusal()
        unknown.unlink()
        _, review = self.inspect()
        for path in [self.release, *self.release.rglob('*')]:
            self.own(path, 0)
        self.put(self.release / 'pi-release.json', b'{}', 0o644)
        with self.assertRaisesRegex(c.Refused, 'write permissions'):
            c.verify_release_state(h, self.layout, review, sealed=True)
        for name in c.UV_LOCKS:
            (self.release / name).chmod(0o644)
        c.verify_release_state(h, self.layout, review, sealed=True)

    def test_build_probe_drift_is_refused_before_configuration_seals(self):
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        fake_process = self.fake_process
        def probe_drift(argv, **kwargs):
            process = fake_process(argv, **kwargs)
            if str(self.release / h.LAUNCHER) in argv:
                (self.release / 'package.json').write_bytes(b'probe changed source')
            return process
        self.popen.side_effect = probe_drift
        adapter.configuration = Mock()
        with self.assertRaises(c.Refused):
            c.run_steps(adapter, h, self.layout, audit, review)
        adapter.configuration.assert_not_called()
        self.assertEqual(json.loads((self.op / 'status.json').read_text())['completedSteps'], 4)
        self.assertEqual(self.processes[0].argv[-3:], [str(self.release / 'server/browser-engine/.venv/bin/python'), '-B', str(self.release / h.LAUNCHER)])

    def test_normalizer_claim_without_actual_isolation_never_executes(self):
        source = self.release / 'server/browser-engine/.venv/lib/authenticated.py'
        self.put(source, b'fixture source\n', 0o644, 1001)
        alias = self.op / 'build-home/cache/shared.py'
        alias.parent.mkdir(parents=True, exist_ok=True)
        os.link(source, alias)
        adapter, audit, review = self.adapter()
        with self.assertRaisesRegex(c.Refused, 'hardlink isolation'):
            c.run_steps(adapter, h, self.layout, audit, review)
        self.normalizer.assert_called_once()
        self.popen.assert_not_called()
        self.assertEqual(json.loads((self.op / 'status.json').read_text())['completedSteps'], 4)
        self.assertEqual(self.real_stat(alias).st_ino, self.real_stat(source).st_ino)

    def test_generated_pyc_requires_quarantine_even_when_normalizer_claims_success(self):
        base = self.release / 'server/browser-engine/.venv/lib/example'
        self.put(base / 'source.py', b'fixture source\n', 0o644, 1001)
        pyc = base / '__pycache__/source.cpython-313.pyc'
        self.put(pyc, b'untrusted generated pyc', 0o644, 1001)
        self.generated_bytecode.add(str(pyc.relative_to(self.release)))
        adapter, audit, review = self.adapter()
        with self.assertRaisesRegex(c.Refused, 'quarantine is incomplete'):
            c.run_steps(adapter, h, self.layout, audit, review)
        self.popen.assert_not_called()
        combined = self.normalizer.call_args.args[2]
        self.assertEqual(combined['quarantineDirectories'], [str(pyc.parent.relative_to(self.release))])
        self.assertEqual(combined['quarantineBytecode'][0]['path'], str(pyc.relative_to(self.release)))

    def test_normalization_union_fresh_snapshots_and_cache_alias_preservation(self):
        source = self.release / 'server/browser-engine/.venv/lib/example/source.py'
        self.put(source, b'authenticated fixture source\n', 0o644, 1001)
        alias = self.op / 'build-home/cache/shared-source.py'
        alias.parent.mkdir(parents=True, exist_ok=True)
        os.link(source, alias)
        pyc = source.parent / '__pycache__/source.cpython-313.pyc'
        self.put(pyc, b'generated fixture pyc', 0o644, 1001)
        self.generated_bytecode.add(str(pyc.relative_to(self.release)))
        archive_pyc = self.release / 'python/lib/archive.pyc'
        self.put(archive_pyc, b'archive-authenticated fixture pyc', 0o644, 1001)
        old_inode = self.real_stat(alias).st_ino
        def normalize(release, audit, proof):
            self.assertFalse(self.processes, 'Installed code executed before normalization')
            result = self.fixture_normalizer(release, audit, proof)
            self.assertEqual({row['path'] for row in proof['assertions']['ownedDirectories']} & c.RUNTIME_DIRS, c.RUNTIME_DIRS)
            for row in proof['verifiedFiles']:
                if row['nlink'] > 1:
                    path = release / row['path']
                    temporary = path.with_name(path.name + '.fixture-copy')
                    self.put(temporary, path.read_bytes(), row['mode'], row['uid'])
                    os.utime(temporary, ns=(row['mtimeNs'], row['mtimeNs']))
                    os.replace(temporary, path)
            for row in proof['quarantineBytecode']:
                (release / row['path']).unlink()
            for directory in proof['quarantineDirectories']:
                (release / directory).rmdir()
            return result
        self.normalizer.side_effect = normalize
        adapter, audit, review = self.adapter()
        self.wire_real_methods(adapter)
        c.run_steps(adapter, h, self.layout, audit, review)
        self.assertEqual(json.loads((self.op / 'status.json').read_text())['state'], 'ready')
        self.assertEqual(self.real_stat(alias).st_ino, old_inode)
        self.assertNotEqual(self.real_stat(source).st_ino, old_inode)
        self.assertEqual(os.stat(alias).st_uid, 1001)
        self.assertEqual(os.stat(source).st_uid, 0)
        self.assertFalse(pyc.exists())
        self.assertEqual(archive_pyc.read_bytes(), b'archive-authenticated fixture pyc')
        self.assertGreaterEqual(self.node_verify.call_count, 7)
        self.assertGreaterEqual(self.python_verify.call_count, 7)
        combined = self.normalizer.call_args.args[2]
        self.assertTrue(any(row['path'] == 'node/bin/node' and 'inode' in row for row in combined['verifiedFiles']))
        self.assertTrue((audit / 'pre-normalization-proof.json').exists())
        self.assertTrue((audit / 'post-normalization-proof.json').exists())

    def test_reference_and_staged_module_pins_are_not_manifest_overrides(self):
        audit, _ = self.stage()
        manifest = json.loads((audit / 'manifest.json').read_text())
        self.assertEqual(manifest['artifactReferences'], c.artifact_references())
        self.assertEqual(manifest['runtimeModuleSha256'], c.REVIEWED_MODULE_SHA256)
        for name, data in self.module_bytes.items():
            self.assertEqual((audit / name).read_bytes(), data)
        self.put(audit / c.NODE_MODULE, b'changed code')
        with self.assertRaises(c.Refused):
            c.validate_stage(h, self.layout, audit, h.Files())

    def test_probe_sandbox_matches_original_and_is_bounded_offline(self):
        audit = self.op / ('continuation-' + str(c.uuid.uuid4()))
        command = c.probe_command(h, self.layout, audit)
        for prop in ('User=outpost-coord', 'Group=outpost-coord', 'SupplementaryGroups=outpost-workspaces',
                     'NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
                     'UMask=0007', 'TasksMax=512', 'LimitNOFILE=8192', 'MemoryHigh=30%', 'MemoryMax=40%', 'CPUQuota=200%',
                     'IPAddressDeny=any', 'RuntimeMaxSec=120', 'KillMode=control-group', 'BindsTo=' + h.UNITS[0]):
            self.assertIn('--property=' + prop, command)
        self.assertIn('--wait', command)
        self.assertIn('--pipe', command)
        env_start = command.index('/usr/bin/env')
        self.assertEqual(command[env_start + 1], '-i')
        self.assertIn('HOME=' + str(self.layout.path('/var/lib/outpost-native/coordinator')), command)
        self.assertIn('--import', command)
        self.assertIn('tsx', command)
        script = command[-1]
        self.assertIn((self.release / 'server/browser/engine.ts').as_uri(), script)
        for assertion in ('openBrowser()', 'setContent(', 'page.title()', 'textContent()', 'page.screenshot(', 'png.subarray(0,8)', 'browser.close()'):
            self.assertIn(assertion, script)
        self.assertNotIn('goto(', script)
        self.assertNotIn('--no-sandbox', ' '.join(command))
        self.assertNotIn('MOZ_DISABLE', ' '.join(command))
        self.assertIn('return ["-B", launcher]', script)
        self.assertIn('syncBuiltinESMExports()', script)
        self.assertIn('assert.equal(launcherCalls, 1)', script)
        self.assertNotIn('EnvironmentFile', ' '.join(command))
        self.assertNotIn('worker-token', ' '.join(command))


if __name__ == '__main__':
    unittest.main()
