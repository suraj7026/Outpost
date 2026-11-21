import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from '../chat-test-navigation.mjs';

// Real production React + xterm, synthetic native IPC only. No SSH or reboot occurs.
// OUTPOST_TEST_DIST selects an existing immutable build; this suite never builds it.
// OUTPOST_TEST_MODE=layout skips lifecycle/reboot tests. OUTPOST_TEST_PHASE labels screenshots only.
const root = process.env.OUTPOST_TEST_DIST ? resolve(process.env.OUTPOST_TEST_DIST) : resolve(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const mode = process.env.OUTPOST_TEST_MODE || 'all';
const phase = process.env.OUTPOST_TEST_PHASE || 'after';
const out = '/tmp/outpost-server-terminal';
assert.ok(['all', 'layout'].includes(mode), 'OUTPOST_TEST_MODE must be all or layout');
assert.ok(['before', 'after'].includes(phase), 'OUTPOST_TEST_PHASE must be before or after');
assert.ok(existsSync(resolve(root, 'index.html')), `Existing build required at ${root}; this test does not build it`);
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const server = createServer((req, res) => {
  const path = resolve(root, new URL(req.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (req.method !== 'GET' || !path.startsWith(root + '/') || !existsSync(path) || !statSync(path).isFile()) return res.writeHead(404).end();
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream');
  res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const engines = process.env.OUTPOST_TEST_BROWSER ? [{ chromium, webkit }[process.env.OUTPOST_TEST_BROWSER]] : [chromium, webkit];
assert.ok(engines.every(Boolean), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
let checks = 0, layoutChecks = 0, lifecycleChecks = 0, layoutCases = 0;
const lifecycleEngines = [];
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++; };
const errors = [], external = [], layoutFailures = [];
mkdirSync(out, { recursive: true });
console.log(`Server-terminal tests: mode=${mode}, dist=${root}, phase=${phase}`);
function install({ A, B, options }) {
  const records = id => [{ kind: 'task', id: 'same-task-id', revision: 1, updatedAt: '2026-11-15T12:00:00Z', data: { goal: id === B ? 'Build chat' : 'Studio chat', state: options.state || 'running', model: 'fixture' } }, { kind: 'message', id: 'user', revision: 1, updatedAt: '2026-11-15T12:00:01Z', data: { taskId: 'same-task-id', author: 'owner', text: 'Inspect the server safely.' } }];
  const target = id => ({ setupId: `setup-${id}`, label: id === B ? 'Build server' : options.ownerLabel || 'Studio server', host: id === B ? 'build.fixture.invalid' : 'studio.fixture.invalid', user: id === B ? 'builder' : 'studio', port: 22, fingerprint: 'SHA256:synthetic-host-key' });
  const saved = (id, label) => ({ environmentId: id, label, activeRoute: 'https://fixture.invalid', routes: ['https://fixture.invalid'] });
  const registry = { version: 1, selectedEnvironmentId: A, legacyMutationsRetired: false, environments: { [A]: saved(A, options.ownerLabel || 'Studio server'), [B]: saved(B, 'Build server') } };
  const fixture = window.__terminalFixture = { calls: [], sessions: {}, reviews: {}, unexpected: [], holdOpen: false, holdRead: false, holdWrite: false, holdApply: false, releases: [], failTarget: false, failOpen: false, failRead: false, failWrite: false, failReview: false, failApply: false, mismatch: false, applyState: 'unknown', statusState: 'waiting', dropped: false, exited: false, release() { this.releases.splice(0).forEach(fn => fn()); } };
  let serial = 0;
  const hold = () => new Promise(resolve => fixture.releases.push(resolve));
  const bytes = value => btoa(String.fromCharCode(...value));
  if (options.preview) {
    window.__OUTPOST_RECORDED_PREVIEW__ = { snapshot: { protocolVersion: 1, cursor: 0, records: records(A) }, runtime: { configured: true }, models: { models: [] } };
    return;
  }
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args = {}) {
    fixture.calls.push({ command, args: structuredClone(args), at: Date.now() });
    if (command === 'plugin:window|set_theme') {
      if (args.label !== 'main' || ![null, 'light', 'dark'].includes(args.value)) {
        fixture.unexpected.push(command); throw new Error(`Invalid native theme request: ${JSON.stringify(args)}`);
      }
      return;
    }
    if (command.startsWith('plugin:') || ['set_sidebar_window_controls', 'sidebar_pointer_inside', 'connections_wake', 'set_window_blur', 'update_sidebar'].includes(command)) return;
    if (command === 'environment_list') return { registry };
    if (command === 'environment_select') { registry.selectedEnvironmentId = args.environmentId; return registry; }
    if (command === 'terminal_target') { if (fixture.failTarget || args.environmentId === null) throw 'No verified saved SSH binding for this server.'; return target(args.environmentId); }
    if (command === 'terminal_open') {
      if (fixture.holdOpen) await hold();
      if (fixture.failOpen) throw 'Synthetic SSH launch failed';
      const sessionId = `session-${++serial}`;
      // Euro character split across native reads exercises xterm's streaming UTF-8 decoder.
      fixture.sessions[sessionId] = { owner: args.environmentId, chunks: [bytes(new TextEncoder().encode(`fixture shell ${sessionId}\r\n`).slice()), bytes([0xe2]), bytes([0x82, 0xac, 13, 10]), bytes(new TextEncoder().encode('\x1b]52;c;c2VjcmV0\x07\x1b]8;;https://unsafe.invalid\x07plain text\x1b]8;;\x07\r\n$ '))], closed: false };
      return { sessionId, target: target(args.environmentId) };
    }
    if (command === 'terminal_read') {
      const session = fixture.sessions[args.sessionId];
      const chunk = session.chunks.shift() || '';
      if (fixture.holdRead) await hold();
      if (fixture.failRead) throw 'Synthetic read lost';
      return { data: chunk, nextOffset: args.offset + atob(chunk).length, dropped: fixture.dropped, exited: fixture.exited, exitCode: fixture.exited ? 7 : null };
    }
    if (command === 'terminal_write') { if (fixture.holdWrite) await hold(); if (fixture.failWrite) throw 'Synthetic write lost'; return; }
    if (command === 'terminal_resize') return;
    if (command === 'terminal_close') { fixture.sessions[args.sessionId].closed = true; return; }
    if (command === 'server_reboot_review') {
      if (fixture.failReview) throw 'Synthetic boot ID unavailable';
      const reviewId = `review-${++serial}`, reviewed = target(fixture.mismatch ? B : args.environmentId);
      fixture.reviews[reviewId] = args.environmentId; return { reviewId, target: reviewed };
    }
    if (command === 'server_reboot_apply') { if (fixture.holdApply) await hold(); if (fixture.failApply) throw 'Synthetic lost apply reply'; return { state: fixture.applyState, message: fixture.applyState === 'requested' ? 'Request acknowledged; completion not verified.' : 'Acknowledgment lost; reboot may have been dispatched.' }; }
    if (command === 'server_reboot_status') return { state: fixture.statusState, message: fixture.statusState === 'returned' ? 'Pinned server returned with changed boot ID.' : 'Waiting for changed boot ID; no command resent.' };
    const op = command.replace(/^environment_/, '');
    if (op === 'connection_info') return { endpoint: args.environmentId ? 'https://fixture.invalid' : '', deviceId: 'synthetic', pending: false, nativeSidebar: false };
    if (op === 'disconnect') return;
    if (op === 'stream_events') return new Promise(() => {});
    if (op === 'query') {
      if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 0, records: args.environmentId ? records(args.environmentId) : [] };
      if (args.kind === 'runtime') return { configured: true, model: 'fixture' };
      if (args.kind === 'models') return { models: ['fixture'], defaultModel: 'fixture' };
      if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 0 };
    }
    fixture.unexpected.push(command); throw new Error(`Unexpected synthetic call: ${command}`);
  } };
}
const count = (page, command) => page.evaluate(command => __terminalFixture.calls.filter(c => c.command === command).length, command);
const configure = (page, value) => page.evaluate(value => Object.assign(__terminalFixture, value), value);
const waitCalls = (page, command, amount) => page.waitForFunction(({ command, amount }) => __terminalFixture.calls.filter(c => c.command === command).length >= amount, { command, amount });
async function open(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: options.width || 1440, height: 1000 }, colorScheme: options.scheme || 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
    external.push(request.url()); return route.abort();
  });
  await page.context().routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
  await page.addInitScript(install, { A, B, options });
  await page.goto(origin);
  await openInitialTestChat(page);
  await page.getByRole('button', { name: 'Terminal', exact: true }).waitFor();
  return page;
}
async function toggle(page) { await page.getByRole('button', { name: 'Terminal', exact: true }).click(); }
async function connected(page) { await page.getByText('Shell connected', { exact: true }).waitFor(); await page.locator('.xterm').waitFor(); }
async function chat(page, id) { await page.locator(`.chat-server-group[data-server-id="${id}"] [data-task-id="same-task-id"]`).evaluate(node => node.click()); }
async function machines(page, label) {
  await page.getByRole('button', { name: 'Machines', exact: true }).evaluate(node => node.click());
  await page.getByRole('region', { name: label, exact: true }).getByRole('button', { name: 'Open terminal' }).click();
}
async function paste(page, text) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.locator('.xterm-helper-textarea').evaluate((node, text) => { const data = new DataTransfer(); data.setData('text/plain', text); node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, text);
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function layoutScreenshot(page, engine, name) {
  const path = `${out}/${phase}-${engine.name()}-${name}.png`;
  await page.screenshot({ path, animations: 'disabled', timeout: 5000 });
  console.log(`SCREENSHOT ${path}`);
}
async function layoutCase(browser, engine, name, options, run) {
  const startedAt = checks;
  layoutCases++;
  let page;
  try {
    page = await open(browser, options);
    await page.locator('.task-unified .conversation').waitFor();
    await page.evaluate(() => document.fonts.ready); await frames(page);
    await layoutScreenshot(page, engine, name);
    await run(page);
    equal(await page.evaluate(() => __terminalFixture.unexpected), [], 'Layout makes no unexpected native calls');
    equal(await page.evaluate(() => __terminalFixture.calls.filter(c => c.command.startsWith('server_reboot_'))), [], 'Layout never reviews or dispatches a reboot');
    console.log(`PASS ${engine.name()} / ${name}`);
  } catch (error) {
    layoutFailures.push(`${engine.name()} / ${name}: ${error.message.split('\n')[0]}`);
    console.error(`FAIL ${engine.name()} / ${name}\n${error.message}`);
    if (page && !page.isClosed()) await layoutScreenshot(page, engine, `failure-${name}`).catch(() => {});
  } finally { layoutChecks += checks - startedAt; await page?.close(); }
}
async function composerLayout(page, { scheme, ownerLabel, long }) {
  const trigger = page.getByRole('button', { name: 'Terminal', exact: true });
  const geometry = await trigger.evaluate(button => {
    const rect = node => {
      if (!node) return null;
      const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const context = document.querySelector('.composer-context-run');
    const identity = context?.querySelector('.composer-context-identity');
    const navigation = context?.querySelector('.environment-navigation');
    const owner = navigation?.querySelector('span:not(.environment-status)');
    let ownerFit = null;
    if (owner) {
      const range = document.createRange();
      range.selectNodeContents(owner);
      const text = range.getBoundingClientRect(), box = owner.getBoundingClientRect(), style = getComputedStyle(owner);
      const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      ownerFit = { availableWidth: right - left, textWidth: text.width, clientWidth: owner.clientWidth, scrollWidth: owner.scrollWidth,
        textLeft: text.left, textRight: text.right, left, right, textOverflow: style.textOverflow, overflowX: style.overflowX };
    }
    const dot = navigation?.querySelector('.environment-status');
    const status = context?.querySelector('.composer-run-status');
    const stop = context?.querySelector('.composer-run-stop');
    const heading = document.querySelector('.task-view h1');
    const headingStyle = heading && getComputedStyle(heading);
    const before = node => !!node && !!(button.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    const buttonBox = rect(button);
    return {
      oldHeaders: document.querySelectorAll('.task-terminal-heading').length,
      main: rect(document.querySelector('.main-shell')), task: rect(document.querySelector('.task-view')),
      columns: rect(document.querySelector('.task-columns')), conversation: rect(document.querySelector('.conversation')),
      heading: rect(heading), headingOutOfFlow: headingStyle?.position === 'absolute' && headingStyle.display !== 'none' && headingStyle.visibility !== 'hidden',
      context: rect(context), owner: rect(owner), dot: rect(dot), terminal: buttonBox, status: rect(status), stop: rect(stop),
      ownerText: owner?.textContent, ownerFit, dark: matchMedia('(prefers-color-scheme: dark)').matches,
      background: context && getComputedStyle(context).backgroundColor,
      colorScheme: context && getComputedStyle(context).colorScheme,
      inContext: !!context?.contains(button), inIdentity: !!identity?.contains(button),
      adjacent: navigation?.parentElement === identity && navigation?.nextElementSibling === button,
      beforeStatus: before(status), beforeStop: before(stop),
      terminalClass: button.matches('button.composer-terminal'),
      terminalUnclipped: button.scrollWidth <= button.clientWidth + 1,
      terminalHit: button.contains(document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2)),
      contextOverflow: context ? context.scrollWidth - context.clientWidth : null,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  console.log(`LAYOUT ${JSON.stringify(geometry)}`);
  const failures = [];
  const verify = (value, label) => { if (value) checks++; else failures.push(label); };
  const near = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) <= 1;
  const sameRow = (a, b) => a && b && Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) <= 2;
  const precedes = (a, b) => a && b && (a.bottom <= b.top + 1 || (sameRow(a, b) && a.right <= b.left + 1));
  verify(geometry.oldHeaders === 0, 'task-terminal-heading must be absent from the DOM, not hidden');
  verify(near(geometry.task?.top, geometry.main?.top) && near(geometry.columns?.top, geometry.task?.top) && near(geometry.conversation?.top, geometry.columns?.top), 'Conversation must start at main-shell top with no reserved heading row');
  verify(geometry.headingOutOfFlow && geometry.heading?.width <= 1 && geometry.heading?.height <= 1, 'Task h1 must remain screen-reader-only without reserving layout space');
  verify(await page.getByRole('heading', { name: 'Studio chat', level: 1, exact: true }).count() === 1, 'Task h1 must remain in the accessibility tree');
  verify(geometry.inContext && !geometry.inIdentity && geometry.terminalClass, 'Terminal button lives on the right of the composer strip, outside the owner label');
  verify(!geometry.beforeStatus && !geometry.beforeStop, 'Terminal follows the run controls in DOM order');
  verify(geometry.ownerText === ownerLabel, 'Composer must show the task owner label');
  if (!long) {
    const fit = geometry.ownerFit;
    verify(fit && fit.scrollWidth <= fit.clientWidth && fit.textLeft >= fit.left - 1 / 64 && fit.textRight <= fit.right + 1 / 64,
      `Normal owner label must have no ellipsis/clipping: ${JSON.stringify(fit)}`);
  }
  verify(sameRow(geometry.owner, geometry.dot) && sameRow(geometry.dot, geometry.terminal), 'Owner label, connection dot and Terminal must share a row');
  const ownerDotGap = geometry.dot?.left - geometry.owner?.right;
  const terminalGap = geometry.terminal.left - geometry.dot?.right;
  verify(ownerDotGap >= 0 && ownerDotGap <= 12 && terminalGap >= 0, `Owner/dot stay grouped and Terminal sits to their right (label–dot ${ownerDotGap}px; dot–Terminal ${terminalGap}px)`);
  verify((precedes(geometry.terminal, geometry.status) || precedes(geometry.status, geometry.terminal)) && (precedes(geometry.terminal, geometry.stop) || precedes(geometry.stop, geometry.terminal)), 'Terminal and status/Stop do not overlap in either responsive layout');
  verify(geometry.terminal.width >= 32 && geometry.terminal.height >= 32 && geometry.terminalUnclipped && geometry.terminalHit, 'Terminal icon button must remain visible, unclipped and pointer reachable');
    verify((await trigger.textContent()).trim() === '', 'Terminal toggle is icon-only');
    verify(await trigger.getAttribute('aria-label') === 'Terminal' && await trigger.getAttribute('title') === 'Terminal', 'Icon-only Terminal retains accessible name and tooltip');
    verify(await trigger.locator('svg.lucide-square-terminal').count() === 1, 'Terminal uses the same Lucide square-terminal glyph as the pane');
        equal(await trigger.locator('svg rect').evaluate(node => [getComputedStyle(node).rx, getComputedStyle(node).ry]), ['5px', '5px'], 'Terminal glyph has rounded corners in both engines');
  verify(geometry.context && geometry.terminal.left >= geometry.context.left && geometry.terminal.right <= geometry.context.right && geometry.terminal.top >= geometry.context.top && geometry.terminal.bottom <= geometry.context.bottom, 'Terminal bounds must stay inside the composer context strip');
  verify(geometry.documentOverflow <= 1 && geometry.contextOverflow !== null && geometry.contextOverflow <= 1, 'Long owner labels must not cause document or composer overflow');
  verify(geometry.dark === (scheme === 'dark'), 'Fixture must render the requested color scheme');
  verify(geometry.background === (scheme === 'light' ? 'rgb(230, 232, 236)' : 'rgb(16, 17, 18)') && geometry.colorScheme === scheme, 'Composer context must use the approved background and color scheme for each theme');
  verify(await trigger.getAttribute('aria-controls') === 'chat-server-terminal', 'Terminal must control chat-server-terminal');
  verify(await trigger.getAttribute('aria-expanded') === 'false', 'Terminal must initially expose collapsed semantics');
  verify(await page.locator('#chat-server-terminal').count() === 0, 'Collapsed terminal must not reserve pane space');
  verify(await count(page, 'terminal_open') === 0, 'Rendering the relocated trigger must not open a shell');
  equal(failures, [], 'Composer terminal layout requirements');
  await page.mouse.move(page.viewportSize().width - 2, 2);
  await page.evaluate(() => document.activeElement?.blur()); await frames(page);
  const focusStyle = node => {
    const style = getComputedStyle(node);
    return { active: node === document.activeElement, visible: node.matches(':focus-visible'), outlineWidth: style.outlineWidth,
      border: style.border, shadow: style.boxShadow, fill: style.backgroundColor, outlineStyle: style.outlineStyle };
  };
  const beforeFocus = await trigger.evaluate(focusStyle);
  const isWebkit = page.context().browser().browserType().name() === 'webkit';
  await trigger.focus();
  await page.keyboard.press(isWebkit ? 'Alt+Tab' : 'Tab');
  await page.keyboard.press(isWebkit ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await frames(page);
  const focused = await trigger.evaluate(focusStyle);
  console.log(`FOCUS ${JSON.stringify({ width: page.viewportSize().width, scheme, ownerLabel, before: beforeFocus, after: focused })}`);
  check(focused.active && focused.visible, 'Terminal receives actual sequential keyboard focus');
  equal(focused.outlineStyle, 'none', 'Terminal focus uses a surface change, not a painted outline');
  equal([focused.border, focused.shadow], [beforeFocus.border, beforeFocus.shadow], 'Terminal focus changes neither border nor shadow');
}
async function terminalDisclosure(page, resourcesOverlay, engine) {
  equal(await page.locator('.composer-context-run > button.composer-terminal').count(), 1, 'Disclosure uses the relocated composer Terminal button');
  const trigger = page.getByRole('button', { name: 'Terminal', exact: true });
  equal(await trigger.getAttribute('aria-expanded'), 'false', 'Terminal starts collapsed');
  equal(await trigger.getAttribute('aria-controls'), 'chat-server-terminal', 'Accessible trigger names its terminal pane');
  await trigger.focus(); await page.keyboard.press('Enter'); await connected(page);
  equal(await trigger.getAttribute('aria-expanded'), 'true', 'Keyboard activation expands terminal');
  check(await page.locator('#chat-server-terminal').isVisible(), 'Controlled terminal pane is visible');
  equal(await page.locator('#chat-server-terminal').getAttribute('data-terminal-owner'), A, 'Relocated trigger opens the chat owner shell');
  if (!resourcesOverlay && page.viewportSize().width === 1440) {
    await waitCalls(page, 'terminal_read', 5); await frames(page);
    await layoutScreenshot(page, engine, 'terminal-open-1440-dark');
  }
  const resources = page.getByRole('button', { name: 'Files, changes and browser', exact: true });
  const close = page.getByRole('button', { name: 'Close files and changes', exact: true });
  if (resourcesOverlay) {
    await resources.click(); await close.waitFor();
    check(await page.locator('.conversation-column').evaluate(node => node.inert), 'Narrow resources overlay makes composer inert');
    check(await page.locator('button.composer-terminal').evaluate(node => !!node.closest('[inert]')), 'Relocated terminal trigger is inside the inert composer');
  }
  await page.getByRole('button', { name: 'Collapse terminal', exact: true }).click(); await frames(page);
  equal(await page.locator('#chat-server-terminal').count(), 0, 'Collapse removes terminal pane');
  equal(await page.locator('button.composer-terminal').getAttribute('aria-expanded'), 'false', 'Collapse resets expanded semantics');
  if (resourcesOverlay) {
    check(await close.evaluate(node => node === document.activeElement), 'Collapse while composer is inert focuses visible resources Close');
    check(await close.isVisible(), 'Fallback focus target remains visible');
    await page.keyboard.press('Escape'); await close.waitFor({ state: 'hidden' }); await frames(page);
    check(await resources.evaluate(node => node === document.activeElement), 'Closing resources restores its composer trigger');
  } else {
    check(await trigger.evaluate(node => node === document.activeElement), 'Collapse restores focus to composer Terminal');
  }
  await trigger.focus(); await page.keyboard.press('Space'); await connected(page);
  equal(await trigger.getAttribute('aria-expanded'), 'true', 'Space reopens retained terminal');
  equal(await count(page, 'terminal_open'), 1, 'Composer disclosure reuses the existing shell');
  await fullWidthDock(page, '#chat-server-terminal');
  const writesBeforeEscape = await count(page, 'terminal_write');
  await page.locator('#chat-server-terminal .xterm-helper-textarea').focus();
  await page.keyboard.press('Escape'); await frames(page);
  equal(await page.locator('#chat-server-terminal').count(), 0, 'Escape inside xterm collapses the pane');
  equal(await count(page, 'terminal_write'), writesBeforeEscape, 'Collapse Escape is not forwarded as a remote keystroke');
  check(await trigger.evaluate(node => node === document.activeElement), 'Escape restores focus to terminal launcher');
  await trigger.click(); await connected(page);
  await trigger.click();
  equal(await trigger.getAttribute('aria-expanded'), 'false', 'Composer trigger also collapses terminal');
  equal(await page.locator('#chat-server-terminal').count(), 0, 'Trigger collapse removes terminal pane');
  equal(await count(page, 'terminal_close'), 0, 'Disclosure never disconnects retained shell');
}
async function fullWidthDock(page, selector) {
  const geometry = await page.locator(selector).evaluate(node => {
    const box = element => { const { left, right, bottom, height } = element.getBoundingClientRect(); return { left, right, bottom, height }; };
    return { pane: box(node), main: box(document.querySelector('.main-shell')), screen: box(node.querySelector('.server-terminal-screen')) };
  });
  check(Math.abs(geometry.pane.left - geometry.main.left) <= 1 && Math.abs(geometry.pane.right - geometry.main.right) <= 1, 'Terminal fills workspace width');
  check(Math.abs(geometry.pane.bottom - geometry.main.bottom) <= 1, 'Terminal reaches the workspace bottom');
  check(Math.abs(geometry.screen.bottom - geometry.pane.bottom) <= 1, 'Output reaches the dock bottom without a footer');
  equal(await page.locator('.statusbar, .server-terminal-footer, .server-terminal-state').count(), 0, 'History strip and text-heavy terminal footer/status row are absent');
  equal(await page.locator(`${selector} .server-terminal-dot`).getAttribute('data-state'), 'connected', 'Connected shell has a status dot');
  check(await page.locator(selector).getByRole('img', { name: 'Shell connected', exact: true }).isVisible(), 'Status dot has an accessible label');
  return geometry.pane;
}
async function layouts(browser, engine) {
  for (const scheme of ['dark', 'light']) for (const width of [1440, 900, 390]) for (const long of [false, true]) {
    const ownerLabel = long ? 'Outpost Research & Development — Europe West Production Server With A Long Name' : 'Outpost 1';
    const options = { width, scheme, ownerLabel, long, state: 'interrupted' };
    await layoutCase(browser, engine, `layout-${width}-${scheme}-${long ? 'long-owner' : 'owner'}`, options, page => composerLayout(page, options));
  }
  const splitOptions = { width: 1180, scheme: 'dark', ownerLabel: 'Outpost 1', long: false, state: 'interrupted' };
  await layoutCase(browser, engine, 'resources-split-1180-dark', splitOptions, async page => {
    const resources = page.getByRole('button', { name: 'Files, changes and browser', exact: true });
    await resources.click(); await page.locator('#task-resources').waitFor(); await frames(page);
    await layoutScreenshot(page, engine, 'resources-split-1180-dark');
    equal(await resources.getAttribute('aria-expanded'), 'true', 'Wide split resources remain open');
    const split = await page.locator('.task-columns').evaluate(node => {
      const column = node.querySelector('.conversation-column');
      const conversation = column.getBoundingClientRect(), panel = node.querySelector('#task-resources').getBoundingClientRect();
      return { overlay: matchMedia('(max-width: 1000px)').matches, inert: column.inert,
        conversationWidth: conversation.width, resourcesWidth: panel.width, gap: panel.left - conversation.right, topGap: panel.top - conversation.top };
    });
    console.log(`SPLIT ${JSON.stringify(split)}`);
    check(!split.overlay && !split.inert, '1180px resources use a split view without making the composer inert');
    check(split.conversationWidth > 0 && split.resourcesWidth > 0 && Math.abs(split.gap) <= 1 && Math.abs(split.topGap) <= 1,
      'Resources sit beside the conversation without covering it');
    await composerLayout(page, splitOptions);
    const trigger = page.getByRole('button', { name: 'Terminal', exact: true });
    await trigger.click({ trial: true });
    await trigger.focus();
    check(await trigger.evaluate(node => node === document.activeElement), 'Terminal remains pointer- and keyboard-reachable with split resources open');
  });
  for (const width of [1440, 900, 390]) {
    const options = { width, ownerLabel: 'Outpost 1', state: 'interrupted' };
    await layoutCase(browser, engine, `disclosure-${width}`, options, page => terminalDisclosure(page, false, engine));
    if (width <= 1000) await layoutCase(browser, engine, `resources-collapse-${width}`, options, page => terminalDisclosure(page, true, engine));
    await layoutCase(browser, engine, `shared-bottom-dock-${width}`, options, async page => {
      await toggle(page); await connected(page); await frames(page);
      const chatDock = await fullWidthDock(page, '#chat-server-terminal');
      await page.getByRole('button', { name: 'Terminal help', exact: true }).click();
      const help = page.getByRole('dialog', { name: 'Terminal help', exact: true }); await help.waitFor();
      check(await help.getByText('SHA256:synthetic-host-key', { exact: true }).isVisible(), 'Verified host details remain available in Help');
      await page.keyboard.press('Escape'); await help.waitFor({ state: 'hidden' });
      check(await page.locator('#chat-server-terminal').isVisible(), 'Escape in Help does not collapse the terminal');
      await page.keyboard.press('Meta+n'); await page.getByLabel('Task goal').waitFor();
      await toggle(page); await connected(page); await frames(page);
      const draftDock = await fullWidthDock(page, '#draft-server-terminal');
      equal(draftDock, chatDock, 'New task and Chat use identical terminal dock geometry');
      equal(await count(page, 'terminal_open'), 1, 'Both docks reuse the same server shell');
      await layoutScreenshot(page, engine, `new-task-bottom-dock-${width}`);
    });
  }
  for (const scheme of ['light', 'dark']) {
    await layoutCase(browser, engine, `machines-terminal-bottom-${scheme}`, { scheme, width: 1440 }, async page => {
      await machines(page, 'Studio server'); await connected(page); await waitCalls(page, 'terminal_read', 5); await frames(page);
      const viewport = await page.locator('.server-terminal-full .xterm-viewport').evaluate(node => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, overflowY: style.overflowY };
      });
      equal(viewport.background, 'rgba(0, 0, 0, 0)', 'Unused terminal row space reveals the themed surface, never xterm’s black default');
      equal(viewport.overflowY, 'scroll', 'Terminal viewport scrolling remains enabled');
      check(await page.locator('.server-terminal-full .xterm-screen').isVisible(), 'Full-size terminal renderer remains visible');
      await layoutScreenshot(page, engine, `machines-terminal-bottom-${scheme}`);
    });
  }
}
try {
  for (const engine of engines) {
    const browser = await engine.launch();
    let lifecycleStartedAt;
    try {
      await layouts(browser, engine);
      if (mode === 'layout') continue;
      lifecycleStartedAt = checks;
      const page = await open(browser);
      await toggle(page); await connected(page); await waitCalls(page, 'terminal_read', 5);
      equal(await page.locator('.xterm').count(), 1, 'Real xterm mounted once');
      check((await page.locator('.xterm-screen').textContent()).includes('€'), 'UTF-8 split reads decode correctly');
      equal(await page.locator('.server-terminal-screen a').count(), 0, 'Remote OSC hyperlinks are not activated');
      await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Control+c');
      await paste(page, 'echo café\r'); await waitCalls(page, 'terminal_write', 2);
      equal(await page.evaluate(() => __terminalFixture.calls.filter(c => c.command === 'terminal_write').map(c => atob(c.args.data))[0]), '\x03', 'Ctrl-C reaches PTY as a byte');
      const reads = await count(page, 'terminal_read');
      await page.getByRole('button', { name: 'Collapse terminal' }).click();
      check(await page.getByRole('button', { name: 'Terminal', exact: true }).evaluate(node => node === document.activeElement), 'Collapse returns keyboard focus');
      await waitCalls(page, 'terminal_read', reads + 2);
      equal(await count(page, 'terminal_close'), 0, 'Collapsed shell remains open and polled');
      for (let i = 0; i < 3; i++) { await toggle(page); await toggle(page); }
      await toggle(page); await connected(page);
      equal(await count(page, 'terminal_open'), 1, 'Rapid toggles reuse shell');
      check((await page.locator('.xterm-screen').textContent()).includes('€'), 'Output survives collapse');
      const writes = await count(page, 'terminal_write');
      await paste(page, 'one listener'); await waitCalls(page, 'terminal_write', writes + 1);
      equal(await count(page, 'terminal_write'), writes + 1, 'No duplicate input listeners after remount');
      await configure(page, { holdWrite: true });
      await paste(page, 'é'.repeat(5000)); await waitCalls(page, 'terminal_write', writes + 2);
      await chat(page, B); await toggle(page); await connected(page);
      await page.evaluate(() => { __terminalFixture.holdWrite = false; __terminalFixture.release(); });
      await waitCalls(page, 'terminal_write', writes + 4);
      check(await page.evaluate(({ A }) => __terminalFixture.calls.filter(c => c.command === 'terminal_write').every(c => __terminalFixture.sessions[c.args.sessionId].owner === A), { A }), 'Queued multichunk input never retargets after chat switch');
      const orderedPaste = await page.evaluate(start => __terminalFixture.calls.filter(c => c.command === 'terminal_write').slice(start).map(c => c.args.data), writes + 1);
      equal(Buffer.concat(orderedPaste.map(data => Buffer.from(data, 'base64'))).toString('utf8'), 'é'.repeat(5000), 'Large UTF-8 paste is byte-exact and ordered across chunks');
      await paste(page, 'build-only');
      await page.waitForFunction(({ B }) => __terminalFixture.calls.some(c => c.command === 'terminal_write' && __terminalFixture.sessions[c.args.sessionId].owner === B), { B });
      await machines(page, 'Studio server'); await connected(page);
      equal(await count(page, 'terminal_open'), 2, 'Machines attaches existing chat shell');
      await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('€'));
      check((await page.locator('.xterm-screen').textContent()).includes('€'), 'Machines retains chat output');
      const resizeCount = await count(page, 'terminal_resize');
      await page.setViewportSize({ width: 1100, height: 850 }); await waitCalls(page, 'terminal_resize', resizeCount + 1);
      await page.getByRole('button', { name: 'Reboot server…' }).click();
      await page.getByLabel('Confirm server hostname').fill('wrong');
      check(await page.getByRole('button', { name: 'Continue to authorization' }).isDisabled(), 'Exact hostname required');
      check((await page.getByRole('dialog').textContent()).includes('Every service, agent task and terminal session'), 'Whole-machine disruption warning');
      await page.keyboard.press('Escape');
      check(await page.getByRole('button', { name: 'Reboot server…' }).evaluate(node => node === document.activeElement), 'Dialog Escape returns focus');
      await page.getByRole('button', { name: 'Reboot server…' }).click();
      await page.getByLabel('Confirm server hostname').fill('studio.fixture.invalid ');
      check(await page.getByRole('button', { name: 'Continue to authorization' }).isDisabled(), 'Whitespace does not bypass exact confirmation');
      await page.getByLabel('Confirm server hostname').fill('studio.fixture.invalid');
      await page.getByLabel('Ask for a sudo password in the protected native prompt').check();
      await configure(page, { holdApply: true });
      await page.getByRole('button', { name: 'Continue to authorization' }).click();
      await waitCalls(page, 'server_reboot_apply', 1);
      equal(await page.getByRole('button', { name: 'Continue to authorization' }).count(), 0, 'Apply consumed before native reply');
      equal(await page.getByRole('button', { name: 'Review another reboot' }).count(), 0, 'Applying cannot start another review');
      await page.keyboard.press('Escape');
      await chat(page, B); await toggle(page); await connected(page);
      await page.evaluate(() => { __terminalFixture.holdApply = false; __terminalFixture.release(); });
      await chat(page, A); await toggle(page); await connected(page);
      await page.getByText('Reboot outcome unknown', { exact: true }).waitFor();
      const reviewsBeforeUnknown = await count(page, 'server_reboot_review');
      await page.getByRole('button', { name: 'Reboot status…' }).click();
      equal(await page.getByRole('button', { name: 'Continue to authorization' }).count(), 0, 'Unknown survives chat remount without retry');
      equal(await page.getByRole('button', { name: 'Review another reboot' }).count(), 0, 'Unknown outcome cannot start another review');
      equal(await count(page, 'server_reboot_review'), reviewsBeforeUnknown, 'Opening unknown status does not request a fresh review');
      const apply = await page.evaluate(() => __terminalFixture.calls.find(c => c.command === 'server_reboot_apply'));
      equal(apply.args.confirmation, 'studio.fixture.invalid', 'Review confirms actual host');
      equal(apply.args.password, true, 'Only boolean password preference crosses IPC');
      equal(Object.keys(apply.args).sort(), ['confirmation', 'password', 'reviewId'], 'No password value in JS request');
      equal(await page.evaluate(id => __terminalFixture.reviews[id], apply.args.reviewId), A, 'Reboot bound to original environment');
      await configure(page, { statusState: 'returned' });
      await waitCalls(page, 'server_reboot_status', 1);
      await page.getByText('Reboot verified', { exact: true }).waitFor();
      equal(await count(page, 'server_reboot_apply'), 1, 'Read-only status does not dispatch again');
      equal(await count(page, 'server_reboot_review'), reviewsBeforeUnknown, 'Verified return does not automatically create another review');
      await page.getByRole('button', { name: 'Review another reboot' }).click();
      await page.getByLabel('Confirm server hostname').waitFor();
      equal(await count(page, 'server_reboot_review'), reviewsBeforeUnknown + 1, 'Explicit action requests a fresh reboot review');
      equal(await count(page, 'server_reboot_apply'), 1, 'New review never automatically dispatches');
      equal(await page.getByLabel('Confirm server hostname').inputValue(), '', 'New review clears previous confirmation');
      check(!(await page.getByLabel('Ask for a sudo password in the protected native prompt').isChecked()), 'New review resets authorization preference');
      check(await page.getByRole('button', { name: 'Continue to authorization' }).isDisabled(), 'New review requires fresh exact-host confirmation');
      await configure(page, { applyState: 'unknown', statusState: 'waiting' });
      await page.getByLabel('Confirm server hostname').fill('studio.fixture.invalid');
      await page.getByRole('button', { name: 'Continue to authorization' }).click();
      await page.getByText('Reboot outcome unknown', { exact: true }).waitFor();
      const applies = await page.evaluate(() => __terminalFixture.calls.filter(c => c.command === 'server_reboot_apply'));
      equal(applies.length, 2, 'Second reboot dispatch requires its own explicit authorization');
      check(applies[1].args.reviewId !== apply.args.reviewId, 'Old apply review ID is never reused');
      equal(await page.evaluate(id => __terminalFixture.reviews[id], applies[1].args.reviewId), A, 'Fresh review remains bound to the original server');
      equal(await page.getByRole('button', { name: 'Review another reboot' }).count(), 0, 'Second unknown outcome locks new reviews again');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Reboot status…' }).click();
      equal(await count(page, 'server_reboot_apply'), 2, 'Reopening second unknown outcome cannot apply again');
      equal(await count(page, 'server_reboot_review'), reviewsBeforeUnknown + 1, 'Second unknown outcome cannot create another review');
      await page.keyboard.press('Escape');
      await page.screenshot({ path: `/tmp/outpost-server-terminal/${engine.name()}-chat.png` });
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await page.getByText('Shell disconnected', { exact: true }).waitFor();
      const ownerReads = () => page.evaluate(A => __terminalFixture.calls.filter(c => c.command === 'terminal_read' && __terminalFixture.sessions[c.args.sessionId].owner === A).length, A);
      const disconnectedReads = await ownerReads();
      await page.waitForTimeout(250);
      equal(await ownerReads(), disconnectedReads, 'Explicit disconnect stops owner polling while other shells continue');
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await connected(page);
      equal(await count(page, 'terminal_open'), 3, 'Reconnect explicitly creates a fresh shell');
      equal(await page.evaluate(() => __terminalFixture.unexpected), [], 'No unexpected IPC');
      await page.close();

      const races = await open(browser);
      await configure(races, { holdOpen: true }); await toggle(races); await waitCalls(races, 'terminal_open', 1);
      await races.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await races.evaluate(() => { __terminalFixture.holdOpen = false; __terminalFixture.release(); });
      await waitCalls(races, 'terminal_close', 1);
      equal(await count(races, 'terminal_read'), 0, 'Stale open reply closed without polling');
      await configure(races, { failTarget: true });
      await races.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await races.getByText('No verified saved SSH binding for this server.').waitFor();
      check(await races.getByRole('link', { name: 'Open Server setup in Settings' }).isVisible(), 'Missing binding has actionable setup guidance');
      equal(await count(races, 'terminal_open'), 1, 'No guessed host when binding missing');
      await configure(races, { failTarget: false, failOpen: true });
      await races.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await races.getByText('Synthetic SSH launch failed').waitFor();
      await configure(races, { failOpen: false }); await races.getByRole('button', { name: 'Reconnect', exact: true }).click(); await connected(races);
      await configure(races, { mismatch: true });
      await races.getByRole('button', { name: 'Reboot server…' }).click();
      await races.getByText(/reviewed SSH target no longer matches/).waitFor();
      check(await races.getByRole('button', { name: 'Continue to authorization' }).isDisabled(), 'Mismatched review target cannot apply');
      await races.keyboard.press('Escape');
      await configure(races, { mismatch: false, failReview: true });
      await races.getByRole('button', { name: 'Reboot server…' }).click();
      await races.getByText('Synthetic boot ID unavailable').waitFor();
      await races.keyboard.press('Escape');
      await configure(races, { failReview: false, failApply: true });
      await races.getByRole('button', { name: 'Reboot server…' }).click();
      await races.getByLabel('Confirm server hostname').fill('studio.fixture.invalid');
      await races.getByRole('button', { name: 'Continue to authorization' }).click();
      await races.getByRole('dialog').getByText(/Reboot outcome is not confirmed/).waitFor();
      await races.keyboard.press('Escape');
      await toggle(races); await toggle(races);
      equal(await count(races, 'server_reboot_apply'), 1, 'Rejected apply is not replayed');
      await configure(races, { failWrite: true }); await paste(races, 'bad-input');
      await races.getByText(/Terminal input stopped/).waitFor();
      const failedWrites = await count(races, 'terminal_write'); await races.waitForTimeout(200);
      equal(await count(races, 'terminal_write'), failedWrites, 'Failed input not retried');
      await configure(races, { failWrite: false }); await races.getByRole('button', { name: 'Reconnect', exact: true }).click(); await connected(races);
      await configure(races, { failRead: true }); await races.getByText(/Terminal read stopped/).waitFor();
      await configure(races, { failRead: false }); await races.getByRole('button', { name: 'Reconnect', exact: true }).click(); await connected(races);
      await configure(races, { dropped: true, exited: true });
      await races.getByText(/Some output exceeded/).waitFor();
      await races.getByText('Shell exited · code 7').waitFor();
      check((await races.locator('.xterm-screen').textContent()).includes('€'), 'Exited shell drains all output before closing');
      await races.close();

      const stale = await open(browser);
      await configure(stale, { holdRead: true }); await toggle(stale); await connected(stale); await waitCalls(stale, 'terminal_read', 1);
      await stale.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await stale.evaluate(() => { __terminalFixture.holdRead = false; __terminalFixture.release(); });
      await stale.getByRole('button', { name: 'Reconnect', exact: true }).click(); await connected(stale);
      await stale.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('session-2'));
      check(!(await stale.locator('.xterm-screen').textContent()).includes('session-1'), 'Late read from disconnected session cannot contaminate new shell');
      await stale.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await waitCalls(stale, 'terminal_close', 2);
      await stale.waitForFunction(() => Object.values(__terminalFixture.sessions).every(session => session.closed));
      check(await stale.evaluate(() => Object.values(__terminalFixture.sessions).every(session => session.closed)), 'Page teardown closes retained native shells');
      await stale.close();

      const bounded = await open(browser); await toggle(bounded); await connected(bounded);
      await bounded.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await bounded.clock.install();
      await configure(bounded, { applyState: 'requested' });
      await bounded.getByRole('button', { name: 'Reboot server…' }).click();
      await bounded.getByLabel('Confirm server hostname').fill('studio.fixture.invalid');
      await bounded.getByRole('button', { name: 'Continue to authorization' }).click();
      await waitCalls(bounded, 'server_reboot_apply', 1);
      await bounded.getByRole('dialog').getByText('Request acknowledged; completion not verified.').waitFor();
      equal(await bounded.getByText('Reboot verified', { exact: true }).count(), 0, 'Acknowledgment is not reboot completion');
      equal(await bounded.getByRole('button', { name: 'Review another reboot' }).count(), 0, 'Requested reboot cannot start another review');
      await bounded.clock.runFor(180_001);
      await bounded.getByRole('dialog').getByText(/three-minute verification window ended/).waitFor();
      const statusChecks = await bounded.evaluate(() => __terminalFixture.calls.filter(c => c.command === 'server_reboot_status'));
      check(statusChecks.length > 0 && statusChecks.length <= 36, 'Reboot observation is bounded');
      check(statusChecks.every((call, index) => !index || call.at - statusChecks[index - 1].at >= 5000), 'Status observations are at least five seconds apart');
      await bounded.clock.runFor(30_000);
      equal(await count(bounded, 'server_reboot_status'), statusChecks.length, 'No status polling past the three-minute window');
      equal(await count(bounded, 'server_reboot_apply'), 1, 'Timed-out reboot remains one-shot');
      await bounded.close();

      const small = await open(browser, { width: 390 }); await toggle(small); await connected(small);
      check(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow viewport has no horizontal overflow');
      await small.getByRole('button', { name: 'Reboot server…' }).click(); await small.getByLabel('Confirm server hostname').waitFor();
      await small.screenshot({ path: `/tmp/outpost-server-terminal/${engine.name()}-reboot-mobile.png` });
      check(await small.getByRole('button', { name: 'Continue to authorization' }).isVisible(), 'Mobile authorization remains reachable');
      await small.close();

      const preview = await open(browser, { preview: true }); await toggle(preview);
      await preview.getByText(/This preview is read-only/).waitFor();
      equal(await count(preview, 'terminal_open'), 0, 'Recorded preview never opens SSH');
      check(await preview.getByRole('button', { name: 'Reboot server…' }).isDisabled(), 'Recorded preview cannot reboot');
      await preview.close();
      lifecycleEngines.push(engine.name());
      console.log(`${engine.name()}: terminal, ownership, race and reboot checks passed`);
    } finally {
      if (lifecycleStartedAt !== undefined) lifecycleChecks += checks - lifecycleStartedAt;
      await browser.close();
    }
  }
  equal(errors, [], 'No browser exceptions');
  equal(external, [], 'No remote HTTP or WebSocket requests');
  equal(layoutFailures, [], 'Composer terminal layout/disclosure scenarios');
  console.log(`${checks} server-terminal browser assertions passed (${mode})`);
} finally {
  console.log(`RESULT ${JSON.stringify({ mode, layout: { passedAssertions: layoutChecks, passedScenarios: layoutCases - layoutFailures.length, failedScenarios: layoutFailures.length }, lifecycle: { passedAssertions: lifecycleChecks, completedEngines: lifecycleEngines }, browserErrors: errors.length, externalRequests: external.length })}`);
  await new Promise(resolve => server.close(resolve));
}
