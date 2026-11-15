import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDiagnosticClient, createDiagnosticReadCoordinator, createDiagnosticViewRequests, diagnosticCoverage, diagnosticCoverageFor,
  diagnosticEntryKey, diagnosticFindings, diagnosticFreshness, diagnosticIdentity, diagnosticReceiptKey, diagnosticReportText,
  diagnosticSources, diagnosticSourceCoverage, diagnosticStateContext,
  stoppedInstallSummary, validateDiagnosticGuide, validateDiagnosticReport, type SetupDiagnosticReport,
} from './src/setup-diagnostics.ts';
import type { Entry } from './src/server-setup-state.ts';

const entry = (): Entry => ({ id: 'setup-a', label: 'Server A',
  target: { host: 'a.example.test', user: 'operator', port: 2222, identityFile: null }, fingerprint: 'SHA256:a',
  phase: 'installing', inspection: null, recommendation: null, endpoint: null, error: null, log: ['LOCAL_SECRET_CANARY'],
  installation: { operationId: 'operation-a', environmentId: 'environment-a', releaseId: 'release-a', state: 'failed',
    completedSteps: 4, totalSteps: 12, stage: 'Browser runtime', startedAt: 100, updatedAt: 200,
    error: 'Command exited with code 1', log: ['LOCAL_RECEIPT_CANARY'] } });
const report = (output = 'Command exited with code 1'): SetupDiagnosticReport => ({ schemaVersion: 1, reportId: 'report-a',
  setupId: 'setup-a', operationId: 'operation-a', environmentId: 'environment-a', releaseId: 'release-a',
  stage: 'Browser runtime', state: 'failed', completedSteps: 4, totalSteps: 12, collectedAt: 1000, expiresAt: 5000,
  sources: [{ id: 'command-log', label: 'Latest command output', status: 'available', text: output, truncated: false }],
  notes: ['Legacy command output has no failed-command provenance.'], redacted: true });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('reports must bind all four identities, including legacy entries without a plan', () => {
  assert.equal(validateDiagnosticReport(report(), entry()).reportId, 'report-a');
  for (const field of ['setupId', 'operationId', 'environmentId', 'releaseId'] as const)
    assert.throws(() => validateDiagnosticReport({ ...report(), [field]: 'peer' }, entry()), /do not match/);
  assert.throws(() => diagnosticIdentity({ ...entry(), installation: null }), /No installation/);
  const inconsistent = entry();
  inconsistent.plan = { ...inconsistent.installation!, operationId: 'peer', planId: 'plan', sha256: 'a', size: 10,
    expiresAt: 5000, browser: true, fullControl: false, coexistenceRequired: false, deviceId: 'device', publicKey: 'public', nodeVersion: '24' };
  assert.throws(() => validateDiagnosticReport(report(), inconsistent), /reviewed plan/);
});

test('view identity changes with pinned destination, key, fingerprint or operation, not label', () => {
  const own = entry(), key = diagnosticEntryKey(own);
  assert.equal(diagnosticEntryKey({ ...own, label: 'Renamed' }), key);
  for (const target of [{ ...own.target, host: 'peer' }, { ...own.target, user: 'root' }, { ...own.target, port: 22 }, { ...own.target, identityFile: '/other/key' }])
    assert.notEqual(diagnosticEntryKey({ ...own, target }), key);
  assert.notEqual(diagnosticEntryKey({ ...own, fingerprint: 'peer' }), key);
  assert.notEqual(diagnosticEntryKey({ ...own, installation: { ...own.installation!, releaseId: 'peer' } }), key);
});

test('unknown, legacy, malformed, oversized and unsanitized wire output fails closed', () => {
  for (const value of [null, 'legacy log', [], {}, { ...report(), schemaVersion: 2 }, { ...report(), redacted: undefined },
    { ...report(), completedSteps: 13 }, { ...report(), totalSteps: 0 }, { ...report(), expiresAt: 999 },
    { ...report(), collectedAt: NaN }, { ...report(), expiresAt: Number.MAX_SAFE_INTEGER }, { ...report(), sources: [...report().sources, ...report().sources] },
    { ...report(), sources: [{ ...report().sources[0], status: 'success' }] }, report('\u001b[31msecret'), report('x\u202ey'),
    report('界'.repeat(18000))]) assert.throws(() => validateDiagnosticReport(value, entry()));
  for (const status of ['missing', 'permission_denied', 'unsafe', 'unavailable'] as const)
    assert.equal(validateDiagnosticReport({ ...report(), sources: [{ ...report().sources[0], status }] }, entry()).sources[0].status, status);
  assert.equal(validateDiagnosticReport({ ...report(), redacted: false }, entry()).redacted, false, 'No replacements can still be a sanitized native report');
});

