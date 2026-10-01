import type { DraftRow, FieldKind, FieldRules } from '@tb/contracts';

/** A field the recording typed into, with what it held then. */
export interface RecordedField {
  key: string;
  label: string;
  rules: FieldRules;
  value: string;
}

/** What a field holds, from its type, name, autocomplete and label, in that order of trust. */
export function fieldKind(f: Pick<RecordedField, 'label' | 'rules'>): FieldKind {
  const { type, name, autocomplete, inputMode } = f.rules;
  const words = `${name} ${autocomplete} ${f.label}`.toLowerCase();
  if (type === 'select') return 'select';
  if (type === 'password') return 'password';
  // One-time codes change on every run, so a recorded one can never be replayed.
  if (autocomplete === 'one-time-code' || /\botp\b|one.?time|verification.?code|\d.?digit.?code|security.?code/.test(words)) return 'otp';
  if (type === 'email' || /e-?mail/.test(words)) return 'email';
  if (type === 'tel' || /mobile|phone|\btel\b/.test(words)) return 'phone';
  if (/pin ?code|postal|zip/.test(words)) return 'pincode';
  if (type === 'date' || /\b(date|dob|birth)\b/.test(words)) return 'date';
  if (type === 'url' || /\b(url|website)\b/.test(words)) return 'url';
  if (type === 'number' || inputMode === 'numeric' || inputMode === 'decimal') return 'number';
  if (type === 'search' || /search|query|\bq\b/.test(words)) return 'search';
  if (/\bname\b|given|family|surname/.test(words)) return 'name';
  return 'text';
}

/** Another value of the same kind, so the valid rows are not all the recorded one. */
function otherValid(kind: FieldKind, f: RecordedField): string | null {
  switch (kind) {
    case 'email':
      return 'qa.tester+tb@example.com';
    case 'phone':
      return '9876543210';
    case 'pincode':
      return '400001';
    case 'name':
      // Accents and an apostrophe: names a form must accept and often mangles.
      return "Zoë D'Souza";
    case 'date':
      return f.rules.type === 'date' ? '2030-01-31' : '31/01/2030';
    case 'url':
      return 'https://example.com/path?x=1';
    case 'number': {
      const min = Number(f.rules.min);
      return f.rules.min !== '' && Number.isFinite(min) ? String(min) : '1';
    }
    case 'select':
      return f.rules.options.find((o) => o && o !== f.value && !/^(select|choose|--)/i.test(o)) ?? null;
    case 'search':
      // What else is worth searching for depends on the product; that is the model's call, not a rule's.
      return null;
    case 'text':
      if (f.rules.maxLength > 0) return 'x'.repeat(Math.min(f.rules.maxLength, 200)); // exactly at the limit
      return null;
    case 'password':
    case 'otp':
    case 'other':
      return null;
  }
}

/**
 * A plain valid value for a field the tester left empty, so the "every field filled" row is complete.
 * Real enough to pass ordinary checks; a team with stricter data edits the data set.
 */
export function sampleValue(f: Pick<RecordedField, 'label' | 'rules'>): string {
  const kind = fieldKind(f);
  const fit = (v: string) => (f.rules.maxLength > 0 ? v.slice(0, f.rules.maxLength) : v);
  switch (kind) {
    case 'email':
      return 'qa.tester+tb@example.com';
    case 'phone':
      return '9876543210';
    case 'pincode':
      return '400001';
    case 'name':
      return fit('Test User');
    case 'date':
      return f.rules.type === 'date' ? '2030-01-31' : '31/01/2030';
    case 'url':
      return 'https://example.com';
    case 'number':
      return f.rules.min !== '' && Number.isFinite(Number(f.rules.min)) ? String(Math.max(Number(f.rules.min), 1)) : '1';
    case 'select':
      return f.rules.options.find((o) => o && !/^(select|choose|--|please)/i.test(o)) ?? '';
    case 'search':
      return fit('test');
    default:
      return fit(`Test ${f.label || 'value'}`.trim());
  }
}

