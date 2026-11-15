import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { call, nativeApp, recordedPreview, type EnvironmentId } from '../api';

export interface TerminalTarget {
  setupId: string; label: string; host: string; user: string; port: number; fingerprint: string;
}
interface Opened { sessionId: string; target: TerminalTarget }
interface ReadReply { data: string; nextOffset: number; dropped: boolean; exited: boolean; exitCode: number | null }
interface Review { reviewId: string; target: TerminalTarget }
type RebootState = 'idle' | 'reviewing' | 'review' | 'applying' | 'requested' | 'waiting' | 'returned' | 'unknown' | 'error';
export interface RebootSnapshot { state: RebootState; review?: Review; message: string; consumed: boolean }
interface Snapshot {
  state: 'idle' | 'opening' | 'connected' | 'disconnected' | 'exited' | 'error';
  target?: TerminalTarget; error: string; warning: string; exitCode?: number | null; reboot: RebootSnapshot;
}
const controllers = new Map<EnvironmentId, TerminalController>();
const available = () => nativeApp() && !recordedPreview();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sameTarget = (a: TerminalTarget, b: TerminalTarget) =>
  a.setupId === b.setupId && a.host === b.host && a.user === b.user && a.port === b.port && a.fingerprint === b.fingerprint;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0));

// Controllers outlive chat/Machines views. Neither queued input nor asynchronous replies
// ever consult the selected chat: the owner and each session generation are captured here.
export class TerminalController {
  private snapshot: Snapshot = { state: 'idle', error: '', warning: '', reboot: { state: 'idle', message: '', consumed: false } };
  private listeners = new Set<() => void>();
  private generation = 0;
  private sessionId?: string;
  private readTimer?: ReturnType<typeof setTimeout>;
  private rebootTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private rendering: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private terminal?: Terminal;
  private fit?: FitAddon;
  private container?: HTMLDivElement;
  private attachment?: HTMLElement;
  private observer?: ResizeObserver;
  private cols = 80;
  private rows = 24;
  private closing: Promise<void> = Promise.resolve();
  private rebootGeneration = 0;
  constructor(readonly environmentId: EnvironmentId) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private reboot(patch: Partial<RebootSnapshot>) { this.update({ reboot: { ...this.snapshot.reboot, ...patch } }); }
  private active() { return this.snapshot.state === 'opening' || !!this.sessionId; }
  private createTerminal() {
    if (this.terminal) return;
    // Retain at most four emulator buffers. Never evict a live shell to make room.
    const retained = [...controllers.values()].filter(item => item.terminal);
    if (retained.length >= 4) {
      const idle = retained.find(item => !item.active() && !item.attachment);
      if (!idle) throw new Error('Four terminals are retained. Disconnect a terminal and leave its pane before opening another server.');
      idle.disposeEmulator();
    }
    this.container = document.createElement('div');
    this.container.className = 'server-terminal-emulator';
    this.terminal = new Terminal({
      cols: this.cols, rows: this.rows, scrollback: 3000, fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: false, screenReaderMode: true, disableStdin: true,
      allowProposedApi: false, allowTransparency: false,
      linkHandler: { activate: () => {} },
      theme: { background: '#101113', foreground: '#ededef', cursor: '#c7c9cf', selectionBackground: '#44464b' },
    });
    this.fit = new FitAddon();
    this.terminal.loadAddon(this.fit);
    // Explicitly consume clipboard and hyperlink OSC sequences; no clipboard, link,
    // image, file-transfer or download addons are installed.
    this.terminal.parser.registerOscHandler(52, () => true);
    this.terminal.parser.registerOscHandler(8, () => true);
    this.terminal.onData(data => this.write(new TextEncoder().encode(data)));
    this.terminal.onBinary(data => this.write(Uint8Array.from(data, char => char.charCodeAt(0))));
    this.terminal.onResize(({ cols, rows }) => {
      this.cols = cols; this.rows = rows;
      const sessionId = this.sessionId, generation = this.generation;
      if (sessionId) this.enqueue(async () => {
        if (generation !== this.generation || sessionId !== this.sessionId) return;
        await call('terminal_resize', { sessionId, cols, rows });
      }, generation);
    });
  }
  attach(host: HTMLElement) {
    this.attachment = host;
    try {
      this.createTerminal();
      this.observer?.disconnect();
      this.attachment = host;
      host.append(this.container!);
      if (!this.terminal!.element) this.terminal!.open(this.container!);
      const fit = () => {
        if (this.attachment !== host || host.clientWidth < 40 || host.clientHeight < 40) return;
        const size = this.fit?.proposeDimensions();
        if (size) this.terminal?.resize(Math.max(1, Math.min(500, size.cols)), Math.max(1, Math.min(300, size.rows)));
      };
      this.observer = new ResizeObserver(fit);
      this.observer.observe(host);
      fit();
    } catch (error) { this.update({ error: message(error) }); }
    return () => {
      if (this.attachment !== host) return;
      this.observer?.disconnect(); this.observer = undefined;
      this.container?.remove(); this.attachment = undefined;
    };
  }
  focus() { this.terminal?.focus(); }
  async open() {
    if (!available() || this.disposed || this.active()) return;
    const generation = ++this.generation;
    this.update({ state: 'opening', error: '', warning: '', exitCode: undefined });
    try {
      await this.closing;
      // Drain accepted parser work before opening another shell, so replies generated
      // by old output cannot reach a new session and no new native PTY waits on rendering.
      await this.rendering;
      if (generation !== this.generation || this.disposed) return;
      this.createTerminal();
      if (this.attachment && !this.terminal?.element) this.attach(this.attachment);
      if ([...controllers.values()].filter(item => item !== this && item.active()).length >= 4)
        throw new Error('Four shells are open. Disconnect another server terminal before connecting.');
      const target = await call<TerminalTarget>('terminal_target', { environmentId: this.environmentId });
      if (generation !== this.generation || this.disposed) return;
      this.update({ target });
      const opened = await call<Opened>('terminal_open', { environmentId: this.environmentId, cols: this.cols, rows: this.rows });
      if (generation !== this.generation || this.disposed) {
        await call('terminal_close', { sessionId: opened.sessionId }); return;
      }
      if (!sameTarget(target, opened.target)) {
        await call('terminal_close', { sessionId: opened.sessionId });
        throw new Error('The saved SSH target changed while connecting. Review Server setup before reconnecting.');
      }
      this.sessionId = opened.sessionId;
      this.terminal!.reset();
      this.terminal!.options.disableStdin = false;
      this.update({ state: 'connected', target: opened.target });
      // The pane may have resized while the SSH open request was in flight.
      this.enqueue(() => call('terminal_resize', { sessionId: opened.sessionId, cols: this.cols, rows: this.rows }), generation);
      void this.poll(opened.sessionId, generation, 0);
    } catch (error) {
      if (generation === this.generation) this.update({ state: 'error', error: message(error) });
    }
  }
  private async poll(sessionId: string, generation: number, offset: number) {
    if (generation !== this.generation || this.disposed) return;
    try {
      const reply = await call<ReadReply>('terminal_read', { sessionId, offset });
      if (generation !== this.generation || this.disposed) return;
      if (reply.dropped) this.update({ warning: 'Some output exceeded the server buffer and was dropped.' });
      const terminal = this.terminal;
      if (reply.data && terminal) {
        this.rendering = new Promise<void>(resolve => terminal.write(decode(reply.data), resolve));
        await this.rendering;
      }
      if (generation !== this.generation || this.disposed) return;
      if (reply.exited && this.terminal) this.terminal.options.disableStdin = true;
      // exited can be true while the native ring still has multiple 64 KiB pages.
      // Keep draining until an empty read before releasing the native session.
      if (reply.exited && !reply.data) {
        await this.disconnect();
        if (generation + 1 === this.generation) this.update({ state: 'exited', exitCode: reply.exitCode });
        return;
      }
      this.readTimer = setTimeout(() => void this.poll(sessionId, generation, reply.nextOffset), 100);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      void this.disconnect();
      this.update({ state: 'error', error: `Terminal read stopped: ${message(error)}. Reconnect explicitly to start a new shell.` });
    }
  }
  private enqueue(operation: () => Promise<unknown>, generation: number) {
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation || this.disposed) return;
      try { await operation(); }
      catch (error) {
        if (generation !== this.generation || this.disposed) return;
        void this.disconnect();
        this.update({ state: 'error', error: `Terminal input stopped: ${message(error)}. Input was not retried.` });
      }
    });
  }
  private write(bytes: Uint8Array) {
    const sessionId = this.sessionId, generation = this.generation;
    if (!sessionId || this.snapshot.state !== 'connected' || !available()) return;
    if (this.queuedBytes + bytes.length > 256 * 1024) {
      this.update({ error: 'Paste is too large or input is still sending. Paste at most 256 KiB at a time.' }); return;
    }
    // Chunk bytes, not JS strings; multibyte input and paste remain ordered on the PTY.
    this.queuedBytes += bytes.length;
    for (let start = 0; start < bytes.length; start += 4096) {
      const data = encode(bytes.subarray(start, start + 4096));
      this.enqueue(async () => {
        if (sessionId === this.sessionId) await call('terminal_write', { sessionId, data });
      }, generation);
    }
    this.queue = this.queue.then(() => { this.queuedBytes -= bytes.length; });
  }
  async disconnect() {
    ++this.generation;
    clearTimeout(this.readTimer);
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (this.terminal) this.terminal.options.disableStdin = true;
    this.update({ state: 'disconnected' });
    if (sessionId) this.closing = this.closing.then(() => call<void>('terminal_close', { sessionId })).catch(error => {
      this.update({ error: `Could not confirm shell closure: ${message(error)}` });
    });
    await this.closing;
  }
  async reviewReboot() {
    if (!available() || this.snapshot.reboot.consumed || this.snapshot.reboot.state === 'reviewing') return;
    const generation = ++this.rebootGeneration;
    this.reboot({ state: 'reviewing', review: undefined, message: 'Reading the server boot ID for this review…' });
    try {
      const review = await call<Review>('server_reboot_review', { environmentId: this.environmentId });
      if (generation !== this.rebootGeneration || this.disposed) return;
      if (this.snapshot.target && !sameTarget(this.snapshot.target, review.target))
        throw new Error('The reviewed SSH target no longer matches this terminal. Disconnect and check Server setup.');
      this.reboot({ state: 'review', review, message: '' });
    } catch (error) {
      if (generation === this.rebootGeneration) this.reboot({ state: 'error', message: message(error) });
    }
  }
  async reviewAnotherReboot() {
    if (!available() || this.disposed || this.snapshot.reboot.state !== 'returned') return;
    clearTimeout(this.rebootTimer);
    this.reboot({ state: 'idle', consumed: false, review: undefined, message: '' });
    await this.reviewReboot();
  }
  cancelReview() {
    if (this.snapshot.reboot.consumed) return;
    ++this.rebootGeneration;
    this.reboot({ state: 'idle', review: undefined, message: '' });
  }
  async applyReboot(confirmation: string, password: boolean) {
    const { review, consumed, state } = this.snapshot.reboot;
    if (!available() || consumed || state !== 'review' || !review || confirmation !== review.target.host) return;
    // Consume synchronously before invoking native authorization. Even a lost/error reply
    // cannot expose another apply until a verified return and a new user-driven review.
    this.reboot({ consumed: true, state: 'applying', message: password ? 'Waiting for protected native sudo authorization…' : 'Requesting reboot without a password prompt…' });
    const deadline = Date.now() + 180_000;
    try {
      const result = await call<{ state: 'requested' | 'unknown'; message: string }>('server_reboot_apply', { reviewId: review.reviewId, confirmation, password });
      this.reboot(result);
    } catch (error) {
      this.reboot({ state: 'unknown', message: `Reboot outcome is not confirmed: ${message(error)}. No reboot will be retried.` });
    }
    if (!this.disposed) this.rebootTimer = setTimeout(() => void this.pollReboot(review.reviewId, deadline, 0), 5000);
  }
  private async pollReboot(reviewId: string, deadline: number, checks: number) {
    if (this.disposed) return;
    if (Date.now() >= deadline || checks >= 36) {
      this.reboot({ state: 'unknown', message: 'The three-minute verification window ended without a verified return. Check the server console. No reboot was resent.' }); return;
    }
    try {
      const result = await call<{ state: 'waiting' | 'returned' | 'unknown'; message: string }>('server_reboot_status', { reviewId });
      if (this.disposed) return;
      this.reboot(result);
      if (result.state !== 'waiting') return;
    } catch (error) {
      this.reboot({ state: 'unknown', message: `Boot-ID verification unavailable: ${message(error)}. Only read-only checks continue; no reboot is resent.` });
    }
    if (!this.disposed) this.rebootTimer = setTimeout(() => void this.pollReboot(reviewId, deadline, checks + 1), 5000);
  }
  private disposeEmulator() {
    this.observer?.disconnect(); this.observer = undefined;
    this.terminal?.dispose(); this.terminal = undefined; this.fit = undefined;
    this.container?.remove(); this.container = undefined;
  }
  dispose() {
    this.disposed = true; this.listeners.clear();
    void this.disconnect(); ++this.rebootGeneration;
    clearTimeout(this.rebootTimer); this.disposeEmulator();
  }
}
export function terminalFor(environmentId: EnvironmentId) {
  let controller = controllers.get(environmentId);
  if (!controller) { controller = new TerminalController(environmentId); controllers.set(environmentId, controller); }
  return controller;
}
let owners = 0;
let cleanup: ReturnType<typeof setTimeout> | undefined;
// App itself is keyed by chat owner. Defer root disposal to allow same-commit replacement
// (and StrictMode effect replay) without destroying shells when switching servers.
export function retainTerminals() {
  ++owners; clearTimeout(cleanup);
  return () => {
    if (--owners === 0) cleanup = setTimeout(disposeTerminals, 0);
  };
}
function disposeTerminals() { controllers.forEach(controller => controller.dispose()); controllers.clear(); }
window.addEventListener('pagehide', disposeTerminals);
