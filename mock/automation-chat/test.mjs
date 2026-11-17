import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = new URL('./index.html', import.meta.url).href;
const output = new URL('./test-results/', import.meta.url);
const shots = new URL('./screenshots/', output);
const results = { entry, cases: [], screenshots: [], pageerrors: [], diagnostics: [] };
const protectedFiles = ['index.html', 'prototype.css', 'prototype.js', 'GoogleSansFlex.woff2'];
const sizes = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 768, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];
const journeyNames = [
  'draft → create automation without running',
  'simulate report ready', 'simulate queued → release',
  'simulate blocked', 'simulate approval → approve',
  'pause → resume', 'edit preserves historical prompts',
  'new automation → dedicated chat without running',
  'run now twice → stable dedicated chat',
  'composer schedules in existing chat', 'all / active / paused filters',
];
await mkdir(shots, { recursive: true });
const hash = async name => createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
const before = await Promise.all(protectedFiles.map(hash));
const watchdog = setTimeout(() => {
  results.cases.push({ name: 'global time budget', status: 'failed', error: 'Exceeded 110 seconds' });
  writeFileSync(new URL('results.json', output), JSON.stringify(results, null, 2));
  console.error('FAIL: global 110-second time budget exceeded; partial results saved.');
  process.exit(124);
}, 110_000);

async function check(name, fn) {
  try {
    await fn();
    results.cases.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    results.cases.push({ name, status: 'failed', error: error.stack || String(error) });
    console.log(`FAIL ${name}: ${error.message}`);
    return false;
  }
}
function skip(name, reason) {
  results.cases.push({ name, status: 'blocked', reason });
  console.log(`BLOCKED ${name}: ${reason}`);
}
const action = (root, name) => root.locator(`[data-action="${name}"]`);
const textIncludes = async (locator, text) => assert.ok((await locator.innerText()).includes(text), `Expected text: ${text}`);
const settle = page => page.waitForTimeout(1200);
const runIds = page => page.locator('.run').evaluateAll(nodes => nodes.map(n => n.id));
const currentChat = page => page.locator('#chat-list [aria-current="page"]').getAttribute('data-chat');

