import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtemp, mkdir, writeFile, rm, symlink, link, rename, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { WorkspaceReview, WORKSPACE_REVIEW_LIMITS } from './workspace-review.js';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'outpost-workspace-review-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspaces', 'task');
  await mkdir(root, { recursive: true });
  return { base, root, review: new WorkspaceReview(root) };
}

const fault = (code: string) => ({ code, message: code });

test('workspace review returns relative metadata, exact UTF-8 text and SHA-256 without changing files', async t => {
  const { root, review } = await fixture(t);
  await mkdir(join(root, 'src'));
  const path = 'src/hello world.ts', text = '\ufeff// café 日本語\n\tconst ready = true;\r\n';
  await writeFile(join(root, path), text);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  const before = await stat(join(root, path), { bigint: true });
  const result = await review.read(path);
  assert.deepEqual(result, { path, name: 'hello world.ts', text, size: Buffer.byteLength(text),
    hash: createHash('sha256').update(text).digest('hex'), modifiedAt: before.mtime.toISOString() });
  const listing = await review.files();
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.files.map(file => file.path), ['.gitignore', path]);
  assert.deepEqual(listing.files[1], { path, name: result.name, size: result.size, modifiedAt: result.modifiedAt });
  assert.equal((await stat(join(root, path), { bigint: true })).mtimeNs, before.mtimeNs);
  await writeFile(join(root, 'empty'), '');
  assert.equal((await review.read('empty')).text, '');
});

test('workspace review never creates a missing workspace or its parent', async t => {
  const { base } = await fixture(t);
  for (const root of [join(base, 'missing'), join(base, 'absent', 'task')]) {
    const review = new WorkspaceReview(root);
    assert.deepEqual(await review.files(), { files: [], truncated: false });
    await assert.rejects(review.read('missing.txt'), fault('workspace_unavailable'));
    await assert.rejects(stat(root), { code: 'ENOENT' });
  }
  await assert.rejects(stat(join(base, 'absent')), { code: 'ENOENT' });
});

test('workspace review rejects traversal, absolute paths, aliases and invalid names', async t => {
  const { review } = await fixture(t);
  for (const path of ['', '.', '..', '../secret', 'src/../../secret', '/etc/passwd', '//host/file',
    './file', 'src/../file', 'src/./file', 'src//file', 'src/', 'file\0', 'line\nname',
    'C:\\secret', 'C:/secret', 'src\\file', '%2e%2e/secret', 'file:///etc/passwd', 'a'.repeat(1001), '\ud800']) {
    await assert.rejects(review.read(path), { name: 'ZodError' }, path);
  }
});

test('workspace review skips symlinks, hardlinks and special files and refuses to read them', async t => {
  const { base, root, review } = await fixture(t);
  const outside = join(base, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'secret'), 'outside secret');
  await writeFile(join(root, 'safe'), 'inside');
  await symlink(join(outside, 'secret'), join(root, 'file-link'));
  await symlink(outside, join(root, 'dir-link'));
  await symlink(join(root, 'safe'), join(root, 'inside-link'));
  await symlink(join(base, 'nonexistent'), join(root, 'dangling'));
  await symlink(root, join(root, 'cycle'));
  await link(join(outside, 'secret'), join(root, 'hardlink'));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(join(root, 'socket'), resolve));
  t.after(() => new Promise<void>(resolve => socket.close(() => resolve())));
  assert.deepEqual((await review.files()).files.map(file => file.path), ['safe']);
  for (const path of ['file-link', 'inside-link', 'dangling', 'hardlink', 'socket']) {
    await assert.rejects(review.read(path), fault('workspace_unsafe_file'));
  }
  for (const path of ['dir-link/secret', 'cycle/safe']) {
    await assert.rejects(review.read(path), fault('workspace_unsafe_directory'));
  }
  await assert.rejects(review.read('dir-link'), fault('workspace_unsafe_file'));
});

test('workspace review refuses linked task roots and configured workspace roots', async t => {
  const { base, root, review } = await fixture(t);
  await rename(root, join(base, 'moved'));
  await symlink(join(base, 'moved'), root);
  await assert.rejects(review.files(), fault('workspace_unsafe_directory'));
  await assert.rejects(review.read('secret'), fault('workspace_unsafe_directory'));
  const linkedBase = join(base, 'linked');
  await symlink(join(base, 'workspaces'), linkedBase);
  await assert.rejects(new WorkspaceReview(join(linkedBase, 'task')).files(), fault('workspace_unsafe_directory'));
});

