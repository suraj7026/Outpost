import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, linkSync, unlinkSync, renameSync, mkdirSync, openSync, closeSync, ftruncateSync, Dir, Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Ledger } from '../core/ledger.js';
import { Artifacts } from '../artifacts/files.js';
import { MemoryStore } from '../memory/memory.js';
import { createBackup } from './backup.js';
import { dryRun } from './import/dry-run.js';
import { hashJson, sha, strictJson, pathStamp, readStable, directoryNames, filenameText } from './import/manifest.js';
import { limits } from './import/contracts.js';
import { runCli } from './import/cli.js';

const key = Buffer.alloc(32, 7);
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'outpost-import-test-'));
  const path = join(root, 'source.sqlite'), artifacts = join(root, 'artifacts');
  const ledger = new Ledger(path), files = new Artifacts(ledger, artifacts);
  ledger.put('task', '秘密', 0, { text: 'sensitive-payload-🚀', safe: Number.MAX_SAFE_INTEGER, decimal: 0.125 });
  ledger.put('device', 'revoked-device', 0, { revoked: true });
  const memory = new MemoryStore(ledger);
  const forgotten = memory.save({ text: 'history-not-erased', project: 'p', identityId: 'i', source: 'owner', provenance: 'owner' });
  memory.forget(forgotten.id, forgotten.revision);
  ledger.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run('revoked-device', 'receipt', 'a'.repeat(64), '{ "value": "✓" }');
  for (const state of ['pending', 'claimed', 'done', 'unknown']) {
    ledger.enqueue('topic', { private: 'outbox-secret' }, state);
    ledger.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state, state);
  }
  const published = files.publish('秘密', 'private-name.txt', 'text/plain', Buffer.from('published bytes'));
  files.publish('秘密', 'empty.txt', 'text/plain', Buffer.alloc(0));
  ledger.db.exec('UPDATE events SET cursor=cursor+100');
  return { root, path, artifacts, ledger, files, published, close: () => ledger.close(), clean: () => rmSync(root, { recursive: true, force: true }), source: { type: 'sqlite' as const, database: path, artifactRoot: artifacts, frozen: true as const } };
}
function mutate(path: string, sql: string) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
function tree(root: string): unknown {
  return readdirSync(root).sort().map(name => { const path = join(root, name); return statSync(path).isDirectory() ? [name, tree(path)] : [name, pathStamp(path), sha(readFileSync(path))]; });
}
interface ArchiveFixture {
  version: number; createdAt: string; ledger: string; ledgerHash: string;
  artifacts: { id: string; hash: string; bytes: string }[]; extra?: string;
}
function decrypt(bytes: Buffer): ArchiveFixture {
  const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20)); d.setAAD(Buffer.from('outpost-backup-v1')); d.setAuthTag(bytes.subarray(20, 36));
  return JSON.parse(Buffer.concat([d.update(bytes.subarray(36)), d.final()]).toString()) as ArchiveFixture;
}
function encrypt(archive: unknown, magic = Buffer.from('OUTPOST1')) {
  const iv = Buffer.alloc(12, 3), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('outpost-backup-v1'));
  const bytes = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(archive))), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), bytes]);
}

test('import source: deterministic frozen inventory preserves receipts, gaps, tombstones, revocation and raw JSON', () => {
  const f = fixture(); f.close();
  try {
    const before = tree(f.root), one = dryRun(f.source), two = dryRun(f.source);
    assert.deepEqual(one, two); assert.deepEqual(tree(f.root), before);
    assert.equal(one.schema.derivedMemoryIndex, true); assert.equal(one.tables.commands!.count, 1);
    assert.notEqual(one.tables.commands!.rawHash, one.tables.commands!.canonicalHash);
    assert.equal(one.tombstones.count, 1); assert.equal(one.events.min, 101);
    assert.equal(one.events.watermark, one.events.max); assert.ok(one.events.max > one.events.count);
    assert.deepEqual(one.outboxStates, { pending: 1, claimed: 1, done: 1, unknown: 1 });
    assert.equal(one.files.filter(file => file.role === 'published').length, 2);
    assert.equal(one.applySupported, false);
    const serialized = JSON.stringify(one);
    for (const secret of ['sensitive-payload', 'revoked-device', 'private-name', 'history-not-erased', f.root]) assert.ok(!serialized.includes(secret));
    assert.equal(JSON.parse(runCli(['sqlite', '--database', f.path, '--artifacts', f.artifacts, '--frozen'])).database.hash, one.database.hash);
    assert.throws(() => runCli(['sqlite', '--target', 'postgres://secret']), /invalid_arguments/);
  } finally { f.clean(); }
});

