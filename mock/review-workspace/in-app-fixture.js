const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'bitchat-research';
const row = (kind, id, data, minute = 10) => ({ kind, id, data, revision: 1, updatedAt: `2026-11-17T14:${String(minute).padStart(2, '0')}:00Z` });
const records = [
  row('task', taskId, { goal: 'BitChat protocol research', profile: 'code', state: 'verifying', provider: 'openai', model: 'gpt-6.1-terra' }),
  row('policy', taskId, { mode: 'full_control' }),
  row('message', 'request', { taskId, author: 'owner', text: 'Research the BitChat protocol and create a markdown file with the findings.' }, 9),
  row('action', 'write-readme', { taskId, tool: 'file.write', state: 'succeeded', target: 'bitchat-protocol-research/README.md', arguments: { path: 'bitchat-protocol-research/README.md' }, result: { text: 'Created README.md' } }),
  row('message', 'response', { taskId, author: 'assistant', text: 'Created **README.md** with an overview of BitChat’s Bluetooth LE mesh and Nostr transports, encryption, and store-and-forward delivery.\n\nThe key caveat is that **encrypted does not mean anonymous**. I included the privacy limitations and links to the upstream documentation.\n\nThe file is ready for your review.' }),
  row('task', 'previous-notes', { goal: 'Review deployment notes', profile: 'code', state: 'completed' }, 6),
  row('task', 'previous-browser', { goal: 'Explore browser automation', profile: 'browser', state: 'completed' }, 3),
];
const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: owner, environments: {
  [owner]: { environmentId: owner, label: 'Outpost 2', activeRoute: 'https://preview.invalid', routes: ['https://preview.invalid'] },
} };
const model = { providerId: 'openai', modelId: 'gpt-6.1-terra', name: 'gpt-6.1-terra', reasoning: true };
const catalogue = { protocolVersion: 1, piVersion: 'preview', profilePath: '/preview', generation: 'preview', providers: [], models: [model], defaultModel: model, refreshedAt: null, refreshErrors: [], capabilities: {} };
localStorage.setItem('outpost.appearance.v1', JSON.stringify({ theme: 'dark', frosted: false, sidebarCollapsed: false, conversationWidth: 'narrow', conversationDetail: 'compact', startupPage: 'home' }));
const callbacks = new Map();
let sequence = 0;
window.__inAppPreview = { calls: [], blocked: [], taskId, owner };
window.isTauri = true;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
  unregisterCallback(id) { callbacks.delete(id); },
  async invoke(wireCommand, args = {}) {
    window.__inAppPreview.calls.push(wireCommand);
    if (wireCommand.startsWith('plugin:event|')) return ++sequence;
    if (wireCommand === 'plugin:window|set_theme') return;
    if (['set_sidebar_window_controls', 'set_sidebar_window_control_mode', 'set_sidebar_window_control_presentation', 'set_window_blur', 'update_sidebar'].includes(wireCommand)) return;
    if (wireCommand === 'sidebar_pointer_inside') return false;
    if (wireCommand === 'environment_list') return { registry, legacy: { endpoint: null, pending: false } };
    if (['setup_list', 'setup_history_list'].includes(wireCommand)) return [];
    if (['automatic_updates_status', 'automatic_updates_tick'].includes(wireCommand)) return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
    if (wireCommand === 'connection_info') return { endpoint: '', pending: false, nativeSidebar: false };
    if (wireCommand === 'disconnect') return;
    if (wireCommand.startsWith('environment_') && args.environmentId === owner) {
      const command = wireCommand.slice('environment_'.length);
      if (command === 'disconnect') return;
      if (command === 'connection_info') return { environmentId: owner, endpoint: 'https://preview.invalid', deviceId: 'preview', publicKey: '', pending: false, nativeSidebar: false };
      if (command === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records };
        if (args.kind === 'runtime') return { configured: true, piManagement: true, browserDirect: false, hostAdministration: false, sharedMemory: false };
        if (args.kind === 'models') return { models: ['gpt-6.1-terra'], defaultModel: 'gpt-6.1-terra' };
        if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
      }
      if (command === 'agent_request' && args.payload.type === 'catalogue') return catalogue;
      if (command === 'stream_events') return new Promise(() => {
        callbacks.get(args.channel.id)({ index: 0, message: { type: 'snapshot', cursor: 1, records, live: [] } });
      });
      if (command === 'update_status') return null;
    }
    window.__inAppPreview.blocked.push(wireCommand);
    throw new Error('Design preview only. No server action was performed.');
  },
};
