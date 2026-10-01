import { describe, expect, it } from 'vitest';
import { apisOf } from './intent/workflow-service';
import { examplesOnly, pagePath, recordedPath } from './site';

describe('page paths', () => {
  it('keep the address without its query, ids made ":id"', () => {
    expect(pagePath('https://x.test/home/projects?email=a')).toBe('/home/projects');
    expect(pagePath('https://x.test/home/projects/48213/')).toBe('/home/projects/:id');
    expect(pagePath('https://x.test/')).toBe('/');
    expect(recordedPath('/home/projects/')).toBe('/home/projects/:id');
    expect(recordedPath('/home/projects')).toBe('/home/projects');
  });
});

describe('examplesOnly', () => {
  it('keeps a few links to a page of one kind, named by its data, and every other action', () => {
    const link = (label: string, to: string | null) => ({ label, role: 'link' as const, to });
    const out = examplesOnly([link('Alpha', '/p/:id'), link('Beta', '/p/:id'), link('Home', '/'), link('Gamma', '/p/:id'), link('Delta', '/p/:id'), link('Add', null)], 2);
    expect(out.map((a) => a.label)).toEqual(['Alpha', 'Beta', 'Home', 'Add']);
  });
});

describe('apisOf', () => {
  it('keeps each call once, after the action that set it off', () => {
    const tab = 't';
    const el = { tag: 'button', role: 'button', text: 'Add', xpath: '', suggestedName: 'Add', page: '/', url: '', locators: [] };
    const apis = apisOf([
      { action: 'open', tab, url: 'https://x.test/home' },
      { action: 'api', tab, method: 'get', url: 'https://x.test/api/projects', status: 200 },
      { action: 'click', tab, element: el, frames: [] } as never,
      { action: 'api', tab, method: 'POST', url: 'https://x.test/api/projects', status: 201 },
      { action: 'api', tab, method: 'POST', url: 'https://x.test/api/projects', status: 201 },
    ]);
    expect(apis).toEqual([
      { method: 'GET', path: '/api/projects', status: 200, after: 'opening the page' },
      { method: 'POST', path: '/api/projects', status: 201, after: 'click Add' },
    ]);
  });
});
