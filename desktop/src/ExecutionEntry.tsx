import { useMemo, useState } from 'react';
import { ChevronRight, Globe, Shield, SquareTerminal as Terminal } from 'lucide-react';
import { actionLabel } from './conversation-model';
import { useConversationDisclosure } from './conversation-detail';
import { EvidenceTime } from './LiveContent';
import OutcomeDot from './OutcomeDot';
import { actionNeedsReview, labelState, object, text, type ServerRecord } from './types';

export function executionIsActive(record: ServerRecord): boolean {
  return record.kind === 'action'
    ? ['pending', 'authorized', 'dispatching', 'running'].includes(text(record, 'state'))
    : record.data.streaming === true && !record.data.interrupted && ['preparing', 'running'].includes(text(record, 'state'));
}

export default function ExecutionEntry({ record, streams = [], onReview }: {
  record: ServerRecord;
  streams?: ServerRecord[];
  onReview: (record: ServerRecord) => void;
}) {
  const { open: expanded, setOpen: setExpanded } = useConversationDisclosure();
  const [copied, setCopied] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const stream = record.kind === 'tool_stream';
  const envelope = object(record.data.arguments);
  const args = stream && typeof envelope.tool === 'string' ? object(envelope.arguments) : envelope;
  const name = stream && typeof envelope.tool === 'string' ? envelope.tool : text(record, 'tool') || text(record, 'name');
  const state = record.data.interrupted ? 'interrupted' : text(record, 'state');
  const failed = stream ? ['error', 'interrupted'].includes(state) : actionNeedsReview(record);
  const succeeded = !failed && ['succeeded', 'finished'].includes(state);
  const review = !stream && ['pending', 'authorized'].includes(state);
  const result = object(record.data.result);
  const argv = Array.isArray(args.argv) && args.argv.every(value => typeof value === 'string') ? args.argv : [];
  // argv is an argument array, not shell text. JSON preserves boundaries for inspection.
  const command = typeof args.command === 'string' ? args.command : argv.length ? JSON.stringify(argv) : '';
  const linkedOutput = streams.map(item => text(item, 'output')).filter(Boolean).at(-1) || '';
  const stdout = typeof result.stdout === 'string' ? result.stdout : text(record, 'output') || linkedOutput;
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const error = typeof result.error === 'string' ? result.error : '';
  const detail = typeof result.detail === 'string' ? result.detail : '';
  const target = typeof args.path === 'string' ? args.path : typeof args.url === 'string' ? args.url : text(record, 'target');
  const Icon = name.startsWith('browser.') ? Globe : name === 'host.execute' ? Shield : Terminal;
  const outcome = failed ? stream ? 'Failed attempt' : 'Needs review' : succeeded ? 'Succeeded' : labelState(state);
  const rawPayload = useMemo(() => rawOpen ? JSON.stringify({
    arguments: args, ...(Object.keys(result).length ? { result } : {}), ...(stream ? { output: text(record, 'output') } : {}),
  }, null, 2) : '', [rawOpen, record, args, result, stream]);

  return <details className={`action execution-entry ${stream ? 'live-tool' : ''} ${failed ? 'action-failed' : ''}`}
    data-record-id={record.id} data-state={state} open={expanded}
    onToggle={event => { if (event.currentTarget.open !== expanded) setExpanded(event.currentTarget.open); }}>
    <summary>
      <ChevronRight size={13} className="disclosure" aria-hidden="true" />
      <Icon size={15} aria-hidden="true" />
      <span className="execution-label" title={actionLabel(record)}>{actionLabel(record)}</span>
      <span className="action-state">{failed || succeeded ? <OutcomeDot failed={failed} label={outcome} /> : labelState(state === 'dispatching' ? 'running' : state)}</span>
      {review && <button type="button" className="execution-review" onClick={event => {
        event.preventDefault(); event.stopPropagation(); onReview(record);
      }}>Review</button>}
    </summary>
    <div className="action-body">
      <div className="execution-meta"><span>{name || 'Tool call'}</span><EvidenceTime record={record} /></div>
      {target && <p className="small execution-target">{target}</p>}
      {command && <>
        <div className="execution-section-title"><span>{argv.length && !args.command ? 'Arguments' : 'Command'}</span><button type="button" onClick={() => {
          void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setCopied(false));
        }}>{copied ? 'Copied' : 'Copy'}</button></div>
        <pre className="execution-command" tabIndex={0}>{command}</pre>
      </>}
      {stdout && <><div className="execution-section-title"><span>Output</span><span>Latest 5 lines</span></div><pre className="execution-output" tabIndex={0} aria-label="Latest command output">{stdout.split('\n').slice(-5).join('\n')}</pre></>}
      {stderr && <pre className="execution-output error-text" tabIndex={0} aria-label="Latest error output">{stderr.split('\n').slice(-5).join('\n')}</pre>}
      {typeof result.exitCode === 'number' && <p className={`small ${result.exitCode !== 0 ? 'error-text' : ''}`}>Exit code {result.exitCode}</p>}
      {error && <p className="error-text">{error}</p>}
      {detail && <pre className="execution-output" tabIndex={0}>{detail.split('\n').slice(-5).join('\n')}</pre>}
      {typeof result.result === 'string' && <p>{result.result}</p>}
      {failed && !stdout && !stderr && !error && !detail && <p className="small">This attempt did not complete successfully. No additional error detail was recorded.</p>}
      {review && <p className="small">Review the exact arguments before {state === 'authorized' ? 'dispatching this approved action' : 'approving this action'}.</p>}
      <details className="execution-raw" open={rawOpen} onToggle={event => { if (event.currentTarget.open !== rawOpen) setRawOpen(event.currentTarget.open); }}><summary><ChevronRight size={13} className="disclosure" aria-hidden="true" />Input &amp; full output</summary>
        {rawOpen && <><pre tabIndex={0}>{rawPayload}</pre>
          {streams.map(item => <div key={item.id}><p className="small">Tool stream · {labelState(text(item, 'state'))}{item.data.interrupted ? ' · interrupted' : ''}</p><pre tabIndex={0}>{text(item, 'output') || '(no output)'}</pre></div>)}
        </>}
      </details>
    </div>
  </details>;
}