test('import source: current writer archive uses exact eight-byte OUTPOST1 layout and cleans staging', async () => {
  const f = fixture(), archive = join(f.root, 'backup.enc');
  try {
    await createBackup(f.ledger, f.files, key, archive); f.close();
    const before = tree(f.root), stagingBefore = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort();
    const bytes = readFileSync(archive);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '4f5554504f535431');
    assert.equal(bytes.subarray(8, 20).length, 12); assert.equal(bytes.subarray(20, 36).length, 16);
    const decoded = decrypt(bytes); assert.equal(decoded.version, 1);
    const result = dryRun({ type: 'outpost1', archive, key });
    assert.deepEqual(result, dryRun({ type: 'outpost1', archive, key }));
    assert.deepEqual(result.tables, dryRun(f.source).tables);
    assert.deepEqual(tree(f.root), before);
    assert.deepEqual(readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort(), stagingBefore);
    const golden = encrypt(decoded); assert.equal(golden.subarray(0, 36).toString('hex'), '4f5554504f535431' + '03'.repeat(12) + golden.subarray(20, 36).toString('hex'));
    writeFileSync(join(f.root, 'golden.enc'), golden);
    assert.deepEqual(dryRun({ type: 'outpost1', archive: join(f.root, 'golden.enc'), key }).tables, result.tables);
    for (const altered of [bytes.subarray(0, 7), bytes.subarray(0, 35), bytes.subarray(0, bytes.length - 1), Buffer.from(bytes)]) {
      if (altered.length === bytes.length) altered[20] = altered[20]! ^ 1;
      const bad = join(f.root, 'bad.enc'); writeFileSync(bad, altered);
      assert.throws(() => dryRun({ type: 'outpost1', archive: bad, key }), /invalid_archive/);
    }
    assert.throws(() => dryRun({ type: 'outpost1', archive, key: Buffer.alloc(32) }), /invalid_archive/);
    const mutations: ((a: ArchiveFixture) => void)[] = [
      a => { a.artifacts.push(a.artifacts[0]!); },
      a => { a.artifacts[0]!.id = '../escape'; },
      a => { a.artifacts[0]!.hash = '0'.repeat(64); },
      a => { a.ledger += '\n'; },
      a => { a.version = 2; },
      a => { a.extra = 'secret'; },
      a => { a.artifacts = []; },
      a => { a.artifacts[0]!.bytes = Buffer.from('substitution').toString('base64'); a.artifacts[0]!.hash = sha(Buffer.from('substitution')); },
    ];
    for (const change of mutations) {
      const a = structuredClone(decoded); change(a); const bad = join(f.root, 'bad.enc'); writeFileSync(bad, encrypt(a));
      assert.throws(() => dryRun({ type: 'outpost1', archive: bad, key }));
    }
    assert.deepEqual(readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort(), stagingBefore);
  } finally { f.clean(); }
});

test('import source: foreign schema, unsafe values, malformed JSON and corrupt database fail closed', () => {
  for (const sql of [
    'CREATE TABLE foreign_data(secret TEXT)', 'PRAGMA user_version=2', 'UPDATE migrations SET version=2',
    'UPDATE records SET revision=9007199254740992',
    `UPDATE commands SET result='{"n":9007199254740993}'`,
    `UPDATE commands SET result='{"n":0.10000000000000001}'`,
    `UPDATE commands SET result='{"a":1,"a":2}'`, `UPDATE commands SET result='broken'`,
    `UPDATE records SET updated_at='2025-02-30T00:00:00.000Z'`,
    `CREATE TRIGGER dangerous AFTER INSERT ON records BEGIN DELETE FROM commands; END`,
  ]) {
    const f = fixture(); f.close();
    try { mutate(f.path, sql); const before = tree(f.root); assert.throws(() => dryRun(f.source)); assert.deepEqual(tree(f.root), before); }
    finally { f.clean(); }
  }
  const f = fixture(); f.close();
  try { writeFileSync(f.path, 'not sqlite'); assert.throws(() => dryRun(f.source), /source_validation_failed/); }
  finally { f.clean(); }
  assert.throws(() => strictJson('{"a":1,"\\u0061":2}'), /duplicate_json_key/);
  assert.equal(hashJson(strictJson('{"整数":9007199254740991,"n":1e-2}')), hashJson({ 整数: Number.MAX_SAFE_INTEGER, n: 0.01 }));
});

