import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium, webkit } from 'playwright';

// Run from the repository root against an existing build: node desktop/test-response-controls.mjs
// Optional: OUTPOST_TEST_BROWSER=chromium|webkit, OUTPOST_TEST_FILTER=<case substring>, OUTPOST_TEST_SCREENSHOTS=<directory>, OUTPOST_TEST_DIST=<built directory>.
// All server traffic is synthetic native IPC; this suite neither builds nor contacts a server.
const root = resolve(process.env.OUTPOST_TEST_DIST ?? 'desktop/dist');
assert.ok(existsSync(resolve(root, 'index.html')), 'Build desktop/dist before running from the repository root');
const engines = process.env.OUTPOST_TEST_BROWSER ? [({ chromium, webkit })[process.env.OUTPOST_TEST_BROWSER]] : [chromium, webkit];
assert.ok(engines.every(Boolean), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'response-controls-task';
const revision = 41;
const confirmationText = 'Cancel this task? Completed changes will not be undone.';
const epoch = Date.parse('2026-11-15T12:00:00Z');
const row = (kind, id, data, version = 1, second = 0) => ({ kind, id, data, revision: version, updatedAt: new Date(epoch + second * 1000).toISOString() });
function fixture(options) {
  const models = options.noModels ? [] : [
    { providerId: 'fixture-provider', modelId: 'initial-model', name: 'Initial fixture model', reasoning: false },
    { providerId: 'other-provider', modelId: 'selected-model', name: 'Selected fixture model', reasoning: false },
  ];
  return {
    cursor: 1, pending: !!options.pending, pendingError: options.pendingError ?? null, managed: !!options.managed,
    records: [
      row('task', taskId, { goal: 'Response controls fixture', profile: 'code', state: options.state ?? 'running', provider: 'fixture-provider', model: 'initial-model' }, revision),
      row('message', 'history', { taskId, author: 'assistant', streaming: true,
        text: Array.from({ length: 40 }, (_, i) => `Synthetic paragraph ${i + 1}. Previously observed output remains readable while the task is active.`).join('\n\n') }, 1, 1),
    ],
    catalogue: { protocolVersion: 1, piVersion: 'fixture', profilePath: '/synthetic', generation: '1', providers: [], models,
      defaultModel: models[0] ?? null, refreshedAt: epoch, refreshErrors: [], capabilities: { providerPackages: false, callbackRelay: false } },
  };
}

// Keep this local: the existing native transport harnesses are auto-running test scripts.
function installTransport({ owner, state }) {
  const callbacks = new Map();
  let sequence = 0, stream;
  const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: owner, environments: {
    [owner]: { environmentId: owner, label: 'Response fixture', activeRoute: 'https://response.invalid', routes: ['https://response.invalid'] },
  } };
  const control = window.__responseControls = {
    state, commands: [], unexpected: [], hold: false, releases: [],
    emit(record) {
      state.records = [...state.records.filter(item => item.kind !== record.kind || item.id !== record.id), record];
      state.cursor++;
      if (!stream) throw new Error('Fixture stream is not ready');
      callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'records', records: [record], cursor: state.cursor } });
    },
    taskState(nextState) {
      const record = structuredClone(state.records.find(item => item.kind === 'task'));
      record.revision++;
      record.data.state = nextState;
      this.emit(record);
    },
    offline() { state.offline = true; stream.resolve(); },
    release() { this.hold = false; this.releases.splice(0).forEach(resolve => resolve()); },
  };
  const unexpected = message => { control.unexpected.push(message); throw new Error(message); };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(wireCommand, args = {}) {
      if (wireCommand === 'plugin:window|set_theme' && args.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
      if (['set_sidebar_window_controls', 'set_window_blur', 'update_sidebar'].includes(wireCommand)) return;
      if (wireCommand === 'sidebar_pointer_inside') return false;
      if (wireCommand.startsWith('plugin:event|')) return 1;
      if (wireCommand === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: null, pending: false } };
      if (wireCommand === 'setup_list') return [];
      if (wireCommand === 'connection_info') return { endpoint: null, pending: false, nativeSidebar: false };
      if (wireCommand === 'disconnect') return;
      if (!wireCommand.startsWith('environment_') || args.environmentId !== owner) return unexpected(`Unscoped or wrong-owner IPC: ${wireCommand}`);
      const command = wireCommand.slice('environment_'.length);
      if (command === 'disconnect') { stream?.resolve(); stream = undefined; return; }
      if (command === 'connection_info') return { environmentId: owner, endpoint: 'https://response.invalid', deviceId: 'synthetic', publicKey: '', pending: state.pending, pendingError: state.pendingError, nativeSidebar: false };
      if (command === 'query') {
        if (state.offline) throw new Error('Synthetic offline owner');
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
        if (args.kind === 'runtime') return { configured: true, model: 'initial-model', piManagement: state.managed, browserDirect: false, hostAdministration: false };
        if (args.kind === 'models') return { models: ['initial-model'], defaultModel: 'initial-model' };
        if (args.kind === 'events') return { events: [], nextCursor: state.cursor, hasMore: false };
      }
      if (command === 'agent_request' && state.managed && args.payload.type === 'catalogue') return structuredClone(state.catalogue);
      if (command === 'stream_events') return new Promise(resolve => {
        stream = { channel: args.channel, index: 0, resolve };
        callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [] } });
        state.ready = true;
      });
      if (command === 'send_command') {
        control.commands.push({ command: wireCommand, args: structuredClone(args) });
        if (state.offline || state.pending || state.pendingError) return unexpected('Mutation escaped read-only guard');
        if (!['task.cancel', 'task.steer'].includes(args.kind)) return unexpected(`Unexpected mutation: ${args.kind}`);
        const previous = state.records.find(record => record.kind === 'task' && record.id === args.id);
        if (!previous || previous.revision !== args.revision) return unexpected('Wrong task or revision');
        if (control.hold) await new Promise(resolve => control.releases.push(resolve));
        const next = structuredClone(previous);
        next.revision++;
        if (args.kind === 'task.cancel') next.data.state = 'cancelled';
        state.records = state.records.map(record => record === previous ? next : record);
        state.cursor++;
        return next;
      }
      return unexpected(`Unexpected IPC: ${wireCommand}`);
    },
  };
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const path = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (request.method !== 'GET' || !path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
  response.setHeader('content-type', mime[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.env.OUTPOST_TEST_SCREENSHOTS;
if (screenshots) mkdirSync(screenshots, { recursive: true });
let browser, cases = 0, checks = 0;
const failures = [];
const deadline = setTimeout(() => { console.error('Response-controls suite exceeded 240 seconds'); process.exitCode = 1; void browser?.close(); server.closeAllConnections(); server.close(); }, 240_000);
deadline.unref();
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const input = page => page.getByRole('textbox', { name: 'Message Outpost', exact: true });
const bottom = page => page.locator('.reply-composer .send-button');
const upper = page => page.locator('.composer-run-stop');
const commands = page => page.evaluate(() => window.__responseControls.commands);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const expectedCommand = (kind, payload = {}, version = revision) => ({ command: 'environment_send_command', args: { environmentId: owner, kind, id: taskId, revision: version, payload } });
const waitAction = (page, action) => page.waitForFunction(action => document.querySelector('.reply-composer .send-button')?.dataset.action === action, action);
const color = value => value.match(/[\d.]+/g)?.map(Number) ?? [];
const red = value => { const [r, g, b, a = 1] = color(value); return r > g * 1.2 && r > b * 1.2 && a > 0; };
const badge = page => page.locator('.composer-follow').evaluate(node => {
  const style = getComputedStyle(node, '::after');
  return !['none', 'normal'].includes(style.content) && style.display !== 'none' && Number(style.opacity) > 0 && parseFloat(style.width) > 0 && parseFloat(style.height) > 0;
});
async function noDispatch(page, dialogs, expected = []) {
  await frames(page);
  equal(await commands(page), expected, 'No unintended command dispatch');
  equal(dialogs, [], 'Guarded actions and sending do not open cancellation confirmation');
}
async function statusMark(page, active, reduced = false) {
  const mark = page.locator('.composer-run-mark');
  equal(await mark.getAttribute('data-active'), String(active), 'Status activity is explicit and independent of draft');
  const style = await mark.evaluate(node => {
    const s = getComputedStyle(node);
    return { width: s.width, height: s.height, animation: s.animationName, duration: s.animationDuration, playState: s.animationPlayState, background: s.backgroundColor };
  });
  if (active) {
    equal([style.width, style.height], ['14px', '14px'], 'Active status uses a 14px spinner');
    if (reduced) check(style.animation === 'none' || style.playState === 'paused' || style.duration.split(',').every(value => parseFloat(value) <= 0.001), 'Reduced motion suppresses spinner rotation');
    else check(style.animation !== 'none' && parseFloat(style.duration) > 0, 'Active status animates when motion is allowed');
  } else {
    equal(style.animation, 'none', 'Review status is not a spinner');
    equal([style.width, style.height], ['6px', '6px'], 'Review retains the status dot');
    const [r, g, b] = color(style.background);
    check(r > b && g > b, `Review dot is amber: ${style.background}`);
  }
}
async function scenario(engine, name, options, run) {
  if (process.env.OUTPOST_TEST_FILTER && !name.includes(process.env.OUTPOST_TEST_FILTER)) return;
  cases++;
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: options.height ?? 900 }, colorScheme: options.scheme ?? 'dark', reducedMotion: options.reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], external = [], dialogs = [], confirmation = { accept: false };
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await (confirmation.accept ? dialog.accept() : dialog.dismiss()); });
  try {
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      external.push(request.url()); return route.abort();
    });
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
    await context.addInitScript(installTransport, { owner, state: fixture(options) });
    await page.goto(origin);
    await input(page).waitFor();
    await page.waitForFunction(() => window.__responseControls.state.ready);
    await page.evaluate(() => document.fonts.ready);
    await frames(page);
    await run(page, dialogs, confirmation);
    equal(errors, [], 'No browser runtime errors');
    equal(external, [], 'No external requests or WebSockets');
    equal(await page.evaluate(() => window.__responseControls.unexpected), [], 'Only expected scoped native IPC');
    console.log(`PASS ${engine.name()} / ${name}`);
  } catch (error) {
    failures.push(`${engine.name()} / ${name}: ${error.message.split('\n')[0]}`);
    console.error(`FAIL ${engine.name()} / ${name}\n${error.stack}`);
    console.error('FIXTURE', await page.evaluate(() => ({ commands: window.__responseControls?.commands, unexpected: window.__responseControls?.unexpected, status: document.querySelector('.composer-run-label')?.textContent, action: document.querySelector('.send-button')?.dataset.action })).catch(() => null));
    if (errors.length) console.error('PAGE ERRORS', errors);
  } finally { await context.close(); }
}

