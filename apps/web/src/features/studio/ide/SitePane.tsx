'use client';

import type { AutoStep, BrowserClientMessage, BrowserServerMessage, Locator, PageContext, PageElement, PickedElement, RecordedStep, RequestDetail, StorageSnapshot } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { toAddress } from './address';
import { ApplicationPanel } from './ApplicationPanel';
import { IntentBuilder, type CaptureKind } from './IntentBuilder';
import { LiveBrowser } from './LiveBrowser';
import { NETWORK_LIMIT, NetworkPanel, type NetworkRow } from './NetworkPanel';
import { locatorCode, scriptCode } from './record-code';
import { Splitter, useStoredFlag, useStoredSize } from './Splitter';
import s from './ide.module.css';

const LAST_SITE = 'tb.ide.siteUrl';
const SITE_MODE = 'tb.ide.siteMode';
/** Room the browser always keeps above the panel. */
const MIN_BROWSER = 160;
/** Height of the panel's tab row: what is left of the panel when it is collapsed. */
const PANEL_HEADER = 31;

type Hovered = PickedElement;
type RecordTarget = 'script' | CaptureKind;
type Mode = 'live' | 'embed';
export type RunDone = Extract<BrowserServerMessage, { t: 'run_done' }>;

/** What a guide beside the site (the Workflows screen) can do with the Test Browser. */
export interface SiteGuide {
  connected: boolean;
  /** The address the Test Browser is on now; empty before it opens one. */
  pageUrl: string;
  /** Why recording is not possible right now, in words the tester can act on; null when it is. */
  recordHint: string | null;
  /** Which capture is being recorded now, if any. */
  recording: CaptureKind | null;
  captures: Record<CaptureKind, RecordedStep[] | null>;
  /** Starts recording for `kind`, or stops the recording that is running. */
  record(kind: CaptureKind): void;
  clearCapture(kind: CaptureKind): void;
  /** Runs steps in the open Test Browser; `onStep` hears each one as it finishes. */
  run(
    steps: AutoStep[],
    data: Record<string, string>,
    secrets: Record<string, string>,
    baseUrl: string,
    onStep?: (index: number, ok: boolean) => void,
    /** Reload the page before running (see run_steps). */
    fresh?: boolean,
  ): Promise<RunDone>;
  /** Opens an address, starting the Test Browser if it is not open yet. */
  open(address: string): void;
}

/**
 * The site under test, beside the editor: hovering an element there shows its locators here, and one
 * click saves it to the page library or drops the code into the editor. Two ways to show the site:
 *
 * - Live (default): any site, in the Test Browser streamed into the pane. Nothing to change on the site.
 * - Embedded: the team's own staging page in an iframe, which must allow framing by Testbench and
 *   include the embed script. It keeps the tester's own login and cookies, which Live cannot.
 */
