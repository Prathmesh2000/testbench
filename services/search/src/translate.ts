import { parseCaseKey } from '@tb/contracts';
import type { Clause, Expr, FieldSpec, Query } from '@tb/tql';

// TQL → OpenSearch query DSL. The parser has already validated fields, operators and values; this
// module only maps them. Values that need a database lookup (owner names, module paths) are resolved
// by the caller beforehand and passed in `Resolved`.

type Dsl = Record<string, unknown>;

export interface Resolved {
  /** Owner value as typed (name, email or "me") → user id; unknown people map to null. */
  owners: Map<string, string | null>;
  /** Module value as typed ("UPI", "UPI / Collect") → the ids of matching modules. */
  modules: Map<string, string[]>;
  now: Date;
}

/** Index field for each TQL field. Text fields have their own handling below. */
const COLUMN: Record<string, string> = {
  key: 'key_no',
  module: 'module_ids',
  priority: 'priority',
  status: 'status',
  lastResult: 'last_result',
  automation: 'automation',
  type: 'type',
  label: 'labels',
  owner: 'owner_id',
  updated: 'updated_at',
  created: 'created_at',
  lastRun: 'last_run_at',
  estimate: 'estimate_min',
};
const SORT_COLUMN: Record<string, string> = {
  key: 'key_no',
  title: 'title.raw',
  module: 'module_sort',
  priority: 'priority_rank',
  status: 'status',
  lastResult: 'last_result',
  updated: 'updated_at',
  created: 'created_at',
  lastRun: 'last_run_at',
  estimate: 'estimate_min',
};
export const GROUP_COLUMN: Record<string, string> = {
  module: 'module_path',
  priority: 'priority',
  status: 'status',
  lastResult: 'last_result',
  automation: 'automation',
  type: 'type',
  label: 'labels',
  owner: 'owner_name',
};

function textQuery(fields: string[], text: string, proximity?: number): Dsl {
  // A phrase with slop is "these words within N positions of each other" (HLD §6); plain text needs every word.
  return proximity !== undefined
    ? { multi_match: { query: text, fields, type: 'phrase', slop: proximity } }
    : { multi_match: { query: text, fields, operator: 'and' } };
}

function valuesOf(field: FieldSpec, clause: Clause, resolved: Resolved): (string | number)[] {
  const raw =
    clause.value.kind === 'list'
      ? clause.value.items
      : clause.value.kind === 'text'
        ? [clause.value.text]
        : [];
  if (field.name === 'key') return raw.map((k) => parseCaseKey(k) ?? -1);
  if (field.name === 'owner') return raw.map((v) => resolved.owners.get(v) ?? '__nobody__');
  if (field.name === 'module') return raw.flatMap((v) => resolved.modules.get(v) ?? ['__nowhere__']);
  return raw;
}

function dateBound(clause: Clause, now: Date): string {
  return clause.value.kind === 'relative'
    ? new Date(now.getTime() + clause.value.ms).toISOString()
    : clause.value.kind === 'date'
      ? clause.value.iso
      : '';
}

