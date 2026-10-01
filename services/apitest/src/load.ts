import type { ApiAssertion, LoadEndpointStats, LoadMetrics, LoadProfile, LoadSecond, LoadStage, LoadThresholds, LoadVerdict } from '@tb/contracts';

import { evaluate } from './assert';

// The load engine's pure parts (plan §14): how many virtual users there should be at each second, what
// a run measured, whether it met its thresholds, and the same test as a k6 script for more capacity.

/** Target points: users ramp linearly between them, so a step is two points at the same second. */
export function stagesFor(profile: LoadProfile, vus: number, seconds: number): LoadStage[] {
  const at = (f: number) => Math.round(seconds * f);
  const v = (f: number) => Math.max(1, Math.round(vus * f));
  switch (profile) {
    case 'smoke': {
      const n = Math.min(2, vus);
      return [{ at: 0, vus: n }, { at: seconds, vus: n }];
    }
    case 'load':
      return [{ at: 0, vus: 0 }, { at: at(0.2), vus }, { at: at(0.8), vus }, { at: seconds, vus: 0 }];
    case 'stress':
      return [
        { at: 0, vus: v(0.25) }, { at: at(0.25), vus: v(0.25) },
        { at: at(0.25), vus: v(0.5) }, { at: at(0.5), vus: v(0.5) },
        { at: at(0.5), vus: v(0.75) }, { at: at(0.75), vus: v(0.75) },
        { at: at(0.75), vus }, { at: seconds, vus },
      ];
    case 'spike':
      return [{ at: 0, vus: v(0.1) }, { at: at(0.4), vus: v(0.1) }, { at: at(0.4), vus }, { at: at(0.6), vus }, { at: at(0.6), vus: v(0.1) }, { at: seconds, vus: v(0.1) }];
    case 'soak':
      return [{ at: 0, vus: 0 }, { at: at(0.1), vus }, { at: at(0.9), vus }, { at: seconds, vus: 0 }];
  }
}

export function vusAt(stages: LoadStage[], t: number): number {
  if (!stages.length) return 0;
  if (t <= stages[0]!.at) return stages[0]!.vus;
  for (let i = 1; i < stages.length; i++) {
    const a = stages[i - 1]!;
    const b = stages[i]!;
    if (t <= b.at) return b.at === a.at ? b.vus : Math.round(a.vus + ((b.vus - a.vus) * (t - a.at)) / (b.at - a.at));
  }
  return stages[stages.length - 1]!.vus;
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

const asc = (a: number[]) => [...a].sort((x, y) => x - y);
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Bucket {
  vus: number;
  latencies: number[];
  errors: number;
}

/** Collects what each request took, per endpoint and per second, and turns it into the stored metrics. */
export class Collector {
  private endpoints = new Map<string, { name: string; latencies: number[]; errors: number; overall: boolean }>();
  private seconds = new Map<number, Bucket>();
  private bytes = 0;

  /**
   * `whole` marks a sample that is a whole workflow run rather than one request: it is listed with the
   * endpoints but kept out of the totals, the timeline and the abort limits, which are about requests.
   */
  record(s: { key: string; name: string; second: number; vus: number; ms: number; ok: boolean; bytes: number; whole?: boolean }) {
    const e = this.endpoints.get(s.key) ?? { name: s.name, latencies: [], errors: 0, overall: !s.whole };
    e.latencies.push(s.ms);
    if (!s.ok) e.errors++;
    this.endpoints.set(s.key, e);
    if (s.whole) return;
    const b = this.seconds.get(s.second) ?? { vus: s.vus, latencies: [], errors: 0 };
    b.vus = Math.max(b.vus, s.vus);
    b.latencies.push(s.ms);
    if (!s.ok) b.errors++;
    this.seconds.set(s.second, b);
    this.bytes += s.bytes;
  }

  /** The last `window` seconds up to `now`: what the abort limits are judged on. */
  recent(now: number, window: number): { requests: number; errorPercent: number; p95: number } {
    const lat: number[] = [];
    let errors = 0;
    for (const [t, b] of this.seconds) {
      if (t > now - window) {
        lat.push(...b.latencies);
        errors += b.errors;
      }
    }
    return { requests: lat.length, errorPercent: lat.length ? round1((errors / lat.length) * 100) : 0, p95: percentile(asc(lat), 95) };
  }

  snapshot(elapsedSeconds: number): LoadMetrics {
    const all: number[] = [];
    let errors = 0;
    const endpoints: LoadEndpointStats[] = [];
    for (const [key, e] of this.endpoints) {
      const s = asc(e.latencies);
      if (e.overall) {
        all.push(...e.latencies);
        errors += e.errors;
      }
      endpoints.push({ key, name: e.name, requests: s.length, errors: e.errors, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] ?? 0 });
    }
    endpoints.sort((a, b) => b.p95 - a.p95);
    const sorted = asc(all);
    const timeline: LoadSecond[] = [...this.seconds.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({ t, vus: b.vus, rps: b.latencies.length, errors: b.errors, p95: percentile(asc(b.latencies), 95) }));
    return {
      requests: sorted.length,
      errors,
      errorPercent: sorted.length ? round1((errors / sorted.length) * 100) : 0,
      rps: elapsedSeconds > 0 ? round1(sorted.length / elapsedSeconds) : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
      bytes: this.bytes,
      endpoints,
      timeline,
    };
  }
}

