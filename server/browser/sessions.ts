import type { BrowserContext, ElementHandle, Page } from 'playwright-camoufox';
import { mkdir } from 'node:fs/promises';
import { browserEngine, openTaskBrowser } from './engine.js';
import { join } from 'node:path';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { HumanInput } from './control-contracts.js';
import { Ledger } from '../core/ledger.js';
import { requireThat } from '../core/contracts.js';

export const BrowserAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('click'), ref: z.string() }),
  z.strictObject({ action: z.literal('fill'), ref: z.string(), text: z.string().max(20000) }),
  z.strictObject({ action: z.literal('select'), ref: z.string(), value: z.string().max(2000) }),
  z.strictObject({ action: z.literal('press'), key: z.string().min(1).max(80) }),
  z.strictObject({ action: z.literal('scroll'), x: z.number().min(-5000).max(5000).default(0), y: z.number().min(-5000).max(5000) }),
  z.strictObject({ action: z.literal('navigate'), url: z.url() }),
  z.strictObject({ action: z.literal('new_tab'), url: z.url() }),
  z.strictObject({ action: z.literal('switch_tab'), tab: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal('close_tab') }),
  z.strictObject({ action: z.literal('back') }),
]);
type Mode = 'direct' | 'human';
interface Session {
  context: BrowserContext;
  page: Page;
  observation: number;
  refs: Map<string, ElementHandle>;
  observed: boolean;
  lastUsed: number;
  capture?: { page: Page; observation: number; promise: Promise<{ bytes: Buffer; hash: string }> };
  frames: Map<string, { page: Page; observation: number; at: number; hash: string }>;
}
export interface BrowserFrameResult {
  unchanged?: boolean;
  session: Record<string, unknown> | null;
  frame?: string | null;
  frameId?: string;
  width?: number;
  height?: number;
  tabs?: { tab: number; url: string; active: boolean }[];
  capturedAt: string | null;
}
export interface BrowserSessionOptions {
  python?: string;
  maxSessions?: number;
  idleMs?: number;
  openContext?: (directory: string, python?: string, signal?: AbortSignal) => Promise<BrowserContext>;
}

export class BrowserSessions {
  private sessions = new Map<string, Session>();
  private busy = new Map<string, AbortController>();
  private closing = new Map<string, Promise<void>>();
  private settling = new Set<Promise<void>>();
  private workByTask = new Map<string, Promise<void>>();
  private held = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private observationSequence = Date.now() * 1000;
  constructor(private db: Ledger, private root: string, private options: BrowserSessionOptions = {}) {
    for (const row of db.list('browser')) if (['idle', 'running', 'starting'].includes(String(row.data.state))) {
      db.put('browser', row.id, row.revision, { ...row.data, state: 'interrupted', action: 'Server restarted; reopen the browser' });
    }
    this.timer = setInterval(() => {
      for (const [taskId, session] of this.sessions) if (!this.busy.has(taskId) && !this.held.has(taskId) && Date.now() - session.lastUsed > (options.idleMs ?? 15 * 60000)) {
        void this.stop(taskId, 'Idle session closed');
      }
    }, Math.min(30000, Math.max(10, options.idleMs ?? 30000)));
    this.timer.unref();
  }

  private publish(taskId: string, state: string, mode: Mode, action: string) {
    const previous = this.db.get('browser', taskId), session = this.sessions.get(taskId);
    this.db.put('browser', taskId, previous?.revision ?? 0, {
      taskId, state, mode, action, url: session?.page.url() ?? previous?.data.url ?? '',
      identity: 'task-profile', engine: browserEngine,
    });
  }

  private invalidate(session: Session) {
    session.observation = ++this.observationSequence;
    session.observed = false;
    for (const handle of session.refs.values()) void handle.dispose().catch(() => {});
    session.refs.clear();
    session.frames.clear();
  }

