import type { Entry } from './server-setup-state';

export type DiagnosticSourceStatus = 'available' | 'missing' | 'permission_denied' | 'unsafe' | 'unavailable';
export interface DiagnosticSource {
  id: string; label: string; status: DiagnosticSourceStatus; text: string; truncated: boolean;
}
export interface DiagnosticIdentity {
  setupId: string; operationId: string; environmentId: string; releaseId: string;
}
export interface SetupDiagnosticReport extends DiagnosticIdentity {
  schemaVersion: 1; reportId: string; stage: string; state: string;
  completedSteps: number; totalSteps: number; collectedAt: number; expiresAt: number;
  sources: DiagnosticSource[]; notes: string[]; redacted: boolean;
}
export interface DiagnosticGuide {
  destination: string; fingerprint: string;
  steps: { id: string; title: string; command: string; detail: string; privileged: boolean; runOn: 'mac' | 'server' }[];
}
export interface DiagnosticFinding {
  id: string; title: string; why: string; sourceId: string; sourceLabel: string; excerpt: string;
  check: string; expected: string; privilege: string; ifUnresolved: string;
}

const maxReportBytes = 48 * 1024;
const sourceStatuses = new Set<unknown>(['available', 'missing', 'permission_denied', 'unsafe', 'unavailable']);
const unsafeControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported diagnostic response. Use the manual troubleshooting steps.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, limit = maxReportBytes): string => {
  if (typeof value !== 'string' || value.length > limit || unsafeControls.test(value)) throw new Error('Invalid or unsanitized diagnostic text was withheld.');
  return value;
};
const identifier = (value: unknown): string => {
  const result = text(value, 512);
  if (!result.trim() || /[\r\n\t]/u.test(result)) throw new Error('Missing or invalid diagnostic identity.');
  return result;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid diagnostic count or timestamp.');
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid diagnostic privacy or coverage metadata.');
  return value;
};
function bounded(value: unknown, maxBytes: number) {
  const encoded = JSON.stringify(value);
  if (!encoded || new TextEncoder().encode(encoded).length > maxBytes) throw new Error('Oversized diagnostic response was withheld. Use the manual steps.');
}

export function diagnosticIdentity(entry: Entry): DiagnosticIdentity {
  const operation = entry.installation;
  if (!operation) throw new Error('No installation operation is saved for this setup.');
  const identity = { setupId: identifier(entry.id), operationId: identifier(operation.operationId),
    environmentId: identifier(operation.environmentId), releaseId: identifier(operation.releaseId) };
  if (entry.plan && (entry.plan.operationId !== identity.operationId || entry.plan.environmentId !== identity.environmentId
    || entry.plan.releaseId !== identity.releaseId)) throw new Error('The saved receipt does not match its reviewed plan.');
  return identity;
}

/** Includes pinned target identity, never the editable display label. */
export function diagnosticEntryKey(entry: Entry): string {
  return JSON.stringify([entry.id, entry.target.host, entry.target.user, entry.target.port, entry.target.identityFile,
    entry.fingerprint, entry.installation?.operationId, entry.installation?.environmentId, entry.installation?.releaseId,
    entry.plan?.planId, entry.plan?.operationId, entry.plan?.environmentId, entry.plan?.releaseId]);
}

export function diagnosticReceiptKey(entry: Entry): string {
  const progress = entry.installation;
  return JSON.stringify([progress?.updatedAt, progress?.state, progress?.stage, progress?.completedSteps, progress?.totalSteps, progress?.error]);
}

