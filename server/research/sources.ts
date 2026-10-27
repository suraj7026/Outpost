import { createHash } from 'node:crypto';
import { id, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
interface Source { taskId: string; url: string; title: string; text: string; hash: string; capturedAt: string; provenance: 'external_untrusted' }
export async function boundedFetch(url: string, enrolledOrigins: Set<string>, limit = 2*1024*1024) {
  const parsed = new URL(url); requireThat(enrolledOrigins.has(parsed.origin) && !parsed.username && !parsed.password,'source_not_enrolled');
  const response = await fetch(url,{ redirect: 'error',signal: AbortSignal.timeout(15000) });
  requireThat(response.ok,'source_unavailable'); requireThat(response.body,'empty_source');
  const chunks: Buffer[] = []; let length = 0;
  const reader = response.body.getReader();
  try { for (;;) { const { value,done } = await reader.read(); if (done) break; length += value.length; requireThat(length <= limit,'source_too_large'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export class Sources {
  constructor(private db: Ledger) {}
  capture(taskId: string, url: string, title: string, text: string) {
    requireThat(['https:','http:'].includes(new URL(url).protocol) && text.length <= 2*1024*1024,'invalid_source');
    return this.db.put<Source>('source',id(),0,{ taskId,url,title,text,hash: createHash('sha256').update(text).digest('hex'),capturedAt: new Date().toISOString(),provenance: 'external_untrusted' });
  }
  cite(sourceId: string, taskId: string, quote: string, claim: string, interpretation: 'observation' | 'inference') {
    const source = this.db.need<Source>('source',sourceId);
    requireThat(source.data.taskId === taskId && quote.length > 0 && source.data.text.includes(quote),'unsupported_citation');
    return this.db.put('citation',id(),0,{ sourceId,sourceHash: source.data.hash,taskId,quote,claim,interpretation });
  }
}
