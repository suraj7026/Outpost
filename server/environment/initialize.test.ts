import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Installation } from './installation.js';
import { initializeInstallation } from './initialize.js';
import { Workspace } from '../artifacts/files.js';

test('native installation enrolls only into a new ledger and preserves its identity on reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-initialize-'));
  const input = { environmentId: randomUUID(), deviceId: randomUUID(), name: 'Installing Mac', publicKey: Buffer.alloc(32, 7).toString('base64') };
  try {
    initializeInstallation(root, input);
    assert.throws(() => initializeInstallation(root, { ...input, deviceId: randomUUID() }), /existing_installation/);
    const db = new Ledger(join(root, 'ledger.sqlite'));
    try { assert.equal(new Installation(db).environmentId, input.environmentId); assert.equal(db.list('device').length, 1); assert.equal(db.list('device')[0]?.id, input.deviceId); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native group workspaces opt in without opening private workspace defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-shared-'));
  const mask = process.umask(0o007);
  try {
    for (const shared of [false, true]) {
      const path = join(root, String(shared)), workspace = new Workspace(path, shared);
      workspace.write('nested/file.txt', 'shared only when configured', null);
      assert.equal(statSync(path).mode & 0o777, shared ? 0o770 : 0o700);
      assert.equal(statSync(join(path, 'nested/file.txt')).mode & 0o777, shared ? 0o660 : 0o600);
    }
  } finally { process.umask(mask); rmSync(root, { recursive: true, force: true }); }
});
