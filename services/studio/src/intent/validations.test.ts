import type { Workflow } from '@tb/contracts';
import { FieldRules } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { buildScenarios, fieldOffers, uniqueValue } from './validations';

const rules = (r: Partial<FieldRules>) => FieldRules.parse(r);
const workflow: Workflow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Create a project',
  version: 1,
  intent: 'Create a new project',
  purpose: '',
  prerequisite: null,
  continuation: null,
  inputs: ['name', 'email', 'priority'],
  fields: [
    { key: 'name', label: 'Project name', kind: 'text', rules: rules({ required: true, maxLength: 60 }), recorded: 'Alpha', secret: false },
    { key: 'email', label: 'Owner email', kind: 'email', rules: rules({ type: 'email' }), recorded: 'qa@x.test', secret: false },
    { key: 'priority', label: 'Priority', kind: 'select', rules: rules({ type: 'select', required: true, options: ['Select', 'High', 'Low'] }), recorded: 'High', secret: false },
  ],
  pages: [{ path: '/projects', title: '', headings: [], fields: [], actions: [], messages: [{ kind: 'dialog', text: 'New project', after: 'Add' }] }],
  steps: [],
  baseUrl: 'http://shop.test',
  apis: [],
  submitLabel: 'Add',
  updatedAt: '',
};

describe('fieldOffers', () => {
  it('offers what each field’s type, role and rules justify, preselecting what the page states', () => {
    const [name, email, priority] = fieldOffers(workflow);
    expect(name).toMatchObject({ domRequired: true, uniqueLikely: true, facts: ['required', 'at most 60 characters'] });
    const picked = (o: typeof name) => o!.suggestions.filter((x) => x.selected).map((x) => x.id);
    expect(picked(name)).toEqual(['empty-refused', 'spaces', 'at-max', 'duplicate']);
    expect(name!.suggestions.find((x) => x.id === 'at-max')).toMatchObject({ outcome: 'success', value: 'A'.repeat(60) });
    // Optional: empty is offered as accepted, not refused. The duplicate is shown once the field is marked unique.
    expect(picked(email)).toEqual(['empty-accepted', 'no-at', 'duplicate']);
    expect(email!.suggestions.find((x) => x.id === 'duplicate')!.when).toBe('unique');
    expect(priority!.suggestions.map((x) => [x.id, x.value])).toEqual([['no-option', 'Select'], ['option-0', 'Low']]);
  });
});

describe('uniqueValue', () => {
  it('keeps a unique value within the field’s limit', () => {
    expect(uniqueValue('Alpha', 60)).toBe('Alpha {unique}');
    expect(uniqueValue('A'.repeat(60), 60, true)).toHaveLength(60);
    expect(uniqueValue('A'.repeat(60), 12)).toBe('AAA {unique}');
  });
});

describe('buildScenarios', () => {
  it('makes only the scenarios the tester picked, with unique values except for the duplicate', () => {
    const s = buildScenarios(workflow, [
      {
        key: 'name', required: 'yes', unique: true, message: 'Name is required', notes: '',
        checks: [
          { id: 'empty-refused', label: 'Left empty', outcome: 'rejected', value: '' },
          { id: 'at-max', label: 'Exactly 60 characters', outcome: 'success', value: 'A'.repeat(60) },
          { id: 'duplicate', label: 'A value already used', outcome: 'rejected', value: 'Alpha' },
        ],
      },
    ]);
    expect(s.map((x) => [x.id, x.values.name])).toEqual([
      ['recorded', 'Alpha {unique}'],
      ['name-empty-refused', ''],
      ['name-at-max', `${'A'.repeat(52)}{unique}`],
      ['name-duplicate', 'Alpha'],
    ]);
    expect(s[1]!.expect).toMatchObject({ outcome: 'rejected', fieldErrors: [{ field: 'name', message: 'Name is required' }], dialog: 'stays_open' });
    expect(s[3]!.expect).toMatchObject({ outcome: 'rejected', fieldErrors: [], message: '' });
  });
});