export function validateDiagnosticReport(value: unknown, entry: Entry): SetupDiagnosticReport {
  bounded(value, maxReportBytes);
  const data = record(value), expected = diagnosticIdentity(entry);
  if (data.schemaVersion !== 1) throw new Error('This diagnostic format is not supported. Use the manual troubleshooting steps.');
  for (const field of ['setupId', 'operationId', 'environmentId', 'releaseId'] as const) {
    if (data[field] !== expected[field]) throw new Error('Diagnostics do not match this setup, operation, environment and release. The response was withheld.');
  }
  const completedSteps = integer(data.completedSteps), totalSteps = integer(data.totalSteps);
  const collectedAt = integer(data.collectedAt), expiresAt = integer(data.expiresAt);
  if (totalSteps < 1 || completedSteps > totalSteps || totalSteps !== entry.installation?.totalSteps || expiresAt <= collectedAt
    || expiresAt > 8_640_000_000_000_000)
    throw new Error('Invalid diagnostic progress or expiry.');
  if (!Array.isArray(data.sources) || data.sources.length > 32 || !Array.isArray(data.notes) || data.notes.length > 64)
    throw new Error('Invalid diagnostic evidence list.');
  const ids = new Set<string>();
  const sources = data.sources.map((value: unknown): DiagnosticSource => {
    const source = record(value), id = identifier(source.id);
    if (ids.has(id) || !sourceStatuses.has(source.status)) throw new Error('Invalid or duplicate diagnostic source.');
    ids.add(id);
    return { id, label: identifier(source.label), status: source.status as DiagnosticSourceStatus,
      text: text(source.text), truncated: boolean(source.truncated) };
  });
  return { ...expected, schemaVersion: 1, reportId: identifier(data.reportId), stage: text(data.stage, 512), state: identifier(data.state),
    completedSteps, totalSteps, collectedAt, expiresAt, sources, notes: data.notes.map(note => text(note, 4096)), redacted: boolean(data.redacted) };
}

export function validateDiagnosticGuide(value: unknown, entry: Entry): DiagnosticGuide {
  diagnosticIdentity(entry);
  bounded(value, 48 * 1024);
  const data = record(value);
  if (data.fingerprint !== entry.fingerprint || !entry.fingerprint) throw new Error('The guide does not match this setup’s pinned SSH fingerprint.');
  const destination = identifier(data.destination), { user, host, port } = entry.target;
  if (![`${user}@${host}:${port}`, `${user}@${host.includes(':') ? `[${host}]` : host}:${port}`].includes(destination))
    throw new Error('The manual guide does not match this setup’s saved SSH destination.');
  if (!Array.isArray(data.steps) || !data.steps.length || data.steps.length > 24) throw new Error('No supported manual steps are available.');
  const ids = new Set<string>();
  const steps = data.steps.map((value: unknown): DiagnosticGuide['steps'][number] => {
    const step = record(value), id = identifier(step.id);
    if (ids.has(id) || !['mac', 'server'].includes(String(step.runOn))) throw new Error('Invalid manual troubleshooting step.');
    ids.add(id);
    const command = text(step.command, 8192);
    if (!command.trim()) throw new Error('A manual command is missing.');
    return { id, title: identifier(step.title), command, detail: text(step.detail, 8192),
      privileged: boolean(step.privileged), runOn: step.runOn as 'mac' | 'server' };
  });
  if (steps[0].runOn !== 'mac') throw new Error('The guide is missing its pinned SSH connection step.');
  // Commands are authored and target-validated natively, never composed from log excerpts here.
  return { destination, fingerprint: identifier(data.fingerprint), steps };
}

function isInferredInterruption(report: SetupDiagnosticReport, entry: Entry): boolean {
  return entry.installation?.state === 'interrupted' && (report.state === 'running' || report.state === 'queued');
}

export function diagnosticFreshness(report: SetupDiagnosticReport, entry: Entry, receiptAtCollection: string, now: number): 'current' | 'stale' | 'expired' {
  if (now >= report.expiresAt) return 'expired';
  const progress = entry.installation;
  if (!progress || diagnosticReceiptKey(entry) !== receiptAtCollection || progress.stage !== report.stage
    || progress.completedSteps !== report.completedSteps || progress.totalSteps !== report.totalSteps) return 'stale';
  // Native validates the raw receipt timestamp. Its service check can infer interruption without
  // rewriting that receipt; allow only this state mismatch, never a changed view revision or progress.
  return progress.state === report.state || isInferredInterruption(report, entry) ? 'current' : 'stale';
}

export const diagnosticReceiptStateNotice = 'The raw server receipt is stored evidence, not proof that installation is active or has resumed.';
export function diagnosticStateContext(report: SetupDiagnosticReport, entry: Entry): string {
  const distinction = isInferredInterruption(report, entry)
    ? `Outpost’s saved status is interrupted. The setup-service check can infer interruption without rewriting the on-disk receipt, which still records ${report.state}. ` : '';
  return distinction + diagnosticReceiptStateNotice;
}

