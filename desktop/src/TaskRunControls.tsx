import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Square } from 'lucide-react';
import type { TaskRunStatus } from './conversation-model';

export interface TaskRunControlsProps {
  status: TaskRunStatus;
  following: boolean;
  unseen: number;
  onJump: () => void;
  onStop: () => void;
  review?: ReactNode;
  canStop: boolean;
  /** Gates the server mutation, not local navigation to the latest output. */
  disabled: boolean;
}

export default function TaskRunControls({ status, following, unseen, onJump, onStop, review, canStop, disabled }: TaskRunControlsProps) {
  const stop = useRef<HTMLButtonElement>(null);
  const follow = useRef<HTMLButtonElement>(null);
  const retires = status.transient && (status.kind === 'success' || status.kind === 'stopped');
  const showStop = canStop && !retires;
  const [stopVisible, setStopVisible] = useState(showStop);
  const [visible, setVisible] = useState(true);

  useLayoutEffect(() => {
    // Delay hiding until focus has moved; aria-disabled never blurs the old target.
    if (!showStop && document.activeElement === stop.current) follow.current?.focus({ preventScroll: true });
    setStopVisible(showStop);
  }, [showStop]);

  useLayoutEffect(() => {
    setVisible(true);
    if (!status.transient || (status.kind !== 'success' && status.kind !== 'stopped')) return;
    const timer = window.setTimeout(() => {
      if (document.activeElement === stop.current) follow.current?.focus({ preventScroll: true });
      setVisible(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [status.kind, status.label, status.transient]);

  const hasUnseen = !following && unseen > 0;
  const followAction = following ? status.active ? 'Following live' : 'At latest' : 'Jump to latest';
  const followLabel = [followAction, hasUnseen ? `${unseen} new` : '', status.label].filter(Boolean).join(' · ');

  return <>
    <div className="composer-run-status" data-kind={status.kind} data-visible={visible} aria-hidden={!visible} inert={!visible}>
      <span className="composer-run-mark" aria-hidden="true" />
      <span className="composer-run-label" role="status" aria-live="polite" aria-atomic="true" title={status.label}>{status.label}</span>
      {review}
      <span className="composer-stop-slot">
        <button ref={stop} type="button" className="composer-run-stop" hidden={!stopVisible}
          aria-label="Stop task" title="Stop task" aria-disabled={disabled || !showStop}
          onClick={() => { if (!disabled && showStop) onStop(); }}>
          <Square size={10} aria-hidden="true" />Stop
        </button>
      </span>
    </div>
    <button ref={follow} type="button" className="icon-button composer-follow"
      aria-label={followLabel} title={followLabel} aria-disabled={following}
      data-active={status.active} data-unseen={hasUnseen}
      onClick={() => { if (!following) onJump(); }}>
      <ArrowDown size={17} aria-hidden="true" />
    </button>
  </>;
}
