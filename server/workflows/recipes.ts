import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { id, requireThat } from '../core/contracts.js';
const Step = z.strictObject({ key: z.string().min(1),title: z.string().min(1),dependsOn: z.array(z.string()),effect: z.enum(['read','prepare','submit','payment','physical']),state: z.enum(['pending','running','waiting','verified','failed','unknown']).default('pending'),evidence: z.array(z.string()).default([]) });
export const Recipe = z.strictObject({ title: z.string().min(1),taskId: z.string(),identityId: z.string(),steps: z.array(Step).min(1).max(100) });
export type Recipe = z.infer<typeof Recipe>;
export class Workflows {
  constructor(private db: Ledger) {}
  prepare(input: unknown) {
    const recipe = Recipe.parse(input), keys = new Set(recipe.steps.map(step => step.key));
    requireThat(keys.size === recipe.steps.length,'duplicate_step');
    const visited = new Set<string>(), active = new Set<string>();
    const visit = (key: string) => { requireThat(!active.has(key),'cyclic_workflow'); if (visited.has(key)) return; const step = recipe.steps.find(step => step.key === key); requireThat(step,'missing_dependency'); active.add(key); step.dependsOn.forEach(visit); active.delete(key); visited.add(key); };
    keys.forEach(visit); return this.db.put('workflow',id(),0,{ ...recipe,state: 'prepared' });
  }
  ready(workflowId: string) {
    const workflow = this.db.need<Recipe>('workflow',workflowId).data;
    return workflow.steps.filter(step => step.state === 'pending' && step.dependsOn.every(key => workflow.steps.find(step => step.key === key)?.state === 'verified'));
  }
  verify(workflowId: string, expected: number, key: string, evidence: string[]) {
    requireThat(evidence.length > 0,'evidence_required');
    const workflow = this.db.need<Recipe>('workflow',workflowId);
    requireThat(this.ready(workflowId).some(step => step.key === key),'step_not_ready');
    evidence.forEach(artifactId => requireThat(this.db.need('artifact',artifactId).data.taskId === workflow.data.taskId,'evidence_scope'));
    const steps = workflow.data.steps.map(step => step.key === key ? { ...step,state: 'verified' as const,evidence } : step);
    return this.db.put('workflow',workflowId,expected,{ ...workflow.data,steps,state: steps.every(step => step.state === 'verified') ? 'verified' : 'running' });
  }
}
