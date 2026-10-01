import { UI_RULES, type UiIssue, type UiNode, type UiPerf, type UiReviewBody, type UiRule, type UiScan, type UiSeverity, type UiSuggestion } from '@tb/contracts';

// What the UI review works out from a scan, with no model: the tree, the page's design tokens as
// used, Web Vitals grades and the suggestions any reviewer would make from the numbers alone.

export interface Count {
  value: string;
  count: number;
}

export interface TreeIndex {
  roots: UiNode[];
  children: Map<number, UiNode[]>;
  byId: Map<number, UiNode>;
}

/** Children by parent, in document order; a node whose parent was not kept becomes a root. */
export function indexTree(nodes: UiNode[]): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<number, UiNode[]>();
  const roots: UiNode[] = [];
  for (const n of nodes) {
    if (n.parent === null || !byId.has(n.parent)) roots.push(n);
    else children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  }
  return { roots, children, byId };
}

/** How a person would name an element in a bug report: `button "Sign in"`. */
export function nodeLabel(n: UiNode): string {
  const words = n.name || n.text;
  return `${n.tag}${words ? ` "${words.length > 50 ? `${words.slice(0, 49)}…` : words}"` : ''}`;
}

/** The first family of a font stack, without quotes: what actually renders when it is installed. */
export const firstFamily = (stack: string) => stack.split(',')[0]!.trim().replace(/^["']|["']$/g, '') || stack;

function tally(values: string[]): Count[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface UiStats {
  elements: number;
  textElements: number;
  interactive: number;
  fonts: Count[];
  sizes: Count[];
  weights: Count[];
  colours: Count[];
  backgrounds: Count[];
  radii: Count[];
  kinds: Count[];
  /** Pairs of text colours so close they are probably meant to be one. */
  nearColours: Array<[string, string]>;
  /** Font sizes 1 px or less apart, both in use. */
  nearSizes: Array<[number, number]>;
  a11yScore: number;
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function colourDistance(a: string, b: string) {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
}

const WEIGHT: Record<UiSeverity, number> = { critical: 6, serious: 4, moderate: 2, minor: 1 };

/**
 * A 0–100 accessibility score from the issues found: each rule costs its severity's weight per
 * occurrence, up to five, so one repeated problem cannot hide every other. Testbench's own measure,
 * not Lighthouse's.
 */
export function a11yScore(issues: UiIssue[]): number {
  const per = new Map<UiRule, number>();
  for (const i of issues) per.set(i.rule, (per.get(i.rule) ?? 0) + 1);
  const cost = [...per].reduce((sum, [rule, n]) => sum + Math.min(n, 5) * WEIGHT[UI_RULES[rule].severity], 0);
  return Math.max(0, 100 - cost);
}

export function uiStats(scan: UiScan): UiStats {
  const text = scan.nodes.filter((n) => n.text);
  const sizes = tally(text.map((n) => `${Math.round(n.style.fontSize * 2) / 2}`));
  const colours = tally(text.map((n) => n.style.color.slice(0, 7)));
  const px = sizes.map((s) => Number(s.value)).sort((a, b) => a - b);
  const nearSizes: Array<[number, number]> = [];
  for (let i = 1; i < px.length; i++) if (px[i]! - px[i - 1]! <= 1) nearSizes.push([px[i - 1]!, px[i]!]);
  const nearColours: Array<[string, string]> = [];
  for (let i = 0; i < colours.length; i++)
    for (let j = i + 1; j < colours.length; j++) {
      const d = colourDistance(colours[i]!.value, colours[j]!.value);
      if (d > 0 && d < 14) nearColours.push([colours[i]!.value, colours[j]!.value]);
    }
  return {
    elements: scan.nodes.length,
    textElements: text.length,
    interactive: scan.nodes.filter((n) => n.focusable).length,
    fonts: tally(text.map((n) => firstFamily(n.style.fontFamily))),
    sizes,
    weights: tally(text.map((n) => n.style.fontWeight)),
    colours,
    backgrounds: tally(text.map((n) => n.style.background.slice(0, 7))),
    radii: tally(scan.nodes.filter((n) => n.style.borderRadius !== '0px' && ['button', 'input', 'select', 'container', 'image'].includes(n.kind)).map((n) => n.style.borderRadius)),
    kinds: tally(scan.nodes.map((n) => n.kind)),
    nearColours: nearColours.slice(0, 12),
    nearSizes,
    a11yScore: a11yScore(scan.issues),
  };
}

// ---------- performance ----------

export type Grade = 'good' | 'needs-work' | 'poor';
type VitalKey = 'ttfb' | 'fcp' | 'lcp' | 'cls' | 'tbt';

/** Google's Web Vitals thresholds: at or under `good` is good, over `poor` is poor. */
export const VITALS: Array<{ key: VitalKey; label: string; hint: string; good: number; poor: number; unit: 'ms' | '' }> = [
  { key: 'lcp', label: 'Largest Contentful Paint', hint: 'When the main content has appeared', good: 2500, poor: 4000, unit: 'ms' },
  { key: 'fcp', label: 'First Contentful Paint', hint: 'When anything first appeared', good: 1800, poor: 3000, unit: 'ms' },
  { key: 'cls', label: 'Cumulative Layout Shift', hint: 'How much the layout jumped while loading', good: 0.1, poor: 0.25, unit: '' },
  { key: 'tbt', label: 'Total Blocking Time', hint: 'How long scripts kept the page from responding', good: 200, poor: 600, unit: 'ms' },
  { key: 'ttfb', label: 'Time to First Byte', hint: 'How long the server took to answer', good: 800, poor: 1800, unit: 'ms' },
];

export function grade(key: VitalKey, value: number | null): Grade | null {
  if (value === null) return null;
  const v = VITALS.find((x) => x.key === key)!;
  return value <= v.good ? 'good' : value <= v.poor ? 'needs-work' : 'poor';
}

// ---------- suggestions ----------

/** A suggestion with the elements it is about, so the tester can jump to them in the tree. */
export type RuleSuggestion = UiSuggestion & { nodes: number[]; source: 'rules' | 'ai' };

const severityOf = (s: UiSeverity): UiSuggestion['severity'] => (s === 'critical' || s === 'serious' ? 'high' : s === 'moderate' ? 'medium' : 'low');
const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('en-IN')} KB`;

/** The suggestions the numbers support on their own, most important first. */
export function ruleSuggestions(scan: UiScan, stats: UiStats): RuleSuggestion[] {
  const out: RuleSuggestion[] = [];
  const add = (s: Omit<RuleSuggestion, 'element' | 'source'> & { element?: string }) => out.push({ element: '', source: 'rules', ...s });

  const byRule = new Map<UiRule, UiIssue[]>();
  for (const i of scan.issues) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
  for (const [rule, list] of byRule) {
    const r = UI_RULES[rule];
    add({
      area: 'accessibility',
      severity: severityOf(r.severity),
      title: `Fix ${list.length === 1 ? 'one' : list.length} × ${r.title.toLowerCase()}`,
      detail: `WCAG ${r.wcag}. ${list[0]!.message}`,
      nodes: list.flatMap((i) => (i.node === null ? [] : [i.node])),
    });
  }

  if (scan.document.width > scan.viewport.width + 1) {
    const wide = scan.nodes.filter((n) => n.box.x + n.box.w > scan.viewport.width + 1 && n.style.position !== 'fixed').sort((a, b) => b.depth - a.depth);
    add({
      area: 'layout',
      severity: 'high',
      title: 'Stop the page scrolling sideways',
      detail: `The page is ${scan.document.width} px wide in a ${scan.viewport.width} px viewport.${wide[0] ? ` The deepest element past the edge is ${nodeLabel(wide[0])} (${wide[0].selector}).` : ''}`,
      nodes: wide.slice(0, 10).map((n) => n.id),
    });
  }

  if (stats.fonts.length > 3)
    add({ area: 'consistency', severity: 'medium', title: `Use fewer font families (${stats.fonts.length} in use)`, detail: `Found ${stats.fonts.map((f) => f.value).join(', ')}. Most designs use one or two.`, nodes: [] });
  if (stats.sizes.length > 8)
    add({ area: 'typography', severity: 'medium', title: `Bring the ${stats.sizes.length} font sizes onto a type scale`, detail: `In use: ${stats.sizes.map((s) => `${s.value}px`).join(', ')}. A scale usually has six to eight steps.`, nodes: [] });
  if (stats.nearSizes.length)
    add({
      area: 'typography',
      severity: 'low',
      title: 'Merge font sizes that are almost the same',
      detail: `${stats.nearSizes.map(([a, b]) => `${a}px and ${b}px`).join('; ')}: a difference nobody sees is usually a mistake.`,
      nodes: scan.nodes.filter((n) => n.text && stats.nearSizes.some(([, b]) => Math.round(n.style.fontSize * 2) / 2 === b)).slice(0, 20).map((n) => n.id),
    });
  if (stats.colours.length > 10)
    add({ area: 'colour', severity: 'medium', title: `Reduce the ${stats.colours.length} text colours to a palette`, detail: 'Text usually needs three or four colours: primary, secondary, muted and a link or accent.', nodes: [] });
  if (stats.nearColours.length)
    add({
      area: 'colour',
      severity: 'low',
      title: 'Merge text colours that are almost the same',
      detail: `${stats.nearColours.map(([a, b]) => `${a} and ${b}`).join('; ')}.`,
      nodes: scan.nodes.filter((n) => n.text && stats.nearColours.some(([, b]) => n.style.color.slice(0, 7) === b)).slice(0, 20).map((n) => n.id),
    });

  const buttons = scan.nodes.filter((n) => n.kind === 'button' && n.box.h > 0);
  const heights = new Set(buttons.map((b) => b.box.h));
  const radii = new Set(buttons.map((b) => b.style.borderRadius));
  if (heights.size > 3 || radii.size > 2)
    add({
      area: 'consistency',
      severity: 'medium',
      title: 'Make buttons consistent',
      detail: `${buttons.length} buttons in ${heights.size} heights (${[...heights].sort((a, b) => a - b).join(', ')} px) and ${radii.size} corner radii (${[...radii].join(', ')}).`,
      nodes: buttons.map((b) => b.id),
    });
  const fields = scan.nodes.filter((n) => (n.kind === 'input' || n.kind === 'select') && n.box.h > 0 && n.tag !== 'textarea');
  const fieldHeights = new Set(fields.map((f) => f.box.h));
  if (fieldHeights.size > 2)
    add({ area: 'consistency', severity: 'low', title: 'Give form fields one height', detail: `${fields.length} fields in ${fieldHeights.size} heights: ${[...fieldHeights].sort((a, b) => a - b).join(', ')} px.`, nodes: fields.map((f) => f.id) });

  const p = scan.perf;
  for (const v of VITALS) {
    const g = grade(v.key, p[v.key]);
    if (g && g !== 'good')
      add({
        area: 'performance',
        severity: g === 'poor' ? 'high' : 'medium',
        title: `Improve ${v.label} (${v.unit ? `${p[v.key]} ms` : p[v.key]})`,
        detail: `${v.hint}. Good is ${v.unit ? `${v.good} ms` : v.good} or less; over ${v.unit ? `${v.poor} ms` : v.poor} is poor.`,
        nodes: [],
      });
  }
  if (p.bytes > 3 * 1024 * 1024)
    add({ area: 'performance', severity: 'medium', title: `Cut the page weight (${kb(p.bytes)})`, detail: `Largest: ${p.largest.slice(0, 3).map((r) => `${r.url.split('/').pop()?.split('?')[0] || r.url} ${kb(r.bytes)}`).join(', ')}.`, nodes: [] });
  const bigImages = p.largest.filter((r) => r.type === 'img' && r.bytes > 300 * 1024);
  if (bigImages.length)
    add({ area: 'performance', severity: 'medium', title: `Compress ${bigImages.length} large image${bigImages.length === 1 ? '' : 's'}`, detail: bigImages.map((r) => `${r.url} (${kb(r.bytes)})`).join('; '), nodes: [] });
  if (p.domNodes > 1400)
    add({ area: 'performance', severity: 'low', title: `Reduce the DOM size (${p.domNodes.toLocaleString('en-IN')} elements)`, detail: `Over 1,400 elements, or a depth over 32 (this page: ${p.domDepth}), makes styling and scripts slower.`, nodes: [] });

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------- the tester's own review ----------

export type FindingSeverity = UiSuggestion['severity'];

/** Something the tester found by hand, on an element or the page. */
export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  note: string;
  node: number | null;
  element: string;
}

export type CheckResult = 'pass' | 'fail' | 'na' | null;

/** A manual UI checklist: what a reviewer looks at that no scan can judge. */
export const CHECKS: Array<{ id: string; group: string; label: string }> = [
  { id: 'design-match', group: 'Design', label: 'Layout, spacing and sizes match the design (Figma, Zeplin)' },
  { id: 'type', group: 'Design', label: 'Fonts, sizes and weights match the type scale' },
  { id: 'colour', group: 'Design', label: 'Colours match the palette, including hover and pressed' },
  { id: 'icons', group: 'Design', label: 'Icons and images are sharp, aligned and the right size' },
  { id: 'align', group: 'Layout', label: 'Elements line up on a grid; nothing overlaps or is cut off' },
  { id: 'responsive', group: 'Layout', label: 'Works at phone, tablet and desktop widths' },
  { id: 'long-text', group: 'Layout', label: 'Long names, numbers and translations do not break the layout' },
  { id: 'states', group: 'States', label: 'Hover, focus, active and disabled states are visible' },
  { id: 'empty', group: 'States', label: 'Empty, loading and error states are designed, not blank' },
  { id: 'feedback', group: 'States', label: 'Every action shows feedback (toast, inline message, spinner)' },
  { id: 'copy', group: 'Content', label: 'Labels and messages are clear, consistent and spelt right' },
  { id: 'formats', group: 'Content', label: 'Dates, currency (₹) and numbers use the right format' },
  { id: 'keyboard', group: 'Accessibility', label: 'Everything works with the keyboard, in a sensible order' },
  { id: 'focus', group: 'Accessibility', label: 'The focus outline is always visible' },
  { id: 'zoom', group: 'Accessibility', label: 'Readable and usable at 200% zoom' },
];

/** What goes to the AI review: the scan summarised, never the whole tree. */
export function reviewBody(scan: UiScan, stats: UiStats, device: string, findings: Finding[], focus: string): UiReviewBody {
  const byRule = new Map<UiRule, UiIssue[]>();
  for (const i of scan.issues) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
  const top = (list: Count[], n: number) => list.slice(0, n);
  const { largest: _l, slowest: _s, ...perf } = scan.perf;
  return {
    url: scan.url,
    title: scan.title,
    device,
    viewport: scan.viewport,
    stats: {
      elements: stats.elements,
      fonts: top(stats.fonts, 20),
      sizes: top(stats.sizes, 40),
      weights: top(stats.weights, 12),
      colours: top(stats.colours, 40),
      backgrounds: top(stats.backgrounds, 40),
      radii: top(stats.radii, 20),
      kinds: stats.kinds,
    },
    perf,
    issues: [...byRule].map(([rule, list]) => ({ rule, count: list.length, example: list[0]!.message.slice(0, 300) })),
    sample: scan.nodes
      .filter((n) => ['heading', 'button', 'input', 'select'].includes(n.kind))
      .slice(0, 60)
      .map((n) => ({
        kind: n.kind,
        element: nodeLabel(n).slice(0, 300),
        font: `${firstFamily(n.style.fontFamily)} ${n.style.fontSize}px/${n.style.lineHeight} ${n.style.fontWeight}`.slice(0, 200),
        colour: n.style.color,
        background: n.style.background,
        size: `${n.box.w}×${n.box.h}`,
        radius: n.style.borderRadius,
      })),
    findings: findings.slice(0, 40).map((f) => ({ title: f.title.slice(0, 200), note: f.note.slice(0, 1_000), element: f.element.slice(0, 300) })),
    focus: focus.slice(0, 1_000),
  };
}

const ms = (v: number | null) => (v === null ? 'n/a' : `${v.toLocaleString('en-IN')} ms`);

/** The whole review as Markdown, for a bug report, a Jira comment or a PR. */
export function markdownReport(input: {
  scan: UiScan;
  stats: UiStats;
  device: string;
  at: string;
  suggestions: RuleSuggestion[];
  findings: Finding[];
  checks: Record<string, CheckResult>;
  checkNotes: Record<string, string>;
}): string {
  const { scan, stats, suggestions, findings, checks, checkNotes } = input;
  const p: UiPerf = scan.perf;
  const lines = [
    `# UI review: ${scan.title || scan.url}`,
    '',
    `${scan.url} · ${input.device} · ${scan.viewport.width}×${scan.viewport.height} · ${input.at}`,
    '',
    `**${stats.elements} elements** · accessibility score **${stats.a11yScore}/100** · ${scan.issues.length} issues · ${stats.fonts.length} font families · ${stats.sizes.length} font sizes · ${stats.colours.length} text colours`,
    '',
    '## Performance',
    '',
    '| Metric | Value | Grade |',
    '|---|---|---|',
    ...VITALS.map((v) => `| ${v.label} | ${v.unit ? ms(p[v.key]) : (p[v.key] ?? 'n/a')} | ${grade(v.key, p[v.key]) ?? 'n/a'} |`),
    `| Requests | ${p.requests} (${kb(p.bytes)}) | |`,
    `| DOM elements | ${p.domNodes} (depth ${p.domDepth}) | |`,
  ];
  if (findings.length)
    lines.push('', '## Findings', '', ...findings.map((f) => `- **[${f.severity}] ${f.title}**${f.element ? ` · \`${f.element}\`` : ''}${f.note ? `\n  ${f.note}` : ''}`));
  const done = CHECKS.filter((c) => checks[c.id]);
  if (done.length)
    lines.push('', '## Checklist', '', ...done.map((c) => `- ${checks[c.id] === 'pass' ? '✅' : checks[c.id] === 'fail' ? '❌' : '➖'} ${c.label}${checkNotes[c.id] ? `: ${checkNotes[c.id]}` : ''}`));
  if (suggestions.length)
    lines.push('', '## Suggestions', '', ...suggestions.map((s) => `- **[${s.severity}] ${s.title}** (${s.area}${s.source === 'ai' ? ', AI draft' : ''})\n  ${s.detail}`));
  return lines.join('\n');
}
