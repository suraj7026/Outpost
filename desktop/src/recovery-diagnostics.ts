export interface RecoveryReport {
  schemaVersion: 1;
  environmentId: string;
  collectedAt: string;
  release: string | null;
  platform: string;
  architecture: string;
  recovery: { state: 'missing' | 'held' | 'enabled' | 'invalid'; revision: number | null };
  dispatchEnabled: boolean;
  maintenance: { state: string; holding: boolean };
  runtime: { configured: boolean; hostAdministration: boolean; hosts: string[] };
  work: { queuedTasks: number; unknownActions: number; unknownOperations: number; unknownOutbox: number };
  findings: Array<{ code: string; severity: 'info' | 'warning'; summary: string }>;
  agent: { available: boolean; reason: string | null };
}

const invalidReport = () => new Error('Invalid recovery report. Use the manual discovery steps.');
const unsafeControls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidReport();
  return value;
}
function isArray(value: unknown): value is unknown[] { return Array.isArray(value); }
function list(value: unknown, limit: number): unknown[] {
  if (!isArray(value) || value.length > limit) throw invalidReport();
  // Array.from also visits holes, so sparse arrays cannot bypass element validation.
  return Array.from(value);
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || unsafeControls.test(value)) throw invalidReport();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidReport();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidReport();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(result)) throw invalidReport();
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== result.slice(0, 10)) throw invalidReport();
  return result;
}

/** A null expected identity accepts legacy reports, but does not verify server binding. */
export function parseRecoveryReport(value: unknown, environmentId: string | null): RecoveryReport {
  const data = record(value);
  if (data.schemaVersion !== 1) throw invalidReport();
  const reportedId = text(data.environmentId, 36);
  if (!uuid.test(reportedId)) throw invalidReport();
  if (environmentId !== null && reportedId !== environmentId)
    throw new Error('Recovery report does not match the selected environment. The response was withheld.');

  const recovery = record(data.recovery), maintenance = record(data.maintenance);
  const runtime = record(data.runtime), work = record(data.work), agent = record(data.agent);
  const state = recovery.state;
  if (state !== 'missing' && state !== 'held' && state !== 'enabled' && state !== 'invalid') throw invalidReport();
  const revision = recovery.revision === null ? null : integer(recovery.revision);
  if ((state === 'missing' && revision !== null) || ((state === 'held' || state === 'enabled') && (revision === null || revision === 0)))
    throw invalidReport();
  const dispatchEnabled = boolean(data.dispatchEnabled), holding = boolean(maintenance.holding);
  const configured = boolean(runtime.configured), available = boolean(agent.available);
  if (dispatchEnabled !== (state === 'missing' || state === 'enabled')) throw invalidReport();
  const reason = agent.reason === null ? null : text(agent.reason, 80);
  const expectedReason = !dispatchEnabled ? `recovery_${state}` : holding ? 'maintenance_in_progress' : !configured ? 'runtime_not_configured' : null;
  if (reason !== expectedReason || available !== (expectedReason === null)) throw invalidReport();

  return {
    schemaVersion: 1, environmentId: reportedId, collectedAt: timestamp(data.collectedAt),
    release: data.release === null ? null : text(data.release, 128),
    platform: text(data.platform, 32), architecture: text(data.architecture, 32),
    recovery: { state, revision }, dispatchEnabled,
    maintenance: { state: text(maintenance.state, 32), holding },
    runtime: {
      configured, hostAdministration: boolean(runtime.hostAdministration),
      hosts: list(runtime.hosts, 32).map(value => {
        const host = text(value, 128);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(host)) throw invalidReport();
        return host;
      }),
    },
    work: {
      queuedTasks: integer(work.queuedTasks), unknownActions: integer(work.unknownActions),
      unknownOperations: integer(work.unknownOperations), unknownOutbox: integer(work.unknownOutbox),
    },
    findings: list(data.findings, 16).map(value => {
      const finding = record(value), severity = finding.severity;
      if (severity !== 'info' && severity !== 'warning') throw invalidReport();
      return { code: text(finding.code, 80), severity, summary: text(finding.summary, 500) };
    }),
    agent: { available, reason },
  };
}