export function SitePane({
  onInsert,
  guide,
  siteHidden = false,
}: {
  onInsert(code: string): boolean;
  /** A guide shown beside the site instead of the Build tab, driving the Test Browser through SiteGuide. */
  guide?: (g: SiteGuide) => ReactNode;
  /** Only the guide shows; the Test Browser keeps running out of sight, so its session survives. */
  siteHidden?: boolean;
}) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(() => (typeof localStorage !== 'undefined' && localStorage.getItem(LAST_SITE)) || '');
  const [mode, setMode] = useState<Mode>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(SITE_MODE) === 'embed' ? 'embed' : 'live',
  );
  const [loaded, setLoaded] = useState('');
  const [nav, setNav] = useState(0);
  const [connected, setConnected] = useState(false);
  const [picking, setPicking] = useState(false);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [pinned, setPinned] = useState<Hovered | null>(null);
  const [chosen, setChosen] = useState(0);
  const [name, setName] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [recording, setRecording] = useState(false);
  const [storing, setStoring] = useState(false);
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  // Kept in step with `steps` synchronously: the stop ack can arrive before React re-renders.
  const recorded = useRef<RecordedStep[]>([]);
  const addStep = (step: RecordedStep) => {
    recorded.current = [...recorded.current, step];
    setSteps(recorded.current);
  };
  const [storedHeight, setPanelHeight] = useStoredSize('tb.ide.sitePanel', 220);
  const [guideWidth, setGuideWidth] = useStoredSize('tb.site.guideWidth', 440);
  // The panel never takes the browser's room: its height is clamped to what the pane can spare,
  // however tall it was dragged before (or on a taller window), and again whenever the pane resizes.
  const siteRef = useRef<HTMLDivElement>(null);
  const [siteHeight, setSiteHeight] = useState(0);
  useEffect(() => {
    const el = siteRef.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setSiteHeight(el.clientHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const panelMax = siteHeight ? Math.max(80, siteHeight - 34 - MIN_BROWSER) : 800;
  const panelHeight = Math.min(storedHeight, panelMax);
  // Collapsed down to its tab row.
  const [collapsed, storeCollapsed] = useStoredFlag('tb.ide.sitePanelCollapsed', false);
  // The height animates only when the button is pressed, never while the divider is dragged.
  const [animating, setAnimating] = useState(false);
  const setCollapsed = (on: boolean) => {
    setAnimating(true);
    storeCollapsed(on);
  };
  const openPanel = (p: typeof panel) => {
    setPanel(p);
    if (collapsed) setCollapsed(false);
  };
  const [panel, setPanel] = useState<'inspect' | 'network' | 'application' | 'build'>('inspect');
  // What a recording is for: code in the editor, or the Build panel's prerequisites or journey.
  const [recordFor, setRecordFor] = useState<RecordTarget>('script');
  const [captures, setCaptures] = useState<Record<CaptureKind, RecordedStep[] | null>>({ prereq: null, main: null });
  const bridge = useRef<((msg: BrowserClientMessage) => void) | null>(null);
  // One switch for the Network details and Application tab: masked unless the tester asks.
  const [reveal, setReveal] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [details, setDetails] = useState(new Map<string, RequestDetail | null>());
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  const [activeTab, setActiveTab] = useState('');
  // Pages the browser reached, sent to the site map once each has settled (per path, latest wins).
  const contextTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const keepContext = (context: PageContext) => {
    if (!can('run.execute')) return;
    let key = context.url;
    try {
      key = new URL(context.url).pathname;
    } catch {
      // Keyed by the whole address.
    }
    clearTimeout(contextTimers.current.get(key));
    contextTimers.current.set(
      key,
      setTimeout(() => {
        contextTimers.current.delete(key);
        void api('POST', `/projects/${project.id}/studio/site/pages`, context).catch(() => {});
      }, 1_500),
    );
  };
  // Runs started by the guide, waiting for the Test Browser to finish them.
  const runs = useRef(new Map<string, { done(m: RunDone): void; step?(index: number, ok: boolean): void }>());

  const askDetail = (id: string, on = reveal) => bridge.current?.({ t: 'request_detail', id, reveal: on });
  const readStorage = (on = reveal) => {
    if (!bridge.current) return;
    setStorageLoading(true);
    bridge.current({ t: 'storage', reveal: on });
  };
  const selectRequest = (id: string | null) => {
    setSelectedRequest(id);
    if (id && !details.has(id)) askDetail(id);
  };
  const changeReveal = (on: boolean) => {
    setReveal(on);
    // What was read masked is read again as asked, and the other way round.
    setDetails(new Map());
    if (selectedRequest) askDetail(selectedRequest, on);
    if (panel === 'application') readStorage(on);
  };
  const [network, setNetwork] = useState<NetworkRow[]>([]);
  const [tabNames, setTabNames] = useState(new Map<string, string>());
  const [expanded, setExpanded] = useState(false);
  const shown = pinned ?? hovered;

  // Storage is a snapshot: read again when the tab opens, the page changes or another tab comes forward.
  useEffect(() => {
    // Not on reveal: changing it reads again itself (changeReveal).
    if (panel === 'application' && connected) readStorage();
  }, [panel, pageUrl, activeTab, connected]);

  // Esc closes the large view, unless it is going to the page in the Test Browser.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.hasAttribute?.('data-tb-keysink')) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const tell = useCallback((on: boolean) => {
    frame.current?.contentWindow?.postMessage({ tb: 'picking', on }, '*');
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const msg = e.data as { tb?: string; payload?: unknown };
      if (msg?.tb === 'ready' || msg?.tb === 'navigated' || msg?.tb === 'state') {
        setConnected(true);
        // A single-page app that changed route needs telling again that picking is on.
        if (picking) tell(true);
      } else if (msg?.tb === 'hover' && !pinned) {
        setHovered(msg.payload as Hovered);
      } else if (msg?.tb === 'picked') {
        pin(msg.payload as Hovered);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [picking, pinned, tell]);

  const pin = (p: Hovered) => {
    setPinned(p);
    setChosen(Math.max(0, p.locators.findIndex((l) => l.matches === 1)));
    setName(p.suggestedName);
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    try {
      localStorage.setItem(SITE_MODE, next);
    } catch {
      // Private browsing: the choice just isn't remembered.
    }
    setMode(next);
    setConnected(false);
    setPicking(false);
    setRecording(false);
    setHovered(null);
    setPinned(null);
  };

  const open = (address = url) => {
    const target = toAddress(address);
    if (!target) return notify('Enter a web address, or words to search for', 'bad');
    setUrl(target);
    try {
      localStorage.setItem(LAST_SITE, target);
    } catch {
      // Private browsing: the address just isn't remembered.
    }
    // A running Test Browser just navigates; a new frame has to announce itself again.
    if (mode === 'embed') setConnected(false);
    setHovered(null);
    setPinned(null);
    setLoaded(target);
    setNav((n) => n + 1);
  };

  /** The Test Browser records the page it is on as the first step, so the script opens where the tester began. */
  const startRecording = (target: RecordTarget = 'script') => {
    setPicking(false);
    setPinned(null);
    setHovered(null);
    recorded.current = [];
    setSteps([]);
    setStoring(false);
    setRecordFor(target);
    setRecording(true);
  };

  /** Runs once browser-live confirms the last step is in (see LiveBrowser's onRecordStopped). */
  const finishRecording = () => {
    const all = recorded.current;
    if (all.length < 2) return notify('Nothing was recorded. Press Record, then use the site.');
    // Recorded for the Build panel: kept for the build, not written into the editor.
    if (recordFor !== 'script') {
      setCaptures((c) => ({ ...c, [recordFor]: all }));
      setSteps([]);
      recorded.current = [];
      return notify(recordFor === 'prereq' ? 'Prerequisites recorded' : 'Test recorded; build it when ready');
    }
    notify(
      onInsert(scriptCode(all))
        ? `${all.length} steps written into the editor at the cursor`
        : 'Recording kept below. Open a spec file, then press Insert.',
    );
  };

  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    setPinned(null);
    setHovered(null);
    tell(next);
  };

  const recordHint =
    mode !== 'live'
      ? 'Switch to Live (top left) to record.'
      : !loaded
        ? 'First open your site: type its address in the bar at the top and press Open.'
        : !connected
          ? 'Waiting for the Test Browser to start…'
          : recording && recordFor === 'script'
            ? 'Stop the recording that is running first.'
            : null;
  const record = (kind: CaptureKind) => (recording ? setRecording(false) : startRecording(kind));
  const clearCapture = (kind: CaptureKind) => setCaptures((c) => ({ ...c, [kind]: null }));

  const siteGuide: SiteGuide = {
    connected,
    pageUrl,
    recordHint,
    recording: recording && recordFor !== 'script' ? recordFor : null,
    captures,
    record,
    clearCapture,
    run: (steps, data, secrets, baseUrl, onStep, fresh) =>
      new Promise((resolve) => {
        const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        if (!bridge.current || !connected) return resolve({ t: 'run_done', id, ok: false, failedAt: null, error: 'The Test Browser is not open.', blocked: null, snapshot: null });
        runs.current.set(id, { done: resolve, step: onStep });
        bridge.current({ t: 'run_steps', id, steps, data, secrets, baseUrl, fresh });
      }),
    open: (address) => {
      if (mode !== 'live') switchMode('live');
      open(address);
    },
  };

  const save = async () => {
    if (!shown || !can('run.execute')) return;
    const c = shown.locators[chosen];
    if (!c) return;
    const locator: Locator = {
      strategy: c.strategy,
      value: c.value,
      ...(c.name ? { name: c.name } : {}),
      ...(c.within ? { within: c.within } : {}),
      ...(c.nth === undefined ? {} : { nth: c.nth }),
    };
    try {
      await api<PageElement>('PUT', `/projects/${project.id}/studio/elements`, { page: shown.page, name: name.trim(), locators: [locator] });
      await queryClient.invalidateQueries({ queryKey: ['studio-elements', project.id] });
      notify(`${shown.page} › ${name.trim()} saved to the page library`);
      setPinned(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the element', 'bad');
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => notify('Copied'), () => notify('Could not copy', 'bad'));
  };

  const embedTag = `<script src="${typeof location === 'undefined' ? '' : location.origin}/api/picker/embed"></script>`;
  const frameHeader = `Content-Security-Policy: frame-ancestors ${typeof location === 'undefined' ? '' : location.origin}`;

  return (
    <div
      className={guide ? s.guided : s.unguided}
      style={guide ? { gridTemplateColumns: siteHidden ? '0px 0px minmax(0, 1fr)' : `minmax(0, 1fr) 6px ${guideWidth}px` } : undefined}
    >
    {expanded && <div className={s.backdrop} onClick={() => setExpanded(false)} aria-hidden />}
    <div ref={siteRef} className={`${s.site} ${expanded ? s.siteExpanded : ''} ${siteHidden && !expanded ? s.siteHidden : ''}`} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? 'Site, expanded' : undefined}>
      <div className={s.siteBar}>
        <div className={s.mode} role="tablist" aria-label="How to show the site">
          <button role="tab" aria-selected={mode === 'live'} onClick={() => switchMode('live')} title="Any site, in the Test Browser">Live</button>
          <button role="tab" aria-selected={mode === 'embed'} onClick={() => switchMode('embed')} title="Your staging site in a frame, with the embed script">Embedded</button>
        </div>
        <input
          className="inp f1"
          style={{ height: 26, fontSize: 12 }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && open()}
          placeholder="Search or type a web address"
          aria-label="Site to open"
        />
        <button className="btn sm" onClick={() => open()}>Open</button>
        {loaded && (
          <button className={`btn sm ${picking ? 'primary' : ''}`} onClick={togglePicking} disabled={!connected || recording} title={connected ? undefined : mode === 'live' ? 'Waiting for the Test Browser' : 'Waiting for the embed script on the page'}>
            <Icon name="search" size={11} />{picking ? 'Picking' : 'Pick'}
          </button>
        )}
        {loaded && mode === 'live' && (
          <button
            className={`btn sm ${recording ? 'primary' : ''}`}
            onClick={recording ? () => setRecording(false) : () => startRecording('script')}
            disabled={!connected}
            title={recording ? 'Stop and write the script into the editor' : 'Record your actions on the site as a script'}
          >
            {recording ? <Icon name="pause" size={11} /> : <span className={s.recDot} aria-hidden />}
            {recording ? `Stop (${steps.length})` : 'Record'}
          </button>
        )}
        {recording && (
          <button
            className={`btn sm ${storing ? 'primary' : ''}`}
            onClick={() => setStoring((v) => !v)}
            title="Click an element in the page to keep what it shows (an order number, a generated name) as a variable the script reads at run time"
          >
            {storing ? 'Click an element…' : 'Store value'}
          </button>
        )}
        <button className="ib sm" aria-label="How to connect a site" onClick={() => setShowSetup((v) => !v)}><Icon name="info" size={12} /></button>
        <button className="ib sm" aria-label={expanded ? 'Back to the side pane' : 'Expand to a large view'} title={expanded ? 'Back to the side pane (Esc)' : 'Expand to a large view'} onClick={() => setExpanded((v) => !v)}>
          <Icon name={expanded ? 'collapse' : 'expand'} size={12} />
        </button>
      </div>

      {showSetup && (
        <div className={s.setup}>
          <b>Live</b>
          <div>Works with any site: it opens in the Test Browser on the server, so nothing on the site changes. It starts signed out; sign in inside it as you would anywhere.</div>
          <b>Embedded</b>
          <div>Your own staging site in a frame, keeping your login. Add these two lines to it (staging, not production):</div>
          <div className="row" style={{ gap: 6 }}>
            <code className="f1">{embedTag}</code>
            <button className="btn sm" onClick={() => copy(embedTag)}>Copy</button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <code className="f1">{frameHeader}</code>
            <button className="btn sm" onClick={() => copy(frameHeader)}>Copy</button>
          </div>
          <div className="t3">
            The script only answers this page and only reports what you hover.
          </div>
        </div>
      )}

      <div className={s.frameWrap}>
        {loaded && mode === 'live' ? (
          <LiveBrowser
            url={loaded}
            nav={nav}
            fill={expanded}
            picking={picking}
            recording={recording}
            onReady={(ready) => {
              setConnected(ready);
              if (!ready) {
                setRecording(false);
                setStoring(false);
                for (const [id, waiting] of runs.current) waiting.done({ t: 'run_done', id, ok: false, failedAt: null, error: 'The Test Browser disconnected.', blocked: null, snapshot: null });
                runs.current.clear();
              }
            }}
            onPage={(u) => {
              setUrl(u === 'about:blank' ? '' : u);
              setPageUrl(u);
            }}
            onHover={(el) => !pinned && setHovered(el)}
            onPicked={pin}
            storing={storing}
            onRecorded={(step) => {
              if (step.action === 'store') setStoring(false);
              addStep(step);
            }}
            onRecordStopped={finishRecording}
            onContext={keepContext}
            onRun={(m) => {
              const waiting = runs.current.get(m.id);
              if (m.t === 'run_step') return waiting?.step?.(m.index, m.ok);
              runs.current.delete(m.id);
              waiting?.done(m);
            }}
            onNetwork={(row) => setNetwork((rows) => [...rows.slice(-(NETWORK_LIMIT - 1)), row])}
            onTabs={(tabs) => setTabNames(new Map(tabs.map((t) => [t.id, t.title || t.url])))}
            onActiveTab={setActiveTab}
            onDetail={(id, d) => setDetails((m) => new Map(m).set(id, d))}
            onStorage={(snap) => {
              setStorage(snap);
              setStorageLoading(false);
            }}
            bridge={bridge}
          />
        ) : loaded ? (
          <iframe
            ref={frame}
            src={loaded}
            // The page may announce itself before this pane is listening, so ask again once it loads.
            onLoad={() => tell(picking)}
            className={s.frame}
            title="Site under test"
            // It is the team's own site, so it keeps its own session; scripts and forms must work for
            // the app to behave normally, and it cannot reach this page except by postMessage.
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className={s.empty} style={{ flexDirection: 'column', gap: 8, textAlign: 'center', padding: 20 }}>
            <span>Open your site here to pick locators while you write the test.</span>
            <button className="btn sm" onClick={() => setShowSetup(true)}>What the site needs</button>
          </div>
        )}
        {loaded && mode === 'embed' && !connected && (
          <div className={s.waiting}>
            Waiting for the embed script… if nothing happens, the site is blocking the frame or has not included it.
          </div>
        )}
      </div>

      {!collapsed && (
        <Splitter direction="rows" size={panelHeight} min={80} max={panelMax} onResize={setPanelHeight} label="Resize the panel under the site" />
      )}
      <div
        className={`${s.bottom} ${animating ? s.bottomAnim : ''} ${collapsed ? s.bottomShut : ''}`}
        style={{ height: collapsed ? PANEL_HEADER : panelHeight }}
        onTransitionEnd={() => setAnimating(false)}
      >
        <div className={s.bottomTabs} role="tablist" aria-label="Site pane panels">
          <button role="tab" aria-selected={!collapsed && panel === 'inspect'} onClick={() => openPanel('inspect')}>
            {recording || steps.length > 0 ? 'Script' : 'Inspector'}
          </button>
          <button role="tab" aria-selected={!collapsed && panel === 'network'} onClick={() => openPanel('network')}>
            Network{network.length ? ` (${network.length})` : ''}
          </button>
          <button role="tab" aria-selected={!collapsed && panel === 'application'} onClick={() => openPanel('application')}>
            Application
          </button>
          {!guide && (
            <button role="tab" aria-selected={!collapsed && panel === 'build'} onClick={() => openPanel('build')} title="Build a test from what you mean: prerequisites, intent and goal">
              Build
            </button>
          )}
          <div className="f1" />
          <button
            className={`ib sm ${s.collapse}`}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Show the panel' : 'Collapse the panel to its tabs'}
            title={collapsed ? 'Show the panel' : 'Collapse the panel'}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name={collapsed ? 'chevUp' : 'chevDown'} size={12} />
          </button>
        </div>
        {panel !== 'inspect' && mode !== 'live' ? (
          <div className="t3" style={{ padding: 10, fontSize: 12 }}>This tab reads the Test Browser; switch to Live to see it.</div>
        ) : panel === 'network' ? (
          <NetworkPanel
            rows={network}
            tabNames={tabNames}
            onClear={() => {
              setNetwork([]);
              setSelectedRequest(null);
            }}
            selected={selectedRequest}
            onSelect={selectRequest}
            detail={selectedRequest && details.has(selectedRequest) ? details.get(selectedRequest) : undefined}
            reveal={reveal}
            onReveal={changeReveal}
          />
        ) : panel === 'application' ? (
          <ApplicationPanel snapshot={storage} loading={storageLoading} onRefresh={() => readStorage()} reveal={reveal} onReveal={changeReveal} />
        ) : panel === 'build' ? (
          <IntentBuilder
            captures={captures}
            recording={siteGuide.recording}
            canRecord={connected && (!recording || recordFor !== 'script')}
            recordHint={recordHint}
            onRecord={record}
            onClearCapture={clearCapture}
          />
        ) : (
      <div className={s.inspector}>
        {(recording || steps.length > 0) && !shown ? (
          <>
            <div className="row" style={{ gap: 6 }}>
              <b className="f1">{recording ? 'Recording…' : 'Recorded script'}</b>
              {!recording && (
                <>
                  <button className="btn sm" onClick={() => onInsert(scriptCode(steps)) || notify('Open a spec file first', 'bad')}>Insert</button>
                  <button className="btn sm" onClick={() => copy(scriptCode(steps))}>Copy</button>
                  <button className="ib sm" aria-label="Discard recording" onClick={() => {
                    recorded.current = [];
                    setSteps([]);
                  }}><Icon name="x" size={11} /></button>
                </>
              )}
            </div>
            <pre className={s.recScript} aria-live="polite">{scriptCode(steps)}</pre>
            {recording && (
              <span className="t3">
                Use the site as usual, in any tab. Typed values become data you can change; <b>Store value</b> keeps
                what an element shows for later steps. Passwords are never captured.
              </span>
            )}
          </>
        ) : !shown ? (
          <span className="t3">{picking ? 'Hover an element in the page.' : 'Press Pick, then hover an element.'}</span>
        ) : (
          <>
            <div className="row" style={{ gap: 6 }}>
              <span className="pill" style={{ height: 20 }}>{shown.tag}{shown.role ? ` · ${shown.role}` : ''}</span>
              <span className="trunc t3 f1">{shown.text}</span>
              {pinned && <button className="ib sm" aria-label="Unpin" onClick={() => setPinned(null)}><Icon name="x" size={11} /></button>}
            </div>
            {shown.locators.map((c, i) => (
              <button key={i} className={`${s.cand} ${i === chosen ? s.on : ''}`} onClick={() => setChosen(i)}>
                <code className="f1">{locatorCode(c)}</code>
                <span className={c.matches === 1 ? s.uniq : s.dup}>
                  {c.within ? 'in container' : c.nth !== undefined ? `position ${c.nth + 1}` : c.matches === 1 ? 'unique' : `${c.matches} matches`}
                </span>
                {!c.stable && <span className={s.dup} title="Leans on what the page shows now (a price, a count, a position); it may break when the data changes">data</span>}
              </button>
            ))}
            <div className="row" style={{ gap: 6 }}>
              <code className="t3 trunc f1" style={{ fontSize: 10.5 }} title={shown.xpath}>{shown.xpath}</code>
              <button className="btn sm" onClick={() => copy(shown.xpath)}>Copy XPath</button>
            </div>
            {pinned && (
              <div className="row" style={{ gap: 6 }}>
                <input className="inp f1" style={{ height: 26, fontSize: 12 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name for the page library" aria-label="Element name" />
                <button className="btn sm" onClick={() => onInsert(locatorCode(shown.locators[chosen]!))}>Insert</button>
                <button className="btn sm" onClick={() => copy(locatorCode(shown.locators[chosen]!))}>Copy</button>
                {can('run.execute') && <button className="btn sm primary" onClick={save} disabled={!name.trim()}>Save element</button>}
              </div>
            )}
          </>
        )}
      </div>
        )}
      </div>
    </div>
    {guide && (
      <>
        {siteHidden ? <div aria-hidden /> : <Splitter direction="columns" size={guideWidth} min={320} max={1100} onResize={setGuideWidth} label="Resize the guide beside the site" />}
        <aside className={s.guide} aria-label="Guide">{guide(siteGuide)}</aside>
      </>
    )}
    </div>
  );
}
