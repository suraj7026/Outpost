import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ManagementError } from '../pi-management/contracts.js';
import { ProviderManagement } from '../pi-management/providers.js';
import { WorkerRequest } from './contracts.js';
import { WorkerRuns } from './runs.js';

/** Internal loopback service. No CORS, public ingress, or unauthenticated management routes. */
export function workerServer(management: ProviderManagement, runs: WorkerRuns, token: string) {
  management.runsActive = () => runs.active;
  if (token.length < 32) throw new Error('worker_token_required');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
    try {
      if (!timingSafeEqual(expected, createHash('sha256').update(request.headers.authorization ?? '').digest())) {
        response.writeHead(401).end(JSON.stringify({ error: 'worker_authentication_required' })); return;
      }
      if (request.method !== 'POST' || request.url !== '/v1') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      const input = WorkerRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      let result: unknown;
      switch (input.type) {
        case 'management': result = await management.request(input.owner, input.request); break;
        case 'run.start': result = runs.start(input); break;
        case 'run.poll': result = runs.poll(input.runId, input.after); break;
        case 'run.abort': result = await runs.abort(input.runId); break;
        case 'run.steer': result = await runs.steer(input.runId, input.text); break;
        case 'run.action-result': result = runs.answer(input.runId, input.callId, input.result, input.failed); break;
      }
      response.end(JSON.stringify(result));
    } catch (error) {
      // SDK and third-party exceptions can contain credentials or callback codes.
      response.writeHead(400).end(JSON.stringify({ error: error instanceof ManagementError ? error.code : 'worker_request_failed' }));
    }
  });
}