async function screenshot(page, prefix, stage, failed = false) {
  const filename = `${prefix}-${stage}${failed ? '-FAILED' : ''}.png`;
  await check(`${prefix}: capture ${stage}${failed ? ' (failure state)' : ''}`, async () => {
    await page.screenshot({ path: fileURLToPath(new URL(filename, shots)), timeout: 4000, animations: 'disabled' });
    results.screenshots.push({ stage, prefix, failed, path: `mock/automation-chat/test-results/screenshots/${filename}` });
  });
}
async function overflow(page, prefix, stage) {
  await check(`${prefix}: ${stage} horizontal overflow`, async () => {
    const dimensions = await page.evaluate(() => {
      const root = document.documentElement;
      const containers = [...document.querySelectorAll('body, #main, .chat-scroll, .transcript, .page-scroll, .page, .composer-area, dialog[open]')];
      const overflowing = containers.filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 1)
        .map(el => ({ element: el.id || el.className || el.tagName, client: el.clientWidth, scroll: el.scrollWidth }));
      const outside = [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight && (r.left < -1 || r.right > innerWidth + 1);
      }).slice(0, 12).map(el => ({ element: el.id || el.className || el.tagName, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
      return { viewport: innerWidth, client: root.clientWidth, scroll: root.scrollWidth, overflowing, outside };
    });
    assert.ok(dimensions.scroll <= dimensions.client + 1 && !dimensions.overflowing.length && !dimensions.outside.length, JSON.stringify(dimensions));
  });
}
async function snapshot(page, prefix, stage, failed = false) {
  await screenshot(page, prefix, stage, failed);
  await overflow(page, prefix, stage);
}
async function goList(page) {
  await page.locator('.main-nav [data-action="automations"]').click();
  await page.locator('.page-header h1').waitFor();
  assert.equal(await page.locator('.page-header h1').innerText(), 'Automations');
}
async function simulate(page, outcome, expected) {
  const count = await page.locator('.run').count();
  await page.getByLabel('Simulated run outcome').selectOption(outcome);
  await action(page, 'simulate').click();
  await settle(page);
  assert.equal(await page.locator('.run').count(), count + 1);
  await textIncludes(page.locator('.run').last().locator('.run-status'), expected);
}

async function desktopJourneys(page, prefix) {
  let healthy = true;
  async function step(name, fn) {
    if (!healthy) return skip(`${prefix}: ${name}`, 'An earlier desktop journey failed');
    healthy = await check(`${prefix}: ${name}`, fn);
    if (!healthy) await screenshot(page, prefix, `journey-${results.cases.length}`, true);
  }
  await step(journeyNames[0], async () => {
    await action(page, 'reset').click();
    await page.getByRole('region', { name: 'Review schedule' }).waitFor();
    assert.equal(await page.locator('.run').count(), 0);
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    await textIncludes(page.getByRole('region', { name: 'Saved automation' }), 'Active');
    assert.equal(await page.locator('.run').count(), 0);
    assert.equal(await currentChat(page), 'server-checks');
  });
  await step(journeyNames[1], async () => {
    await simulate(page, 'complete', 'Report ready');
    await textIncludes(page.locator('.run').last(), 'Both servers are reachable.');
    assert.equal(await page.locator('.run').last().locator('.report-table tbody tr').count(), 2);
  });
  await step(journeyNames[2], async () => {
    await simulate(page, 'queued', 'Queued');
    const id = await page.locator('.run').last().getAttribute('id');
    await textIncludes(page.locator('.run').last(), 'Queued behind your current response');
    await action(page.locator('.run').last(), 'release').click();
    await settle(page);
    assert.equal(await page.locator('.run').last().getAttribute('id'), id);
    await textIncludes(page.locator('.run').last().locator('.run-status'), 'Report ready');
  });
  await step(journeyNames[3], async () => {
    await simulate(page, 'blocked', 'Access blocked');
    await textIncludes(page.locator('.run').last(), 'SSH key not authorized');
    await textIncludes(page.locator('.run').last(), 'Schedule remains active');
  });
  await step(journeyNames[4], async () => {
    await simulate(page, 'approval', 'Needs permission');
    await action(page.locator('.run').last(), 'review').click();
    await page.getByRole('dialog', { name: 'Review sample action' }).waitFor();
    await page.getByRole('button', { name: 'Approve sample action', exact: true }).click();
    await settle(page);
    assert.equal(await page.locator('#approval').evaluate(el => el.open), false);
    await textIncludes(page.locator('.run').last().locator('.run-status'), 'Report ready');
  });
  await step(journeyNames[5], async () => {
    const history = await runIds(page);
    await action(page.locator('.schedule-card'), 'manage').click();
    await page.locator('#manager').getByRole('button', { name: 'Pause', exact: true }).click();
    await textIncludes(page.locator('#manager'), 'No future runs while paused.');
    await action(page.locator('#manager'), 'close').click();
    assert.equal(await action(page, 'simulate').isDisabled(), true);
    assert.deepEqual(await runIds(page), history);
    await action(page.locator('.schedule-card'), 'manage').click();
    await page.locator('#manager').getByRole('button', { name: 'Resume', exact: true }).click();
    await textIncludes(page.locator('#manager .status'), 'Active');
    await action(page.locator('#manager'), 'close').click();
    assert.equal(await action(page, 'simulate').isEnabled(), true);
    assert.deepEqual(await runIds(page), history);
  });
  await step(journeyNames[6], async () => {
    const prompts = await page.locator('.scheduled-prompt > p').allTextContents();
    await action(page.locator('.schedule-card'), 'edit').click();
    await page.locator('#editor').getByLabel('Name', { exact: true }).fill('Daily server health edited');
    await page.locator('#editor').getByRole('textbox', { name: 'Prompt', exact: true }).fill('Inspect sample server health after the schedule edit.');
    await page.locator('#editor').getByLabel('Time', { exact: true }).fill('12:30');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await textIncludes(page.locator('.schedule-card'), 'Daily server health edited');
    assert.deepEqual(await page.locator('.scheduled-prompt > p').allTextContents(), prompts);
    await simulate(page, 'complete', 'Report ready');
    await textIncludes(page.locator('.scheduled-prompt > p').last(), 'Inspect sample server health after the schedule edit.');
  });
  let dedicatedId;
  let dedicatedCount;
  await step(journeyNames[7], async () => {
    await goList(page);
    const chatsBefore = await page.locator('#chat-list .chat-button').count();
    await action(page, 'new-automation').click();
    await textIncludes(page.locator('#editor .destination'), 'A new, dedicated chat');
    await page.locator('#editor').getByLabel('Name', { exact: true }).fill('Test project briefing');
    await page.locator('#editor').getByRole('textbox', { name: 'Prompt', exact: true }).fill('Summarize sample project progress.');
    await snapshot(page, prefix, 'create-dialog');
    await page.getByRole('button', { name: 'Create & open chat', exact: true }).click();
    assert.equal(await page.locator('.chat-heading h1').innerText(), 'Test project briefing');
    await textIncludes(page.locator('.creation-note'), 'No run started on creation');
    assert.equal(await page.locator('.run').count(), 0);
    await settle(page);
    assert.equal(await page.locator('.run').count(), 0);
    dedicatedId = await currentChat(page);
    dedicatedCount = await page.locator('#chat-list .chat-button').count();
    assert.ok(dedicatedId && dedicatedId !== 'server-checks');
    assert.equal(dedicatedCount, chatsBefore + 1);
    await snapshot(page, prefix, 'dedicated-chat');
  });
  await step(journeyNames[8], async () => {
    await page.getByLabel('Simulated run outcome').selectOption('complete');
    let previous = [];
    for (let run = 1; run <= 2; run++) {
      await action(page.locator('.schedule-card'), 'manage').click();
      await page.locator('#manager').getByRole('button', { name: 'Run now', exact: true }).click();
      await settle(page);
      assert.equal(await currentChat(page), dedicatedId);
      assert.equal(await page.locator('#chat-list .chat-button').count(), dedicatedCount);
      const ids = await runIds(page);
      assert.equal(ids.length, run);
      assert.deepEqual(ids.slice(0, -1), previous);
      previous = ids;
      await textIncludes(page.locator('.run').last(), 'Manual run');
      await textIncludes(page.locator('.run').last().locator('.run-status'), 'Report ready');
      await goList(page);
      const row = page.locator('.automation-row').filter({ has: page.getByRole('heading', { name: 'Test project briefing', exact: true }) });
      await textIncludes(row, 'Last run: Report ready');
      await row.getByRole('button', { name: 'Open chat' }).click();
      assert.equal(await currentChat(page), dedicatedId);
      assert.deepEqual(await runIds(page), previous);
    }
  });
  await step(journeyNames[9], async () => {
    await action(page, 'tour-setup').click();
    const chatsBefore = await page.locator('#chat-list .chat-button').count();
    const previousRuns = await runIds(page);
    await action(page.locator('#composer'), 'schedule-chat').click();
    await textIncludes(page.locator('#editor .destination'), 'Home server check-in');
    await page.locator('#editor').getByRole('button', { name: 'Close new automation', exact: true }).click();
    await page.getByLabel('Message Outpost', { exact: true }).fill('Every weekday, summarize my sample server checks.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal(await page.locator('#editor').getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), 'Every weekday, summarize my sample server checks.');
    await textIncludes(page.locator('#editor .destination'), 'Home server check-in');
    await page.locator('#editor').getByLabel('Name', { exact: true }).fill('Existing chat weekday summary');
    await page.locator('#editor').getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('weekdays');
    await page.locator('#editor').getByRole('button', { name: 'Create automation', exact: true }).click();
    assert.equal(await currentChat(page), 'server-checks');
    assert.equal(await page.locator('#chat-list .chat-button').count(), chatsBefore);
    assert.deepEqual(await runIds(page), previousRuns);
    await textIncludes(page.locator('.automation-strip'), '2 automations');
    await action(page.locator('.automation-strip'), 'manage-chat').click();
    await textIncludes(page.locator('#manager'), 'Existing chat weekday summary');
    await action(page.locator('#manager'), 'close').click();
  });
  await step(journeyNames[10], async () => {
    await goList(page);
    for (const [value, count, status] of [['all', 4, null], ['active', 3, 'Active'], ['paused', 1, 'Paused'], ['all', 4, null]]) {
      const filter = page.locator(`[data-action="filter"][data-value="${value}"]`);
      await filter.click();
      assert.equal(await filter.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.automation-row').count(), count);
      if (status) for (const text of await page.locator('.automation-row .status').allTextContents()) assert.equal(text.trim(), status);
    }
    await snapshot(page, prefix, 'automations-list-after-journeys');
  });
}

async function fixture(browser, browserName, size) {
  const prefix = `${browserName}-${size.name}`;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'en-US', timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  page.setDefaultNavigationTimeout(8000);
  const errors = [];
  const external = [];
  const failedRequests = [];
  page.on('pageerror', error => { const detail = { prefix, message: error.message, stack: error.stack }; errors.push(detail); results.pageerrors.push(detail); });
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), failure: request.failure() }));
  await context.route(/^https?:\/\//, route => { external.push(route.request().url()); return route.abort(); });
  try {
    const boot = await check(`${prefix}: file:// startup`, async () => {
      await page.goto(entry, { waitUntil: 'load' });
      assert.equal(new URL(page.url()).protocol, 'file:');
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1500))]));
      assert.equal(await page.locator('main#main').count(), 1, 'Missing semantic main#main; inspect index.html markup');
      assert.equal(await page.locator('.main-nav [data-action="chat"]').count(), 1, 'Conversation action selector is missing');
      await page.getByRole('region', { name: 'Review schedule' }).waitFor();
      assert.equal(await page.locator('.run').count(), 0);
      assert.equal(errors.length, 0, 'Startup emitted JavaScript pageerrors');
    });
    if (!boot) results.diagnostics.push({ prefix, dom: await page.evaluate(() => ({ main: document.querySelector('#main')?.outerHTML ?? null, navigation: [...document.querySelectorAll('.main-nav button')].map(el => ({ action: el.dataset.action, text: el.textContent })), malformedTags: [...document.querySelectorAll('*')].filter(el => el.tagName.includes('<')).map(el => el.outerHTML), bodyText: document.body.innerText })) });
    await snapshot(page, prefix, 'setup', !boot);

    // Exercise public navigation even after startup failure to expose independent blockers.
    const report = await check(`${prefix}: scheduled result tour`, async () => {
      await action(page, 'tour-run').click();
      assert.equal(await page.locator('#main .run').count(), 1, 'Scheduled report did not render');
      await textIncludes(page.locator('.run .run-status'), 'Report ready');
      await textIncludes(page.locator('.run'), 'Both servers are reachable.');
    });
    await snapshot(page, prefix, 'scheduled-report', !report);
    const list = await check(`${prefix}: Automations navigation`, async () => {
      await page.locator('.main-nav [data-action="automations"]').click();
      assert.equal(await page.locator('.page-header h1').count(), 1, 'Automations heading did not render');
      assert.equal(await page.locator('.automation-row').count(), 2);
    });
    await snapshot(page, prefix, 'automations-list', !list);
    if (size.name === 'desktop') {
      if (boot && report && list) await desktopJourneys(page, prefix);
      else for (const name of journeyNames) skip(`${prefix}: ${name}`, 'Startup/navigation is broken; no DOM or source patching permitted');
    } else if (list) {
      await check(`${prefix}: create dialog responsive layout`, async () => {
        await action(page, 'new-automation').click();
        await page.getByRole('dialog', { name: 'New automation', exact: true }).waitFor();
        await snapshot(page, prefix, 'create-dialog');
        await page.locator('#editor').getByRole('button', { name: 'Close new automation', exact: true }).click();
      });
    }
    await check(`${prefix}: no JavaScript pageerrors`, () => assert.deepEqual(errors, []));
    await check(`${prefix}: self-contained assets / no backend requests`, () => {
      assert.deepEqual(external, []);
      assert.deepEqual(failedRequests, []);
    });
  } finally {
    await context.close();
  }
}

try {
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    let browser;
    const launched = await check(`${name}: launch`, async () => { browser = await type.launch({ headless: true, timeout: 10000 }); });
    if (!launched) continue;
    try {
      for (const size of sizes) await check(`${name}-${size.name}: fixture execution`, () => fixture(browser, name, size));
    } finally {
      await browser.close();
    }
  }
} finally {
  await check('prototype files unchanged', async () => assert.deepEqual(await Promise.all(protectedFiles.map(hash)), before));
  results.summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, results.cases.filter(c => c.status === status).length]));
  await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2) + '\n');
  clearTimeout(watchdog);
  console.log(`\nResults: ${JSON.stringify(results.summary)}\nReport: ${fileURLToPath(new URL('results.json', output))}`);
  process.exitCode = results.summary.failed ? 1 : 0;
}