export function stoppedInstallSummary(entry: Entry): string {
  const progress = entry.installation;
  if (!progress) return 'No installation receipt is available.';
  return `${progress.stage || 'Installation'} setup ${progress.state === 'cancelled' ? 'was cancelled' : progress.state === 'interrupted' ? 'was interrupted' : 'stopped'} after ${progress.completedSteps} of ${progress.totalSteps} checks. Command output has not been collected in this view, so the underlying cause is not known yet.`;
}

export const diagnosticCoverage = 'Legacy command.log contains only the latest command output, not necessarily the failed command or the full installation history. A stage name, exit code or successful service status alone does not establish the cause.';
export const diagnosticSharingNotice = 'Review before sharing: redaction cannot guarantee every secret is removed. Reports are never uploaded automatically.';
export const diagnosticSourceLabels: Record<DiagnosticSourceStatus, string> = {
  available: 'Available', missing: 'Missing — not proof of success', permission_denied: 'Permission denied — protected read may help',
  unsafe: 'Unsafe path — read refused', unavailable: 'Unavailable — no evidence collected',
};

const preservedFailureSource = (report: SetupDiagnosticReport) => report.sources.find(source => source.id === 'failed-command.log' && source.status === 'available');

export function diagnosticSources(report: SetupDiagnosticReport): DiagnosticSource[] {
  const priority = (source: DiagnosticSource) => source.id === 'failed-command.log' ? 0 : source.id === 'diagnostics.json' ? 1 : 2;
  return [...report.sources].sort((left, right) => priority(left) - priority(right));
}

export function diagnosticCoverageFor(report: SetupDiagnosticReport): string {
  const preserved = preservedFailureSource(report);
  const metadata = report.sources.some(source => source.id === 'diagnostics.json' && source.status === 'available');
  return [preserved
    ? 'Findings use preserved failed-command.log output, not later command.log output. An empty or unrecognized preserved excerpt does not establish a cause; other sources remain available as context.'
    : 'No available preserved failure output was returned. Findings from other sources may lack failed-command attribution.',
  metadata ? 'Recorded command metadata is available in diagnostics.json; command identifiers are not inferred from the stage.'
    : 'Command metadata is not available; no exact command is inferred from the stage.', diagnosticCoverage].join(' ');
}

export function diagnosticSourceCoverage(source: DiagnosticSource): string {
  if (source.status !== 'available') return 'No readable evidence was returned for this source. Its status does not establish a cause or a successful installation.';
  if (source.id === 'diagnostics.json') return 'Versioned command metadata, validated and sanitized by native collection; not command output or executable instructions. '
    + (source.truncated ? 'This metadata excerpt was truncated; inspect its coverage limits.' : 'Only recorded metadata is available, not a guarantee of complete history.');
  const provenance = source.id === 'failed-command.log' ? 'Preserved failing-command output, rather than the latest command’s output. ' : '';
  return provenance + (source.truncated ? 'Only a bounded tail is available; earlier output was omitted.'
    : 'Not marked truncated; this is not a guarantee of complete command history.');
}

