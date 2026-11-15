import { useState, type ReactNode } from 'react';
import { ArrowDownToLine, Check, CheckCircle2, ChevronRight, Copy, Cpu, KeyRound, Laptop, Pause, Play, Plus, Puzzle, RefreshCw, Search, Server, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react';
import { Badge, Button, EmptyState, Field, IconButton, Modal, Section, SelectField, useNotice } from './ui';
import './settings.css';

function SettingRow({ title, description, children, icon }: { title: string; description?: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="row settings-review-row">{icon && <span className="settings-review-icon">{icon}</span>}<div className="grow"><div className="list-title">{title}</div>{description && <div className="detail-text">{description}</div>}</div>{children && <div className="inline settings-review-row-actions">{children}</div>}</div>;
}

function Confirmation({ title, children, action, danger, onClose, onConfirm }: { title: string; children: ReactNode; action: string; danger?: boolean; onClose: () => void; onConfirm: () => void }) {
  const [approved, setApproved] = useState(false);
  return <Modal title={title} onClose={onClose}><div className="settings-review-dialog stack">{children}<label className="settings-review-check"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /><span>I understand. Apply this change to sample data only.</span></label><div className="dialog-actions"><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} disabled={!approved} onClick={onConfirm}>{action}</Button></div></div></Modal>;
}

function GeneralPage() {
  const notice = useNotice();
  const [name, setName] = useState('Development');
  const [savedName, setSavedName] = useState(name);
  const [removed, setRemoved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (removed) return <EmptyState icon={<Server size={24} />} title="Connection removed from this preview" description="The sample server and its history are unchanged. No real saved connection was removed." action={<Button onClick={() => { setRemoved(false); notice('Sample connection restored.'); }}>Restore sample connection</Button>} />;
  return <div className="stack">
    <Section title="Server details" description="A familiar name for this server on this Mac.">
      <form className="settings-review-name-form" onSubmit={event => { event.preventDefault(); setSavedName(name.trim()); notice('Server name saved in this preview only.'); }}><Field label="Server name" value={name} maxLength={80} required onChange={event => setName(event.target.value)} /><Button type="submit" disabled={!name.trim() || name.trim() === savedName}>Save name</Button></form>
      <SettingRow title="Connection" description="Trusted SSH route · last synced just now" icon={<ShieldCheck size={18} />}><Badge tone="success">Connected</Badge></SettingRow>
      <SettingRow title="Data stays on your server" description="Tasks, history, provider credentials and runtime configuration live on this server." />
      <details className="settings-review-details"><summary>Installation details</summary><dl className="settings-review-facts"><dt>Installation</dt><dd>sample-development-01</dd><dt>Server release</dt><dd>2026.11-preview</dd><dt>Storage</dt><dd>/var/lib/outpost (sample)</dd></dl></details>
    </Section>
    <Section title="Remove connection" description="Forget this server on this Mac. This does not uninstall Outpost or delete server data."><div className="settings-review-section-action"><Button variant="danger" onClick={() => setConfirm(true)}>Remove connection…</Button></div></Section>
    {confirm && <Confirmation title="Remove this saved connection?" action="Remove sample connection" danger onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); setRemoved(true); notice('Sample connection removed. No server was changed.'); }}><p>This Mac would lose its saved route to <strong>{savedName}</strong>. The server keeps running, and its tasks, credentials and history remain on the server. Other devices are unaffected.</p></Confirmation>}
  </div>;
}

