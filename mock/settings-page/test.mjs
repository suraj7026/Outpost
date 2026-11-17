import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pageUrl = `file://${resolve(root, 'index.html')}`;
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };

try {
  for (const scheme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pageUrl);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);

    // Option clusters use the app's raised well + active pill idiom.
    const pill = await page.evaluate(() => {
      const label = document.querySelector('input[name="theme"]:checked').closest('label');
      return { bg: getComputedStyle(label).backgroundColor, active: getComputedStyle(document.documentElement).getPropertyValue('--active') };
    });
    check(pill.bg !== 'rgba(0, 0, 0, 0)' && pill.bg !== 'transparent', `${scheme}: checked option pill has the app active fill (${pill.bg})`);
    await page.getByRole('radio', { name: 'Light', exact: true }).click();
    await page.waitForTimeout(200);
    check(await page.evaluate(() => {
      const selected = document.querySelector('input[name="theme"]:checked').closest('label');
      const other = document.querySelector('input[name="theme"][value="auto"]').closest('label');
      return getComputedStyle(selected).backgroundColor !== getComputedStyle(other).backgroundColor;
    }), `${scheme}: selecting an option moves the active fill`);
    check(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(241, 242, 244)'), `${scheme}: Light selection repaints the canvas`);
    await page.getByRole('radio', { name: 'Auto', exact: true }).click();
    await page.waitForTimeout(200);
    check(await page.evaluate(s => getComputedStyle(document.documentElement).backgroundColor === (s === 'dark' ? 'rgb(15, 16, 17)' : 'rgb(241, 242, 244)'), scheme), `${scheme}: Auto follows the system appearance`);

    // Switches are the app's 44x28 control with a 16px knob travel.
    const knob = await page.evaluate(() => {
      const input = document.querySelector('[data-frost-toggle]');
      const knobStyle = getComputedStyle(input, '::before');
      return { width: input.offsetWidth, height: input.offsetHeight, transform: knobStyle.transform };
    });
    check(knob.width === 44 && knob.height === 28, `${scheme}: switch matches the app's 44x28 control`);
    check(knob.transform === 'matrix(1, 0, 0, 1, 16, 0)', `${scheme}: checked switch knob travels 16px (${knob.transform})`);
    await page.getByRole('switch', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(300);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('[data-collapse-toggle]'), '::before').transform === 'matrix(1, 0, 0, 1, 16, 0)'), `${scheme}: collapse switch knob reaches the checked position`);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.preview-sidebar')).opacity === '0'), `${scheme}: collapse preview hides the sidebar`);
    check(await page.evaluate(() => { const preview = document.querySelector('[data-preview]'); return document.querySelector('[data-preview-main]').getBoundingClientRect().left - preview.getBoundingClientRect().left - preview.clientLeft === 8; }), `${scheme}: collapse preview frees the whole content width`);

    // Reveal replays the app's 520ms spring; an interrupt mid-flight closes it.
    await page.getByRole('switch', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(200);
    await page.getByRole('switch', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(500);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.preview-sidebar')).opacity === '0'), `${scheme}: interrupting the reveal closes from the presentation value`);
    await page.getByRole('switch', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(700);
    check(await page.evaluate(() => {
      const sidebar = document.querySelector('.preview-sidebar');
      return getComputedStyle(sidebar).opacity === '1' && Math.abs(sidebar.getBoundingClientRect().left - document.querySelector('[data-preview]').getBoundingClientRect().left - 1) < 1;
    }), `${scheme}: reveal after an interrupt settles exactly at rest`);
    check(await page.evaluate(() => { const preview = document.querySelector('[data-preview]'); return document.querySelector('[data-preview-main]').getBoundingClientRect().left - preview.getBoundingClientRect().left - preview.clientLeft === 104; }), `${scheme}: revealed preview restores the sidebar column`);

    // Frost toggle owns the preview material and the slider's enabled state.
    await page.getByRole('switch', { name: 'Frosted glass' }).click();
    await page.waitForTimeout(300);
    check(await page.evaluate(() => document.querySelector('[data-preview]').dataset.frost === 'off'), `${scheme}: frost off swaps the preview to a solid material`);
    check(await page.evaluate(() => document.getElementById('glass-opacity').disabled), `${scheme}: opacity slider disables when frost is off`);
    await page.getByRole('switch', { name: 'Frosted glass' }).click();

    // Slider tracks 1:1 into the preview and the tabular readout.
    await page.locator('#glass-opacity').fill('80');
    await page.waitForTimeout(100);
    check(await page.evaluate(() => document.getElementById('glass-opacity-value').textContent === '80%'), `${scheme}: opacity readout follows the slider`);
    check(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--frost') === '80%'), `${scheme}: preview material tracks the slider value`);

    // Reduced motion: state changes are instant and correct.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('switch', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(80);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.preview-sidebar')).opacity === '0'), `${scheme}: reduced motion collapses instantly`);
    await page.getByRole('switch', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(80);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.preview-sidebar')).opacity === '1'), `${scheme}: reduced motion reveals instantly`);

    check(errors.length === 0, `${scheme}: no runtime errors`);
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 480, height: 900 }, colorScheme: 'dark' });
  await page.goto(pageUrl);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow viewport has no horizontal overflow');
  await page.close();

  console.log(`PASS: ${checks} settings mock checks (${engine.name()}); app-idiom rows, option clusters, switches, slider, preview motion, themes.`);
} finally { await browser.close(); }
