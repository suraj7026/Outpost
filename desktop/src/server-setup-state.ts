import { useSyncExternalStore } from 'react';
import { call, nativeApp, recordedPreview } from './api';

export interface Target { host: string; user: string; port: number; identityFile: string | null }
export interface Inspection {
  os: string; osVersion: string; architecture: string; systemd: boolean; uid: number;
  freeBytes: number; memoryBytes: number; markers: string[]; sudo: string; api: string;
  container?: boolean; nativePresent?: boolean; apiPort?: number;
  environment: { environmentId: string; release: string | null } | null;
}
export interface InstallPlan {
  planId: string; operationId: string; environmentId: string; releaseId: string;
  sha256: string; size: number; expiresAt: number; browser: boolean; fullControl: boolean; coexistenceRequired: boolean;
  deviceId: string; publicKey: string; nodeVersion: string;
}
export interface InstallProgress {
  operationId: string; environmentId: string; releaseId: string; state: string;
  completedSteps: number; totalSteps: number; stage: string; startedAt: number; updatedAt: number;
  log: string[]; error: string | null;
}
export interface Entry {
  id: string; label: string; target: Target; fingerprint: string; phase: string;
  inspection: Inspection | null; recommendation: string | null; endpoint: string | null;
  error: string | null; log: string[];
  plan?: InstallPlan | null; installation?: InstallProgress | null;
}
export interface Scan { id: string; target: Target; fingerprint: string }

export interface ServerSetupState {
  entries: Entry[];
  busy: Record<string, string>;
  errors: Record<string, string>;
  statusErrors: Record<string, string>;
  lastChecked: Record<string, number>;
  journalError: string;
  loading: boolean;
  journalReady: boolean;
  archivedIds: string[];
  historyLoading: boolean;
  historyLoaded: boolean;
  historyError: string;
  historyErrors: Record<string, string>;
  historyBusy: string;
  checkingStatus: Record<string, boolean>;
  reloadHistory: () => Promise<void>;
  archive: (id: string) => Promise<boolean>;
  restore: (id: string) => Promise<boolean>;
  /** Command callers validate their captured target ID with mergeSetupEntry before replacing a response. */
  replace: (entry: Entry) => void;
  invalidatePlan: (id: string) => boolean;
  holdRestart: (entry: Entry) => void;
  releaseRestart: (entry: Entry) => void;
  completeRestart: (connection: Entry, fresh: Entry) => void;
  operate: (id: string, label: string, action: () => Promise<void>) => Promise<boolean>;
  checkStatus: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

export interface SetupClient {
  enabled: () => boolean;
  list: () => Promise<Entry[]>;
  status: (id: string) => Promise<Entry>;
  // Older injectable clients can still read the journal when history IPC is unavailable.
  historyList?: () => Promise<string[]>;
  historyArchive?: (id: string) => Promise<string[]>;
  historyRestore?: (id: string) => Promise<string[]>;
}
export interface SetupStoreOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  journalIntervalMs?: number;
  statusIntervalMs?: number;
  historyIntervalMs?: number;
}

const stoppedStates = new Set(['failed', 'cancelled', 'interrupted']);
const terminalStates = new Set(['complete', 'ready', ...stoppedStates]);
export const setupRestartFenced = (entry: Entry) => ['reset', 'restart_pending'].includes(entry.phase);
export const setupWasExecuted = (entry: Entry) => !!entry.installation || ['installing', 'installed', 'authorizing', 'unknown', 'reset', 'restart_pending'].includes(entry.phase);
export const canVisitSetupStage = (step: number, furthest: number) => Number.isInteger(step) && step >= 0 && step <= furthest;
const canonicalSetupHost = (host: string) => {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname; } catch { return value; }
  }
  return value;
};
export const sameSetupHost = (left: Entry, right: Entry) => canonicalSetupHost(left.target.host) === canonicalSetupHost(right.target.host)
  && left.target.port === right.target.port && !!left.fingerprint && left.fingerprint === right.fingerprint;
