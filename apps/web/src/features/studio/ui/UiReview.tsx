'use client';

import { BROWSER_DEVICES, type BrowserClientMessage, type BrowserDevice, type BrowserServerMessage, type UiIssue, type UiNode, type UiReviewResult, type UiScan } from '@tb/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { dateTimeIST, fmt } from '@/lib/format';
import { toAddress } from '../ide/address';
import { LiveBrowser } from '../ide/LiveBrowser';
import { Splitter, useStoredFlag, useStoredSize } from '../ide/Splitter';
import { indexTree, markdownReport, nodeLabel, reviewBody, ruleSuggestions, uiStats, type CheckResult, type Finding, type RuleSuggestion } from './audit';
import { NodeCard } from './NodeCard';
import { PageTree } from './PageTree';
import { ReferencePane } from './ReferencePane';
import { A11yPanel, ChecksPanel, PerfPanel, StatsPanel, SuggestionsPanel } from './ReviewPanels';
import s from './ui.module.css';

const PANELS = [
  { id: 'tree', label: 'Tree', short: 'Tree', icon: 'tree' },
  { id: 'checks', label: 'Review', short: 'Review', icon: 'flag' },
  { id: 'a11y', label: 'Accessibility', short: 'A11y', icon: 'shield' },
  { id: 'perf', label: 'Performance', short: 'Perf', icon: 'clock' },
  { id: 'stats', label: 'Stats', short: 'Stats', icon: 'chart' },
  { id: 'suggest', label: 'Suggestions', short: 'Suggestions', icon: 'sparkle' },
] as const;
type Panel = (typeof PANELS)[number]['id'];

const LAST_URL = 'tb.ui.url';
/** Hover lookups sent at most this often: each is a round trip to the Test Browser. */
const HOVER_MS = 60;

interface Review {
  findings: Finding[];
  checks: Record<string, CheckResult>;
  notes: Record<string, string>;
}
const EMPTY: Review = { findings: [], checks: {}, notes: {} };
/** Origin and path: the scan's URL has its query masked, so the query cannot be compared. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}
/**
 * The elements a model's suggestion names. It was given labels like `button "Sign in"` but often
 * answers with just the words, so those are matched too when the label finds nothing.
 */
function matchElement(nodes: UiNode[], element: string): number[] {
  const exact = nodes.filter((n) => nodeLabel(n) === element);
  const words = element.replace(/^\w+\s+"(.*)"$/, '$1').trim().toLowerCase();
  const found = exact.length ? exact : nodes.filter((n) => words && (n.name || n.text).toLowerCase() === words);
  return found.slice(0, 20).map((n) => n.id);
}
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The tester's findings and checklist, kept in this browser per project until they start a new review. */
function useReview(projectId: string): [Review, (fn: (r: Review) => Review) => void] {
  const key = `tb.ui.review.${projectId}`;
  const [review, setReview] = useState<Review>(() => {
    try {
      return { ...EMPTY, ...(JSON.parse(localStorage.getItem(key) ?? 'null') as Review | null) };
    } catch {
      return EMPTY;
    }
  });
  const update = (fn: (r: Review) => Review) =>
    setReview((prev) => {
      const next = fn(prev);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private browsing: kept for this visit only.
      }
      return next;
    });
  return [review, update];
}

/**
 * UI review (Studio › UI review): a page in the Test Browser, read as a tree of elements with their
 * computed type, colour, size and spacing. Hovering the page shows an element's details; the panel
 * beside it holds the tree, accessibility checks, Web Vitals, the page's design tokens as used, rule
 * and AI suggestions, and the tester's own findings and checklist. A reference pane opens the design
 * (Figma, Zeplin, HTML, an export) alongside.
 */
