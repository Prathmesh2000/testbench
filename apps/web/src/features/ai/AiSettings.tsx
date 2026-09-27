'use client';

import {
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  AI_TASK_LABELS,
  AI_TASKS,
  type AiConfigBody,
  type AiConfigView,
  type AiPolicy,
  type AiProvider,
  type AiTask,
  type AiUsageRow,
  type TaskConfig,
} from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, fmt, lakhs } from '@/lib/format';
import s from './ai.module.css';

const POLICIES: { value: AiPolicy; label: string; hint: string }[] = [
  { value: 'any', label: 'Any provider', hint: 'Tasks use the models configured below' },
  { value: 'allowed', label: 'Allowed list', hint: 'Only the providers ticked here' },
  { value: 'local_only', label: 'Local only', hint: 'Nothing leaves your network' },
  { value: 'off', label: 'Off', hint: 'AI features are disabled' },
];
const CLOUD = ['openai', 'anthropic', 'xai'] as const;

interface Draft {
  policy: AiPolicy;
  allowed: AiProvider[];
  overrides: Partial<Record<AiTask, TaskConfig>>;
  monthlyBudget: number;
}

const toDraft = (v: AiConfigView): Draft => ({
  policy: v.policy,
  allowed: v.allowed,
  overrides: Object.fromEntries(
    AI_TASKS.filter((t) => v.tasks[t].overridden).map((t) => {
      const { overridden: _o, ...cfg } = v.tasks[t];
      return [t, cfg];
    }),
  ),
  monthlyBudget: v.monthlyBudget,
});

const modelLabel = (m: { provider: AiProvider; model: string }) => `${AI_PROVIDER_LABELS[m.provider]} · ${m.model}`;

/**
 * Organisation-wide AI settings (HLD §2.3): policy, model per task, tenant keys and the monthly token
 * budget. Everyone who can use AI sees them; only Org Admins (ai.configure) can change them.
 */