test('4/12 and Browser runtime never diagnose a cause; legacy coverage stays explicit', () => {
  assert.match(stoppedInstallSummary(entry()), /Browser runtime.*4 of 12.*cause is not known/);
  assert.deepEqual(diagnosticFindings(report()), []);
  assert.deepEqual(diagnosticFindings({ ...report(), sources: [], notes: ['No space left on device'] }), []);
  assert.deepEqual(diagnosticFindings(report('ActiveState=inactive\nExecMainStatus=0\nFinished.')), []);
  assert.match(diagnosticCoverage, /not necessarily the failed command/);
  assert.equal(report().state, 'failed');
});

test('deterministic findings require actual available evidence and include read-only interpretation', () => {
  const cases = [
    ['package-lock', 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 42'],
    ['repository', 'E: The repository https://example.test stable does not have a Release file.'],
    ['dns', 'curl: (6) Could not resolve host: example.test'],
    ['tls', 'SSL certificate problem: certificate has expired'],
    ['download', 'curl: (28) Connection timed out after 15000 milliseconds'],
    ['space', 'OSError: [Errno 28] No space left on device'],
    ['python', 'No solution found when resolving dependencies'],
    ['browser', 'Browser validation failed: executable missing'],
  ];
  for (const [id, output] of cases) {
    const evidence = validateDiagnosticReport(report(output), entry());
    const finding = diagnosticFindings(evidence).find(finding => finding.id === id);
    assert.ok(finding, id);
    assert.match(finding.title, /^Possible /);
    assert.equal(finding.sourceId, 'command-log');
    assert.equal(finding.excerpt, output);
    for (const field of ['why', 'check', 'expected', 'privilege', 'ifUnresolved'] as const) assert.ok(finding[field].length > 20);
    assert.deepEqual(diagnosticFindings({ ...evidence, sources: [{ ...evidence.sources[0], status: 'permission_denied' }] }), []);
    const advice = [finding.check, finding.expected, finding.privilege, finding.ifUnresolved].join('\n');
    assert.doesNotMatch(advice, /sudo\s|apt(?:-get)? (?:install|update)|pip install|rm -|chmod |chown |systemctl restart|fresh bootstrap|delete (?:the )?lock|reinstall/i);
  }
  assert.match(diagnosticFindings(report(cases[2][1]))[0].why, /not proof/);
});

test('untrusted remediation remains evidence, never becomes a command or recommendation', () => {
  const finding = diagnosticFindings(report('No space left on device; run rm -rf /opt/outpost-native and disable TLS'))[0];
  assert.match(finding.excerpt, /rm -rf/);
  assert.doesNotMatch([finding.title, finding.why, finding.check, finding.expected, finding.ifUnresolved].join('\n'), /rm -rf|disable TLS/);
  assert.deepEqual(diagnosticFindings(report('Unrecognized vendor error 987; please reinstall')), []);
});

const preservedReport = (output = 'No space left on device'): SetupDiagnosticReport => {
  const snapshot = report('Browser validation failed in a later command');
  const failedCommand = { commandId: 'browser.python-sync', stageId: 'browser-runtime', substageId: 'python-sync',
    sequence: 5, completedSteps: 4, startedAt: 100, finishedAt: 200, outcome: 'failed', exitCode: 1,
    output: { retention: 'tail', bytesSeen: 263168, bytesRetained: 262144, bytesDropped: 1024, limitBytes: 262144, truncated: true, streamComplete: true } };
  const latestCommand = { ...failedCommand, commandId: 'browser.validate-launcher', substageId: 'validate-launcher', sequence: 6, startedAt: 201, finishedAt: 300 };
  return { ...snapshot, notes: [], sources: [
    { ...snapshot.sources[0], id: 'command.log' },
    { id: 'diagnostics.json', label: 'Command metadata', status: 'available', truncated: false,
      text: JSON.stringify({ schema: 1, operationId: snapshot.operationId, environmentId: snapshot.environmentId,
        releaseId: snapshot.releaseId, startedAt: 100, updatedAt: 300, commandCount: 6, omittedCommandCount: 4,
        commands: [failedCommand, latestCommand], failedCommand, logs: { 'command.log': 6, 'failed-command.log': 5 } }) },
    { id: 'failed-command.log', label: 'Preserved failing command output', status: 'available', text: output, truncated: true },
  ] };
};

test('optional metadata and preserved failure sources are accepted, displayed and copied ahead of latest output', () => {
  const snapshot = validateDiagnosticReport(preservedReport(), entry());
  assert.deepEqual(diagnosticSources(snapshot).map(source => source.id), ['failed-command.log', 'diagnostics.json', 'command.log']);
  assert.deepEqual(snapshot.sources.map(source => source.id), ['command.log', 'diagnostics.json', 'failed-command.log'], 'Native snapshot is not mutated');
  const copied = diagnosticReportText(snapshot);
  assert.ok(copied.indexOf('[failed-command.log]') < copied.indexOf('[command.log]'));
  assert.match(copied, /browser.python-sync/);
  assert.match(copied, /\[diagnostics.json\]/);
  assert.match(diagnosticCoverageFor(snapshot), /preserved failed-command\.log/i);
  assert.match(diagnosticSourceCoverage(snapshot.sources[1]), /metadata/i);
  assert.doesNotMatch(diagnosticSourceCoverage(snapshot.sources[1]), /bounded tail/i);
});

test('preserved failure evidence takes precedence independent of source order and later command signatures', () => {
  for (const sources of [preservedReport().sources, [...preservedReport().sources].reverse()]) {
    const findings = diagnosticFindings({ ...preservedReport(), sources });
    assert.deepEqual(findings.map(finding => finding.id), ['space'], 'Later browser failure must not be promoted to this failure’s cause');
    assert.equal(findings[0].sourceId, 'failed-command.log');
  }
  const sameSignature = preservedReport('Browser validation failed in the preserved command');
  assert.equal(diagnosticFindings(sameSignature)[0].excerpt, 'Browser validation failed in the preserved command');
  for (const output of ['', 'Unrecognized command error', 'Exit status 1'])
    assert.deepEqual(diagnosticFindings(preservedReport(output)), [], 'Unknown preserved output must not borrow a later command’s diagnosis');
});

test('legacy, missing, denied and unsafe optional sources retain an honest latest-output fallback', () => {
  for (const status of ['missing', 'permission_denied', 'unsafe', 'unavailable'] as const) {
    const snapshot = preservedReport();
    snapshot.sources = snapshot.sources.map(source => source.id === 'command.log' ? source : { ...source, status, text: '' });
    const validated = validateDiagnosticReport(snapshot, entry());
    assert.deepEqual(diagnosticFindings(validated).map(finding => finding.sourceId), ['command.log']);
    assert.match(diagnosticCoverageFor(validated), /not necessarily the failed command/);
    assert.doesNotMatch(diagnosticReportText(validated), /browser.python-sync/);
  }
  const legacy = validateDiagnosticReport(report('No space left on device'), entry());
  assert.equal(diagnosticFindings(legacy)[0].sourceId, 'command-log');
  assert.match(diagnosticCoverageFor(legacy), /not necessarily the failed command/);
  assert.doesNotMatch(diagnosticReportText(legacy), /browser.python-sync|browser.validate-launcher/);
});

test('command metadata never triggers output recognition or invents a command from the Browser runtime stage', () => {
  const snapshot = preservedReport();
  snapshot.sources = [{ ...snapshot.sources[1], text: '{"schema":1,"stageId":"Browser validation failed","failedCommand":null}' }];
  assert.deepEqual(diagnosticFindings(snapshot), []);
  assert.doesNotMatch(diagnosticCoverageFor(snapshot), /browser\.validate-launcher|browser\.python-sync/);
  assert.deepEqual(diagnosticFindings({ ...snapshot, sources: [] }), []);
});

test('diagnostic client uses the native Tauri camelCase arguments and only setup/report IDs for export', async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const client = createDiagnosticClient((command, args) => {
    calls.push({ command, args });
    return Promise.reject(new Error('Synthetic native boundary'));
  });
  for (const action of [() => client.read('setup-a', false, true), () => client.read('setup-a', true, true),
    () => client.cancel('setup-a'), () => client.guide('setup-a'), () => client.exportReport('setup-a', 'report-a')])
    await assert.rejects(action(), /Synthetic native boundary/);
  assert.deepEqual(calls, [
    { command: 'setup_diagnostics', args: { id: 'setup-a', protectedLogs: false, password: false } },
    { command: 'setup_diagnostics', args: { id: 'setup-a', protectedLogs: true, password: true } },
    { command: 'setup_diagnostics_cancel', args: { id: 'setup-a' } },
    { command: 'setup_diagnostic_guide', args: { id: 'setup-a' } },
    { command: 'setup_diagnostics_export', args: { id: 'setup-a', reportId: 'report-a' } },
  ]);
});

