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
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return !!document.querySelector('#app-sidebar')?.matches(':hover') || !!document.querySelector('.sidebar-edge')?.matches(':hover');
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
        if (command === 'query') return args.kind === 'events' ? { events: [], hasMore: false, nextCursor: 1 } : fixture[args.kind];
        if (command === 'stream_events') return new Promise(() => {});
        if (command === 'plugin:window|set_effects') {
          window.__effects.push(args);
          await new Promise(resolve => setTimeout(resolve, 30));
          if (window.__failEffects) throw new Error('Synthetic native effect failure');
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
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
}
const glass = (page, enabled) => page.waitForFunction(value => document.documentElement.dataset.glass === String(value), enabled);
const surface = (page, selector) => page.locator(selector).evaluate(node => {
  const style = getComputedStyle(node);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d'); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
  return { alpha: context.getImageData(0, 0, 1, 1).data[3] / 255, opacity: style.opacity, filter: style.filter, backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none', radius: style.borderRadius };
});
async function checkReadingComposite(page) {
  for (const opacity of [20, 45, 80]) {
    await page.locator('#glass-opacity').fill(String(opacity));
    const result = await page.evaluate(value => {
      const root = getComputedStyle(document.documentElement);
      const frame = getComputedStyle(document.querySelector('.app-shell'));
      const reading = getComputedStyle(document.querySelector('.main-shell'));
      const tint = reading.backgroundImage.match(/linear-gradient\((color\([^)]*\)|rgba?\([^)]*\))/)?.[1];
      if (!tint) throw new Error(`Missing reading tint: ${reading.backgroundImage}`);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const paint = (color, alpha = 1) => { context.globalAlpha = alpha; context.fillStyle = color; context.fillRect(0, 0, 1, 1); };
      paint(root.getPropertyValue('--bg'), value / 100);
      paint(root.getPropertyValue('--surface'), Math.max(.56, Math.min(.88, value / 100 + .28)));
      const before = [...context.getImageData(0, 0, 1, 1).data];
      context.clearRect(0, 0, 1, 1);
      paint(frame.backgroundColor); paint(reading.backgroundColor); paint(tint);
      return { before, after: [...context.getImageData(0, 0, 1, 1).data] };
    }, opacity);
    check(result.before.every((channel, i) => Math.abs(channel - result.after[i]) <= 2), `Reading surface composite is unchanged at ${opacity}%: ${JSON.stringify(result)}`);
  }
  await page.locator('#glass-opacity').fill('20');
}
async function checkFrostedFooter(page) {
  const effectsBefore = await page.evaluate(() => window.__effects.length);
  await page.locator('#glass-opacity').fill('20');
  const low = await surface(page, '.app-shell');
  check(low.alpha >= .045 && low.alpha <= .055, 'Frame/sidebar tint is reduced from 20% to 5% without changing native blur');
  await page.locator('#glass-opacity').fill('21');
  check(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--glass-frame-opacity')) > 5), 'Opacity slider still responds immediately above its minimum before 8-bit pixel rounding');
  await page.locator('#glass-opacity').fill('20');
  await checkReadingComposite(page);
  check(await page.evaluate(() => window.__effects.length) === effectsBefore, 'Lowering opacity never weakens or rebuilds the native blur');
  await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).uncheck();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  await page.mouse.move(800, 30); await page.waitForTimeout(170);
  const selected = await surface(page, '.connection-nav');
  check(selected.alpha === 0 && selected.backdrop === 'none', 'Selected This Mac shares the sidebar glass without another tile');
  check(selected.opacity === '1' && selected.filter === 'none' && selected.radius === '8px', 'Footer text stays sharp and its original corner geometry is preserved');
  check((await surface(page, '.profile-avatar')).alpha === 0, 'Avatar background shares exactly the sidebar transparency');
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  check((await surface(page, '.connection-nav')).alpha === 0, 'Selected hover adds no dark tile');
  await page.getByRole('button', { name: 'New task', exact: false }).click();
  await page.waitForTimeout(170);
  const normal = await surface(page, '.connection-nav');
  check(normal.alpha === 0 && normal.backdrop === 'none', 'Normal This Mac shares the same glass as the sidebar');
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  check((await surface(page, '.connection-nav')).alpha === 0, 'Normal hover keeps the same transparency');
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.emulateMedia({ contrast: 'more' });
  await page.locator('.connection-nav').hover(); await page.waitForTimeout(170);
  const contrast = await surface(page, '.connection-nav');
  check(contrast.alpha === 1 && contrast.backdrop === 'none', 'Increased contrast independently overrides even selected/hovered glass styling');
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
    const header = document.querySelector('.task-active .task-heading') || document.querySelector('.topbar');
    const button = header.getBoundingClientRect();
    return { width: innerWidth, inset: innerWidth <= 780 ? 8 : 12, top: rect.y, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom, radius: getComputedStyle(document.querySelector('.main-shell')).borderRadius, buttonLeft: button.x, rootScroll: scrollY, mainScroll: document.querySelector('.main-shell').scrollTop, bodyWidth: document.documentElement.scrollWidth };
  });
  for (const side of ['top', 'right', 'bottom']) check(Math.abs(result[side] - result.inset) < 1, `${side} padding remains even`);
  check(result.radius === (result.width <= 780 ? '6px' : '8px'), 'Workspace corners use the inset radius');
  check(result.bodyWidth <= result.width && !result.rootScroll && !result.mainScroll, 'Outer scrolling remains locked');
  return result;
}
try {
  const config = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8'));
  check(config.app.macOSPrivateApi && config.app.windows[0].transparent, 'Native transparency is enabled, not simulated with CSS');
  check(JSON.parse(readFileSync('desktop/src-tauri/capabilities/default.json')).permissions.includes('core:window:allow-set-effects'), 'Only required native effects permission added');
  for (const scheme of ['dark', 'light']) {
    const page = await open({ scheme });
    await geometry(page);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await page.locator('.web-sidebar').waitFor({ state: 'hidden' });
    check(!await page.locator('.web-sidebar').isVisible(), 'Sidebar collapses on task view');
    check((await geometry(page)).buttonLeft === 12, 'Hidden native controls no longer require a header gap');
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
    await page.getByRole('switch', { name: 'Frosted glass', exact: true }).check();
    await glass(page, true);
    check(await page.evaluate(() => window.__effects.at(-1).value.effects[0] === 'underWindowBackground'), 'Uses native behind-window background material');
    check(await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)'), 'HTML reveals native blur');
    check(await page.locator('.main-shell').evaluate(node => getComputedStyle(node).opacity === '1' && getComputedStyle(node).backgroundImage.includes('0.73')), 'Only background tint is translucent, not content opacity');
    await checkFrostedFooter(page);
    await page.locator('#glass-opacity').fill('64');
    check(await page.locator('output[for="glass-opacity"]').innerText() === '64%', 'Slider updates immediately');
    await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).check();
    await page.locator('.web-sidebar').waitFor({ state: 'hidden' });
    check(!await page.locator('.web-sidebar').isVisible(), 'Settings collapse control updates layout');
    await page.reload();
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    await glass(page, true);
    check(!await page.locator('.web-sidebar').isVisible(), 'Collapsed preference persists across reload');
    check(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).opacity === 64, storageKey), 'Opacity persists');
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
    check(await page.evaluate(() => document.documentElement.dataset.glass === 'false' && window.__effects.at(-1).value.effects.length === 0), 'Rapid toggles leave native effect and CSS in the latest requested state');
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
    else check(await page.locator('#glass-opacity').inputValue() === (scenario === 'clamp' ? '80' : '45'), 'Stored values validated and clamped');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} appearance checks (${engine.name()}); native IPC contract, persistence, accessibility, fallback, sidebar and corner geometry.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
