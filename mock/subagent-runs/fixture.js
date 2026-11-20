const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'subagent-ui-preview';
const stamp = new Date();
const row = (kind, id, data, offset = 0) => ({ kind, id, revision: 1, updatedAt: new Date(stamp.getTime() + offset).toISOString(), data });
const records = [
  row('task', taskId, { goal: 'Refine navigation and approvals', profile: 'code', state: 'verifying', provider: 'openai', model: 'gpt-6.1-terra' }),
  row('policy', taskId, { mode: 'full_control' }),
  row('message', 'parent-request', { taskId, author: 'owner', text: 'Remove the separate Approvals page. Put approval indicators on the chats that need attention, and update the navigation tests.' }, -120000),
  row('message', 'delegation-intro', { taskId, author: 'assistant', text: 'I’ll keep approvals with the conversation they belong to. I’m delegating the navigation and approval regressions while I finish the interface changes.' }, -90000),
  row('message', 'parent-summary', { taskId, author: 'assistant', text: 'The regression work is complete. Approval indicators now lead back to the exact action in its chat, and the navigation coverage has been updated.' }, 0),
  row('task', 'bitchat-research', { goal: 'BitChat protocol research', profile: 'research', state: 'completed' }, -7200000),
  row('task', 'dialog-review', { goal: 'Review dialog consistency', profile: 'code', state: 'completed' }, -3600000),
];
const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: owner, environments: {
  [owner]: { environmentId: owner, label: 'Outpost 2', activeRoute: 'https://subagents.preview.invalid', routes: ['https://subagents.preview.invalid'] },
} };
const model = { providerId: 'openai', modelId: 'gpt-6.1-terra', name: 'gpt-6.1-terra', reasoning: true };
const catalogue = { protocolVersion: 1, piVersion: 'preview', generation: 'preview', models: [model], defaultModel: model, providers: [], refreshedAt: null, refreshErrors: [], capabilities: {} };
localStorage.setItem('outpost.appearance.v1', JSON.stringify({ theme: 'dark', frosted: false, sidebarCollapsed: false, conversationWidth: 'wide', conversationDetail: 'compact', startupPage: 'home' }));
let serial = 0, stream;
const callbacks = new Map();
window.__subagentPreview = { owner, taskId, calls: [], blocked: [], setStatus(status) {
  const task = records.find(record => record.kind === 'task' && record.id === taskId);
  task.revision++;
  task.data.state = status === 'running' ? 'running' : 'verifying';
  if (stream) callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'records', cursor: ++serial, records: [structuredClone(task)] } });
} };
window.isTauri = true;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback(fn) { const id = ++serial; callbacks.set(id, fn); return id; },
  unregisterCallback(id) { callbacks.delete(id); },
  async invoke(wire, args = {}) {
    window.__subagentPreview.calls.push(wire);
    if (wire.startsWith('plugin:event|')) return ++serial;
    if (wire === 'plugin:window|set_theme') return;
    if (['set_sidebar_window_controls', 'set_sidebar_window_control_mode', 'set_sidebar_window_control_presentation', 'set_window_blur', 'update_sidebar'].includes(wire)) return;
    if (wire === 'sidebar_pointer_inside') return false;
    if (wire === 'environment_list') return { registry, legacy: { endpoint: '', pending: false } };
    if (['setup_list', 'setup_history_list'].includes(wire)) return [];
    if (['automatic_updates_status', 'automatic_updates_tick'].includes(wire)) return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
    if (wire === 'connection_info') return { endpoint: '', pending: false, nativeSidebar: false };
    if (wire === 'disconnect') return;
    if (wire.startsWith('environment_') && args.environmentId === owner) {
      const command = wire.slice(12);
      if (command === 'disconnect') return;
      if (command === 'connection_info') return { environmentId: owner, endpoint: 'https://subagents.preview.invalid', deviceId: 'preview-device', publicKey: '', pending: false, nativeSidebar: false };
      if (command === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records: structuredClone(records) };
        if (args.kind === 'runtime') return { configured: true, piManagement: true, browserDirect: false, hostAdministration: false, sharedMemory: false };
        if (args.kind === 'models') return { models: ['gpt-6.1-terra'], defaultModel: 'gpt-6.1-terra' };
        if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
        if (args.kind === 'workspace.files') return { files: [], truncated: false };
      }
      if (command === 'agent_request' && args.payload.type === 'catalogue') return catalogue;
      if (command === 'stream_events') return new Promise(() => {
        stream = { channel: args.channel, index: 0 };
        callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: 1, records: structuredClone(records), live: [] } });
      });
      if (command === 'update_status') return null;
    }
    window.__subagentPreview.blocked.push(wire);
    throw new Error('Design preview only. No real agent or server action was performed.');
  },
};
