import { spawn } from 'node:child_process';
import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
import type { Gate } from '../policy/trust.js';
import { Workspace } from '../artifacts/files.js';
export const CommandInput = z.strictObject({ argv: z.array(z.string().max(8192)).min(1).max(128), cwd: z.string().default('.'), timeoutMs: z.number().int().min(100).max(300000).default(30000) });
export interface CommandResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputLimitReached: boolean }
export async function execute(argv: string[], cwd: string, signal: AbortSignal, timeoutMs = 30000, outputLimit = 2*1024*1024): Promise<CommandResult> {
  requireThat(argv.length > 0 && argv[0]?.startsWith('/'),'absolute_executable_required');
  requireThat(!signal.aborted,'cancelled');
  return new Promise((resolve,reject) => {
    const child = spawn(argv[0]!,argv.slice(1),{ cwd,env: { PATH: '/usr/local/bin:/usr/bin:/bin',HOME: cwd,LANG: 'C.UTF-8' },detached: true,stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, cancelled = false, outputLimitReached = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (name: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid,name); } catch { /* Process group already exited. */ } } };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'),500); };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); },timeoutMs);
    signal.addEventListener('abort',abort,{ once: true });
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort',abort); };
    const capture = (chunk: Buffer, error: boolean) => {
      const available = Math.max(0,outputLimit-bytes); bytes += chunk.length;
      const text = chunk.subarray(0,available).toString('utf8'); if (error) stderr += text; else stdout += text;
      if (bytes > outputLimit) { outputLimitReached = true; stop(); }
    };
    child.stdout.on('data',(chunk: Buffer) => capture(chunk,false)); child.stderr.on('data',(chunk: Buffer) => capture(chunk,true));
    child.on('error',error => { cleanup(); reject(error); });
    child.on('close',(exitCode,exitSignal) => { kill('SIGKILL'); cleanup(); resolve({ exitCode,signal: exitSignal,stdout,stderr,timedOut,cancelled,outputLimitReached }); });
  });
}
export function registerCommands(gate: Gate, workspace: Workspace, executables: Set<string>) {
  gate.register('command.run',{ version: 1,effects: ['unknown'],parse: value => CommandInput.parse(value),target: args => `workspace:${String(args.cwd)}`,
    execute: async (args,signal) => {
      const input = CommandInput.parse(args); requireThat(executables.has(input.argv[0]!), 'executable_not_enrolled');
      const cwd = input.cwd === '.' ? workspace.root : workspace.path(input.cwd);
      return { ...await execute(input.argv,cwd,signal,input.timeoutMs) };
    } });
}
