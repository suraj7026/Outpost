import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { sessionExtensions } from './session-extensions.js';
import { SessionWorkJournal } from './session-background.js';

const home = mkdtempSync(join(tmpdir(), 'outpost-extension-home-'));
const originalHome = process.env.HOME, originalAgentDir = process.env.PI_CODING_AGENT_DIR, originalTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.HOME = home;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(home, 'subagents');
process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = originalTempRoot;
  rmSync(home, { recursive: true, force: true });
});

function fixture(source = 'export default function () {}') {
  const root = mkdtempSync(join(home, 'release-'));
  const directory = join(root, 'node_modules', 'pi-ollama-cloud');
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  for (const path of [directory, cwd, agentDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'pi-ollama-cloud': '0.13.1' } }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pi-ollama-cloud', version: '0.13.1', pi: { extensions: ['./index.js'] } }));
  writeFileSync(join(directory, 'index.js'), source);
  return { root, directory, options: { cwd, agentDir, releaseDirectory: root, systemPrompt: 'Fixture coordinator prompt' } };
}

test('release pins and every declared extension must load successfully', async () => {
  for (const kind of ['pin', 'missing', 'factory', 'metadata'] as const) {
    const { directory, options } = fixture(kind === 'factory' ? 'export default function () { throw new Error("broken declared extension"); }' : undefined);
    if (kind === 'pin') writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pi-ollama-cloud', version: '0.0.0', pi: { extensions: ['./index.js'] } }));
    if (kind === 'missing') rmSync(join(directory, 'index.js'));
    if (kind === 'metadata') writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pi-ollama-cloud', version: '0.13.1' }));
    await assert.rejects(sessionExtensions(options));
  }
});

