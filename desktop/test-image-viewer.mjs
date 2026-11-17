import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { assertIconControls } from './icon-control-assertions.mjs';
import { openInitialTestChat } from './chat-test-navigation.mjs';

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
const images = await imagePage.evaluate(() => Object.fromEntries(['png', 'jpeg', 'webp', 'portrait', 'small'].map((format, index) => {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = format === 'portrait' ? [600, 1200] : format === 'small' ? [80, 50] : [1600 - index * 100, 1000 - index * 100];
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = ['#202a29', '#302527', '#252833'][index % 3]; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#68787b'; ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
  for (let y = 0; y < canvas.height; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  ctx.fillStyle = '#ededef'; ctx.font = '48px sans-serif'; ctx.fillText(`Synthetic ${format.toUpperCase()} image`, 80, 150);
  ctx.font = '24px sans-serif'; ctx.fillText('Image viewer verification · No live data', 80, 210);
  return [format, canvas.toDataURL(`image/${['portrait', 'small'].includes(format) ? 'png' : format}`).split(',')[1]];
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
const errors = [], externalRequests = [], unexpectedRequests = [];
const remoteUrl = 'https://untrusted.invalid/tracker.png';
const origin = `http://127.0.0.1:${server.address().port}`;
const withMarkdown = markdown => {
  const value = structuredClone(fixture);
  value.snapshot.records.find(record => record.kind === 'message').data.text = markdown;
  return value;
};
async function open({ width = 1440, scenario = 'live', colorScheme = 'dark', reducedMotion = 'no-preference', testFixture = fixture, imageData = images, remote, stream = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion, serviceWorkers: 'block' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) (remote?.traffic ?? externalRequests).push(request.url());
  });
  await page.route(/^https?:\/\//, async route => {
    const request = route.request();
    if (remote && request.url() === remoteUrl) {
      remote.requests.push({ url: request.url(), headers: await request.allHeaders() });
      await route.fulfill({ status: remote.failFirst && remote.requests.length === 1 ? 503 : 200,
        headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: remote.failFirst && remote.requests.length === 1 ? Buffer.from('Synthetic image failure') : Buffer.from(images.png, 'base64') });
    } else if (new URL(request.url()).origin === origin && request.resourceType() !== 'image') {
      await route.continue();
    } else {
      unexpectedRequests.push(request.url());
      await route.abort();
    }
  });
  if (remote) await page.context().addCookies([{ name: 'image-secret', value: 'must-not-leak', domain: 'untrusted.invalid', path: '/', secure: true, sameSite: 'None' }]);
  await page.addInitScript(({ fixture, images, scenario, stream }) => {
    window.__requests = []; window.__revoked = []; window.__held = [];
    window.__failImages = scenario === 'retry'; window.__corrupt = scenario === 'corrupt'; window.__holdPng = scenario === 'late';
    const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = (url) => { window.__revoked.push(url); revoke(url); };
    if (scenario === 'preview') { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; return; }
    let sequence = 0, channel, index = 0; const callbacks = new Map(); window.isTauri = true;
    window.__emitLive = frame => callbacks.get(channel.id)({ index: index++, message: frame });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'disconnect') return;
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 1 };
          return structuredClone(fixture[args.kind]);
        }
        if (command === 'stream_events') {
          if (stream) {
            channel = args.channel;
            callbacks.get(channel.id)({ index: index++, message: { type: 'snapshot', ...fixture.snapshot, live: [] } });
            window.__streamReady = true;
          }
          return new Promise(() => {});
        }
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
        if (command === 'open_url') return;
        if (command === 'save_artifact') {
          if (window.__failDownload) throw new Error('Synthetic download failed');
          return `/synthetic/Downloads/${args.name}`;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    };
  }, { fixture: testFixture, images: imageData, scenario, stream });
  await page.goto(origin);
  await openInitialTestChat(page);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  await page.locator('.conversation .stream-artifact').first().waitFor();
  return page;
}
const ready = page => page.waitForFunction(() => {
  const img = document.querySelector('.image-canvas img'), stage = document.querySelector('.image-stage');
  if (!img?.complete || !img.naturalWidth || !stage?.clientWidth || getComputedStyle(img).visibility !== 'visible') return false;
  const fit = Math.max(.01, Math.min(1, (stage.clientWidth - 32) / img.naturalWidth, (stage.clientHeight - 32) / img.naturalHeight));
  return Math.abs(Number(stage.dataset.zoom) - fit) < .002;
});
async function assertChatCentered(card, label) {
  const geometry = await card.evaluate(element => {
    const content = element.closest('.conversation .conversation-content');
    const center = node => { const { x, width } = node.getBoundingClientRect(); return x + width / 2; };
    return { card: center(element), content: content ? center(content) : null };
  });
  check(geometry.content !== null, `${label}: card belongs to the chat content container`);
  check(Math.abs(geometry.card - geometry.content) < 1, `${label}: whole card is centered within chat content (${geometry.card} vs ${geometry.content})`);
}
async function assertPreview(card, label, { small = false, portrait = false } = {}) {
  await card.scrollIntoViewIfNeeded();
  await card.locator('.artifact-preview img').waitFor({ state: 'visible' });
  await card.page().waitForFunction(element => {
    const img = element.querySelector('.artifact-preview img');
    return img?.complete && img.naturalWidth > 0 && getComputedStyle(img).display !== 'none';
  }, await card.elementHandle());
  const geometry = await card.evaluate(element => {
    const preview = element.querySelector('.artifact-preview'), img = preview.querySelector('img');
    const rect = node => { const { x, width, height } = node.getBoundingClientRect(); return { x, width, height }; };
    return { card: rect(element), preview: rect(preview), image: rect(img), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, viewport: innerWidth };
  });
  const { card: box, preview, image, naturalWidth, naturalHeight } = geometry;
  if (await card.evaluate(element => Boolean(element.closest('.conversation')))) await assertChatCentered(card, label);
  check(box.width >= 159 && box.width <= 561, `${label}: card width stays between 160 and 560px`);
  check(box.x >= 0 && box.x + box.width <= geometry.viewport + 1, `${label}: card fits viewport`);
  check(image.width > 0 && image.width <= 560 && image.height > 0 && image.height <= 360, `${label}: image respects 560 × 360 bounds`);
  check(Math.abs(image.width / image.height - naturalWidth / naturalHeight) < .015, `${label}: intrinsic aspect ratio retained`);
  check(Math.abs(preview.height - image.height - 2) < 2, `${label}: preview wraps image instead of a fixed-height strip`);
  if (small) {
    check(Math.abs(box.width - 160) < 1, `${label}: small image has a 160px card`);
    check(Math.abs(image.width - naturalWidth) < 1 && Math.abs(image.height - naturalHeight) < 1, `${label}: small image is not enlarged`);
  } else {
    check(image.height > 140, `${label}: large image is not a 120px strip`);
    const expectedWidth = Math.min(naturalWidth, 560, naturalWidth / naturalHeight * 360, preview.width - 2);
    check(Math.abs(image.width - expectedWidth) < 2, `${label}: preview uses the available image size`);
    if (portrait) check(image.height >= 350 && image.width < image.height, `${label}: portrait uses the height limit`);
  }
  const screenshot = await card.screenshot({ path: `${out}/chat-${label}.png`, animations: 'disabled' });
  check(screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label}: screenshot is a PNG`);
  check(Math.abs(screenshot.readUInt32BE(16) - box.width) <= 2 && Math.abs(screenshot.readUInt32BE(20) - box.height) <= 2, `${label}: screenshot captures the full card geometry`);
}
const out = `/tmp/outpost-image-viewer${process.env.OUTPOST_TEST_BROWSER === 'webkit' ? '-webkit' : ''}`; mkdirSync(out, { recursive: true });
try {
  for (const width of [1440, 768, 390]) {
    const page = await open({ width });
    const consent = page.locator('.markdown-image-consent');
    check(await consent.getByRole('button', { name: 'Load image', exact: true }).isEnabled(), `HTTPS image requires consent at ${width}`);
    check(await consent.locator('img').count() === 0, 'Consent placeholder has no remote img');
    await assertChatCentered(consent, `consent-${width}`);
    for (const format of ['png', 'jpeg', 'webp']) {
      await assertPreview(page.locator('.stream-artifact .chat-image').filter({ has: page.getByRole('button', { name: `View capture.${format}`, exact: true }) }), `${format}-${width}`);
    }
    await page.getByRole('button', { name: 'View capture.png', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/chat-${width}.png` });
    check(externalRequests.length === 0, `No request before consent at ${width}`);
    await page.getByRole('button', { name: 'View capture.png', exact: true }).click();
    await ready(page);
    check(await page.getByRole('dialog', { name: 'Image viewer' }).isVisible(), `Modal opens at ${width}`);
    checks += await assertIconControls(page, '.image-viewer');
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
    check(await preview.locator('.markdown-image-consent').getByRole('button', { name: 'Load image', exact: true }).isDisabled(), 'Recorded preview cannot consent to external images');
    check(await preview.locator('.message-markdown img').count() === 0, 'Recorded Markdown preview has no external image element');
  check((await preview.evaluate(() => window.__requests)).length === 0, 'No IPC from recorded-preview images');
  await preview.close();
  const light = await open({ colorScheme: 'light', reducedMotion: 'reduce' });
  await light.getByRole('button', { name: 'Open capture.png', exact: true }).click(); await ready(light);
  check(await light.locator('.image-viewer').evaluate(node => getComputedStyle(node).animationName) === 'none', 'Reduced motion disables viewer animation');
  checks += await assertIconControls(light, '.image-viewer');
  await light.screenshot({ path: `${out}/viewer-light.png` }); await light.close();
  for (const width of [1440, 768, 390]) {
    for (const shape of ['landscape', 'portrait', 'small']) {
      const shapeFixture = withMarkdown(`![First ${shape} image](capture.png)\n\nInspect the ${shape} attachment.\n\n![Later ${shape} image](#artifact-image-0)`);
      const image = images[shape === 'landscape' ? 'png' : shape];
      const record = shapeFixture.snapshot.records.find(record => record.id === 'image-0');
      record.data.hash = createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex');
      const page = await open({ width, testFixture: shapeFixture, imageData: { ...images, png: image } });
      await assertPreview(page.locator('.conversation .stream-artifact#artifact-image-0 .chat-image'), `attachment-${shape}-${width}`, { [shape]: true });
      const inlineCards = page.locator('.conversation .message-markdown .chat-image');
      check(await inlineCards.count() === 2, `${shape}-${width}: both Markdown images render`);
      for (const [index, position] of ['first', 'later'].entries()) {
        await assertPreview(inlineCards.nth(index), `inline-${position}-${shape}-${width}`, { [shape]: true });
      }
      await page.close();
    }
  }
  const unavailable = [
    ['Insecure image', 'http://untrusted.invalid/insecure.png'],
    ['File image', 'file:///synthetic/private.png'],
    ['Data image', `data:image/png;base64,${images.small}`],
    ['Unknown relative image', 'missing.png'],
    ['Other task image', 'other-task.png'],
    ['Unsupported attachment', 'untrusted.svg'],
  ];
  const unsupported = await open({ testFixture: withMarkdown(unavailable.map(([alt, src]) => `![${alt}](${src})`).join('\n\n')) });
  for (const [alt] of unavailable) {
    check(await unsupported.locator('.markdown-image-unavailable').filter({ hasText: alt }).count() === 1, `${alt}: unavailable placeholder`);
  }
  check(await unsupported.locator('.message-markdown img, .markdown-image-consent').count() === 0, 'Unsupported URLs never create images or consent controls');
  await unsupported.screenshot({ path: `${out}/chat-unavailable.png` });
  await unsupported.close();
  for (const src of ['capture.png', '#artifact-image-0']) {
    const page = await open({ testFixture: withMarkdown(`![Attached screenshot](${src})`) });
    const card = page.locator('.message-markdown .chat-image');
    await assertPreview(card, src.startsWith('#') ? 'attached-fragment' : 'attached-relative');
    check(await card.locator('img').getAttribute('alt') === 'Attached screenshot', 'Attachment preserves Markdown alt text');
    check((await card.locator('img').getAttribute('src')).startsWith('blob:'), 'Known attachment uses native artifact bytes');
    const opener = card.getByRole('button', { name: 'View capture.png', exact: true });
    await opener.click(); await ready(page);
    check(await page.getByText('1 / 3', { exact: true }).isVisible(), `${src}: Markdown attachment opens task-scoped gallery`);
    check((await page.evaluate(() => window.__requests)).every(request => !['open_url', 'save_artifact'].includes(request.command)), 'Viewing a Markdown attachment neither downloads nor opens a browser');
    await page.keyboard.press('Escape');
    check(await opener.evaluate(node => document.activeElement === node), 'Markdown attachment receives focus after Escape');
    await card.getByRole('button', { name: 'Download capture.png', exact: true }).click();
    await card.getByRole('status').filter({ hasText: 'Saved to /synthetic/Downloads/capture.png' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__requests.filter(request => request.command === 'save_artifact')),
      [{ command: 'save_artifact', args: { id: 'image-0', hash: artifacts[0].data.hash, name: 'capture.png' } }]); checks++;
    await page.close();
  }
  check(externalRequests.length === 0, 'Untrusted Markdown images never cause remote requests');
  for (const scenario of ['consent', 'linked', 'remote-retry']) {
    const remote = { requests: [], traffic: [], failFirst: scenario === 'remote-retry' };
    const alt = scenario === 'linked' ? 'Linked image' : 'Untrusted remote image';
    const markdown = scenario === 'linked' ? `[**![${alt}](${remoteUrl})**](https://destination.invalid)` : `![${alt}](${remoteUrl})`;
    const testFixture = withMarkdown(markdown);
    const stream = scenario === 'consent';
    if (stream) {
      const message = testFixture.snapshot.records.find(record => record.kind === 'message');
      message.revision = 0; message.data.streaming = true;
    }
    const page = await open({ testFixture, remote, stream });
    if (stream) await page.waitForFunction(() => window.__streamReady);
    const consent = page.locator('.markdown-image-consent');
    await consent.scrollIntoViewIfNeeded();
    check(await consent.getByRole('button', { name: 'Load image', exact: true }).isEnabled(), `${scenario}: explicit consent required`);
    check(remote.traffic.length === 0 && remote.requests.length === 0, `${scenario}: no network request before consent`);
    check(await page.locator('.message-markdown img').count() === 0, `${scenario}: no hidden pre-consent image`);
    check(await consent.evaluate(node => !node.closest('a')), `${scenario}: consent is not nested in a link`);
    check(await page.locator('.message-markdown a[href="https://destination.invalid"]').count() === 0, 'Linked image replaces its destination anchor');
    await consent.getByRole('button', { name: 'Load image', exact: true }).click();
    const card = page.locator('.message-markdown .chat-image');
    if (remote.failFirst) {
      const retry = card.getByRole('button', { name: `Retry ${alt}`, exact: true });
      await retry.waitFor();
      check(remote.requests.length === 1, 'Remote failure does not auto-retry');
      check(await page.getByRole('dialog').count() === 0, 'Remote failure stays in the chat card');
      await retry.click();
    }
    await assertPreview(card, scenario);
    check(remote.requests.length === (remote.failFirst ? 2 : 1), `${scenario}: only consent and explicit retry fetch the image`);
    check(await card.locator('img').evaluate(img => img.crossOrigin === 'anonymous' && img.referrerPolicy === 'no-referrer'), `${scenario}: preview opts out of credentials and referrer`);
    check(await card.evaluate(node => !node.closest('a') && !node.querySelector('a button, button button')), `${scenario}: loaded card has no nested interactive wrappers`);
    check((await page.evaluate(() => window.__requests)).every(request => request.command !== 'open_url'), `${scenario}: Load and Retry never invoke open_url`);
    if (stream) {
      const message = structuredClone(testFixture.snapshot.records.find(record => record.kind === 'message'));
      message.data.text += '\n\nStreaming text after consent.';
      message.updatedAt = '2026-10-30T12:00:01Z';
      await page.evaluate(record => window.__emitLive({ type: 'live', record }), message);
      await page.getByText('Streaming text after consent.', { exact: true }).waitFor();
      check(await page.locator('.markdown-image-consent').count() === 0, 'Streaming text updates preserve image consent');
      check(await card.locator('img').isVisible() && remote.requests.length === 1, 'Streaming text does not remount or refetch the image');
    }
    const opener = card.getByRole('button', { name: `View ${alt}`, exact: true });
    await opener.click(); await ready(page);
    check(await page.getByRole('dialog', { name: 'Image viewer' }).isVisible(), `${scenario}: shared ImageDialog opens`);
    check(await page.getByRole('heading', { name: alt, exact: true }).isVisible(), `${scenario}: viewer uses Markdown alt text`);
    check(await page.locator('.image-canvas img').evaluate(img => img.crossOrigin === 'anonymous' && img.referrerPolicy === 'no-referrer'), `${scenario}: viewer also omits credentials and referrer`);
    check(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), `${scenario}: viewer owns focus`);
    const fit = Number(await page.locator('.image-stage').getAttribute('data-zoom'));
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    check(Number(await page.locator('.image-stage').getAttribute('data-zoom')) > fit, `${scenario}: remote image zooms`);
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    check(await page.locator('.image-stage').getAttribute('data-zoom') === '1.000', `${scenario}: remote actual size`);
    await page.screenshot({ path: `${out}/viewer-${scenario}.png` });
    check((await page.evaluate(() => window.__requests)).every(request => !['open_url', 'save_artifact'].includes(request.command)), `${scenario}: viewing never opens the browser or downloads`);
    await page.keyboard.press('Escape');
    check(await page.getByRole('dialog').count() === 0, `${scenario}: Escape closes remote viewer`);
    check(await opener.evaluate(node => document.activeElement === node), `${scenario}: focus returns to remote card`);
    await card.getByRole('button', { name: `Open original ${alt}`, exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__requests.filter(request => request.command === 'open_url')),
      [{ command: 'open_url', args: { url: remoteUrl } }]); checks++;
    check(remote.traffic.length === remote.requests.length && remote.traffic.every(url => url === remoteUrl), `${scenario}: all external traffic was intercepted, never the destination link`);
    for (const { headers } of remote.requests) {
      check(!headers.cookie && !headers.referer && !headers.referrer, `${scenario}: intercepted image request has no cookies or referrer`);
    }
    await page.close();
  }
  check(externalRequests.length === 0, 'Consent scenarios do not contaminate baseline traffic capture');
  check(unexpectedRequests.length === 0, `Unsupported URLs must never request: ${unexpectedRequests.join(', ')}`);
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} image viewer checks. Synthetic screenshots: ${out}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
