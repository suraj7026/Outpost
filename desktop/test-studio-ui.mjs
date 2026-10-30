import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';

// Entirely synthetic IPC: no connection to Keychain, a coordinator or a provider.
const root = resolve('desktop/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://local').pathname;
  const reference = pathname.startsWith('/reference/');
  const base = reference ? resolve('mock/graphite-studies') : root;
  const path = resolve(base, (reference ? pathname.slice('/reference/'.length) : pathname.slice(1)) || 'index.html');
  if (!path.startsWith(base + '/') || !existsSync(path)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', types[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const out = '/tmp/outpost-studio-ui';
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
  ] },
  runtime: { configured: true, model: 'Synthetic model', hostAdministration: false, browserUse: false, unrestrictedCommands: false },
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
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return pointerX >= 0 && pointerX <= args.width && pointerY >= 0 && pointerY <= innerHeight;
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: scenario === 'pending', nativeSidebar: false };
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
  const windowConfig = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8')).app.windows[0];
  check(windowConfig.titleBarStyle === 'Overlay' && windowConfig.hiddenTitle === true, 'No separate native title bar or title');
  check(windowConfig.trafficLightPosition === undefined, 'Measured native traffic-light positioning is not overridden by a fixed window inset');
  for (const weight of ['Regular', 'Medium', 'Semibold']) {
    check(readFileSync(`desktop/src/assets/graphite/Geist-${weight}.ttf`).equals(readFileSync(`mock/graphite-studies/assets/Geist-${weight}.ttf`)), `Exact ${weight} font binary from mock`);
  }
  for (const scheme of ['dark', 'light']) {
    const actual = await open(1440, 'live', scheme);
    const reference = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await reference.goto(`http://127.0.0.1:${server.address().port}/reference/index.html?embed&design=studio&theme=${scheme}`);
    await reference.evaluate(() => document.fonts.ready);
    const pairs = [
      // Window corner geometry now follows the owner's native screenshots, not the initial mock.
      ['.main-shell', '.studio-main', ['backgroundColor']],
      ['.web-sidebar', '.sidebar', ['paddingTop', 'paddingRight']],
      ['.brand', '.sidebar .brand', ['fontSize', 'fontWeight', 'letterSpacing']],
      ['.new-task-button', '.new-task', ['minHeight', 'borderRadius', 'fontSize']],
      ['.task-heading', '.task-header', ['height', 'paddingLeft']],
      ['.task-title h1', '.title-left h1', ['fontSize', 'fontWeight', 'letterSpacing']],
      ['.message.assistant h2', '.agent-message h2', ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']],
      ['.reply-composer', '.composer', ['borderRadius', 'maxWidth', 'paddingTop', 'paddingLeft', 'backgroundColor']],
      ['.reply-composer textarea', '.composer textarea', ['fontSize', 'height']],
      ['.evidence-column', '.inspector', ['borderRadius', 'paddingTop', 'paddingLeft', 'backgroundColor']],
      ['.evidence-tabs button', '.evidence-tabs button', ['fontSize']],
    ];
    for (const [actualSelector, referenceSelector, properties] of pairs) {
      const styles = (element, properties) => Object.fromEntries(properties.map(key => [key, getComputedStyle(element)[key]]));
      const expected = await reference.locator(referenceSelector).first().evaluate(styles, properties);
      const received = await actual.locator(actualSelector).first().evaluate(styles, properties);
      assert.deepEqual(received, expected, `${scheme}: ${actualSelector} matches the approved mock`); checks++;
    }
    check(await actual.locator('.brand svg.outpost-mark path').count() === 3 && await actual.locator('.brand svg.outpost-mark rect, .brand img').count() === 0, 'Three-bar brand mark has no tile or box boundary');
    check(await actual.locator('.message-byline svg.outpost-mark').isVisible(), 'Three-bar mark remains visible in the assistant byline');
    check(await actual.locator('.workspace-switch').count() === 0 && await actual.getByText('Personal workspace', { exact: true }).count() === 0, 'Redundant workspace selector removed');
    check(await actual.getByText('Private workspace', { exact: true }).count() === 0, 'Redundant private-workspace footer removed');
    check(await actual.locator('.task-heading').getAttribute('data-tauri-drag-region') !== null, 'Integrated task header is a window drag region');
    await reference.close(); await actual.close();
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
    check(await page.locator('.task-title h1').evaluate(el => getComputedStyle(el).fontFamily.includes('Geist')), 'Mock font used by task header');
    check(await page.locator('.task-heading').evaluate(el => el.clientHeight) === (width <= 620 ? 57 : 65), 'Compact mock header geometry');
    if (width > 900) {
      const alignment = await page.evaluate(() => {
        const button = document.querySelector('.new-task-button').getBoundingClientRect();
        const main = document.querySelector('.main-shell').getBoundingClientRect();
        const mark = document.querySelector('.brand .outpost-mark').getBoundingClientRect();
        const navigationIcon = document.querySelector('.web-sidebar nav button svg').getBoundingClientRect();
        const task = document.querySelector('.sidebar-sessions button').getBoundingClientRect();
        return { left: button.left, right: main.left - button.right, brandLeft: mark.left, navigationLeft: navigationIcon.left, taskLeft: task.left, taskRight: task.right, buttonLeft: button.left, buttonRight: button.right };
      });
      check(Math.abs(alignment.left - alignment.right) < 1, `Sidebar gutters are visually balanced at ${width}`);
      check(Math.abs(alignment.brandLeft - alignment.navigationLeft) < 1, `Brand group is left-aligned with sidebar control padding at ${width}`);
      check(Math.abs(alignment.taskLeft - alignment.buttonLeft) < 1 && Math.abs(alignment.taskRight - alignment.buttonRight) < 1, `Task rows align with sidebar controls at ${width}`);
    }
    await page.screenshot({ path: `${out}/studio-conversation-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    check(await page.getByRole('dialog').isVisible(), `Exact action review modal at ${width}`);
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
      await page.getByRole('button', { name: 'Review', exact: true }).click();
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
    await page.close();
  }
  for (const scenario of ['preview', 'pending']) {
    const page = await open(1440, scenario);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
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
      await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
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
  await reduced.getByRole('button', { name: 'Review', exact: true }).click();
  check(await reduced.getByRole('dialog').evaluate(el => getComputedStyle(el).animationName) === 'none', 'Reduced motion disables modal animation');
  check(await reduced.locator('.action-body').first().evaluate(el => getComputedStyle(el).animationName) === 'none', 'Reduced motion disables disclosure animation');
  await reduced.close();
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} Graphite Studio checks. Synthetic screenshots: ${out}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
