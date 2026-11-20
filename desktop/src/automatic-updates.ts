export interface AutomaticUpdatesStatus {
  enabled: boolean;
  targets: string[];
  activeEnvironmentId: string | null;
  servers: { environmentId: string; state: string; message: string; releaseId?: string }[];
}

export interface AutomaticUpdatesInput {
  native: boolean;
  recordedPreview: boolean;
  environments: { environmentId: string; retired?: boolean }[];
  connections: Record<string, { connected: boolean; retired?: boolean; info?: { pending?: boolean; pendingError?: string | null } | null }>;
}

export interface AutomaticUpdatesSnapshot {
  status: AutomaticUpdatesStatus | null;
  busy: boolean;
  error: string;
  uncertain: boolean;
}

export const automaticUpdatesInterval = 15_000;
export const automaticUpdatesAllowed = (input: AutomaticUpdatesInput) => input.native && !input.recordedPreview;
export function automaticUpdateTargets(input: AutomaticUpdatesInput): string[] {
  return [...new Set(input.environments.filter(environment => environment.environmentId && !environment.retired && !input.connections[environment.environmentId]?.retired).map(environment => environment.environmentId))].sort();
}
export function automaticUpdateConnections(input: AutomaticUpdatesInput): string[] {
  return automaticUpdateTargets(input).filter(id => {
    const connection = input.connections[id];
    return connection?.connected && connection.info && !connection.info.pending && !connection.info.pendingError;
  });
}

// Passive checks do not reserve work. An active journal owner overrides even a terminal phase.
// Native status also maps Ready to idle and unenabled, unreserved rows to not_enabled.
const unreservedStates = new Set(['ready', 'checked', 'blocked', 'complete', 'failed', 'rolled_back', 'idle', 'not_enabled']);
export function automaticUpdatesPending(status: AutomaticUpdatesStatus | null): boolean {
  return !!status && (!!status.activeEnvironmentId || status.servers.some(server => !unreservedStates.has(server.state)));
}

export function automaticUpdatePresentation(server: AutomaticUpdatesStatus['servers'][number] | undefined, connected: boolean) {
  const uncertain = !!server && ['unknown', 'needs_attention', 'uncertain'].includes(server.state);
  const label = !server ? 'Status unknown' : uncertain ? 'Needs attention' : !connected ? 'Status unavailable' : server.state.replaceAll('_', ' ');
  const message = !server ? 'No supervisor status reported. No update outcome is confirmed.' :
    `${!connected ? `Last reported (${server.state.replaceAll('_', ' ')}): ` : ''}${server.message}`;
  return { label, message, uncertain };
}

function validStatus(value: AutomaticUpdatesStatus): boolean {
  return !!value && typeof value.enabled === 'boolean' && Array.isArray(value.targets) && value.targets.every(id => typeof id === 'string') &&
    (value.activeEnvironmentId === null || typeof value.activeEnvironmentId === 'string') && Array.isArray(value.servers) &&
    value.servers.every(server => !!server && typeof server.environmentId === 'string' && typeof server.state === 'string' && typeof server.message === 'string' && (server.releaseId === undefined || typeof server.releaseId === 'string'));
}

const recoveryErrorMessages = new Set([
  'Only a verified pre-activation failure can use this recovery',
  'Only a verified pre-activation idle timeout can use this recovery',
  'Another server owns the update queue',
  'The coordinator has not confirmed a released maintenance hold on the previous release; nothing was cleared',
  'Host inspection could not be verified; nothing was cleared',
  'Recovery refused: the failed operation, released maintenance hold, stopped updater and previous release must all agree',
]);

