import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';
import { openSettings } from './settings-test-navigation.mjs';

// Run from the repository root against an already-built desktop/dist. Never builds,
// invokes real Tauri, dispatches server actions, or permits off-origin requests.
const root = resolve('desktop/dist');
assert.ok(existsSync(resolve(root, 'index.html')), 'Build desktop/dist before running this test');
const browserName = process.env.OUTPOST_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const engine = browserName === 'webkit' ? webkit : chromium;
const tab = engine === webkit ? 'Alt+Tab' : 'Tab';
const backTab = engine === webkit ? 'Alt+Shift+Tab' : 'Shift+Tab';
const out = '/tmp/outpost-focus-treatment';
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const server = createServer((request, response) => {
  const path = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (request.method !== 'GET' || !path.startsWith(root + '/') || !existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
  response.setHeader('content-type', types[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const row = (kind, id, data) => ({ kind, id, data, revision: 1, updatedAt: '2026-11-15T00:00:00Z' });
const fixture = {
  snapshot: { cursor: 1, protocolVersion: 1, records: [
    row('task', 'focus-fixture', { goal: 'Review keyboard focus', profile: 'code', state: 'paused' }),
    row('policy', 'focus-fixture', { mode: 'ask_permission' }),
    row('message', 'assistant', { taskId: 'focus-fixture', author: 'assistant', text: '## Synthetic focus review\nKeyboard focus stays visible without outlining the composer. No live server or private data is used.' }),
  ] },
  runtime: { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1, configured: true, model: 'fixture:cloud', piManagement: true, hostAdministration: false, browserDirect: false, unrestrictedCommands: false },
  models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' },
  catalogue: {
    protocolVersion: 1, piVersion: '1.4.0', profilePath: '/synthetic/.pi/agent', generation: 'a'.repeat(64),
    providers: [{ id: 'fixture', name: 'Synthetic provider', configured: true, storedMethod: null, methods: [] }],
    models: ['alpha', 'beta'].map(modelId => ({ providerId: 'fixture', modelId, name: `Synthetic ${modelId}`, reasoning: false })),
    defaultModel: { providerId: 'fixture', modelId: 'alpha' },
    refreshedAt: null, refreshErrors: [], capabilities: { providerPackages: false, callbackRelay: false },
  },
};
let checks = 0;
const failures = [], screenshots = [], errors = [], external = [], a11yNotes = [];
function check(value, message, detail) {
  checks++;
  if (!value) failures.push({ message, ...(detail === undefined ? {} : { detail }) });
}
function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), message, { expected, actual });
}
const delta = (a, b) => Math.max(...a.slice(0, 3).map((value, index) => Math.abs(value - b[index])));
const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

// Canvas normalizes rgb(), color(srgb ...), and color-mix() consistently across engines.
// Composite transparent fills over their ancestors instead of comparing CSS strings.
async function inspect(locator) {
  return locator.evaluate(node => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (front, back) => [...front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])), 1];
    const background = element => {
      if (!element) return [255, 255, 255, 1];
      const own = rgba(getComputedStyle(element).backgroundColor);
      return own[3] === 1 ? own : over(own, background(element.parentElement));
    };
    const edge = (element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return {
        border: ['Top', 'Right', 'Bottom', 'Left'].map(side => [style[`border${side}Width`], style[`border${side}Style`], rgba(style[`border${side}Color`])]),
        outline: [style.outlineStyle, style.outlineWidth], shadow: style.boxShadow,
      };
    };
    const style = getComputedStyle(node), bounds = node.getBoundingClientRect(), effective = background(node);
    const ancestors = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push({ tag: parent.tagName, class: parent.className, ...edge(parent) });
    const pseudo = ['::before', '::after'].map(name => ({ name, content: getComputedStyle(node, name).content, ...edge(node, name) })).filter(value => !['none', 'normal'].includes(value.content));
    return {
      active: document.activeElement === node, visible: node.matches(':focus-visible'),
      painted: bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth && style.visibility === 'visible' && Number(style.opacity) > 0,
      background: rgba(style.backgroundColor), controlBackground: rgba(getComputedStyle(node.closest('.composer-select-field, .anchor-menu-search') ?? node).backgroundColor), effective, foreground: over(rgba(style.color), effective), backgroundImage: style.backgroundImage,
      ...edge(node), ancestors, pseudo,
    };
  });
}
function noOutline(state, label) {
  check(state.outline[0] === 'none' || parseFloat(state.outline[1]) === 0, `${label}: no outline`, state.outline);
}
function stableEdges(before, after, label, ancestors = true) {
  noOutline(after, label);
  equal(after.border, before.border, `${label}: border widths, styles and colors stay unchanged`);
  equal(after.shadow, before.shadow, `${label}: no added box-shadow focus ring`);
  equal(after.pseudo, before.pseudo, `${label}: no pseudo-element border/ring added`);
  if (ancestors) {
    equal(after.ancestors.map(({ border, shadow }) => ({ border, shadow })), before.ancestors.map(({ border, shadow }) => ({ border, shadow })), `${label}: wrapper borders and shadows stay unchanged`);
    for (const ancestor of after.ancestors) noOutline(ancestor, `${label}: ${ancestor.tag}.${ancestor.class || '(unclassed)'}`);
  }
}
function filled(before, after, label, minimumContrast = 4.5) {
  check(JSON.stringify(before.controlBackground ?? before.background) !== JSON.stringify(after.controlBackground ?? after.background), `${label}: the interactive control surface changes fill`, { before: before.controlBackground ?? before.background, after: after.controlBackground ?? after.background });
  check(delta(before.effective, after.effective) >= 4, `${label}: visibly different fill (at least 4/255 in one channel)`, { before: before.effective, after: after.effective });
  check(contrast(after.foreground, after.effective) >= minimumContrast, `${label}: focused foreground contrast >= ${minimumContrast}:1`, { ratio: contrast(after.foreground, after.effective), foreground: after.foreground, background: after.effective });
}
function keyboardState(state, label) {
  check(state.active && state.visible && state.painted, `${label}: real, visible keyboard focus`, { active: state.active, focusVisible: state.visible, painted: state.painted });
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function rest(page) {
  // Navigation can schedule autofocus for the next frame; let it finish before blurring.
  await settle(page);
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(page.viewportSize().width - 2, page.viewportSize().height - 2);
  await settle(page);
}
async function keyboardFocus(page, target, label, reverseEntry = false) {
  // Programmatic focus is only an anchor; the measured focus must be reached by
  // sequential keyboard navigation. Reverse entry avoids the sidebar-reveal
  // sentinel immediately before the first main control on narrow windows.
  await target.focus();
  await page.keyboard.press(reverseEntry ? tab : backTab);
  check(!await target.evaluate(node => node === document.activeElement), `${label}: ${reverseEntry ? 'Tab' : 'reverse Tab'} leaves the control`);
  await page.keyboard.press(reverseEntry ? backTab : tab);
  await settle(page);
  const state = await inspect(target);
  keyboardState(state, label);
  return state;
}
async function nextFocus(page, target, label) {
  await page.keyboard.press(tab); await settle(page);
  const state = await inspect(target);
  keyboardState(state, `${label}: next in Tab order`);
  return state;
}
async function control(page, target, label, minimumContrast = 4.5, reverseEntry = false) {
  await rest(page);
  const before = await inspect(target);
  const after = await keyboardFocus(page, target, label, reverseEntry);
  stableEdges(before, after, label);
  filled(before, after, label, minimumContrast);
  return after;
}
async function screenshot(page, label, name) {
  const path = `${out}/${browserName}-${label}-${name}.png`;
  await page.screenshot({ path }); screenshots.push(path);
}
async function open(browser, width, colorScheme, label, forcedColors = 'none') {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, forcedColors, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin === address && request.method() === 'GET') return route.continue();
    external.push({ label, url: request.url(), method: request.method() });
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { external.push({ label, url: socket.url(), type: 'websocket' }); socket.close(); });
  context.on('page', page => page.on('pageerror', error => errors.push({ label, message: error.message })));
  await context.addInitScript(fixture => {
    window.isTauri = true;
    window.__unexpectedIPC = [];
    let sequence = 0, pointerX = -1, pointerY = -1;
    document.addEventListener('pointermove', event => { pointerX = event.clientX; pointerY = event.clientY; });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (['disconnect', 'set_sidebar_window_controls', 'update_sidebar', 'plugin:event|listen', 'plugin:event|unlisten'].includes(command)) return 1;
        if (command === 'sidebar_pointer_inside') return pointerX >= 0 && pointerX <= args.width && pointerY >= 0 && pointerY <= innerHeight;
        if (command === 'connection_info') return { endpoint: 'https://focus-fixture.invalid:8443', deviceId: 'synthetic', publicKey: '', pending: false, nativeSidebar: false };
        if (command === 'stream_events') return new Promise(() => {});
        if (command === 'query') {
          if (['snapshot', 'runtime', 'models'].includes(args.kind)) return structuredClone(fixture[args.kind]);
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 1 };
        }
        if (command === 'agent_request' && args.payload?.type === 'catalogue') return structuredClone(fixture.catalogue);
        const request = { command, kind: args?.kind, type: args?.payload?.type };
        window.__unexpectedIPC.push(request);
        throw new Error(`Unexpected IPC in focus fixture: ${JSON.stringify(request)}`);
      },
    };
  }, fixture);
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.goto(address);
  await openInitialTestChat(page);
  await page.getByRole('textbox', { name: 'Message Outpost', exact: true }).waitFor();
  await page.locator('.model-picker-trigger:not(:disabled)').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}
