import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';

// Synthetic IPC only. No credentials, Keychain, accounts or live servers are accessed.
const root = resolve('desktop/dist');
const server = createServer((req, res) => {
  const path = resolve(root, new URL(req.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) return res.writeHead(404).end();
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream');
  res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const errors = [];
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
async function open(width = 1440, legacy = false, colorScheme = 'dark') {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ legacy }) => {
    window.isTauri = true;
    window.__commands = []; window.__management = []; window.__secretSeen = false; window.__failCatalogue = false;
    window.__callbackEvents = []; window.__callbackAnswerMatches = false; window.__busyPort = false;
    const callbackURL = 'http://127.0.0.1:1455/auth/callback?code=synthetic-callback-private&state=synthetic-state-123456789&client_id=issued-client';
    const authorizationURL = 'https://auth.openai.com/api/accounts/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=synthetic-state-123456789';
    const model = { modelId: 'org/model:v1', name: 'Shared model', reasoning: false };
    const catalogue = { protocolVersion: 1, piVersion: '1.4.0', profilePath: '/synthetic/server/.pi/agent', generation: 'a'.repeat(64),
      providers: ['alpha', 'beta'].map(id => ({ id, name: id === 'alpha' ? 'Alpha API' : 'Beta subscription', storedMethod: id === 'alpha' ? 'api_key' : null, configured: id === 'alpha',
        methods: [{ type: id === 'alpha' ? 'api_key' : 'oauth', label: id === 'alpha' ? 'API key' : 'Sign in', subscription: id === 'beta', interactive: true }] })),
      models: [{ ...model, providerId: 'alpha' }, { ...model, providerId: 'beta' }], defaultModel: { providerId: 'alpha', modelId: model.modelId },
      refreshErrors: [], refreshedAt: null, capabilities: { providerPackages: false, callbackRelay: false } };
    let flow = null, pointerX = -1, pointerY = -1;
    const rows = [], row = (kind, id, data) => ({ kind, id, data, revision: 1, updatedAt: new Date().toISOString() });
    document.addEventListener('pointermove', event => { pointerX = event.clientX; pointerY = event.clientY; });
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args) {
      if (command === 'set_sidebar_window_controls') return;
      if (command === 'sidebar_pointer_inside') return pointerX >= 0 && pointerX <= args.width && pointerY >= 0 && pointerY <= innerHeight;
      if (command === 'connection_info') return { endpoint: 'Synthetic Server 2', deviceId: 'synthetic', pending: false, nativeSidebar: false };
      if (command === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 0, records: structuredClone(rows) };
        if (args.kind === 'runtime') return { configured: true, piManagement: !legacy, model: 'legacy:cloud' };
        if (args.kind === 'models') return { models: ['legacy:cloud'], defaultModel: 'legacy:cloud' };
        if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: 0 };
      }
      if (command === 'stream_events') return new Promise(() => {});
      if (command.startsWith('plugin:')) return;
      if (command === 'oauth_callback_start') { window.__callbackEvents.push('bind'); if (window.__busyPort) throw new Error('Synthetic occupied port'); return; }
      if (command === 'oauth_callback_wait') { window.__callbackEvents.push('wait'); return new Promise((resolve, reject) => { window.__finishCallback = () => resolve(callbackURL); window.__cancelCallback = () => reject(new Error('Synthetic cancellation')); }); }
      if (command === 'oauth_callback_cancel') { window.__callbackEvents.push('cancel'); window.__cancelCallback?.(); return; }
      if (command === 'open_url') { window.__callbackEvents.push('open'); return; }
      if (command === 'agent_request') {
        const request = args.payload;
        // Record only nonsecret request metadata, exactly as product diagnostics should.
        window.__management.push({ type: request.type, providerId: request.providerId });
        if (request.type === 'catalogue' || request.type === 'refresh') {
          if (window.__failCatalogue) throw new Error('Synthetic failure');
          return structuredClone(catalogue);
        }
        if (request.type === 'login.start') {
          flow = { id: 'flow', providerId: request.providerId, method: request.method, state: 'waiting', expiresAt: Date.now() + 60000,
            prompt: { id: 'secret', input: { type: 'secret', message: 'Synthetic API credential' } }, events: [], error: null };
          if (request.method === 'oauth') {
            flow.prompt = { id: 'manual', input: { type: 'manual_code', message: 'Paste the final redirect URL', placeholder: 'http://127.0.0.1:1455/auth/callback' } };
            flow.events = [{ type: 'auth_url', url: authorizationURL }];
          }
          return structuredClone(flow);
        }
        if (request.type === 'login.status') return structuredClone(flow);
        if (request.type === 'login.cancel') { flow.state = 'cancelled'; flow.prompt = null; return structuredClone(flow); }
        if (request.type === 'login.answer') {
          if (flow.prompt?.id === 'manual') {
            window.__callbackAnswerMatches = request.value === callbackURL;
            flow.prompt = { id: 'save', input: { type: 'select', message: 'Save this credential to the shared server Pi profile?', options: [{ id: 'save', label: 'Save server credential' }] } };
            return structuredClone(flow);
          }
          window.__secretSeen = request.value === 'synthetic-secret-never-persist';
          flow.state = 'succeeded'; flow.prompt = null;
          catalogue.providers.find(p => p.id === flow.providerId).storedMethod = 'api_key';
          return structuredClone(flow);
        }
        if (request.type === 'provider.logout') { catalogue.providers.find(p => p.id === request.providerId).storedMethod = null; return {}; }
        if (request.type === 'default.set') { catalogue.defaultModel = request.model; return {}; }
        if (request.type === 'provider.configure') {
          const c = request.configuration;
          catalogue.providers.push({ id: c.providerId, name: c.providerId, methods: [{ type: 'api_key', label: 'API key' }], storedMethod: null, configured: false });
          window.__configuration = c; return {};
        }
      }
      if (command === 'send_command') {
        window.__commands.push(structuredClone(args));
        if (args.kind === 'task.create') { const r = row('task', args.id, { ...args.payload, provider: args.payload.modelRef?.providerId, model: args.payload.modelRef?.modelId, state: 'running' }); rows.push(r); return r; }
        if (args.kind === 'task.steer') return rows.find(r => r.id === args.id);
      }
      throw new Error(`Unexpected synthetic call: ${command}`);
    } };
  }, { legacy });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('textbox', { name: 'Task goal' }).waitFor();
  return page;
}
try {
  const page = await open();
  await page.getByRole('button', { name: 'alpha · org/model:v1', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search models' }).fill('beta');
  check(await page.locator('.model-results button').count() === 1, 'Search isolates provider, not just shared model ID');
  await page.locator('.model-results button').click();
  check(await page.getByRole('button', { name: 'beta · org/model:v1', exact: true }).evaluate(el => el === document.activeElement), 'Picker returns focus');
  await page.getByRole('textbox', { name: 'Task goal' }).fill('Synthetic instruction');
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  check(await page.evaluate(() => __commands[0].payload.modelRef.providerId === 'beta' && __commands[0].payload.modelRef.modelId === 'org/model:v1'), 'New task sends exact structured selection');
  await page.getByRole('button', { name: 'beta · org/model:v1', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search models' }).fill('alpha');
  await page.locator('.model-results button').click();
  await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Follow-up on another provider');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => __commands.length === 2);
  check(await page.evaluate(() => __commands[1].payload.modelRef.providerId === 'alpha'), 'Follow-up sends next-instruction selection');
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Add or manage a provider' }).fill('alpha');
  await page.getByRole('button', { name: 'API key', exact: true }).click();
  check(await page.getByRole('region', { name: 'Confirm credential change' }).isVisible(), 'Stored credential replacement requires confirmation');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByLabel('Synthetic API credential').fill('synthetic-secret-never-persist');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Credential saved.', { exact: false }).waitFor();
  check(await page.evaluate(() => __secretSeen), 'Secret travels through dedicated IPC');
  check(!(await page.content()).includes('synthetic-secret-never-persist'), 'Secret cleared from rendered document');
  check(await page.evaluate(() => !JSON.stringify([localStorage, sessionStorage, __commands]).includes('synthetic-secret-never-persist')), 'Secret excluded from storage and task payloads');
  await page.getByRole('button', { name: 'Remove credential' }).click();
  check(await page.getByText(/does not revoke the provider account/).isVisible(), 'Removal consequences explained');
  await page.getByRole('button', { name: 'Keep credential' }).click();
  await page.getByText('Compatible endpoint', { exact: true }).click();
  await page.getByLabel('Provider ID', { exact: true }).fill('private-api');
  await page.getByLabel('Base URL', { exact: true }).fill('http://192.0.2.1:11434/v1');
  await page.getByLabel('Exact model ID', { exact: true }).fill('namespace/model:cloud');
  await page.getByLabel('Allow unencrypted HTTP', { exact: false }).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await page.waitForFunction(() => !!window.__configuration);
  check(await page.evaluate(() => __configuration.models[0].id === 'namespace/model:cloud' && __configuration.allowInsecureHttp), 'Compatible endpoint preserves exact ID and HTTP consent');
  await page.getByRole('searchbox', { name: 'Add or manage a provider' }).fill('beta');
  check(await page.getByRole('button', { name: 'Sign in · Subscription' }).isVisible(), 'Runtime subscription method is not presented as an API key');
  await page.getByRole('button', { name: 'Sign in · Subscription' }).click();
  await page.getByRole('button', { name: 'Open provider sign-in', exact: true }).click();
  await page.waitForFunction(() => __callbackEvents.includes('open'));
  check(await page.evaluate(() => __callbackEvents.slice(0, 3).join(',') === 'bind,wait,open'), 'Bind the Mac listener before opening the provider browser');
  await page.evaluate(() => __finishCallback());
  await page.getByLabel('Save this credential to the shared server Pi profile?').waitFor();
  check(await page.evaluate(() => __callbackAnswerMatches), 'Complete callback including issued client ID reaches secret management IPC');
  check(!(await page.content()).includes('synthetic-callback-private'), 'Captured callback is never rendered');
  check(await page.evaluate(() => !JSON.stringify([localStorage, sessionStorage, __commands, __management, __callbackEvents]).includes('synthetic-callback-private')), 'Callback excluded from browser storage, task retries and metadata');
  await page.getByLabel('Save this credential to the shared server Pi profile?').selectOption('save');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Credential saved.', { exact: false }).waitFor();

  await page.getByRole('button', { name: 'Sign in · Subscription' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Open provider sign-in', exact: true }).click();
  await page.getByRole('button', { name: 'Waiting for browser sign-in…' }).waitFor();
  const answersBeforeCancel = await page.evaluate(() => __management.filter(r => r.type === 'login.answer').length);
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.provider-login h3')?.textContent.includes('cancelled'));
  await page.evaluate(() => __finishCallback());
  await page.waitForTimeout(100);
  check(await page.evaluate(() => __management.filter(r => r.type === 'login.answer').length) === answersBeforeCancel, 'Cancelled flow cannot submit a late callback');

  await page.getByRole('button', { name: 'Sign in · Subscription' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.evaluate(() => window.__busyPort = true);
  const opensBeforeFailure = await page.evaluate(() => __callbackEvents.filter(e => e === 'open').length);
  await page.getByRole('button', { name: 'Open provider sign-in', exact: true }).click();
  await page.getByRole('button', { name: 'Open sign-in manually' }).waitFor();
  check(await page.evaluate(() => __callbackEvents.filter(e => e === 'open').length) === opensBeforeFailure, 'Occupied port never opens a broken automatic callback flow');
  check(await page.getByText(/copy the full address from its address bar/).isVisible(), 'Connection-refused page has explicit private manual-return guidance');
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await page.evaluate(() => window.__failCatalogue = true);
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await page.getByText('Provider catalogue unavailable.', { exact: false }).waitFor();
  await page.getByRole('button', { name: /New task/ }).click();
  await page.getByRole('textbox', { name: 'Task goal' }).fill('Must not silently fallback');
  check(await page.getByRole('button', { name: 'Start task' }).isDisabled(), 'Failed catalogue blocks submission instead of legacy fallback');
  await page.close();

  mkdirSync('/tmp/outpost-providers', { recursive: true });
  for (const [width, scheme] of [[1440, 'dark'], [900, 'light'], [390, 'dark']]) {
    const page = await open(width, false, scheme);
    // Use header settings entry at narrow widths; navigation itself is covered by the sidebar suite.
    if (width > 780) await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
    else await page.getByRole('button', { name: 'Open connection settings', exact: true }).click();
    await page.getByText('Server Pi providers', { exact: true }).waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}`);
    await page.screenshot({ path: `/tmp/outpost-providers/${engine.name()}-${width}-${scheme}.png` });
    await page.close();
  }
  const old = await open(1440, true);
  check(await old.getByRole('combobox', { name: 'Ollama model' }).isVisible(), 'Legacy server keeps working selector');
  await old.getByRole('button', { name: 'Connection settings', exact: true }).click();
  check(await old.getByText(/Server update required/).isVisible(), 'Legacy server gets truthful capability state');
  check(await old.getByRole('button', { name: 'Refresh models' }).count() === 0, 'No nonfunctional provider controls on legacy server');
  await old.close();
  check(errors.length === 0, `No page errors: ${errors.join(', ')}`);
  console.log(`${checks} provider UI checks passed (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
