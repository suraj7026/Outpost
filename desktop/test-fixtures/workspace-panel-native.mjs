import { createHash } from 'node:crypto';

export const workspaceOwnerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceOwnerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const workspaceTask = 'workspace-panel-shared-task';
export const workspaceOtherTask = 'workspace-panel-other-task';
const modifiedAt = '2026-11-17T10:00:00.000Z';
const hash = text => createHash('sha256').update(text).digest('hex');
const row = (kind, id, data, second = 0) => ({ kind, id, data, revision: 1, updatedAt: new Date(Date.parse(modifiedAt) + second * 1000).toISOString() });
const document = (path, text) => ({ path, name: path.split('/').at(-1), text, hash: hash(text), size: Buffer.byteLength(text), modifiedAt });

export function workspaceFixture(options = {}) {
  const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: workspaceOwnerA, environments: {} };
  const states = {};
  for (const [owner, label] of [[workspaceOwnerA, 'Workspace Alpha'], [workspaceOwnerB, 'Workspace Beta']]) {
    registry.environments[owner] = { environmentId: owner, label, activeRoute: `https://${label.endsWith('Alpha') ? 'alpha' : 'beta'}.workspace.invalid`, routes: [`https://${label.endsWith('Alpha') ? 'alpha' : 'beta'}.workspace.invalid`] };
    const records = [], documents = {};
    for (const [taskId, taskLabel] of [[workspaceTask, 'Shared workspace task'], [workspaceOtherTask, 'Other workspace task']]) {
      const marker = `${label} / ${taskLabel}`;
      const markdown = `# ${marker}\n\nActual workspace bytes — café.\n\n- [x] Verified file\n\n| Item | Value |\n| --- | --- |\n| owner | ${label} |\n\n![remote image](https://workspace-exfil.invalid/pixel.png)\n\n[Safe reference](https://workspace-exfil.invalid/reference)\n\n[Unsafe reference](javascript:alert(1))\n\n<script>window.__workspaceInjected = true</script>\n<img src="https://workspace-exfil.invalid/raw.png" onerror="window.__workspaceInjected = true">\n<iframe src="https://workspace-exfil.invalid/frame"></iframe>\n`;
      const entries = [document('docs/README.md', markdown), document('docs/drift.md', `# Current on-disk ${marker}\nNot the action arguments.\n`), document('src/edited.txt', `unchanged\nnew ${marker}\n`), document('notes.txt', `Unrecorded actual text: ${marker}\n`), document('slow.md', `# Delayed ${marker}\n`), document('empty.txt', '')];
      documents[taskId] = Object.fromEntries((options.empty ? [] : entries).map(file => [file.path, file]));
      records.push(row('task', taskId, { goal: `${taskLabel} — ${label}`, profile: 'code', state: 'running', model: 'workspace-fixture' }), row('message', `${taskId}-message`, { taskId, author: 'assistant', text: `Review the files for ${marker}.` }, 1));
      if (!options.empty) {
        const write = (id, path, text, expectedHash, second) => row('action', `${taskId}-${id}`, { taskId, tool: 'file.write', state: 'succeeded', target: path, arguments: { path, text, expectedHash }, result: { hash: hash(text) } }, second);
        records.push(write('readme', 'docs/README.md', markdown, null, 2), write('drift', 'docs/drift.md', '# STALE ACTION ARGUMENTS\n', null, 3), write('before', 'src/edited.txt', `unchanged\nold ${marker}\n`, null, 4), write('after', 'src/edited.txt', entries[2].text, hash(`unchanged\nold ${marker}\n`), 5));
        const attachmentText = `# Retrieved attachment ${marker}\nArtifact bytes, not metadata.\n`;
        records.push(row('artifact', `${taskId}-attachment`, { taskId, name: 'attachment.md', mime: 'text/markdown', size: Buffer.byteLength(attachmentText), hash: hash(attachmentText) }, 6));
      }
      if (!options.empty) records.push(row('browser', taskId, { taskId, state: 'running', mode: 'direct', engine: 'camoufox', url: 'https://workspace-browser.invalid/research', action: 'Reading synthetic page' }, 7));
    }
    const artifacts = Object.fromEntries([workspaceTask, workspaceOtherTask].map(taskId => {
      const taskLabel = taskId === workspaceTask ? 'Shared workspace task' : 'Other workspace task';
      const text = `# Retrieved attachment ${label} / ${taskLabel}\nArtifact bytes, not metadata.\n`;
      return [`${taskId}-attachment`, { text, hash: hash(text), base64: Buffer.from(text).toString('base64') }];
    }));
    states[owner] = { records, documents, artifacts, cursor: 1, listError: options.listError ?? '', readError: options.readError ?? '', truncated: !!options.truncated, offline: false, ready: false };
  }
  return { registry, states };
}

