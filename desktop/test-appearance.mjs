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
async function open({ width = 1320, scheme = 'dark', scenario = 'native', storedAppearance, failTheme = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme: scheme });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ fixture, scenario, storageKey, storedAppearance, failTheme }) => {
    if (storedAppearance !== undefined && !sessionStorage.getItem('appearance-fixture-seeded')) {
      localStorage.setItem(storageKey, storedAppearance);
      sessionStorage.setItem('appearance-fixture-seeded', 'true');
    }
    if (scenario === 'corrupt') localStorage.setItem(storageKey, '{broken');
    if (scenario === 'blocked') Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    if (scenario === 'clamp') localStorage.setItem(storageKey, JSON.stringify({ opacity: 900, frosted: 'yes', sidebarCollapsed: 'no', conversationWidth: 'invalid' }));
    if (scenario === 'preview') window.__OUTPOST_RECORDED_PREVIEW__ = fixture;
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
    window.__nativeCalls = [];
    window.__themeRequests = [];
    window.__nativeThemes = [];
    window.__themeInFlight = 0;
    window.__maxThemeInFlight = 0;
    window.__failTheme = failTheme;
    window.isTauri = scenario !== 'preview';
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        window.__nativeCalls.push(command);
        if (command === 'plugin:window|set_theme') {
          if (args.label !== 'main' || ![null, 'light', 'dark'].includes(args.value)) throw new Error(`Invalid native theme request: ${JSON.stringify(args)}`);
          window.__themeRequests.push(args.value);
          window.__themeInFlight++;
          window.__maxThemeInFlight = Math.max(window.__maxThemeInFlight, window.__themeInFlight);
          try {
            if (window.__holdNextTheme) {
              window.__holdNextTheme = false;
              await new Promise(resolve => { window.__releaseTheme = resolve; });
            } else await new Promise(resolve => setTimeout(resolve, 30));
            if (window.__failTheme) throw new Error('Synthetic native theme failure');
            window.__nativeThemes.push(args.value);
          } finally { window.__themeInFlight--; }
          return;
        }
        if (command === 'setup_list' || command === 'setup_history_list') return [];
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
  }, { fixture, scenario, storageKey, storedAppearance, failTheme });
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
const themeRadio = (page, theme) => page.getByRole('group', { name: 'Theme', exact: true })
  .getByRole('radio', { name: theme[0].toUpperCase() + theme.slice(1), exact: true });
const resolvedTheme = (page, preference, theme) => page.waitForFunction(({ preference, theme }) =>
  document.documentElement.dataset.themePreference === preference && document.documentElement.dataset.theme === theme,
{ preference, theme });
const nativeTheme = (page, theme) => page.waitForFunction(theme =>
  window.__nativeThemes.length > 0 && window.__nativeThemes.at(-1) === theme && window.__themeInFlight === 0, theme);
const savedAppearance = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
async function checkTheme(page, preference, theme) {
  await resolvedTheme(page, preference, theme);
  check(await themeRadio(page, preference).isChecked(), `${preference} remains selected while resolving to ${theme}`);
  check(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme) === theme,
    `Native form controls use the resolved ${theme} color scheme`);
}
async function checkThemePalette(page, theme) {
  const colors = await page.locator('html').evaluate(node => {
    const style = getComputedStyle(node), context = document.createElement('canvas').getContext('2d');
    return Object.fromEntries(['--bg', '--surface', '--raised', '--text'].map(token => {
      context.fillStyle = style.getPropertyValue(token).trim();
      return [token, context.fillStyle];
    }));
  });
  const expected = theme === 'light'
    ? { '--bg': '#f1f2f4', '--surface': '#ffffff', '--raised': '#f1f2f4', '--text': '#24272d' }
    : { '--bg': '#0f1011', '--surface': '#16171a', '--raised': '#1c1d21', '--text': '#ededef' };
  assert.deepEqual(colors, expected, `${theme} retains the specified root palette`); checks++;
  check(await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor)
    === (theme === 'light' ? 'rgb(241, 242, 244)' : 'rgb(15, 16, 17)'), `${theme} root paints the selected background`);
}
async function checkContextTheme(page, theme) {
  const contexts = page.locator('.composer-context:visible');
  await contexts.first().waitFor();
  for (const context of await contexts.all()) {
    check(await context.evaluate(node => getComputedStyle(node).backgroundColor)
      === (theme === 'light' ? 'rgb(230, 232, 236)' : 'rgb(16, 17, 18)'), `${theme} composer context follows the app palette`);
  }
}
async function checkSetupTheme(page, theme) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-link-list a[href="#machines"]').click();
  await page.getByRole('link', { name: 'Add server', exact: true }).click();
  const dialog = page.locator('dialog.server-setup-dialog[open]');
  await dialog.waitFor();
  check(await dialog.evaluate(node => node.matches(':modal')), 'Theme is checked on the real setup modal');
  const style = await dialog.evaluate(node => {
    const style = getComputedStyle(node);
    return { scheme: style.colorScheme, background: style.backgroundColor };
  });
  check(style.scheme === theme, `Setup dialog uses manual ${theme}, not the opposite OS theme`);
  check(style.background === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(27, 28, 31)'),
    `Setup dialog paints its ${theme} palette independently of the OS`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}