test('import source: WAL, missing acknowledgment, traversal, symlink, hardlink and hash substitution refused', () => {
  const live = fixture();
  try { assert.throws(() => dryRun(live.source), /source_not_frozen/); } finally { live.close(); live.clean(); }
  for (const attack of ['hash', 'missing', 'symlink', 'hardlink', 'root-symlink', 'database-symlink', 'traversal', 'wal', 'journal', 'capacity']) {
    const f = fixture(); f.close();
    try {
      const blob = join(f.artifacts, `${f.published.id}.blob`);
      if (attack === 'hash') writeFileSync(blob, 'wrong');
      if (attack === 'missing') unlinkSync(blob);
      if (attack === 'symlink') { unlinkSync(blob); symlinkSync(f.path, blob); }
      if (attack === 'hardlink') { unlinkSync(blob); linkSync(f.path, blob); }
      if (attack === 'root-symlink') { renameSync(f.artifacts, f.artifacts + '-real'); symlinkSync(f.artifacts + '-real', f.artifacts); }
      if (attack === 'database-symlink') { renameSync(f.path, f.path + '-real'); symlinkSync(f.path + '-real', f.path); }
      if (attack === 'traversal') mutate(f.path, `UPDATE records SET id='../escape' WHERE kind='artifact' AND id='${f.published.id}'`);
      if (attack === 'wal') writeFileSync(f.path + '-wal', '');
      if (attack === 'journal') writeFileSync(f.path + '-journal', '');
      if (attack === 'capacity') { const fd = openSync(blob, 'w'); ftruncateSync(fd, limits.file + 1); closeSync(fd); }
      assert.throws(() => dryRun(f.source));
    } finally { f.clean(); }
  }
  const f = fixture(); f.close();
  try { assert.throws(() => dryRun({ ...f.source, frozen: false } as never), /frozen_acknowledgment_required/); }
  finally { f.clean(); }
});

test('import source: partial, missing and rename-before-metadata uploads remain explicit blockers', async () => {
  const f = fixture();
  const upload = f.files.begin('秘密', 'partial.txt', 'text/plain', 3, sha(Buffer.from('abc')));
  f.files.chunk(upload.id, 0, Buffer.from('a')); f.close();
  try {
    let manifest = dryRun(f.source);
    assert.ok(manifest.blockers.includes('partial_uploads_unsupported'));
    assert.equal(manifest.files.filter(file => file.role === 'partial').length, 1);
    writeFileSync(join(f.artifacts, `${upload.id}.part`), 'abc');
    assert.ok(dryRun(f.source).blockers.includes('upload_offset_ambiguous'));
    renameSync(join(f.artifacts, `${upload.id}.part`), join(f.artifacts, `${upload.id}.blob`));
    manifest = dryRun(f.source);
    assert.ok(manifest.blockers.includes('upload_rename_ambiguous')); assert.ok(manifest.blockers.includes('upload_part_missing'));
    assert.equal(manifest.files.filter(file => file.role === 'unexpected').length, 1);
  } finally { f.clean(); }
});

test('import source: CLI errors are redacted and no PostgreSQL target is accepted', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/reliability/import/cli.ts', 'sqlite', '--target', 'postgres://SECRET'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.ok(result.stderr.includes('invalid_arguments'));
  assert.ok(!result.stderr.includes('SECRET')); assert.ok(!result.stderr.includes('at runCli'));
});

