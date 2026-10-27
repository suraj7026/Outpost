import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Ledger } from './core/ledger.js';
import { Coordinator } from './gateway/coordinator.js';
import { httpServer } from './gateway/http.js';
const root = resolve(process.env.OUTPOST_DATA ?? '.outpost');
const db = new Ledger(join(root,'ledger.sqlite'));
const roles = process.env.OUTPOST_ROLES_FILE ? JSON.parse(readFileSync(process.env.OUTPOST_ROLES_FILE,'utf8')) as unknown : undefined;
const coordinator = new Coordinator(db,root,{ ...(process.env.OLLAMA_API_KEY ? { apiKey: process.env.OLLAMA_API_KEY } : {}),...(roles ? { roles } : {}),executables: (process.env.OUTPOST_EXECUTABLES ?? '').split(':').filter(Boolean) });
const server = httpServer(coordinator,process.env.OUTPOST_PAIRING_TOKEN ?? '');
let draining = false;
const timer = setInterval(() => {
  if (draining) return; draining = true;
  coordinator.scheduler.tick();
  void coordinator.drain().finally(() => { draining = false; });
},500);
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 4318),'127.0.0.1',() => console.log('Outpost development coordinator: http://127.0.0.1:4318 (loopback only)'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); });