async function composer(page, selector, name, label, shot) {
  const target = page.getByRole('textbox', { name, exact: true });
  const wrapper = page.locator(selector);
  await rest(page);
  const before = await inspect(target), outerBefore = await inspect(wrapper);
  check(!before.active && !before.visible, `${label}: composer baseline is genuinely unfocused`);
  check(outerBefore.border.some(([width]) => parseFloat(width) > 0), `${label}: structural composer border is retained`);
  await screenshot(page, shot, `${selector.slice(1)}-rest`);
  for (const mode of ['pointer', 'keyboard']) {
    if (mode === 'pointer') { await target.click(); await settle(page); }
    else { await rest(page); await keyboardFocus(page, target, label); }
    const after = await inspect(target), outerAfter = await inspect(wrapper);
    check(after.active, `${label}/${mode}: textarea really owns focus`);
    stableEdges(before, after, `${label}/${mode}/textarea`);
    stableEdges(outerBefore, outerAfter, `${label}/${mode}/composer`);
    check(after.background[3] === 0 && after.backgroundImage === 'none' && after.shadow === 'none' && after.border.every(([width]) => parseFloat(width) === 0), `${label}/${mode}: transparent textarea without an inner box`, after);
    if (mode === 'keyboard') {
      keyboardState(after, label);
      filled(outerBefore, outerAfter, `${label}: whole composer focus`);
      check(contrast(after.foreground, after.effective) >= 4.5, `${label}: textarea text contrast >= 4.5:1`);
    }
    await screenshot(page, shot, `${selector.slice(1)}-${mode}`);
  }
}
async function picker(page, label) {
  const trigger = page.locator('.model-picker-trigger');
  await control(page, trigger, `${label}/model trigger`);
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Model', exact: true });
  await menu.waitFor();
  check(await menu.evaluate(node => node.contains(document.activeElement)), `${label}: opening model menu moves focus inside`);
  const search = menu.getByRole('searchbox', { name: 'Search models', exact: true });
  await search.fill('Synthetic');
  await control(page, search, `${label}/model search`);
  const models = menu.locator('.anchor-menu-row');
  equal(await models.count(), 2, `${label}: both synthetic model results are present`);
  const firstBefore = await inspect(models.nth(0)), secondBefore = await inspect(models.nth(1));
  const first = await nextFocus(page, models.nth(0), `${label}/selected model`);
  stableEdges(firstBefore, first, `${label}/selected model`); filled(firstBefore, first, `${label}/selected model`);
  const firstDetail = await inspect(models.nth(0).locator('small'));
  check(contrast(firstDetail.foreground, firstDetail.effective) >= 4.5, `${label}/selected model: secondary text contrast >= 4.5:1`, { ratio: contrast(firstDetail.foreground, firstDetail.effective) });
  const second = await nextFocus(page, models.nth(1), `${label}/next model`);
  stableEdges(secondBefore, second, `${label}/next model`); filled(secondBefore, second, `${label}/next model`);
  const secondDetail = await inspect(models.nth(1).locator('small'));
  check(contrast(secondDetail.foreground, secondDetail.effective) >= 4.5, `${label}/next model: secondary text contrast >= 4.5:1`, { ratio: contrast(secondDetail.foreground, secondDetail.effective) });
  await screenshot(page, label, 'model-dialog-keyboard');
  await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'hidden' });
  keyboardState(await inspect(trigger), `${label}: selecting a model returns keyboard focus to trigger`);
  check((await trigger.textContent()).includes('beta'), `${label}: keyboard selection changes the local model`);
  await page.keyboard.press('Enter'); await menu.waitFor();
  await rest(page);
  const selected = await inspect(models.nth(1));
  equal(selected.border, secondBefore.border, `${label}: selecting model does not add a border`);
  filled(secondBefore, selected, `${label}: selected model uses fill`);
  await search.focus(); await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  keyboardState(await inspect(trigger), `${label}: Escape restores keyboard focus`);
}
async function settings(page, label) {
  await openSettings(page, { page: 'servers' });
  const addServer = page.getByRole('link', { name: 'Add server', exact: true });
  const manageServer = page.locator('.server-settings-list a[data-server-id="legacy"]');
  await manageServer.waitFor();
  await control(page, addServer, `${label}/add server link`, 4.5, true);
  const before = await inspect(manageServer);
  const after = await nextFocus(page, manageServer, `${label}/manage server link`);
  stableEdges(before, after, `${label}/manage server link`); filled(before, after, `${label}/manage server link`);
  await screenshot(page, label, 'machine-link-keyboard');
  await openSettings(page, { page: 'home' });
  const toggle = page.getByRole('switch', { name: 'Collapse sidebar', exact: true });
  await toggle.waitFor(); await rest(page);
  check(!await toggle.isChecked(), `${label}: sidebar switch starts off`);
  const off = await inspect(toggle);
  await toggle.click(); await rest(page);
  check(await toggle.isChecked(), `${label}: sidebar switch retains real checked state`);
  const on = await inspect(toggle);
  check(delta(off.effective, on.effective) >= 4 && on.background[3] > .9, `${label}: switch retains filled-on treatment`, { off: off.background, on: on.background });
  const focused = await keyboardFocus(page, toggle, `${label}/checked switch`);
  stableEdges(on, focused, `${label}/checked switch`);
  check(delta(off.effective, focused.effective) >= 4 && focused.background[3] > .9, `${label}: focus does not erase the switch's filled-on state`);
}