function clauseQuery(clause: Clause, resolved: Resolved): Dsl {
  const { field, op, value } = clause;
  const negate = (q: Dsl): Dsl => ({ bool: { must_not: q } });

  if (field.type === 'text') {
    const text = value.kind === 'text' ? value : { text: '', proximity: undefined };
    const fields = field.name === 'title' ? ['title'] : ['title^2', 'steps_text'];
    const q = textQuery(fields, text.text, text.proximity);
    return op === '!~' ? negate(q) : q;
  }
  const column = COLUMN[field.name]!;
  if (op === 'IS EMPTY') return negate({ exists: { field: column } });
  if (op === 'IS NOT EMPTY') return { exists: { field: column } };

  if (field.name === 'module' && op === '~') {
    const text = value.kind === 'text' ? value.text : '';
    return {
      wildcard: { module_path: { value: `*${text.replace(/[*?\\]/g, '\\$&')}*`, case_insensitive: true } },
    };
  }

  if (field.type === 'date') {
    const bound = dateBound(clause, resolved.now);
    if (op === '=') {
      // "on that day": the whole day in IST, since that is what testers mean by a date.
      const start = new Date(`${bound.slice(0, 10)}T00:00:00+05:30`);
      return {
        range: {
          [column]: { gte: start.toISOString(), lt: new Date(start.getTime() + 86_400_000).toISOString() },
        },
      };
    }
    return {
      range: { [column]: { [{ '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }[op as '>']]: bound } },
    };
  }
  if (field.type === 'number') {
    const n = value.kind === 'number' ? value.n : 0;
    return op === '='
      ? { term: { [column]: n } }
      : { range: { [column]: { [{ '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }[op as '>']]: n } } };
  }
  if (field.name === 'priority' && ['>', '>=', '<', '<='].includes(op)) {
    // Higher priority means a lower number: "priority >= P1" is P0 or P1.
    const rank = Number((value.kind === 'text' ? value.text : 'P0').slice(1));
    return {
      range: { priority_rank: { [{ '>': 'lt', '>=': 'lte', '<': 'gt', '<=': 'gte' }[op as '>']]: rank } },
    };
  }

  const values = valuesOf(field, clause, resolved);
  const q: Dsl = values.length === 1 ? { term: { [column]: values[0] } } : { terms: { [column]: values } };
  return op === '!=' || op === 'NOT IN' ? negate(q) : q;
}

export function whereQuery(expr: Expr | null, resolved: Resolved): Dsl {
  if (!expr) return { match_all: {} };
  if (expr.type === 'clause') return clauseQuery(expr, resolved);
  if (expr.type === 'not') return { bool: { must_not: whereQuery(expr.expr, resolved) } };
  // Flatten chains of the same operator so a ten-clause AND stays one bool, not ten nested ones.
  const flatten = (e: Expr, type: 'and' | 'or'): Expr[] =>
    e.type === type ? [...flatten(e.left, type), ...flatten(e.right, type)] : [e];
  const parts = flatten(expr, expr.type).map((e) => whereQuery(e, resolved));
  return expr.type === 'and'
    ? { bool: { must: parts } }
    : { bool: { should: parts, minimum_should_match: 1 } };
}

export function hasTextSearch(expr: Expr | null): boolean {
  if (!expr) return false;
  if (expr.type === 'clause') return expr.field.type === 'text' && expr.op === '~';
  if (expr.type === 'not') return false;
  return hasTextSearch(expr.left) || hasTextSearch(expr.right);
}

/**
 * Full request body for one page. Always scoped to the project, sorted deterministically (case_id is
 * the final tie-breaker, which search_after pagination requires), grouped fields sorted first so
 * groups arrive contiguous across pages.
 */
export function searchBody(
  query: Query,
  projectId: string,
  resolved: Resolved,
  page: { size: number; after?: unknown[] },
): Dsl {
  const sort: Dsl[] = [];
  if (query.groupBy)
    sort.push({
      [query.groupBy.name === 'module' ? 'module_sort' : GROUP_COLUMN[query.groupBy.name]!]: 'asc',
    });
  for (const o of query.orderBy)
    sort.push({ [SORT_COLUMN[o.field.name]!]: { order: o.dir, missing: '_last' } });
  if (!query.orderBy.length) sort.push(hasTextSearch(query.where) ? { _score: 'desc' } : { key_no: 'asc' });
  sort.push({ case_id: 'asc' });

  return {
    size: page.size,
    track_total_hits: 100_000,
    query: {
      bool: { filter: [{ term: { project_id: projectId } }], must: [whereQuery(query.where, resolved)] },
    },
    sort,
    ...(page.after && { search_after: page.after }),
    highlight: {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        title: { number_of_fragments: 0 },
        steps_text: { fragment_size: 120, number_of_fragments: 1 },
      },
    },
    ...(query.groupBy &&
      !page.after && {
        aggs: { groups: { terms: { field: GROUP_COLUMN[query.groupBy.name]!, size: 100, missing: '—' } } },
      }),
  };
}
