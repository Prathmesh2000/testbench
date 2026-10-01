'use client';

import type { ApiWorkflow, AskResult, AssistAi, ExplainResult, PlanResult } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import g from './graph.module.css';

// The API assistant (plan §16): explain routes, turn a requirement into a chain of calls, and answer
// questions about the project's APIs. Answers come from rules over the specs; the model, when allowed,
// writes the words. Anything it names is checked against the specs first.

type Mode = 'explain' | 'plan' | 'ask';

const MODES: [Mode, string, string][] = [
  ['explain', 'Explain routes', 'Paste routes, cURL, router code or a HAR file'],
  ['plan', 'From a requirement', 'Which API, or chain of APIs, does this?'],
  ['ask', 'Ask', 'Why a 401? Which API gives the invoice?'],
];

function AiNote({ ai }: { ai: AssistAi }) {
  if (ai.status === 'used') return <span className="t3" style={{ fontSize: 11.5 }}><Icon name="sparkle" size={11} /> AI draft ({ai.message}): check it before relying on it.</span>;
  return <span className="t3" style={{ fontSize: 11.5 }}>Answered by rules from your specs, no AI. {ai.message ?? ''}</span>;
}

export function AssistantView({ projectBase, base, workspaceId, historyId, canEdit, onOpenWorkflow }: {
  projectBase: string;
  base: string | null;
  workspaceId: string | null;
  /** The last send, for "why did this fail". */
  historyId: string | null;
  canEdit: boolean;
  onOpenWorkflow(id: string): void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [mode, setMode] = useState<Mode>('explain');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [useLast, setUseLast] = useState(true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'explain') setExplain(await api<ExplainResult>('POST', `${projectBase}/assistant/explain`, { text }));
      else if (mode === 'plan') setPlan(await api<PlanResult>('POST', `${projectBase}/assistant/plan`, { requirement: text }));
      else if (base) setAsk(await api<AskResult>('POST', `${base}/assistant/ask`, { question: text, historyId: useLast ? historyId : null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The assistant could not answer');
    } finally {
      setBusy(false);
    }
  };

  const makeWorkflow = async (steps: string[], name: string) => {
    if (!base) return notify('Pick or make a workspace first', 'bad');
    try {
      const wf = await api<ApiWorkflow>('POST', `${base}/assistant/workflow`, { name, steps });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'workflows', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });
      onOpenWorkflow(wf.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not make the workflow', 'bad');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className={g.bar}>
        <b style={{ fontSize: 13 }}>API assistant</b>
        <div className="seg" role="radiogroup" aria-label="What to ask">
          {MODES.map(([m, label]) => <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{label}</button>)}
        </div>
        <span className="t3" style={{ fontSize: 12 }}>{MODES.find(([m]) => m === mode)![2]}</span>
      </div>
      <div style={{ overflow: 'auto', flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 980 }}>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="inp"
            style={{ height: mode === 'explain' ? 110 : 64, padding: 8, fontFamily: mode === 'explain' ? 'var(--font-mono), monospace' : undefined, resize: 'vertical' }}
            value={text}
            aria-label={MODES.find(([m]) => m === mode)![1]}
            placeholder={mode === 'explain' ? "GET /orders/{id}\nrouter.post('/orders', create)\ncurl -X DELETE https://api.example.com/orders/1" : mode === 'plan' ? 'A customer can cancel an order before it ships and gets a refund.' : 'Why does this return 403?'}
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn primary" disabled={busy || text.trim().length < 3 || (mode === 'ask' && !base)}>{busy ? 'Thinking…' : mode === 'explain' ? 'Explain' : mode === 'plan' ? 'Find the calls' : 'Ask'}</button>
            {mode === 'ask' && historyId && <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={useLast} onChange={(e) => setUseLast(e.target.checked)} /> Include my last send as context</label>}
          </div>
        </form>
        {error && <div className="err" role="alert">{error}</div>}

        {mode === 'explain' && explain && (
          <>
            {explain.routes.length === 0 && <div className="t3">No routes found in that text. Lines like “GET /orders/{'{id}'}”, router code or cURL commands work.</div>}
            {explain.routes.map((r) => (
              <div key={r.key} className={g.card}>
                <div className={g.row}><b className={g.mono}>{r.key}</b>{!r.known && <span className="lbl" style={{ color: 'var(--blocked)' }}>not in your specs</span>}{r.security.length > 0 && <span className="lbl">auth: {r.security.join(', ')}</span>}</div>
                <div>{r.purpose}</div>
                {r.inputs.length > 0 && <div className="t2" style={{ fontSize: 12.5 }}>Inputs: <span className={g.mono}>{r.inputs.join(', ')}</span></div>}
                {r.dependsOn.length > 0 && <div className="t2" style={{ fontSize: 12.5 }}>Needs: {r.dependsOn.map((d) => `${d.param}${d.field ? ` (${d.field})` : ''} from ${d.key}`).join('; ')}</div>}
                {r.feeds.length > 0 && <div className="t2" style={{ fontSize: 12.5 }}>Feeds: {r.feeds.join('; ')}</div>}
                <div style={{ fontSize: 12.5 }}><b>What to test</b><ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{r.whatToTest.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
                {r.gaps.length > 0 && <div className="t2" style={{ fontSize: 12.5, color: 'var(--blocked)' }}>Gaps: {r.gaps.join('; ')}</div>}
              </div>
            ))}
            {explain.unread > 0 && <div className="t3" style={{ fontSize: 12 }}>{explain.unread} lines were not routes.</div>}
            <AiNote ai={explain.ai} />
          </>
        )}

        {mode === 'plan' && plan && (
          <>
            <div className={g.card}>
              <b>{plan.chosen === null ? 'No documented calls meet this requirement' : 'Calls that meet it'}</b>
              <div>{plan.explanation}</div>
              {plan.gaps.length > 0 && <div className="t2" style={{ fontSize: 12.5, color: 'var(--blocked)' }}>Not covered by any API: {plan.gaps.join('; ')}. Ask the API owners, or add it to the spec.</div>}
            </div>
            {plan.chains.map((c) => (
              <div key={c.index} className={g.card} style={plan.chosen === c.index ? { borderColor: 'var(--accent)' } : undefined}>
                <div className={g.row}>
                  <b>{plan.chosen === c.index ? 'Best match' : `Option ${c.index + 1}`}</b>
                  <span className="t3" style={{ fontSize: 12 }}>{c.why}</span>
                  <div className="f1" />
                  {canEdit && <button className="btn sm" onClick={() => makeWorkflow(c.steps, text.slice(0, 80))}><Icon name="plus" size={12} />Make workflow</button>}
                </div>
                <ol style={{ margin: 0, paddingLeft: 18 }}>{c.steps.map((s, i) => <li key={i} className={g.mono}>{s}</li>)}</ol>
              </div>
            ))}
            <AiNote ai={plan.ai} />
          </>
        )}

        {mode === 'ask' && ask && (
          <div className={g.card}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{ask.answer}</div>
            {ask.operations.length > 0 && <div className="t2" style={{ fontSize: 12.5 }}>Operations: <span className={g.mono}>{ask.operations.join(', ')}</span></div>}
            <AiNote ai={ask.ai} />
          </div>
        )}
      </div>
    </div>
  );
}