function ConnectionPage() {
  const notice = useNotice();
  const [paused, setPaused] = useState(false);
  const [route, setRoute] = useState('ssh');
  const [routeDialog, setRouteDialog] = useState(false);
  const [extraRoute, setExtraRoute] = useState('');
  const [routes, setRoutes] = useState<string[]>([]);
  const [tested, setTested] = useState(false);
  return <div className="stack">
    <Section title="Connection" description="Pause access without removing this server.">
      <SettingRow title={paused ? 'Connection paused' : 'Connected over SSH'} description={paused ? 'This preview is read-only until you resume.' : 'Trusted access reconnects automatically after a dropped connection.'} icon={<Server size={18} />}><Badge tone={paused ? 'warning' : 'success'}>{paused ? 'Paused' : 'Connected'}</Badge><Button onClick={() => { setPaused(!paused); notice(paused ? 'Sample connection resumed.' : 'Sample connection paused. No SSH session was changed.'); }}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? 'Resume' : 'Pause'}</Button></SettingRow>
      <div className="settings-review-route-form"><SelectField label="Verified route" value={route} onChange={event => { setRoute(event.target.value); setTested(false); notice('Sample route selected. No connection was opened.'); }}><option value="ssh">SSH · development.example</option><option value="https">HTTPS · development.example</option>{routes.map(value => <option key={value} value={value}>{value}</option>)}</SelectField><Button onClick={() => { setTested(true); notice('Sample connection check passed. No network request was made.'); }} disabled={paused}><RefreshCw size={16} />Check connection</Button></div>
      {tested && <p className="settings-review-inline-status" role="status"><CheckCircle2 size={16} />Sample route reachable; installation identity matches.</p>}
      <div className="settings-review-section-action"><Button variant="ghost" onClick={() => setRouteDialog(true)}><Plus size={16} />Add route</Button></div>
    </Section>
    <Section title="Trust & credentials"><SettingRow title="SSH credentials" description="In the native app, this Mac’s signing key stays in macOS Keychain. Provider credentials stay on the server." icon={<KeyRound size={18} />} /><details className="settings-review-details"><summary>How routes are verified</summary><p>Each route must authenticate as the saved installation before use. A matching installation ID does not replace HTTPS certificate or SSH host-key verification. This offline preview performs none of these checks.</p></details></Section>
    {routeDialog && <Modal title="Add a route" onClose={() => setRouteDialog(false)}><form className="form-grid settings-review-dialog" onSubmit={event => { event.preventDefault(); const value = extraRoute.trim(); if (!value || routes.includes(value)) return; setRoutes([...routes, value]); setRoute(value); setTested(false); setExtraRoute(''); setRouteDialog(false); notice('Sample route added. Identity and transport trust were not verified.'); }}><p className="muted small">Try a fictional HTTPS route. A real connection would verify transport trust and the installation identity before saving.</p><Field label="Route URL" type="url" required pattern="https://.+" placeholder="https://development.example" value={extraRoute} onChange={event => setExtraRoute(event.target.value)} /><div className="dialog-actions"><Button onClick={() => setRouteDialog(false)} type="button">Cancel</Button><Button type="submit" variant="primary" disabled={!extraRoute.trim() || routes.includes(extraRoute.trim())}>Add sample route</Button></div></form></Modal>}
  </div>;
}

type Provider = { id: string; name: string; models: string[]; method: string };
const providerCatalogue: Provider[] = [
  { id: 'anthropic', name: 'Anthropic', models: ['Claude Sonnet', 'Claude Opus'], method: 'API key' },
  { id: 'openai', name: 'OpenAI', models: ['GPT-5', 'GPT-5 mini'], method: 'Browser sign-in' },
  { id: 'ollama', name: 'Ollama Cloud', models: ['Qwen Coder'], method: 'Cloud API key' },
  { id: 'google', name: 'Google', models: ['Gemini Pro'], method: 'API key' },
  { id: 'compatible', name: 'OpenAI-compatible endpoint', models: ['Custom model'], method: 'Server configuration' },
];

