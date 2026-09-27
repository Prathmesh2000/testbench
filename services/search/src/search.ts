import { caseKey, type CaseGroup, type Result, type SearchHit, type SearchResult } from '@tb/contracts';
import { AppError, badRequest, decodeCursor, encodeCursor, type Tx } from '@tb/platform';
import { clauses, parse, TqlError, type Query } from '@tb/tql';
import { sql } from 'kysely';
import { ALIAS, type CaseDocument, type CaseIndex } from './case-index';
import { searchBody, type Resolved } from './translate';

interface Caller {
  userId: string;
}

/** Parses TQL, turning syntax problems into a 400 that carries the position for the editor to underline. */
export function parseOrReject(tql: string): Query {
  try {
    return parse(tql);
  } catch (err) {
    if (err instanceof TqlError)
      throw new AppError(400, 'invalid_tql', err.message, { start: err.start, end: err.end });
    throw err;
  }
}

/**
 * Looks up the people and modules a query names. Unknown people and modules are an error rather than
 * "no results", because a typo there would otherwise look like an empty project.
 */
export async function resolveNames(
  trx: Tx,
  projectId: string,
  query: Query,
  caller: Caller,
): Promise<Resolved> {
  const all = clauses(query.where);
  const valuesFor = (field: string) => [
    ...new Set(
      all
        .filter((c) => c.field.name === field)
        .flatMap((c) =>
          c.value.kind === 'list' ? c.value.items : c.value.kind === 'text' ? [c.value.text] : [],
        ),
    ),
  ];

  const owners = new Map<string, string | null>();
  const people = valuesFor('owner').filter((v) => v.toLowerCase() !== 'me');
  if (valuesFor('owner').some((v) => v.toLowerCase() === 'me')) owners.set('me', caller.userId);
  if (people.length) {
    const rows = await trx
      .selectFrom('iam.app_user')
      .select(['id', 'name', 'email'])
      .where((eb) =>
        eb.or([
          eb(
            sql`lower(name)`,
            'in',
            people.map((p) => p.toLowerCase()),
          ),
          eb(
            'email',
            'in',
            people.map((p) => p.toLowerCase()),
          ),
        ]),
      )
      .execute();
    for (const p of people) {
      const match = rows.find((r) => r.name.toLowerCase() === p.toLowerCase() || r.email === p.toLowerCase());
      if (!match) throw badRequest(`No one called “${p}” is in this organisation.`);
      owners.set(p, match.id);
    }
  }

  const modules = new Map<string, string[]>();
  const wanted = valuesFor('module');
  if (wanted.length) {
    const rows = await trx
      .selectFrom('repo.module')
      .select(['id', 'parent_id', 'name'])
      .where('project_id', '=', projectId)
      .orderBy('path')
      .execute();
    const paths = new Map<string, string>();
    for (const r of rows)
      paths.set(
        r.id,
        r.parent_id && paths.has(r.parent_id) ? `${paths.get(r.parent_id)} / ${r.name}` : r.name,
      );
    const squash = (s: string) =>
      s
        .toLowerCase()
        .replace(/\s*\/\s*/g, '/')
        .trim();
    for (const w of wanted) {
      // Full path ("UPI / Collect") or, when unambiguous enough, a module's own name ("Collect").
      const ids = rows
        .filter((r) => squash(paths.get(r.id)!) === squash(w) || r.name.toLowerCase() === w.toLowerCase())
        .map((r) => r.id);
      if (!ids.length)
        throw badRequest(`No module called “${w}” in this project. Use a path such as "UPI / Collect".`);
      modules.set(w, ids);
    }
  }
  return { owners, modules, now: new Date() };
}

function toHit(source: CaseDocument, highlight: Record<string, string[]> | undefined): SearchHit {
  return {
    id: source.case_id,
    key: caseKey(source.key_no),
    title: source.title,
    moduleId: source.module_id,
    modulePath: source.module_path,
    priority: source.priority as SearchHit['priority'],
    type: source.type,
    status: source.status as SearchHit['status'],
    lastResult: source.last_result as Result,
    labels: source.labels,
    owner: source.owner_id
      ? { id: source.owner_id, name: source.owner_name ?? '', email: source.owner_email ?? '' }
      : null,
    estimateMin: source.estimate_min,
    automation: source.automation as SearchHit['automation'],
    updatedAt: source.updated_at,
    highlight: { title: highlight?.title?.[0], steps: highlight?.steps_text?.[0] },
  };
}

