import { randomUUID } from 'node:crypto';
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
  PageContext,
  RecordedStep,
  RequestDetail,
} from '@tb/contracts';
import { FormField, ObservedItem, PickedElement, PickedLocator, RecordedAction } from '@tb/contracts';
import { BROWSER_LOCALE, BROWSER_TIMEZONE, desktopUserAgent, maskText, maskValue } from '@tb/platform';
import { devices, type Browser, type BrowserContext, type CDPSession, type Frame, type Page, type Request } from 'playwright';
import type { WebSocket } from 'ws';
import { requestDetail, storageSnapshot } from './inspect';
import { apiPath, isApi, pageContext, storageOf } from './site-context';
import { runStep, snapshot, StepBlocked } from './step-runner';
import { blockedBy, blockedMessage, challengeMessage, challengePage, isChallengeFrame } from './bot-block';
import { LIVE_PICKER_SOURCE, PICK_BINDING } from './live-picker';
import { isBlockedHost } from './net-guard';
import { elementAt, highlight, scanPage } from './ui';
import { UI_PERF_INIT } from './ui-scan';

/** Logs keep the most recent entries; a long exploratory session must not grow without bound. */
const LOG_LIMIT = 5_000;
/** A dropped socket (page refresh, flaky Wi-Fi) may reconnect to the same session within this. */
const RECONNECT_GRACE_MS = 30_000;
/** Requests whose details the pane can still ask for; older ones stay in the evidence log only. */
const INSPECTABLE = 1_000;
/** WebSocket frames kept per connection, each cut to 4 KB. */
const WS_FRAMES = 200;
/** Tabs one session may hold; a page that opens windows in a loop must not exhaust the server. */
const MAX_TABS = 10;

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

