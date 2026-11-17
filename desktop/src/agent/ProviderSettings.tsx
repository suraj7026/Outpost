import { useEffect, useRef, useState } from 'react';
import { ChevronRight, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { call, nativeApp, recordedPreview } from '../api';
import { Badge, Button, Dialog, Section, SettingRow } from '../Interface';
import type { Connection } from '../useConnection';
import type { Login, Provider, ModelRef } from './types';
import { providerLabel } from './types';
import ModelPicker from './ModelPicker';
import BrowserSignIn from './BrowserSignIn';
import './agent.css';
import '../provider-runtime-parity.css';

const activeLogin = (flow: Login | null) => !!flow && ['running', 'waiting'].includes(flow.state);

function authenticationMessage(provider: Provider): string | null {
  const status = provider.authentication;
  if (provider.id !== 'ollama-cloud' || !status) return null;
  const messages = {
    missing: 'Add an Ollama Cloud API key to list models.',
    unverified: 'API key not yet validated. Refresh models to check it.',
    validated: status.quota === 'exhausted'
      ? 'API key validated · Ollama reports no remaining credits. Models are listed, but requests may fail until your allowance resets or you add credits.'
      : 'API key validated · Cloud catalogue, not per-model entitlement. Availability and limits are enforced by Ollama.',
    invalid_key: 'Ollama rejected this API key. Replace it with a valid Ollama Cloud key.',
    account_suspended: 'Ollama reports that this account is suspended. Check your Ollama account.',
    rate_limited: 'Ollama rate-limited the authentication check. This does not mean the key is invalid.',
    unavailable: 'Ollama authentication could not be checked. No inference test was sent. Try again later.',
  };
  return messages[status.state] + (status.retryAt ? ` Next check after ${new Date(status.retryAt).toLocaleTimeString()}.` : '');
}

function LoginPanel({ flow, busy, answer, cancel }: { flow: Login; busy: boolean; answer: (value: string) => void; cancel: () => void }) {
  const [value, setValue] = useState('');
  const input = flow.prompt?.input;
  const webLink = (url: string, label: string) => /^https?:\/\//i.test(url) ?
    <Button onClick={() => void call('open_url', { url }).catch(() => {})}>{label}</Button> : null;
  return <section className="provider-login" aria-label="Provider sign-in">
    <h3>{providerLabel(flow.providerId)} · {flow.state}</h3>
    <p>Sign-in runs on your server. Expires at {new Date(flow.expiresAt).toLocaleTimeString()}.</p>
    {flow.events.map((event, index) => <div key={index}>
      {event.type === 'auth_url' ? <><p>{event.instructions}</p><BrowserSignIn url={event.url} expiresAt={flow.expiresAt} manualPrompt={input?.type === 'manual_code'} disabled={busy || !activeLogin(flow)} answer={answer} /></> :
        event.type === 'device_code' ? <><p>Enter code <code>{event.userCode}</code></p>{webLink(event.verificationUri, 'Open device verification')}</> :
          'message' in event ? <><p>{event.message}</p>{event.type === 'info' && event.links?.map(link => <span key={link.url}>{webLink(link.url, link.label || 'Open provider instructions')}</span>)}</> : null}
    </div>)}
    {activeLogin(flow) && input && <form className="ui-form" autoComplete="off" onSubmit={event => { event.preventDefault(); if (!value || busy) return; const response = value; setValue(''); answer(response); }}>
      {input.type === 'manual_code' && <p>If the browser shows “can’t connect” for localhost, copy the full address from its address bar and paste it here—not into the conversation. The URL is sent privately to the active server sign-in.</p>}
      <label htmlFor="provider-answer">{input.message}</label>
      {input.type === 'select' ? <select id="provider-answer" autoFocus value={value} onChange={event => setValue(event.target.value)} disabled={busy}>
        <option value="">Choose an option</option>{input.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select> : <input id="provider-answer" autoFocus type={input.type === 'text' ? 'text' : 'password'} autoComplete="off" spellCheck={false}
        placeholder={input.placeholder} value={value} onChange={event => setValue(event.target.value)} disabled={busy} required />}
      <Button type="submit" disabled={busy || !value}>Continue</Button>
    </form>}
    {flow.state === 'succeeded' && <p>Credential saved. Model access still depends on your provider entitlement.</p>}
    {flow.state === 'failed' && <p role="alert">Sign-in failed. Check the provider instructions or use the shared server CLI.</p>}
    {activeLogin(flow) && <Button disabled={busy} onClick={cancel}>Cancel sign-in</Button>}
  </section>;
}

function CompatibleForm({ save, disabled }: { save: (configuration: Record<string, unknown>) => void; disabled: boolean }) {
  const [providerId, setProvider] = useState(''), [baseUrl, setUrl] = useState(''), [modelId, setModel] = useState('');
  const [api, setApi] = useState('openai-completions'), [allowHttp, setHttp] = useState(false);
  const [context, setContext] = useState('32768'), [tokens, setTokens] = useState('4096');
  return <details className="ui-details"><summary>Compatible endpoint</summary>
    <p>Use an exact model ID advertised by your server. Save the endpoint first, then add its API credential. No credential belongs in the URL.</p>
    <form className="ui-form" onSubmit={event => { event.preventDefault(); if (disabled) return; save({ providerId, baseUrl, api, allowInsecureHttp: allowHttp,
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
      <Button type="submit" disabled={disabled}>Save endpoint</Button>
    </form>
  </details>;
}

export default function ProviderSettings({ connection, requestedProvider }: { connection: Connection; requestedProvider?: { id: string } }) {
  const agentRequest = connection.api.agentRequest;
  const catalogue = connection.agentCatalogue;
  const [search, setSearch] = useState(''), [flow, setFlow] = useState<Login | null>(null);
  const [adding, setAdding] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  useEffect(() => { if (requestedProvider) { setSearch(requestedProvider.id); setSelectedId(requestedProvider.id); setManagingId(null); setConfirmation(null); setAdding(true); } }, [requestedProvider]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ provider: Provider; method?: 'api_key' | 'oauth' } | null>(null);
  const [defaultModel, setDefault] = useState<ModelRef | null>(null);
  const mounted = useRef(true), latestFlow = useRef<Login | null>(null), working = useRef(false);
  const startRequest = useRef<Record<string, unknown> | null>(null);
  const flowRevision = useRef(0);
  latestFlow.current = flow;
  const available = !!connection.runtime?.piManagement;
  const blocked = connection.retired || !!connection.info?.pendingError || !available || !connection.connected || !nativeApp() || recordedPreview() || !!connection.info?.pending;
  const authority = useRef(blocked); authority.current = blocked;
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; ++flowRevision.current;
    if (activeLogin(latestFlow.current)) void agentRequest({ type: 'login.cancel', flowId: latestFlow.current!.id }).catch(() => {});
  }; }, []);
  useEffect(() => {
    if (!activeLogin(flow) || blocked) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const revision = flowRevision.current;
      if (working.current) { timer = setTimeout(() => void poll(), 1200); return; }
      try {
        const next = await agentRequest<Login>({ type: 'login.status', flowId: flow!.id });
        if (!stopped && revision === flowRevision.current && !authority.current) {
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
    if (!mounted.current || authority.current || working.current) return;
    ++flowRevision.current;
    working.current = true; setBusy(true); setError('');
    try { await action(); } catch { if (mounted.current) setError('Provider operation could not be confirmed. Refresh status before retrying; nothing is automatically resent.'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const start = async (request: Record<string, unknown>) => {
    startRequest.current = request;
    const revision = flowRevision.current;
    const next = await agentRequest<Login>(request);
    startRequest.current = null;
    if (mounted.current && revision === flowRevision.current) setFlow(next);
    else if (activeLogin(next)) await agentRequest({ type: 'login.cancel', flowId: next.id });
  };
  const begin = (provider: Provider, method: 'api_key' | 'oauth') => void operate(async () => {
    if (activeLogin(latestFlow.current) || startRequest.current) return;
    setAdding(false); setManagingId(null); setConfirmation(null);
    await start({ type: 'login.start', providerId: provider.id, method, operationId: crypto.randomUUID() });
  });
  const authBlocked = blocked || busy || activeLogin(flow) || !!startRequest.current;
  const selected = catalogue?.providers.find(provider => provider.id === selectedId);
  const managing = catalogue?.providers.find(provider => provider.id === managingId);
  const results = catalogue?.providers.filter(provider => !provider.configured && !provider.storedMethod && `${provider.name} ${provider.id}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const closeMenus = () => { setAdding(false); setManagingId(null); setConfirmation(null); };
  const authentication = (provider: Provider) => <>
    <SettingRow title={adding ? provider.name : 'Authentication'} description={provider.storedMethod ? `Stored ${provider.storedMethod === 'oauth' ? 'browser sign-in' : 'API key'}` : provider.configured ? 'Configured on server' : 'Choose a supported sign-in method'} icon={<KeyRound size={18} />} />
    {authenticationMessage(provider) && <p role="status">{authenticationMessage(provider)}</p>}
    <p>Credentials stay in this server’s Pi profile. Saving a credential does not verify model access.</p>
    <div className="provider-auth-methods">{provider.methods.map(method => <Button key={method.type} disabled={authBlocked} onClick={() => provider.storedMethod ? setConfirmation({ provider, method: method.type }) : begin(provider, method.type)}>{method.label}{method.subscription ? ' · Subscription' : ''}</Button>)}
      {!provider.methods.length && <p>Configure on the server CLI</p>}
    </div>
    {provider.storedMethod && <Button variant="danger" disabled={authBlocked} onClick={() => setConfirmation({ provider })}>Remove credential…</Button>}
    {confirmation?.provider.id === provider.id && <section className="provider-confirm" aria-label="Confirm credential change">
      <p>{confirmation.method ? `Replace the stored credential for ${provider.name}? Pi stores one credential per provider.` : `Remove the stored credential for ${provider.name}? This does not revoke the provider account or remove server environment credentials.`}</p>
      <div className="ui-dialog-actions"><Button disabled={authBlocked} onClick={() => confirmation.method ? begin(provider, confirmation.method) : void operate(async () => {
        await agentRequest({ type: 'provider.logout', providerId: provider.id, operationId: crypto.randomUUID() }); setConfirmation(null); await connection.refreshAgent();
      })}>Confirm</Button><Button disabled={busy} onClick={() => setConfirmation(null)}>Keep credential</Button></div>
    </section>}
  </>;
  return <div className="provider-settings provider-runtime-stack" aria-label="Models & providers">
    {!available ? <p>Server update required: provider management is not enabled on this connection. Existing Ollama tasks remain available.</p> : <>
      <Section title="Configured providers" description="Providers configured for this server." action={<Button variant="primary" disabled={authBlocked || !catalogue} onClick={() => { setSearch(''); setSelectedId(null); setConfirmation(null); setAdding(true); }}><Plus size={16} />Add provider</Button>}>
        {!catalogue ? <p>Provider catalogue unavailable. Refresh to load the server’s supported sign-in methods.</p> : <>
          {!catalogue.providers.some(provider => provider.configured || provider.storedMethod) && <p>No configured providers. Add a provider, then refresh models to check access.</p>}
          <div className="configured-provider-list">
            {catalogue.providers.filter(provider => provider.configured || provider.storedMethod).map(provider => {
              const count = catalogue.models.filter(model => model.providerId === provider.id).length;
              return <SettingRow className="configured-provider-row" key={provider.id} title={provider.name} description={`${provider.id} · ${count} selectable model${count === 1 ? '' : 's'}`} icon={<span className="provider-identity">{provider.name[0]}</span>}>
                <Badge tone={count ? 'neutral' : 'warning'}>{count ? provider.storedMethod ? 'Credential stored' : 'Configured' : 'Access unverified'}</Badge>
                <Button onClick={() => { setManagingId(provider.id); setConfirmation(null); }}>Manage</Button>
              </SettingRow>;
            })}
          </div>
        </>}
        <div className="provider-runtime-footer"><Button variant="ghost" disabled={blocked || busy} onClick={() => void operate(async () => { await connection.refreshAgent(true); })}><RefreshCw size={16} />Refresh models</Button><span>Credentials alone do not verify model access</span></div>
        {catalogue?.refreshErrors.length ? <p role="status">Some providers could not refresh: {catalogue.refreshErrors.join(', ')}{catalogue.refreshErrors.includes('openai') ? '. ChatGPT models are unavailable until account verification succeeds.' : ''}</p> : null}
        {error && <p role="alert">{error}</p>}
        {startRequest.current && <Button disabled={blocked || busy} onClick={() => void operate(() => start(startRequest.current!))}>Recover sign-in status</Button>}
      </Section>
      {flow && <LoginPanel key={`${flow.id}:${flow.prompt?.id ?? flow.state}`} flow={flow} busy={busy || blocked}
        answer={value => void operate(async () => {
          if (!activeLogin(latestFlow.current) || latestFlow.current?.id !== flow.id || latestFlow.current.prompt?.id !== flow.prompt?.id) return;
          const next = await agentRequest<Login>({ type: 'login.answer', flowId: flow.id, promptId: flow.prompt!.id, value });
          if (mounted.current) setFlow(next);
          if (next.state === 'succeeded') await connection.refreshAgent();
        })}
        cancel={() => void operate(async () => { const next = await agentRequest<Login>({ type: 'login.cancel', flowId: flow.id }); if (mounted.current) setFlow(next); })} />}
      {catalogue && <Section title="Default model" description="Used for new tasks on this server. Existing tasks keep their model.">
        <div className="provider-default-control"><ModelPicker catalogue={catalogue} value={defaultModel ?? catalogue.defaultModel} onChange={setDefault} disabled={blocked || busy} />
          <Button disabled={blocked || busy || !defaultModel} onClick={() => void operate(async () => {
            await agentRequest({ type: 'default.set', operationId: crypto.randomUUID(), expectedGeneration: catalogue.generation, model: defaultModel });
            setDefault(null); await connection.refreshAgent();
          })}>Save default</Button></div>
      </Section>}
    </>}
    <details className="ui-details"><summary>Credential storage & model access</summary>
      {catalogue && <dl className="ui-facts"><dt>Pi</dt><dd>{catalogue.piVersion}</dd><dt>Release</dt><dd>{catalogue.releaseId ?? 'Not reported'}</dd><dt>Server profile</dt><dd><code>{catalogue.profilePath}</code></dd><dt>Configuration</dt><dd>{catalogue.generation.slice(0, 12)}</dd></dl>}
      <p>Credentials stay in the server Pi profile. Your Mac sends signed management requests, not chat messages. Cloud models receive task, tool and page context.</p>
      <p>{catalogue?.providers.some(provider => provider.id === 'ollama-cloud' && provider.authentication)
        ? 'Models must pass their provider’s access policy. Ollama validates your API key and lists its cloud catalogue; it does not verify entitlement to each model. Other providers without an approved access verifier stay blocked—even after saving a key.'
        : 'Only models with verified access for the current credential are selectable. Stored credentials and public catalogues are not proof of access. Providers or authentication methods without an approved verifier stay blocked—even after saving a key.'}</p>
      <p>OpenAI browser sign-in supports automatic return through this Mac. Other providers use their supplied device-code or manual-return steps. Ollama uses the managed pi-ollama-cloud provider; enter its Cloud API key here, then refresh models. Pi controls Camoufox directly using the task’s selected model. There is no separate browser-agent model or credential configuration.</p>
    </details>
    {available && catalogue && adding && <Dialog title={selected ? `Add ${selected.name}` : 'Add provider'} onClose={closeMenus} className="provider-runtime-dialog provider-add-dialog">
      {selected ? <><Button variant="ghost" onClick={() => { setSelectedId(null); setConfirmation(null); }}>Back to providers</Button>{authentication(selected)}</> : <>
        <div className="ui-form"><label htmlFor="provider-search">Search providers</label><input autoFocus id="provider-search" type="search" value={search} placeholder="Search by provider name" onChange={e => setSearch(e.target.value)} /></div>
        <div className="provider-search-results">{results.map(provider => <Button variant="ghost" className="provider-result" key={provider.id} onClick={() => setSelectedId(provider.id)}><span><strong>{provider.name}</strong><small>{provider.id}</small></span><ChevronRight size={16} /></Button>)}
          {!results.length && <p>No matching providers. Manage an existing provider or configure a compatible endpoint below.</p>}
        </div>
        <CompatibleForm disabled={authBlocked} save={configuration => void operate(async () => {
          if (activeLogin(latestFlow.current) || startRequest.current) return;
          await agentRequest({ type: 'provider.configure', operationId: crypto.randomUUID(), expectedGeneration: catalogue.generation, configuration }); setAdding(false); await connection.refreshAgent();
        })} />
      </>}
      <div className="ui-dialog-actions"><Button onClick={closeMenus}>Done</Button></div>
    </Dialog>}
    {available && managing && catalogue && <Dialog title={managing.name} onClose={closeMenus} className="provider-runtime-dialog provider-manage-dialog">
      {authentication(managing)}
      <h3>Selectable models</h3>
      <p>{catalogue.models.filter(model => model.providerId === managing.id).map(model => model.name).join(', ') || (managing.authentication ? 'No selectable models · check authentication and refresh the catalogue' : 'No verified models · selection blocked')}</p>
      <p>Removing a stored credential does not revoke the provider account or remove credentials supplied by the server environment.</p>
      <div className="ui-dialog-actions"><Button disabled={blocked || busy} onClick={() => void operate(async () => { await connection.refreshAgent(true); })}>Refresh models</Button><Button onClick={closeMenus}>Done</Button></div>
    </Dialog>}
  </div>;
}
