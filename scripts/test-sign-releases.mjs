import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectArchive, requiredTools, signArtifact } from './sign-releases.mjs';

const { privateKey } = generateKeyPairSync('ed25519');
const manifest = { schema: 2, id: 'host-12345678901234567890', protocolVersion: 2, layoutVersion: 1, compatibility: 'native-v1', sequence: 6,
  rollback: true, piVersion: '1.5.2', extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }, { name: 'pi-subagents', version: '0.88.1' }] };
const files = ['package.json', 'package-lock.json', 'server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs',
  'server/environment/update-checkpoint.ts', 'server/environment/qualify-runtime.ts', 'server/gateway/coordinator.ts',
  'server/gateway/http.ts', 'server/artifacts/workspace-review.ts', 'server/policy/trust.ts',
  'server/core/ledger.ts', 'server/scheduler/tools.ts', 'deploy/environment/auto_update.py'];
const bytes = Buffer.from('fixture archive');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = () => ({ schema: 1, id: manifest.id, manifest: structuredClone(manifest), sha256: hash(bytes), size: bytes.length, runtimePinsSha256: 'a'.repeat(64), requiredTools: [...requiredTools] });
const contents = () => ({ manifest: structuredClone(manifest), files: [...files], runtimePinsSha256: 'a'.repeat(64) });

test('publisher authorization signs exact bounded release contents and required capabilities', () => {
  const artifact = signArtifact(metadata(), bytes, privateKey, contents());
  const payload = Buffer.from(artifact.authorization.payload, 'base64');
  assert.ok(verify(null, payload, createPublicKey(privateKey), Buffer.from(artifact.authorization.signature, 'base64')));
  assert.deepEqual(JSON.parse(payload), { schema: 1, manifest, sha256: hash(bytes), size: bytes.length, runtimePinsSha256: 'a'.repeat(64), requiredTools });
  assert.equal(Buffer.from(artifact.authorization.publisherPublicKey, 'base64').length, 32);
  assert.equal(Buffer.from(artifact.authorization.signature, 'base64').length, 64);
  const changed = Buffer.from(payload); changed[0] ^= 1;
  assert.equal(verify(null, changed, createPublicKey(privateKey), Buffer.from(artifact.authorization.signature, 'base64')), false);
  const other = generateKeyPairSync('ed25519');
  assert.equal(verify(null, payload, other.publicKey, Buffer.from(artifact.authorization.signature, 'base64')), false);
});

test('refuses archive hash, size, pins and manifest mismatches before signing', () => {
  for (const patch of [{ sha256: 'b'.repeat(64) }, { size: bytes.length + 1 }, { id: 'host-00000000000000000000' }, { runtimePinsSha256: 'b'.repeat(64) }]) {
    assert.throws(() => signArtifact({ ...metadata(), ...patch }, bytes, privateKey, contents()));
  }
  for (const patch of [{ sequence: 0 }, { rollback: false }, { layoutVersion: 2 }, { schema: 1 }, { protocolVersion: 1 }, { compatibility: 'other' }]) {
    const changed = { ...manifest, ...patch };
    assert.throws(() => signArtifact({ ...metadata(), manifest: changed }, bytes, privateKey, { ...contents(), manifest: changed }));
  }
  assert.throws(() => signArtifact(metadata(), bytes, privateKey, { ...contents(), manifest: { ...manifest, sequence: 7 } }));
});

test('service entrypoints, workspace review API modules and automation schemas must be packaged', () => {
  for (const name of files) assert.throws(() => signArtifact(metadata(), bytes, privateKey, { ...contents(), files: files.filter(path => path !== name) }), /Incomplete release/);
  for (const tools of [[], requiredTools.slice(1), [...requiredTools, 'unknown.tool']]) assert.throws(() => signArtifact({ ...metadata(), requiredTools: tools }, bytes, privateKey, contents()));
});

function archiveFixture(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-signing-'));
  const path = join(root, 'release.tar.gz');
  execFileSync('python3', ['-c', `import io,json,sys,tarfile
p=json.load(sys.stdin)
with tarfile.open(sys.argv[1],'w:gz') as archive:
 for entry in p:
  info=tarfile.TarInfo(entry['name'])
  if entry.get('type')=='symlink': info.type=tarfile.SYMTYPE;info.linkname='/etc/passwd';archive.addfile(info)
  elif entry.get('type')=='hardlink': info.type=tarfile.LNKTYPE;info.linkname='host-manifest.json';archive.addfile(info)
  else:
   data=entry.get('data','fixture').encode();info.size=len(data);archive.addfile(info,io.BytesIO(data))
`, path], { input: JSON.stringify([{ name: './host-manifest.json', data: JSON.stringify(manifest) }, { name: './deploy/environment/runtime-pins.json', data: '{}' }, ...extra]), timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('archive inspection binds actual manifest and pins without executing source', () => {
  const fixture = archiveFixture([{ name: './server/main.ts', data: 'throw Error("MUST NOT RUN")' }]);
  try {
    assert.deepEqual(inspectArchive(fixture.path), { manifest, runtimePinsSha256: hash(Buffer.from('{}')), files: ['deploy/environment/runtime-pins.json', 'host-manifest.json', 'server/main.ts'] });
  } finally { fixture.cleanup(); }
});

test('a complete-looking archive without the workspace review module cannot be signed', () => {
  const fixture = archiveFixture(files.filter(name => name !== 'server/artifacts/workspace-review.ts').map(name => ({ name })));
  try {
    const snapshot = readFileSync(fixture.path), inspected = inspectArchive(snapshot);
    const value = { ...metadata(), sha256: hash(snapshot), size: snapshot.length, runtimePinsSha256: inspected.runtimePinsSha256 };
    assert.throws(() => signArtifact(value, snapshot, privateKey, inspected), /Incomplete release: server\/artifacts\/workspace-review\.ts/);
  } finally { fixture.cleanup(); }
});

test('signing inspects the captured bytes even when the archive pathname is replaced', () => {
  const fixture = archiveFixture(files.map(name => ({ name, data: 'fixture' })));
  try {
    const snapshot = readFileSync(fixture.path);
    writeFileSync(fixture.path, 'unrelated replacement');
    const inspected = inspectArchive(snapshot);
    const value = { ...metadata(), sha256: hash(snapshot), size: snapshot.length, runtimePinsSha256: inspected.runtimePinsSha256 };
    const signed = signArtifact(value, snapshot, privateKey, inspected);
    assert.equal(JSON.parse(Buffer.from(signed.authorization.payload, 'base64')).sha256, hash(snapshot));
    assert.throws(() => inspectArchive(fixture.path));
  } finally { fixture.cleanup(); }
});

for (const [label, entries] of [
  ['path traversal', [{ name: '../escape' }]], ['absolute paths', [{ name: '/etc/passwd' }]],
  ['symlinks', [{ name: 'link', type: 'symlink' }]], ['hardlinks', [{ name: 'link', type: 'hardlink' }]],
  ['normalized duplicates', [{ name: 'host-manifest.json' }]], ['parent file conflicts', [{ name: 'deploy' }]],
]) test(`archive inspection rejects ${label}`, () => {
  const fixture = archiveFixture(entries);
  try { assert.throws(() => inspectArchive(fixture.path)); } finally { fixture.cleanup(); }
});