function ModelsPage() {
  const notice = useNotice();
  const [providers, setProviders] = useState<Provider[]>(providerCatalogue.slice(0, 2));
  const [defaultModel, setDefaultModel] = useState('anthropic/Claude Sonnet');
  const [dialog, setDialog] = useState<'add' | 'import' | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Provider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [managing, setManaging] = useState<Provider | null>(null);
  const [importProvider, setImportProvider] = useState('ollama');
  const [refreshed, setRefreshed] = useState(false);
  const openAdd = () => { setSearch(''); setSelected(null); setDialog('add'); };
  const available = providerCatalogue.filter(provider => !providers.some(item => item.id === provider.id));
  const results = available.filter(provider => provider.name.toLowerCase().includes(search.trim().toLowerCase()));
  const addProvider = (provider: Provider) => { setProviders([...providers, provider]); if (!defaultModel) setDefaultModel(`${provider.id}/${provider.models[0]}`); setDialog(null); setSelected(null); notice(`${provider.name} added with sample access. No credentials were read or saved.`); };
  return <div className="stack">
    <Section title="Configured providers" description="Only providers available to this server. All access and models below are sample data." action={<Button variant="primary" onClick={openAdd}><Plus size={16} />Add provider</Button>}>
      {providers.length ? providers.map(provider => <SettingRow key={provider.id} title={provider.name} description={`${provider.models.length} sample models · ${provider.method}`} icon={<span className="settings-review-provider-letter">{provider.name[0]}</span>}><Badge tone="success">Sample access</Badge><Button onClick={() => setManaging(provider)}>Manage</Button></SettingRow>) : <EmptyState icon={<KeyRound size={22} />} title="No configured providers" description="Add a provider to choose a default model for new tasks." action={<Button onClick={openAdd}>Add provider</Button>} />}
      <div className="settings-review-provider-footer"><Button variant="ghost" onClick={() => { setRefreshed(true); notice('Sample models refreshed. No provider was contacted.'); }}><RefreshCw size={16} />Refresh models</Button><span className="detail-text">{refreshed ? 'Sample catalogue refreshed just now' : 'Credentials alone do not verify model access'}</span></div>
    </Section>
    <Section title="Default model" description="Used for new tasks on this server. Existing tasks keep their model."><div className="settings-review-field-width"><SelectField label="Model for new tasks" disabled={!providers.length} value={defaultModel} onChange={event => { setDefaultModel(event.target.value); notice('Default model changed for new sample tasks only.'); }}>{!providers.length && <option value="">Add a provider first</option>}{providers.map(provider => <optgroup label={provider.name} key={provider.id}>{provider.models.map(model => <option key={model} value={`${provider.id}/${model}`}>{model}</option>)}</optgroup>)}</SelectField></div></Section>
    <Section title="Bring existing settings" description="Review a provider configuration before using it on this server."><div className="settings-review-section-action"><Button variant="ghost" onClick={() => { setImportProvider(available[0]?.id ?? ''); setDialog('import'); }}><ArrowDownToLine size={16} />Import settings…</Button></div><details className="settings-review-details"><summary>Credential storage & model access</summary><p>Pi keeps provider credentials on the server, not in this page. A saved key or a public model catalogue does not prove model access; only verified models should be selectable in the real app. Tasks using cloud models send task, tool and page context to that provider.</p></details></Section>
    {dialog === 'add' && <Modal title={selected ? `Add ${selected.name}` : 'Add provider'} onClose={() => setDialog(null)}><div className="settings-review-dialog stack">{selected ? <><Button variant="ghost" onClick={() => setSelected(null)}>Back to providers</Button><SettingRow title={selected.name} description={selected.method} icon={<KeyRound size={18} />} /><p className="muted small">Preview connection flow only. No browser opens and no API key is requested. A real flow must use this server’s supported authentication method and verify model access.</p><div className="settings-review-callout"><ShieldCheck size={18} /><span>Use a fictional connected state. Nothing is stored on your Mac or server.</span></div><div className="dialog-actions"><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" onClick={() => addProvider(selected)}>Connect sample provider</Button></div></> : <><Field label="Search providers" type="search" placeholder="Search by provider name" value={search} onChange={event => setSearch(event.target.value)} /><div className="settings-review-provider-results">{results.map(provider => <Button key={provider.id} variant="ghost" onClick={() => setSelected(provider)}><span className="grow">{provider.name}<small className="detail-text">{provider.method}</small></span><ChevronRight size={16} /></Button>)}{!results.length && <EmptyState icon={<Search size={20} />} title={available.length ? 'No matching provider' : 'All sample providers added'} description={available.length ? 'Try another name. This preview includes a small sample catalogue.' : 'Manage an existing provider to review its settings.'} />}</div></>}</div></Modal>}
    {dialog === 'import' && <Modal title="Import provider settings" onClose={() => setDialog(null)}><div className="settings-review-dialog form-grid"><p className="muted small">Review a fictional configuration from another server. This preview does not read files, Keychain or credentials.</p><SelectField label="Sample configuration" value={importProvider} onChange={event => setImportProvider(event.target.value)} disabled={!available.length}>{available.length ? available.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · sample configuration</option>) : <option value="">All sample providers are already configured</option>}</SelectField><p className="small muted">Importing never proves access. In the real app, review the source and destination, confirm credential replacement and verify access before choosing models.</p><div className="dialog-actions"><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!importProvider} onClick={() => { const provider = available.find(item => item.id === importProvider); if (provider) addProvider(provider); }}>Import sample settings</Button></div></div></Modal>}
    {managing && <Modal title={managing.name} onClose={() => setManaging(null)}><div className="settings-review-dialog stack"><SettingRow title="Authentication" description={`${managing.method} · sample access only`}><Badge tone="success">Configured</Badge></SettingRow><div><div className="list-title">Sample models</div><p className="muted small">{managing.models.join(', ')}</p></div><p className="small muted">Credentials belong to this server. Removing a stored credential does not revoke the provider account or remove credentials supplied by the server environment.</p><div className="dialog-actions"><Button variant="danger" onClick={() => { setRemoving(managing); setManaging(null); }}>Remove credential…</Button><Button onClick={() => { setManaging(null); notice('Sample access checked. No credential or entitlement was verified.'); }}>Check sample access</Button></div></div></Modal>}
    {removing && <Confirmation title={`Remove ${removing.name} credential?`} danger action="Remove sample credential" onClose={() => setRemoving(null)} onConfirm={() => { const remaining = providers.filter(provider => provider.id !== removing.id); setProviders(remaining); if (defaultModel.startsWith(`${removing.id}/`)) setDefaultModel(remaining[0] ? `${remaining[0].id}/${remaining[0].models[0]}` : ''); setRemoving(null); notice('Sample credential removed; default model adjusted if needed. No real account was revoked.'); }}><p>This would remove Pi’s stored credential for this provider on this server. It does not revoke the provider account, remove server environment credentials or change completed tasks. A default using this provider will switch to the first remaining sample model, if available.</p></Confirmation>}
  </div>;
}

