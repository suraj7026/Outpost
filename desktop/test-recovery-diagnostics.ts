import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualRecoverySteps, parseRecoveryReport, recoverySummary, type RecoveryReport } from './src/recovery-diagnostics.ts';

const environmentId = 'e75a359a-5291-4e51-82da-e867a29b83d3';
const otherEnvironmentId = '90787a40-9b60-43a4-a3d4-c7b2df042114';
function report(): RecoveryReport {
  return {
    schemaVersion: 1, environmentId, collectedAt: '2026-11-16T10:20:30.123Z',
    release: '0.1.0', platform: 'linux', architecture: 'arm64',
    recovery: { state: 'missing', revision: null }, dispatchEnabled: true,
    maintenance: { state: 'idle', holding: false },
    runtime: { configured: true, hostAdministration: false, hosts: ['server-1'] },
    work: { queuedTasks: 0, unknownActions: 0, unknownOperations: 0, unknownOutbox: 0 },
    findings: [{ code: 'recovery_missing', severity: 'info', summary: 'Legacy dispatch remains enabled.' }],
    agent: { available: true, reason: null },
  };
}
function withoutField(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}
function reject(value: unknown) {
  assert.throws(() => parseRecoveryReport(value, environmentId), /Invalid recovery report/);
}

test('accepts the backend shape and returns independent allowlisted objects', () => {
  const original = report();
  const parsed = parseRecoveryReport(original, environmentId);
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed, original);
  assert.notEqual(parsed.recovery, original.recovery);
  assert.notEqual(parsed.runtime.hosts, original.runtime.hosts);
  assert.notEqual(parsed.findings[0], original.findings[0]);
  parsed.runtime.hosts.push('another-host');
  assert.deepEqual(original.runtime.hosts, ['server-1']);
});

test('requires a UUID and binds non-null expected identities, while legacy null does not invent a binding', () => {
  assert.throws(() => parseRecoveryReport(report(), otherEnvironmentId), /does not match the selected environment/);
  const legacy = parseRecoveryReport({ ...report(), environmentId: otherEnvironmentId }, null);
  assert.equal(legacy.environmentId, otherEnvironmentId);
  assert.equal(Object.hasOwn(legacy, 'bindingVerified'), false);
  for (const value of ['', 'environment-original', 'x'.repeat(36), 'e75a359a-5291-4e51-02da-e867a29b83d3', null, 42]) {
    reject({ ...report(), environmentId: value });
    assert.throws(() => parseRecoveryReport({ ...report(), environmentId: value }, null));
  }
});

test('rejects malformed containers, missing fields at every level and unsupported versions', () => {
  for (const value of [null, undefined, [], '', 1, true, {}, { error: 'secret transport failure' }]) reject(value);
  for (const schemaVersion of [undefined, null, '1', 0, 2]) reject({ ...report(), schemaVersion });
  const original = report();
  for (const field of Object.keys(original)) reject(withoutField(original, field));
  const groups = { recovery: original.recovery, maintenance: original.maintenance, runtime: original.runtime, work: original.work, agent: original.agent };
  for (const [name, group] of Object.entries(groups)) {
    for (const value of [null, [], 1, 'invalid']) reject({ ...original, [name]: value });
    for (const field of Object.keys(group)) reject({ ...original, [name]: withoutField(group, field) });
  }
  for (const field of Object.keys(original.findings[0])) reject({ ...original, findings: [withoutField(original.findings[0], field)] });
});

test('enforces text, host, list and numeric bounds, including sparse arrays', () => {
  const original = report();
  for (const [field, limit] of [['release', 128], ['platform', 32], ['architecture', 32]] satisfies Array<[string, number]>) {
    reject({ ...original, [field]: 'x'.repeat(limit + 1) });
    reject({ ...original, [field]: 3 });
    reject({ ...original, [field]: 'unsafe\u001btext' });
    assert.doesNotThrow(() => parseRecoveryReport({ ...original, [field]: 'x'.repeat(limit) }, environmentId));
  }
  reject({ ...original, maintenance: { ...original.maintenance, state: 'x'.repeat(33) } });
  for (const hosts of [null, {}, new Array(1), Array(33).fill('valid'), [''], ['host name'], ['https://user:secret@host'], ['x'.repeat(129)], [42]])
    reject({ ...original, runtime: { ...original.runtime, hosts } });
  for (const findings of [null, {}, new Array(1), Array(17).fill(original.findings[0]), [null], [{ ...original.findings[0], severity: 'error' }]])
    reject({ ...original, findings });
  for (const [field, limit] of [['code', 80], ['summary', 500]] satisfies Array<[string, number]>)
    reject({ ...original, findings: [{ ...original.findings[0], [field]: 'x'.repeat(limit + 1) }] });
  for (const field of Object.keys(original.work)) {
    for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])
      reject({ ...original, work: { ...original.work, [field]: value } });
  }
  for (const revision of [undefined, -1, 1.1, '1', Infinity, Number.MAX_SAFE_INTEGER + 1])
    reject({ ...original, recovery: { state: 'invalid', revision } });
  assert.doesNotThrow(() => parseRecoveryReport({ ...original, release: null, runtime: { ...original.runtime, hosts: Array(32).fill('h'.repeat(128)) },
    findings: Array(16).fill({ code: 'c'.repeat(80), severity: 'warning', summary: 's'.repeat(500) }),
    work: { queuedTasks: Number.MAX_SAFE_INTEGER, unknownActions: 1, unknownOperations: 2, unknownOutbox: 3 } }, environmentId));
});

