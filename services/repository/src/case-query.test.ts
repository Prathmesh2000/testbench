import type { Database } from '@tb/platform';
import { encodeCursor } from '@tb/platform';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import { afterCursor, caseFilter, cursorAfter, escapeLike } from './case-query';

// Compiles queries without a database, to check the SQL each filter produces.
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const PROJECT = '11111111-1111-1111-1111-111111111111';
const MODULE = '22222222-2222-2222-2222-222222222222';

function compile(filter: Parameters<typeof caseFilter>[1]) {
  return db
    .selectFrom('repo.test_case as c')
    .innerJoin('repo.module as m', 'm.id', 'c.module_id')
    .select('c.id')
    .where(caseFilter(PROJECT, filter))
    .compile();
}

describe('caseFilter', () => {
  it('always scopes to the project', () => {
    const q = compile({});
    expect(q.sql).toContain('"c"."project_id" = $1');
    expect(q.parameters).toEqual([PROJECT]);
  });

  it('matches a module subtree through ltree', () => {
    const q = compile({ moduleId: MODULE });
    expect(q.sql).toContain('sub.path <@ (SELECT path FROM repo.module WHERE id = $3)');
    expect(q.parameters).toContain(MODULE);
  });

  it('requires all labels and uses the GIN-indexable containment operator', () => {
    const q = compile({ labels: ['smoke', 'p0-flow'] });
    expect(q.sql).toContain('c.labels @> $2::text[]');
    expect(q.parameters).toContainEqual(['smoke', 'p0-flow']);
  });

  it('treats a case key in the search box as an exact key lookup', () => {
    const q = compile({ q: 'tc-10231' });
    expect(q.sql).toContain('"c"."key_no" = $2');
    expect(q.parameters).toContain(10231);
  });

  it('escapes LIKE wildcards in title search', () => {
    const q = compile({ q: '100%_off' });
    expect(q.sql).toContain('"c"."title" ilike $2');
    expect(q.parameters).toContain('%100\\%\\_off%');
  });

  it('turns explicit keys into key numbers and never matches everything when none parse', () => {
    expect(compile({ keys: ['TC-1', 'TC-2'] }).parameters).toEqual([PROJECT, 1, 2]);
    expect(compile({ keys: ['TC-x'] as never }).parameters).toEqual([PROJECT, -1]);
  });
});

describe('keyset pagination', () => {
  const row = {
    id: 'abc',
    key_no: 10231,
    title: 'Verify OTP',
    priority: 'P1',
    status: 'ready',
    updated_at: new Date('2026-09-27T10:00:00Z'),
    module_path: 'a.b',
    last_result: 'passed',
  };

  it('encodes the sort value and id of the last row', () => {
    const cursor = cursorAfter('updated', row);
    const sql = db
      .selectFrom('repo.test_case as c')
      .select('c.id')
      .where(afterCursor({ sort: 'updated', dir: 'desc' }, cursor))
      .compile();
    expect(sql.sql).toContain('("c"."updated_at", c.id) < (CAST($1 AS timestamptz), CAST($2 AS uuid))');
    expect(sql.parameters).toEqual(['2026-09-27T10:00:00.000Z', 'abc']);
  });

  it('compares forwards for ascending sorts', () => {
    const sql = db
      .selectFrom('repo.test_case as c')
      .select('c.id')
      .where(afterCursor({ sort: 'key', dir: 'asc' }, encodeCursor([10231, 'abc'])))
      .compile();
    expect(sql.sql).toContain('("c"."key_no", c.id) > (CAST($1 AS integer), CAST($2 AS uuid))');
  });

  it('rejects a cursor from another shape', () => {
    expect(() => afterCursor({ sort: 'key', dir: 'asc' }, encodeCursor([1]))).toThrow();
  });
});

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });
});