interface Hit {
  _source: CaseDocument;
  highlight?: Record<string, string[]>;
  sort: (string | number)[];
}

/** Runs a TQL query for one page of results. */
export async function search(
  trx: Tx,
  index: CaseIndex,
  caller: Caller,
  projectId: string,
  tql: string,
  page: { cursor?: string; limit: number },
): Promise<SearchResult> {
  const query = parseOrReject(tql);
  const resolved = await resolveNames(trx, projectId, query, caller);
  const after = page.cursor ? decodeSortCursor(page.cursor) : undefined;
  const started = performance.now();
  const res = await index.client.search({
    index: ALIAS,
    routing: projectId,
    body: searchBody(query, projectId, resolved, { size: page.limit, after }) as never,
  });
  const body = res.body as unknown as {
    hits: { total: { value: number; relation: 'eq' | 'gte' }; hits: Hit[] };
    aggregations?: { groups: { buckets: { key: string; doc_count: number }[] } };
  };
  const hits = body.hits.hits;
  const groups: CaseGroup[] | null = body.aggregations
    ? body.aggregations.groups.buckets.map((b) => ({ value: b.key, label: b.key, count: b.doc_count }))
    : null;
  return {
    total: body.hits.total.value,
    totalCapped: body.hits.total.relation === 'gte',
    tookMs: Math.round(performance.now() - started),
    items: hits.map((h) => toHit(h._source, h.highlight)),
    groups,
    nextCursor: hits.length === page.limit ? encodeCursor(hits.at(-1)!.sort) : null,
  };
}

// Sort values can be any mix of numbers and strings; decodeCursor wants a fixed arity, which varies by query.
function decodeSortCursor(cursor: string): (string | number)[] {
  const arity = (() => {
    try {
      return (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]).length;
    } catch {
      throw badRequest('The page cursor is not valid. Run the search again.');
    }
  })();
  return decodeCursor(cursor, arity) as (string | number)[];
}

/** Every matching case key up to `max`, for turning a search into a run. */
export async function searchKeys(
  trx: Tx,
  index: CaseIndex,
  caller: Caller,
  projectId: string,
  tql: string,
  max: number,
): Promise<{ keys: string[]; more: boolean }> {
  const query = parseOrReject(tql);
  const resolved = await resolveNames(trx, projectId, { ...query, groupBy: null }, caller);
  const keys: string[] = [];
  let after: unknown[] | undefined;
  while (keys.length <= max) {
    const body = searchBody({ ...query, groupBy: null }, projectId, resolved, { size: 1000, after });
    const res = await index.client.search({
      index: ALIAS,
      routing: projectId,
      body: { ...body, highlight: undefined, _source: ['key_no'] } as never,
    });
    const hits = (res.body as unknown as { hits: { hits: Hit[] } }).hits.hits;
    keys.push(...hits.map((h) => caseKey(h._source.key_no)));
    if (hits.length < 1000) break;
    after = hits.at(-1)!.sort;
  }
  return { keys: keys.slice(0, max), more: keys.length > max };
}

/** Distinct labels and case types in a project, for editor autocomplete. */
export async function fieldValues(
  index: CaseIndex,
  projectId: string,
): Promise<{ label: string[]; type: string[] }> {
  const res = await index.client.search({
    index: ALIAS,
    routing: projectId,
    body: {
      size: 0,
      query: { term: { project_id: projectId } },
      aggs: {
        label: { terms: { field: 'labels', size: 100 } },
        type: { terms: { field: 'type', size: 50 } },
      },
    } as never,
  });
  const aggs = (
    res.body as unknown as { aggregations: Record<'label' | 'type', { buckets: { key: string }[] }> }
  ).aggregations;
  return { label: aggs.label.buckets.map((b) => b.key), type: aggs.type.buckets.map((b) => b.key) };
}