type FindingRule = Omit<DiagnosticFinding, 'sourceId' | 'sourceLabel' | 'excerpt'> & { pattern: RegExp };
const findingRules: FindingRule[] = [
  { id: 'package-lock', title: 'Possible package-manager contention', pattern: /(?:could not get lock.*(?:dpkg|apt)|unable to acquire.*(?:dpkg|apt).*lock|(?:dpkg|apt).*lock.*held by process)/i,
    why: 'The output reports a package-manager lock; it does not identify whether its owner is still active.',
    check: 'Ask the administrator to inspect the lock-owning process and current package activity without changing it.',
    expected: 'A live package process may explain contention. No owner or incomplete evidence needs administrator review.',
    privilege: 'Server administrator may be needed to inspect other users’ processes.', ifUnresolved: 'Share this excerpt and the operation receipt with the administrator; preserve the lock and partial files.' },
  { id: 'repository', title: 'Possible package repository problem', pattern: /(?:repository .* does not have a Release file|NO_PUBKEY\s+\S+|(?:repository|InRelease).*not signed|failed to fetch\s+https?:\/\/)/i,
    why: 'Repository retrieval or verification failed in this excerpt, but its underlying cause is not established.',
    check: 'Have the administrator review the configured repository, reported HTTP status and signing-key identity read-only.',
    expected: 'The repository should match the supported OS release and have a valid signature. A fetch error alone does not prove the host is offline.',
    privilege: 'Usually readable by the SSH user; protected configuration requires an administrator.', ifUnresolved: 'Provide the repository error to the administrator without bypassing signature verification.' },
  { id: 'dns', title: 'Possible name-resolution failure', pattern: /(?:temporary failure in name resolution|could not resolve (?:host|hostname)|getaddrinfo.*(?:EAI_AGAIN|ENOTFOUND)|name or service not known)/i,
    why: 'A lookup error appears in the output; this is not proof that all network access is unavailable.',
    check: 'Ask the administrator to compare the named host with the expected download destination and inspect the server’s resolver state.',
    expected: 'The expected hostname should resolve on this server. A lookup failure may be specific to that name or temporary.',
    privilege: 'Read-only resolver checks normally use the SSH account.', ifUnresolved: 'Share the destination and timestamp with the network administrator; keep host verification enabled.' },
  { id: 'tls', title: 'Possible TLS verification failure', pattern: /(?:CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSL certificate problem|certificate has expired|unable to get local issuer certificate)/i,
    why: 'The excerpt reports certificate validation failure, not a confirmed cause in Outpost itself.',
    check: 'Ask the administrator to inspect the server clock, trust chain and expected destination certificate without changing trust settings.',
    expected: 'The clock and certificate validity should agree, and the chain should lead to a trusted issuer.',
    privilege: 'Read-only clock and certificate inspection usually needs no elevation.', ifUnresolved: 'Share the validation error with the administrator; do not disable TLS verification.' },
  { id: 'download', title: 'Possible download or connection failure', pattern: /(?:curl: \((?:7|18|28|56)\)|(?:connection|connect|read) timed out|connection (?:refused|reset by peer)|HTTP (?:Error |error |[12](?:\.\d)?\s+)(?:403|404|429|5\d\d))/i,
    why: 'This excerpt reports a transport or HTTP error. It may be destination-specific or temporary.',
    check: 'Review the expected destination, response code and time with the administrator; compare with read-only network observations.',
    expected: 'A successful response from the intended endpoint is expected. A single failure does not prove general loss of connectivity.',
    privilege: 'Normal SSH access for observations; administrator for protected network policy.', ifUnresolved: 'Share the relevant response and time with the administrator, without repeating the installer.' },
  { id: 'space', title: 'Possible storage exhaustion', pattern: /(?:no space left on device|\bENOSPC\b|disk quota exceeded)/i,
    why: 'The output reports exhausted space, inodes or quota; the affected resource still needs verification.',
    check: 'Use the manual guide’s capacity check and ask the administrator to inspect filesystem, inode and quota availability.',
    expected: 'The installation filesystems need free space and inodes. Free bytes alone do not rule out a quota or inode limit.',
    privilege: 'Filesystem usage is normally readable; quota details may require an administrator.', ifUnresolved: 'Share the capacity results. Preserve installation files while the administrator plans a separate remedy.' },
  { id: 'python', title: 'Possible Python dependency problem', pattern: /(?:ResolutionImpossible|No solution found when resolving dependencies|No matching distribution found for|Failed building wheel for|requires a different Python)/i,
    why: 'Dependency resolution or a wheel build failed in the output; the exact incompatible requirement needs review.',
    check: 'Compare the reported requirement and Python version with this release’s pinned runtime requirements; inspect the full bounded excerpt.',
    expected: 'The runtime and available package distributions should satisfy the pinned requirements.',
    privilege: 'Log inspection may need the separately approved protected read.', ifUnresolved: 'Send the dependency excerpt and release ID to the administrator; do not change the pinned dependencies here.' },
  { id: 'browser', title: 'Possible browser validation problem', pattern: /(?:browser (?:runtime )?validation failed|Failed to launch (?:the )?browser|error while loading shared libraries:|Host system is missing dependencies to run browsers|camoufox.*(?:validation failed|executable.*not found))/i,
    why: 'Actual browser or shared-library error output was found; the Browser runtime stage alone would not establish this.',
    check: 'Review the missing executable or library named in the excerpt against the release requirements, without launching installation commands.',
    expected: 'The expected executable and required libraries should be present and readable. The excerpt alone may not establish why validation failed.',
    privilege: 'Protected installer output requires separate consent; file inspection may need an administrator.', ifUnresolved: 'Share the excerpt and exact release with the administrator; a corrected prerequisite does not resume the stopped operation.' },
];

