import type { UiNode, UiScan } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { a11yScore, firstFamily, grade, indexTree, reviewBody, ruleSuggestions, uiStats } from './audit';

const style = {
  fontFamily: '"Inter", sans-serif', fontSize: 14, fontWeight: '400', lineHeight: '20px', letterSpacing: 'normal', textTransform: 'none',
  textAlign: 'start', color: '#111111', background: '#ffffff', backgroundImage: false, border: '0px none #000000',
  borderRadius: '0px', padding: '0px', margin: '0px', display: 'block', position: 'static', zIndex: 'auto', opacity: 1,
};
let seq = 0;
const node = (over: Omit<Partial<UiNode>, 'style'> & { style?: Partial<UiNode['style']> } = {}): UiNode => ({
  id: seq++, parent: null, depth: 0, tag: 'p', kind: 'text', role: null, name: '', text: 'Hello', selector: 'p', attrs: [],
  box: { x: 0, y: 0, w: 100, h: 20 }, contrast: 12, focusable: false, childCount: 0, ...over, style: { ...style, ...over.style },
});
const scan = (nodes: UiNode[], over: Partial<UiScan> = {}): UiScan => ({
  url: 'https://x.test/', title: 'X', lang: 'en', viewport: { width: 1280, height: 720 }, document: { width: 1280, height: 2000 },
  nodes, truncated: false, issues: [],
  perf: { ttfb: 100, fcp: 900, lcp: 1200, cls: 0.02, tbt: 50, domContentLoaded: 600, load: 1000, domNodes: 200, domDepth: 10, requests: 20, bytes: 500_000, byType: [], largest: [], slowest: [], jsHeapMb: 12 },
  ...over,
});

describe('indexTree', () => {
  it('nests children in document order and treats orphans as roots', () => {
    const a = node({ id: 1 });
    const b = node({ id: 2, parent: 1 });
    const c = node({ id: 3, parent: 1 });
    const orphan = node({ id: 4, parent: 99 });
    const t = indexTree([a, b, c, orphan]);
    expect(t.roots.map((n) => n.id)).toEqual([1, 4]);
    expect(t.children.get(1)!.map((n) => n.id)).toEqual([2, 3]);
  });
});

describe('uiStats', () => {
  it('counts the type and colour actually used by text', () => {
    const s = uiStats(scan([node(), node({ style: { fontSize: 15 } }), node({ style: { color: '#121212' } }), node({ text: '', kind: 'container' })]));
    expect(firstFamily('"Inter", sans-serif')).toBe('Inter');
    expect(s.textElements).toBe(3);
    expect(s.fonts).toEqual([{ value: 'Inter', count: 3 }]);
    expect(s.nearSizes).toEqual([[14, 15]]);
    expect(s.nearColours).toEqual([['#111111', '#121212']]);
  });
});

describe('a11yScore', () => {
  it('caps how much one repeated rule can cost', () => {
    const many = Array.from({ length: 50 }, () => ({ rule: 'contrast' as const, node: null, message: '' }));
    expect(a11yScore([])).toBe(100);
    expect(a11yScore(many)).toBe(80);
    expect(a11yScore([...many, { rule: 'control-name', node: null, message: '' }])).toBe(74);
  });
});

describe('grade', () => {
  it('uses the Web Vitals thresholds', () => {
    expect(grade('lcp', 2500)).toBe('good');
    expect(grade('lcp', 3000)).toBe('needs-work');
    expect(grade('lcp', 4001)).toBe('poor');
    expect(grade('cls', 0.3)).toBe('poor');
    expect(grade('tbt', null)).toBeNull();
  });
});

describe('ruleSuggestions', () => {
  it('puts sideways scrolling, failing rules and slow loads first', () => {
    const wide = node({ box: { x: 0, y: 0, w: 1600, h: 10 }, depth: 3 });
    const s = scan([node(), wide], {
      document: { width: 1600, height: 2000 },
      issues: [{ rule: 'control-name', node: wide.id, message: 'A button with no text' }],
      perf: { ...scan([]).perf, lcp: 5000 },
    });
    const out = ruleSuggestions(s, uiStats(s));
    expect(out.every((x, i) => i === 0 || { high: 0, medium: 1, low: 2 }[out[i - 1]!.severity] <= { high: 0, medium: 1, low: 2 }[x.severity])).toBe(true);
    expect(out.map((x) => x.title)).toEqual(expect.arrayContaining(['Stop the page scrolling sideways', 'Fix one × button or link without an accessible name', 'Improve Largest Contentful Paint (5000 ms)']));
    expect(out.find((x) => x.area === 'layout')!.nodes).toEqual([wide.id]);
  });

  it('notices buttons that do not match each other', () => {
    const buttons = [32, 36, 40, 44].map((h) => node({ kind: 'button', tag: 'button', box: { x: 0, y: 0, w: 80, h } }));
    const s = scan(buttons);
    expect(ruleSuggestions(s, uiStats(s)).map((x) => x.title)).toContain('Make buttons consistent');
  });

  it('says nothing about a clean page', () => {
    const s = scan([node()]);
    expect(ruleSuggestions(s, uiStats(s))).toEqual([]);
  });
});

describe('reviewBody', () => {
  it('summarises the scan and groups issues by rule', () => {
    const h = node({ kind: 'heading', tag: 'h1', name: 'Welcome' });
    const s = scan([h], { issues: [{ rule: 'contrast', node: h.id, message: 'low' }, { rule: 'contrast', node: h.id, message: 'again' }] });
    const body = reviewBody(s, uiStats(s), 'Desktop Chrome', [], '');
    expect(body.issues).toEqual([{ rule: 'contrast', count: 2, example: 'low' }]);
    expect(body.sample[0]!.element).toBe('h1 "Welcome"');
    expect(body.perf).not.toHaveProperty('largest');
  });
});
