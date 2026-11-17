"""Privileged boundaries mocked; real Ed25519 signatures and disposable SQLite/tars."""
import base64
import copy
import gzip
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import auto_update as auto

NODE = shutil.which('node')
RUN = subprocess.run
LSTAT = Path.lstat


def b64(value):
    return base64.b64encode(value).decode('ascii')


@unittest.skipUnless(NODE, 'Node required for real Ed25519 tests')
class AutoUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        keys = RUN([NODE, '-e', "const c=require('node:crypto');console.log(JSON.stringify([1,2,3].map(()=>{const k=c.generateKeyPairSync('ed25519');return {public:k.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),private:k.privateKey.export({format:'pem',type:'pkcs8'})}})))"],
                   capture_output=True, check=True, timeout=10)
        cls.publisher, cls.device, cls.stranger = json.loads(keys.stdout)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        for name in ('CONFIG', 'DATA', 'OPERATIONS', 'PREFIX', 'LIBRARY', 'HELPER', 'SUDOERS'):
            path = self.root / name if name not in ('HELPER', 'SUDOERS') else self.root / name.lower() / name
            patcher = patch.object(auto, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        for directory in (auto.CONFIG, auto.DATA, auto.PREFIX, auto.OPERATIONS):
            directory.mkdir()
        self.commands = []
        patcher = patch.object(auto.subprocess, 'run', side_effect=self.command)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(auto.os, 'geteuid', return_value=0)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(auto.pwd, 'getpwnam', side_effect=lambda name: SimpleNamespace(pw_uid=0 if name == 'root' else 501))
        patcher.start()
        self.addCleanup(patcher.stop)
        # Simulate root ownership only inside this disposable fixture. Ancestor directory
        # permissions are synthetic too (macOS /tmp is not a Linux deployment root).
        def root_stat(path):
            result = LSTAT(path)
            if path == self.root or self.root in path.parents or path in self.root.parents:
                values = list(result)
                values[4] = 0
                if path in self.root.parents:
                    values[0] = stat.S_IFDIR | 0o755
                return os.stat_result(values)
            return result
        patcher = patch.object(Path, 'lstat', root_stat)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.source = dict(schema=2, id='host-' + 'a'*20, protocolVersion=2, layoutVersion=1,
                           compatibility='native-v1', sequence=1, piVersion='1.4.0', extensions=[], rollback=True)
        self.target = dict(self.source, id='host-' + 'b'*20, sequence=2)
        self.policy = dict(environmentId=str(uuid.uuid4()), deviceId=str(uuid.uuid4()),
                           publisherPublicKey=self.publisher['public'], sshUser='alice')
        self.installation = dict(schema=1, layoutVersion=1, environmentId=self.policy['environmentId'],
                                 release=self.source['id'], fullControl=True)
        self.previous = auto.PREFIX / 'releases' / self.source['id']
        self.previous.mkdir(parents=True)
        (auto.PREFIX / 'current').symlink_to(self.previous)
        (self.previous / 'host-manifest.json').write_text(json.dumps(self.source))
        (self.previous / 'node/bin').mkdir(parents=True)
        (self.previous / 'node/bin/node').write_bytes(b'fixture interpreter')
        (self.previous / 'deploy/environment').mkdir(parents=True)
        self.pins = b'{"pin":"fixture"}'
        (self.previous / 'deploy/environment/runtime-pins.json').write_bytes(self.pins)
        (auto.CONFIG / 'installation.json').write_text(json.dumps(self.installation))
        (auto.DATA / 'coordinator').mkdir()
        self.db = sqlite3.connect(auto.DATA / 'coordinator/ledger.sqlite')
        self.addCleanup(self.db.close)
        self.db.executescript('CREATE TABLE installation_identity(singleton INTEGER PRIMARY KEY, environment_id TEXT); CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));')
        self.db.execute('INSERT INTO installation_identity VALUES(1,?)', (self.policy['environmentId'],))
        self.put('device', self.policy['deviceId'], dict(publicKey=self.device['public'], revoked=False))
        self.sources = (b'"""Audited helper fixture."""\n', b'"""Audited installer fixture."""\n', b'"""Audited updater fixture."""\n')
        self.public = auto.enroll(self.policy, *self.sources)
        self.files = {name: b'// fixture service\n' for name in auto.REQUIRED_FILES}
        for name in ('server/gateway/coordinator.ts', 'server/policy/trust.ts', 'server/core/ledger.ts', 'server/scheduler/tools.ts'):
            self.files[name] = b'// fixture catalogue'
        self.files.update({'host-manifest.json': json.dumps(self.target).encode(),
                           'package.json': json.dumps({'dependencies': {'@earendil-works/pi-coding-agent': '1.4.0'}}).encode(),
                           'package-lock.json': b'{"lockfileVersion":3,"packages":{}}',
                           'deploy/environment/runtime-pins.json': self.pins})
        self.request = dict(operationId=str(uuid.uuid4()), environmentId=self.policy['environmentId'], deviceId=self.policy['deviceId'],
                            releaseId=self.target['id'], expectedRelease=self.source['id'], target=self.target)
        self.payload = self.tar(self.files)
        self.request.update(sha256=auto.digest(self.payload), size=len(self.payload))
        self.signed = dict(schema=1, manifest=self.target, sha256=self.request['sha256'], size=self.request['size'],
                           runtimePinsSha256=auto.digest(self.pins), requiredTools=sorted(auto.REQUIRED_TOOLS))
        self.stage()
        self.commands.clear()

    def command(self, argv, **kwargs):
        self.commands.append(argv)
        if '--input-type=commonjs' in argv:
            self.assertEqual(kwargs['env'], auto.ENV)
            return RUN([NODE, *argv[1:]], **kwargs)
        self.assertIn(argv[0], ('/usr/sbin/visudo', '/usr/bin/systemd-run'))
        return SimpleNamespace(returncode=0)

    def put(self, kind, key, value):
        self.db.execute('INSERT OR REPLACE INTO records VALUES(?,?,?)', (kind, key, json.dumps(value)))
        self.db.commit()

    def stage(self, **changes):
        value = {key: self.request[key] for key in ('operationId', 'expectedRelease', 'target', 'sha256')}
        value.update(owner=self.policy['deviceId'], state='staging')
        value.update(changes)
        self.put('runtime_update', 'server', value)

    @staticmethod
    def tar(files, extra=()):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            for member, content in extra:
                archive.addfile(member, io.BytesIO(content) if content else None)
        return output.getvalue()

    def sign(self, payload, key):
        packet = json.dumps(dict(payload=b64(payload), key=key['private'])).encode()
        return RUN([NODE, '-e', "const c=require('node:crypto'),fs=require('node:fs'),p=JSON.parse(fs.readFileSync(0));process.stdout.write(c.sign(null,Buffer.from(p.payload,'base64'),p.key).toString('base64'))"],
                   input=packet, capture_output=True, check=True, timeout=10).stdout.decode()

    def header(self, request=None, signed=None):
        request_bytes = json.dumps(self.request if request is None else request, separators=(',', ':')).encode()
        signed_bytes = json.dumps(self.signed if signed is None else signed).encode()
        return dict(requestBase64=b64(request_bytes), deviceSignature=self.sign(request_bytes, self.device),
                    authorization=dict(payload=b64(signed_bytes), signature=self.sign(signed_bytes, self.publisher),
                                       publisherPublicKey=self.publisher['public']))

    def receive(self, header=None, payload=None):
        packet = json.dumps(header or self.header()).encode() + b'\n' + (self.payload if payload is None else payload)
        return auto.receive(io.BytesIO(packet))

    def assert_refused(self, header=None, payload=None):
        current = (auto.PREFIX / 'current').readlink()
        with self.assertRaises((ValueError, TypeError, KeyError, OSError, tarfile.TarError)):
            self.receive(header, payload)
        self.assertFalse(any(command[0] == '/usr/bin/systemd-run' for command in self.commands))
        self.assertFalse((auto.OPERATIONS / self.request['operationId']).exists())
        self.assertFalse((auto.PREFIX / 'releases' / self.target['id']).exists())
        self.assertEqual((auto.PREFIX / 'current').readlink(), current)

    def test_enrollment_exact_argument_grant_public_policy_and_same_policy_idempotency(self):
        self.assertEqual(auto.enroll(self.policy, *self.sources), self.public)
        self.assertEqual(auto.SUDOERS.read_text(), f'alice ALL=(root) NOPASSWD: {auto.HELPER} ""\n')
        self.assertEqual(auto.HELPER.read_bytes(), auto.LAUNCHER)
        self.assertEqual(auto.SUDOERS.stat().st_mode & 0o777, 0o440)
        self.assertEqual((auto.CONFIG / 'auto-update.json').stat().st_mode & 0o777, 0o644)
        public = (auto.CONFIG / 'auto-update.json').read_text()
        self.assertNotIn('PRIVATE KEY', public)
        self.assertNotIn('password', public.lower())
        self.assertNotIn('NOPASSWD: ALL', auto.SUDOERS.read_text())

    def test_enrollment_conflict_never_rewrites_policy_or_modules(self):
        before = (auto.CONFIG / 'auto-update.json').read_bytes()
        for change in ({'sshUser': 'bob'}, {'publisherPublicKey': self.stranger['public']}, {'deviceId': str(uuid.uuid4())}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                auto.enroll(dict(self.policy, **change), *self.sources)
        with self.assertRaises(ValueError):
            auto.enroll(self.policy, b'print("different")', *self.sources[1:])
        self.assertEqual(before, (auto.CONFIG / 'auto-update.json').read_bytes())
        self.assertEqual((auto.LIBRARY / 'auto_update.py').read_bytes(), self.sources[0])

    def test_enrollment_rejects_sudoers_user_injection_and_root(self):
        for user in ('root', 'alice ALL=(ALL)', '-alice', 'alice\nroot', 'alice:root'):
            with self.subTest(user=user), self.assertRaises(ValueError):
                auto.enroll(dict(self.policy, sshUser=user), *self.sources)

    def test_real_signatures_launch_only_installed_runner_and_replay_reads_receipt(self):
        header = self.header()
        result = self.receive(header)
        self.assertEqual(result['state'], 'queued')
        launch = [command for command in self.commands if command[0] == '/usr/bin/systemd-run']
        self.assertEqual(len(launch), 1)
        self.assertEqual(launch[0][-5:], ['/usr/bin/python3', '-I', str(auto.LIBRARY / 'auto_update.py'), '--run', str(auto.OPERATIONS / self.request['operationId'])])
        self.stage(state='finished')
        self.assertEqual(self.receive(header), result)
        self.assertEqual(len([command for command in self.commands if command[0] == '/usr/bin/systemd-run']), 1)
        operation = auto.OPERATIONS / self.request['operationId']
        metadata = json.loads((operation / 'authorization.json').read_text())
        self.assertEqual(metadata['requestSha256'], auto.digest(auto.decode(header['requestBase64'])))
        self.assertEqual(metadata['requiredTools'], sorted(auto.REQUIRED_TOOLS))
        self.assertEqual((operation / 'launch.log').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('signature', json.dumps(result).lower())
        self.assertNotIn('publicKey', json.dumps(result))
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_signature_verification_uses_original_json_order_and_whitespace(self):
        header = self.header()
        raw = json.dumps(dict(reversed(list(self.request.items()))), indent=2).encode()
        header.update(requestBase64=b64(raw), deviceSignature=self.sign(raw, self.device))
        self.assertEqual(self.receive(header)['state'], 'queued')

    def test_changed_bytes_invalid_signatures_and_wrong_publisher_fail(self):
        original = self.header()
        cases = []
        changed = copy.deepcopy(original)
        changed['requestBase64'] = b64(json.dumps(self.request, indent=2).encode())
        cases.append(changed)
        changed = copy.deepcopy(original)
        changed['deviceSignature'] = self.sign(auto.decode(changed['requestBase64']), self.stranger)
        cases.append(changed)
        changed = copy.deepcopy(original)
        changed['authorization']['signature'] = self.sign(auto.decode(changed['authorization']['payload']), self.stranger)
        cases.append(changed)
        changed = copy.deepcopy(original)
        changed['authorization']['publisherPublicKey'] = self.stranger['public']
        cases.append(changed)
        for header in cases:
            with self.subTest(header=cases.index(header)):
                self.assert_refused(header)

    def test_environment_source_operation_owner_and_hash_are_bound(self):
        for field, value in (('environmentId', str(uuid.uuid4())), ('deviceId', str(uuid.uuid4())),
                             ('expectedRelease', 'host-' + 'c'*20), ('operationId', str(uuid.uuid4()))):
            with self.subTest(field=field):
                self.assert_refused(self.header(request=dict(self.request, **{field: value})))
        for change in ({'owner': str(uuid.uuid4())}, {'sha256': 'f'*64}, {'expectedRelease': 'host-' + 'c'*20},
                       {'target': dict(self.target, sequence=8)}, {'state': 'cancelled'}, {'state': 'prepared'}, {'state': 'draining'}):
            self.stage(**change)
            self.assert_refused()

    def test_no_maintenance_record_is_never_created_or_repaired(self):
        self.db.execute("DELETE FROM records WHERE kind='runtime_update'")
        self.db.commit()
        self.assert_refused()
        self.assertIsNone(self.db.execute("SELECT data FROM records WHERE kind='runtime_update'").fetchone())

    def test_revoked_device_fails_intake_and_enrollment(self):
        self.put('device', self.policy['deviceId'], dict(publicKey=self.device['public'], revoked=True))
        self.assert_refused()
        with self.assertRaises(ValueError):
            auto.enroll(self.policy, *self.sources)

    def test_ledger_installation_identity_is_not_inferred_from_config(self):
        self.db.execute('UPDATE installation_identity SET environment_id=?', (str(uuid.uuid4()),))
        self.db.commit()
        self.assert_refused()

    def test_manifest_sequence_compatibility_shape_and_pins_fail(self):
        for change in ({'sequence': 1}, {'sequence': True}, {'sequence': 0}, {'compatibility': 'other'},
                       {'protocolVersion': 3}, {'schema': True}, {'layoutVersion': True}, {'rollback': False}, {'unexpected': True}):
            target = dict(self.target, **change)
            with self.subTest(change=change):
                self.assert_refused(self.header(request=dict(self.request, target=target), signed=dict(self.signed, manifest=target)))
        for change in ({'runtimePinsSha256': 'f'*64}, {'size': self.request['size'] + 1}, {'sha256': 'f'*64},
                       {'requiredTools': ['automation.list', 'automation.list']}, {'requiredTools': ['../../bin/sh']}, {'schema': True}):
            with self.subTest(change=change):
                self.assert_refused(self.header(signed=dict(self.signed, **change)))

    def test_current_release_path_permissions_and_policy_symlinks_fail(self):
        (self.previous / 'node/bin/node').chmod(0o666)
        self.assert_refused()
        (self.previous / 'node/bin/node').chmod(0o644)
        current = auto.PREFIX / 'current'
        current.unlink()
        current.symlink_to(self.root)
        self.assert_refused()
        current.unlink()
        current.symlink_to(self.previous)
        policy = auto.CONFIG / 'auto-update.json'
        other = self.root / 'policy-copy'
        policy.rename(other)
        policy.symlink_to(other)
        self.assert_refused()

    def test_release_directory_symlink_cannot_hide_an_external_tree(self):
        external = self.root / 'external-dependencies'
        external.mkdir()
        (external / 'mutable.js').write_text('untrusted dependency')
        (self.previous / 'dependencies').symlink_to(external)
        self.assert_refused()

    def test_library_tampering_fails_before_signature_or_launch(self):
        (auto.LIBRARY / 'host_update.py').write_text('print("unreviewed")')
        self.assert_refused()
        self.assertEqual(self.commands, [])

    def test_archive_hash_short_and_trailing_bytes_fail(self):
        for payload in (self.payload[:-1], self.payload + b'extra', b'x'*len(self.payload)):
            self.assert_refused(payload=payload)

    def check_archive(self, payload, *, tools=None):
        request = dict(self.request, sha256=auto.digest(payload), size=len(payload))
        signed = dict(self.signed, sha256=request['sha256'], size=request['size'])
        if tools is not None:
            signed['requiredTools'] = tools
        return auto.archive(payload, request, signed)

    def test_tar_missing_entrypoints_manifest_package_and_pins_fail(self):
        for name in auto.REQUIRED_FILES:
            files = dict(self.files)
            del files[name]
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check_archive(self.tar(files))
        for name, value in (('host-manifest.json', json.dumps(self.source).encode()),
                            ('deploy/environment/runtime-pins.json', b'new pins'),
                            ('package.json', b'{"dependencies":{}}')):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check_archive(self.tar(dict(self.files, **{name: value})))

    def test_tar_traversal_absolute_duplicate_alias_links_devices_and_file_parents_fail(self):
        members = []
        for name in ('../escape', '/absolute', 'server/../../escape', 'server\\main.ts', './server/main.ts'):
            member = tarfile.TarInfo(name)
            member.size = 1
            members.append((member, b'x'))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            member = tarfile.TarInfo('unsafe')
            member.type = kind
            member.linkname = 'server/main.ts'
            members.append((member, b''))
        for member in members:
            with self.subTest(name=member[0].name, type=member[0].type), self.assertRaises(ValueError):
                self.check_archive(self.tar(self.files, [member]))
        with self.assertRaises(ValueError):
            self.check_archive(self.tar(dict(self.files, server=b'parent is a file')))

    def test_tar_decompression_and_member_count_bounded(self):
        with patch.object(auto, 'EXPANDED_LIMIT', 1024), self.assertRaises(ValueError):
            self.check_archive(gzip.compress(b'\0'*2048))
        with patch.object(auto, 'FILE_LIMIT', 2), self.assertRaises(ValueError):
            self.check_archive(self.payload)

    def test_required_tool_source_files_and_large_lockfile(self):
        files = dict(self.files)
        del files['server/scheduler/tools.ts']
        with self.assertRaises(ValueError):
            self.check_archive(self.tar(files), tools=['automation.list'])
        files = dict(self.files)
        for name in ('server/gateway/coordinator.ts', 'server/policy/trust.ts', 'server/core/ledger.ts', 'server/scheduler/tools.ts'):
            files[name] = b'// audited tool fixture'
        files['package-lock.json'] = json.dumps({'lockfileVersion': 3, 'packages': {}, 'fixture': 'x'*100000}).encode()
        self.assertIn('server/scheduler/tools.ts', self.check_archive(self.tar(files), tools=['automation.list']))

    def test_header_bounds_duplicates_constants_utf8_and_extra_fields(self):
        for raw in (b'{}'*32769 + b'\n', b'{}', b'{"a":1,"a":2}\n', b'{"a":NaN}\n', b'{"a":1e999}\n', b'\xff\n'):
            with self.subTest(raw=raw[:30]), self.assertRaises((ValueError, UnicodeError)):
                auto.receive(io.BytesIO(raw))
        self.assert_refused(dict(self.header(), command='/bin/sh'))
        header = self.header()
        header['requestBase64'] = b64(b'{"size":1,"size":2}')
        self.assert_refused(header)
        header = self.header()
        header['deviceSignature'] = 'not base64'
        self.assert_refused(header)

    def test_existing_operation_conflict_and_unknown_never_relaunch(self):
        def uncertain(argv, **kwargs):
            if argv[0] == '/usr/bin/systemd-run':
                self.commands.append(argv)
                raise subprocess.TimeoutExpired(argv, 20)
            return self.command(argv, **kwargs)
        header = self.header()
        with patch.object(auto.subprocess, 'run', side_effect=uncertain):
            result = self.receive(header)
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(self.receive(header), result)
        self.assertEqual(len([cmd for cmd in self.commands if cmd[0] == '/usr/bin/systemd-run']), 1)
        changed = dict(self.request, expectedRelease='host-' + 'c'*20)
        with self.assertRaises(ValueError):
            self.receive(self.header(request=changed))
        self.assertEqual(len([cmd for cmd in self.commands if cmd[0] == '/usr/bin/systemd-run']), 1)

    def test_existing_ordinary_operation_cannot_acquire_helper_authority(self):
        operation = auto.OPERATIONS / self.request['operationId']
        operation.mkdir()
        (operation / 'request.json').write_text(json.dumps(self.request))
        with self.assertRaises(FileNotFoundError):
            self.receive()
        self.assertFalse((operation / 'authorization.json').exists())
        self.assertFalse(any(command[0] == '/usr/bin/systemd-run' for command in self.commands))

    def test_no_arguments_launcher_internal_directory_validation_and_safe_errors(self):
        # Execute the literal launcher with a harmless extra arg: import must never occur.
        result = RUN([shutil.which('python3'), '-I', str(auto.HELPER), '--run'], capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'No arguments permitted', result.stderr)
        for value in ('/tmp/operation', str(auto.OPERATIONS / '../escape'), str(auto.OPERATIONS / 'not-a-uuid')):
            with self.assertRaises(ValueError):
                auto.run_operation(value)
        with patch.object(auto, 'receive', side_effect=RuntimeError('private-password-canary')), patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(auto.main([]), 1)
            self.assertNotIn('private-password-canary', output.getvalue())
            self.assertLess(len(output.getvalue()), auto.HEADER_LIMIT)
        with patch.object(auto, 'receive') as receive, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(auto.main(['--enroll']), 1)
            receive.assert_not_called()

    def test_internal_runner_is_one_shot_and_revalidates_revocation(self):
        self.receive()
        operation = auto.OPERATIONS / self.request['operationId']
        with patch.object(auto.AuthorizedUpdater, '__init__', return_value=None), patch.object(auto.AuthorizedUpdater, 'execute_locked') as execute:
            auto.run_operation(str(operation))
            execute.assert_called_once()
            with self.assertRaises(FileExistsError):
                auto.run_operation(str(operation))
        self.put('device', self.policy['deviceId'], dict(publicKey=self.device['public'], revoked=True))
        updater = object.__new__(auto.AuthorizedUpdater)
        updater.operation, updater.request = operation, self.request
        with self.assertRaises(ValueError), patch.object(auto.host_update.Updater, 'preflight') as preflight:
            updater.preflight()
            preflight.assert_not_called()

    def test_root_path_checks_reject_group_writes_hardlinks_and_symlink_ancestors(self):
        path = self.root / 'checked'
        path.write_text('fixture')
        path.chmod(0o664)
        with self.assertRaises(ValueError):
            auto.secure_path(path)
        path.chmod(0o644)
        linked = self.root / 'hardlink'
        os.link(path, linked)
        with self.assertRaises(ValueError):
            auto.secure_path(path)
        linked.unlink()
        directory = self.root / 'link-directory'
        directory.symlink_to(auto.LIBRARY)
        with self.assertRaises(ValueError):
            auto.secure_path(directory / 'auto_update.py')
        fixture_lstat = Path.lstat
        def wrong_owner(value):
            result = fixture_lstat(value)
            if value == path:
                fields = list(result)
                fields[4] = 501
                return os.stat_result(fields)
            return result
        with patch.object(Path, 'lstat', wrong_owner), self.assertRaises(ValueError):
            auto.secure_path(path)

    def test_replay_requires_exact_signed_request_bytes_and_authorization(self):
        self.receive()
        header = self.header()
        raw = json.dumps(self.request, indent=2).encode()
        header.update(requestBase64=b64(raw), deviceSignature=self.sign(raw, self.device))
        with self.assertRaises(ValueError):
            self.receive(header)
        with self.assertRaises(ValueError):
            self.receive(self.header(signed=dict(self.signed, requiredTools=['automation.list'])))
        self.assertEqual(len([command for command in self.commands if command[0] == '/usr/bin/systemd-run']), 1)

    def test_runner_rechecks_cancelled_maintenance_without_repairing_it(self):
        self.receive()
        self.stage(state='cancelled')
        operation = auto.OPERATIONS / self.request['operationId']
        for name in ('CONFIG', 'DATA', 'PREFIX', 'OPERATIONS'):
            patcher = patch.object(auto.host_update, name, getattr(auto, name))
            patcher.start()
            self.addCleanup(patcher.stop)
        with patch.object(auto.host_update.Updater, 'checkpoint') as checkpoint, \
                patch.object(auto.host_update.Updater, 'stage') as stage, \
                patch.object(auto.host_update.Updater, 'switch') as switch, \
                patch.object(auto.host_update.Updater, 'release_hold') as release:
            auto.run_operation(str(operation))
            checkpoint.assert_called_once_with('abort')
            stage.assert_not_called()
            switch.assert_not_called()
            release.assert_not_called()
        self.assertEqual(json.loads((operation / 'status.json').read_text())['state'], 'failed')
        staged = json.loads(self.db.execute("SELECT data FROM records WHERE kind='runtime_update'").fetchone()[0])
        self.assertEqual(staged['state'], 'cancelled')
        self.assertEqual((auto.PREFIX / 'current').readlink(), self.previous)

    def test_enrollment_rejects_preexisting_unsafe_or_partial_paths(self):
        (auto.CONFIG / 'auto-update.json').unlink()
        # A policy missing from an otherwise enrolled machine must never be silently recreated.
        with self.assertRaises(ValueError):
            auto.enroll(self.policy, *self.sources)
        self.assertFalse((auto.CONFIG / 'auto-update.json').exists())
        shutil.rmtree(auto.LIBRARY)
        auto.HELPER.unlink()
        auto.SUDOERS.unlink()
        auto.LIBRARY.symlink_to(self.previous)
        with self.assertRaises(ValueError):
            auto.enroll(self.policy, *self.sources)
        self.assertFalse((auto.CONFIG / 'auto-update.json').exists())

    def test_main_bounds_stalled_input_and_never_exposes_timeout_details(self):
        with patch.object(auto, 'receive', side_effect=TimeoutError('private-timeout')), \
                patch.object(auto.signal, 'alarm') as alarm, patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(auto.main([]), 1)
            self.assertEqual([call.args[0] for call in alarm.call_args_list], [120, 0])
            self.assertNotIn('private-timeout', output.getvalue())

    def test_signed_empty_or_incomplete_mandatory_tool_set_is_refused(self):
        for tools in ([], ['automation.list'], ['automation.list', 'automation.save'],
                      ['automation.list', 'automation.set_paused'], ['automation.save', 'automation.set_paused']):
            with self.subTest(tools=tools):
                self.assert_refused(self.header(signed=dict(self.signed, requiredTools=tools)))

    def test_systemd_child_waits_for_intake_lock_before_claiming_and_executes_once(self):
        threads, errors = [], []
        scheduled = threading.Event()
        executed = threading.Event()
        operation = auto.OPERATIONS / self.request['operationId']

        def child():
            scheduled.set()
            try:
                auto.run_operation(str(operation))
            except Exception as error:
                errors.append(error)

        def launch(argv, **kwargs):
            if argv[0] != '/usr/bin/systemd-run':
                return self.command(argv, **kwargs)
            self.commands.append(argv)
            thread = threading.Thread(target=child)
            threads.append(thread)
            thread.start()
            self.assertTrue(scheduled.wait(2))
            self.assertFalse(executed.wait(0.1))
            self.assertFalse((operation / 'runner.started').exists())
            return SimpleNamespace(returncode=0)

        def transaction():
            # Execution owns the shared installation lock; it must not acquire a second FD lock.
            with self.assertRaises(BlockingIOError), auto.installation_lock():
                pass
            executed.set()

        with patch.object(auto.subprocess, 'run', side_effect=launch), \
                patch.object(auto.AuthorizedUpdater, '__init__', return_value=None), \
                patch.object(auto.AuthorizedUpdater, 'execute_locked', side_effect=transaction) as execute:
            try:
                self.assertEqual(self.receive()['state'], 'queued')
                self.assertTrue(executed.wait(3))
            finally:
                for thread in threads:
                    thread.join(timeout=5)
            self.assertEqual(errors, [])
            self.assertFalse(any(thread.is_alive() for thread in threads))
            with self.assertRaises(FileExistsError):
                auto.run_operation(str(operation))
            execute.assert_called_once()
        self.assertTrue((operation / 'runner.started').is_file())

    def test_two_scheduled_runners_have_one_lock_protected_claim(self):
        self.receive()
        operation = auto.OPERATIONS / self.request['operationId']
        errors, threads = [], []
        ready = [threading.Event(), threading.Event()]
        def child(index):
            ready[index].set()
            try:
                auto.run_operation(str(operation))
            except Exception as error:
                errors.append(error)
        with patch.object(auto.AuthorizedUpdater, '__init__', return_value=None), \
                patch.object(auto.AuthorizedUpdater, 'execute_locked') as execute:
            try:
                with auto.installation_lock():
                    for index in range(2):
                        thread = threading.Thread(target=child, args=(index,))
                        threads.append(thread)
                        thread.start()
                    self.assertTrue(all(event.wait(2) for event in ready))
                    self.assertFalse((operation / 'runner.started').exists())
            finally:
                for thread in threads:
                    thread.join(timeout=5)
            self.assertFalse(any(thread.is_alive() for thread in threads))
            execute.assert_called_once()
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], FileExistsError)

    def test_runner_lock_timeout_does_not_consume_claim_or_execute(self):
        self.receive()
        operation = auto.OPERATIONS / self.request['operationId']
        with auto.installation_lock(), patch.object(auto, 'RUNNER_LOCK_SECONDS', 0.05), \
                patch.object(auto.AuthorizedUpdater, 'execute_locked') as execute:
            with self.assertRaises(TimeoutError):
                auto.run_operation(str(operation))
            execute.assert_not_called()
            self.assertFalse((operation / 'runner.started').exists())

    def test_replay_returns_allowlisted_taskless_catalogue_evidence(self):
        self.receive()
        operation = auto.OPERATIONS / self.request['operationId']
        status = json.loads((operation / 'status.json').read_text())
        status['health'] = {'releaseId': self.target['id'], 'stableSeconds': 8,
                            'requiredTools': sorted(auto.REQUIRED_TOOLS), 'privateToken': 'private-canary',
                            'services': [{'unit': 'outpost-native-worker.service', 'pid': 45, 'restarts': 0, 'secret': 'private-canary'}]}
        auto.atomic_json(operation / 'status.json', status, 0o644)
        receipt = self.receive()
        self.assertEqual(receipt['health']['requiredTools'], sorted(auto.REQUIRED_TOOLS))
        self.assertEqual(receipt['health']['releaseId'], self.target['id'])
        self.assertNotIn('private-canary', json.dumps(receipt))

    def refreshed_sources(self, revision=1):
        return tuple(value + f'\nREVISION = {revision}\n'.encode() for value in self.sources)

    def refresh(self, expected=None, sources=None, policy=None):
        return auto.reauthorize(self.policy if policy is None else policy,
                                self.public if expected is None else expected,
                                *(self.refreshed_sources() if sources is None else sources))

    def dispatch_path(self):
        class Executed(BaseException):
            pass
        source = auto.LAUNCHER.decode().replace('/usr/local/lib/outpost-updater', str(auto.LIBRARY))
        source = source.replace('/etc/outpost-native/auto-update.json', str(auto.CONFIG / 'auto-update.json'))
        with patch.object(auto.os, 'execv', side_effect=Executed) as execute, \
                patch.object(auto.sys, 'argv', [str(auto.HELPER)]), self.assertRaises(Executed):
            exec(compile(source, str(auto.HELPER), 'exec'), {'__name__': '__main__'})
        self.assertEqual(execute.call_args.args[0], '/usr/bin/python3')
        self.assertEqual(execute.call_args.args[1][:2], ['/usr/bin/python3', '-I'])
        return Path(execute.call_args.args[1][-1])

    def test_explicit_refresh_atomically_selects_complete_version_and_keeps_identity_and_grant(self):
        self.stage(state='finished')
        previous_grant = auto.SUDOERS.read_bytes()
        self.assertEqual(self.dispatch_path(), auto.LIBRARY / 'auto_update.py')
        public = self.refresh()
        self.assertEqual(set(public), set(self.public))
        self.assertEqual({key: public[key] for key in self.policy}, self.policy)
        self.assertNotEqual(public['sourcesSha256'], self.public['sourcesSha256'])
        root = auto.active_library(public)
        self.assertEqual(root, auto.LIBRARY / 'versions' / auto.version_id(public))
        self.assertEqual(self.dispatch_path(), root / 'auto_update.py')
        auto.verify_version(root, public)
        self.assertEqual(auto.SUDOERS.read_bytes(), previous_grant)
        self.assertEqual((auto.CONFIG / 'auto-update.json').stat().st_mode & 0o777, 0o644)
        for name, old, new in zip(auto.MODULE_NAMES, self.sources, self.refreshed_sources()):
            self.assertEqual((auto.LIBRARY / name).read_bytes(), old)
            self.assertEqual((root / name).read_bytes(), new)
            self.assertEqual((root / name).stat().st_mode & 0o777, 0o644)
        self.assertEqual(auto.enroll(self.policy, *self.refreshed_sources()), public)
        with self.assertRaises(ValueError):
            auto.enroll(self.policy, *self.sources)
        self.assertEqual(self.commands, [])

    def test_refresh_requires_exact_full_reviewed_policy_and_unchanged_authorities(self):
        self.stage(state='finished')
        for expected in (self.policy, dict(self.public, schema=True), dict(self.public, unreviewed=True),
                         dict(self.public, sourcesSha256=dict(self.public['sourcesSha256'], **{'host_update.py': 'f'*64}))):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                self.refresh(expected=expected)
        for key, value in (('environmentId', str(uuid.uuid4())), ('deviceId', str(uuid.uuid4())),
                           ('publisherPublicKey', self.stranger['public']), ('sshUser', 'bob')):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.refresh(policy=dict(self.policy, **{key: value}))
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)
        self.assertFalse((auto.LIBRARY / 'versions').exists())

    def test_refresh_is_root_only_not_reachable_from_sudo_helper(self):
        self.stage(state='finished')
        with patch.object(auto.os, 'geteuid', return_value=501), self.assertRaises(ValueError):
            self.refresh()
        with patch.object(auto, 'reauthorize') as refresh, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(auto.main(['--reauthorize']), 1)
            refresh.assert_not_called()
        header = dict(self.header(), reauthorize=self.public)
        self.assert_refused(header)
        self.assertFalse((auto.LIBRARY / 'versions').exists())

    def test_refresh_refuses_active_maintenance_unreleased_holds_and_revocation(self):
        for state in ('staging', 'draining', 'holding', 'prepared', 'unknown'):
            self.stage(state=state)
            with self.subTest(state=state), self.assertRaises(ValueError):
                self.refresh()
        self.stage(state='finished')
        self.put('maintenance_checkpoint', 'server', {'state': 'prepared', 'expiresAt': 0})
        with self.assertRaises(ValueError):
            self.refresh()
        self.put('maintenance_checkpoint', 'server', {'state': 'completed'})
        self.put('device', self.policy['deviceId'], {'publicKey': self.device['public'], 'revoked': True})
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertFalse((auto.LIBRARY / 'versions').exists())
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)

    def test_refresh_refuses_queued_uncertain_missing_and_malformed_operation_receipts(self):
        self.stage(state='finished')
        operation = auto.OPERATIONS / self.request['operationId']
        operation.mkdir()
        for state in ('queued', 'staging', 'waiting_for_idle', 'activating', 'unknown', 'needs_attention'):
            auto.atomic_json(operation / 'status.json', {'operationId': operation.name, 'state': state})
            with self.subTest(state=state), self.assertRaises(ValueError):
                self.refresh()
        (operation / 'status.json').write_text('{"state":')
        with self.assertRaises(ValueError):
            self.refresh()
        (operation / 'status.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.refresh()
        self.assertFalse((auto.LIBRARY / 'versions').exists())
        auto.atomic_json(operation / 'status.json', {'operationId': operation.name, 'state': 'complete'})
        self.assertNotEqual(self.refresh(), self.public)

    def test_refresh_shares_installation_lock_through_staging_and_commit(self):
        self.stage(state='finished')
        with auto.installation_lock(), self.assertRaises(BlockingIOError):
            self.refresh()
        original = auto.stage_version
        def stage(*args):
            with self.assertRaises(BlockingIOError), auto.installation_lock():
                self.fail('refresh released its lock')
            return original(*args)
        with patch.object(auto, 'stage_version', side_effect=stage):
            self.refresh()

    def test_interrupted_partial_version_is_unselected_and_explicit_retry_recovers(self):
        self.stage(state='finished')
        original = auto.write_new
        def interrupt(path, content, mode):
            if path.parent.name == '.staging' and path.name == 'host_install.py':
                raise OSError('simulated interruption')
            original(path, content, mode)
        with patch.object(auto, 'write_new', side_effect=interrupt), self.assertRaises(OSError):
            self.refresh()
        self.assertTrue((auto.LIBRARY / 'versions/.staging/auto_update.py').is_file())
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)
        self.assertEqual(self.dispatch_path(), auto.LIBRARY / 'auto_update.py')
        public = self.refresh()
        self.assertFalse((auto.LIBRARY / 'versions/.staging').exists())
        self.assertEqual(self.dispatch_path(), auto.active_library(public) / 'auto_update.py')

    def test_legacy_launcher_migration_is_safe_before_policy_commit_and_retry_reuses_version(self):
        self.stage(state='finished')
        auto.HELPER.write_bytes(auto.LEGACY_LAUNCHER)
        def before_commit(*args, **kwargs):
            self.assertEqual(auto.HELPER.read_bytes(), auto.LAUNCHER)
            self.assertEqual(self.dispatch_path(), auto.LIBRARY / 'auto_update.py')
            raise OSError('simulated interruption before policy publication')
        with patch.object(auto, 'atomic_json', side_effect=before_commit), self.assertRaises(OSError):
            self.refresh()
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)
        versions = list((auto.LIBRARY / 'versions').iterdir())
        self.assertEqual(len(versions), 1)
        inode = (versions[0] / 'auto_update.py').stat().st_ino
        public = self.refresh()
        self.assertEqual((auto.active_library(public) / 'auto_update.py').stat().st_ino, inode)
        self.assertEqual(self.dispatch_path(), auto.active_library(public) / 'auto_update.py')

    def test_lost_reply_after_commit_requires_rereading_policy_not_replaying_old_consent(self):
        self.stage(state='finished')
        original = auto.atomic_json
        def committed(*args, **kwargs):
            original(*args, **kwargs)
            raise OSError('simulated lost response after commit')
        with patch.object(auto, 'atomic_json', side_effect=committed), self.assertRaises(OSError):
            self.refresh()
        public = auto.read_public(auto.CONFIG / 'auto-update.json')
        self.assertNotEqual(public, self.public)
        self.assertEqual(self.dispatch_path(), auto.active_library(public) / 'auto_update.py')
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertEqual(self.refresh(expected=public), public)

    def test_refresh_rechecks_maintenance_before_publication(self):
        self.stage(state='finished')
        original = auto.stage_version
        def stage(*args):
            result = original(*args)
            self.stage(state='staging')
            return result
        with patch.object(auto, 'stage_version', side_effect=stage), self.assertRaises(ValueError):
            self.refresh()
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)
        self.assertEqual(self.dispatch_path(), auto.LIBRARY / 'auto_update.py')

    def test_refresh_bounds_retained_versions_and_keeps_previous_immutable(self):
        self.stage(state='finished')
        current = self.public
        previous = None
        for revision in range(1, 5):
            sources = self.refreshed_sources(revision)
            current = self.refresh(expected=current, sources=sources)
            root = auto.active_library(current)
            self.assertLessEqual(len(list((auto.LIBRARY / 'versions').iterdir())), 2)
            if previous is not None:
                auto.verify_version(previous[0], previous[1])
            previous = (root, current)
        self.assertEqual(self.dispatch_path(), root / 'auto_update.py')

    def test_interrupted_retired_version_cleanup_recovers_without_touching_active_version(self):
        self.stage(state='finished')
        first = self.refresh()
        second = self.refresh(expected=first, sources=self.refreshed_sources(2))
        active = auto.active_library(second)
        original = Path.unlink
        count = 0
        def interrupt(path, *args, **kwargs):
            nonlocal count
            if path.parent.name == '.retired':
                count += 1
                if count == 2:
                    raise OSError('simulated interruption during retirement')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'unlink', interrupt), self.assertRaises(OSError):
            self.refresh(expected=second, sources=self.refreshed_sources(3))
        self.assertTrue((auto.LIBRARY / 'versions/.retired').exists())
        self.assertEqual(self.dispatch_path(), active / 'auto_update.py')
        auto.verify_version(active, second)
        third = self.refresh(expected=second, sources=self.refreshed_sources(3))
        self.assertFalse((auto.LIBRARY / 'versions/.retired').exists())
        self.assertEqual(self.dispatch_path(), auto.active_library(third) / 'auto_update.py')
        auto.verify_version(active, second)

    def test_interrupted_launcher_replacement_preserves_legacy_executable_and_retry_recovers(self):
        self.stage(state='finished')
        auto.HELPER.write_bytes(auto.LEGACY_LAUNCHER)
        original = auto.os.replace
        def interrupt(source, destination):
            if destination == auto.HELPER:
                raise OSError('simulated launcher replacement interruption')
            return original(source, destination)
        with patch.object(auto.os, 'replace', side_effect=interrupt), self.assertRaises(OSError):
            self.refresh()
        self.assertEqual(auto.HELPER.read_bytes(), auto.LEGACY_LAUNCHER)
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)
        self.assertTrue(auto.HELPER.with_name(auto.HELPER.name + '.refresh').is_file())
        public = self.refresh()
        self.assertEqual(auto.HELPER.read_bytes(), auto.LAUNCHER)
        self.assertFalse(auto.HELPER.with_name(auto.HELPER.name + '.refresh').exists())
        self.assertEqual(self.dispatch_path(), auto.active_library(public) / 'auto_update.py')

    def test_dispatcher_refuses_modified_or_symlinked_version_modules(self):
        self.stage(state='finished')
        public = self.refresh()
        root = auto.active_library(public)
        path = root / 'host_update.py'
        path.write_bytes(b'print("unreviewed code")')
        with self.assertRaises(SystemExit), patch('sys.stdout', new_callable=io.StringIO) as output:
            self.dispatch_path()
        self.assertNotIn('unreviewed code', output.getvalue())
        path.unlink()
        path.symlink_to(auto.LIBRARY / 'host_update.py')
        with self.assertRaises(SystemExit), patch('sys.stdout', new_callable=io.StringIO):
            self.dispatch_path()

    def test_refresh_never_deletes_unsafe_staging_or_unknown_version_paths(self):
        self.stage(state='finished')
        versions = auto.LIBRARY / 'versions'
        versions.mkdir()
        staging = versions / '.staging'
        staging.mkdir()
        canary = self.root / 'protected-refresh-canary'
        canary.write_bytes(b'private-preserve')
        (staging / 'host_install.py').symlink_to(canary)
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertEqual(canary.read_bytes(), b'private-preserve')
        self.assertTrue((staging / 'host_install.py').is_symlink())
        (staging / 'host_install.py').unlink()
        staging.rmdir()
        (versions / 'unreviewed').mkdir()
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertTrue((versions / 'unreviewed').is_dir())
        self.assertEqual(auto.read_public(auto.CONFIG / 'auto-update.json'), self.public)

    def test_post_refresh_intake_pins_runner_version_and_rejects_already_loaded_old_helper(self):
        self.stage(state='finished')
        public = self.refresh()
        root = auto.active_library(public)
        self.stage()
        with patch.object(auto, 'EXECUTING_LIBRARY', auto.LIBRARY), self.assertRaises(ValueError):
            self.receive()
        with patch.object(auto, 'EXECUTING_LIBRARY', root):
            result = self.receive()
        self.assertEqual(result['state'], 'queued')
        launch = [command for command in self.commands if command[0] == '/usr/bin/systemd-run']
        self.assertEqual(len(launch), 1)
        self.assertEqual(launch[0][-3], str(root / 'auto_update.py'))


if __name__ == '__main__':
    unittest.main()