function RuntimePage() {
  const notice = useNotice();
  const [checked, setChecked] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [confirm, setConfirm] = useState<'restart' | 'update' | null>(null);
  const [restarts, setRestarts] = useState(0);
  return <div className="stack">
    <Section title="Pi runtime" description="Pi runs tasks on this server, not on your Mac.">
      <SettingRow title={`Pi ${updated ? '0.52.1' : '0.52.0'}`} description={`Sample release ${updated ? '2026.11.2' : '2026.11.1'} · no active sample tasks`} icon={<Cpu size={18} />}><Badge tone="success">Running</Badge></SettingRow>
      <div className="settings-review-section-action inline"><Button onClick={() => { setChecked(true); notice(updated ? 'Sample release is up to date. No update service was contacted.' : 'Sample compatible release found. No update service was contacted.'); }}><RefreshCw size={16} />Check for update</Button><Button variant="ghost" onClick={() => setConfirm('restart')}>Restart preview…</Button></div>
      {checked && <div className="settings-review-callout"><CheckCircle2 size={18} /><div className="grow"><div className="list-title">{updated ? 'Sample runtime is up to date' : 'A compatible sample release is available'}</div><div className="detail-text">{updated ? 'No real server was checked or updated.' : 'Pi 0.52.1 and bundled extensions · preview data only'}</div></div>{!updated && <Button onClick={() => setConfirm('update')}>Review update…</Button>}</div>}
      {restarts > 0 && <p className="settings-review-inline-status" role="status"><CheckCircle2 size={16} />Sample restart completed{restarts > 1 ? ` (${restarts})` : ''}. No process was restarted.</p>}
    </Section>
    <Section title="Bundled extensions" description="Managed together with a compatible Outpost server release.">
      <SettingRow title="Ollama Cloud" description="Cloud model provider · sample v1.2.0" icon={<Puzzle size={18} />}><Badge>Bundled</Badge></SettingRow>
      <SettingRow title="Camoufox" description="Browser tools · sample v1.4.0" icon={<Puzzle size={18} />}><Badge>Bundled</Badge></SettingRow>
      <details className="settings-review-details"><summary>Extension management details</summary><p>General extension installation and independent Pi upgrades are not offered here. Pi and qualified extensions update as one compatible server release. Camoufox uses the task’s selected model; it has no separate model or credential setting.</p><p>These update and restart controls are design proposals with mock-only effects, not a promise of backend support. A real maintenance flow must check server capabilities first.</p></details>
    </Section>
    {confirm && <Confirmation title={confirm === 'update' ? 'Review sample release update' : 'Restart the sample runtime?'} action={confirm === 'update' ? 'Simulate update' : 'Simulate restart'} onClose={() => setConfirm(null)} onConfirm={() => { if (confirm === 'update') setUpdated(true); else setRestarts(restarts + 1); notice(confirm === 'update' ? 'Sample runtime version updated. No software was installed.' : 'Sample runtime restarted. No server process was touched.'); setConfirm(null); }}><div className="stack"><p>{confirm === 'update' ? 'Sample release 2026.11.2 updates Pi 0.52.0 to 0.52.1 with its qualified extensions.' : 'A real restart would briefly interrupt this server. This preview has no active tasks and only changes the displayed state.'}</p><div className="settings-review-callout"><TriangleAlert size={18} /><span>Proposed real behavior: pause new work, wait for active tasks and sign-ins, then restart. Do not silently interrupt running tasks.</span></div><p className="small muted">Credentials, sessions and task history stay on the server. A real update must retain a compatible previous release and verify health. If the outcome is unknown, check the original operation status; do not launch again. Uncertain recovery must keep queued work paused.</p></div></Confirmation>}
  </div>;
}