try {
  for (const engine of engines) {
    browser = await engine.launch();
    try {
      for (const options of [
        { scheme: 'dark' }, { scheme: 'light' },
        { scheme: 'dark', reduced: true, width: 600, height: 720 },
        { scheme: 'light', reduced: true, width: 600, height: 720 },
      ]) {
        await scenario(engine, `appearance-${options.scheme}-${options.reduced ? 'reduced-small' : 'motion'}`, options, async (page, dialogs) => {
          for (const draft of ['', ' \n\t ', 'Keep the current response running', '']) {
            await input(page).fill(draft);
            const hasDraft = !!draft.trim();
            await waitAction(page, hasDraft ? 'send' : 'stop');
            // The existing button palette transitions for 140ms when Send becomes Stop.
            await bottom(page).evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
            equal(await bottom(page).getAttribute('aria-label'), hasDraft ? 'Send message' : 'Stop task', 'Bottom action has the correct accessible label');
            check(await bottom(page).isEnabled(), 'Available primary action is enabled');
            equal(await upper(page).isVisible(), hasDraft, 'Exactly one Stop location is visible');
            equal(await page.getByRole('button', { name: 'Stop task', exact: true }).count(), 1, 'Exactly one accessible Stop task');
            await statusMark(page, true, !!options.reduced);
            check(!(await badge(page)), 'Active status alone does not badge Jump to latest');
            if (hasDraft) {
              const style = await upper(page).evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
              check(red(style.color), `Upper Stop uses muted red text: ${style.color}`);
              check((color(style.background)[3] ?? 1) < 0.3, 'Upper Stop remains a quiet transparent/tinted control');
            } else {
              check(red(await bottom(page).evaluate(node => getComputedStyle(node).backgroundColor)), 'Bottom Stop has a red background');
              const square = bottom(page).locator('svg.lucide-square');
              equal(await square.count(), 1, 'Bottom Stop uses the Square glyph');
              const fill = await square.locator('rect').evaluate(node => getComputedStyle(node).fill);
              check(fill !== 'none' && fill !== 'transparent' && (color(fill)[3] ?? 1) > 0, 'Square glyph is filled');
              await input(page).press('Control+Enter');
              await input(page).press('Meta+Enter');
            }
            if (screenshots && (draft === '' || hasDraft)) {
              await page.locator('.reply-composer-stack').screenshot({ path: resolve(screenshots, `${engine.name()}-${options.scheme}-${options.width ?? 1280}-${hasDraft ? 'typing' : 'empty'}.png`), animations: 'disabled' });
            }
            for (const selector of ['.reply-composer .send-button', '.composer-follow', '.composer-run-mark', ...(hasDraft ? ['.composer-run-stop'] : [])]) {
              const box = await page.locator(selector).boundingBox();
              const viewport = page.viewportSize();
              check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${selector} stays within the viewport`);
            }
          }
          await noDispatch(page, dialogs);
        });
      }

      await scenario(engine, 'review-dot-and-inactive-empty-send', {}, async (page, dialogs) => {
        await page.evaluate(() => window.__responseControls.emit({ kind: 'action', id: 'approval', revision: 1, updatedAt: '2026-11-15T12:00:02Z', data: { taskId: 'response-controls-task', tool: 'file.write', target: 'fixture.txt', state: 'pending', nonce: 'fixture-nonce', actionDigest: 'fixture-digest', arguments: { path: 'fixture.txt', content: 'Synthetic' } } }));
        await page.waitForFunction(() => document.querySelector('.composer-run-status')?.dataset.kind === 'review');
        for (const draft of ['', ' \n ', 'A follow-up during review']) {
          await input(page).fill(draft);
          await waitAction(page, 'send');
          equal(await bottom(page).isDisabled(), !draft.trim(), 'Review sends only nonempty drafts');
          check(await upper(page).isVisible(), 'Review retains upper Stop');
          await statusMark(page, false);
          check(!(await badge(page)), 'Review alone does not badge Jump');
          if (!draft.trim()) { await bottom(page).evaluate(node => node.click()); await input(page).press('Control+Enter'); }
        }
        await noDispatch(page, dialogs);
      });

      await scenario(engine, 'unread-only-follow-badge', {}, async (page, dialogs) => {
        check(!(await badge(page)), 'Following active output has no status badge');
        const conversation = page.locator('.conversation');
        check(await conversation.evaluate(node => node.scrollHeight > node.clientHeight), 'Fixture provides real scrollable history');
        const box = await conversation.boundingBox();
        await page.mouse.move(box.x + 50, box.y + 100);
        await page.mouse.wheel(0, -700);
        await page.waitForFunction(() => document.querySelector('.composer-follow')?.getAttribute('aria-disabled') === 'false');
        check(!(await badge(page)), 'Scrolling away alone does not create an unread badge');
        const scrollTop = await conversation.evaluate(node => node.scrollTop);
        await page.evaluate(record => window.__responseControls.emit(record), row('message', 'new-output', { taskId, author: 'assistant', streaming: true, text: 'New synthetic output.\n\n'.repeat(12) }, 1, 10));
        await page.waitForFunction(() => document.querySelector('.composer-follow')?.dataset.unseen === 'true');
        check(await badge(page), 'Unread output still has a badge');
        check(Math.abs(await conversation.evaluate(node => node.scrollTop) - scrollTop) <= 1, 'New output preserves reading position');
        check(/\d+ new/.test(await page.locator('.composer-follow').getAttribute('aria-label')), 'Unread count remains accessible');
        await page.locator('.composer-follow').click();
        await page.waitForFunction(() => document.querySelector('.composer-follow')?.dataset.unseen === 'false');
        check(!(await badge(page)), 'Jump clears unread badge even while task stays active');
        await noDispatch(page, dialogs);
      });

      for (const location of ['bottom', 'upper']) {
        await scenario(engine, `cancel-${location}-dismiss-accept`, {}, async (page, dialogs, confirmation) => {
          const draft = location === 'upper' ? 'Preserve this typed draft after cancellation' : '';
          await input(page).fill(draft);
          await waitAction(page, draft ? 'send' : 'stop');
          const stop = location === 'upper' ? upper(page) : bottom(page);
          await stop.click();
          equal(dialogs, [{ type: 'confirm', message: confirmationText }], 'Stop retains the existing cancellation confirmation');
          equal(await commands(page), [], 'Dismissing Stop never dispatches');
          equal(await input(page).inputValue(), draft, 'Dismiss preserves the draft');
          confirmation.accept = true;
          await stop.click();
          await page.waitForFunction(() => document.querySelector('.reply-composer textarea')?.disabled);
          equal(dialogs, Array.from({ length: 2 }, () => ({ type: 'confirm', message: confirmationText })), 'Both attempts use the exact confirmation');
          equal(await commands(page), [expectedCommand('task.cancel')], 'Accepted Stop dispatches existing task.cancel with the owner/task/revision and empty payload');
          equal(await input(page).inputValue(), draft, 'Cancellation preserves typed draft');
          check((await input(page).getAttribute('placeholder')).includes('This task is closed.'), 'Cancelled composer is closed');
          equal(await page.getByRole('button', { name: 'Stop task', exact: true }).count(), 0, 'Cancelled task has no accessible Stop');
          check(await bottom(page).isDisabled(), 'Closed composer cannot send');
          await bottom(page).evaluate(node => node.click());
          await upper(page).evaluate(node => node.click());
          equal(await commands(page), [expectedCommand('task.cancel')], 'Closed controls cannot dispatch a second command');
          equal(dialogs.length, 2, 'Closed controls do not ask for confirmation again');
        });
      }

      for (const managed of [false, true]) {
        await scenario(engine, `steer-${managed ? 'selected-model' : 'unmanaged'}`, { managed }, async (page, dialogs) => {
          if (managed) {
            await page.locator('.model-picker-trigger').click();
            await page.getByRole('group', { name: 'Available models' }).getByRole('button', { name: /Selected fixture model/ }).click();
          }
          await input(page).fill('  Steer the next step  \n');
          await waitAction(page, 'send');
          check(await bottom(page).isEnabled(), 'Valid draft/model enables send');
          await bottom(page).click();
          await page.waitForFunction(() => document.querySelector('.reply-composer textarea')?.value === '');
          equal(await commands(page), [expectedCommand('task.steer', { text: 'Steer the next step', ...(managed ? { modelRef: { providerId: 'other-provider', modelId: 'selected-model' } } : {}) })], 'Steer trims text and preserves selected model semantics');
          await waitAction(page, 'stop');
          check(!(await upper(page).isVisible()), 'Successful send restores bottom Stop');
          equal(dialogs, [], 'Sending never confirms cancellation');
        });
      }

      await scenario(engine, 'managed-no-model-blocks-send-not-stop', { managed: true, noModels: true }, async (page, dialogs, confirmation) => {
        await input(page).fill('No usable model');
        await waitAction(page, 'send');
        check(await bottom(page).isDisabled(), 'Missing model blocks send');
        await bottom(page).evaluate(node => node.click());
        await input(page).press('Control+Enter');
        await input(page).press('Meta+Enter');
        await noDispatch(page, dialogs);
        await input(page).fill('');
        await waitAction(page, 'stop');
        check(await bottom(page).isEnabled(), 'Missing model does not prevent stopping active work');
        confirmation.accept = true;
        await bottom(page).click();
        await page.waitForFunction(() => document.querySelector('.reply-composer textarea')?.disabled);
        equal(await commands(page), [expectedCommand('task.cancel')], 'Stop is independent of model selection');
      });

      await scenario(engine, 'busy-guards-both-stop-locations-and-send', {}, async (page, dialogs) => {
        await page.evaluate(() => { window.__responseControls.hold = true; });
        await input(page).fill('A held instruction');
        await bottom(page).click();
        await page.waitForFunction(() => window.__responseControls.releases.length === 1);
        const expected = [expectedCommand('task.steer', { text: 'A held instruction' })];
        for (const draft of ['', 'Another draft while busy']) {
          await input(page).fill(draft);
          await waitAction(page, draft ? 'send' : 'stop');
          check(await bottom(page).isDisabled(), 'Busy blocks bottom Send/Stop');
          equal(await upper(page).getAttribute('aria-disabled'), 'true', 'Busy blocks upper Stop');
          await bottom(page).evaluate(node => node.click());
          await upper(page).evaluate(node => node.click());
          await input(page).press('Control+Enter');
          await input(page).press('Meta+Enter');
          await noDispatch(page, dialogs, expected);
        }
        await page.evaluate(() => window.__responseControls.release());
        await page.waitForFunction(() => !document.querySelector('.reply-composer .send-button')?.disabled);
        await noDispatch(page, dialogs, expected);
      });

      for (const [name, options] of [
        ['pending', { pending: true }], ['pending-error', { pendingError: 'Synthetic unresolved recovery' }], ['offline', {}],
      ]) {
        await scenario(engine, `guards-${name}`, options, async (page, dialogs) => {
          if (name === 'offline') {
            await input(page).fill('Draft survives disconnection');
            await page.evaluate(() => window.__responseControls.offline());
            await page.waitForFunction(() => document.querySelector('.composer-run-label')?.textContent === 'Offline · read-only');
            equal(await input(page).inputValue(), 'Draft survives disconnection', 'Disconnection preserves draft');
          }
          for (const draft of ['', ' \n ', 'Must not dispatch']) {
            await input(page).fill(draft);
            await waitAction(page, 'send');
            check(await bottom(page).isDisabled(), `${name} gates bottom action`);
            equal(await upper(page).getAttribute('aria-disabled'), 'true', `${name} gates upper Stop`);
            await bottom(page).evaluate(node => node.click());
            await upper(page).evaluate(node => node.click());
            await input(page).press('Control+Enter');
            await input(page).press('Meta+Enter');
          }
          await noDispatch(page, dialogs);
        });
      }

      for (const state of ['completed', 'cancelled']) {
        await scenario(engine, `closed-${state}-preserves-draft`, {}, async (page, dialogs) => {
          await input(page).fill('Keep this unsent instruction');
          await page.evaluate(state => window.__responseControls.taskState(state), state);
          await page.waitForFunction(() => document.querySelector('.reply-composer textarea')?.disabled);
          equal(await input(page).inputValue(), 'Keep this unsent instruction', `${state} preserves typed draft`);
          await waitAction(page, 'send');
          check(await bottom(page).isDisabled(), `${state} cannot send`);
          equal(await page.getByRole('button', { name: 'Stop task', exact: true }).count(), 0, `${state} has no accessible Stop`);
          await bottom(page).evaluate(node => node.click());
          await upper(page).evaluate(node => node.click());
          await noDispatch(page, dialogs);
        });
      }
    } finally { await browser.close(); browser = undefined; }
  }
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
check(cases > 0, 'Filter selected at least one test case');
console.log(`${failures.length ? 'FAIL' : 'PASS'}: ${checks} checks, ${cases} cases, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
