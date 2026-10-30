import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
import type { Gate } from '../policy/trust.js';

export const HostCommand = z.strictObject({
  host: z.enum(['surajhomeserver','surajhomeserver2']),
  command: z.string().min(1).max(32768),
  timeoutMs: z.number().int().min(100).max(300000).default(30000),
});
export interface HostAdministration { token: string; endpoints: Record<z.infer<typeof HostCommand>['host'],string> }

/** Exposes owner-authorized root execution; this is deliberately not a command allowlist. */
export function registerHosts(gate: Gate, configuration: HostAdministration, taskId: string) {
  gate.register('host.execute',{
    version: 1,effects: ['host.execute'],parse: input => HostCommand.parse(input),
    target: args => `root@${String(args.host)}`,
    execute: async (args,signal) => {
      const input = HostCommand.parse(args);
      const response = await fetch(`${configuration.endpoints[input.host]}/execute`,{
        method: 'POST',redirect: 'error',signal: AbortSignal.any([signal,AbortSignal.timeout(input.timeoutMs+10000)]),
        headers: { authorization: `Bearer ${configuration.token}`,'content-type': 'application/json' },
        body: JSON.stringify({ command: input.command,timeoutMs: input.timeoutMs,taskId }),
      });
      requireThat(response.ok,'host_executor_unavailable');
      return z.json().parse(await response.json());
    },
  });
}
