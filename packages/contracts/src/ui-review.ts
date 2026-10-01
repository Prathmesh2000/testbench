import { z } from 'zod';

// UI review (Studio › UI review): the page in the Test Browser read as a tree of elements with their
// computed styles, checked for accessibility and timed, so a tester can review a screen against its
// design by hand or with AI. The scan is produced inside a page nobody vetted, so browser-live parses
// it with these schemas before it reaches the tester.

/** What an element is, as a reviewer thinks of it rather than by tag. */
export const UI_KINDS = [
  'heading', 'text', 'link', 'button', 'input', 'select', 'checkbox', 'image', 'icon', 'media',
  'list', 'table', 'form', 'landmark', 'container',
] as const;
export type UiKind = (typeof UI_KINDS)[number];

export const UI_SEVERITIES = ['critical', 'serious', 'moderate', 'minor'] as const;
export type UiSeverity = (typeof UI_SEVERITIES)[number];

/** Accessibility rules the scan checks, each with the WCAG criterion it comes from. */
export const UI_RULES = {
  'img-alt': { severity: 'serious', wcag: '1.1.1', title: 'Image without a text alternative' },
  'control-name': { severity: 'critical', wcag: '4.1.2', title: 'Button or link without an accessible name' },
  'input-label': { severity: 'critical', wcag: '1.3.1', title: 'Form field without a label' },
  contrast: { severity: 'serious', wcag: '1.4.3', title: 'Text contrast below the minimum' },
  'heading-order': { severity: 'moderate', wcag: '1.3.1', title: 'Heading level skipped' },
  'no-h1': { severity: 'moderate', wcag: '2.4.6', title: 'Page has no level-one heading' },
  'html-lang': { severity: 'serious', wcag: '3.1.1', title: 'Page language not set' },
  'doc-title': { severity: 'serious', wcag: '2.4.2', title: 'Page has no title' },
  'duplicate-id': { severity: 'moderate', wcag: '4.1.1', title: 'Duplicate id' },
  'target-size': { severity: 'minor', wcag: '2.5.8', title: 'Click target smaller than 24 × 24 px' },
  'small-text': { severity: 'minor', wcag: '1.4.4', title: 'Text smaller than 12 px' },
  'no-main': { severity: 'moderate', wcag: '1.3.1', title: 'Page has no main landmark' },
  'positive-tabindex': { severity: 'minor', wcag: '2.4.3', title: 'Positive tabindex changes the tab order' },
  'zoom-disabled': { severity: 'serious', wcag: '1.4.4', title: 'Pinch zoom is disabled' },
} as const satisfies Record<string, { severity: UiSeverity; wcag: string; title: string }>;
export type UiRule = keyof typeof UI_RULES;
const RULE_IDS = Object.keys(UI_RULES) as [UiRule, ...UiRule[]];

const str = (max: number) => z.string().max(max);
const num = z.number().finite();

export const UiBox = z.object({ x: num, y: num, w: num.min(0), h: num.min(0) });
export type UiBox = z.infer<typeof UiBox>;

/** Computed styles a reviewer compares with the design. Colours are #rrggbb or #rrggbbaa. */
export const UiStyle = z.object({
  fontFamily: str(200),
  fontSize: num,
  fontWeight: str(10),
  lineHeight: str(20),
  letterSpacing: str(20),
  textTransform: str(20),
  textAlign: str(20),
  color: str(9),
  /** The colour actually behind the element: its own, or the first opaque one above it. */
  background: str(9),
  /** True when a background image or gradient sits behind it, so the contrast is not known. */
  backgroundImage: z.boolean(),
  border: str(120),
  borderRadius: str(60),
  padding: str(60),
  margin: str(60),
  display: str(30),
  position: str(20),
  zIndex: str(12),
  opacity: num,
});
export type UiStyle = z.infer<typeof UiStyle>;

/** One element of the page tree. `parent` is another node's id; the root's is null. */
export const UiNode = z.object({
  id: z.number().int().min(0),
  parent: z.number().int().min(0).nullable(),
  depth: z.number().int().min(0),
  tag: str(40),
  kind: z.enum(UI_KINDS),
  role: str(60).nullable(),
  /** Accessible name as a screen reader would announce it; empty when it has none. */
  name: str(200),
  /** Its own visible text, cut short. */
  text: str(200),
  /** A short CSS path, for finding it again in DevTools. */
  selector: str(500),
  attrs: z.array(z.tuple([str(40), str(300)])).max(12),
  /** In document coordinates, so it stays right however the page is scrolled. */
  box: UiBox,
  style: UiStyle,
  /** Text contrast against its background; null when there is no text or the background is an image. */
  contrast: num.nullable(),
  focusable: z.boolean(),
  childCount: z.number().int().min(0),
});
export type UiNode = z.infer<typeof UiNode>;

