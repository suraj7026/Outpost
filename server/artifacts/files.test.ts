import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Artifacts, Workspace } from './files.js';
test('workspace rejects escapes, symlinks and stale edits; artifacts reject corrupt partial transfers',() => {
  const root = mkdtempSync(join(tmpdir(),'outpost-')), db = new Ledger();
  try {
    const workspace = new Workspace(join(root,'work'));
    assert.throws(() => workspace.path('../escape')); symlinkSync(tmpdir(),join(workspace.root,'link')); assert.throws(() => workspace.read('link/file'));
    workspace.write('a.txt','hello',null); assert.throws(() => workspace.write('a.txt','overwrite',null));
    db.put('task','task',0,{}); const store = new Artifacts(db,join(root,'artifacts'));
    const bytes = Buffer.from('test'), hash = createHash('sha256').update(bytes).digest('hex');
    const upload = store.begin('task','test.txt','text/plain',4,hash);
    store.chunk(upload.id,0,bytes.subarray(0,2)); assert.throws(() => store.complete(upload.id));
    store.chunk(upload.id,2,Buffer.from('xx')); assert.throws(() => store.complete(upload.id),/checksum_mismatch/);
    assert.equal(db.list('artifact').length,0);
    const artifact = store.publish('task','good.txt','text/plain',bytes); assert.deepEqual(store.read(artifact.id),bytes);
    assert.equal(store.complete(artifact.id).id,artifact.id);
  } finally { db.close(); rmSync(root,{ recursive: true,force: true }); }
});
