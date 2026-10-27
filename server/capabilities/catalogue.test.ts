import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Capabilities } from './catalogue.js';
test('capability readiness requires exact executable probe and permission-change approval',async () => {
  const db = new Ledger(), capabilities = new Capabilities(db);
  const manifest = { name: 'node-runtime',version: process.version,source: 'https://nodejs.org',license: 'MIT',executable: process.execPath,sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),permissions: ['workspace.execute'],destinations: [],probe: ['--version'],tools: ['command.run'] };
  const staged = capabilities.stage(manifest); assert.throws(() => capabilities.activate(manifest.name,staged.data.hash,0));
  await capabilities.probe(manifest.name); capabilities.activate(manifest.name,staged.data.hash,0);
  const update = capabilities.stage({ ...manifest,permissions: [...manifest.permissions,'owner.read'] });
  assert.deepEqual(update.data.expanded,['owner.read']);
  assert.throws(() => capabilities.activate(manifest.name,staged.data.hash,1));
  assert.equal(db.need('capability',manifest.name).revision,1); db.close();
});
