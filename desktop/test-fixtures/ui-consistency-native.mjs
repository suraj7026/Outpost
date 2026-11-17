export const ownerA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const ownerB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const sharedTask = 'ui-shared-task';
export const reviewAction = 'ui-shared-action';

export function uiConsistencyFixture({ pending = false } = {}) {
  const row = (kind, id, data) => ({ kind, id, data, revision: 7, updatedAt: '2026-11-17T10:00:00.000Z' });
  const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: ownerA, environments: {} };
  const states = {};
  for (const [owner, label] of [[ownerA, 'Consistency Alpha'], [ownerB, 'Consistency Beta']]) {
    const endpoint = `https://${owner === ownerA ? 'alpha' : 'beta'}.ui-consistency.invalid`;
    registry.environments[owner] = { environmentId: owner, label, activeRoute: endpoint, routes: [endpoint] };
    const action = (id, taskId, state) => row('action', id, { taskId, state, tool: 'command.run', target: `${label} workspace`, nonce: `${owner}-nonce`, actionDigest: `${owner}-digest`, arguments: { command: `echo ${label}`, cwd: '/synthetic/workspace' }, effects: ['workspace.write'] });
    states[owner] = { cursor: 1, ready: false, offline: false, pending, records: [
      row('task', sharedTask, { goal: `Collision review — ${label}`, state: 'running', profile: 'code', model: 'fixture' }),
      row('task', 'ui-verifying-task', { goal: `Verifying without actions — ${label}`, state: 'verifying', profile: 'code' }),
      row('task', 'ui-ready-task', { goal: `Ready only — ${label}`, state: 'running', profile: 'code' }),
      row('message', 'ui-message', { taskId: sharedTask, author: 'assistant', text: `Review the exact action on ${label}.` }),
      action(reviewAction, sharedTask, owner === ownerA ? 'pending' : 'succeeded'),
      action('ui-authorized-action', sharedTask, owner === ownerA ? 'authorized' : 'succeeded'),
      action('ui-ready-action', 'ui-ready-task', owner === ownerA ? 'succeeded' : 'authorized'),
      action('ui-not-attention', 'ui-verifying-task', 'failed'),
      row('memory', 'ui-local-note', { text: `Local note for ${label}`, project: 'consistency', confirmed: true, identityId: 'owner' }),
      row('artifact', 'ui-document', { taskId: sharedTask, name: 'consistency.txt', mime: 'text/plain', size: 42, hash: 'synthetic-file-hash' }),
    ] };
  }
  return { registry, states };
}

