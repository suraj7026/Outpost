import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus, DefaultResourceLoader, SettingsManager, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { bundledExtensions } from './bundled-extensions.js';
import { managementError } from './contracts.js';
import { SessionBackground } from './session-background.js';

const manifest = z.object({ pi: z.object({ extensions: z.array(z.string()).min(1),
  skills: z.array(z.string()).optional(), prompts: z.array(z.string()).optional(), themes: z.array(z.string()).optional() }) });
const nativeAllowance = `Installed release extensions are available natively, including their tools and child agents. They may execute, read, and write with the worker's native privileges, without routing through outpost_action. This is an explicit exception to any instruction above that all actual work must use outpost_action. Existing coordinator-gated tools still use outpost_action and retain their approval requirements.`;

/** Release packages only: no ambient settings packages, cwd extensions, or automatic installs. */
export async function sessionExtensions(options: { cwd: string; agentDir: string; systemPrompt: string; releaseDirectory?: string; modelRuntime?: ModelRuntime }) {
  const release = options.releaseDirectory ?? fileURLToPath(new URL('../../', import.meta.url));
  const { extensions } = bundledExtensions(release);
  const entries: string[] = [];
  const packages = extensions.map(({ name }) => {
    const directory = realpathSync(join(release, 'node_modules', name));
    const { pi } = manifest.parse(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')));
    for (const [kind, paths] of Object.entries(pi)) for (const path of paths ?? []) {
      const entry = realpathSync(join(directory, path));
      const suffix = relative(directory, entry);
      if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw managementError('session_extension_path_invalid');
      if (kind === 'extensions') entries.push(entry);
    }
    return directory;
  });
  const events = createEventBus();
  const background = new SessionBackground(events, extensions.some(extension => extension.name === 'pi-subagents'));
  // noExtensions alone does not prevent the SDK package resolver installing settings packages.
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir,
    settingsManager: SettingsManager.inMemory(), eventBus: events, additionalExtensionPaths: packages,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: `${options.systemPrompt}\n\n${nativeAllowance}`, appendSystemPrompt: [] });
  await loader.reload();
  const loaded = loader.getExtensions();
  // Profiles already compose the package provider with credential/transport handling.
  // Loading its tools and hooks must not replace that native provider with the raw config.
  loaded.runtime.pendingProviderRegistrations = loaded.runtime.pendingProviderRegistrations.filter(
    registration => !options.modelRuntime?.getRegisteredNativeProvider(registration.name));
  if (loaded.errors.length || entries.some(entry => !loaded.extensions.some(extension => extension.resolvedPath === entry)))
    throw managementError('session_extensions_load_failed');
  if ([...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics, ...loader.getThemes().diagnostics].some(value => value.type === 'error'))
    throw managementError('session_extension_resources_invalid');
  let failed = false, shutdownFailed = false, shuttingDown = false, started = false;
  const check = () => { if (failed) throw managementError('session_extension_failed'); };
  const toolNames = () => [...new Set(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]))];
  return {
    loader,
    background,
    get toolNames() { return toolNames(); },
    check,
    async bind(session: AgentSession) {
      background.attach(session); started = true;
      await session.bindExtensions({ mode: 'rpc', abortHandler: () => { void session.abort(); },
        shutdownHandler: () => { void session.abort(); },
        onError: () => { if (shuttingDown) shutdownFailed = true; else failed = true; void session.abort(); } });
      await background.bind(session);
      check();
      // session_start can register tools dynamically (for example Ollama's web tools).
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), 'outpost_action', ...toolNames()])]);
      if (!['outpost_action', ...toolNames()].every(name => session.getActiveToolNames().includes(name)))
        throw managementError('session_extension_tools_missing');
    },
    async dispose(session: AgentSession) {
      await background.drain();
      shuttingDown = true;
      try { if (started) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { background.release(); events.clear(); session.dispose(); }
      if (shutdownFailed) throw managementError('session_extension_shutdown_failed');
    },
  };
}