  private track(taskId: string, session: Session, page: Page) {
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(20000);
    page.on('framenavigated', frame => { if (frame === page.mainFrame() && page === session.page) this.invalidate(session); });
    page.on('close', () => { if (page === session.page) this.invalidate(session); });
    page.on('download', download => {
      void download.saveAs(join(this.root, 'workspaces', taskId, 'browser-downloads', `${Date.now()}-${download.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, '_')}`)).catch(() => {});
    });
  }

  private async get(taskId: string, signal: AbortSignal) {
    requireThat(!signal.aborted && !this.closed, 'cancelled');
    const saved = this.sessions.get(taskId);
    if (saved) { this.activePage(saved); return saved; }
    requireThat(new Set([...this.sessions.keys(), ...this.busy.keys()]).size <= (this.options.maxSessions ?? 4), 'browser_capacity');
    const directory = join(this.root, 'workspaces', taskId, 'browser-profile-camoufox');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const open = this.options.openContext ?? openTaskBrowser;
    const context = await open(directory, this.options.python, signal);
    try {
      signal.throwIfAborted();
      const session: Session = { context, page: context.pages()[0] ?? await context.newPage(), observation: 0, observed: false, refs: new Map(), frames: new Map(), lastUsed: Date.now() };
      this.sessions.set(taskId, session);
      for (const page of context.pages()) this.track(taskId, session, page);
      context.on('page', page => { this.track(taskId, session, page); session.page = page; this.invalidate(session); });
      context.on('close', () => {
        if (this.sessions.get(taskId) !== session) return;
        this.sessions.delete(taskId);
        this.busy.get(taskId)?.abort();
        this.publish(taskId, 'interrupted', 'direct', 'Browser disconnected; reopen before continuing');
      });
      signal.throwIfAborted();
      return session;
    } catch (error) { await context.close(); throw error; }
  }

  private activePage(session: Session) {
    if (session.page.isClosed()) {
      const page = session.context.pages().find(page => !page.isClosed());
      requireThat(page, 'browser_no_tabs');
      session.page = page;
      this.invalidate(session);
    }
    return session.page;
  }

  async execute<T>(taskId: string, mode: Mode, action: string, signal: AbortSignal, work: (session: Session, signal: AbortSignal) => Promise<T>): Promise<T> {
    requireThat(!this.closed && !signal.aborted, 'cancelled');
    requireThat(mode === 'human' ? this.held.has(taskId) : !this.held.has(taskId), 'browser_control_held');
    requireThat(!this.busy.has(taskId) && !this.closing.has(taskId), 'browser_busy', 'Another browser action owns this task session. Wait for it to finish.');
    let settle!: () => void;
    const completed = new Promise<void>(resolve => { settle = resolve; });
    this.settling.add(completed);
    this.workByTask.set(taskId, completed);
    const controller = new AbortController(), abort = () => { controller.abort(); void this.stop(taskId, 'Browser work interrupted'); };
    this.busy.set(taskId, controller);
    signal.addEventListener('abort', abort, { once: true });
    this.publish(taskId, 'starting', mode, action);
    try {
      const session = await this.get(taskId, controller.signal);
      this.publish(taskId, 'running', mode, action);
      const result = await work(session, controller.signal);
      controller.signal.throwIfAborted();
      session.lastUsed = Date.now();
      this.publish(taskId, 'idle', mode, 'Ready');
      return result;
    } catch (error) {
      this.publish(taskId, controller.signal.aborted ? 'interrupted' : this.sessions.has(taskId) ? 'idle' : 'closed', mode,
        mode === 'human' ? 'Input outcome uncertain; inspect the page before acting again' : error instanceof Error ? error.message.slice(0, 300) : 'Browser action failed');
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.busy.delete(taskId);
      this.settling.delete(completed); this.workByTask.delete(taskId); settle();
    }
  }

