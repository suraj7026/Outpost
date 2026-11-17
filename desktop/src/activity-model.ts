import { actionNeedsReview, text, type ServerRecord } from './types';

export const isExecutionRecord = (record: ServerRecord) => record.kind === 'action' || record.kind === 'tool_stream';

export function activityChunks(records: ServerRecord[]): ServerRecord[][] {
  const chunks: ServerRecord[][] = [];
  for (const record of records) {
    // Pi emits an assistant envelope for tool-only steps; it is not a visible divider.
    if (record.kind === 'message' && text(record, 'author') === 'assistant' &&
      !text(record, 'text').trim() && !text(record, 'error') && record.data.interrupted !== true &&
      record.data.outputTruncated !== true && !['error', 'aborted'].includes(text(record, 'stopReason'))) continue;
    const previous = chunks.at(-1);
    if (isExecutionRecord(record) && previous && isExecutionRecord(previous[0])) previous.push(record);
    else chunks.push([record]);
  }
  return chunks;
}

export function executionOutcome(record: ServerRecord): 'complete' | 'active' | 'attention' | 'waiting' {
  const state = text(record, 'state');
  if (record.data.interrupted || actionNeedsReview(record) || ['error', 'interrupted', 'denied', 'cancelled', 'pending', 'authorized'].includes(state)) return 'attention';
  if (record.kind === 'action' ? state === 'succeeded' : state === 'finished') return 'complete';
  if (record.kind === 'action' ? ['dispatching', 'running'].includes(state) : record.data.streaming === true && ['preparing', 'running'].includes(state)) return 'active';
  return 'waiting';
}

export function activitySummary(records: ServerRecord[]) {
  const outcomes = records.map(executionOutcome);
  const completed = outcomes.filter(value => value === 'complete').length;
  const attention = outcomes.includes('attention');
  const active = outcomes.includes('active');
  const complete = completed === records.length;
  const approval = records.some(record => record.kind === 'action' && ['pending', 'authorized'].includes(text(record, 'state')));
  const label = attention ? approval ? 'Waiting for approval' : 'Needs attention'
    : active ? 'Working' : complete ? `${completed} ${completed === 1 ? 'action' : 'actions'} completed` : 'Tool activity';
  return { completed, attention, active, complete, label };
}
