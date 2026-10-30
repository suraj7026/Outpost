import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.STUDY_URL || 'http://127.0.0.1:4391';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) externalRequests.push(request.url()); });
await mkdir('mock/graphite-studies/review/interaction', { recursive: true });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const click = selector => page.locator(selector).filter({ visible: true }).first().click();
try {
  for (const design of ['studio', 'precision', 'quiet']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/?design=${design}`);
    await page.evaluate(() => document.fonts.ready);
    check(await page.locator('h1').count() === 1, `${design}: one h1`);
    const review = page.locator('.decision [data-action="review"]');
    const bounds = await review.boundingBox();
    const scrollBounds = await page.locator('.conversation-scroll, .precision-scroll, .quiet-scroll').boundingBox();
    check(bounds.y + bounds.height <= scrollBounds.y + scrollBounds.height + 1, `${design}: primary decision visible without scrolling`);
    await page.screenshot({ path: `mock/graphite-studies/review/interaction/${design}-desktop.png` });
    await click('[data-action="review"]');
    check(await page.locator('#modal').evaluate(element => element.open), `${design}: review dialog opens`);
    check((await page.locator('#modal').innerText()).includes('No live action'), `${design}: honest approval notice`);
    await click('[data-action="approve"]');
    check(await page.locator('.done-decision').count() === 1, `${design}: approval changes state`);
    await click('[data-action="undo"]');
    check(await page.locator('.decision [data-action="review"]').count() === 1, `${design}: undo restores review`);
    await page.locator('#message').fill('Keep the old schedule as a rollback.');
    await page.locator('#message').press('Enter');
    check((await page.locator('#app').innerText()).includes('Keep the old schedule as a rollback.'), `${design}: follow-up works`);
    await click('[data-task="disk"]');
    check((await page.locator('#app').innerText()).includes('84 GB available'), `${design}: task switching`);
    await click('[data-task="backup"]');
    check((await page.locator('#app').innerText()).includes('Keep the old schedule as a rollback.'), `${design}: message survives task switch`);
    await page.goto(`${base}/?design=${design}`);
    await click('[data-action="replay"]');
    check(await page.locator('.handoff.running').count() > 0, `${design}: inspection animation starts`);
    await page.waitForTimeout(2800);
    check(await page.locator('.handoff.running').count() === 0, `${design}: inspection animation stops`);
    await page.keyboard.press('Meta+k');
    check(await page.locator('#modal').evaluate(element => element.open), `${design}: keyboard search`);
    await page.keyboard.press('Escape');
    check(!await page.locator('#modal').evaluate(element => element.open), `${design}: Escape closes dialog`);
    await click('[data-action="theme"]');
    await page.screenshot({ path: `mock/graphite-studies/review/interaction/${design}-light.png` });
    check(await page.locator('body').getAttribute('data-theme') === 'light', `${design}: light appearance`);
    check(await page.locator('h1').evaluate(el => getComputedStyle(el).color) === 'rgb(32, 33, 37)', `${design}: light text inherits light-theme ink`);
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/?design=${design}`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${design}: no page overflow at ${width}`);
      await page.screenshot({ path: `mock/graphite-studies/review/interaction/${design}-${width}.png`, fullPage: true });
      await click('[data-action="review"]');
      check(await page.locator('#modal').evaluate(element => element.open), `${design}: review reachable at ${width}`);
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await click('[data-tab="activity"]');
  check(await page.locator('.event-row').count() === 4, 'Studio activity view');
  await page.keyboard.press('ArrowLeft');
  check(await page.locator('#tab-changes').getAttribute('aria-selected') === 'true', 'Arrow-key evidence navigation');
  await click('[data-action="inspector"]');
  check(await page.locator('.studio').evaluate(el => el.classList.contains('evidence-hidden')), 'Inspector collapse');
  await page.keyboard.press('Meta+n');
  await page.locator('#task-name').fill('Review the morning logs');
  await page.locator('#new-task-form').evaluate(form => form.requestSubmit());
  check((await page.locator('h1').innerText()).includes('Review the morning logs'), 'New sample task created');
  await page.goto(`${base}/?design=quiet`);
  await click('[data-action="fold"]');
  check(await page.locator('.inline-evidence').count() === 1, 'Quiet evidence expands');
  await click('[data-action="fold"]');
  check(await page.locator('.inline-evidence').count() === 0, 'Quiet evidence collapses');
  await page.goto(`${base}/?compare=1`);
  await page.waitForTimeout(800);
  check(await page.locator('.comparison-card').count() === 3, 'Three comparison previews');
  check(await page.locator('iframe').first().evaluate(el => el.getBoundingClientRect().width < 600), 'Comparison iframe scaled');
  await page.screenshot({ path: 'mock/graphite-studies/review/interaction/compare.png', fullPage: true });
  for (const width of [768, 390]) {
    await page.setViewportSize({width, height:900});
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Comparison fits ${width}`);
    await page.screenshot({path:`mock/graphite-studies/review/interaction/compare-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base);
  check(await page.locator('body').getAttribute('data-motion') === 'off', 'Reduced motion honored');
  await click('[data-action="replay"]');
  check(await page.locator('.handoff.running').count() === 0, 'Reduced motion stops replay');
  await click('[data-action="review"]');
  await page.screenshot({ path: 'mock/graphite-studies/review/interaction/approval-reduced-motion.png' });
  check(errors.length === 0, `No browser exceptions: ${errors.join(', ')}`);
  check(externalRequests.length === 0, 'No external network requests');
  await writeFile('mock/graphite-studies/review/interaction/results.json', JSON.stringify({ checks, errors, externalRequests }, null, 2));
  console.log(`PASS: ${checks} checks; no browser exceptions or external network requests.`);
} finally {
  await browser.close();
}
