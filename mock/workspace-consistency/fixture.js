export const owners = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const now = Date.now();
const row = (kind, id, data, minutes = 0) => ({ kind, id, revision: 1, updatedAt: new Date(now - minutes * 60000).toISOString(), data });
const task = (id, goal, state, minutes) => row('task', id, { goal, state, profile: 'code', provider: 'openai', model: 'gpt-6.1-terra' }, minutes);
const sharedNotes = [
  row('memory', 'shared-deploy', { text: 'Before changing a production service, inspect its health and confirm the exact target. Keep a rollback path.', shared: true, confirmed: true, forgotten: false }, 48),
  row('memory', 'shared-docs', { text: 'Keep research notes in Markdown, with source links and a clear separation between verified facts and assumptions.', shared: true, confirmed: true, forgotten: false }, 95),
  row('memory', 'shared-style', { text: 'Prefer concise summaries. Explain what changed, how it was verified, and anything that still needs attention.', shared: true, confirmed: true, forgotten: false }, 180),
];
const texts = {
  'bitchat-readme': '# BitChat protocol research\n\nResearch notes on Bluetooth LE mesh, Nostr relays, message delivery, and privacy.\n\n## Key caveat\n\nEncryption does not guarantee anonymity.\n',
  'release-notes': '# Release notes\n\n## Changes\n\n- Added the file review workspace.\n- Preserved exact-action approval controls.\n\n## Verification\n\nSample content for this UI preview.\n',
  'health-report': '# Server health report\n\nA sample report for the workspace preview.\n\nNo real server was inspected.\n',
};
const attachment = (id, taskId, name, minutes) => row('artifact', id, { taskId, name, mime: 'text/markdown', size: new TextEncoder().encode(texts[id]).length, hash: 'a'.repeat(64), verified: true }, minutes);
const makeAction = (id, taskId, target, state, minutes) => row('action', id, {
  taskId, tool: 'file.write', state, target, nonce: 'preview-nonce', actionDigest: 'preview-digest', effects: ['workspace.write'],
  arguments: { path: target, text: '# Deployment notes\n\nUpdate the runbook after verification.\n', expectedHash: null }, result: null,
}, minutes);
export const states = {
  [owners[0]]: { records: [
    task('deployment-review', 'Update deployment runbook', 'waiting_for_approval', 8),
    task('health-check', 'Inspect service health', 'completed', 46),
    task('backup-notes', 'Document the backup schedule', 'completed', 120),
    row('policy', 'deployment-review', { mode: 'ask_permission' }),
    row('message', 'deploy-user', { taskId: 'deployment-review', author: 'owner', text: 'Update the deployment runbook with the latest verification steps.' }, 10),
    row('message', 'deploy-assistant', { taskId: 'deployment-review', author: 'assistant', text: 'The revised runbook is ready. Two file writes need your approval before I can apply them.\n\nReview the exact paths and proposed contents below.' }, 9),
    makeAction('write-runbook', 'deployment-review', 'docs/deployment.md', 'pending', 8),
    makeAction('write-checks', 'deployment-review', 'docs/verification.md', 'pending', 8),
    attachment('release-notes', 'backup-notes', 'release-notes.md', 35),
    attachment('health-report', 'health-check', 'service-health.md', 46),
    row('memory', 'server-one-note', { project: 'Operations', text: 'Review service health before and after deployment. Keep the previous release available for rollback.', shared: false, confirmed: true, forgotten: false, provenance: 'owner' }, 90),
    ...structuredClone(sharedNotes),
  ] },
  [owners[1]]: { records: [
    task('bitchat-research', 'BitChat protocol research', 'verifying', 3),
    task('publish-notes', 'Publish the research notes', 'paused', 15),
    task('browser-research', 'Explore browser automation', 'completed', 72),
    row('policy', 'bitchat-research', { mode: 'full_control' }),
    row('policy', 'publish-notes', { mode: 'ask_permission' }),
    row('message', 'bitchat-user', { taskId: 'bitchat-research', author: 'owner', text: 'Research BitChat and create a Markdown overview.' }, 5),
    row('message', 'bitchat-assistant', { taskId: 'bitchat-research', author: 'assistant', text: 'The research overview is ready. It covers the two transports, best-effort delivery, and privacy caveats.' }, 3),
    row('message', 'publish-assistant', { taskId: 'publish-notes', author: 'assistant', text: 'The file write is authorized and waiting for dispatch. You can inspect its exact contents before continuing.' }, 15),
    makeAction('publish-write', 'publish-notes', 'research/summary.md', 'authorized', 15),
    attachment('bitchat-readme', 'bitchat-research', 'bitchat-protocol-research.md', 3),
    row('memory', 'server-two-note', { project: 'Research', text: 'Save research under a dedicated project folder. Include sources and note limitations.', shared: false, confirmed: true, forgotten: false, provenance: 'owner' }, 55),
    ...structuredClone(sharedNotes),
  ] },
};
const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: owners[1], environments: Object.fromEntries(owners.map((id, index) => [id, { environmentId: id, label: `Outpost ${index + 1}`, activeRoute: `https://outpost-${index + 1}.preview.invalid`, routes: [`https://outpost-${index + 1}.preview.invalid`] }])) };
const model = { providerId: 'openai', modelId: 'gpt-6.1-terra', name: 'gpt-6.1-terra', reasoning: true };
const catalogue = { protocolVersion: 1, piVersion: 'preview', generation: 'preview', providers: [], models: [model], defaultModel: model, refreshedAt: null, refreshErrors: [], capabilities: {} };
localStorage.setItem('outpost.appearance.v1', JSON.stringify({ theme: 'dark', frosted: false, sidebarCollapsed: false, conversationWidth: 'large', conversationDetail: 'compact', startupPage: 'home' }));
const callbacks = new Map(), streams = new Map();
let serial = 0;
window.__consistencyPreview = { states, registry, calls: [], blocked: [], simulated: [] };
function emit(owner, record) {
  const state = states[owner];
  state.records = [...state.records.filter(value => value.kind !== record.kind || value.id !== record.id), record];
  const stream = streams.get(owner);
  if (stream) callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'records', cursor: ++serial, records: [record] } });
}
window.isTauri = true;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback(fn) { const id = ++serial; callbacks.set(id, fn); return id; },
  unregisterCallback(id) { callbacks.delete(id); },
  async invoke(wire, args = {}) {
    window.__consistencyPreview.calls.push(wire);
    if (wire.startsWith('plugin:event|')) return ++serial;
    if (wire === 'plugin:window|set_theme') return;
    if (['set_sidebar_window_controls', 'set_sidebar_window_control_mode', 'set_sidebar_window_control_presentation', 'set_window_blur', 'update_sidebar'].includes(wire)) return;
    if (wire === 'sidebar_pointer_inside') return false;
    if (wire === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: '', pending: false } };
    if (wire === 'environment_select' && states[args.environmentId]) { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
    if (['setup_list', 'setup_history_list'].includes(wire)) return [];
    if (['automatic_updates_status', 'automatic_updates_tick'].includes(wire)) return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
    if (wire === 'connection_info') return { endpoint: '', pending: false, nativeSidebar: false };
    if (wire === 'disconnect') return;
    if (wire.startsWith('environment_') && states[args.environmentId]) {
      const owner = args.environmentId, state = states[owner], command = wire.slice(12);
      if (command === 'disconnect') return;
      if (command === 'connection_info') return { environmentId: owner, endpoint: registry.environments[owner].activeRoute, deviceId: 'preview-device', publicKey: '', pending: false, nativeSidebar: false };
      if (command === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records: structuredClone(state.records) };
        if (args.kind === 'runtime') return { configured: true, piManagement: true, browserDirect: false, hostAdministration: false, sharedMemory: true };
        if (args.kind === 'models') return { models: ['gpt-6.1-terra'], defaultModel: 'gpt-6.1-terra' };
        if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
        if (args.kind === 'workspace.files') return { files: [], truncated: false };
      }
      if (command === 'agent_request' && args.payload.type === 'catalogue') return catalogue;
      if (command === 'update_status') return null;
      if (command === 'stream_events') return new Promise(() => {
        const stream = { channel: args.channel, index: 0 }; streams.set(owner, stream);
        callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: 1, records: structuredClone(state.records), live: [] } });
      });
      if (command === 'send_command') {
        window.__consistencyPreview.simulated.push({ owner, kind: args.kind });
        if (args.kind === 'approval.decide' || args.kind === 'action.dispatch') {
          const action = state.records.find(value => value.kind === 'action' && value.id === args.id);
          if (!action || action.revision !== args.revision) throw new Error('Sample action changed.');
          const next = { ...action, revision: action.revision + 1, data: { ...action.data, state: args.kind === 'action.dispatch' ? 'succeeded' : args.payload.decision === 'approve' ? 'authorized' : 'denied' } };
          emit(owner, next); return next;
        }
        if (args.kind === 'memory.shared') {
          const prior = state.records.find(value => value.kind === 'memory' && value.id === args.id);
          const next = row('memory', args.id, { shared: true, confirmed: true, forgotten: args.payload.text === null, text: args.payload.text });
          next.revision = (prior?.revision ?? 0) + 1; emit(owner, next); return next;
        }
      }
      if (command === 'artifact' && texts[args.id]) return btoa(unescape(encodeURIComponent(texts[args.id])));
      if (command === 'save_artifact' && texts[args.id]) {
        const url = URL.createObjectURL(new Blob([texts[args.id]], { type: 'text/markdown' }));
        const a = document.createElement('a'); a.href = url; a.download = args.name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); return 'browser download (sample file)';
      }
    }
    window.__consistencyPreview.blocked.push(wire);
    throw new Error('Preview only. No real server action was performed.');
  },
};
