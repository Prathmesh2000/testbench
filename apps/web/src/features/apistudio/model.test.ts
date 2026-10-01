import type { ApiNode, ApiRequestDef } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { nestTree, overridesFrom, pathTo, prettyBody, statusTone, variablesIn, withOverrides } from './model';

const node = (id: string, parentId: string | null, position = 0, name = id): ApiNode => ({
  id,
  parentId,
  kind: parentId ? 'folder' : 'collection',
  name,
  position,
  method: null,
  variationCount: 0,
  needsReview: null,
  updatedAt: '',
});

const req: ApiRequestDef = {
  method: 'POST',
  url: '{{baseUrl}}/orders',
  params: [],
  headers: [{ key: 'A', value: '1', enabled: true }],
  body: { type: 'json', text: '{"qty":1}' },
  auth: { type: 'inherit' },
  assertions: [],
  extractors: [],
  settings: { timeoutMs: 30000, followRedirects: true },
  docs: '',
  scripts: { pre: '', post: '' },
  operation: null,
};

describe('tree', () => {
  it('nests by parent and orders siblings by position then name', () => {
    const tree = nestTree([node('b', 'c1', 1), node('c1', null), node('a', 'c1', 1), node('z', 'c1', 0), node('lost', 'gone')]);
    expect(tree.map((t) => t.id)).toEqual(['c1']);
    expect(tree[0]!.children.map((t) => t.id)).toEqual(['z', 'a', 'b']);
  });

  it('finds the path from the root', () => {
    expect(pathTo([node('c', null), node('f', 'c'), node('r', 'f')], 'r')).toEqual(['c', 'f', 'r']);
  });
});

describe('variations', () => {
  it('stores only the fields that differ, and applies them back', () => {
    const edited = { ...req, body: { type: 'json' as const, text: '{"qty":0}' } };
    const overrides = overridesFrom(req, edited);
    expect(overrides).toEqual({ body: edited.body });
    expect(withOverrides(req, overrides)).toEqual(edited);
    expect(overridesFrom(req, req)).toEqual({});
  });
});

describe('display', () => {
  it('indents JSON and leaves other text alone', () => {
    expect(prettyBody('{"a":1}', 'application/json')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('<p>hi</p>', 'text/html')).toBe('<p>hi</p>');
    expect(prettyBody('{broken', 'application/json')).toBe('{broken');
  });

  it('groups status codes', () => {
    expect([200, 301, 404, 503, null].map(statusTone)).toEqual(['ok', 'redirect', 'client', 'server', 'none']);
  });

  it('lists the variables a text uses', () => {
    expect(variablesIn('{{baseUrl}}/orders/{{ id }}?x={{$uuid}}')).toEqual(['baseUrl', 'id']);
  });
});
