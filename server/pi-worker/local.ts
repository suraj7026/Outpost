import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WorkerClient } from './client.js';
import type { InferenceConfiguration } from '../models/inference.js';

export async function startLocalWorker(root: string, workspaceRoot: string, shared: boolean, inference?: InferenceConfiguration) {
  const token = randomBytes(32).toString('hex');
  const env = Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'TMPDIR', 'TEMP', 'LANG', 'OLLAMA_API_KEY']
    .map(key => [key, process.env[key]]));
  const child = fork(fileURLToPath(new URL('./main.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...env, PI_CODING_AGENT_DIR: join(root, 'pi-worker', 'profile'),
      OUTPOST_PI_WORKSPACES: workspaceRoot, OUTPOST_PI_SESSIONS: join(root, 'pi-worker', 'sessions'),
      OUTPOST_WORKSPACE_SHARED: String(shared), OUTPOST_PI_LOCAL_TOKEN: token,
      ...(inference ? { OUTPOST_PI_LOCAL_INFERENCE: JSON.stringify(inference) } : {}) },
  });
  let ready = false;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local Pi worker startup timed out')), 15000);
      child.on('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (ready) console.error('Local Pi worker exited:', code ?? signal);
        else reject(new Error(`Local Pi worker exited before startup (${code ?? signal})`));
      });
      child.once('message', message => {
        clearTimeout(timer);
        if (typeof message !== 'number' || !Number.isInteger(message) || message < 1 || message > 65535)
          reject(new Error('Local Pi worker returned an invalid port'));
        else resolve(message);
      });
    });
    ready = true;
    return { worker: new WorkerClient(`http://127.0.0.1:${port}`, token), close: () => child.kill('SIGTERM') };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
