import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { Ledger } from '../core/ledger.js';
import { id, requireThat } from '../core/contracts.js';
interface Lease { holder: string; expiresAt: number; observation: number; needsObservation: boolean }
export class BrowserLeases {
  constructor(private db: Ledger) {}
  create(sessionId: string) { return this.db.put<Lease>('browser_lease',sessionId,0,{ holder: 'agent',expiresAt: Date.now()+60000,observation: 0,needsObservation: true }); }
  take(sessionId: string, expected: number, deviceId: string) {
    const lease = this.db.need<Lease>('browser_lease',sessionId);
    requireThat(lease.data.holder === 'agent' || lease.data.expiresAt < Date.now(),'browser_busy');
    return this.db.put('browser_lease',sessionId,expected,{ ...lease.data,holder: deviceId,expiresAt: Date.now()+60000,needsObservation: true });
  }
  check(sessionId: string, holder: string, observation?: number) {
    const lease = this.db.need<Lease>('browser_lease',sessionId);
    requireThat(lease.data.holder === holder && lease.data.expiresAt > Date.now(),'invalid_browser_lease');
    if (observation !== undefined) requireThat(!lease.data.needsObservation && lease.data.observation === observation,'stale_observation');
    return lease;
  }
  observe(sessionId: string, holder: string) {
    const lease = this.check(sessionId,holder);
    return this.db.put('browser_lease',sessionId,lease.revision,{ ...lease.data,observation: lease.data.observation+1,needsObservation: false,expiresAt: Date.now()+60000 });
  }
  release(sessionId: string, holder: string) {
    const lease = this.check(sessionId,holder);
    return this.db.put('browser_lease',sessionId,lease.revision,{ ...lease.data,holder: 'agent',expiresAt: Date.now()+60000,needsObservation: true });
  }
  invalidate(sessionId: string, holder: string) {
    const lease = this.check(sessionId,holder);
    this.db.put('browser_lease',sessionId,lease.revision,{ ...lease.data,needsObservation: true });
  }
}
export class HeadlessBrowser {
  private browser: Browser | undefined;
  private sessions = new Map<string,{ context: BrowserContext; page: Page }>();
  readonly leases: BrowserLeases;
  constructor(private db: Ledger, private origins: Set<string>) { this.leases = new BrowserLeases(db); }
  async open(taskId: string, url: string) {
    requireThat(this.origins.has(new URL(url).origin),'origin_not_enrolled');
    this.browser ??= await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ acceptDownloads: false,serviceWorkers: 'block' });
    await context.route('**/*',async route => {
      if (this.origins.has(new URL(route.request().url()).origin)) await route.continue(); else await route.abort('blockedbyclient');
    });
    const page = await context.newPage(), sessionId = id();
    try { await page.goto(url,{ waitUntil: 'domcontentloaded',timeout: 15000 }); }
    catch (error) { await context.close(); throw error; }
    this.sessions.set(sessionId,{ context,page });
    this.db.transaction(() => { this.leases.create(sessionId); this.db.put('browser',sessionId,0,{ taskId,url,identity: 'agent-local',state: 'open' }); });
    return { sessionId,...await this.observe(sessionId,'agent') };
  }
  private page(sessionId: string) { const session = this.sessions.get(sessionId); requireThat(session,'browser_interrupted'); return session.page; }
  async observe(sessionId: string, holder: string) {
    this.leases.check(sessionId,holder); const page = this.page(sessionId);
    const text = (await page.locator('body').innerText()).slice(0,16000), title = await page.title(), url = page.url();
    const lease = this.leases.observe(sessionId,holder); return { title,url,text,observation: lease.data.observation };
  }
  async click(sessionId: string, holder: string, observation: number, selector: string) {
    this.leases.check(sessionId,holder,observation);
    this.leases.invalidate(sessionId,holder);
    await this.page(sessionId).locator(selector).click({ timeout: 5000 }); return this.observe(sessionId,holder);
  }
  async capture(sessionId: string, holder: string) { this.leases.check(sessionId,holder); return this.page(sessionId).screenshot({ type: 'png' }); }
  async close() { await this.browser?.close(); this.browser = undefined; this.sessions.clear(); }
}
