'use client';

import type { AiAnswer, CaseDetail, EdgeCase } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import s from './ai.module.css';

/**
 * "Suggest edge cases" for one case. Suggestions are only shown; each can become a draft case in the
 * same module, which its author then fills in. On the local model this takes about a minute.
 */
export function EdgeCases({ c }: { c: CaseDetail }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AiAnswer<{ edgeCases: EdgeCase[] }> | null>(null);
  const [created, setCreated] = useState<Record<string, string>>({});

  const suggest = async () => {
    setBusy(true);
    try {
      setAnswer(await api<AiAnswer<{ edgeCases: EdgeCase[] }>>('POST', `/projects/${project.id}/ai/edge-cases`, { caseKey: c.key }));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not get suggestions', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async (e: EdgeCase) => {
    try {
      const draft = await api<CaseDetail>('POST', `/projects/${project.id}/cases`, {
        title: e.title,
        moduleId: c.moduleId,
        priority: c.priority,
        preconditions: e.why,
        status: 'draft',
        labels: ['edge-case'],
      });
      setCreated({ ...created, [e.title]: draft.key });
      await queryClient.invalidateQueries({ queryKey: ['cases', project.id] });
      notify(`Created ${draft.key} as a draft`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the case', 'bad');
    }
  };

  return (
    <>
      <div className="sec" style={{ margin: '16px 0 8px' }}>AI assist</div>
      {!answer && (
        <button className="btn sm" onClick={suggest} disabled={busy}>
          <Icon name={busy ? 'refresh' : 'flag'} size={12} className={busy ? 'spin' : ''} />
          {busy ? 'Thinking… (up to a minute offline)' : 'Suggest edge cases'}
        </button>
      )}
      {answer && (
        <div className="panel" style={{ marginTop: 4 }}>
          <ul className={s.suggest} style={{ margin: 0, listStyle: 'none' }}>
            {answer.result.edgeCases.map((e) => (
              <li key={e.title} className="col" style={{ gap: 3 }}>
                <b style={{ fontWeight: 500 }}>{e.title}</b>
                <span className="t3">{e.why}</span>
                {created[e.title]
                  ? <Link className="mono" href={`/cases/${created[e.title]}`}>{created[e.title]}</Link>
                  : <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => createDraft(e)}>Create as draft case</button>}
              </li>
            ))}
          </ul>
          <div className="t3" style={{ fontSize: 11, padding: '0 14px 10px' }}>Suggested by {answer.provider} · {answer.model}. Check before use.</div>
        </div>
      )}
    </>
  );
}
