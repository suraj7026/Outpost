import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PiProfile } from './profile.js';
import { ProviderManagement } from './providers.js';

test('held catalogue reads cannot trigger SDK OAuth refresh while inventory remains available', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-provider-hold-'));
  const profile = new PiProfile(directory), owner = randomUUID(), operationId = randomUUID();
  let creations = 0;
  const management = new ProviderManagement(profile, async () => { creations++; throw Error('would resolve or refresh credentials'); });
  t.after(() => { management.close(); rmSync(directory, { recursive: true, force: true }); });
  profile.holdMaintenance(owner, operationId);
  await assert.rejects(management.request(owner, { type: 'catalogue' }), /maintenance_in_progress/);
  assert.equal(creations, 0);
  assert.equal((await management.request(owner, { type: 'runtime.inventory' }) as { piVersion: string }).piVersion, profile.version);
  profile.releaseMaintenance(owner, operationId);
  await assert.rejects(management.request(owner, { type: 'catalogue' }), /would resolve or refresh credentials/);
  assert.equal(creations, 1);
});
