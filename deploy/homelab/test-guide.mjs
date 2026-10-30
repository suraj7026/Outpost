import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const output = process.env.GUIDE_TEST_OUTPUT ?? '/tmp/homelab-guide-tests';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const url = new URL('./cluster-guide.html', import.meta.url).href;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
try {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const errors = [], networkRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) networkRequests.push(request.url()); });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  check(await page.evaluate(() => document.fonts.check('500 15px Geist')), 'Embedded Geist is available offline');
  check(await page.locator('#connection').isVisible(), 'Connection view starts visible');
  for (const node of ['mac', 'router', 'worker', 'main']) {
    await page.locator(`[data-node="${node}"]`).click();
    check(await page.locator(`[data-node="${node}"]`).getAttribute('aria-pressed') === 'true', `${node} can be selected`);
  }
  for (let i = 1; i <= 4; i++) {
    await page.locator('#trace-next').click();
    check((await page.locator('#trace-label').textContent()).includes(`${i}/4`), `Command illustration step ${i}`);
  }
  await page.locator('#trace-reset').click();
  check(await page.locator('#trace-reset').isHidden(), 'Trace resets');
  await page.getByRole('button', { name: 'Show me the tests' }).click();
  await page.waitForURL('**#tests');
  await page.locator('#tests').waitFor({ state: 'visible' });
  check(await page.locator('#tests').isVisible(), 'Primary action opens tests');
  for (const test of ['nodes', 'ansible', 'hostname', 'memory', 'http']) {
    await page.locator(`[data-test="${test}"]`).click();
    check(await page.locator(`[data-test="${test}"]`).getAttribute('aria-pressed') === 'true', `${test} selection state`);
    await page.locator('.evidence summary').click();
    check((await page.locator('#test-evidence').textContent()).trim().length > 20, `${test} evidence has substance`);
  }
  check(await page.locator('#test-command-wrap').isHidden(), 'Historical HTTP proof has no fake runnable command');
  await page.locator('[data-test="hostname"]').click();
  check((await page.locator('#evidence-label').textContent()).includes('not recorded'), 'Hostname example is not mislabelled evidence');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async text => { window.copiedCommand = text; } },
  }));
  await page.locator('#copy-test').click();
  check(await page.evaluate(() => window.copiedCommand) === "cluster run 'hostname'", 'Copy uses selected command');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Denied'); } } });
    document.execCommand = () => false;
  });
  await page.locator('#copy-test').click();
  const fallback = page.getByRole('textbox', { name: 'Command to copy' });
  check(await fallback.isVisible(), 'Blocked clipboard exposes manual copy');
  check(await fallback.inputValue() === "cluster run 'hostname'", 'Fallback contains the correct command');
  await fallback.press('Tab');
  await page.locator('[data-route="scaling"]').click();
  await page.locator('#scaling').waitFor({ state: 'visible' });
  check(await page.locator('#main-pods .pod').count() === 8, 'Eight recorded Docker containers');
  check(await page.locator('#worker-pods .pod').count() === 0, 'No fake migrated Docker containers');
  check(await page.locator('#replica-control').isHidden(), 'Current Docker has no scaling control');
  for (const scenario of ['replicas', 'hpa']) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    check(await page.locator('#replica-control').isVisible(), 'Illustrative replica control is available');
    for (const count of [1, 4, 6]) {
      await page.locator('#replica-count').fill(String(count));
      await page.locator('#replica-count').dispatchEvent('input');
      check(await page.locator('.pod.hypothetical').count() === count, `${scenario} placement reconciles at ${count}`);
      check((await page.locator('#placement-note').textContent()).includes('not a scheduler prediction'), 'Hypothetical placement is labelled');
    }
  }
  await page.locator('[data-scenario="docker"]').click();
  check(await page.locator('#main-pods .pod').count() === 8, 'Docker count returns to recorded inventory');
  check(await page.locator('#worker-pods').getAttribute('aria-label') === '0 recorded Docker containers', 'Accessible count resets to zero');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of ['connection', 'tests', 'scaling']) {
      await page.goto(`${url}#${route}`);
      await page.evaluate(() => document.fonts.ready);
      check(await page.locator(`#${route}`).isVisible(), `${route} deep link at ${width}px`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal page overflow: ${route} at ${width}px`);
      if (route === 'tests') await page.locator('.evidence summary').click();
      await page.screenshot({ path: `${output}/${route}-${width}.png`, fullPage: true });
    }
    await page.locator('.footer summary').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Font license disclosure fits at ${width}px`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${url}#connection`);
  await page.locator('#trace-next').focus();
  await page.keyboard.press('Enter');
  check((await page.locator('#trace-label').textContent()).includes('1/4'), 'Keyboard and reduced-motion interaction');
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement.id === 'trace-reset'), 'Focus order reaches reset');
  check(errors.length === 0, `No JavaScript errors: ${errors.join('; ')}`);
  check(networkRequests.length === 0, `No external requests: ${networkRequests.join('; ')}`);
  await context.close();
  const noJs = await browser.newContext({ javaScriptEnabled: false, offline: true, viewport: { width: 390, height: 844 } });
  const fallbackPage = await noJs.newPage();
  await fallbackPage.goto(url);
  check(await fallbackPage.locator('noscript').isVisible(), 'No-JavaScript instructions are available');
  check(await fallbackPage.locator('#connection').isVisible(), 'Connection overview remains readable without JavaScript');
  await noJs.close();
  console.log(`${assertions} assertions passed. Offline desktop/tablet/mobile screenshots: ${output}`);
} finally {
  await browser.close();
}