// Component-shaped CSS fixtures exercise rare viewer/enrollment states without
// claiming browser takeover, image decoding/zoom behavior, or enrollment coverage.
async function mountCssFixtures(page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = '#34373c'; context.fillRect(0, 0, 480, 180);
    context.fillStyle = '#f0f0f2'; context.font = '18px sans-serif'; context.fillText('Synthetic CSS viewport — no live image', 20, 90);
    const image = canvas.toDataURL();
    const dialog = document.createElement('dialog'); dialog.dataset.focusCssFixtures = '';
    dialog.setAttribute('aria-label', 'Focus CSS fixtures — not functional UI');
    dialog.style.cssText = 'width:calc(100vw - 24px);max-width:900px;max-height:calc(100dvh - 24px);overflow:auto;padding:20px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:16px';
    dialog.innerHTML = `
      <h2>CSS fixtures — not functional UI</h2>
      <p>Production styles; synthetic viewer, primary action and enrollment markup only.</p>
      <section class="settings-workspace">
        <fieldset class="enrollment-choices"><legend>CSS fixture: enrollment cards</legend>
          <label><input type="radio" name="focus-enrollment" value="adopt" checked><span>Existing enrollment<small>Synthetic selection only</small></span></label>
          <label><input type="radio" name="focus-enrollment" value="pair"><span>New enrollment<small>No pairing action is implemented</small></span></label>
        </fieldset>
      </section>
      <section class="server-setup-dialog" style="width:100%;max-height:none;margin:16px 0">
        <button type="button" class="primary" data-fixture-primary>CSS fixture primary action</button>
        <p class="setup-error" role="alert">Synthetic error styling must remain intact.</p>
      </section>
      <section class="browser-viewer" aria-label="CSS fixture browser viewer">
        <div class="browser-heading-row"><button type="button" class="browser-viewer-heading"><span>CSS fixture: browser viewport</span></button></div>
        <div class="browser-viewer-body">
          <div class="browser-toolbar"><p class="browser-mode"><strong>CSS fixture toolbar</strong><span>No server input is sent</span></p></div>
          <div class="browser-workspace"><div class="browser-viewer-main"><div class="browser-frame">
            <button type="button" class="browser-page-input" aria-label="CSS fixture browser viewport"><img src="${image}" alt="Synthetic CSS viewport"></button>
          </div></div></div>
        </div>
      </section>
      <section class="image-viewer" aria-label="CSS fixture image viewer" style="width:100%;height:340px;margin-top:16px">
        <div class="image-viewer-content">
          <header class="image-viewer-header"><div class="image-viewer-title"><h2>CSS fixture: image viewport</h2></div><button type="button">Fixture image action</button></header>
          <div class="image-stage" tabindex="0" aria-label="CSS fixture image viewport"><div class="image-canvas"><img src="${image}" width="240" height="90" alt="Synthetic CSS image"></div></div>
          <footer class="image-viewer-toolbar"><div class="image-zoom-controls"><button type="button" aria-pressed="false" data-fixture-fit>Fit</button><output>CSS only</output></div></footer>
        </div>
      </section>`;
    dialog.querySelector('[data-fixture-fit]').addEventListener('click', event => event.currentTarget.setAttribute('aria-pressed', 'true'));
    document.body.append(dialog); dialog.showModal();
  });
  return page.locator('[data-focus-css-fixtures]');
}
async function cssFixtures(page, label) {
  const root = await mountCssFixtures(page);
  const radios = root.locator('.enrollment-choices input'), cards = root.locator('.enrollment-choices label');
  await rest(page);
  const cardBefore = await inspect(cards.nth(1)), radioBefore = await inspect(radios.nth(1));
  check(cardBefore.border.some(([width]) => parseFloat(width) > 0), `${label}/CSS enrollment: structural card border retained`);
  await radios.nth(1).click(); await rest(page);
  check(await radios.nth(1).isChecked() && !await radios.nth(0).isChecked(), `${label}/CSS enrollment: native radio exclusivity`);
  const cardSelected = await inspect(cards.nth(1));
  stableEdges(cardBefore, cardSelected, `${label}/CSS selected enrollment card`);
  filled(cardBefore, cardSelected, `${label}/CSS selected enrollment card`);
  const radioFocused = await keyboardFocus(page, radios.nth(1), `${label}/CSS checked radio`);
  stableEdges(radioBefore, radioFocused, `${label}/CSS checked radio`, false);
  await page.keyboard.press('ArrowLeft'); await settle(page);
  check(await radios.nth(0).isChecked() && !await radios.nth(1).isChecked(), `${label}/CSS radio: ArrowLeft changes checked state`);
  const arrowFocused = await inspect(radios.nth(0));
  check(arrowFocused.active && arrowFocused.painted, `${label}/CSS radio: ArrowLeft moves real keyboard focus`);
  if (!arrowFocused.visible) a11yNotes.push(`${label}: native radio ArrowLeft moves focus without :focus-visible in ${browserName}; selected-card fill remains the cue. Tab-entry focus is checked separately.`);
  await keyboardFocus(page, radios.nth(0), `${label}/CSS arrow-selected radio Tab re-entry`);
  const cardKeyboard = await inspect(cards.nth(0));
  equal(cardKeyboard.border, cardBefore.border, `${label}/CSS keyboard-selected radio card: normal structural border`);
  noOutline(cardKeyboard, `${label}/CSS keyboard-selected radio card`);
  await screenshot(page, label, 'css-enrollment-keyboard');
  const error = root.locator('.setup-error');
  const errorBefore = await error.evaluate(node => ({ color: getComputedStyle(node).color, border: getComputedStyle(node).border, background: getComputedStyle(node).backgroundColor }));
  await control(page, root.locator('[data-fixture-primary]'), `${label}/CSS primary text button`);
  equal(await error.evaluate(node => ({ color: getComputedStyle(node).color, border: getComputedStyle(node).border, background: getComputedStyle(node).backgroundColor })), errorBefore, `${label}/CSS primary focus preserves adjacent error styling`);
  await screenshot(page, label, 'css-primary-keyboard');
  for (const [kind, viewportSelector, feedbackSelectors] of [
    ['browser', '.browser-page-input', ['.browser-heading-row', '.browser-toolbar']],
    ['image', '.image-stage', ['.image-viewer-header', '.image-viewer-toolbar']],
  ]) {
    const target = root.locator(viewportSelector);
    await target.scrollIntoViewIfNeeded(); await rest(page);
    const before = await inspect(target), feedbackBefore = await Promise.all(feedbackSelectors.map(selector => inspect(root.locator(selector))));
    const after = await keyboardFocus(page, target, `${label}/CSS ${kind} viewport`);
    stableEdges(before, after, `${label}/CSS ${kind} viewport`);
    equal(after.background, before.background, `${label}/CSS ${kind} viewport: image area is not tinted by focus`);
    const feedbackAfter = await Promise.all(feedbackSelectors.map(selector => inspect(root.locator(selector))));
    feedbackAfter.forEach((state, index) => stableEdges(feedbackBefore[index], state, `${label}/CSS ${kind} feedback ${feedbackSelectors[index]}`, false));
    check(feedbackAfter.some((state, index) => JSON.stringify(state.background) !== JSON.stringify(feedbackBefore[index].background) && delta(state.effective, feedbackBefore[index].effective) >= 4), `${label}/CSS ${kind} viewport: visible non-border header/toolbar fill`, { before: feedbackBefore.map(state => state.effective), after: feedbackAfter.map(state => state.effective) });
    await screenshot(page, label, `css-${kind}-viewport-keyboard`);
  }
  const fit = root.locator('[data-fixture-fit]');
  await rest(page); const fitBefore = await inspect(fit);
  await fit.click(); await rest(page); const fitSelected = await inspect(fit);
  check(await fit.getAttribute('aria-pressed') === 'true', `${label}/CSS Fit: selected state exercised`);
  stableEdges(fitBefore, fitSelected, `${label}/CSS selected Fit`);
  filled(fitBefore, fitSelected, `${label}/CSS selected Fit`);
  await control(page, fit, `${label}/CSS selected Fit keyboard focus`);
  await screenshot(page, label, 'css-fit-keyboard');
  await root.evaluate(node => { node.close(); node.remove(); });
}

