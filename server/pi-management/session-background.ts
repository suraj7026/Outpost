import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AgentSession, EventBus } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { managementError } from './contracts.js';

// pi-subagents 0.88.1's host protocol includes native/nested jobs, owed results and parent wakes.
// Its separate background-work API only describes providers registered by other extensions.
const registryKey = Symbol.for('@agegr/pi-web/session-liveness/v1');
type SessionIdentity = Pick<AgentSession, 'sessionId' | 'sessionFile'>;
type BackgroundSession = SessionIdentity & Pick<AgentSession, 'isIdle' | 'abort'>;
type Registration = { name: string; sessionId: string; sessionFile?: string; isActive: () => boolean };
const registrations = new Set<Registration>();
let installed = false;
export function installSessionLiveness() {
  if (installed) return;
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = globals[registryKey];
  const previous = z.object({ version: z.literal(1), register: z.custom<(entry: Registration) => () => void>(value => typeof value === 'function') }).optional().parse(existing);
  globals[registryKey] = { version: 1, register(entry: Registration) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.isActive !== 'function')
      throw managementError('native_liveness_registration_invalid');
    const release = previous?.register(entry);
    registrations.add(entry);
    return () => { registrations.delete(entry); release?.(); };
  } };
  installed = true;
}

const replySchema = z.object({ version: z.literal(1), requestId: z.string(), success: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() });
interface NativeWorkNode { id: string; state: string; children?: NativeWorkNode[] | undefined }
const workNode: z.ZodType<NativeWorkNode> = z.lazy(() => z.object({ id: z.string(), state: z.string(), children: z.array(workNode).optional() }));

const statusSchema = z.object({ fleet: z.object({ totalActive: z.number().int().nonnegative() }),
  asyncSnapshot: z.object({ runs: z.array(workNode),
    omitted: z.object({ runs: z.number(), children: z.number(), byteLimitExceeded: z.boolean() }) }) });
const startedSchema = z.object({ id: z.string(), sessionId: z.string() });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(managementError('native_work_timeout')), Math.max(1, timeoutMs));
  })]); } finally { clearTimeout(timer); }
}

