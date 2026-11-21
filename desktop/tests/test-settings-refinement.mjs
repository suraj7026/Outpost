import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { openSettings, settingsTestAssets } from '../settings-test-navigation.mjs';

// Current source, in-memory assets, synthetic IPC only; no dist or native mutations.
const engineName = process.env.OUTPOST_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engineName), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const storageKey = 'outpost.appearance.v1';
const defaults = { startupPage: 'home', theme: 'auto', conversationWidth: 'narrow', conversationDetail: 'compact', frosted: false, opacity: 45, sidebarCollapsed: false };
const groups = [
  { title: 'On startup', name: 'startup-page', key: 'startupPage', options: [['New task home page', 'home'], ['Last working page', 'last']] },
  { title: 'Theme', name: 'theme', key: 'theme', options: [['Auto', 'auto'], ['Light', 'light'], ['Dark', 'dark']] },
  { title: 'Conversation width', name: 'conversation-width', key: 'conversationWidth', options: [['Narrow', 'narrow'], ['Wide', 'wide'], ['Large', 'large']] },
  { title: 'Conversation detail', name: 'conversation-detail', key: 'conversationDetail', options: [['Compact', 'compact'], ['Extended', 'extended']] },
];
let checks = 0, scenarios = 0, browser;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const server = createServer(await settingsTestAssets());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const deadline = setTimeout(() => {
  console.error('Settings refinement exceeded its 180-second deadline');
  void browser?.close();
  server.closeAllConnections();
  server.close();
  process.exitCode = 1;
}, 180_000);
const groupFor = (page, title) => page.getByRole('group', { name: title, exact: true });
const toggle = (page, name) => page.getByRole('switch', { name, exact: true });
const preview = page => page.locator('.appearance-preview');

function installFixture({ origin, storageKey, defaults, options }) {
  if (location.origin !== origin) return;
  if (!sessionStorage.getItem('settings-refinement-seeded')) {
    localStorage.setItem(storageKey, JSON.stringify({ ...defaults, ...options.preferences }));
    sessionStorage.setItem('settings-refinement-seeded', 'true');
  }
  if (options.blockStorage) {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === storageKey) throw new DOMException('Synthetic storage failure', 'SecurityError');
      return setItem.call(this, key, value);
    };
  }
  // Exercise both capability paths independently of the host running Playwright.
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: options.unsupported ? 'Settings fixture (Linux)' : 'Settings fixture (Macintosh)' });
  const matchMedia = window.matchMedia.bind(window);
  window.__settingsReduced = false;
  const reducedMedia = [];
  window.matchMedia = query => {
    const media = matchMedia(query);
    if (query.includes('prefers-reduced-transparency')) {
      Object.defineProperty(media, 'matches', { get: () => window.__settingsReduced });
      reducedMedia.push(media);
    }
    return media;
  };
  window.__setSettingsReduced = value => {
    window.__settingsReduced = value;
    for (const media of reducedMedia) media.dispatchEvent(new Event('change'));
  };
  window.__settingsFailTheme = false;
  window.__settingsFailBlur = false;
  window.isTauri = true;
  const callbacks = new Map();
  let sequence = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      if (command === 'plugin:window|set_theme') {
        if (window.__settingsFailTheme) throw new Error('Synthetic theme failure');
        return;
      }
      if (command === 'set_window_blur') {
        if (window.__settingsFailBlur) throw new Error('Synthetic blur failure');
        return;
      }
      if (command === 'set_sidebar_window_controls' || command === 'disconnect') return;
      if (command === 'sidebar_pointer_inside') return false;
      if (command === 'setup_list' || command === 'setup_history_list') return [];
      if (command === 'automatic_updates_status' || command === 'automatic_updates_tick') return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
      if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: 'https://settings.invalid', pending: false } };
      if (command === 'connection_info') return { endpoint: 'https://settings.invalid', deviceId: 'settings-fixture', publicKey: '', pending: false, nativeSidebar: false, lifecycle: { state: 'connected', error: null } };
      if (command === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records: [] };
        if (args.kind === 'runtime') return { configured: true, piManagement: false, sharedMemory: false, model: 'fixture:cloud' };
        if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
        if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 1 };
      }
      if (command === 'stream_events') {
        callbacks.get(args.channel.id)?.({ index: 0, message: { type: 'snapshot', cursor: 1, records: [], live: [] } });
        return new Promise(() => {});
      }
      const message = `Unexpected IPC: ${command} ${args.kind ?? ''}`;
      await window.__settingsViolation(message);
      throw new Error(message);
    },
  };
}

