import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Copy, Download, FileText, Folder, Globe, PanelRight, RefreshCw, Search, Shield } from 'lucide-react';
import { call, recordedPreview } from '../api';
import { useAutomaticUpdates } from '../AutomaticUpdates';
import type { Connection } from '../useConnection';
import { text, type ServerRecord } from '../types';
import { chatAttention } from '../chat-attention';
import BrowserViewer from '../BrowserViewer';
import Artifact from '../image-viewer/Artifact';
import { imageMime } from '../image-viewer/artifact-image';
import DocumentContent, { type DocumentViewMode } from './DocumentContent';
import { decodeTextArtifact, parseWorkspaceDocument, parseWorkspaceListing, recordedWorkspaceChanges, selectionKey, workspaceFailure, type WorkspaceFailure, type WorkspaceDocument, type WorkspaceFile, type WorkspaceListing, type WorkspaceOpenRequest, type WorkspaceSelection } from './workspace-files';
import './workspace-panel.css';

interface Props {
  taskId: string;
  connection: Connection;
  records: ServerRecord[];
  open: boolean;
  request: WorkspaceOpenRequest | null;
  onClose: () => void;
  onReviewAction: (record: ServerRecord) => void;
}
interface TreeNode { folders: Map<string, TreeNode>; files: WorkspaceFile[] }
function fileTree(files: WorkspaceFile[]) {
  const root: TreeNode = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/'); parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part)!;
    }
    node.files.push(file);
  }
  return root;
}
function FileTree({ node, selected, changes, onSelect }: { node: TreeNode; selected: string; changes: Map<string, { kind: string }>; onSelect: (path: string) => void }) {
  return <>{[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <details className="workspace-folder" key={name} open>
    <summary><ChevronRight size={12} /><Folder size={14} /><span>{name}</span></summary><div className="workspace-tree-children"><FileTree node={child} selected={selected} changes={changes} onSelect={onSelect} /></div>
  </details>)}{node.files.sort((a, b) => a.name.localeCompare(b.name)).map(file => <button type="button" className="workspace-file-row" key={file.path} title={file.path} aria-current={selected === file.path ? 'true' : undefined} onClick={() => onSelect(file.path)}>
    <FileText size={15} /><span>{file.name}</span>{changes.has(file.path) && <small className="workspace-change-mark" aria-label={changes.get(file.path)?.kind === 'added' ? 'Recorded addition' : 'Recorded modification'}>{changes.get(file.path)?.kind === 'added' ? 'A' : 'M'}</small>}
  </button>)}</>;
}

function WorkspaceUpdateNotice({ environmentId }: { environmentId: Connection['environmentId'] }) {
  return <><strong>Server update required</strong><p>This server needs an update to support file review.</p>
    <p>{environmentId ? 'Install a compatible release or enable automatic updates in Server updates.' : 'This legacy connection needs a verified, supported installation before app-managed updates are available. Outpost will not reinstall it automatically.'}</p>
    <a href={`#settings/servers/${environmentId ?? 'legacy'}/${environmentId ? 'runtime' : 'setup'}`}>{environmentId ? 'Open Server updates' : 'Open server settings'}</a>
  </>;
}

