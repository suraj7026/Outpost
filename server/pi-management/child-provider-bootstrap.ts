import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from '@earendil-works/pi-coding-agent';

/** A native child imports this private module before model resolution; credentials only cross a local socket. */
export async function createChildProviderBootstrap(options: {
  directory: string; sessionId: string; providerId: string; configuration: ProviderConfig; apiKey: string;
}) {
  const { registerRequiredChildExtensions } = await import('pi-subagents/required-child-extensions');
  const directory = join(options.directory, '.native-child-provider', options.sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  // Unix socket paths have a small platform limit. Keep the socket in a separate private short directory.
  const tempRoot = tmpdir();
  const socketDirectory = mkdtempSync(join(tempRoot.length > 60 ? '/tmp' : tempRoot, 'op-provider-'));
  chmodSync(socketDirectory, 0o700);
  const socketPath = join(socketDirectory, 's'), token = randomBytes(32).toString('hex');
  const modulePath = join(directory, 'provider.mjs'), staging = `${modulePath}.${token}.tmp`;
  const connections = new Set<Socket>();
  const server = createServer(socket => {
    connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let request = '';
    socket.on('data', chunk => {
      request += chunk.toString('utf8');
      if (request.length > 256) { socket.destroy(); return; }
      if (!request.includes('\n')) return;
      if (request.trim() !== token) { socket.destroy(); return; }
      socket.end(JSON.stringify({ providerId: options.providerId, configuration: options.configuration, apiKey: options.apiKey }) + '\n');
    });
  });
  let registration: { dispose(): void } | undefined;
  const close = async () => {
    registration?.dispose();
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(socketDirectory, { recursive: true, force: true });
    rmSync(staging, { force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
    const source = `import { createConnection } from 'node:net';
import { ModelRuntime } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
import { InMemoryCredentialStore, InMemoryModelsStore } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))};
export default async function (pi) {
  const configuration = await new Promise((resolve, reject) => {
    const socket = createConnection(${JSON.stringify(socketPath)});
    let response = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Native provider bootstrap timed out')));
    socket.once('error', () => reject(new Error('Native provider bootstrap unavailable')));
    socket.once('connect', () => socket.write(${JSON.stringify(token + '\n')}));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('end', () => {
      try { resolve(JSON.parse(response)); } catch { reject(new Error('Invalid native provider bootstrap response')); }
    });
  });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(configuration.providerId, configuration.configuration);
  const provider = runtime.getProvider(configuration.providerId);
  if (!provider) throw new Error('Native child provider unavailable');
  pi.registerProvider({ ...provider, auth: { ...provider.auth, apiKey: {
    name: 'Outpost parent credential', resolve: async () => ({ auth: { apiKey: configuration.apiKey }, source: 'Outpost parent' })
  } } });
}
`;
    writeFileSync(staging, source, { mode: 0o600, flag: 'wx' }); renameSync(staging, modulePath);
    registration = registerRequiredChildExtensions({ sessionId: options.sessionId,
      extensions: [{ id: 'outpost-parent-provider', path: modulePath }], requireForAllRunners: false });
    return { modulePath, dispose: close };
  } catch (error) { await close(); throw error; }
}