export class SessionBackground {
  private session?: BackgroundSession;
  private released = false;
  private external?: typeof import('pi-subagents/background-work');
  private launched = new Set<string>();
  private unsubscribe: () => void;
  private attention = false;
  private cancelling = false;
  constructor(private events: EventBus, readonly enabled: boolean,
    private inspectOwned: typeof inspectNativeSessionWork = inspectNativeSessionWork) {
    if (enabled) installSessionLiveness();
    this.unsubscribe = events.on('subagent:async-started', raw => {
      const event = startedSchema.safeParse(raw);
      if (event.success && this.identities.includes(event.data.sessionId)) this.launched.add(event.data.id);
    });
  }
  private get identities() { return this.session ? [this.session.sessionId, ...(this.session.sessionFile ? [this.session.sessionFile] : [])] : []; }
  attach(session: BackgroundSession) { this.session = session; }
  async bind(session: BackgroundSession) {
    this.attach(session);
    if (!this.enabled) return;
    this.external = await import('pi-subagents/background-work');
    this.nativeRegistrations();
    // Also ask the native bridge: a missing/malformed bridge must not look like an empty fleet.
    await this.status();
  }
  private nativeRegistrations() {
    const owned = [...registrations].filter(entry => entry.name === 'pi-subagents' &&
      (this.identities.includes(entry.sessionId) || !!entry.sessionFile && this.identities.includes(entry.sessionFile)));
    if (!owned.length) throw managementError('native_liveness_unavailable');
    return owned;
  }
  get needsAttention() { return !this.released && this.attention; }
  get active() { return !this.released && !!this.session && (!this.session.isIdle || this.nativeActive); }
  get nativeActive() {
    if (this.released || !this.session || !this.enabled) return false;
    try {
      const nativeActive = this.nativeRegistrations().some(entry => entry.isActive());
      const owned = this.inspectOwned(this.identities, this.launched);
      for (const id of owned.terminalIds) this.launched.delete(id);
      if (owned.unknown) this.attention = true;
      return nativeActive || owned.unknown || owned.activeIds.length > 0 ||
        !!this.external?.snapshotBackgroundWork(this.identities).items.length;
    } catch { this.attention = true; return true; }
  }
  private request(method: 'status' | 'stop', params?: { id: string }) {
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(managementError('native_work_rpc_timeout')); }, 1000);
      const unsubscribe = this.events.on(`subagents:rpc:v1:reply:${requestId}`, raw => {
        clearTimeout(timer); unsubscribe();
        const reply = replySchema.safeParse(raw);
        if (!reply.success || reply.data.requestId !== requestId || !reply.data.success) reject(managementError('native_work_rpc_failed'));
        else resolve(reply.data.data);
      });
      this.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method, ...(params ? { params } : {}) });
    });
  }
  private async status() { return statusSchema.parse(await this.request('status')); }
  private cancellationDrained(status: z.infer<typeof statusSchema>) {
    if (!this.session?.isIdle || status.fleet.totalActive !== 0 || this.external?.snapshotBackgroundWork(this.identities).items.length) return false;
    // RPC trees are display projections with truncation, not workload limits or terminal proof.
    const owned = this.inspectOwned(this.identities, this.launched);
    for (const id of owned.terminalIds) this.launched.delete(id);
    // A retained foreground nested route can be live while fleet.totalActive is zero.
    // Only a positively proven, non-nested async termination may bypass queued notice liveness.
    return !owned.unknown && !owned.nested && owned.activeIds.length === 0 &&
      (!this.nativeRegistrations().some(entry => entry.isActive()) || owned.terminalIds.length > 0);
  }
  async drain() {
    // Yield once for completion callbacks queued by the final foreground event.
    await delay(0);
    while (this.active) {
      if (this.cancelling && this.enabled) {
        try { if (this.cancellationDrained(await this.status())) return; }
        catch { this.attention = true; }
      }
      await delay(50);
    }
  }
  async cancel(timeoutMs = 5000): Promise<boolean> {
    if (!this.session) return true;
    this.cancelling = true;
    const deadline = Date.now() + timeoutMs;
    try {
      // Pi's abort waits for idle; native before-settle hooks can be waiting on these children.
      // Request their cancellation concurrently, rather than waiting for parent abort first.
      const aborting = this.session.abort();
      void aborting.catch(() => { this.attention = true; });
      if (!this.enabled) { await within(aborting, deadline - Date.now()); return !this.active; }
      const requested = new Set<string>();
      do {
        const status = await within(this.status(), deadline - Date.now());
        const snapshot = status.asyncSnapshot;
        const active = snapshot.runs.filter(run => ['queued', 'running'].includes(run.state));
        for (const run of active) this.launched.add(run.id);
        const owned = this.inspectOwned(this.identities, this.launched);
        for (const id of owned.activeIds) this.launched.add(id);
        for (const id of owned.terminalIds) this.launched.delete(id);
        if (this.cancellationDrained(status)) {
          // Aborted turns cannot start queued completion wakes. Native shutdown persists them for replay.
          await within(aborting, deadline - Date.now());
          return true;
        }
        // The native RPC checks exact session ownership, including restored jobs. Never signal PIDs ourselves.
        await within(Promise.allSettled([...this.launched].filter(id => !requested.has(id)).map(async id => {
          await this.request('stop', { id }); requested.add(id);
        })), deadline - Date.now());
        if (!this.active) { await within(aborting, deadline - Date.now()); return true; }
        await within(delay(50), deadline - Date.now());
      } while (Date.now() < deadline);
    } catch { this.attention = true; }
    if (this.active) this.attention = true;
    return !this.active;
  }
  release() { this.released = true; this.unsubscribe(); }
}

const nativeTempDirectory = () => {
  const root = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim() ||
    (process.getuid ? join(tmpdir(), `pi-subagents-uid-${process.getuid()}`) : undefined);
  return root ? resolve(root) : undefined;
};
const requireNative = createRequire(import.meta.url);
const readers = new Map<string, (...args: unknown[]) => unknown>();
function nativeReader(module: string, name: string) {
  const key = `${module}:${name}`;
  let reader = readers.get(key);
  if (!reader) {
    const root = dirname(dirname(fileURLToPath(import.meta.resolve('pi-subagents'))));
    z.object({ name: z.literal('pi-subagents'), version: z.literal('0.88.1') }).parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
    const exports = z.record(z.string(), z.unknown()).parse(requireNative(join(root, 'src', module)));
    reader = z.custom<(...args: unknown[]) => unknown>(value => typeof value === 'function').parse(exports[name]);
    readers.set(key, reader);
  }
  return reader;
}
const object = z.record(z.string(), z.unknown());
function nativeTerminalProven(directory: string, record: Record<string, unknown>) {
  let proof: Record<string, unknown>;
  if (record.mode === 'workflow') {
    const summary = object.parse(nativeReader('workflows/workflow-child-summary.js', 'parseWorkflowChildSummary')(record.workflowChildren));
    if (summary.workflowRunId !== record.runId) return false;
    const commands = z.array(z.unknown()).parse(nativeReader('runs/shared/host-step-status.js', 'validHostStepNodes')(record.workflowGraph));
    proof = object.parse(nativeReader('runs/background/workflow-terminal-proof.js', 'readWorkflowTerminalProof')(
      directory, record.steps, summary, commands.length, record.endedAt ?? record.lastUpdate ?? record.startedAt));
    if (proof.dispatchClosed !== true) return false;
  } else {
    const recorded = object.safeParse(record.processTerminal);
    const identity = recorded.success ? recorded.data.runnerProcessInstanceId : undefined;
    proof = object.parse(nativeReader('runs/background/process-terminal.js', 'readProcessTerminal')(directory,
      { runId: record.runId, ...(typeof identity === 'string' ? { runnerProcessInstanceId: identity } : {}) }));
  }
  if (proof.state !== 'observed' || proof.runId !== record.runId) return false;
  if (record.mode !== 'workflow') {
    const instances = z.array(object).parse(proof.instances);
    if (instances.some(instance => instance.kind === 'pi-writer' && object.parse(instance.processTree).state !== 'observed')) return false;
    if (proof.canonicalSession !== undefined && object.parse(proof.canonicalSession).freeAtObservation !== true) return false;
  }
  // The native sidecar certifies writer/tree exit. A later canonical-session lease must also be free.
  const files = [record.sessionFile, ...(Array.isArray(record.steps) ? record.steps.map(step => object.parse(step).sessionFile) : [])];
  for (const file of files) if (typeof file === 'string') {
    const lease = object.parse(nativeReader('runs/shared/session-lease.js', 'inspectSessionLease')(file));
    if (lease.state !== 'free') return false;
  }
  return true;
}

