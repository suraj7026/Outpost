import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
import type { Gate } from '../policy/trust.js';

export const HostCommand = z.strictObject({
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  command: z.string().min(1).max(32768).regex(/^[^\0]*$/),
  timeoutMs: z.number().int().min(100).max(300000).default(30000),
});
export interface HostAdministration { token: string; endpoints: Record<string,string> }

export function hostAdministrationFromEnvironment(env: NodeJS.ProcessEnv): HostAdministration | undefined {
  const endpoints: unknown = env.OUTPOST_HOST_ENDPOINTS ? JSON.parse(env.OUTPOST_HOST_ENDPOINTS) :
    env.OUTPOST_HOST_MAIN && env.OUTPOST_HOST_WORKER ? { surajhomeserver: env.OUTPOST_HOST_MAIN,surajhomeserver2: env.OUTPOST_HOST_WORKER } : undefined;
  if (!endpoints) {
    requireThat(!env.OUTPOST_HOST_ENDPOINTS && !env.OUTPOST_HOST_MAIN && !env.OUTPOST_HOST_WORKER && !env.OUTPOST_HOST_TOKEN_FILE && !env.OUTPOST_HOST_TOKEN,'incomplete_host_configuration');
    return undefined;
  }
  const token = (env.OUTPOST_HOST_TOKEN_FILE ? readFileSync(env.OUTPOST_HOST_TOKEN_FILE,'utf8') : env.OUTPOST_HOST_TOKEN)?.trim();
  requireThat(token && token.length >= 32,'host_token_required');
  const parsed = z.record(HostCommand.shape.host,z.string().url().refine(value => {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  }).transform(value => value.replace(/\/$/,''))).parse(endpoints);
  requireThat(Object.keys(parsed).length > 0,'host_endpoints_required');
  return { token,endpoints: parsed };
}

/** Exposes owner-authorized root execution; this is deliberately not a command allowlist. */
export function registerHosts(gate: Gate, configuration: HostAdministration, taskId: string) {
  const names = Object.keys(configuration.endpoints);
  requireThat(names.length > 0,'host_endpoints_required');
  const command = HostCommand.extend({ host: z.enum(names) });
  gate.register('host.execute',{
    version: 1,effects: ['host.execute'],inputSchema: z.toJSONSchema(command),description: 'Executes a shell command as root on the specified enrolled host through the coordinator validation/evidence gate. Full host filesystem, Docker, system services and installed tools are available, subject to host configuration. No sudo is required here. The local host, when listed, is this environment’s server. Preserve unrelated workloads.',parse: input => command.parse(input),
    target: args => `root@${String(args.host)}`,
    execute: async (args,signal) => {
      const input = command.parse(args);
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