test('installed package metadata loads skills and prompts without ambient discovery or settings installs', async () => {
  const { root, directory, options } = fixture();
  mkdirSync(join(directory, 'skills', 'fixture'), { recursive: true });
  mkdirSync(join(directory, 'prompts'));
  writeFileSync(join(directory, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Release skill\n---\nFixture skill instructions.\n');
  writeFileSync(join(directory, 'prompts', 'fixture.md'), '---\ndescription: Release prompt\n---\nFixture prompt instructions.\n');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pi-ollama-cloud', version: '0.13.1', pi: { extensions: ['./index.js'], skills: ['./skills'], prompts: ['./prompts'] } }));
  for (const base of [options.agentDir, join(options.cwd, '.pi')]) {
    mkdirSync(join(base, 'extensions'), { recursive: true });
    writeFileSync(join(base, 'extensions', 'unwanted.js'), `throw new Error('ambient extension executed');`);
    writeFileSync(join(base, 'settings.json'), JSON.stringify({ packages: [join(root, 'not-installed')], extensions: ['./missing-extension.js'] }));
    writeFileSync(join(base, 'APPEND_SYSTEM.md'), 'AMBIENT PROMPT MUST NOT LOAD');
  }
  const extensions = await sessionExtensions(options);
  assert.equal(extensions.loader.getExtensions().extensions.length, 1);
  assert.deepEqual(extensions.loader.getSkills().skills.map(skill => skill.name), ['fixture']);
  assert.deepEqual(extensions.loader.getPrompts().prompts.map(prompt => prompt.name), ['fixture']);
  assert.deepEqual(extensions.loader.getAppendSystemPrompt(), []);
  assert.deepEqual(extensions.loader.getAgentsFiles().agentsFiles, []);
  assert.match(extensions.loader.getSystemPrompt()!, /Installed release extensions are available natively/);
});

test('Auto never imports package or ambient extension factories, hooks or tools', async () => {
  const marker = join(home, 'auto-factory-executed');
  const { options } = fixture(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'UNSAFE'); export default function () { throw Error('must not load'); }`);
  for (const base of [options.agentDir, join(options.cwd, '.pi')]) {
    mkdirSync(join(base, 'extensions'), { recursive: true });
    writeFileSync(join(base, 'extensions', 'ambient.js'), `throw Error('must not load ambient');`);
    writeFileSync(join(base, 'settings.json'), JSON.stringify({ packages: ['npm:must-never-install'], extensions: ['./extensions/ambient.js'] }));
  }
  const extensions = await sessionExtensions({ ...options, mode: 'auto' });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(extensions.toolNames, []);
  assert.deepEqual(extensions.loader.getExtensions().extensions, []);
  assert.equal(extensions.background.enabled, false);
  assert.doesNotMatch(extensions.loader.getSystemPrompt()!, /available natively/);
  assert.deepEqual(extensions.loader.getSkills().skills, []);
  assert.deepEqual(extensions.loader.getPrompts().prompts, []);
});

test('real installed packages expose bundled workflow resources', async () => {
  const extensions = await sessionExtensions({ cwd: home, agentDir: process.env.PI_CODING_AGENT_DIR!, systemPrompt: 'Fixture' });
  assert.equal(extensions.loader.getExtensions().extensions.length, 2);
  assert.ok(extensions.toolNames.includes('subagent'));
  assert.ok(extensions.loader.getSkills().skills.length > 0);
  assert.ok(extensions.loader.getPrompts().prompts.length > 0);
});

test('loading full extensions preserves already composed native provider auth and transport', async () => {
  const runtime = await ModelRuntime.create({ authPath: join(home, 'provider-auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('ollama-cloud', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [
    { id: 'native-provider-fixture', name: 'Native fixture', contextWindow: 16384, maxTokens: 1024, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ] });
  const base = runtime.getProvider('ollama-cloud'); assert.ok(base);
  const resolve = async () => ({ auth: { apiKey: 'native-resolver-fixture' } });
  const provider = { ...base, auth: { ...base.auth, apiKey: { name: 'Native auth', resolve } } };
  runtime.registerNativeProvider(provider);
  const extensions = await sessionExtensions({ cwd: home, agentDir: process.env.PI_CODING_AGENT_DIR!, systemPrompt: 'Fixture', modelRuntime: runtime });
  const { session } = await createAgentSession({ cwd: home, agentDir: process.env.PI_CODING_AGENT_DIR!, resourceLoader: extensions.loader,
    modelRuntime: runtime, model: runtime.getModel('ollama-cloud', 'native-provider-fixture')!, noTools: 'builtin', sessionManager: SessionManager.inMemory(home),
    settingsManager: SettingsManager.inMemory(), customTools: [
      { name: 'outpost_action', label: 'Action', description: 'Coordinator action', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) },
    ] });
  try {
    await extensions.bind(session);
    assert.equal(runtime.getRegisteredNativeProvider('ollama-cloud'), provider);
    assert.equal(runtime.getProvider('ollama-cloud')?.auth.apiKey?.resolve, resolve);
    assert.equal(runtime.getProvider('ollama-cloud')?.streamSimple, provider.streamSimple);
    assert.equal(runtime.getModel('ollama-cloud', 'native-provider-fixture')?.baseUrl, 'http://127.0.0.1:1/v1');
    assert.ok(session.getActiveToolNames().includes('ollama_web_search'));
    assert.ok(session.getActiveToolNames().includes('subagent'));
    assert.ok(extensions.toolNames.every(name => session.getActiveToolNames().includes(name)), 'Every registered extension tool is active');
  } finally { await extensions.dispose(session); }
});

test('headless lifecycle binds startup, dynamic tools, before_agent_start and shutdown', async () => {
  const events = join(home, 'events.jsonl');
  const { options } = fixture(`
    import { appendFileSync } from 'node:fs';
    export default function (pi) {
      const record = event => appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + '\\n');
      pi.on('session_start', event => {
        record(event.type);
        pi.events.emit('subagent:async-started', { id: 'fixture-run', sessionId: 'fixture-session' });
        pi.registerTool({ name: 'native_dynamic', label: 'Native dynamic', description: 'Dynamic native tool', parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'native' }], details: {} }) });
      });
      pi.on('before_agent_start', event => { record(event.type); pi.events.emit('subagent:jobs-changed', { version: 1 }); });
      pi.on('session_shutdown', event => { record(event.type); });
    }
  `);
  const extensions = await sessionExtensions(options);
  const observed: string[] = [];
  const unobserve = extensions.observeSubagents(name => { observed.push(name); });
  const throwingObserver = extensions.observeSubagents(() => { throw new Error('observer unavailable'); });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'lifecycle', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await ModelRuntime.create({ authPath: join(options.agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture', models: [
    { id: 'fixture', name: 'Fixture', contextWindow: 16384, maxTokens: 1024, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ] });
  const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, resourceLoader: extensions.loader,
    modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture')!, noTools: 'builtin', sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), customTools: [
      { name: 'outpost_action', label: 'Action', description: 'Coordinator action', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) },
    ] });
  try {
    await extensions.bind(session);
    assert.deepEqual(observed, ['subagent:async-started'], 'Observer is installed before session_start');
    unobserve(); throwingObserver();
    assert.ok(extensions.toolNames.includes('native_dynamic'));
    assert.deepEqual(new Set(session.getActiveToolNames()), new Set(['native_dynamic', 'outpost_action']));
    await session.prompt('Reply once');
    extensions.check();
    assert.deepEqual(observed, ['subagent:async-started'], 'Unsubscribed observers receive no later events');
    assert.notEqual(session.messages.findLast(message => message.role === 'assistant')?.stopReason, 'error');
  } finally { await extensions.dispose(session); await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)), ['session_start', 'before_agent_start', 'session_shutdown']);
});

test('declared extension startup errors fail the session instead of silently skipping', async () => {
  const { options } = fixture(`export default function (pi) { pi.on('session_start', () => { throw new Error('startup failed'); }); }`);
  const extensions = await sessionExtensions(options);
  const runtime = await ModelRuntime.create({ authPath: join(options.agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, resourceLoader: extensions.loader,
    modelRuntime: runtime, noTools: 'builtin', sessionManager: SessionManager.create(options.cwd, join(options.agentDir, 'sessions')), settingsManager: SettingsManager.inMemory() });
  assert.ok(session.sessionFile); assert.equal(existsSync(session.sessionFile), false);
  const journal = new SessionWorkJournal(options.agentDir); journal.own(session);
  try { await assert.rejects(extensions.bind(session), /session_extension_failed/); }
  finally {
    await extensions.dispose(session);
    journal.settled(session); journal.releaseOwnership(session);
  }
  assert.throws(extensions.check, /session_extension_failed/, 'Execution failure survives independently of successful cleanup');
  assert.equal(new SessionWorkJournal(options.agentDir).needsAttention, false, 'Confirmed startup cleanup does not leave a permanent orphan receipt');
});
