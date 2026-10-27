import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ledger } from '../core/ledger.js';
import { digest, requireThat } from '../core/contracts.js';
import { execute } from '../processes/runner.js';
export const Manifest = z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]+$/),version: z.string().min(1),source: z.url(),license: z.string().min(1),executable: z.string().startsWith('/'),sha256: z.string().regex(/^[a-f0-9]{64}$/),permissions: z.array(z.string()),destinations: z.array(z.string()),probe: z.array(z.string()).max(20),tools: z.array(z.string()).min(1) });
export type Manifest = z.infer<typeof Manifest>;
export class Capabilities {
  constructor(private db: Ledger) {}
  stage(input: unknown) {
    const manifest = Manifest.parse(input), previous = this.db.get<{ manifest: Manifest }>('capability',manifest.name);
    const oldScope = new Set([...(previous?.data.manifest.permissions ?? []),...(previous?.data.manifest.destinations ?? [])]);
    const expanded = [...manifest.permissions,...manifest.destinations].filter(scope => !oldScope.has(scope));
    return this.db.put('capability_candidate',manifest.name,this.db.get('capability_candidate',manifest.name)?.revision ?? 0,{ manifest,expanded,hash: digest(manifest),state: 'staged' });
  }
  async probe(name: string) {
    const candidate = this.db.need<{ manifest: Manifest; hash: string }>('capability_candidate',name), manifest = candidate.data.manifest;
    requireThat(createHash('sha256').update(readFileSync(manifest.executable)).digest('hex') === manifest.sha256,'executable_changed');
    const result = await execute([manifest.executable,...manifest.probe],'/tmp',new AbortController().signal,10000);
    requireThat(result.exitCode === 0 && !result.timedOut && !result.outputLimitReached,'probe_failed');
    return this.db.put('capability_probe',name,this.db.get('capability_probe',name)?.revision ?? 0,{ hash: candidate.data.hash,passedAt: Date.now(),result });
  }
  activate(name: string, approvedHash: string, expected: number) {
    const candidate = this.db.need<{ manifest: Manifest; hash: string }>('capability_candidate',name);
    const probe = this.db.need<{ hash: string; passedAt: number }>('capability_probe',name);
    requireThat(candidate.data.hash === approvedHash && probe.data.hash === approvedHash && Date.now()-probe.data.passedAt < 300000,'unverified_capability');
    requireThat(createHash('sha256').update(readFileSync(candidate.data.manifest.executable)).digest('hex') === candidate.data.manifest.sha256,'executable_changed');
    return this.db.put('capability',name,expected,{ manifest: candidate.data.manifest,state: 'ready',hash: approvedHash });
  }
}
