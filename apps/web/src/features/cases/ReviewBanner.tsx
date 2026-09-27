'use client';

import type { CaseDetail, CaseFlag } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';

/**
 * Why a case is "Needs review" (a linked PRD requirement changed or was removed, HLD §5.13), with the
 * owner's way out: confirm the case still holds, or edit it.
 */
export function ReviewBanner({ c }: { c: CaseDetail }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const flags = useQuery({
    queryKey: ['case-flags', project.id, c.key],
    queryFn: () => get<CaseFlag[]>(`/projects/${project.id}/cases/${c.key}/flags`),
    enabled: c.status === 'needs_review',
  });
  if (c.status !== 'needs_review') return null;

  const confirm = async () => {
    try {
      await api('POST', `/projects/${project.id}/cases/${c.key}/confirm-review`);
      await queryClient.invalidateQueries({ queryKey: ['case', project.id, c.key] });
      await queryClient.invalidateQueries({ queryKey: ['cases', project.id] });
      notify(`${c.key} confirmed and back to Ready`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not confirm', 'bad');
    }
  };

  const list = flags.data ?? [];
  return (
    <div className="banner warn" role="status" style={{ margin: '0 0 12px' }}>
      <Icon name="alert" />
      <div className="f1">
        <b>Needs review.</b>{' '}
        {list.length === 0
          ? 'Someone marked this case for review.'
          : list.map((f) => `${f.requirementRef} ${f.kind === 'needs_review' ? 'changed' : 'was removed'} in ${f.documentTitle}`).join(' · ')}
        {list.some((f) => f.kind === 'possibly_obsolete') && ' — this case may be obsolete.'}
      </div>
      {can('case.write') && <button className="btn sm" onClick={confirm}>Still valid</button>}
    </div>
  );
}
