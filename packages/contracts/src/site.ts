import { z } from 'zod';
import { FieldRules, type Assertion, type ComponentMeta, type FieldKind } from './studio';
import type { Expectation, Scenario, WorkflowField } from './workflow';

// The site map (testing-studio-plan §3.3): every page the Test Browser reaches is kept as the
// project's picture of its site (what can be pressed, its fields, the APIs it calls), and saved
// workflows join those pages into the journeys users take. Journeys of workflows make test cases.

/** A page as the Test Browser saw it, sent by the pane (see PageContext in browser.ts). */
export const SitePageBody = z.object({
  url: z.string().min(1).max(4_000),
  title: z.string().max(300).default(''),
  headings: z.array(z.string().max(300)).max(30).default([]),
  actions: z
    .array(z.object({ label: z.string().trim().min(1).max(200), role: z.enum(['button', 'link', 'tab', 'menuitem']), href: z.string().max(2_000).nullable() }))
    .max(120)
    .default([]),
  fields: z.array(z.object({ label: z.string().max(200), rules: FieldRules })).max(60).default([]),
  apis: z.array(z.object({ method: z.string().max(10), path: z.string().max(500), status: z.number().int().nullable() })).max(80).default([]),
});
export type SitePageBody = z.infer<typeof SitePageBody>;

export interface SitePage {
  id: string;
  /** The stable part of its address: ids and numbers cut off, e.g. /home/projects. */
  path: string;
  title: string;
  headings: string[];
  /** What can be pressed; a link's `to` is the stable path it leads to. */
  actions: Array<{ label: string; role: 'button' | 'link' | 'tab' | 'menuitem'; to: string | null }>;
  fields: Array<{ key: string; label: string; kind: FieldKind; rules: FieldRules }>;
  /** APIs the page called, ids made ":id". */
  apis: Array<{ method: string; path: string; status: number | null }>;
  visits: number;
  firstSeen: string;
  lastSeen: string;
}

/** A workflow as the site map shows it: from which page, by which button, to which page, and what is checked. */
export interface GraphWorkflow {
  id: string;
  /** A recorded workflow, or a prerequisite (signing in) that workflows run first. */
  kind: 'workflow' | 'prerequisite';
  name: string;
  version: number;
  intent: string;
  /** Pages it starts on and ends on (stable paths); the same when it stays on one page. */
  from: string;
  to: string;
  /** The button or link on `from` that starts it. */
  startAction: string | null;
  prerequisiteId: string | null;
  fields: WorkflowField[];
  apis: ComponentMeta['apis'];
  /** The scenarios agreed for it, and checks added for every success. */
  scenarios: Array<Pick<Scenario, 'id' | 'title' | 'kind' | 'status'> & { expect: Pick<Expectation, 'outcome' | 'message' | 'fieldErrors' | 'stop' | 'checks'> }>;
  checks: Assertion[];
  /** Tests (and so test cases) that use it. */
  usedBy: Array<{ testId: string; key: string; title: string; caseId: string | null }>;
}

export interface SiteGraph {
  pages: SitePage[];
  workflows: GraphWorkflow[];
  /** Links between known pages that are not workflows: plain navigation. */
  links: Array<{ from: string; to: string; label: string }>;
}

// ---------- journeys: workflows in order, as a test case ----------

export const JourneyBody = z.object({
  title: z.string().trim().min(3).max(160),
  /**
   * The workflows in the order a user goes through them. Every part but the last runs one scenario
   * (a positive one: the journey goes on after it); the last may run several, a data row each.
   */
  parts: z
    .array(z.object({ workflowId: z.uuid(), scenarioIds: z.array(z.string().max(40)).min(1).max(30) }))
    .min(1)
    .max(10),
  /** The test case it automates: an existing one, a new one in `moduleId`, or none. */
  caseId: z.uuid().nullable().default(null),
  createCase: z.object({ moduleId: z.uuid() }).nullable().default(null),
});
export type JourneyBody = z.infer<typeof JourneyBody>;

export interface JourneyResult {
  tests: Array<{ id: string; key: string; title: string; rows: number }>;
  caseId: string | null;
  caseKey: string | null;
}