export const UiIssue = z.object({
  rule: z.enum(RULE_IDS),
  /** The element it is about; null for a page-level issue (no title, no h1). */
  node: z.number().int().min(0).nullable(),
  message: str(300),
});
export type UiIssue = z.infer<typeof UiIssue>;

export const UiResource = z.object({ url: str(2_000), type: str(40), bytes: num.min(0), durationMs: num.min(0) });

/**
 * Page timings from the browser's own Performance API, in milliseconds; null when the browser has
 * none (a page that never finished loading, or one reached by in-app navigation).
 */
export const UiPerf = z.object({
  ttfb: num.nullable(),
  fcp: num.nullable(),
  lcp: num.nullable(),
  /** Cumulative Layout Shift: the worst session window, as Core Web Vitals counts it. */
  cls: num.nullable(),
  /** Total Blocking Time: the part of each long task over 50 ms, summed. */
  tbt: num.nullable(),
  domContentLoaded: num.nullable(),
  load: num.nullable(),
  domNodes: z.number().int().min(0),
  domDepth: z.number().int().min(0),
  requests: z.number().int().min(0),
  /** Transfer size where the server allows timing it; cross-origin files without Timing-Allow-Origin count 0. */
  bytes: num.min(0),
  byType: z.array(z.object({ type: str(40), count: z.number().int().min(0), bytes: num.min(0) })).max(20),
  largest: z.array(UiResource).max(8),
  slowest: z.array(UiResource).max(8),
  jsHeapMb: num.nullable(),
});
export type UiPerf = z.infer<typeof UiPerf>;

/** One scan of the active tab. */
export const UiScan = z.object({
  url: str(4_000),
  title: str(300),
  lang: str(40),
  viewport: z.object({ width: num, height: num }),
  document: z.object({ width: num, height: num }),
  nodes: z.array(UiNode).max(3_000),
  /** True when the page had more elements than a scan keeps. */
  truncated: z.boolean(),
  issues: z.array(UiIssue).max(1_000),
  perf: UiPerf,
});
export type UiScan = z.infer<typeof UiScan>;

// ---------- AI review ----------

export const UI_AREAS = ['typography', 'colour', 'layout', 'consistency', 'accessibility', 'performance', 'content'] as const;
export type UiArea = (typeof UI_AREAS)[number];

const Count = z.object({ value: str(200), count: z.number().int().min(0) });

/**
 * What the web app sends for an AI review: the scan summarised, not the whole tree. Everything a
 * page showed is masked again on the server before it goes to a model.
 */
export const UiReviewBody = z.object({
  url: str(4_000),
  title: str(300),
  device: str(60),
  viewport: z.object({ width: num, height: num }),
  stats: z.object({
    elements: z.number().int().min(0),
    fonts: z.array(Count).max(20),
    sizes: z.array(Count).max(40),
    weights: z.array(Count).max(12),
    colours: z.array(Count).max(40),
    backgrounds: z.array(Count).max(40),
    radii: z.array(Count).max(20),
    kinds: z.array(Count).max(UI_KINDS.length),
  }),
  perf: UiPerf.omit({ largest: true, slowest: true }),
  issues: z.array(z.object({ rule: z.enum(RULE_IDS), count: z.number().int().min(1), example: str(300) })).max(RULE_IDS.length),
  /** Headings, buttons and fields: where design drift shows first. */
  sample: z
    .array(z.object({ kind: z.enum(UI_KINDS), element: str(300), font: str(200), colour: str(20), background: str(20), size: str(40), radius: str(60) }))
    .max(60),
  /** What the tester found by hand, so the model does not repeat it. */
  findings: z.array(z.object({ title: str(200), note: str(1_000), element: str(300) })).max(40),
  /** What the tester wants the review to focus on. */
  focus: str(1_000).default(''),
});
export type UiReviewBody = z.infer<typeof UiReviewBody>;

export const UiSuggestion = z.object({
  area: z.enum(UI_AREAS),
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string().min(2).max(200),
  detail: z.string().max(1_000),
  /** The element it is about, as it was named in the input; empty for the page as a whole. */
  element: z.string().max(300).default(''),
});
export type UiSuggestion = z.infer<typeof UiSuggestion>;

export const UiReviewAnswer = z.object({
  summary: z.string().max(2_000),
  suggestions: z.array(UiSuggestion).max(25),
});
export type UiReviewAnswer = z.infer<typeof UiReviewAnswer>;

export interface UiReviewResult extends UiReviewAnswer {
  ai: { status: 'used' | 'off' | 'unavailable'; message: string | null };
}
