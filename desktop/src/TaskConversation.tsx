import { memo, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, UserRound } from 'lucide-react';
import { call } from './api';

import { actionNeedsReview, text, type ServerRecord } from './types';
import type { Connection } from './useConnection';
import { groupConversation, linkedToolStreams, type ConversationGroup } from './conversation-model';
import ExecutionEntry from './ExecutionEntry';
import OutpostMark from './OutpostMark';

import Artifact from './image-viewer/Artifact';

const MessageText = memo(function MessageText({ record, onError }: { record: ServerRecord; onError: Connection['setError'] }) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    img: () => null,
    a: ({ href, children }) => <a href={href} onClick={event => {
      event.preventDefault();
      if (href) void call('open_url', { url: href }).catch(error => onError(String(error)));
    }}>{children}</a>,
  }}>{text(record, 'text')}</Markdown></div>;
});

function RunReasoning({ records }: { records: ServerRecord[] }) {
  const [open, setOpen] = useState(false);
  const messages = records.filter(record => record.kind === 'message' && text(record, 'thinking'));
  if (!messages.length) return null;
  return <details className="thinking-block run-reasoning" open={open} onToggle={event => {
    if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
  }}><summary><ChevronRight size={13} className="disclosure" aria-hidden="true" /><span>Reasoning</span><span className="small">Model-provided{messages.length > 1 ? ` · ${messages.length} segments` : ''}</span></summary>
    <div className="reasoning-segments">{messages.map(message => <pre key={message.id}>{text(message, 'thinking')}</pre>)}</div>
  </details>;
}

function completedAction(record: ServerRecord) {
  return record.kind === 'action' && text(record, 'state') === 'succeeded' && !actionNeedsReview(record);
}

function Run({ group, connection, streams, onReview }: {
  group: Extract<ConversationGroup, { kind: 'run' }>;
  connection: Connection;
  streams: Map<string, ServerRecord[]>;
  onReview: (record: ServerRecord) => void;
}) {
  // Only compact already-settled history. Live rows never move into a new group
  // when they finish: doing that would destroy an inspected disclosure's state.
  const historical = useRef(new Set(group.records.filter(completedAction).map(record => record.id)));
  const executionKeys = useRef(new Map<string, string>());

  const chunks: ServerRecord[][] = [];
  for (const record of group.records) {
    const previous = chunks.at(-1);
    if (completedAction(record) && historical.current.has(record.id) && previous?.every(item => completedAction(item) && historical.current.has(item.id))) previous.push(record);
    else chunks.push([record]);
  }
  const render = (record: ServerRecord) => {
    if (record.kind === 'artifact') return <div className="stream-artifact" id={`artifact-${record.id}`} key={record.id}><Artifact record={record} /></div>;
    if (record.kind !== 'message') {
      const linked = streams.get(record.id) ?? [];
      // Either projection can arrive first. Reuse its mounted identity when the
      // other arrives, rather than remounting and discarding the user's choice.
      const aliases = [`${record.kind}:${record.id}`, ...linked.map(item => `tool_stream:${item.id}`)];
      if (record.kind === 'tool_stream' && text(record, 'actionId')) aliases.push(`action:${text(record, 'actionId')}`);
      const key = aliases.map(alias => executionKeys.current.get(alias)).find(Boolean) ?? aliases[0];
      for (const alias of aliases) executionKeys.current.set(alias, key);
      return <ExecutionEntry key={key} record={record} streams={linked} onReview={onReview} />;
    }
    return <div className="run-message" data-record-id={record.id} key={record.id}>
      {text(record, 'text') && <MessageText record={record} onError={connection.setError} />}
      {record.data.interrupted === true && <p className="small">Interrupted · partial output retained</p>}
      {text(record, 'error') && <p className="error-text">{text(record, 'error')}</p>}
      {record.data.outputTruncated === true && <p className="small">Display limited to 128 KiB per text channel; full finalized context remains in the Pi session.</p>}
    </div>;
  };
  const firstRecord = group.records[0];
  return <article className="message assistant conversation-run" data-run-id={group.id} aria-label="Outpost response">
    <div className="run-byline message-byline">
      <span className="message-avatar assistant-avatar" aria-hidden="true"><OutpostMark /></span>
      <span>Outpost</span>
      {firstRecord && <time dateTime={firstRecord.updatedAt}>{new Date(firstRecord.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
    </div>
    <div className="run-content">
      <RunReasoning records={group.records} />
      {chunks.map(chunk => chunk.length > 1
        ? <details className="completed-action-group" key={`completed:${chunk[0].id}`}><summary><ChevronRight size={13} className="disclosure" aria-hidden="true" /><Check size={15} aria-hidden="true" /><span>Completed actions</span><span className="small">{chunk.length} actions</span></summary><div>{chunk.map(render)}</div></details>
        : render(chunk[0]))}
    </div>
  </article>;
}

const TaskConversation = memo(function TaskConversation({ records, connection, onReview }: {
  records: ServerRecord[];
  connection: Connection;
  onReview: (record: ServerRecord) => void;
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
    : <Run key={group.id} group={group} connection={connection} streams={streams} onReview={onReview} />)}</>;
});

export default TaskConversation;
