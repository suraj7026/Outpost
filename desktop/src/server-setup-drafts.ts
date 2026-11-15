import { useSyncExternalStore } from 'react';
import type { Entry, Scan, Target } from './server-setup-state';

export interface Draft {
  id: string; label: string; host: string; user: string; port: string;
  identityFile: string; auth: 'agent' | 'file'; scan: Scan | null; confirmed: boolean;
  defaultLabel: string | null;
  labelTouched: boolean;
}
export type DraftPatch = Partial<Pick<Draft, 'label' | 'host' | 'user' | 'port' | 'identityFile' | 'auth' | 'scan' | 'confirmed'>>;
export interface DraftState {
  drafts: Draft[];
  busy: Record<string, string>;
  errors: Record<string, string>;
  committing: Record<string, boolean>;
  uncertainTrust: Record<string, boolean>;
}
export interface DraftRequest {
  current: () => boolean;
  update: (patch: DraftPatch) => void;
  keepTrustPending: () => void;
}

export function isDraftEdited(draft: Draft): boolean {
  const label = draft.label.trim(), port = draft.port.trim();
  return !!label && label !== (draft.defaultLabel ?? '') || !!draft.host.trim() || !!draft.user.trim()
    || !!port && Number(port) !== 22 || draft.auth !== 'agent' || !!draft.identityFile.trim();
}

export function nextSetupLabel(labels: Iterable<string>): string {
  const used = new Set([...labels].map(label => label.trim()));
  let number = 1;
  while (used.has(`Outpost ${number}`)) number++;
  return `Outpost ${number}`;
}

export const sameSetupTarget = (left: Target, right: Target) => left.host === right.host
  && left.user === right.user && left.port === right.port && left.identityFile === right.identityFile;

export function targetForDraft(draft: Draft): Target {
  const host = draft.host.trim().replace(/^\[([^\]]+)\]$/, '$1'), user = draft.user.trim(), port = Number(draft.port);
  if (!draft.label.trim() || !host || /[\s/@]/.test(host) || host.startsWith('-') || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user)
    || !Number.isInteger(port) || port < 1 || port > 65535 || draft.auth === 'file' && !draft.identityFile.trim())
    throw new Error('Enter a server name, a hostname or IP address, an SSH username, a port from 1 to 65535, and a private key path if selected.');
  return { host, user, port, identityFile: draft.auth === 'file' ? draft.identityFile.trim() : null };
}

function without<T>(record: Record<string, T>, id: string) {
  const next = { ...record };
  delete next[id];
  return next;
}

