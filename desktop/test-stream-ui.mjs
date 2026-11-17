import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const previewPath = process.argv[2] ?? '/tmp/outpost-recorded-preview.json';
assert.ok(existsSync(previewPath), `Recorded preview fixture is required: ${previewPath}`);
const preview = JSON.parse(readFileSync(previewPath, 'utf8'));
const task = preview.snapshot.records.find(record => record.kind === 'task' && record.data.profile === 'code');
assert.ok(task); task.data.state = 'running';
const start = Math.max(Date.now(), ...preview.snapshot.records.flatMap(record =>
  [Date.parse(record.updatedAt), typeof record.data.startedAt === 'number' ? record.data.startedAt : Date.parse(record.data.startedAt)].filter(Number.isFinite))) + 1000;
// Collapsed execution history may fit on one screen. Keep this scroll assertion
// meaningful regardless of how much history happens to be in the recording.
preview.snapshot.records.push({ id: 'scroll-fixture-history', kind: 'message', revision: 1, updatedAt: new Date(start).toISOString(),
  data: { taskId: task.id, author: 'assistant', startedAt: start, streaming: false, thinking: 'Earlier fixture reasoning',
    text: Array.from({ length: 40 }, (_, index) => `Scrolling fixture paragraph ${index + 1}: previously recorded context remains available while new output arrives.`).join('\n\n') } });