async function ready(page, route) {
  await page.getByRole('heading', { level: 1, name: route === '#settings' ? 'Settings' : 'Appearance', exact: true }).waitFor();
  await page.locator('.appearance-settings > .appearance-controls.ui-stack').waitFor();
  await page.waitForFunction(() => document.fonts.status === 'loaded');
}

async function scenario(name, options, test) {
  console.log(`  ${name}`);
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, colorScheme: options.scheme ?? 'dark', reducedMotion: options.motion ?? 'no-preference', serviceWorkers: 'block' });
  const errors = [], violations = [];
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      violations.push(`Blocked network: ${request.method()} ${request.url()}`);
      return route.abort();
    });
    await context.routeWebSocket('**/*', socket => {
      violations.push(`Blocked WebSocket: ${socket.url()}`);
      socket.close();
    });
    await page.exposeFunction('__settingsViolation', message => violations.push(message));
    await page.addInitScript(installFixture, { origin, storageKey, defaults, options });
    const route = options.route ?? '#settings';
    if (route === '#settings') {
      await page.goto(origin);
      await openSettings(page, { page: 'home' });
    } else await page.goto(`${origin}/${route}`);
    await ready(page, route);
    equal(new URL(page.url()).hash, route, 'Settings route is preserved');
    await test(page);
    equal(violations, [], 'No external network or unexpected IPC');
    equal(errors, [], 'No browser, console, or asset errors');
    scenarios++;
  } catch (error) {
    error.message = `${name}: ${error.message}\n${[...violations, ...errors].join('\n')}`;
    throw error;
  } finally { await context.close(); }
}

async function saved(page, expected) {
  await page.waitForFunction(({ storageKey, expected }) => {
    const actual = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return Object.entries(expected).every(([key, value]) => actual[key] === value);
  }, { storageKey, expected });
  const actual = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  for (const [key, value] of Object.entries(expected)) equal(actual[key], value, `${key} persists`);
}

async function semantics(page, route) {
  const sections = page.locator('.appearance-controls > .ui-section');
  equal(await sections.locator('.ui-section-heading h2').allTextContents(), ['Startup', 'Theme', 'Conversation', 'Window'], 'Four ordered shared sections');
  equal(await sections.count(), 4, 'Exactly four sections');
  equal(await page.locator('.settings-workspace .settings-link-list').count(), 0, 'Settings is not the old navigation menu');
  if (route === '#settings') equal(await page.locator('.page-heading .settings-header-icon svg').count(), 1, 'Root header has an icon');
  for (const group of groups) {
    const fieldset = groupFor(page, group.title);
    equal(await fieldset.count(), 1, `${group.title} has one accessible group`);
    check(await fieldset.evaluate(node => node.matches('fieldset.appearance-width') && node.querySelector(':scope > legend')?.classList.contains('sr-only')), `${group.title} uses a native fieldset and visually hidden legend`);
    equal(await fieldset.getByRole('radio').count(), group.options.length, `${group.title} option count`);
    for (const [label, value] of group.options) {
      const radio = fieldset.getByRole('radio', { name: label, exact: true });
      check(await radio.evaluate((node, expected) => node.tagName === 'INPUT' && node.type === 'radio' && node.name === expected.name && node.value === expected.value, { name: group.name, value }), `${label} preserves its native radio contract`);
    }
  }
  const rows = await page.locator('.appearance-controls .ui-row').evaluateAll(nodes => nodes.map(node => ({ icon: !!node.querySelector('svg'), actions: !!node.querySelector('.ui-row-actions'), text: node.textContent.trim() })));
  check(rows.length >= 7 && rows.every(row => row.icon && row.actions && row.text), 'All setting rows have an icon, text, and trailing actions');
  for (const name of ['Frosted glass', 'Collapse sidebar']) {
    const control = toggle(page, name);
    check(await control.evaluate(node => node.type === 'checkbox' && !!node.closest('label.ui-row.appearance-toggle')), `${name} is a native switch inside a whole-row label`);
    const box = await control.boundingBox();
    check(box && Math.abs(box.width - 44) < .5 && Math.abs(box.height - 28) < .5, `${name} stays 44×28`);
  }
  const range = page.getByRole('slider', { name: /Glass opacity/i });
  equal(await range.getAttribute('id'), 'glass-opacity', 'Slider has an accessible label');
  equal(await range.getAttribute('min'), '0', 'Slider minimum');
  equal(await range.getAttribute('max'), '100', 'Slider maximum');
  equal(await page.locator('output[for="glass-opacity"]').count(), 1, 'Output is associated with the slider');
  equal(await preview(page).getAttribute('aria-hidden'), 'true', 'Decorative preview stays out of the accessibility tree');
  equal(await preview(page).locator('.appearance-preview-sidebar').count(), 1, 'Preview has sidebar');
  equal(await preview(page).locator('.appearance-preview-main').count(), 1, 'Preview has main pane');
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => {
    const selectors = 'html, body, .settings-page, .appearance-settings, .appearance-controls, .appearance-controls .ui-section, .appearance-controls .ui-row, .appearance-controls .ui-row-actions, .appearance-width, .appearance-preview';
    return [...document.querySelectorAll(selectors)].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && (node.scrollWidth > node.clientWidth + 1 || box.left < -1 || box.right > innerWidth + 1);
    }).map(node => ({ className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth }));
  });
  equal(overflow, [], 'Settings and every grouped control fit the viewport without horizontal overflow');
}

