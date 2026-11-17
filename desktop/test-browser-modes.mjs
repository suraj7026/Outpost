import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
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
const out = `/tmp/outpost-browser-viewer-${engine.name()}`; mkdirSync(out, { recursive: true });
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
async function openResources(page) {
  const toggle = page.getByRole('button', { name: 'Files, changes and browser', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.task-resources').waitFor();
}
async function checkDialogLayout(dialog, controls = false) {
  const layout = await dialog.evaluate(node => {
    const box = selector => node.querySelector(selector).getBoundingClientRect();
    const modal = node.getBoundingClientRect(), heading = box('.browser-heading-row');
    const toolbar = box('.browser-toolbar'), frame = box('.browser-frame'), workspace = box('.browser-workspace');
    const body = node.querySelector('.browser-viewer-body');
    return {
      inViewport: modal.x >= 0 && modal.y >= 0 && modal.right <= innerWidth && modal.bottom <= innerHeight,
      noOverflow: body.scrollWidth <= body.clientWidth + 1,
      separateHeader: toolbar.top >= heading.bottom,
      frameBelowToolbar: frame.top >= toolbar.bottom,
      fullWidth: Math.abs(frame.width - workspace.width) < 2,
      controls: !!node.querySelector('.browser-control'),
      width: modal.width, height: modal.height,
    };
  });
  check(layout.inViewport, 'Browser dialog stays inside the viewport');
  check(layout.noOverflow, 'Browser dialog content does not overflow horizontally');
  check(layout.separateHeader && layout.frameBelowToolbar, 'Header, toolbar and browser frame never overlap');
  check(layout.controls === controls, 'Input sidebar exists only for owner input');
  if (!controls) check(layout.fullWidth, 'Read-only and empty views do not reserve an unused sidebar');
  check(await dialog.getByRole('heading', { name: 'Server browser' }).count() === 1, 'Modal uses a static heading, not an inert accordion button');
  return layout;
}
try {
  for (const width of [1440, 900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const row = (kind, id, data) => ({ kind, id, revision: 1, updatedAt: '2026-11-08T10:00:00Z', data });
      const records = [
        row('task', 'browser-task', { goal: 'Watch server browsing', profile: 'browser', state: 'running' }),
        row('browser', 'browser-task', { taskId: 'browser-task', state: 'running', mode: 'direct', engine: 'camoufox', url: 'https://fixture.example/research', action: 'Pi is browsing' }),
        row('task', 'other-task', { goal: 'Other browser task', profile: 'browser', state: 'verifying' }),
        row('browser', 'other-task', { taskId: 'other-task', state: 'idle', mode: 'direct', url: 'https://fixture.example/other' }),
      ];
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f6f5f0'; ctx.fillRect(0, 0, 1280, 800);
      ctx.fillStyle = '#202428'; ctx.font = '42px sans-serif'; ctx.fillText('Server browser fixture', 70, 130);
      ctx.font = '24px sans-serif'; ctx.fillText('A live page frame appears here while Pi works.', 70, 190);
      const jpeg = canvas.toDataURL('image/jpeg').split(',')[1];
      window.__frameMode = 'direct'; window.__frameState = 'running'; window.__frameCalls = 0;
      window.__frameError = false; window.__heldFrames = []; window.__holdFrames = false; window.__mutations = [];
      window.__control = null; window.__browserRequests = []; window.__inputError = false; window.__offline = false;
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args) {
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (['disconnect', 'set_sidebar_window_controls', 'set_sidebar_window_control_mode', 'set_sidebar_window_control_presentation'].includes(command)) return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', pending: false, nativeSidebar: false };
        if (command === 'stream_events') return new Promise((resolve, reject) => {
          window.__goOffline = () => { window.__offline = true; reject(new Error('Synthetic disconnect')); };
        });
        if (command.startsWith('plugin:')) return;
        if (command === 'browser_request') {
          const request = args.payload; window.__browserRequests.push(request);
          if (request.type === 'take') window.__control = { leaseId: 'fixture-lease', holder: 'fixture', state: 'pending', expiresAt: Date.now() + 30000 };
          if (request.type === 'renew') window.__control.expiresAt = Date.now() + 30000;
          if (request.type === 'release') window.__control.state = 'released';
          if (request.type === 'input' && window.__inputError) throw new Error('Synthetic uncertain input');
          return window.__control;
        }
        if (command === 'query') {
          if (window.__offline) throw new Error('Synthetic offline transport');
          if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records };
          if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud', browserEngine: 'camoufox', browserDirect: true, browserTakeover: !location.search.includes('takeover=0') };
          if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
          if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
          if (args.kind === 'browser.frame') {
            window.__frameCalls++;
            if (window.__frameError) throw new Error('Synthetic frame failure');
            const other = args.payload.taskId === 'other-task';
            const result = { frame: window.__frameState === 'closed' ? null : jpeg, capturedAt: new Date().toISOString(),
              frameId: crypto.randomUUID(), width: 1280, height: 800, controlEpoch: 'fixture-epoch', control: structuredClone(window.__control),
              tabs: [{ tab: 0, url: 'https://fixture.example/research', active: true }],
              session: { state: window.__frameState, mode: other ? 'direct' : window.__frameMode,
                url: other ? 'https://fixture.example/other' : 'https://fixture.example/research', action: 'Reading the page' } };
            if (window.__holdFrames && !other) return new Promise(resolve => window.__heldFrames.push(() => resolve(result)));
            return result;
          }
        }
        window.__mutations.push(command); throw new Error(`Unexpected IPC ${command}`);
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await openInitialTestChat(page);
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    await openResources(page);
    const viewer = page.getByRole('region', { name: 'Server browser' });
    await viewer.getByRole('img', { name: 'Current page in this task’s server browser' }).waitFor();
    check(await viewer.getByText('Pi actions', { exact: true }).isVisible(), 'Direct Pi control is visible');
    check(await viewer.getByText('Camoufox · direct Pi control').isVisible(), 'The actual browser engine is advertised');
    check(await viewer.getByText('View only · refreshes every second').isVisible(), 'Viewing cadence and authority are explicit');
    check(await viewer.locator('img').evaluate(image => image.complete && image.naturalWidth === 1280), 'Frame is rendered');
    await page.screenshot({ path: `${out}/${width}-camoufox.png` });
    const enlarged = page.getByRole('dialog', { name: 'Server browser' });
    await viewer.getByRole('button', { name: 'Enlarge browser view' }).click();
    await enlarged.getByRole('button', { name: 'Take control', exact: true }).waitFor();
    await checkDialogLayout(enlarged);
    check(await enlarged.getByRole('button', { name: 'Close browser view' }).evaluate(button => button === document.activeElement), 'Modal focuses its close control rather than outlining the title');
    check(await enlarged.locator('.browser-viewer-footer').evaluate(footer => footer.getBoundingClientRect().bottom < innerHeight), 'Full browser frame and its footer fit without scrolling');
    await page.screenshot({ path: `${out}/${width}-view-only.png` });
    await enlarged.getByRole('button', { name: 'Close browser view' }).click();
    check(await viewer.getByRole('button', { name: 'Enlarge browser view' }).evaluate(button => button === document.activeElement), 'Closing restores focus to the enlarge button');
    await page.evaluate(() => { window.__frameMode = 'direct'; });
    await viewer.getByText('Pi actions', { exact: true }).waitFor(); checks++;
    await page.evaluate(() => { window.__frameError = true; });
    await viewer.getByText('Live view unavailable. Retrying…').waitFor();
    check(await viewer.locator('img').count() === 0, 'Failed requests never leave a stale frame labelled live');
    await page.evaluate(() => { window.__frameError = false; });
    await viewer.locator('img').waitFor();
    await viewer.getByRole('button', { name: /Server browser/ }).click();
    const count = await page.evaluate(() => window.__frameCalls);
    await page.waitForTimeout(1200);
    check(await page.evaluate(() => window.__frameCalls) === count, 'Collapsed viewer stops polling');
    await viewer.getByRole('button', { name: /Server browser/ }).click();
    await viewer.locator('img').waitFor();
    await page.evaluate(() => { window.__frameState = 'closed'; });
    await viewer.getByText('Browser closed. The task profile and saved files are retained.').waitFor();
    check(await viewer.locator('img').count() === 0, 'Closed browser clears live frame');
    await viewer.getByRole('button', { name: 'Enlarge browser view' }).click();
    await enlarged.getByText('Browser closed. The task profile and saved files are retained.').waitFor();
    const empty = await checkDialogLayout(enlarged);
    check(empty.width <= 880 && empty.height < 600, 'Empty browser view has a compact frame');
    check(await enlarged.getByRole('button', { name: 'Take control', exact: true }).isDisabled(), 'Closed browser cannot be controlled');
    await page.screenshot({ path: `${out}/${width}-closed.png` });
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Viewer fits the viewport');
    check(await page.evaluate(() => window.__mutations.length) === 0, 'Watching never sends mutations');
    await page.evaluate(() => { window.__frameState = 'idle'; });
    await viewer.locator('img').waitFor();
    await viewer.getByRole('button', { name: 'Take control', exact: true }).click();
    await viewer.getByText('Waiting for the current browser operation to finish. Pi is paused.').waitFor();
    check(await viewer.getByLabel('Text for focused field').count() === 0, 'Pending handoff has no input controls');
    await page.evaluate(() => { window.__control.state = 'human'; });
    await viewer.getByLabel('Text for focused field').waitFor();
    await page.screenshot({ path: `${out}/${width}-takeover.png` });
    await viewer.getByRole('button', { name: 'Enlarge browser view' }).click();
    await enlarged.getByRole('button', { name: 'Return control', exact: true }).waitFor();
    check(await enlarged.isVisible(), 'Browser control can be enlarged without changing its lease');
    await checkDialogLayout(enlarged, true);
    await page.screenshot({ path: `${out}/${width}-enlarged.png` });
    if (width === 1440) {
      await page.setViewportSize({ width, height: 600 });
      await checkDialogLayout(enlarged, true);
      check(await enlarged.locator('.browser-frame').evaluate(frame => frame.getBoundingClientRect().bottom < innerHeight), 'Short windows show the whole browser frame');
      const inputPage = enlarged.getByRole('button', { name: 'Click server browser page', exact: true });
      const inputBox = await inputPage.boundingBox();
      check(Math.abs(inputBox.width / inputBox.height - 1.6) < .01, 'Fitted page input preserves the server viewport aspect ratio');
      await inputPage.click({ position: { x: inputBox.width / 2, y: inputBox.height / 2 } });
      const click = await page.evaluate(() => window.__browserRequests.filter(request => request.input?.action === 'click').at(-1).input);
      check(Math.abs(click.x - 640) < 3 && Math.abs(click.y - 400) < 3, `Fitted page clicks map to server coordinates, not the letterbox: ${JSON.stringify({ click, inputBox })}`);
      await enlarged.getByLabel('Browser tab').scrollIntoViewIfNeeded();
      check(await enlarged.getByRole('button', { name: 'Close browser view' }).isVisible(), 'Header remains visible when control content scrolls');
      await page.screenshot({ path: `${out}/${width}-short-window.png` });
      await page.setViewportSize({ width, height: 1000 });
    }
    await page.keyboard.press('Escape');
    await viewer.getByLabel('Text for focused field').waitFor();
    check(await viewer.getByRole('button', { name: 'Enlarge browser view' }).evaluate(button => button === document.activeElement), 'Escape restores focus to the enlarge button');
    await viewer.getByLabel('Text for focused field').fill('synthetic-private-text');
    await viewer.getByRole('button', { name: 'Send text', exact: true }).click();
    check(await viewer.getByLabel('Text for focused field').inputValue() === '', 'Sent private text is cleared');
    await page.waitForFunction(() => window.__browserRequests.some(request => request.input?.action === 'text'));
    check(await page.evaluate(() => window.__browserRequests.find(request => request.input?.action === 'text').input.text) === 'synthetic-private-text', 'Text uses transient browser IPC');
    const inputPage = viewer.getByRole('button', { name: 'Click server browser page', exact: true });
    await inputPage.click({ position: { x: 40, y: 30 } });
    check(await page.evaluate(() => window.__browserRequests.some(request => request.input?.action === 'click' && request.input.x > 40)), 'Clicks scale to the server viewport');
    await page.evaluate(() => { window.__inputError = true; });
    await viewer.getByRole('button', { name: 'Send key', exact: true }).click();
    await viewer.getByRole('alert').filter({ hasText: 'Input outcome uncertain' }).waitFor();
    const requests = await page.evaluate(() => window.__browserRequests.filter(request => request.type === 'input').length);
    await page.waitForTimeout(1100);
    check(await page.evaluate(() => window.__browserRequests.filter(request => request.type === 'input').length) === requests, 'Uncertain inputs are never automatically retried');
    await viewer.getByRole('button', { name: 'Return control', exact: true }).click();
    await viewer.getByText('Control returned. Resume Pi when ready.').waitFor();
    check(await viewer.getByLabel('Text for focused field').count() === 0, 'Return removes input controls');
    check(await page.evaluate(() => window.__mutations.length) === 0, 'Takeover never enters durable command IPC or resumes Pi');
    await page.evaluate(() => { window.__control = { leaseId: 'other', holder: 'other-device', state: 'human', expiresAt: Date.now() + 30000 }; });
    await viewer.getByText('Another device controls this browser.').waitFor();
    check(await viewer.getByRole('button', { name: 'Take control', exact: true }).isDisabled(), 'Another device cannot be displaced');
    await page.evaluate(() => { window.__control.state = 'expired'; });
    await viewer.getByText('Control expired. Pi remains paused.').waitFor();
    check(await viewer.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), 'Expired control can be explicitly reacquired');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Takeover controls fit the viewport');
    if (width === 1440) {
      await page.evaluate(() => { window.__holdFrames = true; });
      await page.waitForFunction(() => window.__heldFrames.length > 0);
      await page.getByRole('button', { name: /Other browser task/ }).click();
      await openResources(page);
      await viewer.locator('.browser-viewer-url').filter({ hasText: 'https://fixture.example/other' }).waitFor();
      await page.evaluate(() => { window.__heldFrames.forEach(resolve => resolve()); });
      await page.waitForTimeout(200);
      check(await viewer.locator('.browser-viewer-url').textContent() === 'https://fixture.example/other', 'Late frames cannot cross task boundaries');
    }
    await viewer.getByRole('button', { name: 'Enlarge browser view' }).click();
    await page.evaluate(() => window.__goOffline());
    await enlarged.getByText('Offline. Reconnect to watch the server browser.').waitFor();
    const offline = await checkDialogLayout(enlarged);
    check(offline.width <= 880 && offline.height < 600, 'Offline dialog does not expand into an empty canvas');
    check(await enlarged.getByText('Live view paused · offline').isVisible(), 'Offline view never claims to be refreshing');
    check(await enlarged.locator('img').count() === 0, 'Offline view hides the last live image');
    check(await enlarged.locator('.browser-control-toggle:enabled').count() === 0, 'Offline control remains unavailable');
    await page.screenshot({ path: `${out}/${width}-offline.png` });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await openInitialTestChat(page);
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    await openResources(page);
    await viewer.locator('img').waitFor();
    await viewer.getByRole('button', { name: 'Enlarge browser view' }).click();
    await page.evaluate(() => window.__goOffline());
    await enlarged.getByText('Offline. Reconnect to watch the server browser.').waitFor();
    await checkDialogLayout(enlarged);
    await page.screenshot({ path: `${out}/${width}-offline-light.png` });
    await enlarged.getByRole('button', { name: 'Close browser view' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`http://127.0.0.1:${server.address().port}?takeover=0`);
    await openInitialTestChat(page);
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    await openResources(page);
    await viewer.locator('img').waitFor();
    await viewer.getByRole('button', { name: 'Enlarge browser view' }).click();
    await checkDialogLayout(enlarged);
    check(await enlarged.getByRole('button', { name: 'Take control', exact: true }).count() === 0, 'View-only servers never show takeover controls');
    check(errors.length === 0, errors.join('\n'));
    await page.close();
  }
  console.log(`${checks} browser viewer checks passed (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