/** Values each kind must refuse, with what they test. Only what the field's own rules or kind justify. */
function invalidFor(kind: FieldKind, f: RecordedField): Array<{ value: string; case: string }> {
  const out: Array<{ value: string; case: string }> = [];
  const label = f.label || f.key;
  if (f.rules.required) out.push({ value: '', case: `${label} left empty` });
  // Not "one over maxlength": the browser stops typing at the limit, so the page never sees it and
  // the row is not invalid at all (a replay showed it being accepted). The limit itself is a valid row.
  if (f.rules.minLength > 1) out.push({ value: 'x'.repeat(f.rules.minLength - 1), case: `${label} one character under its minimum of ${f.rules.minLength}` });
  switch (kind) {
    case 'email':
      out.push({ value: 'qa.tester.example.com', case: `${label} without an @` }, { value: 'qa@tester', case: `${label} without a domain ending` });
      break;
    case 'phone':
      out.push({ value: '987654321', case: `${label} with 9 digits` }, { value: '5876543210', case: `${label} starting with 5` }, { value: '98765abcde', case: `${label} with letters` });
      break;
    case 'pincode':
      out.push({ value: '40001', case: `${label} with 5 digits` }, { value: '000000', case: `${label} of all zeros` });
      break;
    case 'number': {
      if (f.rules.min !== '' && Number.isFinite(Number(f.rules.min))) out.push({ value: String(Number(f.rules.min) - 1), case: `${label} below its minimum of ${f.rules.min}` });
      if (f.rules.max !== '' && Number.isFinite(Number(f.rules.max))) out.push({ value: String(Number(f.rules.max) + 1), case: `${label} above its maximum of ${f.rules.max}` });
      // A native number field will not take letters at all; only a text field that means a number can.
      if (f.rules.type !== 'number') out.push({ value: 'abc', case: `${label} that is not a number` });
      break;
    }
    case 'date':
      // Likewise a native date field cannot hold 30 February; a typed date field can.
      if (f.rules.type !== 'date') out.push({ value: '30/02/2023', case: `${label} that does not exist (30 February)` });
      break;
    case 'url':
      out.push({ value: 'not a url', case: `${label} that is not an address` });
      break;
    default:
      break;
  }
  if (f.rules.pattern) out.push({ value: '!!!', case: `${label} not matching its pattern` });
  if (kind !== 'password' && kind !== 'select' && f.rules.required) out.push({ value: '   ', case: `${label} of spaces only` });
  // The same value twice is one test, not two.
  return out.filter((v, i) => out.findIndex((o) => o.value === v.value) === i);
}

const MAX_INVALID = 20;

/**
 * Data rows for the fields the recording typed into: valid ones (the recorded values, then other
 * values of the same kinds), and invalid ones that each break exactly one field and keep the rest
 * valid, so a failure points at one cause. Passwords are not varied: they come from a secret.
 * Other valid values are only for the fields in `vary` too: a prerequisite's login stays as recorded.
 */
export function variations(fields: RecordedField[], vary?: Set<string>): { valid: DraftRow[]; invalid: DraftRow[] } {
  const varied = fields.filter((f) => fieldKind(f) !== 'password' && fieldKind(f) !== 'otp');
  const base = Object.fromEntries(varied.map((f) => [f.key, f.value]));
  const valid: DraftRow[] = [{ values: { ...base }, case: 'As recorded', source: 'recorded' }];
  // Other values of the same kinds, with every field filled in, the ones the tester left empty too.
  const alt = Object.fromEntries(
    varied.map((f) => [f.key, (!vary || vary.has(f.key) ? (otherValid(fieldKind(f), f) ?? (f.value || sampleValue(f))) : null) ?? f.value]),
  );
  if (Object.entries(alt).some(([k, v]) => v !== base[k])) valid.push({ values: alt, case: 'Other valid values, every field filled in', source: 'rule' });
  const invalid: DraftRow[] = [];
  // Only the fields `vary` names are broken (the form the negative test submits); the others keep
  // their recorded values, so an invalid row fails where it should and not at an earlier login.
  for (const f of varied.filter((x) => !vary || vary.has(x.key)))
    for (const bad of invalidFor(fieldKind(f), f)) {
      if (invalid.length >= MAX_INVALID) break;
      invalid.push({ values: { ...base, [f.key]: bad.value }, case: bad.case, source: 'rule' });
    }
  return { valid, invalid };
}