export function judge(m: LoadMetrics, t: LoadThresholds): LoadVerdict[] {
  const out: LoadVerdict[] = [];
  if (t.p95Ms !== null) out.push({ name: `p95 under ${t.p95Ms} ms`, passed: m.p95 <= t.p95Ms, detail: `p95 was ${m.p95} ms` });
  if (t.errorPercent !== null) out.push({ name: `errors under ${t.errorPercent}%`, passed: m.errorPercent <= t.errorPercent, detail: `${m.errorPercent}% of ${m.requests} requests failed` });
  if (t.minRps !== null) out.push({ name: `at least ${t.minRps} requests/s`, passed: m.rps >= t.minRps, detail: `${m.rps} requests/s` });
  if (!m.requests) out.push({ name: 'sent requests', passed: false, detail: 'No request completed.' });
  return out;
}

/** The reason to stop early, from the last ten seconds, or null. Needs enough traffic to mean something. */
export function abortReason(recent: { requests: number; errorPercent: number; p95: number }, abort: { errorPercent: number; p95Ms: number | null }): string | null {
  if (recent.requests < 20) return null;
  if (recent.errorPercent >= abort.errorPercent) return `Stopped early: ${recent.errorPercent}% of the last requests failed (limit ${abort.errorPercent}%).`;
  if (abort.p95Ms !== null && recent.p95 >= abort.p95Ms) return `Stopped early: p95 reached ${recent.p95} ms (limit ${abort.p95Ms} ms).`;
  return null;
}

export function compareRuns(prev: { id: string; metrics: Pick<LoadMetrics, 'p95' | 'errorPercent' | 'rps'> }, cur: Pick<LoadMetrics, 'p95' | 'errorPercent' | 'rps'>) {
  return { previousId: prev.id, p95Delta: cur.p95 - prev.metrics.p95, errorDelta: round1(cur.errorPercent - prev.metrics.errorPercent), rpsDelta: round1(cur.rps - prev.metrics.rps) };
}

export interface K6Request {
  name: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
  /** Values to keep from the response for the requests after it in the same iteration: $.a.b[0] paths. */
  assign?: { variable: string; path: string }[];
  /** A workflow's requests share a group and the values assigned in it. */
  workflow?: string;
}

/** A JSONPath of plain keys and indexes as a JavaScript accessor; null when it needs wildcards or filters. */
export function jsAccessor(path: string, root = 'j'): string | null {
  if (path === '$') return root;
  if (!/^\$(\.[A-Za-z_][\w-]*|\[\d+\])+$/.test(path)) return null;
  return root + path.slice(1).replace(/\.([A-Za-z_][\w-]*)/g, (_m, k: string) => `[${JSON.stringify(k)}]`);
}

/**
 * The same test as a k6 script. Secret values never appear in it: each becomes an environment variable
 * to supply when running (`k6 run -e TB_SECRET_0=...`).
 */
