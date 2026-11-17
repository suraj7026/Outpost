import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/** Load native extensions only in a disposable process, before they can capture ambient paths or credentials. */
export async function qualifyRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-qualification-'));
  try {
    for (const name of ['home', 'tmp', 'agent', 'workspace', 'config', 'cache', 'data']) mkdirSync(join(directory, name), { mode: 0o700 });
    await promisify(execFile)(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), fileURLToPath(import.meta.url), '--isolated-qualification', directory], {
      cwd: join(directory, 'workspace'), timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'),
        XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data'),
        PI_CODING_AGENT_DIR: join(directory, 'agent'), PI_SUBAGENTS_TEMP_ROOT: join(directory, 'tmp', 'subagents'),
        PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', JITI_FS_CACHE: 'false', TSX_DISABLE_CACHE: '1' },
    });
  } catch { throw new Error('Managed runtime qualification failed'); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

async function qualifyIsolated(directory: string) {
  const originalFetch = globalThis.fetch;
  let calls = 0, denied = false;
  try {
    const [{ createAgentSession, SessionManager, SettingsManager }, { Type }, { PiProfile }, { credentialStore }, { bundledExtensions }, { sessionExtensions }, { z }] = await Promise.all([
      import('@earendil-works/pi-coding-agent'), import('typebox'), import('../pi-management/profile.js'),
      import('../pi-management/credential-store.js'), import('../pi-management/bundled-extensions.js'), import('../pi-management/session-extensions.js'), import('zod'),
    ]);
    const bundle = bundledExtensions();
    const subagents = bundle.extensions.some(extension => extension.name === 'pi-subagents');
    const expectedTools = ['outpost_action', 'ollama_web_search', 'ollama_web_fetch', ...(subagents ? ['subagent'] : [])];
    const toolName = subagents ? 'subagent' : 'outpost_action';
    const bodySchema = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })) });
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== 'https://outpost-qualification.invalid/v1/chat/completions') { denied = true; throw new Error('qualification_network_denied'); }
      const body = bodySchema.parse(JSON.parse(String(init?.body)));
      const tools = body.tools.map(tool => tool.function.name);
      if (!expectedTools.every(name => tools.includes(name)) || tools.includes('bash') || tools.includes('write')) throw new Error('qualification_tools_missing');
      if (++calls > 2) throw new Error('qualification_unexpected_turn');
      const delta = calls === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'qualification_tool', type: 'function', function: {
        name: toolName, arguments: JSON.stringify(subagents ? { action: 'list' } : {}),
      } }] } : { role: 'assistant', content: 'qualified' };
      const chunks = [{ delta, finish_reason: null }, { delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }];
      return new Response(chunks.map(choice => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const agentDir = join(directory, 'agent'), cwd = join(directory, 'workspace');
    const store = await credentialStore(agentDir);
    await store.modify('qualification', async () => ({ type: 'api_key', key: 'synthetic' }));
    const credential = await store.read('qualification');
    if (credential?.type !== 'api_key' || credential.key !== 'synthetic') throw new Error('qualification_credential_adapter_failed');
    await store.delete('qualification');
    if (await store.read('qualification')) throw new Error('qualification_credential_adapter_failed');
    mkdirSync(join(agentDir, 'agents'), { recursive: true });
    writeFileSync(join(agentDir, 'agents', 'qualification-agent.md'), '---\nname: qualification-agent\ndescription: Synthetic qualification agent\n---\nNever run a real task.\n', { mode: 0o600 });
    const runtime = await new PiProfile(agentDir).runtime();
    const provider = runtime.getRegisteredNativeProvider('ollama-cloud');
    if (!provider || !runtime.getProvider('openai')) throw new Error('qualification_provider_missing');
    runtime.registerProvider('qualification', { baseUrl: 'https://outpost-qualification.invalid/v1', api: 'openai-completions', apiKey: 'synthetic', models: [
      { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 256 },
    ] });
    const model = runtime.getModel('qualification', 'fixture');
    if (!model) throw new Error('qualification_model_missing');
    const extensions = await sessionExtensions({ cwd, agentDir, modelRuntime: runtime, systemPrompt: 'Synthetic qualification only. Native agent metadata discovery is authorized.' });
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, noTools: 'builtin', resourceLoader: extensions.loader,
      sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      customTools: [{ name: 'outpost_action', label: 'Qualification action', description: 'Synthetic coordinator action', parameters: Type.Object({}),
        execute: async () => {
          if (subagents) throw new Error('qualification_native_tool_used_coordinator');
          return { content: [{ type: 'text', text: 'qualification-agent' }], details: {} };
        } }],
    });
    try {
      await extensions.bind(session);
      if (!expectedTools.every(name => session.getActiveToolNames().includes(name)) ||
          !extensions.toolNames.every(name => session.getActiveToolNames().includes(name))) throw new Error('qualification_tools_missing');
      if (runtime.getRegisteredNativeProvider('ollama-cloud') !== provider) throw new Error('qualification_provider_replaced');
      if (subagents && (!extensions.loader.getSkills().skills.length || !extensions.loader.getPrompts().prompts.length)) throw new Error('qualification_resources_missing');
      await session.prompt('List the available agent metadata once, then reply qualified. Do not launch a child.');
      extensions.check();
      const result = session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'qualification_tool');
      const reply = session.messages.findLast(message => message.role === 'assistant');
      if (calls !== 2 || denied || result?.role !== 'toolResult' || result.toolName !== toolName || result.isError ||
          !result.content.some(part => part.type === 'text' && part.text.includes('qualification-agent')) ||
          reply?.stopReason !== 'stop' || !reply.content.some(part => part.type === 'text' && part.text === 'qualified')) throw new Error('qualification_failed');
    } finally { await extensions.dispose(session); }
  } finally { globalThis.fetch = originalFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await (process.argv[2] === '--isolated-qualification' && process.argv[3] ? qualifyIsolated(process.argv[3]) : qualifyRuntime())
    .catch(() => { console.error('Managed runtime qualification failed'); process.exitCode = 1; });
}
