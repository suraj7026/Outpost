import { text, type ServerRecord } from './types';

export function unchangedReviewedAction(snapshot: ServerRecord, current: ServerRecord | undefined): boolean {
  return !!current && current.kind === 'action' && snapshot.kind === 'action' && current.id === snapshot.id &&
    current.revision === snapshot.revision && text(current, 'taskId') === text(snapshot, 'taskId') &&
    text(current, 'state') === text(snapshot, 'state') && text(current, 'nonce') === text(snapshot, 'nonce') &&
    text(current, 'actionDigest') === text(snapshot, 'actionDigest') &&
    JSON.stringify(current.data.arguments) === JSON.stringify(snapshot.data.arguments) &&
    JSON.stringify(current.data.effects) === JSON.stringify(snapshot.data.effects) && text(current, 'target') === text(snapshot, 'target');
}
