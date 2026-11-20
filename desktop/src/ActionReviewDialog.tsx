import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Interface';
import { Action, ActionDecisions } from './TaskAction';
import { nativeApp, recordedPreview } from './api';
import { unchangedReviewedAction } from './action-review';
import { workspaceBlocker } from './workspace-presentation';
import { labelState, text, type ServerRecord } from './types';
import type { Connection } from './useConnection';
import { taskModeBlocker } from './control-mode';

export default function ActionReviewDialog({ snapshot, connection, onClose }: {
  snapshot: ServerRecord; connection: Connection; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), alive = useRef(true), latest = useRef(connection);
  const owner = useRef(connection.environmentId);
  latest.current = connection;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [receipt, setReceipt] = useState<ServerRecord | null>(null);
  const observed = connection.records.find(record => record.kind === 'action' && record.id === snapshot.id);
  const current = receipt && (!observed || receipt.revision > observed.revision) ? receipt : observed;
  const stale = connection.environmentId !== owner.current || !unchangedReviewedAction(snapshot, current);
  const blocker = workspaceBlocker(connection, nativeApp(), recordedPreview());
  const pending = text(snapshot, 'state') === 'pending';
  const close = () => { if (!working.current) onClose(); };
  const command: Connection['command'] = async (kind, id, revision, payload) => {
    if (!alive.current || working.current) return undefined;
    const live = latest.current;
    const action = live.records.find(record => record.kind === 'action' && record.id === snapshot.id);
    if (live.environmentId !== owner.current || id !== snapshot.id || revision !== snapshot.revision || !unchangedReviewedAction(snapshot, action)) {
      setError('The action changed. Close and reopen review before deciding.'); return undefined;
    }
    const blocked = workspaceBlocker(live, nativeApp(), recordedPreview()) || (payload?.decision === 'approve' ? taskModeBlocker(live.records, text(snapshot, 'taskId'), live.runtime) : '');
    if (blocked) { setError(blocked); return undefined; }
    const state = text(snapshot, 'state');
    if (kind !== 'approval.decide' || state !== 'pending' || payload?.nonce !== text(snapshot, 'nonce') || payload?.actionDigest !== text(snapshot, 'actionDigest') || !['approve', 'deny'].includes(String(payload?.decision))) return undefined;
    working.current = true; setBusy(true); setError('');
    try {
      const result = await live.command(kind, id, revision, payload);
      if (alive.current) {
        if (!result || result.kind !== 'action' || result.id !== id || result.revision <= revision) setError('Could not confirm the outcome. Check server recovery before trying again.');
        else setReceipt(result);
      }
      return result;
    } catch (cause) {
      if (alive.current) setError(`Could not confirm the outcome. Check server recovery before trying again. ${String(cause)}`);
      return undefined;
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const guarded = { ...connection, busy: connection.busy || busy || stale || !!blocker || !!error, command };
  return <Dialog title={pending ? 'Review the exact action' : 'Action details'} closeLabel={pending ? 'Close review' : 'Close action details'} className="action-review-dialog" busy={busy} onClose={close} footer={<>
    <button type="button" disabled={busy} onClick={close}>Close</button>
    {pending && !stale && <ActionDecisions record={snapshot} connection={guarded} />}
  </>}>
    {pending && !stale && <p>Approve only the displayed arguments. Approval runs this exact action and continues the agent automatically. Completed changes cannot be undone here.</p>}
    {stale ? <p role="status">The action has updated{current ? `: ${text(current, 'state') === 'authorized' ? 'Queued' : labelState(text(current, 'state'))}` : ''}. Close this review to see its current state.</p>
      : <Action record={snapshot} connection={guarded} showDecisions={false} />}
    {blocker && <p role="status">{blocker}</p>}
    {(error || connection.error) && <p className="error-text" role="alert">{error || connection.error}</p>}
  </Dialog>;
}