type Device = { id: string; name: string; kind: 'mac' | 'phone'; self?: boolean; revoked?: boolean; key: string };
const sampleDevices: Device[] = [
  { id: 'sample-mac-01', name: 'MacBook Pro', kind: 'mac', self: true, key: 'SAMPLE-PUBLIC-KEY-MAC-NOT-VALID' },
  { id: 'sample-phone-02', name: 'iPhone', kind: 'phone', key: 'SAMPLE-PUBLIC-KEY-PHONE-NOT-VALID' },
];

function DevicesPage() {
  const notice = useNotice();
  const [devices, setDevices] = useState(sampleDevices);
  const [adding, setAdding] = useState(false);
  const [details, setDetails] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [name, setName] = useState('');
  const [verified, setVerified] = useState(false);
  const selfRevoked = devices.some(device => device.self && device.revoked);
  const copy = async (value: string) => { try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(value); notice('Sample public identity copied. No private key is included.'); } catch { notice('Clipboard unavailable. Select the sample identity text in Details to copy it.'); } };
  return <div className="stack">
    <Section title="Trusted devices" description="Devices allowed to send signed requests to this server." action={<Button variant="primary" disabled={selfRevoked} onClick={() => { setAdding(true); setName(''); setVerified(false); }}><Plus size={16} />Add device</Button>}>
      {selfRevoked && <div className="settings-review-callout" role="status"><TriangleAlert size={18} /><span>This Mac has lost sample access. Use another trusted device to manage the server.</span><Button onClick={() => { setDevices(sampleDevices); notice('Sample device access reset.'); }}>Reset sample</Button></div>}
      {devices.map(device => <SettingRow key={device.id} title={`${device.name}${device.self ? ' (this Mac)' : ''}`} description={device.revoked ? 'Access revoked in this preview' : device.self ? 'Signing key stays in macOS Keychain' : 'Paired device · sample authority'} icon={device.kind === 'phone' ? <Smartphone size={18} /> : <Laptop size={18} />}><Badge tone={device.revoked ? 'neutral' : 'success'}>{device.revoked ? 'Revoked' : 'Trusted'}</Badge><Button onClick={() => setDetails(device)}>Details</Button></SettingRow>)}
      <div className="settings-review-section-action"><Button variant="ghost" onClick={() => notice('Sample device authority refreshed. No authenticated server snapshot was requested.')}><RefreshCw size={16} />Refresh devices</Button></div>
    </Section>
    <Section title="Your device identity" description="Share only the device ID and public pairing key. Never share a private key."><details className="settings-review-details"><summary>View this Mac’s sample pairing details</summary><dl className="settings-review-facts"><dt>Device ID</dt><dd>{sampleDevices[0].id}</dd><dt>Public key</dt><dd>{sampleDevices[0].key}</dd></dl><Button variant="ghost" onClick={() => void copy(`${sampleDevices[0].id}\n${sampleDevices[0].key}`)}><Copy size={16} />Copy sample pairing details</Button></details></Section>
    {adding && <Modal title="Add a trusted device" onClose={() => setAdding(false)}><form className="form-grid settings-review-dialog" onSubmit={event => { event.preventDefault(); if (!verified || !name.trim()) return; setDevices([...devices, { id: `sample-device-${devices.length + 1}`, name: name.trim(), kind: 'mac', key: 'SAMPLE-PUBLIC-KEY-NOT-VALID' }]); setAdding(false); notice('Sample device added. No identity was enrolled on a server.'); }}><p className="small muted">In the real app, copy the ID and public pairing key from the other device and verify them with its owner. This mock uses a generated fictional identity; do not enter real keys.</p><Field label="Device name" placeholder="Studio Mac" required maxLength={80} value={name} onChange={event => setName(event.target.value)} /><div className="settings-review-callout"><KeyRound size={18} /><span>Sample public identity ready. No private key or pairing token is needed.</span></div><label className="settings-review-check"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} /><span>I reviewed the sample identity. A real enrollment requires owner verification.</span></label><p className="detail-text">If enrollment has an unknown outcome, refresh the device list and verify the same ID and key before trying again. Never automatically retry enrollment.</p><div className="dialog-actions"><Button type="button" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!name.trim() || !verified}>Add sample device</Button></div></form></Modal>}
    {details && <Modal title={details.name} onClose={() => setDetails(null)}><div className="settings-review-dialog stack"><dl className="settings-review-facts"><dt>Device ID</dt><dd>{details.id}</dd><dt>Public pairing key</dt><dd>{details.key}</dd><dt>Authority</dt><dd>{details.revoked ? 'Revoked' : 'Trusted'} (sample)</dd></dl><div className="dialog-actions"><IconButton label="Copy sample device identity" onClick={() => void copy(`${details.id}\n${details.key}`)}><Copy size={18} /></IconButton><Button variant="danger" disabled={details.revoked || selfRevoked} onClick={() => { setRevoking(details); setDetails(null); }}>Revoke access…</Button><Button onClick={() => setDetails(null)}>Done</Button></div></div></Modal>}
    {revoking && <Confirmation title={`Revoke ${revoking.name}?`} action="Revoke sample access" danger onClose={() => setRevoking(null)} onConfirm={() => { setDevices(devices.map(device => device.id === revoking.id ? { ...device, revoked: true } : device)); setRevoking(null); notice('Sample access revoked. No server authority was changed.'); }}><div className="stack"><p>This device would lose the ability to send future signed requests. Revocation does not undo tasks or external effects that already happened.</p>{revoking.self && <div className="settings-review-callout"><TriangleAlert size={18} /><span>You are revoking this Mac. It will lose access. Another trusted device is needed to administer the server.</span></div>}<p className="small muted">The real action must use fresh device authority. If the device record changes, cancel and review it again before revoking.</p></div></Confirmation>}
  </div>;
}

