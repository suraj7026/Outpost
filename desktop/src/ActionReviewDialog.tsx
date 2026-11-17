import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Interface';
import { Action, ActionDecisions } from './TaskAction';
import { nativeApp, recordedPreview } from './api';
import { unchangedReviewedAction } from './action-review';
import { workspaceBlocker } from './workspace-presentation';
import { labelState, text, type ServerRecord } from './types';
import type { Connection } from './useConnection';

export default function ActionReviewDialog({ snapshot, connection, onClose }: {
  snapshot: ServerRecord; connection: Connection; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), alive = useRef(true), latest = useRef(connection);
  const owner = useRef(connection.environmentId);
  latest.current = connection;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = connection.records.find(record => record.kind === 'action' && record.id === snapshot.id);
  const stale = connection.environmentId !== owner.current || !unchangedReviewedAction(snapshot, current);
  const blocker = workspaceBlocker(connection, nativeApp(), recordedPreview());
  const close = () => { if (!working.current) onClose(); };
  const command: Connection['command'] = async (kind, id, revision, payload) => {
    if (!alive.current || working.current) return undefined;
    const live = latest.current;
    const action = live.records.find(record => record.kind === 'action' && record.id === snapshot.id);
    if (live.environmentId !== owner.current || id !== snapshot.id || revision !== snapshot.revision || !unchangedReviewedAction(snapshot, action)) {
      setError('The action changed. Close and reopen review before deciding.'); return undefined;
    }
    const blocked = workspaceBlocker(live, nativeApp(), recordedPreview());
    if (blocked) { setError(blocked); return undefined; }
    const state = text(snapshot, 'state');
    if (kind === 'approval.decide') {
      if (state !== 'pending' || payload?.nonce !== text(snapshot, 'nonce') || payload?.actionDigest !== text(snapshot, 'actionDigest') || !['approve', 'deny'].includes(String(payload?.decision))) return undefined;
    } else if (kind !== 'action.dispatch' || state !== 'authorized') return undefined;
    working.current = true; setBusy(true); setError('');
    try {
      const result = await live.command(kind, id, revision, payload);
      if (alive.current && (!result || result.kind !== 'action' || result.id !== id || result.revision <= revision)) setError('Could not confirm the outcome. Check server recovery before trying again.');
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
  return <Dialog title="Review the exact action" closeLabel="Close review" className="action-review-dialog" busy={busy} onClose={close} footer={<>
    <button type="button" disabled={busy} onClick={close}>Close</button>
    {!stale && <ActionDecisions record={snapshot} connection={guarded} />}
  </>}>
    <p>Approve only the displayed arguments. Completed changes cannot be undone here.</p>
    {stale ? <p role="status">The action has updated{current ? `: ${labelState(text(current, 'state'))}` : ''}. Close this review to see its current state.</p>
      : <Action record={snapshot} connection={guarded} showDecisions={false} />}
    {blocker && <p role="status">{blocker}</p>}
    {(error || connection.error) && <p className="error-text" role="alert">{error || connection.error}</p>}
  </Dialog>;
}
