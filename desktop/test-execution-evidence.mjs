import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';

const root = resolve('desktop/dist'), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer((req, res) => {
  const path = resolve(root, new URL(req.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch(); let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const row = (kind, id, minute, data) => ({ kind, id, revision: 1, updatedAt: `2026-10-31T05:${String(minute).padStart(2, '0')}:00Z`, data: { taskId: 'fixture-task', ...data } });
const records = [
  row('task', 'fixture-task', 0, { goal: 'Review the execution evidence', profile: 'code', state: 'verifying' }),
  row('policy', 'fixture-task', 0, { mode: 'ask_permission' }),
  row('message', 'owner', 0, { author: 'owner', text: 'Review the execution evidence' }),
  row('message', 'reasoning-one', 0, { author: 'assistant', startedAt: Date.parse('2026-10-31T05:00:10Z'), text: 'Reviewing recorded actions.', thinking: 'Inspect the first attempt.' }),
  row('message', 'reasoning-two', 0, { author: 'assistant', startedAt: Date.parse('2026-10-31T05:00:20Z'), text: 'Earlier attempts are retained.', thinking: 'Keep the failure evidence.' }),
  row('tool_stream', 'old-command', 1, { name: 'outpost_action', state: 'error', streaming: false, actionId: null, arguments: { tool: 'command.run', arguments: { command: 'pwd' } }, output: '' }),
  row('tool_stream', 'old-write', 2, { name: 'outpost_action', state: 'error', streaming: false, actionId: null, arguments: { tool: 'file.write', arguments: { path: 'MEMORY.md', text: 'Large old attempt\n'.repeat(300) } }, output: 'invalid_tool_arguments: expectedHash is required.' }),
  row('action', 'command-success', 3, { state: 'succeeded', tool: 'command.run', arguments: { argv: ['/bin/pwd'], cwd: '.' }, result: { exitCode: 0, stdout: '/synthetic/workspace' } }),
  row('tool_stream', 'linked-command', 3, { state: 'finished', streaming: false, actionId: 'command-success', arguments: { tool: 'command.run', arguments: { argv: ['/bin/pwd'] } }, output: 'Linked command stream output\nFull wrapper evidence retained.' }),
  row('action', 'nonzero', 4, { state: 'succeeded', tool: 'command.run', arguments: { argv: ['/bin/false'] }, result: { exitCode: 1 } }),
  row('action', 'write-success', 5, { state: 'succeeded', tool: 'file.write', arguments: { path: 'MEMORY.md', text: 'Verified note', expectedHash: null }, result: { path: 'MEMORY.md', hash: 'synthetic-hash' } }),
  row('action', 'read-success', 6, { state: 'succeeded', tool: 'file.read', arguments: { path: 'MEMORY.md' }, result: { text: 'Verified note' } }),
];
try {
  mkdirSync('/tmp/outpost-execution-evidence', { recursive: true });
  for (const scheme of ['dark', 'light']) for (const width of [1440, 900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(records => {
      window.isTauri = true; window.__mutations = [];
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args) {
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'disconnect') return;
        if (command === 'automatic_updates_status' || command === 'automatic_updates_tick') return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', pending: false, nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records: [...records].reverse() };
          if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud' };
          if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
          if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
        }
        if (command === 'stream_events') return new Promise(() => {});
        if (command.startsWith('plugin:')) return;
        window.__mutations.push(command); throw new Error('Unexpected mutation');
      } };
    }, records);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await openInitialTestChat(page);
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    const conversation = page.locator('.conversation');
    const entries = conversation.locator('.execution-entry');
    const expectedOrder = ['old-command', 'old-write', 'command-success', 'nonzero', 'write-success', 'read-success'];
    assert.deepEqual(await entries.evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), expectedOrder); checks++;
    check(await page.locator('#evidence-panel, .handoff-spine').count() === 0, 'Actions have one chronological home, not a split evidence panel');
    check(await conversation.locator('.conversation-run').count() === 1, 'Assistant chunks and actions share one run identity');
    const byline = conversation.locator('.conversation-run > .run-byline.message-byline');
    check(await byline.count() === 1, 'Execution evidence shares one assistant byline per run');
    check(await byline.locator(':scope > .message-avatar.assistant-avatar .outpost-mark').count() === 1, 'Run byline contains the Outpost avatar');
    check(await byline.locator(':scope > span:not(.message-avatar)').textContent() === 'Outpost', 'Run byline names Outpost');
    check(await byline.locator(':scope > time').count() === 1, 'Run byline retains its timestamp');
    check(await conversation.locator('.conversation-run > .run-content .message-byline').count() === 0, 'Execution entries do not duplicate the run byline');
    check(await conversation.getByRole('article', { name: 'Outpost response', exact: true }).count() === 1, 'Assistant run retains accessible attribution');
    check(await page.locator('.composer-run-label').textContent() === 'Ready for your review', 'Historical failed attempts do not masquerade as current activity');
    check(await entries.evaluateAll(nodes => nodes.every(node => !node.open)), 'Settled evidence starts collapsed');
    check(await conversation.locator('.live-tool.action-failed').count() === 2, 'Both failed unlinked attempts remain in the timeline');
    check(await conversation.locator('.live-tool[open]').count() === 0, 'Historical argument dumps start collapsed');
    check(await page.locator('[data-record-id="linked-command"]').count() === 0, 'Linked action and tool stream are deduplicated');
    check(await entries.locator('.execution-meta time').count() === expectedOrder.length, 'Each execution outcome retains a timestamp inside its disclosure');

    const reasoning = conversation.locator('.run-reasoning');
    check(await reasoning.count() === 1 && !await reasoning.evaluate(node => node.open), 'One reasoning group starts collapsed');
    check(await reasoning.locator('.reasoning-segments pre').count() === 2, 'Both reasoning chunks are retained in the group');
    check(!await reasoning.getByText('Inspect the first attempt.', { exact: true }).isVisible(), 'Reasoning text is not exposed until expanded');
    await reasoning.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    await reasoning.getByText('Inspect the first attempt.', { exact: true }).waitFor();
    check(await reasoning.getByText('Keep the failure evidence.', { exact: true }).isVisible(), 'Keyboard expansion reveals every reasoning segment');
    await reasoning.locator(':scope > summary').click();

    const activity = conversation.locator('.activity-group');
    check(await activity.count() === 1 && await activity.evaluate(node => node.open), 'Consecutive actions and streams share one expanded stack when failures need attention');
    assert.deepEqual(await activity.locator('.execution-entry').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), expectedOrder); checks++;
    check(await activity.locator('.activity-group-title').textContent() === 'Needs attention', 'Later successes do not hide failure evidence');
    await activity.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    check(await activity.evaluate(node => node.open), 'Keyboard collapse cannot hide a group requiring attention');
    await conversation.locator('[data-record-id="write-success"] > summary').waitFor();
    check(await conversation.getByRole('img', { name: 'Succeeded', exact: true }).count() === 3, 'Successful outcomes retain accessible success dots');
    check(await conversation.getByRole('img', { name: 'Needs review', exact: true }).count() === 1, 'Nonzero exit remains a review outcome');
    check(await conversation.getByRole('img', { name: 'Failed attempt', exact: true }).count() === 2, 'Historical failures are not rewritten');
    check((await entries.locator('.action-state').allTextContents()).every(text => text.trim() === ''), 'Settled outcomes use dots instead of visible status badges');
    const success = conversation.locator('[data-record-id="write-success"]');
    check(await success.locator('.outcome-dot').getAttribute('title') === 'Succeeded', 'Hover reveals the outcome');
    check(await success.locator('.outcome-dot').evaluate(el => {
      const expected = document.createElement('span'); expected.style.background = 'var(--positive)'; el.append(expected);
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove(); return matches;
    }), 'Success dot is green');

    const nonzero = conversation.locator('[data-record-id="nonzero"]');
    check(await nonzero.getByRole('img', { name: 'Succeeded', exact: true }).count() === 0, 'A transport succeeded state with nonzero exit is never presented as success');
    await nonzero.locator(':scope > summary').click();
    check(await nonzero.getByText('Exit code 1', { exact: true }).isVisible(), 'Failed command exposes its nonzero exit code');
    await nonzero.locator('.execution-raw > summary').click();
    assert.deepEqual(JSON.parse(await nonzero.locator('.execution-raw > pre').textContent()).result, { exitCode: 1 }); checks++;
    await nonzero.locator(':scope > summary').click();

    const old = conversation.locator('[data-record-id="old-write"]');
    await old.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    check(await old.getByText('invalid_tool_arguments: expectedHash is required.', { exact: true }).isVisible(), 'Keyboard disclosure reveals the recorded explanation');
    check(!await old.locator('.execution-raw').evaluate(node => node.open), 'Large raw arguments stay collapsed even when an attempt is opened');
    await old.locator('.execution-raw > summary').click();
    const rawAttempt = JSON.parse(await old.locator('.execution-raw > pre').textContent());
    assert.deepEqual(rawAttempt.arguments, records.find(record => record.id === 'old-write').data.arguments.arguments); checks++;
    assert.equal(rawAttempt.output, 'invalid_tool_arguments: expectedHash is required.'); checks++;
    check(await old.locator('.outcome-dot').evaluate(el => {
      const expected = document.createElement('span'); expected.style.background = 'var(--danger)'; el.append(expected);
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove(); return matches;
    }), 'Failed attempt dot is red');
    check(await old.locator('.outcome-dot').evaluate(el => getComputedStyle(el).backgroundColor) === await nonzero.locator('.outcome-dot').evaluate(el => getComputedStyle(el).backgroundColor), 'Nonzero exit uses the same red dot');
    await old.locator(':scope > summary').click();

    const emptyFailure = conversation.locator('[data-record-id="old-command"]');
    await emptyFailure.locator(':scope > summary').click();
    check(await emptyFailure.getByText('This attempt did not complete successfully. No additional error detail was recorded.', { exact: true }).isVisible(), 'An empty failed tool result is not silently dropped');
    await emptyFailure.locator(':scope > summary').click();
    const linked = conversation.locator('[data-record-id="command-success"]');
    await linked.locator(':scope > summary').click();
    check(await linked.getByRole('img', { name: 'Succeeded', exact: true }).isVisible(), 'Linked action owns its outcome');
    check(await linked.locator('.execution-output').textContent() === '/synthetic/workspace', 'Observed action output remains available');
    await linked.locator('.execution-raw > summary').click();
    await linked.getByText('Linked command stream output\nFull wrapper evidence retained.', { exact: true }).waitFor();
    check(await linked.getByText('Linked command stream output\nFull wrapper evidence retained.', { exact: true }).isVisible(), 'Deduplication retains the linked stream full output');
    await linked.locator(':scope > summary').click();

    const resourcesButton = page.getByRole('button', { name: 'Files, changes and browser', exact: true });
    await resourcesButton.click();
    await page.getByRole('complementary', { name: 'Files, changes and browser' }).waitFor();
    check(await resourcesButton.getAttribute('aria-expanded') === 'true', 'Files button opens the optional resource panel');
    check(await page.locator('#task-resources .execution-entry, #task-resources .action').count() === 0, 'Resource panel does not duplicate conversation actions');
    assert.deepEqual(await entries.evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), expectedOrder); checks++;
    await page.getByRole('button', { name: 'Close files and changes', exact: true }).click();
    check(await resourcesButton.getAttribute('aria-expanded') === 'false', 'Resource panel closes without altering the timeline');
    await activity.locator(':scope > summary').click();
    check(await activity.evaluate(node => node.open), 'Failure evidence remains visible after resource-panel interactions');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    check(await page.evaluate(() => __mutations.length) === 0, 'Viewing history never retries commands');
    check(errors.length === 0, errors.join('\n'));
    await page.screenshot({ path: `/tmp/outpost-execution-evidence/${engine.name()}-${width}-${scheme}.png` });
    await page.close();
  }
  console.log(`${checks} execution evidence checks passed (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
