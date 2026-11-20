import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Type } from 'typebox';
import { z } from 'zod';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, VERSION } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../core/ledger.js';
import { requireThat } from '../core/contracts.js';
import { Gate } from '../policy/trust.js';
import type { Task } from '../tasks/tasks.js';
import { validateRoles } from '../models/cloud.js';
import type { InferenceConfiguration } from '../models/inference.js';
import { supportsThinking } from '../models/thinking.js';
import { LiveFeed } from '../gateway/live.js';
import { liveEvents } from './live-events.js';
import { SubagentRuns } from './subagent-runs.js';
import { outpostSystemPrompt } from './system-prompt.js';
import { sessionExtensions } from '../pi-management/session-extensions.js';
import { SessionBackground, SessionWorkJournal, within } from '../pi-management/session-background.js';
import { createChildProviderBootstrap } from '../pi-management/child-provider-bootstrap.js';

export class PiRuntime {
  private active = new Map<string,AgentSession>();
    private starting = new Map<string, { aborted: boolean }>();
  private backgrounds = new Map<string, SessionBackground>();
  private journal: SessionWorkJournal;
  constructor(private db: Ledger, private gate: Gate, private root: string, private live = new LiveFeed(db)) {
    mkdirSync(root,{ recursive: true,mode: 0o700 });
    this.journal = new SessionWorkJournal(root);
  }
  get needsAttention() { return this.journal.needsAttention || [...this.backgrounds.values()].some(background => background.needsAttention); }
  isActive(taskId: string) { return this.starting.has(taskId) || this.active.has(taskId) || this.needsAttention; }
  async run(taskId: string, cwd: string, prompt: string, apiKey: string, roleInput: unknown, inference?: InferenceConfiguration) {
    requireThat(!this.starting.has(taskId) && !this.active.has(taskId), 'pi_already_running');
    const run = { aborted: false };
    this.gate.startRuntime(taskId);
    this.starting.set(taskId, run);
    try { await this.execute(taskId, cwd, prompt, apiKey, roleInput, run, inference); }
    finally { this.starting.delete(taskId); this.gate.finishRuntime(taskId); }
  }
  private async execute(taskId: string, cwd: string, prompt: string, apiKey: string, roleInput: unknown, run: { aborted: boolean }, inference?: InferenceConfiguration) {
    const mode = this.gate.policy(taskId).data.mode;
    requireThat(mode !== 'auto' || !this.needsAttention, 'native_work_needs_attention');
    const roles = inference ? { operator: inference.model,contextWindow: inference.contextWindow,maxTokens: inference.maxTokens } : validateRoles(roleInput);
    const runtime = await ModelRuntime.create({ authPath: join(this.root,'auth.json'),modelsPath: null,allowModelNetwork: false,refreshOnCreate: false });
    const thinking = await supportsThinking(inference);
    const configuration: ProviderConfig = { baseUrl: inference?.baseUrl ?? 'https://ollama.com/v1',api: 'openai-completions',models: [{ id: roles.operator,name: roles.operator,reasoning: thinking,input: inference?.vision ? ['text','image'] : ['text'],contextWindow: roles.contextWindow,maxTokens: roles.maxTokens,cost: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0 } }] };
    runtime.registerProvider('outpost-ollama', configuration);
    const provider = runtime.getProvider('outpost-ollama'); requireThat(provider,'operator_unavailable');
    // Native children inherit registered providers, not this runtime's credential overlay.
    // A resolver keeps the key in memory and literal (not a settings !command/$env expression).
    runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, apiKey: {
      name: 'Outpost runtime key', resolve: async () => ({ auth: { apiKey }, source: 'Outpost runtime' }),
    } } });
    await runtime.setRuntimeApiKey('outpost-ollama',apiKey);
    const model = runtime.getModel('outpost-ollama',roles.operator); requireThat(model,'operator_unavailable');
    const mapping = this.db.get<{ file: string }>('pi_session',taskId);
    const manager = mapping ? SessionManager.open(mapping.data.file) : SessionManager.create(cwd,join(this.root,'sessions'));
    const extensions = await sessionExtensions({ cwd, agentDir: this.root, modelRuntime: runtime, mode, systemPrompt: outpostSystemPrompt(this.gate.catalogue(),cwd,mode) });
        requireThat(!run.aborted, 'action_cancelled');
    const { session } = await createAgentSession({ cwd,agentDir: this.root,modelRuntime: runtime,model,thinkingLevel: thinking ? 'medium' : 'off',noTools: 'builtin',resourceLoader: extensions.loader,sessionManager: manager,settingsManager: SettingsManager.inMemory({ compaction: { enabled: false },retry: { enabled: false } }),customTools: [{
      name: 'outpost_action',label: 'Outpost action',description: mode === 'auto' ? 'Execute through the coordinator. Routine actions may run automatically; sensitive or unclassified actions wait for exact owner approval.' : 'Execute an exact action through the protected coordinator with validation and observed evidence. No per-action approval is needed.',parameters: Type.Object({ tool: Type.String(),arguments: Type.Record(Type.String(),Type.Unknown()) }),
      execute: async (_call,params,signal,onUpdate) => {
        const input = z.strictObject({ tool: z.string(),arguments: z.record(z.string(),z.json()) }).parse(params);
        const action = await this.gate.propose(taskId,input.tool,input.arguments);
        onUpdate?.({ content: [{ type: 'text',text: JSON.stringify(action) }],details: { actionId: action.id } });
        const result = await this.gate.awaitDecisionAndDispatch(action.id,signal);
        return { content: [{ type: 'text' as const,text: JSON.stringify(result) }],details: { actionId: action.id } };
      },
    }] });
    this.active.set(taskId,session); this.backgrounds.set(taskId,extensions.background);
    const subagents = new SubagentRuns(this.live, { taskId, sessionId: session.sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}), secrets: [apiKey] });
    const unobserve = extensions.observeSubagents((name, value) => {
      try { subagents.extensionEvent(name, value); } catch { subagents.observationFailed(); }
    });
    let unsubscribe = () => {}, claimed = false;
    let bootstrap: Awaited<ReturnType<typeof createChildProviderBootstrap>> | undefined;
    try {
      if (extensions.background.enabled) {
        this.journal.own(session); claimed = true;
        bootstrap = await createChildProviderBootstrap({ directory: this.root, sessionId: session.sessionId,
          providerId: 'outpost-ollama', configuration, apiKey });
      }
      this.db.put('pi_session',taskId,mapping?.revision ?? 0,{ file: session.sessionFile ?? '',sessionId: session.sessionId,adapterVersion: 1,piVersion: VERSION });
      unsubscribe = session.subscribe(liveEvents(this.live,taskId,session.sessionId,roles.operator,subagents));
      requireThat(!run.aborted, 'action_cancelled');
      await extensions.bind(session);
      requireThat(!run.aborted, 'action_cancelled');
      await session.prompt(prompt, { streamingBehavior: 'followUp' });
      await extensions.background.drain();
      extensions.check();
      const lastAssistant = session.messages.findLast(message => message.role === 'assistant');
      if (lastAssistant?.role === 'assistant' && lastAssistant.stopReason === 'error') throw new Error(lastAssistant.errorMessage ?? 'Inference failed without a model response');
      const task = this.db.need<Task>('task',taskId);
      if (!['paused','cancelled'].includes(task.data.state)) {
        this.db.put('task',taskId,task.revision,{ ...task.data,state: 'verifying',blocker: 'Run finished. Review the evidence or send the next instruction.' });
      }
    } catch (error) {
      this.gate.stop(taskId);
      await extensions.background.cancel();
      throw error;
    } finally {
      try {
        try { await extensions.dispose(session); }
        finally { await bootstrap?.dispose(); }
        if (claimed) this.journal.settled(session);
        extensions.check();
      } finally {
        try { subagents.close(); } catch { subagents.observationFailed(); }
        finally { unobserve(); this.live.interrupt(taskId); unsubscribe(); this.journal.releaseOwnership(session); }
        this.active.delete(taskId); this.backgrounds.delete(taskId);
      }
    }
  }
  async abort(taskId: string) {
    const run = this.starting.get(taskId); if (run) run.aborted = true;
    this.gate.stop(taskId);
    await within(Promise.all([this.active.get(taskId)?.abort(), this.backgrounds.get(taskId)?.cancel()]), 5000);
  }
  async steer(taskId: string, text: string) { return this.active.get(taskId)?.steer(text); }
}
