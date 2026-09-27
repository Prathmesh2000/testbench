import { caseKey, runKey, type NotifyEvent, type Recipient } from '@tb/contracts';
import type { Consumer, OutboxEvent, Tx } from '@tb/platform';
import { documentsFor, matchingFilters, type CaseIndex } from '@tb/search';
import type { NotifyClient } from './client';

/**
 * Turns Testbench domain events into notification requests. It only decides *who* is concerned and
 * *what* happened; which channels to use is the notification service's rules. The outbox event id is
 * the idempotency key, so a redelivered event never notifies twice.
 */
export function notifier(client: NotifyClient, index: CaseIndex, webUrl: string): Consumer {
  const send = (
    e: OutboxEvent,
    event: NotifyEvent,
    recipients: Recipient[],
    data: Record<string, string | number>,
    link: string,
    suffix = '',
  ) => client.notify(e.orgId, { event, idempotencyKey: `${e.id}${suffix}`, recipients, data, link });

  return {
    name: 'notifier',
    types: [
      'run.created',
      'run.prepared',
      'defect.created',
      'defect.status_changed',
      'testcase.created',
      'document.versioned',
    ],
    async handle(trx, e) {
      switch (e.type) {
        case 'run.created':
        case 'run.prepared': {
          // A prepared run notifies once its items exist, not at creation when there is nothing to open.
          if (e.type === 'run.created' && e.data.prepared) return;
          const runId = String(e.data.run_id);
          const run = await trx
            .selectFrom('exec.run')
            .select(['key_no', 'name', 'build'])
            .where('id', '=', runId)
            .executeTakeFirst();
          if (!run) return;
          const assignees = await trx
            .selectFrom('exec.run_item as i')
            .innerJoin('iam.app_user as u', 'u.id', 'i.assignee_id')
            .select(['u.id', 'u.name', 'u.email', (eb) => eb.fn.countAll<number>().as('count')])
            .where('i.run_id', '=', runId)
            .groupBy(['u.id', 'u.name', 'u.email'])
            .execute();
          // One request per person, because each gets their own item count.
          for (const a of assignees) {
            if (a.id === e.actor) continue; // nobody needs telling about work they just gave themselves
            await send(
              e,
              'run.assigned',
              [{ id: a.id, name: a.name, email: a.email }],
              { runKey: runKey(run.key_no), runName: run.name, count: a.count, build: run.build },
              `${webUrl}/runs/${runId}`,
              `:${a.id}`,
            );
          }
          return;
        }
        case 'defect.created': {
          const d = await defect(trx, String(e.data.defect_id));
          if (d)
            await send(
              e,
              'defect.logged',
              [],
              { jiraKey: d.jira_key, summary: d.summary, severity: d.severity, reporter: d.reporter },
              `${webUrl}/defects`,
            );
          return;
        }
        case 'defect.status_changed': {
          if (e.data.category !== 'done') return;
          const d = await defect(trx, String(e.data.defect_id));
          if (!d) return;
          const people = await trx
            .selectFrom('defect.retest as r')
            .innerJoin('iam.app_user as u', 'u.id', 'r.assignee_id')
            .innerJoin('repo.test_case as c', 'c.id', 'r.case_id')
            .select(['u.id', 'u.name', 'u.email', 'c.key_no'])
            .where('r.defect_id', '=', d.id)
            .where('r.status', '=', 'pending')
            .execute();
          const recipients = [
            ...new Map(people.map((p) => [p.id, { id: p.id, name: p.name, email: p.email }])).values(),
          ];
          if (recipients.length) {
            await send(
              e,
              'defect.fixed',
              recipients,
              {
                jiraKey: d.jira_key,
                summary: d.summary,
                cases: [...new Set(people.map((p) => caseKey(p.key_no)))].join(', '),
              },
              `${webUrl}/defects`,
            );
          }
          return;
        }
        case 'testcase.created':
          await filterMatches(trx, e, send, index, webUrl);
          return;
        case 'document.versioned': {
          if (!e.data.flagged) return;
          const documentId = String(e.data.document_id);
          const doc = await trx
            .selectFrom('docs.document')
            .select('title')
            .where('id', '=', documentId)
            .executeTakeFirst();
          if (!doc) return;
          // Each owner hears about their own flagged cases once, with their own count.
          const owners = await trx
            .selectFrom('docs.case_flag as f')
            .innerJoin('docs.requirement as r', 'r.id', 'f.requirement_id')
            .innerJoin('repo.test_case as c', (j) =>
              j.onRef('c.id', '=', 'f.case_id').onRef('c.project_id', '=', 'f.project_id'),
            )
            .innerJoin('iam.app_user as u', 'u.id', 'c.owner_id')
            .select([
              'u.id',
              'u.name',
              'u.email',
              (eb) => eb.fn.count<number>('f.case_id').distinct().as('count'),
            ])
            .where('r.document_id', '=', documentId)
            .where('r.changed_in', '=', Number(e.data.version))
            .where('c.status', '=', 'needs_review')
            .groupBy(['u.id', 'u.name', 'u.email'])
            .execute();
          for (const o of owners) {
            if (o.id === e.actor) continue;
            await send(
              e,
              'requirement.changed',
              [{ id: o.id, name: o.name, email: o.email }],
              { documentTitle: doc.title, version: Number(e.data.version), count: o.count },
              `${webUrl}/docs?doc=${documentId}`,
              `:${o.id}`,
            );
          }
        }
      }
    },
  };
}

async function defect(trx: Tx, id: string) {
  return trx
    .selectFrom('defect.defect as d')
    .innerJoin('iam.app_user as u', 'u.id', 'd.created_by')
    .select(['d.id', 'd.jira_key', 'd.summary', 'd.severity', 'u.name as reporter'])
    .where('d.id', '=', id)
    .executeTakeFirst();
}

/**
 * "New matches" for saved-filter subscribers (HLD §5.15): percolate the new case against subscribed
 * filters and tell each subscriber, except the person who created the case.
 * ponytail: only newly created cases count as new matches; an edit that makes an old case match is not announced.
 */
async function filterMatches(
  trx: Tx,
  e: OutboxEvent,
  send: (
    e: OutboxEvent,
    ev: NotifyEvent,
    r: Recipient[],
    d: Record<string, string | number>,
    link: string,
    s?: string,
  ) => Promise<unknown>,
  index: CaseIndex,
  webUrl: string,
) {
  const [doc] = await documentsFor(trx, e.projectId!, [String(e.data.case_id)]);
  if (!doc) return;
  const filterIds = await matchingFilters(index, doc);
  if (!filterIds.length) return;
  const subs = await trx
    .selectFrom('search.filter_subscription as s')
    .innerJoin('search.saved_filter as f', 'f.id', 's.filter_id')
    .innerJoin('iam.app_user as u', 'u.id', 's.user_id')
    .select(['f.id as filter_id', 'f.name as filter_name', 'u.id', 'u.name', 'u.email'])
    .where('s.filter_id', '=', (eb) => eb.fn.any(eb.val(filterIds)))
    .execute();
  for (const s of subs) {
    if (s.id === e.actor) continue;
    await send(
      e,
      'filter.matched',
      [{ id: s.id, name: s.name, email: s.email }],
      { filterName: s.filter_name, caseKey: doc.key, caseTitle: doc.title },
      `${webUrl}/cases/${doc.key}`,
      `:${s.filter_id}:${s.id}`,
    );
  }
}
