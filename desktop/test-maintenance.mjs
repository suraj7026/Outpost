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
const subagentsNotice = 'Bundled pi-subagents is inactive and is not enabled for managed tasks until approval-aware integration is available. Authorizing this release does not enable it.';
const nativeExtensionsNotice = 'Installed extensions are available to Pi automatically. They and their subagents run with the server worker’s permissions, outside Outpost’s per-action approvals.';
const nativeReleaseNotice = `Installing this release enables native extensions automatically. ${nativeExtensionsNotice}`;
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
        window.__endStreams = {};
    window.__targetManifest = { ...manifest, id: 'host-' + 'b'.repeat(20), sequence: 2, piVersion: '1.5.2', extensions: [...manifest.extensions, { name: 'pi-subagents', version: '0.88.1' }] };
    const catalogue = { protocolVersion: 1, piVersion: '1.4.0', profilePath: '/synthetic/profile', generation: 'a'.repeat(64), providers: providers.map(p => ({ ...p, storedMethod: p.method, configured: true, methods: [{ type: p.method, label: p.method === 'oauth' ? 'Sign in' : 'API key' }] })), models: [], defaultModel: null, refreshedAt: null, refreshErrors: [], capabilities: { providerTransfer: true } };
    const saved = (id, label) => ({ environmentId: id, label, routes: ['https://fixture.invalid'], activeRoute: 'https://fixture.invalid' });
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args = {}) {
      window.__calls.push({ command, args: structuredClone(args) });
      if (command.startsWith('plugin:') || ['set_sidebar_window_controls', 'sidebar_pointer_inside', 'connections_wake'].includes(command)) return;
      if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: saved(A, 'Studio server'), [B]: saved(B, 'Build server') } } };
      if (command === 'provider_transfer_review') return { reviewId: 'review', source: { installationId: B, providers }, destination: { installationId: A, providers: [providers[0]] } };
      if (command === 'provider_transfer_start') {
        const receipt = { operationId: args.operationId, state: 'complete', providers: args.selection.map(p => ({ id: p.id, state: 'saved' })) }; window.__receipts.push(receipt);
        if (window.__deferTransfer) await new Promise(resolve => { window.__finishTransfer = resolve; });
        if (window.__failTransfer) throw 'Synthetic lost reply'; return receipt;
      }
      if (command === 'environment_update_check') {
        if (window.__holdUpdateCheck) await new Promise(resolve => { window.__releaseUpdateCheck = resolve; });
        return window.__update = { reviewId: 'update-review', operationId: 'operation', state: 'review', message: 'Review the compatible bundled release.', available: window.__updateAvailable, installed: structuredClone(window.__inventory), artifact: { manifest: structuredClone(window.__targetManifest), ...(window.__extensionPolicy ? { extensionPolicy: window.__extensionPolicy } : {}) } };
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
        if (!window.__update) throw 'No review'; return window.__update;
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
async function checkRuntimeFooter(page, state, width) {
  const dialog = page.getByRole('dialog');
  const footer = dialog.locator('.runtime-update-actions');
  check(await dialog.locator('.ui-dialog-actions').count() === 1 && await footer.count() === 1, `${state}: runtime actions share one footer`);
  await footer.scrollIntoViewIfNeeded();
  const geometry = await dialog.evaluate(node => {
    const rect = element => { const { left, right, top, bottom, height } = element.getBoundingClientRect(); return { left, right, top, bottom, height }; };
    const body = node.querySelector('.ui-dialog-body'), footer = node.querySelector('.runtime-update-actions');
    const bodyStyle = getComputedStyle(body), heading = node.querySelector('.ui-dialog-heading');
    return {
      dialog: rect(node), body: rect(body), footer: rect(footer), previous: rect(footer.previousElementSibling),
      paddingLeft: parseFloat(bodyStyle.paddingLeft), paddingRight: parseFloat(bodyStyle.paddingRight), paddingBottom: parseFloat(bodyStyle.paddingBottom),
      headingLeft: rect(heading).left + parseFloat(getComputedStyle(heading).paddingLeft),
      headingRight: rect(heading).right - parseFloat(getComputedStyle(heading).paddingRight),
      buttons: [...footer.querySelectorAll('button')].map(button => ({ ...rect(button), text: button.textContent })),
      bodyButtons: body.querySelectorAll('button').length,
      overflow: node.scrollWidth > node.clientWidth, viewportHeight: innerHeight,
    };
  });
  const { buttons, footer: box } = geometry;
  check(buttons.length === geometry.bodyButtons, `${state}: no actions stranded in the dialog body`);
  check(!geometry.overflow, `${state}: dialog has no horizontal overflow`);
  check(Math.abs(box.left - geometry.body.left - geometry.paddingLeft) < 1 && Math.abs(geometry.body.right - box.right - geometry.paddingRight) < 1, `${state}: footer follows body padding`);
  check(Math.abs(box.left - geometry.headingLeft) < 1 && Math.abs(box.right - geometry.headingRight) < 1, `${state}: footer and header edges align`);
  check(geometry.paddingBottom >= 20 && geometry.paddingBottom <= 24 && Math.abs(geometry.body.bottom - box.bottom - geometry.paddingBottom) < 1, `${state}: footer has one compact bottom inset`);
  const gap = box.top - geometry.previous.bottom;
  check(gap >= 16 && gap <= 24, `${state}: content-to-footer gap is compact (${gap}px)`);
  for (const [index, button] of buttons.entries()) {
    check(button.left >= box.left - 1 && button.right <= box.right + 1 && button.top >= box.top - 1 && button.bottom <= box.bottom + 1, `${state}: ${button.text} stays inside footer`);
    check(button.top >= geometry.dialog.top && button.bottom <= Math.min(geometry.dialog.bottom, geometry.viewportHeight), `${state}: ${button.text} is visible after scrolling`);
    for (const other of buttons.slice(index + 1)) check(button.right <= other.left || other.right <= button.left || button.bottom <= other.top || other.bottom <= button.top, `${state}: footer buttons never overlap`);
  }
  if (width >= 900) check(buttons.every(button => Math.abs(button.top - buttons[0].top) < 1 && Math.abs(button.bottom - buttons[0].bottom) < 1), `${state}: all footer buttons align in one row`);
  check(Math.abs(buttons.at(-1).right - box.right) < 1, `${state}: final action aligns to the right inset`);
  const cancellable = ['staging', 'waiting_for_idle', 'unknown'].includes(state);
  if (cancellable) check(buttons[0].text.startsWith('Cancel ') && Math.abs(buttons[0].left - box.left) < 1, `${state}: cancellation aligns to the left inset`);
  check(await footer.getByRole('button', { name: 'Check update status', exact: true }).count() === (['staging', 'waiting_for_idle', 'unknown', 'needs_attention'].includes(state) ? 1 : 0), `${state}: status action appears only for in-progress/recovery states`);
  check(await footer.locator('.ui-button-primary').count() === (state === 'review' ? 1 : 0), `${state}: only review has a primary authorization action`);
  await dialog.screenshot({ path: `/tmp/outpost-maintenance/${engine.name()}-${width}-footer-${state}.png` });
}
try {
  for (const width of [900, 1320, 646, 390]) {
    const page = await open(width, width === 900 ? 'light' : 'dark');
    await page.evaluate(() => { window.__updateAvailable = true; window.__extensionPolicy = 'native-installed'; });
    await page.getByRole('link', { name: 'Pi & extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Review update…', exact: true }).click();
    check(await page.getByRole('dialog').getByText(nativeReleaseNotice, { exact: true }).isVisible(), 'Native-policy release review discloses automatic activation and worker permissions');
        await checkRuntimeFooter(page, 'review', width);
    await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByText('Release & recovery details', { exact: true }).click();
    for (const state of ['staging', 'waiting_for_idle', 'unknown', 'needs_attention', 'complete', 'rolled_back', 'failed', 'cancelled']) {
      await page.evaluate(state => { window.__update.state = state; }, state);
      await page.getByRole('button', { name: 'Check update status', exact: true }).click();
      await page.getByRole('button', { name: 'View update status', exact: true }).click();
      await checkRuntimeFooter(page, state, width);
      await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    }
    check(await page.evaluate(() => !__calls.some(call => ['environment_update_start', 'environment_update_cancel'].includes(call.command))), 'Opening and closing every footer state never launches or cancels an update');
    await page.close();
  }
  for (const [width, theme] of [[1440, 'dark'], [390, 'light']]) {
    const page = await open(width, theme);
    check(await page.getByLabel('Source server', { exact: true }).count() === 0, 'Import is a compact entry, not an inline transfer form');
    await page.getByRole('button', { name: 'Import settings…', exact: true }).click();
    const importDialog = page.getByRole('dialog', { name: 'Import provider settings', exact: true });
    await page.getByLabel('Source server', { exact: true }).selectOption(B);
    await page.getByRole('button', { name: 'Review providers', exact: true }).click();
    check(await page.getByLabel('Action for Anthropic', { exact: true }).inputValue() === 'keep', 'Existing destination defaults to keep');
    check(await page.getByLabel('Action for OpenAI', { exact: true }).inputValue() === 'copy', 'Missing key defaults to copy');
    check(await page.getByRole('button', { name: 'Import selected keys' }).isDisabled(), 'Approval required');
    await page.getByLabel('Action for Anthropic', { exact: true }).selectOption('replace');
    const approval = page.getByLabel(/I approve copying/); check((await approval.locator('..').textContent()).includes('replacing anthropic'), 'Replacement named in consent');
    await page.getByRole('button', { name: 'Find destination sign-in' }).click();
    const signInDialog = page.getByRole('dialog', { name: 'Add Subscription account', exact: true });
    await signInDialog.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ state: 'visible' });
    check(await signInDialog.getByRole('button', { name: 'Sign in', exact: true }).isVisible(), 'OAuth directs to fresh destination sign-in');
    check(await importDialog.count() === 0, 'Import closes before destination sign-in menu opens');
    await signInDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Import settings…', exact: true }).click();
    check(await page.getByLabel('Action for Anthropic', { exact: true }).inputValue() === 'replace', 'Transfer review and choices survive closing the modal');
    await approval.check();
    await importDialog.screenshot({ path: `/tmp/outpost-maintenance/${engine.name()}-${width}-${theme}-import.png` });
    await page.evaluate(() => { window.__failTransfer = true; window.__deferTransfer = true; });
    await page.getByRole('button', { name: 'Import selected keys' }).click();
    await page.getByText('Checking authenticated servers…', { exact: true }).waitFor();
    await importDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByText('Import operation in progress.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Import settings…', exact: true }).click();
    check(await page.getByRole('button', { name: 'Check import receipts', exact: true }).isDisabled(), 'Closing and reopening an in-flight import preserves its busy guard');
    await page.evaluate(() => __finishTransfer());
    await page.getByText(/Import could not be confirmed/).waitFor();
    await importDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByText(/An import needs reconciliation/).waitFor();
    await page.getByRole('button', { name: 'Import settings…', exact: true }).click();
    check(await page.getByRole('button', { name: 'Review providers', exact: true }).isDisabled(), 'Closing an unknown import does not clear its unresolved guard');
    check(await page.getByRole('button', { name: 'Import selected keys' }).count() === 0, 'Unknown outcome cannot replay an import');
    await page.getByRole('button', { name: 'Check import receipts' }).click();
    await page.getByRole('heading', { name: 'Import complete', exact: true }).waitFor();
    check(await page.evaluate(() => __calls.filter(c => c.command === 'provider_transfer_start').length) === 1, 'Reconciliation does not export or apply again');
    check(await page.evaluate(() => !__calls.some(c => ['transfer.export', 'transfer.apply'].includes(c.args?.payload?.type))), 'Packets never cross React IPC');
    await page.evaluate(() => __receipts.push({ operationId: 'prepared-import', state: 'prepared', providers: [] }));
    await page.getByRole('button', { name: 'Check import receipts' }).click();
    check(await page.getByRole('button', { name: 'Review providers', exact: true }).isDisabled(), 'Prepared history blocks a new transfer');
    await page.getByRole('button', { name: 'Cancel prepared import prepared', exact: true }).click();
    await page.waitForFunction(() => __receipts.find(receipt => receipt.operationId === 'prepared-import').state === 'cancelled');
    await page.getByText('Recent destination imports', { exact: true }).click();
    check(await importDialog.getByText(/prepared-import.*cancelled/).isVisible(), 'Recent history and prepared-import cancellation remain available in the dialog');
    await importDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.evaluate(() => { window.__holdInitialStatus = true; });
    await page.getByRole('link', { name: 'Pi & extensions', exact: true }).click();
    await page.waitForFunction(() => !!window.__releaseInitialStatus);
    await page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true }).click();
    await page.getByText('No newer bundled release', { exact: true }).waitFor();
    await page.evaluate(() => { window.__holdInitialStatus = false; window.__releaseInitialStatus(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(await page.getByText('No newer bundled release', { exact: true }).count() === 1, 'A late saved status cannot replace the newer manual check');
    check(await page.getByRole('dialog').count() === 0, 'No-newer-release result is a compact callout, not a dialog');
    check(await page.getByText('Review the compatible bundled release.', { exact: true }).isHidden(), 'Technical release details start collapsed');
    check(await page.getByRole('button', { name: /Restart runtime/ }).count() === 0, 'No unsupported runtime restart is invented');
    check(await page.getByText('Running', { exact: true }).count() === 0, 'Inventory does not claim a running process');
    const runtimeGeometry = () => page.locator('.runtime-settings').evaluate(node => {
      const button = [...node.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Check Pi + bundled extensions' || button.textContent === 'Check Pi + bundled extensions');
      const box = button.getBoundingClientRect();
      return { height: node.getBoundingClientRect().height, width: box.width, buttonHeight: box.height };
    });
    const beforeRecheck = await runtimeGeometry();
    await page.evaluate(() => { window.__holdUpdateCheck = true; });
    await page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true }).click();
    await page.waitForFunction(() => !!window.__releaseUpdateCheck);
    const duringRecheck = await runtimeGeometry();
    const checkButton = page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true });
    check(await checkButton.getAttribute('aria-busy') === 'true' && (await checkButton.textContent()).includes('Checking…'), 'Button provides visible and accessible checking feedback');
    check(await checkButton.isDisabled(), 'Repeated checks are disabled while pending');
    check(duringRecheck.width === beforeRecheck.width && duringRecheck.buttonHeight === beforeRecheck.buttonHeight, 'Checking label preserves button geometry');
    check(Math.abs(duringRecheck.height - beforeRecheck.height) < 1, `Rechecking must not add/remove a loading paragraph and shift the page (${beforeRecheck.height} → ${duringRecheck.height})`);
    await page.evaluate(() => { window.__holdUpdateCheck = false; window.__releaseUpdateCheck(); });
    await page.waitForFunction(() => ![...document.querySelectorAll('.runtime-settings button')].find(button => button.getAttribute('aria-label') === 'Check Pi + bundled extensions' || button.textContent === 'Check Pi + bundled extensions').disabled);
    check((await runtimeGeometry()).height === beforeRecheck.height, 'Result remains stable after recheck completes');
    check(await page.evaluate(() => __calls.filter(call => call.command === 'environment_update_start').length) === 0, 'Checking releases never starts an update');
    await page.evaluate(() => {
      window.__updateAvailable = true;
      window.__previousInventory = structuredClone(window.__inventory);
      const manifest = { ...window.__targetManifest, id: 'host-' + 'c'.repeat(20), sequence: 1, extensions: window.__targetManifest.extensions.map(extension => extension.name === 'pi-subagents' ? { ...extension, version: '0.88.0' } : extension) };
      window.__inventory = { ...manifest, releaseId: manifest.id, manifest, extensionStates: { 'pi-ollama-cloud': 'provider-only', 'pi-subagents': 'inactive' } };
    });
    await checkButton.click();
    await page.getByText('Pi 1.5.2 unchanged · Review bundled extensions', { exact: true }).waitFor();
    check(await page.getByText('Bundled release available', { exact: true }).isVisible(), 'Extension-only updates are available even when the Pi version is unchanged');
    await page.getByRole('button', { name: 'Review update…', exact: true }).click();
    const extensionDialog = page.getByRole('dialog', { name: 'Review bundled release', exact: true });
    check(await extensionDialog.getByText('1.5.2 → 1.5.2', { exact: true }).isVisible(), 'An extension-only release remains reviewable with unchanged Pi');
    check(await extensionDialog.locator('.ui-facts > div').filter({ has: page.getByText('pi-subagents', { exact: true }) }).getByText('0.88.0 → 0.88.1', { exact: true }).isVisible(), 'Extension-only review names pi-subagents and both versions');
    check(await extensionDialog.getByText(subagentsNotice, { exact: true }).isVisible(), 'Extension-only review explains that bundled subagents stays inactive pending approval-aware integration');
    check(await extensionDialog.getByText(/^Enabled$/i).count() === 0, 'Extension-only review does not claim subagents is enabled');
        check(await extensionDialog.getByText(nativeReleaseNotice, { exact: true }).count() === 0, 'Legacy review without a policy flag never claims installation enables extensions');
    check(await extensionDialog.getByRole('button', { name: 'Authorize server update' }).isDisabled(), 'Extension-only releases require the same explicit server-update approval');
    check(await page.evaluate(() => __calls.filter(call => call.command === 'environment_update_start').length) === 0, 'Reviewing an extension-only release never starts an update');
    await extensionDialog.getByRole('button', { name: 'Back', exact: true }).click();
    await page.evaluate(() => { window.__inventory = window.__previousInventory; window.__failUpdate = true; window.__extensionPolicy = 'native-installed'; });
    await page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Review update…', exact: true }).click();
    const updateDialog = page.getByRole('dialog');
    check(await updateDialog.getByText('1.4.0 → 1.5.2', { exact: true }).isVisible(), 'Bundled release review targets approved Pi 1.5.2');
    check(await page.evaluate(() => !('extensionStates' in window.__update.artifact.manifest)), 'Target manifest fixture has no activation states');
    check(await updateDialog.getByText(nativeReleaseNotice, { exact: true }).isVisible(), 'New release policy explicitly discloses enabling native extensions outside per-action approvals');
    check(await updateDialog.getByText(subagentsNotice, { exact: true }).count() === 0, 'Native-policy release review does not promise inactive subagents');
    check(await page.locator('.runtime-settings > .ui-section').getByText('Enabled', { exact: true }).count() === 0, 'Reviewing a native-policy release does not enable the installed inventory');
    check(await updateDialog.locator('.ui-facts > div').filter({ has: page.getByText('pi-subagents', { exact: true }) }).getByText('Not installed → 0.88.1', { exact: true }).isVisible(), 'Review explicitly includes installing bundled pi-subagents 0.88.1');
    check(await updateDialog.locator('.ui-facts > div').filter({ has: page.getByText('pi-ollama-cloud', { exact: true }) }).getByText('0.13.1 → 0.13.1', { exact: true }).isVisible(), 'Unchanged bundled extensions remain visible in the release review');
    check(await page.getByRole('button', { name: 'Authorize server update' }).isDisabled(), 'Update requires separate approval');
    check(await page.getByLabel(/Ask for the remote sudo password/).isChecked(), 'Protected native password prompt is the default');
    await page.getByLabel(/I approve this release update/).check();
    await updateDialog.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Review update…', exact: true }).click();
    check(await page.getByRole('button', { name: 'Authorize server update' }).isDisabled(), 'Reopening a review requires renewed approval');
    await page.getByLabel(/I approve this release update/).check();
    await updateDialog.screenshot({ path: `/tmp/outpost-maintenance/${engine.name()}-${width}-${theme}-update.png` });
    await page.getByRole('button', { name: 'Authorize server update' }).click();
    await page.getByRole('heading', { name: 'Update unknown', exact: true }).waitFor();
    await updateDialog.getByRole('button', { name: 'Done', exact: true }).click();
    check(await page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true }).isDisabled(), 'Unknown launch cannot be replaced by a fresh check');
    await page.getByText('Update staging', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'View update status' }).click();
    check(await page.getByRole('button', { name: 'Cancel before activation' }).isEnabled(), 'Staging is visible and cancellable before draining');
    await updateDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.evaluate(() => { window.__update.state = 'waiting_for_idle'; });
    await page.getByText('Update waiting for idle', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'View update status' }).click();
    await page.getByRole('heading', { name: 'Update waiting for idle' }).waitFor();
    check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_start').length) === 1, 'Server progresses to drain without another approval or launch');
    await page.getByRole('button', { name: 'Cancel waiting update' }).click();
    await page.getByRole('heading', { name: 'Update cancelled' }).waitFor();
    check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_start').every(c => c.args.environmentId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' && c.args.reviewId === 'update-review' && c.args.approved === true && c.args.password === true)), 'Update bound to reviewed server, approval and native password consent');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No viewport overflow');
    await page.close();
  }
  for (const [width, theme] of [[1440, 'dark'], [390, 'light']]) {
    for (const outcome of ['confirmed', 'rejected', 'lost']) {
      const page = await open(width, theme);
      await page.evaluate(outcome => {
        window.__update = { reviewId: 'pending-review', operationId: 'pending-operation', state: 'unknown', message: 'Host receipt unavailable.', available: true, installed: window.__inventory, artifact: { manifest: window.__targetManifest } };
        window.__cancelOutcome = outcome;
        window.__holdUpdateCancel = true;
      }, outcome);
      await page.getByRole('link', { name: 'Pi & extensions', exact: true }).click();
      await page.getByText('Update unknown', { exact: true }).waitFor();
      const checkButton = page.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true });
      check(await checkButton.isDisabled(), 'An unknown operation with no host receipt blocks a new release check');
      await page.getByRole('button', { name: 'View update status', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const cancel = dialog.getByRole('button', { name: 'Cancel pending update', exact: true });
      check(await cancel.isEnabled(), 'An unknown operation offers explicit pending-update cancellation');
      check(await dialog.getByText('The server only permits cancellation of this device’s pending operation while staging or draining. It will refuse if activation has started or maintenance is held. Cancellation is not confirmed until server status verifies it.', { exact: true }).isVisible(), 'Unknown cancellation explains ownership, pre-activation limits and server confirmation');
      check(await dialog.getByRole('button', { name: /retry|launch|reset|delete|reinstall|authorize/i }).count() === 0, 'Unknown recovery offers no launch retry, reset, deletion or reinstall');
      await cancel.evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => !!window.__releaseUpdateCancel);
      check(await cancel.isDisabled(), 'Cancellation is disabled while the native request is pending');
      check(await dialog.getByRole('heading', { name: 'Update unknown', exact: true }).isVisible(), 'Requesting cancellation does not optimistically clear unknown');
      check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_cancel').length) === 1, 'Rapid repeated clicks invoke native cancellation only once');
      check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_cancel').every(c => c.args.environmentId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' && Object.keys(c.args).length === 1)), 'Cancel is bound to the selected environment without password or launch arguments');
      await page.evaluate(() => { window.__holdUpdateCancel = false; window.__releaseUpdateCancel(); });
      if (outcome === 'confirmed') {
        await dialog.getByRole('heading', { name: 'Update cancelled', exact: true }).waitFor();
        check(await dialog.getByRole('button', { name: /Cancel pending update/ }).count() === 0, 'Confirmed cancellation removes the pending cancel action');
      } else {
        await dialog.getByRole('alert').waitFor();
        check((await dialog.getByRole('alert').textContent()).includes('could not be confirmed'), `${outcome} cancellation is reported as unconfirmed`);
        check(!(await page.locator('body').textContent()).includes('synthetic-cancel-secret'), 'Native cancellation errors never expose password details');
        check(await dialog.getByRole('heading', { name: 'Update unknown', exact: true }).isVisible(), `${outcome} cancellation preserves unknown`);
        const statusReads = await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_status').length);
        await page.waitForFunction(count => __calls.filter(c => c.command === 'environment_update_status').length >= count + 2, statusReads, { timeout: 15000 });
        check(await dialog.getByRole('heading', { name: 'Update unknown', exact: true }).isVisible(), 'Repeated native status reads without a host receipt preserve unknown');
        check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_cancel').length) === 1, `${outcome} cancellation is never automatically retried during polling`);
      }
      check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_start' || c.command === 'environment_update_check' || /reset|delete/.test(c.command)).length) === 0, 'Cancel and reconciliation never launch, reset, delete or check a new release automatically');
      if (outcome === 'lost') {
        // The native layer can later reconcile the signed server cancellation, without a host receipt.
        await page.evaluate(() => { window.__update.state = 'cancelled'; });
        await dialog.getByRole('button', { name: 'Check update status', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Update cancelled', exact: true }).waitFor();
      }
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      if (outcome === 'rejected') {
        check(await checkButton.isDisabled(), 'Rejected cancellation keeps a fresh release check blocked');
        check(await page.getByText('Update unknown', { exact: true }).isVisible(), 'Closing the rejected cancellation dialog preserves unknown');
      } else {
        check(await checkButton.isEnabled(), 'Only confirmed cancellation re-enables a fresh release check');
        await checkButton.click();
        await page.getByText('No newer bundled release', { exact: true }).waitFor();
        check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_check').length) === 1, 'A new check runs only after explicit user action following confirmed cancellation');
      }
      check(await page.evaluate(() => __calls.filter(c => c.command === 'environment_update_cancel').length) === 1, 'Exactly one cancellation was invoked throughout recovery');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Unknown cancellation guidance fits the viewport');
      await page.close();
    }
  }
  const inventoryPage = await open(1440, 'dark');
  await inventoryPage.evaluate(() => { window.__holdInventory = true; window.__updateAvailable = true; });
  await inventoryPage.getByRole('link', { name: 'Pi & extensions', exact: true }).click();
  await inventoryPage.waitForFunction(() => !!window.__releaseInventory);
  await inventoryPage.getByRole('button', { name: 'Check Pi + bundled extensions', exact: true }).click();
  await inventoryPage.getByRole('button', { name: 'Review update…', exact: true }).waitFor();
  await inventoryPage.evaluate(() => {
    window.__previousInventory = window.__inventory;
    const manifest = window.__targetManifest;
    window.__inventory = { ...manifest, releaseId: manifest.id, manifest, extensionStates: { 'pi-ollama-cloud': 'provider-only', 'pi-subagents': 'inactive' } };
    window.__update.state = 'complete';
  });
  await inventoryPage.getByText('Release & recovery details', { exact: true }).click();
  await inventoryPage.getByRole('button', { name: 'Check update status', exact: true }).click();
  await inventoryPage.getByText('Pi 1.5.2', { exact: true }).waitFor();
  check(await inventoryPage.getByText('pi-subagents', { exact: true }).isVisible(), 'Completed release refreshes the installed extension inventory');
  check(await inventoryPage.getByText('Installed · inactive', { exact: true }).isVisible(), 'Completed legacy release preserves the reported inactive state');
  await inventoryPage.evaluate(() => window.__releaseInventory());
  await inventoryPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(await inventoryPage.getByText('Pi 1.5.2', { exact: true }).isVisible() && await inventoryPage.getByText('pi-subagents', { exact: true }).isVisible(), 'A late pre-update inventory cannot overwrite the completed release inventory');
  await inventoryPage.evaluate(() => { window.__inventory = window.__previousInventory; window.__update.state = 'rolled_back'; });
  await inventoryPage.getByRole('button', { name: 'Check update status', exact: true }).click();
  await inventoryPage.getByText('Pi 1.4.0', { exact: true }).waitFor();
  check(await inventoryPage.getByText('pi-subagents', { exact: true }).count() === 0, 'Rollback refreshes inventory to the restored release rather than the target');
  await inventoryPage.evaluate(() => {
    const manifest = window.__targetManifest;
    window.__inventory = { ...manifest, releaseId: manifest.id, manifest, extensionStates: { 'pi-ollama-cloud': 'enabled', 'pi-subagents': 'enabled' } };
    window.__update.state = 'complete';
  });
  await inventoryPage.getByRole('button', { name: 'Check update status', exact: true }).click();
  await inventoryPage.getByText('Pi 1.5.2', { exact: true }).waitFor();
  check(await inventoryPage.getByText('Enabled', { exact: true }).count() === 2, 'Completed native release refreshes both server-reported enabled extensions');
  check(await inventoryPage.getByText(nativeExtensionsNotice, { exact: true }).isVisible(), 'Completed native release explains automatic availability and worker permissions');
  check(await inventoryPage.getByText(inactiveExtensionsNotice, { exact: true }).count() === 0, 'Completed native release does not retain inactive guidance');
  await inventoryPage.close();
  for (const width of [1440, 646, 390]) {
    for (const states of [undefined, { 'pi-ollama-cloud': 'provider-only', 'pi-subagents': 'inactive' }, { 'pi-ollama-cloud': 'enabled', 'pi-subagents': 'enabled' }, { 'pi-ollama-cloud': 'enabled', 'pi-subagents': 'inactive' }]) {
      const page = await open(width, 'light');
      await page.evaluate(states => {
        const manifest = window.__targetManifest;
        window.__inventory = { ...manifest, releaseId: manifest.id, manifest, ...(states ? { extensionStates: states } : {}) };
      }, states);
      await page.getByRole('link', { name: 'Pi & extensions', exact: true }).click();
      await page.getByText('pi-subagents', { exact: true }).waitFor();
      const runtime = page.locator('.runtime-settings');
      check(await runtime.getByText('0.88.1', { exact: true }).isVisible(), 'Inventory keeps the bundled subagents version visible');
      for (const name of ['pi-ollama-cloud', 'pi-subagents']) {
        const state = states?.[name];
        const row = runtime.locator('.ui-row').filter({ has: page.getByText(name, { exact: true }) });
        check(await row.getByText(state === 'enabled' ? 'Enabled' : `Installed · ${state ?? 'status unknown'}`, { exact: true }).isVisible(), `${name}: badge reflects only its server-reported state`);
      }
      check(await runtime.getByText(nativeExtensionsNotice, { exact: true }).count() === (Object.values(states ?? {}).includes('enabled') ? 1 : 0), 'Automatic availability and worker permissions are explained only for reported enabled packages');
      check(await runtime.getByText(inactiveExtensionsNotice, { exact: true }).count() === (Object.values(states ?? {}).includes('inactive') ? 1 : 0), 'Only reported inactive packages require a server update');
      check(await runtime.getByText(subagentsNotice, { exact: true }).count() === 0, 'Inventory never assumes approval-aware integration is required');
      check(await runtime.getByRole('button', { name: /enable|activate|install|npm/i }).count() === 0 && await runtime.locator('input[type="checkbox"], [role="switch"]').count() === 0, 'Inventory offers no extension installation or activation controls');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'State-specific inventory and permission notice fit the viewport');
      await page.evaluate(A => window.__endStreams[A](), A);
      await runtime.getByText('Disconnected', { exact: true }).waitFor();
      for (const name of ['pi-ollama-cloud', 'pi-subagents']) {
        const row = runtime.locator('.ui-row').filter({ has: page.getByText(name, { exact: true }) });
        check(await row.getByText(`Last reported · ${states?.[name] ?? 'status unknown'}`, { exact: true }).isVisible(), `${name}: disconnected inventory is explicitly last reported`);
      }
      check(await runtime.getByText('Enabled', { exact: true }).count() === 0, 'Disconnected inventory never claims current activation');
      await page.close();
    }
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`${checks} maintenance/import browser checks passed (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