const isActive = (entry: Entry) => !setupRestartFenced(entry) && !!entry.installation && !terminalStates.has(entry.installation.state);
const archiveBusyPhases = new Set(['inspecting', 'connecting', 'queued', 'running']);
const inactivePhases = new Set(['trusted', 'review', 'install_review', 'tunnel_ready', 'disconnected', 'failed', 'interrupted', 'cancelled', 'complete', 'ready']);
// Match native history visibility: SSH connection recovery must not undo an existing archive.
const historyActive = (entry: Entry) => !setupRestartFenced(entry) && (isActive(entry) || ['installing', 'authorizing', 'unknown'].includes(entry.phase));
const archiveBlocked = (entry: Entry) => historyActive(entry) || archiveBusyPhases.has(entry.phase)
  || !entry.installation && !inactivePhases.has(entry.phase);

export function setupArchiveBlocker(entry: Entry, busy = '', statusError = ''): string {
  if (busy) return 'Wait for this setup’s current action to finish before removing it from the list.';
  if (entry.phase === 'reset') return '';
  if (entry.phase === 'restart_pending') return 'Check restart outcome before changing this history. Removal is not confirmed.';
  if (statusError) return 'Current installation status is unavailable. Check progress before removing this setup.';
  if (archiveBlocked(entry)) return 'Active or unconfirmed setups cannot be removed. Check progress; stopping an installation is a separate action.';
  return '';
}

function archiveIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim()))
    throw new Error('Invalid setup history response. Existing setups are unchanged.');
  return [...new Set(value)];
}
type Identity = Pick<InstallPlan, 'operationId' | 'environmentId' | 'releaseId'>;
const sameIdentity = (left: Identity, right: Identity) => left.operationId === right.operationId
  && left.environmentId === right.environmentId && left.releaseId === right.releaseId;
const validIdentity = (value: Identity) => [value.operationId, value.environmentId, value.releaseId]
  .every(id => typeof id === 'string' && id.length > 0);
const sameReceipt = (left: InstallProgress, right: InstallProgress) => sameIdentity(left, right)
  && left.state === right.state && left.completedSteps === right.completedSteps && left.totalSteps === right.totalSteps
  && left.startedAt === right.startedAt && left.updatedAt === right.updatedAt && left.stage === right.stage
  && left.error === right.error && left.log.length === right.log.length && left.log.every((line, index) => line === right.log[index]);

