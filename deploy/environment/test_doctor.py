"""Exercise the doctor against disposable native filesystem trees."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class DoctorTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.prefix = self.root / 'opt/outpost-native'
        self.release = self.prefix / 'releases/fixture'
        self.put(self.release / 'node/bin/node', 0o755)
        (self.prefix / 'current').symlink_to(self.release)
        self.config = self.root / 'etc/outpost-native'
        data = self.root / 'var/lib/outpost-native'
        for role, mode in [('coordinator', 0o700), ('worker', 0o700), ('workspaces', 0o2770)]:
            path = data / role
            path.mkdir(parents=True)
            path.chmod(mode)
        for role, user, entry in [('coordinator', 'outpost-coord', 'server/main.ts'),
                                  ('worker', 'outpost-pi', 'server/pi-worker/main.ts')]:
            self.put(self.config / f'{role}.env', 0o600, 'DO_NOT_PRINT=secret')
            installed = '/opt/outpost-native/releases/fixture'
            self.put(self.root / f'etc/systemd/system/outpost-native-{role}.service', 0o644,
                     f'[Service]\nUser={user}\nEnvironmentFile=/etc/outpost-native/{role}.env\n'
                     f'ExecStart={installed}/node/bin/node --import tsx {installed}/{entry}\n')

    @staticmethod
    def put(path, mode, contents='not a real executable'):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        path.chmod(mode)

    def doctor(self, *args):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('doctor.py')), '--root',
                               str(self.root), *args], text=True, capture_output=True, timeout=10)

    def test_clean_fixture(self):
        result = self.doctor('--check')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_check_is_read_only_and_fix_is_idempotent(self):
        env = self.config / 'worker.env'
        env.chmod(0o644)
        result = self.doctor('--check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Config permissions', result.stdout)
        self.assertNotIn('DO_NOT_PRINT', result.stdout)
        self.assertEqual(env.stat().st_mode & 0o777, 0o644)
        for _ in range(2):
            result = self.doctor('--fix')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(env.stat().st_mode & 0o777, 0o600)

    def test_aged_uv_lock_and_broken_symlink_are_not_removed(self):
        lock = self.root / 'locks/uv-example.lock'
        self.put(lock, 0o600, '')
        os.utime(lock, (1, 1))
        node = self.release / 'node/bin/node'
        node.unlink()
        node.symlink_to('missing')
        result = self.doctor('--fix', '--uv-lock-dir', str(lock.parent))
        self.assertEqual(result.returncode, 1)
        self.assertIn('old empty lock candidate', result.stdout)
        self.assertIn('Node:', result.stdout)
        self.assertTrue(lock.is_file())
        self.assertTrue(node.is_symlink())

    def test_fix_refuses_symlink_and_hardlink(self):
        target = self.root / 'unrelated'
        self.put(target, 0o644)
        for env, link in [(self.config / 'worker.env', lambda p: p.symlink_to(target)),
                          (self.config / 'coordinator.env', lambda p: os.link(target, p))]:
            env.unlink()
            link(env)
        result = self.doctor('--fix')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.count('Config permissions'), 2)
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)

    def test_browser_profile_and_cache_metadata(self):
        project = self.release / 'server/browser-engine'
        self.put(project / '.venv/bin/python', 0o755)
        self.put(project / 'uv.lock', 0o644, '[[package]]\nname = "fixture"\n')
        self.put(self.release / 'node/bin/uv', 0o755)
        pins = dict(camoufoxVersion='1', camoufoxBuild='2', camoufoxInterface=1, camoufoxSha256='fixture')
        self.put(self.release / 'deploy/environment/runtime-pins.json', 0o644, json.dumps(pins))
        cache = self.release / 'browsers/camoufox/browsers/official/1-2'
        self.put(cache / 'camoufox-bin', 0o755)
        marker = cache / 'version.json'
        self.put(marker, 0o644, json.dumps(dict(version='1', build='2', interface=1, sha256='fixture')))
        result = self.doctor('--check', '--browser')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.put(marker, 0o644, '{}')
        self.assertIn('Browser cache', self.doctor('--check', '--browser').stdout)
