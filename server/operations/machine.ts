import { arch, cpus, freemem, totalmem, platform, release, uptime, hostname } from 'node:os';
import { z } from 'zod';
import { requireThat, digest } from '../core/contracts.js';
import type { Gate } from '../policy/trust.js';
import { execute } from '../processes/runner.js';
export function inventory() { return { hostname: hostname(),platform: platform(),release: release(),arch: arch(),cpus: cpus().length,totalMemory: totalmem(),freeMemory: freemem(),uptime: uptime(),enforcement: 'cooperative-development',hostRootQualified: false }; }
export const ServicePlan = z.strictObject({ unit: z.string().regex(/^outpost-task-[a-z0-9-]+\.service$/),verb: z.enum(['status','restart','stop']),machineId: z.string().min(1),reason: z.string().min(1).max(1000) });
export function adminPlan(input: unknown) {
  const plan = ServicePlan.parse(input);
  return { ...plan,argv: ['/usr/bin/systemctl',plan.verb,'--',plan.unit],digest: digest(plan),impact: plan.verb === 'status' ? 'Read service state' : 'Changes task-owned service availability',rollback: 'Restart the prior verified service revision; a command exit is not a health check' };
}
export function registerInventory(gate: Gate) {
  gate.register('system.inspect',{ version: 1,effects: ['machine.read'],parse: value => z.strictObject({}).parse(value),target: () => hostname(),execute: async () => inventory() });
}
export async function inspectService(unit: string, signal: AbortSignal) {
  const plan = adminPlan({ unit,verb: 'status',machineId: hostname(),reason: 'Health inspection' });
  requireThat(platform() === 'linux','ubuntu_required');
  return execute(plan.argv,'/tmp',signal,10000);
}
