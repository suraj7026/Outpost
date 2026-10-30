import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';

// Synthetic IPC and generated images only. No Keychain, live server or provider calls.
const root = resolve('desktop/dist');
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser = await chromium.launch();
const imagePage = await browser.newPage();
const images = await imagePage.evaluate(() => Object.fromEntries(['png', 'jpeg', 'webp'].map((format, index) => {
  const canvas = document.createElement('canvas'); canvas.width = 1600 - index * 100; canvas.height = 1000 - index * 100;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = ['#202a29', '#302527', '#252833'][index]; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#68787b'; ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
  for (let y = 0; y < canvas.height; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  ctx.fillStyle = '#ededef'; ctx.font = '48px sans-serif'; ctx.fillText(`Synthetic ${format.toUpperCase()} image`, 80, 150);
  ctx.font = '24px sans-serif'; ctx.fillText('Image viewer verification · No live data', 80, 210);
  return [format, canvas.toDataURL(`image/${format}`).split(',')[1]];
})));
await imagePage.close();
if (process.env.OUTPOST_TEST_BROWSER === 'webkit') { await browser.close(); browser = await webkit.launch(); }
const row = (kind, id, data) => ({ kind, id, revision: 1, updatedAt: '2026-10-30T12:00:00Z', data });
const artifacts = ['png', 'jpeg', 'webp'].map((format, index) => row('artifact', `image-${index}`, { taskId: 'task', name: `capture.${format}`, mime: `image/${format}`, hash: createHash('sha256').update(Buffer.from(images[format], 'base64')).digest('hex') }));
const fixture = { snapshot: { cursor: 1, protocolVersion: 1, records: [
  row('task', 'task', { goal: 'Inspect image evidence', profile: 'browser', state: 'paused' }),
  row('message', 'message', { taskId: 'task', author: 'assistant', text: 'Screenshots are ready for inspection.\n\n![Untrusted remote image](https://untrusted.invalid/tracker.png)' }),
  ...artifacts,
  row('artifact', 'unsupported', { taskId: 'task', name: 'untrusted.svg', mime: 'image/svg+xml', hash: 'unsupported' }),
  row('artifact', 'other-task', { taskId: 'other-task', name: 'other-task.png', mime: 'image/png', hash: artifacts[0].data.hash }),
] }, runtime: { model: 'fixture:cloud' }, models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' } };
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const errors = [], externalRequests = [];
async function open({ width = 1440, scenario = 'live', colorScheme = 'dark', reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith('https://')) externalRequests.push(request.url()); });
  await page.addInitScript(({ fixture, images, scenario }) => {
    window.__requests = []; window.__revoked = []; window.__held = [];
    window.__failImages = scenario === 'retry'; window.__corrupt = scenario === 'corrupt'; window.__holdPng = scenario === 'late';
    const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = (url) => { window.__revoked.push(url); revoke(url); };
    if (scenario === 'preview') { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; return; }
    let sequence = 0; window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 1 };
          return structuredClone(fixture[args.kind]);
        }
        if (command === 'stream_events') return new Promise(() => {});
        window.__requests.push({ command, args });
        if (command === 'artifact') {
          if (window.__failImages) throw new Error('Synthetic integrity check failed');
          if (window.__corrupt) return btoa('Not an image');
          const record = fixture.snapshot.records.find(row => row.kind === 'artifact' && row.id === args.id);
          if (record.data.mime === 'image/svg+xml') throw new Error('Unsupported image must not be fetched');
          const content = images[record.data.mime.split('/')[1]];
          if (window.__holdPng && args.id === 'image-0') return new Promise(resolve => window.__held.push(() => resolve(content)));
          return content;
        }
        if (command === 'save_artifact') {
          if (window.__failDownload) throw new Error('Synthetic download failed');
          return `/synthetic/Downloads/${args.name}`;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    };
  }, { fixture, images, scenario });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  if (width <= 780) await page.getByRole('button', { name: /^Evidence \(/ }).click();
  return page;
}
const ready = page => page.waitForFunction(() => {
  const img = document.querySelector('.image-canvas img');
  return img?.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility === 'visible';
});
const out = `/tmp/outpost-image-viewer${process.env.OUTPOST_TEST_BROWSER === 'webkit' ? '-webkit' : ''}`; mkdirSync(out, { recursive: true });
try {
  for (const width of [1440, 768, 390]) {
    const page = await open({ width });
    await page.getByRole('button', { name: 'View capture.png', exact: true }).click();
    await ready(page);
    check(await page.getByRole('dialog', { name: 'Image viewer' }).isVisible(), `Modal opens at ${width}`);
    check(await page.getByText('1600 × 1000', { exact: true }).isVisible(), 'Dimensions shown');
    check(await page.getByRole('button', { name: 'Previous image', exact: true }).isDisabled(), 'First image boundary');
    check(await page.getByText('1 / 3', { exact: true }).isVisible(), 'Only supported images from this task are in gallery');
    check((await page.evaluate(() => window.__requests)).every(request => request.command !== 'save_artifact'), 'Opening never downloads');
    check(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), 'Modal owns focus');
    await page.keyboard.press('Meta+n');
    check(await page.getByRole('heading', { name: 'What should run next?', exact: true }).count() === 0, 'Background app shortcuts are blocked while viewing');
    for (let step = 0; step < 10; step++) await page.keyboard.press('Tab');
    check(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), 'Tab focus remains within viewer');
    const fit = Number(await page.locator('.image-stage').getAttribute('data-zoom'));
    check(fit < 1, 'Large image fits viewport');
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    check(await page.locator('.image-stage').getAttribute('data-zoom') === '1.000', 'Actual size is 100%');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    check(Number(await page.locator('.image-stage').getAttribute('data-zoom')) > 1, 'Zoom in');
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    check(await page.locator('.image-stage').getAttribute('data-zoom') === '1.000', 'Zoom out');
    const canvas = page.locator('.image-stage');
    const before = await canvas.evaluate(node => node.scrollLeft);
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 40, { steps: 5 }); await page.mouse.up();
    check(await canvas.evaluate(node => node.scrollLeft) > before, 'Drag pans enlarged image');
    await canvas.press('0');
    check(Math.abs(Number(await canvas.getAttribute('data-zoom')) - fit) < .01, 'Keyboard fit resets view');
    await canvas.press('ArrowRight'); await ready(page);
    check(await page.getByRole('heading', { name: 'capture.jpeg', exact: true }).isVisible(), 'Arrow selects JPEG');
    check(await page.getByText('1500 × 900', { exact: true }).isVisible(), 'JPEG decodes');
    await page.keyboard.press('ArrowRight'); await ready(page);
    check(await page.getByRole('heading', { name: 'capture.webp', exact: true }).isVisible(), 'Navigation keeps focus after image change');
    check(await page.getByRole('button', { name: 'Next image', exact: true }).isDisabled(), 'Last image boundary');
    check(await page.getByText('1400 × 800', { exact: true }).isVisible(), 'WebP decodes');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'No page overflow');
    await page.screenshot({ path: `${out}/viewer-${width}.png` });
    const url = await page.locator('.image-canvas img').getAttribute('src');
    await page.keyboard.press('Escape');
    check(await page.getByRole('dialog').count() === 0, 'Escape closes viewer');
    check(await page.getByRole('button', { name: 'View capture.png', exact: true }).evaluate(node => document.activeElement === node), 'Focus returns to opening thumbnail');
    check(await page.evaluate(url => window.__revoked.includes(url), url), 'Viewer blob URL revoked on close');
    check((await page.evaluate(() => window.__requests)).every(request => request.args?.id !== 'unsupported'), 'SVG never fetched as an image');
    await page.close();
  }
  const page = await open();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Open capture.jpeg', exact: true }).click(); await ready(page);
  check(await page.getByText('2 / 3', { exact: true }).isVisible(), 'Library opens the same task-scoped gallery');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved to /synthetic/Downloads/capture.jpeg' }).waitFor();
  const saves = await page.evaluate(() => window.__requests.filter(request => request.command === 'save_artifact'));
  assert.deepEqual(saves, [{ command: 'save_artifact', args: { id: 'image-1', hash: artifacts[1].data.hash, name: 'capture.jpeg' } }]); checks++;
  await page.evaluate(() => { window.__failDownload = true; });
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic download failed' }).waitFor(); checks++;
  await page.getByRole('button', { name: 'Close image viewer' }).click();
  await page.getByRole('button', { name: 'Open other-task.png', exact: true }).click(); await ready(page);
  check(await page.getByText('1 / 1', { exact: true }).isVisible(), 'Other task images never mix into gallery');
  await page.close();
  for (const scenario of ['retry', 'corrupt']) {
    const page = await open({ scenario });
    await page.getByRole('button', { name: 'Open capture.png', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor(); checks++;
    check(await page.getByRole('button', { name: 'Zoom in', exact: true }).isDisabled(), `${scenario}: invalid image cannot be zoomed`);
    await page.evaluate(() => { window.__failImages = false; window.__corrupt = false; });
    await page.getByRole('button', { name: 'Retry image', exact: true }).click(); await ready(page);
    check(await page.getByText('1600 × 1000', { exact: true }).isVisible(), `${scenario}: retry recovers`);
    await page.close();
  }
  const late = await open({ scenario: 'late' });
  await late.getByRole('button', { name: 'Open capture.png', exact: true }).click();
  await late.getByRole('dialog').getByText('Loading image…').waitFor();
  await late.getByRole('button', { name: 'Next image', exact: true }).click(); await ready(late);
  await late.evaluate(() => { window.__holdPng = false; window.__held.forEach(resolve => resolve()); });
  await late.getByRole('button', { name: 'View capture.png', exact: true }).locator('img').waitFor({ state: 'attached' });
  check(await late.locator('.image-canvas img').getAttribute('alt') === 'capture.jpeg', 'Late previous-image response cannot replace current image');
  await late.close();
  const preview = await open({ scenario: 'preview' });
  check(await preview.getByRole('button', { name: 'View capture.png', exact: true }).isDisabled(), 'Recorded preview does not fetch images');
  check(await preview.getByRole('button', { name: 'Download capture.png', exact: true }).isDisabled(), 'Recorded preview cannot save');
  check((await preview.evaluate(() => window.__requests)).length === 0, 'No IPC from recorded-preview images');
  await preview.close();
  const light = await open({ colorScheme: 'light', reducedMotion: 'reduce' });
  await light.getByRole('button', { name: 'Open capture.png', exact: true }).click(); await ready(light);
  check(await light.locator('.image-viewer').evaluate(node => getComputedStyle(node).animationName) === 'none', 'Reduced motion disables viewer animation');
  await light.screenshot({ path: `${out}/viewer-light.png` }); await light.close();
  check(externalRequests.length === 0, 'Untrusted Markdown images never cause remote requests');
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} image viewer checks. Synthetic screenshots: ${out}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
