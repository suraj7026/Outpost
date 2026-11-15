import { useSyncExternalStore } from 'react';
import { call } from './api';
import { sameSetupHost, setupRestartFenced, setupStore, type Entry } from './server-setup-state';

export interface RestartCandidate {
  id: string; label: string; operationId: string; environmentId: string;
  state: string; completedSteps: number; totalSteps: number;
}
export interface RestartReview {
  reviewId: string; resetId: string; sourceId: string; host: string;
  operationId: string; environmentId: string; releaseId: string; expiresAt: number;
  paths: string[]; services: string[]; accounts: string[]; preserved: string[];
  warnings: string[]; blockers: string[]; canReset: boolean;
  state: string; completedSteps: number; totalSteps: number;
}
export interface RestartResult {
  state: 'complete' | 'unknown' | 'failed'; resetId: string; entry: Entry | null; message: string;
}
export interface NoPendingRestart {
  state: 'none'; resetId: ''; entry: null; message: string;
}
export type RestartStatus = RestartResult | NoPendingRestart;
export interface RestartSession {
  connection: Entry; binding: string; open: boolean; busy: '' | 'status' | 'candidates' | 'review' | 'stop' | 'apply';
  candidates: RestartCandidate[] | null; sourceId: string; review: RestartReview | null; reviewBinding: string;
  reconciled: boolean; pending: boolean; resetId: string; result: RestartResult | null; error: string; delivered: boolean;
}
export interface RestartClient {
  candidates: (id: string) => Promise<RestartCandidate[]>;
  review: (id: string, sourceId: string, password: boolean) => Promise<RestartReview>;
  stop: (id: string, sourceId: string, password: boolean) => Promise<void>;
  apply: (id: string, reviewId: string, confirmation: string, password: boolean) => Promise<RestartResult>;
  status: (id: string) => Promise<RestartStatus>;
  beforeApply?: (entry: Entry) => void;
  noPending?: (entry: Entry) => void;
}
export interface RestartErrorPresentation {
  title: string;
  tone: 'warning' | 'negative';
}

/** Display labels only. Error text never establishes authorization, inactivity or a restart outcome. */
export function restartErrorPresentation(error: string): RestartErrorPresentation {
  const tag = /^(?:Could not check restart outcome\. )?(?:Error: )?\[([A-Za-z]+:[A-Za-z]+(?::[A-Za-z]+)?)\](?:\s|$)/.exec(error)?.[1];
  switch (tag) {
    case 'localAuthorization:userCancel': return { title: 'Authorization cancelled', tone: 'warning' };
    case 'localAuthorization:timeout': return { title: 'Authorization prompt timed out', tone: 'warning' };
    case 'localAuthorization:unavailable': return { title: 'Authorization prompt unavailable', tone: 'warning' };
    case 'localAuthorization:invalidResponse': return { title: 'Authorization response invalid', tone: 'negative' };
    case 'localAuthorization:requestCancel': return { title: 'Authorization request cancelled', tone: 'warning' };
    case 'restartRequest:requestCancel': return { title: 'Restart request cancelled', tone: 'warning' };
    case 'restartRequest:requestReplaced':
    case 'restartRequest:targetChanged':
    case 'restartRequest:targetUnverified': return { title: 'Restart request needs a fresh review', tone: 'warning' };
    case 'restartRequest:supervisorUnavailable': return { title: 'Restart request unavailable', tone: 'warning' };
    case 'restartRequest:transportUnavailable': return { title: 'Restart connection unavailable', tone: 'warning' };
    case 'serverExecution:review': return { title: 'Server restart review failed', tone: 'negative' };
    case 'serverProtocol:review': return { title: 'Server review response could not be verified', tone: 'negative' };
    case 'serverExecution:stop': return { title: 'Server stop request unconfirmed', tone: 'negative' };
    case 'serverProtocol:stop': return { title: 'Server stop response could not be verified', tone: 'negative' };
    case 'serverExecution:apply': return { title: 'Server removal outcome unconfirmed', tone: 'negative' };
    case 'serverProtocol:apply': return { title: 'Server removal response could not be verified', tone: 'negative' };
    case 'serverExecution:status': return { title: 'Server restart outcome unavailable', tone: 'negative' };
    case 'serverProtocol:status': return { title: 'Server restart outcome could not be verified', tone: 'negative' };
  }
  if (tag?.startsWith('localAuthorization:processFailure:')) return { title: 'Authorization prompt failed', tone: 'negative' };
  if (tag?.startsWith('restartRequest:')) return { title: 'Restart request could not continue', tone: 'warning' };
  return { title: 'Restart could not continue', tone: 'negative' };
}

