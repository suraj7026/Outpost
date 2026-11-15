import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openSettings } from './settings-test-navigation.mjs';

// Offline synthetic preview only; never uses native IPC, Keychain or live servers.
const root = resolve('desktop/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain' };
const server = createServer((request, response) => {
  const path = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) return response.writeHead(404).end();
  response.setHeader('content-type', types[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const address = `http://127.0.0.1:${server.address().port}`;
const baseline = process.env.OUTPOST_TYPOGRAPHY_BASELINE === '1';
const out = `/tmp/outpost-typography/${baseline ? 'before' : 'after'}`;
mkdirSync(out, { recursive: true });
const row = (kind, id, data) => ({ kind, id, revision: 1, updatedAt: '2026-11-11T00:00:00Z', data });
const fixture = {
  snapshot: { protocolVersion: 1, cursor: 1, records: [
    row('task', 'typography', { goal: 'Review the server connection', profile: 'code', state: 'paused' }),
    row('policy', 'typography', { mode: 'ask_permission' }),
    row('message', 'response', { taskId: 'typography', author: 'assistant', text: '## Connection review\nSynthetic typography fixture. **Saved settings** and *connection details* stay readable.\n\n```text\nServer: Outpost\nStatus: Ready\n```' }),
  ] },
  runtime: { configured: true, model: 'fixture:cloud', hostAdministration: false },
  models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' },
};
let checks = 0;
const errors = [], external = [];
const check = (value, message) => { assert.ok(value, message); checks++; };
async function open(width, colorScheme, fallback = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(address)) external.push(request.url()); });
  if (fallback) await page.route('**/GoogleSansFlex-*.woff2', route => route.abort());
  await page.addInitScript(fixture => { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; }, fixture);
  await page.goto(address);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function reveal(page) {
  if (await page.locator('.web-sidebar').getAttribute('aria-hidden') === 'true') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
}
async function alignment(page, context) {
  const result = await page.evaluate(() => {
    const button = document.querySelector('.connection-nav');
    const [gear, chevron] = button.querySelectorAll('svg');
    const nav = document.querySelector('.web-sidebar nav button');
    const text = [...nav.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const range = document.createRange(); range.selectNodeContents(text);
    const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, cy: r.top + r.height / 2, height: r.height }; };
    return { button: bounds(button), gear: bounds(gear), label: bounds(button.querySelector('span')), chevron: bounds(chevron), navIcon: bounds(nav.querySelector('svg')), navText: bounds(range) };
  });
  check(Math.abs(result.gear.left - result.navIcon.left) < 1, `${context}: settings gear aligns with navigation icons`);
  check(Math.abs(result.label.left - result.navText.left) < 1, `${context}: settings label aligns with navigation labels`);
  check([result.gear, result.label, result.chevron].every(item => Math.abs(item.cy - result.button.cy) < 1), `${context}: icon, label and chevron share a vertical center`);
  check(Math.abs(result.button.right - result.chevron.right - 12) < 1, `${context}: only chevron occupies trailing edge`);
  check(result.button.height >= (page.viewportSize().width <= 780 ? 44 : 40), `${context}: full-row target retains its height`);
}
async function renderedFont(page, selector, expected) {
  if (engine !== chromium) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  check(fonts.some(font => font.isCustomFont && font.familyName.replaceAll(' ', '').startsWith(expected.replaceAll(' ', '')) && font.glyphCount > 0), `Actual rendered font on ${selector}: ${expected}; got ${JSON.stringify(fonts)}`);
  await cdp.detach();
}
try {
  for (const width of [1440, 768, 390]) {
    for (const scheme of ['dark', 'light']) {
      const page = await open(width, scheme);
      if (!baseline) {
        for (const selector of ['body', '.task-title h1', '.message p', '.message strong', '.message em', '.message pre code', '.reply-composer textarea', '.connection-nav']) {
          check(await page.locator(selector).first().evaluate(node => getComputedStyle(node).fontFamily.split(',').slice(0, 2).map(value => value.trim().replaceAll('"', '')).join('|') === 'Google Sans Flex|Google Sans'), `${selector}: shared primary/fallback stack`);
        }
        check(await page.evaluate(() => [...document.fonts].some(face => face.family.replaceAll('"', '') === 'Google Sans Flex' && face.status === 'loaded')), 'Bundled Google Sans Flex loaded');
        await renderedFont(page, '.message p', 'Google Sans Flex');
      }
      await reveal(page);
      if (!baseline) await alignment(page, `${width}/${scheme}/chat`);
      await page.screenshot({ path: `${out}/chat-${width}-${scheme}-${engine.name()}.png` });
      await page.locator('.connection-nav').screenshot({ path: `${out}/settings-row-${width}-${scheme}-${engine.name()}.png` });
      await openSettings(page, { page: 'home' });
      await page.evaluate(() => document.fonts.ready);
      await reveal(page);
      if (!baseline) {
        await alignment(page, `${width}/${scheme}/settings`);
        await renderedFont(page, '.connection-nav > span', 'Google Sans Flex');
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal overflow`);
        await page.mouse.move(width - 2, 898);
        const settings = page.getByRole('button', { name: 'Settings', exact: true });
        await settings.evaluate(node => node.blur());
        const restingFocus = await settings.evaluate(node => ({ fill: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).border, shadow: getComputedStyle(node).boxShadow }));
        await settings.focus();
        await page.keyboard.press('ArrowRight');
        const focus = await page.locator('.connection-nav').evaluate(node => ({ active: node === document.activeElement, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, fill: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).border, shadow: getComputedStyle(node).boxShadow }));
        check(focus.active && focus.visible && focus.outline === 'none' && focus.fill !== restingFocus.fill && focus.border === restingFocus.border && focus.shadow === restingFocus.shadow, `Settings keyboard focus stays visible through non-border fill at ${width}: ${JSON.stringify({ restingFocus, focus })}`);
      }
      await page.screenshot({ path: `${out}/settings-${width}-${scheme}-${engine.name()}.png` });
      await page.close();
    }
  }
  if (!baseline) {
    const page = await open(1440, 'dark', true);
    check(await page.evaluate(() => [...document.fonts].some(face => face.family.replaceAll('"', '') === 'Google Sans Flex' && face.status === 'error')), 'Primary-font failure was exercised');
    check(await page.evaluate(() => [...document.fonts].some(face => face.family.replaceAll('"', '') === 'Google Sans' && face.style === 'normal' && face.status === 'loaded')), 'Bundled Google Sans fallback loads without the primary');
    await renderedFont(page, '.message p', 'Google Sans');
    await renderedFont(page, '.message em', 'Google Sans');
    await alignment(page, 'fallback');
    await page.screenshot({ path: `${out}/fallback-${engine.name()}.png` });
    await page.close();
    for (const family of ['GoogleSansFlex', 'GoogleSans']) check(readFileSync(`desktop/dist/font-licenses/${family}-OFL.txt`, 'utf8').includes('SIL OPEN FONT LICENSE'), `${family}: redistribution license included in the built app`);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  }
  console.log(`${baseline ? 'BASELINE' : 'PASS'}: ${checks} typography/alignment checks (${engine.name()}); screenshots ${out}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