  async observe(session: Session) {
    const page = this.activePage(session);
    this.invalidate(session);
    const observation = session.observation;
    const elements: { ref: string; tag: string; role: string; label: string; text: string; type: string }[] = [];
    const handles = await page.locator('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]').elementHandles();
    for (const handle of handles) {
      if (elements.length >= 150 || !await handle.isVisible()) { await handle.dispose(); continue; }
      const ref = String(elements.length + 1);
      const details = await handle.evaluate(element => {
        if (!(element instanceof Element)) throw new Error('Browser element detached');
        return {
        tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? '',
        label: element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? '',
        text: (element.textContent ?? '').trim().slice(0, 180), type: element.getAttribute('type') ?? '',
        };
      });
      session.refs.set(ref, handle); elements.push({ ref, ...details });
    }
    const title = await page.title(), body = (await page.locator('body').innerText()).slice(0, 16000);
    requireThat(observation === session.observation, 'stale_observation', 'The page changed while observing. Observe again.');
    session.observed = true;
    return { observation, title, url: page.url(), text: body, elements,
      tabs: session.context.pages().map((tab, index) => ({ tab: index, url: tab.url(), active: tab === page })) };
  }

  async open(taskId: string, url: string, signal: AbortSignal) {
    this.webUrl(url);
    return this.execute(taskId, 'direct', 'Open page', signal, async session => {
      await this.activePage(session).goto(url, { waitUntil: 'domcontentloaded' });
      return this.observe(session);
    });
  }

  private webUrl(url: string) { requireThat(['https:', 'http:'].includes(new URL(url).protocol), 'browser_web_url_required'); }

  async act(session: Session, observation: number, input: z.infer<typeof BrowserAction>) {
    const page = this.activePage(session);
    requireThat(session.observed && session.observation === observation, 'stale_observation', 'Observe the page again before acting.');
    const handle = 'ref' in input ? session.refs.get(input.ref) : undefined;
    if ('ref' in input) requireThat(handle, 'unknown_browser_ref');
    // Retain the chosen handle until the action settles; dispose all others.
    if ('ref' in input) session.refs.delete(input.ref);
    this.invalidate(session);
    try {
      switch (input.action) {
        case 'click': await handle!.click(); break;
        case 'fill': await handle!.fill(input.text); break;
        case 'select': await handle!.selectOption(input.value); break;
        case 'press': await page.keyboard.press(input.key); break;
        case 'scroll': await page.mouse.wheel(input.x, input.y); break;
        case 'navigate': this.webUrl(input.url); await page.goto(input.url, { waitUntil: 'domcontentloaded' }); break;
        case 'new_tab': this.webUrl(input.url); session.page = await session.context.newPage(); await session.page.bringToFront(); await session.page.goto(input.url, { waitUntil: 'domcontentloaded' }); break;
        case 'switch_tab': {
          const target = session.context.pages()[input.tab]; requireThat(target, 'browser_tab_not_found');
          session.page = target; await target.bringToFront(); break;
        }
        case 'close_tab': requireThat(session.context.pages().length > 1, 'browser_last_tab'); await page.close(); await this.activePage(session).bringToFront(); break;
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
      }
    } finally { await handle?.dispose().catch(() => {}); }
    return this.observe(session);
  }

