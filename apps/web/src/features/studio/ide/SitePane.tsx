'use client';

import type { Locator, LocatorStrategy, PageElement } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import s from './ide.module.css';

const LAST_SITE = 'tb.ide.siteUrl';

/** One locator the embedded picker found, with how many elements it matches on the live page. */
interface Candidate {
  strategy: LocatorStrategy;
  value: string;
  name?: string;
  /** Set when the locator is scoped to a container, e.g. the row that says "Dell XPS". */
  within?: { strategy: LocatorStrategy; value: string; name?: string; hasText?: string };
  /** Set when position is the only thing telling identical elements apart. */
  nth?: number;
  code: string;
  matches: number;
}
interface Hovered {
  tag: string;
  role: string | null;
  text: string;
  xpath: string;
  suggestedName: string;
  page: string;
  url: string;
  locators: Candidate[];
}

/**
 * The site under test, beside the editor. It is the team's own page in an iframe, with the Testbench
 * embed script running inside it: hovering an element there shows its locators here, and one click
 * saves it to the page library or drops the code into the editor.
 *
 * The site has to allow being framed by Testbench and include the embed script. Both are one-line
 * changes to a staging environment, and they are what make this work with real logins and real data
 * instead of a copy of the page.
 */
export function SitePane({ onInsert }: { onInsert(code: string): void }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(() => (typeof localStorage !== 'undefined' && localStorage.getItem(LAST_SITE)) || '');
  const [loaded, setLoaded] = useState('');
  const [connected, setConnected] = useState(false);
  const [picking, setPicking] = useState(false);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [pinned, setPinned] = useState<Hovered | null>(null);
  const [chosen, setChosen] = useState(0);
  const [name, setName] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const shown = pinned ?? hovered;

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
        const p = msg.payload as Hovered;
        setPinned(p);
        setChosen(Math.max(0, p.locators.findIndex((l) => l.matches === 1)));
        setName(p.suggestedName);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [picking, pinned, tell]);

  const open = () => {
    const target = url.trim();
    if (!/^https?:\/\/.+/.test(target)) return notify('Enter the address of your site, starting with http:// or https://', 'bad');
    try {
      localStorage.setItem(LAST_SITE, target);
    } catch {
      // Private browsing: the address just isn't remembered.
    }
    setConnected(false);
    setHovered(null);
    setPinned(null);
    setLoaded(target);
  };

  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    setPinned(null);
    setHovered(null);
    tell(next);
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
    <div className={s.site}>
      <div className={s.siteBar}>
        <input
          className="inp f1"
          style={{ height: 26, fontSize: 12 }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && open()}
          placeholder="https://staging.example.com"
          aria-label="Site to open"
        />
        <button className="btn sm" onClick={open}>Open</button>
        {loaded && (
          <button className={`btn sm ${picking ? 'primary' : ''}`} onClick={togglePicking} disabled={!connected} title={connected ? undefined : 'Waiting for the embed script on the page'}>
            <Icon name="search" size={11} />{picking ? 'Picking' : 'Pick'}
          </button>
        )}
        <button className="ib sm" aria-label="How to connect a site" onClick={() => setShowSetup((v) => !v)}><Icon name="info" size={12} /></button>
      </div>

      {showSetup && (
        <div className={s.setup}>
          <b>To open your site here</b>
          <div>Add these two lines to the environment you test (staging, not production):</div>
          <div className="row" style={{ gap: 6 }}>
            <code className="f1">{embedTag}</code>
            <button className="btn sm" onClick={() => copy(embedTag)}>Copy</button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <code className="f1">{frameHeader}</code>
            <button className="btn sm" onClick={() => copy(frameHeader)}>Copy</button>
          </div>
          <div className="t3">
            The script only answers this page and only reports what you hover. Sites you cannot change still work
            with the bookmarklet under <b>Page library → Pick from your site</b>.
          </div>
        </div>
      )}

      <div className={s.frameWrap}>
        {loaded ? (
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
        {loaded && !connected && (
          <div className={s.waiting}>
            Waiting for the embed script… if nothing happens, the site is blocking the frame or has not included it.
          </div>
        )}
      </div>

      <div className={s.inspector}>
        {!shown ? (
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
                <code className="f1">{c.code}</code>
                <span className={c.matches === 1 ? s.uniq : s.dup}>
                  {c.within ? 'in container' : c.nth !== undefined ? `position ${c.nth + 1}` : c.matches === 1 ? 'unique' : `${c.matches} matches`}
                </span>
              </button>
            ))}
            <div className="row" style={{ gap: 6 }}>
              <code className="t3 trunc f1" style={{ fontSize: 10.5 }} title={shown.xpath}>{shown.xpath}</code>
              <button className="btn sm" onClick={() => copy(shown.xpath)}>Copy XPath</button>
            </div>
            {pinned && (
              <div className="row" style={{ gap: 6 }}>
                <input className="inp f1" style={{ height: 26, fontSize: 12 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name for the page library" aria-label="Element name" />
                <button className="btn sm" onClick={() => onInsert(shown.locators[chosen]!.code)}>Insert</button>
                <button className="btn sm" onClick={() => copy(shown.locators[chosen]!.code)}>Copy</button>
                {can('run.execute') && <button className="btn sm primary" onClick={save} disabled={!name.trim()}>Save element</button>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
