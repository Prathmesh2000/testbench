import type { AutoItemStatus, AutoStepResult } from '@tb/contracts';
import { maskText } from '@tb/platform';

// Reads Playwright's JSON reporter output for one generated test. Only the parts Testbench shows are
// kept: the outcome, each test.step (the generator writes one per Testbench step) and attachments.

interface PwStep {
  title: string;
  duration: number;
  error?: { message?: string };
  category?: string;
}
interface PwResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  errors?: { message?: string }[];
  steps?: PwStep[];
  attachments?: { name: string; path?: string; contentType: string }[];
}
interface PwSuite {
  title?: string;
  specs?: { title: string; tests: { results: PwResult[] }[] }[];
  suites?: PwSuite[];
}
export interface PwReport {
  suites?: PwSuite[];
  errors?: { message?: string }[];
}

export interface Outcome {
  status: Extract<AutoItemStatus, 'passed' | 'failed' | 'skipped' | 'error'>;
  error: string | null;
  durationMs: number;
  steps: AutoStepResult[];
  attachments: { name: string; path: string; contentType: string }[];
}

// ANSI colour codes in Playwright's messages are noise outside a terminal.
// eslint-disable-next-line no-control-regex -- matching the ESC character is the point
const clean = (s: string | undefined) => (s ? maskText(s.replace(/\u001b\[[0-9;]*m/g, '')).slice(0, 4_000) : null);

/** Every test result in the report, with its full title ("describe › test"). */
function results(suites: PwSuite[] | undefined, path: string[] = []): { title: string; result: PwResult }[] {
  const out: { title: string; result: PwResult }[] = [];
  for (const s of suites ?? []) {
    const here = s.title && !/\.(spec|test)\.ts$/.test(s.title) ? [...path, s.title] : path;
    for (const spec of s.specs ?? [])
      for (const t of spec.tests) if (t.results[0]) out.push({ title: [...here, spec.title].join(' › '), result: t.results[0] });
    out.push(...results(s.suites, here));
  }
  return out;
}

const statusOf = (r: PwResult): Outcome['status'] =>
  r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : r.status === 'interrupted' ? 'error' : 'failed';

/**
 * One generated test reports its test.step blocks as steps. A spec file with several tests (written
 * in the code workspace) reports each test as a step instead, and fails if any of them fails.
 */
export function readReport(report: PwReport): Outcome {
  const all = results(report.suites);
  if (!all.length)
    return {
      status: 'error',
      error: clean(report.errors?.[0]?.message) ?? 'The test did not run',
      durationMs: 0,
      steps: [],
      attachments: [],
    };
  const attachments = all.flatMap(({ result }) =>
    (result.attachments ?? []).filter((a): a is { name: string; path: string; contentType: string } => !!a.path),
  );
  if (all.length === 1) {
    const r = all[0]!.result;
    return {
      status: statusOf(r),
      error: r.status === 'passed' ? null : clean(r.errors?.[0]?.message) ?? (r.status === 'timedOut' ? 'Timed out' : null),
      durationMs: Math.round(r.duration),
      steps: (r.steps ?? [])
        .filter((s) => s.category === undefined || s.category === 'test.step')
        .map((s) => ({
          title: s.title,
          status: s.error ? ('failed' as const) : ('passed' as const),
          durationMs: Math.round(s.duration),
          error: clean(s.error?.message),
        })),
      attachments,
    };
  }
  const statuses = all.map((x) => statusOf(x.result));
  const firstBad = all.find((x) => statusOf(x.result) === 'failed' || statusOf(x.result) === 'error');
  return {
    status: statuses.includes('error') ? 'error' : statuses.includes('failed') ? 'failed' : statuses.every((x) => x === 'skipped') ? 'skipped' : 'passed',
    error: firstBad ? `${firstBad.title}: ${clean(firstBad.result.errors?.[0]?.message) ?? 'failed'}` : null,
    durationMs: Math.round(all.reduce((n, x) => n + x.result.duration, 0)),
    steps: all.map(({ title, result }) => ({
      title,
      status: result.status === 'passed' ? ('passed' as const) : result.status === 'skipped' ? ('skipped' as const) : ('failed' as const),
      durationMs: Math.round(result.duration),
      error: result.status === 'passed' ? null : clean(result.errors?.[0]?.message),
    })),
    attachments,
  };
}
