import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { settingsTestAssets } from '../settings-test-navigation.mjs';
import { installUiConsistencyNative, uiConsistencyFixture, ownerA as A, ownerB as B, sharedTask, reviewAction } from '../test-fixtures/ui-consistency-native.mjs';

// OUTPOST_TEST_BROWSER=chromium|webkit node desktop/tests/test-ui-consistency.mjs
// Current src/main.tsx is bundled in memory. Never reads dist or invokes a production/native build.
const engineName = process.env.OUTPOST_TEST_BROWSER ?? 'chromium';
const engine = { chromium, webkit }[engineName];
assert.ok(engine, 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const output = '/tmp/outpost-ui-consistency';
mkdirSync(output, { recursive: true });
const started = Date.now(), results = [], failures = [];
let browser, server, origin, checks = 0;
const report = () => writeFileSync(`${output}/${engineName}-report.json`, JSON.stringify({ engine: engineName, source: 'settingsTestAssets(): actual src/main.tsx, in memory', elapsedMs: Date.now() - started, checks, failures, results }, null, 2));
const shutdown = setTimeout(() => {
  failures.push('Suite exceeded 165 seconds; closing browser before the hard deadline');
  void browser?.close();
  server?.closeAllConnections();
}, 165000);
const deadline = setTimeout(() => {
  failures.push('Hard deadline: suite exceeded 175 seconds');
  report();
  process.exit(1);
}, 175000);
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const check = (value, label) => { assert.ok(value, label); checks++; };
const near = (actual, expected, label, tolerance = 1) => check(Math.abs(actual - expected) <= tolerance, `${label}: actual ${actual}, expected ${expected} ± ${tolerance}`);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = (page, name) => page.getByRole('button', { name, exact: true });
const dialog = page => page.getByRole('dialog');
const historyRow = (page, owner, task = sharedTask) => page.locator(`.chat-server-group[data-server-id="${owner}"] button[data-task-id="${task}"]`);
const chatRow = (page, owner, task = sharedTask) => page.locator(`.workspace-chat[data-server-id="${owner}"][data-task-id="${task}"]`);
const mutations = page => page.evaluate(() => window.__uiConsistency.mutations);
async function shot(page, result, name) {
  const path = `${output}/${engineName}-${result.name}-${name}.png`;
  await page.screenshot({ path, animations: 'disabled', timeout: 4000 });
  result.screenshots.push(path);
}
async function go(page, name) {
  const target = name === 'Settings' ? button(page, name) : page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true });
  await target.click();
  await page.getByRole('heading', { name, level: 1, exact: true }).waitFor();
  await settle(page);
}
async function selectChat(page, owner = A, task = sharedTask) {
  await historyRow(page, owner, task).click();
  await page.waitForFunction(owner => document.querySelector('.main-shell')?.dataset.ownerId === owner, owner);
  await page.locator('.task-workspace-heading h1').waitFor();
  await settle(page);
}
async function openReview(page, owner = A) {
  await selectChat(page, owner);
  await page.locator('.task-workspace-heading .task-attention-indicator').click();
  await page.getByRole('dialog', { name: 'Review the exact action', exact: true }).waitFor();
  await settle(page);
}
async function metric(locator) {
  return locator.evaluate(element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    const rgba = color => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
      background: rgba(s.backgroundColor), foreground: rgba(s.color), border: rgba(s.borderTopColor),
      radius: s.borderRadius, font: s.fontSize, shadow: s.boxShadow, borderWidth: s.borderTopWidth,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
}
function neutral(color, label) {
  check(color[3] > 0, `${label}: surface must not be transparent`);
  check(Math.max(...color.slice(0, 3)) - Math.min(...color.slice(0, 3)) <= 2, `${label}: expected neutral gray, got ${color}`);
}
async function dialogGeometry(page, result, name) {
  const modal = dialog(page), header = modal.locator('header'), footer = modal.locator('footer');
  const body = modal.locator('.ui-dialog-body, .dialog-form-body');
  const g = { modal: await metric(modal), header: await metric(header), close: await metric(header.locator('button')), footer: await metric(footer), body: await metric(body), actions: [] };
  for (const action of await footer.locator('button').all()) g.actions.push(await metric(action));
  result.measurements[name] = g;
  near(g.modal.width, 600, `${name}: common dialog width`);
  equal(g.modal.radius, '16px', `${name}: dialog radius`);
  neutral(g.modal.background, `${name}: dialog surface`);
  neutral(g.header.background, `${name}: header surface`);
  near(g.close.width, 36, `${name}: header close width`);
  near(g.close.height, 36, `${name}: header close height`);
  near(g.close.y + g.close.height / 2, g.header.y + g.header.height / 2, `${name}: header close centered`);
  check(g.actions.length >= 2, `${name}: actual footer actions present`);
  for (const action of g.actions) { near(action.height, 36, `${name}: footer button height`); equal(action.radius, '8px', `${name}: footer button radius`); }
  check(g.modal.scrollWidth <= g.modal.clientWidth, `${name}: no horizontal overflow`);
  await shot(page, result, name);
  return g;
}
async function scenario(name, run, options = {}) {
  const result = { name, status: 'running', screenshots: [], measurements: {}, errors: [], external: [] };
  results.push(result);
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: options.theme ?? 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(3500); page.setDefaultNavigationTimeout(8000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('dialog', async modal => { result.errors.push(`Unexpected native browser dialog: ${modal.message()}`); await modal.dismiss(); });
  const fail = error => { result.status = 'failed'; (result.failures ??= []).push(error.stack ?? String(error)); failures.push(`${name}: ${error.message}`); console.error(`FAIL ${engineName} / ${name}: ${error.stack}`); };
  try {
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      result.external.push(request.url()); return route.abort();
    });
    await context.routeWebSocket('**/*', socket => { result.external.push(socket.url()); socket.close(); });
    await context.addInitScript(installUiConsistencyNative, uiConsistencyFixture(options));
    await page.goto(origin);
    await page.waitForFunction(() => Object.values(window.__uiConsistency.states).every(state => state.ready));
    await historyRow(page, A).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    await run(page, result);
    result.status = 'passed';
  } catch (error) {
    fail(error);
    result.visibleState = await page.locator('.main-shell').innerText({ timeout: 1000 }).catch(() => 'Main shell unavailable');
  }
  finally {
    try {
      await shot(page, result, 'final');
      result.ipc = await page.evaluate(() => ({ unexpected: window.__uiConsistency.unexpected, mutations: window.__uiConsistency.mutations, permits: window.__uiConsistency.permits, calls: window.__uiConsistency.calls }));
      equal(result.errors, [], `${name}: no runtime errors`);
      equal(result.external, [], `${name}: no external network`);
      equal(result.ipc.unexpected, [], `${name}: no non-allowlisted native calls (including builds)`);
      equal(result.ipc.permits, [], `${name}: all explicitly permitted mutations were exercised`);
      if (!options.writes) equal(result.ipc.mutations, [], `${name}: read-only scenario must not mutate`);
    } catch (error) { fail(error); }
    await context.close();
    report();
  }
  if (result.status === 'passed') console.log(`PASS ${engineName} / ${name}`);
}

