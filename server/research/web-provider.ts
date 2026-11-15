import { WebResearchError, webAbortable, webRequire } from './web-contracts.js';
import type { WebProvider, WebRequest, WebScope } from './web-contracts.js';

/** Fixed Cloud endpoint: no local-model inference or credential fallback. Keys are supplied
 * by the parent account credential owner, never read from Pi auth files or environment here.
 */
export class OllamaWebProvider implements WebProvider {
  constructor(
    private credential: (scope: Readonly<WebScope>, signal: AbortSignal) => Promise<string>,
    private http: typeof fetch = fetch,
    private maxResponseBytes = 256 * 1024,
    private timeoutMs = 15_000,
  ) {
    webRequire(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'invalid_provider_limits');
  }
  async request(scope: Readonly<WebScope>, request: WebRequest, callerSignal: AbortSignal): Promise<{ status: number; data: unknown }> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      webRequire(!signal.aborted, 'cancelled');
      const key = await webAbortable(this.credential(scope, signal), signal);
      webRequire(typeof key === 'string' && key.length > 0 && !/[\r\n]/.test(key), 'credential_unavailable');
      webRequire(!signal.aborted, 'cancelled');
      const response = await webAbortable(this.http(`https://ollama.com/api/web_${request.kind}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request.kind === 'search' ? { query: request.query, max_results: request.maxResults } : { url: request.url }),
      }), signal);
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); return { status: response.status, data: null }; }
      webRequire(response.body, 'invalid_provider_response');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          webRequire(!signal.aborted, 'cancelled');
          const { done, value } = await webAbortable(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          webRequire(size <= this.maxResponseBytes, 'response_too_large');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => undefined); }
      webRequire(!signal.aborted, 'cancelled');
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WebResearchError('invalid_provider_response'); }
      return { status: response.status, data };
    } catch (error) {
      if (signal.aborted) throw new WebResearchError('cancelled');
      if (error instanceof WebResearchError) throw error;
      throw new WebResearchError('provider_transport_failed');
    }
  }
}
