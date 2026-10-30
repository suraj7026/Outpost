import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('Swift package and Xcode project retain iPhone/shared targets, not a Mac application', () => {
  assert.equal(existsSync(new URL('clients/macOS', root)), false);
  assert.equal(existsSync(new URL('clients/build-mac.sh', root)), false);
  const manifest = read('clients/Package.swift');
  assert.doesNotMatch(manifest, /\.executable(?:Target)?\s*\(|OutpostMac|path:\s*"macOS"/);
  assert.match(manifest, /\.library\(name: "OutpostKit", targets: \["OutpostKit"\]\)/);
  assert.match(manifest, /\.target\(name: "OutpostKit", path: "Shared", resources: \[\.process\("Resources"\)\]\)/);
  assert.match(manifest, /\.testTarget\(name: "OutpostKitTests"/);

  const spec = read('clients/project.yml');
  assert.doesNotMatch(spec, /OutpostMac|macOS/);
  assert.match(spec, /OutpostPhone:\s+type: application\s+platform: iOS\s+sources: \[iOS\]/);
  assert.match(spec, /OutpostPhoneUITests:\s+type: bundle.ui-testing\s+platform: iOS\s+sources: \[UITests\]/);
  assert.match(spec, /product: OutpostKit/);
  assert.match(spec, /target: OutpostPhone/);

  const project = read('clients/Outpost.xcodeproj/project.pbxproj');
  assert.doesNotMatch(project, /OutpostMac|macOS|macosx|dev\.outpost\.mac\b/);
  const targets = [...project.matchAll(/\/\* (\w+) \*\/ = \{\s+isa = PBXNativeTarget;/g)].map(match => match[1]).sort();
  assert.deepEqual(targets, ['OutpostPhone', 'OutpostPhoneUITests']);
  assert.match(project, /productName = OutpostKit;/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.outpost\.ios;/);
  assert.match(project, /TEST_TARGET_NAME = OutpostPhone;/);
  assert.match(read('clients/iOS/OutpostApp.swift'), /@main struct OutpostPhoneApp: App/);
  assert.ok(existsSync(new URL('clients/iOS/Info.plist', root)));
});

test('retained iPhone and homelab resources include fonts, licences and the source catalogue', () => {
  for (const font of ['Geist-Regular', 'Geist-Medium', 'Geist-Semibold', 'GeistMono-Regular']) {
    const bytes = readFileSync(new URL(`clients/Shared/Resources/${font}.ttf`, root));
    assert.ok(bytes.length > 1000, font);
    assert.equal(bytes.readUInt32BE(0), 0x00010000, `${font} TrueType header`);
    assert.ok(read('clients/Shared/Design.swift').includes(`"${font}"`));
  }
  for (const licence of ['Geist-OFL.txt', 'GeistMono-OFL.txt']) {
    assert.match(read(`clients/Shared/Resources/${licence}`), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
  const features = JSON.parse(read('clients/Shared/Resources/features.json')) as { id: string }[];
  assert.equal(features.length, 270);
  assert.equal(new Set(features.map(feature => feature.id)).size, 270);
  assert.match(read('deploy/homelab/build-guide.mjs'), /clients\/Shared\/Resources/);
});

test('native UI runner rejects the retired Mac path before starting any fixture', () => {
  const result = spawnSync('bash', ['scripts/test-native-ui.sh', 'mac'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /iPhone simulator only/);
  assert.doesNotMatch(read('scripts/test-native-ui.sh'), /OutpostMac|platform=macOS/);
  assert.doesNotMatch(read('clients/UITests/OutpostUITests.swift'), /#if os\((?:macOS|iOS)\)/);
  assert.doesNotMatch(read('clients/Shared/Connection.swift'), /#if os\(macOS\)|Outpost Mac|Outpost\/bootstrap-token/);
});

test('active setup uses Tauri while historical Swift Mac evidence stays labelled', () => {
  for (const path of ['README.md', 'desktop/README.md', 'docs/implementation/RUNBOOK.md']) {
    assert.doesNotMatch(read(path), /clients\/build-mac\.sh|clients\/build\/Outpost\.app|clients\/macOS\/|OutpostMac|test-native-ui\.sh mac/);
    assert.match(read(path), /T0b/);
  }
  assert.ok(existsSync(new URL('desktop/build-mac.sh', root)));
  assert.ok(existsSync(new URL('desktop/src-tauri/native/sidebar.m', root)));
  for (const name of ['ACCEPTANCE', 'PLAN', 'DECISIONS']) {
    assert.match(read(`docs/implementation/${name}.md`), /Historical record — superseded/);
  }
});
