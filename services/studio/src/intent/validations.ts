import type { FieldCheckOffer, FieldValidation, Scenario, Workflow } from '@tb/contracts';
import { UNIQUE_TOKEN } from '@tb/contracts';
import { sampleValue } from './variations';

// What to test in a workflow comes from the tester: their intent, and for each field whether it is
// required, unique, and which values to try. This file offers those values, from what the page says
// about each field (its type, role and rules), and turns the tester's picks into scenarios. It never
// invents scenarios the tester did not ask for; the chat may add ones their intent needs.

const UNIQUE_WORDS = /\b(name|title|code|slug|e-?mail|username|user ?id|sku|reference|handle|login)\b/i;
const PLACEHOLDER_OPTION = /^(select|choose|--|please|pick)/i;

type Offer = FieldCheckOffer['suggestions'][number];

/** The rules a field states in the page, as words a tester reads. */
function factsOf(f: Workflow['fields'][number]): string[] {
  const r = f.rules;
  return [
    r.required ? 'required' : 'optional',
    r.type && !['text', 'textarea', 'select'].includes(r.type) ? `type ${r.type}` : '',
    r.minLength > 0 ? `at least ${r.minLength} characters` : '',
    r.maxLength > 0 ? `at most ${r.maxLength} characters` : '',
    r.pattern ? `pattern ${r.pattern}` : '',
    r.min ? `min ${r.min}` : '',
    r.max ? `max ${r.max}` : '',
    r.options.length ? `${r.options.length} options` : '',
  ].filter(Boolean);
}

/** Checks worth offering for one field: those its kind, role and rules justify, and no more. */
export function fieldOffers(w: Workflow): FieldCheckOffer[] {
  return w.fields
    .filter((f) => !f.secret && f.kind !== 'password' && f.kind !== 'otp')
    .map((f) => {
      const r = f.rules;
      const out: Offer[] = [];
      const add = (o: Omit<Offer, 'selected'> & { selected?: boolean }) => out.push({ selected: false, ...o });
      if (f.kind === 'select') {
        const placeholder = r.options.find((o) => PLACEHOLDER_OPTION.test(o));
        add({ id: 'no-option', label: 'No option chosen', outcome: 'rejected', value: placeholder ?? '', why: 'A required choice left at its placeholder must be refused.', when: 'required', selected: r.required });
        r.options
          .filter((o) => o && !PLACEHOLDER_OPTION.test(o) && o !== f.recorded)
          .slice(0, 8)
          .forEach((o, i) => add({ id: `option-${i}`, label: `Option “${o}”`, outcome: 'success', value: o, why: 'Each option the form offers should be taken.', when: 'always' }));
      } else {
        add({ id: 'empty-refused', label: 'Left empty', outcome: 'rejected', value: '', why: 'A required field left empty must be refused, with its error.', when: 'required', selected: r.required });
        add({ id: 'spaces', label: 'Only spaces', outcome: 'rejected', value: '   ', why: 'Spaces are not a value; many forms forget to trim.', when: 'required', selected: r.required });
        if (f.recorded) add({ id: 'empty-accepted', label: 'Left empty', outcome: 'success', value: '', why: 'An optional field may be left out.', when: 'optional', selected: !r.required });
        if (r.maxLength > 0) add({ id: 'at-max', label: `Exactly ${r.maxLength} characters (its maximum)`, outcome: 'success', value: 'A'.repeat(r.maxLength), why: 'The limit itself must be accepted. One over it cannot be typed: the browser stops there.', when: 'always', selected: true });
        if (r.minLength > 1) {
          add({ id: 'under-min', label: `${r.minLength - 1} characters (one under its minimum)`, outcome: 'rejected', value: 'x'.repeat(r.minLength - 1), why: 'Below the minimum must be refused.', when: 'always', selected: true });
          add({ id: 'at-min', label: `Exactly ${r.minLength} characters (its minimum)`, outcome: 'success', value: 'x'.repeat(r.minLength), why: 'The minimum itself must be accepted.', when: 'always' });
        }
        if (r.pattern) add({ id: 'pattern', label: 'Not matching its pattern', outcome: 'rejected', value: '!!!', why: `The page asks for ${r.pattern}.`, when: 'always', selected: true });
        switch (f.kind) {
          case 'email':
            add({ id: 'no-at', label: 'Without an @', outcome: 'rejected', value: 'qa.tester.example.com', why: 'Not an email address.', when: 'always', selected: true });
            add({ id: 'no-domain', label: 'Without a domain ending', outcome: 'rejected', value: 'qa@tester', why: 'Browsers accept it; many apps do not.', when: 'always' });
            break;
          case 'phone':
            add({ id: 'short', label: '9 digits', outcome: 'rejected', value: '987654321', why: 'An Indian mobile number has 10.', when: 'always', selected: true });
            add({ id: 'letters', label: 'With letters', outcome: 'rejected', value: '98765abcde', why: 'Only digits make a number.', when: 'always' });
            break;
          case 'pincode':
            add({ id: 'short', label: '5 digits', outcome: 'rejected', value: '40001', why: 'A PIN code has 6.', when: 'always', selected: true });
            break;
          case 'url':
            add({ id: 'not-url', label: 'Not an address', outcome: 'rejected', value: 'not a url', why: 'Not a web address.', when: 'always', selected: true });
            break;
          case 'number':
            if (r.min !== '' && Number.isFinite(Number(r.min))) add({ id: 'below-min', label: `Below its minimum of ${r.min}`, outcome: 'rejected', value: String(Number(r.min) - 1), why: 'Under the page’s own minimum.', when: 'always', selected: true });
            if (r.max !== '' && Number.isFinite(Number(r.max))) add({ id: 'above-max', label: `Above its maximum of ${r.max}`, outcome: 'rejected', value: String(Number(r.max) + 1), why: 'Over the page’s own maximum.', when: 'always', selected: true });
            if (r.min === '') add({ id: 'negative', label: 'A negative number', outcome: 'rejected', value: '-1', why: 'No minimum is set; the app may still refuse it.', when: 'always' });
            if (r.type !== 'number') add({ id: 'nan', label: 'Not a number', outcome: 'rejected', value: 'abc', why: 'A text field that means a number.', when: 'always', selected: true });
            break;
          case 'date':
            if (r.type === 'date') {
              add({ id: 'past', label: 'A date in the past', outcome: 'success', value: '2000-01-01', why: 'Whether a past date is allowed is the app’s rule: say which.', when: 'always' });
              add({ id: 'future', label: 'A date far in the future', outcome: 'success', value: '2099-12-31', why: 'Whether a far date is allowed is the app’s rule: say which.', when: 'always' });
            } else add({ id: 'no-such-date', label: '30 February', outcome: 'rejected', value: '30/02/2023', why: 'A date that does not exist.', when: 'always', selected: true });
            break;
          default:
            if (f.kind === 'name' || f.kind === 'text')
              add({ id: 'special', label: 'Accents and an apostrophe', outcome: 'success', value: "Zoë D'Souza", why: 'Real names a form must accept and often mangles.', when: 'always' });
        }
      }
      if (f.recorded && f.kind !== 'select')
        add({ id: 'duplicate', label: 'A value already used', outcome: 'rejected', value: f.recorded, why: 'Recording created one with this value, so it exists.', when: 'unique', selected: true });
      if (f.kind !== 'select') add({ id: 'other', label: 'Another valid value', outcome: 'success', value: sampleValue({ label: f.label, rules: r }), why: 'The form works beyond the recorded value.', when: 'always' });
      return {
        key: f.key,
        label: f.label,
        kind: f.kind,
        domRequired: r.required,
        facts: factsOf(f),
        uniqueLikely: f.kind !== 'select' && UNIQUE_WORDS.test(`${f.key} ${f.label} ${r.name}`),
        suggestions: out,
      };
    });
}

