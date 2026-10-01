import type { SuiteResult, SuiteRunTotals } from '@tb/contracts';

// Pure parts of suites (plan §13): cron schedules, the retry and flaky rules, totals and JUnit XML.

// ---------- cron ----------

export class CronError extends Error {}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function field(text: string, [min, max]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new CronError(`"${part}" is not valid in the ${name} field.`);
    const step = m[3] ? Number(m[3]) : 1;
    const from = m[1] === '*' ? min : Number(m[1]);
    const to = m[2] ? Number(m[2]) : m[1] === '*' ? max : m[3] ? max : from;
    if (from < min || to > max || from > to || step < 1) throw new CronError(`${part} is out of range for the ${name} field (${min}-${max}).`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** "minute hour day-of-month month day-of-week", the usual five fields. Times are in IST. */
export function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('A schedule has five fields: minute hour day month weekday, like "0 2 * * *".');
  const names = ['minute', 'hour', 'day', 'month', 'weekday'];
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, RANGES[i]!, names[i]!));
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday!, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' };
}

const IST_MS = 330 * 60_000;

/** The first time after `from` that matches, as an absolute instant; the fields are read in IST. */
export function nextRun(expr: string, from: Date): Date {
  const c = parseCron(expr);
  // Work in IST wall-clock time by shifting, then shift back.
  let t = new Date(Math.floor((from.getTime() + IST_MS) / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = c.anyDay && c.anyWeekday ? true : c.anyDay ? c.weekday.has(t.getUTCDay()) : c.anyWeekday ? c.day.has(t.getUTCDate()) : c.day.has(t.getUTCDate()) || c.weekday.has(t.getUTCDay());
    if (c.month.has(t.getUTCMonth() + 1) && dayOk && c.hour.has(t.getUTCHours()) && c.minute.has(t.getUTCMinutes())) return new Date(t.getTime() - IST_MS);
    t = new Date(t.getTime() + 60_000);
  }
  throw new CronError('That schedule never runs.');
}

// ---------- results ----------

/**
 * One unit's outcome from its attempts: passed if the last attempt passed, flaky if an earlier one
 * failed. Flaky is not passed for reporting; it is its own number, so it gets looked at.
 */
export function settle(attempts: boolean[]): { status: 'passed' | 'failed'; flaky: boolean } {
  const passed = attempts.at(-1) === true;
  return { status: passed ? 'passed' : 'failed', flaky: passed && attempts.slice(0, -1).some((a) => !a) };
}

export function totals(results: Pick<SuiteResult, 'status' | 'flaky' | 'durationMs' | 'driftIssues'>[]): SuiteRunTotals {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.ceil((p / 100) * durations.length) - 1)]! : 0);
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed' && !r.flaky).length,
    flaky: results.filter((r) => r.flaky).length,
    failed: results.filter((r) => r.status === 'failed').length,
    errored: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    drift: results.reduce((n, r) => n + r.driftIssues, 0),
    p50Ms: pct(50),
    p95Ms: pct(95),
  };
}

/** XML-escaped, with the control characters XML 1.0 does not allow dropped (they break CI parsers). */
const xml = (s: string) =>
  [...s]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** JUnit XML, which every CI shows: one testcase per result, failures with their message. */
export function junit(suiteName: string, results: SuiteResult[], startedAt: string): string {
  const t = totals(results);
  const cases = results.map((r) => {
    const name = xml(`${r.name}${r.row !== null ? ` [row ${r.row + 1}]` : ''}`);
    const time = (r.durationMs / 1000).toFixed(3);
    const body =
      r.status === 'failed'
        ? `<failure message="${xml(r.message.slice(0, 500))}">${xml(r.message)}</failure>`
        : r.status === 'error'
          ? `<error message="${xml(r.message.slice(0, 500))}">${xml(r.message)}</error>`
          : r.status === 'skipped'
            ? '<skipped/>'
            : r.flaky
              ? `<system-out>Passed after ${r.attempts} attempts (flaky).</system-out>`
              : '';
    return `    <testcase classname="${xml(suiteName)}.${xml(r.group)}" name="${name}" time="${time}">${body}</testcase>`;
  });
  const seconds = (results.reduce((n, r) => n + r.durationMs, 0) / 1000).toFixed(3);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(suiteName)}" tests="${t.total}" failures="${t.failed}" errors="${t.errored}" skipped="${t.skipped}" time="${seconds}">`,
    `  <testsuite name="${xml(suiteName)}" tests="${t.total}" failures="${t.failed}" errors="${t.errored}" skipped="${t.skipped}" time="${seconds}" timestamp="${startedAt}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

/** Runs async work with at most `limit` at a time, in order of the list. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A run as one self-contained HTML page: summary, then every result. No scripts or outside assets, so
 * it can be attached to a ticket or printed to PDF as it is.
 */
export function htmlReport(suiteName: string, run: { status: string; trigger: string; startedAt: string; finishedAt: string | null; results: SuiteResult[] }, generatedAt: string): string {
  const t = totals(run.results);
  const colour: Record<string, string> = { passed: '#15803d', failed: '#b91c1c', error: '#b91c1c', skipped: '#6b7280' };
  const rows = run.results
    .map(
      (r) => `<tr><td><span style="color:${colour[r.status]}">${r.flaky ? 'flaky' : r.status}</span></td><td>${html(r.group)}</td><td>${html(r.name)}${r.row !== null ? ` <small>row ${r.row + 1}</small>` : ''}</td><td>${r.method ?? ''}</td><td>${r.httpStatus ?? ''}</td><td>${r.durationMs} ms</td><td>${r.attempts}</td><td>${r.driftIssues || ''}</td><td>${html(r.message)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(suiteName)}: ${html(run.status)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:24px;max-width:1200px}
h1{font-size:20px;margin:0 0 4px}.meta{color:#555;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.card{border:1px solid #ddd;border-radius:8px;padding:8px 14px}
.card b{display:block;font-size:20px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}
th{background:#f6f6f6}small{color:#777}
</style></head><body>
<h1>${html(suiteName)}</h1>
<div class="meta">${html(run.status.toUpperCase())} · ${html(run.trigger)} run · started ${html(run.startedAt)}${run.finishedAt ? ` · finished ${html(run.finishedAt)}` : ''} · report made ${html(generatedAt)}</div>
<div class="cards">
<div class="card">Total<b>${t.total}</b></div><div class="card">Passed<b style="color:#15803d">${t.passed}</b></div><div class="card">Flaky<b style="color:#b45309">${t.flaky}</b></div>
<div class="card">Failed<b style="color:#b91c1c">${t.failed + t.errored}</b></div><div class="card">Skipped<b>${t.skipped}</b></div>
<div class="card">p50 / p95<b>${t.p50Ms} / ${t.p95Ms} ms</b></div><div class="card">Spec differences<b>${t.drift}</b></div>
</div>
<table><thead><tr><th>Result</th><th>Group</th><th>Test</th><th>Method</th><th>Status</th><th>Time</th><th>Tries</th><th>Drift</th><th>Message</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>
`;
}