const interruptedEntry = (): Entry => {
  const own = entry();
  return { ...own, phase: 'installation_stopped', installation: { ...own.installation!, state: 'interrupted',
    error: 'The setup service is no longer running. Partial changes may exist. Inspect this operation before recovery; it was not restarted.' } };
};

test('fresh raw running/queued receipts remain shareable for an unchanged inferred interruption without changing installation state', () => {
  for (const state of ['running', 'queued']) {
    const own = interruptedEntry(), before = structuredClone(own), receipt = diagnosticReceiptKey(own);
    const raw = validateDiagnosticReport({ ...report(), state }, own);
    assert.equal(diagnosticFreshness(raw, own, receipt, 2000), 'current', `${state} is raw disk evidence, not a different app-status revision`);
    assert.equal(diagnosticFreshness(raw, own, receipt, 5000), 'expired', 'The narrow mismatch exception must not bypass expiry');
    assert.equal(raw.state, state, 'Do not rewrite the native diagnostic snapshot');
    assert.deepEqual(own, before, 'Shareable diagnostics must not mark the installation active or resume it');
  }
});

test('inferred-interruption exception never bypasses genuine captured receipt changes', () => {
  const own = interruptedEntry(), receipt = diagnosticReceiptKey(own);
  for (const state of ['running', 'queued']) {
    const raw = validateDiagnosticReport({ ...report(), state }, own);
    const revisions = [
      { updatedAt: 201 }, { updatedAt: 199 }, { state }, { state: 'failed' }, { error: 'New installation evidence' },
      { stage: 'Server dependencies' }, { completedSteps: 3 }, { completedSteps: 5 }, { totalSteps: 13 },
    ];
    for (const patch of revisions) {
      const changed = { ...own, installation: { ...own.installation!, ...patch } };
      assert.equal(diagnosticFreshness(raw, changed, receipt, 2000), 'stale', JSON.stringify(patch));
    }
  }
});

