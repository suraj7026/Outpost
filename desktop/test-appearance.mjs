import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
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
  { id: 'task', kind: 'task', revision: 1, updatedAt: '2026-10-30T12:00:00Z', data: { goal: 'Appearance fixture', profile: 'operations', state: 'paused' } },
  { id: 'message', kind: 'message', revision: 1, updatedAt: '2026-10-30T12:00:00Z', data: { taskId: 'task', author: 'assistant', text: '## Recorded inspection\n\nOnly synthetic data is used here.\n\n'.repeat(60) } },
] }, runtime: { model: 'fixture:cloud' }, models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' } };
let checks = 0; const errors = [];
const check = (value, label) => { assert.ok(value, label); checks++; };
const storageKey = 'outpost.appearance.v1';
async function open({ width = 1320, scheme = 'dark', scenario = 'native' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme: scheme });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ fixture, scenario, storageKey }) => {
    if (scenario === 'corrupt') localStorage.setItem(storageKey, '{broken');
    if (scenario === 'blocked') Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    if (scenario === 'clamp') localStorage.setItem(storageKey, JSON.stringify({ opacity: 900, frosted: 'yes', sidebarCollapsed: 'no' }));
    if (scenario === 'preview') { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; return; }
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = realMatchMedia(query);
      if (query.includes('prefers-reduced-transparency')) {
        Object.defineProperty(media, 'matches', { get: () => window.__reduced === true });
        window.__reduceMedia = media;
      }
      return media;
    };
    window.__effects = []; let sequence = 0;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'disconnect') return;
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return !!document.querySelector('#app-sidebar')?.matches(':hover') || !!document.querySelector('.sidebar-edge')?.matches(':hover');
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
        if (command === 'query') return args.kind === 'events' ? { events: [], hasMore: false, nextCursor: 1 } : fixture[args.kind];
        if (command === 'stream_events') return new Promise(() => {});
        if (command === 'set_window_blur') {
          await new Promise(resolve => setTimeout(resolve, 30));
          if (window.__failEffects) throw new Error('Synthetic native effect failure');
          window.__effects.push(args.radius);
          return;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }, { fixture, scenario, storageKey });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function settings(page) {
  if (await page.locator('.web-sidebar').getAttribute('aria-hidden') === 'true') await page.keyboard.press('Meta+b');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-link-list a[href="#settings/appearance"]').click();
  await page.getByRole('heading', { name: 'Appearance', exact: true, level: 1 }).waitFor();
}
const glass = (page, enabled) => page.waitForFunction(value => document.documentElement.dataset.glass === String(value), enabled);
const blur = (page, radius) => page.waitForFunction(value => window.__effects.at(-1) === value, radius);
const surface = (page, selector) => page.locator(selector).evaluate(node => {
  const style = getComputedStyle(node);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d'); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
  return { alpha: context.getImageData(0, 0, 1, 1).data[3] / 255, opacity: style.opacity, filter: style.filter, backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none', radius: style.borderRadius };
});
const workspaceBackground = page => page.locator('.main-shell').evaluate(node => getComputedStyle(node).background);
async function checkSidebarGlass(page) {
  await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).uncheck();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  const chat = '.chat-server-threads > [data-task-id="task"]';
  const selectors = ['.sidebar-chrome .icon-button', '.sidebar-section .icon-button', '#task-search', chat];
  const sample = async opacity => {
    await page.locator('#glass-opacity').fill(String(opacity));
    await page.locator(chat).hover();
    await page.waitForTimeout(170);
    return Promise.all(selectors.map(async selector => (await surface(page, selector)).alpha));
  };
  const low = await sample(0);
  const high = await sample(80);
  for (const [i, selector] of selectors.entries()) {
    check(low[i] < high[i] && high[i] < 1, `${selector} adapts to glass opacity (${low[i]} → ${high[i]})`);
  }
  await page.locator('#glass-opacity').fill('0');
  await page.locator(chat).click();
  await page.locator(`${chat}[aria-current="page"]`).waitFor();
  await page.mouse.move(800, 30);
  await page.waitForTimeout(170);
  const selected = await surface(page, chat);
  check(selected.alpha > low.at(-1) && selected.alpha < 1, 'Selected chat stays distinct and translucent');
  await settings(page);
}
async function checkFrostedFooter(page, solidBackground) {
  await page.locator('#glass-opacity').fill('0');
  await blur(page, 0);
  check((await surface(page, 'html')).alpha === 0 && (await surface(page, '.app-shell')).alpha === 0,
    'Zero opacity has no frame tint or native blur');
  await page.locator('#glass-opacity').fill('20');
  await blur(page, 20);
  const low = await surface(page, '.app-shell');
  check(Math.abs(low.alpha - .2) < .01, 'Frame opacity matches the slider');
  for (const [opacity, radius] of [[50, 32], [99, 1], [100, 0]]) {
    await page.locator('#glass-opacity').fill(String(opacity));
    await blur(page, radius);
    const workspace = await surface(page, '.main-shell');
    check(workspace.alpha === 1 && workspace.opacity === '1' && await workspaceBackground(page) === solidBackground,
      `Workspace keeps its solid background at ${opacity}% glass opacity`);
  }
  await glass(page, false);
  check((await surface(page, 'html')).alpha === 1, '100% uses the solid background with native blur off');
  await page.locator('#glass-opacity').fill('0');
  await glass(page, true);
  await blur(page, 0);
  await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).uncheck();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  await page.mouse.move(800, 30); await page.waitForTimeout(170);
  const selected = await surface(page, '.connection-nav');
  check(selected.alpha === 0 && selected.backdrop === 'none', 'Selected This Mac shares the sidebar glass without another tile');
  check(selected.opacity === '1' && selected.filter === 'none' && selected.radius === '8px', 'Footer text stays sharp and its original corner geometry is preserved');
  check(await page.locator('.connection-nav > svg').first().isVisible(), 'Unified Settings icon stays visible on glass');
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  check((await surface(page, '.connection-nav')).alpha === 0, 'Selected hover adds no dark tile');
  await page.getByRole('button', { name: 'New task', exact: false }).click();
  await page.waitForTimeout(170);
  const normal = await surface(page, '.connection-nav');
  check(normal.alpha === 0 && normal.backdrop === 'none', 'Normal This Mac shares the same glass as the sidebar');
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  check((await surface(page, '.connection-nav')).alpha === 0, 'Normal hover keeps the same transparency');
  await settings(page);
  await page.emulateMedia({ contrast: 'more' });
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  const contrast = await surface(page, '.connection-nav');
  check(contrast.alpha === 1 && contrast.backdrop === 'none', 'Increased contrast independently overrides even selected/hovered glass styling');
  check((await surface(page, '.sidebar-chrome .icon-button')).alpha === 1, 'Increased contrast keeps sidebar controls solid');
  await page.emulateMedia({ contrast: 'no-preference' });
  await page.waitForTimeout(170);
  mkdirSync('/tmp/outpost-frost', { recursive: true });
  const theme = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  await page.screenshot({ path: `/tmp/outpost-frost/${engine.name()}-${theme}-minimum.png` });
  await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).check();
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  const overlay = await surface(page, '.web-sidebar');
  check(overlay.alpha === 0, 'Pushing sidebar exposes native glass, not a dark overlay pane');
  check((await surface(page, '.connection-nav')).alpha === 0, 'This Mac matches the revealed sidebar');
  await page.keyboard.press('Escape');
}
async function geometry(page) {
  const result = await page.evaluate(() => {
    const rect = document.querySelector('.main-shell').getBoundingClientRect();
    const content = document.querySelector('.main-shell > .task-view, .main-shell > main, .main-shell > .settings-workspace');
    const start = content.getBoundingClientRect();
    const conversation = document.querySelector('.conversation')?.getBoundingClientRect();
    const composer = document.querySelector('.reply-composer')?.getBoundingClientRect();
    return { width: innerWidth, inset: innerWidth <= 780 ? 8 : 12, top: rect.y, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom, radius: getComputedStyle(document.querySelector('.main-shell')).borderRadius, contentLeft: start.x, contentTop: start.top - rect.top, conversationTop: conversation ? conversation.top - rect.top : null, composerBottom: composer ? rect.bottom - composer.bottom : null, headers: document.querySelectorAll('.topbar, .task-heading, .task-title').length, rootScroll: scrollY, mainScroll: document.querySelector('.main-shell').scrollTop, bodyWidth: document.documentElement.scrollWidth };
  });
  for (const side of ['top', 'right', 'bottom']) check(Math.abs(result[side] - result.inset) < 1, `${side} padding remains even`);
  check(result.radius === (result.width <= 780 ? '6px' : '8px'), 'Workspace corners use the inset radius');
  check(result.bodyWidth <= result.width && !result.rootScroll && !result.mainScroll, 'Outer scrolling remains locked');
  check(result.headers === 0, 'Global and task headers are absent from the DOM');
  check(Math.abs(result.contentTop) <= 1, 'Current page starts at the workspace top without a reserved header row');
  if (result.conversationTop !== null) {
    check(result.conversationTop >= 0 && result.conversationTop <= 32, 'Task conversation starts at the top with normal padding only');
    check(Math.abs(result.composerBottom - 12) <= 1, 'Task composer remains pinned to its 12px bottom inset');
  }
  return result;
}
try {
  const config = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8'));
  check(config.app.macOSPrivateApi && config.app.windows[0].transparent, 'Native transparency is enabled, not simulated with CSS');
  check(config.app.windows[0].shadow === false, 'Native window shadow and its outline are disabled');
  for (const scheme of ['dark', 'light']) {
    const page = await open({ scheme });
    await geometry(page);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await page.locator('.web-sidebar').waitFor({ state: 'hidden' });
    check(!await page.locator('.web-sidebar').isVisible(), 'Sidebar collapses on task view');
    check((await geometry(page)).contentLeft === 12, 'Collapsing the sidebar leaves no native-control or header gap in the content frame');
    await page.keyboard.press('Meta+b');
    check(await page.locator('.web-sidebar').isVisible(), 'Shortcut restores sidebar');
    await page.keyboard.press('Meta+b');
    await page.keyboard.press('Meta+k');
    await page.getByRole('textbox', { name: 'Find a task', exact: true }).waitFor();
    check(await page.locator('#task-search').evaluate(node => node === document.activeElement), 'Search reveals sidebar and focuses field');
    await settings(page);
    check(!await page.getByRole('switch', { name: 'Frosted glass', exact: true }).isChecked(), 'Solid appearance is the default');
    check(await page.locator('.appearance-toggle').first().evaluate(node => getComputedStyle(node).display === 'flex'), 'Switches align beside their labels, not under them');
    check(await page.getByRole('switch', { name: 'Frosted glass', exact: true }).evaluate(node => { const rect = node.getBoundingClientRect(); return rect.width === 44 && rect.height === 28; }), 'Switch geometry stays 44×28 despite general form input rules');
    const solidBackground = await workspaceBackground(page);
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).check();
    await glass(page, true);
    check(await page.evaluate(() => window.__effects.at(-1) === 32), 'Default opacity applies full native blur');
    check(await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)'), 'HTML reveals native blur');
    await checkSidebarGlass(page);
    await checkFrostedFooter(page, solidBackground);
    await page.locator('#glass-opacity').fill('64');
    check(await page.locator('output[for="glass-opacity"]').innerText() === '64%', 'Slider updates immediately');
    await page.locator('#glass-opacity').fill('0');
    await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).check();
    await page.locator('.web-sidebar').waitFor({ state: 'hidden' });
    check(!await page.locator('.web-sidebar').isVisible(), 'Settings collapse control updates layout');
    await page.reload();
    await page.getByRole('heading', { name: 'Appearance', exact: true, level: 1 }).waitFor();
    await glass(page, true);
    check(!await page.locator('.web-sidebar').isVisible(), 'Collapsed preference persists across reload');
    check(await page.locator('#glass-opacity').inputValue() === '0', 'Zero opacity persists across reload');
    await settings(page);
    await page.evaluate(() => { window.__reduced = true; window.__reduceMedia.dispatchEvent(new Event('change')); });
    await glass(page, false);
    check(await page.locator('#glass-opacity').isDisabled(), 'Accessibility preference overrides translucency');
    // WebKit can retain cached styles on display:none descendants; verify the visible surface.
    await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).uncheck();
    const reducedFooter = await surface(page, '.connection-nav');
    check(reducedFooter.backdrop === 'none', `Reduced transparency disables footer blur: ${JSON.stringify(reducedFooter)}`);
    await page.evaluate(() => { window.__reduced = false; window.__reduceMedia.dispatchEvent(new Event('change')); });
    await glass(page, true);
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).uncheck();
    await glass(page, false);
    check((await surface(page, '.connection-nav')).backdrop === 'none', 'Glass-off mode preserves the original solid appearance');
    await page.evaluate(() => { window.__failEffects = true; });
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).check();
    await page.getByRole('alert').filter({ hasText: 'Frosted glass could not be applied' }).waitFor();
    await glass(page, false);
    check(await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'Native failure leaves an opaque fallback');
    await page.evaluate(() => { window.__failEffects = false; });
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).uncheck();
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).check();
    await glass(page, true);
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).uncheck();
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).check();
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).uncheck();
    await page.waitForTimeout(180);
    check(await page.evaluate(() => document.documentElement.dataset.glass === 'false' && window.__effects.at(-1) === 0), 'Rapid toggles leave native effect and CSS in the latest requested state');
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).check();
    await glass(page, true);
    mkdirSync('/tmp/outpost-appearance', { recursive: true });
    await page.screenshot({ path: `/tmp/outpost-appearance/${engine.name()}-${scheme}.png` });
    await page.close();
  }
  for (const width of [900, 390]) {
    const page = await open({ width });
    await geometry(page);
    await settings(page);
    await geometry(page);
    await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).check();
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    check(await page.locator('.web-sidebar').isVisible(), 'Narrow overlay stays usable with persisted collapse');
    await page.getByRole('button', { name: 'New task', exact: false }).click();
    await page.locator('.web-sidebar').waitFor({ state: 'hidden' });
    check(!await page.locator('.web-sidebar').isVisible(), 'Navigation closes narrow drawer');
    await geometry(page);
    await page.close();
  }
  for (const scenario of ['corrupt', 'blocked', 'clamp', 'preview']) {
    const page = await open({ scenario });
    await settings(page);
    if (scenario === 'blocked') check(await page.getByRole('alert').filter({ hasText: 'could not be saved' }).isVisible(), 'Storage failures are visible and nonfatal');
    else if (scenario === 'preview') check(await page.getByRole('switch', { name: 'Frosted glass', exact: true }).isDisabled(), 'Browser preview never claims native blur');
    else check(await page.locator('#glass-opacity').inputValue() === (scenario === 'clamp' ? '100' : '45'), 'Stored values validated and clamped');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} appearance checks (${engine.name()}); native IPC contract, persistence, accessibility, fallback, sidebar and corner geometry.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
