import type { PickedElement, RecordedAction, RecordedStep } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { bestLocator, locatorCode, scriptCode, urlPattern } from './record-code';

type Loc = PickedElement['locators'][number];
const loc = (l: Partial<Loc> & Pick<Loc, 'strategy' | 'value'>): Loc => ({ code: '', matches: 1, stable: true, ...l });
const el = (locators: Loc[], extra: Partial<PickedElement> = {}): PickedElement => ({
  tag: 'button', role: 'button', text: '', xpath: '', suggestedName: '', page: '', url: '', locators, ...extra,
});
type Act = RecordedAction & { tab: string };
const act = (s: Partial<Act> & Pick<Act, 'action'>): RecordedStep => ({ tab: 'A', frames: [], secret: false, element: null, ...s });
const body = (steps: RecordedStep[]) => scriptCode(steps).split('\n').slice(1, -2).map((l) => l.trim());

describe('locators', () => {
  it('are written the way the picker writes them, text matched exactly', () => {
    expect(locatorCode({ strategy: 'role', value: 'button', name: 'Add' })).toBe('page.getByRole("button", { name: "Add", exact: true })');
    expect(locatorCode({ strategy: 'text', value: 'Add', within: { strategy: 'role', value: 'row', hasText: 'Dell XPS' }, nth: 1 })).toBe(
      'page.getByRole("row").filter({ hasText: "Dell XPS" }).getByText("Add", { exact: true }).nth(1)',
    );
  });

  it('prefer stable over data-dependent, and never read a stored value through itself', () => {
    const price = loc({ strategy: 'text', value: '₹499', stable: false });
    const id = loc({ strategy: 'testid', value: 'price' });
    expect(bestLocator(el([price, id]))).toBe(id);
    expect(bestLocator(el([loc({ strategy: 'text', value: 'ORD-4821' }), id]), 'ORD-4821')).toBe(id);
  });

  it('never let page text become code', () => {
    const hostile = 'x"); require("child_process").exec("rm -rf /"); ("';
    const code = scriptCode([act({ action: 'click', element: el([loc({ strategy: 'label', value: hostile, code: 'evil()' })]) })]);
    expect(code).toContain(JSON.stringify(hostile));
    expect(code).not.toContain('evil()');
  });
});

describe('urlPattern', () => {
  it('checks the path, not the host, with ids wildcarded', () => {
    expect(urlPattern('https://shop.example.com/orders/48213/items?x=1')).toBe('^https?://[^/]+/orders/[^/]+/items(?:[?#]|$)');
    expect(urlPattern('https://example.com/')).toBe('^https?://[^/]+/(?:[?#]|$)');
    expect(new RegExp(urlPattern('https://a.test/p/1f9c2e7a-0000-4c1b-9d7e-3a2b1c0d9e8f')).test('https://b.test/p/other-id')).toBe(true);
  });
});

describe('scriptCode', () => {
  const search = el([loc({ strategy: 'role', value: 'searchbox', name: 'Search' })], { tag: 'input', suggestedName: 'Search searchbox' });
  const result = (text: string) => el([loc({ strategy: 'text', value: text })], { tag: 'a' });

  it('turns typed values into data parameters and follows them into locators', () => {
    expect(
      body([
        { action: 'open', tab: 'A', url: 'https://example.com/' },
        act({ action: 'type', element: search, value: 'Mumbai' }),
        act({ action: 'click', element: result('Mumbai') }),
      ]),
    ).toEqual([
      'context.setDefaultTimeout(15_000);',
      'context.setDefaultNavigationTimeout(45_000);',
      `const data: Record<string, string> = { searchSearchbox: "Mumbai", ...JSON.parse(process.env.TB_DATA ?? '{}') };`,
      'await page.goto("https://example.com/");',
      'await page.getByRole("searchbox", { name: "Search", exact: true }).fill(data.searchSearchbox);',
      'await page.getByText(data.searchSearchbox, { exact: true }).click();',
    ]);
  });

  it('reads stored values at run time and uses them wherever they appear', () => {
    const order = el([loc({ strategy: 'text', value: 'ORD-4821' }), loc({ strategy: 'testid', value: 'order-id' })], { tag: 'span', suggestedName: 'Order id' });
    const lines = body([
      act({ action: 'store', element: order, value: 'ORD-4821' }),
      act({ action: 'type', element: search, value: 'ORD-4821' }),
      act({ action: 'click', element: result('Order ORD-4821') }),
    ]);
    expect(lines).toContain('vars.orderId = (await page.getByTestId("order-id").innerText()).trim();');
    expect(lines).toContain('await page.getByRole("searchbox", { name: "Search", exact: true }).fill(vars.orderId);');
    expect(lines).toContain('await page.getByText("Order " + vars.orderId, { exact: true }).click();');
  });

  it('waits for a new tab from the click that opens it, and checks page changes by pattern', () => {
    const link = el([loc({ strategy: 'role', value: 'link', name: 'Docs' })]);
    expect(
      body([
        { action: 'open', tab: 'A', url: 'https://example.com/' },
        { action: 'navigated', tab: 'A', url: 'https://example.com/' },
        act({ action: 'click', element: link }),
        { action: 'popup', tab: 'B', opener: 'A' },
        { action: 'navigated', tab: 'B', url: 'https://example.com/r/1' },
        { action: 'navigated', tab: 'B', url: 'https://example.com/docs/42' },
        act({ action: 'click', element: link, tab: 'B' }),
        { action: 'close', tab: 'B' },
      ]).slice(2),
    ).toEqual([
      'await page.goto("https://example.com/");',
      "const page1Promise = page.waitForEvent('popup');",
      'await page.getByRole("link", { name: "Docs", exact: true }).click();',
      'const page1 = await page1Promise;',
      'await page1.waitForLoadState();',
      'await expect(page1).toHaveURL(new RegExp("^https?://[^/]+/docs/[^/]+(?:[?#]|$)"));',
      'await page1.getByRole("link", { name: "Docs", exact: true }).click();',
      'await page1.close();',
    ]);
  });

  it('opens a tab made with + as a new page of the same context', () => {
    expect(
      body([
        { action: 'open', tab: 'A', url: 'https://example.com/' },
        { action: 'newtab', tab: 'B' },
        { action: 'open', tab: 'B', url: 'https://example.com/help' },
      ]).slice(2),
    ).toEqual(['await page.goto("https://example.com/");', 'const page1 = await context.newPage();', 'await page1.goto("https://example.com/help");']);
  });

  it('reaches into iframes, reads passwords from secrets and keeps a double click as one', () => {
    const frame = el([loc({ strategy: 'css', value: 'iframe[name="pay"]' })], { tag: 'iframe' });
    const pass = el([loc({ strategy: 'label', value: 'Password' })], { tag: 'input', suggestedName: 'Password' });
    const row = el([loc({ strategy: 'role', value: 'row', name: 'Invoice' })]);
    expect(
      body([
        act({ action: 'type', element: pass, secret: true, frames: [frame] }),
        act({ action: 'click', element: row }),
        act({ action: 'click', element: row }),
        act({ action: 'dblclick', element: row }),
      ]).slice(2),
    ).toEqual([
      `await page.locator("iframe[name=\\"pay\\"]").contentFrame().getByLabel("Password", { exact: true }).fill((process.env["TB_SECRET_password"] ?? ''));`,
      'await page.getByRole("row", { name: "Invoice", exact: true }).dblclick();',
    ]);
  });
});
