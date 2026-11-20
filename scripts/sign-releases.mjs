import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const service = 'dev.outpost.release-signing', account = 'publisher-v1';
export const requiredTools = Object.freeze(['automation.list', 'automation.save', 'automation.set_paused']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rawPublicKey = key => {
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  assert.equal(der.subarray(0, 12).toString('hex'), '302a300506032b6570032100');
  assert.equal(der.length, 44);
  return der.subarray(12).toString('base64');
};

export function loadSigningKey() {
  // CI may inject a private file; it is never bundled, logged or passed as an argument.
  if (process.env.OUTPOST_RELEASE_SIGNING_KEY_FILE) {
    const path = resolve(process.env.OUTPOST_RELEASE_SIGNING_KEY_FILE), info = lstatSync(path);
    if (!info.isFile() || (info.mode & 0o077) || info.size > 16384) throw Error('Publisher key must be a private regular file (0600).');
    const bytes = readFileSync(path);
    try {
      const key = createPrivateKey(bytes);
      assert.equal(key.asymmetricKeyType, 'ed25519');
      return key;
    } finally { bytes.fill(0); }
  }
  if (process.platform !== 'darwin') throw Error('Set OUTPOST_RELEASE_SIGNING_KEY_FILE to a private Ed25519 PEM file.');
  let bytes;
  try {
    bytes = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const der = Buffer.from(bytes.toString().trim(), 'base64');
    try {
      const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      assert.equal(key.asymmetricKeyType, 'ed25519');
      return key;
    } finally { der.fill(0); }
  } catch { throw Error('Publisher signing key unavailable. Run node scripts/sign-releases.mjs --init once, or allow Keychain access. Never replace an enrolled publisher key silently.'); }
  finally { bytes?.fill(0); }
}

function initializeKeychain() {
  if (process.platform !== 'darwin' || process.env.OUTPOST_RELEASE_SIGNING_KEY_FILE) throw Error('Keychain initialization is macOS-only and cannot replace an explicit CI key.');
  try {
    const existing = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account], { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    existing.fill(0);
    console.log('Existing publisher key retained. Public key:', rawPublicKey(loadSigningKey()));
    return;
  } catch (error) {
    if (error.status !== 44) throw Error('Unable to establish whether a publisher key already exists; no key created.');
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Interactive security input avoids exposing the key in process arguments or terminal output.
  const input = Buffer.from(`add-generic-password -s ${service} -a ${account} -w ${der.toString('base64')}\n`);
  try {
    execFileSync('/usr/bin/security', ['-i'], { input, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(rawPublicKey(loadSigningKey()), rawPublicKey(privateKey));
    console.log('Created build-only publisher key in macOS Keychain. Public key:', rawPublicKey(privateKey));
  } catch { throw Error('Publisher key creation was not confirmed. Inspect Keychain before trying again.'); }
  finally { input.fill(0); der.fill(0); }
}

export function signArtifact(metadata, bytes, key, contents) {
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(metadata.schema, 1);
  assert.equal(metadata.id, metadata.manifest.id);
  assert.equal(metadata.sha256, hash(bytes));
  assert.equal(metadata.size, bytes.length);
  assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024);
  const manifest = metadata.manifest;
  assert.deepEqual(Object.keys(manifest).sort(), ['schema', 'id', 'protocolVersion', 'layoutVersion', 'compatibility', 'sequence', 'rollback', 'piVersion', 'extensions'].sort());
  assert.ok(/^host-[a-f0-9]{20}$/.test(manifest.id));
  assert.equal(manifest.schema, 2); assert.equal(manifest.protocolVersion, 2); assert.equal(manifest.layoutVersion, 1);
  assert.equal(manifest.compatibility, 'native-v1'); assert.equal(manifest.rollback, true);
  assert.ok(Number.isSafeInteger(manifest.sequence) && manifest.sequence > 0);
  assert.deepEqual(contents.manifest, manifest);
  assert.equal(contents.runtimePinsSha256, metadata.runtimePinsSha256);
  assert.ok(/^[a-f0-9]{64}$/.test(metadata.runtimePinsSha256));
  const required = ['package.json', 'package-lock.json', 'server/main.ts', 'server/pi-worker/main.ts', 'deploy/agent/host-executor.mjs',
    'server/environment/update-checkpoint.ts', 'server/environment/qualify-runtime.ts', 'server/gateway/coordinator.ts',
    'server/gateway/http.ts', 'server/artifacts/workspace-review.ts', 'server/policy/trust.ts', 'server/core/ledger.ts', 'server/scheduler/tools.ts', 'deploy/environment/auto_update.py'];
  for (const path of required) assert.ok(contents.files.includes(path), `Incomplete release: ${path}`);
  assert.deepEqual(metadata.requiredTools, requiredTools);
  const payload = Buffer.from(JSON.stringify({ schema: 1, manifest, sha256: metadata.sha256, size: bytes.length,
    runtimePinsSha256: metadata.runtimePinsSha256, requiredTools }));
  const signature = sign(null, payload, key);
  assert.ok(verify(null, payload, createPublicKey(key), signature));
  return { ...metadata, authorization: { payload: payload.toString('base64'), signature: signature.toString('base64'), publisherPublicKey: rawPublicKey(key) } };
}

export function inspectArchive(input) {
  // Inspect the same immutable byte snapshot that will be signed, never reopen its pathname.
  const bytes = Buffer.isBuffer(input) ? input : readFileSync(input);
  const output = execFileSync('python3', ['-c', `import gzip,hashlib,io,json,pathlib,sys,tarfile
raw=sys.stdin.buffer.read(16*1024*1024+1)
assert 0<len(raw)<=16*1024*1024
with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
 expanded=compressed.read(128*1024*1024+1)
assert len(expanded)<=128*1024*1024
with tarfile.open(fileobj=io.BytesIO(expanded),mode='r:') as archive:
 files={};names=set()
 members=archive.getmembers();assert len(members)<=8192
 for member in members:
  path=pathlib.PurePosixPath(member.name)
  assert not path.is_absolute() and '..' not in path.parts and (member.isdir() or member.isfile()) and not member.issparse()
  name=path.as_posix()
  assert name not in names;names.add(name)
  if member.isfile(): files[name]=member
 assert sum(member.size for member in files.values())<=128*1024*1024
 for name in files:
  assert not any(parent.as_posix() in files for parent in pathlib.PurePosixPath(name).parents)
 manifest=json.load(archive.extractfile(files['host-manifest.json']))
 pins=archive.extractfile(files['deploy/environment/runtime-pins.json']).read()
 print(json.dumps({'files':sorted(files),'manifest':manifest,'runtimePinsSha256':hashlib.sha256(pins).hexdigest()}))
`], { input: bytes, timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(output);
}

export function signBundles(directory, key) {
  const outputs = [];
  for (const name of ['host-release', 'pi-release']) {
    const path = join(directory, `${name}.json`), archive = join(directory, `${name}.tar.gz`);
    const metadata = JSON.parse(readFileSync(path));
    const bytes = readFileSync(archive);
    outputs.push({ path, value: signArtifact(metadata, bytes, key, inspectArchive(bytes)) });
  }
  // Validate both before publishing either; a partial write can never authorize unsigned input.
  for (const { path, value } of outputs) {
    const temporary = path + '.signed';
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
    renameSync(temporary, path);
    console.log(`Signed ${value.id}: ${value.requiredTools.length} required automation tools; publisher ${value.authorization.publisherPublicKey}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--init') initializeKeychain();
  else if (!args.length) signBundles(join(root, 'desktop/src-tauri/resources'), loadSigningKey());
  else throw Error('Usage: node scripts/sign-releases.mjs [--init]');
}
