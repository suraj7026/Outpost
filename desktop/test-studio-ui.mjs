import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
import { assertIconControls } from './icon-control-assertions.mjs';

// Entirely synthetic IPC: no connection to Keychain, a coordinator or a provider.
const root = resolve('desktop/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://local').pathname;
  const path = resolve(root, pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', types[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const out = process.env.OUTPOST_STUDIO_OUTPUT || '/tmp/outpost-studio-ui';
mkdirSync(out, { recursive: true });
const row = (kind, id, data) => ({ kind, id, data, revision: 3, updatedAt: '2026-10-30T09:41:00Z' });
const fixture = {
  snapshot: { cursor: 1, protocolVersion: 1, records: [
    row('task', 'task-fixture', { goal: 'Review the backup schedule', profile: 'operations', state: 'paused' }),
    row('policy', 'task-fixture', { mode: 'ask_permission' }),
    row('message', 'owner', { taskId: 'task-fixture', author: 'owner', text: 'Inspect the nightly backup and prepare a safe schedule change. Ask before changing anything.' }),
    row('message', 'assistant', { taskId: 'task-fixture', author: 'assistant', text: '## The backup is healthy.\nThe schedule needs more room. The inspection is complete and a proposed change is ready for your review.\n\nThis is synthetic test content, not a live server observation.' }),
    row('action', 'success', { taskId: 'task-fixture', state: 'succeeded', tool: 'file.read', arguments: { path: 'backup.timer' }, result: { exitCode: 0, stdout: 'Synthetic fixture' } }),
    row('action', 'failure', { taskId: 'task-fixture', state: 'succeeded', tool: 'command.run', arguments: { argv: ['false'] }, result: { exitCode: 1, stderr: 'Synthetic failure' } }),
    row('action', 'pending', { taskId: 'task-fixture', state: 'pending', tool: 'file.write', target: 'backup.timer', nonce: 'fixture-nonce', actionDigest: 'fixture-digest', arguments: { path: 'backup.timer', content: 'OnCalendar=*-*-* 02:30:00' } }),
    row('artifact', 'report', { taskId: 'task-fixture', name: 'backup-review.md', mime: 'text/markdown', hash: 'fixture' }),
    row('automation', 'schedule', { title: 'Synthetic nightly schedule', enabled: true }),
    row('memory', 'note', { title: 'Synthetic workspace note', text: 'Fixture only; no live workspace data.' }),
  ] },
  runtime: { configured: true, model: 'Synthetic model', hostAdministration: false, browserDirect: false, browserEngine: null, unrestrictedCommands: false },
  models: { models: [], defaultModel: '' },
};
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const errors = [];
async function open(width, scenario = 'live', colorScheme = 'dark', reducedMotion = 'no-preference') {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ fixture, scenario }) => {
    window.__requests = [];
    if (scenario.startsWith('cloud-')) {
      fixture.runtime.model = 'local:latest';
      fixture.models = { models: scenario === 'cloud-empty' ? ['local:latest'] : ['local:latest', 'alpha:cloud', 'beta:120b-cloud', 'alpha:cloud', 'custom-cloud:latest'], defaultModel: 'local:latest' };
    }
    if (scenario === 'preview') { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; return; }
    let sequence = 0, pointerX = -1, pointerY = -1;
    document.addEventListener('pointermove', event => { pointerX = event.clientX; pointerY = event.clientY; });
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'disconnect') return;
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return pointerX >= 0 && pointerX <= args.width && pointerY >= 0 && pointerY <= innerHeight;
        if (command === 'connection_info') return { endpoint: 'https://studio-server.example:8443', deviceId: 'fixture', publicKey: '', pending: scenario === 'pending', nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'snapshot') return structuredClone(fixture.snapshot);
          if (args.kind === 'runtime') return fixture.runtime;
          if (args.kind === 'models') {
            if (scenario === 'cloud-failure') throw new Error('Synthetic catalogue unavailable');
            return fixture.models;
          }
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 1 };
        }
        if (command === 'stream_events') return new Promise(() => {});
        if (command === 'update_sidebar' || command.startsWith('plugin:event|')) return 1;
        window.__requests.push({ command, args });
        if (command === 'send_command' && args.kind === 'approval.decide') {
          const row = fixture.snapshot.records.find(row => row.id === args.id && row.kind === 'action');
          row.revision++;
          row.data.state = args.payload.decision === 'approve' ? 'authorized' : 'denied';
          return structuredClone(row);
        }
        if (command === 'send_command' && args.kind === 'task.create') {
          const row = { kind: 'task', id: args.id, revision: 1, updatedAt: new Date().toISOString(), data: { ...args.payload, state: 'running' } };
          fixture.snapshot.records.push(row);
          return row;
        }
        throw new Error('Unexpected mutation in Studio fixture');
      },
    };
  }, { fixture, scenario });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}