test('only the same-stage/count interrupted versus running/queued mismatch is accepted', () => {
  const own = interruptedEntry(), receipt = diagnosticReceiptKey(own);
  for (const state of ['running', 'queued']) {
    for (const patch of [{ stage: 'Preflight' }, { completedSteps: 3 }, { completedSteps: 5 }, { totalSteps: 13 }])
      assert.equal(diagnosticFreshness({ ...report(), state, ...patch }, own, receipt, 2000), 'stale', `${state}: ${JSON.stringify(patch)}`);
    for (const appState of ['failed', 'cancelled', 'unknown', 'authorizing', 'ready', 'complete']) {
      const other = { ...own, installation: { ...own.installation!, state: appState } };
      assert.equal(diagnosticFreshness({ ...report(), state }, other, diagnosticReceiptKey(other), 2000), 'stale', appState);
    }
  }
  for (const state of ['failed', 'cancelled', 'unknown', 'ready', 'complete'])
    assert.equal(diagnosticFreshness({ ...report(), state }, own, receipt, 2000), 'stale', `Do not generalize the exception to a raw ${state} receipt`);
  assert.equal(diagnosticFreshness({ ...report(), completedSteps: 3 }, entry(), diagnosticReceiptKey(entry()), 2000), 'stale', 'Older failed steps remain stale');
});

test('UI context and copied reports distinguish raw receipt state from the app’s interrupted assessment', () => {
  const own = interruptedEntry();
  for (const state of ['running', 'queued']) {
    const snapshot = validateDiagnosticReport({ ...report(), state }, own);
    const explanation = diagnosticStateContext(snapshot, own), copied = diagnosticReportText(snapshot);
    assert.match(explanation, /saved status is interrupted/);
    assert.match(explanation, /setup-service check can infer interruption without rewriting/);
    assert.ok(explanation.includes(`still records ${state}`));
    assert.match(explanation, /not proof that installation is active or has resumed/);
    assert.ok(copied.includes(`Raw server receipt: ${state}`));
    assert.match(copied, /not proof that installation is active or has resumed/);
    assert.doesNotMatch(copied, /Observed:|LOCAL_SECRET_CANARY|LOCAL_RECEIPT_CANARY/);
    assert.equal(own.installation?.state, 'interrupted');
  }
  assert.doesNotMatch(diagnosticStateContext(report(), entry()), /saved status is interrupted/);
});

test('freshness uses receipt revision rather than comparing server and Mac clocks; expiry disables sharing', () => {
  const own = entry(), receipt = diagnosticReceiptKey(own), snapshot = report();
  assert.equal(diagnosticFreshness(snapshot, own, receipt, 2000), 'current');
  assert.equal(diagnosticFreshness(snapshot, own, receipt, 5000), 'expired');
  assert.equal(diagnosticFreshness(snapshot, { ...own, installation: { ...own.installation!, updatedAt: 201 } }, receipt, 2000), 'stale');
  assert.equal(diagnosticFreshness({ ...snapshot, state: 'running' }, own, receipt, 2000), 'stale');
});

