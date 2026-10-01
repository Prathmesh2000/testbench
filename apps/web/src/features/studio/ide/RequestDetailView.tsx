'use client';

import type { RequestDetail } from '@tb/contracts';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import s from './ide.module.css';

type View = 'headers' | 'payload' | 'response' | 'timing' | 'messages';

/** JSON shown indented, anything else as it came. */
export function Pretty({ text }: { text: string }) {
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON: shown as is.
  }
  return <pre className={s.code}>{shown}</pre>;
}

function Pairs({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className={s.pairs}>
      <b>{title} ({rows.length})</b>
      {rows.length === 0 ? (
        <span className="t3">None</span>
      ) : (
        rows.map(([k, v], i) => (
          <div key={`${k}-${i}`} className={s.pair}>
            <span className={s.pairKey}>{k}</span>
            <span className={s.pairVal}>{v}</span>
          </div>
        ))
      )}
    </section>
  );
}

function queryOf(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

/** A form body as its fields; null when the body is not form-encoded. */
function formOf(body: string, contentType: string | undefined): Array<[string, string]> | null {
  if (!contentType?.includes('x-www-form-urlencoded')) return null;
  return [...new URLSearchParams(body).entries()];
}

/**
 * One request as DevTools shows it: headers, what was sent, what came back and where the time went.
 * `detail` is undefined while it loads and null when the browser no longer has the request.
 */
export function RequestDetailView({
  detail,
  reveal,
  onReveal,
  onClose,
}: {
  detail: RequestDetail | null | undefined;
  reveal: boolean;
  onReveal(on: boolean): void;
  onClose(): void;
}) {
  const [view, setView] = useState<View>('headers');
  if (detail === undefined) return <div className={`${s.detail} t3`}>Loading…</div>;
  if (detail === null)
    return (
      <div className={`${s.detail} t3`}>
        The browser no longer has this request (its tab closed, or it is older than the last 1,000).
        <button className="ib sm" aria-label="Close details" onClick={onClose}><Icon name="x" size={11} /></button>
      </div>
    );

  const isSocket = detail.resourceType === 'websocket';
  const views: View[] = isSocket ? ['messages'] : ['headers', 'payload', 'response', 'timing'];
  const current = views.includes(view) ? view : views[0]!;
  const reqType = detail.requestHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  const query = queryOf(detail.url);
  const form = detail.postData ? formOf(detail.postData, reqType) : null;
  const t = detail.timing;
  const total = t ? t.dns + t.connect + t.tls + t.wait + t.download : 0;

  return (
    <div className={s.detail}>
      <div className={s.detailBar} role="tablist" aria-label="Request details">
        {views.map((v) => (
          <button key={v} role="tab" aria-selected={current === v} onClick={() => setView(v)}>
            {v[0]!.toUpperCase() + v.slice(1)}
          </button>
        ))}
        <div className="f1" />
        <label className="row t3" style={{ gap: 4, fontSize: 11 }} title="Show authorization headers, cookies, tokens and personal data as they are. Only you see them; nothing is stored.">
          <input type="checkbox" checked={reveal} onChange={(e) => onReveal(e.target.checked)} /> Show sensitive values
        </label>
        <button className="ib sm" aria-label="Close details" onClick={onClose}><Icon name="x" size={11} /></button>
      </div>
      <div className={s.detailBody}>
        {current === 'headers' && (
          <>
            <Pairs
              title="General"
              rows={[
                ['Request URL', detail.url],
                ['Method', detail.method],
                ['Status', detail.status === null ? 'failed' : `${detail.status} ${detail.statusText}`.trim()],
                ['Type', detail.resourceType],
                ...(detail.remoteAddress ? ([['Remote address', detail.remoteAddress]] as Array<[string, string]>) : []),
              ]}
            />
            <Pairs title="Response headers" rows={detail.responseHeaders} />
            <Pairs title="Request headers" rows={detail.requestHeaders} />
          </>
        )}
        {current === 'payload' && (
          <>
            {query.length > 0 && <Pairs title="Query string" rows={query} />}
            {form ? (
              <Pairs title="Form data" rows={form} />
            ) : detail.postData ? (
              <section className={s.pairs}>
                <b>Request body</b>
                <Pretty text={detail.postData} />
              </section>
            ) : null}
            {!query.length && !detail.postData && <span className="t3">Nothing was sent with this request.</span>}
          </>
        )}
        {current === 'response' && (detail.body !== null ? <Pretty text={detail.body} /> : <span className="t3">{detail.bodyNote}</span>)}
        {current === 'timing' &&
          (t ? (
            <section className={s.pairs}>
              {(
                [
                  ['DNS lookup', t.dns],
                  ['Connecting', t.connect],
                  ['TLS', t.tls],
                  ['Waiting for server', t.wait],
                  ['Downloading', t.download],
                ] as const
              ).map(([label, ms]) => (
                <div key={label} className={s.timingRow}>
                  <span>{label}</span>
                  <span className={s.timingBar}><span style={{ width: `${total ? (ms / total) * 100 : 0}%` }} /></span>
                  <span className="t3">{ms} ms</span>
                </div>
              ))}
              <span className="t3">Total {total} ms. A reused connection skips DNS, connecting and TLS.</span>
            </section>
          ) : (
            <span className="t3">No timing for this request.</span>
          ))}
        {current === 'messages' &&
          (detail.messages.length ? (
            <section className={s.pairs}>
              {detail.messages.map((m, i) => (
                <div key={i} className={s.pair}>
                  <span className={s.pairKey}>{m.dir === 'sent' ? '↑ sent' : '↓ received'}</span>
                  <span className={s.pairVal}>{m.data}</span>
                </div>
              ))}
            </section>
          ) : (
            <span className="t3">No messages yet.</span>
          ))}
        {detail.masked && current !== 'timing' && (
          <span className="t3" style={{ fontSize: 10.5 }}>
            Credentials and personal data are masked (••••). Tick Show sensitive values to see them.
          </span>
        )}
      </div>
    </div>
  );
}
