import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ChevronRight, Files, Pause, Play, Plus, Shield, X } from 'lucide-react';
import { recordedPreview } from './api';
import type { Connection } from './useConnection';
import { labelState, text, title, type ServerRecord } from './types';
import ModelPicker from './agent/ModelPicker';
import { chosenModel, type ModelRef } from './agent/types';
import BrowserViewer from './BrowserViewer';
import TaskConversation from './TaskConversation';
import { Action } from './TaskAction';
import { ComposerRunContext } from './ComposerContext';
import TaskRunControls from './TaskRunControls';
import { taskRunStatus, type TaskRunStatus } from './conversation-model';
import { useConversationScroll } from './useConversationScroll';
import { useMediaQuery } from './appearance';
import './unified-task.css';
import TerminalPane from './server-terminal/TerminalPane';

export { Action } from './TaskAction';

export default function TaskView({ task, ownerLabel, connection, contextBar }: {
  contextBar: ReactNode;
  task: ServerRecord;
  ownerLabel: string;
  connection: Connection;
}) {
  const [reply, setReply] = useState('');
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalButton = useRef<HTMLButtonElement>(null);
  const terminalOwner = connection.environmentId;
  const resourcesOverlay = useMediaQuery('(max-width: 1000px)');
  const resourcesButton = useRef<HTMLButtonElement>(null);
  const resourcesClose = useRef<HTMLButtonElement>(null);
  const collapseTerminal = () => {
    setTerminalOpen(false);
    const focusTarget = resourcesOpen && resourcesOverlay ? resourcesClose : terminalButton;
    focusTarget.current?.focus({ preventScroll: true });
  };
  const [reviewedAction, setReviewedAction] = useState<{ id: string; revision: number } | null>(null);
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const managed = !!connection.runtime?.piManagement;
  const initialModel = text(task, 'model') ? { providerId: text(task, 'provider') || 'outpost-ollama', modelId: text(task, 'model') } : null;
  const selectedRef = chosenModel(connection.agentCatalogue, modelRef, initialModel);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mutationBlocked = connection.retired || !!connection.info?.pendingError || connection.busy || !connection.connected || Boolean(connection.info?.pending) || recordedPreview();
  const related = useMemo(() => connection.records.filter(record => text(record, 'taskId') === task.id), [connection.records, task.id]);
  const actions = related.filter(record => record.kind === 'action');
  const artifacts = related.filter(record => record.kind === 'artifact');
  const proposed = actions.filter(record => ['pending', 'authorized'].includes(text(record, 'state')));
  const pendingActions = proposed.filter(record => text(record, 'state') === 'pending');
  const reviewAction = useCallback((action: ServerRecord) => setReviewedAction({ id: action.id, revision: action.revision }), []);
  const reviewing = actions.find(action => action.id === reviewedAction?.id);
  const closeResources = () => {
    setResourcesOpen(false);
    requestAnimationFrame(() => resourcesButton.current?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    if (resourcesOpen && (resourcesOverlay || document.activeElement === resourcesButton.current)) {
      resourcesClose.current?.focus({ preventScroll: true });
    }
  }, [resourcesOpen, resourcesOverlay]);
  useEffect(() => {
    if (reviewedAction && !reviewDialog.current?.open) reviewDialog.current?.showModal();
    if (!reviewedAction && reviewDialog.current?.open) reviewDialog.current.close();
  }, [reviewedAction]);
  const policy = connection.records.find(record => record.kind === 'policy' && record.id === task.id);
  const state = text(task, 'state');
  const stopped = ['cancelled', 'completed'].includes(state);
  const resumable = ['paused', 'interrupted', 'failed', 'waiting_for_capacity'].includes(state);
  // Live projections are immutable, including same-revision partial updates.
  // Compare references instead of serializing full payloads on every keystroke.
  const contentRevision = useRef({ records: related, state, value: 0 });
  if (contentRevision.current.state !== state || contentRevision.current.records.length !== related.length ||
      related.some((record, index) => record !== contentRevision.current.records[index])) {
    contentRevision.current = { records: related, state, value: contentRevision.current.value + 1 };
  }
  const contentVersion = String(contentRevision.current.value);
  const scroll = useConversationScroll(`${connection.environmentId ?? 'legacy'}:${task.id}`, contentVersion);
  const currentStatus = taskRunStatus(task, related);
  const runStatus: TaskRunStatus = !connection.connected
    ? { label: 'Offline · read-only', kind: 'error', active: false, transient: false }
    : connection.retired ? { label: 'Legacy read-only', kind: 'idle', active: false, transient: false }
    : connection.info?.pendingError || connection.info?.pending ? { label: 'Connection needs attention', kind: 'review', active: false, transient: false }
    : state === 'running' && currentStatus.kind === 'running' && !connection.streaming ? { ...currentStatus, label: 'Reconnecting stream', transient: false }
    : currentStatus;
  const cancel = () => {
    if (mutationBlocked || stopped) return;
    if (confirm('Cancel this task? Completed changes will not be undone.')) {
      void connection.command('task.cancel', task.id, task.revision);
    }
  };
  const submit = async () => {
    if (!reply.trim() || stopped || mutationBlocked || (managed && !selectedRef)) return;
    const result = await connection.command('task.steer', task.id, task.revision, {
      text: reply.trim(), ...(managed && selectedRef ? { modelRef: { providerId: selectedRef.providerId, modelId: selectedRef.modelId } } : {}),
    });
    if (result) { setReply(''); scroll.jumpToLatest(); }
  };
  const browserAvailable = !!connection.runtime?.browserDirect || related.some(record => record.kind === 'browser');

  return <section className="task-view task-unified" aria-label={`${ownerLabel || 'Workspace'}: ${title(task)}`}>
    <h1 className="sr-only">{title(task)}</h1>
    <div className={`task-columns ${resourcesOpen ? 'with-resources' : ''}`}>
      <div className="conversation-column" inert={resourcesOpen && resourcesOverlay}>
        <div className="conversation" ref={scroll.viewportRef} tabIndex={0} aria-label="Conversation and execution evidence">
          <div className="conversation-content" ref={scroll.contentRef}>
            <TaskConversation records={related} connection={connection} onReview={reviewAction} />
            {text(task, 'blocker') && state !== 'verifying' && <p className="inline-notice">{text(task, 'blocker')}</p>}
          </div>
        </div>
        <div className="composer-stack reply-composer-stack">
          <ComposerRunContext.Provider value={{
            terminalToggle: <button ref={terminalButton} type="button" className="composer-terminal" aria-label="Terminal" title="Terminal" aria-expanded={terminalOpen} aria-controls="chat-server-terminal" onClick={() => setTerminalOpen(open => !open)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="m8 9 3 3-3 3m6 0h3" /></svg></button>,
            controls: <TaskRunControls status={runStatus} following={scroll.following} unseen={scroll.unseen} onJump={scroll.jumpToLatest} onStop={cancel} canStop={!stopped} disabled={mutationBlocked}
              review={pendingActions[0] && <button type="button" className="review-shortcut" onClick={() => reviewAction(pendingActions[0])}>Review ({pendingActions.length})</button>} />,
          }}>
            {contextBar}
          </ComposerRunContext.Provider>
          <div className="reply-composer">
            <textarea aria-label="Message Outpost" placeholder={stopped ? 'This task is closed. Start a new task to continue.' : 'Ask a follow-up, or give Outpost the next step…'} value={reply}
              onChange={event => setReply(event.target.value)} onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
              }} disabled={stopped} />
            <div className="composer-toolbar">
              <input ref={input} type="file" hidden onChange={event => {
                const file = event.target.files?.[0];
                if (file) void connection.perform(() => connection.api.upload(file, task.id));
                event.target.value = '';
              }} />
              <button className="icon-button" aria-label="Attach file" title="Attach file" disabled={mutationBlocked || stopped} onClick={() => input.current?.click()}><Plus size={18} /></button>
              {!stopped && <button type="button" className="icon-button" title={resumable ? 'Resume task' : 'Pause task'} aria-label={resumable ? 'Resume task' : 'Pause task'} disabled={mutationBlocked}
                onClick={() => void connection.command(resumable ? 'task.resume' : 'task.pause', task.id, task.revision)}>{resumable ? <Play size={16} /> : <Pause size={16} />}</button>}
              <button ref={resourcesButton} type="button" className="icon-button" aria-label="Files, changes and browser" title="Files, changes and browser" aria-controls="task-resources" aria-expanded={resourcesOpen} onClick={() => setResourcesOpen(value => !value)}><Files size={16} /></button>
              {policy && <label className="composer-permission"><Shield size={16} aria-hidden="true" /><select aria-label="Task control mode" value={text(policy, 'mode')} disabled={mutationBlocked} onChange={event => void connection.command('policy.change', task.id, policy.revision, { mode: event.target.value })}><option value="full_control">Full control</option><option value="auto">Auto review</option><option value="ask_permission">Ask permission</option></select></label>}
              <div className="composer-model-control">{managed ? <ModelPicker catalogue={connection.agentCatalogue} value={selectedRef} onChange={setModelRef} disabled={mutationBlocked || stopped} /> : <span className="composer-model" title={text(task, 'model') || connection.runtime?.model || 'Server default'}>{text(task, 'model') || connection.runtime?.model || 'Server default'}</span>}</div>
              <button className="send-button" aria-label="Send message" title="Send message" onClick={() => void submit()} disabled={!reply.trim() || mutationBlocked || stopped || (managed && !selectedRef)}><ArrowUp size={17} /></button>
            </div>
          </div>
        </div>
      </div>
      {resourcesOpen && <aside className="task-resources" id="task-resources" aria-label="Files, changes and browser" onKeyDown={event => {
        if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('dialog[open]'))) {
          event.preventDefault(); event.stopPropagation(); closeResources();
        }
      }}>
        <div className="section-heading"><h2>Files &amp; changes</h2><button ref={resourcesClose} className="icon-button" aria-label="Close files and changes" onClick={closeResources}><X size={16} /></button></div>
        {browserAvailable && <BrowserViewer key={`${connection.environmentId ?? 'legacy'}:${task.id}`} taskId={task.id} api={connection.api} connected={connection.connected}
          session={related.find(record => record.kind === 'browser')} engine={connection.runtime?.browserEngine} takeover={!!connection.runtime?.browserTakeover} deviceId={connection.info?.deviceId ?? ''} />}
        <section className="resource-section"><h3>Proposed actions</h3>{proposed.length ? proposed.map(action => <button className="resource-link" key={action.id} onClick={() => reviewAction(action)}><Shield size={14} /><span>{text(action, 'target') || text(action, 'tool')}</span><ChevronRight size={13} /></button>) : <p className="small">No actions waiting for approval or dispatch.</p>}</section>
        <section className="resource-section"><h3>Files &amp; screenshots</h3>{artifacts.length ? artifacts.map(artifact => <button className="resource-link" key={artifact.id} onClick={() => {
          setResourcesOpen(false);
          requestAnimationFrame(() => {
            const node = document.getElementById(`artifact-${artifact.id}`);
            node?.scrollIntoView({ block: 'center', behavior: 'instant' });
            node?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
          });
        }}><Files size={14} /><span>{text(artifact, 'name') || 'Unnamed file'}</span><ChevronRight size={13} /></button>) : <p className="small">Files and screenshots will appear in the conversation.</p>}</section>
      </aside>}
    </div>
    {terminalOpen && <TerminalPane key={terminalOwner ?? 'legacy'} id="chat-server-terminal" environmentId={terminalOwner} label={ownerLabel} onCollapse={collapseTerminal} />}
    <dialog ref={reviewDialog} className="action-review-dialog" aria-labelledby="action-review-title" onClose={() => setReviewedAction(null)} onCancel={() => setReviewedAction(null)}>
      <div className="modal-top"><h2 id="action-review-title">Review the exact action</h2><button className="icon-button" aria-label="Close review" title="Close review" onClick={() => setReviewedAction(null)}><X size={18} /></button></div>
      <p>Approve only the displayed arguments. Completed changes cannot be undone here.</p>
      {reviewing && reviewing.revision === reviewedAction?.revision ? <Action key={`${reviewing.id}:${reviewing.revision}`} record={reviewing} connection={connection} /> : <p role="status">The action has updated{reviewing ? `: ${labelState(text(reviewing, 'state'))}` : ''}. Close this review to see its current state.</p>}
      {connection.error && <p className="error-text" role="alert">{connection.error}</p>}
      <div className="modal-actions"><button onClick={() => setReviewedAction(null)}>Close</button></div>
    </dialog>
  </section>;
}