const root = resolve('desktop/dist'), types = { '.html': 'text/html','.js': 'text/javascript','.css': 'text/css','.woff2': 'font/woff2','.woff': 'font/woff' };
const server = createServer((req,res) => {
  const path = resolve(root,new URL(req.url,'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root+'/') || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type',types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch(); let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280,height: 900 },colorScheme: 'dark' });
  const errors = []; page.on('pageerror',error => errors.push(error.message));
  await page.addInitScript(({ preview, legacy }) => {
    const callbacks = new Map(); let sequence = 0, channel, index = 0;
    window.isTauri = true; window.__mutations = []; window.__streamReady = false;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(fn) { const id = ++sequence; callbacks.set(id,fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command,args) {
        if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        const environmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const bound = command.startsWith('environment_');
        if (command === 'environment_list' && legacy) return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: environmentId, environments: { [environmentId]: { environmentId, label: 'Stream fixture', activeRoute: 'https://fixture.example', routes: ['https://fixture.example'] } } }, legacy: { endpoint: null, pending: false } };
        if (command === 'environment_disconnect') return;
        if (command.startsWith('environment_')) {
          if (args.environmentId !== environmentId) throw new Error('Wrong stream owner');
          command = command.slice('environment_'.length);
        }
        if (command === 'disconnect') return;
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Fixture transport',deviceId: 'fixture',publicKey: '',pending: false,nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'snapshot') return preview.snapshot;
          if (args.kind === 'runtime') return preview.runtime;
          if (args.kind === 'models') return preview.models;
          if (args.kind === 'events') return { events: [],hasMore: false,nextCursor: preview.snapshot.cursor };
        }
        if (command === 'stream_events' && bound === legacy) return new Promise(() => {});
        if (command === 'stream_events') {
          channel = args.channel; index = 0;
          callbacks.get(channel.id)({ index: index++,message: { type: 'snapshot',...preview.snapshot,live: [] } });
          window.__streamReady = true;
          return new Promise(() => {});
        }
        if (command === 'update_sidebar' || command.startsWith('plugin:event|')) return 1;
        window.__mutations.push(command);
        throw new Error('Mutations are disabled in this UI fixture');
      },
    };
    window.__emitLive = frame => callbacks.get(channel.id)({ index: index++,message: frame });
  },{ preview, legacy: process.env.OUTPOST_TEST_LEGACY === '1' });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const activeOwner = await page.locator('.main-shell').getAttribute('data-owner-id');
  await page.locator(`.chat-server-group[data-server-id="${activeOwner}"] button[data-task-id="${task.id}"]`).click();
  await page.waitForFunction(() => window.__streamReady);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  assert.ok(await page.locator('.composer-context-run .composer-run-status').isVisible()); checks++;
  const conversation = page.locator('.conversation');
  const follow = page.locator('.composer-follow');
  const message = { id: 'live-fixture-message', kind: 'message', revision: 0, updatedAt: new Date(start + 1).toISOString(),
    data: { taskId: task.id, author: 'assistant', startedAt: start + 1, text: '', thinking: 'Visible model fixture reasoning', streaming: true } };
  const emit = frame => page.evaluate(value => window.__emitLive(value), frame);
  const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await emit({ type: 'live', record: message });
  const messageRow = conversation.locator('[data-record-id="live-fixture-message"]');
  const run = conversation.locator('.conversation-run').filter({ has: page.locator('[data-record-id="live-fixture-message"]') });
  const reasoning = run.locator('.run-reasoning');
  await reasoning.getByText('Visible model fixture reasoning', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await reasoning.count(), 1, 'Reasoning has one disclosure per run'); checks++;
  const byline = run.locator(':scope > .run-byline.message-byline');
  const assertRunByline = async () => {
    assert.equal(await byline.count(), 1, 'Streaming chunks share one direct assistant byline'); checks++;
    assert.equal(await byline.locator(':scope > .message-avatar.assistant-avatar .outpost-mark').count(), 1, 'Assistant byline has the Outpost avatar'); checks++;
    assert.equal(await byline.locator(':scope > span:not(.message-avatar)').textContent(), 'Outpost'); checks++;
    assert.equal(await byline.locator(':scope > time').count(), 1); checks++;
    assert.equal(await run.locator(':scope > .run-content .message-byline').count(), 0, 'Chunks do not duplicate the run byline'); checks++;
  };
  await assertRunByline();
  assert.equal(await run.getAttribute('aria-label'), 'Outpost response', 'Assistant run retains accessible attribution'); checks++;
  assert.equal(await reasoning.evaluate(node => node.open), false, 'Even live reasoning starts collapsed'); checks++;
  assert.equal(await reasoning.getByText('Visible model fixture reasoning', { exact: true }).isVisible(), false); checks++;
  await reasoning.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await reasoning.getByText('Visible model fixture reasoning', { exact: true }).waitFor();
  assert.ok(await reasoning.getByText('Earlier fixture reasoning', { exact: true }).isVisible(), 'Earlier and current reasoning are available in the same group'); checks++;
  message.data.thinking += ' — next chunk'; await emit({ type: 'live', record: message });
  await reasoning.getByText('Visible model fixture reasoning — next chunk', { exact: true }).waitFor(); checks++;
  assert.ok(await reasoning.evaluate(node => node.open), 'Streaming updates preserve the inspected disclosure'); checks++;
  await reasoning.locator(':scope > summary').click();
  await page.waitForFunction(() => document.querySelector('.composer-follow')?.getAttribute('aria-disabled') === 'false');
  await follow.click();
  message.data.text = 'Streaming answer: first'; await emit({ type: 'live', record: message });
  await messageRow.getByText('Streaming answer: first', { exact: true }).waitFor(); checks++;
  message.data.text += ' second'; await emit({ type: 'live', record: message });
  await messageRow.getByText('Streaming answer: first second', { exact: true }).waitFor(); checks++;
  await page.waitForFunction(() => { const node = document.querySelector('.conversation'); return node && node.scrollHeight - node.scrollTop - node.clientHeight < 4; });
  assert.ok(await conversation.evaluate(node => node.scrollHeight > node.clientHeight), 'The follow assertion exercises a scrollable conversation'); checks++;
  assert.equal(await follow.getAttribute('aria-disabled'), 'true', 'New output remains at the tail while following'); checks++;

  const tool = { id: 'live-fixture-tool', kind: 'tool_stream', revision: 0, updatedAt: new Date(start + 2).toISOString(),
    data: { taskId: task.id, name: 'outpost_action', state: 'preparing', arguments: { tool: 'command.run', arguments: { argv: ['/bin/echo', 'fixture'] } }, streaming: true } };
  const toolRow = conversation.locator('.execution-entry[data-record-id="live-fixture-tool"]');
  await emit({ type: 'live', record: tool }); await toolRow.locator('.action-state').getByText('preparing', { exact: true }).waitFor(); checks++;
  assert.equal(await toolRow.evaluate(node => node.open), false, 'Compact starts even current tool output collapsed'); checks++;
  await toolRow.locator(':scope > summary').focus(); await page.keyboard.press('Enter'); await flush();
  assert.ok(await toolRow.evaluate(node => node.open), 'Current tool output can be explicitly inspected'); checks++;
  assert.equal(await toolRow.locator('.execution-label').textContent(), 'Run /bin/echo fixture'); checks++;
  tool.data.state = 'running'; await emit({ type: 'live', record: tool });
  await toolRow.locator('.action-state').getByText('running', { exact: true }).waitFor(); checks++;
  const chronology = () => conversation.locator('[data-record-id]').evaluateAll(nodes => nodes.map(node => node.dataset.recordId).filter(id => ['scroll-fixture-history', 'live-fixture-message', 'live-fixture-tool', 'live-fixture-action'].includes(id)));
  assert.deepEqual(await chronology(), ['scroll-fixture-history', 'live-fixture-message', 'live-fixture-tool']); checks++;

  await conversation.focus(); await page.keyboard.press('Home');
  await conversation.evaluate(node => { node.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('.composer-follow')?.getAttribute('aria-disabled') === 'false');
  message.data.text += ' third'; message.updatedAt = new Date(start + 3).toISOString();
  await emit({ type: 'live', record: message });
  await messageRow.getByText(message.data.text, { exact: true }).waitFor({ state: 'attached' });
  await flush();
  assert.ok(await conversation.evaluate(node => node.scrollTop < 10), 'Reading older messages must not be interrupted by new chunks'); checks++;
  assert.equal(await follow.getAttribute('data-unseen'), 'true', 'New output while paused marks the follow button'); checks++;
  assert.match(await follow.getAttribute('aria-label'), /Jump to latest.*new/); checks++;
  assert.deepEqual(await chronology(), ['scroll-fixture-history', 'live-fixture-message', 'live-fixture-tool'], 'An updated message stays before the later tool'); checks++;
  await follow.click();
  await page.waitForFunction(() => { const node = document.querySelector('.conversation'); return node && node.scrollHeight - node.scrollTop - node.clientHeight < 4; });
  assert.equal(await follow.getAttribute('data-unseen'), 'false'); checks++;
  message.revision = 1; message.data.streaming = false;
  await emit({ type: 'settled', record: message }); await flush();
  assert.equal(await messageRow.getByText(message.data.text, { exact: true }).count(), 1); checks++;
  assert.equal(await reasoning.evaluate(node => node.open), false, 'Finalization does not reopen collapsed reasoning'); checks++;
  await reasoning.locator(':scope > summary').click();
  await reasoning.getByText('Visible model fixture reasoning — next chunk', { exact: true }).waitFor(); checks++;
  // A delayed partial frame must not replace an already finalized message.
  await emit({ type: 'live', record: { ...message, revision: 0, data: { ...message.data, streaming: true, text: 'stale fragment' } } });
  await flush();
  assert.equal(await conversation.getByText('stale fragment', { exact: true }).count(), 0); checks++;
  assert.equal(await messageRow.getByText(message.data.text, { exact: true }).count(), 1); checks++;
  await reasoning.locator(':scope > summary').click();

  const action = { id: 'live-fixture-action', kind: 'action', revision: 1, updatedAt: new Date(start + 4).toISOString(),
    data: { taskId: task.id, tool: 'command.run', state: 'dispatching', arguments: { argv: ['/bin/echo', 'fixture'] }, result: null } };
  tool.data.actionId = action.id;
  tool.data.output = Array.from({ length: 7 }, (_, index) => `Fixture output ${index + 1}`).join('\n');
  await emit({ type: 'live', record: tool });
  await emit({ type: 'records', records: [action], cursor: preview.snapshot.cursor + 1 });
  const actionRow = conversation.locator('.execution-entry[data-record-id="live-fixture-action"]');
  await actionRow.waitFor();
  assert.equal(await toolRow.count(), 0, 'A linked live stream becomes one action row'); checks++;
  assert.ok(await actionRow.evaluate(node => node.open), 'Linking retains the expanded execution disclosure'); checks++;
  assert.deepEqual(await chronology(), ['scroll-fixture-history', 'live-fixture-message', 'live-fixture-action']); checks++;
  assert.equal(await actionRow.locator('.execution-output').textContent(), tool.data.output.split('\n').slice(-5).join('\n')); checks++;
  tool.revision = 1; tool.data.state = 'finished'; tool.data.streaming = false;
  await emit({ type: 'settled', record: tool });
  action.revision = 2; action.updatedAt = new Date(start + 5).toISOString(); action.data.state = 'succeeded'; action.data.result = { exitCode: 0 };
  await emit({ type: 'records', records: [action], cursor: preview.snapshot.cursor + 2 });
  await actionRow.getByRole('img', { name: 'Succeeded', exact: true }).waitFor(); checks++;
  assert.ok(await actionRow.evaluate(node => node.open), 'Settling live work does not compact or collapse the inspected row'); checks++;
  await actionRow.locator('.execution-raw > summary').click();
  assert.deepEqual(JSON.parse(await actionRow.locator('.execution-raw > pre').textContent()), { arguments: action.data.arguments, result: { exitCode: 0 } }); checks++;
  assert.ok(await actionRow.getByText(tool.data.output, { exact: true }).isVisible(), 'Full linked output survives the five-line preview'); checks++;
  await emit({ type: 'live', record: { ...tool, revision: 0, data: { ...tool.data, state: 'running', streaming: true, output: 'stale tool output' } } });
  await flush();
  assert.equal(await actionRow.getByText('stale tool output', { exact: true }).count(), 0); checks++;
  assert.ok(await actionRow.getByText(tool.data.output, { exact: true }).isVisible()); checks++;
  assert.equal(await toolRow.count(), 0, 'A stale linked frame cannot create a duplicate action'); checks++;
  await assertRunByline();
  assert.equal(await page.evaluate(() => window.__mutations.length), 0, 'Reading, expanding and following history never sends mutations'); checks++;
  assert.equal(errors.length, 0, errors.join('\n')); checks++;
  mkdirSync('/tmp/outpost-ui',{ recursive: true }); await page.screenshot({ path: '/tmp/outpost-ui/live-stream-fixture.png' });
  console.log(`${checks} ${process.env.OUTPOST_TEST_LEGACY === '1' ? 'legacy' : 'bound'} live UI checks passed: grouped reasoning, chronological activity, follow controls, linked output, finalization and stale-frame protection.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