type Command = 'automatic_updates_status' | 'automatic_updates_tick' | 'automatic_updates_enable' | 'automatic_updates_disable' | 'automatic_updates_recover';
interface ControllerOptions {
  input: () => AutomaticUpdatesInput;
  invoke: (command: Command, args?: Record<string, unknown>) => Promise<AutomaticUpdatesStatus>;
  working?: { current: boolean };
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createAutomaticUpdatesController({ input, invoke, working = { current: false }, schedule = setTimeout, cancel = clearTimeout }: ControllerOptions) {
  let snapshot: AutomaticUpdatesSnapshot = { status: null, busy: false, error: '', uncertain: false };
  const listeners = new Set<() => void>();
  let running = false, generation = 0, needsStatus = true, requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (patch: Partial<AutomaticUpdatesSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  const clearTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const arm = (delay = automaticUpdatesInterval) => {
    clearTimer();
    if (running && automaticUpdatesAllowed(input())) timer = schedule(() => { timer = undefined; void poll(); }, delay);
  };
  const shouldTick = () => automaticUpdateConnections(input()).length > 0 || !!snapshot.status?.enabled || automaticUpdatesPending(snapshot.status);
  const request = async (command: Command, args?: Record<string, unknown>): Promise<boolean> => {
    if (!running || !automaticUpdatesAllowed(input()) || working.current) return false;
    clearTimer();
    const ticket = generation;
    working.current = true;
    publish({ busy: true });
    let accepted = false;
    try {
      const status = await invoke(command, args);
      if (!running || ticket !== generation || !automaticUpdatesAllowed(input())) return false;
      if (!validStatus(status)) throw new Error('Invalid supervisor status');
      needsStatus = false;
      publish({ status, error: '', uncertain: false });
      accepted = true;
    } catch (error) {
      if (running && ticket === generation && automaticUpdatesAllowed(input())) {
        needsStatus = true;
        publish({
          uncertain: true,
          error: command === 'automatic_updates_recover'
            ? (typeof error === 'string' && recoveryErrorMessages.has(error)
              ? error
              : 'Recovery could not be verified. The retained operation must be inspected; no restart was automatically repeated.')
            : 'Supervisor status could not be confirmed. An enrollment or update may still be running. Outpost will reconcile native status; it will not repeat enrollment or blindly retry a launch.',
        });
      }
    } finally {
      working.current = false;
      if (running) {
        publish({ busy: false });
        const immediately = requested || (accepted && command === 'automatic_updates_status' && shouldTick()) || (accepted && command === 'automatic_updates_enable');
        requested = false;
        arm(immediately ? 0 : automaticUpdatesInterval);
      }
    }
    return accepted;
  };
  async function poll() {
    if (!running || !automaticUpdatesAllowed(input())) return;
    if (working.current) { requested = true; return; }
    if (needsStatus || !shouldTick()) await request('automatic_updates_status');
    else await request('automatic_updates_tick', { connectedEnvironmentIds: automaticUpdateConnections(input()) });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (running) return;
      running = true; generation += 1; needsStatus = true;
      void poll();
    },
    stop() { running = false; generation += 1; requested = false; clearTimer(); },
    connectionsChanged() { if (running) { clearTimer(); void poll(); } },
    refresh: () => request('automatic_updates_status'),
    async recoverServer(environmentId: string, approved: boolean, password = true) {
      if (!approved || !automaticUpdateConnections(input()).includes(environmentId)) return false;
      return request('automatic_updates_recover', { environmentId, approved: true, password });
    },
    async updateServer(environmentId: string) {
      if (!automaticUpdateConnections(input()).includes(environmentId)) return false;
      const accepted = await request('automatic_updates_tick', { connectedEnvironmentIds: [environmentId] });
      if (accepted && snapshot.status?.enabled && snapshot.status.targets.includes(environmentId) && !snapshot.status.activeEnvironmentId &&
        snapshot.status.servers.some(server => server.environmentId === environmentId && server.state === 'checked')) {
        return request('automatic_updates_tick', { connectedEnvironmentIds: [environmentId] });
      }
      return accepted;
    },
    async enable(approved: boolean, password = true, reviewedIds = automaticUpdateTargets(input())) {
      const availableIds = automaticUpdateTargets(input());
      const environmentIds = [...new Set(reviewedIds)].sort();
      // Consent is bound only to the explicitly selected saved, nonretired servers.
      if (!approved || !environmentIds.length || !snapshot.status || snapshot.uncertain || automaticUpdatesPending(snapshot.status) ||
        !environmentIds.every(id => availableIds.includes(id)) ||
        (snapshot.status.enabled && environmentIds.every(id => snapshot.status!.targets.includes(id)))) return false;
      const accepted = await request('automatic_updates_enable', { environmentIds, approved: true, password });
      // Native may return a valid status while a partial enrollment remains reserved.
      return accepted && !!snapshot.status?.enabled && environmentIds.every(id => snapshot.status?.targets.includes(id)) && !automaticUpdatesPending(snapshot.status);
    },
    disable: (environmentId?: string) => environmentId
      ? request('automatic_updates_disable', { environmentId })
      : request('automatic_updates_disable'),
  };
}
