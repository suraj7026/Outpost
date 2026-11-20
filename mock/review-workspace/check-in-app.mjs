import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1728, height: 1080 }, colorScheme: 'dark', timezoneId: 'UTC' });
  const errors = [], requests = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto(new URL('in-app.html', root).href);
  await page.locator('.in-app-review iframe').waitFor({ timeout: 20000 });
  const reviewer = page.frameLocator('.in-app-review iframe');
  await reviewer.locator('#preview h1').waitFor();
  assert.deepEqual(await page.locator('.in-app-review iframe').evaluate(el => {
      const style = getComputedStyle(el);
      return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius];
    }), ['0px', '0px', '0px', '0px'], 'Workspace frame has square corners');
  const paneGeometry = await page.locator('.in-app-review').evaluate(el => {
    const style = getComputedStyle(el);
    const frame = el.querySelector('iframe');
    const frameStyle = getComputedStyle(frame);
    const pane = el.getBoundingClientRect();
    const content = frame.getBoundingClientRect();
    const columns = el.parentElement.getBoundingClientRect();
    return {
      padding: style.padding,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      frameBorder: frameStyle.borderWidth,
      flush: Math.abs(content.top - columns.top) < 1 && Math.abs(content.bottom - columns.bottom) < 1 && Math.abs(content.right - columns.right) < 1,
      fullHeight: Math.abs(pane.height - columns.height) < 1,
    };
  });
  assert.equal(paneGeometry.padding, '0px');
  assert.deepEqual(paneGeometry.borders, ['0px', '0px', '0px', '1px']);
  assert.equal(paneGeometry.frameBorder, '0px');
  assert.ok(paneGeometry.flush && paneGeometry.fullHeight, 'Workspace is flush with only a full-height left divider');
  assert.equal(await reviewer.locator('#doc-tab').evaluate(el => getComputedStyle(el).borderTopLeftRadius), '8px');
  assert.equal(await reviewer.locator('.modes').evaluate(el => getComputedStyle(el).borderTopLeftRadius), '12px');
  assert.equal(await reviewer.locator('.review-footer, #mark-reviewed, #review-status').count(), 0);
  assert.ok(await reviewer.locator('#document-scroll').evaluate(el => Math.abs(el.getBoundingClientRect().bottom - innerHeight) < 2), 'Document fills the pane to the bottom');
  const workspaceToggle = page.locator('.workspace-toggle');
  await workspaceToggle.waitFor();
  assert.equal(await workspaceToggle.count(), 1);
  assert.equal(await page.locator('.in-app-file-card .review-file-arrow').count(), 1);
  assert.equal((await page.locator('.in-app-file-card').textContent()).includes('↗'), false);
  assert.equal(await page.locator('.review-file-arrow').getAttribute('aria-hidden'), 'true');
  assert.equal(await reviewer.locator('.workspace-close').count(), 0, 'No duplicate close icon in the pane');
  await page.evaluate(() => document.fonts.ready);
  await reviewer.locator('body').evaluate(() => document.fonts.ready);
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  await page.locator('.conversation').evaluate(el => { el.scrollTop = 0; });
  const assertAlignedRows = async (browserView = false) => {
    const differences = await reviewer.locator('body').evaluate((body, browserView) => {
      const bottom = selector => body.querySelector(selector).getBoundingClientRect().bottom;
      return [
        bottom('.tabs') - bottom('.explorer .panel-heading'),
        bottom(browserView ? '.browser-address' : '.document-toolbar') - bottom('.file-filter-row'),
        bottom(browserView ? '.browser-label' : '.document-info') - bottom('.file-switch'),
      ];
    }, browserView);
    assert.ok(differences.every(value => Math.abs(value) < 1), `Document/browser and file-sidebar dividers align: ${differences}`);
  };
  await assertAlignedRows();
  await page.screenshot({ path: fileURLToPath(new URL('in-app-preview.png', root)) });
  const divider = page.getByRole('separator', { name: 'Resize chat and workspace' });
  const chatWidth = () => page.locator('.conversation-column').evaluate(el => Math.round(el.getBoundingClientRect().width));
  const dragDivider = async delta => {
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  const initialWidth = await chatWidth();
  const togglePosition = await workspaceToggle.boundingBox();
  await dragDivider(140);
  assert.equal(await chatWidth(), initialWidth + 140, 'Divider resizes across the embedded browser');
  assert.deepEqual(await workspaceToggle.boundingBox(), togglePosition, 'Toggle stays fixed during resizing');
  await assertAlignedRows();
  assert.equal(await page.locator('html').evaluate(el => el.classList.contains('in-app-resizing')), false);
  await divider.press('ArrowRight');
  assert.equal(await chatWidth(), initialWidth + 156);
  await divider.press('ArrowLeft');
  assert.equal(await chatWidth(), initialWidth + 140);
  await divider.press('Home');
  assert.equal(await chatWidth(), 600, 'Minimum chat width keeps the composer on one row');
  const composerLayout = await page.locator('.reply-composer-stack').evaluate(stack => {
    const centers = selectors => selectors.map(selector => {
      const box = stack.querySelector(selector).getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const toolbar = centers(['.composer-toolbar > .icon-button', '.composer-permission', '.composer-model-control', '.send-button']);
    const status = centers(['.composer-context-identity', '.composer-run-status', '.composer-terminal', '.composer-follow']);
    return { toolbarSpread: Math.max(...toolbar) - Math.min(...toolbar), statusSpread: Math.max(...status) - Math.min(...status), width: stack.getBoundingClientRect().width };
  });
  assert.ok(composerLayout.width > 560);
  assert.ok(composerLayout.toolbarSpread < 3, 'Composer controls stay in one row at minimum width');
  assert.ok(composerLayout.statusSpread < 3, 'Server/status controls stay in one row at minimum width');
  await dragDivider(-200);
  assert.equal(await chatWidth(), 600);
  await divider.press('ArrowLeft');
  assert.equal(await chatWidth(), 600);
  await page.screenshot({ path: fileURLToPath(new URL('in-app-minimum-width.png', root)) });
  await divider.press('End');
  assert.ok(await chatWidth() <= 760);
  assert.ok(await page.locator('.in-app-review').evaluate(el => el.getBoundingClientRect().width >= 420));
  await divider.dblclick();
  assert.equal(await chatWidth(), 600, 'Double-click restores default width');
  await dragDivider(140);
  const resizedWidth = await chatWidth();
  await page.screenshot({ path: fileURLToPath(new URL('in-app-resized.png', root)) });
  await page.setViewportSize({ width: 1600, height: 1080 });
  await page.waitForFunction(() => document.querySelector('.in-app-review').getBoundingClientRect().width < 680);
  await assertAlignedRows();
  await page.setViewportSize({ width: 1300, height: 1080 });
  await page.waitForFunction(() => document.querySelector('.in-app-review').getBoundingClientRect().width >= 419);
  assert.ok(await chatWidth() >= 600);
  await page.setViewportSize({ width: 1100, height: 1080 });
  await divider.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.conversation-column').isVisible(), false, 'Insufficient space switches panes rather than squeezing chat');
  await page.setViewportSize({ width: 850, height: 1080 });
  await divider.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.conversation-column').isVisible(), false, 'Narrow view uses a single pane');
  const narrowTogglePosition = await workspaceToggle.boundingBox();
  assert.ok(narrowTogglePosition, 'Toggle stays accessible in the narrow layout');
  await workspaceToggle.click();
  assert.deepEqual(await workspaceToggle.boundingBox(), narrowTogglePosition);
  await workspaceToggle.click();
  assert.deepEqual(await workspaceToggle.boundingBox(), narrowTogglePosition);
  await page.setViewportSize({ width: 1728, height: 1080 });
  await divider.waitFor({ state: 'visible' });
  await page.waitForFunction(width => Math.round(document.querySelector('.conversation-column').getBoundingClientRect().width) === width, resizedWidth);
  await reviewer.locator('[data-mode="changes"]').click();
  await page.screenshot({ path: fileURLToPath(new URL('in-app-changes.png', root)) });
  await reviewer.locator('[data-mode="preview"]').click();
  await reviewer.locator('#browser-tab').click();
  await assertAlignedRows(true);
  await page.screenshot({ path: fileURLToPath(new URL('in-app-browser.png', root)) });
  await workspaceToggle.click();
  assert.equal(await page.locator('.in-app-review').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Open workspace', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await workspaceToggle.boundingBox(), togglePosition, 'Toggle stays fixed when closed');
  assert.equal(await workspaceToggle.textContent(), '', 'Workspace control is icon-only');
  assert.equal(await workspaceToggle.locator('svg').count(), 1);
  assert.equal(await workspaceToggle.getAttribute('title'), 'Open workspace');
  assert.equal(await workspaceToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await workspaceToggle.evaluate(el => getComputedStyle(el).borderRadius), '12px');
  const collapsedWidth = await page.locator('.conversation-column').evaluate(el => el.getBoundingClientRect().width);
  await page.screenshot({ path: fileURLToPath(new URL('in-app-collapsed.png', root)) });
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  assert.equal(await reviewer.locator('#browser-view').isVisible(), true, 'Browser tab survives reopening');
  assert.deepEqual(await workspaceToggle.boundingBox(), togglePosition, 'Toggle stays fixed when reopened');
  assert.equal(await workspaceToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await workspaceToggle.getAttribute('title'), 'Close workspace');
  await workspaceToggle.press('Enter');
  assert.equal(await page.locator('.in-app-review').isVisible(), false);
  await workspaceToggle.press('Space');
  assert.equal(await page.locator('.in-app-review').isVisible(), true);
  const expandedWidth = await page.locator('.conversation-column').evaluate(el => el.getBoundingClientRect().width);
  assert.equal(Math.round(expandedWidth), resizedWidth, 'Chosen width survives collapse/reopen');
  assert.ok(collapsedWidth > expandedWidth + 400, 'Chat reclaims workspace width');
  await reviewer.locator('#doc-tab').click();
  await reviewer.locator('[data-file="sources"]').click();
  await reviewer.locator('[data-mode="source"]').click();
  await reviewer.getByRole('button', { name: 'Toggle file list', exact: true }).click();
  assert.equal(await reviewer.locator('.explorer').isVisible(), false);
  await reviewer.locator('#doc-tab').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.in-app-review').isVisible(), false);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  assert.equal(await reviewer.locator('#tab-filename').innerText(), 'sources.md');
  assert.equal(await reviewer.locator('#source').isVisible(), true, 'Document mode survives reopening');
  assert.equal(await reviewer.locator('.explorer').isVisible(), false, 'File-list visibility survives reopening');
  await reviewer.getByRole('button', { name: 'Toggle file list', exact: true }).click();
  assert.equal(await reviewer.locator('.explorer').isVisible(), true);
  await reviewer.locator('[data-file="readme"]').click();
  await reviewer.locator('[data-mode="preview"]').click();
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  assert.equal(await page.locator('.in-app-review').isVisible(), false);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  assert.equal(await page.locator('.in-app-review').isVisible(), true);
  await page.getByRole('button', { name: 'Files, changes and browser', exact: true }).click();
  assert.equal(await page.locator('.in-app-review').isVisible(), false);
  await page.locator('.in-app-file-card').click();
  assert.equal(await page.locator('.in-app-review').isVisible(), true);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.locator('#app-sidebar[data-motion="closed"]').waitFor({ state: 'attached' });
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.locator('.conversation').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: fileURLToPath(new URL('in-app-focused.png', root)) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => window.__inAppPreview.blocked), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log('PASS: pointer/keyboard resizing, min widths, reset, viewport clamping, width retention, workspace collapse/reopen, full-width chat, independent file-list toggle, tab/file/mode preservation, Escape/focus return, real composer controls, and isolated transport. No network requests or unexpected IPC.');
} finally {
  await browser.close();
}