test('import source: streamed reads detect in-place changes and rename substitutions', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'outpost-import-race-'));
  const path = join(root, 'frozen.bin');
  try {
    for (const mode of ['in-place', 'rename', 'hardlink']) {
      writeFileSync(path, Buffer.alloc(128 * 1024, 1)); let changed = false;
      assert.throws(() => readStable(path, limits.file, () => {
        if (changed) return; changed = true;
        if (mode === 'in-place') writeFileSync(path, Buffer.alloc(128 * 1024, 2));
        else if (mode === 'rename') { renameSync(path, path + '.old'); writeFileSync(path, Buffer.alloc(128 * 1024, 1)); }
        else linkSync(path, path + '.alias');
      }), /source_changed|source_regular_file_required/);
      if (mode === 'hardlink') unlinkSync(path + '.alias');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('import source: legacy backup omission of incomplete upload bytes is a blocker, not success for apply', async () => {
  const f = fixture();
  try {
    f.files.begin('秘密', 'unfinished.txt', 'text/plain', 3, sha(Buffer.from('abc')));
    const archive = join(f.root, 'partial.enc'); await createBackup(f.ledger, f.files, key, archive); f.close();
    const manifest = dryRun({ type: 'outpost1', archive, key });
    assert.ok(manifest.blockers.includes('partial_uploads_unsupported'));
    assert.ok(manifest.blockers.includes('upload_part_missing'));
    assert.equal(manifest.uploads.count, 3);
    assert.equal(manifest.applySupported, false);
  } finally { f.clean(); }
});

test('import source: empty and safe-boundary event watermarks ignore allocator gaps', () => {
  const f = fixture(); f.close();
  try {
    const baseline = dryRun(f.source);
    mutate(f.path, 'UPDATE sqlite_sequence SET seq=9007199254740991');
    assert.equal(dryRun(f.source).events.watermark, baseline.events.watermark);
    mutate(f.path, 'DELETE FROM events WHERE cursor NOT IN (SELECT MAX(cursor) FROM events); UPDATE events SET cursor=9007199254740991');
    assert.equal(dryRun(f.source).events.watermark, Number.MAX_SAFE_INTEGER);
    mutate(f.path, 'UPDATE events SET cursor=9007199254740992');
    assert.throws(() => dryRun(f.source));
    mutate(f.path, 'DELETE FROM events');
    assert.deepEqual(dryRun(f.source).events, { min: 0, max: 0, count: 0, watermark: 0 });
    mutate(f.path, "UPDATE commands SET result=CAST(x'ff' AS TEXT)");
    assert.throws(() => dryRun(f.source), /invalid_utf8/);
  } finally { f.clean(); }
});

test('import source: counter validation follows column identity, not SQLite storage class', async t => {
  const cases = [
    ['records TEXT revision', "UPDATE records SET revision='oops'"],
    ['events TEXT revision', "UPDATE events SET revision='oops'"],
    ['records REAL revision', 'UPDATE records SET revision=1.5'],
    ['events REAL revision', 'UPDATE events SET revision=1.5'],
    ['events zero revision', 'UPDATE events SET revision=0'],
    ['events negative revision', 'UPDATE events SET revision=-1'],
    ['zero cursor', 'UPDATE events SET cursor=0 WHERE cursor=(SELECT MAX(cursor) FROM events)'],
    ['negative cursor', 'UPDATE events SET cursor=-1 WHERE cursor=(SELECT MAX(cursor) FROM events)'],
    ['zero migration version', 'UPDATE migrations SET version=0'],
    ['negative migration version', 'UPDATE migrations SET version=-1'],
    ['TEXT sequence', "UPDATE sqlite_sequence SET seq='oops'"],
    ['REAL sequence', 'UPDATE sqlite_sequence SET seq=1.5'],
    ['negative sequence', 'UPDATE sqlite_sequence SET seq=-1'],
  ] as const;
  for (const [name, sql] of cases) await t.test(name, () => {
    const f = fixture(); f.close();
    try {
      mutate(f.path, sql);
      const before = tree(f.root);
      try { assert.throws(() => dryRun(f.source)); }
      finally { assert.deepEqual(tree(f.root), before); }
    } finally { f.clean(); }
  });
  // INTEGER PRIMARY KEY columns reject noninteger storage classes at the SQLite boundary.
  for (const column of ['events.cursor', 'migrations.version']) await t.test(`${column} rejects TEXT and REAL storage`, () => {
    const f = fixture(); f.close();
    try {
      const [table, field] = column.split('.');
      for (const value of ["'oops'", '1.5']) assert.throws(() => mutate(f.path, `UPDATE ${table} SET ${field}=${value}`), /datatype mismatch/);
      const before = tree(f.root); dryRun(f.source); assert.deepEqual(tree(f.root), before);
    } finally { f.clean(); }
  });
});

test('import source: raw ff filename cannot collide with actual replacement-character filename', t => {
  const f = fixture(); f.close();
  const rawPath = Buffer.concat([Buffer.from(f.artifacts + '/'), Buffer.from([0xff])]);
  try {
    writeFileSync(join(f.artifacts, '\uFFFD'), 'B', { flag: 'wx' });
    try { writeFileSync(rawPath, 'A', { flag: 'wx' }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EILSEQ' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
      t.skip(`Filesystem cannot create raw ff filename: ${code}; exact byte-decoding primitive tested separately`); return;
    }
    const names = readdirSync(f.artifacts, { encoding: 'buffer' });
    assert.ok(names.some(name => name.equals(Buffer.from([0xff]))));
    assert.ok(names.some(name => name.equals(Buffer.from('\uFFFD'))));
    const before = names.map(name => {
      const path = Buffer.concat([Buffer.from(f.artifacts + '/'), name]);
      return [name.toString('hex'), sha(readFileSync(path)), statSync(path, { bigint: true }).mtimeNs.toString()];
    });
    assert.throws(() => dryRun(f.source), /invalid_filename_utf8/);
    const after = readdirSync(f.artifacts, { encoding: 'buffer' }).map(name => {
      const path = Buffer.concat([Buffer.from(f.artifacts + '/'), name]);
      return [name.toString('hex'), sha(readFileSync(path)), statSync(path, { bigint: true }).mtimeNs.toString()];
    });
    assert.deepEqual(after, before);
  } finally { f.clean(); }
});

test('import source: directory limit stops at limit plus one and closes the handle', t => {
  const f = fixture(); f.close();
  const originalRead = Dir.prototype.readSync, originalClose = Dir.prototype.closeSync;
  let reads = 0, closes = 0;
  try {
    // Two published blobs plus these entries exceed the bound by three.
    for (let i = 0; i < limits.files + 1; i++) writeFileSync(join(f.artifacts, `extra-${i}`), '');
    const before = tree(f.root), stagingBefore = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort();
    t.mock.method(Dir.prototype, 'readSync', function(this: Dir) { reads++; return originalRead.call(this); });
    t.mock.method(Dir.prototype, 'closeSync', function(this: Dir) { closes++; return originalClose.call(this); });
    assert.throws(() => dryRun(f.source), /source_capacity/);
    assert.equal(reads, limits.files + 1); assert.equal(closes, 1);
    assert.deepEqual(tree(f.root), before);
    assert.deepEqual(readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort(), stagingBefore);
    reads = 0; closes = 0;
    for (let i = 0; i < 3; i++) unlinkSync(join(f.artifacts, `extra-${i}`));
    const names = directoryNames(f.artifacts);
    assert.equal(names.length, limits.files);
    assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.equal(reads, limits.files + 1); assert.equal(closes, 1);
  } finally { t.mock.restoreAll(); f.clean(); }
});

test('import source: byte-preserving enumeration rejects invalid UTF8 without filesystem support', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'outpost-import-name-'));
  try {
    // Dir's latin1 transport must retain these exact bytes until UTF-8 validation.
    const names = [Buffer.from([0xff]), Buffer.from('\uFFFD')];
    let index = 0, closes = 0;
    const originalClose = Dir.prototype.closeSync;
    t.mock.method(Dir.prototype, 'closeSync', function(this: Dir) { closes++; return originalClose.call(this); });
    t.mock.method(Dir.prototype, 'readSync', () => {
      const bytes = names[index++]; if (!bytes) return null;
      const entry = new Dirent(); entry.name = bytes.toString('latin1'); return entry;
    });
    assert.throws(() => directoryNames(root), /invalid_filename_utf8/);
    assert.equal(index, 1); assert.equal(closes, 1);
  } finally { t.mock.restoreAll(); rmSync(root, { recursive: true, force: true }); }
});

