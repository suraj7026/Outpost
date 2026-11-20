import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Ledger } from './core/ledger.js';
import { formatErrorForLog } from './core/contracts.js';
import { Coordinator } from './gateway/coordinator.js';
import { httpServer } from './gateway/http.js';
import { Notifications } from './notifier/apns.js';
import type { APNsConfig } from './notifier/apns.js';
import { InferenceConfiguration } from './models/inference.js';
import { WorkerClient } from './pi-worker/client.js';
import { EnvironmentOptions } from './environment/contracts.js';
import { hostAdministrationFromEnvironment } from './operations/hosts.js';
const root = resolve(process.env.OUTPOST_DATA ?? '.outpost');
const db = new Ledger(join(root,'ledger.sqlite'));
const roles = process.env.OUTPOST_ROLES_FILE ? JSON.parse(readFileSync(process.env.OUTPOST_ROLES_FILE,'utf8')) as unknown : undefined;
const inference = process.env.OUTPOST_OLLAMA_MODEL ? InferenceConfiguration.parse({ baseUrl: process.env.OUTPOST_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',model: process.env.OUTPOST_OLLAMA_MODEL }) : undefined;
const hosts = hostAdministrationFromEnvironment(process.env);
const worker = process.env.OUTPOST_PI_WORKER_URL ? new WorkerClient(process.env.OUTPOST_PI_WORKER_URL,
  readFileSync(process.env.OUTPOST_PI_WORKER_TOKEN_FILE ?? '', 'utf8').trim()) : undefined;
const allowLegacy = process.env.OUTPOST_ALLOW_LEGACY_PROTOCOL;
if (allowLegacy !== undefined && allowLegacy !== 'true' && allowLegacy !== 'false') {
  throw new Error('OUTPOST_ALLOW_LEGACY_PROTOCOL must be true or false');
}
const environment = EnvironmentOptions.parse({
  label: process.env.OUTPOST_ENVIRONMENT_LABEL,
  runtimeRelease: process.env.OUTPOST_RUNTIME_RELEASE,
  allowLegacyProtocol: allowLegacy !== 'false',
});
const coordinator = new Coordinator(db,root,{
  environment,
  ...(process.env.OUTPOST_WORKSPACE_ROOT ? { workspaceRoot: resolve(process.env.OUTPOST_WORKSPACE_ROOT), sharedWorkspaces: true } : {}),
  ...(worker ? { worker } : {}),
  ...(process.env.OLLAMA_API_KEY ? { apiKey: process.env.OLLAMA_API_KEY } : {}),...(roles ? { roles } : {}),
  ...(inference ? { inference } : {}),...(hosts ? { hosts } : {}),
  ...(process.env.OUTPOST_BROWSER_ENABLED === 'true' ? { browser: {
    ...(process.env.OUTPOST_CAMOUFOX_PYTHON ? { python: process.env.OUTPOST_CAMOUFOX_PYTHON } : {}),
  } } : {}),
  unrestrictedCommands: process.env.OUTPOST_FULL_CONTROL === 'true',
  executables: (process.env.OUTPOST_EXECUTABLES ?? '').split(':').filter(Boolean),
});
const server = httpServer(coordinator,(process.env.OUTPOST_PAIRING_TOKEN ?? '').trim());
const notifier = new Notifications(db);
const apns: APNsConfig | undefined = process.env.APNS_KEY_FILE && process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_TOPIC ? {
  privateKeyPEM: readFileSync(process.env.APNS_KEY_FILE,'utf8'),teamId: process.env.APNS_TEAM_ID,keyId: process.env.APNS_KEY_ID,topic: process.env.APNS_TOPIC,environment: process.env.APNS_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
} : undefined;
let draining = false;
const timer = setInterval(() => {
  void coordinator.maintenance.advance().catch(error =>
    console.error('Maintenance hold needs reconciliation:', formatErrorForLog(error)),
  );
  if (draining || !coordinator.dispatchEnabled) return; draining = true;
  void Promise.resolve().then(async () => {
    if (!coordinator.maintenance.holding) coordinator.scheduler.tick();
    await coordinator.drain();
    if (apns) for (const notice of db.list('inbox').filter(row => row.data.state === 'pending').slice(0,20)) await notifier.deliver(notice.id,apns);
  }).catch(error =>
    console.error('Background work needs inspection:', formatErrorForLog(error)),
  ).finally(() => { draining = false; });
},500);
const compactionTimer = setInterval(() => {
  if (coordinator.maintenance.holding) return;
  try { db.compact(); }
  catch (error) { console.error('Ledger compaction needs inspection:', formatErrorForLog(error)); }
}, 60 * 60 * 1000);
compactionTimer.unref();
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 4318),'127.0.0.1',() => console.log(`Outpost coordinator: http://127.0.0.1:${process.env.PORT ?? 4318} (loopback only); inference=${inference?.model ?? 'legacy/unconfigured'}; host administration=${!!hosts}`));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => {
  clearInterval(timer); clearInterval(compactionTimer); coordinator.live.close();
  const finish = () => server.close(() => { db.close(); process.exit(0); });
  void coordinator.close().finally(finish);
});
