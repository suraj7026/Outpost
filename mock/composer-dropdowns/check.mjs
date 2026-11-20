import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 940 }, deviceScaleFactor: 2 });
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
  const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name + '.png', root)), fullPage: true });
  const ready = async () => { await page.evaluate(() => document.fonts.ready); };
  const assertFits = async selector => {
    const bounds = await page.locator(selector).evaluate(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, selector + ' must fit the viewport');
  };
  await page.goto(new URL('index.html', root).href);
  await ready();
  assert.equal(await page.evaluate(() => document.fonts.check('15px "Google Sans Flex"')), true);
  await screenshot('overview');
  for (const kind of ['outpost', 'control', 'model']) {
    await page.locator('[data-menu="' + kind + '"]').click();
    await assertFits('#floating');
    assert.equal(await page.locator('[data-menu][aria-expanded="true"]').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#floating').isVisible(), false);
    assert.equal(await page.locator('[data-menu="' + kind + '"]').evaluate(el => el === document.activeElement), true);
  }
  await page.locator('[data-menu="control"]').click();
  assert.deepEqual(await page.locator('#floating [data-value]').evaluateAll(items => items.map(item => item.dataset.value)), ['Full control', 'Auto']);
  for (const condition of ['financial', 'destructive', 'security-sensitive', 'unclassified']) {
    assert.ok((await page.locator('#floating [data-value="Auto"]').textContent()).includes(condition));
  }
  for (const tool of ['shell', 'browser', 'extension']) {
    assert.ok((await page.locator('#floating').textContent()).includes(tool));
  }
  await page.locator('#floating [data-value="Auto"]').click();
  assert.equal(await page.locator('[data-menu="control"] .trigger-label').textContent(), 'Auto');
  assert.equal(await page.locator('[data-menu="control"] .control-icon use').getAttribute('href'), '#shield-auto');
  assert.equal(await page.locator('#floating').isVisible(), false);
  await page.locator('[data-menu="control"]').click();
  assert.equal(await page.locator('#floating [aria-checked="true"]').getAttribute('data-value'), 'Auto');
  assert.equal(await page.locator('#floating [aria-checked="true"]').count(), 1);
  await page.locator('#floating .menu').screenshot({ path: fileURLToPath(new URL('control-menu-auto.png', root)) });
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-menu="control"] .trigger-label').textContent(), 'Full control');
  assert.equal(await page.locator('[data-menu="control"] .control-icon use').getAttribute('href'), '#shield');
  await page.locator('[data-menu="model"]').click();
  await page.locator('#floating input').fill('qwen');
  assert.equal(await page.locator('#floating .model-row:visible').count(), 1);
  await page.locator('#floating .model-row:visible').click();
  assert.equal(await page.locator('[data-menu="model"] .trigger-label').textContent(), 'Ollama · qwen3-coder');
  await page.locator('[data-menu="model"]').click();
  await page.locator('#floating input').fill('nonexistent-model');
  assert.equal(await page.locator('#floating .empty').isVisible(), true);
  await page.locator('h1').click();
  assert.equal(await page.locator('#floating').isVisible(), false);
  await page.locator('[data-menu="outpost"]').click();
  assert.equal(await page.locator('#floating [data-value="Outpost 3"]').isDisabled(), true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-menu="outpost"] .trigger-label').textContent(), 'Outpost 2');

  await page.goto(new URL('index.html?view=focused', root).href);
  await ready();
  await page.setViewportSize({ width: 1180, height: 760 });
  for (const kind of ['outpost', 'control', 'model']) {
    await page.locator('[data-menu="' + kind + '"]').click();
    await assertFits('#floating');
    await screenshot(kind + '-open');
    await page.keyboard.press('Escape');
  }
  await page.locator('[data-menu="control"]').click();
  await page.locator('#floating [data-value="Auto"]').click();
  await page.locator('[data-menu="control"]').click();
  await assertFits('#floating');
  await screenshot('control-auto-open');
  await page.keyboard.press('Escape');
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No page overflow at ' + width);
    for (const kind of ['outpost', 'control', 'model']) {
      await page.locator('[data-menu="' + kind + '"]').click();
      await assertFits('#floating');
      if (kind === 'model') await screenshot('model-open-' + width);
      if (kind === 'control') await screenshot('control-auto-open-' + width);
      await page.keyboard.press('Escape');
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Mock checks passed: exactly Full control + Auto, policy copy, mode label/icon/checkmark synchronization, shared menus, search, empty/offline states, keyboard, dismissal, focus return, 1180/768/390px bounds. No external requests.');
} finally { await browser.close(); }
