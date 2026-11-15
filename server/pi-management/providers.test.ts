import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AuthFlows } from './auth-flows.js';
import { CompatibleProvider, LoginState, ManagementRequest, ModelRef } from './contracts.js';
import { VerifiedFixtureProfile as PiProfile } from '../testing/verified-profile.js';
import { ProviderManagement } from './providers.js';

const configuration = { providerId: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions',
  models: [{ id: 'org/model:cloud', name: 'Fixture model', contextWindow: 8192, maxTokens: 1024 }] };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(read: () => LoginState, predicate: (value: LoginState) => boolean) {
  for (let n = 0; n < 100; n++) { const value = read(); if (predicate(value)) return value; await tick(); }
  throw new Error('Fixture authentication did not reach the expected state');
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-pi-profile-'));
  const profile = new PiProfile(directory), service = new ProviderManagement(profile);
  return { directory, profile, service, close: () => { service.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('management contracts preserve provider-qualified IDs and reject unsafe or ambiguous inputs', () => {
  assert.deepEqual(ModelRef.parse({ providerId: 'fixture', modelId: 'org/model:cloud' }), { providerId: 'fixture', modelId: 'org/model:cloud' });
  for (const providerId of ['__proto__','constructor','../keys','x/y']) assert.equal(ModelRef.safeParse({ providerId, modelId: 'test' }).success, false);
  for (const baseUrl of ['file:///tmp/key','https://key:secret@example.test','http://169.254.169.254/latest','http://[fe80::1]/v1','https://example.test?key=secret'])
    assert.equal(CompatibleProvider.safeParse({ ...configuration, baseUrl }).success, false);
  assert.equal(CompatibleProvider.safeParse({ ...configuration, baseUrl: 'http://private-server/v1' }).success, false);
  assert.equal(CompatibleProvider.safeParse({ ...configuration, baseUrl: 'http://private-server/v1', allowInsecureHttp: true }).success, true);
  assert.equal(ManagementRequest.safeParse({ type: 'catalogue', apiKey: 'do-not-accept' }).success, false);
  assert.equal(CompatibleProvider.safeParse({ ...configuration, models: [...configuration.models, ...configuration.models] }).success, false);
});

test('compatible-provider configuration preserves settings, rejects stale writes and is readable by a separate Pi runtime', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({ theme: 'dark', quietStartup: true }));
    const initial = f.profile.generation();
    await f.profile.configure(configuration, initial);
    await assert.rejects(f.profile.configure(configuration, initial), /configuration_changed/);
    const cli = await ModelRuntime.create({ authPath: join(f.directory, 'auth.json'), modelsPath: join(f.directory, 'models.json'), refreshOnCreate: false });
    assert.equal(cli.getModel('fixture', 'org/model:cloud')?.name, 'Fixture model');
    await cli.login('fixture', 'api_key', { prompt: async () => 'fixture-secret', notify: () => {} });
    assert.ok((await (await f.profile.runtime()).getAvailable('fixture')).some(model => model.id === 'org/model:cloud'));
    await f.profile.setDefault({ providerId: 'fixture', modelId: 'org/model:cloud' }, f.profile.generation());
    const settings = JSON.parse(readFileSync(join(f.directory, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark'); assert.equal(settings.quietStartup, true);
    assert.equal(settings.defaultProvider, 'fixture'); assert.equal(settings.defaultModel, 'org/model:cloud');
    assert.equal(statSync(join(f.directory, 'models.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.directory, 'auth.json')).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(f.directory, 'models.json'), 'utf8').includes('fixture-secret'));
  } finally { f.close(); }
});

test('real Pi API-key login is device-bound, replay-safe, persistent and never returns the credential', async () => {
  const f = fixture(), owner = randomUUID(), id = randomUUID();
  try {
    await f.profile.configure(configuration, f.profile.generation());
    const start = { type: 'login.start', operationId: id, providerId: 'fixture', method: 'api_key' };
    await f.service.request(owner, start);
    const state = await until(() => f.service.logins.status(owner, id), value => value.state === 'waiting');
    assert.equal(state.prompt?.input.type, 'secret'); assert.ok(state.prompt);
    await assert.rejects(f.service.request(randomUUID(), { type: 'login.status', flowId: id }), /unavailable/);
    const answer = { type: 'login.answer', flowId: id, promptId: state.prompt.id, value: 'fixture-secret-not-for-output' };
    const result = await f.service.request(owner, answer);
    assert.ok(!JSON.stringify(result).includes(answer.value));
    await f.service.request(owner, answer);
    await assert.rejects(f.service.request(owner, { ...answer, value: 'other-secret' }), /conflict/);
    const commit = await until(() => f.service.logins.status(owner, id), value => value.prompt?.input.type === 'select');
    assert.equal((await (await f.profile.runtime()).listCredentials()).length, 0, 'Background login has not persisted credentials');
    await f.service.request(owner, { type: 'login.answer', flowId: id, promptId: commit.prompt!.id, value: 'save' });
    await until(() => f.service.logins.status(owner, id), value => value.state === 'succeeded');
    const replay = LoginState.parse(await f.service.request(owner, start));
    assert.equal(replay.state, 'succeeded');
    const catalogue = await f.service.catalogue();
    assert.ok(catalogue.providers.length > 5, 'Provider list comes from Pi, not an Outpost allowlist');
    assert.equal(catalogue.providers.find(provider => provider.id === 'fixture')?.storedMethod, 'api_key');
    assert.ok(catalogue.models.some(model => model.providerId === 'fixture' && model.modelId === 'org/model:cloud'));
    assert.ok(!JSON.stringify(catalogue).includes(answer.value));
    const generation = f.profile.generation();
    await f.service.request(owner, { type: 'provider.logout', operationId: randomUUID(), providerId: 'fixture' });
    assert.equal(f.profile.generation(), generation, 'Public configuration revision is independent of secrets');
    assert.equal((await (await f.profile.runtime()).getAvailable('fixture')).length, 0);
  } finally { f.close(); }
});

test('generic OAuth interaction supports choices, device flow, cancellation and sanitized failures', async () => {
  const f = fixture();
  const runtime = await f.profile.runtime();
  const source = runtime.getProvider('openai'); assert.ok(source);
  runtime.registerNativeProvider({ ...source, id: 'fixture-oauth', name: 'Fixture OAuth', getModels: () => [],
    auth: { oauth: { name: 'Fixture subscription', isSubscription: true,
      login: async interaction => {
        const region = await interaction.prompt({ type: 'select', message: 'Region', options: [{ id: 'test', label: 'Test' }] });
        assert.equal(region, 'test');
        interaction.notify({ type: 'device_code', userCode: 'TEST-CODE', verificationUri: 'https://example.test/login' });
        const code = await interaction.prompt({ type: 'manual_code', message: 'Paste code' });
        if (code !== 'approved') throw new Error('provider exception contains fixture-secret');
        return { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 };
      }, refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) } },
  });
  const flows = new AuthFlows(async () => runtime, { generation: () => f.profile.generation(), save: (...args) => f.profile.saveCredential(...args) }), owner = randomUUID();
  try {
    const id = randomUUID(); flows.start(owner, id, 'fixture-oauth', 'oauth');
    let state = await until(() => flows.status(owner, id), value => value.state === 'waiting');
    assert.ok(state.prompt);
    await assert.rejects(flows.answer(owner, id, state.prompt!.id, 'wrong-region'), /invalid_login_selection/);
    await flows.answer(owner, id, state.prompt.id, 'test');
    state = await until(() => flows.status(owner, id), value => value.prompt?.input.type === 'manual_code');
    assert.equal(state.events[0]?.type, 'device_code'); assert.ok(state.prompt);
    await flows.answer(owner, id, state.prompt.id, 'bad-code');
    state = await until(() => flows.status(owner, id), value => value.state === 'failed');
    assert.ok(!JSON.stringify(state).includes('fixture-secret'));
    const cancelled = randomUUID(); flows.start(owner, cancelled, 'fixture-oauth', 'oauth');
    state = await until(() => flows.status(owner, cancelled), value => value.state === 'waiting');
    flows.cancel(owner, cancelled);
    assert.equal(flows.status(owner, cancelled).state, 'cancelled');
    await assert.rejects(flows.answer(owner, cancelled, state.prompt!.id, 'test'), /unavailable/);
    await tick();
  } finally { flows.close(); f.close(); }
});
