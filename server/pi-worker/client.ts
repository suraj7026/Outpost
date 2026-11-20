import { z } from 'zod';
import { managementError } from '../pi-management/contracts.js';
import { WorkerRequest } from './contracts.js';

export class WorkerClient {
  private endpoint: string;
  constructor(endpoint: string, private token: string) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
      || token.length < 32) throw managementError('invalid_worker_connection');
    this.endpoint = `${url.origin}/v1`;
  }
  async request(input: z.input<typeof WorkerRequest>): Promise<unknown> {
    const payload = JSON.stringify(WorkerRequest.parse(input));
    if (Buffer.byteLength(payload) > 1024 * 1024) throw managementError('worker_request_too_large');
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: payload });
    const chunks: Uint8Array[] = []; let length = 0;
    if (response.body) for await (const bytes of response.body) {
      length += bytes.byteLength;
      if (length > 2 * 1024 * 1024) throw managementError('worker_response_too_large');
      chunks.push(bytes);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) {
      const error = z.object({ error: z.string().regex(/^[a-z_]{1,80}$/) }).safeParse(value);
      throw managementError(error.success ? error.data.error : 'worker_request_failed');
    }
    return value;
  }
}