/** Reject foreign receipts; ignore older snapshots without also regressing their phase, endpoint or log. */
export function mergeSetupEntry(current: Entry | undefined, incoming: Entry, expectedId: string): Entry {
  if (!expectedId || incoming.id !== expectedId || current && current.id !== expectedId)
    throw new Error('Setup response does not match the requested target.');
  if (current && (current.fingerprint !== incoming.fingerprint || current.target.host !== incoming.target.host
    || current.target.port !== incoming.target.port || current.target.user !== incoming.target.user
    || current.target.identityFile !== incoming.target.identityFile))
    throw new Error('Saved SSH identity cannot be overwritten. Scan and verify a new setup instead.');
  if (current?.phase === 'reset') return current;
  if (setupRestartFenced(incoming)) return { ...incoming, endpoint: null };
  if (current?.phase === 'restart_pending') return current;
  const plan = incoming.plan, progress = incoming.installation;
  if (plan && (!plan.planId || !validIdentity(plan) || !Number.isFinite(plan.expiresAt)))
    throw new Error('Invalid installation plan identity.');
  if (progress && (!validIdentity(progress) || !Number.isInteger(progress.completedSteps)
    || !Number.isInteger(progress.totalSteps) || progress.completedSteps < 0
    || progress.totalSteps < 1 || progress.completedSteps > progress.totalSteps
    || !Number.isFinite(progress.updatedAt) || progress.updatedAt < 0
    || !Number.isFinite(progress.startedAt) || progress.startedAt < 0))
    throw new Error('Invalid installation receipt.');
  if (plan && progress && !sameIdentity(plan, progress))
    throw new Error('Installation receipt does not match its plan.');

  const previous = current?.installation;
  const expected = previous ?? current?.plan;
  if (progress && expected && !sameIdentity(expected, progress))
    throw new Error('Installation receipt does not match the expected operation, environment and release.');
  if (previous && plan && (!sameIdentity(previous, plan) || current?.plan && current.plan.planId !== plan.planId))
    throw new Error('An installation already exists; its reviewed plan cannot be replaced.');
  if (progress && current?.plan && plan && current.plan.planId !== plan.planId)
    throw new Error('Installation receipt does not match the reviewed plan.');

  if (previous) {
    if (!progress) return current;
    if (progress.totalSteps !== previous.totalSteps)
      throw new Error('Installation receipt changed its total number of steps.');
    if (progress.completedSteps < previous.completedSteps) return current;
    const unchanged = sameReceipt(previous, progress);
    const completing = previous.state === 'ready' && progress.state === 'complete';
    if (['ready', 'complete'].includes(previous.state) && !completing && !unchanged) return current;
    if (stoppedStates.has(previous.state) && !unchanged
      && (progress.updatedAt <= previous.updatedAt || ['authorizing', 'complete'].includes(progress.state))) return current;

    // Native launch/unknown observations and registration use the Mac clock; receipts use the host clock.
    // A zero-step unknown has no IPC provenance. Native runtime checks own its ambiguous freshness.
    const resolvingLaunch = previous.state === 'authorizing' && progress.state !== 'authorizing'
      || previous.state === 'unknown' && previous.completedSteps === 0;
    if (!resolvingLaunch && !completing) {
      if (progress.updatedAt < previous.updatedAt) return current;
      if (progress.updatedAt === previous.updatedAt && progress.completedSteps === previous.completedSteps
        && (progress.state === previous.state && !unchanged || previous.state === 'running' && progress.state === 'unknown')) return current;
    }
    // An identical receipt can accompany a new endpoint/connection phase; do not freeze those fields.
    if (progress.state === 'authorizing' && !['authorizing', 'unknown'].includes(previous.state)) return current;
    if (previous.state === 'running' && progress.state === 'queued') return current;
  } else if (current?.plan && !progress) {
    if (!plan || plan.expiresAt < current.plan.expiresAt) return current;
  }
  return current?.plan && !plan ? { ...incoming, plan: current.plan } : incoming;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
const scheduleTimeout = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** One store per application lifetime, not per panel or selected environment. Tests inject all I/O and timers. */
export function createSetupStore(client: SetupClient, options: SetupStoreOptions = {}) {
  const now = options.now ?? Date.now, schedule = options.schedule ?? scheduleTimeout;
  const listeners = new Set<() => void>(), locks = new Set<string>();
  const restartHolds: Entry[] = [];
  const invalidPlans = new Map<string, Set<string>>();
  const held = (entry: Entry | undefined) => !!entry && (setupRestartFenced(entry) || restartHolds.some(source => sameSetupHost(source, entry)));
  const withoutInvalidPlan = (entry: Entry): Entry => !entry.installation && entry.plan && invalidPlans.get(entry.id)?.has(entry.plan.planId)
    ? { ...entry, plan: null } : entry;
  const generations = new Map<string, number>(), appliedReads = new Map<string, number>();
  const statusRequests = new Map<string, Promise<void>>(), statusTimers = new Map<string, () => void>();
  let journalRequest: Promise<void> | undefined, journalTimer: (() => void) | undefined;
  let historyRequest: Promise<void> | undefined, historyTimer: (() => void) | undefined;
  let historyGeneration = 0;
  const historyRevivals = new Map<string, number>();
  let readSequence = 0, disposed = false;
  let state: ServerSetupState = {
    entries: [], busy: {}, errors: {}, statusErrors: {}, lastChecked: {}, journalError: '', loading: false, journalReady: false,
    archivedIds: [], historyLoading: false, historyLoaded: false, historyError: '', historyErrors: {}, historyBusy: '', checkingStatus: {},
    replace, invalidatePlan, holdRestart, releaseRestart, completeRestart, operate, checkStatus, reload, reloadHistory, archive, restore,
  };
  const getSnapshot = () => state;
  const enabled = () => !disposed && client.enabled();
  const generation = (id: string) => generations.get(id) ?? 0;
  const invalidate = (id: string) => generations.set(id, generation(id) + 1);
  const find = (id: string) => state.entries.find(entry => entry.id === id);
  const publish = (patch: Partial<ServerSetupState>) => {
    if (disposed) return;
    if (patch.entries) {
      for (const entry of patch.entries) {
        const previous = state.entries.find(value => value.id === entry.id);
        if (historyActive(entry) && (!previous || !historyActive(previous))) historyRevivals.set(entry.id, ++historyGeneration);
      }
    }
    state = { ...state, ...patch };
    const archivedIds = state.archivedIds.filter(id => !state.entries.some(entry => entry.id === id && historyActive(entry)));
    if (archivedIds.length !== state.archivedIds.length) state = { ...state, archivedIds };
    for (const listener of [...listeners]) listener();
  };
  const upsert = (entries: Entry[], entry: Entry) => {
    const index = entries.findIndex(value => value.id === entry.id);
    if (index < 0) return [...entries, entry];
    if (entries[index] === entry) return entries;
    return entries.map((value, position) => position === index ? entry : value);
  };
  const validRead = (id: string, version: number, ticket: number) => enabled() && !locks.has(id)
    && generation(id) === version && ticket >= (appliedReads.get(id) ?? 0);

  function syncPolling() {
    const active = state.entries.filter(entry => isActive(entry) && !held(entry));
    const needed = enabled() && (listeners.size > 0 || locks.size > 0 || active.length > 0);
    if (!needed) { journalTimer?.(); journalTimer = undefined; }
    else if (!journalRequest && !journalTimer) {
      journalTimer = schedule(() => { journalTimer = undefined; void reload(); }, options.journalIntervalMs ?? 1500);
    }
    if (!enabled() || !listeners.size || state.historyBusy || !client.historyList) { historyTimer?.(); historyTimer = undefined; }
    else if (!historyRequest && !historyTimer) {
      historyTimer = schedule(() => { historyTimer = undefined; void reloadHistory(); }, options.historyIntervalMs ?? 1500);
    }
    const ids = new Set(needed ? active.filter(entry => !locks.has(entry.id)).map(entry => entry.id) : []);
    for (const [id, cancel] of statusTimers) {
      if (!ids.has(id)) { cancel(); statusTimers.delete(id); }
    }
    for (const id of ids) {
      if (statusRequests.has(id) || statusTimers.has(id)) continue;
      statusTimers.set(id, schedule(() => {
        statusTimers.delete(id);
        void checkStatus(id);
      }, options.statusIntervalMs ?? 2500));
    }
  }

  function replace(entry: Entry) {
    if (disposed) return;
    const merged = withoutInvalidPlan(mergeSetupEntry(find(entry.id), entry, entry.id));
    invalidate(entry.id);
    publish({ entries: upsert(state.entries, merged) });
    syncPolling();
  }

  function invalidatePlan(id: string): boolean {
    const entry = find(id);
    if (!entry || locks.has(id) || held(entry) || setupWasExecuted(entry)) return false;
    if (entry.plan) {
      const invalid = invalidPlans.get(id) ?? new Set<string>();
      invalid.add(entry.plan.planId); invalidPlans.set(id, invalid);
    }
    invalidate(id);
    publish({ entries: upsert(state.entries, { ...entry, plan: null }) });
    return true;
  }

  function holdRestart(entry: Entry) {
    if (!restartHolds.some(source => sameSetupHost(source, entry))) restartHolds.push(entry);
    for (const peer of state.entries.filter(peer => sameSetupHost(peer, entry))) invalidate(peer.id);
    syncPolling();
  }

  function releaseRestart(connection: Entry) {
    for (let index = restartHolds.length - 1; index >= 0; index--)
      if (sameSetupHost(restartHolds[index], connection)) restartHolds.splice(index, 1);
    syncPolling();
  }

  function completeRestart(connection: Entry, fresh: Entry) {
    if (!fresh.id || fresh.id === connection.id || fresh.phase !== 'trusted' || fresh.inspection || fresh.plan || fresh.installation || fresh.endpoint
      || !sameSetupHost(connection, fresh))
      throw new Error('Restart did not return a fresh trusted connection.');
    const current = find(fresh.id);
    const creation = mergeSetupEntry(current, fresh, fresh.id);
    const previousRead = journalRequest;
    for (let index = restartHolds.length - 1; index >= 0; index--)
      if (sameSetupHost(restartHolds[index], connection)) restartHolds.splice(index, 1);
    // The immutable creation receipt must not replace subsequent inspection, plans or progress.
    invalidate(fresh.id);
    publish({ entries: upsert(state.entries, current ?? creation) });
    // Only native history knows which IDs this reset affected. A host match can include newer work.
    // Follow any pre-completion journal flight with a new read of authoritative phases.
    void (previousRead ?? Promise.resolve()).then(() => reload());
    syncPolling();
  }

  async function operate(id: string, label: string, action: () => Promise<void>): Promise<boolean> {
    if (!enabled() || locks.has(id) || held(find(id))) return false;
    locks.add(id);
    invalidate(id);
    publish({ busy: { ...state.busy, [id]: label }, errors: withoutKey(state.errors, id) });
    syncPolling();
    try {
      await action();
      return true;
    } catch (error) {
      publish({ errors: { ...state.errors, [id]: String(error) } });
      return false;
    } finally {
      // Also reject reads issued during a command, even when it failed or did not call replace.
      invalidate(id);
      locks.delete(id);
      publish({ busy: withoutKey(state.busy, id) });
      syncPolling();
    }
  }

  function reload(): Promise<void> {
    if (!enabled()) return Promise.resolve();
    if (journalRequest) return journalRequest;
    journalTimer?.(); journalTimer = undefined;
    const versions = new Map(generations), busyAtStart = new Set(locks), ticket = ++readSequence;
    // Reserve the flight before notifying React or invoking a potentially synchronous test client.
    journalRequest = Promise.resolve().then(() => enabled() ? client.list() : undefined).then(entries => {
      if (!enabled() || !entries) return;
      let next = state.entries;
      const failures: string[] = [], seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.id)) { failures.push('Duplicate setup target in the local journal.'); continue; }
        seen.add(entry.id);
        if (busyAtStart.has(entry.id) || !validRead(entry.id, versions.get(entry.id) ?? 0, ticket)) continue;
        try {
          const merged = withoutInvalidPlan(mergeSetupEntry(next.find(value => value.id === entry.id), entry, entry.id));
          // Cached journal reads must not invalidate a slower, authoritative remote receipt request.
          next = upsert(next, merged);
        } catch (error) { failures.push(String(error)); }
      }
      // History archiving never deletes journal entries or saved connection bindings.
      publish({ entries: next, journalError: failures.join(' '), journalReady: state.journalReady || failures.length === 0 });
    }).catch(error => {
      if (enabled()) publish({ journalError: `Could not read the local SSH setup journal. Existing environment connections are unchanged. ${String(error)}` });
    }).finally(() => {
      journalRequest = undefined;
      publish({ loading: false });
      syncPolling();
    });
    publish({ loading: true });
    return journalRequest;
  }

  function reloadHistory(): Promise<void> {
    if (!enabled() || state.historyBusy) return Promise.resolve();
    if (historyRequest) return historyRequest;
    historyTimer?.(); historyTimer = undefined;
    const version = historyGeneration;
    const activeAtStart = new Set(state.entries.filter(historyActive).map(entry => entry.id));
    const current = () => enabled() && version === historyGeneration;
    historyRequest = Promise.resolve().then(() => {
      if (!current()) return undefined;
      if (!client.historyList) throw new Error('Setup history is unavailable in this client.');
      return client.historyList();
    }).then(ids => {
      if (current()) publish({ archivedIds: archiveIds(ids).filter(id => !activeAtStart.has(id)), historyLoaded: true, historyError: '' });
    }).catch(error => {
      if (current()) publish({ historyError: `Could not read archived setups. The setup journal and saved connections are unchanged. ${String(error)}` });
    }).finally(() => {
      historyRequest = undefined;
      publish({ historyLoading: false });
      syncPolling();
    });
    publish({ historyLoading: true });
    return historyRequest;
  }

  async function changeHistory(id: string, removing: boolean): Promise<boolean> {
    if (!enabled() || state.historyBusy) return false;
    const entry = find(id);
    const blocked = !entry ? 'This setup is no longer available.'
      : locks.has(id) || statusRequests.has(id) ? 'Wait for this setup’s current action to finish.'
      : !state.historyLoaded || state.historyError ? 'Load archived setups successfully before changing the list.'
      : removing ? setupArchiveBlocker(entry, state.busy[id], state.statusErrors[id]) : '';
    if (blocked) { publish({ historyErrors: { ...state.historyErrors, [id]: blocked } }); return false; }
    locks.add(id);
    invalidate(id);
    const version = ++historyGeneration;
    const activeAtStart = new Set(state.entries.filter(historyActive).map(entry => entry.id));
    publish({ historyBusy: id, busy: { ...state.busy, [id]: removing ? 'Removing from list' : 'Restoring setup' },
      historyErrors: withoutKey(state.historyErrors, id) });
    syncPolling();
    try {
      const command = removing ? client.historyArchive : client.historyRestore;
      if (!command) throw new Error('Setup history changes are unavailable in this client.');
      // Native rechecks inactivity; the renderer never deletes a receipt, trust record or binding.
      const ids = archiveIds(await command(id));
      if (!enabled()) return false;
      publish({ archivedIds: ids.filter(value => !activeAtStart.has(value) && (historyRevivals.get(value) ?? 0) <= version), historyLoaded: true, historyError: '' });
      const applied = removing ? state.archivedIds.includes(id) : !state.archivedIds.includes(id);
      if (!applied) publish({ historyErrors: { ...state.historyErrors, [id]: removing
        ? 'This setup was not archived. Check its current progress before trying again.'
        : 'This setup is still archived. Refresh history before trying again.' } });
      return applied;
    } catch (error) {
      publish({ historyErrors: { ...state.historyErrors, [id]: String(error) } });
      return false;
    } finally {
      historyGeneration++;
      invalidate(id);
      locks.delete(id);
      publish({ historyBusy: '', busy: withoutKey(state.busy, id) });
      syncPolling();
    }
  }
  function archive(id: string) { return changeHistory(id, true); }
  function restore(id: string) { return changeHistory(id, false); }

  function checkStatus(id: string): Promise<void> {
    if (!enabled()) return Promise.resolve();
    const pending = statusRequests.get(id);
    if (pending) return pending;
    if (locks.has(id) || held(find(id)) || !find(id)?.installation) return Promise.resolve();
    statusTimers.get(id)?.(); statusTimers.delete(id);
    const version = generation(id), ticket = ++readSequence;
    const request = Promise.resolve().then(() => validRead(id, version, ticket) ? client.status(id) : undefined).then(entry => {
      if (!entry || !validRead(id, version, ticket)) return;
      const merged = mergeSetupEntry(find(id), entry, id);
      appliedReads.set(id, ticket);
      publish({ entries: upsert(state.entries, merged), statusErrors: withoutKey(state.statusErrors, id),
        lastChecked: { ...state.lastChecked, [id]: Math.max(state.lastChecked[id] ?? 0, now()) } });
    }).catch(error => {
      if (validRead(id, version, ticket)) {
        appliedReads.set(id, ticket);
        publish({ statusErrors: { ...state.statusErrors, [id]: String(error) },
          lastChecked: { ...state.lastChecked, [id]: Math.max(state.lastChecked[id] ?? 0, now()) } });
      }
    }).finally(() => {
      statusRequests.delete(id);
      publish({ checkingStatus: withoutKey(state.checkingStatus, id) });
      syncPolling();
    });
    statusRequests.set(id, request);
    publish({ checkingStatus: { ...state.checkingStatus, [id]: true } });
    return request;
  }

  const subscribe = (listener: () => void) => {
    if (disposed) return () => {};
    listeners.add(listener);
    if (listeners.size === 1) { void reload(); void reloadHistory(); }
    syncPolling();
    return () => { listeners.delete(listener); syncPolling(); };
  };
  const dispose = () => {
    disposed = true;
    listeners.clear();
    syncPolling();
  };
  return { getSnapshot, subscribe, dispose, replace, invalidatePlan, holdRestart, releaseRestart, completeRestart, operate, checkStatus, reload, reloadHistory, archive, restore };
}

export const setupStore = createSetupStore({
  enabled: () => typeof window !== 'undefined' && nativeApp() && !recordedPreview(),
  list: () => call<Entry[]>('setup_list'),
  status: id => call<Entry>('setup_install_status', { id }),
  historyList: () => call<string[]>('setup_history_list'),
  historyArchive: id => call<string[]>('setup_history_archive', { id }),
  historyRestore: id => call<string[]>('setup_history_restore', { id }),
});

export function useServerSetup(): ServerSetupState {
  return useSyncExternalStore(setupStore.subscribe, setupStore.getSnapshot, setupStore.getSnapshot);
}