async function previewState(page, frost, collapsed) {
  await page.waitForFunction(({ frost, collapsed }) => {
    const node = document.querySelector('.appearance-preview');
    return node?.dataset.frost === frost && node.dataset.collapsed === String(collapsed);
  }, { frost, collapsed });
  equal(await preview(page).getAttribute('data-frost'), frost, 'Preview reflects frost');
  equal(await preview(page).getAttribute('data-collapsed'), String(collapsed), 'Preview reflects sidebar preference');
}

const previewPaint = page => preview(page).evaluate(node => JSON.stringify([node, ...node.querySelectorAll('*')].map(element => {
  const style = getComputedStyle(element);
  return [style.backgroundColor, style.backgroundImage, style.opacity, style.backdropFilter, style.webkitBackdropFilter];
})));
const previewLayout = page => preview(page).evaluate(node => ['.appearance-preview-sidebar', '.appearance-preview-main'].map(selector => {
  const element = node.querySelector(selector), box = element.getBoundingClientRect(), parent = node.getBoundingClientRect();
  return { left: box.left - parent.left, width: box.width, transform: getComputedStyle(element).transform };
}));

async function exercise(page, route, scheme) {
  await semantics(page, route);
  await noOverflow(page);
  equal(await page.locator('html').getAttribute('data-theme'), scheme, 'Auto resolves to the system scheme');
  check(await page.locator('#glass-opacity').isDisabled(), 'Opacity starts disabled with frost off');
  await previewState(page, 'off', false);
  for (const group of groups) {
    for (const [label, value] of group.options) {
      const radio = groupFor(page, group.title).getByRole('radio', { name: label, exact: true });
      await radio.check();
      check(await radio.isChecked(), `${label} is usable`);
      await saved(page, { [group.key]: value });
      await noOverflow(page);
    }
    const first = groupFor(page, group.title).getByRole('radio').first();
    await first.focus();
    await page.keyboard.press('ArrowRight');
    check(await groupFor(page, group.title).getByRole('radio').nth(1).isChecked(), `${group.title} supports native arrow-key selection`);
  }
  await groupFor(page, 'Theme').getByRole('radio', { name: 'Auto', exact: true }).check();
  await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, scheme === 'dark' ? 'light' : 'dark');
  await groupFor(page, 'Theme').getByRole('radio', { name: 'Dark', exact: true }).check();

  // Click label text, not just the checkbox, to cover the complete switch row.
  await page.locator('label.ui-row.appearance-toggle').filter({ has: toggle(page, 'Frosted glass') }).getByText('Frosted glass', { exact: true }).click();
  check(await toggle(page, 'Frosted glass').isChecked(), 'Frost label toggles switch');
  check(await page.locator('#glass-opacity').isEnabled(), 'Opacity is enabled with supported frost');
  await previewState(page, 'on', false);
  const range = page.locator('#glass-opacity');
  await range.focus();
  await page.keyboard.press('Home');
  equal(await range.inputValue(), '0', 'Slider keyboard reaches clear endpoint');
  await page.waitForFunction(() => document.querySelector('output[for="glass-opacity"]')?.textContent === '0%');
  const clearPaint = await previewPaint(page);
  await page.keyboard.press('End');
  equal(await range.inputValue(), '100', 'Slider keyboard reaches solid endpoint');
  await page.waitForFunction(() => document.querySelector('output[for="glass-opacity"]')?.textContent === '100%');
  check(await previewPaint(page) !== clearPaint, 'Opacity changes the rendered preview, not only its output text');
  await range.fill('64');
  await saved(page, { opacity: 64 });
  equal(await page.locator('output[for="glass-opacity"]').textContent(), '64%', 'Output reflects intermediate opacity');
  await previewState(page, 'on', false);

  const expanded = await previewLayout(page);
  await page.locator('label.ui-row.appearance-toggle').filter({ has: toggle(page, 'Collapse sidebar') }).getByText('Collapse sidebar', { exact: true }).click();
  check(await toggle(page, 'Collapse sidebar').isChecked(), 'Collapse label toggles switch');
  await previewState(page, 'on', true);
  await page.waitForFunction(before => {
    const parent = document.querySelector('.appearance-preview').getBoundingClientRect();
    return ['.appearance-preview-sidebar', '.appearance-preview-main'].every((selector, index) => {
      const element = document.querySelector(selector), box = element.getBoundingClientRect();
      return Math.abs(box.left - parent.left - before[index].left) > 1 || Math.abs(box.width - before[index].width) > 1 || getComputedStyle(element).transform !== before[index].transform;
    });
  }, expanded);
  check(true, 'Both preview sidebar and main pane move when collapsed');
  await noOverflow(page);
  const expected = { startupPage: 'last', theme: 'dark', conversationWidth: 'wide', conversationDetail: 'extended', frosted: true, opacity: 64, sidebarCollapsed: true };
  await saved(page, expected);
  await page.reload();
  await ready(page, route);
  await saved(page, expected);
  for (const group of groups) check(await groupFor(page, group.title).locator(`input[value="${expected[group.key]}"]`).isChecked(), `${group.title} restores after reload`);
  check(await toggle(page, 'Frosted glass').isChecked() && await toggle(page, 'Collapse sidebar').isChecked(), 'Both switches restore after reload');
  equal(await range.inputValue(), '64', 'Opacity restores after reload');
  await previewState(page, 'on', true);
  await toggle(page, 'Frosted glass').focus();
  await page.keyboard.press('Space');
  check(!await toggle(page, 'Frosted glass').isChecked() && await range.isDisabled(), 'Keyboard switch turns frost off and disables opacity');
  await previewState(page, 'off', true);
  await noOverflow(page);
}

