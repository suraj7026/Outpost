import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { InMemoryCredentialStore, type Credential } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager, VERSION } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { credentialStore } from './credential-store.js';
import { CompatibleProvider, ModelRef, managementError } from './contracts.js';
import { registerOllamaCloud } from './ollama-cloud.js';
import { refreshSubscriptionModels } from './subscription-models.js';
import { OllamaAccessVerifier, refreshOllamaModels } from './ollama-access.js';
import { registerModelAccess, type AccessVerifiers } from './model-access.js';

const object = z.record(z.string(), z.json());
export class PiProfile {
  readonly directory: string;
  readonly version = VERSION;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly ollamaAccess = new OllamaAccessVerifier();
  constructor(directory: string, readonly releaseId = 'unmanaged', private accessVerifiers: AccessVerifiers = new Map()) {
    if (!isAbsolute(directory)) throw managementError('absolute_pi_profile_required');
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw managementError('pi_profile_symlink_denied');
  }
  private read(name: string): string {
    const path = join(this.directory, name);
    try {
      if (!lstatSync(path).isFile()) throw managementError('pi_profile_regular_file_required');
      const data = readFileSync(path, 'utf8');
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw managementError('pi_configuration_too_large');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
      throw error;
    }
  }
  generation(): string {
    // Never derive a public revision from credentials or credential-command output.
    return createHash('sha256').update(this.version).update(this.releaseId).update(this.read('settings.json')).update(this.read('models.json')).digest('hex');
  }
  get maintenance() { return existsSync(join(this.directory, '.outpost-maintenance.json')); }
  holdMaintenance(owner: string, operationId: string) {
    const path = join(this.directory, '.outpost-maintenance.json');
    if (existsSync(path)) {
      const previous = JSON.parse(readFileSync(path, 'utf8'));
      if (previous.owner !== owner || previous.operationId !== operationId) throw managementError('maintenance_already_active');
    } else writeFileSync(path, JSON.stringify({ owner, operationId }), { mode: 0o600, flag: 'wx' });
  }
  releaseMaintenance(owner: string, operationId: string) {
    const path = join(this.directory, '.outpost-maintenance.json');
    if (!existsSync(path)) return;
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.owner !== owner || previous.operationId !== operationId) throw managementError('maintenance_owner_mismatch');
    rmSync(path);
  }
  settings() {
    return SettingsManager.create(this.directory, this.directory, { projectTrusted: false });
  }
  installationId(): string {
    const path = join(this.directory, '.outpost-installation-id');
    if (!this.readInstallationId(path)) {
      try { writeFileSync(path, randomUUID(), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    return z.uuid().parse(this.readInstallationId(path));
  }
  private readInstallationId(path: string) {
    try { if (!lstatSync(path).isFile()) throw managementError('pi_profile_regular_file_required'); return readFileSync(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async saveCredential(provider: string, credential: Credential, expected: string, signal: AbortSignal) {
    await this.mutate(expected, async () => {
      signal.throwIfAborted();
      const runtime = await this.runtime();
      const definition = runtime.getProvider(provider);
      if (!definition) throw managementError('provider_unavailable');
      const check = () => { signal.throwIfAborted(); if (this.generation() !== expected) throw managementError('pi_configuration_changed'); };
      // Use the public Pi credential persistence API, retaining its cross-process file lock.
      // Provider interaction has already completed; this login only commits the approved value.
      runtime.registerNativeProvider({ ...definition, auth: credential.type === 'oauth'
        ? { ...definition.auth, oauth: { ...definition.auth.oauth!, login: async () => { check(); return credential; } } }
        : { ...definition.auth, apiKey: { ...definition.auth.apiKey!, login: async () => { check(); return credential; } } } });
      await runtime.login(provider, credential.type, { signal, prompt: async () => { throw managementError('unexpected_commit_prompt'); }, notify: () => {} });
    });
  }
  async runtime(metadataOnly = false) {
    const runtime = await ModelRuntime.create({ ...(metadataOnly ? { credentials: new InMemoryCredentialStore() } : { authPath: join(this.directory, 'auth.json') }),
      modelsPath: join(this.directory, 'models.json'), modelsStorePath: join(this.directory, 'models-store.json'),
      allowModelNetwork: false, refreshOnCreate: false });
    if (runtime.getError()) throw managementError('pi_provider_configuration_invalid');
    await registerOllamaCloud(runtime);
    if (!metadataOnly) await registerModelAccess(runtime, this.accessVerifiers, this.ollamaAccess);
    if (runtime.getError()) throw managementError('pi_provider_configuration_invalid');
    return runtime;
  }
  private async mutate<T>(expected: string, operation: () => Promise<T>): Promise<T> {
    const result = this.writes.catch(() => {}).then(async () => {
      const lock = join(this.directory, '.outpost-configuration-lock');
      try { mkdirSync(lock, { mode: 0o700 }); }
      catch { throw managementError('pi_configuration_busy'); }
      try {
        if (this.generation() !== expected) throw managementError('pi_configuration_changed');
        return await operation();
      } finally { rmSync(lock, { recursive: true }); }
    });
    this.writes = result;
    return result;
  }
  async configure(input: unknown, expected: string) {
    const configuration = CompatibleProvider.parse(input);
    if (['ollama-cloud', 'outpost-ollama'].includes(configuration.providerId)) throw managementError('managed_provider_configuration');
    return this.mutate(expected, async () => {
      const original = this.read('models.json');
      const config = object.parse(JSON.parse(original));
      const providers = object.parse(config.providers ?? {});
      const previous = object.parse(providers[configuration.providerId] ?? {});
      providers[configuration.providerId] = { ...previous, baseUrl: configuration.baseUrl,
        api: configuration.api, models: configuration.models };
      const candidate = JSON.stringify({ ...config, providers }, null, 2) + '\n';
      const staging = join(this.directory, `.models-${randomUUID()}.json`);
      try {
        writeFileSync(staging, candidate, { mode: 0o600, flag: 'wx' });
        const runtime = await ModelRuntime.create({ authPath: join(this.directory, 'auth.json'), modelsPath: staging,
          allowModelNetwork: false, refreshOnCreate: false });
        if (runtime.getError() || !runtime.getProvider(configuration.providerId)) throw managementError('pi_provider_configuration_invalid');
        if (this.generation() !== expected || this.read('models.json') !== original) throw managementError('pi_configuration_changed');
        renameSync(staging, join(this.directory, 'models.json'));
        return { generation: this.generation() };
      } finally { rmSync(staging, { force: true }); }
    });
  }
  async migrateLegacyOllama(input: unknown, defaultModel: string) {
    const configuration = CompatibleProvider.parse(input);
    if (configuration.providerId !== 'outpost-ollama' || !configuration.models.some(model => model.id === defaultModel)) throw managementError('legacy_migration_invalid');
    await this.mutate(this.generation(), async () => {
      const config = object.parse(JSON.parse(this.read('models.json')));
      const providers = object.parse(config.providers ?? {});
      if (providers['outpost-ollama']) {
        const existing = object.parse(providers['outpost-ollama']);
        if (existing.baseUrl !== configuration.baseUrl || existing.api !== configuration.api) throw managementError('legacy_provider_conflict');
        const models = z.array(z.object({ id: z.string() }).passthrough()).parse(existing.models);
        if (configuration.models.some(model => !models.some(saved => saved.id === model.id))) throw managementError('legacy_models_conflict');
        return;
      }
      // This is the same nonsecret sentinel used by the legacy local Ollama adapter.
      // No account credential is copied or overwritten by migration.
      providers['outpost-ollama'] = { baseUrl: configuration.baseUrl, api: configuration.api, apiKey: 'ollama', models: configuration.models };
      const staging = join(this.directory, `.models-${randomUUID()}.json`);
      try {
        writeFileSync(staging, JSON.stringify({ ...config, providers }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        const runtime = await ModelRuntime.create({ modelsPath: staging, authPath: join(this.directory,'auth.json'), allowModelNetwork: false, refreshOnCreate: false });
        if (runtime.getError() || !runtime.getModel('outpost-ollama', defaultModel)) throw managementError('legacy_migration_invalid');
        renameSync(staging, join(this.directory,'models.json'));
      } finally { rmSync(staging, { force: true }); }
    });
    const settings = this.settings();
    if (settings.drainErrors().length) throw managementError('pi_settings_invalid');
    if (!settings.getDefaultModel() && !settings.getDefaultProvider()) await this.setDefault({ providerId: 'outpost-ollama', modelId: defaultModel }, this.generation());
    return { generation: this.generation() };
  }
  async retireLegacyOllama(expected: string) {
    return this.mutate(expected, async () => {
      const config = object.parse(JSON.parse(this.read('models.json')));
      const providers = object.parse(config.providers ?? {});
      if (providers['ollama-cloud']) throw managementError('ollama_cloud_configuration_conflict');
      if (providers['outpost-ollama']) {
        delete providers['outpost-ollama'];
        const staging = join(this.directory, `.models-${randomUUID()}.json`);
        try {
          writeFileSync(staging, JSON.stringify({ ...config, providers }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          renameSync(staging, join(this.directory, 'models.json'));
        } finally { rmSync(staging, { force: true }); }
      }
      const original = this.read('settings.json');
      const settings = object.parse(JSON.parse(original));
      if (settings.defaultProvider === 'outpost-ollama') {
        delete settings.defaultProvider; delete settings.defaultModel;
        const staging = join(this.directory, `.settings-${randomUUID()}.json`);
        try {
          writeFileSync(staging, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          if (this.read('settings.json') !== original) throw managementError('pi_configuration_changed');
          renameSync(staging, join(this.directory, 'settings.json'));
        } finally { rmSync(staging, { force: true }); }
      }
      // Old credentials and task/session records are deliberately not rewritten or reused for cloud.
      return { generation: this.generation() };
    });
  }
  transferProviderIds(): string[] {
    const config = object.parse(JSON.parse(this.read('models.json')));
    return Object.keys(object.parse(config.providers ?? {}));
  }
  transferConfiguration(providerId: string): Record<string, unknown> | null {
    const config = object.parse(JSON.parse(this.read('models.json')));
    const providers = object.parse(config.providers ?? {});
    if (!providers[providerId]) return null;
    const value = object.parse(providers[providerId]);
    if (Object.keys(value).some(key => !['baseUrl', 'api', 'models'].includes(key))) throw managementError('transfer_advanced_configuration_unsupported');
    return CompatibleProvider.parse({ providerId, ...value, allowInsecureHttp: String(value.baseUrl).startsWith('http:') });
  }
  async importCredential(providerId: string, key: string, configuration: Record<string, unknown> | null,
    expected: string, unchanged: (credential: import('@earendil-works/pi-ai').Credential | undefined) => boolean) {
    return this.mutate(expected, async () => {
      const runtime = await this.runtime(true);
      const definition = runtime.getProvider(providerId);
      if (!configuration && !definition?.auth.apiKey) throw managementError('provider_unavailable');
      const source = configuration ? CompatibleProvider.parse(configuration) : null;
      if (source && (source.providerId !== providerId || ['ollama-cloud', 'outpost-ollama'].includes(providerId))) throw managementError('transfer_provider_invalid');
      this.transferConfiguration(providerId); // Reject advanced destination expressions/headers, not just source ones.
      const original = this.read('models.json');
      const config = object.parse(JSON.parse(original)), providers = object.parse(config.providers ?? {});
      if (source) providers[providerId] = { baseUrl: source.baseUrl, api: source.api, models: source.models };
      else if (providers[providerId]) throw managementError('transfer_endpoint_conflict');
      const staging = join(this.directory, `.models-${randomUUID()}.json`);
      try {
        if (source) writeFileSync(staging, JSON.stringify({ ...config, providers }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await (await credentialStore(this.directory)).modify(providerId, async current => {
          if (!unchanged(current) || this.generation() !== expected || this.read('models.json') !== original) throw managementError('transfer_destination_changed');
          if (source) renameSync(staging, join(this.directory, 'models.json'));
          return { type: 'api_key', key };
        }, { signal: AbortSignal.timeout(8000) });
      } finally { rmSync(staging, { force: true }); }
      return this.generation();
    });
  }
  async setDefault(input: unknown, expected: string) {
    const model = ModelRef.parse(input);
    return this.mutate(expected, async () => {
      const runtime = await this.runtime();
      if (model.providerId === 'openai') await refreshSubscriptionModels(runtime);
      if (model.providerId === 'ollama-cloud') await refreshOllamaModels(runtime);
      if (!(await runtime.getAvailable()).some(value => value.provider === model.providerId && value.id === model.modelId))
        throw managementError('model_not_available');
      if (this.generation() !== expected) throw managementError('pi_configuration_changed');
      const settings = this.settings();
      if (settings.drainErrors().length) throw managementError('pi_settings_invalid');
      settings.setDefaultModelAndProvider(model.providerId, model.modelId);
      await settings.flush();
      if (settings.drainErrors().length) throw managementError('pi_settings_write_failed');
      return { generation: this.generation() };
    });
  }
}