/** Only observed available output can trigger a finding; stages, notes and generic exit codes cannot. */
export function diagnosticFindings(report: SetupDiagnosticReport): DiagnosticFinding[] {
  const preserved = preservedFailureSource(report);
  // Later/cleanup output must not supply a different diagnosis when the actual failure was preserved.
  // Metadata describes command provenance, not stdout/stderr to match against failure signatures.
  const evidence = preserved ? [preserved] : report.sources.filter(source => source.id !== 'diagnostics.json');
  return findingRules.flatMap(({ pattern, ...rule }) => {
    for (const source of evidence) {
      if (source.status !== 'available') continue;
      const line = source.text.split('\n').find(line => pattern.test(line));
      if (line) return [{ ...rule, sourceId: source.id, sourceLabel: source.label, excerpt: line.length > 700 ? `${line.slice(0, 700)}…` : line }];
    }
    return [];
  });
}

/** Copy only the validated native snapshot, never local receipt/activity fields or arbitrary extra IPC keys. */
export function diagnosticReportText(report: SetupDiagnosticReport): string {
  return ['Outpost diagnostics · schema 1', `Report: ${report.reportId}`, `Setup: ${report.setupId}`,
    `Operation: ${report.operationId}`, `Environment: ${report.environmentId}`, `Release: ${report.releaseId}`,
    `Raw server receipt: ${report.state} · ${report.stage} · ${report.completedSteps}/${report.totalSteps} checks`, diagnosticReceiptStateNotice,
    `Collected: ${new Date(report.collectedAt).toISOString()}`, `Expires: ${new Date(report.expiresAt).toISOString()}`,
    `Native redaction reported: ${report.redacted ? 'yes' : 'no replacements reported'}`, diagnosticSharingNotice, diagnosticCoverageFor(report),
    ...report.notes.map(note => `Note: ${note}`), ...diagnosticSources(report).flatMap(source => ['', `${source.label} [${source.id}]`,
      `${diagnosticSourceLabels[source.status]}${source.truncated ? ' · truncated' : ''}`, diagnosticSourceCoverage(source), source.text])].join('\n');
}

export function createDiagnosticViewRequests() {
  let generation = 0;
  return { capture: () => generation, current: (ticket: number) => ticket === generation, invalidate: () => { generation++; } };
}

export interface DiagnosticReadClient {
  read: (id: string, protectedLogs: boolean, password: boolean) => Promise<unknown>;
  cancel: (id: string) => Promise<void>;
}
/** Tauri commands use camelCase IPC keys unless their command attribute explicitly overrides it. */
export function createDiagnosticClient(invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>) {
  return {
    read: (id: string, protectedLogs: boolean, password: boolean) => invoke<unknown>('setup_diagnostics', { id, protectedLogs, password: protectedLogs && password }),
    cancel: (id: string) => invoke<void>('setup_diagnostics_cancel', { id }),
    guide: (id: string) => invoke<unknown>('setup_diagnostic_guide', { id }),
    exportReport: (id: string, reportId: string) => invoke<string>('setup_diagnostics_export', { id, reportId }),
  };
}

/** Serialize only a target’s reads, including cancellation acknowledgement across close/reopen. */
export function createDiagnosticReadCoordinator(client: DiagnosticReadClient) {
  const pending = new Map<string, { cancellation?: Promise<void> }>();
  return {
    async read(id: string, protectedLogs: boolean, password: boolean): Promise<unknown> {
      if (pending.has(id)) throw new Error('The previous diagnostic read is still ending. Try again shortly; other setups are unaffected.');
      const request: { cancellation?: Promise<void> } = {};
      pending.set(id, request);
      try { return await client.read(id, protectedLogs, protectedLogs && password); }
      finally {
        try { await request.cancellation; } catch { /* The caller reports cancellation failure; still release this read. */ }
        if (pending.get(id) === request) pending.delete(id);
      }
    },
    cancel(id: string): Promise<void> {
      const request = pending.get(id);
      if (!request) return Promise.resolve();
      return request.cancellation ??= client.cancel(id);
    },
  };
}
