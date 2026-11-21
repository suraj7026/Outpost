import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from '../chat-test-navigation.mjs';
import { installWorkspaceTransport, workspaceFixture, workspaceOwnerA as A, workspaceOwnerB as B, workspaceTask as taskId, workspaceOtherTask as otherTaskId } from '../test-fixtures/workspace-panel-native.mjs';

// node desktop/tests/test-workspace-panel.mjs (existing dist only; no build, real server, or native file writes).
// OUTPOST_TEST_BROWSER=webkit optionally runs the same suite in WebKit; Chromium is the default.
const engine = { chromium, webkit }[process.env.OUTPOST_TEST_BROWSER ?? 'chromium'];
assert.ok(engine, 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const output = '/tmp/outpost-workspace-panel';
assert.ok(existsSync(resolve(root, 'index.html')), 'Parent must build desktop/dist before this test');
mkdirSync(output, { recursive: true });
const fingerprint = () => {
  const hash = createHash('sha256');
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(path.slice(root.length)).update(readFileSync(path));
    }
  };
  visit(root); return hash.digest('hex');
};
const distHash = fingerprint();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer((request, response) => {
  try {
    const path = resolve(root, decodeURIComponent(new URL(request.url, 'http://fixture').pathname).slice(1) || 'index.html');
    if (request.method !== 'GET' || !path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(readFileSync(path));
  } catch { response.writeHead(400).end(); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
let browser, origin, checks = 0, expired = false;
const results = [], failures = [];
const started = Date.now();
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, message, tolerance = 1.5) => check(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const panel = page => page.locator('#task-resources.workspace-panel');
const body = page => panel(page).locator('.workspace-document-body');
const download = page => panel(page).getByRole('button', { name: 'Download', exact: true });
const mode = (page, name) => panel(page).getByRole('group', { name: 'Document view' }).getByRole('button', { name, exact: true });
const file = (page, path) => panel(page).locator('.workspace-file-row').filter({ has: page.locator(`span`, { hasText: path.split('/').at(-1) }) });
const countFrames = page => page.evaluate(() => window.__workspacePanelTest.calls.filter(call => call.command === 'environment_query' && call.args.kind === 'browser.frame').length);
async function open(page) {
  if (await page.locator('.task-workspace-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.task-workspace-toggle').click();
  await panel(page).waitFor(); await settle(page);
}
async function selectChat(page, owner = A, task = taskId) {
  // As in chat-test-navigation.mjs, use the actual history button without pinning/revealing the overlay sidebar.
  const button = page.locator(`.chat-server-group[data-server-id="${owner}"] button[data-task-id="${task}"]`);
  await button.waitFor({ state: 'attached' }); await button.evaluate(node => node.click());
  await page.waitForFunction(owner => document.querySelector('.main-shell')?.dataset.ownerId === owner, owner);
  await page.locator('.task-workspace-heading h1').filter({ hasText: task === taskId ? 'Shared workspace task' : 'Other workspace task' }).waitFor();
  await settle(page);
}
async function textVisible(page, text) { await body(page).getByText(text, { exact: false }).first().waitFor(); }
async function screenshot(page, name) {
  const path = `${output}/${engine.name()}-${name}.png`;
  await page.screenshot({ path, animations: 'disabled', timeout: 4000 }); return path;
}
async function scenario(name, options, run) {
  if (expired) throw new Error('Workspace test deadline exceeded');
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], external = [], dialogs = [];
  const result = { name, screenshots: [], errors, external, dialogs, measurements: [] };
  results.push(result);
  page.setDefaultTimeout(4000); page.setDefaultNavigationTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  try {
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      external.push(request.url()); return route.abort();
    });
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
    if (options.virtualTime) await page.clock.install();
    await context.addInitScript(installWorkspaceTransport, workspaceFixture(options));
    await page.goto(origin);
    await openInitialTestChat(page);
    await page.waitForFunction(() => Object.values(window.__workspacePanelTest.states).every(state => state.ready));
    await selectChat(page);
    await page.evaluate(() => document.fonts.ready);
    if (options.virtualTime) await page.clock.runFor(10);
    await run(page, result);
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = error.stack;
    failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
    console.error(`FAIL ${name}\n${error.stack}`);
  } finally {
    try {
      result.screenshots.push(await screenshot(page, name));
      result.ipc = await page.evaluate(() => ({ unexpected: window.__workspacePanelTest.unexpected, downloads: window.__workspacePanelTest.downloads, queries: window.__workspacePanelTest.calls.filter(call => call.command === 'environment_query'), mutations: window.__workspacePanelTest.calls.filter(call => /send_command|retry_command|browser_request|open_url|terminal|artifact\.(begin|chunk|complete)/.test(call.command)) }));
      equal(errors, [], `${name}: no browser runtime errors`);
      equal(external, [], `${name}: no external HTTP or WebSocket traffic`);
      equal(dialogs, [], `${name}: no unexpected dialogs`);
      equal(result.ipc.unexpected, [], `${name}: all native IPC is allowlisted and owner scoped`);
      equal(result.ipc.mutations, [], `${name}: no side-effect commands`);
    } catch (error) {
      result.status = 'failed'; failures.push(new Error(`${name} safety/cleanup: ${error.message}`, { cause: error }));
      console.error(`FAIL ${name} safety/cleanup: ${error.message}`);
    }
    await context.close();
  }
  if (result.status === 'passed') console.log(`PASS ${engine.name()} / ${name}`);
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector), r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    };
    const toolbar = document.querySelector('.reply-composer .composer-toolbar');
    return { icon: rect('.task-workspace-toggle'), grid: rect('.task-columns'), chat: rect('.conversation-column'), workspace: rect('#task-resources'), composer: rect('.reply-composer'), toolbar: rect('.reply-composer .composer-toolbar'), controls: [...toolbar.children].filter(node => node.getBoundingClientRect().width > 0).map(node => { const r = node.getBoundingClientRect(); return { name: node.getAttribute('aria-label') || node.className, x: r.x, right: r.right, center: r.y + r.height / 2, top: r.top, bottom: r.bottom }; }), single: document.querySelector('.task-columns').dataset.workspaceSingle, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth };
  });
}
function composerRow(g) {
  check(g.controls.length >= 5, 'Composer has attachment, task, resources, model, and send controls');
  for (const control of g.controls) {
    near(control.center, g.controls[0].center, `${control.name} stays on one composer row`, 3);
    check(control.x >= g.toolbar.x - 1 && control.right <= g.toolbar.right + 1, `${control.name} fits the composer toolbar`);
  }
  check(g.composer.scrollWidth <= g.composer.clientWidth + 1, 'Composer does not overflow at minimum chat width');
}
async function setContainerWidth(page, width) {
  const g = await geometry(page);
  await page.setViewportSize({ width: Math.round(g.viewport + width - g.grid.width), height: 1000 });
  await page.waitForFunction(width => Math.abs(document.querySelector('.task-columns').getBoundingClientRect().width - width) < 1, width);
  await settle(page);
}
async function run() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch({ headless: true, timeout: 15000 });

  await scenario('document-content-and-evidence', {}, async (page, result) => {
    equal(await countFrames(page), 0, 'Closed workspace does not poll browser');
    const review = page.locator('.conversation-file-review').filter({ hasText: 'README.md' });
    await review.click(); await panel(page).waitFor();
    equal(await page.locator('.task-workspace-toggle').getAttribute('aria-expanded'), 'true', 'Evidence card opens the real workspace');
    await textVisible(page, 'Actual workspace bytes — café.');
    const rendered = body(page).locator('.workspace-document-markdown');
    equal(await rendered.getByRole('heading', { level: 1 }).textContent(), 'Workspace Alpha / Shared workspace task', 'Markdown renders actual returned file text');
    equal(await rendered.locator('table tbody tr').count(), 1, 'GFM table rendered');
    check(await rendered.locator('input[type=checkbox]').isChecked(), 'GFM task list rendered');
    equal(await rendered.locator('img, script, iframe, object, embed, video, audio, [onerror]').count(), 0, 'Raw HTML and remote images never become active DOM');
    check((await rendered.innerText()).includes('[Image not loaded: remote image]'), 'Remote image has a safe placeholder');
    equal(await rendered.getByRole('link').count(), 1, 'Only explicit safe web link is actionable');
    equal(await page.evaluate(() => window.__workspaceInjected), undefined, 'Raw HTML does not execute');
    result.screenshots.push(await screenshot(page, 'safe-markdown'));
    await mode(page, 'Source').click();
    const source = await body(page).locator('.workspace-document-line-text').allTextContents();
    const expected = workspaceFixture().states[A].documents[taskId]['docs/README.md'].text.trimEnd().split('\n');
    equal(source.map(line => line === '\u200b' ? '' : line), expected, 'Source matches every actual file line, including literal untrusted HTML');
    await mode(page, 'Changes').click(); await textVisible(page, 'Current contents match the recorded write.');
    check(await body(page).locator('.workspace-document-diff-added').count() > 5, 'Matching addition shows recorded added lines');
    await file(page, 'docs/drift.md').click();
    await textVisible(page, 'File has changed since recorded write.');
    equal(await body(page).locator('.workspace-document-diff').count(), 0, 'Changed disk text does not get a fabricated recorded diff');
    await mode(page, 'Preview').click(); await textVisible(page, 'Current on-disk Workspace Alpha');
    check(!(await body(page).innerText()).includes('STALE ACTION ARGUMENTS'), 'Preview is not reconstructed from action arguments');
    await file(page, 'src/edited.txt').click(); await mode(page, 'Changes').click();
    await textVisible(page, 'Recorded changes');
    check((await body(page).locator('.workspace-document-diff-removed').innerText()).includes('old Workspace Alpha'), 'Hash-linked prior write supplies removed evidence');
    check((await body(page).locator('.workspace-document-diff-added').innerText()).includes('new Workspace Alpha'), 'Actual current write supplies added evidence');
    result.screenshots.push(await screenshot(page, 'recorded-changes'));
    await file(page, 'notes.txt').click(); await textVisible(page, 'A previous version was not recorded.');
    await mode(page, 'Preview').click(); await textVisible(page, 'Unrecorded actual text: Workspace Alpha');
    await file(page, 'empty.txt').click(); await textVisible(page, 'This file is empty.');
    equal(await countFrames(page), 0, 'Document selection never starts browser polling');
  });

  await scenario('listing-filter-and-attachments', { truncated: true }, async page => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    equal(await panel(page).locator('.workspace-file-row').count(), 7, 'List contains six workspace files plus the attachment');
    await panel(page).getByText('File list limited to 1,000 entries and eight directory levels.').waitFor();
    const filter = panel(page).getByRole('textbox', { name: 'Filter files' });
    await filter.fill('DOCS/readME'); equal(await panel(page).locator('.workspace-file-row').count(), 1, 'Filter is case-insensitive and includes directory path');
    await filter.fill('no-matching-file'); await panel(page).getByText('No matching files.', { exact: true }).waitFor();
    equal(await panel(page).locator('.workspace-file-row').count(), 0, 'No unrelated rows survive filter');
    await filter.fill('');
    await panel(page).locator('.workspace-file-filters').getByRole('button', { name: /^Changes/ }).click();
    equal(await panel(page).locator('.workspace-file-row').count(), 3, 'Changes filter includes only recorded written paths');
    await panel(page).getByText('Recorded file writes only.').waitFor();
    await panel(page).getByRole('button', { name: 'All files', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Toggle file list' }).click();
    check(!await panel(page).locator('#workspace-files').isVisible(), 'File list hides without closing document');
    check(await body(page).isVisible(), 'Document remains visible');
    await panel(page).getByRole('button', { name: 'Toggle file list' }).click();
    await file(page, 'attachment.md').click(); await textVisible(page, 'Retrieved attachment Workspace Alpha');
    await download(page).click(); await panel(page).getByRole('status').filter({ hasText: 'Saved to' }).waitFor();
    const saved = await page.evaluate(() => window.__workspacePanelTest.downloads.at(-1));
    equal(saved, { command: 'environment_save_artifact', args: { environmentId: A, id: `${taskId}-attachment`, name: 'attachment.md', hash: workspaceFixture().states[A].artifacts[`${taskId}-attachment`].hash } }, 'Existing artifact retrieval/download keeps owner and exact hash');
    const before = await page.evaluate(() => window.__workspacePanelTest.calls.filter(call => call.args.kind === 'workspace.files').length);
    await panel(page).getByRole('button', { name: 'Refresh files' }).click();
    await page.waitForFunction(before => window.__workspacePanelTest.calls.filter(call => call.args.kind === 'workspace.files').length > before, before);
  });

  await scenario('resize-minimum-fixed-icon-and-composer', {}, async (page, result) => {
    const closed = await page.locator('.task-workspace-toggle').boundingBox();
    await open(page); await textVisible(page, 'Actual workspace bytes');
    const initial = await geometry(page); result.measurements.push(initial);
    near(initial.chat.width, 600, 'Default chat width is 600'); composerRow(initial);
    near(initial.icon.x, closed.x, 'Opening keeps header icon x'); near(initial.icon.y, closed.y, 'Opening keeps header icon y');
    const separator = page.getByRole('separator', { name: 'Resize chat and workspace' });
    equal(await separator.getAttribute('aria-orientation'), 'vertical', 'Resize separator has vertical orientation');
    await separator.focus(); await separator.press('End'); await settle(page);
    const maximum = await geometry(page); near(maximum.chat.width, 760, 'Keyboard End reaches maximum 760');
    near(maximum.icon.x, initial.icon.x, 'Resizing never shifts header icon');
    await separator.press('Home'); await separator.press('ArrowLeft'); await settle(page);
    near((await geometry(page)).chat.width, 600, 'Keyboard cannot shrink chat below 600');
    const r = await separator.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + 200); await page.mouse.down();
    await page.mouse.move(r.x - 250, r.y + 200, { steps: 5 }); await page.mouse.up(); await settle(page);
    near((await geometry(page)).chat.width, 600, 'Pointer cannot shrink chat below 600');
    await separator.press('ArrowRight'); await settle(page); near((await geometry(page)).chat.width, 616, 'Arrow increments width');
    await separator.dblclick(); await settle(page); near((await geometry(page)).chat.width, 600, 'Double click restores default');
    result.screenshots.push(await screenshot(page, 'chat-minimum-600'));
    await page.locator('.task-workspace-toggle').click(); await settle(page);
    check(!await panel(page).isVisible(), 'Header toggle closes workspace');
    const after = await page.locator('.task-workspace-toggle').boundingBox();
    near(after.x, closed.x, 'Closing keeps icon x'); near(after.y, closed.y, 'Closing keeps icon y');
  });

  await scenario('row-alignment', {}, async (page, result) => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    const alignmentErrors = [];
    for (const width of [1450, 1200]) {
      await setContainerWidth(page, width);
      const rows = await page.evaluate(() => ['.workspace-tabs', '.workspace-files-heading', '.workspace-document-toolbar', '.workspace-filter-row', '.workspace-meta', '.workspace-file-filters'].map(selector => {
        const node = document.querySelector(selector), rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { selector, bottom: rect.bottom, height: rect.height, cssHeight: style.height, padding: style.padding, boxSizing: style.boxSizing };
      }));
      result.measurements.push({ width, rows });
      result.screenshots.push(await screenshot(page, `row-alignment-${width}`));
      for (let i = 0; i < rows.length; i += 2) {
        try { near(rows[i].bottom, rows[i + 1].bottom, `${width}px: ${rows[i].selector} aligns with ${rows[i + 1].selector}`); }
        catch (error) { alignmentErrors.push(error.message); }
      }
    }
    equal(alignmentErrors, [], 'Document and explorer row bottoms align at wide and compact workspace widths');
  });

  await scenario('single-pane-boundary-and-focus', {}, async (page, result) => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    await setContainerWidth(page, 1020);
    let g = await geometry(page); result.measurements.push(g);
    equal(g.single, 'false', 'Exactly 1020 supports split view'); near(g.chat.width, 600, 'Boundary preserves minimum chat'); near(g.workspace.width, 420, 'Boundary preserves minimum workspace'); composerRow(g);
    await setContainerWidth(page, 1019); g = await geometry(page); result.measurements.push(g);
    equal(g.single, 'true', 'Below 1020 uses single pane');
    check(!await page.locator('.conversation-column').isVisible(), 'Single pane hides conversation');
    equal(await page.getByRole('separator', { name: 'Resize chat and workspace' }).count(), 0, 'No separator in single pane');
    check(await panel(page).isVisible(), 'Workspace remains accessible');
    near(g.workspace.width, g.grid.width, 'Single pane uses full available width');
    check(g.documentWidth <= g.viewport, 'No page horizontal overflow');
    result.screenshots.push(await screenshot(page, 'single-pane'));
    const before = await page.locator('.task-workspace-toggle').boundingBox();
    await panel(page).getByRole('button', { name: 'Toggle file list' }).focus(); await page.keyboard.press('Escape'); await settle(page);
    check(await page.locator('.conversation-column').isVisible(), 'Escape returns to chat in single pane');
    check(await page.locator('.task-workspace-toggle').evaluate(node => node === document.activeElement), 'Escape restores focus to fixed header toggle');
    const after = await page.locator('.task-workspace-toggle').boundingBox(); near(after.x, before.x, 'Single-pane close keeps icon x'); near(after.y, before.y, 'Single-pane close keeps icon y');
  });

  await scenario('stale-read-task-switch', {}, async page => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    await page.evaluate(({ owner, taskId }) => { window.__workspacePanelTest.holdReads = [{ owner, taskId, path: 'slow.md' }]; }, { owner: A, taskId });
    await file(page, 'slow.md').click();
    await page.waitForFunction(() => window.__workspacePanelTest.heldReads.length === 1);
    await selectChat(page, A, otherTaskId); await open(page);
    await file(page, 'slow.md').click(); await textVisible(page, 'Delayed Workspace Alpha / Other workspace task');
    await page.evaluate(() => window.__workspacePanelTest.releaseReads()); await settle(page);
    check((await body(page).innerText()).includes('Delayed Workspace Alpha / Other workspace task'), 'New task retains its own contents for the identical path after old read resolves');
    check(!(await body(page).innerText()).includes('Shared workspace task'), 'Delayed prior task read is discarded');
  });

  await scenario('owner-isolation-stale-read-and-download', {}, async page => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    await page.evaluate(() => { window.__workspacePanelTest.holdDownloads = true; });
    await download(page).click();
    await page.waitForFunction(() => window.__workspacePanelTest.heldDownloads.length === 1);
    await page.evaluate(({ owner, taskId }) => { window.__workspacePanelTest.holdReads = [{ owner, taskId, path: 'slow.md' }]; }, { owner: A, taskId });
    await file(page, 'slow.md').click(); await page.waitForFunction(() => window.__workspacePanelTest.heldReads.length === 1);
    await selectChat(page, B); await open(page); await file(page, 'slow.md').click();
    await textVisible(page, 'Delayed Workspace Beta / Shared workspace task');
    await page.evaluate(() => { window.__workspacePanelTest.releaseReads(); window.__workspacePanelTest.releaseDownloads(); }); await settle(page);
    check(!(await body(page).innerText()).includes('Workspace Alpha'), 'Identical task ID on new owner cannot show old owner contents');
    equal(await panel(page).locator('.workspace-notice').count(), 0, 'Old owner download completion does not announce success in new owner');
    check(await download(page).isEnabled(), 'New owner download is not stuck saving');
    await file(page, 'docs/README.md').click(); await textVisible(page, 'Workspace Beta / Shared workspace task');
    await download(page).click(); await panel(page).getByRole('status').filter({ hasText: 'Saved to' }).waitFor();
    const saves = await page.evaluate(() => window.__workspacePanelTest.downloads);
    const fixture = workspaceFixture();
    equal(saves, [A, B].map(owner => ({ command: 'environment_save_workspace_file', args: { environmentId: owner, taskId, path: 'docs/README.md', hash: fixture.states[owner].documents[taskId]['docs/README.md'].hash } })), 'Native downloads bind original owner, same task ID, exact path and each owner’s actual hash');
    check((await panel(page).locator('.workspace-notice').innerText()).includes(B), 'Only current owner download reports success');
  });

  await scenario('pending-download-selection-generation', {}, async page => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    await page.evaluate(() => { window.__workspacePanelTest.holdDownloads = true; });
    await download(page).click(); await page.waitForFunction(() => window.__workspacePanelTest.heldDownloads.length === 1);
    await file(page, 'notes.txt').click(); await textVisible(page, 'Unrecorded actual text');
    await page.evaluate(() => window.__workspacePanelTest.releaseDownloads()); await settle(page);
    equal(await panel(page).locator('.workspace-notice').count(), 0, 'Previous file download completion does not update current file notice');
    check(await download(page).isEnabled(), 'Selection change releases saving state for current document');
    await download(page).click(); await panel(page).getByRole('status').filter({ hasText: 'notes.txt' }).waitFor();
  });

  await scenario('live-browser-polling-lifecycle', {}, async (page, result) => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    await page.waitForTimeout(1150); equal(await countFrames(page), 0, 'Open Document tab does not poll Browser');
    await panel(page).getByRole('tab', { name: 'Browser', exact: true }).click();
    const image = panel(page).getByRole('img', { name: 'Current page in this task’s server browser' });
    await image.waitFor();
    check(await image.evaluate(node => node.complete && node.naturalWidth === 960 && node.naturalHeight === 600 && node.src.startsWith('data:image/jpeg;base64,')), 'Actual embedded BrowserViewer decodes synthetic JPEG');
    await page.waitForFunction(() => window.__workspacePanelTest.calls.filter(call => call.args.kind === 'browser.frame').length >= 2);
    result.screenshots.push(await screenshot(page, 'live-browser'));
    await panel(page).locator('#workspace-document-button').click(); await settle(page);
    const unselected = await countFrames(page); await page.waitForTimeout(1250); equal(await countFrames(page), unselected, 'Unselected Browser stops polling beyond a full interval');
    await panel(page).getByRole('tab', { name: 'Browser', exact: true }).click(); await image.waitFor();
    await page.locator('.task-workspace-toggle').click(); await settle(page);
    const closed = await countFrames(page); await page.waitForTimeout(1250); equal(await countFrames(page), closed, 'Closed workspace stops polling even with Browser selected');
    await open(page); await image.waitFor();
    check(await countFrames(page) > closed, 'Reopening selected Browser resumes polling');
    const requests = await page.evaluate(() => window.__workspacePanelTest.calls.filter(call => call.args.kind === 'browser.frame'));
    check(requests.every(call => call.args.environmentId === A && call.args.payload.taskId === taskId), 'Every live frame is scoped to active owner and task');
  });

  await scenario('read-error-retry-and-offline', {}, async page => {
    await open(page); await textVisible(page, 'Actual workspace bytes');
    await page.evaluate(owner => { window.__workspacePanelTest.states[owner].readError = 'Synthetic workspace read denied'; }, A);
    await file(page, 'notes.txt').click(); await body(page).getByRole('alert').filter({ hasText: 'Synthetic workspace read denied' }).waitFor();
    check(await download(page).isDisabled(), 'Failed read cannot download an unknown hash');
    equal(await panel(page).getByRole('link', { name: 'Open Server updates', exact: true }).count(), 0, 'Permission/read failures do not masquerade as missing server APIs');
    await page.evaluate(owner => { window.__workspacePanelTest.states[owner].readError = ''; }, A);
    await body(page).getByRole('button', { name: 'Retry', exact: true }).click(); await textVisible(page, 'Unrecorded actual text');
    await page.evaluate(owner => window.__workspacePanelTest.offline(owner), A);
    await body(page).getByRole('status').filter({ hasText: 'Offline. Reconnect to load workspace files.' }).waitFor();
    check(await download(page).isDisabled(), 'Offline document download is disabled');
    check(await panel(page).getByRole('button', { name: 'Refresh files' }).isDisabled(), 'Offline refresh is disabled');
    check(!(await body(page).innerText()).includes('Unrecorded actual text'), 'Offline UI does not present cached bytes as live');
  });

  await scenario('empty-workspace', { empty: true }, async page => {
    await open(page); await panel(page).getByText('No workspace files yet.', { exact: true }).waitFor();
    await textVisible(page, 'Choose a file from the file list to preview it.');
    equal(await panel(page).locator('.workspace-file-row').count(), 0, 'Empty server listing produces no fabricated files');
    check(await download(page).isDisabled(), 'No selection cannot download');
  });

  await scenario('unsupported-server-feedback', { empty: true, listError: 'Unknown query: workspace.files' }, async page => {
    await open(page);
    const alert = panel(page).locator('.workspace-files').getByRole('alert'); await alert.waitFor();
    check((await alert.innerText()).includes('Unknown query: workspace.files'), 'Older native string error stays visible');
    check((await alert.innerText()).includes('This server needs an update to support file review.'), 'Older server gets actionable update guidance');
    equal(await alert.getByRole('link', { name: 'Open Server updates' }).getAttribute('href'), `#settings/servers/${A}/runtime`, 'Update link targets the chat owner');
    equal(await panel(page).getByText('No workspace files yet.', { exact: true }).count(), 0, 'An unsupported listing is not shown as an empty workspace');
    check(await panel(page).getByRole('button', { name: 'Refresh files' }).isEnabled(), 'Unsupported server retains retry affordance');
  });

  await scenario('coded-unsupported-document-and-settings-link', { listError: { code: 'unknown_query', message: 'Unsupported query' }, readError: { code: 'unknown_query', message: 'Unsupported query' } }, async page => {
    await selectChat(page, B);
    await open(page);
    const alert = body(page).getByRole('alert'); await alert.getByText('Server update required', { exact: true }).waitFor();
    check(await download(page).isDisabled(), 'Unsupported reads cannot download invented file bytes');
    const link = alert.getByRole('link', { name: 'Open Server updates', exact: true });
    equal(await link.getAttribute('href'), `#settings/servers/${B}/runtime`, 'Identical task IDs still navigate to the owning server');
    await link.click();
    await page.getByRole('heading', { name: 'Workspace Beta', exact: true }).waitFor();
    equal(await page.getByRole('link', { name: 'Server updates', exact: true }).getAttribute('aria-current'), 'page', 'File review opens the real Server updates settings');
    equal(await page.evaluate(() => window.__workspacePanelTest.calls.filter(call => /environment_update_(check|start|cancel)|automatic_updates_enable/.test(call.command)).length), 0, 'Following the link never authorizes or launches an update');
  });

  await scenario('automatic-completion-reloads-own-workspace', { virtualTime: true, listError: { code: 'unknown_query', message: 'Unsupported query' }, readError: { code: 'unknown_query', message: 'Unsupported query' } }, async page => {
    await open(page);
    await body(page).getByRole('alert').getByText('Server update required', { exact: true }).waitFor();
    const workspaceReads = () => page.evaluate(owner => window.__workspacePanelTest.calls.filter(call => call.args.environmentId === owner && ['workspace.files', 'workspace.read'].includes(call.args.kind)).length, A);
    const before = await workspaceReads();
    await page.evaluate(owner => { window.__workspacePanelTest.automaticStatus = { enabled: true, targets: [owner], activeEnvironmentId: null, servers: [{ environmentId: owner, state: 'complete', message: 'Verified complete', releaseId: 'other-release' }] }; }, B);
    await page.clock.runFor(15_100);
    equal(await workspaceReads(), before, 'Another server completing never refreshes this workspace');
    await page.evaluate(owner => {
      const control = window.__workspacePanelTest;
      control.states[owner].listError = ''; control.states[owner].readError = '';
      control.automaticStatus = { enabled: true, targets: [owner], activeEnvironmentId: null, servers: [{ environmentId: owner, state: 'complete', message: 'Verified complete', releaseId: 'workspace-capable-release' }] };
    }, A);
    await page.clock.runFor(15_100);
    await textVisible(page, 'Actual workspace bytes');
    check(await workspaceReads() > before, 'Verified completion reloads listing and selected file without Retry or reconnect');
    equal(await panel(page).getByText('Server update required', { exact: true }).count(), 0, 'Successful reload clears obsolete upgrade notices');
    const refreshed = await workspaceReads();
    await page.clock.runFor(15_100);
    equal(await workspaceReads(), refreshed, 'Repeated completion status does not repeatedly fetch documents');
  });
  equal(fingerprint(), distHash, 'Built desktop/dist remains unchanged throughout the suite');
}

let deadline;
const watchdog = setTimeout(() => {
  console.error('Workspace panel hard watchdog: exceeded 120 seconds');
  server.closeAllConnections(); server.close(); void browser?.close(); process.exit(1);
}, 120_000);
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => { expired = true; reject(new Error('Workspace panel main run exceeded 110 seconds')); }, 110_000); })]);
} catch (error) {
  failures.push(error);
} finally {
  clearTimeout(deadline);
  try { await browser?.close(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(watchdog);
    writeFileSync(`${output}/${engine.name()}-report.json`, JSON.stringify({ engine: engine.name(), distRoot: root, distHash, elapsedMs: Date.now() - started, checks, results, failures: failures.map(error => error.message) }, null, 2));
  }
}
console.log(`Workspace panel: ${results.filter(result => result.status === 'passed').length}/${results.length} scenarios, ${checks} assertions, ${Date.now() - started}ms. Screenshots/report: ${output}`);
if (failures.length) throw new AggregateError(failures, 'Workspace panel regressions detected; production code was not modified');
