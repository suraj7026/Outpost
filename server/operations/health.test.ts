import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { probeHealth, verifyRollout } from './health.js';
test('rollbacks require independent health proof rather than successful command exit',async () => {
  const db = new Ledger(); let rollbackCount = 0;
  const result = await verifyRollout(db,'deploy','abc',async () => ({ healthy: false }),async () => { rollbackCount++; });
  assert.equal(result.data.state,'recovery_required'); assert.equal(rollbackCount,1);
  await assert.rejects(probeHealth('http://169.254.169.254',new Set()),/health_target_not_enrolled/); db.close();
});
