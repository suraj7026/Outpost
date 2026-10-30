import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Synthetic IPC only: no Keychain, accounts, credentials or server connections.
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((req, res) => {
  const path = resolve(root, new URL(req.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const self = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const publicKey = Buffer.alloc(32, 9).toString('base64');
const record = (kind, id, revision, data) => ({ kind, id, revision, data, updatedAt: '2026-10-30T00:00:00Z' });
const fixture = {
  snapshot: { protocolVersion: 1, cursor: 1, records: [
    record('device', self, 1, { name: 'This Mac', publicKey, revoked: false }),
    record('device', other, 3, { name: 'Other Mac', publicKey, revoked: false }),
    record('recovery', 'server', 5, { dispatchEnabled: false, reason: 'Review restored work.', restoredAt: '2026-10-30T00:00:00Z' }),
  ] },
  runtime: { configured: true, model: 'fixture', hostAdministration: false, browserUse: false, unrestrictedCommands: false },
  models: { models: [], defaultModel: '' },
};
const errors = [];
async function open(scenario = 'normal') {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ fixture, scenario, self }) => {
    window.__requests = [];
    window.__advanceRevision = () => { fixture.snapshot.records.forEach(row => row.revision++); };
    if (scenario === 'preview') { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; return; }
    if (scenario === 'revoked') fixture.snapshot.records[0].data.revoked = true;
    let sequence = 0, pending = scenario === 'pending', failed = false;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return ++sequence; }, unregisterCallback() {},
      async invoke(command, args) {
        if (command === 'connection_info') return { endpoint: 'Fixture transport', deviceId: self, publicKey: '', pending, nativeSidebar: false };
        if (command === 'query') {
          if (scenario === 'offline' || (scenario === 'disconnect' && failed)) throw new Error('Offline fixture: cannot reach server');
          if (args.kind === 'snapshot') return structuredClone(fixture.snapshot);
          if (args.kind === 'runtime') return fixture.runtime;
          if (args.kind === 'models') return fixture.models;
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 1 };
        }
        if (command === 'stream_events') return new Promise(() => {});
        if (command === 'update_sidebar' || command.startsWith('plugin:event|')) return 1;
        window.__requests.push({ command, args });
        if (command === 'send_command') {
          const row = fixture.snapshot.records.find(row => row.id === args.id);
          if (scenario === 'stale' && !failed) { failed = true; row.revision++; throw new Error('revision_conflict'); }
          if (scenario === 'disconnect') { failed = true; throw new Error('Cannot reach server'); }
          if (scenario === 'unknown') { pending = true; throw new Error('Outcome unknown; retry the same command'); }
          assertRevision();
          function assertRevision() { if (row.revision !== args.revision) throw new Error('revision_conflict'); }
          row.revision++;
          if (args.kind === 'device.revoke') row.data.revoked = true;
          if (args.kind === 'recovery.resume') row.data.dispatchEnabled = true;
          return structuredClone(row);
        }
        if (command === 'enroll_device') {
          if (scenario === 'enrollment-error') throw new Error('Enrollment outcome unknown. Refresh trusted devices before trying again.');
          const row = { id: args.deviceId, kind: 'device', revision: 1, updatedAt: '', data: { name: args.name, publicKey: args.publicKey, revoked: false } };
          fixture.snapshot.records.push(row); return row;
        }
        throw new Error('Unexpected fixture IPC');
      },
    };
  }, { fixture, scenario, self });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Trusted devices', exact: true }).waitFor();
  return page;
}
try {
  const page = await open();
  const resume = page.getByRole('button', { name: 'Confirm and resume dispatch' });
  assert.ok(await resume.isDisabled());
  await page.getByRole('button', { name: 'Revoke Other Mac…', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__requests), []);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__requests), []);
  await page.getByRole('button', { name: 'Revoke Other Mac…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revocation' }).click();
  await page.getByRole('article', { name: 'Other Mac', exact: true }).getByText('Revoked · Revision 4').waitFor();
  assert.deepEqual((await page.evaluate(() => window.__requests))[0], { command: 'send_command', args: { kind: 'device.revoke', id: other, revision: 3, payload: {} } });
  await page.getByRole('checkbox').check(); await resume.click();
  await page.getByText('Dispatch enabled · Revision 6', { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__requests))[1], { command: 'send_command', args: { kind: 'recovery.resume', id: 'server', revision: 5, payload: { acknowledged: true } } });
  const target = '33333333-3333-4333-8333-333333333333';
  await page.getByLabel('Device name', { exact: true }).fill('New Mac');
  await page.getByLabel('Other device ID', { exact: true }).fill(target);
  await page.getByLabel('Other device public pairing key', { exact: true }).fill(publicKey);
  await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
  await page.getByRole('article', { name: 'New Mac', exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.__requests))[2], { command: 'enroll_device', args: { deviceId: target, name: 'New Mac', publicKey } });
  await page.getByRole('button', { name: 'Revoke This Mac…', exact: true }).click();
  await page.getByText(/This Mac will lose access/).waitFor();
  await page.close();

  for (const kind of ['revoke', 'resume']) {
    const stale = await open('stale');
    if (kind === 'revoke') {
      await stale.getByRole('button', { name: 'Revoke Other Mac…', exact: true }).click();
      await stale.getByRole('button', { name: 'Confirm revocation' }).click();
    } else {
      await stale.getByRole('checkbox').check();
      await stale.getByRole('button', { name: 'Confirm and resume dispatch' }).click();
    }
    await stale.getByRole('alert').filter({ hasText: 'revision_conflict' }).waitFor();
    await stale.getByText(/Not confirmed. Review the error/).waitFor();
    assert.equal((await stale.evaluate(() => window.__requests)).length, 1);
    if (kind === 'revoke') {
      await stale.getByRole('button', { name: 'Revoke Other Mac…', exact: true }).click();
      await stale.getByText(/Revoke Other Mac at revision 4/).waitFor();
      await stale.getByRole('button', { name: 'Confirm revocation' }).click();
    } else {
      assert.ok(await stale.getByRole('button', { name: 'Confirm and resume dispatch' }).isDisabled());
      assert.equal(await stale.getByRole('checkbox').isChecked(), false);
      await stale.getByRole('checkbox').check();
      await stale.getByRole('button', { name: 'Confirm and resume dispatch' }).click();
    }
    await stale.waitForFunction(() => window.__requests.length === 2);
    assert.equal((await stale.evaluate(() => window.__requests))[1].args.revision, kind === 'revoke' ? 4 : 6);
    await stale.close();
  }
  const changed = await open();
  await changed.getByRole('checkbox').check();
  await changed.getByRole('button', { name: 'Revoke Other Mac…', exact: true }).click();
  await changed.evaluate(() => window.__advanceRevision());
  await changed.getByRole('button', { name: 'Refresh authority' }).click();
  await changed.getByText('Device changed. Cancel and review its current revision.').waitFor();
  assert.ok(await changed.getByRole('button', { name: 'Confirm revocation' }).isDisabled());
  assert.ok(await changed.getByRole('button', { name: 'Confirm and resume dispatch' }).isDisabled());
  assert.equal(await changed.getByRole('checkbox').isChecked(), false);
  assert.deepEqual(await changed.evaluate(() => window.__requests), []);
  await changed.close();
  const disconnected = await open('disconnect');
  await disconnected.getByRole('checkbox').check();
  await disconnected.getByRole('button', { name: 'Confirm and resume dispatch' }).click();
  await disconnected.getByText('Offline. Showing last received records, not current authority.').waitFor();
  assert.ok(await disconnected.getByRole('button', { name: 'Enroll device', exact: true }).isDisabled());
  await disconnected.close();
  for (const scenario of ['preview', 'offline', 'revoked', 'pending', 'unknown']) {
    const page = await open(scenario);
    if (scenario === 'unknown') {
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Confirm and resume dispatch' }).click();
      await page.getByRole('button', { name: 'Retry same command' }).waitFor();
    }
    assert.ok(await page.getByRole('button', { name: 'Enroll device', exact: true }).isDisabled());
    for (const button of await page.getByRole('button', { name: /^Revoke / }).all()) assert.ok(await button.isDisabled());
    for (const checkbox of await page.getByRole('checkbox').all()) assert.ok(await checkbox.isDisabled());
    if (scenario === 'preview') {
      assert.ok(await page.getByRole('button', { name: 'Save and connect' }).isDisabled());
      assert.ok(await page.getByRole('button', { name: 'Pair device', exact: true }).isDisabled());
    }
    assert.equal((await page.evaluate(() => window.__requests)).length, scenario === 'unknown' ? 1 : 0);
    await page.close();
  }
  const failed = await open('enrollment-error');
  await failed.getByLabel('Device name', { exact: true }).fill('New Mac');
  await failed.getByLabel('Other device ID', { exact: true }).fill(target);
  await failed.getByLabel('Other device public pairing key', { exact: true }).fill(publicKey);
  await failed.getByRole('button', { name: 'Enroll device', exact: true }).click();
  await failed.getByRole('alert').filter({ hasText: 'Enrollment outcome unknown' }).waitFor();
  assert.equal(await failed.getByRole('article', { name: 'New Mac', exact: true }).count(), 0);
  assert.equal(await failed.getByLabel('Device name', { exact: true }).inputValue(), 'New Mac');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: enrollment IPC, revocation confirmation, recovery acknowledgment, revision-bound stale re-review, pending unknown, offline, revoked and read-only preview controls.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
