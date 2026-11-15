import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
// Synthetic native IPC only: no Keychain, SSH, production credentials or updates.
const root = resolve('desktop/dist'), A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const server = createServer((req, res) => {
  const path = resolve(root, new URL(req.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) return res.writeHead(404).end();
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium, browser = await engine.launch();
const errors = []; let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
mkdirSync('/tmp/outpost-maintenance', { recursive: true });
async function open(width, colorScheme) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ A, B }) => {
    window.isTauri = true; window.__calls = []; window.__failTransfer = false; window.__update = null; window.__receipts = [];
    const providers = [{ id: 'anthropic', name: 'Anthropic', method: 'api_key', baseUrl: 'https://api.anthropic.com', configuration: null }, { id: 'openai', name: 'OpenAI', method: 'api_key', baseUrl: 'https://api.openai.com/v1', configuration: null }, { id: 'subscription', name: 'Subscription account', method: 'oauth', baseUrl: '', configuration: null }];
    const manifest = { id: 'host-' + 'a'.repeat(20), piVersion: '1.4.0', sequence: 1, extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }] };
    const inventory = { ...manifest, releaseId: manifest.id, manifest };
    const catalogue = { protocolVersion: 1, piVersion: '1.4.0', profilePath: '/synthetic/profile', generation: 'a'.repeat(64), providers: providers.map(p => ({ ...p, storedMethod: p.method, configured: true, methods: [{ type: p.method, label: p.method === 'oauth' ? 'Sign in' : 'API key' }] })), models: [], defaultModel: null, refreshedAt: null, refreshErrors: [], capabilities: { providerTransfer: true } };
    const saved = (id, label) => ({ environmentId: id, label, routes: ['https://fixture.invalid'], activeRoute: 'https://fixture.invalid' });
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args = {}) {
      window.__calls.push({ command, args: structuredClone(args) });
      if (command.startsWith('plugin:') || ['set_sidebar_window_controls', 'sidebar_pointer_inside', 'connections_wake'].includes(command)) return;
      if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: saved(A, 'Studio server'), [B]: saved(B, 'Build server') } } };
      if (command === 'provider_transfer_review') return { reviewId: 'review', source: { installationId: B, providers }, destination: { installationId: A, providers: [providers[0]] } };
      if (command === 'provider_transfer_start') {
        const receipt = { operationId: args.operationId, state: 'complete', providers: args.selection.map(p => ({ id: p.id, state: 'saved' })) }; window.__receipts.push(receipt);
        if (window.__failTransfer) throw 'Synthetic lost reply'; return receipt;
      }
      if (command === 'environment_update_check') return window.__update = { reviewId: 'update-review', operationId: 'operation', state: 'review', message: 'Review the compatible bundled release.', available: true, installed: inventory, artifact: { manifest: { ...manifest, id: 'host-' + 'b'.repeat(20), sequence: 2, piVersion: '1.4.1' } } };
      if (command === 'environment_update_start') return window.__update = { ...window.__update, state: 'staging' };
      if (command === 'environment_update_cancel') return window.__update = { ...window.__update, state: 'cancelled' };
      if (command === 'environment_update_status') { if (!window.__update) throw 'No review'; return window.__update; }
      const op = command.replace(/^environment_/, '');
      if (op === 'connection_info') return { endpoint: 'https://fixture.invalid', deviceId: 'synthetic', pending: false, nativeSidebar: false };
      if (op === 'disconnect') return;
      if (op === 'stream_events') return new Promise(() => {});
      if (op === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 0, records: [] };
        if (args.kind === 'runtime') return { configured: true, piManagement: true };
        if (args.kind === 'models') return { models: [] };
        if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 0 };
      }
      if (op === 'agent_request') {
        if (['catalogue', 'refresh'].includes(args.payload.type)) return catalogue;
        if (args.payload.type === 'runtime.inventory') return inventory;
        if (args.payload.type === 'transfer.history') return window.__receipts;
        if (args.payload.type === 'transfer.status') return window.__receipts.find(r => r.operationId === args.payload.operationId);
      }
      throw new Error('Unexpected synthetic call: ' + command);
    } };
  }, { A, B });
  await page.goto(`http://127.0.0.1:${server.address().port}/#settings/servers/${A}/models`);
  await page.getByLabel('Source server', { exact: true }).waitFor(); return page;
}
try {
  for (const [width, theme] of [[1440, 'dark'], [390, 'light']]) {
    const page = await open(width, theme);
    await page.getByLabel('Source server', { exact: true }).selectOption(B);
    await page.getByRole('button', { name: 'Review providers', exact: true }).click();
    check(await page.getByLabel('Action for Anthropic', { exact: true }).inputValue() === 'keep', 'Existing destination defaults to keep');
    check(await page.getByLabel('Action for OpenAI', { exact: true }).inputValue() === 'copy', 'Missing key defaults to copy');
    check(await page.getByRole('button', { name: 'Import selected keys' }).isDisabled(), 'Approval required');
    await page.getByLabel('Action for Anthropic', { exact: true }).selectOption('replace');
    const approval = page.getByLabel(/I approve copying/); check((await approval.locator('..').textContent()).includes('replacing anthropic'), 'Replacement named in consent');
    await page.getByRole('button', { name: 'Find destination sign-in' }).click();
    await page.waitForFunction(() => document.getElementById('provider-search')?.value === 'subscription');
    check(await page.getByRole('searchbox', { name: 'Add or manage a provider' }).inputValue() === 'subscription', 'OAuth directs to fresh destination sign-in');
    await approval.check();
    await page.locator('.provider-import').screenshot({ path: `/tmp/outpost-maintenance/${engine.name()}-${width}-${theme}-import.png` });
    await page.evaluate(() => { window.__failTransfer = true; });
    await page.getByRole('button', { name: 'Import selected keys' }).click();
    await page.getByText(/Import could not be confirmed/).waitFor();
    check(await page.getByRole('button', { name: 'Import selected keys' }).count() === 0, 'Unknown outcome cannot replay an import');
    await page.getByRole('button', { name: 'Check import receipts' }).click();
    await page.getByRole('heading', { name: 'Import complete', exact: true }).waitFor();
    check(await page.evaluate(() => __calls.filter(c => c.command === 'provider_transfer_start').length) === 1, 'Reconciliation does not export or apply again');
    check(await page.evaluate(() => !__calls.some(c => ['transfer.export', 'transfer.apply'].includes(c.args?.payload?.type))), 'Packets never cross React IPC');
    await page.getByRole('link', { name: 'Pi & extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Check for compatible update' }).click();
    check(await page.getByRole('button', { name: 'Authorize server update' }).isDisabled(), 'Update requires separate approval');
    await page.getByLabel(/I approve this release update/).check();
    await page.locator('.runtime-settings').screenshot({ path: `/tmp/outpost-maintenance/${engine.name()}-${width}-${theme}-update.png` });
    await page.getByRole('button', { name: 'Authorize server update' }).click();
    await page.getByRole('heading', { name: 'Update staging' }).waitFor();
    check(await page.getByRole('button', { name: 'Cancel before activation' }).isEnabled(), 'Staging is visible and cancellable before draining');
    await page.evaluate(() => { window.__update.state = 'waiting_for_idle'; });
    await page.getByRole('heading', { name: 'Update waiting for idle' }).waitFor();
    check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_start').length) === 1, 'Server progresses to drain without another approval or launch');
    await page.getByRole('button', { name: 'Cancel waiting update' }).click();
    await page.getByRole('heading', { name: 'Update cancelled' }).waitFor();
    check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_start').every(c => c.args.environmentId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' && c.args.approved === true)), 'Update bound to reviewed server and approval');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No viewport overflow');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`${checks} maintenance/import browser checks passed (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
