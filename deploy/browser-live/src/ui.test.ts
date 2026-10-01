import { describe, expect, it } from 'vitest';
import { parseScan } from './ui';

const style = {
  fontFamily: 'Inter', fontSize: 14, fontWeight: '400', lineHeight: '20px', letterSpacing: 'normal', textTransform: 'none',
  textAlign: 'start', color: '#111111', background: '#ffffff', backgroundImage: false, border: '0px none #000000',
  borderRadius: '0px', padding: '0px', margin: '0px', display: 'block', position: 'static', zIndex: 'auto', opacity: 1,
};
const node = (id: number, parent: number | null, extra: object = {}) => ({
  id, parent, depth: 0, tag: 'div', kind: 'container', role: null, name: '', text: '', selector: 'div', attrs: [],
  box: { x: 0, y: 0, w: 10, h: 10 }, style, contrast: null, focusable: false, childCount: 0, ...extra,
});
const perf = {
  ttfb: 100, fcp: 300, lcp: 900, cls: 0.01, tbt: 0, domContentLoaded: 500, load: 800, domNodes: 3, domDepth: 2,
  requests: 2, bytes: 1000, byType: [], largest: [{ url: 'https://x.test/a.js?token=abc', type: 'script', bytes: 900, durationMs: 40 }], slowest: [], jsHeapMb: null,
};
const raw = (nodes: unknown[], issues: unknown[] = []) => ({
  url: 'https://x.test/?token=abc', title: 'X', lang: 'en', viewport: { width: 1280, height: 720 }, document: { width: 1280, height: 2000 },
  nodes, truncated: false, issues, perf,
});
const mask = (u: string) => u.replace(/token=[^&]+/, 'token=***');

describe('parseScan', () => {
  it('keeps a well-formed scan and masks its addresses', () => {
    const scan = parseScan(raw([node(0, null), node(1, 0)]), mask)!;
    expect(scan.nodes).toHaveLength(2);
    expect(scan.url).toBe('https://x.test/?token=***');
    expect(scan.perf.largest[0]!.url).toBe('https://x.test/a.js?token=***');
  });

  it('drops a bad element and hangs its children from the nearest kept one', () => {
    const scan = parseScan(raw([node(0, null), node(1, 0, { tag: 'x'.repeat(500) }), node(2, 1)]), mask)!;
    expect(scan.nodes.map((n) => n.id)).toEqual([0, 2]);
    expect(scan.nodes[1]!.parent).toBe(0);
  });

  it('drops issues about elements it did not keep, and unknown rules', () => {
    const scan = parseScan(
      raw([node(0, null)], [
        { rule: 'contrast', node: 0, message: 'low' },
        { rule: 'contrast', node: 9, message: 'gone' },
        { rule: 'made-up', node: null, message: 'no' },
        { rule: 'doc-title', node: null, message: 'no title' },
      ]),
      mask,
    )!;
    expect(scan.issues.map((i) => i.message)).toEqual(['low', 'no title']);
  });

  it('refuses something that is not a scan', () => {
    expect(parseScan(null, mask)).toBeNull();
    expect(parseScan({ nodes: 'x' }, mask)).toBeNull();
  });
});
