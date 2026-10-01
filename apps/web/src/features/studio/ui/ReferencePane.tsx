'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import s from './ui.module.css';

const KINDS = ['figma', 'zeplin', 'url', 'html', 'file'] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = { figma: 'Figma', zeplin: 'Zeplin', url: 'Web page', html: 'HTML', file: 'Image or PDF' };
const STORED = 'tb.ui.references';

interface Reference {
  id: string;
  kind: Kind;
  name: string;
  /** The address for figma, zeplin and url; the markup for html; an object URL for a file. */
  source: string;
  /** Pasted HTML may run its scripts only when the tester says so, and even then with no origin. */
  scripts?: boolean;
}

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function webAddress(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** Figma's own embed viewer: a file or prototype link opens in it, frames and all. */
function figmaEmbed(u: URL): string {
  if (u.hostname === 'embed.figma.com' || u.pathname.startsWith('/embed')) return u.toString();
  return `https://www.figma.com/embed?embed_host=testbench&url=${encodeURIComponent(u.toString())}`;
}

/**
 * What the page is checked against, open beside it: a Figma file, a Zeplin screen, another web page
 * (the design system, a Storybook, a published artifact), pasted HTML, or a screenshot or PDF export.
 * Web addresses are remembered in this browser; files and pasted HTML are not, as they may be large
 * or private.
 */
export function ReferencePane({ onClose }: { onClose(): void }) {
  const { notify } = useToast();
  const [refs, setRefs] = useState<Reference[]>(() => {
    try {
      return (JSON.parse(localStorage.getItem(STORED) ?? '[]') as Reference[]).filter((r) => KINDS.includes(r.kind) && r.kind !== 'file' && r.kind !== 'html');
    } catch {
      return [];
    }
  });
  const [active, setActive] = useState<string | null>(refs[0]?.id ?? null);
  const [adding, setAdding] = useState<Kind | null>(refs.length ? null : 'figma');
  const [input, setInput] = useState('');
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const file = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());

  useEffect(() => {
    try {
      localStorage.setItem(STORED, JSON.stringify(refs.filter((r) => r.kind !== 'file' && r.kind !== 'html')));
    } catch {
      // Not remembered; the references still work for now.
    }
  }, [refs]);
  // Object URLs hold the file in memory until they are revoked.
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const add = (r: Omit<Reference, 'id'>) => {
    const ref = { ...r, id: newId() };
    setRefs((list) => [...list, ref]);
    setActive(ref.id);
    setAdding(null);
    setInput('');
  };
  const remove = (id: string) => {
    const r = refs.find((x) => x.id === id);
    if (r?.kind === 'file') {
      URL.revokeObjectURL(r.source);
      urls.current.delete(r.source);
    }
    const rest = refs.filter((x) => x.id !== id);
    setRefs(rest);
    if (active === id) setActive(rest[0]?.id ?? null);
    if (!rest.length) setAdding('figma');
  };

  const submit = () => {
    if (!adding) return;
    if (adding === 'html') {
      if (!input.trim()) return notify('Paste the HTML to show', 'bad');
      return add({ kind: 'html', name: 'Pasted HTML', source: input });
    }
    const u = webAddress(input);
    if (!u) return notify('Enter a web address starting with https://', 'bad');
    // Framed with allow-scripts and allow-same-origin, a page on this origin could lift its own sandbox.
    if (u.origin === location.origin) return notify('Testbench’s own pages cannot be opened as a reference', 'bad');
    if (adding === 'figma' && !/(^|\.)figma\.com$/.test(u.hostname)) return notify('That is not a figma.com link', 'bad');
    if (adding === 'zeplin' && !/(^|\.)zeplin\.(io|app)$/.test(u.hostname)) return notify('That is not a Zeplin link', 'bad');
    add({ kind: adding, name: adding === 'url' ? u.hostname : LABEL[adding], source: adding === 'figma' ? figmaEmbed(u) : u.toString() });
  };

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/|^application\/pdf$/.test(f.type)) return notify('Choose an image (PNG, JPG, SVG, WebP) or a PDF', 'bad');
    const source = URL.createObjectURL(f);
    urls.current.add(source);
    add({ kind: 'file', name: f.name, source });
  };

  const current = refs.find((r) => r.id === active) ?? null;
  const isPdf = current?.kind === 'file' && current.name.toLowerCase().endsWith('.pdf');

  return (
    <section className={s.reference} aria-label="Design reference">
      <div className={s.refBar}>
        <div className={s.refTabs} role="tablist" aria-label="References">
          {refs.map((r) => (
            <div key={r.id} className={`${s.refTab} ${r.id === active && !adding ? s.on : ''}`}>
              <button role="tab" aria-selected={r.id === active && !adding} className="trunc" title={r.kind === 'html' ? r.name : r.source} onClick={() => { setActive(r.id); setAdding(null); }}>
                <span className={s.refKind}>{LABEL[r.kind]}</span>{r.kind === 'figma' || r.kind === 'zeplin' ? '' : r.name}
              </button>
              <button className={s.refX} aria-label={`Close ${r.name}`} onClick={() => remove(r.id)}><Icon name="x" size={9} /></button>
            </div>
          ))}
          <button className={s.refAdd} aria-label="Add a reference" title="Add a reference" onClick={() => setAdding(adding ? null : 'figma')}>
            <Icon name="plus" size={11} />
          </button>
        </div>
        {current && !adding && current.kind !== 'html' && current.kind !== 'file' && (
          <button className="ib sm" aria-label="Open in a new window" title="Open in a new window" onClick={() => window.open(current.kind === 'figma' ? decodeURIComponent(current.source.split('url=')[1] ?? current.source) : current.source, '_blank', 'noopener')}>
            <Icon name="expand" size={12} />
          </button>
        )}
        {current?.kind === 'file' && !isPdf && !adding && (
          <div className="seg" role="group" aria-label="Zoom">
            <button className={zoom === 'fit' ? 'on' : ''} onClick={() => setZoom('fit')}>Fit</button>
            <button className={zoom === 'actual' ? 'on' : ''} onClick={() => setZoom('actual')}>100%</button>
          </div>
        )}
        <button className="ib sm" aria-label="Close the reference pane" onClick={onClose}><Icon name="x" size={12} /></button>
      </div>

      {adding ? (
        <div className={s.refAddForm}>
          <div className="seg" role="radiogroup" aria-label="What to open">
            {KINDS.map((k) => (
              <button key={k} role="radio" aria-checked={adding === k} className={adding === k ? 'on' : ''} onClick={() => { setAdding(k); setInput(''); }}>{LABEL[k]}</button>
            ))}
          </div>
          {adding === 'file' ? (
            <>
              <input ref={file} type="file" accept="image/*,application/pdf" className={s.fileInput} aria-label="Choose an image or PDF" onChange={(e) => pickFile(e.target.files?.[0])} />
              <button
                className={s.drop}
                onClick={() => file.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  pickFile(e.dataTransfer.files[0]);
                }}
              >
                <Icon name="paperclip" size={16} />
                <span>Drop a screenshot, design export or PDF here, or choose a file</span>
                <span className="t3">It stays in this browser tab and is not uploaded.</span>
              </button>
            </>
          ) : adding === 'html' ? (
            <>
              <textarea className={`inp ${s.htmlInput}`} value={input} onChange={(e) => setInput(e.target.value)} placeholder="<!doctype html>…" aria-label="HTML to show" spellCheck={false} />
              <button className="btn sm primary" onClick={submit}>Show</button>
            </>
          ) : (
            <>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="inp f1"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder={adding === 'figma' ? 'https://www.figma.com/design/…' : adding === 'zeplin' ? 'https://app.zeplin.io/project/…/screen/…' : 'https://…'}
                  aria-label={`${LABEL[adding]} link`}
                />
                <button className="btn sm primary" onClick={submit}>Open</button>
              </div>
              <span className="t3">
                {adding === 'figma'
                  ? 'Copy the link to a frame (Share › Copy link). You may need to sign in to Figma inside the pane.'
                  : adding === 'zeplin'
                    ? 'Zeplin usually refuses to open inside other apps; if the pane stays blank, use the open-in-window button.'
                    : 'A design system page, Storybook, a published artifact or the previous release. Sites that forbid framing stay blank; open them in a window.'}
              </span>
            </>
          )}
        </div>
      ) : !current ? null : current.kind === 'file' && !isPdf ? (
        <div className={`${s.refImage} ${zoom === 'fit' ? s.fit : ''}`}>
          <img src={current.source} alt={`Reference: ${current.name}`} />
        </div>
      ) : current.kind === 'html' ? (
        <div className={s.refFrameWrap}>
          <label className={s.refNote}>
            <input type="checkbox" checked={!!current.scripts} onChange={(e) => setRefs((list) => list.map((r) => (r.id === current.id ? { ...r, scripts: e.target.checked } : r)))} />
            Run its scripts (sandboxed, with no access to Testbench)
          </label>
          {/* No allow-same-origin: pasted markup gets an opaque origin and cannot reach this page or its cookies. */}
          <iframe key={`${current.id}-${!!current.scripts}`} className={s.refFrame} srcDoc={current.source} sandbox={current.scripts ? 'allow-scripts' : ''} title={current.name} />
        </div>
      ) : (
        <iframe
          key={current.id}
          className={s.refFrame}
          src={current.source}
          title={`${LABEL[current.kind]} reference`}
          // Another origin, so allow-same-origin gives it its own cookies (a Figma sign-in), never ours.
          sandbox={current.kind === 'file' ? undefined : 'allow-scripts allow-same-origin allow-popups allow-forms'}
          referrerPolicy="no-referrer"
          allow="fullscreen; clipboard-write"
        />
      )}
    </section>
  );
}