/** Unsaved SSH details live only in this application's memory, independent of settings mounts. */
export function createDraftController(makeId = () => `draft-${crypto.randomUUID()}`) {
  let state: DraftState = { drafts: [], busy: {}, errors: {}, committing: {}, uncertainTrust: {} };
  const listeners = new Set<() => void>();
  const requests = new Map<string, object>();
  const getSnapshot = () => state;
  const find = (id: string) => state.drafts.find(draft => draft.id === id);
  const publish = (patch: Partial<DraftState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const remove = (id: string) => {
    requests.delete(id);
    publish({ drafts: state.drafts.filter(draft => draft.id !== id), busy: without(state.busy, id),
      errors: without(state.errors, id), committing: without(state.committing, id), uncertainTrust: without(state.uncertainTrust, id) });
  };
  const discard = (id: string) => {
    if (!find(id) || state.committing[id]) return false;
    remove(id);
    return true;
  };
  const leave = (id: string) => {
    const draft = find(id);
    if (!draft || state.committing[id]) return;
    if (!isDraftEdited(draft)) { remove(id); return; }
    // A dismissed picker/scan must not edit a retained draft after a later visit.
    if (requests.delete(id)) publish({ busy: without(state.busy, id) });
  };
  const leaveAll = () => { for (const draft of state.drafts) leave(draft.id); };
  const update = (id: string, patch: DraftPatch) => {
    const current = find(id);
    if (!current || state.busy[id]) return;
    const connectionChanged = (['host', 'port', 'user', 'identityFile', 'auth'] as const)
      .some(key => patch[key] !== undefined && patch[key] !== current[key]);
    publish({ drafts: state.drafts.map(draft => draft.id === id
      ? { ...draft, ...(connectionChanged ? { scan: null, confirmed: false } : {}), ...patch,
        labelTouched: patch.label === undefined ? draft.labelTouched : true } : draft), errors: without(state.errors, id) });
  };
  const fromEntry = (entry: Entry) => {
    const draft: Draft = { id: makeId(), label: entry.label, defaultLabel: null, labelTouched: true,
      host: entry.target.host, user: entry.target.user, port: String(entry.target.port),
      identityFile: entry.target.identityFile ?? '', auth: entry.target.identityFile ? 'file' : 'agent', scan: null, confirmed: false };
    publish({ drafts: [...state.drafts, draft] });
    return draft.id;
  };
  const restart = (id: string) => {
    const draft = find(id);
    if (!draft || state.committing[id]) return false;
    requests.delete(id);
    publish({ drafts: state.drafts.map(value => value.id === id
      ? { ...value, label: value.defaultLabel ?? '', labelTouched: false, host: '', user: '', port: '22', identityFile: '', auth: 'agent', scan: null, confirmed: false }
      : value), busy: without(state.busy, id), errors: without(state.errors, id) });
    return true;
  };
  const reconcileNames = (labels: Iterable<string>, journalReady: boolean) => {
    if (!journalReady) return;
    const used = new Set([...labels].map(label => label.trim()));
    for (const draft of state.drafts) {
      if (draft.labelTouched && draft.label.trim()) used.add(draft.label.trim());
      if (state.committing[draft.id]) used.add(draft.label.trim());
    }
    let changed = false;
    const drafts = state.drafts.map(draft => {
      if (state.committing[draft.id]) return draft;
      const custom = draft.labelTouched && !!draft.label.trim();
      const label = draft.defaultLabel && (custom || !used.has(draft.defaultLabel)) ? draft.defaultLabel : nextSetupLabel(used);
      if (!custom) used.add(label);
      if (draft.defaultLabel === label) return draft;
      changed = true;
      return { ...draft, defaultLabel: label, label: draft.labelTouched ? draft.label : label };
    });
    if (changed) publish({ drafts });
  };
  const add = (labels: Iterable<string>, journalReady: boolean) => {
    reconcileNames(labels, journalReady);
    const temporary = state.drafts.find(draft => !isDraftEdited(draft) && !state.committing[draft.id]);
    if (temporary) return temporary.id;
    const label = journalReady ? nextSetupLabel([...labels, ...state.drafts.map(draft => draft.label)]) : null;
    const draft: Draft = { id: makeId(), label: label ?? '', defaultLabel: label, labelTouched: false, host: '', user: '', port: '22',
      identityFile: '', auth: 'agent', scan: null, confirmed: false };
    publish({ drafts: [...state.drafts, draft] });
    return draft.id;
  };
  const operate = async (id: string, label: string, work: (request: DraftRequest) => Promise<void>, committing = false): Promise<boolean> => {
    if (!find(id) || state.busy[id]) return false;
    const token = {};
    let uncertain = false;
    requests.set(id, token);
    const current = () => requests.get(id) === token && !!find(id);
    publish({ busy: { ...state.busy, [id]: label }, errors: without(state.errors, id),
      committing: committing ? { ...state.committing, [id]: true } : state.committing });
    try {
      await work({ current, keepTrustPending: () => { uncertain = committing; }, update: patch => {
        if (current()) publish({ drafts: state.drafts.map(draft => draft.id === id ? { ...draft, ...patch } : draft) });
      } });
      return current();
    } catch (error) {
      if (current()) publish({ errors: { ...state.errors, [id]: String(error) } });
      return false;
    } finally {
      if (current()) {
        if (uncertain) publish({ busy: { ...state.busy, [id]: 'Trust status unconfirmed' }, uncertainTrust: { ...state.uncertainTrust, [id]: true } });
        else {
          requests.delete(id);
          publish({ busy: without(state.busy, id), committing: without(state.committing, id) });
        }
      }
    }
  };
  const resolveUncertainTrust = (id: string) => {
    if (!state.uncertainTrust[id]) return;
    requests.delete(id);
    publish({ busy: without(state.busy, id), committing: without(state.committing, id), uncertainTrust: without(state.uncertainTrust, id) });
  };
  const reconcileTrusted = (entries: Entry[]) => {
    for (const draft of state.drafts) {
      const scan = draft.scan;
      if (scan && entries.some(entry => entry.id === scan.id && entry.fingerprint === scan.fingerprint
        && sameSetupTarget(entry.target, scan.target))) remove(draft.id);
    }
  };
  return { getSnapshot, subscribe, add, fromEntry, restart, update, discard, leave, leaveAll, operate, reconcileNames, reconcileTrusted, resolveUncertainTrust };
}

export const setupDrafts = createDraftController();
export function useSetupDrafts(): DraftState {
  return useSyncExternalStore(setupDrafts.subscribe, setupDrafts.getSnapshot, setupDrafts.getSnapshot);
}
