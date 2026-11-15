import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('all Swift clients, shared resources and Xcode targets are deliberately retired', () => {
  const directory = new URL('clients/', root);
  // An attached Swift language server can recreate its index after source removal.
  const entries = existsSync(directory) ? readdirSync(directory).filter(name => name !== '.build' && name !== '.DS_Store') : [];
  assert.deepEqual(entries, []);
});

test('retired iPhone UI and specification generation tools are not advertised as package commands', () => {
  for (const path of ['scripts/test-native-ui.sh', 'scripts/generate-contracts.mjs']) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
  const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts.contracts, undefined);
  for (const command of Object.values(manifest.scripts)) {
    assert.doesNotMatch(command, /generate-contracts|test-native-ui|\bclients\/|\bspec\/|\bswift\b|\bxcodegen\b/);
  }
  assert.equal(manifest.scripts.qualify, 'node scripts/qualify.mjs');
});

test('active setup retains Tauri and Recovery Hold safety guidance', () => {
  for (const path of ['README.md', 'desktop/README.md']) {
    assert.doesNotMatch(read(path), /clients\/build-mac\.sh|clients\/build\/Outpost\.app|clients\/macOS\/|OutpostMac|test-native-ui\.sh mac/);
    assert.match(read(path), /Tauri/);
    assert.match(read(path), /Recovery Hold/);
    assert.doesNotMatch(read(path), /T0b gap|Pending T0b|controls are not implemented in Tauri|Client limitation \(T0a\)/);
  }
  assert.ok(existsSync(new URL('desktop/build-mac.sh', root)));
  assert.ok(existsSync(new URL('desktop/src-tauri/native/sidebar.m', root)));
  assert.match(read('desktop/build-mac.sh'), /codesign --verify --deep --strict/);
});

test('retained Mac transport preserves identity and refuses unsafe remote endpoints and unknown commands', () => {
  const transport = read('desktop/src-tauri/src/transport.rs');
  assert.match(transport, /get_generic_password\("dev\.outpost\.identity", "device"\)/);
  assert.match(transport, /Use HTTPS or localhost HTTP, without embedded credentials/);
  assert.match(transport, /Resolve the unknown pending command before enrolling another device/);
  assert.match(transport, /A previous command has an unknown outcome\. Retry that command first\./);
});

test('held-reset recovery retains the exact qualification record and fail-closed helper gates', () => {
  const path = 'scripts/fixtures/linux-qualification-final-18.json';
  const evidence = read(path);
  assert.equal(sha256(evidence), '69f8a60985836af850a647dcde3f061c7ff69b43c7e305750972784813f857e5');
  const qualification = JSON.parse(evidence);
  const digest = sha256(read('desktop/src-tauri/src/setup_restart_helper.py'));
  assert.equal(digest, 'b47fca46be69ab592314a69b24c96b51e467a8def0ecb2d2e5db8d9aa794fc8d');
  assert.equal(qualification.qualificationPassed, true);
  assert.equal(qualification.testedHelperSha256, digest);
  assert.equal(qualification.sourcesUnchangedDuringRun, true);

  const launcher = read('scripts/recover-outpost2-native.command');
  assert.ok(launcher.includes(`Path('${path}')`));
  assert.ok(launcher.includes(`digest != '${digest}'`));
  assert.match(launcher, /qualification\.get\('qualificationPassed'\) is not True/);
  assert.match(launcher, /qualification\.get\('testedHelperSha256'\) != digest/);
  assert.match(launcher, /qualification\.get\('sourcesUnchangedDuringRun'\) is not True/);
  assert.match(launcher, /if set\(records\) != \{reset_id\}:/);
  assert.match(launcher, /record\['remoteComplete'\] or record\['localComplete'\]/);
  assert.match(launcher, /record\['fresh'\]\['id'\] != '2e1c768b-fb41-4f33-912e-a86cbc038098'/);
  assert.match(launcher, /if probe\.returncode != 1:/);
  assert.match(launcher, /Another native operator is running; do not overlap recovery attempts/);
  assert.match(launcher, /python3 -B - <<'PY' \|\| exit 1/);
});
