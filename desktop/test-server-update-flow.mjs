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
const subagentsNotice = 'Bundled pi-subagents is inactive for managed tasks in this legacy release. Authorizing this release does not enable it.';
const nativeExtensionsNotice = 'In Full control, installed native extensions and subagents run with the server worker’s permissions, without individual action approvals. Compatible Auto servers disable them for Auto tasks.';
const nativeReleaseNotice = `Installing this release makes native extensions available to Full control tasks. ${nativeExtensionsNotice}`;
const inactiveExtensionsNotice = 'This server reports inactive extensions. A server update is required to activate them.';
mkdirSync('/tmp/outpost-maintenance', { recursive: true });
async function open(width, colorScheme) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ A, B }) => {
    window.isTauri = true; window.__calls = []; window.__failTransfer = false; window.__update = null; window.__receipts = []; window.__updateAvailable = false; window.__failUpdate = false;
    const providers = [{ id: 'anthropic', name: 'Anthropic', method: 'api_key', baseUrl: 'https://api.anthropic.com', configuration: null }, { id: 'openai', name: 'OpenAI', method: 'api_key', baseUrl: 'https://api.openai.com/v1', configuration: null }, { id: 'subscription', name: 'Subscription account', method: 'oauth', baseUrl: '', configuration: null }];
    const manifest = { id: 'host-' + 'a'.repeat(20), piVersion: '1.4.0', sequence: 1, extensions: [{ name: 'pi-ollama-cloud', version: '0.13.1' }] };
    const inventory = { ...manifest, releaseId: manifest.id, manifest };
    window.__inventory = inventory;
    window.__automatic = { enabled: true, targets: [A, B], activeEnvironmentId: null, servers: [{ environmentId: A, state: 'checked', message: 'Ready to update' }, { environmentId: B, state: 'complete', message: 'Up to date' }] };
        window.__endStreams = {};
    window.__targetManifest = { ...manifest, id: 'host-' + 'b'.repeat(20), sequence: 2, piVersion: '1.5.2', extensions: [...manifest.extensions, { name: 'pi-subagents', version: '0.88.1' }] };
    const catalogue = { protocolVersion: 1, piVersion: '1.4.0', profilePath: '/synthetic/profile', generation: 'a'.repeat(64), providers: providers.map(p => ({ ...p, storedMethod: p.method, configured: true, methods: [{ type: p.method, label: p.method === 'oauth' ? 'Sign in' : 'API key' }] })), models: [], defaultModel: null, refreshedAt: null, refreshErrors: [], capabilities: { providerTransfer: true } };
    const saved = (id, label) => ({ environmentId: id, label, routes: ['https://fixture.invalid'], activeRoute: 'https://fixture.invalid' });
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args = {}) {
      window.__calls.push({ command, args: structuredClone(args) });
      if (command.startsWith('plugin:') || ['set_sidebar_window_controls', 'sidebar_pointer_inside', 'connections_wake'].includes(command)) return;
      if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: saved(A, 'Studio server'), [B]: saved(B, 'Build server') } } };
      if (command === 'automatic_updates_recover') { window.__automatic.activeEnvironmentId = null; window.__automatic.servers[0].state = 'checked'; return structuredClone(window.__automatic); }
      if (command === 'automatic_updates_status' || command === 'automatic_updates_tick') {
        if (window.__failAutomatic) throw 'Synthetic supervisor unavailable';
        const snapshot = structuredClone(window.__automatic);
        if (window.__holdAutomatic) {
          window.__holdAutomatic = false;
          await new Promise(resolve => { window.__releaseAutomatic = resolve; });
        }
        return snapshot;
      }
      if (command === 'provider_transfer_review') return { reviewId: 'review', source: { installationId: B, providers }, destination: { installationId: A, providers: [providers[0]] } };
      if (command === 'provider_transfer_start') {
        const receipt = { operationId: args.operationId, state: 'complete', providers: args.selection.map(p => ({ id: p.id, state: 'saved' })) }; window.__receipts.push(receipt);
        if (window.__deferTransfer) await new Promise(resolve => { window.__finishTransfer = resolve; });
        if (window.__failTransfer) throw 'Synthetic lost reply'; return receipt;
      }
      if (command === 'environment_update_check') {
        const review = window.__update = { reviewId: 'update-review', operationId: 'operation', state: 'review', message: window.__reviewMessage ?? 'Review the compatible bundled release.', available: window.__updateAvailable, ...(window.__checkOutcome ? { checkOutcome: window.__checkOutcome } : {}), installed: structuredClone(window.__inventory), artifact: { manifest: structuredClone(window.__targetManifest), ...(window.__extensionPolicy ? { extensionPolicy: window.__extensionPolicy } : {}) } };
        if (window.__holdUpdateCheck) await new Promise(resolve => { window.__releaseUpdateCheck = resolve; });
        return review;
      }
      if (command === 'environment_update_start') { window.__update = { ...window.__update, state: 'staging' }; if (window.__failUpdate) throw 'Synthetic lost update reply'; return window.__update; }
      if (command === 'environment_update_cancel') {
        if (window.__holdUpdateCancel) await new Promise(resolve => { window.__releaseUpdateCancel = resolve; });
        if (window.__cancelOutcome === 'rejected') throw 'Synthetic activation/hold rejection; sudo password: synthetic-cancel-secret';
        if (window.__cancelOutcome === 'lost') throw 'Synthetic lost cancel reply; sudo password: synthetic-cancel-secret';
        return window.__update = { ...window.__update, state: 'cancelled' };
      }
      if (command === 'environment_update_status') {
        if (window.__holdInitialStatus) return new Promise(resolve => { window.__releaseInitialStatus = () => resolve({ reviewId: 'old-review', operationId: 'old-operation', state: 'review', message: 'Old saved check', available: true, installed: inventory, artifact: { manifest: { ...manifest, sequence: 2, piVersion: '1.4.1' } } }); });
        if (!window.__update) throw 'No review';
        const snapshot = structuredClone(window.__update);
        if (window.__holdNextStatus) {
          window.__holdNextStatus = false;
          await new Promise(resolve => { window.__releaseNextStatus = resolve; });
        }
        return snapshot;
      }
      const op = command.replace(/^environment_/, '');
      if (op === 'connection_info') return { endpoint: 'https://fixture.invalid', deviceId: 'synthetic', pending: false, nativeSidebar: false };
      if (op === 'disconnect') return;
      if (op === 'stream_events') return new Promise(resolve => { window.__endStreams[args.environmentId] = resolve; });
      if (op === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 0, records: [] };
        if (args.kind === 'runtime') return { configured: true, piManagement: true };
        if (args.kind === 'models') return { models: [] };
        if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 0 };
      }
      if (op === 'agent_request') {
        if (['catalogue', 'refresh'].includes(args.payload.type)) return catalogue;
        if (args.payload.type === 'runtime.inventory') {
          const snapshot = structuredClone(window.__inventory);
          if (window.__holdInventory) {
            window.__holdInventory = false;
            await new Promise(resolve => { window.__releaseInventory = resolve; });
          }
          return snapshot;
        }
        if (args.payload.type === 'transfer.history') return window.__receipts;
        if (args.payload.type === 'transfer.status') return window.__receipts.find(r => r.operationId === args.payload.operationId);
        if (args.payload.type === 'transfer.cancel') { const receipt = window.__receipts.find(r => r.operationId === args.payload.operationId); receipt.state = 'cancelled'; return receipt; }
      }
      throw new Error('Unexpected synthetic call: ' + command);
    } };
  }, { A, B });
  await page.goto(`http://127.0.0.1:${server.address().port}/#settings/servers/${A}/models`);
  await page.getByRole('button', { name: 'Import settings…', exact: true }).waitFor(); return page;
}