// Serialized by Playwright into the real application's window; no production modules are replaced.
export function installWorkspaceTransport({ registry, states }) {
  localStorage.setItem('outpost.appearance.v1', JSON.stringify({ frosted: false, opacity: 45, sidebarCollapsed: true }));
  const callbacks = new Map(), streams = new Map();
  let sequence = 0;
  const control = window.__workspacePanelTest = {
    registry, states, calls: [], unexpected: [], downloads: [], holdReads: [], heldReads: [], holdDownloads: false, heldDownloads: [],
    automaticStatus: { enabled: false, targets: [], activeEnvironmentId: null, servers: [] },
    releaseReads() { this.holdReads = []; this.heldReads.splice(0).forEach(entry => entry.resolve(entry.result)); },
    releaseDownloads() { this.holdDownloads = false; this.heldDownloads.splice(0).forEach(entry => entry.resolve(entry.result)); },
    offline(owner) { states[owner].offline = true; streams.get(owner)?.resolve(); },
  };
  const deny = (command, args) => {
    control.unexpected.push({ command, args: structuredClone(args) });
    throw new Error(`Blocked unexpected workspace IPC: ${command}`);
  };
  const requireValue = (condition, command, args) => { if (!condition) deny(command, args); };
  let jpeg;
  const frame = () => {
    if (jpeg) return jpeg;
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 600;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f6f5f0'; ctx.fillRect(0, 0, 960, 600);
    ctx.fillStyle = '#202428'; ctx.font = '32px sans-serif'; ctx.fillText('Workspace synthetic live browser', 50, 100);
    jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
    return jpeg;
  };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      control.calls.push({ command, args: structuredClone(args) });
      if (command === 'plugin:window|set_theme' && args.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
      if (['set_sidebar_window_controls', 'set_window_blur', 'update_sidebar'].includes(command)) return;
      if (command === 'sidebar_pointer_inside') return false;
      if (command === 'plugin:event|listen') return ++sequence;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: null, pending: false } };
      if (command === 'setup_list') return [];
      if (['automatic_updates_status', 'automatic_updates_tick'].includes(command)) return structuredClone(control.automaticStatus);
      if (command === 'connection_info') return { endpoint: null, pending: false, nativeSidebar: false };
      if (command === 'disconnect' && !args.pause) return;
      if (command === 'environment_select' && states[args.environmentId]) { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
      if (!command.startsWith('environment_') || !states[args.environmentId]) return deny(command, args);
      const owner = args.environmentId, state = states[owner], op = command.slice('environment_'.length);
      if (op === 'disconnect' && !args.pause) { streams.get(owner)?.resolve(); streams.delete(owner); return; }
      if (op === 'update_status') throw 'No synthetic update receipt';
      if (op === 'agent_request' && args.payload?.type === 'runtime.inventory') throw 'Synthetic runtime inventory unavailable';
      if (op === 'connection_info') return { environmentId: owner, endpoint: registry.environments[owner].activeRoute, deviceId: 'workspace-synthetic-device', publicKey: '', pending: false, pendingError: null, nativeSidebar: false };
      if (op === 'query') {
        if (state.offline) throw new Error('Synthetic workspace owner offline');
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
        if (args.kind === 'runtime') return { configured: true, model: 'workspace-fixture', piManagement: false, browserDirect: false, browserTakeover: true, browserEngine: 'camoufox', hostAdministration: false };
        if (args.kind === 'models') return { models: ['workspace-fixture'], defaultModel: 'workspace-fixture' };
        if (args.kind === 'events') return { events: [], nextCursor: state.cursor, hasMore: false };
        const payload = args.payload;
        requireValue(payload && state.documents[payload.taskId], command, args);
        const documents = state.documents[payload.taskId];
        if (args.kind === 'workspace.files') {
          requireValue(Object.keys(payload).join() === 'taskId', command, args);
          if (state.listError) throw typeof state.listError === 'string' ? new Error(state.listError) : state.listError;
          return { files: Object.values(documents).map(({ text, hash, ...metadata }) => structuredClone(metadata)), truncated: state.truncated };
        }
        if (args.kind === 'workspace.read') {
          requireValue(Object.keys(payload).sort().join() === 'path,taskId' && documents[payload.path], command, args);
          if (state.readError) throw typeof state.readError === 'string' ? new Error(state.readError) : state.readError;
          const result = structuredClone(documents[payload.path]);
          if (control.holdReads.some(hold => hold.owner === owner && hold.taskId === payload.taskId && hold.path === payload.path)) return new Promise(resolve => control.heldReads.push({ owner, ...payload, result, resolve }));
          return result;
        }
        if (args.kind === 'browser.frame') return { frame: frame(), capturedAt: new Date().toISOString(), frameId: String(++sequence), width: 960, height: 600, controlEpoch: 'workspace-frame-epoch', control: null, tabs: [{ tab: 0, url: 'https://workspace-browser.invalid/research', active: true }], session: { state: 'running', mode: 'direct', url: 'https://workspace-browser.invalid/research', action: 'Reading synthetic page' } };
      }
      if (op === 'stream_events') return new Promise(resolve => {
        const stream = { channel: args.channel, index: 0, resolve }; streams.set(owner, stream);
        callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [] } });
        state.ready = true;
      });
      if (op === 'artifact' || op === 'save_artifact') {
        const artifact = state.artifacts[args.id];
        requireValue(!state.offline && artifact && args.hash === artifact.hash, command, args);
        if (op === 'artifact') return artifact.base64;
        requireValue(args.name === 'attachment.md', command, args);
      } else if (op === 'save_workspace_file') {
        const file = state.documents[args.taskId]?.[args.path];
        requireValue(!state.offline && file && args.hash === file.hash && Object.keys(args).sort().join() === 'environmentId,hash,path,taskId', command, args);
      } else return deny(command, args);
      control.downloads.push({ command, args: structuredClone(args) });
      const result = `/synthetic-downloads/${owner}/${args.path ?? args.name}`;
      if (control.holdDownloads) return new Promise(resolve => control.heldDownloads.push({ result, resolve }));
      return result;
    },
  };
}