try {
  server = createServer(await settingsTestAssets());
  server.requestTimeout = server.headersTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch({ headless: true, timeout: 12000 });

  await scenario('six-pages', async (page, result) => {
    let headingX;
    for (const name of ['Settings', 'Machines', 'Library', 'Automations', 'Memory', 'All chats']) {
      await go(page, name);
      const main = page.locator('.main-shell > .page'), shell = await metric(page.locator('.main-shell'));
      const g = await metric(main), heading = await metric(main.locator('.page-heading h1'));
      const icon = main.locator(':scope > .page-heading > .page-header-icon, :scope > .page-heading > .settings-header-icon');
      equal(await icon.count(), 1, `${name}: bare heading icon contract`);
      const i = await metric(icon);
      result.measurements[name] = { page: g, heading, icon: i, shell };
      near(g.width, 1040, `${name}: page width`);
      near(g.x + g.width / 2, shell.x + shell.width / 2, `${name}: centered in workspace`);
      headingX ??= heading.x;
      near(heading.x, headingX, `${name}: heading X matches Settings`);
      equal(i.background[3], 0, `${name}: icon has no background`);
      equal(i.borderWidth, '0px', `${name}: icon has no border`);
      equal(i.shadow, 'none', `${name}: icon has no shadow`);
      equal(i.radius, '0px', `${name}: icon has no badge radius`);
      equal((await metric(page.locator('.web-sidebar'))).background, [15, 15, 15, 255], `${name}: dark sidebar #0f0f0f`);
      equal(shell.background, [30, 30, 30, 255], `${name}: workspace #1e1e1e`);
      equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /approvals/i }).count(), 0, `${name}: no Approvals navigation`);
      await shot(page, result, name.toLowerCase().replaceAll(' ', '-'));
    }
  });

  await scenario('attention-controls-and-owner-counts', async (page, result) => {
    const badgeA = historyRow(page, A).locator('.chat-attention-count');
    equal(await badgeA.innerText(), '2', 'Sidebar Alpha combines pending + authorized records');
    equal(await badgeA.getAttribute('aria-label'), '1 approval needed · 1 ready to run', 'Sidebar attention labels actual action states');
    equal(await historyRow(page, B).locator('.chat-attention-count').count(), 0, 'Colliding Beta task/action IDs do not inherit Alpha attention');
    for (const owner of [A, B]) equal(await historyRow(page, owner, 'ui-verifying-task').locator('.chat-attention-count').count(), 0, 'Task verifying / failed action are not attention counts');
    await go(page, 'All chats');
    const search = page.getByRole('searchbox', { name: 'Search chats' }), select = page.getByRole('combobox', { name: 'Server', exact: true }), attention = page.locator('.chat-attention-filter');
    const controls = [await metric(search), await metric(select), await metric(attention)];
    result.measurements.controls = controls;
    for (const [index, g] of controls.entries()) {
      near(g.height, 40, `Control ${index}: 40px height`);
      near(g.y, controls[0].y, `Control ${index}: search/select/attention top alignment`);
      equal(g.font, '14px', `Control ${index}: 14px font`);
      equal(g.radius, '8px', `Control ${index}: 8px radius`);
      neutral(g.background, `Control ${index}: neutral background`);
      neutral(g.border, `Control ${index}: neutral border`);
    }
    equal(await attention.locator('b').innerText(), '2', 'Filter counts chats, not individual actions');
    check((await chatRow(page, A).innerText()).includes('1 approval needed · 1 ready to run'), 'AllChats matches SidebarHistory action labels');
    equal(await chatRow(page, B).getAttribute('data-attention'), 'false', 'AllChats preserves owner scope');
    await attention.click();
    equal(await attention.getAttribute('aria-pressed'), 'true', 'Attention filter is a pressed toggle');
    equal(await page.locator('.workspace-chat').count(), 2, 'Only chats with pending or authorized actions');
    await select.selectOption(A); await search.fill('Collision');
    equal(await page.locator('.workspace-chat').count(), 1, 'Search + server + attention combine');
    equal(await attention.locator('b').innerText(), '1', 'Attention count respects search + server');
    await select.selectOption(B);
    equal(await attention.locator('b').innerText(), '0', 'Same title on other owner has no attention');
    equal(await page.locator('.workspace-chat').count(), 0, 'No cross-owner matching records');
    await search.fill('Ready');
    equal(await page.locator('.workspace-chat').count(), 1, 'Authorized-only chat matches');
    await search.fill('Verifying');
    equal(await attention.locator('b').innerText(), '0', 'Verifying tasks do not count');
    equal(await page.locator('.workspace-chat').count(), 0, 'Verifying does not match attention filter');
    await button(page, 'Clear search and filters').click();
    equal(await search.inputValue(), '', 'Clear resets search'); equal(await select.inputValue(), 'all', 'Clear resets owner');
    equal(await attention.getAttribute('aria-pressed'), 'false', 'Clear resets attention');
  });

  await scenario('offline-last-known', async page => {
    await page.evaluate(owner => window.__uiConsistency.offline(owner), A);
    await page.waitForFunction(owner => document.querySelector(`.chat-server-group[data-server-id="${owner}"] .chat-attention-count`)?.dataset.cached === 'true', A);
    check((await historyRow(page, A).getAttribute('aria-label')).includes('Last known: 1 approval needed · 1 ready to run'), 'Sidebar offline count labeled last known');
    await go(page, 'All chats');
    check((await chatRow(page, A).innerText()).includes('Last known: 1 approval needed · 1 ready to run'), 'AllChats keeps last-known records');
    equal(await chatRow(page, A).getAttribute('data-cached'), 'true', 'Offline row is cached');
    await openReview(page);
    equal(await page.locator('.task-attention-indicator').getAttribute('data-cached'), 'true', 'Task header attention is last-known');
    check(await dialog(page).getByRole('button', { name: 'Approve', exact: true }).isDisabled(), 'Offline review cannot approve');
  });

  await scenario('memory-scope-stability', async (page, result) => {
    await go(page, 'Memory');
    const scope = page.getByRole('group', { name: 'Where the note is kept' });
    const geometry = async () => ({ scope: await metric(scope), row: await metric(page.locator('.workspace-scope-row')), content: await metric(page.locator('.main-shell > .page > .shared-memory, .main-shell > .page > .workspace-server')) });
    const all = await geometry();
    await scope.getByRole('button', { name: 'One server', exact: true }).click();
    const one = await geometry();
    result.measurements.scopes = { all, one };
    for (const key of ['x', 'y', 'width', 'height']) near(one.scope[key], all.scope[key], `Memory scope ${key} stable`);
    near(one.row.height, all.row.height, 'Memory toolbar height stable');
    near(one.content.y, all.content.y, 'Memory content does not jump between scopes');
    const select = page.getByRole('combobox', { name: 'Server', exact: true });
    await select.selectOption(B);
    check((await page.getByRole('region', { name: 'Server notes', exact: true }).innerText()).includes('Local note for Consistency Beta'), 'One-server notes use selected owner');
    await scope.getByRole('button', { name: 'All servers', exact: true }).click();
    equal(await select.count(), 0, 'All-server scope hides owner selector');
    await scope.getByRole('button', { name: 'One server', exact: true }).click();
    equal(await select.inputValue(), B, 'Owner selection survives scope toggles');
  });

  await scenario('actual-dialogs', async (page, result) => {
    await page.setViewportSize({ width: 1600, height: 700 });
    await go(page, 'Automations'); await button(page, 'New schedule').click();
    const before = await dialogGeometry(page, result, 'schedule');
    check(before.body.scrollHeight > before.body.clientHeight, 'Long Schedule fields overflow within body');
    await dialog(page).locator('.dialog-form-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await settle(page);
    check(await dialog(page).locator('.dialog-form-body').evaluate(element => element.scrollTop > 0), 'Schedule fields actually scroll');
    near((await metric(dialog(page).locator('header'))).y, before.header.y, 'Schedule header fixed while fields scroll');
    near((await metric(dialog(page).locator('footer'))).y, before.footer.y, 'Schedule footer fixed while fields scroll');
    await button(page, 'Close dialog').click();
    await go(page, 'Memory'); await button(page, 'New shared note').click();
    await dialogGeometry(page, result, 'shared-note'); await button(page, 'Close dialog').click();
    await button(page, 'One server').click();
        await page.getByRole('combobox', { name: 'Server', exact: true }).selectOption(A);
        await button(page, 'New server note').click();
    await dialogGeometry(page, result, 'server-note'); await button(page, 'Close dialog').click();
    await openReview(page);
    await dialogGeometry(page, result, 'action-review');
    check((await dialog(page).innerText()).includes('echo Consistency Alpha'), 'Actual review displays fixture snapshot arguments');
    equal(await mutations(page), [], 'Opening all real dialogs never sends commands');
  });

  await scenario('explicit-approval-then-separate-run', async (page, result) => {
    await openReview(page);
    equal(await mutations(page), [], 'Review does not automatically decide or dispatch');
    const expected = { environmentId: A, kind: 'approval.decide', id: reviewAction, revision: 7, payload: { nonce: `${A}-nonce`, actionDigest: `${A}-digest`, decision: 'approve' } };
    await page.evaluate(expected => window.__uiConsistency.allowMutation(expected), expected);
    await dialog(page).getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => window.__uiConsistency.mutations.length === 1);
    await dialog(page).getByText(/The action has updated/).waitFor();
    await settle(page);
    equal(await mutations(page), [{ command: 'environment_send_command', args: expected }], 'Explicit approval sends exactly revision/nonce/digest to owning environment');
    equal(await dialog(page).getByRole('button', { name: 'Run approved action', exact: true }).count(), 0, 'Old snapshot cannot dispatch after approval');
    await button(page, 'Close review').click();
    await page.evaluate(owner => {
      const other = window.__uiConsistency.states[owner].records.find(row => row.kind === 'action' && row.id === 'ui-authorized-action');
      window.__uiConsistency.emitRecord(owner, { ...other, revision: other.revision + 1, data: { ...other.data, state: 'succeeded' } });
    }, A);
    await settle(page);
    await page.locator('.task-attention-indicator').click();
    const run = dialog(page).getByRole('button', { name: 'Run approved action', exact: true });
    await run.waitFor();
    equal((await mutations(page)).length, 1, 'Opening authorized review does not dispatch');
    const dispatch = { environmentId: A, kind: 'action.dispatch', id: reviewAction, revision: 8, payload: {} };
    equal(await dialog(page).locator('.action').getAttribute('data-record-id'), reviewAction, 'Reopened authorized snapshot is the action just approved');
    await page.evaluate(expected => window.__uiConsistency.allowMutation(expected), dispatch);
    await run.click();
    await page.waitForFunction(() => window.__uiConsistency.mutations.length === 2);
    equal(await mutations(page), [{ command: 'environment_send_command', args: expected }, { command: 'environment_send_command', args: dispatch }], 'Authorized action runs only after separate explicit click, on its owner');
    await shot(page, result, 'separate-run');
  }, { writes: true });

  for (const [name, change] of [
    ['revision', { revision: 8 }],
    ['same-revision-nonce', { data: { nonce: 'replacement-nonce' } }],
    ['same-revision-digest', { data: { actionDigest: 'replacement-digest' } }],
    ['same-revision-task', { data: { taskId: 'ui-verifying-task' } }],
    ['same-revision-arguments', { data: { arguments: { command: 'echo changed', cwd: '/synthetic/workspace' } } }],
    ['same-revision-state', { data: { state: 'authorized' } }],
        ['same-revision-target', { data: { target: 'replacement workspace' } }],
        ['same-revision-effects', { data: { effects: ['host.write'] } }],
  ]) {
    await scenario(`review-refuses-${name}`, async page => {
      await openReview(page);
      const approve = dialog(page).getByRole('button', { name: 'Approve', exact: true });
      await approve.focus();
      await page.evaluate(([owner, id, patch]) => {
        const previous = window.__uiConsistency.states[owner].records.find(row => row.kind === 'action' && row.id === id);
        window.__uiConsistency.emitRecord(owner, { ...previous, ...patch, data: { ...previous.data, ...patch.data } }, patch.revision ? 'records' : 'snapshot');
      }, [A, reviewAction, change]);
      await dialog(page).getByText(/The action has updated/).waitFor();
      equal(await approve.count(), 0, 'Changed exact snapshot removes stale decision buttons');
      equal(await dialog(page).getByRole('button', { name: 'Run approved action', exact: true }).count(), 0, 'Changed snapshot never becomes runnable in place');
      await page.keyboard.press('Enter'); await settle(page);
      equal(await mutations(page), [], 'Stale focused approval cannot submit after stream update');
    });
  }

  await scenario('review-goes-offline-while-open', async page => {
    await openReview(page);
    const approve = dialog(page).getByRole('button', { name: 'Approve', exact: true });
    equal(await approve.isEnabled(), true, 'Review begins writable');
    await page.evaluate(owner => window.__uiConsistency.offline(owner), A);
    await page.waitForFunction(() => document.querySelector('.action-review-dialog .primary')?.disabled === true);
    check(await approve.isDisabled(), 'Latest connection state blocks already-open approval');
    await page.keyboard.press('Enter'); await settle(page);
    equal(await mutations(page), [], 'Losing connection while review is open cannot approve');
  });

  await scenario('review-pending-transport', async page => {
    await openReview(page);
    check(await dialog(page).getByRole('button', { name: 'Approve', exact: true }).isDisabled(), 'Pending transport/recovery blocks approval');
    check(await dialog(page).getByRole('button', { name: 'Deny', exact: true }).isDisabled(), 'Pending transport/recovery blocks denial');
    equal(await mutations(page), [], 'Pending connection cannot mutate');
  }, { pending: true });

  await scenario('review-owner-switch', async page => {
    await openReview(page);
    check((await dialog(page).innerText()).includes('echo Consistency Alpha'), 'Snapshot belongs to Alpha');
    // Simulate owner navigation arriving from outside the modal (e.g. the native sidebar).
    // Invoke the real navigation handler, not a React state setter or replacement component.
    await historyRow(page, B).evaluate(element => element.click());
    await page.waitForFunction(owner => document.querySelector('.main-shell')?.dataset.ownerId === owner, B);
    await settle(page);
    equal(await page.locator('.task-attention-indicator').count(), 0, 'Same task ID on Beta has no Alpha review indicator');
    equal(await dialog(page).count(), 0, 'Alpha review does not survive owner navigation');
    await selectChat(page, B, 'ui-ready-task');
    await page.locator('.task-attention-indicator').click();
    check((await dialog(page).innerText()).includes('echo Consistency Beta'), 'Authorized snapshot belongs to Beta');
    equal(await dialog(page).getByRole('button', { name: 'Approve', exact: true }).count(), 0, 'Authorized owner requires run, not approval');
    equal(await mutations(page), [], 'Owner navigation/review cannot dispatch');
  });

  await scenario('light-theme-preserved', async (page, result) => {
    await go(page, 'All chats');
    equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Real appearance hook selects light theme');
    const shell = await metric(page.locator('.main-shell')), sidebar = await metric(page.locator('.web-sidebar'));
    result.measurements.light = { shell, sidebar };
    check(shell.background.slice(0, 3).every(value => value > 180), 'Light workspace not overridden by dark palette');
    check(sidebar.background.slice(0, 3).every(value => value > 180), 'Light sidebar preserved');
    check(shell.foreground.slice(0, 3).every(value => value < 120), 'Light theme retains dark readable text');
    await go(page, 'Memory'); await button(page, 'New shared note').click();
    const surface = await metric(dialog(page));
    check(surface.background.slice(0, 3).every(value => value > 180), 'Light dialog surface preserved');
    await shot(page, result, 'light-dialog');
    await button(page, 'Close dialog').click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    equal((await metric(page.locator('.main-shell'))).background, [30, 30, 30, 255], 'System theme change restores neutral dark workspace');
  }, { theme: 'light' });
} catch (error) {
  failures.push(`Suite setup/runtime: ${error.stack}`); console.error(error);
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  clearTimeout(shutdown); clearTimeout(deadline); report();
}
console.log(`${engineName}: ${checks} checks; ${results.filter(result => result.status === 'passed').length}/${results.length} scenarios passed; ${failures.length} failures. Report: ${output}/${engineName}-report.json`);
if (failures.length) process.exitCode = 1;