test('import source: filename decoder requires exact UTF8 bytes and accepts a literal replacement character', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    assert.throws(() => filenameText(bytes), /invalid_filename_utf8/);
  }
  for (const name of ['ascii', '\uFFFD', 'é-秘密-🚀', '\uFEFFbom']) assert.equal(filenameText(Buffer.from(name)), name);
  const f = fixture(); f.close();
  try {
    const unicodeRoot = join(f.root, 'é-秘密-🚀'); renameSync(f.artifacts, unicodeRoot);
    writeFileSync(join(unicodeRoot, '\uFFFD'), 'B', { flag: 'wx' });
    writeFileSync(join(unicodeRoot, 'é-秘密-🚀'), 'C', { flag: 'wx' });
    const before = tree(f.root), manifest = dryRun({ ...f.source, artifactRoot: unicodeRoot });
    assert.equal(manifest.files.find(file => file.nameHash === sha('\uFFFD'))?.hash, sha('B'));
    assert.equal(manifest.files.find(file => file.nameHash === sha('é-秘密-🚀'))?.hash, sha('C'));
    assert.deepEqual(tree(f.root), before);
  } finally { f.clean(); }
});

test('import source: directory read failures close handles and remove private staging', t => {
  const f = fixture(); f.close();
  const originalClose = Dir.prototype.closeSync; let closes = 0;
  try {
    const before = tree(f.root), stagingBefore = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort();
    t.mock.method(Dir.prototype, 'readSync', () => { throw new Error('injected directory read failure'); });
    t.mock.method(Dir.prototype, 'closeSync', function(this: Dir) { closes++; return originalClose.call(this); });
    assert.throws(() => dryRun(f.source), /^SourceError: source_validation_failed$/);
    assert.equal(closes, 1); assert.deepEqual(tree(f.root), before);
    assert.deepEqual(readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith('outpost-source-')).sort(), stagingBefore);
  } finally { t.mock.restoreAll(); f.clean(); }
});
