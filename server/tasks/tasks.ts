import { z } from 'zod';
import { Mode, RunState, id, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { ModelRef } from '../pi-management/contracts.js';
import { retireLegacyApprovals } from '../policy/migration.js';

export const NewTask = z.strictObject({ goal: z.string().trim().min(1).max(20000), profile: z.enum(['code','browser','operations','research','cowork','chat']), mode: Mode.default('full_control'), model: z.string().trim().min(1).max(200).optional(), modelRef: ModelRef.optional() }).refine(value => !(value.model && value.modelRef), 'Choose either a legacy model or a provider-qualified model');
export interface Task { goal: string; profile: string; model?: string; provider?: string; state: z.infer<typeof RunState>; runId: string; instructionSequence: number; plan: { title: string; state: string }[]; evidence: string[]; blocker: string | null }
const terminal = new Set(['cancelled','completed']);
export class Tasks {
  constructor(readonly db: Ledger) {}
  create(taskId: string, input: unknown) {
    const data = NewTask.parse(input);
    const task = this.db.put<Task>('task',taskId,0,{ goal: data.goal,profile: data.profile,...(data.modelRef ? { model: data.modelRef.modelId, provider: data.modelRef.providerId } : data.model ? { model: data.model } : {}),state: 'queued',runId: id(),instructionSequence: 1,plan: [],evidence: [],blocker: null },'task.created');
    this.db.put('policy',taskId,0,{ mode: data.mode });
    this.db.put('message',id(),0,{ taskId,author: 'owner',text: data.goal,sequence: 1 },'instruction.accepted');
    this.db.enqueue('task.run',{ taskId,runId: task.data.runId, ...(data.modelRef ? { modelRef: data.modelRef } : {}) });
    return task;
  }
  steer(taskId: string, expected: number, text: string, selection?: ModelRef) {
    z.string().trim().min(1).max(20000).parse(text);
    const task = this.db.need<Task>('task',taskId); requireThat(!terminal.has(task.data.state),'terminal_task');
    const modelRef = selection ? ModelRef.parse(selection) : task.data.provider && task.data.model ? { providerId: task.data.provider, modelId: task.data.model } : undefined;
    const sequence = task.data.instructionSequence + 1;
    const updated = this.db.put('task',taskId,expected,{ ...task.data,instructionSequence: sequence,
      ...(modelRef ? { provider: modelRef.providerId, model: modelRef.modelId } : {}) },'task.steered');
    this.db.put('message',id(),0,{ taskId,author: 'owner',text,sequence, ...(modelRef ? { modelRef } : {}) },'instruction.accepted');
    this.db.enqueue('task.steer',{ taskId,sequence,text, ...(modelRef ? { modelRef } : {}) }); return updated;
  }
  control(taskId: string, expected: number, intent: 'pause' | 'cancel' | 'resume') {
    const task = this.db.need<Task>('task',taskId);
    requireThat(!terminal.has(task.data.state),'terminal_task');
    if (intent === 'resume') requireThat(['paused','interrupted','failed','waiting_for_capacity'].includes(task.data.state),'invalid_transition');
    const state = intent === 'pause' ? 'paused' : intent === 'cancel' ? 'cancelled' : 'queued';
    const updated = this.db.put('task',taskId,expected,{ ...task.data,state,runId: intent === 'resume' ? id() : task.data.runId,blocker: null },`task.${intent}`);
    this.db.enqueue(`task.${intent}`,{ taskId,runId: task.data.runId }); return updated;
  }
  claim(taskId: string, workerId: string) {
    return this.db.transaction(() => {
      const task = this.db.need<Task>('task',taskId); requireThat(task.data.state === 'queued','already_claimed');
      this.db.put('run',task.data.runId,0,{ taskId,workerId,state: 'running',startedAt: Date.now() });
      return this.db.put('task',taskId,task.revision,{ ...task.data,state: 'running' },'run.started');
    });
  }
  checkpoint(taskId: string, expected: number, plan: Task['plan'], evidence: string[]) {
    const task = this.db.need<Task>('task',taskId); requireThat(!terminal.has(task.data.state),'terminal_task');
    this.db.put('checkpoint',id(),0,{ taskId,runId: task.data.runId,plan,evidence,instructionSequence: task.data.instructionSequence });
    return this.db.put('task',taskId,expected,{ ...task.data,plan,evidence });
  }
  prepareMaintenance() {
    return this.db.transaction(() => {
      requireThat(!this.db.list<Task>('task').some(task => ['running','queued'].includes(task.data.state)), 'maintenance_tasks_active');
      requireThat(!this.db.list('action').some(action => action.data.state === 'dispatching'), 'maintenance_actions_active');
      requireThat(!['message','tool_stream'].some(kind => this.db.list(kind).some(row => row.data.streaming)), 'maintenance_stream_active');
      requireThat(!this.db.db.prepare("SELECT 1 FROM outbox WHERE state IN ('pending','claimed','unknown') AND topic!='notice' LIMIT 1").get(), 'maintenance_work_unsettled');
      const previous = this.db.get('maintenance_checkpoint','server');
      requireThat(!previous || previous.data.state === 'completed', 'maintenance_already_prepared');
      const recovery = this.db.get('recovery','server');
      const checkpoint = this.db.put('maintenance_checkpoint','server',previous?.revision ?? 0,{
        state: 'prepared', expiresAt: Date.now() + 30 * 60 * 1000,
        tasks: this.db.list<Task>('task').filter(task => task.data.state === 'verifying').map(task => ({ id: task.id, revision: task.revision })),
        previousRecovery: recovery?.data ?? { dispatchEnabled: true },
      });
      this.db.put('recovery','server',recovery?.revision ?? 0,{ ...recovery?.data, dispatchEnabled: false, reason: 'Planned deployment checkpoint' });
      return checkpoint;
    });
  }
  finishMaintenance() {
    return this.db.transaction(() => {
      const checkpoint = this.db.need('maintenance_checkpoint','server');
      requireThat(checkpoint.data.state === 'restored', 'maintenance_not_restored');
      const recovery = this.db.need('recovery','server');
      requireThat(recovery.data.dispatchEnabled === false, 'maintenance_hold_changed');
      this.db.put('recovery','server',recovery.revision,z.record(z.string(),z.json()).parse(checkpoint.data.previousRecovery));
      return this.db.put('maintenance_checkpoint','server',checkpoint.revision,{ ...checkpoint.data,state: 'completed' });
    });
  }
  recover() {
    return this.db.transaction(() => {
      const checkpoint = this.db.get('maintenance_checkpoint','server');
      const preserved = new Set<string>();
      if (checkpoint && ['prepared','restored'].includes(String(checkpoint.data.state))) {
        requireThat(this.db.get('recovery','server')?.data.dispatchEnabled === false && Number(checkpoint.data.expiresAt) > Date.now(), 'maintenance_checkpoint_invalid');
        const saved = z.array(z.object({ id: z.string(), revision: z.number() })).parse(checkpoint.data.tasks);
        for (const reference of saved) {
          const task = this.db.need<Task>('task',reference.id);
          requireThat(task.revision === reference.revision && task.data.state === 'verifying', 'maintenance_checkpoint_changed');
          preserved.add(task.id);
        }
        if (checkpoint.data.state === 'prepared') this.db.put('maintenance_checkpoint','server',checkpoint.revision,{ ...checkpoint.data,state: 'restored' });
      }
      const paused = retireLegacyApprovals(this.db);
      if (checkpoint && [...preserved].some(taskId => paused.has(taskId))) {
        const current = this.db.need('maintenance_checkpoint','server');
        const references = z.array(z.object({ id: z.string(), revision: z.number() })).parse(current.data.tasks);
        this.db.put('maintenance_checkpoint','server',current.revision,{ ...current.data,tasks: references.filter(task => !paused.has(task.id)) });
      }
      for (const task of this.db.list<Task>('task')) if (['running','verifying'].includes(task.data.state) && !preserved.has(task.id)) this.db.put('task',task.id,task.revision,{ ...task.data,state: 'interrupted',blocker: 'Worker restart: reconcile outstanding effects before resuming' },'run.interrupted');
    });
  }
}
