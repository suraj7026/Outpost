import { createHmac, randomBytes } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProviderTransfers } from './transfers.js';
import { TransferRequest } from './transfer-contracts.js';
import { ReleaseManifest, UpdateRequest } from './update-contracts.js';
import { bundledExtensions } from './bundled-extensions.js';
import { AuthFlows } from './auth-flows.js';
import { ProviderRequest, managementProtocol, managementError, type Catalogue } from './contracts.js';
import { PiProfile } from './profile.js';
import { ManagementReceipts } from './receipts.js';
import { refreshSubscriptionModels } from './subscription-models.js';
import { ollamaAuthentication, refreshOllamaModels } from './ollama-access.js';

/** Construct only in the Pi worker; never import provider packages into the coordinator. */
export class ProviderManagement {
  readonly logins: AuthFlows;
  readonly transfers: ProviderTransfers;
  runsActive = () => false;
  private mutations = 0;
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
    this.transfers = new ProviderTransfers(profile);
    this.logins = new AuthFlows(() => this.runtime(), {
      generation: () => profile.generation(),
      save: async (provider, credential, generation, signal) => {
        await profile.saveCredential(provider, credential, generation, signal);
        this.runtimeCache = undefined;
      },
      loginOptions: { getDeviceId: () => profile.installationId(), agentName: 'Outpost' },
    });
  }
  close() { this.logins.close(); this.transfers.close(); this.journal.close(); }
  inventory() {
    let manifest: unknown = null;
    try { manifest = ReleaseManifest.parse(JSON.parse(readFileSync(join(dirname(process.env.OUTPOST_PI_RELEASE_FILE ?? ''), 'host-manifest.json'), 'utf8'))); } catch { /* Legacy/container releases have no qualified native manifest. */ }
    return { piVersion: this.profile.version, releaseId: this.profile.releaseId, ...bundledExtensions(), manifest, providerTransfer: true };
  }
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
    const [subscriptionUnavailable, ollamaUnavailable] = await Promise.all([refreshSubscriptionModels(runtime), refreshOllamaModels(runtime)]);
    const credentials = new Map((await runtime.listCredentials()).map(value => [value.providerId, value.type]));
    const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(10000) });
    const ollamaStatus = await ollamaAuthentication(runtime);
    const configured = new Set(available.map(model => model.provider));
    const providers: Catalogue['providers'] = [];
    for (const provider of runtime.getProviders()) {
      const methods: Catalogue['providers'][number]['methods'] = [];
      if (provider.auth.apiKey) methods.push({ type: 'api_key', label: provider.auth.apiKey.name,
        subscription: false, interactive: !!provider.auth.apiKey.login });
      if (provider.auth.oauth) methods.push({ type: 'oauth', label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
        subscription: !!provider.auth.oauth.isSubscription, interactive: true });
      providers.push({ id: provider.id, name: provider.name, methods, configured: configured.has(provider.id) || runtime.hasConfiguredAuth(provider.id),
        storedMethod: credentials.get(provider.id) ?? null,
        ...(provider.id === 'ollama-cloud' && ollamaStatus ? { authentication: ollamaStatus } : {}) });
    }
    if (this.profile.generation() !== generation) throw managementError('pi_configuration_changed');
    const settings = this.profile.settings();
    if (settings.drainErrors().length) throw managementError('pi_settings_invalid');
    const providerId = settings.getDefaultProvider(), modelId = settings.getDefaultModel();
    return { protocolVersion: managementProtocol, piVersion: this.profile.version, releaseId: this.profile.releaseId, profilePath: this.profile.directory, generation,
      providers, models: available.map(model => ({ providerId: model.provider, modelId: model.id, name: model.name,
        reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
      defaultModel: providerId && modelId ? { providerId, modelId } : null,
      refreshedAt: this.refreshedAt, refreshErrors: [...new Set([...this.refreshErrors.filter(id => !['openai', 'ollama-cloud'].includes(id)),
        ...(subscriptionUnavailable ? ['openai'] : []), ...(ollamaUnavailable ? ['ollama-cloud'] : [])])],
      capabilities: { providerPackages: false, callbackRelay: false, providerTransfer: true } };
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
    this.mutations++;
    try { return await this.handle(owner, input); } finally { this.mutations--; }
  }
  private async handle(owner: string, input: unknown): Promise<unknown> {
    const update = UpdateRequest.safeParse(input);
    if (update.success) {
      const request = update.data;
      if (request.type === 'runtime.inventory') return this.inventory();
      if (request.type === 'maintenance.hold') {
        if (this.runsActive() || this.logins.busy || this.transfers.active || this.mutations > 1) return { ready: false };
        this.profile.holdMaintenance(owner, request.operationId); return { ready: true };
      }
      if (request.type === 'maintenance.release') { this.profile.releaseMaintenance(owner, request.operationId); return { released: true }; }
      throw managementError('coordinator_maintenance_required');
    }
    const transfer = TransferRequest.safeParse(input);
    if (transfer.success) {
      if (this.profile.maintenance && !['transfer.status', 'transfer.cancel', 'transfer.inventory', 'transfer.history'].includes(transfer.data.type)) throw managementError('maintenance_in_progress');
      return this.transfers.request(owner, transfer.data);
    }
    const request = ProviderRequest.parse(input);
    // Catalogue reads can refresh OAuth credentials through the SDK. They are not
    // side-effect-free and must not race the protected activation boundary.
    if (this.profile.maintenance && !['login.status', 'login.cancel'].includes(request.type)) throw managementError('maintenance_in_progress');
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
