import { memo, useMemo, useRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUpRight, ChevronRight, FileText, UserRound } from 'lucide-react';
import { workspaceLinkPath, writtenWorkspacePath, type WorkspaceSelection } from './workspace/workspace-files';
import { call } from './api';

import { text, type ServerRecord } from './types';
import type { Connection } from './useConnection';
import { groupConversation, linkedToolStreams, type ConversationGroup } from './conversation-model';
import ExecutionEntry from './ExecutionEntry';
import ActivityGroup, { type ActivityGroupMemory } from './ActivityGroup';
import { activityChunks, isExecutionRecord } from './activity-model';
import { ThinkingIndicator, useConversationDisclosure, type ExecutionViewState } from './conversation-detail';
import OutpostMark from './OutpostMark';
import SubagentCard from './subagents/SubagentCard';
import { isSubagentRecord, subagentRun, type SubagentRun } from './subagents/model';

type OpenSubagent = (run: SubagentRun, expanded: boolean, trigger: HTMLButtonElement) => void;

import Artifact from './image-viewer/Artifact';
import MarkdownImage from './image-viewer/MarkdownImage';

type MarkdownNode = { type: string; tagName?: string; children?: MarkdownNode[] };
function containsImage(node: MarkdownNode): boolean {
  return node.tagName === 'img' || Boolean(node.children?.some(containsImage));
}

const MessageText = memo(function MessageText({ record, onError, onOpenFile }: { record: ServerRecord; onError: Connection['setError']; onOpenFile?: (selection: WorkspaceSelection) => void }) {
  const taskId = text(record, 'taskId');
  const components = useMemo<Components>(() => ({
    img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} taskId={taskId} />,
    a: ({ href, children, node }) => node && containsImage(node)
      ? <span>{children}</span>
      : <a href={href} onClick={event => {
        event.preventDefault();
        const path = workspaceLinkPath(href);
        if (path && onOpenFile) onOpenFile({ kind: 'workspace', path });
        else if (href && /^https?:\/\//i.test(href)) void call('open_url', { url: href }).catch(error => onError(String(error)));
      }}>{children}</a>,
  }), [taskId, onError, onOpenFile]);
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components}>{text(record, 'text')}</Markdown></div>;
});

function RunReasoning({ records }: { records: ServerRecord[] }) {
  const { open, setOpen } = useConversationDisclosure();
  const messages = records.filter(record => record.kind === 'message');
  const traces = messages.filter(message => text(message, 'thinking'));
  const latest = messages.at(-1);
  const active = !!latest && latest.data.streaming === true && !latest.data.interrupted && !text(latest, 'error') && !['error', 'aborted'].includes(text(latest, 'stopReason')) && !text(latest, 'text').trim();
  if (!traces.length && !active) return null;
  return <details className="thinking-block run-reasoning" open={open} onToggle={event => {
    if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
  }}><summary><ChevronRight size={13} className="disclosure" aria-hidden="true" /><ThinkingIndicator active={active} /><span>{active ? text(latest!, 'thinking') ? 'Thinking…' : 'Waiting for model output…' : 'Thinking'}</span><span className="small">{active ? 'In progress' : latest?.data.interrupted ? 'Interrupted' : 'Model-provided'}{traces.length > 1 ? ` · ${traces.length} segments` : ''}</span></summary>
    <div className="reasoning-segments">{traces.map(message => <pre key={message.id}>{text(message, 'thinking')}</pre>)}{active && !text(latest!, 'thinking') && <p className="small">No thinking trace has been provided yet.</p>}</div>
  </details>;
}