try {
  for (const width of [1440, 768, 390]) for (const scheme of ['dark', 'light']) {
    const page = await open(width, 'live', scheme, 'reduce');
    const reveal = async () => {
      if (await page.locator('#app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
      await page.locator('#app-sidebar[data-motion="open"]').waitFor();
    };
    await reveal();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await page.screenshot({ path: `${out}/navigation-${width}-${scheme}-${engine.name()}.png` });
    const labels = await nav.locator('button').evaluateAll(buttons => buttons.map(button => [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()));
    assert.deepEqual(labels, ['Tasks', 'Approvals', 'Machines', 'Library', 'Automations', 'Memory', 'All chats']); checks++;
    check(await page.locator('.workspace-tools').count() === 0 && await page.getByText('Workspace tools', { exact: true }).count() === 0, 'Obsolete Workspace tools disclosure is removed');
    for (const name of ['Automations', 'Memory']) check(await page.getByRole('button', { name, exact: true }).count() === 1, `${name} appears once in the sidebar`);
    await nav.getByRole('button', { name: 'Library', exact: true }).focus();
    for (const name of ['Automations', 'Memory', 'All chats']) {
      const next = nav.getByRole('button', { name, exact: true });
      const restingFocus = await next.evaluate(node => ({ fill: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).border, shadow: getComputedStyle(node).boxShadow }));
      // macOS WebKit uses Option-Tab to include buttons in sequential keyboard navigation.
      await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
      const focus = await next.evaluate(node => ({ active: node === document.activeElement, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, fill: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).border, shadow: getComputedStyle(node).boxShadow, focused: document.activeElement?.textContent }));
      check(focus.active && focus.visible && focus.outline === 'none' && focus.fill !== restingFocus.fill && focus.border === restingFocus.border && focus.shadow === restingFocus.shadow, `${width}: ${name} is next in the visible keyboard order with non-border filled focus: ${JSON.stringify({ restingFocus, focus })}`);
    }
    for (const [name, record, other] of [['Automations', 'Synthetic nightly schedule', 'Synthetic workspace note'], ['Memory', 'Synthetic workspace note', 'Synthetic nightly schedule']]) {
      await nav.getByRole('button', { name, exact: true }).press('Enter');
      await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
      check(await page.getByRole('heading', { name: record, exact: true }).isVisible(), `${name} retains its existing server records`);
      check(await page.getByRole('heading', { name: other, exact: true }).count() === 0, `${name} does not show the other destination's records`);
      if (width <= 780) check(await page.locator('#app-sidebar').getAttribute('aria-hidden') === 'true', 'Narrow navigation dismisses after selection');
      await reveal();
      check(await nav.locator('[aria-current="page"]').textContent() === name, `${name} gets the same active state as the main destinations`);
      await page.screenshot({ path: `${out}/navigation-${name.toLowerCase()}-${width}-${scheme}-${engine.name()}.png` });
    }
    await nav.getByRole('button', { name: 'All chats', exact: true }).click();
    await page.getByRole('heading', { name: 'All chats', exact: true }).waitFor();
    if (width <= 780) await page.locator('#app-sidebar[aria-hidden="true"]').waitFor({ state: 'attached' });
    await reveal();
    await nav.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Automations', exact: true }).waitFor();
    check(await page.getByRole('heading', { name: 'All chats', exact: true }).count() === 0, 'Main navigation exits All chats without changing ownership');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Navigation has no horizontal overflow at ${width}`);
    check((await page.evaluate(() => window.__requests)).length === 0, 'Browsing Automations and Memory issues no mutations');
    await page.close();
  }
  const windowConfig = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8')).app.windows[0];
  check(windowConfig.titleBarStyle === 'Overlay' && windowConfig.hiddenTitle === true, 'No separate native title bar or title');
  check(windowConfig.trafficLightPosition === undefined, 'Measured native traffic-light positioning is not overridden by a fixed window inset');
  for (const family of ['GoogleSansFlex', 'GoogleSans', 'GoogleSans-Italic']) {
    check(readFileSync(`desktop/src/assets/fonts/${family}.woff2`).subarray(0, 4).toString() === 'wOF2', `${family} is bundled locally as WOFF2`);
  }
  for (const scheme of ['dark', 'light']) {
    const actual = await open(1440, 'live', scheme);
    // Fixed Studio expectations from styles.css/studio.css, cross-checked against
    // the approved baseline; do not derive expected values from the page under test.
    const expectedStyles = [
      ['.main-shell', { backgroundColor: scheme === 'dark' ? 'rgb(22, 23, 26)' : 'rgb(250, 250, 250)' }],
      ['.web-sidebar', { paddingTop: '15px', paddingRight: '16px' }],
      ['.new-task-button', { minHeight: '38px', borderRadius: '8px', fontSize: '13px' }],
      ['.message.assistant h2', { fontSize: '26px', fontWeight: '500', lineHeight: '32.5px', letterSpacing: '-0.8px' }],
      ['.evidence-column', { borderRadius: '14px', paddingTop: '19px', paddingLeft: '18px', backgroundColor: scheme === 'dark' ? 'rgb(15, 16, 17)' : 'rgb(240, 241, 242)' }],
      ['.evidence-tabs button', { fontSize: '11px' }],
    ];
    for (const [selector, expected] of expectedStyles) {
      const received = await actual.locator(selector).first().evaluate((element, properties) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(properties.map(key => [key, style[key]]));
      }, Object.keys(expected));
      assert.deepEqual(received, expected, `${scheme}: ${selector} matches the approved Studio styles`); checks++;
    }
    check(await actual.locator('#app-sidebar .brand').count() === 0, 'Sidebar brand is removed from the DOM');
    const byline = actual.locator('.conversation-run > .run-byline.message-byline');
    check(await byline.count() === 1, 'Assistant run has one direct avatar byline');
    check(await byline.locator(':scope > .message-avatar.assistant-avatar svg.outpost-mark path').count() === 3 && await byline.locator('svg.outpost-mark rect, img').count() === 0, 'Assistant avatar retains the unboxed three-bar Outpost mark');
    check(await byline.locator(':scope > span:not(.message-avatar)').textContent() === 'Outpost' && await byline.locator(':scope > time').count() === 1, 'Assistant byline includes its name and timestamp');
    check(await actual.locator('.conversation-run > .run-content .message-byline').count() === 0, 'Assistant chunks do not repeat the run byline');
    check(await actual.locator('.workspace-switch').count() === 0 && await actual.getByText('Personal workspace', { exact: true }).count() === 0, 'Redundant workspace selector removed');
    check(await actual.getByText('Private workspace', { exact: true }).count() === 0, 'Redundant private-workspace footer removed');
    check(await actual.locator('.topbar, .task-heading, .task-title').count() === 0, 'Global/task headers are absent from the DOM, not hidden');
    check(await actual.locator('.app-shell[data-tauri-drag-region]').count() === 1, 'Existing app inset remains a window drag region without a new header');
    check(await actual.locator('.composer-context[data-tauri-drag-region]').count() === 1, 'Existing composer context remains a window drag region');
    checks += await assertIconControls(actual);
    check(await actual.locator('.web-sidebar nav button > svg').evaluateAll(icons => icons.length === 7 && icons.every(icon => getComputedStyle(icon).backgroundColor === 'rgba(0, 0, 0, 0)')), 'Navigation icons remain unboxed beside labels');
    const action = actual.getByRole('button', { name: 'Resume task', exact: true });
    const resting = await action.evaluate(el => getComputedStyle(el).backgroundColor);
    await action.hover();
    await actual.waitForTimeout(180);
    check(await action.evaluate(el => getComputedStyle(el).backgroundColor) !== resting, `${scheme}: round actions have hover feedback`);
    await actual.mouse.move(1430, 890);
    await actual.waitForTimeout(180);
    const restingFocus = await action.evaluate(el => ({ border: getComputedStyle(el).border, shadow: getComputedStyle(el).boxShadow }));
    await actual.keyboard.press('Tab');
    await action.focus();
    await actual.waitForTimeout(180);
    const focus = await action.evaluate(el => ({ active: el === document.activeElement, visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle, fill: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).border, shadow: getComputedStyle(el).boxShadow }));
    check(focus.active && focus.visible && focus.outline === 'none' && focus.fill !== resting && focus.border === restingFocus.border && focus.shadow === restingFocus.shadow, `${scheme}: keyboard focus remains visible through non-border fill: ${JSON.stringify({ resting, restingFocus, focus })}`);
    await actual.close();
  }
  for (const width of [1440, 1050, 900, 768, 390]) {
    const page = await open(width);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}`);
    const inset = width <= 780 ? 8 : 12;
    const frame = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      const style = getComputedStyle(shell);
      const main = document.querySelector('.main-shell').getBoundingClientRect();
      const sidebar = document.querySelector('.web-sidebar').getBoundingClientRect();
      const composer = document.querySelector('.reply-composer').getBoundingClientRect();
      const evidence = document.querySelector('.evidence-column').getBoundingClientRect();
      return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], top: main.top, right: innerWidth - main.right, bottom: innerHeight - main.bottom, left: innerWidth > 780 ? sidebar.left : main.left, composerBottom: main.bottom - composer.bottom, evidenceBottom: main.bottom - evidence.bottom, pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
    });
    check(frame.padding.every(value => value === `${inset}px`), `Equal shell padding on all sides at ${width}`);
    check([frame.top, frame.right, frame.bottom, frame.left].every(value => Math.abs(value - inset) < 1), `Actual workspace frame keeps the inset at ${width}`);
    check(Math.abs(frame.composerBottom - 12) < 1, `Composer has a consistent 12px bottom inset at ${width}`);
    check(frame.pageHeight <= frame.viewportHeight, `No clipped or overflowing page bottom at ${width}`);
    if (width > 780) check(Math.abs(frame.evidenceBottom - frame.composerBottom) < 1, `Evidence and composer share a bottom baseline at ${width}`);
    check(await page.locator('.topbar, .task-heading, .task-title').count() === 0, 'Removed header has no DOM at any viewport');
    check(await page.getByRole('heading', { name: 'Review the backup schedule', level: 1, exact: true }).count() === 1, 'Task retains its accessible heading without a visible title bar');
    check(await page.locator('.task-view > h1').evaluate(el => { const box = el.getBoundingClientRect(); return getComputedStyle(el).position === 'absolute' && box.width <= 1 && box.height <= 1; }), 'Accessible task heading reserves no layout space');
    check(await page.locator('.conversation').evaluate(el => { const gap = el.getBoundingClientRect().top - document.querySelector('.main-shell').getBoundingClientRect().top; return gap >= 0 && gap <= 32; }), 'Conversation starts at workspace top with normal padding, not a 66px header row');
    const run = page.locator('.conversation-run');
    check(await run.locator(':scope > .run-byline.message-byline').count() === 1, `One direct assistant byline at ${width}`);
    check(await run.evaluate(node => {
      const byline = node.querySelector(':scope > .run-byline.message-byline');
      return node.firstElementChild === byline && byline.nextElementSibling?.matches('.run-content');
    }), `Run content follows its avatar byline at ${width}`);
    check(await run.locator(':scope > .run-content').evaluate(node => getComputedStyle(node).marginLeft) === `${width <= 620 ? 40 : 48}px`, `Assistant content has the responsive avatar inset at ${width}`);
    const owner = page.locator('.conversation .owner');
    check(await owner.locator(':scope > .message-avatar.owner-avatar').count() === 1, `Owner has a direct avatar at ${width}`);
    check(await owner.locator(':scope > .owner-content > .message-byline > span').textContent() === 'You' && await owner.locator(':scope > .owner-content > .message-byline > time').count() === 1, `Owner content retains its name and timestamp at ${width}`);
    check(await owner.evaluate(node => {
      const avatar = node.querySelector(':scope > .message-avatar.owner-avatar');
      const content = node.querySelector(':scope > .owner-content');
      const markdown = content.querySelector('.message-markdown');
      return avatar.getBoundingClientRect().left >= content.getBoundingClientRect().right - 1
        && getComputedStyle(markdown).textAlign === 'right'
        && [node, content, markdown].every(element => {
          const style = getComputedStyle(element);
          return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none' && style.boxShadow === 'none';
        });
    }), `Owner avatar sits right of plain, right-aligned bubble-free text at ${width}`);
    if (width > 900) {
      const alignment = await page.evaluate(() => {
        const button = document.querySelector('.new-task-button').getBoundingClientRect();
        const main = document.querySelector('.main-shell').getBoundingClientRect();
        const task = document.querySelector('.sidebar-sessions button').getBoundingClientRect();
        return { left: button.left, right: main.left - button.right, taskLeft: task.left, taskRight: task.right, buttonLeft: button.left, buttonRight: button.right };
      });
      check(Math.abs(alignment.left - alignment.right) < 1, `Sidebar gutters are visually balanced at ${width}`);
      check(Math.abs(alignment.taskLeft - alignment.buttonLeft) < 1 && Math.abs(alignment.taskRight - alignment.buttonRight) < 1, `Task rows align with sidebar controls at ${width}`);
    }
    check(await page.locator('.reply-composer-stack .environment-navigation > span').first().textContent() === 'studio-server.example', `Session composer shows the server hostname at ${width}`);
    check(await page.locator('.web-sidebar .environment-navigation').count() === 0, 'Environment block is no longer in the sidebar');
    check(await page.getByLabel('Environment', { exact: true }).count() === 0, 'Chat ownership is a label, not a global environment picker');
    const composerGeometry = await page.evaluate(() => {
      const stack = document.querySelector('.reply-composer-stack');
      const context = stack.querySelector('.composer-context').getBoundingClientRect();
      const composer = stack.querySelector('.reply-composer');
      const box = composer.getBoundingClientRect();
      return { radius: parseFloat(getComputedStyle(composer).borderRadius), attached: context.bottom > box.top && context.top < box.top, inset: context.left > box.left && context.right < box.right,
        contained: [...stack.querySelectorAll('textarea, button, select')].every(el => { const rect = el.getBoundingClientRect(); return rect.left >= box.left && rect.right <= box.right + 1; }) };
    });
    check(composerGeometry.radius >= 24 && composerGeometry.attached && composerGeometry.inset, `Rounded input overlaps an inset server bar at ${width}`);
    check(composerGeometry.contained, `Session composer controls stay inside the input width at ${width}`);
    checks += await assertIconControls(page);
    await page.screenshot({ path: `${out}/studio-conversation-${width}.png`, fullPage: true });
    await page.locator('.composer-run-status').getByRole('button', { name: 'Review (1)', exact: true }).click();
    check(await page.getByRole('dialog').isVisible(), `Exact action review modal at ${width}`);
    checks += await assertIconControls(page, '.action-review-dialog');
    check(await page.getByRole('dialog').locator('.action[data-state="pending"]').isVisible(), `Pending action visible at ${width}`);
    check(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog'))), `Review owns keyboard focus at ${width}`);
    await page.getByRole('button', { name: 'Close review' }).press('Escape');
    check(!await page.getByRole('dialog').isVisible(), 'Escape closes review without dispatch');
    if (width <= 780) await page.getByRole('button', { name: /^Evidence \(/ }).click();
    check(await page.locator('.handoff-step').count() === 3, 'Actual action records form the handoff');
    check(await page.locator('.handoff-step.failed').count() === 1, 'Nonzero exit code is not shown as success');
    check(await page.locator('.artifact-row').filter({ hasText: 'backup-review.md' }).isVisible(), 'Artifact accessible');
    await page.getByRole('tab', { name: 'Overview', exact: true }).press('ArrowRight');
    check(await page.getByRole('tab', { name: 'Changes', exact: true }).getAttribute('aria-selected') === 'true', 'Arrow-key tab navigation');
    await page.getByRole('tab', { name: 'Changes', exact: true }).press('End');
    check(await page.getByRole('tab', { name: 'Activity', exact: true }).getAttribute('aria-selected') === 'true', 'End selects activity');
    check(await page.locator('.action').count() === 3, 'All audit records remain available');
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    check(await page.getByRole('button', { name: /^(Hide|Show|Close) evidence$/ }).count() === 0, 'Both Evidence visibility controls are removed');
    check(await page.locator('.inspector-title button, .inspector-collapsed').count() === 0, 'No duplicate control or collapsed-state class remains');
    if (width > 780) {
      check(await page.locator('#task-evidence').isVisible(), 'Evidence is permanently visible on desktop');
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
      check(await page.locator('#task-evidence').isVisible(), 'Evidence stays visible when the navigation sidebar collapses');
      await page.keyboard.press('Meta+b');
      await page.getByRole('button', { name: 'Pin sidebar', exact: true }).click();
      check(await page.locator('#task-evidence').isVisible(), 'Evidence stays visible when the navigation sidebar is pinned');
    }
    if (width === 1440) {
      await page.reload();
      await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
      check(await page.locator('#task-evidence').isVisible(), 'Evidence remains present after app reload');
    }
    await page.screenshot({ path: `${out}/studio-${width}.png`, fullPage: true });
    if (width === 1440) {
      await page.locator('.composer-run-status').getByRole('button', { name: 'Review (1)', exact: true }).click();
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      const requests = await page.evaluate(() => window.__requests);
      assert.deepEqual(requests, [{ command: 'send_command', args: { kind: 'approval.decide', id: 'pending', revision: 3, payload: { nonce: 'fixture-nonce', actionDigest: 'fixture-digest', decision: 'approve' } } }]); checks++;
      await page.getByRole('dialog').getByRole('status').waitFor();
      check(await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).count() === 0, 'Changed action revision cannot be approved from stale review');
      await page.getByRole('button', { name: 'Close review' }).click();
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      check(await page.getByRole('button', { name: 'Run approved action' }).isVisible(), 'Explicit dispatch preserved');
      check(await page.locator('.review-handoff').count() === 0, 'Review banner disappears only after state update');
    }
    await page.keyboard.press('Meta+n');
    await page.getByLabel('Task goal', { exact: true }).waitFor();
    check(await page.locator('.composer-stack .new-task-server summary').textContent() === 'Run on studio-server.example', `New-task composer shows the same server at ${width}`);
    check(await page.locator('.composer-stack .composer-context').isVisible(), `New-task context bar visible at ${width}`);
    checks += await assertIconControls(page);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `New-task page has no horizontal overflow at ${width}`);
    await page.screenshot({ path: `${out}/studio-new-task-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Composer connection settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Models & providers', exact: true }).waitFor();
    check(await page.getByLabel('Environment', { exact: true }).count() === 0, 'Server settings use explicit navigation, never a global selector');
    await page.close();
  }
  for (const scenario of ['preview', 'pending']) {
    const page = await open(1440, scenario);
    await page.locator('.composer-run-status').getByRole('button', { name: 'Review (1)', exact: true }).click();
    check(await page.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), `${scenario}: approval blocked`);
    check(await page.getByRole('button', { name: 'Deny', exact: true }).isDisabled(), `${scenario}: denial blocked`);
    await page.getByRole('button', { name: 'Close review' }).click();
    check(await page.getByRole('button', { name: 'Resume task', exact: true }).isDisabled(), `${scenario}: resume blocked`);
    check(await page.getByRole('combobox', { name: 'Task control mode' }).isDisabled(), `${scenario}: policy change blocked`);
    await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Must not dispatch');
    await page.getByRole('textbox', { name: 'Message Outpost' }).press('Meta+Enter');
    check((await page.evaluate(() => window.__requests)).length === 0, `${scenario}: shortcut dispatch blocked`);
    await page.close();
  }
  for (const scenario of ['cloud-mixed', 'cloud-empty', 'cloud-failure']) {
    const page = await open(1440, scenario);
    await page.getByRole('button', { name: /New task/ }).click();
    const picker = page.getByRole('combobox', { name: 'Ollama model', exact: true });
    await page.getByRole('textbox', { name: 'Task goal' }).fill('Synthetic cloud model selection');
    if (scenario === 'cloud-mixed') {
      assert.deepEqual(await picker.locator('option').allTextContents(), ['alpha:cloud', 'beta:120b-cloud']); checks++;
      check(await picker.inputValue() === 'alpha:cloud', 'Local server default is never an implicit option');
      await picker.selectOption('beta:120b-cloud');
      await page.getByRole('button', { name: 'Start task', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
      const sent = await page.evaluate(() => window.__requests.filter(request => request.args?.kind === 'task.create'));
      check(sent.length === 1 && sent[0].args.payload.model === 'beta:120b-cloud', 'Exact cloud model is sent explicitly');
      await page.getByRole('button', { name: 'Composer connection settings', exact: true }).click();
      assert.deepEqual(await page.locator('.model-list > div > span:first-child').allTextContents(), ['alpha:cloud', 'beta:120b-cloud']); checks++;
    } else {
      check(await picker.isDisabled(), `${scenario}: no selectable local fallback`);
      check(await page.getByRole('button', { name: 'Start task', exact: true }).isDisabled(), `${scenario}: new task blocked`);
      await page.getByRole('textbox', { name: 'Task goal' }).press('Meta+Enter');
      check((await page.evaluate(() => window.__requests)).length === 0, `${scenario}: keyboard shortcut also blocked`);
    }
    await page.close();
  }
  const light = await open(1440, 'live', 'light');
  check(await light.locator('html').evaluate(el => getComputedStyle(el).color) === 'rgb(32, 33, 37)', 'Light-theme ink');
  await light.screenshot({ path: `${out}/studio-light.png` });
  await light.close();
  const reduced = await open(1440, 'live', 'dark', 'reduce');
  await reduced.locator('.composer-run-status').getByRole('button', { name: 'Review (1)', exact: true }).click();
  check(await reduced.getByRole('dialog').evaluate(el => getComputedStyle(el).animationName) === 'none', 'Reduced motion disables modal animation');
  check(await reduced.locator('.action-body').first().evaluate(el => getComputedStyle(el).animationName) === 'none', 'Reduced motion disables disclosure animation');
  await reduced.close();
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} Graphite Studio checks. Synthetic screenshots: ${out}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