export const restartBinding = (entry: Entry) => JSON.stringify([
  entry.id, entry.target.host, entry.target.port, entry.target.user, entry.target.identityFile, entry.fingerprint,
]);
export const restartReviewBinding = (entry: Entry) => JSON.stringify([restartBinding(entry), entry.plan, entry.installation, entry.inspection]);

const nativeRoots = ['/opt/outpost-native', '/etc/outpost-native', '/var/lib/outpost-native'];
const nativeServices = ['outpost-native-worker.service', 'outpost-native-coordinator.service', 'outpost-native-host.service'];
const nativeAccounts = ['user:outpost-coord', 'user:outpost-pi', 'user:outpost-build', 'group:outpost-coord', 'group:outpost-pi', 'group:outpost-build', 'group:outpost-workspaces'];
const fixedSubset = (values: string[], allowed: string[]) => values.every(value => allowed.includes(value)) && new Set(values).size === values.length;
const inactive = new Set(['failed', 'cancelled', 'interrupted', 'ready', 'complete', 'inactive']);
// canReset is the native live lock/service check; state may be a stale running receipt.
export const restartNeedsStop = (review: RestartReview) => !review.canReset && !inactive.has(review.state);
export const restartBusy = (session: RestartSession | undefined) => !!session?.busy;
export const restartHeld = (entry: Entry, sessions: Record<string, RestartSession>) => Object.values(sessions)
  .some(session => session.pending && sameSetupHost(entry, session.connection));

export function validateRestartReview(entry: Entry, source: RestartCandidate, review: RestartReview): RestartReview {
  if (!review.reviewId || !review.resetId || review.sourceId !== source.id || review.host !== entry.target.host
    || review.operationId !== source.operationId || review.environmentId !== source.environmentId || !review.releaseId
    || !Number.isFinite(review.expiresAt) || !Number.isInteger(review.completedSteps) || !Number.isInteger(review.totalSteps)
    || review.completedSteps < 0 || review.totalSteps < 1 || review.completedSteps > review.totalSteps
    || ![review.paths, review.services, review.accounts, review.preserved, review.warnings, review.blockers]
      .every(values => Array.isArray(values) && values.every(value => typeof value === 'string')))
    throw new Error('The restart review does not match the selected operation and verified host. Nothing was removed.');
  if (typeof review.canReset !== 'boolean' || typeof review.state !== 'string' || review.paths.length !== nativeRoots.length
    || !fixedSubset(review.paths, nativeRoots) || !fixedSubset(review.services, nativeServices) || !fixedSubset(review.accounts, nativeAccounts))
    throw new Error('The restart review is outside the fixed native removal scope. Nothing was removed.');
  if (source.id === entry.id && entry.plan && review.releaseId !== entry.plan.releaseId)
    throw new Error('The reviewed release changed. Nothing was removed.');
  return review;
}

export function restartApplyBlocker(entry: Entry, session: RestartSession | undefined, confirmation: string, approved: boolean, now = Date.now()): string {
  if (!session || session.binding !== restartBinding(entry)) return 'The verified SSH connection changed. Review again.';
  if (session.busy) return 'Wait for the current restart action to finish.';
  if (session.pending || session.result) return 'Check restart outcome before doing anything else.';
  if (!session.reconciled) return 'Check for a pending restart first.';
  const review = session.review;
  if (!review || review.sourceId !== session.sourceId) return 'Review the original installation first.';
  if (session.reviewBinding !== restartReviewBinding(entry)) return 'The connection evidence or original operation changed. Review restart again.';
  if (setupRestartFenced(entry)) return 'This original setup is fenced. Check restart outcome.';
  if (now >= review.expiresAt) return 'This restart review expired. Review again and approve the new review.';
  if (restartNeedsStop(review)) return 'Stop installation, then review again to confirm it is inactive.';
  if (!review.canReset || review.blockers.length) return review.blockers.join(' ') || 'Native ownership checks block removal.';
  if (confirmation !== review.host) return 'Type the exact hostname shown in this review.';
  if (!approved) return 'Explicitly approve deleting this native installation and its data.';
  return '';
}