export function UiReview({ header }: { header: ReactNode }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const panel = (PANELS.some((p) => p.id === params.get('panel')) ? params.get('panel') : 'tree') as Panel;
  const setPanel = (p: Panel) => router.replace(`/automation?tab=ui&panel=${p}`);

  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem(LAST_URL) || localStorage.getItem('tb.ide.siteUrl') || '';
    } catch {
      return '';
    }
  });
  const [loaded, setLoaded] = useState('');
  const [nav, setNav] = useState(0);
  const [device, setDevice] = useState<BrowserDevice>('Desktop Chrome');
  const [connected, setConnected] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  const bridge = useRef<((msg: BrowserClientMessage) => void) | null>(null);
  const send = (msg: BrowserClientMessage) => bridge.current?.(msg);

  const [scan, setScan] = useState<UiScan | null>(null);
  const [scannedAt, setScannedAt] = useState('');
  const [scanning, setScanning] = useState(false);
  const pendingScan = useRef<string | null>(null);

  const [inspecting, setInspecting] = useState(false);
  const [hover, setHover] = useState<{ node: UiNode; x: number; y: number } | null>(null);
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastAt = useRef(0);
  const [selected, setSelected] = useState<number | null>(null);
  // An element picked from the page that the last scan does not have (it appeared since).
  const [loose, setLoose] = useState<UiNode | null>(null);

  const [refOpen, setRefOpen] = useStoredFlag('tb.ui.refOpen', false);
  const [refWidth, setRefWidth] = useStoredSize('tb.ui.refWidth', 440);
  const [panelWidth, setPanelWidth] = useStoredSize('tb.ui.panelWidth', 440);

  const [review, updateReview] = useReview(project.id);
  const [focus, setFocus] = useState('');
  const [asking, setAsking] = useState(false);
  const [ai, setAi] = useState<{ result: UiReviewResult; forUrl: string } | null>(null);

  const tree = useMemo(() => indexTree(scan?.nodes ?? []), [scan]);
  const issuesByNode = useMemo(() => {
    const m = new Map<number, UiIssue[]>();
    for (const i of scan?.issues ?? []) if (i.node !== null) m.set(i.node, [...(m.get(i.node) ?? []), i]);
    return m;
  }, [scan]);
  const stats = useMemo(() => (scan ? uiStats(scan) : null), [scan]);
  const suggestions = useMemo<RuleSuggestion[]>(() => {
    if (!scan || !stats) return [];
    const fromAi: RuleSuggestion[] =
      ai && ai.forUrl === scan.url
        ? ai.result.suggestions.map((x) => ({ ...x, source: 'ai', nodes: x.element ? matchElement(scan.nodes, x.element) : [] }))
        : [];
    return [...fromAi, ...ruleSuggestions(scan, stats)];
  }, [scan, stats, ai]);

  const selectedNode = selected !== null ? (tree.byId.get(selected) ?? null) : loose;
  const stale = !!scan && !!pageUrl && pathOf(pageUrl) !== pathOf(scan.url);

  const open = (address = url) => {
    const target = toAddress(address);
    if (!target) return notify('Enter a web address, or words to search for', 'bad');
    setUrl(target);
    try {
      localStorage.setItem(LAST_URL, target);
    } catch {
      // Not remembered; the page still opens.
    }
    setLoaded(target);
    setNav((n) => n + 1);
  };

  const runScan = () => {
    if (!connected) return;
    const id = newId();
    pendingScan.current = id;
    setScanning(true);
    send({ t: 'ui_scan', id });
  };

  const select = (id: number, scroll = true) => {
    setSelected(id);
    setLoose(null);
    send({ t: 'ui_highlight', node: id, scroll });
  };
  const show = (nodes: number[]) => {
    if (!nodes.length) return;
    select(nodes[0]!);
    setPanel('tree');
  };

  const onUi = (msg: Extract<BrowserServerMessage, { t: 'ui_scan' | 'ui_at' }>) => {
    if (msg.t === 'ui_scan') {
      if (msg.id !== pendingScan.current) return;
      pendingScan.current = null;
      setScanning(false);
      if (!msg.scan) return notify(msg.error ?? 'The page could not be scanned', 'bad');
      setScan(msg.scan);
      setScannedAt(new Date().toISOString());
      if (selected !== null && !msg.scan.nodes.some((n) => n.id === selected)) setSelected(null);
      return;
    }
    const at = pointer.current;
    setHover(inspecting && msg.node && at ? { node: msg.node, x: at.clientX, y: at.clientY } : null);
  };

  const onPointer = (at: { x: number; y: number; clientX: number; clientY: number } | null) => {
    pointer.current = at;
    if (!inspecting) return;
    if (!at) {
      setHover(null);
      send({ t: 'ui_highlight', node: selected, scroll: false });
      return;
    }
    const now = performance.now();
    if (now - lastAt.current < HOVER_MS) return;
    lastAt.current = now;
    send({ t: 'ui_at', x: at.x, y: at.y });
  };

  useEffect(() => {
    if (inspecting) return;
    setHover(null);
    send({ t: 'ui_highlight', node: selected, scroll: false });
  }, [inspecting]);

  // Esc leaves inspect mode, unless the keys are going to the page.
  useEffect(() => {
    if (!inspecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.hasAttribute?.('data-tb-keysink')) setInspecting(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspecting]);

  const askAi = async () => {
    if (!scan || !stats) return;
    setAsking(true);
    try {
      const result = await api<UiReviewResult>('POST', `/projects/${project.id}/studio/ui-review`, reviewBody(scan, stats, device, review.findings, focus));
      setAi({ result, forUrl: scan.url });
      if (result.ai.status === 'used') notify(`${result.suggestions.length} AI suggestions added`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'The AI review failed', 'bad');
    } finally {
      setAsking(false);
    }
  };

  const addFinding = (f: Omit<Finding, 'id' | 'node' | 'element'>, attach: boolean) =>
    updateReview((r) => ({
      ...r,
      findings: [...r.findings, { ...f, id: newId(), node: attach && selectedNode ? selectedNode.id : null, element: attach && selectedNode ? `${nodeLabel(selectedNode)} · ${selectedNode.selector}` : '' }],
    }));

  const report = () =>
    scan && stats
      ? markdownReport({ scan, stats, device, at: dateTimeIST(scannedAt), suggestions, findings: review.findings, checks: review.checks, checkNotes: review.notes })
      : '';
  const copyReport = () => navigator.clipboard.writeText(report()).then(() => notify('Report copied as Markdown'), () => notify('Could not copy', 'bad'));
  const downloadJson = () => {
    if (!scan) return;
    const blob = new Blob([JSON.stringify({ device, scannedAt, scan, suggestions, ...review }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ui-review-${new URL(scan.url).hostname}-${scannedAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
  };

  const columns = refOpen ? `minmax(320px, 1fr) 6px ${refWidth}px 6px ${panelWidth}px` : `minmax(320px, 1fr) 6px ${panelWidth}px`;

  return (
    <div className={s.screen}>
      {header}
      <div className={s.bar}>
        <input
          className="inp f1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && open()}
          placeholder="Page to review: a web address, or words to search for"
          aria-label="Page to review"
        />
        <select
          className="inp"
          value={device}
          onChange={(e) => {
            setDevice(e.target.value as BrowserDevice);
            setScan(null);
            setSelected(null);
            if (pageUrl) setLoaded(pageUrl);
          }}
          aria-label="Device"
        >
          {BROWSER_DEVICES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="btn sm" onClick={() => open()}>Open</button>
        <span className={s.sep} aria-hidden />
        <button className="btn sm primary" onClick={runScan} disabled={!connected || scanning} title={connected ? 'Read the page as it is now' : 'Open a page first'}>
          <Icon name="refresh" size={11} />{scanning ? 'Scanning…' : scan ? 'Rescan' : 'Scan page'}
        </button>
        <button className={`btn sm ${inspecting ? 'primary' : ''}`} aria-pressed={inspecting} onClick={() => setInspecting((v) => !v)} disabled={!connected} title="Hover the page to see each element’s details; click to select it (Esc to stop)">
          <Icon name="inspect" size={11} />Inspect
        </button>
        <button className={`btn sm ${refOpen ? 'primary' : ''}`} aria-pressed={refOpen} onClick={() => setRefOpen(!refOpen)} title="Open the design beside the page: Figma, Zeplin, HTML or an export">
          <Icon name="layers" size={11} />Reference
        </button>
        <span className={s.sep} aria-hidden />
        <button className="btn sm" onClick={copyReport} disabled={!scan}><Icon name="doc" size={11} />Copy report</button>
        <button className="ib sm" onClick={downloadJson} disabled={!scan} aria-label="Download the review as JSON" title="Download the review as JSON"><Icon name="paperclip" size={12} /></button>
      </div>

      <div className={s.body} style={{ '--cols': columns } as React.CSSProperties}>
        <section
          className={s.page}
          aria-label="Page under review"
          onPointerDownCapture={(e) => {
            // Inspecting, a click on the page selects what is under it instead of clicking it, as in DevTools.
            if (!inspecting || (e.target as HTMLElement).tagName !== 'IMG') return;
            e.stopPropagation();
            e.preventDefault();
            if (!hover) return;
            if (tree.byId.has(hover.node.id)) select(hover.node.id, false);
            else {
              setSelected(null);
              setLoose(hover.node);
            }
            setPanel('tree');
          }}
          onPointerUpCapture={(e) => {
            if (inspecting && (e.target as HTMLElement).tagName === 'IMG') e.stopPropagation();
          }}
        >
          {loaded ? (
            <LiveBrowser
              key={device}
              device={device}
              url={loaded}
              nav={nav}
              fill={false}
              picking={false}
              recording={false}
              storing={false}
              onReady={(ready) => {
                setConnected(ready);
                if (!ready) {
                  setScanning(false);
                  setInspecting(false);
                }
              }}
              onPage={(u) => {
                setPageUrl(u);
                if (u !== 'about:blank') setUrl(u);
              }}
              onHover={() => {}}
              onPicked={() => {}}
              onRecorded={() => {}}
              onRecordStopped={() => {}}
              onNetwork={() => {}}
              onTabs={() => {}}
              onDetail={() => {}}
              onStorage={() => {}}
              onActiveTab={() => {}}
              onPointer={onPointer}
              onUi={onUi}
              bridge={bridge}
            />
          ) : (
            <div className="empty">
              <Icon name="inspect" size={20} />
              <div>Review any page’s UI</div>
              <span className="t3" style={{ maxWidth: 420 }}>
                Open a page, sign in and get to the screen you want, then press <b>Scan page</b>. You get every element with its font, colour,
                size and spacing, accessibility and performance checks, and suggestions. <b>Inspect</b> shows any element’s details as you hover it.
              </span>
              <button className="btn sm primary" onClick={() => open()} disabled={!url.trim()}>Open {url ? toAddress(url)?.replace(/^https?:\/\//, '').slice(0, 40) : 'a page'}</button>
            </div>
          )}
        </section>

        {refOpen && (
          <>
            <Splitter direction="columns" size={refWidth} min={280} max={1200} onResize={setRefWidth} label="Resize the reference pane" />
            <ReferencePane onClose={() => setRefOpen(false)} />
          </>
        )}

        <Splitter direction="columns" size={panelWidth} min={340} max={900} onResize={setPanelWidth} label="Resize the review panel" />
        <aside className={s.side} aria-label="Review">
          <div className={s.panelTabs} role="tablist" aria-label="Review panels">
            {PANELS.map((p) => (
              <button key={p.id} role="tab" aria-selected={panel === p.id} onClick={() => setPanel(p.id)} title={p.label} aria-label={p.label}>
                <Icon name={p.icon} size={12} />
                <span>{p.short}</span>
                {p.id === 'a11y' && scan && scan.issues.length > 0 && <span className={s.tabCount}>{scan.issues.length}</span>}
                {p.id === 'checks' && review.findings.length > 0 && <span className={s.tabCount}>{review.findings.length}</span>}
              </button>
            ))}
          </div>
          {scan && (
            <div className={s.scanLine} role="status">
              <span className="trunc f1" title={scan.url}>
                {fmt(scan.nodes.length)} elements{scan.truncated ? ' (first 2,500)' : ''} · {scan.viewport.width}×{scan.viewport.height} · {dateTimeIST(scannedAt)}
              </span>
              {stale && <button className="btn sm" onClick={runScan}>Page changed: rescan</button>}
            </div>
          )}
          <div className={s.panel} role="tabpanel">
            {panel === 'checks' ? (
              <ChecksPanel
                checks={review.checks}
                notes={review.notes}
                findings={review.findings}
                selectedLabel={selectedNode ? nodeLabel(selectedNode) : null}
                onCheck={(id, r) => updateReview((v) => ({ ...v, checks: { ...v.checks, [id]: r } }))}
                onNote={(id, note) => updateReview((v) => ({ ...v, notes: { ...v.notes, [id]: note } }))}
                onAddFinding={addFinding}
                onRemoveFinding={(id) => updateReview((v) => ({ ...v, findings: v.findings.filter((f) => f.id !== id) }))}
                onShow={(n) => show([n])}
              />
            ) : !scan || !stats ? (
              <div className="empty">
                <Icon name={PANELS.find((p) => p.id === panel)!.icon} size={20} />
                <div>{connected ? 'Scan the page to review it' : 'Open a page first'}</div>
                <span className="t3">The review reads the page as it is when you scan: open menus, dialogs and error states count.</span>
                {connected && <button className="btn sm primary" onClick={runScan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan page'}</button>}
              </div>
            ) : panel === 'tree' ? (
              <div className={s.treePanel}>
                <PageTree
                  tree={tree}
                  issuesByNode={issuesByNode}
                  selected={selected}
                  onSelect={(id) => select(id)}
                  onHover={(id) => send({ t: 'ui_highlight', node: id ?? selected, scroll: false })}
                />
                {selectedNode ? (
                  <div className={s.detail}>
                    {loose && <div className={s.aiNote}><Icon name="info" size={12} />This element is not in the last scan. Rescan to see it in the tree.</div>}
                    <NodeCard
                      node={selectedNode}
                      issues={issuesByNode.get(selectedNode.id) ?? []}
                      onFlag={() => {
                        setPanel('checks');
                        notify('Describe the finding; it is attached to the selected element');
                      }}
                    />
                  </div>
                ) : (
                  <div className={`${s.detail} t3`} style={{ fontSize: 12 }}>Select an element in the tree, or press Inspect and click one in the page.</div>
                )}
              </div>
            ) : panel === 'a11y' ? (
              <A11yPanel scan={scan} stats={stats} onShow={(n) => show([n])} />
            ) : panel === 'perf' ? (
              <PerfPanel scan={scan} />
            ) : panel === 'stats' ? (
              <StatsPanel scan={scan} stats={stats} />
            ) : (
              <SuggestionsPanel
                suggestions={suggestions}
                ai={ai && ai.forUrl === scan.url ? { summary: ai.result.summary, status: ai.result.ai.status, message: ai.result.ai.message } : null}
                focus={focus}
                onFocus={setFocus}
                onAsk={askAi}
                asking={asking}
                canAsk={can('ai.use')}
                onShow={show}
                onAdopt={(x) => {
                  const node = x.nodes.length ? tree.byId.get(x.nodes[0]!) : undefined;
                  updateReview((r) => ({
                    ...r,
                    findings: [...r.findings, { id: newId(), title: x.title, severity: x.severity, note: x.detail, node: node?.id ?? null, element: node ? `${nodeLabel(node)} · ${node.selector}` : x.element }],
                  }));
                  notify('Added to findings');
                }}
              />
            )}
          </div>
          {panel === 'checks' && (review.findings.length > 0 || Object.keys(review.checks).length > 0) && (
            <div className={s.sideFoot}>
              <button
                className="btn sm ghost"
                onClick={() => {
                  if (window.confirm('Start a new review? This clears the findings and checklist.')) updateReview(() => EMPTY);
                }}
              >
                Start a new review
              </button>
            </div>
          )}
        </aside>
      </div>

      {hover && inspecting && (
        <div
          className={s.tooltip}
          role="tooltip"
          style={{
            left: Math.min(hover.x + 16, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 336),
            top: Math.min(hover.y + 16, (typeof window === 'undefined' ? 800 : window.innerHeight) - 300),
          }}
        >
          <NodeCard node={hover.node} issues={issuesByNode.get(hover.node.id) ?? []} compact />
        </div>
      )}
    </div>
  );
}