/** Observed items from the page, each checked on its own: the page is not trusted, one bad item costs only itself. */
function observedItems(raw: unknown, max: number): ObservedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).flatMap((item: { element?: unknown } | null) => {
    if (item && typeof item === 'object') item.element = keepValidLocators(item.element ?? null);
    const parsed = ObservedItem.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Drops the locators that do not fit the contract, so one oversized name costs a locator, not the step. */
function keepValidLocators(raw: unknown): unknown {
  const el = raw as { locators?: unknown[] } | null;
  if (el && Array.isArray(el.locators)) el.locators = el.locators.filter((l) => PickedLocator.safeParse(l).success);
  return el;
}

type Tracked =
  | { kind: 'http'; req: Request }
  | { kind: 'ws'; url: string; messages: RequestDetail['messages'] };

/** A WebSocket as the Network tab shows it: no headers or body, its frames instead. */
function wsDetail(item: Extract<Tracked, { kind: 'ws' }>, reveal: boolean): RequestDetail {
  return {
    url: reveal ? item.url : maskUrl(item.url),
    method: 'GET',
    status: 101,
    statusText: 'Switching Protocols',
    resourceType: 'websocket',
    remoteAddress: null,
    requestHeaders: [],
    responseHeaders: [],
    postData: null,
    body: null,
    bodyNote: null,
    contentType: null,
    timing: null,
    messages: item.messages.map((m) => (reveal ? m : { ...m, data: maskText(m.data) })),
    masked: !reveal,
  };
}

interface Tab {
  id: string;
  page: Page;
  cdp: CDPSession;
}

type Modes = { picking: boolean; recording: boolean; storing: boolean };

/**
 * One tester's live browser: an isolated context on the shared Chromium, streamed as JPEG frames over
 * the tester's WebSocket, with their input replayed into the page. Every tab the site opens is kept
 * (up to MAX_TABS); the active one is streamed and receives input. Console and network activity are
 * recorded (masked) and a Playwright trace runs throughout, so any of them can be saved as evidence.
 */
export class LiveSession {
  private ws: WebSocket | null = null;
  private lastInput = Date.now();
  private detachedAt: number | null = null;
  private closed = false;
  private picking = false;
  private recording = false;
  private storing = false;
  /** Set while the pane is in its large view; null means the device profile's own size. */
  private viewportOverride: { width: number; height: number } | null = null;
  private toldCaptcha = false;
  private readonly tabs = new Map<string, Tab>();
  private readonly tabOf = new Map<Page, Promise<Tab>>();
  private activeId = '';
  // Messages run one at a time, in order: "click B, then type" must not type into A.
  private queue: Promise<void> = Promise.resolve();
  private readonly consoleLog: ConsoleEntry[] = [];
  private readonly networkLog: NetworkEntry[] = [];
  // The site map's APIs per tab since its last navigation, and those of a run while one is going.
  private readonly pageApis = new Map<string, PageContext['apis']>();
  private runApis: PageContext['apis'] | null = null;
  private readonly contextTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // By request, not URL: the same endpoint called twice at once must not share a start time.
  private readonly started = new WeakMap<Request, number>();
  private readonly requestIds = new WeakMap<Request, string>();
  private readonly inspectable = new Map<string, Tracked>();
  private readonly timers: NodeJS.Timeout[] = [];

  private constructor(
    readonly claims: BrowserClaims,
    private readonly context: BrowserContext,
    private readonly touch: boolean,
    private readonly onClosed: (id: string) => void,
  ) {}

  static async open(
    browser: Browser,
    claims: BrowserClaims,
    opts: { idleMs: number; blockPrivate: boolean; onClosed(id: string): void },
  ): Promise<LiveSession> {
    const profile = devices[claims.device] ?? devices['Desktop Chrome']!;
    const context = await browser.newContext({
      ...profile,
      // Desktop profiles claim Windows; the browser runs on Linux, and a mismatch is a bot signal.
      ...(profile.isMobile ? {} : { userAgent: desktopUserAgent(profile.userAgent) }),
      locale: BROWSER_LOCALE,
      timezoneId: BROWSER_TIMEZONE,
    });
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
    await context.addInitScript({ content: LIVE_PICKER_SOURCE });
    await context.addInitScript({ content: UI_PERF_INIT });
    const session = new LiveSession(claims, context, !!profile.hasTouch, opts.onClosed);
    await context.exposeBinding(PICK_BINDING, ({ page, frame }, kind: unknown, payload: unknown) =>
      session.fromPage(page, frame, kind, payload),
    );
    context.on('page', (page) => void session.tabFor(page));
    const first = await session.tabFor(await context.newPage());
    session.activeId = first.id;
    session.wire(opts.idleMs);
    return session;
  }

  private get active(): Tab {
    return this.tabs.get(this.activeId) ?? [...this.tabs.values()][0]!;
  }

  private get page(): Page {
    return this.active.page;
  }

  get viewport() {
    return this.page.viewportSize() ?? { width: 1280, height: 720 };
  }

  /**
   * Fits every tab to the pane, like maximising a window. Clamped to desktop sizes so a site keeps
   * the layout the device profile promises; a phone profile is never resized.
   */
  private async setViewport(size: { width: number; height: number } | null) {
    if (this.touch) return;
    const profile = (devices[this.claims.device] ?? devices['Desktop Chrome']!).viewport;
    const next = size
      ? { width: Math.round(Math.min(Math.max(size.width, 1024), 2560)), height: Math.round(Math.min(Math.max(size.height, 500), 1600)) }
      : null;
    this.viewportOverride = next;
    await Promise.all([...this.tabs.values()].map((t) => t.page.setViewportSize(next ?? profile).catch(() => {})));
    const { width, height } = this.viewport;
    await this.active.cdp.send('Page.stopScreencast').catch(() => {});
    this.send({ t: 'ready', width, height });
    await this.startScreencast(this.active);
  }

  private send(msg: BrowserServerMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private push<T>(log: T[], entry: T) {
    log.push(entry);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }

  /** Kept for evidence, and shown live in the pane's Network tab. */
  private logRequest(tab: Tab, entry: NetworkEntry) {
    this.push(this.networkLog, entry);
    this.send({ t: 'network', tab: tab.id, entry });
  }

  /** Remembers a request (or socket) so its details can be read later, dropping the oldest past the cap. */
  private track(id: string, item: Tracked) {
    this.inspectable.set(id, item);
    if (this.inspectable.size > INSPECTABLE) this.inspectable.delete(this.inspectable.keys().next().value!);
  }

  private idOf(req: Request): string {
    let id = this.requestIds.get(req);
    if (!id) {
      id = randomUUID();
      this.requestIds.set(req, id);
      this.track(id, { kind: 'http', req });
    }
    return id;
  }

  private recordStep(step: RecordedStep) {
    if (this.recording) this.send({ t: 'recorded', step });
  }

  /**
   * Tells the pane what the page is made of, for the site map, once it has settled: after it loads,
   * after a single-page app changes route, and again when later API calls come in.
   */
  private reportContext(tab: Tab) {
    clearTimeout(this.contextTimers.get(tab.id));
    this.contextTimers.set(
      tab.id,
      setTimeout(() => {
        this.contextTimers.delete(tab.id);
        if (!this.tabs.has(tab.id)) return;
        void pageContext(tab.page, this.pageApis.get(tab.id) ?? []).then((context) => {
          if (context) this.send({ t: 'page_context', context: { ...context, url: maskUrl(context.url) } });
        });
      }, 2_500),
    );
  }

  /** An API call the page made: kept for the site map, the recording and a run going on. */
  private noteApi(tab: Tab, req: Request, status: number | null) {
    if (!isApi(req.resourceType())) return;
    const call = { method: req.method(), path: apiPath(req.url()), status };
    const list = this.pageApis.get(tab.id) ?? [];
    if (!list.some((c) => c.method === call.method && c.path === call.path && c.status === call.status)) list.push(call);
    this.pageApis.set(tab.id, list.slice(-80));
    this.runApis?.push(call);
    if (this.recording) {
      const u = new URL(req.url());
      this.recordStep({ action: 'api', tab: tab.id, method: call.method, url: maskUrl(`${u.origin}${u.pathname}`).slice(0, 2_000), status });
    }
    this.reportContext(tab);
  }

  /** The tab for a page, created once however many events ask for it at the same time. */
  private tabFor(page: Page): Promise<Tab> {
    let tab = this.tabOf.get(page);
    if (!tab) {
      tab = this.addTab(page);
      this.tabOf.set(page, tab);
    }
    return tab;
  }

  private async addTab(page: Page): Promise<Tab> {
    const tab: Tab = { id: randomUUID(), page, cdp: await this.context.newCDPSession(page) };
    // A tab opened while the pane is in its large view opens at that size too.
    if (this.viewportOverride) await page.setViewportSize(this.viewportOverride).catch(() => {});
    this.tabs.set(tab.id, tab);
    this.wirePage(tab);
    if (this.tabs.size > MAX_TABS) {
      void page.close().catch(() => {});
      this.send({ t: 'error', message: `The site tried to open more than ${MAX_TABS} tabs; the newest was closed.` });
      return tab;
    }
    const opener = await page.opener();
    if (opener) {
      // Like Chrome: a tab the site opens comes to the front.
      const from = await this.tabFor(opener);
      this.recordStep({ action: 'popup', tab: tab.id, opener: from.id });
      await this.switchTo(tab.id);
    }
    return tab;
  }

  private tabList() {
    return [...this.tabs.values()].map((t) => ({ id: t.id, url: t.page.url(), title: '' }));
  }

  private async sendTabs() {
    const tabs = await Promise.all(
      [...this.tabs.values()].map(async (t) => ({ id: t.id, url: t.page.url(), title: await t.page.title().catch(() => '') })),
    );
    this.send({ t: 'tabs', tabs, active: this.activeId });
  }

  private async startScreencast(tab: Tab) {
    const { width, height } = this.viewport;
    await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height });
  }

  /** Records the fill still being typed in a tab, while the tab is still there to report it. */
  private async flushTab(tab: Tab) {
    if (!this.recording) return;
    await Promise.all(
      tab.page.frames().map((f) => f.evaluate(() => (globalThis as { __tbFlush?: () => void }).__tbFlush?.()).catch(() => {})),
    );
  }

  private async switchTo(id: string) {
    const next = this.tabs.get(id);
    if (!next) return;
    const prev = this.tabs.get(this.activeId);
    if (prev && prev !== next) await this.flushTab(prev);
    if (prev && prev !== next) await prev.cdp.send('Page.stopScreencast').catch(() => {});
    this.activeId = id;
    await next.page.bringToFront().catch(() => {});
    if (this.ws) await this.startScreencast(next).catch(() => {});
    this.send({ t: 'page', url: next.page.url(), title: await next.page.title().catch(() => '') });
    await this.sendTabs();
  }

  private wirePage(tab: Tab) {
    const { page, cdp } = tab;
    const isActive = () => tab.id === this.activeId;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      if (isActive()) this.send({ t: 'frame', data });
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (isActive()) this.send({ t: 'page', url: frame.url(), title: '' });
      const challenge = challengePage(frame.url());
      if (challenge) this.send({ t: 'signal', kind: 'blocked', text: challengeMessage(challenge) });
      if (isWebUrl(frame.url())) this.recordStep({ action: 'navigated', tab: tab.id, url: frame.url() });
      this.pageApis.set(tab.id, []);
      if (isWebUrl(frame.url())) this.reportContext(tab);
      void this.sendTabs();
    });
    page.on('load', () => {
      if (isWebUrl(page.url())) this.reportContext(tab);
      if (isActive()) void page.title().then((title) => this.send({ t: 'page', url: page.url(), title })).catch(() => {});
      void this.sendTabs();
    });
    page.on('close', () => void this.removeTab(tab));
    page.on('response', (res) => {
      if (!res.request().isNavigationRequest() || res.frame() !== page.mainFrame()) return;
      const by = blockedBy({ status: res.status(), headers: res.headers() });
      if (by) this.send({ t: 'signal', kind: 'blocked', text: blockedMessage(by) });
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
    page.on('request', (req) => {
      this.started.set(req, Date.now());
      this.idOf(req);
    });
    page.on('websocket', (sock) => {
      const id = randomUUID();
      const item: Tracked = { kind: 'ws', url: sock.url(), messages: [] };
      this.track(id, item);
      const opened = new Date().toISOString();
      const frame = (dir: 'sent' | 'received') => ({ payload }: { payload: string | Buffer }) => {
        const data = typeof payload === 'string' ? payload.slice(0, 4_000) : `(binary, ${payload.length} bytes)`;
        item.messages.push({ dir, at: new Date().toISOString(), data });
        if (item.messages.length > WS_FRAMES) item.messages.shift();
      };
      sock.on('framesent', frame('sent'));
      sock.on('framereceived', frame('received'));
      this.logRequest(tab, {
        id, at: opened, startedAt: opened, method: 'GET', url: maskUrl(sock.url()), status: 101,
        resourceType: 'websocket', durationMs: null, failure: null,
      });
    });
    page.on('requestfinished', (req) => {
      void req.response().then((res) => {
        const t0 = this.started.get(req);
        const status = res?.status() ?? null;
        const url = maskUrl(req.url());
        this.noteApi(tab, req, status);
        this.logRequest(tab, {
          id: this.idOf(req),
          at: new Date().toISOString(),
          startedAt: t0 ? new Date(t0).toISOString() : null,
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
      const t0 = this.started.get(req);
      this.logRequest(tab, {
        id: this.idOf(req),
        at: new Date().toISOString(),
        startedAt: t0 ? new Date(t0).toISOString() : null,
        method: req.method(),
        url,
        status: null,
        resourceType: req.resourceType(),
        durationMs: t0 ? Date.now() - t0 : null,
        failure,
      });
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        const by = blockedBy({ failure });
        if (by) return this.send({ t: 'signal', kind: 'blocked', text: blockedMessage(by) });
      }
      if (['fetch', 'xhr', 'document'].includes(req.resourceType()))
        this.send({ t: 'signal', kind: 'request_failed', text: `${req.method()} ${url}: ${failure}` });
    });
  }

  private async removeTab(tab: Tab) {
    if (!this.tabs.delete(tab.id) || this.closed) return;
    this.recordStep({ action: 'close', tab: tab.id });
    if (!this.tabs.size) {
      // The site closed its last window: keep the session usable with a blank tab.
      const blank = await this.tabFor(await this.context.newPage());
      await this.switchTo(blank.id);
    } else if (this.activeId === tab.id) {
      const opener = await tab.page.opener().catch(() => null);
      const back = (opener && this.tabOf.get(opener) && (await this.tabOf.get(opener))) || [...this.tabs.values()].pop()!;
      await this.switchTo(back.id);
    } else await this.sendTabs();
  }

  private wire(idleMs: number) {
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
    ws.on('message', (raw) => this.enqueue(raw.toString()));
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.detachedAt = Date.now();
      }
    });
    const { width, height } = this.viewport;
    this.send({ t: 'ready', width, height });
    await this.active.cdp.send('Page.stopScreencast').catch(() => {});
    await this.startScreencast(this.active);
    await this.sendTabs();
    if (first) await this.page.goto(this.claims.url).catch((err: Error) => this.openFailed(this.claims.url, err));
    else this.send({ t: 'page', url: this.page.url(), title: await this.page.title().catch(() => '') });
  }

  private openFailed(url: string, err: Error) {
    const by = blockedBy({ failure: err.message });
    this.send({ t: 'error', message: by ? blockedMessage(by) : `Could not open ${url}: ${err.message.split('\n')[0]}` });
  }

  /**
   * Runs messages one at a time, in order, except that mouse movement is coalesced: only the latest
   * position matters, and replaying every move of a 60 Hz pointer on a heavy page puts the tester's
   * click seconds behind them. A move waiting in the queue just takes the newest position; anything
   * else (a click, a key) closes it, so a move never jumps ahead of the input that followed it.
   */
  private enqueue(raw: string) {
    let msg: BrowserClientMessage;
    try {
      msg = JSON.parse(raw) as BrowserClientMessage;
    } catch {
      return;
    }
    this.lastInput = Date.now();
    if (msg.t === 'input' && msg.input.kind === 'mousemove') {
      if (this.moveSlot) {
        this.moveSlot.input = msg.input;
        return;
      }
      const slot: { input: BrowserInput } = { input: msg.input };
      this.moveSlot = slot;
      this.queue = this.queue.then(() => {
        if (this.moveSlot === slot) this.moveSlot = null;
        return this.handle({ t: 'input', input: slot.input });
      });
      return;
    }
    if (msg.t === 'input' && msg.input.kind === 'wheel') {
      // Trackpads fire wheel events as fast as moves; waiting ones add up instead of queueing.
      if (this.wheelSlot) {
        this.wheelSlot.deltaY += msg.input.deltaY;
        return;
      }
      const slot = { ...msg.input };
      this.wheelSlot = slot;
      this.queue = this.queue.then(() => {
        if (this.wheelSlot === slot) this.wheelSlot = null;
        return this.handle({ t: 'input', input: slot });
      });
      return;
    }
    if (msg.t === 'ui_at') {
      // Sent on every pointer move while the UI review inspects; only where the pointer is now matters.
      if (this.atSlot) {
        this.atSlot.x = msg.x;
        this.atSlot.y = msg.y;
        return;
      }
      const slot = { ...msg };
      this.atSlot = slot;
      this.queue = this.queue.then(() => {
        if (this.atSlot === slot) this.atSlot = null;
        return this.handle(slot);
      });
      return;
    }
    this.moveSlot = null;
    this.wheelSlot = null;
    this.atSlot = null;
    this.queue = this.queue.then(() => this.handle(msg));
  }

  private atSlot: Extract<BrowserClientMessage, { t: 'ui_at' }> | null = null;

  private wheelSlot: Extract<BrowserInput, { kind: 'wheel' }> | null = null;

  private moveSlot: { input: BrowserInput } | null = null;

  private async handle(msg: BrowserClientMessage) {
    try {
      if (msg.t === 'input') await this.input(msg.input);
      else if (msg.t === 'navigate') {
        if (!isWebUrl(msg.url)) return this.send({ t: 'error', message: 'Only http:// and https:// addresses can be opened.' });
        this.recordStep({ action: 'open', tab: this.activeId, url: msg.url });
        // Not awaited: a slow page must not hold up the queue, or Stop and every click would wait for it.
        void this.page.goto(msg.url).catch((err: Error) => this.openFailed(msg.url, err));
      } else if (msg.t === 'history') {
        this.recordStep({ action: 'history', tab: this.activeId, go: msg.go });
        const page = this.page;
        const go = msg.go === 'back' ? page.goBack() : msg.go === 'forward' ? page.goForward() : page.reload();
        void go.catch(() => {});
      } else if (msg.t === 'capture') await this.capture(msg.id, msg.artifact);
      else if (msg.t === 'pick') {
        this.picking = !!msg.on;
        await this.applyModes();
      } else if (msg.t === 'record') await this.setRecording(!!msg.on);
      else if (msg.t === 'store') {
        this.storing = this.recording;
        await this.applyModes();
      } else if (msg.t === 'request_detail') {
        const item = this.inspectable.get(msg.id);
        const detail = !item
          ? null
          : item.kind === 'http'
            ? await requestDetail(item.req, msg.reveal)
            : wsDetail(item, msg.reveal);
        this.send({ t: 'request_detail', id: msg.id, detail });
      } else if (msg.t === 'run_steps') {
        // Not awaited: a run takes seconds, and the tester can still watch, stop or look meanwhile.
        void this.runSteps(msg);
      } else if (msg.t === 'viewport') {
        await this.setViewport(msg.size);
      } else if (msg.t === 'ui_scan') {
        const scan = await scanPage(this.page, maskUrl).catch(() => null);
        this.send({ t: 'ui_scan', id: msg.id, scan, error: scan ? null : 'This page could not be read. Wait for it to finish loading, then scan again.' });
      } else if (msg.t === 'ui_at') {
        this.send({ t: 'ui_at', node: await elementAt(this.page, Math.round(msg.x), Math.round(msg.y)).catch(() => null) });
      } else if (msg.t === 'ui_highlight') {
        await highlight(this.page, typeof msg.node === 'number' ? msg.node : null, !!msg.scroll).catch(() => {});
      } else if (msg.t === 'storage') {
        this.send({ t: 'storage', snapshot: await storageSnapshot(this.context, this.page, msg.reveal) });
      } else if (msg.t === 'tab') {
        if (msg.action === 'new') {
          const tab = await this.tabFor(await this.context.newPage());
          this.recordStep({ action: 'newtab', tab: tab.id });
          await this.switchTo(tab.id);
        } else if (msg.action === 'switch') await this.switchTo(msg.id);
        else if (this.tabs.size > 1) {
          const tab = this.tabs.get(msg.id);
          // The page's own pagehide flush cannot reach us once it is closing.
          if (tab) await this.flushTab(tab);
          await tab?.page.close();
        }
      }
    } catch (err) {
      this.send({ t: 'error', message: err instanceof Error ? err.message.split('\n')[0]! : 'The browser could not do that' });
    }
  }

  private running = false;

  /** Saved steps, one at a time in the active tab, reporting each and a snapshot at the end. */
  private async runSteps(msg: Extract<BrowserClientMessage, { t: 'run_steps' }>) {
    if (this.running) return this.send({ t: 'run_done', id: msg.id, ok: false, failedAt: null, error: 'Another run is still going.', blocked: null, snapshot: null });
    this.running = true;
    const page = this.page;
    const vars: Record<string, string> = {};
    const values = { data: msg.data, secrets: msg.secrets, baseUrl: msg.baseUrl };
    this.runApis = [];
    if (msg.fresh) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    let failedAt: number | null = null;
    let error: string | null = null;
    let blocked: 'disabled' | 'missing' | null = null;
    try {
      for (const [index, step] of msg.steps.slice(0, 300).entries()) {
        this.lastInput = Date.now();
        try {
          await runStep(page, step, values, vars);
          this.send({ t: 'run_step', id: msg.id, index, ok: true, error: null });
        } catch (err) {
          failedAt = index;
          blocked = err instanceof StepBlocked ? err.kind : null;
          error = maskText(err instanceof Error ? err.message.split('\n')[0]! : 'The step could not be done');
          this.send({ t: 'run_step', id: msg.id, index, ok: false, error });
          break;
        }
      }
      const shot = await snapshot(page).catch(() => null);
      const storage = shot ? await storageOf(this.context, page) : [];
      const apis = this.runApis.slice(0, 60);
      this.send({ t: 'run_done', id: msg.id, ok: failedAt === null, failedAt, error, blocked, apis, snapshot: shot && { ...shot, url: maskUrl(shot.url), storage } });
      this.reportContext(this.active);
    } finally {
      this.running = false;
      this.runApis = null;
    }
  }

  /**
   * Starting records where the tester is; stopping flushes the field still being typed into while
   * recording is on, so that last fill is kept. CDP delivers its binding call before the evaluate
   * returns, so it is sent before the ack.
   */
  private async setRecording(on: boolean) {
    const starting = !this.recording && on;
    const stopping = this.recording && !on;
    if (stopping) {
      await this.everyFrame(() => (globalThis as { __tbFlush?: () => void }).__tbFlush?.());
      // Where the tester ended up: the goal is checked against it.
      const raw = (await this.page
        .evaluate(() => (globalThis as { __tbFacts?: () => unknown }).__tbFacts?.())
        .catch(() => null)) as { url?: unknown; title?: unknown; items?: unknown } | null;
      if (raw && typeof raw.url === 'string')
        this.recordStep({
          action: 'facts',
          tab: this.activeId,
          url: raw.url.slice(0, 4_000),
          title: String(raw.title ?? '').slice(0, 300),
          items: observedItems(raw.items, 20),
        });
    }
    this.recording = on;
    this.storing = false;
    this.toldCaptcha = false;
    if (starting) this.recordStep({ action: 'open', tab: this.activeId, url: this.page.url() });
    await this.applyModes();
    if (stopping) this.send({ t: 'record_stopped' });
    // What the recording opened (a dialog and its fields) belongs on the site map too.
    if (stopping) this.reportContext(this.active);
  }

  private modesFor(frame: Frame): Modes {
    // Picking reports hovers by position on the streamed screen, so it runs in the top page only.
    return { picking: this.picking && !frame.parentFrame(), recording: this.recording, storing: this.storing };
  }

  private async everyFrame(fn: (modes: Modes) => void) {
    await Promise.all(
      [...this.tabs.values()].flatMap((t) =>
        t.page.frames().map((f) => f.evaluate(fn, this.modesFor(f)).catch(() => {})),
      ),
    );
  }

  private applyModes() {
    return this.everyFrame((modes) => (globalThis as { __tbSetModes?: (m: Modes) => void }).__tbSetModes?.(modes));
  }

  /** The iframes around a frame, outermost first, each described by the page that contains it. */
  private async framePath(frame: Frame): Promise<PickedElement[] | null> {
    const path: PickedElement[] = [];
    for (let f = frame; f.parentFrame(); f = f.parentFrame()!) {
      const raw = await (await f.frameElement()).evaluate((el) =>
        (globalThis as { __tbDescribe?: (e: unknown) => unknown }).__tbDescribe?.(el),
      );
      const parsed = PickedElement.safeParse(keepValidLocators(raw));
      if (!parsed.success) return null;
      path.unshift(parsed.data);
    }
    return path;
  }

  /**
   * A report from the in-page picker or recorder. The binding is visible to the site's own scripts, so
   * anything arriving here is untrusted: it counts only while that mode is on, only in the shape the
   * pane expects, and the frame path is worked out here rather than taken from the page. It goes to
   * this tester's pane and nowhere else. `modes` is the page asking, as it starts, what is switched on.
   */
  async fromPage(page: Page, frame: Frame, kind: unknown, payload: unknown): Promise<Modes | undefined> {
    const tab = await this.tabFor(page);
    if (kind === 'modes') return this.modesFor(frame);
    if (kind === 'observe') {
      if (this.recording && !frame.parentFrame()) {
        const items = observedItems(payload, 8);
        if (items.length) this.recordStep({ action: 'observed', tab: tab.id, items });
      }
      return;
    }
    if (kind === 'record') {
      if (!this.recording) return;
      for (let f: Frame | null = frame; f; f = f.parentFrame()) {
        if (!isChallengeFrame(f.url())) continue;
        if (!this.toldCaptcha) this.send({ t: 'error', message: 'Steps inside the CAPTCHA are not recorded: a script cannot replay a person proving they are human.' });
        this.toldCaptcha = true;
        return;
      }
      const raw = payload as { element?: unknown } | null;
      if (raw && typeof raw === 'object') {
        raw.element = keepValidLocators(raw.element ?? null);
        // A form's fields are checked one by one: an odd field costs itself, not the submit.
        const form = (raw as { form?: unknown }).form;
        if (Array.isArray(form))
          (raw as { form?: unknown }).form = form.slice(0, 40).flatMap((f: { element?: unknown } | null) => {
            if (f && typeof f === 'object') f.element = keepValidLocators(f.element ?? null);
            const ok = FormField.safeParse(f);
            return ok.success ? [ok.data] : [];
          });
      }
      const step = RecordedAction.safeParse(payload);
      const frames = step.success ? await this.framePath(frame) : null;
      if (!step.success || !frames) {
        this.send({ t: 'error', message: 'One action could not be recorded; do it again, or add the step by hand.' });
        return;
      }
      if (step.data.action === 'store') {
        this.storing = false;
        void this.applyModes();
      }
      this.recordStep({ ...step.data, frames, tab: tab.id });
      return;
    }
    if (!this.picking || frame.parentFrame() || tab.id !== this.activeId || (kind !== 'hover' && kind !== 'picked')) return;
    const element = PickedElement.safeParse(keepValidLocators(payload));
    if (element.success) this.send({ t: kind, element: element.data });
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
    } else if (i.kind === 'text') await keyboard.type(i.text.slice(0, 1_000));
    else if (i.kind === 'keydown') await keyboard.down(i.key);
    else if (i.kind === 'keyup') await keyboard.up(i.key);
  }

  private async capture(id: string, artifact: BrowserArtifact) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (artifact === 'screenshot') {
      const png = await this.page.screenshot({ type: 'png' });
      this.send({ t: 'artifact', id, fileName: `screen-${stamp}.png`, contentType: 'image/png', data: png.toString('base64') });
    } else if (artifact === 'logs') {
      const body = JSON.stringify({ url: this.page.url(), tabs: this.tabList(), console: this.consoleLog, network: this.networkLog }, null, 2);
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
