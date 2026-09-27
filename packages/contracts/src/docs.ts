import { z } from 'zod';
import type { CaseStatus, Result } from './domain';

// Docs & PRDs (HLD §5.13): documents, their versions, the requirements extracted from each, links from
// requirements to cases, and the impact of a new version on those cases.

export const DocumentBody = z.object({
  title: z.string().trim().min(1).max(200),
  /** Markdown or plain text. PDF and Word files are converted in the browser before upload. */
  body: z.string().min(20).max(2_000_000),
});
export const VersionBody = z.object({ body: z.string().min(20).max(2_000_000) });
export const LinkCasesBody = z.object({
  caseKeys: z
    .array(z.string().regex(/^TC-\d+$/i))
    .min(1)
    .max(500),
});

export const REQUIREMENT_CHANGES = ['unchanged', 'added', 'changed', 'removed'] as const;
export type RequirementChange = (typeof REQUIREMENT_CHANGES)[number];
/** full: every linked case is Ready · partial: some linked cases are not Ready (draft, needs review) · none: no cases. */
export type Coverage = 'full' | 'partial' | 'none';

export interface DocumentSummary {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  requirements: number;
  covered: number;
  needsReview: number;
}

export interface RequirementRow {
  id: string;
  ref: string;
  title: string;
  text: string;
  change: RequirementChange;
  /** The version in which it last changed (or was added or removed). */
  changedIn: number;
  caseCount: number;
  coverage: Coverage;
}

export interface DocumentVersionInfo {
  version: number;
  createdAt: string;
  author: string;
  /** "tags" when the document carried its own requirement ids, else the model that extracted them. */
  extractedBy: string;
}

export interface DocumentDetail {
  id: string;
  title: string;
  currentVersion: number;
  version: number;
  body: string;
  versions: DocumentVersionInfo[];
  requirements: RequirementRow[];
  /** What the latest version changed, for the impact banner. */
  impact: { changed: number; added: number; removed: number; needsReview: number; uncoveredAdded: number };
}

export interface RequirementDiff {
  ref: string;
  change: RequirementChange;
  before: string | null;
  after: string | null;
}

export interface VersionCompare {
  base: { version: number; body: string };
  head: { version: number; body: string };
  changes: RequirementDiff[];
}

export interface VersionResult {
  version: number;
  changed: number;
  added: number;
  removed: number;
  /** Cases now marked Needs review because a linked requirement changed or went away. */
  flagged: number;
}

export interface LinkedCase {
  key: string;
  title: string;
  status: CaseStatus;
  lastResult: Result;
  flagged: boolean;
}

export interface TraceRow {
  requirementId: string;
  ref: string;
  title: string;
  coverage: Coverage;
  caseCount: number;
  /** Pass rate of the latest result per linked case, per environment; null where nothing has run. */
  passRate: Record<string, number | null>;
  openBugs: string[];
}

export interface Traceability {
  environments: string[];
  rows: TraceRow[];
}

export interface CaseFlag {
  kind: 'needs_review' | 'possibly_obsolete';
  reason: string;
  documentTitle: string;
  requirementRef: string;
  flaggedAt: string;
}
