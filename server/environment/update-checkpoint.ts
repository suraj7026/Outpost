import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ledger } from '../core/ledger.js';
import { requireThat } from '../core/contracts.js';
import { Installation } from './installation.js';
import { Tasks } from '../tasks/tasks.js';

export function updateCheckpoint(root: string, environmentId: string, operationId: string, digest: string, action: 'stage' | 'prepare' | 'check' | 'finish' | 'abort' = 'check') {
  const db = new Ledger(join(root, 'ledger.sqlite'));
  try {
    new Installation(db).requireTarget(environmentId);
    return db.transaction(() => {
      const operation = db.need('runtime_update', 'server');
      requireThat(operation.data.operationId === operationId && operation.data.sha256 === digest, 'update_binding_mismatch');
      if (operation.data.state === 'finished' && action === 'finish') return;
      if (action === 'abort') {
        requireThat(['staging', 'draining', 'cancelled'].includes(String(operation.data.state)), 'update_cannot_abort');
        if (operation.data.state !== 'cancelled') db.put('runtime_update', 'server', operation.revision, { ...operation.data, state: 'cancelled' });
        return;
      }
      if (action !== 'finish') requireThat(db.get('device', String(operation.data.owner))?.data.revoked === false, 'update_owner_revoked');
      if (action === 'stage') { requireThat(operation.data.state === 'staging', 'update_not_staging'); return; }
      if (action === 'prepare') {
        requireThat(operation.data.state === 'staging', 'update_not_staging');
        db.put('runtime_update', 'server', operation.revision, { ...operation.data, state: 'draining' });
        return;
      }
      requireThat(!['draining', 'holding'].includes(String(operation.data.state)), 'update_waiting');
      requireThat(operation.data.state === 'prepared', 'update_not_prepared');
      const checkpoint = db.need('maintenance_checkpoint', 'server');
      requireThat(db.get('recovery', 'server')?.data.dispatchEnabled === false && Number(checkpoint.data.expiresAt) > Date.now(), 'update_hold_invalid');
      if (action === 'finish') {
        const tasks = new Tasks(db); tasks.recover(); tasks.finishMaintenance();
        db.put('runtime_update', 'server', operation.revision, { ...operation.data, state: 'finished' });
      }
    });
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, root, environment, operation, digest] = process.argv.slice(2);
    if (!['stage', 'prepare', 'check', 'finish', 'abort'].includes(action ?? '') || !root?.startsWith('/') || !environment || !operation || !digest) throw new Error('invalid');
    updateCheckpoint(root, environment, operation, digest, action as 'stage' | 'prepare' | 'check' | 'finish' | 'abort');
  } catch (error) {
    if (error instanceof Error && error.message === 'update_waiting') process.exitCode = 2;
    else { console.error('Update checkpoint validation failed; inspect the retained operation.'); process.exitCode = 1; }
  }
}
