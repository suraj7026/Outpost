import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Eye, EyeOff, Globe, Maximize2, X } from 'lucide-react';
import type { EnvironmentApi } from './api';
import { recordedPreview } from './api';
import {
  FAST_POLL_MS,
  INPUT_BOOST_MS,
  mergeBrowserFrame,
  nextBrowserPollDelayMs,
  type BrowserFrame,
} from './browser-polling';
import type { ServerRecord } from './types';
import { text } from './types';
import './browser-viewer.css';

type RefreshOutcome = 'updated' | 'unchanged' | 'error' | 'stale';

export default function BrowserViewer({ taskId, api, connected, session, engine, takeover = false, deviceId = '', active: viewActive = true, embedded = false }: {
  taskId: string; api: EnvironmentApi; connected: boolean; session: ServerRecord | undefined; engine?: string | null;
  takeover?: boolean; deviceId?: string; active?: boolean; embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [enlarged, setEnlarged] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const enlargeButton = useRef<HTMLButtonElement>(null);
  const wasEnlarged = useRef(false);
  const textInputId = useId();
  useEffect(() => {
    if (!viewActive) { dialog.current?.close(); setEnlarged(false); }
  }, [viewActive]);
  useEffect(() => {
    if (enlarged) dialog.current?.showModal();
    else if (wasEnlarged.current) enlargeButton.current?.focus({ preventScroll: true });
    wasEnlarged.current = enlarged;
  }, [enlarged]);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [error, setError] = useState('');
  const [controlError, setControlError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputText, setInputText] = useState('');
  const [maskInput, setMaskInput] = useState(false);
  const [address, setAddress] = useState('');
  const [key, setKey] = useState('Enter');
  const [now, setNow] = useState(Date.now());
  const alive = useRef(false), sending = useRef(false), generation = useRef(0), lifetime = useRef(0);
  const current = useRef<BrowserFrame | null>(null);
  const boostUntil = useRef(0);
  const reschedulePoll = useRef<((delayMs: number) => void) | null>(null);
  const hasSession = !!session;
  const propState = session ? text(session, 'state') : '';
  const sessionStateRef = useRef(propState);
  sessionStateRef.current = propState;

  const refresh = useCallback(async (): Promise<RefreshOutcome> => {
    const ticket = ++generation.current;
    const previous = current.current;
    const payload: Record<string, string> = { taskId };
    if (previous?.frame && previous.frameId) payload.lastFrameId = previous.frameId;
    try {
      const result = await api.query<BrowserFrame>('browser.frame', payload);
      if (!alive.current || ticket !== generation.current) return 'stale';
      const merged = mergeBrowserFrame(current.current, result);
      current.current = merged; setFrame(merged); setError('');
      return result.unchanged && !!merged.frame ? 'unchanged' : 'updated';
    } catch {
      if (!alive.current || ticket !== generation.current) return 'stale';
      current.current = null; setFrame(null); setError('Live view unavailable. Retrying…');
      return 'error';
    }
  }, [api, taskId]);

  useEffect(() => {
    if (propState === 'running' || propState === 'starting') {
      reschedulePoll.current?.(FAST_POLL_MS);
    }
  }, [propState]);

  useEffect(() => {
    alive.current = true; lifetime.current++;
    current.current = null; boostUntil.current = 0;
    setFrame(null); setError(''); setInputText(''); setMaskInput(false); setAddress(''); setBusy(sending.current);
    let cancelled = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let clock: ReturnType<typeof setInterval> | undefined;
    const canPoll = connected && viewActive && expanded && hasSession && !recordedPreview();
    const schedule = (delayMs: number) => {
      clearTimeout(timer); timer = undefined;
      if (cancelled || !canPoll || document.hidden || inFlight) return;
      timer = setTimeout(() => { timer = undefined; void poll(); }, delayMs);
    };
    const poll = async () => {
      if (cancelled || !canPoll || document.hidden || inFlight) return;
      inFlight = true;
      clearTimeout(timer); timer = undefined;
      let outcome: RefreshOutcome = 'error';
      try {
        outcome = await refresh();
        const latest = current.current, lease = latest?.control;
        if (!cancelled && lease?.holder === deviceId && ['pending', 'human'].includes(lease.state)
          && lease.expiresAt > Date.now() && lease.expiresAt - Date.now() < 15000 && latest?.controlEpoch) {
          try {
            await api.browserRequest({ type: 'renew', taskId, epoch: latest.controlEpoch, leaseId: lease.leaseId });
          } catch { if (!cancelled) setControlError('Control could not be renewed. Refresh the view before continuing.'); }
        }
      } finally {
        inFlight = false;
      }
      if (cancelled || document.hidden) return;
      const latest = current.current;
      schedule(nextBrowserPollDelayMs({
        now: Date.now(),
        boostUntil: boostUntil.current,
        sessionState: latest?.session?.state ?? sessionStateRef.current,
        controlState: latest?.control?.state,
        unchanged: outcome === 'unchanged',
        hasError: outcome === 'error',
      }));
    };
    reschedulePoll.current = schedule;
    const onVisibilityChange = () => {
      clearInterval(clock); clock = undefined;
      if (document.hidden) {
        clearTimeout(timer); timer = undefined;
        return;
      }
      if (viewActive && connected && hasSession) {
        setNow(Date.now());
        clock = setInterval(() => setNow(Date.now()), 1000);
      }
      if (canPoll && !inFlight) void poll();
    };
    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true; alive.current = false; lifetime.current++; generation.current++;
      reschedulePoll.current = null;
      clearTimeout(timer); clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [api, taskId, connected, viewActive, expanded, hasSession, deviceId, refresh]);

  const state = frame?.session?.state ?? (session ? text(session, 'state') : '');
  const mode = frame?.session?.mode ?? (session ? text(session, 'mode') : '');
  const url = frame?.session?.url ?? (session ? text(session, 'url') : '');
  const active = ['starting', 'running', 'idle'].includes(state);
  const fresh = !!frame?.capturedAt && now - Date.parse(frame.capturedAt) < 5000;
  const canShow = connected && active && !error && !recordedPreview() && (!frame?.frame || fresh);
  const lease = frame?.control;
  const held = !!lease && ['pending', 'human', 'releasing'].includes(lease.state);
  const mine = held && lease.holder === deviceId;
  const canInput = canShow && mine && lease.state === 'human' && lease.expiresAt > now && fresh && !!frame?.frameId && !busy;
  useEffect(() => { if (!mine) { setInputText(''); setMaskInput(false); } }, [mine]);

  const control = async (type: 'take' | 'release' | 'input', input?: Record<string, unknown>) => {
    const latest = current.current, scope = lifetime.current;
    if (sending.current || !connected || !latest?.controlEpoch || (type === 'input' && !canInput)) return;
    sending.current = true; setBusy(true); setControlError(''); generation.current++;
    boostUntil.current = Date.now() + INPUT_BOOST_MS;
    try {
      await api.browserRequest({ type, taskId, epoch: latest.controlEpoch,
        ...(type !== 'take' ? { leaseId: latest.control?.leaseId } : {}),
        ...(type === 'input' ? { frameId: latest.frameId, input } : {}) });
    } catch {
      if (alive.current && scope === lifetime.current) setControlError(type === 'input'
        ? 'Input outcome uncertain. Inspect the refreshed page before acting again; nothing is retried automatically.'
        : 'Control request did not confirm. Check the refreshed ownership status before trying again.');
    } finally {
      boostUntil.current = Date.now() + INPUT_BOOST_MS;
      if (alive.current && scope === lifetime.current) {
        const outcome = await refresh();
        const nextLatest = current.current;
        reschedulePoll.current?.(nextBrowserPollDelayMs({
          now: Date.now(),
          boostUntil: boostUntil.current,
          sessionState: nextLatest?.session?.state ?? sessionStateRef.current,
          controlState: nextLatest?.control?.state,
          unchanged: outcome === 'unchanged',
          hasError: outcome === 'error',
        }));
      }
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const message = !connected ? 'Offline. Reconnect to watch the server browser.'
    : recordedPreview() ? 'Recorded preview. Live browser viewing requires the connected app.'
    : error || (!hasSession ? 'Ask Pi to use the browser. Its page will appear here.'
    : state === 'closed' ? 'Browser closed. The task profile and saved files are retained.'
    : state === 'interrupted' ? 'Browser interrupted. Ask Pi to reopen it before continuing.'
    : 'Waiting for a fresh page frame…');
  const ownership = !connected ? 'Live view paused · offline' : !held ? lease?.state === 'expired' ? 'Control expired. Pi remains paused.' : lease?.state === 'released' ? 'Control returned. Resume Pi when ready.' : 'View only · live updates'
    : lease.state === 'pending' ? 'Waiting for the current browser operation to finish. Pi is paused.'
    : lease.state === 'releasing' ? 'Finishing the handoff. Pi remains paused.'
    : mine ? 'You control this browser. Pi is paused.' : 'Another device controls this browser.';
  const hasFrame = !!(canShow && frame?.frame);
  const showInputs = takeover && mine && lease.state === 'human';
  const status = !connected ? 'Offline' : error || (frame?.frame && !fresh) ? 'Unavailable' : held ? 'Owner control' : state === 'running' ? 'Working' : active ? 'Live view' : 'Ready';
  const image = <img src={`data:image/jpeg;base64,${frame?.frame}`} draggable={false} alt="Current page in this task’s server browser" />;
  const content = <>
    <div className="browser-heading-row">
      {enlarged || embedded ? <div className="browser-viewer-title"><Globe size={17} /><h2 className={embedded && !enlarged && url ? 'browser-viewer-url' : undefined} title={embedded && !enlarged ? url : undefined}>{embedded && !enlarged && url ? url : 'Server browser'}</h2></div>
        : <button className="browser-viewer-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          <ChevronRight size={13} className={expanded ? 'expanded' : ''} /><Globe size={15} /><span>Server browser</span>
        </button>}
      <span className="browser-viewer-status" data-live={hasFrame}>{status}</span>
      <button ref={enlarged ? undefined : enlargeButton} className="browser-enlarge icon-button"
        aria-label={enlarged ? 'Close browser view' : 'Enlarge browser view'} title={enlarged ? 'Close browser view' : 'Enlarge browser view'}
        onClick={() => { setExpanded(true); setEnlarged(value => !value); }}>
        {enlarged ? <X size={16} /> : <Maximize2 size={16} />}
      </button>
    </div>
    {expanded && <div className="browser-viewer-body">
      <div className="browser-toolbar">
        <p className="browser-mode"><strong>{mode === 'human' ? 'Owner input' : mode === 'direct' ? 'Pi actions' : 'Pi actions available'}</strong>
          <span>{engine === 'camoufox' ? 'Camoufox · direct Pi control' : 'Direct control available'}</span></p>
        {takeover && <button className="browser-control-toggle"
          disabled={!canShow || !frame?.controlEpoch || busy || (held && (!mine || lease.state === 'releasing'))}
          title={!connected ? 'Reconnect to take control of the server browser' : undefined}
          onClick={() => void control(mine ? 'release' : 'take')}>{busy ? 'Working…' : mine ? 'Return control' : 'Take control'}</button>}
      </div>
      {controlError && <p className="browser-control-error" role="alert">{controlError}</p>}
      <div className="browser-workspace" data-controls={showInputs}>
        <div className="browser-viewer-main">
          {url && (!embedded || enlarged) && <p className="browser-viewer-url" title={url}>{url}</p>}
          <div className="browser-frame" data-empty={!hasFrame}>
            {hasFrame ? mine && lease.state === 'human'
              ? <button className="browser-page-input" aria-label="Click server browser page" disabled={!canInput} onClick={event => {
                if (!event.detail) return;
                const rect = event.currentTarget.getBoundingClientRect();
                void control('input', { action: 'click', x: (event.clientX - rect.left) / rect.width * (frame.width ?? 1280), y: (event.clientY - rect.top) / rect.height * (frame.height ?? 800) });
              }}>{image}</button> : image
              : <p role="status">{message}</p>}
          </div>
          <div className="browser-viewer-footer"><span role="status">{ownership}</span>
            {canShow && frame?.capturedAt && <time dateTime={frame.capturedAt}>Updated {new Date(frame.capturedAt).toLocaleTimeString()}</time>}
          </div>
          {state === 'running' && frame?.session?.action && <p className="browser-current-action">{frame.session.action}</p>}
        </div>
        {showInputs && <div className="browser-control">
          <p className="browser-control-note">Click the page to focus a field. Sent text is not saved in chat or input logs. This is the shared task profile; Pi can see the page after you resume.</p>
          <form onSubmit={event => {
            event.preventDefault();
            if (!canInput || !inputText) return;
            const value = inputText;
            setInputText('');
            void control('input', { action: 'text', text: value });
          }}>
            <div className="browser-text-field">
              <label htmlFor={textInputId}>Text for focused field</label>
              <div className="browser-text-input-row">
                <input
                  id={textInputId}
                  type={maskInput ? 'password' : 'text'}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={inputText}
                  maxLength={20000}
                  disabled={!canInput}
                  onChange={event => setInputText(event.target.value)}
                />
                <button
                  type="button"
                  className="browser-mask-toggle icon-button"
                  aria-pressed={maskInput}
                  aria-label="Mask input (password/secret)"
                  title={maskInput ? 'Show input text' : 'Mask input (password/secret)'}
                  onClick={() => setMaskInput(value => !value)}
                >
                  {maskInput ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={!canInput || !inputText}>Send text</button>
          </form>
          <div className="browser-input-row">
            <label>Browser key<select value={key} disabled={!canInput} onChange={event => setKey(event.target.value)}>
              {['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'ControlOrMeta+A'].map(value => <option key={value}>{value}</option>)}
            </select></label><button type="button" disabled={!canInput} onClick={() => void control('input', { action: 'key', key })}>Send key</button>
          </div>
          <div className="browser-input-row"><button type="button" disabled={!canInput} onClick={() => void control('input', { action: 'scroll', x: 0, y: -500 })}>Scroll up</button>
            <button type="button" disabled={!canInput} onClick={() => void control('input', { action: 'scroll', x: 0, y: 500 })}>Scroll down</button></div>
          <form onSubmit={event => { event.preventDefault(); void control('input', { action: 'navigate', url: address }); }}>
            <label>Go to URL<input type="url" value={address} disabled={!canInput} onChange={event => setAddress(event.target.value)} placeholder="https://" required /></label>
            <button type="submit" disabled={!canInput || !address}>Go</button>
          </form>
          {!!frame?.tabs?.length && <label>Browser tab<select disabled={!canInput} value={frame.tabs.find(tab => tab.active)?.tab ?? 0} onChange={event => void control('input', { action: 'switch_tab', tab: Number(event.target.value) })}>
            {frame.tabs.map(tab => <option key={tab.tab} value={tab.tab}>{tab.tab + 1}: {tab.url || 'Blank page'}</option>)}
          </select></label>}
        </div>}
      </div>
    </div>}
  </>;
  return enlarged ? <dialog ref={dialog} className="browser-viewer browser-viewer-dialog" data-empty={!hasFrame} aria-label="Server browser"
    onCancel={event => { event.preventDefault(); setEnlarged(false); }}>{content}</dialog>
    : <section className={`browser-viewer${embedded ? ' browser-viewer-embedded' : ''}`} aria-label="Server browser">{content}</section>;
}
