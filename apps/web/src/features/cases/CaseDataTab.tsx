'use client';

import type { CaseDetail, DataResults, DataSetSummary } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { ResultStatus } from '@/components/status';
import { api, ApiError, get } from '@/lib/api';
import { ago } from '@/lib/format';

/**
 * The case's test data: which data set drives it, and the latest result of every data row per
 * configuration, so a tester sees at a glance which inputs fail.
 */
export function CaseDataTab({ c, canEdit }: { c: CaseDetail; canEdit: boolean }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const sets = useQuery({ queryKey: ['data-sets', project.id], queryFn: () => get<DataSetSummary[]>(`/projects/${project.id}/data-sets`) });
  const results = useQuery({
    queryKey: ['data-results', project.id, c.key],
    queryFn: () => get<DataResults>(`/projects/${project.id}/cases/${c.key}/data-results`),
    enabled: Boolean(c.dataSet),
  });

  const link = async (dataSetId: string | null) => {
    try {
      await api('PUT', `/projects/${project.id}/cases/${c.key}/data-set`, { dataSetId });
      await queryClient.invalidateQueries({ queryKey: ['case', project.id, c.key] });
      await queryClient.invalidateQueries({ queryKey: ['data-results', project.id, c.key] });
      notify(dataSetId ? 'Linked. New runs will run this case once per data row.' : 'Unlinked. New runs will run this case once.');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not change the data set', 'bad');
    }
  };

  const data = results.data;
  const configs = [...new Set(data?.rows.flatMap((r) => r.results.map((x) => x.config)) ?? [])].sort();
  const usesPlaceholders = c.version.steps.some((st) => /\{\{[^}]+\}\}/.test(`${st.action} ${st.expected} ${st.data}`));

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="t2">Data set</span>
        <select className="inp" style={{ minWidth: 260 }} disabled={!canEdit} value={c.dataSet?.id ?? ''} onChange={(e) => link(e.target.value || null)} aria-label="Data set">
          <option value="">None: run once</option>
          {sets.data?.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.rowCount} rows)</option>)}
        </select>
        {c.dataSet && <Link className="btn sm ghost" href={`/data?set=${c.dataSet.id}`}>Open data set</Link>}
        <Link className="btn sm ghost" href="/data?set=new"><Icon name="plus" size={12} />New data set</Link>
      </div>

      {c.dataSet && !usesPlaceholders && (
        <div className="banner info"><Icon name="info" /><div>No step uses a <span className="mono">{'{{column}}'}</span> placeholder yet. Add one, such as <span className="mono">{`{{${data?.dataSet?.columns[0] ?? 'amount'}}}`}</span>, so each run item shows its row’s value in the step.</div></div>
      )}

      {!c.dataSet && (
        <div className="empty t3" style={{ padding: 32 }}>
          <Icon name="rows" size={20} />
          <div>Link a data set to run this case once per row, each with its own result, evidence and bugs.</div>
        </div>
      )}

      {c.dataSet && data?.dataSet && (
        <div style={{ overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                {data.dataSet.columns.map((col) => <th key={col}>{col}</th>)}
                {configs.map((cfg) => <th key={cfg}>{cfg}</th>)}
                {configs.length === 0 && <th>Latest result</th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.index}>
                  <td className="mono t3">{r.index + 1}</td>
                  {data.dataSet!.columns.map((col) => <td key={col} className="mono">{r.values[col]}</td>)}
                  {configs.map((cfg) => {
                    const hit = r.results.find((x) => x.config === cfg);
                    return (
                      <td key={cfg} title={hit ? `${hit.runKey} · ${ago(hit.at)}` : 'Not run yet'}>
                        {hit ? <ResultStatus result={hit.status} /> : <span className="t3">—</span>}
                      </td>
                    );
                  })}
                  {configs.length === 0 && <td className="t3">Not run yet</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