function Run({ group, connection, streams, onReview, onOpenFile, onOpenSubagent }: {
  group: Extract<ConversationGroup, { kind: 'run' }>;
  connection: Connection;
  streams: Map<string, ServerRecord[]>;
  onReview: (record: ServerRecord) => void;
  onOpenFile?: (selection: WorkspaceSelection) => void;
  onOpenSubagent?: OpenSubagent;
}) {
  const executionKeys = useRef(new Map<string, string>());
  const executionOrder = useRef(new Map<string, number>());
  const rowViews = useRef(new Map<string, ExecutionViewState>());
  const groupViews = useRef(new Map<string, ActivityGroupMemory>());
  const rowView = (key: string) => {
    let view = rowViews.current.get(key);
    if (!view) { view = {}; rowViews.current.set(key, view); }
    return view;
  };
  const executionKey = (record: ServerRecord) => {
    const linked = streams.get(record.id) ?? [];
    // Keep both the row and its group mounted when a stream acquires an action record.
    const aliases = [`${record.kind}:${record.id}`, ...linked.map(item => `tool_stream:${item.id}`)];
    if (record.kind === 'tool_stream' && text(record, 'actionId')) aliases.push(`action:${text(record, 'actionId')}`);
    const known = aliases.map(alias => executionKeys.current.get(alias)).filter((key): key is string => key !== undefined);
    // Both projections may already exist when their link arrives; retain the earlier row.
    const key = known.sort((a, b) => executionOrder.current.get(a)! - executionOrder.current.get(b)!)[0] ?? aliases[0];
    if (!executionOrder.current.has(key)) executionOrder.current.set(key, executionOrder.current.size);
    for (const alias of aliases) executionKeys.current.set(alias, key);
    return key;
  };
  const chunks = activityChunks(group.records);
  const render = (record: ServerRecord) => {
    if (isSubagentRecord(record)) {
      const run = subagentRun(record);
      if (!run) return <p key={record.id} className="small">Subagent run details unavailable.</p>;
      return <SubagentCard key={`subagent:${run.parentToolId}`} run={run} connected={connection.connected && !connection.retired}
        onOpen={(expanded, trigger) => onOpenSubagent?.(run, expanded, trigger)} />;
    }
    if (record.kind === 'artifact') return <div className="stream-artifact" id={`artifact-${record.id}`} key={record.id}><Artifact record={record} onReviewFile={onOpenFile ? () => onOpenFile({ kind: 'artifact', id: record.id }) : undefined} /></div>;
    if (record.kind !== 'message') {
      const key = executionKey(record);
      return <ExecutionEntry key={key} viewState={rowView(key)} record={record} streams={streams.get(record.id) ?? []} onReview={onReview} />;
    }
    return <div className="run-message" data-record-id={record.id} key={record.id}>
      {text(record, 'text').trim() && <MessageText record={record} onError={connection.setError} onOpenFile={onOpenFile} />}
      {(record.data.interrupted === true || text(record, 'stopReason') === 'aborted') && <p className="small">Interrupted · partial output retained</p>}
      {(text(record, 'error') || text(record, 'stopReason') === 'error') && <p className="error-text">{text(record, 'error') || 'Response failed.'}</p>}
      {record.data.outputTruncated === true && <p className="small">Display limited to 128 KiB per text channel; full finalized context remains in the Pi session.</p>}
    </div>;
  };
  const firstRecord = group.records[0];
  const writtenFiles = [...new Set(group.records.map(writtenWorkspacePath).filter((path): path is string => Boolean(path)))];
  return <article className="message assistant conversation-run" data-run-id={group.id} aria-label="Outpost response">
    <div className="run-byline message-byline">
      <span className="message-avatar assistant-avatar" aria-hidden="true"><OutpostMark /></span>
      <span>Outpost</span>
      {firstRecord && <time dateTime={firstRecord.updatedAt}>{new Date(firstRecord.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
    </div>
    <div className="run-content">
      <RunReasoning records={group.records} />
      {chunks.map(chunk => {
        if (!isExecutionRecord(chunk[0])) return render(chunk[0]);
        const key = executionKey(chunk[0]);
        let memory = groupViews.current.get(key);
        if (!memory) { memory = {}; groupViews.current.set(key, memory); }
        return <ActivityGroup key={`activity:${key}`} records={chunk} memory={memory} rowStates={chunk.map(record => rowView(executionKey(record)))}>{chunk.map(render)}</ActivityGroup>;
      })}
      {onOpenFile && writtenFiles.map(path => <button key={path} type="button" className="conversation-file-review" onClick={() => onOpenFile({ kind: 'workspace', path })} title={path}>
        <FileText size={18} aria-hidden="true" /><span><strong>{path.split('/').at(-1)}</strong><small>{path.split('/').slice(0, -1).join('/') || 'Workspace'}</small></span><span className="conversation-file-review-action">Review file<ArrowUpRight size={14} aria-hidden="true" /></span>
      </button>)}
    </div>
  </article>;
}

const TaskConversation = memo(function TaskConversation({ records, connection, onReview, onOpenFile, onOpenSubagent }: {
  records: ServerRecord[];
  connection: Connection;
  onReview: (record: ServerRecord) => void;
  onOpenFile?: (selection: WorkspaceSelection) => void;
  onOpenSubagent?: OpenSubagent;
}) {
  const firstSeen = useRef(new Map<string, number>());
  const groups = useMemo(() => groupConversation(records, firstSeen.current), [records]);
  const streams = useMemo(() => linkedToolStreams(records), [records]);
  return <>{groups.map(group => group.kind === 'owner'
    ? <article className="message owner" key={`owner:${group.id}`} data-record-id={group.id}>
      <div className="owner-content">
        <div className="message-byline"><span>You</span><time dateTime={group.record.updatedAt}>{new Date(group.record.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        <MessageText record={group.record} onError={connection.setError} />
      </div>
      <span className="message-avatar owner-avatar" aria-hidden="true"><UserRound size={18} /></span>
    </article>
    : <Run key={group.id} group={group} connection={connection} streams={streams} onReview={onReview} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} />)}</>;
});

export default TaskConversation;
