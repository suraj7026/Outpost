import { useEffect, useRef, useState } from 'react';
import { agentRequest, call, nativeApp, recordedPreview } from '../api';
import type { Connection } from '../useConnection';
import type { Login, Provider, ModelRef } from './types';
import { providerLabel } from './types';
import ModelPicker from './ModelPicker';
import BrowserSignIn from './BrowserSignIn';
import './agent.css';

const activeLogin = (flow: Login | null) => !!flow && ['running', 'waiting'].includes(flow.state);

function LoginPanel({ flow, busy, answer, cancel }: { flow: Login; busy: boolean; answer: (value: string) => void; cancel: () => void }) {
  const [value, setValue] = useState('');
  const input = flow.prompt?.input;
  const webLink = (url: string, label: string) => /^https?:\/\//i.test(url) ?
    <button type="button" onClick={() => void call('open_url', { url }).catch(() => {})}>{label}</button> : null;
  return <section className="provider-login" aria-label="Provider sign-in">
    <h3>{providerLabel(flow.providerId)} · {flow.state}</h3>
    <p>Sign-in runs on your server. Expires at {new Date(flow.expiresAt).toLocaleTimeString()}.</p>
    {flow.events.map((event, index) => <div key={index}>
      {event.type === 'auth_url' ? <><p>{event.instructions}</p><BrowserSignIn url={event.url} expiresAt={flow.expiresAt} manualPrompt={input?.type === 'manual_code'} disabled={busy || !activeLogin(flow)} answer={answer} /></> :
        event.type === 'device_code' ? <><p>Enter code <code>{event.userCode}</code></p>{webLink(event.verificationUri, 'Open device verification')}</> :
          'message' in event ? <><p>{event.message}</p>{event.type === 'info' && event.links?.map(link => <span key={link.url}>{webLink(link.url, link.label || 'Open provider instructions')}</span>)}</> : null}
    </div>)}
    {activeLogin(flow) && input && <form autoComplete="off" onSubmit={event => { event.preventDefault(); if (!value || busy) return; const response = value; setValue(''); answer(response); }}>
      {input.type === 'manual_code' && <p>If the browser shows “can’t connect” for localhost, copy the full address from its address bar and paste it here—not into the conversation. The URL is sent privately to the active server sign-in.</p>}
      <label htmlFor="provider-answer">{input.message}</label>
      {input.type === 'select' ? <select id="provider-answer" autoFocus value={value} onChange={event => setValue(event.target.value)} disabled={busy}>
        <option value="">Choose an option</option>{input.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select> : <input id="provider-answer" autoFocus type={input.type === 'text' ? 'text' : 'password'} autoComplete="off" spellCheck={false}
        placeholder={input.placeholder} value={value} onChange={event => setValue(event.target.value)} disabled={busy} required />}
      <button disabled={busy || !value}>Continue</button>
    </form>}
    {flow.state === 'succeeded' && <p>Credential saved. Model access still depends on your provider entitlement.</p>}
    {flow.state === 'failed' && <p role="alert">Sign-in failed. Check the provider instructions or use the shared server CLI.</p>}
    {activeLogin(flow) && <button type="button" disabled={busy} onClick={cancel}>Cancel sign-in</button>}
  </section>;
}

function CompatibleForm({ save, disabled }: { save: (configuration: Record<string, unknown>) => void; disabled: boolean }) {
  const [providerId, setProvider] = useState(''), [baseUrl, setUrl] = useState(''), [modelId, setModel] = useState('');
  const [api, setApi] = useState('openai-completions'), [allowHttp, setHttp] = useState(false);
  const [context, setContext] = useState('32768'), [tokens, setTokens] = useState('4096');
  return <details><summary>Compatible endpoint</summary>
    <p>Use an exact model ID advertised by your server. Save the endpoint first, then add its API credential. No credential belongs in the URL.</p>
    <form onSubmit={event => { event.preventDefault(); if (disabled) return; save({ providerId, baseUrl, api, allowInsecureHttp: allowHttp,
      models: [{ id: modelId, name: modelId, contextWindow: Number(context), maxTokens: Number(tokens), input: ['text'], reasoning: false }] }); }}>
      <label htmlFor="compatible-provider">Provider ID</label><input id="compatible-provider" value={providerId} onChange={e => setProvider(e.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" />
      <label htmlFor="compatible-url">Base URL</label><input id="compatible-url" type="url" value={baseUrl} onChange={e => setUrl(e.target.value)} required />
      <label htmlFor="compatible-api">API format</label><select id="compatible-api" value={api} onChange={e => setApi(e.target.value)}>
        {['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].map(value => <option key={value}>{value}</option>)}
      </select>
      <label htmlFor="compatible-model">Exact model ID</label><input id="compatible-model" value={modelId} onChange={e => setModel(e.target.value)} required />
      <label htmlFor="compatible-context">Context window (tokens)</label><input id="compatible-context" type="number" min="1024" max="10000000" value={context} onChange={e => setContext(e.target.value)} required />
      <label htmlFor="compatible-tokens">Maximum output tokens</label><input id="compatible-tokens" type="number" min="1" max={context} value={tokens} onChange={e => setTokens(e.target.value)} required />
      <label className="agent-check"><input type="checkbox" checked={allowHttp} onChange={e => setHttp(e.target.checked)} />Allow unencrypted HTTP to this trusted private endpoint</label>
      <p>Saving replaces this provider’s endpoint/model definition, not its credential. Active runs keep their current model.</p>
      <button disabled={disabled}>Save endpoint</button>
    </form>
  </details>;
}

export default function ProviderSettings({ connection }: { connection: Connection }) {
  const catalogue = connection.agentCatalogue;
  const [search, setSearch] = useState(''), [flow, setFlow] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ provider: Provider; method?: 'api_key' | 'oauth' } | null>(null);
  const [defaultModel, setDefault] = useState<ModelRef | null>(null);
  const mounted = useRef(true), latestFlow = useRef<Login | null>(null), working = useRef(false);
  const startRequest = useRef<Record<string, unknown> | null>(null);
  latestFlow.current = flow;
  const available = !!connection.runtime?.piManagement;
  const blocked = !available || !connection.connected || !nativeApp() || recordedPreview() || !!connection.info?.pending;
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    if (activeLogin(latestFlow.current)) void agentRequest({ type: 'login.cancel', flowId: latestFlow.current!.id }).catch(() => {});
  }; }, []);
  useEffect(() => {
    if (!activeLogin(flow) || blocked) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await agentRequest<Login>({ type: 'login.status', flowId: flow!.id });
        if (!stopped) {
          setFlow(next);
          if (next.state === 'succeeded') await connection.refreshAgent();
        }
      } catch { if (!stopped) setError('Sign-in status unavailable. No credentials were resent. Check your connection.'); }
      if (!stopped) timer = setTimeout(() => void poll(), 1200);
    };
    timer = setTimeout(() => void poll(), 700);
    return () => { stopped = true; clearTimeout(timer); };
  }, [flow?.id, flow?.state, blocked, connection.refreshAgent]);
  const operate = async (action: () => Promise<void>) => {
    if (blocked || working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); } catch { if (mounted.current) setError('Provider operation could not be confirmed. Refresh status before retrying; nothing is automatically resent.'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const start = async (request: Record<string, unknown>) => {
    startRequest.current = request;
    const next = await agentRequest<Login>(request);
    startRequest.current = null;
    if (mounted.current) setFlow(next);
    else if (activeLogin(next)) await agentRequest({ type: 'login.cancel', flowId: next.id });
  };
  const begin = (provider: Provider, method: 'api_key' | 'oauth') => void operate(async () => {
    setConfirmation(null);
    await start({ type: 'login.start', providerId: provider.id, method, operationId: crypto.randomUUID() });
  });
  return <section className="settings-section provider-settings">
    <div><h2>Server Pi providers</h2><p>Credentials stay in the server Pi profile. Your Mac sends signed management requests, not chat messages.</p>
      {catalogue && <p>Pi {catalogue.piVersion}{catalogue.releaseId ? ` · ${catalogue.releaseId}` : ''}<br /><code>{catalogue.profilePath}</code><br />Configuration {catalogue.generation.slice(0, 12)}</p>}
      <p>ChatGPT subscription sign-in and OpenAI API billing are separate. One stored credential per provider; configured does not mean verified access.</p>
    </div>
    <div className="agent-settings-body">
      {!available ? <p>Server update required: provider management is not enabled on this connection. Existing Ollama tasks remain available.</p> : <>
        <div className="button-row"><button disabled={blocked || busy} onClick={() => void operate(async () => { await connection.refreshAgent(true); })}>Refresh models</button></div>
        {error && <p role="alert">{error}</p>}
        {catalogue?.refreshErrors.length ? <p role="status">Some providers could not refresh: {catalogue.refreshErrors.join(', ')}</p> : null}
        {!catalogue && <p>Provider catalogue unavailable. Refresh to load the server’s supported sign-in methods.</p>}
        {startRequest.current && <button disabled={blocked || busy} onClick={() => void operate(() => start(startRequest.current!))}>Recover sign-in status</button>}
        {flow && <LoginPanel key={`${flow.id}:${flow.prompt?.id ?? flow.state}`} flow={flow} busy={busy || blocked}
          answer={value => void operate(async () => {
            const next = await agentRequest<Login>({ type: 'login.answer', flowId: flow.id, promptId: flow.prompt!.id, value });
            if (mounted.current) setFlow(next);
            if (next.state === 'succeeded') await connection.refreshAgent();
          })}
          cancel={() => void operate(async () => { setFlow(await agentRequest<Login>({ type: 'login.cancel', flowId: flow.id })); })} />}
        {confirmation && <section className="provider-confirm" aria-label="Confirm credential change">
          <p>{confirmation.method ? `Replace the stored credential for ${confirmation.provider.name}? Pi stores one credential per provider.` : `Remove the stored credential for ${confirmation.provider.name}? This does not revoke the provider account or remove server environment credentials.`}</p>
          <div className="button-row"><button disabled={busy || blocked} onClick={() => confirmation.method ? begin(confirmation.provider, confirmation.method) : void operate(async () => {
            await agentRequest({ type: 'provider.logout', providerId: confirmation.provider.id, operationId: crypto.randomUUID() }); setConfirmation(null); await connection.refreshAgent();
          })}>Confirm</button><button onClick={() => setConfirmation(null)}>Keep credential</button></div>
        </section>}
        {catalogue && <>
          <label htmlFor="provider-search">Add or manage a provider</label><input id="provider-search" type="search" value={search} placeholder="Search supported providers" onChange={e => setSearch(e.target.value)} />
          <div className="provider-list">
            {catalogue.providers.filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(search.toLowerCase())).map(provider => <div className="provider-row" key={provider.id}>
              <div><strong>{provider.name}</strong><small>{provider.id} · {provider.storedMethod ? 'Credential stored' : provider.configured ? 'Configured on server' : 'Not configured'}</small></div>
              <div className="button-row">{provider.methods.map(method => <button key={method.type} disabled={blocked || busy || activeLogin(flow) || !!startRequest.current}
                onClick={() => provider.storedMethod ? setConfirmation({ provider, method: method.type }) : begin(provider, method.type)}>
                {method.label}{method.subscription ? ' · Subscription' : ''}</button>)}
                {provider.storedMethod && <button disabled={blocked || busy || activeLogin(flow)} onClick={() => setConfirmation({ provider })}>Remove credential</button>}
                {!provider.methods.length && <small>Configure on the server CLI</small>}
              </div>
            </div>)}
          </div>
          <div className="provider-default"><h3>Default for new tasks</h3><ModelPicker catalogue={catalogue} value={defaultModel ?? catalogue.defaultModel} onChange={setDefault} disabled={blocked || busy} />
            <button disabled={blocked || busy || !defaultModel} onClick={() => void operate(async () => {
              await agentRequest({ type: 'default.set', operationId: crypto.randomUUID(), expectedGeneration: catalogue.generation, model: defaultModel });
              setDefault(null); await connection.refreshAgent();
            })}>Save default</button><p>Existing tasks and running responses keep their selections.</p></div>
          <CompatibleForm disabled={blocked || busy || activeLogin(flow)} save={configuration => void operate(async () => {
            await agentRequest({ type: 'provider.configure', operationId: crypto.randomUUID(), expectedGeneration: catalogue.generation, configuration }); await connection.refreshAgent();
          })} />
          <p>OpenAI browser sign-in supports automatic return through this Mac. Other providers use their supplied device-code or manual-return steps. Ollama uses the managed pi-ollama-cloud provider; enter its Cloud API key here, then refresh models. General package installation is not enabled. Browser automation keeps its own model configuration.</p>
        </>}
      </>}
    </div>
  </section>;
}
