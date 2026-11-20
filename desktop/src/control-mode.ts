import { object, text, type Json, type RuntimeInfo, type ServerRecord } from './types';

export type ControlMode = 'full_control' | 'auto';
export type ControlCapabilities = Pick<RuntimeInfo, 'controlModes' | 'autoPolicyVersion'>;
export const autoUnavailable = 'Auto needs a compatible server update. Its safety policy is not verified on this server; work is blocked, not switched to Full control.';
export const pauseToChangeMode = 'Pause the task, then change control mode after active work settles.';
export const modeHelp: Record<ControlMode, string> = {
  full_control: 'Full control runs actions without individual approvals. Native extensions and subagents are available. Recovery and maintenance holds still apply.',
  auto: 'Auto runs trusted routine work automatically and asks before financial, destructive, security-sensitive or unknown actions. Scripts, build scripts, root commands and browser submissions may need review. Native extensions and subagents are disabled; classification is not a guarantee of safety.',
};

export function supportsAuto(runtime: ControlCapabilities | null | undefined): boolean {
  const modes = runtime?.controlModes;
  return runtime?.autoPolicyVersion === 1 && Array.isArray(modes) && modes.length === 2 &&
    modes.includes('full_control') && modes.includes('auto');
}

export function savedControlMode(value: unknown): ControlMode | null {
  return value === 'ask_permission' || value === 'auto' ? 'auto' : value === 'full_control' ? 'full_control' : null;
}

export function modeBlocker(mode: unknown, runtime: ControlCapabilities | null | undefined): string {
  if (!savedControlMode(mode)) return 'Control mode is unrecognized. Refresh the policy before continuing.';
  return savedControlMode(mode) === 'auto' && !supportsAuto(runtime) ? autoUnavailable : '';
}

export function taskModeBlocker(records: ServerRecord[], taskId: string, runtime: ControlCapabilities | null | undefined): string {
  const policy = records.find(row => row.kind === 'policy' && row.id === taskId);
  return policy ? modeBlocker(policy.data.mode, runtime) : '';
}

export function modeChangeActive(task: ServerRecord, records: ServerRecord[]): boolean {
  const state = text(task, 'state');
  if (['queued', 'running', 'reconciling'].includes(state) || state.startsWith('waiting_') && state !== 'waiting_for_capacity') return true;
  return records.some(row => text(row, 'taskId') === task.id && (
    row.kind === 'action' && ['dispatching', 'running'].includes(text(row, 'state')) ||
    row.data.streaming === true && row.data.interrupted !== true ||
    row.kind === 'subagent_run' && ['queued', 'running'].includes(text(row, 'state'))
  ));
}

// Defense in depth for every desktop command path, including cached task policies.
// Pause/cancel/deny remain available when a server cannot honor Auto.
export function controlCommandBlocker(runtime: ControlCapabilities | null | undefined, records: ServerRecord[], kind: string, id: string, payload: Record<string, Json>): string {
  if (['task.create', 'policy.change', 'recovery.investigate', 'automation.save'].includes(kind)) {
    const mode = kind === 'automation.save' ? object(payload.task).mode : payload.mode;
    if (mode !== undefined) {
      if (mode !== 'auto' && mode !== 'full_control') return 'Choose Full control or Auto.';
      const blocked = modeBlocker(mode, runtime);
      if (blocked) return blocked;
    }
    if (kind === 'policy.change') {
      const task = records.find(row => row.kind === 'task' && row.id === id);
      if (task && modeChangeActive(task, records)) return pauseToChangeMode;
    }
  }
  if (['task.steer', 'task.resume', 'action.propose'].includes(kind)) return taskModeBlocker(records, id, runtime);
  if (kind === 'action.dispatch' || kind === 'approval.decide' && payload.decision === 'approve') {
    const action = records.find(row => row.kind === 'action' && row.id === id);
    if (action) return taskModeBlocker(records, text(action, 'taskId'), runtime);
  }
  return '';
}
