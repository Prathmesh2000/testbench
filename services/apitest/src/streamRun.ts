import type { StreamResult } from '@tb/contracts';
import { badRequest } from '@tb/platform';
import { evaluate, extract } from './assert';
import { certFor } from './profiles';
import { maskHeaders, maskSecrets } from './resolve';
import { runStream, type StreamOutcome } from './stream';
import type { PreparedSend, SendConfig } from './send';

/** The messages that came in, as JSON where they parse, so JSONPath assertions read them: `$[0].type`. */
export function transcriptFacts(o: Pick<StreamOutcome, 'events' | 'status' | 'responseHeaders' | 'timings'>) {
  const messages = o.events
    .filter((e) => e.kind === 'in')
    .map((e) => {
      try {
        return JSON.parse(e.data) as unknown;
      } catch {
        return e.data;
      }
    });
  const bodyText = JSON.stringify(messages);
  return { status: o.status ?? 0, timeMs: o.timings.totalMs, sizeBytes: Buffer.byteLength(bodyText), headers: o.responseHeaders, bodyText, json: messages as unknown };
}

/**
 * Connects, listens and checks: no database and no transaction, since this can take as long as the
 * listening time. History is not kept for streams; the transcript lives in the builder until the next send.
 */
export async function performStream(p: PreparedSend, cfg: SendConfig): Promise<StreamResult> {
  const protocol = p.def.protocol;
  if (protocol !== 'ws' && protocol !== 'sse') throw badRequest('This request is not a WebSocket or SSE request.');
  if (p.profile) throw badRequest('Auth profiles are not used for WebSocket and SSE yet. Put the token in a header with a variable, or use bearer auth.');
  const secrets = p.secrets;
  const mask = (t: string) => maskSecrets(t, secrets);
  const stream = { listenMs: 5000, maxMessages: 50, ...p.def.stream };
  const base = { protocol, url: mask(p.request.url), unresolved: p.request.unresolved };
  const scriptErrors = p.pre?.errors.map((e) => ({ phase: 'pre' as const, source: e.source, message: mask(e.message) })) ?? [];
  const logs = p.pre?.logs.map((l) => ({ ...l, text: mask(l.text) })) ?? [];
  const empty = { status: null, responseHeaders: [], requestHeaders: maskHeaders(p.request.headers, secrets), events: [], closeCode: null, closeReason: null, truncated: false, assertions: [], extracted: {} };
  if (scriptErrors.length)
    return { ...base, ...empty, endedBy: 'error', timings: { connectMs: null, firstMessageMs: null, totalMs: 0 }, error: { code: 'script', message: `The pre-request script in the ${scriptErrors[0]!.source} failed, so nothing was sent: ${scriptErrors[0]!.message}` }, logs, scriptErrors };

  const out = await runStream({
    protocol,
    url: p.request.url,
    method: p.request.method,
    headers: p.request.headers,
    body: p.request.body,
    messages: p.request.messages ?? [],
    listenMs: stream.listenMs,
    maxMessages: stream.maxMessages,
    allowPrivate: cfg.allowPrivate,
    tls: p.certs.length ? certFor(p.certs, new URL(p.request.url.replace(/^ws/i, 'http'))) : null,
  });
  const facts = transcriptFacts(out);
  const connected = out.status !== null && (protocol === 'ws' ? out.status === 101 : out.status === 200);
  const assertions = connected || out.events.length ? evaluate(p.def.assertions, facts) : [];
  const extracted = connected ? extract(p.def.extractors, facts).values : {};
  return {
    ...base,
    status: out.status,
    responseHeaders: maskHeaders(out.responseHeaders, secrets),
    requestHeaders: maskHeaders(out.requestHeaders, secrets),
    events: out.events.map((e) => ({ ...e, data: mask(e.data) })),
    closeCode: out.closeCode,
    closeReason: out.closeReason,
    endedBy: out.endedBy,
    timings: out.timings,
    error: out.error,
    truncated: out.truncated,
    assertions,
    extracted: Object.fromEntries(Object.entries(extracted).map(([k, v]) => [k, mask(v)])),
    logs,
    scriptErrors,
  };
}
