import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const token = process.env.OUTPOST_HOST_TOKEN?.trim();
if (!token || token.length < 32) throw new Error('Host executor requires a strong authentication token');
const expected = createHash('sha256').update(`Bearer ${token}`).digest();
let running = 0;
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  if (request.method === 'GET' && request.url === '/health') {
    response.end(JSON.stringify({ ready: true, host: process.env.OUTPOST_HOST_NAME }));
    return;
  }
  const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
  if (!timingSafeEqual(actual, expected)) { response.writeHead(401).end('{"error":"unauthorized"}'); return; }
  if (request.method !== 'POST' || request.url !== '/execute') { response.writeHead(404).end('{}'); return; }
  if (running >= 2) { response.writeHead(429).end('{"error":"host_busy"}'); return; }
  try {
    const parts = [];
    let size = 0;
    for await (const part of request) {
      size += part.length;
      if (size > 65536) { response.writeHead(413).end('{}'); return; }
      parts.push(part);
    }
    const { command, timeoutMs = 30000, taskId } = JSON.parse(Buffer.concat(parts).toString());
    if (typeof command !== 'string' || !command || command.length > 32768 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 ||
        typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/.test(taskId)) {
      response.writeHead(400).end('{"error":"invalid_command"}'); return;
    }
    // Re-check after body parsing so concurrent requests cannot exceed the cap.
    if (running >= 2) { response.writeHead(429).end('{"error":"host_busy"}'); return; }
    running++;
    const started = Date.now();
    const commandDigest = createHash('sha256').update(command).digest('hex');
    console.log(JSON.stringify({ event: 'host.command.started', taskId, commandDigest, host: process.env.OUTPOST_HOST_NAME }));
    const child = spawn('/usr/bin/nsenter', [
      '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--root', '--wd',
      '--', '/bin/bash', '-lc', command,
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' } });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, outputLimitReached = false, settled = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const capture = (chunk, isError) => {
      const available = Math.max(0, 2 * 1024 * 1024 - bytes);
      bytes += chunk.length;
      if (isError) stderr += chunk.subarray(0, available).toString(); else stdout += chunk.subarray(0, available).toString();
      if (bytes > 2 * 1024 * 1024) { outputLimitReached = true; kill(); }
    };
    child.stdout.on('data', chunk => capture(chunk, false));
    child.stderr.on('data', chunk => capture(chunk, true));
    response.on('close', () => { if (!settled) kill(); });
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); kill(); running--;
      console.log(JSON.stringify({ event: 'host.command.finished', taskId, commandDigest, exitCode, signal, elapsedMs: Date.now() - started }));
      response.end(JSON.stringify({ host: process.env.OUTPOST_HOST_NAME, exitCode, signal, stdout, stderr: error ?? stderr, timedOut, outputLimitReached }));
    };
    child.on('error', error => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
  } catch { if (!response.headersSent) response.writeHead(400); response.end('{"error":"invalid_request"}'); }
});
server.requestTimeout = 15000;
server.listen(4319, '0.0.0.0');