export function AiSettings() {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const editable = can('ai.configure');
  const config = useQuery({ queryKey: ['ai-config', project.id], queryFn: () => get<AiConfigView>(`/projects/${project.id}/ai/config`) });
  const usage = useQuery({
    queryKey: ['ai-usage', project.id],
    queryFn: () => get<AiUsageRow[]>(`/projects/${project.id}/ai/usage`),
    enabled: editable,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  useEffect(() => { if (config.data) setDraft(toDraft(config.data)); }, [config.data]);

  const v = config.data;
  if (config.error) return <section className="panel"><div className="hdr"><h3>AI</h3></div><div className="empty t3" style={{ padding: 24 }}>{config.error instanceof ApiError ? config.error.message : 'AI settings are not available.'}</div></section>;
  if (!v || !draft) return null;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['ai-config', project.id] }),
    queryClient.invalidateQueries({ queryKey: ['ai-usage', project.id] }),
  ]);
  const effective = (t: AiTask): TaskConfig => draft.overrides[t] ?? v.tasks[t];
  const setTask = (t: AiTask, patch: Partial<TaskConfig>) =>
    setDraft({ ...draft, overrides: { ...draft.overrides, [t]: { ...effective(t), ...patch } } });
  const resetTask = (t: AiTask) => {
    const { [t]: _dropped, ...rest } = draft.overrides;
    setDraft({ ...draft, overrides: rest });
  };

  const save = async () => {
    const body: AiConfigBody = { policy: draft.policy, allowed: draft.allowed, tasks: draft.overrides, monthlyBudget: draft.monthlyBudget };
    try {
      await api('PUT', `/projects/${project.id}/ai/config`, body);
      await refresh();
      notify('AI settings saved');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save', 'bad');
    }
  };
  const saveKey = async (provider: (typeof CLOUD)[number], key: string | null) => {
    try {
      await api('PUT', `/projects/${project.id}/ai/keys/${provider}`, { key });
      setKeyInput({ ...keyInput, [provider]: '' });
      await refresh();
      notify(key ? `${AI_PROVIDER_LABELS[provider]} key saved` : `${AI_PROVIDER_LABELS[provider]} key removed`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the key', 'bad');
    }
  };

  const usedPct = v.monthlyBudget ? Math.min(100, (v.usedThisMonth / v.monthlyBudget) * 100) : 100;

  return (
    <section className="panel">
      <div className="hdr"><h3>AI</h3><div className="f1" /><span className="t3" style={{ fontSize: 11.5 }}>Applies to the whole organisation{editable ? '' : ' · set by Org Admins'}</span></div>
      <div className={s.body}>
        {v.mode !== 'cloud' && (
          <div className={s.mode}>
            {v.mode === 'local'
              ? <>This server runs AI offline: every task goes to <b className="mono">{v.localModel}</b> on Ollama and nothing leaves the machine. The models below apply when it runs in cloud mode.</>
              : <>This server answers AI requests from recorded responses (mock mode), as used by tests.</>}
          </div>
        )}

        <div className="col" style={{ gap: 8 }}>
          <div className="sec">Policy</div>
          <div className={s.policies} role="radiogroup" aria-label="AI policy">
            {POLICIES.map((p) => (
              <button key={p.value} role="radio" aria-checked={draft.policy === p.value} disabled={!editable} className={`${s.pol} ${draft.policy === p.value ? s.on : ''}`} onClick={() => setDraft({ ...draft, policy: p.value })}>
                <span className={s.rd} />
                <span><span>{p.label}</span><span className="t3" style={{ display: 'block' }}>{p.hint}</span></span>
              </button>
            ))}
          </div>
          {draft.policy === 'allowed' && (
            <div className="row" style={{ gap: 14 }}>
              {AI_PROVIDERS.map((p) => (
                <label key={p} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" className="cb" disabled={!editable} checked={draft.allowed.includes(p)} onChange={(e) => setDraft({ ...draft, allowed: e.target.checked ? [...draft.allowed, p] : draft.allowed.filter((x) => x !== p) })} />
                  {AI_PROVIDER_LABELS[p]}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="col" style={{ gap: 8 }}>
          <div className="sec">Provider per task</div>
          <table className={`tbl ${s.tasks}`}>
            <thead><tr><th>Task</th><th>Provider</th><th>Model</th><th>Fallback</th><th /></tr></thead>
            <tbody>
              {AI_TASKS.map((t) => {
                const cfg = effective(t);
                const available = v.available.includes(cfg.provider);
                return (
                  <tr key={t}>
                    <td>{AI_TASK_LABELS[t]}</td>
                    <td>
                      <select className="inp" disabled={!editable} value={cfg.provider} onChange={(e) => setTask(t, { provider: e.target.value as AiProvider })} aria-label={`Provider for ${AI_TASK_LABELS[t]}`}>
                        {AI_PROVIDERS.map((p) => <option key={p} value={p}>{AI_PROVIDER_LABELS[p]}</option>)}
                      </select>
                      {!available && <span className="t3" style={{ fontSize: 11, marginLeft: 6 }}>no key</span>}
                    </td>
                    <td><input className="inp mono" disabled={!editable} value={cfg.model} onChange={(e) => setTask(t, { model: e.target.value })} aria-label={`Model for ${AI_TASK_LABELS[t]}`} /></td>
                    <td className="t2">{cfg.fallback.length ? cfg.fallback.map(modelLabel).join(', ') : '—'}</td>
                    <td>{editable && draft.overrides[t] && <button className="btn sm ghost" onClick={() => resetTask(t)}>Use default</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className={s.cols}>
          <div className="col" style={{ gap: 8 }}>
            <div className="sec">API keys</div>
            <div className={s.keys}>
              {CLOUD.map((p) => (
                <KeyRow key={p} label={AI_PROVIDER_LABELS[p]} hint={v.keys[p]} platform={!v.keys[p] && v.available.includes(p)} editable={editable}
                  value={keyInput[p] ?? ''} onChange={(value) => setKeyInput({ ...keyInput, [p]: value })} onSave={(k) => saveKey(p, k)} />
              ))}
            </div>
            <div className="t3" style={{ fontSize: 11.5 }}>Keys are encrypted and write-only: nobody can read one back, only replace or remove it.</div>
          </div>
          <div className={s.budget}>
            <div className="sec">Monthly token budget</div>
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span className={s.big}>{lakhs(v.usedThisMonth)}</span>
              <span className="t3">of {lakhs(v.monthlyBudget)} tokens · resets on the 1st</span>
            </div>
            <div className={`${s.bar} ${usedPct >= 100 ? s.over : usedPct >= 80 ? s.warn : ''}`} role="meter" aria-valuenow={Math.round(usedPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used"><i style={{ width: `${usedPct}%` }} /></div>
            <div className="row t3" style={{ fontSize: 12 }}><span>{usedPct.toFixed(1)}% used</span><div className="f1" />{usedPct >= 80 && <span className="st st-blocked">Over 80%</span>}</div>
            {editable && (
              <label className="row" style={{ gap: 8 }}>
                <span className="t2">Budget</span>
                <input className="inp num" type="number" min={0} step={100000} style={{ width: 140 }} value={draft.monthlyBudget} onChange={(e) => setDraft({ ...draft, monthlyBudget: Math.max(0, Number(e.target.value) || 0) })} />
                <span className="t3">tokens a month</span>
              </label>
            )}
          </div>
        </div>

        {editable && <div className="row"><button className="btn primary" onClick={save}>Save AI settings</button></div>}

        {editable && (usage.data?.length ?? 0) > 0 && (
          <div className="col" style={{ gap: 8 }}>
            <div className="sec">Recent AI calls</div>
            <table className="tbl">
              <thead><tr><th>When</th><th>Task</th><th>Model</th><th>Tokens</th><th>By</th><th>Result</th></tr></thead>
              <tbody>
                {usage.data!.slice(0, 20).map((u, i) => (
                  <tr key={`${u.at}-${i}`}>
                    <td className="t3">{ago(u.at)}</td>
                    <td>{AI_TASK_LABELS[u.task] ?? u.task}</td>
                    <td className="mono t2">{u.provider} · {u.model}</td>
                    <td className="num">{fmt(u.inputTokens + u.outputTokens)}</td>
                    <td className="t2">{u.user ?? '—'}</td>
                    <td>{u.ok ? <span className="st st-passed">OK</span> : <span className="st st-failed" title={u.error ?? ''}>Failed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function KeyRow({ label, hint, platform, editable, value, onChange, onSave }: {
  label: string;
  hint: string | null;
  platform: boolean;
  editable: boolean;
  value: string;
  onChange(value: string): void;
  onSave(key: string | null): void;
}) {
  return (
    <>
      <span className="t2">{label}</span>
      {editable ? (
        <input className="inp mono" type="password" autoComplete="off" placeholder={hint ?? (platform ? 'Using the Testbench platform key' : 'Not set')} value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} API key`} />
      ) : (
        <span className="mono t2">{hint ?? (platform ? 'Platform key' : 'Not set')}</span>
      )}
      <span className="row" style={{ gap: 6 }}>
        {editable && <button className="btn sm" disabled={value.trim().length < 10} onClick={() => onSave(value.trim())}>{hint ? 'Rotate' : 'Save'}</button>}
        {editable && hint && <button className="btn sm ghost" onClick={() => onSave(null)}>Remove</button>}
      </span>
    </>
  );
}
