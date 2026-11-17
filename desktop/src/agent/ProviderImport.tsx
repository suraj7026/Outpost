import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { call, nativeApp, recordedPreview } from '../api';
import { Button, Dialog } from '../Interface';
import '../provider-runtime-parity.css';
import type { Metadata } from '../Environments';
import type { Connection } from '../useConnection';

type Provider = { id: string; name: string; method: 'api_key' | 'oauth' | 'unsupported'; baseUrl: string };
type Inventory = { installationId: string; providers: Provider[] };
type Review = { reviewId: string; source: Inventory; destination: Inventory };
type Receipt = { operationId: string; state: string; providers: { id: string; state: string }[] };

export default function ProviderImport({ connection, registry, onSignIn }: { connection: Connection; registry: Metadata; onSignIn: (id: string) => void }) {
  const sources = Object.values(registry.environments).filter(server => server.environmentId !== connection.environmentId);
  // The transfer belongs to this page, not the dismissible dialog.
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(''), [review, setReview] = useState<Review | null>(null);
  const [choices, setChoices] = useState<Record<string, 'keep' | 'copy' | 'replace'>>({});
  const [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null), [history, setHistory] = useState<Receipt[]>([]);
  const working = useRef(false);
  const blocked = !nativeApp() || recordedPreview() || !connection.connected || connection.retired || !!connection.info?.pendingError || !!connection.info?.pending;
  const capable = !!connection.agentCatalogue?.capabilities.providerTransfer;
  const unresolved = [receipt, ...history].some(item => item && ['unknown', 'prepared', 'applying'].includes(item.state));
  const destination = registry.environments[connection.environmentId ?? '']?.label ?? 'this server';
  const operate = async (action: () => Promise<void>) => {
    if (blocked || working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); } catch { setError('Import could not be confirmed. Check destination receipts before starting another import. Credentials are never automatically resent.'); }
    finally { working.current = false; setBusy(false); }
  };
  const refreshHistory = async () => setHistory(await connection.api.agentRequest<Receipt[]>({ type: 'transfer.history' }));
  useEffect(() => { if (capable && !blocked) void refreshHistory().catch(() => {}); }, [capable, blocked]);
  const selection = review?.source.providers.filter(provider => ['copy', 'replace'].includes(choices[provider.id])).map(provider => ({ id: provider.id, replace: choices[provider.id] === 'replace' })) ?? [];
  return <div className="provider-import" aria-label="Import from server">
    <Button variant="ghost" onClick={() => setOpen(true)}><ArrowDownToLine size={16} />Import settings…</Button>
    {(busy || unresolved || error) && <p className="provider-runtime-note" role="status">{busy ? 'Import operation in progress.' : unresolved ? 'An import needs reconciliation. Open import settings to check its receipt.' : 'Import needs attention. Open import settings for details.'}</p>}
    {open && <Dialog title="Import provider settings" onClose={() => setOpen(false)} className="provider-runtime-dialog provider-import-dialog">
      <p>Copy selected API keys into {destination}. The source stays unchanged.</p>
      <details className="ui-details"><summary>What can be imported</summary><p>Nothing stays in sync. OAuth and subscription accounts require a fresh sign-in on the destination. Keys from this Mac, environment variables and command expressions are not imported.</p></details>
    <div className="ui-form provider-import-body">
      {!connection.environmentId ? <p>Save this installation as a verified server before importing credentials.</p> : !capable ? <p>This server does not advertise secure credential import. A compatible server release is required.</p> : <>
        {!sources.length ? <p>Add another Outpost server to use it as an import source.</p> : <>
          <label htmlFor="import-source">Source server</label>
          <select id="import-source" value={source} disabled={busy} onChange={event => { setSource(event.target.value); setReview(null); setApproved(false); setChoices({}); }}>
            <option value="">Choose an Outpost server</option>{sources.map(server => <option key={server.environmentId} value={server.environmentId}>{server.label}</option>)}
          </select>
          <Button disabled={blocked || busy || !source || unresolved} onClick={() => void operate(async () => {
            const next = await call<Review>('provider_transfer_review', { source, destination: connection.environmentId });
            setReview(next); setApproved(false); setChoices(Object.fromEntries(next.source.providers.map(provider => [provider.id,
              provider.method === 'api_key' && !next.destination.providers.some(p => p.id === provider.id) ? 'copy' : 'keep'])));
          })}>Review providers</Button>
        </>}
        {unresolved && <p role="status">An earlier import needs reconciliation. Check its destination receipt before reviewing another transfer.</p>}
        {review && <div className="import-review" role="region" aria-label="Review provider import">
          <h3>{registry.environments[source]?.label} → {destination}</h3>
          <p>Reviews expire after five minutes. Existing destination credentials are kept unless you explicitly choose Replace. Endpoint changes travel with compatible configurations.</p>
          {!review.source.providers.length && <p>No stored credentials on this source server.</p>}
          {review.source.providers.map(provider => {
            const current = review.destination.providers.find(p => p.id === provider.id);
            return <div className="import-provider" key={provider.id}>
              <div><strong>{provider.name}</strong><small>{provider.id} · {provider.method === 'oauth' ? 'Fresh destination sign-in required' : provider.method === 'unsupported' ? 'No transferable literal API key' : current ? 'Destination credential or configuration exists' : 'No stored destination credential'}</small>
                {provider.baseUrl && <small>Source endpoint: {provider.baseUrl}</small>}{current?.baseUrl && <small>Destination endpoint: {current.baseUrl}</small>}
              </div>
              {provider.method === 'api_key' ? <label>Action for {provider.name}<select aria-label={`Action for ${provider.name}`} disabled={busy} value={choices[provider.id] ?? 'keep'} onChange={event => { setChoices({ ...choices, [provider.id]: event.target.value as 'keep' | 'copy' | 'replace' }); setApproved(false); }}>
                <option value="keep">{current ? 'Keep destination' : 'Skip'}</option><option value={current ? 'replace' : 'copy'}>{current ? 'Replace destination' : 'Copy API key'}</option>
              </select></label> : provider.method === 'oauth' && <Button disabled={blocked || busy} onClick={() => { setOpen(false); onSignIn(provider.id); }}>Find destination sign-in</Button>}
            </div>;
          })}
          <label className="provider-runtime-check"><input type="checkbox" disabled={busy || !selection.length} checked={approved} onChange={event => setApproved(event.target.checked)} />I approve copying {selection.length} API key{selection.length === 1 ? '' : 's'} to {destination}{selection.some(s => s.replace) ? ` and replacing ${selection.filter(s => s.replace).map(s => s.id).join(', ')}` : ''}. The source remains unchanged.</label>
          <Button variant="primary" disabled={blocked || busy || !approved || !selection.length || unresolved} onClick={() => void operate(async () => {
            const operationId = crypto.randomUUID(); setReceipt({ operationId, state: 'unknown', providers: [] });
            const reviewId = review.reviewId; setReview(null); setApproved(false);
            const result = await call<Receipt>('provider_transfer_start', { reviewId, operationId, selection, approved: true });
            setReceipt(result); await refreshHistory(); await connection.refreshAgent();
          })}>Import selected keys</Button>
        </div>}
        {receipt && <div role="status"><h3>Import {receipt.state.replaceAll('_', ' ')}</h3><p>Operation <code>{receipt.operationId}</code></p>{receipt.providers.map(p => <p key={p.id}>{p.id}: {p.state === 'saved' ? 'Saved on destination' : 'Not confirmed — inspect before retrying'}</p>)}<p>Saving a key does not verify model access. Refresh models and choose a default separately.</p></div>}
        <Button disabled={blocked || busy} onClick={() => void operate(async () => { await refreshHistory(); if (receipt) setReceipt(await connection.api.agentRequest<Receipt>({ type: 'transfer.status', operationId: receipt.operationId })); })}>Check import receipts</Button>
        {history.filter(item => item.state === 'prepared').map(item => <Button key={item.operationId} disabled={blocked || busy} onClick={() => void operate(async () => { const result = await connection.api.agentRequest<Receipt>({ type: 'transfer.cancel', operationId: item.operationId }); if (receipt?.operationId === item.operationId) setReceipt(result); await refreshHistory(); })}>Cancel prepared import {item.operationId.slice(0, 8)}</Button>)}
        {history.length > 0 && <details className="ui-details"><summary>Recent destination imports</summary>{history.map(item => <p key={item.operationId}><code>{item.operationId}</code> · {item.state.replaceAll('_', ' ')}{item.providers.map(p => ` · ${p.id}: ${p.state}`).join('')}</p>)}</details>}
      </>}
      {busy && <p role="status">Checking authenticated servers…</p>}{error && <p role="alert">{error}</p>}
    </div>
    <div className="ui-dialog-actions"><Button onClick={() => setOpen(false)}>Done</Button></div>
    </Dialog>}
  </div>;
}