export function k6Script(i: { name: string; stages: LoadStage[]; thresholds: LoadThresholds; requests: K6Request[]; secrets: string[] }): string {
  const lit = (s: string) => {
    let out = JSON.stringify(s);
    i.secrets.forEach((secret, n) => {
      if (secret) out = out.split(JSON.stringify(secret).slice(1, -1)).join(`" + __ENV.TB_SECRET_${n} + "`);
    });
    // A value a workflow step passes on (left as {{name}}, or percent-encoded inside a URL) is read from vars.
    return out.replace(/(?:\{\{|%7B%7B)\s*([\w.$-]+)\s*(?:\}\}|%7D%7D)/gi, (_m, name: string) => `" + (vars[${JSON.stringify(name)}] ?? "") + "`);
  };
  const stages: string[] = [];
  for (let n = 1; n < i.stages.length; n++) {
    const a = i.stages[n - 1]!;
    const b = i.stages[n]!;
    stages.push(`    { duration: '${Math.max(0, b.at - a.at)}s', target: ${b.vus} },`);
  }
  const th: string[] = [];
  if (i.thresholds.p95Ms !== null) th.push(`    http_req_duration: ['p(95)<${i.thresholds.p95Ms}'],`);
  if (i.thresholds.errorPercent !== null) th.push(`    http_req_failed: ['rate<${i.thresholds.errorPercent / 100}'],`);
  if (i.thresholds.minRps !== null) th.push(`    http_reqs: ['rate>${i.thresholds.minRps}'],`);
  const calls = i.requests.map((r) => {
    const headers = `{ ${r.headers.map(([k, v]) => `${lit(k)}: ${lit(v)}`).join(', ')} }`;
    const keep = (r.assign ?? []).flatMap((a) => {
      const acc = jsAccessor(a.path);
      return acc ? [`vars[${JSON.stringify(a.variable)}] = String(${acc});`] : [`// ${a.variable}: ${a.path} needs a script in k6`];
    });
    return `  group(${lit(r.workflow ? `${r.workflow} › ${r.name}` : r.name)}, () => {\n    const res = http.request(${lit(r.method)}, ${lit(r.url)}, ${r.body === null ? 'null' : lit(r.body)}, { headers: ${headers} });\n    check(res, { 'status below 400': (r) => r.status < 400 });${keep.length ? `\n    try {\n      const j = res.json();\n      ${keep.join('\n      ')}\n    } catch (e) {\n      // not JSON: nothing to keep\n    }` : ''}\n  });`;
  });
  const flows = [...new Set(i.requests.flatMap((r) => (r.workflow ? [r.workflow] : [])))];
  const flowNote = flows.length ? `// Workflows (${flows.map((f) => f.replace(/[\r\n]+/g, ' ')).join(', ')}): their requests run in order and pass values on. Only request steps are exported;\n// waits, conditions, loops and polling are not.\n` : '';
  const secretNote = i.secrets.length ? `// Secrets: set ${i.secrets.map((_, n) => `TB_SECRET_${n}`).join(', ')} as environment variables.\n` : '';
  return `// ${i.name.replace(/[\r\n]+/g, ' ')}: exported from Testbench.\n${secretNote}${flowNote}import http from 'k6/http';\nimport { check, group } from 'k6';\n\nexport const options = {\n  stages: [\n${stages.join('\n')}\n  ],\n  thresholds: {\n${th.join('\n')}\n  },\n};\n\nexport default function () {\n  const vars = {};\n${calls.join('\n')}\n}\n`;
}


/**
 * Whether an answer counts as a success under load: when the request checks its status (a step that
 * expects a 404, say) that decides, otherwise anything below 400 is fine.
 */
export function statusOk(assertions: ApiAssertion[], status: number): boolean {
  const checks = assertions.filter((a) => a.enabled && a.source === 'status');
  if (!checks.length) return status < 400;
  return evaluate(checks, { status, timeMs: 0, sizeBytes: 0, headers: [], bodyText: '', json: undefined }).every((r) => r.passed);
}
