import type { Tx } from '@tb/platform';
import type { CaseDocument, CaseIndex } from './case-index';
import { MAPPINGS } from './case-index';
import { resolveNames, parseOrReject } from './search';
import { whereQuery } from './translate';

// Filter subscriptions (HLD §6, §5.15): each subscribed saved filter is stored as an OpenSearch
// percolator query, and each new case is "percolated" against them, which answers "which filters does
// this case match?" in one request instead of running every filter on every change.
//
// ponytail: relative dates ("updated >= -7d") and owner/module names are resolved when the filter is
// registered, so a filter's window stops moving until it is saved or subscribed to again. Re-register
// nightly if long-lived relative filters need to stay exact.

const INDEX = 'filter-queries';

export async function ensurePercolator(index: CaseIndex): Promise<void> {
  const exists = await index.client.indices.exists({ index: INDEX });
  if (exists.body) return;
  await index.client.indices.create({
    index: INDEX,
    body: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        dynamic: 'strict',
        // The stored queries refer to case fields, so the case mapping must be present here too.
        properties: {
          ...MAPPINGS.properties,
          query: { type: 'percolator' },
          filter_id: { type: 'keyword' },
          filter_project: { type: 'keyword' },
        },
      },
    } as never,
  });
}

/**
 * Stores (or removes) a saved filter's query, depending on whether anyone is subscribed. Called after
 * every change to the filter or its subscriptions, inside the same request.
 */
export async function syncFilterQuery(trx: Tx, index: CaseIndex, filterId: string): Promise<void> {
  const filter = await trx
    .selectFrom('search.saved_filter')
    .select(['id', 'project_id', 'tql', 'owner_id'])
    .where('id', '=', filterId)
    .executeTakeFirst();
  const subscribers = filter
    ? await trx
        .selectFrom('search.filter_subscription')
        .select('user_id')
        .where('filter_id', '=', filterId)
        .execute()
    : [];
  if (!filter || !subscribers.length) {
    await index.client.delete({ index: INDEX, id: filterId, refresh: true }).catch(() => undefined);
    return;
  }
  const query = parseOrReject(filter.tql);
  const resolved = await resolveNames(trx, filter.project_id, query, { userId: filter.owner_id });
  await index.client.index({
    index: INDEX,
    id: filterId,
    refresh: true,
    body: {
      query: {
        bool: {
          filter: [{ term: { project_id: filter.project_id } }],
          must: [whereQuery(query.where, resolved)],
        },
      },
      filter_id: filterId,
      filter_project: filter.project_id,
    } as never,
  });
}

/** Ids of the subscribed filters in the project that this case matches. */
export async function matchingFilters(index: CaseIndex, doc: CaseDocument): Promise<string[]> {
  const res = await index.client.search({
    index: INDEX,
    body: {
      query: {
        bool: {
          filter: [
            { term: { filter_project: doc.project_id } },
            { percolate: { field: 'query', document: doc } },
          ],
        },
      },
      _source: ['filter_id'],
      size: 100,
    } as never,
  });
  return (res.body as unknown as { hits: { hits: { _source: { filter_id: string } }[] } }).hits.hits.map(
    (h) => h._source.filter_id,
  );
}
