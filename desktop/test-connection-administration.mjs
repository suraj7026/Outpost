import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { openSettings, serverTab, settingsTestAssets } from './settings-test-navigation.mjs';

// Current React source and synthetic IPC only: no Keychain, accounts or server connections.
const server = createServer(await settingsTestAssets());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true });
const self = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const publicKey = Buffer.alloc(32, 9).toString('base64');
const record = (kind, id, revision, data) => ({ kind, id, revision, data, updatedAt: '2026-10-30T00:00:00Z' });
const fixture = {
  snapshot: { protocolVersion: 1, cursor: 1, records: [
    record('device', self, 1, { name: 'Outpost Desktop', publicKey, revoked: false }),
    record('device', other, 3, { name: 'Other Mac', publicKey, revoked: false }),
    record('recovery', 'server', 5, { dispatchEnabled: false, reason: 'Review restored work.', restoredAt: '2026-10-30T00:00:00Z' }),
    record('task', 'waiting-one', 1, { goal: 'First queued task', state: 'queued' }),
    record('task', 'waiting-two', 1, { goal: 'Second queued task', state: 'queued' }),
    record('task', 'finished', 1, { goal: 'Completed task', state: 'completed' }),
  ] },
  runtime: { configured: true, model: 'fixture', hostAdministration: false, browserDirect: false, browserEngine: null, unrestrictedCommands: false },
  models: { models: [], defaultModel: '' },
};
const errors = [];
async function open(scenario = 'normal') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(({ fixture, scenario, self, publicKey }) => {
    window.__requests = []; window.__recoveryReads = 0;
    window.__supplyRecovery = () => {
      fixture.snapshot.records = fixture.snapshot.records.filter(row => row.kind !== 'recovery');
      fixture.snapshot.records.push({ kind: 'recovery', id: 'server', revision: 8, updatedAt: '2026-10-30T00:00:00Z', data: { dispatchEnabled: false, reason: 'Review restored work.' } });
      fixture.snapshot.cursor++;
    };
    window.__advanceRevision = () => { fixture.snapshot.records.forEach(row => row.revision++); fixture.snapshot.cursor++; window.__publish?.(); };
    if (scenario === 'preview') { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; return; }
    if (scenario === 'revoked') fixture.snapshot.records[0].data.revoked = true;
    if (scenario === 'missing') fixture.snapshot.records = fixture.snapshot.records.filter(row => row.kind !== 'recovery');
    if (scenario === 'unknown-state') fixture.snapshot.records.find(row => row.kind === 'recovery').data.dispatchEnabled = null;
    let sequence = 0, pending = scenario === 'pending', failed = false;
    const callbacks = new Map();
    window.isTauri = true;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => {
      if (window.__clipboardFail) throw new Error('Clipboard unavailable');
      window.__copied = value;
    } } });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback) { const id = ++sequence; callbacks.set(id, callback); return id; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: scenario === 'retired', selectedEnvironmentId: null, environments: {} }, legacy: { endpoint: null, pending: false } };
        if (command === 'disconnect') return;
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Fixture transport', deviceId: self, publicKey, pending, pendingError: scenario === 'pending-error' ? 'Synthetic unreadable recovery storage' : null, nativeSidebar: false };
        if (command === 'query') {
          if (scenario === 'offline' || (scenario === 'disconnect' && failed)) throw new Error('Offline fixture: cannot reach server');
          if (args.kind === 'snapshot') { window.__recoveryReads++; return structuredClone(fixture.snapshot); }
          if (args.kind === 'runtime') return fixture.runtime;
          if (args.kind === 'models') return fixture.models;
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: fixture.snapshot.cursor };
        }
        if (command === 'stream_events') return new Promise(() => {
          let index = 0;
          window.__publish = () => callbacks.get(args.channel.id)?.({ index: index++, message: { type: 'snapshot', cursor: fixture.snapshot.cursor, records: structuredClone(fixture.snapshot.records), live: [] } });
          window.__publish();
        });
        if (command === 'update_sidebar' || command.startsWith('plugin:event|')) return 1;
        window.__requests.push({ command, args });
        if (command === 'send_command') {
          const row = fixture.snapshot.records.find(row => row.id === args.id);
          if (scenario === 'stale' && !failed) { failed = true; row.revision++; fixture.snapshot.cursor++; throw new Error('revision_conflict'); }
          if (scenario === 'disconnect') { failed = true; throw new Error('Cannot reach server'); }
          if (scenario === 'unknown') { pending = true; throw new Error('Outcome unknown; retry the same command'); }
          if (row.revision !== args.revision) throw new Error('revision_conflict');
          row.revision++; fixture.snapshot.cursor++;
          if (args.kind === 'device.revoke') row.data.revoked = true;
          if (args.kind === 'recovery.resume') row.data.dispatchEnabled = true;
          return structuredClone(row);
        }
        if (command === 'enroll_device') {
          if (scenario === 'enrollment-error') throw new Error('Enrollment outcome unknown. Refresh trusted devices before trying again.');
          const row = { id: args.deviceId, kind: 'device', revision: 1, updatedAt: '', data: { name: args.name, publicKey: args.publicKey, revoked: false } };
          fixture.snapshot.records.push(row); fixture.snapshot.cursor++; return row;
        }
        throw new Error('Unexpected fixture IPC');
      },
    };
  }, { fixture, scenario, self, publicKey });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openSettings(page, { tab: 'devices' });
  await page.getByRole('heading', { name: 'Trusted devices', exact: true }).waitFor();
  return page;
}
const requests = page => page.evaluate(() => window.__requests);
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
async function details(page, name = 'Other Mac') {
  await page.getByRole('article', { name, exact: true }).getByRole('button', { name: 'Details', exact: true }).click();
  return dialog(page, 'Device details');
}
async function revoke(page, name = 'Other Mac') {
  await (await details(page, name)).getByRole('button', { name: 'Revoke access…', exact: true }).click();
  return dialog(page, 'Revoke device access?');
}
async function confirmRevoke(page) {
  const modal = dialog(page, 'Revoke device access?');
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Confirm revocation', exact: true }).click();
}
async function resume(page) {
  await page.getByRole('checkbox', { name: /I reviewed device authority/ }).check();
  await page.getByRole('button', { name: 'Resume work…', exact: true }).click();
  return dialog(page, 'Resume queued work?');
}
async function confirmResume(page) {
  const modal = dialog(page, 'Resume queued work?');
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Confirm and resume dispatch', exact: true }).click();
}
async function fillEnrollment(page, target) {
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  const modal = dialog(page, 'Add a trusted device');
  await modal.getByLabel('Device name', { exact: true }).fill('New Mac');
  await modal.getByLabel('Other device ID', { exact: true }).fill(target);
  await modal.getByLabel('Other device public pairing key', { exact: true }).fill(publicKey);
  assert.ok(await modal.getByRole('button', { name: 'Enroll device', exact: true }).isDisabled());
  await modal.getByRole('checkbox').check();
  return modal;
}
try {
  const page = await open();
  assert.deepEqual(await page.locator('.settings-page-content h2').allTextContents(), ['Trusted devices', 'Your device identity']);
  assert.equal(await page.locator('.settings-breadcrumb, .settings-connection-status').count(), 0);
  await page.setViewportSize({ width: 900, height: 900 });
  const tabs = await page.locator('.server-settings-tabs a').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  assert.equal(new Set(tabs).size, 1, 'All six tabs stay on one row at 900px');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const info = await details(page);
  await info.getByRole('button', { name: 'Copy device identity', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copied), `${other}\n${publicKey}`);
  await page.evaluate(() => { window.__clipboardFail = true; });
  await info.getByRole('button', { name: 'Copy device identity', exact: true }).click();
  await info.getByText(/Clipboard unavailable/).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await page.getByRole('article', { name: 'Other Mac', exact: true }).getByRole('button', { name: 'Details', exact: true }).evaluate(node => node === document.activeElement));
  let modal = await revoke(page);
  assert.ok(await modal.getByRole('button', { name: 'Confirm revocation' }).isDisabled());
  assert.deepEqual(await requests(page), []);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(await requests(page), []);
  await revoke(page); await confirmRevoke(page);
  await page.getByRole('article', { name: 'Other Mac', exact: true }).getByText('Revoked', { exact: true }).waitFor();
  assert.deepEqual((await requests(page))[0], { command: 'send_command', args: { kind: 'device.revoke', id: other, revision: 3, payload: {} } });
  await serverTab(page, 'recovery');
  await page.getByText('1 trusted · 1 revoked · 0 authority unknown', { exact: true }).waitFor();
  await page.getByText(/2 queued of 3 received task records/).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Resume work…', exact: true }).isDisabled());
  modal = await resume(page);
  assert.equal((await requests(page)).length, 1, 'Opening resume confirmation sends nothing');
  assert.ok(await modal.getByRole('button', { name: 'Confirm and resume dispatch' }).isDisabled());
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await requests(page)).length, 1);
  await page.getByRole('button', { name: 'Resume work…', exact: true }).click(); await confirmResume(page);
  await page.locator('.settings-recovery-state h3').getByText('No recovery hold', { exact: true }).waitFor();
  assert.deepEqual((await requests(page))[1], { command: 'send_command', args: { kind: 'recovery.resume', id: 'server', revision: 5, payload: { acknowledged: true } } });
  await serverTab(page, 'devices');
  const target = '33333333-3333-4333-8333-333333333333';
  modal = await fillEnrollment(page, target);
  await modal.getByRole('button', { name: 'Enroll device', exact: true }).click();
  await page.getByRole('article', { name: 'New Mac', exact: true }).waitFor();
  assert.deepEqual((await requests(page))[2], { command: 'enroll_device', args: { deviceId: target, name: 'New Mac', publicKey } });
  modal = await revoke(page, 'Outpost');
  await modal.getByText(/This Mac will lose access/).waitFor();
  await confirmRevoke(page);
  await page.getByText('This device is revoked. Use another trusted device to manage the server.', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Add device', exact: true }).isDisabled());
  await page.close();

  for (const kind of ['revoke', 'resume']) {
    const stale = await open('stale');
    if (kind === 'revoke') { await revoke(stale); await confirmRevoke(stale); }
    else { await serverTab(stale, 'recovery'); await resume(stale); await confirmResume(stale); }
    await stale.getByRole('alert').filter({ hasText: 'revision_conflict' }).waitFor();
    await stale.getByText(/Not confirmed. Review the error/).waitFor();
    assert.equal((await requests(stale)).length, 1);
    if (kind === 'revoke') {
      const modal = await revoke(stale);
      await modal.getByText(/Revoke Other Mac at revision 4/).waitFor();
      await confirmRevoke(stale);
    } else {
      assert.ok(await stale.getByRole('button', { name: 'Resume work…', exact: true }).isDisabled());
      assert.equal(await stale.getByRole('checkbox').isChecked(), false);
      await resume(stale); await confirmResume(stale);
    }
    await stale.waitForFunction(() => window.__requests.length === 2);
    assert.equal((await requests(stale))[1].args.revision, kind === 'revoke' ? 4 : 6);
    await stale.close();
  }
  const changed = await open();
  modal = await revoke(changed);
  await modal.getByRole('checkbox').check();
  await changed.evaluate(() => window.__advanceRevision());
  await modal.getByText('Device changed. Cancel and review its current revision.').waitFor();
  assert.ok(await modal.getByRole('button', { name: 'Confirm revocation' }).isDisabled());
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await serverTab(changed, 'recovery');
  modal = await resume(changed); await modal.getByRole('checkbox').check();
  await changed.evaluate(() => window.__advanceRevision());
  await modal.getByText('Recovery changed. Cancel and review its current revision.').waitFor();
  assert.ok(await modal.getByRole('button', { name: 'Confirm and resume dispatch' }).isDisabled());
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(await changed.getByRole('button', { name: 'Resume work…', exact: true }).isDisabled());
  assert.equal(await changed.getByRole('checkbox').isChecked(), false);
  assert.deepEqual(await requests(changed), []);
  await changed.close();

  const disconnected = await open('disconnect');
  await serverTab(disconnected, 'recovery'); await resume(disconnected); await confirmResume(disconnected);
  await disconnected.getByText(/Not confirmed. Review the error/).waitFor();
  await serverTab(disconnected, 'devices');
  await disconnected.getByText('Offline. Showing last received records, not current authority.').waitFor();
  assert.ok(await disconnected.getByRole('button', { name: 'Add device', exact: true }).isDisabled());
  await disconnected.close();
  for (const scenario of ['preview', 'offline', 'revoked', 'retired', 'pending', 'pending-error', 'unknown']) {
    const page = await open(scenario);
    if (scenario === 'unknown') {
      await serverTab(page, 'recovery'); await resume(page); await confirmResume(page);
      await page.getByRole('button', { name: 'Retry same command' }).waitFor();
      await page.getByText(/Not confirmed. Review the error/).waitFor();
      await serverTab(page, 'devices');
    }
    assert.ok(await page.getByRole('button', { name: 'Add device', exact: true }).isDisabled());
    if (await page.getByRole('article', { name: 'Other Mac', exact: true }).count()) {
      const info = await details(page);
      assert.ok(await info.getByRole('button', { name: 'Revoke access…', exact: true }).isDisabled());
      await info.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await serverTab(page, 'recovery');
    for (const checkbox of await page.getByRole('checkbox').all()) assert.ok(await checkbox.isDisabled());
    if (scenario === 'preview' || scenario === 'retired') {
      await serverTab(page, 'setup');
      await page.getByText('Legacy connection & first-device pairing', { exact: true }).click();
      assert.ok(await page.getByRole('button', { name: 'Save and connect' }).isDisabled());
      assert.ok(await page.getByRole('button', { name: 'Pair device', exact: true }).isDisabled());
    }
    if (scenario === 'pending-error') {
      await serverTab(page, 'general');
      await page.getByRole('alert').filter({ hasText: 'Synthetic unreadable recovery storage' }).waitFor();
      assert.ok(await page.getByRole('button', { name: 'Remove connection…', exact: true }).isDisabled());
    }
    assert.equal((await requests(page)).length, scenario === 'unknown' ? 1 : 0);
    await page.close();
  }
  for (const scenario of ['missing', 'unknown-state']) {
    const page = await open(scenario); await serverTab(page, 'recovery');
    await page.getByRole('heading', { name: 'Recovery state not reported', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Resume work…', exact: true }).count(), 0);
    const reviewButton = page.getByRole('button', { name: 'Needs review', exact: true });
    await reviewButton.focus(); await page.keyboard.press('Enter');
    const review = dialog(page, 'Review recovery'); await review.waitFor();
    assert.equal(await review.getByRole('link', { name: 'Open connection settings' }).getAttribute('href'), '#settings/servers/legacy/setup');
    assert.equal(await review.getByRole('link', { name: 'Review trusted devices' }).getAttribute('href'), '#settings/servers/legacy/devices');
    assert.equal(await review.getByRole('link', { name: 'Check Pi & server release' }).getAttribute('href'), '#settings/servers/legacy/runtime');
    const beforeRefresh = await page.evaluate(() => window.__recoveryReads);
    await review.getByRole('button', { name: 'Refresh recovery status' }).click();
    await review.getByRole('status').filter({ hasText: 'Status refreshed' }).waitFor();
    assert.equal(await page.evaluate(() => window.__recoveryReads), beforeRefresh + 1, 'Review refreshes the owning snapshot');
    assert.equal(await review.getByRole('button', { name: 'Review paused work' }).count(), 0, 'Unknown state never enables resume');
    assert.deepEqual(await requests(page), [], 'Review and refresh do not dispatch, retry or create recovery records');
    if (scenario === 'missing') {
      await page.evaluate(() => window.__supplyRecovery());
      await review.getByRole('button', { name: 'Refresh recovery status' }).click();
      await review.getByText('Work held · revision 8', { exact: true }).waitFor();
      await review.getByRole('button', { name: 'Review paused work' }).click();
      await review.waitFor({ state: 'hidden' });
      const acknowledgement = page.getByRole('checkbox', { name: /I reviewed device authority/ });
      assert.equal(await acknowledgement.isChecked(), false, 'Refreshed hold still requires explicit acknowledgement');
      await page.waitForFunction(() => document.activeElement?.type === 'checkbox');
      assert.ok(await page.getByRole('button', { name: 'Resume work…', exact: true }).isDisabled());
      assert.deepEqual(await requests(page), [], 'Navigating to the paused-work review does not resume work');
    } else {
      await page.keyboard.press('Escape'); await review.waitFor({ state: 'hidden' });
      assert.ok(await reviewButton.evaluate(node => node === document.activeElement), 'Review returns keyboard focus to its trigger');
    }
    await page.close();
  }
  const failed = await open('enrollment-error');
  modal = await fillEnrollment(failed, target);
  await modal.getByRole('button', { name: 'Enroll device', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: 'Enrollment outcome unknown' }).waitFor();
  assert.equal(await failed.getByRole('article', { name: 'New Mac', exact: true }).count(), 0);
  assert.equal(await modal.getByLabel('Device name', { exact: true }).inputValue(), 'New Mac');
  assert.equal(await modal.getByRole('checkbox').isChecked(), false);
  assert.ok(await modal.getByRole('button', { name: 'Enroll device', exact: true }).isDisabled());
  await failed.waitForTimeout(2100);
  assert.equal((await requests(failed)).filter(request => request.command === 'enroll_device').length, 1);
  assert.deepEqual(errors, []);
  console.log(`PASS (${engine.name()}): recovery review navigation and read-only refresh, modal enrollment/copy/revocation, separate resume confirmation, stale revisions, self revocation, pending errors, unknown outcomes, read-only controls, and 900px tabs.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
