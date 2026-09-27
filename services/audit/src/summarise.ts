import { ROLE_LABELS, type Role } from '@tb/contracts';

// Turns a domain event into the three columns people read in the audit log. Pure, so the wording is
// tested once and the stored text never depends on later code changes.

export interface Summary {
  action: string;
  entity: string;
  details: string;
}

type Data = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const role = (v: unknown) =>
  ROLE_LABELS[v as Role] ?? (str(v).startsWith('custom:') ? 'custom role' : str(v));
const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');

export function summarise(type: string, d: Data): Summary {
  switch (type) {
    case 'testcase.created':
      return { action: 'Case created', entity: str(d.key), details: '' };
    case 'testcase.updated': {
      const why =
        d.reason === 'requirement_changed'
          ? 'flagged: linked requirement changed'
          : d.reason === 'review_confirmed'
            ? 'review confirmed'
            : '';
      return {
        action: 'Case updated',
        entity: str(d.key),
        details: why || `${list(d.fields)}${d.version ? ` · v${d.version}` : ''}`,
      };
    }
    case 'testcase.bulk_updated': {
      const patch = (d.patch ?? {}) as Data;
      return {
        action: 'Bulk update',
        entity: `${str(d.processed)} cases`,
        details: Object.entries(patch)
          .map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(', ') : str(v)}`)
          .join(' · '),
      };
    }
    case 'run.created':
      return {
        action: 'Run created',
        entity: str(d.key),
        details: `${str(d.items)} items${d.prepared ? ' · prepared in background' : ''}`,
      };
    case 'run.prepared':
      return { action: 'Run prepared', entity: str(d.key), details: `${str(d.items)} items` };
    case 'result.recorded':
      return {
        action: 'Result recorded',
        entity: `step ${Number(d.step_index) + 1}`,
        details: `${str(d.status)} · item now ${str(d.item_status)}`,
      };
    case 'defect.created':
      return { action: 'Bug created', entity: str(d.jira_key), details: 'logged from a run' };
    case 'defect.linked':
      return { action: 'Bug linked', entity: str(d.jira_key), details: '' };
    case 'defect.status_changed':
      return {
        action: 'Jira status changed',
        entity: str(d.jira_key),
        details: `${str(d.from)} → ${str(d.to)}`,
      };
    case 'retest.completed':
      return { action: `Retest ${str(d.status)}`, entity: 'retest', details: '' };
    case 'user.role_changed':
      return {
        action: 'Role changed',
        entity: 'member',
        details: `${d.from ? `${role(d.from)} → ` : ''}${role(d.role)}`,
      };
    case 'member.invited':
      return { action: 'Member invited', entity: str(d.email), details: role(d.role) };
    case 'member.removed':
      return { action: 'Member removed', entity: 'member', details: '' };
    case 'role.saved': {
      const changes = [list(d.added) && `+ ${list(d.added)}`, list(d.removed) && `− ${list(d.removed)}`]
        .filter(Boolean)
        .join(' · ');
      return {
        action: Number(d.version) === 1 ? 'Role created' : 'Role edited',
        entity: str(d.name),
        details: changes || `v${str(d.version)}`,
      };
    }
    case 'role.deleted':
      return { action: 'Role deleted', entity: str(d.name), details: '' };
    case 'token.created':
      return {
        action: 'Token created',
        entity: str(d.name),
        details: `scopes ${list(d.scopes)} · ${str(d.days)} days`,
      };
    case 'token.revoked':
      return { action: 'Token revoked', entity: str(d.name), details: '' };
    case 'document.created':
      return { action: 'PRD imported', entity: str(d.title), details: `${str(d.requirements)} requirements` };
    case 'document.versioned':
      return {
        action: 'PRD version added',
        entity: `v${str(d.version)}`,
        details: `${str(d.changed)} changed · ${str(d.added)} added · ${str(d.removed)} removed · ${str(d.flagged)} cases flagged`,
      };
    case 'release.signed_off':
      return {
        action: d.decision === 'go' ? 'Release Go' : 'Release No-go',
        entity: `build ${str(d.build)}`,
        details: str(d.note),
      };
    case 'ai.config_changed':
      return { action: 'AI settings changed', entity: str(d.what), details: str(d.detail) };
    case 'board.created':
      return { action: 'Board created', entity: str(d.title), details: str(d.kind) };
    case 'meeting.scheduled':
      return { action: 'Meeting scheduled', entity: str(d.title), details: str(d.starts_at) };
    case 'action_item.converted':
      return { action: 'Action item converted', entity: str(d.converted_to), details: str(d.text) };
    default:
      return { action: type, entity: '', details: '' };
  }
}
