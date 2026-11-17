import { join } from 'node:path';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { ClientCommand, Fault, id, requireThat } from '../core/contracts.js';
import type { Json } from '../core/contracts.js';
import { Devices, Gate } from '../policy/trust.js';
import type { Action } from '../policy/trust.js';
import { Tasks } from '../tasks/tasks.js';
import type { Task } from '../tasks/tasks.js';
import { Workspace, Artifacts } from '../artifacts/files.js';
import { WorkspaceReview, WorkspaceFilesInput, WorkspaceReadInput } from '../artifacts/workspace-review.js';
import { registerCommands } from '../processes/runner.js';
import { registerInventory } from '../operations/machine.js';
import { PiRuntime } from '../pi-adapter/runtime.js';
import { RemotePiRuntime } from '../pi-adapter/remote-runtime.js';
import { WorkerClient } from '../pi-worker/client.js';
import { ManagementRequest, ModelRef } from '../pi-management/contracts.js';
import { cloudReviewer } from '../models/cloud.js';
import { profileCSV } from '../data/analysis.js';
import { renderHTML } from '../documents/documents.js';
import { MemoryStore } from '../memory/memory.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { registerAutomationTools } from '../scheduler/tools.js';
import { Notifications } from '../notifier/apns.js';
import type { InferenceConfiguration } from '../models/inference.js';
import { registerHosts } from '../operations/hosts.js';
import type { HostAdministration } from '../operations/hosts.js';
import { LiveFeed } from './live.js';
import { BrowserSessions } from '../browser/sessions.js';
import { BrowserControl } from '../browser/control.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserSessionOptions } from '../browser/sessions.js';
import { registerDirectBrowser } from '../browser/direct.js';
import { Maintenance } from '../environment/maintenance.js';
import { Installation } from '../environment/installation.js';
import type { EnvironmentOptions } from '../environment/contracts.js';
import { collectRecoveryDiagnostics, RecoveryInput, RecoveryInvestigationInput, recoveryAllowsDispatch, recoveryInvestigationGoal, recoveryStatus } from '../diagnostics/recovery.js';

