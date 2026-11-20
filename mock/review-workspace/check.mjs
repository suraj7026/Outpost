import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1568, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('index.html', root).href);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('14px "Google Sans Flex"')), true);
  await page.screenshot({ path: fileURLToPath(new URL('preview.png', root)) });
  await page.locator('[data-mode="source"]').click();
  assert.equal(await page.locator('#source').isVisible(), true);
  assert.match(await page.locator('#source').innerText(), /# BitChat protocol research/);
  await page.locator('[data-mode="changes"]').click();
  assert.equal(await page.locator('#changes').isVisible(), true);
  await page.screenshot({ path: fileURLToPath(new URL('changes.png', root)) });
  assert.equal(await page.locator('.review-footer, #mark-reviewed, #review-status').count(), 0);
  await page.locator('#filter').fill('notes');
  assert.equal(await page.locator('[data-file="readme"]').isVisible(), false);
  assert.equal(await page.locator('[data-file="notes"]').isVisible(), true);
  await page.locator('#filter').fill('not-a-file');
  assert.equal(await page.locator('#no-files').isVisible(), true);
  await page.locator('#filter').fill('');
  await page.locator('[data-filter="changed"]').click();
  assert.equal(await page.locator('[data-file="sources"]').isVisible(), false);
  await page.locator('[data-filter="all"]').click();
  await page.locator('[data-file="sources"]').click();
  assert.match(await page.locator('#changes').innerText(), /No changes/);

  await page.locator('#review-file').click();
  assert.equal(await page.locator('#preview').isVisible(), true);
  await page.locator('#preview [data-source]').click();
  assert.equal(await page.locator('#browser-view').isVisible(), true);
  await page.locator('#toast').evaluate(el => { el.hidden = true; });
  await page.screenshot({ path: fileURLToPath(new URL('browser.png', root)) });
  await page.locator('#return-doc').click();
  await page.locator('#toggle-files').click();
  assert.equal(await page.locator('.explorer').isVisible(), false);
  await page.locator('#toggle-files').click();
  await page.locator('#focus').click();
  assert.equal(await page.locator('.chat').isVisible(), false);
  await page.locator('#focus').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download').click();
  assert.equal((await downloadEvent).suggestedFilename(), 'README.md');
  await page.locator('#toast').evaluate(el => { el.hidden = true; });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.locator('#document-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: fileURLToPath(new URL(`preview-${width}.png`, root)) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
  }
  await page.locator('.mobile-nav [data-mobile="chat"]').click();
  assert.equal(await page.locator('.chat').isVisible(), true);
  await page.locator('.mobile-nav [data-mobile="browser"]').click();
  assert.equal(await page.locator('#browser-view').isVisible(), true);
  await page.locator('#toggle-files').click();
  assert.equal(await page.locator('.explorer').isVisible(), true);
  await page.locator('[data-file="notes"]').click();
  assert.equal(await page.locator('.explorer').isVisible(), false);
  assert.match(await page.locator('#preview h1').innerText(), /Research notes/);
  assert.deepEqual(errors, []);
  console.log('PASS: document modes, no review footer, file switching/filtering, source navigation, sidebar/focus controls, download, mobile navigation, fonts, and overflow checks.');
} finally {
  await browser.close();
}
