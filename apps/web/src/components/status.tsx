import type { CaseStatus, Priority, Result, RunCounts, UserRef } from '@tb/contracts';
import { avatarTone, initials } from '@/lib/format';
import { Icon, type IconName } from './Icon';

// Status vocabulary. Every result is shown as colour + icon + word, so it reads for colour-blind testers too.

const RESULT: Record<Result, { label: string; icon: IconName }> = {
  passed: { label: 'Passed', icon: 'check' },
  failed: { label: 'Failed', icon: 'x' },
  blocked: { label: 'Blocked', icon: 'blocked' },
  skipped: { label: 'Skipped', icon: 'skip' },
  untested: { label: 'Untested', icon: 'circle' },
};

export const resultLabel = (r: Result) => RESULT[r].label;

export function ResultStatus({ result, label = true, size = 13 }: { result: Result; label?: boolean; size?: number }) {
  return (
    <span className={`st st-${result}`} title={label ? undefined : RESULT[result].label}>
      <Icon name={RESULT[result].icon} size={size} />
      {label && RESULT[result].label}
    </span>
  );
}

/** Small square result markers, e.g. the last runs of a case. */
export function ResultDots({ results }: { results: Result[] }) {
  return (
    <span className="rdots">
      {results.map((r, i) => (
        <span key={i} className={`rdot rd-${r}`} title={RESULT[r].label}>
          <Icon name={RESULT[r].icon} size={10} />
        </span>
      ))}
    </span>
  );
}

const CASE_STATUS: Record<CaseStatus, string> = {
  draft: 'Draft', in_review: 'In review', ready: 'Ready', needs_review: 'Needs review', obsolete: 'Obsolete',
};
export const caseStatusLabel = (s: CaseStatus) => CASE_STATUS[s];

export function CaseStatusPill({ status }: { status: CaseStatus }) {
  return <span className={`pill ${status}`}>{CASE_STATUS[status]}</span>;
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return <span className={`prio prio-${priority}`}>{priority}</span>;
}

export function Avatar({ user, large = false }: { user: UserRef; large?: boolean }) {
  return (
    <span className={`av ${avatarTone(user.id)} ${large ? 'lg' : ''}`} title={user.name}>
      {initials(user.name)}
    </span>
  );
}

export function Avatars({ users, max = 4 }: { users: UserRef[]; max?: number }) {
  return (
    <span className="avs">
      {users.slice(0, max).map((u) => <Avatar key={u.id} user={u} />)}
      {users.length > max && <span className="av av-i" title={`${users.length - max} more`}>+{users.length - max}</span>}
    </span>
  );
}

/** Stacked pass / fail / blocked / skip bar; the empty remainder is untested. */
export function StackedBar({ counts, width = 140, height = 6 }: { counts: RunCounts; width?: number | string; height?: number }) {
  const pct = (n: number) => (counts.total ? `${(n / counts.total) * 100}%` : '0%');
  const done = counts.total - counts.untested;
  return (
    <div className="sbar" style={{ width, height }} role="img" aria-label={`${done} of ${counts.total} executed: ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.skipped} skipped`}>
      <i className="b-passed" style={{ width: pct(counts.passed) }} />
      <i className="b-failed" style={{ width: pct(counts.failed) }} />
      <i className="b-blocked" style={{ width: pct(counts.blocked) }} />
      <i className="b-skipped" style={{ width: pct(counts.skipped) }} />
    </div>
  );
}