export const publicKinds = ['task','policy','message','action','artifact','inbox','automation','memory','identity','capability','browser','browser_control','workflow','source','citation','deployment_evidence','operation','device','recovery','tool_stream'];
const wire = (value: unknown): Json => z.json().parse(value);
export class Coordinator {
  readonly browsers: BrowserSessions | undefined;
  readonly browserControl: BrowserControl | undefined;
  readonly environment: Installation;
  readonly maintenance: Maintenance;
  readonly live: LiveFeed;
  readonly devices: Devices; readonly tasks: Tasks; readonly artifacts: Artifacts; readonly memory: MemoryStore; readonly scheduler: Scheduler;
  private managementWrites = new Map<string, number>();
  private gates = new Map<string,Gate>(); private runtimes = new Map<string,PiRuntime | RemotePiRuntime>(); private jobs = new Set<string>();
  constructor(readonly db: Ledger, readonly root: string, private options: { workspaceRoot?: string; sharedWorkspaces?: boolean; apiKey?: string; roles?: unknown; executables?: string[]; inference?: InferenceConfiguration; unrestrictedCommands?: boolean; hosts?: HostAdministration; browser?: BrowserSessionOptions; worker?: WorkerClient; environment?: EnvironmentOptions } = {}) {
    this.environment = new Installation(db, options.environment);
    db.db.exec('CREATE TABLE IF NOT EXISTS credential_leases(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.live = new LiveFeed(db);
    this.browsers = options.browser ? new BrowserSessions(db, root, options.browser) : undefined;
    for (const kind of ['message','tool_stream']) for (const record of db.list(kind)) if (record.data.streaming) db.put(kind,record.id,record.revision,{ ...record.data,streaming: false,interrupted: true });
    this.devices = new Devices(db); this.tasks = new Tasks(db); this.artifacts = new Artifacts(db,join(root,'artifacts')); this.memory = new MemoryStore(db); this.scheduler = new Scheduler(db,this.tasks);
    this.tasks.recover();
    this.maintenance = new Maintenance(db, this.tasks, options.worker, () => this.jobs.size > 0 || this.managementWrites.size > 0);
    if (this.browsers) this.browserControl = new BrowserControl(db, this.browsers, taskId => {
      const task = db.need<Task>('task', taskId);
      requireThat(!['cancelled', 'completed'].includes(task.data.state), 'terminal_task');
      db.put('task', taskId, task.revision, { ...task.data, state: 'paused', blocker: 'Browser takeover requested. Return control, then explicitly resume Pi.' }, 'task.browser_takeover');
    }, async taskId => {
      await this.runtimes.get(taskId)?.abort(taskId);
      for (let attempt = 0; attempt < 1000 && this.runtimes.get(taskId)?.isActive(taskId); attempt++) await delay(10);
      requireThat(!this.runtimes.get(taskId)?.isActive(taskId), 'browser_runtime_not_settled');
    });
    db.db.prepare("UPDATE outbox SET state='unknown' WHERE state='claimed'").run();
    for (const operation of db.list('operation')) if (operation.data.state === 'running') db.put('operation',operation.id,operation.revision,{ ...operation.data,state: 'unknown',error: 'Coordinator restarted; reconcile before retry' });
    for (const action of db.list<Action>('action')) if (action.data.state === 'dispatching') db.put('action',action.id,action.revision,{ ...action.data,state: 'unknown',result: { error: 'Coordinator restarted; reconcile before retry' } });
  }
  get dispatchEnabled() { return recoveryAllowsDispatch(recoveryStatus(this.db)); }
  gate(taskId: string) {
    const task = this.db.need<Task>('task',taskId); z.uuid().parse(taskId);
    let gate = this.gates.get(taskId); if (gate) return gate;
    const reviewer = this.options.apiKey && this.options.roles ? cloudReviewer(this.options.apiKey,this.options.roles) : undefined;
    gate = new Gate(this.db,reviewer,!!this.options.hosts); const workspace = new Workspace(join(this.options.workspaceRoot ?? join(this.root,'workspaces'),taskId),this.options.sharedWorkspaces);
    workspace.register(gate); registerInventory(gate); registerCommands(gate,workspace,new Set(this.options.executables ?? []),this.options.unrestrictedCommands);
    registerAutomationTools(gate,this.scheduler,taskId,{ workerAvailable: !!this.options.worker, assertWritable: () => {
      requireThat(!this.maintenance.holding,'maintenance_in_progress');
      requireThat(this.dispatchEnabled,'recovery_dispatch_disabled');
    } });
    if (this.options.hosts) registerHosts(gate,this.options.hosts,taskId);
    if (this.browsers) registerDirectBrowser(gate,this.browsers,this.artifacts,taskId);
    gate.register('recovery.inspect',{ version: 1,effects: ['machine.read'],inputSchema: z.toJSONSchema(RecoveryInput),description: 'Reads bounded authoritative recovery diagnostics for this environment. Configuration is not proof of runtime health. Does not repair, create records or release holds.',parse: input => RecoveryInput.parse(input),target: () => 'environment recovery',execute: async () => wire(this.recoveryDiagnostics()) });
    const ArtifactRead = z.strictObject({ artifactId: z.uuid() });
    gate.register('artifact.read_text',{ version: 1,effects: ['workspace.read'],inputSchema: z.toJSONSchema(ArtifactRead),description: 'Reads a published text artifact by its UUID artifactId. For workspace paths such as STATUS.md use file.read instead.',parse: input => ArtifactRead.parse(input),target: args => String(args.artifactId),execute: async args => {
      const artifact = this.db.need('artifact',String(args.artifactId)); requireThat(artifact.data.taskId === taskId,'artifact_scope_denied');
      const bytes = this.artifacts.read(artifact.id); requireThat(bytes.length <= 1024*1024 && !bytes.includes(0),'text_artifact_required');
      return { name: artifact.data.name ?? '',text: bytes.toString('utf8'),hash: artifact.data.hash ?? '' };
    } });
    const ProfileInput = z.strictObject({ path: z.string() }), ReportInput = z.record(z.string(), z.json());
    gate.register('data.profile',{ version: 1,effects: ['workspace.read'],inputSchema: z.toJSONSchema(ProfileInput),description: 'Profiles a CSV file at a relative workspace path.',parse: input => ProfileInput.parse(input),target: args => String(args.path),execute: async args => profileCSV(workspace.read(String(args.path))) });
    gate.register('document.report',{ version: 1,effects: ['workspace.write'],inputSchema: z.toJSONSchema(ReportInput),description: 'Publishes an HTML report from a JSON object.',parse: input => ReportInput.parse(input),target: () => 'task artifacts',execute: async args => wire(this.artifacts.publish(taskId,'report.html','text/html',Buffer.from(renderHTML(args)))) });
    this.gates.set(taskId,gate); return gate;
  }
  private queueOperation(taskId: string, topic: string, payload: Record<string,Json>) {
    const operationId = id();
    this.db.put('operation',operationId,0,{ taskId,topic,state: 'accepted',error: null });
    this.db.enqueue(topic,{ ...payload,taskId,operationId },operationId);
    return { operationId,status: 'accepted' };
  }
  command(input: unknown) {
    const command = ClientCommand.parse(input);
    // Investigation retries return their accepted task; new admission is checked inside db.accept.
    if (this.maintenance.holding && command.type !== 'recovery.investigate') requireThat(this.maintenance.status().state === 'draining' && ['task.pause', 'task.cancel', 'approval.decide'].includes(command.type), 'maintenance_in_progress');
    this.environment.requireProtocol(command.protocolVersion);
    if (command.protocolVersion === 2) this.environment.requireTarget(command.environmentId);
    requireThat(Math.abs(Date.now()-command.issuedAt) < 300000,'expired_command');
    const accepted = this.db.accept(command,() => {
      const { type,aggregateId: key,expectedRevision: expected,payload } = command;
      switch (type) {
        case 'recovery.investigate': {
          z.uuid().parse(key); requireThat(expected === 0,'stale_revision');
          const selection = RecoveryInvestigationInput.parse(payload);
          requireThat(!this.maintenance.holding,'maintenance_in_progress');
          requireThat(this.dispatchEnabled,'recovery_dispatch_disabled');
          requireThat(this.runtimeStatus().configured,'runtime_not_configured');
          requireThat(!selection.modelRef || !!this.options.worker,'pi_worker_required');
          return wire(this.tasks.create(key,{ ...selection,profile: 'operations',mode: 'ask_permission',goal: recoveryInvestigationGoal(this.recoveryDiagnostics()) }));
        }
        case 'task.create': z.uuid().parse(key); requireThat(expected === 0,'stale_revision'); requireThat(!payload.modelRef || !!this.options.worker,'pi_worker_required'); return wire(this.tasks.create(key,payload));
        case 'task.steer': {
          requireThat(!payload.modelRef || !!this.options.worker,'pi_worker_required');
          return wire(this.tasks.steer(key,expected,z.string().parse(payload.text),payload.modelRef ? ModelRef.parse(payload.modelRef) : undefined));
        }
        case 'task.resume': requireThat(!this.browsers?.isHeld(key) && !['pending', 'human', 'releasing'].includes(String(this.browserControl?.status(key)?.state)), 'browser_control_held'); return wire(this.tasks.control(key,expected,'resume'));
        case 'task.pause': case 'task.cancel': return wire(this.tasks.control(key,expected,type.split('.')[1] as 'pause' | 'cancel'));
        case 'policy.change': return wire(this.gate(key).changePolicy(key,expected,payload.mode));
        case 'approval.decide': {
          const action = this.db.need<Action>('action',key);
          return wire(this.gate(action.data.taskId).decide(key,expected,z.string().parse(payload.nonce),z.string().parse(payload.actionDigest),z.enum(['approve','deny']).parse(payload.decision),command.deviceId));
        }
        case 'action.propose': {
          this.db.need('task',key); const tool = z.string().parse(payload.tool), args = z.record(z.string(),z.json()).parse(payload.arguments);
          return this.queueOperation(key,'action.propose',{ tool,arguments: args });
        }
        case 'action.dispatch': { const action = this.db.need<Action>('action',key); requireThat(action.revision === expected,'stale_revision'); requireThat(action.data.state === 'authorized','not_authorized'); return this.queueOperation(action.data.taskId,'action.dispatch',{ actionId: key }); }
        case 'artifact.begin': {
          const value = z.strictObject({ name: z.string(),mime: z.string(),size: z.number().int(),hash: z.string() }).parse(payload);
          return wire(this.artifacts.begin(key,value.name,value.mime,value.size,value.hash));
        }
        case 'artifact.chunk': {
          const value = z.strictObject({ offset: z.number().int().nonnegative(),base64: z.string().max(700000) }).parse(payload);
          return wire(this.artifacts.chunk(key,value.offset,Buffer.from(value.base64,'base64')));
        }
        case 'artifact.complete': return wire(this.artifacts.complete(key));
        case 'automation.save': return wire(this.scheduler.save(key,expected,payload));
        case 'memory.save': return wire(this.memory.save(z.strictObject({ text: z.string(),project: z.string(),identityId: z.string(),source: z.string(),provenance: z.literal('owner') }).parse(payload)));
        case 'memory.forget': return wire(this.memory.forget(key,expected));
        case 'memory.shared': {
          requireThat(command.protocolVersion === 2, 'shared_memory_requires_verified_server');
          requireThat(expected === 0, 'invalid_shared_memory_revision');
          const value = z.strictObject({ text: z.string().trim().min(1).max(20000).nullable() }).parse(payload);
          return wire(this.memory.applyShared(z.uuid().parse(key),value.text));
        }
        case 'device.register_push': {
          const value = z.strictObject({ token: z.string(),topic: z.string().min(1),environment: z.enum(['sandbox','production']) }).parse(payload);
          return wire(new Notifications(this.db).register(command.deviceId,value.token,value.topic,value.environment));
        }
        case 'device.revoke':
          requireThat(!this.managementWrites.get(key) && !this.db.db.prepare('SELECT 1 FROM credential_leases WHERE device_id=? AND expires_at>? LIMIT 1').get(key,Date.now()), 'credential_commit_in_progress', 'A credential operation is settling. Retry revocation after it completes.');
          return wire(this.devices.revoke(key,expected));
        case 'recovery.resume': {
          requireThat(key === 'server' && payload.acknowledged === true,'recovery_acknowledgment_required');
          const hold = this.db.need('recovery',key);
          return wire(this.db.put('recovery',key,expected,{ ...hold.data,dispatchEnabled: true,resumedBy: command.deviceId }));
        }
        default: throw new Fault('unknown_command','Unsupported command',400);
      }
    });
    if (command.type === 'device.revoke') this.browserControl?.revoke(command.aggregateId);
    if (['task.pause','task.cancel'].includes(command.type)) {
      this.gates.get(command.aggregateId)?.stop(command.aggregateId);
      void this.browsers?.stop(command.aggregateId,'Task paused or cancelled');
      void this.runtimes.get(command.aggregateId)?.abort(command.aggregateId);
    }
    return accepted;
  }
  async agentRequest(deviceId: string, input: unknown) {
    requireThat(this.options.worker, 'pi_worker_unavailable', 'Server Pi management is not enabled.');
    const request = ManagementRequest.parse(input);
    requireThat(!this.db.need('device', deviceId).data.revoked, 'revoked_device');
    if (['maintenance.stage', 'maintenance.prepare', 'maintenance.status', 'maintenance.cancel'].includes(request.type)) return this.maintenance.request(deviceId, request);
    requireThat(!['maintenance.hold', 'maintenance.release'].includes(request.type), 'maintenance_internal_operation');
    if (this.maintenance.holding) requireThat(['catalogue', 'runtime.inventory', 'transfer.inventory', 'transfer.history', 'transfer.status', 'transfer.cancel', 'login.status', 'login.answer', 'login.cancel'].includes(request.type), 'maintenance_in_progress');
    const writes = !['catalogue', 'refresh', 'login.status', 'login.start', 'login.cancel'].includes(request.type);
    const leaseId = id();
    if (writes) {
      this.managementWrites.set(deviceId, (this.managementWrites.get(deviceId) ?? 0) + 1);
      this.db.db.prepare('DELETE FROM credential_leases WHERE expires_at<=?').run(Date.now());
      this.db.db.prepare('INSERT INTO credential_leases VALUES(?,?,?)').run(leaseId, deviceId, Date.now() + 30000);
    }
    let settled = false;
    try {
      const result = await this.options.worker.request({ type: 'management', owner: deviceId, request });
      settled = true;
      return result;
    }
    finally {
      if (writes) {
        if (settled) this.db.db.prepare('DELETE FROM credential_leases WHERE id=?').run(leaseId);
        const remaining = (this.managementWrites.get(deviceId) ?? 1) - 1;
        if (remaining) this.managementWrites.set(deviceId, remaining); else this.managementWrites.delete(deviceId);
      }
    }
  }
  runtimeStatus() {
    return { piManagement: !!this.options.worker, configured: !!this.options.worker || !!this.options.inference || !!(this.options.apiKey && this.options.roles),model: this.options.inference?.model ?? null,hostAdministration: !!this.options.hosts,browserEngine: this.browsers ? 'camoufox' : null,browserDirect: !!this.browsers,browserTakeover: !!this.browserControl,unrestrictedCommands: !!this.options.unrestrictedCommands };
  }
  environmentDescriptor() {
    return this.environment.descriptor({ worker: !!this.options.worker, hostAdministration: !!this.options.hosts });
  }
  recoveryDiagnostics() {
    return collectRecoveryDiagnostics(this.db,{
      environment: this.environmentDescriptor(),
      maintenance: { state: this.maintenance.status().state,holding: this.maintenance.holding },
      runtime: { ...this.runtimeStatus(),hosts: Object.keys(this.options.hosts?.endpoints ?? {}) },
    });
  }
  query(type: string, payload: Record<string,Json>) {
    if (type === 'workspace.files' || type === 'workspace.read') {
      const input = type === 'workspace.files' ? { ...WorkspaceFilesInput.parse(payload), path: undefined } : WorkspaceReadInput.parse(payload);
      this.db.need('task',input.taskId);
      const workspace = new WorkspaceReview(join(this.options.workspaceRoot ?? join(this.root,'workspaces'),input.taskId));
      return (input.path === undefined ? workspace.files() : workspace.read(input.path)).then(wire);
    }
    if (type === 'recovery.diagnostics') { RecoveryInput.parse(payload); return wire(this.recoveryDiagnostics()); }
    if (type === 'browser.frame') {
      const { taskId } = z.strictObject({ taskId: z.uuid() }).parse(payload);
      this.db.need('task',taskId);
      requireThat(this.browsers,'browser_unavailable');
      return this.browsers.frame(taskId).then(frame => wire({ ...frame, control: this.browserControl?.status(taskId) ?? null, controlEpoch: this.browserControl?.epoch ?? null }));
    }
    if (type === 'environment') return wire(this.environmentDescriptor());
    if (type === 'runtime') return wire({ ...this.runtimeStatus(), sharedMemory: true });
    if (type === 'models' && this.options.inference) {
      const base = this.options.inference.baseUrl.replace(/\/v1\/?$/,'');
      return fetch(`${base}/api/tags`,{ signal: AbortSignal.timeout(10000),redirect: 'error' }).then(async response => {
        requireThat(response.ok,'model_catalogue_unavailable');
        const result = z.object({ models: z.array(z.object({ name: z.string() })) }).parse(await response.json());
        return wire({ models: result.models.map(model => model.name),defaultModel: this.options.inference?.model });
      });
    }
    if (type === 'snapshot') return wire(this.db.snapshot(publicKinds));
    if (type === 'events') {
      const page = this.db.events(z.number().int().parse(payload.after),200);
      return wire({ events: page.filter(event => publicKinds.includes(z.object({ kind: z.string() }).parse(event.payload).kind)),nextCursor: page.at(-1)?.feedCursor ?? payload.after,hasMore: page.length === 200 });
    }
    if (type === 'tools') return wire(this.gate(z.string().parse(payload.taskId)).catalogue());
    throw new Fault('unknown_query','Unsupported query',400);
  }
  async closeBrowsers() {
    await this.browsers?.close();
    await this.browserControl?.close();
  }
  private runPi(taskId: string, prompt: string, selection?: ModelRef) {
    const task = this.db.need<Task>('task',taskId);
    let pending: Promise<void>;
    if (this.options.worker) {
      const saved = this.runtimes.get(taskId);
      const runtime = saved instanceof RemotePiRuntime ? saved : new RemotePiRuntime(this.db,this.gate(taskId),this.options.worker,this.live);
      this.runtimes.set(taskId,runtime);
      pending = runtime.run(taskId,prompt,selection ?? { providerId: task.data.provider ?? 'outpost-ollama', modelId: task.data.model ?? this.options.inference?.model ?? '' });
    } else {
      const inference = this.options.inference ? { ...this.options.inference,...(task.data.model ? { model: task.data.model } : {}) } : undefined;
      const saved = this.runtimes.get(taskId);
      const runtime = saved instanceof PiRuntime ? saved : new PiRuntime(this.db,this.gate(taskId),join(this.root,'pi',taskId),this.live);
      this.runtimes.set(taskId,runtime);
      pending = runtime.run(taskId,join(this.options.workspaceRoot ?? join(this.root,'workspaces'),taskId),prompt,this.options.apiKey ?? 'ollama',this.options.roles,inference);
    }
    void pending.catch(error => {
      const current = this.db.need<Task>('task',taskId);
      if (!['paused','cancelled'].includes(current.data.state)) this.db.put('task',taskId,current.revision,{ ...current.data,state: 'interrupted',blocker: `Pi run failed: ${String(error).slice(0,800)}` });
    });
  }
  async drain() {
    if (!this.dispatchEnabled) return;
    const rows = this.db.db.prepare("SELECT id,topic,payload FROM outbox WHERE state='pending' AND topic!='notice' ORDER BY created_at LIMIT 20").all();
    const blockedTasks = new Set<string>();
    for (const row of rows) {
      const key = String(row.id), topic = String(row.topic); if (this.jobs.has(key) || topic === 'notice') continue;
      const data = z.record(z.string(),z.json()).parse(JSON.parse(String(row.payload)));
      if (topic === 'task.steer') {
        const taskId = String(data.taskId), runtime = this.runtimes.get(taskId);
        if (blockedTasks.has(taskId)) continue;
        if (this.browsers?.isHeld(taskId)) { blockedTasks.add(taskId); continue; }
        if (runtime instanceof RemotePiRuntime && runtime.isActive(taskId) && data.modelRef && !runtime.canSteer(ModelRef.parse(data.modelRef))) {
          blockedTasks.add(taskId); continue;
        }
      }
      this.db.db.prepare("UPDATE outbox SET state='claimed' WHERE id=? AND state='pending'").run(key); this.jobs.add(key);
      const operation = this.db.get('operation',key);
      if (operation) this.db.put('operation',key,operation.revision,{ ...operation.data,state: 'running' });
      try {
        if (topic === 'action.propose') await this.gate(String(data.taskId)).propose(String(data.taskId),String(data.tool),data.arguments,String(data.operationId));
        else if (topic === 'action.dispatch') { const action = this.db.need<Action>('action',String(data.actionId)); await this.gate(action.data.taskId).dispatch(String(data.actionId)); }
        else if (topic === 'task.pause' || topic === 'task.cancel') await this.runtimes.get(String(data.taskId))?.abort(String(data.taskId));
        else if (topic === 'task.steer') {
          const taskId = String(data.taskId);
          const runtime = this.runtimes.get(taskId);
          if (runtime?.isActive(taskId)) await runtime.steer(taskId,String(data.text));
          else if (this.options.worker || this.options.inference || (this.options.apiKey && this.options.roles)) {
            const task = this.db.need<Task>('task',taskId);
            if (!['paused','cancelled','completed'].includes(task.data.state)) {
              this.db.put('task',taskId,task.revision,{ ...task.data,state: 'running',blocker: null });
              this.runPi(taskId,String(data.text),data.modelRef ? ModelRef.parse(data.modelRef) : undefined);
            }
          }
        }
        else if (topic === 'task.run' || topic === 'task.resume') {
          const taskId = String(data.taskId), task = this.db.need<Task>('task',taskId);
          if (task.data.state === 'queued') {
            if (!this.options.worker && !this.options.inference && (!this.options.apiKey || !this.options.roles)) this.db.put('task',taskId,task.revision,{ ...task.data,state: 'waiting_for_capacity',blocker: 'Configure an Ollama endpoint and model, or qualified Cloud roles. Local tools can be proposed explicitly.' });
            else {
              this.tasks.claim(taskId,this.options.worker ? 'pi-server-worker' : 'pi-local');
              this.runPi(taskId,task.data.goal,data.modelRef ? ModelRef.parse(data.modelRef) : undefined);
            }
          }
        }
        this.db.db.prepare("UPDATE outbox SET state='done' WHERE id=?").run(key);
        const finished = this.db.get('operation',key);
        if (finished) this.db.put('operation',key,finished.revision,{ ...finished.data,state: 'handled' });
      } catch (error) {
        this.db.db.prepare("UPDATE outbox SET state='unknown' WHERE id=?").run(key);
        const failed = this.db.get('operation',key);
        if (failed) this.db.put('operation',key,failed.revision,{ ...failed.data,state: 'unknown',error: error instanceof Fault ? error.code : 'Operation failed; reconcile before retry' });
      }
      finally { this.jobs.delete(key); }
    }
  }
}