test('requires an actual UTC ISO calendar timestamp, not a coercible date', () => {
  for (const collectedAt of [null, 0, '', 'today', '2026-11-16', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+01:00', '2026-01-01T00:00:00', '2026-01-01T00:00:00.' + '1'.repeat(80) + 'Z'])
    reject({ ...report(), collectedAt });
  for (const collectedAt of ['2024-02-29T00:00:00Z', '2026-11-16T10:20Z', '2026-11-16T10:20:30.123456Z'])
    assert.equal(parseRecoveryReport({ ...report(), collectedAt }, environmentId).collectedAt, collectedAt);
});

test('validates every recovery/admission combination and exact blocker precedence', () => {
  const states: Array<RecoveryReport['recovery']['state']> = ['missing', 'held', 'enabled', 'invalid'];
  for (const state of states) for (const holding of [false, true]) for (const configured of [false, true]) {
    const dispatchEnabled = state === 'missing' || state === 'enabled';
    const reason = !dispatchEnabled ? `recovery_${state}` : holding ? 'maintenance_in_progress' : !configured ? 'runtime_not_configured' : null;
    const valid: RecoveryReport = { ...report(), recovery: { state, revision: state === 'missing' ? null : 1 }, dispatchEnabled,
      maintenance: { state: holding ? 'holding' : 'idle', holding }, runtime: { configured, hostAdministration: false, hosts: [] },
      agent: { available: reason === null, reason } };
    assert.deepEqual(parseRecoveryReport(valid, environmentId), valid);
    reject({ ...valid, dispatchEnabled: !dispatchEnabled });
    reject({ ...valid, agent: { ...valid.agent, available: !valid.agent.available } });
    for (const otherReason of [null, 'recovery_held', 'recovery_invalid', 'maintenance_in_progress', 'runtime_not_configured', 'secret transport error']) {
      if (otherReason !== reason) reject({ ...valid, agent: { available: valid.agent.available, reason: otherReason } });
    }
  }
  reject({ ...report(), recovery: { state: 'missing', revision: 1 } });
  for (const revision of [0, null]) reject({ ...report(), recovery: { state: 'enabled', revision } });
  reject({ ...report(), recovery: { state: 'unknown', revision: null } });
  for (const value of ['true', 1, null]) {
    reject({ ...report(), dispatchEnabled: value });
    reject({ ...report(), maintenance: { state: 'idle', holding: value } });
    reject({ ...report(), runtime: { ...report().runtime, configured: value } });
    reject({ ...report(), runtime: { ...report().runtime, hostAdministration: value } });
    reject({ ...report(), agent: { available: value, reason: null } });
  }
});

test('strips arbitrary extras at every level and never echoes untrusted errors', () => {
  const original = report();
  const secret = { error: 'private-transport-secret', token: 'private-transport-secret', raw: { logs: 'private-transport-secret' } };
  const parsed = parseRecoveryReport({ ...original, ...secret,
    recovery: { ...original.recovery, ...secret }, maintenance: { ...original.maintenance, ...secret },
    runtime: { ...original.runtime, ...secret }, work: { ...original.work, ...secret },
    findings: original.findings.map(finding => ({ ...finding, ...secret })), agent: { ...original.agent, ...secret },
  }, environmentId);
  assert.deepEqual(parsed, original);
  assert.doesNotMatch(JSON.stringify(parsed), /private-transport-secret/);
  assert.throws(() => parseRecoveryReport({ ...secret, schemaVersion: 'private-transport-secret' }, environmentId),
    error => error instanceof Error && !error.message.includes('private-transport-secret'));
  assert.throws(() => parseRecoveryReport({ ...original, environmentId: otherEnvironmentId }, 'private-transport-secret'),
    error => error instanceof Error && !error.message.includes('private-transport-secret'));
});

test('summaries describe missing, held, invalid and enabled states without inventing repairs or health', () => {
  const original = report();
  const missing = recoverySummary(original);
  assert.match(missing, /legacy dispatch is enabled/i);
  assert.match(missing, /not an error and requires no repair/i);
  const held: RecoveryReport = { ...original, recovery: { state: 'held', revision: 1 }, dispatchEnabled: false, agent: { available: false, reason: 'recovery_held' } };
  assert.match(recoverySummary(held), /explicitly holds dispatch/);
  assert.match(recoverySummary(held), /does not release the hold/);
  assert.match(recoverySummary({ ...held, recovery: { state: 'invalid', revision: null } }), /invalid; dispatch is blocked/);
  assert.match(recoverySummary({ ...original, recovery: { state: 'enabled', revision: 1 } }), /enabled; this does not confirm runtime or provider health/);
  for (const value of [original, held]) {
    const summary = recoverySummary({ ...value, maintenance: { state: 'holding', holding: true } });
    assert.match(summary, /^Maintenance is holding new investigation tasks\./);
  }
  assert.match(recoverySummary({ ...original, runtime: { ...original.runtime, configured: false } }), /No agent runtime is configured; use manual discovery/);
});

test('manual discovery is deterministic, read-only, concise and never interpolates platform text', () => {
  for (const platform of [null, 'linux', 'darwin', 'macos', 'win32', 'unknown', 'secret; rm -rf /']) {
    const steps = manualRecoverySteps(platform);
    assert.deepEqual(steps, manualRecoverySteps(platform));
    assert.equal(new Set(steps.map(step => step.id)).size, steps.length);
    for (const step of steps) {
      assert.deepEqual(Object.keys(step).sort(), ['command', 'expected', 'id', 'title', 'where']);
      assert.ok(step.id && step.title && step.command && step.where && step.expected);
      assert.ok(step.command.length < 300);
      assert.match(step.where, /manually.*POSIX shell.*server/);
      assert.match(step.where, /Windows.*native OS tools/);
      assert.match(step.expected, /correct unit or installation.*existing troubleshooting UI.*exact reviewed repair commands/);
      assert.doesNotMatch(step.command, /\b(?:sudo|ssh|restart|stop|start|enable|disable|delete|rm|reset|sqlite3|inspect|exec|apply|patch|edit|env|printenv|logs|describe)\b/i);
      assert.doesNotMatch(step.command, /secret|token|password|\/opt\/|\/etc\/|\.service|<[^>]+>|\$\(|`/i);
      if (/\b(?:systemctl|docker|kubectl)\b/.test(step.command)) assert.match(step.command, /^if command -v (?:systemctl|docker|kubectl) /);
    }
    assert.notEqual(steps, manualRecoverySteps(platform));
  }
  assert.deepEqual(manualRecoverySteps('secret; rm -rf /'), manualRecoverySteps(null));
});

test('unknown and Linux discovery cover identity and both systemd scopes without guessed names', () => {
  for (const platform of [null, 'linux']) {
    const steps = manualRecoverySteps(platform);
    assert.equal(steps[0].command, 'uname -s\nhostname');
    const system = steps.find(step => step.id === 'system-services');
    const user = steps.find(step => step.id === 'user-services');
    assert.ok(system && user);
    for (const step of [system, user]) {
      assert.match(step.command, /list-units --all --no-pager --plain 'outpost\*'/);
      assert.match(step.command, /list-unit-files --no-pager --plain 'outpost\*'/);
    }
    assert.match(user.command, /systemctl --user list-units/);
    assert.match(user.command, /systemctl --user list-unit-files/);
  }
});

test('Mac discovery uses OS information and filtered launch labels without environment dumps', () => {
  const steps = manualRecoverySteps('darwin');
  assert.equal(steps[0].command, 'sw_vers\nuname -s\nhostname');
  assert.equal(steps.find(step => step.id === 'launch-services')?.command, 'launchctl list | grep -i outpost');
  assert.ok(!steps.some(step => step.command.includes('systemctl')));
  assert.deepEqual(steps, manualRecoverySteps('macos'));
});

test('Docker exposes only names/status and Kubernetes remains optional with a separate context review', () => {
  const steps = manualRecoverySteps(null);
  const docker = steps.find(step => step.id === 'containers');
  const context = steps.find(step => step.id === 'kubernetes-context');
  const deployments = steps.find(step => step.id === 'kubernetes-deployments');
  assert.ok(docker && context && deployments);
  assert.match(docker.command, /docker ps --all --format '\{\{\.Names\}\}\t\{\{\.Status\}\}'/);
  assert.match(docker.where, /confirm.*context\/daemon belongs to this server/);
  assert.match(context.command, /kubectl config current-context/);
  assert.match(context.expected, /Confirm.*targets this server.*before running the next step/);
  assert.match(deployments.where, /Optional, user-run only, never automatic.*only after confirming.*same server/);
  assert.match(deployments.command, /kubectl config current-context.*kubectl get deployments --all-namespaces/);
  assert.ok(steps.indexOf(context) < steps.indexOf(deployments));
});