async function forcedColorsChecks(browser, scheme) {
  const label = `forced-colors-${scheme}`;
  let page, context;
  try {
    ({ page, context } = await open(browser, 1440, scheme, label, 'active'));
    check(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), `${label}: forced colors actually active`);
    const readable = async (target, name) => {
      const state = await inspect(target), ratio = contrast(state.foreground, state.effective);
      check(state.painted && ratio >= 4.5, `${label}/${name}: visible text contrast >= 4.5:1`, { ratio, foreground: state.foreground, background: state.effective, painted: state.painted });
      return state;
    };
    const focusControl = async (target, name) => {
      await rest(page); const before = await inspect(target);
      const after = await keyboardFocus(page, target, `${label}/${name}`);
      noOutline(after, `${label}/${name}`);
      filled(before, after, `${label}/${name}`);
      // Forced-color adjustment remaps border colors, not structural border geometry.
      equal(after.border.map(([width, style]) => [width, style]), before.border.map(([width, style]) => [width, style]), `${label}/${name}: structural border geometry unchanged`);
      equal(after.shadow, before.shadow, `${label}/${name}: no added shadow ring`);
      return after;
    };
    await focusControl(page.locator('.control-mode-picker'), 'task control mode');
    await focusControl(page.locator('.model-picker-trigger'), 'model trigger');
    await page.keyboard.press('Enter');
    const menu = page.getByRole('dialog', { name: 'Model', exact: true });
    await menu.waitFor();
    check(await menu.evaluate(node => node.contains(document.activeElement)), `${label}: model menu opens inside the app surface`);
    await focusControl(menu.locator('.anchor-menu-row').first(), 'ordinary option');
    const search = menu.getByRole('searchbox', { name: 'Search models', exact: true });
    await search.fill('Synthetic');
    await focusControl(search, 'input');
    const models = menu.locator('.anchor-menu-row');
    equal(await models.count(), 2, `${label}: both model label states exercised`);
    for (let index = 0; index < 2; index++) {
      await focusControl(models.nth(index), `model ${index}`);
      await readable(models.nth(index).locator('small'), `model ${index} secondary label`);
    }
    await screenshot(page, label, 'model-secondary-keyboard');
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    const textarea = page.getByRole('textbox', { name: 'Message Outpost', exact: true });
    await textarea.fill('Synthetic unsent forced-colors message'); await rest(page);
    const composerBefore = await inspect(page.locator('.reply-composer'));
    const textareaAfter = await keyboardFocus(page, textarea, `${label}/composer`);
    const composerAfter = await inspect(page.locator('.reply-composer'));
    noOutline(textareaAfter, `${label}/textarea`); noOutline(composerAfter, `${label}/composer`);
    filled(composerBefore, composerAfter, `${label}/composer`);
    check(textareaAfter.background[3] === 0 && textareaAfter.backgroundImage === 'none' && textareaAfter.shadow === 'none' && textareaAfter.border.every(([width]) => parseFloat(width) === 0), `${label}: textarea stays transparent without an inner box`);
    await readable(textarea, 'composer text');
    await screenshot(page, label, 'composer-keyboard');

    const root = await mountCssFixtures(page);
    await root.evaluate(root => {
      root.querySelector('.browser-toolbar').insertAdjacentHTML('beforeend', '<button type="button" class="browser-control-toggle">CSS fixture browser action</button>');
      root.querySelector('.image-zoom-controls').insertAdjacentHTML('beforeend', '<button type="button" data-fixture-unpressed>Actual size</button>');
      root.querySelector('[data-fixture-fit]').setAttribute('aria-pressed', 'true');
      for (const toolbar of root.querySelectorAll('.browser-toolbar, .image-viewer-toolbar')) {
        toolbar.insertAdjacentHTML('beforeend', '<span data-fixture-subtle style="color:var(--subtle)">CSS subtle label</span><small data-fixture-faint style="color:var(--faint,var(--muted))">CSS faint label</small>');
      }
    });
    await root.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await focusControl(root.locator('[data-fixture-primary]'), 'CSS primary text button');
    await screenshot(page, label, 'css-primary-keyboard');
    for (const [kind, viewportSelector, toolbarSelector, textSelectors] of [
      ['browser', '.browser-page-input', '.browser-toolbar', ['.browser-mode strong', '.browser-mode > span', '[data-fixture-subtle]', '[data-fixture-faint]']],
      ['image', '.image-stage', '.image-viewer-toolbar', ['output', '[data-fixture-subtle]', '[data-fixture-faint]']],
    ]) {
      const viewport = root.locator(viewportSelector), toolbar = root.locator(toolbarSelector);
      await viewport.scrollIntoViewIfNeeded(); await rest(page);
      const viewportBefore = await inspect(viewport), toolbarBefore = await inspect(toolbar);
      const pixelsBefore = await viewport.screenshot({ caret: 'hide' });
      const viewportAfter = await keyboardFocus(page, viewport, `${label}/CSS ${kind} viewport`);
      noOutline(viewportAfter, `${label}/CSS ${kind} viewport`);
      equal(viewportAfter.background, viewportBefore.background, `${label}/CSS ${kind}: viewport background unchanged`);
      equal(viewportAfter.shadow, viewportBefore.shadow, `${label}/CSS ${kind}: no shadow ring`);
      equal(viewportAfter.border.map(([width, style]) => [width, style]), viewportBefore.border.map(([width, style]) => [width, style]), `${label}/CSS ${kind}: viewport border geometry unchanged`);
      check(pixelsBefore.equals(await viewport.screenshot({ caret: 'hide' })), `${label}/CSS ${kind}: rendered image area pixels unchanged by focus`);
      if (kind === 'image') {
        // The viewport screenshot can clip its toolbar; reveal the whole fixture without moving focus.
        await root.locator('.image-viewer').scrollIntoViewIfNeeded();
        await settle(page);
        keyboardState(await inspect(viewport), `${label}/CSS image viewport after fixture scroll`);
      }
      const toolbarAfter = await inspect(toolbar);
      noOutline(toolbarAfter, `${label}/CSS ${kind} toolbar`);
      check(toolbarAfter.painted, `${label}/CSS ${kind}: focused viewport feedback toolbar is visible`);
      filled(toolbarBefore, toolbarAfter, `${label}/CSS ${kind} toolbar`);
      for (const selector of textSelectors) await readable(toolbar.locator(selector), `CSS ${kind} toolbar ${selector}`);
      for (const button of await toolbar.locator('button').all()) {
        const state = await readable(button, `CSS ${kind} toolbar button ${await button.textContent()}`);
        noOutline(state, `${label}/CSS ${kind} toolbar button`);
        check(!state.active, `${label}/CSS ${kind}: toolbar buttons are readable while viewport owns focus`);
      }
      if (kind === 'image') {
        const selected = await inspect(toolbar.locator('[data-fixture-fit]')), ordinary = await inspect(toolbar.locator('[data-fixture-unpressed]'));
        check(delta(selected.effective, ordinary.effective) >= 4, `${label}/CSS image: pressed and ordinary toolbar buttons retain distinct fills`);
      }
      await screenshot(page, label, `css-${kind}-viewport-keyboard`);
    }
  } catch (error) {
    check(false, `${label}: interaction/harness failure`, error.stack);
    if (page && !page.isClosed()) await screenshot(page, label, 'interaction-failure');
  } finally {
    if (page && !page.isClosed()) equal(await page.evaluate(() => window.__unexpectedIPC), [], `${label}: no unexpected IPC or server mutations`);
    if (context) await context.close();
  }
}