/**
 * A value that is new on every run, for a field the app keeps unique: `{unique}` is 8 characters and
 * is replaced by 8 characters, so a value within the field's limit stays within it.
 */
export function uniqueValue(value: string, maxLength: number, atMax = false): string {
  if (value.includes(UNIQUE_TOKEN)) return value;
  if (maxLength > 0 && maxLength < UNIQUE_TOKEN.length + 1) return value;
  if (atMax) return 'A'.repeat(maxLength - UNIQUE_TOKEN.length) + UNIQUE_TOKEN;
  const room = maxLength > 0 ? maxLength - UNIQUE_TOKEN.length - 1 : 200;
  return `${(value || 'Test').slice(0, room)} ${UNIQUE_TOKEN}`;
}

/** The scenarios the tester's picks make: the recorded journey, then one per chosen check. */
export function buildScenarios(w: Workflow, validations: FieldValidation[]): Scenario[] {
  const byKey = new Map(w.fields.map((f) => [f.key, f]));
  const unique = new Set(validations.filter((v) => v.unique && byKey.has(v.key)).map((v) => v.key));
  const dialog = w.pages.some((p) => p.messages.some((m) => m.kind === 'dialog'));
  const base = Object.fromEntries(
    w.fields.filter((f) => !f.secret).map((f) => [f.key, unique.has(f.key) ? uniqueValue(f.recorded, f.rules.maxLength) : f.recorded]),
  );
  const accepted = { outcome: 'success' as const, message: '', fieldErrors: [], page: 'any' as const, dialog: dialog ? ('closes' as const) : ('any' as const), stop: null, checks: [] };
  const out: Scenario[] = [
    { id: 'recorded', title: `${w.name} with the recorded values`, kind: 'positive', values: base, expect: accepted, seen: null, status: 'draft', source: 'rule' },
  ];
  for (const v of validations) {
    const f = byKey.get(v.key);
    if (!f || f.secret) continue;
    for (const c of v.checks) {
      // Every value but the duplicate is new on each run, or a rerun would be refused as a duplicate.
      const value = unique.has(f.key) && c.outcome === 'success' && c.value !== '' ? uniqueValue(c.value, f.rules.maxLength, c.id === 'at-max') : c.value;
      const values = { ...base, [f.key]: value };
      if (out.some((s) => JSON.stringify(s.values) === JSON.stringify(values))) continue;
      const refused = c.outcome === 'rejected';
      out.push({
        id: `${f.key}-${c.id}`.slice(0, 40),
        title: `${f.label}: ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)} ${refused ? 'is refused' : 'is accepted'}`.slice(0, 200),
        kind: refused ? 'negative' : /max|min/.test(c.id) ? 'boundary' : 'positive',
        values,
        expect: refused
          ? {
              outcome: 'rejected',
              // A duplicate is usually refused by the server with a message of its own, not the field's error:
              // discovery reads what it says.
              message: '',
              fieldErrors: c.id === 'duplicate' ? [] : [{ field: f.key, message: v.message, source: 'page' }],
              page: 'stays',
              dialog: dialog ? 'stays_open' : 'any',
              stop: null,
              checks: [],
            }
          : accepted,
        seen: null,
        status: 'draft',
        source: 'tester',
      });
    }
  }
  return out;
}