test('clipboard formatting includes only validated sanitized native fields and sharing limitations', () => {
  const parsed = validateDiagnosticReport({ ...report('password=[REDACTED]'), secret: 'EXTRA_CANARY', target: entry().target }, entry());
  const copied = diagnosticReportText(parsed);
  assert.match(copied, /password=\[REDACTED\]/);
  assert.match(copied, /Review before sharing/);
  assert.match(copied, /never uploaded automatically/);
  assert.match(copied, /Legacy command.log/);
  assert.match(copied, /Operation: operation-a/);
  assert.doesNotMatch(copied, /LOCAL_SECRET_CANARY|LOCAL_RECEIPT_CANARY|EXTRA_CANARY|a.example.test/);
});

test('manual steps preserve native commands and reject malformed or foreign fingerprint results', () => {
  const own = entry();
  const guide = { destination: 'operator@a.example.test:2222', fingerprint: own.fingerprint,
    steps: [{ id: 'ssh', title: 'Connect', command: 'ssh -o StrictHostKeyChecking=yes -p 2222 operator@a.example.test', detail: 'Compare the pinned fingerprint.', privileged: false, runOn: 'mac' },
      { id: 'receipt', title: 'Read receipt', command: "cat '/var/lib/outpost-setup/operations/operation-a/status.json'", detail: 'Read this operation only.', privileged: false, runOn: 'server' }] };
  assert.deepEqual(validateDiagnosticGuide(guide, own), guide);
  const ipv6 = { ...own, target: { ...own.target, host: '2001:db8::10' } };
  for (const destination of ['operator@2001:db8::10:2222', 'operator@[2001:db8::10]:2222'])
    assert.equal(validateDiagnosticGuide({ ...guide, destination }, ipv6).destination, destination);
  for (const value of [{ ...guide, fingerprint: 'peer' }, { ...guide, destination: 'operator@b.example.test:2222' },
    { ...guide, steps: [] }, { ...guide, steps: [guide.steps[1]] },
    { ...guide, steps: [{ ...guide.steps[0], command: '' }] }, { ...guide, steps: [{ ...guide.steps[0], runOn: 'remote' }] }])
    assert.throws(() => validateDiagnosticGuide(value, own));
});

test('closing, switching and cancelling invalidate late view results without invalidating a peer', () => {
  const own = createDiagnosticViewRequests(), peer = createDiagnosticViewRequests();
  const lateRead = own.capture(), lateGuide = own.capture(), lateExport = own.capture(), peerRead = peer.capture();
  own.invalidate();
  for (const ticket of [lateRead, lateGuide, lateExport]) assert.equal(own.current(ticket), false);
  assert.equal(peer.current(peerRead), true);
  assert.equal(own.current(own.capture()), true);
});

test('read cancellation is scoped, idempotent and holds its target until read and acknowledgement settle', async () => {
  const a = deferred<unknown>(), b = deferred<unknown>(), cancelled = deferred<void>();
  const calls: unknown[] = [];
  const coordinator = createDiagnosticReadCoordinator({
    read: (id, protectedLogs, password) => { calls.push(['read', id, protectedLogs, password]); return id === 'a' ? a.promise : b.promise; },
    cancel: id => { calls.push(['cancel', id]); return cancelled.promise; },
  });
  const first = coordinator.read('a', false, true), peer = coordinator.read('b', true, true);
  const cancellation = coordinator.cancel('a');
  assert.equal(coordinator.cancel('a'), cancellation);
  a.resolve(report());
  await assert.rejects(coordinator.read('a', true, true), /previous diagnostic read/);
  b.resolve(report()); await peer;
  cancelled.resolve(); await cancellation; await first;
  await coordinator.read('a', false, false);
  assert.deepEqual(calls, [['read', 'a', false, false], ['read', 'b', true, true], ['cancel', 'a'], ['read', 'a', false, false]]);
});

test('read errors release their own target and cancellation never invokes an installation operation', async () => {
  const calls: string[] = [];
  const coordinator = createDiagnosticReadCoordinator({ read: async id => { calls.push(`read:${id}`); throw new Error('SSH unavailable'); },
    cancel: async id => { calls.push(`cancel:${id}`); } });
  await coordinator.cancel('missing');
  await assert.rejects(coordinator.read('a', false, false), /SSH unavailable/);
  await assert.rejects(coordinator.read('a', false, false), /SSH unavailable/);
  assert.deepEqual(calls, ['read:a', 'read:a']);
});