try {
 const page = await open(1440, 'dark');
 await page.evaluate(({ A, B }) => { window.__automatic = { enabled: true, targets: [A, B], activeEnvironmentId: null, servers: [{ environmentId: A, state: 'checked', message: 'Ready to update' }, { environmentId: B, state: 'complete', message: 'Up to date' }] }; }, { A, B });
 await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Machines/ }).click();
 await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor();
 await page.getByRole('link', { name: 'Update Studio server', exact: true }).click();
 await page.getByRole('heading', { name: 'Studio server', exact: true }).waitFor();
 await page.waitForFunction(A => window.__calls.some(call => call.command === 'automatic_updates_tick' && JSON.stringify(call.args.connectedEnvironmentIds) === JSON.stringify([A])), A);
 const runtime = page.locator('.runtime-settings');
 assert.equal(await runtime.getByText('Build server', { exact: true }).count(), 0);
 assert.equal(await runtime.getByText('Global setting for all saved servers on this Mac, not just the selected connection.', { exact: true }).count(), 0);
 assert.equal(await runtime.getByRole('heading', { name: 'Server update', exact: true }).isVisible(), true);
 assert.equal(await runtime.getByText('Details & update recovery', { exact: true }).isVisible(), true);
 assert.equal(await runtime.getByRole('heading', { name: 'Pi runtime', exact: true }).isVisible(), false);
 await page.screenshot({ path: '/tmp/outpost-maintenance/server-update-flow-' + engine.name() + '.png' });
 await page.getByRole('link', { name: 'Models & providers', exact: true }).click();
 await page.evaluate(A => { window.__automatic.activeEnvironmentId = A; window.__automatic.servers[0].state = 'failed'; window.__automatic.servers[0].message = 'Idle deadline exceeded'; }, A);
 // Refresh the provider via a scoped tick without dispatching any real command.
 await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Machines/ }).click();
 await page.getByRole('link', { name: 'Update Studio server', exact: true }).click();
 await page.getByRole('button', { name: 'Inspect & recover', exact: true }).waitFor();
 assert.equal(await page.getByRole('progressbar').count(), 0, 'Failed reservations never animate progress');
 await page.getByRole('button', { name: 'Inspect & recover', exact: true }).click();
 await page.getByRole('dialog', { name: 'Recover failed update', exact: true }).waitFor();
 assert.equal(await page.locator('input[type=password]').count(), 0, 'Password entry stays in the native protected dialog');
 await page.getByRole('button', { name: 'Inspect and restart update', exact: true }).click();
 await page.waitForFunction(A => window.__calls.some(call => call.command === 'automatic_updates_recover' && call.args.environmentId === A && call.args.approved === true), A);
 await page.getByRole('link', { name: 'Models & providers', exact: true }).click();
 await page.evaluate(A => {
   window.__automatic.activeEnvironmentId = A;
   window.__automatic.servers[0].state = 'updating';
   window.__update = { reviewId: 'stop-review', operationId: 'stop-operation', state: 'staging', available: true, installed: window.__inventory, artifact: { manifest: window.__targetManifest } };
 }, A);
 await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Machines/ }).click();
 await page.getByRole('link', { name: 'Update Studio server', exact: true }).click();
 await page.evaluate(() => { window.__cancelOutcome = 'rejected'; });
 await page.getByRole('button', { name: 'Stop update', exact: true }).click();
 await page.getByText('Stop could not be confirmed. Activation may have started, or the server is unavailable. Check progress before trying again.', { exact: true }).waitFor();
 assert.equal(await page.getByText('Update stopped.', { exact: true }).count(), 0);
 assert.equal((await page.locator('body').innerText()).includes('synthetic-cancel-secret'), false);
 await page.evaluate(() => { window.__cancelOutcome = undefined; });
 await page.getByRole('button', { name: 'Stop update', exact: true }).click();
 await page.getByText('Update stopped.', { exact: true }).waitFor();
 const stops = await page.evaluate(() => window.__calls.filter(call => call.command === 'environment_update_cancel'));
 assert.equal(stops.length, 2);
 assert.equal(stops[0].args.environmentId, A, 'Stop stays bound to the selected server');
 assert.deepEqual(errors, []);
 console.log('PASS: scoped server update navigation, automatic request, compact details (' + engine.name() + ')');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