/** Read real native storage; logical terminal states never replace native process/lease proof. */
export function inspectNativeSessionWork(identities: readonly string[], knownIds: ReadonlySet<string>) {
  const result = { activeIds: [] as string[], terminalIds: [] as string[], unknown: false, nested: false };
  const root = nativeTempDirectory();
  if (!root) return { ...result, unknown: true };
  const schema = z.object({ runId: z.string(), sessionId: z.string().optional(), parentWorkflowRunId: z.string().optional(),
    state: nativeStatus.shape.state, steps: z.array(z.unknown()).optional() }).passthrough();
  const records: { data: z.infer<typeof schema>; directory: string; nestedRoot?: string }[] = [];
  const directories = (path: string) => {
    try { return readdirSync(path, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && entry.isDirectory()).map(entry => join(path, entry.name)); }
    catch (error) { if (!missing(error)) result.unknown = true; return []; }
  };
  const read = (directory: string, nestedRoot?: string) => {
    try { records.push({ data: schema.parse(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))), directory, ...(nestedRoot ? { nestedRoot } : {}) }); }
    catch { result.unknown = true; }
  };
  for (const directory of directories(join(root, 'async-subagent-runs'))) read(directory);
  for (const nestedRoot of directories(join(root, 'nested-subagent-runs'))) {
    for (const directory of directories(nestedRoot)) read(directory, basename(nestedRoot));
  }
  const owners = new Set(identities), owned = new Set<string>();
  const childRoots = identities.filter(isAbsolute).map(file => file.replace(/\.jsonl$/, ''));
  const ownsIdentity = (value: unknown) => typeof value === 'string' && (owners.has(value) || childRoots.some(root => inside(root, value)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { data, nestedRoot } of records) {
      if (owned.has(data.runId)) continue;
      if (knownIds.has(data.runId) || ownsIdentity(data.sessionId) || data.parentWorkflowRunId && owned.has(data.parentWorkflowRunId) || nestedRoot && owned.has(nestedRoot)) {
        owned.add(data.runId); changed = true;
        for (const step of data.steps ?? []) {
          const file = object.parse(step).sessionFile;
          if (typeof file === 'string') owners.add(file);
        }
      }
    }
  }
  for (const { data, directory, nestedRoot } of records.filter(record => owned.has(record.data.runId))) {
    if (nestedRoot) result.nested = true;
    if (['queued', 'running'].includes(data.state)) result.activeIds.push(data.runId);
    else {
      try { if (nativeTerminalProven(directory, data)) result.terminalIds.push(data.runId); else result.unknown = true; }
      catch { result.unknown = true; }
    }
  }
  // Native foreground descendants can exist only in nested event/registry records. Do not
  // turn their truthful host-liveness signal into 'pending notices' based on an empty fleet.
  for (const directory of directories(join(root, 'nested-subagent-events'))) {
    try {
      const metadata = z.object({ rootRunId: z.string(), capabilityToken: z.string() }).parse(JSON.parse(readFileSync(join(directory, 'route.json'), 'utf8')));
      const route = { ...metadata, eventSink: join(directory, 'events'), controlInbox: join(directory, 'controls') };
      nativeReader('runs/shared/nested-events.js', 'resolveNestedRoute')(route);
      const children: unknown[] = [];
      try {
        const registry = z.object({ children: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(join(directory, 'registry.json'), 'utf8')));
        children.push(...registry.children);
      } catch (error) { if (!missing(error)) throw error; }
      for (const name of readdirSync(route.eventSink)) {
        if (!/\.jsonl?$/.test(name)) continue;
        const events = z.array(z.object({ child: z.unknown() })).parse(nativeReader('runs/shared/nested-events.js', 'parseNestedEventRecords')(readFileSync(join(route.eventSink, name), 'utf8'), route));
        if (!events.length) result.nested = true;
        children.push(...events.map(event => event.child));
      }
      let rootOwner = records.find(record => record.data.runId === metadata.rootRunId)?.data.sessionId;
      if (!rootOwner) {
        const name = z.string().parse(nativeReader('runs/background/index-segment.js', 'encodeIndexSegment')(metadata.rootRunId));
        try {
          const history = z.object({ runId: z.literal(metadata.rootRunId), sessionId: z.string() }).parse(JSON.parse(readFileSync(join(root, 'async-subagent-results', 'foreground-history', `${name}.json`), 'utf8')));
          rootOwner = history.sessionId;
        } catch (error) { if (!missing(error)) result.nested = true; }
      }
      if (children.length && (!rootOwner || ownsIdentity(rootOwner) || owned.has(metadata.rootRunId) || knownIds.has(metadata.rootRunId) || children.some(value => {
        const child = object.parse(value);
        return ownsIdentity(child.sessionId) || ownsIdentity(child.sessionFile) || (!child.sessionId && !child.sessionFile);
      }))) result.nested = true;
    } catch { result.nested = true; }
  }
  if ([...knownIds].some(id => !owned.has(id))) result.unknown = true;
  return result;
}

