import { FieldRules } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { fieldKind, variations } from './variations';

const rules = (r: Partial<FieldRules> = {}) => FieldRules.parse(r);

describe('fieldKind', () => {
  it('reads a field from its type, name and label', () => {
    expect(fieldKind({ label: 'Enter Mobile Number', rules: rules({ type: 'text' }) })).toBe('phone');
    expect(fieldKind({ label: 'Work email', rules: rules() })).toBe('email');
    expect(fieldKind({ label: 'Pincode', rules: rules({ inputMode: 'numeric' }) })).toBe('pincode');
    expect(fieldKind({ label: 'Password', rules: rules({ type: 'password' }) })).toBe('password');
    expect(fieldKind({ label: 'Qty', rules: rules({ type: 'number' }) })).toBe('number');
    expect(fieldKind({ label: 'Enter 6 digit code', rules: rules({ type: 'number' }) })).toBe('otp');
    expect(fieldKind({ label: 'Code', rules: rules({ autocomplete: 'one-time-code' }) })).toBe('otp');
  });
});

describe('variations', () => {
  const mobile = { key: 'mobile', label: 'Mobile number', rules: rules({ type: 'tel', required: true, maxLength: 10 }), value: '9123456789' };
  const city = { key: 'city', label: 'City', rules: rules({ required: false }), value: 'Pune' };
  const pass = { key: 'password', label: 'Password', rules: rules({ type: 'password', required: true }), value: '' };

  it('keeps the recorded row first and adds other valid values', () => {
    const { valid } = variations([mobile, city]);
    expect(valid[0]).toEqual({ values: { mobile: '9123456789', city: 'Pune' }, case: 'As recorded', source: 'recorded' });
    expect(valid[1]!.values.mobile).toBe('9876543210');
  });

  it('breaks one field per invalid row, from that field’s own rules', () => {
    const { invalid } = variations([mobile, city]);
    expect(invalid.map((r) => r.case)).toEqual([
      'Mobile number left empty',
      'Mobile number with 9 digits',
      'Mobile number starting with 5',
      'Mobile number with letters',
      'Mobile number of spaces only',
    ]);
    for (const row of invalid) expect(row.values.city).toBe('Pune');
  });

  it('leaves passwords to secrets', () => {
    const { valid, invalid } = variations([mobile, pass]);
    expect(valid[0]!.values).not.toHaveProperty('password');
    expect(invalid.every((r) => !('password' in r.values))).toBe(true);
  });
});
