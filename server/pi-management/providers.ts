import { createHmac, randomBytes } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AuthFlows } from './auth-flows.js';
import { ManagementRequest, managementProtocol, managementError, type Catalogue } from './contracts.js';
import { PiProfile } from './profile.js';
import { ManagementReceipts } from './receipts.js';
import { refreshSubscriptionModels } from './subscription-models.js';

/** Construct only in the Pi worker; never import provider packages into the coordinator. */
export class ProviderManagement {
  readonly logins: AuthFlows;
  private runtimeCache: { generation: string; runtime: Promise<ModelRuntime> } | undefined;
  private refreshedAt: number | null = null;
  private refreshErrors: string[] = [];
  private refreshRevision = 0;
  private receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  private receiptKey = randomBytes(32);
  private journal: ManagementReceipts;
  private startedLogins = new Set<string>();
  constructor(readonly profile: PiProfile, private createRuntime = () => profile.runtime()) {
    this.journal = new ManagementReceipts(profile.directory);
    this.logins = new AuthFlows(() => this.runtime(), {
      generation: () => profile.generation(),
      save: async (provider, credential, generation, signal) => {
        await profile.saveCredential(provider, credential, generation, signal);
        this.runtimeCache = undefined;
      },
      loginOptions: { getDeviceId: () => profile.installationId(), agentName: 'Outpost' },
    });
  }
  close() { this.logins.close(); this.journal.close(); }
  async runtime() {
    const generation = this.profile.generation();
    if (!this.runtimeCache || this.runtimeCache.generation !== generation) {
      const runtime = this.createRuntime();
      this.runtimeCache = { generation, runtime };
      void runtime.catch(() => { if (this.runtimeCache?.runtime === runtime) this.runtimeCache = undefined; });
    }
    return this.runtimeCache.runtime;
  }
  async catalogue(): Promise<Catalogue> {
    const generation = this.profile.generation();
    const runtime = await this.runtime();
    const subscriptionUnavailable = await refreshSubscriptionModels(runtime);
    const credentials = new Map((await runtime.listCredentials()).map(value => [value.providerId, value.type]));
    const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(10000) });
    const configured = new Set(available.map(model => model.provider));
    const providers: Catalogue['providers'] = [];
    for (const provider of runtime.getProviders()) {
      const methods: Catalogue['providers'][number]['methods'] = [];
      if (provider.auth.apiKey) methods.push({ type: 'api_key', label: provider.auth.apiKey.name,
        subscription: false, interactive: !!provider.auth.apiKey.login });
      if (provider.auth.oauth) methods.push({ type: 'oauth', label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
        subscription: !!provider.auth.oauth.isSubscription, interactive: true });
      providers.push({ id: provider.id, name: provider.name, methods, configured: configured.has(provider.id) || runtime.hasConfiguredAuth(provider.id),
        storedMethod: credentials.get(provider.id) ?? null });
    }
    if (this.profile.generation() !== generation) throw managementError('pi_configuration_changed');
    const settings = this.profile.settings();
    if (settings.drainErrors().length) throw managementError('pi_settings_invalid');
    const providerId = settings.getDefaultProvider(), modelId = settings.getDefaultModel();
    return { protocolVersion: managementProtocol, piVersion: this.profile.version, releaseId: this.profile.releaseId, profilePath: this.profile.directory, generation,
      providers, models: available.map(model => ({ providerId: model.provider, modelId: model.id, name: model.name,
        reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
      defaultModel: providerId && modelId ? { providerId, modelId } : null,
      refreshedAt: this.refreshedAt, refreshErrors: [...new Set([...this.refreshErrors.filter(id => id !== 'openai'), ...(subscriptionUnavailable ? ['openai'] : [])])],
      capabilities: { providerPackages: false, callbackRelay: false } };
  }
  private async refresh(providerId?: string) {
    const revision = ++this.refreshRevision, generation = this.profile.generation();
    const runtime = await this.runtime();
    if (providerId && !runtime.getProvider(providerId)) throw managementError('provider_unavailable');
    const result = await runtime.refresh({ allowNetwork: true, force: true, signal: AbortSignal.timeout(15000),
      ...(providerId ? { providers: [providerId] } : {}) });
    if (revision !== this.refreshRevision || this.profile.generation() !== generation) throw managementError('provider_refresh_superseded');
    this.refreshedAt = Date.now();
    this.refreshErrors = [...result.errors.keys()];
    if (result.aborted) throw managementError('provider_refresh_interrupted');
    return this.catalogue();
  }
  async request(owner: string, input: unknown): Promise<unknown> {
    const request = ManagementRequest.parse(input);
    if (request.type === 'catalogue') return this.catalogue();
    if (request.type === 'refresh') return this.refresh(request.providerId);
    if (request.type === 'login.start') {
      const key = `${owner}:${request.operationId}`;
      if (!this.startedLogins.has(key)) { this.journal.reserve(owner, request.operationId, request); this.startedLogins.add(key); }
      return this.logins.start(owner, request.operationId, request.providerId, request.method);
    }
    if (request.type === 'login.status') return this.logins.status(owner, request.flowId);
    if (request.type === 'login.cancel') return this.logins.cancel(owner, request.flowId);
    if (request.type === 'login.answer') return this.logins.answer(owner, request.flowId, request.promptId, request.value);
    const key = `${owner}:${request.operationId}`;
    const fingerprint = createHmac('sha256', this.receiptKey).update(JSON.stringify(request)).digest('hex');
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw managementError('management_operation_conflict');
      return previous.result;
    }
    if (this.receipts.size >= 1024) throw managementError('management_receipt_capacity');
    const reserved = this.journal.reserve(owner, request.operationId, request);
    if (reserved.replay) return reserved.result;
    const result = (async () => {
      if (request.type === 'provider.configure') return this.profile.configure(request.configuration, request.expectedGeneration);
      if (request.type === 'default.set') return this.profile.setDefault(request.model, request.expectedGeneration);
      const runtime = await this.runtime();
      if (!runtime.getProvider(request.providerId)) throw managementError('provider_unavailable');
      await runtime.logout(request.providerId, { signal: AbortSignal.timeout(10000) });
      return { status: 'credential_removed', providerId: request.providerId };
    })().then(result => { this.journal.finish(owner, request.operationId, result); return result; });
    this.receipts.set(key, { fingerprint, result });
    return result;
  }
}
