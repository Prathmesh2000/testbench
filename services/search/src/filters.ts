import type { SavedFilter } from '@tb/contracts';
import { forbidden, notFound, type Tx } from '@tb/platform';
import { parseOrReject } from './search';

interface Caller {
  orgId: string;
  userId: string;
}

/** Filters the caller owns plus the ones teammates shared with the project. */
export async function listFilters(trx: Tx, caller: Caller, projectId: string): Promise<SavedFilter[]> {
  const rows = await trx
    .selectFrom('search.saved_filter as f')
    .innerJoin('iam.app_user as u', 'u.id', 'f.owner_id')
    .leftJoin('search.filter_subscription as s', (j) =>
      j.onRef('s.filter_id', '=', 'f.id').on('s.user_id', '=', caller.userId),
    )
    .select([
      'f.id',
      'f.name',
      'f.tql',
      'f.shared',
      'f.owner_id',
      'u.name as owner_name',
      'u.email as owner_email',
      's.user_id as subscriber',
    ])
    .where('f.project_id', '=', projectId)
    .where((eb) => eb.or([eb('f.owner_id', '=', caller.userId), eb('f.shared', '=', true)]))
    .orderBy('f.name')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tql: r.tql,
    shared: r.shared,
    mine: r.owner_id === caller.userId,
    subscribed: !!r.subscriber,
    owner: { id: r.owner_id, name: r.owner_name, email: r.owner_email },
  }));
}

export async function saveFilter(
  trx: Tx,
  caller: Caller,
  projectId: string,
  body: { name: string; tql: string; shared: boolean },
): Promise<string> {
  parseOrReject(body.tql); // never store a filter that cannot run
  const { id } = await trx
    .insertInto('search.saved_filter')
    .values({ org_id: caller.orgId, project_id: projectId, owner_id: caller.userId, ...body })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

async function ownFilter(trx: Tx, caller: Caller, projectId: string, id: string) {
  const f = await trx
    .selectFrom('search.saved_filter')
    .select(['id', 'owner_id', 'shared'])
    .where('id', '=', id)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!f || (f.owner_id !== caller.userId && !f.shared)) throw notFound('Filter');
  return f;
}

/** Only the owner can change or delete a filter, even a shared one. */
export async function updateFilter(
  trx: Tx,
  caller: Caller,
  projectId: string,
  id: string,
  body: { name: string; tql: string; shared: boolean },
): Promise<void> {
  const f = await ownFilter(trx, caller, projectId, id);
  if (f.owner_id !== caller.userId) throw forbidden('Only the person who saved this filter can change it.');
  parseOrReject(body.tql);
  await trx
    .updateTable('search.saved_filter')
    .set({ ...body, updated_at: new Date() })
    .where('id', '=', id)
    .execute();
}

export async function deleteFilter(trx: Tx, caller: Caller, projectId: string, id: string): Promise<void> {
  const f = await ownFilter(trx, caller, projectId, id);
  if (f.owner_id !== caller.userId) throw forbidden('Only the person who saved this filter can delete it.');
  await trx.deleteFrom('search.saved_filter').where('id', '=', id).execute();
}

/** Anyone who can see a filter can subscribe to it; delivery arrives with notifications (M3). */
export async function setSubscription(
  trx: Tx,
  caller: Caller,
  projectId: string,
  id: string,
  on: boolean,
): Promise<void> {
  await ownFilter(trx, caller, projectId, id);
  if (on) {
    await trx
      .insertInto('search.filter_subscription')
      .values({ filter_id: id, user_id: caller.userId, org_id: caller.orgId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  } else {
    await trx
      .deleteFrom('search.filter_subscription')
      .where('filter_id', '=', id)
      .where('user_id', '=', caller.userId)
      .execute();
  }
}