test('workspace review bounds bytes before opening and rejects binary and malformed UTF-8', async t => {
  const { root, review } = await fixture(t);
  const max = WORKSPACE_REVIEW_LIMITS.bytes;
  await writeFile(join(root, 'limit.txt'), 'x'.repeat(max));
  assert.equal((await review.read('limit.txt')).size, max);
  await writeFile(join(root, 'large.txt'), 'x'.repeat(max + 1));
  const opened: unknown[] = [], originalOpen = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    opened.push(args[0]); return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(review.read('large.txt'), fault('workspace_file_too_large'));
    assert.equal(opened.length, 0);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  for (const [name, bytes] of Object.entries({ nul: Buffer.from('a\0b'), control: Buffer.from([1, 2, 3]),
    invalid: Buffer.from([0xc3, 0x28]), utf16: Buffer.from([0xff, 0xfe, 0x61, 0]), del: Buffer.from([0x7f]) })) {
    await writeFile(join(root, name), bytes);
    await assert.rejects(review.read(name), fault('workspace_text_required'));
  }
  assert.equal((await review.files()).files.find(file => file.path === 'large.txt')?.size, max + 1);
});

test('workspace review caps scanned entries and nesting, including directories with no files', async t => {
  const { root, review } = await fixture(t);
  for (let i = 0; i <= WORKSPACE_REVIEW_LIMITS.entries; i++) await writeFile(join(root, `file-${i}`), 'x');
  const listing = await review.files();
  assert.equal(listing.files.length, WORKSPACE_REVIEW_LIMITS.entries);
  assert.equal(listing.truncated, true);
  await rm(join(root, `file-${WORKSPACE_REVIEW_LIMITS.entries}`));
  assert.equal((await review.files()).truncated, false);
  const directories = join(root, 'directories'); await mkdir(directories);
  for (let i = 0; i <= WORKSPACE_REVIEW_LIMITS.entries; i++) await mkdir(join(directories, `dir-${i}`));
  assert.deepEqual(await new WorkspaceReview(directories).files(), { files: [], truncated: true });
  const deep = join(root, 'deep'); await mkdir(deep);
  const nested = join(deep, ...Array<string>(WORKSPACE_REVIEW_LIMITS.depth + 1).fill('dir'));
  await mkdir(nested, { recursive: true }); await writeFile(join(nested, 'hidden'), 'deep');
  assert.deepEqual(await new WorkspaceReview(deep).files(), { files: [], truncated: true });
});

test('workspace review accepts shared-group workspace permissions without chmod', async t => {
  const { root, review } = await fixture(t);
  await chmod(root, 0o2770); await writeFile(join(root, 'shared.txt'), 'shared', { mode: 0o660 });
  const mode = (await stat(root)).mode;
  assert.equal((await review.read('shared.txt')).text, 'shared');
  assert.equal((await review.files()).files.length, 1);
  assert.equal((await stat(root)).mode, mode);
});

test('workspace review detects directory replacement during open without returning redirected content', async t => {
  const { base, root, review } = await fixture(t);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'file'), 'inside');
  const outside = join(base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file'), 'secret');
  const originalOpen = fs.open;
  let replaced = false;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith('/src/file')) {
      await rename(join(root, 'src'), join(root, 'original'));
      await symlink(outside, join(root, 'src')); replaced = true;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(review.read('src/file'), fault('workspace_changed'));
    assert.equal(replaced, true);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('workspace listing rejects directory replacement instead of returning host metadata', async t => {
  const { base, root, review } = await fixture(t);
  await mkdir(join(root, 'src'));
  const outside = join(base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'secret');
  const originalOpen = fs.opendir;
  let replaced = false;
  const mocked = t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]).endsWith('/src')) {
      await rename(join(root, 'src'), join(root, 'original'));
      await symlink(outside, join(root, 'src')); replaced = true;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(review.files(), fault('workspace_changed'));
    assert.equal(replaced, true);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('workspace review rejects same-size edits made after the file is read', async t => {
  const { root, review } = await fixture(t);
  await writeFile(join(root, 'changing'), 'before');
  const originalOpen = fs.open;
  let edited = false;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('/changing')) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs: [Buffer, number, number, number]) => {
        const result = await read(...readArgs);
        if (!edited) { await writeFile(join(root, 'changing'), 'after!'); edited = true; }
        return result;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(review.read('changing'), fault('workspace_changed'));
    assert.equal(edited, true);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('workspace review rechecks size after open and redacts missing-file errors', async t => {
  const { base, root, review } = await fixture(t);
  await writeFile(join(root, 'growing'), 'small');
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('/growing')) await writeFile(join(root, 'growing'), 'x'.repeat(WORKSPACE_REVIEW_LIMITS.bytes + 1));
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(review.read('growing'), fault('workspace_file_too_large')); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(review.read('missing'), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'workspace_unavailable');
    assert.equal(error.message.includes(base), false); return true;
  });
});
