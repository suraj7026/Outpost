import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Gate } from '../policy/trust.js';
import type { InferenceConfiguration } from '../models/inference.js';
import type { Workspace, Artifacts } from '../artifacts/files.js';
import { requireThat } from '../core/contracts.js';

const BrowserInput = z.strictObject({ task: z.string().min(1).max(20000),maxSteps: z.number().int().min(1).max(100).default(20) });
const BrowserOutput = z.strictObject({ done: z.boolean(),agent_reported_success: z.boolean().nullable(),result: z.string().nullable(),urls: z.array(z.string()),errors: z.array(z.string()),screenshots: z.array(z.string()),steps: z.number(),duration_seconds: z.number() });

/** Launches a local Python worker with bounded output and process-group cancellation. */
export function runBrowserWorker(python: string, request: Record<string,unknown>, signal: AbortSignal): Promise<z.infer<typeof BrowserOutput>> {
  requireThat(!signal.aborted,'cancelled');
  return new Promise((resolveResult,reject) => {
    const script = fileURLToPath(new URL('../browser-use/worker.py',import.meta.url));
    const child = spawn(python,[script],{ detached: true,stdio: ['pipe','pipe','pipe'],env: { PATH: '/usr/local/bin:/usr/bin:/bin',HOME: process.env.HOME ?? '/home/node',LANG: 'C.UTF-8',ANONYMIZED_TELEMETRY: 'false' } });
    let stdout = '', stderr = '', bytes = 0;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* Already exited. */ } } };
    const timer = setTimeout(kill,300000);
    signal.addEventListener('abort',kill,{ once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort',kill); kill(); };
    child.stdout.on('data',(chunk: Buffer) => { bytes += chunk.length; if (bytes > 4*1024*1024) kill(); else stdout += chunk.toString(); });
    child.stderr.on('data',(chunk: Buffer) => { stderr = (stderr+chunk.toString()).slice(-8000); });
    child.stdin.on('error',() => { /* Exit handling reports worker failures. */ });
    child.on('error',error => { cleanup(); reject(error); });
    child.on('close',code => {
      cleanup();
      if (code !== 0 || signal.aborted) { reject(new Error(`Browser worker stopped (${code}): ${stderr.slice(-2000)}`)); return; }
      try { resolveResult(BrowserOutput.parse(JSON.parse(stdout))); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function registerBrowserUse(gate: Gate, python: string, inference: InferenceConfiguration, workspace: Workspace, artifacts: Artifacts, taskId: string) {
  gate.register('browser.run',{
    version: 1,effects: ['unknown'],parse: input => BrowserInput.parse(input),target: () => 'self-hosted Chromium',
    execute: async (args,signal) => {
      const input = BrowserInput.parse(args);
      const result = await runBrowserWorker(python,{ task: input.task,max_steps: input.maxSteps,model: inference.model,base_url: inference.baseUrl,directory: workspace.root,vision: inference.vision },signal);
      const artifactIds: string[] = [];
      for (const screenshot of result.screenshots) {
        const path = resolve(screenshot), rel = relative(workspace.root,path);
        requireThat(rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'),'browser_artifact_escape');
        artifactIds.push(artifacts.publish(taskId,`browser-${artifactIds.length+1}.png`,'image/png',readFileSync(path)).id);
      }
      const evidence = artifacts.publish(taskId,'browser-result.json','application/json',Buffer.from(JSON.stringify(result,null,2)));
      return { ...result,artifactIds: [...artifactIds,evidence.id] };
    },
  });
}
