import type { AutoStep } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { generateCode, locatorExpr, valueExpr } from './generate';
import { validateSteps, type ValidationContext } from './validate';

const step = (s: Partial<AutoStep> & Pick<AutoStep, 'id' | 'action'>): AutoStep => ({ assertions: [], noCheck: false, intent: '', ...s });
const lib = { elements: new Map(), components: new Map() };

const checkout: AutoStep[] = [
  step({ id: 's1', action: 'open', value: '{env.baseUrl}/login', intent: 'Open login', assertions: [{ kind: 'title_contains', expected: 'Login', soft: false }] }),
  step({ id: 's2', action: 'type', target: { locator: { strategy: 'label', value: 'Email' } }, value: '{data.email}' }),
  step({ id: 's3', action: 'type', target: { locator: { strategy: 'label', value: 'Password' } }, value: '{secret.password}' }),
  step({
    id: 's4',
    action: 'click',
    target: { locator: { strategy: 'role', value: 'button', name: 'Sign in' } },
    assertions: [{ kind: 'url_contains', expected: '/dashboard', soft: false }],
  }),
];

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  dataColumns: ['email'],
  secrets: ['password'],
  elementIds: new Set(),
  components: new Map(),
  ...over,
});

describe('values', () => {
  it('keeps step text as string data and turns placeholders into lookups', () => {
    expect(valueExpr('plain')).toBe('"plain"');
    expect(valueExpr('{env.baseUrl}/login')).toBe(`(env["baseUrl"] ?? '') + "/login"`);
    expect(valueExpr('{secret.password}')).toBe('secret("password")');
    // Quotes, backticks and ${} in step text can never become code.
    expect(valueExpr('a"b`${x}')).toBe(JSON.stringify('a"b`${x}'));
  });

  it('renders each locator strategy with Playwright’s recommended API', () => {
    expect(locatorExpr({ strategy: 'testid', value: 'pay' })).toBe('page.getByTestId("pay")');
    expect(locatorExpr({ strategy: 'role', value: 'button', name: 'Pay' })).toBe(
      'page.getByRole(role("button"), { name: "Pay", exact: true })',
    );
    expect(locatorExpr({ strategy: 'css', value: '#pay' })).toBe('page.locator("#pay")');
  });
});

describe('generateCode', () => {
  it('writes one test.step per step with web-first assertions and no sleeps', () => {
    const { code, runnable } = generateCode({ title: 'Login', key: 'AT-1', version: 3, steps: checkout }, lib);
    expect(runnable).toBe(true);
    expect(code).toContain('await test.step("1. Open login"');
    expect(code).toContain('await page.goto((env["baseUrl"] ?? \'\') + "/login");');
    expect(code).toContain('await page.getByLabel("Email", { exact: true }).fill((data["email"] ?? \'\'));');
    expect(code).toContain('await expect(page).toHaveURL(contains("/dashboard"));');
    expect(code).not.toMatch(/waitForTimeout|setTimeout/);
  });

  it('marks tests with a manual step as not runnable unattended', () => {
    const { runnable, code } = generateCode(
      { title: 'Token', key: 'AT-2', version: 1, steps: [step({ id: 'm', action: 'manual', intent: 'Tap the hardware key' })] },
      lib,
    );
    expect(runnable).toBe(false);
    expect(code).toContain("process.env.TB_ASSIST !== '1'");
  });

  it('inlines component steps with their inputs in place of data', () => {
    const comp = { name: 'Login', steps: [checkout[1]!] };
    const { code } = generateCode(
      {
        title: 'Uses login',
        key: 'AT-3',
        version: 1,
        steps: [step({ id: 'c', action: 'use_component', component: { id: '00000000-0000-4000-8000-000000000001', version: 2, inputs: { email: '{data.email}' } }, noCheck: true })],
      },
      { elements: new Map(), components: new Map([['00000000-0000-4000-8000-000000000001@2', comp]]) },
    );
    expect(code).toContain('const input: Record<string, string> = { "email": (data["email"] ?? \'\') };');
    expect(code).toContain(".fill((input[\"email\"] ?? ''))");
  });
});

describe('validateSteps', () => {
  it('accepts a well-formed test', () => {
    expect(validateSteps(checkout, ctx()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('requires a check after an action that changes the page', () => {
    const issues = validateSteps([step({ id: 'a', action: 'click', target: { locator: { strategy: 'testid', value: 'go' } } })], ctx());
    expect(issues.map((i) => i.code)).toContain('needs_assertion');
    const ok = validateSteps([step({ id: 'a', action: 'click', target: { locator: { strategy: 'testid', value: 'go' } }, noCheck: true })], ctx());
    expect(ok.map((i) => i.code)).not.toContain('needs_assertion');
  });

  it('refuses unknown data columns, undeclared secrets and unsaved vars', () => {
    const codes = validateSteps(
      [step({ id: 'a', action: 'type', target: { locator: { strategy: 'label', value: 'X' } }, value: '{data.pin}{secret.otp}{vars.id}' })],
      ctx(),
    ).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['unknown_data', 'unknown_secret', 'unknown_var']));
  });

  it('warns about fragile CSS locators and tests that check nothing', () => {
    const codes = validateSteps([step({ id: 'a', action: 'hover', target: { locator: { strategy: 'css', value: 'div > a' } } })], ctx()).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['fragile_locator', 'no_assertions']));
  });
});
