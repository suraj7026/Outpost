import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Minus, Power, TerminalSquare, Unplug, X } from 'lucide-react';
import { nativeApp, recordedPreview, type EnvironmentId } from '../api';
import { terminalFor, type TerminalController } from './controller';
import '@xterm/xterm/css/xterm.css';
import './server-terminal.css';

function RebootDialog({ controller, close, returnFocus }: { controller: TerminalController; close: () => void; returnFocus: HTMLButtonElement | null }) {
  const { reboot } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState(false);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement;
    dialog.current?.showModal();
    return () => {
      controller.cancelReview();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [controller]);
  const target = reboot.review?.target;
  return <dialog className="server-reboot-dialog" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={close} onClose={close}>
    <div className="server-reboot-heading"><Power size={22} /><button className="icon-button" aria-label="Close reboot review" title="Close reboot review" onClick={close}><X size={18} /></button></div>
    <h2 id={titleId}>Reboot {target?.label || 'server'}?</h2>
    <p id={descriptionId}>This restarts the entire machine, not just this chat or Outpost. Every service, agent task and terminal session on this server will be interrupted. Unsaved shell work can be lost.</p>
    {target && <div className="server-reboot-target"><strong>{target.host}</strong><span>{target.label} · SSH as {target.user} · port {target.port}</span><small>Verified saved host key: {target.fingerprint}</small></div>}
    {!reboot.consumed && target && <>
      <label className="server-reboot-confirm">Type <strong>{target.host}</strong> to confirm<input aria-label="Confirm server hostname" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <label className="server-reboot-password"><input type="checkbox" checked={password} onChange={event => setPassword(event.target.checked)} />Ask for a sudo password in the protected native prompt</label>
      <p className="small">{password ? 'The desktop app handles the password securely. It never enters this web interface.' : 'Use non-interactive sudo. If a password is required, this request cannot authorize the reboot.'} Outpost never retries a reboot automatically.</p>
    </>}
    {reboot.message && <p role="status" className={reboot.state === 'error' || reboot.state === 'unknown' ? 'error-text' : ''}>{reboot.message}</p>}
    {reboot.consumed && <p className="small">{reboot.state === 'returned' ? 'A changed boot ID was verified by the native connection.' : 'A requested or uncertain reboot is not a verified completion. Read-only checks watch for a changed boot ID for up to three minutes.'}</p>}
    <div className="modal-actions">
      <button onClick={close}>{reboot.consumed ? 'Close' : 'Cancel'}</button>
      {reboot.state === 'returned' && <button onClick={() => {
        setConfirmation(''); setPassword(false);
        void controller.reviewAnotherReboot();
      }}>Review another reboot</button>}
      {!reboot.consumed && <button className="server-reboot-authorize" disabled={reboot.state !== 'review' || !target || confirmation !== target.host} onClick={() => void controller.applyReboot(confirmation, password)}>Continue to authorization</button>}
    </div>
  </dialog>;
}

export default function TerminalPane({ environmentId, label, onCollapse, fullSize = false, id }: {
  environmentId: EnvironmentId; label: string; onCollapse?: () => void; fullSize?: boolean; id?: string;
}) {
  const controller = terminalFor(environmentId);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const rebootButton = useRef<HTMLButtonElement>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const enabled = nativeApp() && !recordedPreview();
  useEffect(() => {
    if (!enabled || !host.current) return;
    const detach = controller.attach(host.current);
    if (controller.getSnapshot().state === 'idle') void controller.open();
    return detach;
  }, [controller, enabled]);
  const target = snapshot.target;
  const live = snapshot.state === 'connected' || snapshot.state === 'opening';
  const stateLabel = snapshot.state === 'connected' ? 'Shell connected' : snapshot.state === 'opening' ? 'Connecting to saved SSH host…' : snapshot.state === 'exited' ? `Shell exited${snapshot.exitCode == null ? '' : ` · code ${snapshot.exitCode}`}` : snapshot.state === 'error' ? 'Connection needs attention' : 'Shell disconnected';
  return <section id={id} className={`server-terminal-pane ${fullSize ? 'server-terminal-full' : ''}`} aria-label={`${label} server terminal`} data-terminal-owner={environmentId ?? 'legacy'}>
    <div className="server-terminal-toolbar">
      <div className="server-terminal-identity"><TerminalSquare size={17} aria-hidden="true" /><strong>Terminal</strong><div><span>{target ? `${target.user}@${target.host}` : label}</span><small>{target ? `${target.label} · verified SSH host · port ${target.port}` : 'Saved SSH connection'}</small></div></div>
      <div className="server-terminal-actions">
        {enabled && <button onClick={() => live ? void controller.disconnect() : void controller.open()}><Unplug size={14} />{live ? 'Disconnect' : 'Reconnect'}</button>}
        <button ref={rebootButton} className="server-terminal-reboot" disabled={!enabled} onClick={() => { setReviewOpen(true); if (!snapshot.reboot.consumed) void controller.reviewReboot(); }}><Power size={14} />{snapshot.reboot.consumed ? 'Reboot status…' : 'Reboot server…'}</button>
        {onCollapse && <button className="icon-button" aria-label="Collapse terminal" title="Collapse terminal" onClick={onCollapse}><Minus size={16} /></button>}
      </div>
    </div>
    {!enabled ? <div className="server-terminal-notice" role="status"><p>This preview is read-only. Open the installed Outpost app and connect a verified saved SSH server to use the terminal or reboot.</p><a href="#settings/servers">Open server settings</a></div> : <>
      <div className="server-terminal-state" role="status">{stateLabel}</div>
      {snapshot.error && <div className="server-terminal-notice" role="alert"><p>{snapshot.error}</p><a href="#settings/servers">Open Server setup in Settings</a></div>}
      {snapshot.warning && <p className="server-terminal-notice" role="status">{snapshot.warning}</p>}
      {snapshot.reboot.consumed && <p className="server-terminal-reboot-status" role="status"><strong>{snapshot.reboot.state === 'returned' ? 'Reboot verified' : snapshot.reboot.state === 'unknown' ? 'Reboot outcome unknown' : 'Reboot not yet verified'}</strong> · {snapshot.reboot.message}</p>}
      <div className="server-terminal-screen" ref={host} aria-label="Interactive SSH terminal" />
    </>}
    <div className="server-terminal-footer"><span>SSH · UTF-8</span><span>Collapsing keeps this shell open. Disconnect ends it, not agent tasks.</span><span>⌃C Interrupt · ⌘V Paste</span></div>
    {reviewOpen && <RebootDialog key={environmentId ?? 'legacy'} controller={controller} returnFocus={rebootButton.current} close={() => setReviewOpen(false)} />}
  </section>;
}