export function validateRestartResult(entry: Entry, result: RestartResult, resetId = '', sourceId = ''): RestartResult {
  if (!['complete', 'unknown', 'failed'].includes(result.state) || typeof result.resetId !== 'string'
    || typeof result.message !== 'string' || resetId && result.resetId !== resetId)
    throw new Error('Restart identity could not be reconciled. Check restart outcome; do not repeat removal.');
  if (!result.resetId) throw new Error('Restart status did not identify a reset receipt.');
  if (result.state !== 'complete') {
    if (result.entry) throw new Error('An unconfirmed restart cannot create a new installation.');
    return result;
  }
  const fresh = result.entry;
  if (!fresh || !fresh.id || fresh.id === entry.id || fresh.id === sourceId || fresh.inspection || fresh.plan || fresh.installation || fresh.endpoint
    || fresh.phase !== 'trusted' || !sameSetupHost(entry, fresh))
    throw new Error('The completed restart did not return a fresh trusted setup for this connection. Check restart outcome.');
  return result;
}

/** Session memory survives modal/settings mounts. Native receipts remain the durable authority. */
export function createRestartController(client: RestartClient, now = Date.now) {
  let sessions: Record<string, RestartSession> = {};
  const listeners = new Set<() => void>();
  const getSnapshot = () => sessions;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const patch = (id: string, value: Partial<RestartSession>) => {
    sessions = { ...sessions, [id]: { ...sessions[id], ...value } };
    for (const listener of [...listeners]) listener();
  };
  const ensure = (entry: Entry) => {
    const current = sessions[entry.id];
    if (current?.binding === restartBinding(entry)) return current;
    if (current?.busy || current?.pending) throw new Error('A restart is unresolved for the previous SSH identity. Check its outcome first.');
    patch(entry.id, { connection: entry, binding: restartBinding(entry), open: false, busy: '', candidates: null,
      sourceId: '', review: null, reviewBinding: '', reconciled: false, pending: false, resetId: '', result: null, error: '', delivered: false });
    return sessions[entry.id];
  };
  const accept = (entry: Entry, result: RestartResult) => {
    const session = sessions[entry.id];

    // Status can use an original, affected or newly verified SSH login. Native binds its
    // immutable creation receipt to the reset origin; the caller need only verify the same host.
    validateRestartResult(entry, result, result.resetId ? session.resetId : '', session.sourceId);
    const confirmed = Object.values(sessions).find(peer => peer.resetId === result.resetId && peer.result?.state === 'complete')?.result;
    if (result.state === 'complete' && confirmed?.entry && confirmed.entry.id !== result.entry?.id)
      throw new Error('The confirmed restart changed its fresh setup identity. Check restart outcome.');
    patch(entry.id, { result: result.resetId ? result : null, resetId: result.resetId, reconciled: true,
      pending: !!result.resetId && result.state !== 'complete', review: null, error: '' });
    if (result.state === 'complete') {
      for (const peer of Object.values(sessions)) {
        if (peer.connection.id !== entry.id && peer.resetId === result.resetId && sameSetupHost(peer.connection, entry))
          patch(peer.connection.id, { pending: false, result, reconciled: true, review: null, error: '', delivered: true });
      }
    }
    if (result.resetId && result.state !== 'complete') client.beforeApply?.(entry);
  };
  const acceptNoPending = (entry: Entry, status: NoPendingRestart) => {
    if (status.resetId !== '' || status.entry !== null || typeof status.message !== 'string')
      throw new Error('Invalid no-pending restart status. Nothing was unlocked.');
    if (setupRestartFenced(entry))
      throw new Error('The fenced setup has no reconciled restart receipt. Keep it read-only and check restart outcome.');
    patch(entry.id, { result: null, resetId: '', reconciled: true, pending: false, review: null, error: '' });
    if (!Object.values(sessions).some(peer => peer.pending && sameSetupHost(entry, peer.connection))) client.noPending?.(entry);
  };
  const check = async (entry: Entry): Promise<boolean> => {
    const session = ensure(entry);
    if (session.busy) return false;
    patch(entry.id, { busy: 'status', error: '', review: null, reconciled: false });
    try {
      const status = await client.status(entry.id);
      if (status.state === 'none') acceptNoPending(entry, status);
      else accept(entry, status);
      return true;
    } catch (error) {
      patch(entry.id, { error: `Could not check restart outcome. ${String(error)}` }); return false;
    }
    finally { patch(entry.id, { busy: '' }); }
  };
  const candidates = async (entry: Entry) => {
    const session = ensure(entry);
    if (session.busy || session.pending || session.result || !session.reconciled) return;
    patch(entry.id, { busy: 'candidates', error: '', review: null });
    try {
      const values = await client.candidates(entry.id);
      if (!Array.isArray(values) || values.some(value => !value.id || !value.operationId || !value.environmentId)
        || new Set(values.map(value => value.id)).size !== values.length) throw new Error('Invalid original setup candidates.');
      patch(entry.id, { candidates: values, sourceId: values.length === 1 ? values[0].id : '' });
    } catch (error) { patch(entry.id, { error: String(error) }); }
    finally { patch(entry.id, { busy: '' }); }
  };
  const open = async (entry: Entry) => {
    ensure(entry); patch(entry.id, { open: true, review: null });
    if (await check(entry)) await candidates(entry);
  };
  const close = (id: string) => { if (sessions[id]) patch(id, { open: false, review: null }); };
  const choose = (entry: Entry, sourceId: string) => {
    const session = ensure(entry);
    if (session.busy || session.pending || session.result || !session.candidates?.some(value => value.id === sourceId)) return;
    patch(entry.id, { sourceId, review: null, error: '' });
  };
  const review = async (entry: Entry, password: boolean) => {
    const session = ensure(entry), source = session.candidates?.find(value => value.id === session.sourceId);
    if (!source || session.busy || session.pending || session.result || !session.reconciled || setupRestartFenced(entry)) return false;
    patch(entry.id, { busy: 'review', review: null, error: '' });
    try {
      const result = validateRestartReview(entry, source, await client.review(entry.id, source.id, password));
      if (sessions[entry.id].open) patch(entry.id, { review: result, reviewBinding: restartReviewBinding(entry) });
      return true;
    } catch (error) { patch(entry.id, { error: String(error) }); return false; }
    finally { patch(entry.id, { busy: '' }); }
  };
  const stop = async (entry: Entry, password: boolean) => {
    const session = ensure(entry), review = session.review;
    if (session.busy || session.pending || !review || !restartNeedsStop(review) || now() >= review.expiresAt) return false;
    patch(entry.id, { busy: 'stop', review: null, error: '' });
    try { await client.stop(entry.id, review.sourceId, password); return true; }
    catch (error) { patch(entry.id, { error: String(error) }); return false; }
    finally { patch(entry.id, { busy: '' }); }
  };
  const apply = async (entry: Entry, confirmation: string, approved: boolean, password: boolean) => {
    const session = ensure(entry);
    const peerPending = Object.values(sessions).some(peer => peer !== session && peer.pending && sameSetupHost(entry, peer.connection));
    const blocker = peerPending ? 'Another restart is pending for this verified host. Check restart outcome.'
      : restartApplyBlocker(entry, session, confirmation, approved, now());
    if (blocker) { patch(entry.id, { error: blocker }); return false; }
    const review = session.review;
    if (!review) return false;
    // Fence before IPC: even a rejected/lost reply cannot authorize a second destructive request.
    patch(entry.id, { busy: 'apply', pending: true, resetId: review.resetId, error: '', review: null });
    client.beforeApply?.(entry);
    try { accept(entry, await client.apply(entry.id, review.reviewId, confirmation, password)); return true; }
    catch (error) {
      patch(entry.id, { pending: true, result: { state: 'unknown', resetId: review.resetId, entry: null,
        message: 'Removal may have started. Check the durable restart receipt before continuing.' }, error: String(error) });
      return false;
    } finally { patch(entry.id, { busy: '' }); }
  };
  const delivered = (id: string) => { if (sessions[id]?.result?.state === 'complete') patch(id, { delivered: true, open: false }); };
  return { getSnapshot, subscribe, open, close, check, candidates, choose, review, stop, apply, delivered };
}

export const setupRestarts = createRestartController({
  candidates: id => call<RestartCandidate[]>('setup_restart_candidates', { id }),
  review: (id, sourceId, password) => call<RestartReview>('setup_restart_review', { id, sourceId, password }),
  stop: (id, sourceId, password) => call<void>('setup_restart_stop', { id, sourceId, password }),
  apply: (id, reviewId, confirmation, password) => call<RestartResult>('setup_restart_apply', { id, reviewId, confirmation, password }),
  status: id => call<RestartStatus>('setup_restart_status', { id }),
  beforeApply: entry => setupStore.holdRestart(entry),
  noPending: entry => setupStore.releaseRestart(entry),
});
export function useSetupRestarts() {
  return useSyncExternalStore(setupRestarts.subscribe, setupRestarts.getSnapshot, setupRestarts.getSnapshot);
}
