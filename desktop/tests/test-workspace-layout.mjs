import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openSettings, serverTab } from '../settings-test-navigation.mjs';

// Existing dist only. No build, real IPC, credentials, host inspection or remote requests.
// OUTPOST_TEST_DIST selects an absolute path or a path relative to cwd; default: this desktop/dist.
// OUTPOST_TEST_FILTER is a regexp over profile/view (e.g. baseline, general, memory, protected-chat).
// Layout only: ^(?!provider-validation/). Provider validation only: ^provider-validation/.
// OUTPOST_TEST_BROWSER=chromium|webkit (default both); OUTPOST_TEST_PHASE=before|after labels evidence only.
// OUTPOST_TEST_GRIDS=1 also requires the new responsive grids/container queries; assertions never depend on phase.
const root = process.env.OUTPOST_TEST_DIST ? resolve(process.env.OUTPOST_TEST_DIST) : resolve(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const output = '/tmp/outpost-workspace-layout';
const phase = process.env.OUTPOST_TEST_PHASE || 'after';
const engines = process.env.OUTPOST_TEST_BROWSER ? [({ chromium, webkit })[process.env.OUTPOST_TEST_BROWSER]] : [chromium, webkit];
const filter = new RegExp(process.env.OUTPOST_TEST_FILTER || '.');
const requireGrids = process.env.OUTPOST_TEST_GRIDS === '1';
assert.ok(engines.every(Boolean), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
assert.ok(['before', 'after'].includes(phase), 'OUTPOST_TEST_PHASE must be before or after');
assert.ok(existsSync(resolve(root, 'index.html')), `An existing build is required at ${root}; this suite never rebuilds it`);
mkdirSync(output, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const fingerprint = () => {
  const hash = createHash('sha256');
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = resolve(directory, name);
      if (statSync(file).isDirectory()) visit(file);
      else { hash.update(file.slice(root.length)); hash.update(readFileSync(file)); }
    }
  }
  visit(root); return hash.digest('hex');
};
const distHash = fingerprint();
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const taskId = 'layout-task';
const token = 'synthetic-layout-token-'.repeat(18);
const row = (kind, id, data, index = 0) => ({ kind, id, data, revision: 1, updatedAt: new Date(Date.UTC(2026, 10, 15, 12, 0, index)).toISOString() });
function records(label, empty, long) {
  const devices = [row('device', 'synthetic-self', { name: 'This fixture Mac', publicKey: 'synthetic-public-key', revoked: false }),
    row('recovery', 'server', { dispatchEnabled: false, reason: long ? token : 'Synthetic recovery hold; never authorize dispatch.' })];
  if (empty) return devices;
  return [...devices,
    row('task', taskId, { goal: `${label} layout inspection`, profile: 'code', state: 'paused', model: 'fixture:cloud' }, 59),
    row('policy', taskId, { mode: 'ask_permission' }),
    row('message', 'owner', { taskId, author: 'owner', text: 'Inspect this synthetic workspace without running commands.' }, 1),
    row('message', 'reply', { taskId, author: 'assistant', text: Array.from({ length: 32 }, (_, i) => `Recorded paragraph ${i + 1}. This is synthetic layout evidence, not live server output.`).join('\n\n') + '\n\nTRANSCRIPT-END' }, 2),
    ...Array.from({ length: 12 }, (_, i) => row('task', `old-${i}`, { goal: `Previous inspection ${i} ${long ? token : label}`, profile: 'code', state: 'completed' }, i)),
    ...Array.from({ length: 8 }, (_, i) => row('action', `approval-${i}`, { taskId, tool: 'file.write', state: 'pending', nonce: 'synthetic', actionDigest: 'synthetic', target: long ? token : `fixture-${i}.txt`, arguments: { path: `fixture-${i}.txt`, content: 'Read-only inspection.\n'.repeat(8) } }, i)),
    ...Array.from({ length: 12 }, (_, i) => row('artifact', `artifact-${i}`, { taskId, name: `${long ? token : 'Synthetic report'}-${i}.txt`, mime: 'text/plain', hash: 'synthetic' }, i)),
    ...Array.from({ length: 12 }, (_, i) => row('automation', `schedule-${i}`, { title: `${label} schedule ${i} ${long ? token : ''}`, enabled: false, description: long ? token : 'Fixture schedule only', schedule: 'Never run', instructions: 'Synthetic instruction.\n'.repeat(5) }, i)),
    ...Array.from({ length: 10 }, (_, i) => row('memory', `local-${i}`, { title: `${label} note ${i} ${long ? token : ''}`, text: `${long ? token : 'Synthetic server note.'}\n` + 'Read-only layout evidence.\n'.repeat(5) }, i)),
    // Both replicas have exactly the same notes: merely opening Memory must never start replication writes.
    ...Array.from({ length: 6 }, (_, i) => row('memory', `shared-${i}`, { text: `Shared fixture note ${i}. ${long ? token : ''}\n` + 'No production data.\n'.repeat(4), shared: true, confirmed: true, forgotten: false }, i)),
    ...Array.from({ length: 6 }, (_, i) => row('device', `fixture-device-${i}`, { name: long ? token : `Fixture device ${i}`, publicKey: long ? token : `synthetic-public-${i}`, revoked: false })),
  ];
}
function fixture(profile) {
  const label = profile.long ? 'Studio-' + 'long-label-'.repeat(6) : 'Studio server';
  const endpoint = profile.long ? 'https://fixture.invalid/' + token : 'https://studio.fixture.invalid';
  const saved = (environmentId, name) => ({ environmentId, label: name, activeRoute: endpoint, routes: [endpoint, 'https://alternate.fixture.invalid'] });
  const providers = Array.from({ length: profile.empty ? 0 : 8 }, (_, i) => ({ id: `fixture-${i}`, name: `Fixture provider ${i} ${profile.long ? token : ''}`, configured: false, storedMethod: null, methods: [{ type: 'api_key', label: 'Add API key' }] }));
  const manifest = { id: profile.long ? token : 'host-synthetic-release', piVersion: '1.4.0', sequence: 1, extensions: Array.from({ length: 8 }, (_, i) => ({ name: `fixture-extension-${i}`, version: '1.0.0' })) };
  return { A, B, collapsed: profile.sidebar === 'collapsed', registryError: profile.registryError,
    registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: saved(A, label), [B]: saved(B, 'Build server') } },
    states: { [A]: { records: records(label, profile.empty, profile.long), cursor: 1 }, [B]: { records: records('Build server', profile.empty, profile.long), cursor: 1 } },
    catalogue: { protocolVersion: 1, piVersion: '1.4.0', profilePath: '/synthetic/profile/' + (profile.long ? token : 'fixture'), generation: 'a'.repeat(64), providers, models: [], defaultModel: null, refreshErrors: [], refreshedAt: null, capabilities: { providerTransfer: true } },
    inventory: { ...manifest, releaseId: manifest.id, manifest },
  };
}
function installTransport({ A, B, collapsed, registryError, registry, states, catalogue, inventory }) {
  localStorage.setItem('outpost.appearance.v1', JSON.stringify({ frosted: false, opacity: 45, sidebarCollapsed: collapsed }));
  const callbacks = new Map(), streams = {}, snapshots = new Map();
  let sequence = 0, pointerX = -1, pointerY = -1;
  const control = window.__workspaceLayout = { calls: [], unexpected: [], states, registry,
    offline() { for (const id of [A, B]) { states[id].offline = true; streams[id]?.resolve(); } },
  };
  const deny = (command, args) => {
    control.unexpected.push({ command, args: structuredClone(args) });
    throw new Error(`Blocked unexpected layout-fixture IPC: ${command}`);
  };
  document.addEventListener('pointermove', event => { pointerX = event.clientX; pointerY = event.clientY; });
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      if (command === 'sidebar_pointer_inside') return pointerX >= 0 && pointerX <= args.width && pointerY >= 0 && pointerY <= innerHeight;
      control.calls.push({ command, args: structuredClone(args) });
      if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
      if (['set_sidebar_window_controls', 'update_sidebar'].includes(command)) return;
      if (command === 'plugin:event|listen') return ++sequence;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'environment_list') {
        if (registryError) throw new Error('Synthetic registry unavailable. ' + 'Read-only diagnostic evidence. '.repeat(100));
        return { registry: structuredClone(registry), legacy: { endpoint: '', pending: false } };
      }
      if (['setup_list', 'setup_history_list'].includes(command)) return [];
      if (command === 'environment_select' && states[args.environmentId]) { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
      if (command === 'connection_info') return { endpoint: '', pending: false, nativeSidebar: false };
      if (command === 'disconnect' && !args.pause) return;
      if (!command.startsWith('environment_') || !states[args.environmentId]) return deny(command, args);
      const state = states[args.environmentId], op = command.slice('environment_'.length);
      if (op === 'disconnect' && !args.pause) { streams[args.environmentId]?.resolve(); delete streams[args.environmentId]; return; }
      if (op === 'connection_info') return { environmentId: args.environmentId, endpoint: registry.environments[args.environmentId].activeRoute, deviceId: 'synthetic-self', publicKey: 'synthetic-public-key', pending: false, pendingError: null, nativeSidebar: false };
      if (op === 'update_status') return null;
      if (op === 'query' && ['snapshot', 'runtime', 'models', 'events'].includes(args.kind)) {
        if (state.offline) throw new Error('Synthetic offline connection');
        if (args.kind === 'snapshot') {
          // Publish both initial replicas before either runtime becomes writable.
          if (!state.ready) await new Promise(resolve => {
            snapshots.set(args.environmentId, resolve);
            if (snapshots.size === 2) { for (const release of snapshots.values()) release(); }
          });
          return { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
        }
        if (args.kind === 'runtime') return { configured: true, piManagement: true, sharedMemory: true, browserDirect: false, hostAdministration: false, unrestrictedCommands: false };
        if (args.kind === 'models') return { models: [], defaultModel: null };
        return { events: [], nextCursor: state.cursor, hasMore: false };
      }
      if (op === 'agent_request') {
        if (args.payload.type === 'catalogue') return structuredClone(catalogue);
        if (args.payload.type === 'runtime.inventory') return structuredClone(inventory);
        if (args.payload.type === 'transfer.history') return [];
        return deny(command, args);
      }
      if (op === 'stream_events') return new Promise(resolve => {
        const stream = streams[args.environmentId] = { channel: args.channel, index: 0, resolve };
        callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [] } });
        state.ready = true;
      });
      return deny(command, args);
    },
  };
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (request.method !== 'GET' || !file.startsWith(root + sep) || !mime[extname(file)] || !existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end();
  response.setHeader('content-type', mime[extname(file)]); response.end(readFileSync(file));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, current, checks = 0, cases = 0, timedOut = false;
const results = [], measurements = [], failures = [];
const verify = (value, message) => { checks++; if (!value) { current.errors.push(message); } };
const near = (a, b, message) => verify(Math.abs(a - b) <= 1.5, `${message}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const deadline = setTimeout(() => {
  timedOut = true; console.error('Workspace layout suite exceeded 300 seconds; narrow OUTPOST_TEST_FILTER.');
  void browser?.close(); server.closeAllConnections(); server.close();
}, 300_000);
deadline.unref();

async function screenshot(page, engine, name) {
  const path = `${output}/${phase}-${engine.name()}-${runId}-${name}.png`;
  await page.screenshot({ path, animations: 'disabled', timeout: 5000 });
  current.screenshots.push(path); console.log(`SCREENSHOT ${path}`);
}
async function reveal(page) {
  if (await page.locator('#app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
}
async function settle(page, profile) {
  await page.mouse.move(profile.width - 2, 2);
  if (profile.sidebar === 'collapsed' || profile.width <= 780) {
    await page.locator('.main-shell').focus(); await page.keyboard.press('Escape');
    await page.locator('#app-sidebar[data-motion="closed"]').waitFor({ state: 'attached' });
  } else await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  await frames(page);
}
const workspaceNames = { approvals: 'Approvals', library: 'Library', memory: 'Memory', automations: 'Automations', 'all-chats': 'All chats', machines: 'Machines' };
const tabs = ['general', 'setup', 'models', 'runtime', 'devices', 'recovery'];
async function navigate(page, view, profile) {
  if (tabs.includes(view)) {
    if (await page.locator('.server-settings-tabs').count()) await serverTab(page, view);
    else await openSettings(page, { server: A, tab: view });
    await page.locator('.settings-section').first().waitFor();
  } else if (['settings-home', 'appearance', 'servers', 'add-server'].includes(view)) {
    await openSettings(page, { page: view === 'settings-home' ? 'home' : view === 'add-server' ? 'servers' : view });
    if (view === 'add-server') {
      await page.getByRole('link', { name: 'Add server', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Server setup', exact: true });
      await dialog.waitFor(); await dialog.getByRole('button', { name: 'Close server setup', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('.server-setup-launcher').waitFor();
    }
  } else if (view === 'protected-chat') {
    await reveal(page);
    await page.locator(`.chat-server-group[data-server-id="${A}"] [data-task-id="${taskId}"]`).click();
    await page.locator('.conversation-run').first().waitFor();
  } else {
    await reveal(page); await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: view === 'approvals' ? /^Approvals(?:\s*\d+)?$/ : workspaceNames[view], exact: true }).click();
    await page.getByRole('heading', { name: workspaceNames[view], level: 1, exact: true }).waitFor();
  }
  await settle(page, profile);
}

async function geometry(page, view) {
  const measurement = await page.evaluate(() => {
    const box = node => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
        contentLeft: r.left + node.clientLeft + parseFloat(s.paddingLeft), contentRight: r.left + node.clientLeft + node.clientWidth - parseFloat(s.paddingRight), maxWidth: s.maxWidth };
    };
    const main = document.querySelector('.main-shell'), page = document.querySelector('.main-shell > .page') || document.querySelector('#root > .page');
    const selectors = ['.page-heading', '.settings-link-list', '.settings-section', '.machines-server-list', '.machines-server-card', '.workspace-server', '.shared-memory', '.shared-memory-form', '.session-list', '.outputs-grid', '.workspace-records'];
    return { main: main ? box(main) : { left: 0, right: innerWidth, top: 0, bottom: innerHeight, width: innerWidth, height: innerHeight }, page: box(page),
      elements: selectors.flatMap(selector => [...page.querySelectorAll(selector)].filter(node => node.getBoundingClientRect().height > 0).map((node, index) => ({ selector, index, ...box(node) }))),
      textarea: page.querySelector('#shared-memory-note') ? box(page.querySelector('#shared-memory-note')) : null,
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      headers: document.querySelectorAll('.topbar, .task-heading, .task-title, .run-byline').length };
  });
  measurements.push({ case: current.name, engine: current.engine, view, ...measurement });
  const { main, page: pane, elements, textarea } = measurement;
  console.log(`MEASURE ${current.engine}/${current.name} shell=${main.width} page=${pane.width} pageMax=${pane.maxWidth} content=${pane.contentRight - pane.contentLeft} scroll=${pane.scrollWidth}/${pane.clientWidth}${textarea ? ` memoryEditor=${textarea.width} form=${elements.find(item => item.selector === '.shared-memory-form')?.width}` : ''}`);
  near(pane.left, main.left, 'Page fills shell left edge'); near(pane.right, main.right, 'Page fills shell right edge');
  near(pane.top, main.top, 'Page starts at shell top'); near(pane.bottom, main.bottom, 'Page fills shell height');
  verify(pane.scrollWidth <= pane.clientWidth + 1, `Page itself must not overflow horizontally: ${pane.scrollWidth}/${pane.clientWidth}`);
  verify(measurement.documentWidth <= measurement.viewportWidth, 'Document does not overflow horizontally');
  verify(measurement.headers === 0, 'Removed global/task/assistant headers stay absent');
  for (const item of elements) {
    const name = `${item.selector}[${item.index}]`;
    near(item.left, pane.contentLeft, `${name} reaches padded left edge`);
    near(item.right, pane.contentRight, `${name} reaches padded right edge`);
    verify(item.scrollWidth <= item.clientWidth + 1, `${name} has no horizontal overflow: ${item.scrollWidth}/${item.clientWidth}`);
  }
  if (textarea) { near(textarea.left, pane.contentLeft, 'Memory editor starts at padded left edge'); near(textarea.right, pane.contentRight, 'Memory editor reaches padded right edge'); }
  if (view === 'add-server') verify(await page.locator('dialog[open]').count() === 0, 'Add-server measures the inline launcher, not a modal');
  if (view === 'machines') {
    verify(await page.locator('.machines-page > .machines-server-list').count() === 1, 'Machines shows its own server list, not Settings Servers');
    verify(await page.locator('.machines-server-card').count() > 0, 'Machines fixture contains saved-server cards');
    verify(await page.locator('.machines-terminal-page, .server-terminal-pane, .server-reboot-dialog[open]').count() === 0, 'Read-only Machines inspection never opens a terminal or reboot dialog');
  }
  if (requireGrids) await grids(page, pane);
}
async function grids(page, pane) {
  const sections = await page.locator('.settings-page .settings-section').evaluateAll(nodes => nodes.map(node => {
    const children = [...node.children].filter(child => child.getBoundingClientRect().height > 0), first = children[0]?.getBoundingClientRect(), second = children[1]?.getBoundingClientRect();
    return { launcher: node.classList.contains('server-setup-launcher'), first: first?.toJSON(), second: second?.toJSON() };
  }));
  if (sections.length) verify(await page.locator('.settings-page').evaluate(node => getComputedStyle(node).containerType.includes('inline-size')), 'Settings responds to its content container width');
  const contentWidth = pane.contentRight - pane.contentLeft;
  for (const section of sections) {
    if (!section.first || !section.second || section.launcher) continue;
    if (contentWidth <= 720) verify(section.second.top >= section.first.bottom - 1, 'Settings stacks by actual available content width');
    else if (contentWidth >= 760) {
      near(section.first.top, section.second.top, 'Wide settings columns align');
      verify(section.first.width / contentWidth >= .22 && section.first.width / contentWidth <= .34, 'Wide settings description uses about 28%, not half the page');
    }
  }
  const groups = await page.locator('.workspace-server:has(.record-row), .shared-memory:has(.record-row)').count();
  if (groups) verify(await page.locator('.workspace-records').count() >= groups, 'Note/automation groups use workspace-records grids');
  const layouts = await page.locator('.workspace-records').evaluateAll(nodes => nodes.map(node => ({ display: getComputedStyle(node).display, width: node.clientWidth, children: [...node.children].map(child => child.getBoundingClientRect().toJSON()) })));
  for (const layout of layouts) {
    verify(layout.display === 'grid', 'Workspace records use CSS grid');
    if (layout.children.length > 1 && layout.width >= 760) near(layout.children[0].top, layout.children[1].top, 'Wide record groups use multiple columns');
    if (layout.children.length > 1 && layout.width < 600) verify(layout.children[1].top >= layout.children[0].bottom - 1, 'Narrow record groups stack');
  }
  if (await page.locator('#environment-name').count()) {
    verify(await page.locator('.environment-connection-controls').count() === 1, 'General uses the connection controls grid');
    verify(await page.locator('.environment-connection-state').count() === 1, 'Connection state has a full-span group');
    verify(await page.locator('.environment-connection-controls > .environment-connection-fields').count() === 1, 'Saved rename/routes use their own fields grid');
  }
  const controls = await page.evaluate(() => {
    const box = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      const leftInset = parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), rightInset = parseFloat(s.borderRightWidth) + parseFloat(s.paddingRight);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
        contentLeft: r.left + leftInset, contentRight: r.right - rightInset, contentWidth: r.width - leftInset - rightInset,
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, display: s.display,
        columns: s.gridTemplateColumns.split(/\s+/).map(parseFloat).filter(width => width > 0) };
    };
    const general = document.querySelector('.environment-connection-controls');
    const fields = general?.querySelector(':scope > .environment-connection-fields');
    const appearance = document.querySelector('.appearance-settings > .appearance-controls');
    return {
      general: general ? { outer: box(general), state: box(general.querySelector(':scope > .environment-connection-state')),
        fields: box(fields), rename: box(fields?.querySelector(':scope > form:first-child')),
        routes: box(fields?.querySelector(':scope > .environment-route-settings:last-child')) } : null,
      appearance: appearance ? { section: box(appearance.parentElement), controls: box(appearance),
        stack: appearance.classList.contains('ui-stack'), groups: [...appearance.querySelectorAll(':scope > .ui-section')].map(group => ({
          ...box(group), title: group.querySelector('h2')?.textContent,
          rows: [...group.querySelectorAll('.ui-row')].map(box),
        })) } : null,
    };
  });
  current.settingsControlMeasurements = controls;
  if (controls.general) {
    const { outer, state, fields, rename, routes } = controls.general;
    verify(outer.display === 'grid' && outer.columns.length === 1, '.environment-connection-controls has one outer column');
    near(outer.contentRight, pane.contentRight, '.environment-connection-controls reaches the page padded right edge');
    verify(!!state && !!fields && !!rename && !!routes, 'General retains direct state, fields, first rename form and final route settings groups');
    if (state && fields && rename && routes) {
      near(state.left, outer.contentLeft, '.environment-connection-state fills the outer column from the left');
      near(state.right, outer.contentRight, '.environment-connection-state fills the outer column to the right');
      near(fields.left, outer.contentLeft, '.environment-connection-fields starts at the controls left edge');
      near(fields.right, outer.contentRight, '.environment-connection-fields fills the controls right edge');
      near(rename.left, fields.contentLeft, 'First rename form starts at the fields left edge');
      near(routes.right, fields.contentRight, 'Final .environment-route-settings reaches the fields right edge');
      near(routes.right, outer.contentRight, 'Final .environment-route-settings reaches the controls right edge');
      near(routes.right, pane.contentRight, 'Final .environment-route-settings reaches the page padded right edge without a trailing grid hole');
      const columns = fields.contentWidth >= 660 ? 2 : 1;
      verify(fields.display === 'grid' && fields.columns.length === columns, `.environment-connection-fields at ${fields.contentWidth.toFixed(2)}px uses ${columns} columns, got ${JSON.stringify(fields.columns)}`);
      verify(fields.scrollWidth <= fields.clientWidth + 1, '.environment-connection-fields does not overflow horizontally');
      if (columns === 2) {
        near(rename.top, routes.top, 'Wide rename/routes share a row');
        verify(routes.left >= rename.right, 'Wide route settings occupy the second column without overlap');
      } else {
        near(rename.right, fields.contentRight, 'Stacked rename form fills the fields width');
        near(routes.left, fields.contentLeft, 'Stacked route settings start at the fields left edge');
        verify(routes.top >= rename.bottom, 'Narrow rename/routes stack vertically without overlap');
      }
    }
  }
  if (await page.locator('.appearance-settings').count()) {
    verify(!!controls.appearance, 'Appearance retains its full-width grouped controls');
    if (controls.appearance) {
      const { section, controls: appearance, stack, groups } = controls.appearance;
      verify(stack, 'Appearance groups use the shared ui-stack');
      near(section.contentLeft, pane.contentLeft, 'Appearance starts at the page padded left edge');
      near(appearance.width, section.contentWidth, '.appearance-controls fills the entire settings section, not a separate column');
      near(appearance.left, section.contentLeft, '.appearance-controls starts at the settings section left edge');
      near(appearance.right, section.contentRight, '.appearance-controls reaches the settings section right edge');
      near(appearance.right, pane.contentRight, '.appearance-controls reaches the page padded right edge');
      verify(appearance.scrollWidth <= appearance.clientWidth + 1, '.appearance-controls does not overflow horizontally');
      verify(JSON.stringify(groups.map(group => group.title)) === JSON.stringify(['Startup', 'Theme', 'Conversation', 'Window']), 'Appearance has the four ordered preference sections');
      for (const [index, group] of groups.entries()) {
        near(group.left, appearance.contentLeft, `${group.title} starts at the controls left edge`);
        near(group.right, appearance.contentRight, `${group.title} fills the controls width`);
        verify(group.scrollWidth <= group.clientWidth + 1, `${group.title} does not overflow horizontally`);
        if (index) verify(group.top >= groups[index - 1].bottom - 1, 'Appearance sections stack without overlap');
        verify(group.rows.length > 0, `${group.title} contains grouped setting rows`);
        for (const row of group.rows) {
          verify(row.left >= group.contentLeft - 1 && row.right <= group.contentRight + 1, `${group.title} row stays inside its section`);
          verify(row.scrollWidth <= row.clientWidth + 1, `${group.title} row does not overflow horizontally`);
        }
      }
    }
  }
}
const locked = page => page.evaluate(() => ({ window: [scrollX, scrollY], nodes: Object.fromEntries(['html', 'body', '#root', '.app-shell', '.main-shell'].map(selector => {
  const node = document.querySelector(selector), r = node?.getBoundingClientRect();
  return [selector, node ? { scroll: [node.scrollLeft, node.scrollTop], rect: [r.left, r.top, r.width, r.height] } : null];
})) }));
async function scrollToEnd(page) {
  const pane = page.locator('.main-shell > .page, #root > .page');
  const before = await locked(page);
  await pane.evaluate(node => { node.scrollTop = node.scrollHeight; }); await frames(page);
  const end = await pane.evaluate(node => {
    const visible = [...node.querySelectorAll('button, input, textarea, p, article, a, pre')].filter(child => child.getBoundingClientRect().height > 0 && !child.closest('dialog'));
    const last = visible.at(-1), r = node.getBoundingClientRect(), terminal = last?.getBoundingClientRect();
    return { top: node.scrollTop, max: node.scrollHeight - node.clientHeight, bottom: terminal?.bottom, viewportBottom: r.bottom, overflow: getComputedStyle(node).overflowY };
  });
  near(end.top, end.max, 'Terminal content is scroll reachable');
  verify(end.bottom === undefined || end.bottom <= end.viewportBottom + 1, 'Last visible content is not clipped below the page');
  verify(['auto', 'scroll'].includes(end.overflow), 'Page owns vertical scrolling');
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.max(2, box.height - 12)); await page.mouse.wheel(0, 700); await frames(page);
  const after = await locked(page);
  verify(JSON.stringify(before) === JSON.stringify(after), 'Scrolling at the page boundary does not move shell/window geometry or scroll offsets');
  verify(after.window.every(value => value === 0) && Object.values(after.nodes).every(node => !node || node.scroll.every(value => value === 0)), 'Window and layout containers stay scroll locked');
  await pane.evaluate(node => { node.scrollTop = 0; });
}
async function sidebarContainment(page, profile, engine) {
  await reveal(page);
  const content = page.locator('#app-sidebar > .sidebar-content');
  await content.waitFor();
  const snapshot = () => page.locator('#app-sidebar').evaluate(panel => {
    const box = node => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
        scrollTop: node.scrollTop, scrollLeft: node.scrollLeft, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
        overflowY: s.overflowY, insideContent: !!node.closest('.sidebar-content') };
    };
    return { viewportHeight: innerHeight, nodes: Object.fromEntries([
      ['panel', panel], ['content', panel.querySelector('.sidebar-content')],
      ...['.sidebar-chrome', '.brand', '.new-task-button', '.sidebar-bottom', '.connection-nav', '.sidebar-sessions'].map(selector => [selector, panel.querySelector(selector)]),
    ].map(([name, node]) => [name, box(node)])) };
  });
  const initial = await snapshot(), outer = await locked(page);
  current.sidebarMeasurements = [{ stage: 'initial', ...initial }];
  const fixed = ['panel', '.sidebar-chrome', '.brand', '.new-task-button', '.sidebar-bottom', '.connection-nav'];
  const visibleSettings = state => {
    const panel = state.nodes.panel, settings = state.nodes['.connection-nav'];
    verify(settings.height > 0 && settings.top >= Math.max(0, panel.top) - 1 && settings.bottom <= Math.min(state.viewportHeight, panel.bottom) + 1 && settings.left >= panel.left - 1 && settings.right <= panel.right + 1,
      `${profile.sidebar} Settings stays within the visible sidebar: top=${settings.top}, bottom=${settings.bottom}, panel=${panel.top}..${panel.bottom}, viewport=${state.viewportHeight}`);
  };
  const assertFixed = async stage => {
    const state = await snapshot(); current.sidebarMeasurements.push({ stage, ...state });
    for (const name of fixed) {
      for (const edge of ['left', 'right', 'top', 'bottom']) near(state.nodes[name][edge], initial.nodes[name][edge], `${stage}: ${name} ${edge} stays fixed`);
      verify(state.nodes[name].scrollTop === 0 && state.nodes[name].scrollLeft === 0, `${stage}: ${name} never scrolls`);
    }
    verify(state.nodes['.sidebar-sessions'].scrollTop === 0 && state.nodes['.sidebar-sessions'].scrollLeft === 0, `${stage}: wrapper scroll does not move the nested chat list`);
    verify(state.nodes.content.scrollLeft === 0, `${stage}: sidebar content does not scroll horizontally`);
    visibleSettings(state);
    const after = await locked(page);
    verify(JSON.stringify(outer) === JSON.stringify(after), `${stage}: sidebar scrolling leaves window/shell geometry and offsets unchanged`);
    verify(after.window.every(value => value === 0) && Object.values(after.nodes).every(node => !node || node.scroll.every(value => value === 0)), `${stage}: window and shell remain scroll locked`);
  };
  visibleSettings(initial);
  for (const name of fixed.slice(1)) verify(!initial.nodes[name].insideContent, `${name} stays outside the sidebar scroll wrapper`);
  verify(initial.nodes.content.clientHeight > 0 && initial.nodes.content.scrollHeight > initial.nodes.content.clientHeight, 'Short sidebar fixture genuinely overflows a nonzero inner viewport');
  verify(['auto', 'scroll'].includes(initial.nodes.content.overflowY), 'Inner sidebar-content owns vertical overflow');
  verify(await content.locator('nav[aria-label="Main navigation"], .sidebar-section, .sidebar-sessions').count() === 3, 'Navigation, section controls and chat history belong to the inner wrapper');
  const wheel = async bottom => {
    const box = await content.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(12, box.height / 2));
    await page.mouse.wheel(0, (initial.nodes.content.scrollHeight + 500) * (bottom ? 1 : -1));
    await page.waitForFunction(bottom => {
      const node = document.querySelector('#app-sidebar > .sidebar-content');
      return bottom ? node.scrollTop >= node.scrollHeight - node.clientHeight - 1 : node.scrollTop <= 1;
    }, bottom);
    await frames(page);
  };
  await wheel(true); await assertFixed('wheel-to-bottom');
  verify(await content.evaluate(node => node.scrollTop > 0), 'Ordinary wheel input scrolls sidebar-content');
  await wheel(true); await assertFixed('bottom-boundary');
  await screenshot(page, engine, current.name.replaceAll('/', '-') + '-scrolled');
  await wheel(false); await assertFixed('wheel-to-top');
  await wheel(false); await assertFixed('top-boundary');

  await content.getByRole('button', { name: 'Machines', exact: true }).click();
  await page.getByRole('heading', { name: 'Machines', level: 1, exact: true }).waitFor();
  await reveal(page); await frames(page); await assertFixed('navigation-click');
  await content.getByRole('button', { name: 'Find a task', exact: true }).click();
  const search = content.getByRole('textbox', { name: 'Find a task', exact: true });
  await search.waitFor(); await search.click(); await search.fill('layout inspection');
  verify(await search.evaluate(node => node === document.activeElement), 'Sidebar search remains reachable and focusable inside the scroll wrapper');
  await assertFixed('search-focus');
  await content.locator(`.chat-server-group[data-server-id="${A}"] [data-task-id="${taskId}"]`).click();
  await page.locator('.conversation-run').first().waitFor();
  await reveal(page); await frames(page); await assertFixed('chat-click');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1, exact: true }).waitFor();
  await settle(page, profile);
  const final = await locked(page);
  verify(final.window.every(value => value === 0) && Object.values(final.nodes).every(node => !node || node.scroll.every(value => value === 0)), 'Settings navigation leaves window and shell scroll locked');
}
async function providerValidation(page) {
  await page.getByText('Compatible endpoint', { exact: true }).click();
  const provider = page.locator('#compatible-provider'); await provider.fill('!invalid');
  await page.getByRole('button', { name: 'Save endpoint', exact: true }).click();
  verify(await provider.evaluate(node => node.validity.patternMismatch && node === document.activeElement), 'Compatible-provider validation prevents any request');
  await provider.fill('');
  const state = await locked(page);
  verify(state.window.every(value => value === 0) && Object.values(state.nodes).every(node => !node || node.scroll.every(value => value === 0)), 'Provider validation/focus does not scroll shell/window');
}
async function validation(page, view, profile) {
  const focus = async locator => { await locator.focus(); verify(await locator.evaluate(node => node === document.activeElement), 'Control retains focus without shell scrolling'); };
  if (view === 'general') {
    const name = page.locator('#environment-name'), route = page.locator('#new-route');
    verify(await name.getAttribute('maxlength') === '80', 'Environment label ID/length contract is preserved');
    const previous = await name.inputValue(); await name.fill('');
    await page.getByRole('button', { name: 'Rename environment', exact: true }).click();
    verify(await name.evaluate(node => node.validity.valueMissing && node === document.activeElement), 'Empty rename validates and focuses locally');
    await name.fill(previous); await route.fill('not a url');
    await page.getByRole('button', { name: 'Verify and use route', exact: true }).click();
    verify(await route.evaluate(node => node.validity.typeMismatch && node === document.activeElement), 'Invalid route validates and focuses without IPC');
    await route.fill(''); await focus(page.locator('#verified-route'));
  }
  if (view === 'memory') {
    const note = page.locator('#shared-memory-note'), save = page.getByRole('button', { name: 'Save to all servers', exact: true });
    verify(await note.getAttribute('maxlength') === '20000', 'Memory field ID/length contract is preserved');
    verify(await save.isDisabled(), 'Empty memory cannot be saved');
    verify(await note.evaluate(node => !node.reportValidity() && node.validity.valueMissing), 'Memory required-field validation stays local');
    await focus(note); await note.fill('   '); verify(await save.isDisabled(), 'Whitespace-only memory cannot be saved');
    await note.fill('Unsaved synthetic draft. ' + token);
    verify(profile.offline ? await save.isDisabled() : await save.isEnabled(), 'Memory save readiness reflects connection, without saving');
    await note.fill('');
  }
  if (view === 'models') {
    await focus(page.locator('.server-settings-tabs a[aria-current="page"]'));
    if (!profile.offline) {
      await focus(page.locator('#provider-search'));
      await page.getByText('Compatible endpoint', { exact: true }).click();
      await focus(page.locator('#compatible-provider'));
    }
  }
  if (view === 'devices' && !profile.offline) {
    const name = page.locator('#enroll-name'); await focus(name);
    verify(await name.evaluate(node => !node.reportValidity()), 'Empty enrollment is invalid locally');
    verify(await page.getByRole('button', { name: 'Enroll device', exact: true }).isDisabled(), 'Incomplete enrollment remains disabled');
  }
  if (view === 'recovery') verify(await page.getByRole('button', { name: 'Confirm and resume dispatch', exact: true }).isDisabled(), 'Geometry inspection does not authorize recovery');
  if (view === 'appearance') await focus(page.getByRole('switch', { name: 'Collapse sidebar', exact: true }));
  const state = await locked(page);
  verify(state.window.every(value => value === 0) && Object.values(state.nodes).every(node => !node || node.scroll.every(value => value === 0)), 'Validation/focus does not scroll shell/window');
}
async function protectedChat(page) {
  // The intentional task-terminal-heading is separate from legacy headers and assistant attribution strips.
  verify(await page.locator('.topbar, .task-heading, .task-title').count() === 0, 'Legacy global/task headers remain removed');
  const runs = await page.locator('.conversation-run').evaluateAll(nodes => nodes.map(node => {
    const content = node.querySelector(':scope > .run-content');
    return { headers: [...node.querySelectorAll('.run-byline, .message-byline, .outpost-mark, .message-model, time')].filter(child => !child.closest('.execution-entry, .stream-artifact')).length,
      first: node.firstElementChild === content, gap: content?.getBoundingClientRect().top - node.getBoundingClientRect().top };
  }));
  verify(runs.length > 0, 'Protected chat fixture contains assistant output');
  for (const run of runs) { verify(run.headers === 0 && run.first, 'Assistant header absent from DOM, not merely hidden'); near(run.gap, 0, 'Assistant content has no reserved header strip'); }
  const transcript = await page.locator('.conversation-content').evaluate(node => ({ width: node.getBoundingClientRect().width, max: getComputedStyle(node).maxWidth }));
  verify(transcript.width <= 805 && transcript.max === '804px', `Transcript retains 804px reading width: ${JSON.stringify(transcript)}`);
  const before = await locked(page);
  await page.locator('.conversation').evaluate(node => { node.scrollTop = node.scrollHeight; }); await frames(page);
  verify(await page.getByText('TRANSCRIPT-END', { exact: true }).evaluate(node => node.getBoundingClientRect().bottom <= node.closest('.conversation').getBoundingClientRect().bottom), 'Transcript terminal content is reachable');
  verify(JSON.stringify(before) === JSON.stringify(await locked(page)), 'Transcript scrolling preserves shell geometry');
}

const allViews = ['settings-home', 'appearance', 'servers', 'machines', ...tabs, 'add-server', 'approvals', 'library', 'memory', 'automations', 'all-chats'];
const profiles = [
  ...[1920, 1440].flatMap(width => ['general', 'memory'].map(view => ({ name: `baseline-${view}-${width}-dark-pinned`, width, height: 1000, scheme: 'dark', sidebar: 'pinned', views: [view], baseline: true }))),
  ...[1920, 1440, 1024, 781, 780, 390].flatMap(width => ['dark', 'light'].map(scheme => ({ name: `matrix-${width}-${scheme}-${scheme === 'dark' ? 'pinned' : 'collapsed'}-long`, width, height: 900, scheme, sidebar: scheme === 'dark' ? 'pinned' : 'collapsed', long: true, views: [...allViews, 'protected-chat'] }))),
  ...['empty', 'offline'].flatMap(state => [1440, 390].map(width => ({ name: `${state}-${width}`, width, height: 900, scheme: width === 1440 ? 'light' : 'dark', sidebar: 'pinned', [state]: true, long: true, views: allViews }))),
  ...['pinned', 'collapsed'].map(sidebar => ({ name: `short-desktop-${sidebar}`, width: 1024, height: 460, scheme: sidebar === 'pinned' ? 'dark' : 'light', sidebar, long: true, views: ['sidebar-containment', ...allViews, 'protected-chat'] })),
  ...[1440, 390].map(width => ({ name: `registry-error-${width}`, width, height: 460, scheme: width === 1440 ? 'dark' : 'light', sidebar: 'collapsed', registryError: true, views: ['registry'] })),
  { name: 'provider-validation', width: 1440, height: 900, scheme: 'dark', sidebar: 'pinned', long: true, views: ['invalid-provider'] },
];

async function runProfile(engine, profile, views) {
  const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, colorScheme: profile.scheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], network = [], dialogs = [];
  page.setDefaultTimeout(4500); page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && request.method() === 'GET' && ['document', 'script', 'stylesheet', 'font', 'image'].includes(request.resourceType())) return route.continue();
    network.push(`${request.method()} ${request.url()}`); return route.abort();
  });
  await context.routeWebSocket('**/*', socket => { network.push(socket.url()); socket.close(); });
  await context.addInitScript(installTransport, fixture(profile));
  try {
    current = { name: `${profile.name}/startup`, engine: engine.name(), errors: [], screenshots: [] };
    await page.goto(origin);
    if (profile.registryError) await page.getByRole('heading', { name: 'Saved environments', exact: true }).waitFor();
    else {
      await page.waitForFunction(({ A, B }) => window.__workspaceLayout.states[A].ready && window.__workspaceLayout.states[B].ready, { A, B });
      await page.locator('.main-shell').waitFor();
      if (profile.offline) { await page.evaluate(() => window.__workspaceLayout.offline()); await frames(page); }
    }
    await page.evaluate(() => document.fonts.ready);
    for (const view of views) {
      if (timedOut) break;
      current = { name: `${profile.name}/${view}`, engine: engine.name(), errors: [], screenshots: [] }; cases++;
      try {
        if (view === 'invalid-provider') {
          await navigate(page, 'models', profile);
          await providerValidation(page);
        } else if (view === 'sidebar-containment') await sidebarContainment(page, profile, engine);
        else {
          if (view !== 'registry') await navigate(page, view, profile);
          if (view === 'protected-chat') await protectedChat(page);
          else {
            await geometry(page, view);
            if (profile.baseline || (['general', 'memory', 'automations'].includes(view) && [1920, 780, 390].includes(profile.width)) ||
                (profile.width === 1440 && profile.scheme === 'light' && ['appearance', 'servers', 'machines'].includes(view))) await screenshot(page, engine, current.name.replaceAll('/', '-'));
            await scrollToEnd(page);
            await validation(page, view, profile);
            if (profile.empty && ['approvals', 'library', 'automations', 'memory'].includes(view)) verify(await page.locator('.workspace-view > .empty-line').isVisible(), 'Empty workspace state is visible');
            if (profile.offline && ['approvals', 'library', 'automations', 'memory'].includes(view)) verify((await page.locator('.workspace-view').innerText()).includes('Offline'), 'Cached records are clearly offline');
          }
        }
      } catch (error) { current.errors.push(error.stack || error.message); }
      const safety = await page.evaluate(() => ({ unexpected: window.__workspaceLayout.unexpected, calls: window.__workspaceLayout.calls })).catch(() => ({ unexpected: ['Page unavailable'], calls: [] }));
      verify(safety.unexpected.length === 0, `No unexpected/mutating IPC: ${JSON.stringify(safety.unexpected)}`);
      verify(!safety.calls.some(call => /send_command|retry_command|enroll_device|environment_(rename|register|remove|update_(check|start|cancel))|provider_transfer|setup_(scan|trust|install|restart)/.test(call.command)), 'Read-only geometry/validation sends no task, route, rename, remove, enrollment or maintenance commands');
      verify(!safety.calls.some(call => /^(?:environment_)?(?:terminal_|server_reboot_)/.test(call.command)), 'No terminal target/session/read/write or server-reboot requests');
      verify(network.length === 0, `No unexpected HTTP/WebSocket requests: ${JSON.stringify(network)}`);
      verify(errors.length === 0, `No browser runtime errors: ${JSON.stringify(errors)}`);
      verify(dialogs.length === 0, `No unexpected native confirmations: ${JSON.stringify(dialogs)}`);
      current.calls = safety.calls;
      if (current.errors.length) {
        failures.push(`${engine.name()}/${current.name}`);
        console.error(`FAIL ${engine.name()}/${current.name}\n${current.errors.join('\n')}`);
        if (!current.screenshots.length) await screenshot(page, engine, 'failure-' + current.name.replaceAll('/', '-')).catch(() => {});
      } else console.log(`PASS ${engine.name()}/${current.name}`);
      results.push(current);
    }
  } catch (error) {
    current.errors.push(error.stack || error.message); failures.push(`${engine.name()}/${current.name}`); results.push(current);
    console.error(`FAIL ${engine.name()}/${current.name}\n${current.errors.join('\n')}`);
    await screenshot(page, engine, 'startup-' + profile.name).catch(() => {});
  } finally { await context.close(); }
}
try {
  for (const engine of engines) {
    if (timedOut) break;
    browser = await engine.launch();
    try {
      for (const profile of profiles) {
        if (timedOut) break;
        const views = profile.views.filter(view => filter.test(`${profile.name}/${view}`));
        if (views.length) await runProfile(engine, profile, views);
      }
    } finally { await browser.close(); browser = null; }
  }
} finally {
  clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const finalDistHash = fingerprint(), changed = finalDistHash !== distHash;
  if (changed) failures.push(`${root} changed during the run; evidence is not a stable baseline`);
  if (!cases) failures.push('No cases selected (or startup failed); check OUTPOST_TEST_FILTER');
  if (timedOut) failures.push('Suite timeout');
  const report = `${output}/${phase}-${engines.map(engine => engine.name()).join('-')}-${runId}-report.json`;
  writeFileSync(report, JSON.stringify({ phase, runId, distRoot: root, distHash, finalDistHash, distChanged: changed, filter: filter.source, requireGrids, cases, checks, failures, measurements, results }, null, 2) + '\n');
  console.log(`REPORT ${report}\n${cases} cases, ${checks} checks, ${failures.length} failed; dist ${distHash}\nDIST ROOT ${root}`);
  if (failures.length) process.exitCode = 1;
}
