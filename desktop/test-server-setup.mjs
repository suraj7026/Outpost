import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

// Exercise the shipped React bundle; only the native IPC boundary is synthetic.
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const noPendingRestart = JSON.parse(readFileSync(new URL('./test-fixtures/restart-status-none.json', import.meta.url), 'utf8'));
assert.ok(existsSync(resolve(root, 'index.html')), 'Build desktop/dist before running this regression (npm --prefix desktop run build).');
const browserName = process.env.OUTPOST_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const engine = browserName === 'webkit' ? webkit : chromium;
const out = `/tmp/outpost-server-setup-${browserName}`;
mkdirSync(out, { recursive: true });
// The old mode switch remains an alias: neither invocation may omit safety coverage.
if (process.env.OUTPOST_TEST_SETUP_MODE) console.log('OUTPOST_TEST_SETUP_MODE is a compatibility alias; running the complete setup regression.');
const actionTimeout = 7000, testTimeout = 60000;
const A = { id: 'setup-alpha', label: 'Server Alpha', host: '2001:db8::10', user: 'operator', port: 2222,
  environmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationId: '11111111-1111-4111-8111-111111111111', endpoint: 'http://127.0.0.1:55441' };
const B = { id: 'setup-beta', label: 'Server Beta', host: 'beta.example.test', user: 'deployer', port: 22,
  environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', operationId: '22222222-2222-4222-8222-222222222222', endpoint: 'http://127.0.0.1:55442' };
const direct = { environmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', endpoint: 'https://url.example.test', label: 'URL server' };
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://local').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  const file = resolve(root, pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});

function installFixture({ servers, direct, exportDirectory, noPendingRestart }) {
  const copy = value => structuredClone(value);
  const specs = Object.fromEntries(servers.map(server => [server.id, server]));
  const entries = {}, scans = {}, controls = {}, pending = {}, responses = {}, failures = {}, holds = {}, reports = {};
  const archived = new Set(), restartReviews = {}, resetJobs = {};
  const calls = [], unexpected = [];
  const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} };
  let timestamp = Date.now(), callback = 0;
  const now = () => timestamp = Math.max(timestamp + 1, Date.now());
  const key = (command, id = '') => `${command}:${id}`;
  const requireEntry = id => {
    if (!specs[id] || !entries[id]) throw new Error(`Unknown setup ID: ${id}`);
    return entries[id];
  };
  const inspection = id => {
    const control = controls[id], spec = specs[id];
    return { os: 'ubuntu', osVersion: '24.04', architecture: 'x86_64', systemd: true, container: false, nativePresent: false,
      uid: 1000, freeBytes: 20 * 1024 ** 3, memoryBytes: 8 * 1024 ** 3,
      markers: control.recommendation === 'migration_review' ? ['etc/rancher/k3s', 'srv/remotejobs/pi-workspace'] : [],
      sudo: 'authentication_or_admin_required', api: control.recommendation === 'connect_existing' ? 'environment' : 'absent',
      environment: control.recommendation === 'connect_existing' ? { environmentId: spec.environmentId, release: 'fixture-existing-release' } : null,
      ...control.inspection };
  };
  const advance = (id, completedSteps, state = 'running', error = null) => {
    const entry = requireEntry(id), plan = entry.plan;
    if (!plan) throw new Error(`No reviewed plan for ${id}`);
    entry.installation = { operationId: plan.operationId, environmentId: plan.environmentId, releaseId: plan.releaseId,
      state, completedSteps, totalSteps: 12, stage: completedSteps === 4 ? 'Browser runtime' : `Confirmed check ${completedSteps}`,
      startedAt: entry.installation?.startedAt ?? now(), updatedAt: now(),
      log: [...entry.installation?.log ?? [], `${id} ONLY: ${completedSteps}/12 ${state}`], error };
    entry.phase = ['failed', 'cancelled', 'interrupted'].includes(state) ? 'installation_stopped' : state === 'ready' ? 'installed' : 'installing';
    return copy(entry);
  };
  const deliver = (command, id, value) => {
    const requestKey = key(command, id), snapshot = copy(responses[requestKey] ?? value);
    if (failures[requestKey]) throw new Error(failures[requestKey]);
    if (!holds[requestKey]) return snapshot;
    delete holds[requestKey];
    if (pending[requestKey]) throw new Error(`Duplicate in-flight fixture request: ${requestKey}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { delete pending[requestKey]; reject(new Error(`Fixture gate timed out: ${requestKey}`)); }, 20000);
      pending[requestKey] = {
        snapshot,
        resolve(value = snapshot) { clearTimeout(timer); delete pending[requestKey]; resolve(copy(value)); },
        reject(message) { clearTimeout(timer); delete pending[requestKey]; reject(new Error(message)); },
      };
    });
  };
  const sameHost = (left, right) => left.target.host.toLowerCase().replace(/\.$/, '') === right.target.host.toLowerCase().replace(/\.$/, '') && left.target.port === right.target.port && left.fingerprint === right.fingerprint;
  const finishReset = job => {
    if (job.result) return copy(job.result);
    const freshId = `${job.connection.id}-fresh`;
    for (const id of job.affected) { entries[id].phase = 'reset'; entries[id].endpoint = null; archived.add(id); }
    delete registry.environments[job.review.environmentId];
    specs[freshId] = { ...copy(specs[job.connection.id]), id: freshId, operationId: crypto.randomUUID(), environmentId: crypto.randomUUID() };
    controls[freshId] = { recommendation: 'fresh_install_candidate', inspection: {}, planNumber: 0, launchState: 'running', launchSteps: 4 };
    entries[freshId] = { id: freshId, label: job.connection.label, target: copy(job.connection.target), fingerprint: job.connection.fingerprint,
      phase: 'trusted', inspection: null, recommendation: null, endpoint: null, error: null, log: ['Original native removal confirmed. New installation approval required.'], plan: null, installation: null };
    job.result = { state: 'complete', resetId: job.review.resetId, entry: copy(entries[freshId]), message: 'Removal confirmed; review a new installation plan.' };
    return copy(job.result);
  };
  for (const spec of servers) controls[spec.id] = { recommendation: 'fresh_install_candidate', inspection: {}, planNumber: 0, launchState: 'running', launchSteps: 4 };
  window.__setupFixture = { specs, entries, scans, controls, pending, responses, failures, holds, calls, unexpected, registry, advance, archived, reports, restartReviews, resetJobs,
    journal: null, journalError: '', snapshot: id => copy(requireEntry(id)),
    release(command, id = '', value) { const request = pending[key(command, id)]; if (!request) throw new Error(`No pending ${command}:${id}`); request.resolve(value); },
    reject(command, id, message) { const request = pending[key(command, id)]; if (!request) throw new Error(`No pending ${command}:${id}`); request.reject(message); },
  };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => ++callback, unregisterCallback() {},
    async invoke(command, args = {}) {
      if (command.startsWith('plugin:') || ['set_sidebar_window_controls', 'set_sidebar_window_control_mode', 'set_sidebar_window_control_presentation'].includes(command)) return;
      if (command === 'sidebar_pointer_inside') return false;
      calls.push({ command, args: copy(args) });
      if (command === 'environment_list') return { registry: copy(registry), legacy: { endpoint: null, pending: false } };
      if (command === 'setup_list') {
        if (window.__setupFixture.journalError) throw new Error(window.__setupFixture.journalError);
        return deliver(command, '', window.__setupFixture.journal ?? Object.values(entries));
      }
      if (command === 'setup_history_list') {
        for (const id of archived) if (entries[id]?.phase !== 'reset' && entries[id]?.installation && !['ready', 'complete', 'failed', 'cancelled', 'interrupted'].includes(entries[id].installation.state)) archived.delete(id);
        return deliver(command, '', [...archived]);
      }
      if (command === 'setup_choose_identity') return deliver(command, '', '/synthetic/private/id_ed25519');
      if (command === 'setup_scan') {
        const spec = servers.find(spec => spec.host === args.target.host);
        if (!spec) throw new Error(`Unexpected SSH destination ${args.target.host}`);
        scans[spec.id] = { id: spec.id, target: copy(args.target), fingerprint: `SHA256:independently-verify-${spec.id}` };
        return deliver(command, spec.id, scans[spec.id]);
      }
      if (command === 'setup_trust') {
        const scan = scans[args.id];
        if (!scan || scan.fingerprint !== args.fingerprint) throw new Error('The reviewed fingerprint does not match');
        if (entries[args.id]) throw new Error('Duplicate trust');
        entries[args.id] = { ...copy(scan), label: args.label, phase: 'trusted', inspection: null, recommendation: null,
          endpoint: null, error: null, log: [`${args.id} ONLY: host key explicitly trusted; no server changes.`] };
        return deliver(command, args.id, entries[args.id]);
      }
      if (command.startsWith('setup_')) {
        const entry = requireEntry(args.id), control = controls[args.id], spec = specs[args.id];
        if (command === 'setup_restart_status') {
          const job = Object.values(resetJobs).find(job => job.affected.includes(args.id) || sameHost(job.connection, entry));
          if (!job) return deliver(command, args.id, noPendingRestart);
          if (job.result || controls[job.connection.id].restartStatusComplete) return deliver(command, args.id, finishReset(job));
          return deliver(command, args.id, { state: 'unknown', resetId: job.review.resetId, entry: null, message: 'Reset outcome unconfirmed. Do not repeat removal.' });
        }
        if (command === 'setup_restart_candidates') return deliver(command, args.id, Object.values(entries).filter(source => source.installation && source.plan && sameHost(entry, source) && !['reset', 'restart_pending'].includes(source.phase)).map(source => ({ id: source.id, label: source.label, operationId: source.installation.operationId,
          environmentId: source.installation.environmentId, state: source.installation.state, completedSteps: source.installation.completedSteps, totalSteps: source.installation.totalSteps })));
        if (command === 'setup_restart_review') {
          const source = requireEntry(args.sourceId), progress = source.installation;
          if (typeof args.password !== 'boolean' || !sameHost(entry, source) || !progress) throw new Error('Restart ownership mismatch');
          const inactive = ['failed', 'cancelled', 'interrupted', 'ready', 'complete'].includes(progress.state);
          const blockers = inactive ? control.restartBlockers ?? [] : ['The installer is still active. Stop it and review again.'];
          const canReset = inactive && blockers.length === 0;
          const review = { reviewId: crypto.randomUUID(), resetId: crypto.randomUUID(), sourceId: source.id, host: entry.target.host,
            operationId: progress.operationId, environmentId: progress.environmentId, releaseId: progress.releaseId, expiresAt: now() + 300000,
            paths: ['/opt/outpost-native', '/etc/outpost-native', '/var/lib/outpost-native'], services: ['outpost-native-worker.service', 'outpost-native-coordinator.service'],
            accounts: ['user:outpost-coord', 'user:outpost-pi', 'user:outpost-build', 'group:outpost-workspaces'], preserved: ['Original setup receipts', 'Kubernetes and legacy workloads'],
            warnings: ['All data in the native roots will be erased.'], blockers,
            canReset, state: progress.state, completedSteps: progress.completedSteps, totalSteps: progress.totalSteps };
          restartReviews[args.id] = review;
          return deliver(command, args.id, review);
        }
        if (command === 'setup_restart_stop') {
          if (typeof args.password !== 'boolean' || !sameHost(entry, requireEntry(args.sourceId))) throw new Error('Wrong stop target');
          await deliver(command, args.id, null);
          advance(args.sourceId, entries[args.sourceId].installation.completedSteps, 'cancelled'); return;
        }
        if (command === 'setup_restart_apply') {
          const review = restartReviews[args.id];
          if (!review || args.reviewId !== review.reviewId || args.confirmation !== entry.target.host || typeof args.password !== 'boolean' || !review.canReset || review.expiresAt <= Date.now()) throw new Error('Explicit current restart review and host confirmation required');
          if (Object.values(resetJobs).some(job => sameHost(job.connection, entry) && !job.result)) throw new Error('Unresolved reset cannot be repeated');
          await deliver(command, args.id, null);
          const job = { connection: copy(entry), review: copy(review), affected: Object.values(entries).filter(source => sameHost(entry, source)).map(source => source.id), result: null };
          resetJobs[review.resetId] = job;
          for (const id of job.affected) entries[id].phase = 'restart_pending';
          if (control.restartUnknown) return { state: 'unknown', resetId: review.resetId, entry: null, message: 'Reset outcome unconfirmed. Do not repeat removal.' };
          return finishReset(job);
        }
        if (command === 'setup_history_archive') {
          if (entry.installation && !['ready', 'complete', 'failed', 'cancelled', 'interrupted'].includes(entry.installation.state)) throw new Error('Active or unknown installations cannot be archived.');
          await deliver(command, args.id, null);
          archived.add(args.id); delete reports[args.id]; return [...archived];
        }
        if (command === 'setup_history_restore') { await deliver(command, args.id, null); archived.delete(args.id); return [...archived]; }
        if (command === 'setup_diagnostics') {
          if (typeof args.protectedLogs !== 'boolean' || typeof args.password !== 'boolean' || Object.keys(args).sort().join(',') !== 'id,password,protectedLogs') throw new Error('Diagnostic consent is boolean-only');
          const receipt = entry.installation, timestamp = now();
          if (!receipt) throw new Error('No saved installation receipt');
          const source = (id, label, text, isPrivate = false) => ({ id, label, status: isPrivate && !args.protectedLogs ? 'permission_denied' : 'available', text: isPrivate && !args.protectedLogs ? '' : text, truncated: false });
          const report = { schemaVersion: 1, reportId: `report-${args.id}-${timestamp}`, setupId: args.id,
            operationId: receipt.operationId, environmentId: receipt.environmentId, releaseId: receipt.releaseId,
            stage: receipt.stage, state: receipt.state, completedSteps: receipt.completedSteps, totalSteps: receipt.totalSteps,
            collectedAt: timestamp, expiresAt: timestamp + 300000, redacted: args.protectedLogs,
            sources: [source('status.json', 'Installation receipt', JSON.stringify(receipt)),
              source('command.log', 'Latest installer command output (legacy)', 'Later cleanup completed.', true),
              source('failed-command.log', 'Preserved failed command output', `Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234.\n${args.id} ONLY: [REDACTED sensitive line]`, true),
              source('diagnostics.json', 'Command attribution', JSON.stringify({ schema: 1, failedCommand: { substageId: 'browser-os-dependencies', outcome: 'failed', exitCode: 1 } }), true),
              source('launch.log', 'Installer launch output', 'Transient setup unit launched.', true),
              source('service', 'Setup service properties', 'ActiveState=inactive\nExecMainStatus=0')],
            notes: ['Synthetic diagnostic evidence. No actual SSH or sudo is used.'] };
          reports[args.id] = report;
          return deliver(command, args.id, report);
        }
        if (command === 'setup_diagnostics_cancel') {
          delete reports[args.id];
          pending[key('setup_diagnostics', args.id)]?.reject('Diagnostic read cancelled');
          return;
        }
        if (command === 'setup_diagnostics_export') {
          if (Object.keys(args).sort().join(',') !== 'id,reportId' || reports[args.id]?.reportId !== args.reportId) throw new Error('Unknown native diagnostic snapshot');
          return deliver(command, args.id, `${exportDirectory}/${args.id}-diagnostics.json`);
        }
        if (command === 'setup_diagnostic_guide') {
          const path = `/var/lib/outpost-setup/operations/${entry.installation.operationId}`;
          return deliver(command, args.id, { destination: `${entry.target.user}@${entry.target.host}:${entry.target.port}`, fingerprint: entry.fingerprint, steps: [
            { id: 'connect', title: 'Open the pinned SSH session on this Mac', command: `ssh -o StrictHostKeyChecking=yes -p ${entry.target.port} ${entry.target.user}@${entry.target.host}`, detail: 'Synthetic guide only; compare the saved fingerprint and use the real native-generated pinned command.', privileged: false, runOn: 'mac' },
            { id: 'receipt', title: 'Read this operation’s receipt', command: `cat '${path}/status.json'`, detail: 'Inspect stage, state and completedSteps; this fixture never executes commands.', privileged: false, runOn: 'server' },
            { id: 'output', title: 'Read recent installer output', command: `sudo tail -c 12288 -- '${path}/command.log'`, detail: 'Private output must be reviewed before sharing. Correcting prerequisites does not resume installation.', privileged: true, runOn: 'server' },
          ] });
        }
        if (command === 'setup_export_log') {
          if (Object.keys(args).length !== 1) throw new Error('Native export accepts only the saved setup ID');
          return deliver(command, args.id, `${exportDirectory}/${entry.id}.log`);
        }
        if (command === 'setup_inspect') {
          entry.phase = 'review'; entry.inspection = inspection(args.id); entry.recommendation = control.recommendation;
          if (!entry.installation) entry.plan = null;
          entry.log.push(`${args.id} ONLY: read-only inspection; no installer was run.`);
          return deliver(command, args.id, entry);
        }
        if (command === 'setup_plan') {
          if (entry.installation) throw new Error('An operation already exists');
          if (typeof args.browser !== 'boolean' || typeof args.fullControl !== 'boolean') throw new Error('Explicit capabilities required');
          entry.phase = 'install_review';
          entry.plan = { planId: `${args.id}-plan-${++control.planNumber}`, operationId: spec.operationId, environmentId: spec.environmentId,
            releaseId: `host-fixture-${args.id}`, sha256: (args.id === 'setup-alpha' ? 'a' : 'b').repeat(64), size: 123456,
            expiresAt: now() + 300000, browser: args.browser, fullControl: args.fullControl,
            coexistenceRequired: control.recommendation === 'migration_review', deviceId: 'synthetic-mac-device', publicKey: 'synthetic-ed25519-public-key', nodeVersion: '24.22.1' };
          return deliver(command, args.id, entry);
        }
        if (command === 'setup_install') {
          if (!entry.plan || args.planId !== entry.plan.planId || args.approved !== true || entry.plan.coexistenceRequired && args.coexistence !== true)
            throw new Error('Explicit plan and coexistence approval required');
          if (typeof args.password !== 'boolean' || Object.keys(args).some(name => /secret|token/i.test(name))) throw new Error('Only a native sudo boolean is accepted');
          if (entry.installation && !(['unknown', 'authorizing'].includes(entry.installation.state) && entry.installation.completedSteps === 0)) throw new Error('Unsafe installation replay');
          if (!entry.installation && Date.now() >= entry.plan.expiresAt) throw new Error('Expired first launch');
          return deliver(command, args.id, advance(args.id, control.launchSteps, control.launchState));
        }
        if (command === 'setup_install_status') return deliver(command, args.id, entry);
        if (command === 'setup_install_cancel') return deliver(command, args.id, advance(args.id, entry.installation.completedSteps, 'cancelled'));
        if (command === 'setup_finish') {
          if (!['ready', 'complete'].includes(entry.installation?.state)) throw new Error('Cannot register an unfinished installation');
          if (entry.installation.state !== 'complete') advance(args.id, 12, 'complete');
          entry.endpoint = spec.endpoint; entry.phase = 'tunnel_ready';
          registry.environments[spec.environmentId] = { environmentId: spec.environmentId, label: entry.label, activeRoute: entry.endpoint, routes: [entry.endpoint] };
          return deliver(command, args.id, entry);
        }
        if (command === 'setup_tunnel') { entry.endpoint = spec.endpoint; entry.phase = 'tunnel_ready'; return deliver(command, args.id, entry); }
        if (command === 'setup_disconnect') { entry.endpoint = null; entry.phase = 'disconnected'; return deliver(command, args.id, entry); }
      }
      if (command === 'environment_discover') {
        if (args.endpoint !== direct.endpoint) throw new Error('Unexpected discovery URL');
        return { descriptorVersion: 1, environmentId: direct.environmentId, label: direct.label, protocolVersion: 2, recordProtocolVersion: 1 };
      }
      if (command === 'environment_register') {
        const spec = servers.find(spec => spec.environmentId === args.environmentId);
        if (args.endpoint !== (spec?.endpoint ?? direct.endpoint) || !spec && args.environmentId !== direct.environmentId) throw new Error('Unverified environment route');
        if ('bootstrapToken' in args) throw new Error('Existing enrollment must never bootstrap');
        await deliver(command, args.environmentId, null);
        registry.environments[args.environmentId] = { environmentId: args.environmentId, label: args.label, activeRoute: args.endpoint, routes: [args.endpoint] };
        if (args.retireLegacyMutations) registry.legacyMutationsRetired = true;
        return copy(registry);
      }
      if (command === 'environment_select') { registry.selectedEnvironmentId = args.environmentId; return copy(registry); }
      const op = command.replace(/^environment_/, '');
      if (op === 'disconnect') return;
      if (op === 'connection_info') return { endpoint: 'Synthetic connection', deviceId: 'fixture', publicKey: 'fixture-public', pending: false, nativeSidebar: false };
      // A stream lives only as long as this bounded browser context, never a real native subscription.
      if (op === 'stream_events') return new Promise(resolve => setTimeout(resolve, 90000));
      if (op === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records: [{ kind: 'task', id: 'fixture-task', revision: 1, updatedAt: '2026-11-08T10:00:00Z', data: { goal: 'Setup fixture', profile: 'operations', state: 'verifying' } }] };
        if (args.kind === 'runtime') return { configured: false, model: null };
        if (args.kind === 'models') return { models: [], defaultModel: null };
        if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
      }
      unexpected.push({ command, args: copy(args) });
      throw new Error(`Unexpected fixture IPC ${command}`);
    },
  };
}

const dialogFor = page => page.getByRole('dialog', { name: 'Server setup', exact: true });
const paneFor = (page, spec) => dialogFor(page).getByRole('region', { name: spec.label, exact: true });
const activePane = page => dialogFor(page).locator('.workspace:not([hidden])');
const railFor = (page, spec) => dialogFor(page).locator(`[data-setup-id="${spec.id}"]`);
const button = (pane, name) => pane.getByRole('button', { name, exact: true });
const installApproval = pane => pane.getByRole('checkbox', { name: /I approve these installation changes/ });
const coexistenceApproval = pane => pane.getByRole('checkbox', { name: /Create a separate environment alongside/ });
const callsFor = (page, command, id) => page.evaluate(({ command, id }) => window.__setupFixture.calls.filter(call => call.command === command && (id === undefined || call.args.id === id || call.args.environmentId === id)), { command, id });
const snapshot = (page, spec) => page.evaluate(id => window.__setupFixture.snapshot(id), spec.id);
const configure = (page, spec, patch) => page.evaluate(({ id, patch }) => Object.assign(window.__setupFixture.controls[id], patch), { id: spec.id, patch });
const pending = (page, command, id = '') => page.waitForFunction(key => !!window.__setupFixture.pending[key], `${command}:${id}`, { timeout: actionTimeout });
const hold = (page, command, id = '') => page.evaluate(key => { window.__setupFixture.holds[key] = true; }, `${command}:${id}`);
const release = (page, command, id = '', value) => page.evaluate(({ command, id, value }) => window.__setupFixture.release(command, id, value), { command, id, value });
const advance = (page, spec, steps, state = 'running', error = null) => page.evaluate(({ id, steps, state, error }) => window.__setupFixture.advance(id, steps, state, error), { id: spec.id, steps, state, error });
const visible = locator => locator.waitFor({ state: 'visible', timeout: actionTimeout });
async function enabled(locator, expected = true) {
  await locator.evaluate((element, expected) => new Promise((resolve, reject) => {
    const start = performance.now();
    const poll = () => {
      if (!element.disabled === expected) resolve();
      else if (performance.now() - start > 6000) reject(new Error(`Control did not become ${expected ? 'enabled' : 'disabled'}`));
      else setTimeout(poll, 20);
    };
    poll();
  }), expected);
}
async function progress(page, spec, value) {
  await page.waitForFunction(({ id, value }) => document.querySelector(`[data-setup-id="${id}"] progress`)?.value === value, { id: spec.id, value }, { timeout: actionTimeout });
  equal(await railFor(page, spec).locator('progress').getAttribute('max'), '12', `${spec.label} has twelve native checks`);
}
async function observeJournal(page, rounds = 2) {
  const count = (await callsFor(page, 'setup_list')).length;
  await page.waitForFunction(count => window.__setupFixture.calls.filter(call => call.command === 'setup_list').length >= count, count + rounds, { timeout: actionTimeout });
}
async function select(page, spec) {
  await railFor(page, spec).click();
  await visible(paneFor(page, spec));
}
async function fillDraft(page, spec, { key = false } = {}) {
  const pane = activePane(page);
  await pane.getByLabel('Server name', { exact: true }).fill(spec.label);
  await pane.getByLabel('Server address', { exact: true }).fill(spec.host.includes(':') ? `[${spec.host}]` : spec.host);
  await pane.getByLabel('SSH username', { exact: true }).fill(spec.user);
  await pane.getByLabel('SSH port', { exact: true }).fill(String(spec.port));
  check(await pane.getByRole('radio', { name: /SSH agent/ }).isChecked(), 'SSH agent is the default authentication choice');
  if (key) {
    await pane.getByRole('radio', { name: 'A private key on this Mac', exact: true }).check();
    await button(pane, 'Choose SSH key…').click();
    await enabled(button(pane, 'Check connection'));
    equal(await pane.getByLabel('Private key path', { exact: true }).inputValue(), '/synthetic/private/id_ed25519', 'Native picker supplies a path, not private key contents');
  }
}
async function scanDraft(page, spec) {
  const pane = activePane(page);
  const identityFile = await pane.getByRole('radio', { name: 'A private key on this Mac', exact: true }).isChecked()
    ? await pane.getByLabel('Private key path', { exact: true }).inputValue() : null;
  await button(pane, 'Check connection').click();
  await visible(pane.getByRole('group', { name: 'Verify SSH host fingerprint' }));
  check(await button(pane, 'Trust & inspect').isDisabled(), 'Host trust needs an independent affirmative choice');
  equal((await callsFor(page, 'setup_trust', spec.id)).length, 0, 'Scanning never trusts automatically');
  equal((await callsFor(page, 'setup_inspect', spec.id)).length, 0, 'No inspection before fingerprint approval');
  const scan = (await callsFor(page, 'setup_scan')).find(call => call.args.target.host === spec.host);
  equal(scan.args.target, { host: spec.host, user: spec.user, port: spec.port, identityFile }, 'Split SSH fields produce an exact native target, including IPv6');
}
async function trustDraft(page, spec, { wait = true } = {}) {
  const pane = activePane(page);
  await pane.getByRole('checkbox', { name: /I independently verified this fingerprint/ }).check();
  await button(pane, 'Trust & inspect').click();
  await visible(paneFor(page, spec));
  await page.waitForFunction(id => window.__setupFixture.calls.some(call => call.command === 'setup_inspect' && call.args.id === id), spec.id, { timeout: actionTimeout });
  if (wait) await visible(button(paneFor(page, spec), 'Inspect again'));
  equal((await callsFor(page, 'setup_inspect', spec.id)).length, 1, 'Trust automatically starts exactly one read-only inspection for its ID');
  const trust = (await callsFor(page, 'setup_trust', spec.id)).at(-1);
  equal(trust.args, { id: spec.id, label: spec.label, fingerprint: `SHA256:independently-verify-${spec.id}` }, 'Trust binds the displayed fingerprint and server label');
}
async function addServer(page, spec, options = {}) {
  if (spec.id !== A.id) await dialogFor(page).getByRole('button', { name: 'Add server', exact: true }).click();
  await fillDraft(page, spec, options);
  await scanDraft(page, spec);
  await trustDraft(page, spec, options);
}
async function preparePlan(page, spec) {
  const pane = paneFor(page, spec);
  await button(pane, 'Review installation plan').click();
  await visible(button(pane, 'Authorize & install'));
  await enabled(button(pane, 'Refresh plan'));
  check(await button(pane, 'Authorize & install').isDisabled(), 'A real plan is not authorization');
  return (await snapshot(page, spec)).plan;
}
async function approve(page, spec) {
  const pane = paneFor(page, spec);
  await installApproval(pane).check();
  if (await coexistenceApproval(pane).count()) {
    check(await button(pane, 'Authorize & install').isDisabled(), 'Coexistence consent is separate from install consent');
    await coexistenceApproval(pane).check();
  }
  await enabled(button(pane, 'Authorize & install'));
}
async function launch(page, spec) {
  await preparePlan(page, spec);
  await approve(page, spec);
  await button(paneFor(page, spec), 'Authorize & install').click();
  await visible(button(paneFor(page, spec), 'Continue in background'));
}
async function layout(page, tag) {
  const geometry = await dialogFor(page).evaluate(modal => {
    const pane = modal.querySelector('.workspace:not([hidden])'), footer = pane.querySelector('.setup-footer');
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const buttons = [...footer.querySelectorAll('button')].map(element => {
      const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { ...rect(element), text: element.textContent, hit: element === hit || element.contains(hit) };
    });
    return { modal: rect(modal), footer: rect(footer), buttons, width: innerWidth, height: innerHeight,
      bodyWidth: document.documentElement.scrollWidth, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth,
      modalScrollWidth: modal.scrollWidth, modalWidth: modal.clientWidth, scrollHeight: pane.querySelector('.content-scroll').clientHeight,
      scrollTopBeforeCapture: pane.querySelector('.content-scroll').scrollTop };
  });
  writeFileSync(`${out}/${tag}-geometry.json`, JSON.stringify(geometry, null, 2));
  check(geometry.modal.x >= -1 && geometry.modal.right <= geometry.width + 1 && geometry.modal.y >= -1 && geometry.modal.bottom <= geometry.height + 1, `${tag}: native modal fits viewport`);
  check(geometry.bodyWidth <= geometry.width + 1 && geometry.paneScrollWidth <= geometry.paneWidth + 1 && geometry.modalScrollWidth <= geometry.modalWidth + 1, `${tag}: no horizontal document or pane overflow`);
  check(geometry.footer.y >= geometry.modal.y && geometry.footer.bottom <= geometry.modal.bottom + 1, `${tag}: footer remains inside the dialog without scrolling`);
  check(geometry.scrollHeight > 40, `${tag}: stage content retains a usable scroll area`);
  for (const control of geometry.buttons) check(control.hit && control.x >= -1 && control.right <= geometry.width + 1 && control.bottom <= geometry.height + 1, `${tag}: footer action visible and unobscured: ${control.text}`);
  // Capture normalization only; stage-scroll-reset verifies the real transition before this helper runs.
  await activePane(page).locator('.content-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `${out}/${tag}.png`, timeout: actionTimeout });
}
async function copyReport(page, spec, peer) {
  const pane = paneFor(page, spec);
  await pane.getByRole('button', { name: /^(Copy log|Copied)$/ }).click();
  await visible(button(pane, 'Copied'));
  const report = await page.evaluate(() => navigator.clipboard.readText());
  check(report.includes(spec.label) && report.includes(spec.host) && report.includes(spec.operationId)
    && report.includes(`${spec.id} ONLY`), `${spec.label} copied report contains its own target, operation and activity`);
  check(!report.includes(peer.label) && !report.includes(peer.host) && !report.includes(peer.operationId)
    && !report.includes(`${peer.id} ONLY`), `${spec.label} copied report excludes peer identity and logs`);
  writeFileSync(`${out}/${spec.id}-copied.log`, report);
}
async function reopen(page) {
  await dialogFor(page).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open server setup', exact: true }).click();
  await visible(dialogFor(page));
}
async function focusAndEscape(page) {
  const modal = dialogFor(page), close = button(modal, 'Close server setup');
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  // Native dialogs may visit browser chrome at the tab boundary, but never the inert application.
  const atChrome = await page.evaluate(() => document.activeElement === document.body && !document.hasFocus());
  if (atChrome) await page.keyboard.press('Shift+Tab');
  check(await modal.evaluate(element => element.contains(document.activeElement)), 'Backward Tab never reaches the inert application');
  await close.focus();
  await page.keyboard.press('Tab');
  check(await modal.evaluate(element => element.contains(document.activeElement)), 'Forward Tab stays in the native modal');
  await page.keyboard.press('Escape');
  await reopen(page);
  check(await close.evaluate(element => document.activeElement === element), 'Reopening focuses the dialog close control');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  check(await page.getByRole('button', { name: 'Open server setup', exact: true }).evaluate(element => document.activeElement === element), 'Escape restores focus to the opener');
  await reopen(page);
}

const results = [];
let browser;
async function run(name, test, { width = 1440, colorScheme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.grantPermissions(browserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage(), errors = [], network = [], downloads = [];
  page.setDefaultTimeout(actionTimeout); page.setDefaultNavigationTimeout(actionTimeout);
  page.on('download', download => downloads.push(download.suggestedFilename()));
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    network.push(url.href); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { network.push(socket.url()); socket.close(); });
  await page.addInitScript(installFixture, { servers: [A, B], direct, exportDirectory: out, noPendingRestart });
  const started = Date.now();
  let timer, failure;
  console.log(`RUN ${name} (${browserName})`);
  try {
    await Promise.race([
      (async () => {
        await page.goto(origin);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-link-list a[href="#machines"]').click();
        await page.getByRole('link', { name: 'Add server', exact: true }).click();
        await visible(dialogFor(page));
        check(await dialogFor(page).evaluate(element => element instanceof HTMLDialogElement && element.open && element.matches(':modal')), 'Add server auto-opens a real modal dialog');
        await page.setViewportSize({ width, height: 1000 });
        await test(page);
        equal(await page.evaluate(() => window.__setupFixture.unexpected), [], 'All IPC belongs to the synthetic fixture contract');
        equal(network, [], 'No SSH, Keychain, remote HTTP or WebSocket traffic');
        equal(downloads, [], 'Native log export never triggers a browser download');
        equal(errors, [], 'No browser exceptions or console errors');
        const installs = await callsFor(page, 'setup_install');
        check(installs.every(call => typeof call.args.password === 'boolean'), 'Sudo crosses IPC as a boolean only');
        check(installs.every(call => Object.keys(call.args).sort().join(',') === 'approved,coexistence,id,password,planId'), 'Install arguments contain no credential or bootstrap payload');
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} exceeded ${testTimeout} ms`)), testTimeout); }),
    ]);
    console.log(`PASS ${name}`);
  } catch (error) {
    failure = error;
    console.error(`FAIL ${name}: ${error.stack || error}`);
    await page.screenshot({ path: `${out}/${name}-failure.png`, timeout: 3000 }).catch(() => {});
    const diagnostics = await Promise.race([
      page.evaluate(() => ({ html: document.body.innerHTML, text: document.body.innerText,
        focus: { tag: document.activeElement?.tagName, id: document.activeElement?.id, label: document.activeElement?.getAttribute('aria-label'), hasDocumentFocus: document.hasFocus() },
        calls: window.__setupFixture?.calls, entries: window.__setupFixture?.entries, registry: window.__setupFixture?.registry })).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 3000)),
    ]);
    writeFileSync(`${out}/${name}-failure.json`, JSON.stringify({ error: String(error.stack || error), errors, network, downloads, diagnostics }, null, 2));
  } finally {
    clearTimeout(timer);
    results.push({ name, passed: !failure, durationMs: Date.now() - started, error: failure ? String(failure.message) : undefined });
    await context.close();
  }
}

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await engine.launch({ timeout: 15000 });
  await run('dialog-keyboard-and-focus', focusAndEscape);
  for (const width of [1440, 900, 390]) await run(`flow-${width}`, async page => {
    await configure(page, A, { recommendation: 'migration_review' });
    await fillDraft(page, A, { key: true });
    await layout(page, `${width}-connect`);
    await scanDraft(page, A);
    await layout(page, `${width}-fingerprint`);
    await trustDraft(page, A);
    const pane = paneFor(page, A);
    await visible(pane.getByText('Migration review required', { exact: true }));
    check(await pane.getByRole('checkbox', { name: /Full server control/ }).isChecked() === false, 'Full server control is off by default');
    check(await pane.getByRole('checkbox', { name: /Browser tools/ }).isChecked(), 'Browser tools are initially enabled');
    equal(await pane.locator('input[type=password]').count(), 0, 'SSH and sudo passwords are never collected by the page');
    equal((await callsFor(page, 'setup_install')).length, 0, 'Trust and inspection do not install');
    await preparePlan(page, A);
    equal((await callsFor(page, 'setup_plan', A.id)).at(-1).args, { id: A.id, browser: true, fullControl: false }, 'Default native plan has restricted ongoing authority');
    await approve(page, A);
    await layout(page, `${width}-plan`);
    await button(pane, 'Authorize & install').click();
    await progress(page, A, 4);
    equal(await pane.getByRole('progressbar', { name: `${A.label} completed checks`, exact: true }).getAttribute('value'), '4', 'Install screen reports four completed native checks');
    equal(await button(pane, 'Connect & finish setup').count(), 0, 'Running installation cannot be registered as ready');
    await layout(page, `${width}-install`);
    await button(pane, 'Continue in background').click();
    await advance(page, A, 10, 'ready');
    await observeJournal(page);
    await reopen(page);
    await visible(button(pane, 'Connect & finish setup'));
    await progress(page, A, 10);
    equal((await callsFor(page, 'setup_install', A.id)).length, 1, 'Closing and reopening never relaunches installation');
    equal(await page.evaluate(id => window.__setupFixture.registry.environments[id] ?? null, A.environmentId), null, 'Ready at ten checks is not authenticated registration');
    await layout(page, `${width}-ready`);
    await button(pane, 'Connect & finish setup').click();
    await visible(button(pane, 'Open environment'));
    await progress(page, A, 12);
    await visible(pane.getByRole('heading', { name: `${A.label} is ready.`, exact: true }));
    equal(await page.evaluate(() => [window.__setupFixture.registry.selectedEnvironmentId, window.__setupFixture.registry.legacyMutationsRetired]), [null, false], 'Finishing does not select the environment or retire unrelated legacy mutations');
    equal((await callsFor(page, 'environment_select')).length, 0, 'Only explicit Open environment may change global selection');
    await layout(page, `${width}-complete`);
    await button(pane, 'Disconnect SSH').click();
    await visible(button(pane, 'Reconnect environment'));
    await button(pane, 'Reconnect environment').click();
    await visible(button(pane, 'Open environment'));
    equal((await callsFor(page, 'setup_finish', A.id)).length, 2, 'Reconnection verifies the saved route through finish');
    equal((await callsFor(page, 'setup_install', A.id)).length, 1, 'Reconnection does not reinstall');
    await page.emulateMedia({ colorScheme: 'light' });
    check(await dialogFor(page).evaluate(element => getComputedStyle(element).colorScheme === 'light' && getComputedStyle(element).backgroundColor === 'rgb(255, 255, 255)'), 'Setup honors light mode');
    await layout(page, `${width}-light`);
  }, { width });

  await run('stage-scroll-reset', async page => {
    await configure(page, A, { recommendation: 'migration_review' });
    await addServer(page, A);
    const pane = paneFor(page, A), scroll = pane.locator('.content-scroll');
    await preparePlan(page, A);
    await approve(page, A);
    check(await scroll.evaluate(element => element.scrollTop > 100), 'Approving the long review naturally scrolls away from the stage heading');
    await button(pane, 'Authorize & install').click();
    await progress(page, A, 4);
    equal(await pane.locator('.steps [aria-current="step"]').getAttribute('aria-label'), 'Install, current', 'Authorization advances from Review to Install');
    equal(await scroll.evaluate(element => element.scrollTop), 0, 'Authorization itself resets the new stage to the top, before screenshot normalization');
    check(await scroll.evaluate(element => {
      const heading = element.querySelector('.stage-title').getBoundingClientRect(), viewport = element.getBoundingClientRect();
      return heading.top >= viewport.top && heading.bottom <= viewport.bottom;
    }), 'The installation heading is visible without scrolling it into view');
    await layout(page, '390-install-scroll-reset');
  }, { width: 390 });

  await run('inspection-blockers', async page => {
    await addServer(page, A);
    const pane = paneFor(page, A);
    const cases = [
      ['unsupported_host', { os: 'debian' }, /not supported for installation/],
      ['fresh_install_candidate', { osVersion: '22.04' }, /Installation blocked/],
      ['fresh_install_candidate', { architecture: 'aarch64' }, /Installation blocked/],
      ['fresh_install_candidate', { systemd: false }, /Installation blocked/],
      ['fresh_install_candidate', { container: true }, /Installation blocked/],
      ['ambiguous_installation', { api: 'unknown', apiPort: 4518 }, /Existing data or service needs review/],
      ['insufficient_capacity', { freeBytes: 9 * 1024 ** 3 }, /Capacity review required/],
      ['fresh_install_candidate', { nativePresent: true }, /Native installation files already exist/],
    ];
    for (const [recommendation, inspection, message] of cases) {
      await configure(page, A, { recommendation, inspection });
      const before = (await callsFor(page, 'setup_inspect', A.id)).length;
      await button(pane, 'Inspect again').click();
      await page.waitForFunction(({ id, before }) => window.__setupFixture.calls.filter(call => call.command === 'setup_inspect' && call.args.id === id).length > before, { id: A.id, before });
      await enabled(button(pane, 'Inspect again'));
      await visible(pane.getByText(message).first());
      check(await button(pane, 'Review installation plan').isDisabled(), `${recommendation}/${JSON.stringify(inspection)} blocks installation plans`);
      equal(await button(pane, 'Authorize & install').count(), 0, 'Blocked inspections do not expose authorization');
    }
    equal((await callsFor(page, 'setup_plan')).length, 0, 'No blocker was bypassed with native plan creation');
    await configure(page, A, { recommendation: 'fresh_install_candidate', inspection: { memoryBytes: 2.5 * 1024 ** 3 } });
    await button(pane, 'Inspect again').click();
    await enabled(button(pane, 'Inspect again'));
    check(await button(pane, 'Review installation plan').isDisabled(), 'Browser tools require at least 3 GiB usable RAM');
    await pane.getByRole('checkbox', { name: /Browser tools/ }).uncheck();
    await enabled(button(pane, 'Review installation plan'));
    await configure(page, A, { recommendation: 'migration_review', inspection: { nativePresent: true } });
    await button(pane, 'Inspect again').click();
    await enabled(button(pane, 'Inspect again'));
    check(await button(pane, 'Review installation plan').isDisabled(), 'Migration review cannot override nativePresent');
    await configure(page, A, { recommendation: 'migration_review', inspection: { uid: 0 } });
    await button(pane, 'Inspect again').click();
    await enabled(button(pane, 'Review installation plan'));
    equal(await pane.getByRole('button', { name: /Upgrade|Remove Kubernetes|Migrate data/ }).count(), 0, 'Migration review offers no destructive upgrade, removal or migration action');
    await preparePlan(page, A);
    equal(await pane.getByRole('checkbox', { name: /Ask for the remote sudo password/ }).count(), 0, 'Root SSH account never asks the webview for a sudo password');
    await approve(page, A);
    await button(pane, 'Authorize & install').click();
    await progress(page, A, 4);
    equal((await callsFor(page, 'setup_install', A.id)).at(-1).args.password, false, 'Root authorization passes password=false');
  });

  await run('plan-consent-expiry', async page => {
    await configure(page, A, { recommendation: 'migration_review' });
    await addServer(page, A);
    const pane = paneFor(page, A), first = await preparePlan(page, A);
    await pane.getByText('Release, signing identity & operation', { exact: true }).click();
    for (const text of [first.sha256, first.deviceId, first.publicKey, first.environmentId, first.operationId, first.planId])
      check((await pane.innerText()).includes(text), `Native plan discloses ${text}`);
    await approve(page, A);
    await button(pane, 'Refresh plan').click();
    await enabled(button(pane, 'Refresh plan'));
    const second = (await snapshot(page, A)).plan;
    check(first.planId !== second.planId, 'Refresh returns a genuinely new plan identity');
    check(!await installApproval(pane).isChecked() && !await coexistenceApproval(pane).isChecked(), 'Plan identity changes clear both approvals');
    await approve(page, A);
    await pane.getByRole('checkbox', { name: /Full server control/ }).check();
    await visible(button(pane, 'Review installation plan'));
    equal(await installApproval(pane).count(), 0, 'Capability edits discard the old plan approval');
    equal(await coexistenceApproval(pane).count(), 0, 'Capability edits discard the old coexistence approval');
    equal(await button(pane, 'Authorize & install').count(), 0, 'An invalidated plan exposes no installation action');
    await observeJournal(page);
    equal(await button(pane, 'Authorize & install').count(), 0, 'Polling cannot resurrect the invalidated plan');
    await pane.getByRole('checkbox', { name: /Browser tools/ }).uncheck();
    await button(pane, 'Review installation plan').click();
    await enabled(button(pane, 'Refresh plan'));
    equal((await callsFor(page, 'setup_plan', A.id)).at(-1).args, { id: A.id, browser: false, fullControl: true }, 'Refreshed plan preserves explicitly chosen capabilities');
    check((await installApproval(pane).getAttribute('id')) !== null, 'Install approval remains a labeled control');
    check((await pane.locator('.approval').innerText()).includes('ongoing full root access'), 'Full-control consent explicitly discloses secrets, services and data');
    await approve(page, A);
    const expiring = (await snapshot(page, A)).plan;
    await page.clock.setFixedTime(expiring.expiresAt + 1);
    // No React state is changed here: authorization must recheck expiry, not trust a stale enabled button.
    await button(pane, 'Authorize & install').click();
    await visible(pane.getByRole('alert').filter({ hasText: /plan has expired/ }));
    check(!await installApproval(pane).isChecked() && !await coexistenceApproval(pane).isChecked(), 'Expiry at authorization clears approvals');
    check(await button(pane, 'Authorize & install').isDisabled(), 'Expired plan cannot launch');
    equal((await callsFor(page, 'setup_install')).length, 0, 'Expired authorization never crosses native IPC');
    await button(pane, 'Refresh plan').click();
    await enabled(button(pane, 'Refresh plan'));
    check(!await installApproval(pane).isChecked() && !await coexistenceApproval(pane).isChecked(), 'Refreshing an expired plan needs fresh consent');
    await approve(page, A);
    await pane.getByRole('checkbox', { name: /Ask for the remote sudo password/ }).uncheck();
    equal(await pane.locator('input[type=password]').count(), 0, 'No sudo secret input even with full server control');
    await button(pane, 'Authorize & install').click();
    await progress(page, A, 4);
    equal((await callsFor(page, 'setup_install', A.id)).at(-1).args.password, false, 'Passwordless sudo is an explicit boolean choice');
    check((await pane.locator('.phase-list').innerText()).includes('Will skip'), 'Browser-disabled plan reports its runtime check as skipped, not installed');
  });

  await run('unknown-and-failed-recovery', async page => {
    await configure(page, A, { recommendation: 'migration_review', launchState: 'unknown', launchSteps: 0 });
    await addServer(page, A);
    await launch(page, A);
    const pane = paneFor(page, A), original = await snapshot(page, A);
    const retry = button(pane, 'Retry same authorization');
    await visible(retry);
    check(await retry.isDisabled(), 'Unknown zero-step launch cannot retry without renewed approval');
    equal(await button(pane, 'Review installation plan').count(), 0, 'Uncertain operation cannot create a new plan');
    await button(pane, 'Reconnect & check').click();
    await enabled(button(pane, 'Reconnect & check'));
    await page.clock.setFixedTime(original.plan.expiresAt + 1);
    await pane.getByRole('checkbox', { name: /I approve retrying authorization for this same/ }).check();
    check(await retry.isDisabled(), 'Same-operation retry separately renews coexistence consent');
    await coexistenceApproval(pane).check();
    await configure(page, A, { launchState: 'running', launchSteps: 4 });
    await retry.click();
    await progress(page, A, 4);
    const launches = await callsFor(page, 'setup_install', A.id);
    equal(launches.map(call => call.args.planId), [original.plan.planId, original.plan.planId], 'Expired recovery uses exactly the original reviewed plan, never a new operation');
    equal((await snapshot(page, A)).installation.operationId, original.installation.operationId, 'Same-operation retry preserves the native operation ID');
    await advance(page, A, 4, 'failed', 'Alpha dependency download failed. Partial files retained.');
    await button(pane, 'Check progress').click();
    await visible(pane.getByRole('alert').filter({ hasText: 'Alpha dependency download failed' }));
    await progress(page, A, 4);
    equal(await button(pane, 'Retry same authorization').count(), 0, 'Failed partial installs cannot retry authorization');
    equal(await button(pane, 'Connect & finish setup').count(), 0, 'Failed installs cannot pretend to finish');
    check((await pane.innerText()).includes(`/var/lib/outpost-setup/operations/${A.operationId}`), 'Failure points to this operation’s retained receipt');
    await configure(page, B, { launchState: 'unknown', launchSteps: 4 });
    await addServer(page, B);
    await launch(page, B);
    const peer = paneFor(page, B);
    await progress(page, B, 4);
    equal(await button(peer, 'Retry same authorization').count(), 0, 'Unknown status with partial work cannot relaunch');
    check(!(await peer.innerText()).includes('Alpha dependency download failed'), 'Failed peer errors do not leak into another setup');
    await observeJournal(page);
    equal((await callsFor(page, 'setup_install', A.id)).length, 2, 'Failure never auto-retries the earlier operation');
    equal((await callsFor(page, 'setup_install', B.id)).length, 1, 'Unknown partial progress never auto-retries');
    await layout(page, 'unknown-partial');
  });

  await run('existing-enrollment', async page => {
    await configure(page, A, { recommendation: 'connect_existing', inspection: { nativePresent: true } });
    await addServer(page, A);
    const pane = paneFor(page, A);
    check(await button(pane, 'Verify & connect').isDisabled(), 'Existing installation needs explicit connect-only approval');
    equal(await button(pane, 'Review a separate installation').count(), 0, 'Native installation cannot be overwritten by a separate-install shortcut');
    await pane.getByRole('checkbox', { name: /Connect to this installation without changing its data/ }).check();
    await pane.getByRole('checkbox', { name: /If required for adoption, retire legacy mutations/ }).check();
    await hold(page, 'environment_register', A.environmentId);
    await button(pane, 'Verify & connect').click();
    await pending(page, 'environment_register', A.environmentId);
    equal(await page.evaluate(id => window.__setupFixture.registry.environments[id] ?? null, A.environmentId), null, 'A private route alone does not authenticate or save enrollment');
    equal(await button(pane, 'Open environment').count(), 0, 'No ready action before signed registration succeeds');
    await page.evaluate(id => window.__setupFixture.reject('environment_register', id, 'This Mac is not enrolled in Alpha'), A.environmentId);
    await visible(pane.getByRole('alert').filter({ hasText: 'This Mac is not enrolled in Alpha' }));
    await observeJournal(page);
    equal((await callsFor(page, 'environment_register', A.environmentId)).length, 1, 'Failed registration does not retry automatically');
    equal((await callsFor(page, 'environment_register', A.environmentId)).at(-1).args.retireLegacyMutations, true, 'Legacy retirement is an explicit separate choice');
    await pane.getByRole('checkbox', { name: /If required for adoption, retire legacy mutations/ }).uncheck();
    await button(pane, 'Verify enrollment & save').click();
    await visible(button(pane, 'Open environment'));
    equal((await callsFor(page, 'environment_register', A.environmentId)).at(-1).args, { environmentId: A.environmentId, endpoint: A.endpoint, label: A.label }, 'Existing enrollment binds the inspected environment and tunnel without bootstrap or implicit retirement');
    equal((await callsFor(page, 'setup_tunnel', A.id)).length, 1, 'Manual registration retry reuses the owned private route');
    await button(pane, 'Disconnect SSH').click();
    await visible(button(pane, 'Reconnect environment'));

    await button(dialogFor(page), 'Close server setup').click();
    await reopen(page);
    await visible(button(pane, 'Reconnect environment'));
    equal((await callsFor(page, 'setup_tunnel', A.id)).length, 1, 'Reopening a disconnected journal never replays a tunnel');
    await button(pane, 'Reconnect environment').click();
    await visible(button(pane, 'Open environment'));
    equal((await callsFor(page, 'setup_tunnel', A.id)).length, 2, 'Explicit reconnect restores the existing route');
    equal((await callsFor(page, 'setup_install')).length, 0, 'Existing connection and reconnection never install');
    equal((await callsFor(page, 'setup_plan')).length, 0, 'Existing connection never prepares an installation plan');
    check((await callsFor(page, 'environment_register')).every(call => !('bootstrapToken' in call.args)), 'Existing enrollment never resets or bootstraps device lists');
    equal((await callsFor(page, 'environment_select')).length, 0, 'Existing connection never switches the global environment');
    equal(await page.evaluate(() => window.__setupFixture.registry.selectedEnvironmentId), null, 'Original active environment remains selected');
  });

  await run('concurrent-isolation', async page => {
    await hold(page, 'setup_inspect', A.id);
    await addServer(page, A, { wait: false });
    await pending(page, 'setup_inspect', A.id);
    await dialogFor(page).getByRole('button', { name: 'Add server', exact: true }).click();
    await fillDraft(page, B);
    const draft = activePane(page), user = draft.getByLabel('SSH username', { exact: true });
    await user.focus();
    await user.evaluate(element => element.setSelectionRange(2, 5));
    await release(page, 'setup_inspect', A.id);
    await observeJournal(page, 1);
    equal(await user.inputValue(), B.user, 'Typing survives a peer inspection and journal update');
    equal(await user.evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd]), [true, 2, 5], 'Peer updates preserve field focus and selection');
    equal(await draft.getByLabel('Server address', { exact: true }).inputValue(), B.host, 'Peer updates do not reset a draft address');
    await scanDraft(page, B); await trustDraft(page, B);
    await hold(page, 'setup_plan', B.id);
    await button(paneFor(page, B), 'Review installation plan').click();
    await pending(page, 'setup_plan', B.id);
    check((await railFor(page, B).innerText()).includes('Preparing installation plan'), 'Busy label belongs to the held server');
    await select(page, A);
    check(!(await railFor(page, A).innerText()).includes('Preparing installation plan'), 'Peer busy state never locks this server');
    await launch(page, A);
    await page.evaluate(id => window.__setupFixture.reject('setup_plan', id, 'Beta plan unavailable; Alpha is unaffected'), B.id);
    await select(page, B);
    await visible(paneFor(page, B).getByRole('alert').filter({ hasText: 'Beta plan unavailable' }));
    await select(page, A);
    equal(await paneFor(page, A).getByRole('alert').count(), 0, 'Command errors stay on their own server');
    await select(page, B);
    // A failed native plan call may leave a journaled plan; refresh it explicitly if the journal has arrived.
    const peer = paneFor(page, B);
    if (await button(peer, 'Refresh plan').count()) {
      await button(peer, 'Refresh plan').click(); await enabled(button(peer, 'Refresh plan'));
    } else await preparePlan(page, B);
    await approve(page, B); await button(peer, 'Authorize & install').click();
    await progress(page, B, 4);
    await progress(page, A, 4);
    const order = await dialogFor(page).locator('[data-setup-id]').evaluateAll(rows => rows.map(row => row.dataset.setupId));
    equal(order, [A.id, B.id], 'Trust replaces drafts in place without reordering the rail');
    const oldA = await snapshot(page, A), oldB = await snapshot(page, B);
    check(oldA.installation.operationId !== oldB.installation.operationId, 'Concurrent servers have distinct operation identities');
    await hold(page, 'setup_list');
    await hold(page, 'setup_install_status', A.id); await hold(page, 'setup_install_status', B.id);
    await select(page, A); await button(paneFor(page, A), 'Check progress').click();
    await select(page, B); await button(peer, 'Check progress').click();
    await pending(page, 'setup_install_status', A.id); await pending(page, 'setup_install_status', B.id); await pending(page, 'setup_list');
    await select(page, A);
    const freshB = await advance(page, B, 6);
    await release(page, 'setup_install_status', B.id, freshB);
    await progress(page, B, 6);
    check(await paneFor(page, B).count() === 0, 'Hidden peer pane is removed from the accessibility tree while its rail advances');
    const freshA = await advance(page, A, 7);
    await release(page, 'setup_list', '', [oldB, freshA]);
    await progress(page, A, 7);
    await release(page, 'setup_install_status', A.id, oldA);
    await enabled(button(paneFor(page, A), 'Check progress'));
    await progress(page, A, 7); await progress(page, B, 6);
    equal(await dialogFor(page).locator('[data-setup-id]').evaluateAll(rows => rows.map(row => row.dataset.setupId)), order, 'Reversed stale journal and interleaved status responses never reorder servers');
    const pane = paneFor(page, A);
    await pane.getByRole('button', { name: /Activity & diagnostics/ }).click();
    const logA = pane.getByLabel(`${A.label} activity log`, { exact: true });
    check((await logA.innerText()).includes('setup-alpha ONLY: 7/12') && !(await logA.innerText()).includes('setup-beta'), 'Visible diagnostics contain only Alpha logs');
    await copyReport(page, A, B);
    const beforeExports = await page.evaluate(() => ({ entries: window.__setupFixture.entries, registry: window.__setupFixture.registry }));
    const railBeforeExport = await dialogFor(page).locator('[data-setup-id]').allTextContents();
    await hold(page, 'setup_export_log', A.id);
    await button(pane, 'Download').click();
    await pending(page, 'setup_export_log', A.id);
    equal((await callsFor(page, 'setup_export_log')).map(call => call.args), [{ id: A.id }], 'Native export sends exactly Alpha’s saved setup ID, never report contents or an operation ID');
    check(await button(pane, 'Saving log…').isDisabled(), 'In-flight native export disables only its own export control');
    await select(page, B);
    await peer.getByRole('button', { name: /Activity & diagnostics/ }).click();
    check((await peer.getByLabel(`${B.label} activity log`, { exact: true }).innerText()).includes('setup-beta ONLY: 6/12') && !(await peer.getByLabel(`${B.label} activity log`, { exact: true }).innerText()).includes('setup-alpha'), 'Switching servers does not mix logs');
    await copyReport(page, B, A);
    check(await button(peer, 'Download').isEnabled(), 'A pending Alpha export leaves Beta’s controls usable');
    await page.evaluate(id => { window.__setupFixture.failures[`setup_export_log:${id}`] = 'Beta log destination is not writable'; }, B.id);
    await button(peer, 'Download').click();
    await visible(peer.getByRole('alert').filter({ hasText: 'Could not save this log: Error: Beta log destination is not writable' }));
    equal((await callsFor(page, 'setup_export_log')).map(call => call.args), [{ id: A.id }, { id: B.id }], 'Failed export is still bound only to Beta’s setup ID');
    await release(page, 'setup_export_log', A.id);
    await observeJournal(page, 1);
    equal((await callsFor(page, 'setup_export_log')).length, 2, 'An export failure is not retried automatically');
    equal(await peer.locator('.saved-log').count(), 0, 'A hidden Alpha export does not display its saved path on Beta');
    check(await peer.getByRole('alert').filter({ hasText: 'Beta log destination is not writable' }).isVisible(), 'Alpha success does not clear Beta’s export error');
    await select(page, A);
    await visible(pane.getByRole('status').filter({ hasText: `Saved log to ${out}/${A.id}.log` }));
    equal(await pane.locator('.saved-log').innerText(), `Saved log to ${out}/${A.id}.log`, 'Native export displays the returned saved path on the originating setup');
    equal(await pane.getByRole('alert').count(), 0, 'Beta’s export failure never leaks into Alpha');
    await select(page, B);
    await page.evaluate(id => { delete window.__setupFixture.failures[`setup_export_log:${id}`]; }, B.id);
    await button(peer, 'Download').click();
    await visible(peer.getByRole('status').filter({ hasText: `Saved log to ${out}/${B.id}.log` }));
    equal(await peer.getByRole('alert').count(), 0, 'An explicit Beta export retry clears only its own failure');
    equal((await callsFor(page, 'setup_export_log')).map(call => call.args), [{ id: A.id }, { id: B.id }, { id: B.id }], 'Every native export and retry contains exactly its own setup ID');
    equal(await page.evaluate(() => ({ entries: window.__setupFixture.entries, registry: window.__setupFixture.registry })), beforeExports, 'Export success, failure and retry leave both setup journals and registry unchanged');
    equal(await dialogFor(page).locator('[data-setup-id]').allTextContents(), railBeforeExport, 'Export does not change either server’s rail status, progress or order');
    await peer.getByRole('button', { name: /Activity & diagnostics/ }).click();
    await select(page, A);
    equal(await pane.locator('.saved-log').innerText(), `Saved log to ${out}/${A.id}.log`, 'Retrying Beta does not replace Alpha’s saved path');
    await pane.getByRole('button', { name: /Activity & diagnostics/ }).click();
    await page.evaluate(({ id, response }) => { window.__setupFixture.responses[`setup_install_status:${id}`] = response; }, { id: A.id, response: freshB });
    await button(pane, 'Check progress').click();
    await visible(pane.getByText('Progress could not be refreshed', { exact: true }));
    check((await pane.innerText()).includes('requested target'), 'A response with another setup ID is rejected');
    await progress(page, A, 7); await progress(page, B, 6);
    await select(page, B);
    equal(await peer.getByText('Progress could not be refreshed', { exact: true }).count(), 0, 'Status errors belong only to the requested server');
    await select(page, A);
    const foreign = structuredClone(freshA);
    foreign.plan.operationId = B.operationId; foreign.installation.operationId = B.operationId;
    await page.evaluate(({ id, response }) => { window.__setupFixture.responses[`setup_install_status:${id}`] = response; }, { id: A.id, response: foreign });
    await button(pane, 'Reconnect & check').click();
    await visible(pane.getByText(/expected operation, environment and release/));
    await page.evaluate(id => { delete window.__setupFixture.responses[`setup_install_status:${id}`]; }, A.id);
    await button(pane, 'Reconnect & check').click();
    await visible(button(pane, 'Check progress'));
    await enabled(button(pane, 'Check progress'));
    await button(pane, 'Continue in background').click();
    await advance(page, A, 8); await advance(page, B, 9);
    await observeJournal(page);
    await reopen(page);
    await progress(page, A, 8); await progress(page, B, 9);
    await page.keyboard.press('Escape');
    await reopen(page);
    equal((await callsFor(page, 'setup_install')).map(call => call.args.id), [A.id, B.id], 'Background progress, Escape and reopening never replay either installation');
    await hold(page, 'setup_install_status', A.id);
    await button(pane, 'Check progress').click(); await pending(page, 'setup_install_status', A.id);
    await button(pane, 'Stop installation…').click();
    await visible(pane.getByRole('group', { name: `Stop installation on ${A.label}?`, exact: true }));
    equal((await callsFor(page, 'setup_install_cancel')).length, 0, 'Showing scoped cancellation confirmation does not stop anything');
    await select(page, B);
    equal(await peer.getByRole('button', { name: 'Stop this installation', exact: true }).count(), 0, 'Alpha cancellation consent does not appear on Beta');
    await select(page, A); await button(pane, 'Keep installing').click();
    equal((await callsFor(page, 'setup_install_cancel')).length, 0, 'Keep installing has no cancellation side effect');
    await button(pane, 'Stop installation…').click(); await button(pane, 'Stop this installation').click();
    await visible(pane.getByRole('heading', { name: 'Installation stopped.', exact: true }));
    await page.evaluate(id => window.__setupFixture.reject('setup_install_status', id, 'Stale pre-cancellation status failure'), A.id);
    await enabled(button(pane, 'Check progress'));
    equal(await pane.getByText(/Stale pre-cancellation status failure/).count(), 0, 'A late status failure cannot poison a newer cancellation command');
    equal((await callsFor(page, 'setup_install_cancel')).map(call => call.args.id), [A.id], 'Cancellation targets only Alpha');
    equal((await callsFor(page, 'setup_disconnect')).length, 0, 'Installation cancellation does not disconnect peer SSH routes');
    await progress(page, A, 8); await progress(page, B, 9);
    equal((await snapshot(page, B)).installation.state, 'running', 'Beta keeps installing after Alpha stops');
    await page.evaluate(() => { window.__setupFixture.journalError = 'Synthetic journal unavailable'; });
    await visible(dialogFor(page).getByRole('alert').filter({ hasText: 'Synthetic journal unavailable' }));
    equal(await dialogFor(page).locator('[data-setup-id]').evaluateAll(rows => rows.map(row => row.dataset.setupId)), order, 'Journal failures preserve both sessions');
    await page.evaluate(() => { window.__setupFixture.journalError = ''; window.__setupFixture.journal = []; });
    await button(dialogFor(page), 'Retry journal').click();
    await dialogFor(page).getByText('Synthetic journal unavailable', { exact: false }).waitFor({ state: 'hidden' });
    equal(await dialogFor(page).locator('[data-setup-id]').evaluateAll(rows => rows.map(row => row.dataset.setupId)), order, 'A partial journal cannot erase sessions');
    await layout(page, 'concurrent-cancelled');
  });

  await run('inspection-cancel', async page => {
    await hold(page, 'setup_inspect', A.id);
    await addServer(page, A, { wait: false });
    await pending(page, 'setup_inspect', A.id);
    const pane = paneFor(page, A);
    await visible(button(pane, 'Cancel inspection'));
    await button(pane, 'Cancel inspection').click();
    equal((await callsFor(page, 'setup_disconnect', A.id)).length, 1, 'Inspection cancellation targets the inspected SSH session');
    await release(page, 'setup_inspect', A.id);
    await visible(pane.getByRole('alert').filter({ hasText: 'This SSH action was cancelled' }));
    await enabled(button(pane, 'Inspect again'));
    await button(pane, 'Inspect again').click();
    await enabled(button(pane, 'Review installation plan'));
    equal(await pane.getByRole('alert').count(), 0, 'An explicit fresh inspection releases the cancelled action lock and clears its error');
    equal((await callsFor(page, 'setup_install')).length, 0, 'Inspection cancellation never installs or authorizes');
  });

  await run('temporary-draft-lifecycle', async page => {
    const modal = dialogFor(page);
    equal(await modal.locator('[data-setup-id]').count(), 0, 'Opening setup does not create a counted blank server');
    await enabled(button(activePane(page), 'Check connection'));
    await modal.locator('.add-server').click();
    equal(await modal.locator('.workspace').filter({ has: page.getByLabel('Server address', { exact: true }) }).count(), 1, 'Repeated Add reuses the temporary form');
    await page.keyboard.press('Escape'); await reopen(page);
    equal(await modal.locator('[data-setup-id]').count(), 0, 'Escape discards the temporary form');
    const draft = activePane(page);
    await draft.getByLabel('Server address', { exact: true }).fill('unsaved.example.test');
    equal(await modal.locator('[data-setup-id]').count(), 1, 'Meaningful input creates an in-memory sidebar draft');
    await button(draft, 'Close').click(); await reopen(page);
    equal(await activePane(page).getByLabel('Server address', { exact: true }).inputValue(), 'unsaved.example.test', 'Edited draft survives modal close');
    await button(activePane(page), 'Discard setup').click();
    const confirmation = modal.getByRole('group', { name: 'Discard this unsaved setup?' });
    await visible(confirmation);
    check(await button(confirmation, 'Keep setup').evaluate(element => document.activeElement === element), 'Discard confirmation focuses the safe choice');
    await button(confirmation, 'Keep setup').click();
    equal(await modal.locator('[data-setup-id]').count(), 1, 'Cancelling discard keeps input');
    await button(activePane(page), 'Discard setup').click(); await button(confirmation, 'Discard setup').click();
    equal(await modal.locator('[data-setup-id]').count(), 0, 'Confirmed discard removes only the unsaved form');
    equal((await callsFor(page, 'setup_trust')).length, 0, 'Draft cleanup never changes host trust');
    equal((await callsFor(page, 'environment_remove')).length, 0, 'Draft cleanup never removes a saved environment');
    await modal.locator('.add-server').click();
    await activePane(page).getByRole('radio', { name: 'A private key on this Mac', exact: true }).check();
    await hold(page, 'setup_choose_identity'); await button(activePane(page), 'Choose SSH key…').click();
    await pending(page, 'setup_choose_identity');
    await button(activePane(page), 'Discard setup').click();
    await button(confirmation, 'Discard setup').click();
    await release(page, 'setup_choose_identity');
    await modal.locator('.add-server').click();
    check(await activePane(page).getByRole('radio', { name: /SSH agent/ }).isChecked(), 'Late native picker cannot alter the replacement draft');
    equal(await modal.locator('[data-setup-id]').count(), 0, 'Late picker cannot resurrect discarded input');
    await layout(page, 'temporary-form');
    await button(modal, 'Connect with a URL').click();
    equal(await modal.locator('.workspace').filter({ has: page.getByLabel('Server address', { exact: true }) }).count(), 0, 'Switching to URL discards the untouched SSH form');
  });

  await run('existing-labels-and-archive', async page => {
    await page.evaluate(({ A, B }) => {
      const fixture = window.__setupFixture;
      for (const [spec, label] of [[A, 'Outpost 1'], [B, 'Outpost 2']]) {
        fixture.entries[spec.id] = { id: spec.id, label, target: { host: spec.host, user: spec.user, port: spec.port, identityFile: null },
          fingerprint: `SHA256:independently-verify-${spec.id}`, phase: 'trusted', inspection: null, recommendation: null, endpoint: null, error: null, log: [] };
      }
      fixture.registry.environments[A.environmentId] = { environmentId: A.environmentId, label: 'Outpost 1', routes: [A.endpoint], activeRoute: A.endpoint };
    }, { A, B });
    await observeJournal(page);
    await button(dialogFor(page), 'Add server').click();
    equal(await activePane(page).getByLabel('Server name', { exact: true }).inputValue(), 'Outpost 3', 'Default name avoids saved and failed/history setup labels');
    equal(await dialogFor(page).locator('[data-setup-id]').count(), 2, 'Temporary third form is not counted beside two real setups');
    await railFor(page, B).click();
    const history = dialogFor(page).locator('.setup-history-actions');
    await enabled(button(history, 'Remove from list…'));
    await button(history, 'Remove from list…').click();
    await visible(history.getByRole('group', { name: 'Remove this setup from the list?' }));
    equal((await callsFor(page, 'setup_history_archive')).length, 0, 'Showing archive confirmation has no side effects');
    await button(history, 'Remove from list').click();
    await railFor(page, B).waitFor({ state: 'hidden' });
    await button(dialogFor(page), 'Close server setup').click(); await reopen(page);
    equal(await railFor(page, B).count(), 0, 'Archived history remains absent on reopen');
    await dialogFor(page).getByRole('button', { name: /^Archived setups/ }).click();
    await visible(button(activePane(page), 'Restore Outpost 2'));
    await button(activePane(page), 'Restore Outpost 2').click();
    await visible(railFor(page, B));
    equal((await callsFor(page, 'setup_history_restore')).map(call => call.args.id), [B.id], 'Restore targets only the archived setup');
    check(await page.evaluate(id => !!window.__setupFixture.registry.environments[id], A.environmentId), 'Peer saved connection survives history cleanup');
    equal((await callsFor(page, 'setup_disconnect')).length, 0, 'History archive does not close SSH routes');
    equal((await callsFor(page, 'environment_remove')).length, 0, 'History archive does not delete connections');
    await layout(page, 'restored-history');
  });

  await run('failure-troubleshooting-evidence', async page => {
    await addServer(page, A); await launch(page, A);
    await advance(page, A, 4, 'failed', 'Setup command failed (exit 1); root-only command.log contains diagnostics');
    const pane = paneFor(page, A), modal = dialogFor(page);
    await visible(button(pane, 'Troubleshoot'));
    equal((await callsFor(page, 'setup_diagnostics')).length, 0, 'Failure does not silently read protected logs');
    await button(pane, 'Troubleshoot').click();
    const troubleshooting = pane.locator('.setup-troubleshooting');
    await visible(troubleshooting.getByRole('heading', { name: 'Troubleshoot this setup.' }));
    await button(troubleshooting, 'Collect server diagnostics').click();
    await visible(troubleshooting.getByRole('heading', { name: 'Evidence & possible causes' }));
    check(await troubleshooting.getByText('Cause not established.', { exact: true }).isVisible(), 'Without command output the UI does not invent a cause');
    equal((await callsFor(page, 'setup_diagnostics')).at(-1).args, { id: A.id, protectedLogs: false, password: false }, 'Ordinary read requests no privilege');
    await button(troubleshooting, 'Read protected logs…').click();
    check(await button(troubleshooting, 'Authorize diagnostic read').isDisabled(), 'Protected read requires separate diagnostic consent');
    await troubleshooting.getByRole('checkbox', { name: /I authorize this protected diagnostic read/ }).check();
    await button(troubleshooting, 'Authorize diagnostic read').click();
    await visible(troubleshooting.getByRole('heading', { name: 'Possible package-manager contention', exact: true }));
    equal((await callsFor(page, 'setup_diagnostics')).at(-1).args, { id: A.id, protectedLogs: true, password: true }, 'Protected authorization carries booleans, never a password');
    await button(troubleshooting, 'Copy report').click();
    await visible(troubleshooting.getByText('Sanitized report copied. Review it before sharing.', { exact: true }));
    const report = await page.evaluate(() => navigator.clipboard.readText());
    check(report.includes(A.operationId) && report.includes('failed-command.log') && report.includes('Could not get lock'), 'Copied evidence includes real operation and preserved failure source');
    check(!report.includes(B.operationId) && !report.includes(B.host), 'Copied diagnostics exclude peer operation');
    await button(troubleshooting, 'Download report').click();
    await visible(troubleshooting.getByText(/Saved sanitized report to/));
    equal(Object.keys((await callsFor(page, 'setup_diagnostics_export')).at(-1).args).sort(), ['id', 'reportId'], 'Export sends snapshot identity only, not path or renderer text');
    await button(troubleshooting, 'Show manual steps').click();
    await visible(troubleshooting.getByRole('heading', { name: 'Read recent installer output', exact: true }));
    check((await troubleshooting.locator('.troubleshooting-guide').innerText()).includes(A.operationId), 'Fallback commands use this exact operation path');
    for (const width of [1440, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await layout(page, `${width}-troubleshooting`);
      for (const name of ['Refresh diagnostics', 'Hide manual steps']) {
        check(await button(troubleshooting, name).evaluate(element => {
          const bounds = element.getBoundingClientRect(), scroll = element.closest('.content-scroll').getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          return bounds.top >= scroll.top && bounds.bottom <= scroll.bottom && (element === hit || element.contains(hit));
        }), `${width}: ${name} is accessible immediately without scrolling`);
      }
    }
    equal((await callsFor(page, 'setup_install')).length, 1, 'Troubleshooting never retries a failed partial installation');
    equal((await callsFor(page, 'setup_install_cancel')).length, 0, 'Collecting diagnostics never cancels installation');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await hold(page, 'setup_diagnostics', A.id);
    await button(troubleshooting, 'Refresh diagnostics').click(); await pending(page, 'setup_diagnostics', A.id);
    await button(modal, 'Close server setup').click(); await reopen(page);
    await visible(button(pane, 'Troubleshoot'));
    await page.waitForFunction(id => window.__setupFixture.calls.some(call => call.command === 'setup_diagnostics_cancel' && call.args.id === id), A.id);
    equal((await callsFor(page, 'setup_install_cancel')).length, 0, 'Closing cancels only the diagnostic read');
    await button(pane, 'Troubleshoot').click();
    equal(await troubleshooting.getByRole('heading', { name: 'Evidence & possible causes' }).count(), 0, 'Closed diagnostic snapshot does not reappear');
    await page.evaluate(id => { window.__setupFixture.failures[`setup_diagnostics:${id}`] = 'Synthetic SSH unavailable'; }, A.id);
    await button(troubleshooting, 'Collect server diagnostics').click();
    await visible(troubleshooting.getByRole('alert').filter({ hasText: 'Synthetic SSH unavailable' }));
    await button(troubleshooting, 'Show manual steps').click();
    await visible(troubleshooting.getByRole('heading', { name: 'Read recent installer output', exact: true }));
    check((await snapshot(page, A)).installation.error.includes('exit 1'), 'Collection error leaves original installation failure unchanged');
  });

  await run('backwards-editing-and-draft-restart', async page => {
    await fillDraft(page, A); await scanDraft(page, A);
    let pane = activePane(page);
    await button(pane, 'Connect, complete').click();
    equal(await pane.getByLabel('Server address', { exact: true }).inputValue(), `[${A.host}]`, 'Back from Verify preserves entered connection details');
    await pane.getByLabel('SSH username', { exact: true }).fill('changed-user');
    check(await button(pane, 'Verify, upcoming').isDisabled(), 'Changing connection invalidates the prior fingerprint stage');
    await pane.getByLabel('SSH username', { exact: true }).fill(A.user);
    await scanDraft(page, A); await trustDraft(page, A);
    await preparePlan(page, A); await approve(page, A);
    pane = paneFor(page, A);
    await button(pane, 'Connect, complete').click();
    await visible(pane.getByRole('heading', { name: 'Review connection details.' }));
    await button(pane, 'Edit connection details').click();
    pane = activePane(page);
    equal(await pane.getByLabel('SSH username', { exact: true }).inputValue(), A.user, 'Editing trusted connection starts a filled draft, not a blank dead end');
    check(await button(pane, 'Verify, upcoming').isDisabled(), 'Edited trusted connection requires a new verified scan');
    equal((await callsFor(page, 'setup_install')).length, 0, 'Back/edit never uses previous plan approval to install');
    await button(pane, 'Restart setup…').click();
    await visible(activePane(page).getByRole('heading', { name: 'Restart this unsaved setup?' }));
    await button(activePane(page), 'Keep setup').click();
    equal(await activePane(page).getByLabel('SSH username', { exact: true }).inputValue(), A.user, 'Declining draft restart preserves input');
    await button(activePane(page), 'Restart setup…').click(); await button(activePane(page), 'Clear form & restart').click();
    equal(await activePane(page).getByLabel('Server address', { exact: true }).inputValue(), '', 'Confirmed draft restart clears input');
    equal((await callsFor(page, 'setup_restart_apply')).length, 0, 'Restarting an unsaved form never removes remote files');
    equal((await callsFor(page, 'setup_trust')).length, 1, 'Back/edit never silently replaces existing host trust');
  });

  await run('active-restart-and-new-consent', async page => {
    await addServer(page, A); await launch(page, A);
    await addServer(page, B); await launch(page, B); await select(page, A);
    let pane = paneFor(page, A);
    await button(pane, 'Restart setup…').click();
    await enabled(button(paneFor(page, A), 'Review restart'));
    await button(paneFor(page, A), 'Review restart').click();
    pane = paneFor(page, A);
    await visible(pane.getByRole('heading', { name: 'Stop installation before removal' }));
    check(await button(pane, 'Stop installation').isDisabled(), 'Active restart requires explicit stop consent');
    equal((await callsFor(page, 'setup_restart_apply')).length, 0, 'Reviewing an active installation never deletes files');
    await pane.getByRole('checkbox', { name: /I request stopping this installation/ }).check();
    await button(pane, 'Stop installation').click();
    await enabled(button(pane, 'Review restart')); await observeJournal(page);
    await button(pane, 'Review restart').click();
    await visible(pane.getByText('Native Outpost data will be permanently erased.', { exact: true }));
    check((await pane.locator('.restart-candidates').innerText()).includes('cancelled'), 'Fresh restart review replaces the old running status after confirmed stop');
    const remove = button(pane, 'Remove native installation & restart');
    check(await remove.isDisabled(), 'Removal requires typed hostname and separate approval');
    const host = pane.getByLabel(`Type ${A.host} to confirm the server`, { exact: true });
    await host.fill(B.host);
    await pane.getByRole('checkbox', { name: /I approve permanently deleting this native Outpost installation/ }).check();
    check(await remove.isDisabled(), 'Typing a peer host cannot authorize this reset');
    await host.fill(A.host); await enabled(remove);
    for (const width of [1440, 900, 390]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `${width}-restart-confirmation`); }
    await remove.click();
    const freshId = `${A.id}-fresh`;
    await page.waitForFunction(id => document.querySelector(`[data-setup-id="${id}"]`)?.getAttribute('aria-current') === 'true', freshId);
    await visible(button(activePane(page), 'Review installation plan'));
    equal((await callsFor(page, 'setup_restart_apply')).length, 1, 'Reset is applied exactly once');
    equal(Object.keys((await callsFor(page, 'setup_restart_apply')).at(-1).args).sort(), ['confirmation', 'id', 'password', 'reviewId'], 'Reset IPC carries no paths, commands or passwords');
    equal((await callsFor(page, 'setup_install')).length, 2, 'Reset completion does not launch a third installation');
    equal((await snapshot(page, B)).installation.state, 'running', 'Peer installation continues during reset');
    const fresh = await page.evaluate(id => window.__setupFixture.specs[id], freshId);
    await preparePlan(page, fresh);
    check(await button(activePane(page), 'Authorize & install').isDisabled(), 'Fresh setup requires fresh installation consent');
    check((await snapshot(page, fresh)).plan.operationId !== A.operationId, 'Restart creates a distinct operation, not a replay');
  });

  await run('blocked-archived-restart-unknown-outcome', async page => {
    await addServer(page, A); await launch(page, A);
    await advance(page, A, 4, 'failed', 'Original browser runtime failure');
    const working = { ...A, id: 'setup-alpha-new', label: 'Current SSH connection' };
    await page.evaluate(({ A, working }) => {
      const fixture = window.__setupFixture;
      fixture.archived.add(A.id);
      fixture.specs[working.id] = { ...fixture.specs[A.id], id: working.id, label: working.label };
      fixture.controls[working.id] = { ...fixture.controls[A.id], recommendation: 'migration_review', inspection: { nativePresent: true }, restartUnknown: true };
      const original = fixture.entries[A.id];
      fixture.entries[working.id] = { ...structuredClone(original), id: working.id, label: working.label,
        target: { ...original.target, user: 'updated-login', identityFile: '/synthetic/private/host-key' }, phase: 'review', plan: null, installation: null, error: null,
        inspection: { ...original.inspection, nativePresent: true }, recommendation: 'migration_review' };
    }, { A, working });
    await observeJournal(page); await select(page, working);
    let pane = paneFor(page, working);
    check(await button(pane, 'Review installation plan').isDisabled(), 'Existing native roots still block blind fresh installation');
    await button(pane, 'Find original setup / Debug').click();
    await enabled(button(paneFor(page, working), 'Review restart'));
    pane = paneFor(page, working);
    equal(await pane.getByRole('alert').count(), 0, 'First open treats the shared native no-pending status as normal, not a restart failure');
    equal((await callsFor(page, 'setup_restart_review')).length, 0, 'No-pending status only finds candidates; it does not authorize a server review');
    equal((await callsFor(page, 'setup_restart_apply')).length, 0, 'Opening restart with no previous reset never starts removal');
    check((await pane.locator('.restart-candidates').innerText()).includes(A.operationId), 'Restart finds the original archived installation receipt');
    await button(pane, 'Review restart').click();
    await visible(pane.getByLabel(`Type ${A.host} to confirm the server`, { exact: true }));
    equal((await callsFor(page, 'setup_restart_review')).at(-1).args.id, working.id, 'Review uses the current working SSH entry');
    equal((await callsFor(page, 'setup_restart_review')).at(-1).args.sourceId, A.id, 'Review is bound to the original archived operation');
    await pane.getByLabel(`Type ${A.host} to confirm the server`, { exact: true }).fill(A.host);
    await pane.getByRole('checkbox', { name: /I approve permanently deleting this native Outpost installation/ }).check();
    await button(pane, 'Remove native installation & restart').click();
    await visible(button(pane, 'Check restart outcome'));
    check((await pane.innerText()).includes('Do not repeat removal'), 'Unknown reset outcome keeps a visible recovery hold');
    await button(dialogFor(page), 'Close server setup').click(); await reopen(page);
    pane = paneFor(page, working);
    await visible(button(pane, 'Check restart outcome'));
    equal((await callsFor(page, 'setup_restart_apply')).length, 1, 'Reopening an unknown reset never repeats removal');
    equal((await callsFor(page, 'setup_install')).length, 1, 'Unknown reset cannot start another install');
    await configure(page, working, { restartStatusComplete: true });
    await button(pane, 'Check restart outcome').click();
    await page.waitForFunction(id => document.querySelector(`[data-setup-id="${id}"]`)?.getAttribute('aria-current') === 'true', `${working.id}-fresh`);
    await visible(button(activePane(page), 'Review installation plan'));
    const fresh = await page.evaluate(id => window.__setupFixture.entries[id], `${working.id}-fresh`);
    equal(fresh.target.user, 'updated-login', 'New setup keeps the working username rather than the archived one');
    equal(fresh.target.identityFile, '/synthetic/private/host-key', 'New setup keeps the verified private key path');
    equal((await callsFor(page, 'setup_restart_apply')).length, 1, 'Status reconciliation is not a second deletion');
    await layout(page, 'restart-reconciled-review');
  });

  await run('restart-auth-errors-and-actionable-blockers', async page => {
    await addServer(page, A); await launch(page, A); await advance(page, A, 4, 'failed', 'Original browser failure');
    await visible(button(paneFor(page, A), 'Restart setup…'));
    await button(paneFor(page, A), 'Restart setup…').click();
    const pane = paneFor(page, A);
    await enabled(button(pane, 'Review restart'));
    for (const [message, title, tone] of [
      ['[localAuthorization:timeout] The native prompt timed out; no cleanup was dispatched.', 'Authorization prompt timed out', 'warning'],
      ['[localAuthorization:processFailure:appleScript] The native prompt failed (code -1743); no cleanup was dispatched.', 'Authorization prompt failed', 'negative'],
      ['[localAuthorization:userCancel] The native prompt reported Cancel; no cleanup was dispatched.', 'Authorization cancelled', 'warning'],
      ['[serverExecution:review] The SSH, sudo or helper stage failed; the exact cause is not confirmed.', 'Server restart review failed', 'negative'],
    ]) {
      await page.evaluate(({ id, message }) => { window.__setupFixture.failures[`setup_restart_review:${id}`] = message; }, { id: A.id, message });
      await button(pane, 'Review restart').click();
      const alert = pane.getByRole('alert');
      await visible(alert.getByText(title, { exact: true }));
      check((await alert.getAttribute('class')).includes(tone), `${title} uses the correct presentation, not a generic server-health failure`);
      check((await alert.innerText()).includes(message), 'Secret-safe native phase and numeric diagnostic remain visible');
      equal(await pane.locator('input[type="password"]').count(), 0, 'The page never collects a sudo password');
      equal((await callsFor(page, 'setup_restart_apply')).length, 0, 'Authorization or review failures never dispatch cleanup');
      await enabled(button(pane, 'Review restart'));
    }
    const attempts = (await callsFor(page, 'setup_restart_review')).length;
    await observeJournal(page);
    equal((await callsFor(page, 'setup_restart_review')).length, attempts, 'Prompt failures are never automatically retried');
    const detail = 'Native path is writable by unexpected identities. path="/opt/outpost-native/releases/host-fixture/python/unexpected-file"; mode=0o100666 uid=993 gid=979';
    await page.evaluate(({ id, detail }) => {
      delete window.__setupFixture.failures[`setup_restart_review:${id}`];
      window.__setupFixture.controls[id].restartBlockers = [detail];
    }, { id: A.id, detail });
    await button(pane, 'Review restart').click();
    const blocked = pane.getByRole('heading', { name: 'Removal blocked', exact: true });
    await visible(blocked);
    check(await blocked.evaluate(element => document.activeElement === element), 'A blocked review focuses the actionable reason');
    check((await pane.locator('.restart-blockers').innerText()).includes(detail), 'Blocker shows the exact escaped path and ownership metadata');
    await visible(button(pane, 'Recheck safety checks'));
    equal(await button(pane, 'Remove native installation & restart').count(), 0, 'Blocked scope exposes no deletion action');
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `${width}-restart-blocker`); }
    await configure(page, A, { restartBlockers: [] });
    await button(pane, 'Recheck safety checks').click();
    await visible(pane.getByLabel(`Type ${A.host} to confirm the server`, { exact: true }));
    equal(await pane.getByLabel(`Type ${A.host} to confirm the server`, { exact: true }).inputValue(), '', 'A newly valid review requires a fresh typed hostname');
    check(!await pane.getByRole('checkbox', { name: /I approve permanently deleting/ }).isChecked(), 'Rechecking does not inherit deletion consent');
    check(await button(pane, 'Remove native installation & restart').isDisabled(), 'Passing checks alone does not authorize deletion');
    equal((await callsFor(page, 'setup_restart_apply')).length, 0, 'The complete error/recovery scenario never deletes anything');
  });

  await run('completed-install-backwards-review', async page => {
    await addServer(page, A); await launch(page, A); await advance(page, A, 10, 'ready');
    let pane = paneFor(page, A);
    await visible(button(pane, 'Connect & finish setup')); await button(pane, 'Connect & finish setup').click();
    await visible(button(pane, 'Open environment'));
    check(await button(pane, 'Restart setup…').isEnabled(), 'Restart remains available at Finish');
    await button(pane, 'Review, complete').click();
    await visible(pane.getByRole('heading', { name: 'Review the executed plan.' }));
    equal(await pane.getByRole('checkbox', { name: /Browser tools/ }).count(), 0, 'Executed choices cannot be silently mutated by backwards navigation');
    await button(pane, 'Edit for a new installation').click();
    await enabled(button(paneFor(page, A), 'Review restart'));
    await button(paneFor(page, A), 'Review restart').click();
    pane = paneFor(page, A);
    await visible(pane.getByText('Native Outpost data will be permanently erased.', { exact: true }));
    check(await button(pane, 'Remove native installation & restart').isDisabled(), 'Finished server reset still requires explicit destructive confirmation');
    equal((await callsFor(page, 'setup_restart_apply')).length, 0, 'Reviewing completed settings performs no reset');
    equal((await callsFor(page, 'setup_install')).length, 1, 'Reviewing old stages performs no new installation');
  });

  await run('advanced-url-connection', async page => {
    equal(await dialogFor(page).locator('[data-setup-id]').count(), 0, 'The untouched SSH form is not a saved setup or sidebar row');
    equal(await page.locator('.environment-settings > .settings-section #add-url').count(), 0, 'The old direct URL form is no longer outside the modal');
    check(await dialogFor(page).getByLabel('Environment URL', { exact: true }).isHidden(), 'Direct URL fields are hidden until that section is selected');
    await button(dialogFor(page), 'Connect with a URL').click();
    const pane = activePane(page);
    await visible(pane.getByRole('heading', { name: 'Connect an existing server', exact: true }));
    await pane.getByLabel('Environment URL', { exact: true }).fill(direct.endpoint);
    await button(pane, 'Discover environment').click();
    await visible(pane.getByText(/Untrusted preview:/));
    equal((await callsFor(page, 'environment_register')).length, 0, 'Untrusted discovery never enrolls or registers');
    await pane.getByLabel('Expected installation UUID', { exact: true }).fill(A.environmentId);
    await pane.getByLabel('New environment label', { exact: true }).fill(direct.label);
    check(await button(pane, 'Verify and adopt enrollment').isDisabled(), 'Expected UUID mismatch blocks URL adoption');
    await pane.getByLabel('Expected installation UUID', { exact: true }).fill(direct.environmentId);
    check(await pane.getByRole('radio', { name: /I already have access/ }).isChecked(), 'URL connection defaults to existing enrollment, not bootstrap');
    await pane.getByRole('radio', { name: /Pair a new installation/ }).check();
    await pane.getByLabel('New installation bootstrap token', { exact: true }).fill('synthetic-not-a-real-token');
    await pane.getByRole('radio', { name: /I already have access/ }).check();
    equal(await pane.locator('input[type=password]').count(), 0, 'Switching back to adoption removes the bootstrap token');
    await page.evaluate(id => { window.__setupFixture.failures[`environment_register:${id}`] = 'URL enrollment not verified'; }, direct.environmentId);
    await button(pane, 'Verify and adopt enrollment').click();
    await visible(pane.getByRole('alert').filter({ hasText: 'URL enrollment not verified' }));
    await observeJournal(page);
    equal((await callsFor(page, 'environment_register', direct.environmentId)).length, 1, 'Failed URL registration is not automatically retried');
    await page.evaluate(id => { delete window.__setupFixture.failures[`environment_register:${id}`]; }, direct.environmentId);
    await button(pane, 'Verify and adopt enrollment').click();
    await page.waitForFunction(id => !!window.__setupFixture.registry.environments[id], direct.environmentId);
    equal((await callsFor(page, 'environment_register', direct.environmentId)).at(-1).args, { environmentId: direct.environmentId, endpoint: direct.endpoint, label: direct.label }, 'URL adoption sends authenticated identity without the discarded bootstrap token');
    equal((await callsFor(page, 'setup_scan')).length, 0, 'Advanced URL connection does not start SSH setup');
    equal((await callsFor(page, 'setup_install')).length, 0, 'Advanced URL connection does not bootstrap an installation');
    equal((await callsFor(page, 'environment_select')).length, 0, 'URL adoption preserves global selection');
    for (const width of [1440, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await dialogFor(page).getByRole('button', { name: 'Add server', exact: true }).click();
      equal(await dialogFor(page).locator('[data-setup-id]').count(), 0, 'Opening an untouched SSH form does not add a counted session');
      const urlControl = button(dialogFor(page), 'Connect with a URL');
      equal(await urlControl.getAttribute('aria-label'), 'Connect with a URL', `${width}: the URL icon retains its accessible name`);
      await urlControl.click();
      await visible(pane.getByRole('heading', { name: 'Connect an existing server', exact: true }));
      await layout(page, `${width}-url`);
    }
  }, { colorScheme: 'light' });
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(`${out}/results.json`, JSON.stringify({ browser: browserName, checks, results }, null, 2));
}
const failures = results.filter(result => !result.passed);
console.log(`${checks} assertions; ${results.length - failures.length}/${results.length} scenarios passed (${browserName}). Artifacts: ${out}`);
if (failures.length) {
  console.error(failures.map(result => `- ${result.name}: ${result.error}`).join('\n'));
  process.exitCode = 1;
}
