import { join } from 'node:path';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { Command, Fault, id, requireThat } from '../core/contracts.js';
import type { Json } from '../core/contracts.js';
import { Devices, Gate } from '../policy/trust.js';
import type { Action } from '../policy/trust.js';
import { Tasks } from '../tasks/tasks.js';
import type { Task } from '../tasks/tasks.js';
import { Workspace, Artifacts } from '../artifacts/files.js';
import { registerCommands } from '../processes/runner.js';
import { registerInventory } from '../operations/machine.js';
import { PiRuntime } from '../pi-adapter/runtime.js';
import { cloudReviewer } from '../models/cloud.js';
import { profileCSV } from '../data/analysis.js';
import { renderHTML } from '../documents/documents.js';
import { MemoryStore } from '../memory/memory.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { Notifications } from '../notifier/apns.js';

export const publicKinds = ['task','policy','message','action','artifact','inbox','automation','memory','identity','capability','browser','workflow','source','citation','deployment_evidence','operation'];
const wire = (value: unknown): Json => z.json().parse(value);
export class Coordinator {
  readonly devices: Devices; readonly tasks: Tasks; readonly artifacts: Artifacts; readonly memory: MemoryStore; readonly scheduler: Scheduler;
  private gates = new Map<string,Gate>(); private runtimes = new Map<string,PiRuntime>(); private jobs = new Set<string>();
  constructor(readonly db: Ledger, readonly root: string, private options: { apiKey?: string; roles?: unknown; executables?: string[] } = {}) {
    this.devices = new Devices(db); this.tasks = new Tasks(db); this.artifacts = new Artifacts(db,join(root,'artifacts')); this.memory = new MemoryStore(db); this.scheduler = new Scheduler(db,this.tasks);
    this.tasks.recover();
    db.db.prepare("UPDATE outbox SET state='unknown' WHERE state='claimed'").run();
    for (const operation of db.list('operation')) if (operation.data.state === 'running') db.put('operation',operation.id,operation.revision,{ ...operation.data,state: 'unknown',error: 'Coordinator restarted; reconcile before retry' });
    for (const action of db.list<Action>('action')) if (action.data.state === 'dispatching') db.put('action',action.id,action.revision,{ ...action.data,state: 'unknown',result: { error: 'Coordinator restarted; reconcile before retry' } });
  }
  gate(taskId: string) {
    this.db.need('task',taskId); z.uuid().parse(taskId);
    let gate = this.gates.get(taskId); if (gate) return gate;
    const reviewer = this.options.apiKey && this.options.roles ? cloudReviewer(this.options.apiKey,this.options.roles) : undefined;
    gate = new Gate(this.db,reviewer); const workspace = new Workspace(join(this.root,'workspaces',taskId));
    workspace.register(gate); registerInventory(gate); registerCommands(gate,workspace,new Set(this.options.executables ?? []));
    gate.register('artifact.read_text',{ version: 1,effects: ['workspace.read'],parse: input => z.strictObject({ artifactId: z.uuid() }).parse(input),target: args => String(args.artifactId),execute: async args => {
      const artifact = this.db.need('artifact',String(args.artifactId)); requireThat(artifact.data.taskId === taskId,'artifact_scope_denied');
      const bytes = this.artifacts.read(artifact.id); requireThat(bytes.length <= 1024*1024 && !bytes.includes(0),'text_artifact_required');
      return { name: artifact.data.name ?? '',text: bytes.toString('utf8'),hash: artifact.data.hash ?? '' };
    } });
    gate.register('data.profile',{ version: 1,effects: ['workspace.read'],parse: input => z.strictObject({ path: z.string() }).parse(input),target: args => String(args.path),execute: async args => profileCSV(workspace.read(String(args.path))) });
    gate.register('document.report',{ version: 1,effects: ['workspace.write'],parse: input => z.record(z.string(),z.json()).parse(input),target: () => 'task artifacts',execute: async args => wire(this.artifacts.publish(taskId,'report.html','text/html',Buffer.from(renderHTML(args)))) });
    this.gates.set(taskId,gate); return gate;
  }
  private queueOperation(taskId: string, topic: string, payload: Record<string,Json>) {
    const operationId = id();
    this.db.put('operation',operationId,0,{ taskId,topic,state: 'accepted',error: null });
    this.db.enqueue(topic,{ ...payload,taskId,operationId },operationId);
    return { operationId,status: 'accepted' };
  }
  command(input: unknown) {
    const command = Command.parse(input); requireThat(Math.abs(Date.now()-command.issuedAt) < 300000,'expired_command');
    const accepted = this.db.accept(command,() => {
      const { type,aggregateId: key,expectedRevision: expected,payload } = command;
      switch (type) {
        case 'task.create': z.uuid().parse(key); requireThat(expected === 0,'stale_revision'); return wire(this.tasks.create(key,payload));
        case 'task.steer': return wire(this.tasks.steer(key,expected,z.string().parse(payload.text)));
        case 'task.pause': case 'task.cancel': case 'task.resume': return wire(this.tasks.control(key,expected,type.split('.')[1] as 'pause' | 'cancel' | 'resume'));
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
        case 'device.register_push': {
          const value = z.strictObject({ token: z.string(),topic: z.string().min(1),environment: z.enum(['sandbox','production']) }).parse(payload);
          return wire(new Notifications(this.db).register(command.deviceId,value.token,value.topic,value.environment));
        }
        case 'device.revoke': return wire(this.devices.revoke(key,expected));
        default: throw new Fault('unknown_command','Unsupported command',400);
      }
    });
    if (['task.pause','task.cancel'].includes(command.type)) {
      this.gates.get(command.aggregateId)?.stop(command.aggregateId);
      void this.runtimes.get(command.aggregateId)?.abort(command.aggregateId);
    }
    return accepted;
  }
  query(type: string, payload: Record<string,Json>) {
    if (type === 'snapshot') return wire(this.db.snapshot(publicKinds));
    if (type === 'events') {
      const page = this.db.events(z.number().int().parse(payload.after),200);
      return wire({ events: page.filter(event => publicKinds.includes(z.object({ kind: z.string() }).parse(event.payload).kind)),nextCursor: page.at(-1)?.feedCursor ?? payload.after,hasMore: page.length === 200 });
    }
    if (type === 'tools') return wire(this.gate(z.string().parse(payload.taskId)).catalogue());
    throw new Fault('unknown_query','Unsupported query',400);
  }
  async drain() {
    const rows = this.db.db.prepare("SELECT id,topic,payload FROM outbox WHERE state='pending' AND topic!='notice' ORDER BY created_at LIMIT 20").all();
    for (const row of rows) {
      const key = String(row.id), topic = String(row.topic); if (this.jobs.has(key) || topic === 'notice') continue;
      const data = z.record(z.string(),z.json()).parse(JSON.parse(String(row.payload)));
      this.db.db.prepare("UPDATE outbox SET state='claimed' WHERE id=? AND state='pending'").run(key); this.jobs.add(key);
      const operation = this.db.get('operation',key);
      if (operation) this.db.put('operation',key,operation.revision,{ ...operation.data,state: 'running' });
      try {
        if (topic === 'action.propose') await this.gate(String(data.taskId)).propose(String(data.taskId),String(data.tool),data.arguments,String(data.operationId));
        else if (topic === 'action.dispatch') { const action = this.db.need<Action>('action',String(data.actionId)); await this.gate(action.data.taskId).dispatch(String(data.actionId)); }
        else if (topic === 'task.pause' || topic === 'task.cancel') await this.runtimes.get(String(data.taskId))?.abort(String(data.taskId));
        else if (topic === 'task.steer') await this.runtimes.get(String(data.taskId))?.steer(String(data.taskId),String(data.text));
        else if (topic === 'task.run' || topic === 'task.resume') {
          const taskId = String(data.taskId), task = this.db.need<Task>('task',taskId);
          if (task.data.state === 'queued') {
            if (!this.options.apiKey || !this.options.roles) this.db.put('task',taskId,task.revision,{ ...task.data,state: 'waiting_for_capacity',blocker: 'Configure and qualify Ollama Cloud operator/reviewer roles to run Pi. Local tools can be proposed explicitly.' });
            else {
              this.tasks.claim(taskId,'pi-local');
              const runtime = this.runtimes.get(taskId) ?? new PiRuntime(this.db,this.gate(taskId),join(this.root,'pi',taskId)); this.runtimes.set(taskId,runtime);
              void runtime.run(taskId,join(this.root,'workspaces',taskId),task.data.goal,this.options.apiKey,this.options.roles).catch(() => {
                const current = this.db.need<Task>('task',taskId); if (!['paused','cancelled'].includes(current.data.state)) this.db.put('task',taskId,current.revision,{ ...current.data,state: 'interrupted',blocker: 'Pi run failed; inspect session and operation evidence before resuming' });
              });
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
