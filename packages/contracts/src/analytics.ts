import { z } from 'zod';
import type { Result } from './domain';

// Analytics & Reporting (HLD §5.10, §5.16): overview, release readiness with sign-off, test health,
// build comparison and workload.

export interface ResultCounts {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface Overview {
  days: number;
  kpis: {
    /** Percentage of executed results that passed; null with nothing executed. */
    passRate: number | null;
    passRatePrevious: number | null;
    executed: number;
    automatedShare: number | null;
    openDefects: number;
    openBlockers: number;
    openCriticals: number;
    /** Automated share of Ready cases. */
    automationCoverage: number | null;
    meanRetestHours: number | null;
  };
  daily: ({ day: string } & ResultCounts)[];
  modules: ({ name: string } & ResultCounts)[];
  topFailing: { key: string; title: string; fails: number; lastBuild: string; bug: string | null }[];
}

export type CriterionStatus = 'met' | 'failing' | 'no_data';

export interface Criterion {
  id: string;
  label: string;
  target: string;
  actual: string;
  status: CriterionStatus;
  evidence: string;
}

export interface Signoff {
  decision: 'go' | 'no_go';
  note: string;
  by: string;
  at: string;
}

export interface Readiness {
  build: string | null;
  /** Builds that have runs, newest first. */
  builds: string[];
  evaluatedAt: string;
  criteria: Criterion[];
  /** Go is allowed only when every criterion is met. */
  ready: boolean;
  signoffs: Signoff[];
}

export const SignoffBody = z.object({
  build: z.string().trim().min(1).max(60),
  decision: z.enum(['go', 'no_go']),
  note: z.string().trim().max(2000).default(''),
});

export const HEALTH_KINDS = ['always_failing', 'flaky', 'needs_review', 'stale'] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];

export interface HealthItem {
  kind: HealthKind;
  key: string;
  title: string;
  why: string;
  owner: { id: string; name: string } | null;
}

export interface Health {
  staleDays: number;
  counts: Record<HealthKind, number>;
  /** The first 200 cases needing attention, worst kinds first. */
  items: HealthItem[];
}

export const COMPARE_CATEGORIES = ['new_failure', 'fixed', 'still_failing', 'added', 'not_run'] as const;
export type CompareCategory = (typeof COMPARE_CATEGORIES)[number];

export interface CompareRow {
  key: string;
  title: string;
  config: string;
  base: Result | null;
  head: Result | null;
  category: CompareCategory;
  bug: string | null;
}

export interface BuildCompare {
  base: string;
  head: string;
  builds: string[];
  /** Null when the project has fewer than two builds to compare. */
  counts: Record<CompareCategory, number> | null;
  compared: number;
  rows: CompareRow[];
}

export interface WorkloadRow {
  user: { id: string; name: string };
  items: number;
  estimateMin: number;
  capacityMin: number;
  /** Estimated ÷ actual time over the last 30 days, as a percentage; null without history. */
  accuracy: number | null;
}

export interface Workload {
  rows: WorkloadRow[];
  unassigned: number;
}
