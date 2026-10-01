import type { Severity, Step } from '@tb/contracts';

// Jira issue content built from an executed run item. Pure, so the exact text a developer receives
// is covered by tests.

/** Atlassian Document Format: Jira Cloud's rich-text JSON. Only the node types we need. */
export type AdfNode =
  | { type: 'paragraph'; content: AdfInline[] }
  | { type: 'heading'; attrs: { level: number }; content: AdfInline[] }
  | { type: 'orderedList' | 'bulletList'; content: { type: 'listItem'; content: AdfNode[] }[] }
  | { type: 'codeBlock'; attrs: { language: string }; content: { type: 'text'; text: string }[] };
type AdfInline = { type: 'text'; text: string; marks?: { type: 'strong' | 'code' }[] };
export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const text = (t: string, strong = false): AdfInline => ({
  type: 'text',
  text: t,
  ...(strong && { marks: [{ type: 'strong' }] }),
});
const para = (...parts: AdfInline[]): AdfNode => ({
  type: 'paragraph',
  content: parts.filter((p) => p.text),
});
const heading = (t: string): AdfNode => ({ type: 'heading', attrs: { level: 3 }, content: [text(t)] });

const kind = (contentType: string) =>
  contentType.startsWith('image/')
    ? 'screenshot'
    : contentType.startsWith('video/')
      ? 'recording'
      : contentType === 'application/pdf'
        ? 'PDF'
        : contentType.startsWith('text/')
          ? 'log'
          : 'file';
const size = (bytes: number) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export interface BugContext {
  caseKey: string;
  caseTitle: string;
  runKey: string;
  runName: string;
  environment: string;
  build: string;
  config: string;
  preconditions: string;
  steps: Step[];
  /** Index of the failed or blocked step, or -1 when the tester logs a bug without one. */
  failedAt: number;
  actual: string | null;
  /** The data-set row this item ran with, already masked; null when the case has no data set. */
  data: Record<string, string> | null;
  /** Evidence being attached to the issue. */
  evidence: { fileName: string; contentType: string; sizeBytes: number }[];
  reporter: string;
  link: string;
}

/** Steps up to and including the failure: everything after it was never reached. */
export function reproSteps(ctx: BugContext): Step[] {
  return ctx.steps.slice(0, ctx.failedAt === -1 ? ctx.steps.length : ctx.failedAt + 1);
}

export function bugDescription(ctx: BugContext): AdfDoc {
  const failed = ctx.failedAt === -1 ? null : ctx.steps[ctx.failedAt]!;
  const content: AdfNode[] = [
    para(text('Environment: ', true), text(`${ctx.environment} · build ${ctx.build} · ${ctx.config}`)),
    para(
      text('Found by: ', true),
      text(`${ctx.caseKey} ${ctx.caseTitle} in ${ctx.runKey} (${ctx.runName}), reported by ${ctx.reporter}`),
    ),
  ];
  if (ctx.preconditions.trim())
    content.push(para(text('Preconditions: ', true), text(ctx.preconditions.trim())));
  content.push(heading('Steps to reproduce'), {
    type: 'orderedList',
    content: reproSteps(ctx).map((s) => ({
      type: 'listItem',
      content: [para(text(s.data ? `${s.action} [${s.data}]` : s.action))],
    })),
  });
  if (failed) {
    content.push(para(text('Expected: ', true), text(failed.expected || '—')));
    content.push(para(text('Actual: ', true), text(ctx.actual || '—')));
  }
  if (ctx.data && Object.keys(ctx.data).length)
    content.push(
      para(
        text('Test data: ', true),
        text(
          Object.entries(ctx.data)
            .map(([k, v]) => `${k} = ${v}`)
            .join(' · '),
        ),
      ),
    );
  if (ctx.evidence.length) {
    // The files arrive as attachments shortly after the issue; this list says what each one is, and
    // still tells the developer what exists if one was too large for the site and stayed a link.
    content.push(heading('Attachments'), {
      type: 'bulletList',
      content: ctx.evidence.map((e) => ({
        type: 'listItem',
        content: [para(text(`${e.fileName} (${kind(e.contentType)}, ${size(e.sizeBytes)})`))],
      })),
    });
  }
  content.push(para(text('Open in Testbench (optional): ', true), text(ctx.link)));
  return { type: 'doc', version: 1, content };
}

/** Short Jira comment, e.g. when the same bug turns up again in another run. */
export function commentDoc(message: string): AdfDoc {
  return { type: 'doc', version: 1, content: [para(text(message))] };
}

/** Jira's default priority scheme, mapped from our severities. */
export const JIRA_PRIORITY: Record<Severity, string> = {
  Blocker: 'Highest',
  Critical: 'High',
  Major: 'Medium',
  Minor: 'Low',
  Trivial: 'Lowest',
};
