import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { InferenceConfiguration } from '../models/inference.js';
import { PiProfile } from '../pi-management/profile.js';
import { runtimeRelease } from '../pi-management/runtime-release.js';
import { ProviderManagement } from '../pi-management/providers.js';
import { WorkerRuns } from './runs.js';
import { workerServer } from './http.js';

function required(name: string) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`An absolute ${name} is required`);
  return value;
}
if (process.getuid?.() === 0) throw new Error('Pi worker must run as a non-root user');
for (const key of ['OUTPOST_HOST_TOKEN','OUTPOST_PAIRING_TOKEN','APNS_KEY_FILE']) {
  if (process.env[key]) throw new Error('Coordinator secrets must not be supplied to the Pi worker');
}
const directory = required('PI_CODING_AGENT_DIR');
const localToken = process.send ? process.env.OUTPOST_PI_LOCAL_TOKEN : undefined;
const legacyInference = localToken ? process.env.OUTPOST_PI_LOCAL_INFERENCE : undefined;
delete process.env.OUTPOST_PI_LOCAL_TOKEN;
delete process.env.OUTPOST_PI_LOCAL_INFERENCE;
const releaseId = localToken ? 'local-dev' : runtimeRelease(required('OUTPOST_PI_RELEASE_FILE'), directory).id;
const profile = new PiProfile(directory, releaseId);
if (legacyInference) {
  const { baseUrl, model, contextWindow, maxTokens } = InferenceConfiguration.parse(JSON.parse(legacyInference));
  await profile.migrateLegacyOllama({ providerId: 'outpost-ollama', baseUrl, api: 'openai-completions',
    allowInsecureHttp: true, models: [{ id: model, name: model, contextWindow, maxTokens }] }, model);
}
const management = new ProviderManagement(profile);
const runs = new WorkerRuns(profile, required('OUTPOST_PI_WORKSPACES'), required('OUTPOST_PI_SESSIONS'), process.env.OUTPOST_WORKSPACE_SHARED === 'true');
const token = localToken ?? readFileSync(required('OUTPOST_PI_WORKER_TOKEN_FILE'), 'utf8').trim();
const server = workerServer(management, runs, token);
server.requestTimeout = 20000; server.headersTimeout = 10000;
server.listen(localToken ? 0 : Number(process.env.OUTPOST_PI_WORKER_PORT ?? 4320), '127.0.0.1', () => {
  const address = server.address();
  if (localToken && address && typeof address !== 'string') process.send?.(address.port);
  console.log(`Outpost Pi worker ready; Pi ${profile.version}; release ${releaseId}; management protocol 1`);
});
let closing = false;
function close() {
  if (closing) return; closing = true;
  management.close();
  void runs.close().then(
      () => server.close(() => process.exit(0)),
      () => { console.error('Native extension work did not confirm shutdown; retained session receipts require reconciliation.'); server.close(() => process.exit(1)); },
    );
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, close);
if (localToken) process.once('disconnect', close);