async function checkThemePreferences() {
  for (const scheme of ['dark', 'light']) {
    const manual = scheme === 'dark' ? 'light' : 'dark';
    const page = await open({ scheme });
    await resolvedTheme(page, 'auto', scheme);
    await nativeTheme(page, null);
    await checkContextTheme(page, scheme);
    await settings(page);
    await checkTheme(page, 'auto', scheme);
    await checkThemePalette(page, scheme);
    const group = page.getByRole('group', { name: 'Theme', exact: true });
    check(await group.evaluate(node => node.tagName === 'FIELDSET'), 'Theme choices have a native accessible fieldset');
    check(await group.getByRole('radio').count() === 3, 'Theme fieldset exposes exactly Auto, Light and Dark');
    const inputs = await group.getByRole('radio').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, type: node.type, name: node.name })));
    check(inputs.every(node => node.tag === 'INPUT' && node.type === 'radio' && node.name && node.name === inputs[0].name),
      'Theme choices are native radios in one keyboard group');
    await page.emulateMedia({ colorScheme: manual });
    await checkTheme(page, 'auto', manual);
    await checkThemePalette(page, manual);
    await page.emulateMedia({ colorScheme: scheme });
    await checkTheme(page, 'auto', scheme);
    check((await savedAppearance(page)).theme === 'auto', 'OS changes do not replace the saved Auto preference');
    check(await page.evaluate(() => window.__themeRequests.every(theme => theme === null)), 'Auto never sends a resolved manual theme to native chrome');
    await themeRadio(page, manual).check();
    await checkTheme(page, manual, manual);
    await nativeTheme(page, manual);
    await checkThemePalette(page, manual);
    check((await savedAppearance(page)).theme === manual, 'Manual theme is saved immediately');
    await page.getByRole('button', { name: 'New task', exact: false }).click();
    await checkContextTheme(page, manual);
    await settings(page);
    await checkSetupTheme(page, manual);
    await settings(page);
    await page.reload();
    await page.getByRole('heading', { name: 'Appearance', exact: true, level: 1 }).waitFor();
    await checkTheme(page, manual, manual);
    await nativeTheme(page, manual);
    check(await page.evaluate(theme => window.__themeRequests.every(value => value === theme), manual),
      'Saved manual theme is applied to native chrome on startup without an Auto reset');
    const requests = await page.evaluate(() => window.__themeRequests.length);
    for (const colorScheme of [manual, scheme]) {
      await page.emulateMedia({ colorScheme });
      // Allow media change listeners and the delayed native mock to finish before asserting no override.
      await page.waitForTimeout(100);
      await checkTheme(page, manual, manual);
      await checkThemePalette(page, manual);
    }
    check(await page.evaluate(() => window.__themeRequests.length) === requests, 'Manual theme ignores OS changes without extra native calls');
    await themeRadio(page, 'auto').check();
    await checkTheme(page, 'auto', scheme);
    await nativeTheme(page, null);
    await page.reload();
    await page.getByRole('heading', { name: 'Appearance', exact: true, level: 1 }).waitFor();
    await checkTheme(page, 'auto', scheme);
    await nativeTheme(page, null);
    await page.emulateMedia({ colorScheme: manual });
    await checkTheme(page, 'auto', manual);
    await page.close();
  }
  const invalidPreferences = ['{broken', 'null', '[]', '"dark"', ...['system', 'Dark', '', null, true, 42, {}].map(theme => JSON.stringify({ theme }))];
  for (const [index, storedAppearance] of invalidPreferences.entries()) {
    const scheme = index % 2 ? 'light' : 'dark';
    const page = await open({ scheme, storedAppearance });
    await settings(page);
    await checkTheme(page, 'auto', scheme);
    await nativeTheme(page, null);
    check((await savedAppearance(page)).theme === 'auto', `Corrupt/invalid preference falls back to Auto: ${storedAppearance}`);
    await themeRadio(page, 'light').check();
    await nativeTheme(page, 'light');
    check((await savedAppearance(page)).theme === 'light', 'Invalid storage does not prevent saving a valid replacement');
    await page.close();
  }
  {
    const preferences = { theme: 'invalid', frosted: true, opacity: 64, sidebarCollapsed: true, conversationWidth: 'large' };
    const page = await open({ storedAppearance: JSON.stringify(preferences) });
    await settings(page);
    await checkTheme(page, 'auto', 'dark');
    await themeRadio(page, 'light').check();
    await nativeTheme(page, 'light');
    assert.deepEqual(await savedAppearance(page), { ...preferences, theme: 'light', conversationDetail: 'compact' }, 'Theme validation and selection preserve every other appearance preference and initialize conversation detail'); checks++;
    await page.reload();
    await page.getByRole('heading', { name: 'Appearance', exact: true, level: 1 }).waitFor();
    await checkTheme(page, 'light', 'light');
    check(await page.getByRole('switch', { name: 'Frosted glass', exact: true }).isChecked()
      && await page.locator('#glass-opacity').inputValue() === '64'
      && await page.getByRole('switch', { name: 'Collapse sidebar', exact: true }).isChecked()
      && await page.getByRole('radio', { name: 'Large', exact: true }).isChecked(), 'Other preferences remain effective after theme reload');
    await page.close();
  }
  {
    const page = await open({ scheme: 'dark' });
    await settings(page);
    await nativeTheme(page, null);
    await themeRadio(page, 'auto').focus();
    // Native WebKit radios stop at group edges; Chromium wraps. Exercise traversal shared by both.
    for (const [key, preference] of [['ArrowRight', 'light'], ['ArrowRight', 'dark'], ['ArrowLeft', 'light'], ['ArrowLeft', 'auto']]) {
      await page.keyboard.press(key);
      await checkTheme(page, preference, preference === 'auto' ? 'dark' : preference);
      check(await themeRadio(page, preference).evaluate(node => node === document.activeElement), 'Arrow keys move both theme selection and focus');
    }
    await themeRadio(page, 'light').focus();
    await page.keyboard.press('Space');
    await checkTheme(page, 'light', 'light');
    await nativeTheme(page, 'light');
    await themeRadio(page, 'auto').check();
    await nativeTheme(page, null);
    const start = await page.evaluate(() => { window.__holdNextTheme = true; return window.__themeRequests.length; });
    await themeRadio(page, 'light').check();
    await page.waitForFunction(() => typeof window.__releaseTheme === 'function');
    for (const preference of ['dark', 'auto', 'dark']) {
      await themeRadio(page, preference).check();
      await checkTheme(page, preference, preference === 'auto' ? 'dark' : preference);
    }
    assert.deepEqual(await page.evaluate(start => window.__themeRequests.slice(start), start), ['light'], 'Native theme changes wait behind the in-flight request'); checks++;
    await page.evaluate(() => window.__releaseTheme());
    await nativeTheme(page, 'dark');
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(start => window.__themeRequests.slice(start), start), ['light', 'dark'], 'Superseded queued theme requests are skipped'); checks++;
    check(await page.evaluate(() => window.__maxThemeInFlight === 1 && window.__nativeThemes.at(-1) === 'dark'),
      'Rapid switching serializes native calls and leaves the last requested theme applied');
    check((await savedAppearance(page)).theme === 'dark', 'Rapid switching persists only the latest selected preference');
    await page.evaluate(() => { window.__failTheme = true; });
    await themeRadio(page, 'light').check();
    const alert = page.getByRole('alert').filter({ hasText: /theme/i });
    await alert.waitFor();
    check(await alert.isVisible(), 'Native theme IPC failure is surfaced accessibly');
    await checkTheme(page, 'light', 'light');
    check(await page.evaluate(() => window.__nativeThemes.at(-1) === 'dark'), 'Failed theme IPC is not recorded as native success');
    await page.evaluate(() => { window.__failTheme = false; });
    await themeRadio(page, 'auto').check();
    await nativeTheme(page, null);
    await alert.waitFor({ state: 'hidden' });
    await themeRadio(page, 'light').check();
    await nativeTheme(page, 'light');
    await checkTheme(page, 'light', 'light');
    check(!await alert.isVisible(), 'Theme IPC queue recovers after rejection and clears the error');
    await page.close();
  }
  {
    const page = await open({ failTheme: true });
    await settings(page);
    await page.getByRole('alert').filter({ hasText: /theme/i }).waitFor();
    await checkTheme(page, 'auto', 'dark');
    check(await page.evaluate(() => window.__nativeThemes.length === 0), 'Startup theme failure leaves the app usable without reporting native success');
    await page.evaluate(() => { window.__failTheme = false; });
    await themeRadio(page, 'light').check();
    await nativeTheme(page, 'light');
    await page.getByRole('alert').filter({ hasText: /theme/i }).waitFor({ state: 'hidden' });
    await page.close();
  }
  {
    const page = await open({ scheme: 'dark', scenario: 'preview' });
    await settings(page);
    for (const preference of ['light', 'dark', 'auto']) {
      await themeRadio(page, preference).check();
      await checkTheme(page, preference, preference === 'auto' ? 'dark' : preference);
      await checkThemePalette(page, preference === 'auto' ? 'dark' : preference);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await checkTheme(page, 'auto', 'light');
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.__nativeCalls), [], 'Browser preview never invokes native IPC on startup, selection, or OS changes'); checks++;
    await page.close();
  }
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
  await checkThemePreferences();
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
    check(await page.getByRole('radio', { name: 'Narrow', exact: true }).isChecked(), 'Missing or invalid stored width defaults to Narrow');
    await page.getByRole('radio', { name: 'Wide', exact: true }).check();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--conversation-width') === '864px');
    check(await page.getByRole('radio', { name: 'Wide', exact: true }).isChecked(), 'Width remains usable in preview and with unavailable storage');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} appearance checks (${engine.name()}); Auto/Light/Dark, native IPC contract, persistence, accessibility, fallback, sidebar and corner geometry.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