try {
  browser = await ({ chromium, webkit })[engineName].launch();
  for (const width of [1440, 390]) await scenario(`hidden scrollbar preserves scrolling at ${width}px`, { width }, async page => {
    await page.setViewportSize({ width, height: 600 });
    const settings = page.locator('.page.settings-workspace');
    const style = await settings.evaluate(node => ({
      scrollbar: getComputedStyle(node).scrollbarWidth,
      webkit: getComputedStyle(node, '::-webkit-scrollbar').display,
      overflow: getComputedStyle(node).overflowY,
      scrollable: node.scrollHeight > node.clientHeight,
    }));
    equal(style.scrollbar, 'none', 'Settings scrollbar is visually hidden');
    equal(style.webkit, 'none', 'WebKit scrollbar is visually hidden');
    check(['auto', 'scroll'].includes(style.overflow) && style.scrollable, 'Settings still has a scrollable viewport');
    await settings.evaluate(node => node.scrollTo(0, 0));
    const bounds = await settings.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.querySelector('.settings-workspace').scrollTop > 0);
    checks++;
    await settings.evaluate(node => node.scrollTo(0, 0));
    await settings.getByRole('heading', { level: 1 }).focus();
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('.settings-workspace').scrollTop > 0);
    checks++;
    equal(await page.evaluate(() => window.scrollY), 0, 'Only Settings scrolls, not the window');
  });
  for (const width of [1440, 390]) for (const scheme of ['dark', 'light']) for (const route of ['#settings', '#settings/appearance']) {
    await scenario(`${width}px ${scheme} ${route}`, { width, scheme, route }, page => exercise(page, route, scheme));
  }
  await scenario('unsupported native effects', { unsupported: true, preferences: { frosted: true } }, async page => {
    check(await toggle(page, 'Frosted glass').isDisabled(), 'Unsupported frost switch is disabled');
    check(await page.locator('#glass-opacity').isDisabled(), 'Unsupported opacity is disabled');
    await page.getByText('Available in the macOS desktop app.', { exact: true }).waitFor();
    await previewState(page, 'off', false);
    await groupFor(page, 'Conversation width').getByRole('radio', { name: 'Large', exact: true }).check();
    await saved(page, { conversationWidth: 'large' });
  });
  await scenario('reduced transparency', { preferences: { frosted: true } }, async page => {
    await previewState(page, 'on', false);
    await page.evaluate(() => window.__setSettingsReduced(true));
    await page.waitForFunction(() => document.querySelector('#glass-opacity').disabled && document.documentElement.dataset.glass === 'false');
    await previewState(page, 'off', false);
    check(await toggle(page, 'Frosted glass').isChecked(), 'Accessibility override preserves frost preference');
    await page.getByText('Using a solid background to respect reduced transparency or increased contrast.', { exact: true }).waitFor();
    await page.evaluate(() => window.__setSettingsReduced(false));
    await previewState(page, 'on', false);
    check(await page.locator('#glass-opacity').isEnabled(), 'Opacity returns after accessibility override clears');
  });
  await scenario('reduced motion at 390px', { width: 390, motion: 'reduce' }, async page => {
    const durations = await preview(page).evaluate(node => [node, ...node.querySelectorAll('*')].flatMap(element => {
      const style = getComputedStyle(element);
      return [style.transitionDuration, style.animationDuration].flatMap(value => value.split(',').map(parseFloat));
    }));
    check(durations.every(duration => duration <= .01), 'Reduced motion removes preview animation durations');
    await toggle(page, 'Collapse sidebar').check();
    await previewState(page, 'off', true);
    await toggle(page, 'Collapse sidebar').uncheck();
    await previewState(page, 'off', false);
    await noOverflow(page);
  });
  await scenario('storage failure', { blockStorage: true }, async page => {
    await page.getByRole('alert').filter({ hasText: 'could not be saved' }).waitFor();
    await groupFor(page, 'Conversation width').getByRole('radio', { name: 'Large', exact: true }).check();
    check(await groupFor(page, 'Conversation width').getByRole('radio', { name: 'Large', exact: true }).isChecked(), 'Storage failure does not block controls');
    await page.waitForFunction(() => document.documentElement.dataset.conversationWidth === 'large');
    await noOverflow(page);
  });
  await scenario('native failures and recovery', {}, async page => {
    await page.evaluate(() => { window.__settingsFailTheme = true; });
    await groupFor(page, 'Theme').getByRole('radio', { name: 'Light', exact: true }).check();
    const themeError = page.getByRole('alert').filter({ hasText: 'window theme could not be applied' });
    await themeError.waitFor();
    await page.evaluate(() => { window.__settingsFailTheme = false; });
    await groupFor(page, 'Theme').getByRole('radio', { name: 'Dark', exact: true }).check();
    await themeError.waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.__settingsFailBlur = true; });
    await toggle(page, 'Frosted glass').check();
    const blurError = page.getByRole('alert').filter({ hasText: 'Frosted glass could not be applied' });
    await blurError.waitFor();
    equal(await page.locator('html').getAttribute('data-glass'), 'false', 'Native failure keeps the actual window solid');
    await page.evaluate(() => { window.__settingsFailBlur = false; });
    await toggle(page, 'Frosted glass').uncheck();
    await toggle(page, 'Frosted glass').check();
    await blurError.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'true');
    await previewState(page, 'on', false);
  });
  console.log(`PASS: ${checks} settings refinement checks in ${scenarios} scenarios (${engineName})`);
} finally {
  clearTimeout(deadline);
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
