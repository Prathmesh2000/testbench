import { z } from 'zod';

// Vocabulary shared by the API, the web app and the database CHECK constraints (db/migrations).
// Changing a list here means a migration too.

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const CASE_STATUSES = ['draft', 'in_review', 'ready', 'needs_review', 'obsolete'] as const;
export const AUTOMATION = ['manual', 'automated', 'flaky'] as const;
/** Outcome of a step or a whole run item. `untested` is only ever derived, never recorded. */
export const RESULTS = ['passed', 'failed', 'blocked', 'skipped', 'untested'] as const;
export const RECORDABLE_RESULTS = ['passed', 'failed', 'blocked', 'skipped'] as const;
export const RUN_TYPES = ['smoke', 'regression', 'custom', 'exploratory', 'automated'] as const;
export const RUN_STATUSES = ['preparing', 'active', 'completed'] as const;
export const CASE_FORMATS = ['steps', 'gherkin'] as const;

export const Priority = z.enum(PRIORITIES);
export const CaseStatus = z.enum(CASE_STATUSES);
export const Automation = z.enum(AUTOMATION);
export const Result = z.enum(RESULTS);
export const RecordableResult = z.enum(RECORDABLE_RESULTS);
export const RunType = z.enum(RUN_TYPES);
export const CaseFormat = z.enum(CASE_FORMATS);

export type Priority = z.infer<typeof Priority>;
export type CaseStatus = z.infer<typeof CaseStatus>;
export type Automation = z.infer<typeof Automation>;
export type Result = z.infer<typeof Result>;
export type RecordableResult = z.infer<typeof RecordableResult>;
export type RunType = z.infer<typeof RunType>;
export type CaseFormat = z.infer<typeof CaseFormat>;

/** Human-readable case key. The number is unique per project; the prefix is fixed for now. */
export const CASE_KEY_PREFIX = 'TC-';
export const caseKey = (keyNo: number) => `${CASE_KEY_PREFIX}${keyNo}`;
export const RUN_KEY_PREFIX = 'RUN-';
export const runKey = (keyNo: number) => `${RUN_KEY_PREFIX}${keyNo}`;

/** Parses "TC-10231" (case-insensitive) into 10231, or null when it is not a case key. */
export function parseCaseKey(key: string): number | null {
  const match = /^tc-(\d{1,9})$/i.exec(key.trim());
  return match ? Number(match[1]) : null;
}