function RecoveryPage() {
  const notice = useNotice();
  const [scenario, setScenario] = useState('held');
  const [confirm, setConfirm] = useState<'resume' | 'retry' | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [receiptChecked, setReceiptChecked] = useState(false);
  const held = scenario !== 'healthy';
  const unknown = scenario === 'unknown';
  return <div className="stack">
    <div className="settings-review-scenario"><SelectField label="Sample recovery state" value={scenario} onChange={event => { setScenario(event.target.value); setReviewed(false); setReceiptChecked(false); }}><option value="held">Work paused after recovery</option><option value="unknown">Command outcome unknown</option><option value="healthy">No recovery hold</option></SelectField></div>
    <Section title="Recovery status" description="Check what happened before allowing queued work to run.">
      <div className={`settings-review-recovery-state${held ? ' settings-review-recovery-held' : ''}`}>{held ? <Pause size={22} /> : <ShieldCheck size={22} />}<div className="grow"><h3>{unknown ? 'One command needs a confirmed outcome' : held ? 'Queued work is paused' : 'Ready for new work'}</h3><p>{unknown ? 'A connection was lost before a command’s result was confirmed. Do not send a new copy.' : held ? 'The sample server was restored. Two queued tasks will stay paused until you review and resume.' : 'No recovery hold in this sample. This is not a live health or authority check.'}</p></div><Badge tone={held ? 'warning' : 'success'}>{held ? 'Needs review' : 'No hold'}</Badge></div>
      <SettingRow title="Device authority" description="Sample trusted devices reviewed; no revoked device is allowed to send new requests." icon={<ShieldCheck size={18} />}><Badge>Sample only</Badge></SettingRow>
      <SettingRow title="Queued tasks" description={held ? '2 waiting · neither will run until work resumes' : 'New and queued sample work may run'} icon={<Pause size={18} />} />
      {unknown ? <div className="settings-review-section-action stack"><p className="small muted">Check the original operation receipt first. Retrying must reuse the original operation key; it is not a new command or a way to undo external effects.</p><div className="inline"><Button onClick={() => { setReceiptChecked(true); notice('Sample receipt still has an unknown outcome. No real status was checked.'); }}><RefreshCw size={16} />Check sample command status</Button><Button disabled={!receiptChecked} onClick={() => setConfirm('retry')}>Retry same sample command…</Button></div>{receiptChecked && <p role="status" className="detail-text">Sample receipt is still unknown. Resume remains blocked.</p>}</div> : held ? <div className="settings-review-section-action stack"><label className="settings-review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed trusted devices, pending work and possible external effects in this sample.</span></label><div><Button variant="primary" disabled={!reviewed} onClick={() => setConfirm('resume')}><Play size={16} />Resume sample work…</Button></div></div> : <p className="settings-review-inline-status"><Check size={16} />No recovery action needed in this sample.</p>}
      <details className="settings-review-details"><summary>Recovery record & safety details</summary><dl className="settings-review-facts"><dt>Record</dt><dd>Sample revision 7</dd><dt>Reason</dt><dd>{held ? 'Restored server snapshot' : 'Sample hold reviewed and cleared'}</dd>{unknown && <><dt>Original operation key</dt><dd>sample-operation-0042</dd></>}</dl><p>Resuming allows queued work to run. It does not reconcile unknown commands, undo external effects or prove device authority. If recovery storage cannot be read, mutations must remain blocked and recovery files retained. Missing recovery records are not evidence of a reviewed recovery.</p></details>
    </Section>
    {confirm && <Confirmation title={confirm === 'resume' ? 'Resume queued work?' : 'Retry the same sample command?'} action={confirm === 'resume' ? 'Resume sample work' : 'Simulate same-key retry'} onClose={() => setConfirm(null)} onConfirm={() => { if (confirm === 'resume') { setScenario('healthy'); notice('Sample work resumed. No queued task was actually dispatched.'); } else { setScenario('held'); setReviewed(false); notice('Sample original command confirmed using the same fictional key. Queued work stays paused.'); } setConfirm(null); }}><div className="stack"><div className="settings-review-callout"><TriangleAlert size={18} /><span>{confirm === 'resume' ? 'Both queued sample tasks become eligible to run. A real resume can cause external effects.' : 'Use original key sample-operation-0042. Never submit this as a new operation.'}</span></div><p className="small muted">{confirm === 'resume' ? 'Only resume after reviewing fresh device authority, pending commands and external effects for the current recovery revision. Resuming does not reconcile earlier effects.' : 'This simulation will show a confirmed sample receipt, then leave queued work paused for a separate review. It performs no retry or reconciliation on a real server.'}</p></div></Confirmation>}
  </div>;
}

export default function SettingsPages({ tab }: { tab: string }) {
  const pages: Record<string, ReactNode> = { general: <GeneralPage />, connection: <ConnectionPage />, models: <ModelsPage />, runtime: <RuntimePage />, devices: <DevicesPage />, recovery: <RecoveryPage /> };
  return <div className="settings-review-pages">{pages[tab] ?? <GeneralPage />}</div>;
}