const leaseSchema = z.object({ version: z.literal(1), sessionFile: z.string(), sessionId: z.string() });
const nativeStatus = z.object({ sessionId: z.string().optional(), state: z.enum(['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']) });
const inside = (root: string, path: string) => { const suffix = relative(root, path); return !!suffix && !suffix.startsWith('..') && !isAbsolute(suffix); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Durable ownership receipts prevent a restarted worker reporting idle before native recovery. */
export class SessionWorkJournal {
  private directory: string;
  private unresolved = new Set<string>();
  private owned = new Set<string>();
  private unknown = false;
  constructor(private root: string) {
    this.directory = join(root, '.outpost-native-work');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      for (const name of readdirSync(this.directory)) {
        const lease = leaseSchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8')));
        if (!inside(root, lease.sessionFile)) throw managementError('native_work_receipt_invalid');
        this.unresolved.add(lease.sessionFile);
      }
    } catch { this.unknown = true; }
    this.discoverNativeWork();
  }
  private discoverNativeWork() {
    const tempRoot = nativeTempDirectory();
    if (!tempRoot) { this.unknown = true; return; }
    const directories = (path: string) => {
      try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => join(path, entry.name)); }
      catch (error) { if (!missing(error)) this.unknown = true; return []; }
    };
    const runs = [...directories(join(tempRoot, 'async-subagent-runs')),
      ...directories(join(tempRoot, 'nested-subagent-runs')).flatMap(directories)];
    for (const directory of runs) {
      let status;
      try { status = nativeStatus.passthrough().parse(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))); }
      catch { this.unknown = true; continue; }
      if (!status.sessionId || !isAbsolute(status.sessionId)) { this.unknown = true; continue; }
      if (!inside(this.root, status.sessionId)) continue;
      try {
        if (['queued', 'running'].includes(status.state) || !nativeTerminalProven(directory, status)) this.unresolved.add(status.sessionId);
      } catch { this.unresolved.add(status.sessionId); }
    }
  }
  get needsAttention() { return this.unknown || [...this.unresolved].some(file => !this.owned.has(file)); }
  get unresolvedSessions() { return [...this.unresolved]; }
  private path(sessionFile: string) { return join(this.directory, `${createHash('sha256').update(sessionFile).digest('hex')}.json`); }
  own(session: SessionIdentity) {
    if (!session.sessionFile || !inside(this.root, session.sessionFile)) throw managementError('native_work_session_path_invalid');
    const path = this.path(session.sessionFile), staging = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify({ version: 1, sessionFile: session.sessionFile, sessionId: session.sessionId }), { mode: 0o600, flag: 'wx' });
      renameSync(staging, path);
    } finally { rmSync(staging, { force: true }); }
    this.unresolved.add(session.sessionFile);
    this.owned.add(session.sessionFile);
  }
  releaseOwnership(session: SessionIdentity) { if (session.sessionFile) this.owned.delete(session.sessionFile); }
  settled(session: SessionIdentity) {
    if (!session.sessionFile) return;
    rmSync(this.path(session.sessionFile), { force: true });
    this.unresolved.delete(session.sessionFile);
    this.owned.delete(session.sessionFile);
  }
}