export function recoverySummary(report: RecoveryReport): string {
  const maintenance = report.maintenance.holding ? 'Maintenance is holding new investigation tasks. ' : '';
  let recovery: string;
  switch (report.recovery.state) {
    case 'missing':
      recovery = 'No recovery record exists; legacy dispatch is enabled. Absence alone is not an error and requires no repair.';
      break;
    case 'held':
      recovery = 'Recovery explicitly holds dispatch. Inspection does not release the hold.';
      break;
    case 'invalid':
      recovery = 'The recovery record is invalid; dispatch is blocked safely. Inspect the evidence before considering any repair.';
      break;
    case 'enabled':
      recovery = 'Recovery dispatch is enabled; this does not confirm runtime or provider health.';
      break;
  }
  const runtime = !report.runtime.configured ? ' No agent runtime is configured; use manual discovery.' : '';
  return maintenance + recovery + runtime;
}

export function manualRecoverySteps(platform: string | null): Array<{ id: string; title: string; where: string; command: string; expected: string }> {
  const server = 'Run manually in a POSIX shell on the Outpost server, not on the desktop unless it is the server. On Windows, use native OS tools instead.';
  const followUp = ' Identify the correct unit or installation, then use its existing troubleshooting UI or bring the reviewed output to your agent for exact reviewed repair commands. These steps do not perform repairs.';
  const mac = platform?.toLowerCase() === 'darwin' || platform?.toLowerCase() === 'macos';
  const linux = platform?.toLowerCase() === 'linux';
  const identity = {
    id: 'server-identity', title: mac ? 'Confirm the Mac server' : 'Confirm the server and operating system', where: server,
    command: mac ? 'sw_vers\nuname -s\nhostname' : 'uname -s\nhostname',
    expected: 'Check that the OS and hostname belong to the intended server. Stop if they do not; these names alone do not verify the saved environment binding.' + followUp,
  };
  const services = mac ? [{
    id: 'launch-services', title: 'Discover Outpost launch services', where: server,
    command: "launchctl list | grep -i outpost",
    expected: 'Shows matching labels in the current launch domain. No matches do not prove Outpost is absent from other domains or installations.' + followUp,
  }] : [{
    id: 'system-services', title: linux ? 'Discover system Outpost units' : 'Discover system Outpost units if systemd is available', where: server,
    command: "if command -v systemctl >/dev/null 2>&1; then\n  systemctl list-units --all --no-pager --plain 'outpost*'\n  systemctl list-unit-files --no-pager --plain 'outpost*'\nfi",
    expected: 'Lists loaded and installed matching system units without assuming a service name. Empty output or an unavailable system manager does not prove there is no installation.' + followUp,
  }, {
    id: 'user-services', title: 'Discover user Outpost units', where: server + ' Use the account that owns the installation.',
    command: "if command -v systemctl >/dev/null 2>&1; then\n  systemctl --user list-units --all --no-pager --plain 'outpost*'\n  systemctl --user list-unit-files --no-pager --plain 'outpost*'\nfi",
    expected: 'Lists matching units for the current user only. A missing user session or no matches does not rule out another installation account.' + followUp,
  }];
  return [identity, ...services, {
    id: 'containers', title: 'Optionally discover containers',
    where: server + ' Optional, user-run only: first confirm the selected Docker context/daemon belongs to this server; skip if uncertain.',
    command: "if command -v docker >/dev/null 2>&1; then docker ps --all --format '{{.Names}}\t{{.Status}}'; fi",
    expected: 'Shows container names and status only, not environment variables or credentials. Do not assume a matching name identifies this Outpost installation.' + followUp,
  }, {
    id: 'kubernetes-context', title: 'Optionally check the Kubernetes context',
    where: server + ' Optional, user-run only; never run automatically.',
    command: 'if command -v kubectl >/dev/null 2>&1; then kubectl config current-context; fi',
    expected: 'Shows the configured context name only. Confirm from your deployment records that it targets this server’s Outpost deployment before running the next step. If unset or uncertain, skip Kubernetes discovery.' + followUp,
  }, {
    id: 'kubernetes-deployments', title: 'Optionally discover Kubernetes deployments',
    where: server + ' Optional, user-run only, never automatic: run only after confirming the configured Kubernetes context targets this same server’s deployment. Otherwise skip.',
    command: 'if command -v kubectl >/dev/null 2>&1 && kubectl config current-context >/dev/null 2>&1; then kubectl get deployments --all-namespaces; fi',
    expected: 'Lists deployment names and readiness across namespaces in the confirmed context. This does not establish the cause of a recovery problem or permission to modify a deployment.' + followUp,
  }];
}
