import { z } from 'zod';
import { Mode, RunState, id, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';

export const NewTask = z.strictObject({ goal: z.string().trim().min(1).max(20000), profile: z.enum(['code','browser','operations','research','cowork','chat']), mode: Mode.default('ask_permission') });
export interface Task { goal: string; profile: string; state: z.infer<typeof RunState>; runId: string; instructionSequence: number; plan: { title: string; state: string }[]; evidence: string[]; blocker: string | null }
const terminal = new Set(['cancelled','completed']);
export class Tasks {
  constructor(readonly db: Ledger) {}
  create(taskId: string, input: unknown) {
    const data = NewTask.parse(input);
    const task = this.db.put<Task>('task',taskId,0,{ goal: data.goal,profile: data.profile,state: 'queued',runId: id(),instructionSequence: 1,plan: [],evidence: [],blocker: null },'task.created');
    this.db.put('policy',taskId,0,{ mode: data.mode });
    this.db.put('message',id(),0,{ taskId,author: 'owner',text: data.goal,sequence: 1 },'instruction.accepted');
    this.db.enqueue('task.run',{ taskId,runId: task.data.runId });
    return task;
  }
  steer(taskId: string, expected: number, text: string) {
    z.string().trim().min(1).max(20000).parse(text);
    const task = this.db.need<Task>('task',taskId); requireThat(!terminal.has(task.data.state),'terminal_task');
    const sequence = task.data.instructionSequence + 1;
    const updated = this.db.put('task',taskId,expected,{ ...task.data,instructionSequence: sequence },'task.steered');
    this.db.put('message',id(),0,{ taskId,author: 'owner',text,sequence },'instruction.accepted');
    this.db.enqueue('task.steer',{ taskId,sequence,text }); return updated;
  }
  control(taskId: string, expected: number, intent: 'pause' | 'cancel' | 'resume') {
    const task = this.db.need<Task>('task',taskId);
    requireThat(!terminal.has(task.data.state),'terminal_task');
    if (intent === 'resume') requireThat(['paused','interrupted','failed','waiting_for_capacity'].includes(task.data.state),'invalid_transition');
    const state = intent === 'pause' ? 'paused' : intent === 'cancel' ? 'cancelled' : 'queued';
    const updated = this.db.put('task',taskId,expected,{ ...task.data,state,blocker: null },`task.${intent}`);
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
  recover() {
    return this.db.transaction(() => {
      for (const task of this.db.list<Task>('task')) if (['running','verifying'].includes(task.data.state)) this.db.put('task',task.id,task.revision,{ ...task.data,state: 'interrupted',blocker: 'Worker restart: reconcile outstanding effects before resuming' },'run.interrupted');
    });
  }
}
