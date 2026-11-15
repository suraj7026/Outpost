import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential, LoginOptions } from '@earendil-works/pi-ai';
import { LoginEvent, LoginPrompt, LoginState, Secret, managementError } from './contracts.js';

type Interaction = Parameters<ModelRuntime['login']>[2];
type AuthRuntime = Pick<ModelRuntime, 'login' | 'getProvider'>;
interface Flow {
  owner: string; public: LoginState; abort: AbortController; generation: string;
  commitPrompt?: string; completion?: Promise<void>;
  pending?: { id: string; resolve: (value: string) => void; reject: (error: Error) => void; cleanup: () => void } | undefined;
  answers: Map<string, string>; timer: ReturnType<typeof setTimeout>;
}
const active = (flow: Flow) => ['running','waiting'].includes(flow.public.state);
const safeLink = (value: string) => {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw managementError('unsupported_authentication_link');
};
export class AuthFlows {
  private flows = new Map<string, Flow>();
  private fingerprintKey = randomBytes(32);
  constructor(private runtime: () => Promise<AuthRuntime>, private persistence: {
    generation: () => string;
    save: (provider: string, credential: Credential, generation: string, signal: AbortSignal) => Promise<void>;
    loginOptions?: LoginOptions;
  }, private lifetime = 10 * 60 * 1000) {}
  get busy() { return [...this.flows.values()].some(flow => active(flow) && flow.public.expiresAt > Date.now()); }
  close() { for (const flow of this.flows.values()) this.end(flow, 'cancelled'); this.flows.clear(); }
  private owned(owner: string, id: string) {
    const flow = this.flows.get(id);
    if (!flow || flow.owner !== owner) throw managementError('login_flow_unavailable');
    if (active(flow) && (Date.now() >= flow.public.expiresAt || flow.generation !== this.persistence.generation())) this.end(flow, 'expired');
    return flow;
  }
  private view(flow: Flow): LoginState { return structuredClone(flow.public); }
  status(owner: string, id: string) { return this.view(this.owned(owner, id)); }
  private end(flow: Flow, state: 'cancelled' | 'expired') {
    if (!active(flow)) return;
    flow.public.state = state;
    flow.public.prompt = null;
    clearTimeout(flow.timer);
    flow.abort.abort();
  }
  cancel(owner: string, id: string) { const flow = this.owned(owner, id); this.end(flow, 'cancelled'); return this.view(flow); }
  start(owner: string, id: string, providerId: string, method: 'api_key' | 'oauth') {
    const existing = this.flows.get(id);
    if (existing) {
      if (existing.owner !== owner || existing.public.providerId !== providerId || existing.public.method !== method)
        throw managementError('login_operation_conflict');
      return this.view(existing);
    }
    for (const [key, flow] of this.flows) if (!active(flow) && Date.now() > flow.public.expiresAt) this.flows.delete(key);
    if (this.flows.size >= 128) throw managementError('too_many_login_flows');
    if ([...this.flows.values()].some(flow => active(flow) && flow.public.providerId === providerId)) throw managementError('provider_login_in_progress');
    const abort = new AbortController();
    const state: LoginState = { id, providerId, method, expiresAt: Date.now() + this.lifetime,
      state: 'running', prompt: null, events: [], error: null };
    const flow: Flow = { owner, public: state, abort, generation: this.persistence.generation(), answers: new Map(),
      timer: setTimeout(() => this.end(flow, 'expired'), this.lifetime) };
    flow.timer.unref();
    this.flows.set(id, flow);
    const interaction: Interaction = {
      signal: abort.signal,
      prompt: input => {
        if (abort.signal.aborted) return Promise.reject(managementError('login_cancelled'));
        if (flow.pending || flow.answers.size >= 32) return Promise.reject(managementError('unsupported_login_prompt_sequence'));
        const { signal, ...data } = input;
        const prompt = LoginPrompt.parse(data), promptId = randomUUID();
        return new Promise<string>((resolve, reject) => {
          const cancellation = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
          const onAbort = () => {
            cancellation.removeEventListener('abort', onAbort);
            if (flow.pending?.id === promptId) { flow.pending = undefined; state.prompt = null; if (active(flow)) state.state = 'running'; }
            reject(managementError('login_prompt_cancelled'));
          };
          if (cancellation.aborted) { onAbort(); return; }
          flow.pending = { id: promptId, resolve, reject, cleanup: () => cancellation.removeEventListener('abort', onAbort) };
          state.prompt = { id: promptId, input: prompt }; state.state = 'waiting';
          cancellation.addEventListener('abort', onAbort, { once: true });
        });
      },
      notify: input => {
        if (!active(flow) || abort.signal.aborted) return;
        const event = LoginEvent.parse(input);
        if (event.type === 'auth_url') safeLink(event.url);
        if (event.type === 'device_code') safeLink(event.verificationUri);
        if (event.type === 'info') event.links?.forEach(link => safeLink(link.url));
        // Progress text is provider-defined. Never relay a provider's error object or credentials.
        state.events = [...state.events, event].slice(-32);
      },
    };
    flow.completion = (async () => {
      const runtime = await this.runtime();
      if (abort.signal.aborted) return;
      const provider = runtime.getProvider(providerId);
      if (!provider || (method === 'api_key' ? !provider.auth.apiKey?.login : !provider.auth.oauth))
        throw managementError('authentication_method_unavailable');
      // Invoke Pi's provider interaction without its automatic credential persistence.
      // A background OAuth callback must never write after the initiating device is revoked.
      const bounded = { ...interaction, signal: abort.signal };
      const credential = method === 'oauth'
        ? await provider.auth.oauth!.login(bounded, this.persistence.loginOptions)
        : await provider.auth.apiKey!.login!(bounded);
      abort.signal.throwIfAborted();
      if (flow.generation !== this.persistence.generation()) throw managementError('pi_configuration_changed');
      const confirmation = interaction.prompt({ type: 'select', message: 'Save this credential to the shared server Pi profile?', options: [{ id: 'save', label: 'Save server credential' }] });
      flow.commitPrompt = state.prompt!.id;
      await confirmation;
      await this.persistence.save(providerId, credential, flow.generation, AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]));
      if (!abort.signal.aborted) { state.state = 'succeeded'; state.prompt = null; state.events = []; }
    })().catch(() => {
      if (!abort.signal.aborted) { state.state = 'failed'; state.prompt = null; state.events = []; state.error = 'login_failed_check_provider_status'; }
    }).finally(() => {
      clearTimeout(flow.timer);
      if (flow.pending) { flow.pending.cleanup(); flow.pending.reject(managementError('login_finished')); flow.pending = undefined; }
    });
    return this.view(flow);
  }
  async answer(owner: string, id: string, promptId: string, value: string) {
    Secret.parse(value);
    const flow = this.owned(owner, id);
    const fingerprint = createHmac('sha256', this.fingerprintKey).update(value).digest('hex');
    const previous = flow.answers.get(promptId);
    if (previous) {
      if (previous !== fingerprint) throw managementError('login_answer_conflict');
      return this.view(flow);
    }
    if (!active(flow) || !flow.pending || flow.pending.id !== promptId || !flow.public.prompt)
      throw managementError('login_prompt_unavailable');
    const prompt = flow.public.prompt.input;
    if (prompt.type === 'select' && !prompt.options.some(option => option.id === value)) throw managementError('invalid_login_selection');
    flow.answers.set(promptId, fingerprint);
    const pending = flow.pending;
    flow.pending = undefined; flow.public.prompt = null; flow.public.state = 'running';
    pending.cleanup(); pending.resolve(value);
    // Keep the authenticated coordinator operation open until credential commit settles.
    if (flow.commitPrompt === promptId) await flow.completion;
    return this.view(flow);
  }
}
