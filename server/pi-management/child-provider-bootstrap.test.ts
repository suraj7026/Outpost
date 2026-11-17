import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createChildProviderBootstrap } from './child-provider-bootstrap.js';

const home = mkdtempSync(join(tmpdir(), 'outpost-bootstrap-home-'));
const originalHome = process.env.HOME, originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(home, { recursive: true, force: true });
});

test('child bootstrap keeps literal credentials off disk and does not mandate local extensions for external runners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-child-provider-'));
  const sessionId = randomUUID(), apiKey = '!literal-key-$NOT_AN_ENV_LOOKUP';
  const originalEnvironment = { ...process.env };
  const bootstrap = await createChildProviderBootstrap({ directory, sessionId, providerId: 'bootstrap-fixture', apiKey,
    configuration: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [
      { id: 'private-model', name: 'Private model', contextWindow: 16384, maxTokens: 1024, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ] } });
  try {
    assert.equal(statSync(bootstrap.modulePath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(bootstrap.modulePath)).mode & 0o777, 0o700);
    assert.ok(!readFileSync(bootstrap.modulePath, 'utf8').includes(apiKey));
    const registry = Reflect.get(globalThis, Symbol.for('pi-subagents.required-child-extensions.v1')) as {
      bySession: Map<string, { path: string; requireForAllRunners?: boolean }[]>;
    };
    assert.equal(registry.bySession.get(sessionId)?.[0]?.path, bootstrap.modulePath);
    assert.notEqual(registry.bySession.get(sessionId)?.[0]?.requireForAllRunners, true);
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [bootstrap.modulePath] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const provider = loader.getExtensions().runtime.pendingNativeProviderRegistrations[0]?.provider;
    assert.equal(provider?.id, 'bootstrap-fixture');
    const auth = provider?.auth.apiKey; assert.ok(auth);
    const result = await auth.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: AbortSignal.timeout(1000) });
    assert.equal(result?.auth.apiKey, apiKey);
    assert.deepEqual({ ...process.env }, originalEnvironment);
    await bootstrap.dispose();
    assert.equal(registry.bySession.has(sessionId), false);
  } finally { await bootstrap.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