let browser;
try {
  browser = await engine.launch();
  for (const width of [1440, 768, 390]) for (const scheme of ['dark', 'light']) {
    const label = `${width}-${scheme}`;
    let context, page;
    try {
      ({ context, page } = await open(browser, width, scheme, label));
      await composer(page, '.reply-composer', 'Message Outpost', `${label}/reply`, label);
      await control(page, page.getByRole('button', { name: 'Resume task', exact: true }), `${label}/ordinary icon button`, 3, true);
      await picker(page, label);
      await page.keyboard.press('Meta+n');
      const goal = page.getByRole('textbox', { name: 'Task goal', exact: true });
      await goal.waitFor();
      await composer(page, '.composer', 'Task goal', `${label}/main`, label);
      await goal.fill('Synthetic unsent task');
      const mode = page.locator('.control-mode-picker');
      check(await mode.textContent() !== null, `${label}: new task control mode present`);
      const model = page.locator('.model-picker-trigger'), send = page.getByRole('button', { name: 'Start task', exact: true });
      check(await send.isEnabled(), `${label}: real primary send control is enabled without dispatch`);
      await rest(page);
      const modeBefore = await inspect(mode), modelBefore = await inspect(model), sendBefore = await inspect(send);
      await keyboardFocus(page, goal, `${label}/main textarea order anchor`);
      for (const [target, before, name, minimumContrast] of [[mode, modeBefore, 'control mode', 3], [model, modelBefore, 'model picker', 4.5], [send, sendBefore, 'primary send', 3]]) {
        const after = await nextFocus(page, target, `${label}/composer order/${name}`);
        stableEdges(before, after, `${label}/${name}`); filled(before, after, `${label}/${name}`, minimumContrast);
      }
      await screenshot(page, label, 'primary-send-keyboard');
      await settings(page, label);
      await cssFixtures(page, label);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: app has no horizontal overflow`);
    } catch (error) {
      check(false, `${label}: interaction/harness failure`, error.stack);
      if (page && !page.isClosed()) await screenshot(page, label, 'interaction-failure');
    } finally {
      if (page && !page.isClosed()) equal(await page.evaluate(() => window.__unexpectedIPC), [], `${label}: no unexpected IPC or server mutations (including swallowed rejections)`);
      if (context) await context.close();
    }
  }
  if (engine === chromium) {
    for (const scheme of ['dark', 'light']) await forcedColorsChecks(browser, scheme);
  } else {
    a11yNotes.push('Forced-colors emulation is unsupported in WebKit: Chromium-only forced-colors cases were not run. Normal WebKit focus checks remain strict.');
  }
  equal(errors, [], 'No uncaught page errors');
  equal(external, [], 'No external HTTP or WebSocket requests; all attempts are blocked');
  const report = { browser: browserName, checks, passed: checks - failures.length, failed: failures.length, failures, screenshots, a11yNotes, scopes: { functional: ['main/reply composers', 'model picker top-layer dialog and local selection', 'composer keyboard order', 'settings links', 'appearance switch'], cssOnly: ['enrollment radio cards', 'setup primary button and error styling', 'browser/image viewport focus', 'image Fit selected state'], forcedColors: engine === chromium ? ['light/dark real controls and model secondary labels', 'transparent composer', 'CSS viewer direct/secondary toolbar text and button contrast', 'unchanged viewport pixels with filled toolbar focus'] : [] } };
  writeFileSync(`${out}/${browserName}-results.json`, JSON.stringify(report, null, 2));
  console.log(`${failures.length ? 'FAIL' : 'PASS'}: ${checks - failures.length}/${checks} focus-treatment checks (${browserName}); ${screenshots.length} screenshots: ${out}`);
  for (const failure of failures.slice(0, 16)) console.error(failure.message);
  if (failures.length > 16) console.error(`All ${failures.length} failures are recorded in ${out}/${browserName}-results.json`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
