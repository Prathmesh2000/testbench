import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserArtifact,
  BrowserClaims,
  BrowserClientMessage,
  BrowserInput,
  BrowserServerMessage,
  ConsoleEntry,
  NetworkEntry,
} from '@tb/contracts';
import { maskText, maskValue } from '@tb/platform';
import { devices, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import type { WebSocket } from 'ws';
import { isBlockedHost } from './net-guard';

/** Logs keep the most recent entries; a long exploratory session must not grow without bound. */
const LOG_LIMIT = 5_000;
/** A dropped socket (page refresh, flaky Wi-Fi) may reconnect to the same session within this. */
const RECONNECT_GRACE_MS = 30_000;

/** Query values that look like credentials are masked before the URL is kept anywhere. */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const [k, v] of url.searchParams) url.searchParams.set(k, maskValue(k, v));
    return url.toString();
  } catch {
    return maskText(raw);
  }
}

const isWebUrl = (s: string) => /^https?:\/\//i.test(s);

/**
 * One tester's live browser: an isolated context on the shared Chromium, streamed as JPEG frames over
 * the tester's WebSocket, with their input replayed into the page. Console and network activity are
 * recorded (masked) and a Playwright trace runs throughout, so any of them can be saved as evidence.
 */
export class LiveSession {
  private ws: WebSocket | null = null;
  private lastInput = Date.now();
  private detachedAt: number | null = null;
  private closed = false;
  private readonly consoleLog: ConsoleEntry[] = [];
  private readonly networkLog: NetworkEntry[] = [];
  private readonly started = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];

  private constructor(
    readonly claims: BrowserClaims,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly touch: boolean,
    private readonly onClosed: (id: string) => void,
  ) {}

  static async open(
    browser: Browser,
    claims: BrowserClaims,
    opts: { idleMs: number; blockPrivate: boolean; onClosed(id: string): void },
  ): Promise<LiveSession> {
    const profile = devices[claims.device] ?? devices['Desktop Chrome']!;
    const context = await browser.newContext({ ...profile });
    if (opts.blockPrivate) {
      // Every request, not just navigations: redirects, popups, iframes and fetches can all reach inward.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if ((url.protocol === 'http:' || url.protocol === 'https:') && (await isBlockedHost(url.hostname)))
          return route.abort('blockedbyclient');
        return route.continue();
      });
    }
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const session = new LiveSession(claims, context, page, cdp, !!profile.hasTouch, opts.onClosed);
    session.wire(opts.idleMs);
    return session;
  }

  get viewport() {
    return this.page.viewportSize() ?? { width: 1280, height: 720 };
  }

  private send(msg: BrowserServerMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private push<T>(log: T[], entry: T) {
    log.push(entry);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }

  private wire(idleMs: number) {
    const { page, cdp } = this;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      this.send({ t: 'frame', data });
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.send({ t: 'page', url: frame.url(), title: '' });
    });
    page.on('load', () => void page.title().then((title) => this.send({ t: 'page', url: page.url(), title })).catch(() => {}));
    // A link that opens a new tab keeps the tester in one view: follow it here and close the tab.
    page.on('popup', (popup) => {
      void popup.waitForLoadState('domcontentloaded').then(async () => {
        const url = popup.url();
        await popup.close().catch(() => {});
        if (isWebUrl(url)) await page.goto(url).catch(() => {});
      });
    });
    page.on('console', (m) => {
      const text = maskText(m.text()).slice(0, 4_000);
      this.push(this.consoleLog, { at: new Date().toISOString(), type: m.type(), text });
      if (m.type() === 'error') this.send({ t: 'signal', kind: 'console_error', text });
    });
    page.on('pageerror', (err) => {
      const text = maskText(err.message).slice(0, 4_000);
      this.push(this.consoleLog, { at: new Date().toISOString(), type: 'pageerror', text });
      this.send({ t: 'signal', kind: 'console_error', text });
    });
    page.on('request', (req) => this.started.set(req.url() + req.method(), Date.now()));
    page.on('requestfinished', (req) => {
      void req.response().then((res) => {
        const key = req.url() + req.method();
        const t0 = this.started.get(key);
        this.started.delete(key);
        const status = res?.status() ?? null;
        const url = maskUrl(req.url());
        this.push(this.networkLog, {
          at: new Date().toISOString(),
          method: req.method(),
          url,
          status,
          resourceType: req.resourceType(),
          durationMs: t0 ? Date.now() - t0 : null,
          failure: null,
        });
        if (status !== null && status >= 400 && ['fetch', 'xhr', 'document'].includes(req.resourceType()))
          this.send({ t: 'signal', kind: 'request_failed', text: `${req.method()} ${url} → ${status}` });
      });
    });
    page.on('requestfailed', (req) => {
      const url = maskUrl(req.url());
      const failure = req.failure()?.errorText ?? 'failed';
      this.push(this.networkLog, {
        at: new Date().toISOString(),
        method: req.method(),
        url,
        status: null,
        resourceType: req.resourceType(),
        durationMs: null,
        failure,
      });
      if (['fetch', 'xhr', 'document'].includes(req.resourceType()))
        this.send({ t: 'signal', kind: 'request_failed', text: `${req.method()} ${url}: ${failure}` });
    });

    // Idle, detached-too-long and ticket expiry all end the session.
    this.timers.push(
      setInterval(() => {
        if (Date.now() - this.lastInput > idleMs) void this.close('Closed after 10 minutes without activity');
        else if (this.detachedAt && Date.now() - this.detachedAt > RECONNECT_GRACE_MS) void this.close('Disconnected');
      }, 15_000),
      setTimeout(() => void this.close('The session reached its maximum length'), Math.max(0, this.claims.exp * 1000 - Date.now())),
    );
  }

  /** Binds a (re)connected socket and starts streaming; the first attach also opens the start URL. */
  async attach(ws: WebSocket): Promise<void> {
    const first = !this.ws && this.detachedAt === null;
    if (this.ws && this.ws !== ws) this.ws.close(4000, 'Opened in another tab');
    this.ws = ws;
    this.detachedAt = null;
    this.lastInput = Date.now();
    ws.on('message', (raw) => void this.handle(raw.toString()));
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.detachedAt = Date.now();
      }
    });
    const { width, height } = this.viewport;
    this.send({ t: 'ready', width, height });
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height });
    if (first) await this.page.goto(this.claims.url).catch((err: Error) => this.send({ t: 'error', message: `Could not open ${this.claims.url}: ${err.message}` }));
    else this.send({ t: 'page', url: this.page.url(), title: await this.page.title().catch(() => '') });
  }

  private async handle(raw: string) {
    let msg: BrowserClientMessage;
    try {
      msg = JSON.parse(raw) as BrowserClientMessage;
    } catch {
      return;
    }
    this.lastInput = Date.now();
    try {
      if (msg.t === 'input') await this.input(msg.input);
      else if (msg.t === 'navigate') {
        if (!isWebUrl(msg.url)) return this.send({ t: 'error', message: 'Only http:// and https:// addresses can be opened.' });
        await this.page.goto(msg.url);
      } else if (msg.t === 'history') {
        if (msg.go === 'back') await this.page.goBack();
        else if (msg.go === 'forward') await this.page.goForward();
        else await this.page.reload();
      } else if (msg.t === 'capture') await this.capture(msg.id, msg.artifact);
    } catch (err) {
      this.send({ t: 'error', message: err instanceof Error ? err.message.split('\n')[0]! : 'The browser could not do that' });
    }
  }

  private pointer: { x: number; y: number } | null = null;

  private async input(i: BrowserInput) {
    const { mouse, keyboard, touchscreen } = this.page;
    if (i.kind === 'mousemove') await mouse.move(i.x, i.y);
    else if (i.kind === 'mousedown') {
      if (this.touch) this.pointer = { x: i.x, y: i.y };
      else {
        await mouse.move(i.x, i.y);
        await mouse.down({ button: i.button ?? 'left' });
      }
    } else if (i.kind === 'mouseup') {
      // Mobile profiles take taps, not mouse clicks: a press and release in place is a tap.
      if (this.touch && this.pointer) {
        await touchscreen.tap(this.pointer.x, this.pointer.y);
        this.pointer = null;
      } else if (!this.touch) {
        await mouse.move(i.x, i.y);
        await mouse.up({ button: i.button ?? 'left' });
      }
    } else if (i.kind === 'wheel') {
      await mouse.move(i.x, i.y);
      await mouse.wheel(0, i.deltaY);
    } else if (i.kind === 'keydown') await keyboard.down(i.key);
    else if (i.kind === 'keyup') await keyboard.up(i.key);
  }

  private async capture(id: string, artifact: BrowserArtifact) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (artifact === 'screenshot') {
      const png = await this.page.screenshot({ type: 'png' });
      this.send({ t: 'artifact', id, fileName: `screen-${stamp}.png`, contentType: 'image/png', data: png.toString('base64') });
    } else if (artifact === 'logs') {
      const body = JSON.stringify({ url: this.page.url(), console: this.consoleLog, network: this.networkLog }, null, 2);
      this.send({ t: 'artifact', id, fileName: `session-log-${stamp}.json`, contentType: 'application/json', data: Buffer.from(body).toString('base64') });
    } else {
      // Stopping writes the trace so far; tracing restarts at once so the rest of the session is kept.
      const dir = await mkdtemp(join(tmpdir(), 'tb-trace-'));
      const path = join(dir, 'trace.zip');
      try {
        await this.context.tracing.stop({ path });
        await this.context.tracing.start({ screenshots: true, snapshots: true });
        const zip = await readFile(path);
        this.send({ t: 'artifact', id, fileName: `trace-${stamp}.zip`, contentType: 'application/zip', data: zip.toString('base64') });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.send({ t: 'closed', reason });
    this.ws?.close(1000, reason.slice(0, 100));
    await this.context.close().catch(() => {});
    this.onClosed(this.claims.session);
  }
}