export default function WorkspacePanel({ taskId, connection, records, open, request, onClose, onReviewAction }: Props) {
  const { api, connected } = connection;
  const scope = `${api.environmentId ?? 'legacy'}:${taskId}`;
  const previewOnly = recordedPreview();
  const updates = useAutomaticUpdates();
  const serverUpdate = updates?.available && !updates.uncertain ? updates.status?.servers.find(server => server.environmentId === api.environmentId) : undefined;
  const completedRelease = serverUpdate?.state === 'complete' ? serverUpdate.releaseId : undefined;
  const lastCompletion = useRef(completedRelease);
  const changes = useMemo(() => recordedWorkspaceChanges(records), [records]);
  const artifacts = records.filter(record => record.kind === 'artifact');
  const pending = chatAttention(records, taskId).records;
  const browserSession = records.find(record => record.kind === 'browser');
  const browserAvailable = Boolean(connection.runtime?.browserDirect || browserSession);
  const [tab, setTab] = useState<'document' | 'browser'>(() => browserAvailable && !changes.size && !artifacts.length ? 'browser' : 'document');
  const [mode, setMode] = useState<DocumentViewMode>('preview');
  const [selected, setSelected] = useState<WorkspaceSelection | null>(null);
  const [filesPreference, setFilesPreference] = useState<boolean | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const filesOpen = filesPreference ?? panelWidth >= 540;
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setPanelWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [filter, setFilter] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<{ scope: string; value?: WorkspaceListing; error?: WorkspaceFailure; loading: boolean }>({ scope, loading: false });
  const [document, setDocument] = useState<{ key: string; value?: WorkspaceDocument; error?: WorkspaceFailure; loading: boolean }>({ key: '', loading: false });
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [outline, setOutline] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const key = `${scope}:${selectionKey(selected)}`;

  const operationGeneration = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; operationGeneration.current++; }; }, []);
  const evidenceVersion = records.filter(record => record.kind === 'action' && !['pending', 'authorized', 'running', 'dispatching'].includes(text(record, 'state'))).map(record => `${record.id}:${record.revision}`).join('|');
  const currentListing = listing.scope === scope ? listing : { scope, loading: false };
  const files = currentListing.value?.files ?? [];
  const artifact = selected?.kind === 'artifact' ? artifacts.find(record => record.id === selected.id) : undefined;
  const isImage = Boolean(artifact && imageMime(artifact));
  const metadata = selected?.kind === 'workspace' ? files.find(file => file.path === selected.path) : undefined;
  const name = selected?.kind === 'workspace' ? selected.path.split('/').at(-1)! : artifact ? text(artifact, 'name') : 'Documents';
  const currentDocument = document.key === key ? document : { key, loading: false };
  const loaded = connected && !previewOnly ? currentDocument.value : undefined;
  const documentPath = selected?.kind === 'workspace' ? selected.path : name;
  const change = selected?.kind === 'workspace' ? changes.get(selected.path) : undefined;

  useEffect(() => {
    if (!completedRelease || lastCompletion.current === completedRelease) return;
    lastCompletion.current = completedRelease;
    setRefresh(value => value + 1);
  }, [completedRelease]);
  useEffect(() => {
    if (!request) return;
    setSelected(request.selection); setTab('document'); setMode('preview');
  }, [request]);
  useEffect(() => {
    if (!open || !connected || previewOnly) return;
    let current = true;
    setListing(previous => ({ scope, value: previous.scope === scope ? previous.value : undefined, loading: true }));
    void api.query<unknown>('workspace.files', { taskId }).then(parseWorkspaceListing).then(value => {
      if (current) setListing({ scope, value, loading: false });
    }).catch(error => {
      if (current) setListing(previous => ({ scope, value: previous.scope === scope ? previous.value : undefined, loading: false, error: workspaceFailure(error) }));
    });
    return () => { current = false; };
  }, [api, taskId, scope, open, connected, previewOnly, refresh, evidenceVersion]);
  useEffect(() => {
    if (selected) return;
    const path = [...changes.keys()][0] ?? files[0]?.path;
    if (path) setSelected({ kind: 'workspace', path });
    else if (artifacts[0]) setSelected({ kind: 'artifact', id: artifacts[0].id });
  }, [selected, files, changes, artifacts]);
  useEffect(() => {
    operationGeneration.current++;
    setNotice(''); setSaving(false);
  }, [key, loaded?.hash, connected]);
  const artifactHash = artifact ? text(artifact, 'hash') : '';
  const artifactSize = artifact?.data.size;
  useEffect(() => {
    if (!open || !connected || previewOnly || !selected || isImage) return;
    let current = true;
    setDocument({ key, loading: true });
    const read = async (): Promise<WorkspaceDocument> => {
      if (selected.kind === 'workspace') return parseWorkspaceDocument(await api.query<unknown>('workspace.read', { taskId, path: selected.path }), selected.path);
      if (!artifact || typeof artifactSize !== 'number' || artifactSize > 1_048_576) throw new Error('This file cannot be previewed as text. Download it to view it.');
      const result = await api.call<string>('artifact', { id: selected.id, hash: artifactHash });
      const value = decodeTextArtifact(result);
      return { path: name, name, text: value, hash: artifactHash, size: new TextEncoder().encode(value).length, modifiedAt: artifact.updatedAt };
    };
    void read().then(value => { if (current) setDocument({ key, loading: false, value }); }).catch(error => {
      if (current) setDocument({ key, loading: false, error: workspaceFailure(error, selected.kind === 'workspace') });
    });
    return () => { current = false; };
  }, [api, taskId, key, open, connected, previewOnly, refresh, metadata?.modifiedAt, metadata?.size, evidenceVersion, artifactHash, isImage]);
  useEffect(() => {
    const headings = body.current?.querySelectorAll('.workspace-document-markdown :is(h1,h2,h3,h4,h5,h6)');
    setOutline(headings ? [...headings].map(node => node.textContent ?? '') : []);
  }, [loaded?.text, loaded?.path, mode, tab]);

  const selectFile = (path: string) => { setSelected({ kind: 'workspace', path }); setTab('document'); };
  const filteredFiles = files.filter(file => (!changedOnly || changes.has(file.path)) && file.path.toLowerCase().includes(filter.toLowerCase()));
  const tree = useMemo(() => fileTree(filteredFiles), [files, changedOnly, changes, filter]);
  const visibleArtifacts = artifacts.filter(record => !changedOnly && text(record, 'name').toLowerCase().includes(filter.toLowerCase()));
  const copy = async () => {
    if (!loaded || saving) return;
    const ticket = ++operationGeneration.current;
    try { await navigator.clipboard.writeText(loaded.text); if (alive.current && operationGeneration.current === ticket) setNotice('Copied.'); }
    catch { if (alive.current && operationGeneration.current === ticket) setNotice('Clipboard unavailable. Use Download instead.'); }
  };
  const download = async () => {
    if (!selected || !connected || previewOnly || saving) return;
    const ticket = ++operationGeneration.current; setSaving(true); setNotice('');
    try {
      const saved = selected.kind === 'artifact' && artifact
        ? await api.call<string>('save_artifact', { id: artifact.id, hash: artifactHash, name })
        : loaded && selected.kind === 'workspace' ? await api.call<string>('save_workspace_file', { taskId, path: selected.path, hash: loaded.hash }) : undefined;
      if (alive.current && operationGeneration.current === ticket && saved) setNotice(`Saved to ${saved}`);
    } catch (error) { if (alive.current && operationGeneration.current === ticket) setNotice(`Download failed: ${String(error)}`); }
    finally { if (alive.current && operationGeneration.current === ticket) setSaving(false); }
  };
  const openLink = (url: string) => { void call('open_url', { url }).catch(error => setNotice(String(error))); };

  return <aside ref={panel} className="task-resources workspace-panel" id="task-resources" aria-label="Files, changes and browser" hidden={!open} data-files-open={filesOpen} onKeyDown={event => {
    if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('dialog[open]'))) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="workspace-main">
      <div className="workspace-tabs" role="tablist" aria-label="Workspace views" onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'document' : event.key === 'End' ? 'browser' : tab === 'document' ? 'browser' : 'document';
        setTab(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`#workspace-${next}-button`)?.focus();
      }}>
        <button type="button" role="tab" tabIndex={tab === 'document' ? 0 : -1} aria-selected={tab === 'document'} aria-controls="workspace-document-tab" id="workspace-document-button" onClick={() => setTab('document')}><FileText size={16} /><span>{name}</span>{change && <i className="workspace-added-dot" />}</button>
        <button type="button" role="tab" tabIndex={tab === 'browser' ? 0 : -1} aria-selected={tab === 'browser'} aria-controls="workspace-browser-tab" id="workspace-browser-button" onClick={() => setTab('browser')}><Globe size={16} />Browser</button>
        <button type="button" className="workspace-files-toggle" aria-label="Toggle file list" title={filesOpen ? 'Hide file list' : 'Show file list'} aria-expanded={filesOpen} aria-controls="workspace-files" onClick={() => setFilesPreference(!filesOpen)}><PanelRight size={16} /><span>Files</span></button>
      </div>
      <div className="workspace-document-tab" role="tabpanel" id="workspace-document-tab" aria-labelledby="workspace-document-button" hidden={tab !== 'document'}>
        <div className="workspace-document-toolbar"><div className="workspace-breadcrumb" title={documentPath}><span>{selected ? selected.kind === 'workspace' ? selected.path.split('/').slice(0, -1).join('/') || 'Workspace' : 'Attachments' : 'Workspace'}</span><ChevronRight size={13} /><strong>{selected ? name : 'Choose a file'}</strong></div><div className="workspace-modes" role="group" aria-label="Document view">{(['preview', 'source', 'changes'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={isImage && value !== 'preview'} onClick={() => setMode(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div></div>
        <div className="workspace-meta"><span>{change ? change.kind === 'added' ? 'Added file' : 'Modified file' : artifact ? 'Attachment' : 'Workspace file'}{loaded ? ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(loaded.size / 1024)} KB` : ''}</span><div><button type="button" onClick={() => void copy()} disabled={!loaded || saving}><Copy size={15} />Copy</button><button type="button" onClick={() => void download()} disabled={!connected || previewOnly || saving || (!loaded && !artifact)}><Download size={15} />{saving ? 'Saving…' : 'Download'}</button></div></div>
        {notice && <p className="workspace-notice" role="status">{notice}</p>}
        <div className="workspace-document-body" ref={body}>
          {!connected || previewOnly ? <p className="workspace-empty" role="status">{previewOnly ? 'File contents are unavailable in a recorded preview.' : 'Offline. Reconnect to load workspace files.'}</p>
            : !selected && currentListing.error?.updateRequired ? <div className="workspace-empty" role="alert"><WorkspaceUpdateNotice environmentId={api.environmentId} /></div>
            : !selected ? <p className="workspace-empty">Choose a file from the file list to preview it.</p>
            : isImage && artifact ? <Artifact record={artifact} />
            : currentDocument.loading ? <p className="workspace-empty" role="status">Loading {name}…</p>
            : currentDocument.error ? <div className="workspace-empty" role="alert">{currentDocument.error.updateRequired ? <WorkspaceUpdateNotice environmentId={api.environmentId} /> : <p>Could not preview {name}.</p>}<p>{currentDocument.error.message}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Retry</button></div>
            : loaded ? <DocumentContent path={documentPath} text={loaded.text} mode={mode} change={change} onOpenLink={openLink} />
            : <p className="workspace-empty">Select a file to load its contents.</p>}
        </div>
      </div>
      <div className="workspace-browser-tab" role="tabpanel" id="workspace-browser-tab" aria-labelledby="workspace-browser-button" hidden={tab !== 'browser'}>
        <BrowserViewer taskId={taskId} api={api} connected={connected} session={browserSession} engine={connection.runtime?.browserEngine} takeover={!!connection.runtime?.browserTakeover} deviceId={connection.info?.deviceId ?? ''} active={open && tab === 'browser'} embedded />
      </div>
    </div>
    <div className="workspace-files" id="workspace-files" hidden={!filesOpen} aria-label="Project files">
      <div className="workspace-files-heading"><strong>Files</strong><button type="button" aria-label="Refresh files" title="Refresh files" disabled={!connected || previewOnly || currentListing.loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button></div>
      <div className="workspace-filter-row"><label><Search size={15} /><input aria-label="Filter files" placeholder="Filter files…" value={filter} onChange={event => setFilter(event.target.value)} /></label></div>
      <div className="workspace-file-filters"><button type="button" aria-pressed={!changedOnly} onClick={() => setChangedOnly(false)}>All files</button><button type="button" aria-pressed={changedOnly} onClick={() => setChangedOnly(true)}>Changes <small>{changes.size}</small></button></div>
      <div className="workspace-files-scroll">
        {currentListing.loading && <p className="workspace-list-note" role="status">Refreshing files…</p>}
        {currentListing.error && <div className="workspace-list-note" role="alert">{currentListing.error.updateRequired ? <WorkspaceUpdateNotice environmentId={api.environmentId} /> : <p>Could not load workspace files.</p>}<p>{currentListing.error.message}</p></div>}
        {changedOnly && <p className="workspace-list-note">Recorded file writes only.</p>}
        {!currentListing.loading && !currentListing.error && !filteredFiles.length && !visibleArtifacts.length && <p className="workspace-list-note">{filter ? 'No matching files.' : changedOnly ? 'No recorded file changes.' : 'No workspace files yet.'}</p>}
        <FileTree node={tree} selected={selected?.kind === 'workspace' ? selected.path : ''} changes={changes} onSelect={selectFile} />
        {currentListing.value?.truncated && <p className="workspace-list-note">File list limited to 1,000 entries and eight directory levels.</p>}
        {!!visibleArtifacts.length && <><p className="workspace-list-heading">Attachments</p>{visibleArtifacts.map(record => <button type="button" className="workspace-file-row" key={record.id} aria-current={selected?.kind === 'artifact' && selected.id === record.id ? 'true' : undefined} onClick={() => { setSelected({ kind: 'artifact', id: record.id }); setTab('document'); setMode('preview'); }}><FileText size={15} /><span>{text(record, 'name') || 'Unnamed file'}</span></button>)}</>}
        {!!outline.length && tab === 'document' && <><p className="workspace-list-heading">In this document</p>{outline.map((heading, index) => <button className="workspace-outline-link" type="button" key={`${index}:${heading}`} onClick={() => body.current?.querySelectorAll('.workspace-document-markdown :is(h1,h2,h3,h4,h5,h6)')[index]?.scrollIntoView({ block: 'start' })}>{heading}</button>)}</>}
        {!!pending.length && <><p className="workspace-list-heading">Proposed actions</p>{pending.map(action => <button type="button" className="workspace-file-row" key={action.id} onClick={() => onReviewAction(action)}><Shield size={15} /><span>{text(action, 'target') || text(action, 'tool')}</span><ChevronRight size={13} /></button>)}</>}
      </div>
    </div>
  </aside>;
}
