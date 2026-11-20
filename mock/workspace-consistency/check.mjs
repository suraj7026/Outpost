import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1568, height: 1100 }, colorScheme: 'dark' });
  const errors = [], external = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
  await page.goto(new URL('index.html', root).href);
  await page.locator('.settings-workspace h1').waitFor({ timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  await page.locator('.preview-attention-count').first().waitFor();
  assert.equal(await page.locator('.web-sidebar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(15, 15, 15)');
  assert.equal(await page.locator('.main-shell').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(30, 30, 30)');
  const assertNeutral = async selector => {
    const colors = await page.locator(selector).evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor));
    for (const color of colors) {
      const components = color.match(/[\d.]+/g)?.map(Number);
      assert.ok(components && components[0] === components[1] && components[1] === components[2], `Neutral surface expected for ${selector}: ${color}`);
    }
  };
  assert.equal(await page.locator('.appearance-width-options').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(25, 25, 25)');
  assert.equal(await page.locator('.appearance-width-options label:has(input:checked)').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(54, 54, 54)');
  await assertNeutral('.appearance-width-options, .appearance-width-options label:has(input:checked)');
  const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, root)), animations: 'disabled' });
  const checkPopup = async name => {
    const dialog = page.getByRole('dialog', { name, exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('dialog[open]')].every(el => el.classList.contains('preview-standard-dialog')));
    await assertNeutral('dialog[open], dialog[open] input, dialog[open] select, dialog[open] textarea');
    assert.equal(await dialog.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(36, 36, 36)');
    const geometry = await dialog.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const footer = el.querySelector('.ui-dialog-actions, .workspace-dialog-actions, .modal-actions');
      const buttons = footer ? [...footer.querySelectorAll(':scope > button')].filter(button => button.getBoundingClientRect().width) : [];
      return { radius: getComputedStyle(el).borderRadius, overflow: el.scrollWidth > el.clientWidth + 1, inside: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, buttons: buttons.map(button => { const r = button.getBoundingClientRect(); return { height: r.height, center: r.top + r.height / 2, right: r.right, inside: r.top >= rect.top && r.bottom <= rect.bottom };  }) };
    });
    assert.equal(geometry.radius, '16px');
    assert.equal(geometry.overflow, false, `${name} has no horizontal overflow`);
    assert.equal(geometry.inside, true, `${name} fits the viewport`);
    for (const button of geometry.buttons) {
      assert.equal(button.height, 36, `${name} action buttons share one height`);
      assert.ok(button.inside, `${name} action buttons stay visible`);
      assert.ok(Math.abs(button.center - geometry.buttons[0].center) < 1, `${name} footer buttons align`);
    }
    return dialog;
  };
  const bounds = () => page.locator('.main-shell > .page').evaluate(el => {
    const r = el.getBoundingClientRect();
    const title = el.querySelector('h1').getBoundingClientRect();
    return { x: r.x, width: r.width, titleX: title.x };
  });
  const expected = await bounds();
  assert.equal(expected.width, 1040);
  const alignment = await page.locator('.settings-workspace').evaluate(el => ({ title: el.querySelector('h1').getBoundingClientRect().left, section: el.querySelector('.ui-section-heading h2').getBoundingClientRect().left, icon: el.querySelector('.settings-header-icon').getBoundingClientRect().right }));
  assert.equal(alignment.title, alignment.section);
  assert.ok(alignment.icon < alignment.title);
  assert.equal(await page.getByRole('button', { name: /^Approvals/ }).count(), 0);
  const bareIcon = async () => {
    const icon = page.locator('.main-shell > .page > .page-heading > .preview-page-icon');
    await icon.waitFor();
    assert.equal(await icon.locator('svg').count(), 1);
    const style = await icon.evaluate(el => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, border: s.borderWidth, shadow: s.boxShadow, width: el.querySelector('svg').getBoundingClientRect().width };
    });
    assert.deepEqual(style, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', width: 20 });
  };
  await bareIcon();
  await screenshot('settings');
  for (const [label, name] of [['Machines', 'machines'], ['Library', 'library'], ['Automations', 'automations'], ['Memory', 'memory'], ['All chats', 'all-chats']]) {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: label, exact: true }).click();
    await page.locator('.main-shell > .page h1').filter({ hasText: label }).waitFor();
    await page.waitForTimeout(100);
    assert.deepEqual(await bounds(), expected, `${label} follows Settings column and heading alignment`);
    await bareIcon();
    await assertNeutral('.main-shell > .page input, .main-shell > .page select, .machines-server-card, .workspace-chat, .workspace-note-card, .outputs-grid > .artifact');
    await screenshot(name);
    if (label === 'Memory') {
      const memoryPositions = () => page.locator('.workspace-scope-row').evaluate(row => {
        const scope = row.querySelector('.workspace-scope').getBoundingClientRect();
        const content = row.nextElementSibling.getBoundingClientRect();
        return { x: scope.x, y: scope.y, width: scope.width, height: scope.height, contentY: content.y };
      });
      const allServers = await memoryPositions();
      await page.getByRole('button', { name: 'One server', exact: true }).click();
      await page.getByRole('combobox', { name: 'Server', exact: true }).waitFor();
      assert.deepEqual(await memoryPositions(), allServers, 'Memory scope and content do not shift when server selector appears');
      await screenshot('memory-one-server');
      await page.getByRole('button', { name: 'All servers', exact: true }).click();
      assert.deepEqual(await memoryPositions(), allServers, 'Memory scope and content do not shift when server selector disappears');
    }
  }
  const attention = page.locator('.preview-attention-filter');
  const filterGeometry = await page.locator('.all-chats-page .workspace-toolbar').evaluate(toolbar => {
    const controls = [toolbar.querySelector('input'), toolbar.querySelector('select'), toolbar.querySelector('.preview-attention-filter')];
    return controls.map(control => { const rect = control.getBoundingClientRect(), style = getComputedStyle(control); return { top: rect.top, bottom: rect.bottom, height: rect.height, fontSize: style.fontSize, radius: style.borderRadius }; });
  });
  for (const control of filterGeometry) {
    assert.equal(control.height, 40);
    assert.equal(control.top, filterGeometry[0].top);
    assert.equal(control.bottom, filterGeometry[0].bottom);
    assert.equal(control.fontSize, filterGeometry[0].fontSize);
    assert.equal(control.radius, filterGeometry[0].radius);
  }
  const centers = await attention.evaluate(button => [...button.children].map(child => { const rect = child.getBoundingClientRect(); return rect.top + rect.height / 2; }));
  assert.ok(centers.every(center => Math.abs(center - centers[0]) < 1), 'Attention icon, label, and count share one centerline');
  await attention.click();
  assert.equal(await page.locator('.workspace-chat:visible').count(), 2);
  await screenshot('all-chats-attention');
  await page.locator('.workspace-chat[data-task-id="deployment-review"]').click();
  await page.locator('.preview-chat-attention').waitFor();
  assert.match(await page.locator('.preview-chat-attention').innerText(), /2 approvals/);
  await assertNeutral('.reply-composer, .composer-context-run');
  await screenshot('chat-approval');
  await page.locator('.preview-chat-attention').click();
  await page.getByRole('dialog', { name: 'Review the exact action' }).waitFor();
  await page.locator('.preview-action-proxy').first().waitFor();
  await checkPopup('Review the exact action');
  assert.equal(await page.locator('.action-review-dialog .modal-actions > button').count(), 3);
  await screenshot('exact-action-review');
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.locator('.model-picker-trigger').click();
  await checkPopup('Model for the next instruction');
  await page.getByRole('button', { name: 'Close model picker', exact: true }).waitFor();
  await screenshot('model-picker');
  await page.getByRole('button', { name: 'Close model picker', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  const schedule = await checkPopup('New schedule');
  await screenshot('new-schedule');
  const scheduleFooter = await schedule.locator('.workspace-dialog-actions').boundingBox();
  await schedule.locator('.workspace-fields').evaluate(fields => { fields.scrollTop = fields.scrollHeight; });
  assert.deepEqual(await schedule.locator('.workspace-dialog-actions').boundingBox(), scheduleFooter, 'Long forms keep footer actions fixed');
  await checkPopup('New schedule');
  await screenshot('new-schedule-actions');
  await page.setViewportSize({ width: 900, height: 600 });
  await checkPopup('New schedule');
  await screenshot('new-schedule-compact');
  await schedule.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 1568, height: 1100 });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('button', { name: 'New shared note', exact: true }).click();
  await checkPopup('New shared note');
  await screenshot('new-shared-note');
  await page.getByRole('dialog', { name: 'New shared note', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'One server', exact: true }).click();
  await page.getByRole('button', { name: 'New server note', exact: true }).click();
  await checkPopup('New server note');
  await screenshot('new-server-note');
  await page.getByRole('dialog', { name: 'New server note', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'All servers', exact: true }).click();
  await page.getByRole('button', { name: 'New shared note', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkPopup('New shared note');
  await screenshot('new-shared-note-390');
  await page.getByRole('dialog', { name: 'New shared note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 1568, height: 1100 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.screenshot({ path: fileURLToPath(new URL('settings-1000.png', root)) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(950, 400);
  if (await page.locator('#app-sidebar').getAttribute('aria-hidden') !== 'true') {
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).evaluate(button => button.click());
  }
  await page.locator('#app-sidebar[data-motion="closed"]').waitFor({ state: 'attached' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(380, 400);
  await screenshot('settings-390');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(await page.evaluate(() => window.__consistencyPreview.blocked), []);
  console.log('PASS: shared centered width, heading alignment, and bare icons on six real pages; approvals are on chat rows; consistent approval, model, schedule, and memory dialogs with aligned visible actions; no network or real server actions.');
} finally { await browser.close(); }
