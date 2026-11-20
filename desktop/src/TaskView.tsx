import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUp, Files, PanelRight, Pause, Play, Plus, ShieldCheck, Square, SquareTerminal } from 'lucide-react';
import { recordedPreview } from './api';
import type { Connection } from './useConnection';
import { text, title, type ServerRecord } from './types';
import ModelPicker from './agent/ModelPicker';
import { chosenModel, type ModelRef } from './agent/types';
import WorkspacePanel from './workspace/WorkspacePanel';
import { useWorkspaceResize } from './workspace/useWorkspaceResize';
import type { WorkspaceOpenRequest, WorkspaceSelection } from './workspace/workspace-files';
import './workspace/task-workspace.css';
import TaskConversation from './TaskConversation';
import SubagentPanel from './subagents/SubagentPanel';
import { subagentRun, type SubagentRun } from './subagents/model';
import ActionReviewDialog from './ActionReviewDialog';
import { chatAttention } from './chat-attention';
import { ComposerRunContext } from './ComposerContext';
import { ControlMode } from './ComposerControls';
import { modeBlocker, modeChangeActive, pauseToChangeMode, savedControlMode, type ControlMode as Mode } from './control-mode';

import TaskRunControls from './TaskRunControls';
import { taskRunStatus, type TaskRunStatus } from './conversation-model';
import { useConversationScroll } from './useConversationScroll';

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
  const [resourcePane, setResourcePane] = useState<'files' | 'subagent'>('files');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runExpanded, setRunExpanded] = useState(false);
  const runTrigger = useRef<HTMLButtonElement | null>(null);
  const splitOpen = resourcesOpen && !(resourcePane === 'subagent' && runExpanded);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalButton = useRef<HTMLButtonElement>(null);
  const terminalOwner = connection.environmentId;
  const workspaceToggle = useRef<HTMLButtonElement>(null);
  const resourcesButton = useRef<HTMLButtonElement>(null);
  const [fileRequest, setFileRequest] = useState<WorkspaceOpenRequest | null>(null);
  const workspace = useWorkspaceResize({ open: splitOpen, scope: `${connection.environmentId ?? 'legacy'}:${task.id}` });
  const openFile = useCallback((selection: WorkspaceSelection) => {
    setFileRequest(previous => ({ selection, sequence: (previous?.sequence ?? 0) + 1 }));
    setResourcePane('files');
    setRunExpanded(false);
    setResourcesOpen(true);
  }, []);
  const openSubagent = useCallback((run: SubagentRun, expanded: boolean, trigger: HTMLButtonElement) => {
    runTrigger.current = trigger;
    setSelectedRunId(run.parentToolId);
    setResourcePane('subagent');
    setRunExpanded(expanded);
    setResourcesOpen(true);
  }, []);
  const collapseTerminal = () => {
    setTerminalOpen(false);
    const focusTarget = splitOpen && workspace.singlePane ? workspaceToggle : terminalButton;
    focusTarget.current?.focus({ preventScroll: true });
  };
  const [reviewedAction, setReviewedAction] = useState<ServerRecord | null>(null);
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const managed = !!connection.runtime?.piManagement;
  const initialModel = text(task, 'model') ? { providerId: text(task, 'provider') || 'outpost-ollama', modelId: text(task, 'model') } : null;
  const selectedRef = chosenModel(connection.agentCatalogue, modelRef, initialModel);

  const input = useRef<HTMLInputElement>(null);
  const [changingMode, setChangingMode] = useState(false), [modeError, setModeError] = useState('');
  const modeWriting = useRef(false);
  const policy = connection.records.find(record => record.kind === 'policy' && record.id === task.id);
  const mode = savedControlMode(policy?.data.mode);
  const policyBlocker = mode ? modeBlocker(mode, connection.runtime) : 'Task policy is unavailable. Refresh before continuing.';
  const modeActive = modeChangeActive(task, connection.records);
  const mutationBlocked = changingMode || connection.retired || !!connection.info?.pendingError || connection.busy || !connection.connected || Boolean(connection.info?.pending) || recordedPreview();
  const related = useMemo(() => connection.records.filter(record => text(record, 'taskId') === task.id), [connection.records, task.id]);
  const selectedRun = useMemo(() => {
    let selected: SubagentRun | null = null;
    for (const record of related) {
      const run = subagentRun(record, task.id);
      if (run?.parentToolId === selectedRunId && (!selected || !run.legacy)) selected = run;
    }
    return selected;
  }, [related, selectedRunId, task.id]);
  const attention = useMemo(() => chatAttention(related, task.id), [related, task.id]);
  const attentionLabel = `${!connection.connected || connection.retired ? 'Last known: ' : ''}${attention.label}`;
  const reviewAction = useCallback((action: ServerRecord) => setReviewedAction(structuredClone(action)), []);
  const closeResources = () => {
    setResourcesOpen(false);
    setRunExpanded(false);
    requestAnimationFrame(() => {
      const trigger = resourcePane === 'subagent' ? runTrigger.current : null;
      const summary = trigger?.closest('details')?.querySelector('summary');
      const target = trigger?.isConnected && trigger.getClientRects().length ? trigger
        : summary instanceof HTMLElement && summary.getClientRects().length ? summary : workspaceToggle.current;
      target?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (splitOpen && workspace.singlePane && document.activeElement instanceof HTMLElement && document.activeElement.closest('.conversation-column')) {
      workspaceToggle.current?.focus({ preventScroll: true });
    }
  }, [splitOpen, workspace.singlePane]);


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
  const runStatus: TaskRunStatus = connection.reconnecting
    ? { label: 'Reconnecting…', kind: 'review', active: false, transient: false }
    : !connection.connected
    ? { label: 'Offline · read-only', kind: 'error', active: false, transient: false }
    : connection.retired ? { label: 'Legacy read-only', kind: 'idle', active: false, transient: false }
    : connection.info?.pendingError || connection.info?.pending ? { label: 'Connection needs attention', kind: 'review', active: false, transient: false }
    : state === 'running' && currentStatus.kind === 'running' && !connection.streaming ? { ...currentStatus, label: 'Reconnecting stream', transient: false }
    : currentStatus;
  const primaryStops = runStatus.active && !reply.trim() && !stopped;
  const cancel = () => {
    if (mutationBlocked || stopped) return;
    if (confirm('Cancel this task? Completed changes will not be undone.')) {
      void connection.command('task.cancel', task.id, task.revision);
    }
  };
  const changeMode = async (next: Mode) => {
    if (!policy || next === mode || mutationBlocked || stopped || modeActive || modeWriting.current || modeError || modeBlocker(next, connection.runtime)) return;
    modeWriting.current = true; setChangingMode(true);
    try {
      const result = await connection.command('policy.change', task.id, policy.revision, { mode: next });
      if (!result || result.kind !== 'policy' || result.id !== task.id || result.revision <= policy.revision || result.data.mode !== next)
        setModeError('Mode change was not confirmed. Refresh this task and inspect pending work before trying again.');
    } catch {
      setModeError('Mode change was not confirmed. Refresh this task and inspect pending work before trying again.');
    } finally { modeWriting.current = false; setChangingMode(false); }
  };
  const submit = async () => {
    if (!reply.trim() || stopped || mutationBlocked || policyBlocker || modeError || (managed && !selectedRef)) return;
    const result = await connection.command('task.steer', task.id, task.revision, {
      text: reply.trim(), ...(managed && selectedRef ? { modelRef: { providerId: selectedRef.providerId, modelId: selectedRef.modelId } } : {}),
    });
    if (result) { setReply(''); scroll.jumpToLatest(); }
  };
  return <section className="task-view task-unified workspace-enabled" aria-label={`${ownerLabel || 'Workspace'}: ${title(task)}`}>
    <header className="task-workspace-heading"><h1>{title(task)}</h1>{attention.first && <button type="button" className="task-attention-indicator" data-cached={!connection.connected || connection.retired} title={attentionLabel} aria-label={`Review ${attentionLabel}`} onClick={() => attention.first && reviewAction(attention.first)}><ShieldCheck size={14} aria-hidden="true" /><span>{attentionLabel}</span></button>}<button ref={workspaceToggle} type="button" className="task-workspace-toggle" aria-label={resourcesOpen ? 'Close workspace' : 'Open workspace'} title={resourcesOpen ? 'Close workspace' : 'Open workspace'} aria-controls={resourcePane === 'files' ? 'task-resources' : 'task-subagent-run'} aria-expanded={resourcesOpen} onClick={() => resourcesOpen ? closeResources() : setResourcesOpen(true)}><PanelRight size={20} aria-hidden="true" /></button></header>
    <div ref={workspace.columnsRef} className={`task-columns${splitOpen ? ' workspace-open' : ''}`} data-workspace-single={workspace.singlePane} data-resizing={workspace.dragging} style={{ '--workspace-chat-width': `${workspace.chatWidth}px` } as CSSProperties}>
      <div className="conversation-column" hidden={splitOpen && workspace.singlePane} inert={splitOpen && workspace.singlePane}>
        <div className="conversation" ref={scroll.viewportRef} tabIndex={0} aria-label="Conversation and execution evidence">
          <div className="conversation-content" ref={scroll.contentRef}>
            <TaskConversation records={related} connection={connection} onReview={reviewAction} onOpenFile={openFile} onOpenSubagent={openSubagent} />
            {text(task, 'blocker') && state !== 'verifying' && <p className="inline-notice">{text(task, 'blocker')}</p>}
          </div>
        </div>
        <div className="composer-stack reply-composer-stack">
          <ComposerRunContext.Provider value={{
            controls: <TaskRunControls terminal={<button ref={terminalButton} type="button" className="composer-terminal" aria-label="Terminal" title="Terminal" aria-expanded={terminalOpen} aria-controls="chat-server-terminal" onClick={() => setTerminalOpen(open => !open)}><SquareTerminal size={18} aria-hidden="true" /></button>} status={runStatus} following={scroll.following} unseen={scroll.unseen} onJump={scroll.jumpToLatest} onStop={cancel} canStop={!stopped && !primaryStops} disabled={mutationBlocked}
              review={attention.first && <button type="button" className="review-shortcut" onClick={() => attention.first && reviewAction(attention.first)}>Review ({attention.total})</button>} />,
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
              {!stopped && <button type="button" className="icon-button" title={resumable ? 'Resume task' : 'Pause task'} aria-label={resumable ? 'Resume task' : 'Pause task'} disabled={mutationBlocked || (resumable && (!!policyBlocker || !!modeError))}
                onClick={() => { if (!mutationBlocked && (!resumable || (!policyBlocker && !modeError))) void connection.command(resumable ? 'task.resume' : 'task.pause', task.id, task.revision); }}>{resumable ? <Play size={18} /> : <Pause size={18} />}</button>}
              <button ref={resourcesButton} type="button" className="icon-button" aria-label="Files, changes and browser" title="Files, changes and browser" aria-controls="task-resources" aria-expanded={resourcesOpen && resourcePane === 'files'} onClick={() => {
                if (resourcesOpen && resourcePane === 'files') closeResources();
                else { setResourcePane('files'); setRunExpanded(false); setResourcesOpen(true); }
              }}><Files size={18} /></button>

              <ControlMode label="Task control mode" value={mode ?? 'full_control'} runtime={connection.runtime} onModeChange={next => void changeMode(next)} disabled={mutationBlocked || stopped || !mode || modeActive || !!modeError} reason={modeActive ? pauseToChangeMode : policyBlocker || modeError} />
              <div className="composer-model-control">{managed ? <ModelPicker catalogue={connection.agentCatalogue} value={selectedRef} onChange={setModelRef} disabled={mutationBlocked || stopped} /> : <span className="composer-model" title={text(task, 'model') || connection.runtime?.model || 'Server default'}>{text(task, 'model') || connection.runtime?.model || 'Server default'}</span>}</div>
              <button type="button" className="send-button" data-action={primaryStops ? 'stop' : 'send'}
                aria-label={primaryStops ? 'Stop task' : 'Send message'} title={primaryStops ? 'Stop task' : 'Send message'}
                onClick={() => { if (primaryStops) cancel(); else void submit(); }}
                disabled={mutationBlocked || stopped || (!primaryStops && (!reply.trim() || !!policyBlocker || !!modeError || (managed && !selectedRef)))}>
                {primaryStops ? <Square size={14} aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {modeActive && <p className="small" role="status">{pauseToChangeMode}</p>}
          {policyBlocker && <p className="small" role="status">{policyBlocker}</p>}
          {modeError && <p className="error-text" role="alert">{modeError}</p>}
        </div>
      </div>
      <WorkspacePanel key={`${connection.environmentId ?? 'legacy'}:${task.id}`} taskId={task.id} connection={connection} records={related} open={resourcesOpen && resourcePane === 'files'} request={fileRequest} onClose={closeResources} onReviewAction={reviewAction} />
      <SubagentPanel run={selectedRun} connected={connection.connected && !connection.retired} open={resourcesOpen && resourcePane === 'subagent'} expanded={runExpanded} onExpandedChange={setRunExpanded} onClose={closeResources} />
      {splitOpen && !workspace.singlePane && <div className="task-workspace-divider" {...workspace.separatorProps} />}
    </div>
    {terminalOpen && <TerminalPane key={terminalOwner ?? 'legacy'} id="chat-server-terminal" environmentId={terminalOwner} label={ownerLabel} onCollapse={collapseTerminal} />}
    {reviewedAction && <ActionReviewDialog key={`${reviewedAction.id}:${reviewedAction.revision}`} snapshot={reviewedAction} connection={connection} onClose={() => setReviewedAction(null)} />}
  </section>;
}
