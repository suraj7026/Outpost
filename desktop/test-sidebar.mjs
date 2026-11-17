import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';
const root = resolve('desktop/dist');
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const fixture = { snapshot: { cursor: 1, protocolVersion: 1, records: [
  { kind: 'task', id: 'task', revision: 1, updatedAt: '2026-10-30T12:00:00Z', data: { goal: 'Sidebar fixture', profile: 'operations', state: 'paused' } },
  { kind: 'message', id: 'message', revision: 1, updatedAt: '2026-10-30T12:00:00Z', data: { taskId: 'task', author: 'assistant', text: '## Recorded inspection\n\nSynthetic output, no server operations.\n\n'.repeat(60) } },
] }, runtime: {}, models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' } };
let checks = 0; const errors = [];
const check = (value, label) => { assert.ok(value, label); checks++; };
const shown = (page, visible) => page.locator('#app-sidebar').waitFor({ state: visible ? 'visible' : 'hidden' });
const controls = (page, visible) => page.waitForFunction(value => window.__controls.at(-1) === value, visible);
const frame = page => page.locator('.main-shell').boundingBox();
async function open(width, colorScheme = 'dark') {
  const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ fixture }) => {
    window.isTauri = true; window.__controls = []; window.__controlFrames = []; window.__timeouts = []; let sequence = 0;
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => { window.__timeouts.push(delay); return schedule(fn, delay, ...args); };
    let x = -1, y = -1;
    document.addEventListener('pointermove', event => { x = event.clientX; y = event.clientY; });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'disconnect') return;
        if (command === 'set_sidebar_window_controls') { window.__controls.push(args.visible); window.__controlFrames.push(args); return; }
        if (command === 'sidebar_pointer_inside') return window.__nativeArea ?? (x >= 0 && x <= args.width && y >= 0 && y <= innerHeight);
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', pending: false, nativeSidebar: false };
        if (command === 'query') return args.kind === 'events' ? { events: [], hasMore: false, nextCursor: 1 } : fixture[args.kind];
        if (command === 'stream_events') return new Promise(() => {});
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }, { fixture });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openInitialTestChat(page);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}
try {
  for (const scheme of ['dark', 'light']) {
    const page = await open(1320, scheme);
    await controls(page, true);
    check(await page.locator('#app-sidebar .sidebar-chrome button').count() === 1, 'One state-aware sidebar control replaces Close and Pin');
    check(await page.locator('.topbar, .task-heading, .task-title').count() === 0, 'Content headers are removed, not hidden with their sidebar controls');
    check(await page.locator('.conversation').evaluate(node => node.getBoundingClientRect().top - document.querySelector('.main-shell').getBoundingClientRect().top <= 32), 'Conversation starts at the workspace top without a reserved header row');
    check(await page.locator('.reply-composer').evaluate(node => Math.abs(document.querySelector('.main-shell').getBoundingClientRect().bottom - node.getBoundingClientRect().bottom - 12) <= 1), 'Composer stays pinned after removing the task header');
    check(await page.locator('#app-sidebar .brand').count() === 0, 'Sidebar brand is removed from the DOM');
    const geometry = () => page.evaluate(() => {
      const box = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; };
      return { sidebar: box('#app-sidebar'), navigation: box('.web-sidebar nav'), chrome: box('.sidebar-chrome'), control: box('.sidebar-chrome button') };
    });
    const centeredControls = () => page.evaluate(() => {
      const nativeY = window.__controlFrames.at(-1).y;
      const button = document.querySelector('.sidebar-chrome button').getBoundingClientRect();
      return Math.abs(nativeY - document.querySelector('.new-task-button').getBoundingClientRect().top / 2) < .5
        && Math.abs(nativeY - (button.top + button.height / 2)) < .5;
    });
    check(await centeredControls(), 'Traffic lights and sidebar control share the vertical midpoint between the window top and New task');
    const anchor = await geometry();
    const nativeRequests = await page.evaluate(() => window.__controlFrames.length);
    for (const width of [1601, 1600, 1599, 1151, 1150, 1149, 901, 900, 901, 1151, 1320]) {
      await page.setViewportSize({ width, height: width === 900 ? 600 : 850 });
      await page.waitForTimeout(40);
      assert.deepEqual(await geometry(), anchor, `Sidebar/header geometry stays anchored through ${width}px resize`); checks++;
      check(await centeredControls(), 'Traffic lights remain centered after resizing');
      check(await page.evaluate(() => window.__controlFrames.length) === nativeRequests, 'Resizing does not queue duplicate or stale native button positions');
      check(await page.locator('#task-evidence').isVisible(), 'Persistent Evidence remains visible during resizing');
    }
    const docked = await frame(page);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await shown(page, false); await controls(page, false);
    const hidden = await frame(page);
    check(hidden.x === 12 && hidden.width > docked.width, 'Closing sidebar frees the whole workspace width');
    await page.locator('.conversation').evaluate(node => { node.scrollTop = 500; });
    await page.mouse.move(1, 380);
    await shown(page, true);
    const samples = await page.evaluate(() => {
      const panel = document.querySelector('#app-sidebar'), shell = document.querySelector('.app-shell');
      const animations = document.getAnimations().filter(a => a.effect.target === panel || a.effect.target === shell);
      animations.forEach(a => a.pause());
      const samples = [0, 130, 350, 447, 520].map(time => {
        animations.forEach(a => { a.currentTime = time; });
        return { main: document.querySelector('.main-shell').getBoundingClientRect().x, sidebar: panel.getBoundingClientRect().x };
      });
      const hiddenControls = window.__controls.at(-1) === false;
      animations.forEach(a => a.play());
      return { samples, count: animations.length, hiddenControls, durations: animations.map(a => a.effect.getTiming().duration) };
    });
    check(samples.count === 2 && samples.hiddenControls, 'Pane and workspace animate together while native controls stay hidden');
    check(samples.durations.every(duration => duration === 520), 'Both entrance animations use the slower 520ms timing');
    check(await page.locator('.sidebar-edge').evaluate(node => { const style = getComputedStyle(node); return style.opacity === '0' && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none'; }), 'Hover edge stays invisible even while hovered during sliding');
    check(samples.samples[1].main > samples.samples[0].main && samples.samples[1].main < samples.samples[4].main, 'Workspace moves continuously during reveal');
    check(samples.samples[2].main > samples.samples[4].main && samples.samples[3].main < samples.samples[4].main, 'Spring overshoots and gently settles');
    await controls(page, true);
    const revealed = await frame(page);
    check(revealed.x > hidden.x && revealed.width < hidden.width, 'Hover pushes and resizes the workspace');
    const nativeRow = await page.evaluate(() => window.__controlFrames.at(-1));
    check(nativeRow.x >= 24 && await centeredControls(), 'Native dots keep their horizontal inset and vertical midpoint after sidebar reveal');
    check(await page.locator('.conversation').evaluate(node => node.scrollTop === 500), 'Hover does not change conversation scroll');
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('outpost.appearance.v1')).sidebarCollapsed), 'Hover does not change saved pin preference');
    await page.mouse.move(140, 380);
    await page.waitForTimeout(350);
    check(await page.locator('#app-sidebar').isVisible(), 'Sidebar stays while moving from edge into the panel');
    // Native controls do not produce DOM pointer events; the native hit test owns this region.
    await page.evaluate(() => { window.__nativeArea = true; });
    await page.mouse.move(600, 350);
    await page.waitForTimeout(450);
    check(await page.locator('#app-sidebar').isVisible(), 'Native traffic-light hover keeps the panel usable');
    await page.evaluate(() => { window.__nativeArea = false; });
    await shown(page, false); await controls(page, false);
    await page.evaluate(() => { delete window.__nativeArea; });
    await page.mouse.move(1, 400); await shown(page, true);
    await page.mouse.move(600, 400); await page.waitForTimeout(60);
    await page.mouse.move(100, 400); await page.waitForTimeout(350);
    check(await page.locator('#app-sidebar').isVisible(), 'Brief edge crossing does not flicker closed');
    await page.mouse.move(600, 400);
    await page.waitForTimeout(280);
    check(await page.locator('#app-sidebar').getAttribute('data-motion') !== 'closing', 'Leaving the hover area no longer starts dismissal at 220ms');
    check(await page.evaluate(() => window.__timeouts.includes(350)), 'Hover dismissal waits 350ms');
    await shown(page, false);
    await page.mouse.move(1, 400); await controls(page, true);
    await page.keyboard.press('Escape');
    await page.locator('#app-sidebar[data-motion="closing"]').waitFor();
    const interrupted = await page.evaluate(() => {
      const panel = document.querySelector('#app-sidebar'), shell = document.querySelector('.app-shell');
      document.getAnimations().filter(a => a.effect.target === panel || a.effect.target === shell).forEach(a => { a.pause(); a.currentTime = 120; });
      return { transform: getComputedStyle(panel).transform, column: parseFloat(getComputedStyle(shell).gridTemplateColumns), inert: panel.inert, controls: window.__controls.at(-1), durations: document.getAnimations().filter(a => a.effect.target === panel || a.effect.target === shell).map(a => a.effect.getTiming().duration) };
    });
    check(interrupted.inert && !interrupted.controls, 'Closing immediately disables sidebar interaction and hides native controls');
    check(interrupted.durations.every(duration => duration === 240), 'Both exit animations use 240ms timing');
    await page.mouse.move(600, 400); await page.mouse.move(1, 400);
    await page.locator('#app-sidebar[data-motion="opening"]').waitFor();
    const reversal = await page.evaluate(() => {
      const animations = document.getAnimations(), panel = document.querySelector('#app-sidebar'), shell = document.querySelector('.app-shell');
      return { transform: animations.find(a => a.effect.target === panel)?.effect.getKeyframes()[0].transform, column: parseFloat(animations.find(a => a.effect.target === shell)?.effect.getKeyframes()[0].gridTemplateColumns) };
    });
    check(reversal.transform === interrupted.transform && Math.abs(reversal.column - interrupted.column) < .1, 'Re-entry reverses from the current pane and workspace positions without jumping');
    await controls(page, true);
    await page.mouse.move(600, 400); await shown(page, false);
    await page.keyboard.press('Meta+k');
    await page.getByRole('textbox', { name: 'Find a task', exact: true }).waitFor();
    await page.waitForTimeout(500);
    check(await page.locator('#task-search').evaluate(node => node === document.activeElement), 'Keyboard search stays accessible outside hover area');
    await page.keyboard.press('Escape'); await shown(page, false); await controls(page, false);
    check(await page.locator('.main-shell').evaluate(node => node === document.activeElement), 'Dismissal moves focus out of the hidden panel');
    await page.keyboard.press('Meta+b'); await shown(page, true);
    await page.getByRole('button', { name: 'Pin sidebar', exact: true }).click();
    assert.deepEqual(await frame(page), revealed, 'Pinning holds the hover layout without a second shift'); checks++;
    await page.mouse.move(800, 400); await page.waitForTimeout(500);
    check(await page.locator('#app-sidebar').isVisible(), 'Pinned sidebar stays open away from pointer');
    await page.reload(); await shown(page, true); await controls(page, true);
    check((await frame(page)).x > 12, 'Pinned layout persists across reload');
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await shown(page, false); await controls(page, false);
    check((await frame(page)).x === 12, 'Pinned-state control collapses and releases workspace width');
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('outpost.appearance.v1')).sidebarCollapsed), 'Collapse also unpins the sidebar');
    await page.reload(); await shown(page, false); await controls(page, false);
    await page.mouse.move(1, 400); await shown(page, true);
    await page.getByRole('button', { name: 'New task', exact: false }).click();
    await shown(page, false);
    await page.getByRole('heading', { name: 'What should run next?', exact: true }).waitFor();
    await page.mouse.move(1, 400); await shown(page, true);
    check(await page.locator('.topbar, .task-heading, .task-title').count() === 0, 'Home also has no hidden header DOM');
    await page.locator('.home').click({ position: { x: 300, y: 20 } }); await shown(page, false);
    check(await page.locator('.home').evaluate(node => Math.abs(node.getBoundingClientRect().top - document.querySelector('.main-shell').getBoundingClientRect().top) <= 1), 'Home content starts at the main-shell top after outside-click dismissal');
    await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.id = 'test-dialog'; document.body.append(dialog); dialog.showModal(); });
    await page.mouse.move(500, 400); await page.mouse.move(1, 400);
    await page.keyboard.press('Meta+b');
    check(!await page.locator('#app-sidebar').isVisible(), 'Modal prevents edge and shortcut reveal');
    await page.evaluate(() => document.querySelector('#test-dialog').remove());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.mouse.move(500, 400); await page.mouse.move(1, 400); await shown(page, true);
    check(await page.evaluate(() => scrollY === 0 && document.querySelector('.main-shell').scrollTop === 0), 'Reveal preserves outer scroll lock');
    check(await page.evaluate(() => document.getAnimations().filter(a => a.effect.target === document.querySelector('.app-shell') || a.effect.target === document.querySelector('#app-sidebar')).length === 0), 'Reduce Motion disables both spring and workspace animations');
    const closeBox = await page.getByRole('button', { name: 'Pin sidebar', exact: true }).boundingBox();
    check(closeBox.x > 100 && closeBox.height >= 28, 'Sidebar controls clear native traffic lights with usable targets');
    mkdirSync('/tmp/outpost-sidebar', { recursive: true });
    await page.screenshot({ path: `/tmp/outpost-sidebar/${engine.name()}-${scheme}.png` });
    await page.close();
  }
  for (const width of [900, 390]) {
    const page = await open(width);
    if (width > 780) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await shown(page, false); await controls(page, false);
    const before = await frame(page);
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await shown(page, true); await controls(page, true);
    if (width > 780) check((await frame(page)).x > before.x, 'Minimum native window also uses push layout');
    else { assert.deepEqual(await frame(page), before); checks++; }
    await page.keyboard.press('Escape');
    await shown(page, false); await controls(page, false);
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).focus();
    await shown(page, true);
    await page.keyboard.press('Tab');
    check(await page.locator('#app-sidebar').evaluate(node => node.contains(document.activeElement)), 'Keyboard-only entry reaches sidebar controls');
    await page.keyboard.press('Escape'); await shown(page, false);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No narrow-layout overflow');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} sidebar checks (${engine.name()}); spring motion, push layout, native chrome, pinning, persistence, focus and modals.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
