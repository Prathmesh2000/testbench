'use client';

import type {
  BrowserClientMessage,
  BrowserDevice,
  BrowserSession,
  BrowserServerMessage,
  BrowserTab,
  NetworkEntry,
  PickedElement,
  RecordedStep,
  RequestDetail,
  StorageSnapshot,
} from '@tb/contracts';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Icon } from '@/components/Icon';
import { useSession } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import s from './ide.module.css';

type Status = { kind: 'starting' } | { kind: 'live' } | { kind: 'closed'; reason: string };

/** Keys sent to the page by name. Everything that produces text goes as text instead (see below). */
const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Control', 'Alt', 'Meta', 'Shift',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/**
 * Any site, beside the editor: a real browser on the Test Browser server, streamed in and driven by
 * the tester's mouse and keys, with every tab the site opens. Nothing is framed, so a site's frame and
 * CSP rules do not get in the way, and the picker and recorder run inside that browser.
 *
 * Typing goes through a hidden textarea rather than raw key codes: its input events carry exactly the
 * text the tester produced, whether typed, pasted, composed with an IME (Hindi, Chinese) or picked
 * from the emoji panel, which the page receives as typed text. Only named keys (Enter, arrows,
 * shortcuts with Ctrl) are sent as keys.
 */
export function LiveBrowser({
  url,
  nav,
  fill,
  picking,
  recording,
  storing,
  onReady,
  onPage,
  onHover,
  onPicked,
  onRecorded,
  onRecordStopped,
  onNetwork,
  onTabs,
  onDetail,
  onStorage,
  onActiveTab,
  onRun,
  onContext,
  device,
  onPointer,
  onUi,
  bridge,
}: {
  /** Opening a new address navigates the running session instead of starting another. */
  url: string;
  /** Bumped on every Open, so opening the same address again (in a new tab, say) still navigates. */
  nav: number;
  /** The large view: the browser's viewport follows the pane's size instead of the device profile's. */
  fill: boolean;
  picking: boolean;
  recording: boolean;
  /** Armed by the pane: the next click in the page is stored as a variable instead of clicked. */
  storing: boolean;
  onReady(ready: boolean): void;
  onPage(url: string): void;
  onHover(el: PickedElement): void;
  onPicked(el: PickedElement): void;
  onRecorded(step: RecordedStep): void;
  /** The recording is complete: every step, including a fill still in progress, has arrived. */
  onRecordStopped(): void;
  onNetwork(row: NetworkEntry & { tab: string }): void;
  onTabs(tabs: BrowserTab[]): void;
  onDetail(id: string, detail: RequestDetail | null): void;
  onStorage(snapshot: StorageSnapshot): void;
  onActiveTab(id: string): void;
  /** Progress of steps run with `run_steps`: each step, then the page as the run left it. */
  onRun?(msg: Extract<BrowserServerMessage, { t: 'run_step' | 'run_done' }>): void;
  /** What a page the browser reached is made of, for the site map. */
  onContext?(context: Extract<BrowserServerMessage, { t: 'page_context' }>['context']): void;
  /** The device profile the session starts with; the default is desktop Chrome. */
  device?: BrowserDevice;
  /** Where the pointer is over the page, in page and screen coordinates; null when it leaves. */
  onPointer?(at: { x: number; y: number; clientX: number; clientY: number } | null): void;
  /** Answers to the UI review's scans and hovers. */
  onUi?(msg: Extract<BrowserServerMessage, { t: 'ui_scan' | 'ui_at' }>): void;
  /** Filled with this session's send, so the pane can ask for request details and storage. */
  bridge: MutableRefObject<((msg: BrowserClientMessage) => void) | null>;
}) {
  const { project } = useSession();
  const screen = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const size = useRef({ width: 1280, height: 720 });
  const [status, setStatus] = useState<Status>({ kind: 'starting' });
  const [error, setError] = useState('');
  const [tabs, setTabs] = useState<{ list: BrowserTab[]; active: string }>({ list: [], active: '' });
  const [attempt, setAttempt] = useState(0);
  // The first address starts the session; later ones are sent as navigations (see below).
  const firstUrl = useRef(url);
  const firstNav = useRef(nav);
  const handlers = useRef({ onReady, onPage, onHover, onPicked, onRecorded, onRecordStopped, onNetwork, onTabs, onDetail, onStorage, onActiveTab, onRun, onPointer, onUi, onContext });
  handlers.current = { onReady, onPage, onHover, onPicked, onRecorded, onRecordStopped, onNetwork, onTabs, onDetail, onStorage, onActiveTab, onRun, onPointer, onUi, onContext };
  // What is held down on the server, so nothing stays pressed when focus leaves the pane.
  const held = useRef(new Set<string>());
  const pointer = useRef<{ x: number; y: number; button: 'left' | 'middle' | 'right' } | null>(null);

  const send = (msg: BrowserClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };
  bridge.current = send;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let session: BrowserSession | null = null;
    let cancelled = false;
    // Closing or reloading the tab never runs the cleanup below, so the session is ended as the page
    // goes: keepalive lets the request outlive it. Otherwise it would count against the cap for hours.
    const leave = () => {
      if (session) void fetch(`/api/core/projects/${project.id}/sessions/${session.id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    setStatus({ kind: 'starting' });
    setError('');
    void (async () => {
      try {
        session = await api<BrowserSession>('POST', `/projects/${project.id}/sessions`, { url: firstUrl.current, ...(device ? { device } : {}) });
      } catch (err) {
        if (!cancelled) setStatus({ kind: 'closed', reason: err instanceof ApiError ? err.message : 'Could not start the Test Browser' });
        return;
      }
      if (cancelled) return;
      socket = new WebSocket(`${session.wsUrl}?ticket=${encodeURIComponent(session.ticket)}`);
      ws.current = socket;
      socket.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as BrowserServerMessage;
        if (msg.t === 'frame') {
          // Straight onto the image: a state update per frame would re-render the pane 30 times a second.
          if (screen.current) screen.current.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.t === 'ready') {
          size.current = { width: msg.width, height: msg.height };
          setStatus({ kind: 'live' });
          handlers.current.onReady(true);
        } else if (msg.t === 'page') handlers.current.onPage(msg.url);
        else if (msg.t === 'tabs') {
          setTabs({ list: msg.tabs, active: msg.active });
          handlers.current.onTabs(msg.tabs);
          handlers.current.onActiveTab(msg.active);
        } else if (msg.t === 'network') handlers.current.onNetwork({ ...msg.entry, tab: msg.tab });
        else if (msg.t === 'request_detail') handlers.current.onDetail(msg.id, msg.detail);
        else if (msg.t === 'storage') handlers.current.onStorage(msg.snapshot);
        else if (msg.t === 'hover') handlers.current.onHover(msg.element);
        else if (msg.t === 'picked') handlers.current.onPicked(msg.element);
        else if (msg.t === 'recorded') handlers.current.onRecorded(msg.step);
        else if (msg.t === 'record_stopped') handlers.current.onRecordStopped();
        else if (msg.t === 'run_step' || msg.t === 'run_done') handlers.current.onRun?.(msg);
        else if (msg.t === 'page_context') handlers.current.onContext?.(msg.context);
        else if (msg.t === 'ui_scan' || msg.t === 'ui_at') handlers.current.onUi?.(msg);
        else if (msg.t === 'signal' && msg.kind === 'blocked') setError(msg.text);
        else if (msg.t === 'error') setError(msg.message);
        else if (msg.t === 'closed') setStatus({ kind: 'closed', reason: msg.reason });
      };
      socket.onclose = (e) => {
        handlers.current.onReady(false);
        if (!cancelled) setStatus((st) => (st.kind === 'closed' ? st : { kind: 'closed', reason: e.reason || 'The Test Browser disconnected' }));
      };
    })();
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', leave);
      socket?.close();
      ws.current = null;
      handlers.current.onReady(false);
      if (session) void api('DELETE', `/projects/${project.id}/sessions/${session.id}`).catch(() => {});
    };
  }, [project.id, attempt]);

  useEffect(() => {
    if (nav !== firstNav.current) send({ t: 'navigate', url });
  }, [nav]);

  useEffect(() => {
    send({ t: 'pick', on: picking });
  }, [picking, status.kind]);

  useEffect(() => {
    send({ t: 'record', on: recording });
  }, [recording, status.kind]);

  useEffect(() => {
    if (storing) send({ t: 'store' });
  }, [storing]);

  // In the large view the page is laid out at the pane's size, so it fills it with no bars; back in
  // the side pane it returns to the device profile's size, which is what tests replay at.
  const wrap = useRef<HTMLDivElement>(null);
  const filled = useRef(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el || status.kind !== 'live') return;
    if (!fill) {
      if (filled.current) send({ t: 'viewport', size: null });
      filled.current = false;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      clearTimeout(timer);
      // Debounced: dragging a window edge must not resize the remote browser on every frame.
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) send({ t: 'viewport', size: { width: Math.floor(r.width), height: Math.floor(r.height) } });
        filled.current = true;
      }, 200);
    };
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    fit();
    return () => {
      clearTimeout(timer);
      watch.disconnect();
    };
  }, [fill, status.kind]);

  /**
   * Pane coordinates to page coordinates. The stream is scaled to fit the pane whole (object-fit:
   * contain), so it is centred with bars on two sides; the page starts where the picture does.
   */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = screen.current!.getBoundingClientRect();
    const { width, height } = size.current;
    const scale = Math.min(r.width / width, r.height / height) || 1;
    const left = r.left + (r.width - width * scale) / 2;
    const top = r.top + (r.height - height * scale) / 2;
    return {
      x: Math.round(Math.min(Math.max((e.clientX - left) / scale, 0), width - 1)),
      y: Math.round(Math.min(Math.max((e.clientY - top) / scale, 0), height - 1)),
    };
  };
  const button = (b: number) => (b === 1 ? 'middle' : b === 2 ? 'right' : 'left');

  /** Lets go of everything on the server: a key or button left down turns later clicks into ctrl-clicks. */
  const release = () => {
    for (const key of held.current) send({ t: 'input', input: { kind: 'keyup', key } });
    held.current.clear();
    if (pointer.current) send({ t: 'input', input: { kind: 'mouseup', ...pointer.current } });
    pointer.current = null;
  };

  // Wheel needs a non-passive listener to keep the IDE itself from scrolling.
  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({ t: 'input', input: { kind: 'wheel', ...at(e), deltaY: e.deltaY } });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', release);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', release);
    };
  }, [status.kind]);

  const lastMove = useRef(0);
  const typed = (text: string) => {
    if (text) send({ t: 'input', input: { kind: 'text', text } });
    if (keys.current) keys.current.value = '';
  };

  return (
    <div className={s.live}>
      <div className={s.liveBar}>
        <button className="ib sm" aria-label="Back" onClick={() => send({ t: 'history', go: 'back' })}><Icon name="back" size={12} /></button>
        <button className="ib sm" aria-label="Forward" onClick={() => send({ t: 'history', go: 'forward' })}><Icon name="forward" size={12} /></button>
        <button className="ib sm" aria-label="Reload" onClick={() => send({ t: 'history', go: 'reload' })}><Icon name="refresh" size={12} /></button>
        <div className={s.tabs} role="tablist" aria-label="Tabs in the Test Browser">
          {tabs.list.map((t) => (
            <div key={t.id} className={`${s.tab} ${t.id === tabs.active ? s.on : ''}`}>
              <button role="tab" aria-selected={t.id === tabs.active} className="trunc" title={t.url} onClick={() => send({ t: 'tab', action: 'switch', id: t.id })}>
                {t.url === 'about:blank' ? 'New tab' : t.title || t.url.replace(/^https?:\/\//, '') || 'New tab'}
              </button>
              {tabs.list.length > 1 && (
                <button className={s.tabX} aria-label={`Close ${t.title || 'tab'}`} onClick={() => send({ t: 'tab', action: 'close', id: t.id })}><Icon name="x" size={9} /></button>
              )}
            </div>
          ))}
          <button className={s.tabNew} aria-label="New tab" title="New tab" onClick={() => send({ t: 'tab', action: 'new' })}>
            <Icon name="plus" size={11} />
          </button>
        </div>
        {status.kind === 'live' && recording && <span className={s.recOn}>{storing ? 'Click what to store' : 'Recording'}</span>}
      </div>
      <div className={s.screenWrap} ref={wrap}>
        <img
          ref={screen}
          alt="Test Browser. Click it, then use the mouse and keyboard as on the site."
          className={s.screen}
          style={picking || storing ? { cursor: 'crosshair' } : undefined}
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => {
            // One move per animation frame is as precise as the stream can show.
            if (e.timeStamp - lastMove.current < 16) return;
            lastMove.current = e.timeStamp;
            const p = at(e);
            send({ t: 'input', input: { kind: 'mousemove', ...p } });
            handlers.current.onPointer?.({ ...p, clientX: e.clientX, clientY: e.clientY });
          }}
          onPointerLeave={() => handlers.current.onPointer?.(null)}
          onPointerDown={(e) => {
            e.preventDefault();
            // Captured, so the release is seen even outside the pane.
            e.currentTarget.setPointerCapture(e.pointerId);
            keys.current?.focus();
            pointer.current = { ...at(e), button: button(e.button) };
            send({ t: 'input', input: { kind: 'mousedown', ...pointer.current } });
          }}
          onPointerUp={(e) => {
            pointer.current = null;
            send({ t: 'input', input: { kind: 'mouseup', ...at(e), button: button(e.button) } });
          }}
        />
        <textarea
          ref={keys}
          data-tb-keysink=""
          className={s.keySink}
          aria-label="Keyboard input for the Test Browser"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          onBlur={release}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const shortcut = e.ctrlKey || e.metaKey;
            // Paste arrives as an input event with the clipboard's text, like typing.
            if (shortcut && e.key.toLowerCase() === 'v') return;
            if (NAMED_KEYS.has(e.key) || (shortcut && [...e.key].length === 1)) {
              e.preventDefault();
              held.current.add(e.key);
              send({ t: 'input', input: { kind: 'keydown', key: e.key } });
            }
          }}
          onKeyUp={(e) => {
            if (!held.current.delete(e.key)) return;
            e.preventDefault();
            send({ t: 'input', input: { kind: 'keyup', key: e.key } });
          }}
          onInput={(e) => {
            if ((e.nativeEvent as InputEvent).isComposing) return;
            typed(e.currentTarget.value);
          }}
          onCompositionEnd={(e) => typed(e.data)}
        />
        {status.kind !== 'live' && (
          <div className={s.empty} style={{ position: 'absolute', inset: 0, flexDirection: 'column', gap: 8, textAlign: 'center', padding: 20, background: 'var(--panel)' }}>
            <span>{status.kind === 'starting' ? 'Opening a browser for this site…' : status.reason}</span>
            {status.kind === 'closed' && (
              <button
                className="btn sm"
                onClick={() => {
                  firstUrl.current = url;
                  firstNav.current = nav;
                  setAttempt((n) => n + 1);
                }}
              >
                Start again
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className={s.waiting} role="alert">
          {error} <button className="ib sm" aria-label="Dismiss" onClick={() => setError('')}><Icon name="x" size={11} /></button>
        </div>
      )}
    </div>
  );
}