// Runs only inside the isolated browser context. Production components/hooks are not replaced.
export function installUiConsistencyNative({ registry, states }) {
  localStorage.setItem('outpost.appearance.v1', JSON.stringify({ theme: 'auto', frosted: false, sidebarCollapsed: false }));
  const callbacks = new Map(), streams = new Map();
  let sequence = 0;
  const copy = value => structuredClone(value);
  const control = window.__uiConsistency = {
    registry, states, calls: [], unexpected: [], mutations: [], permits: [],
    allowMutation(expected) { this.permits.push(copy(expected)); },
    emitRecord(owner, record, frame = 'records') {
      const state = states[owner];
      if (!state || state.offline || !streams.has(owner)) throw new Error(`No live fixture stream for ${owner}`);
      state.records = [...state.records.filter(row => row.kind !== record.kind || row.id !== record.id), copy(record)];
      state.cursor++;
      const stream = streams.get(owner);
      // Equal revisions are ignored by the production incremental merge. An authoritative
            // snapshot is required to exercise same-revision changes in the actual review guard.
            const message = frame === 'snapshot'
              ? { type: 'snapshot', cursor: state.cursor, records: copy(state.records), live: [] }
              : { type: 'records', cursor: state.cursor, records: [copy(record)] };
            callbacks.get(stream.channel.id)({ index: stream.index++, message });
    },
    offline(owner) { states[owner].offline = true; streams.get(owner)?.resolve(); streams.delete(owner); },
  };
  const deny = (command, args) => {
    control.unexpected.push({ command, args: copy(args) });
    throw new Error(`UI consistency fixture blocked IPC: ${command} ${JSON.stringify(args)}`);
  };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      control.calls.push({ command, args: copy(args) });
      if (command === 'plugin:window|set_theme' && args.label === 'main' && [null, 'dark', 'light'].includes(args.value)) return;
      if (['set_sidebar_window_controls', 'set_window_blur', 'update_sidebar'].includes(command)) return;
      if (command === 'sidebar_pointer_inside') return false;
      if (command === 'plugin:event|listen') return ++sequence;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'environment_list') return { registry: copy(registry), legacy: { endpoint: null, pending: false } };
      if (command === 'setup_list') return [];
      if (['automatic_updates_status', 'automatic_updates_tick'].includes(command)) return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
      if (command === 'connection_info') return { endpoint: null, pending: false, nativeSidebar: false };
      if (command === 'disconnect' && !args.pause) return;
      if (command === 'environment_select' && states[args.environmentId]) { registry.selectedEnvironmentId = args.environmentId; return copy(registry); }
      if (!command.startsWith('environment_') || !states[args.environmentId]) return deny(command, args);
      const owner = args.environmentId, state = states[owner], op = command.slice('environment_'.length);
      if (op === 'disconnect' && !args.pause) { streams.get(owner)?.resolve(); streams.delete(owner); return; }
      if (op === 'connection_info') return { environmentId: owner, endpoint: registry.environments[owner].activeRoute, deviceId: 'ui-synthetic-device', publicKey: '', pending: state.pending, pendingError: null, nativeSidebar: false };
      if (op === 'query') {
        if (state.offline) throw new Error('Synthetic consistency owner offline');
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: state.cursor, records: copy(state.records) };
        if (args.kind === 'runtime') return { configured: true, model: 'fixture', piManagement: true, sharedMemory: true, browserDirect: false, browserTakeover: false, hostAdministration: false, unrestrictedCommands: false };
        if (args.kind === 'models') return { models: ['fixture'], defaultModel: 'fixture' };
        if (args.kind === 'events') return { events: [], nextCursor: state.cursor, hasMore: false };
        if (args.kind === 'workspace.files' && Object.keys(args.payload).join() === 'taskId' && state.records.some(row => row.kind === 'task' && row.id === args.payload.taskId)) return { files: [], truncated: false };
        return deny(command, args);
      }
      if (op === 'agent_request' && args.payload?.type === 'catalogue') return {
        protocolVersion: 1, piVersion: 'fixture', profilePath: '/synthetic/profile', generation: 'fixture', providers: [],
        models: [{ providerId: 'fixture', modelId: 'fixture', name: 'Fixture model', reasoning: false }],
        defaultModel: { providerId: 'fixture', modelId: 'fixture' }, refreshedAt: null, refreshErrors: [],
        capabilities: { providerPackages: false, callbackRelay: false },
      };
      if (op === 'stream_events') {
        if (state.offline) throw new Error('Synthetic consistency owner offline');
        return new Promise(resolve => {
          const stream = { channel: args.channel, index: 0, resolve }; streams.set(owner, stream);
          callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: state.cursor, records: copy(state.records), live: [] } });
          state.ready = true;
        });
      }
      if (op === 'send_command') {
        const expected = control.permits[0];
        const exact = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
        if (state.offline || state.pending || !expected || !exact(args, expected)) return deny(command, args);
        const current = state.records.find(row => row.kind === 'action' && row.id === args.id);
        if (!current || current.revision !== args.revision) return deny(command, args);
        if (args.kind === 'approval.decide') {
          if (current.data.state !== 'pending' || args.payload.nonce !== current.data.nonce || args.payload.actionDigest !== current.data.actionDigest || args.payload.decision !== 'approve') return deny(command, args);
        } else if (args.kind !== 'action.dispatch' || current.data.state !== 'authorized') return deny(command, args);
        control.permits.shift(); control.mutations.push({ command, args: copy(args) });
        const result = { ...copy(current), revision: current.revision + 1, data: { ...copy(current.data), state: args.kind === 'approval.decide' ? 'authorized' : 'dispatching' } };
        control.emitRecord(owner, result);
        return copy(result);
      }
      // No builds, filesystem writes, terminals, downloads, live network, or unplanned mutations.
      return deny(command, args);
    },
  };
}