  async frame(taskId: string, lastFrameId?: string): Promise<BrowserFrameResult> {
    const record = this.db.get('browser', taskId), session = this.sessions.get(taskId);
    if (!session) return { session: record?.data ?? null, frame: null, capturedAt: null };
    const page = this.activePage(session), observation = session.observation;
    // Coalesce requests from multiple clients; never write frame bytes to the ledger.
    if (!session.capture || session.capture.page !== page || session.capture.observation !== observation) {
      const capture = {
        page,
        observation,
        promise: page.screenshot({ type: 'jpeg', quality: 65, timeout: 4000 }).then(bytes => ({
          bytes,
          hash: createHash('sha256').update(bytes).digest('hex'),
        })),
      };
      session.capture = capture;
      void capture.promise.finally(() => { if (session.capture === capture) delete session.capture; }).catch(() => {});
    }
    const { bytes, hash } = await session.capture.promise;
    requireThat(this.sessions.get(taskId) === session && page === session.page && observation === session.observation, 'stale_browser_frame');
    const at = Date.now();
    const metadata = {
      session: { ...this.db.get('browser', taskId)?.data, url: page.url() },
      width: page.viewportSize()?.width ?? 1280,
      height: page.viewportSize()?.height ?? 800,
      tabs: session.context.pages().map((tab, index) => ({ tab: index, url: tab.url(), active: tab === page })),
      capturedAt: new Date(at).toISOString(),
    };
    if (lastFrameId) {
      const previous = session.frames.get(lastFrameId);
      if (previous && previous.page === page && previous.observation === observation && previous.hash === hash) {
        session.frames.delete(lastFrameId);
        session.frames.set(lastFrameId, { page, observation, at, hash });
        return { unchanged: true, ...metadata, frameId: lastFrameId };
      }
    }
    const frameId = randomUUID();
    session.frames.set(frameId, { page, observation, at, hash });
    while (session.frames.size > 20) session.frames.delete(session.frames.keys().next().value!);
    return { ...metadata, frame: bytes.toString('base64'), frameId };
  }

  async capture(session: Session) { return this.activePage(session).screenshot({ type: 'png', timeout: 5000 }); }

  reserve(taskId: string) {
    requireThat(!this.closed && this.sessions.has(taskId) && !this.closing.has(taskId), 'browser_not_open');
    requireThat(!this.held.has(taskId), 'browser_control_held');
    this.held.add(taskId);
  }

  isHeld(taskId: string) { return this.held.has(taskId); }
  isOpen(taskId: string) { return this.sessions.has(taskId); }
  settled(taskId: string) { return this.workByTask.get(taskId) ?? Promise.resolve(); }
  refreshObservation(taskId: string) {
    const session = this.sessions.get(taskId);
    if (session) { this.invalidate(session); session.lastUsed = Date.now(); }
  }
  release(taskId: string) {
    this.held.delete(taskId);
    this.refreshObservation(taskId);
  }

  async humanInput(taskId: string, frameId: string, input: z.infer<typeof HumanInput>) {
    return this.execute(taskId, 'human', 'Owner browser input', new AbortController().signal, async session => {
      const frame = session.frames.get(frameId), page = this.activePage(session);
      requireThat(frame && frame.page === page && frame.observation === session.observation && Date.now() - frame.at < 5000,
        'stale_browser_frame', 'Refresh the browser view before acting.');
      this.invalidate(session);
      switch (input.action) {
        case 'click': {
          const size = page.viewportSize();
          requireThat(size && input.x < size.width && input.y < size.height, 'invalid_browser_coordinates');
          await page.mouse.click(input.x, input.y); break;
        }
        case 'text': await page.keyboard.insertText(input.text); break;
        case 'key': await page.keyboard.press(input.key); break;
        case 'scroll': await page.mouse.wheel(input.x, input.y); break;
        case 'navigate': this.webUrl(input.url); await page.goto(input.url, { waitUntil: 'domcontentloaded' }); break;
        case 'switch_tab': {
          const target = session.context.pages()[input.tab]; requireThat(target, 'browser_tab_not_found');
          session.page = target; await target.bringToFront(); break;
        }
      }
      return { applied: true };
    });
  }

  async stop(taskId: string, reason = 'Session closed') {
    this.release(taskId);
    const closing = this.closing.get(taskId);
    if (closing) return closing;
    this.busy.get(taskId)?.abort();
    const session = this.sessions.get(taskId);
    this.sessions.delete(taskId);
    if (this.db.get('browser', taskId)) this.publish(taskId, 'closed', 'direct', reason);
    if (session) {
      const closed = session.context.close().catch(() => {}).finally(() => { this.closing.delete(taskId); });
      this.closing.set(taskId, closed);
      await closed;
    }
  }

  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.busy.values()) controller.abort();
    await Promise.all([...this.sessions.keys()].map(taskId => this.stop(taskId, 'Server stopped')));
    await Promise.all([...this.closing.values(), ...this.settling]);
  }
}
