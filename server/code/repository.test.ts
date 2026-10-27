import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository, fileHash } from './repository.js';
import { Workspace } from '../artifacts/files.js';
test('precise patch refuses ambiguous and stale changes and preserves literal replacement',() => {
  const root = mkdtempSync(join(tmpdir(),'outpost-code-'));
  try {
    const workspace = new Workspace(root), repo = new Repository(workspace);
    workspace.write('source','one two two',null);
    assert.throws(() => repo.patch('source','two','three',fileHash('one two two')),/patch_not_unique/);
    assert.throws(() => repo.patch('source','one','three',fileHash('old')),/file_changed/);
    repo.patch('source','one','$&',fileHash('one two two')); assert.equal(workspace.read('source'),'$& two two');
  } finally { rmSync(root,{ recursive: true,force: true }); }
});
