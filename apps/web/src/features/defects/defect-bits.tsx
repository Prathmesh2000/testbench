import type { DefectRow, Severity } from '@tb/contracts';
import { Icon } from '@/components/Icon';
import s from './defects.module.css';

// Small pieces shared by the defects screen, the execute view and the log-bug dialog.

/** Jira status as a coloured pill. Colours follow the status category; names come from Jira as-is. */
export function JiraStatus({ status, category }: { status: string; category: DefectRow['statusCategory'] }) {
  const tone = category === 'done' ? s.done : /review/i.test(status) ? s.rev : category === 'indeterminate' ? s.prog : /reopen/i.test(status) ? s.reop : s.todo;
  return <span className={`${s.js} ${tone}`}>{status}</span>;
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return (
    <span className={`${s.sev} ${s[`sev${severity}`]}`}>
      <Icon name={severity === 'Blocker' ? 'blocked' : severity === 'Critical' ? 'alert' : 'flag'} size={12} />
      {severity}
    </span>
  );
}

export function RetestState({ retest }: { retest: DefectRow['retest'] }) {
  if (!retest) return <span className={s.rtNone}>—</span>;
  const label = { pending: 'Retest pending', passed: 'Verified', failed: 'Still failing' }[retest];
  const cls = { pending: s.rtPend, passed: s.rtPass, failed: s.rtFail }[retest];
  return <span className={cls} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{label}</span>;
}
