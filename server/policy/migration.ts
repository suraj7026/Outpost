import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { Mode, autoPolicyVersion, digest } from '../core/contracts.js';
import type { Action } from './trust.js';
import type { Task } from '../tasks/tasks.js';

const retirement = 'Incompatible or previously approved work was retired without execution. Explicitly resume the task and reconcile prior evidence before replanning; never replay uncertain effects.';

function compatible(db: Ledger, action: Action) {
  const { state: _state, nonce: _nonce, review: _review, decidedBy: _device, result: _result, actionDigest, ...envelope } = action;
  const policy = db.get('policy', action.taskId);
  return action.state === 'pending' && action.autoPolicyVersion === autoPolicyVersion && action.expiresAt > Date.now() &&
    policy?.data.mode === 'auto' && policy.revision === action.policyVersion && digest(envelope) === actionDigest;
}
/** Pending approvals whose decision window already passed at startup cannot be reviewed. */
const expired = (action: { state: Action['state']; expiresAt: number }) => action.state === 'pending' && action.expiresAt <= Date.now();

/** Runtime sweep: retire decision windows that elapsed with no waiter, so reviews never wedge. */
export function expireDueApprovals(db: Ledger) {
  return db.transaction(() => {
    const due = db.list<Action>('action').filter(action => expired(action.data as unknown as { state: Action['state']; expiresAt: number }));
    for (const action of due) {
      db.put('action', action.id, action.revision, { ...action.data, state: 'denied', review: 'Approval window expired; explicitly replan without replay.' }, 'action.retired');
      const notice = db.get('inbox', action.id);
      if (notice?.data.state === 'pending') db.put('inbox', action.id, notice.revision, { ...notice.data, state: 'resolved', resolution: 'approval_expired' });
      db.db.prepare("UPDATE outbox SET state='done' WHERE topic='notice' AND state='pending' AND json_extract(payload,'$.noticeId')=?").run(action.id);
      const task = db.get('task', action.data.taskId);
      if (task?.data.state === 'waiting_for_approval' && !db.list<Action>('action').some(row => row.data.taskId === action.data.taskId &&
        ['pending', 'authorized', 'dispatching'].includes(row.data.state)))
        db.put('task', action.data.taskId, task.revision, { ...task.data, state: 'verifying', blocker: 'Expired approvals were retired. Replan without replaying uncertain effects.' }, 'task.approval_expired');
    }
  });
}

/** Retire old requests, not effects. Startup must never authorize or replay an old approval. */
export function retireLegacyApprovals(db: Ledger) {
  return db.transaction(() => {
    for (const policy of db.list('policy')) if (policy.data.mode === 'ask_permission') {
      db.put('policy', policy.id, policy.revision, { ...policy.data, mode: 'auto' }, 'policy.normalized');
    }
    for (const automation of db.list('automation')) {
      const task = z.record(z.string(), z.json()).safeParse(automation.data.task);
      if (task.success && task.data.mode === 'ask_permission' && Mode.safeParse(task.data.mode).success) db.put('automation', automation.id, automation.revision,
        { ...automation.data, task: { ...task.data, mode: 'auto' } }, 'automation.normalized');
    }
    const affected = new Set<string>();
    const valid = new Set(db.list<Action>('action').filter(action => compatible(db, action.data) && !expired(action.data as { state: Action['state']; expiresAt: number })).map(action => action.id));
    for (const action of db.list<Action>('action')) if ((action.data.state === 'pending' && !valid.has(action.id)) || (action.data.state === 'authorized' && action.data.decidedBy)) {
      affected.add(action.data.taskId);
      db.put('action', action.id, action.revision, { ...action.data, state: 'denied', review: retirement }, 'action.retired');
    }
    for (const notice of db.list('inbox')) if (notice.data.category === 'approval' && notice.data.state === 'pending' && !valid.has(notice.id)) {
      db.put('inbox', notice.id, notice.revision, { ...notice.data, state: 'resolved', resolution: 'approval_retired' });
      db.db.prepare("UPDATE outbox SET state='done' WHERE topic='notice' AND state='pending' AND json_extract(payload,'$.noticeId')=?").run(notice.id);
    }
    const paused = new Set<string>();
    for (const task of db.list<Task>('task')) {
      if (task.data.state === 'waiting_for_approval' && !db.list<Action>('action').some(action => action.data.taskId === task.id && valid.has(action.id))) affected.add(task.id);
      if (!affected.has(task.id) || ['cancelled', 'completed', 'paused', 'reconciling'].includes(task.data.state)) continue;
      db.put('task', task.id, task.revision, { ...task.data, state: 'paused', blocker: retirement }, 'task.approval_retired');
      paused.add(task.id);
    }
    // Pending queue entries were never claimed. Retire them so explicit resume cannot revive
    // a stale instruction or action. Claimed/unknown entries remain available for reconciliation.
    const interrupted = new Set([...affected, ...db.list<Action>('action').filter(action => valid.has(action.id)).map(action => action.data.taskId)]);
    for (const taskId of interrupted) {
      const rows = db.db.prepare("SELECT id FROM outbox WHERE state='pending' AND topic IN ('task.run','task.resume','task.steer','action.propose','action.dispatch') AND json_extract(payload,'$.taskId')=?").all(taskId);
      for (const row of rows) {
        const key = String(row.id);
        db.db.prepare("UPDATE outbox SET state='done' WHERE id=? AND state='pending'").run(key);
        const operation = db.get('operation', key);
        if (operation && operation.data.state === 'accepted') db.put('operation', key, operation.revision,
          { ...operation.data, state: 'cancelled', error: retirement });
      }
    }
    return paused;
  });
}
