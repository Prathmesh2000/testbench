import { z } from 'zod';
import { Priority } from './domain';

// AI Assist (HLD §2.3): one provider layer, configured per task, with tenant policy, BYOK and budgets.

export const AI_PROVIDERS = ['openai', 'anthropic', 'xai', 'local'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  xai: 'xAI Grok',
  local: 'Local Ollama',
};

export const AI_TASKS = ['generate_cases', 'edge_cases', 'extract_requirements'] as const;
export type AiTask = (typeof AI_TASKS)[number];
export const AI_TASK_LABELS: Record<AiTask, string> = {
  generate_cases: 'Generate cases from a requirement',
  edge_cases: 'Suggest edge cases',
  extract_requirements: 'Extract requirements from a PRD',
};

/** any: members may use every provider · allowed: only the listed ones · local_only: nothing leaves the network · off: AI disabled. */
export const AI_POLICIES = ['any', 'allowed', 'local_only', 'off'] as const;
export type AiPolicy = (typeof AI_POLICIES)[number];

const ModelRef = z.object({
  provider: z.enum(AI_PROVIDERS),
  // Model ids are configuration, not constants: providers ship new ones every few months.
  model: z.string().trim().min(1).max(100),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const TaskConfig = ModelRef.extend({ fallback: z.array(ModelRef).max(3).default([]) });
export type TaskConfig = z.infer<typeof TaskConfig>;

export const AiConfigBody = z.object({
  policy: z.enum(AI_POLICIES),
  allowed: z.array(z.enum(AI_PROVIDERS)).max(4).default([]),
  /** Tasks left out use the platform default. */
  tasks: z.partialRecord(z.enum(AI_TASKS), TaskConfig).default({}),
  monthlyBudget: z.number().int().min(0).max(10_000_000_000),
});
export type AiConfigBody = z.infer<typeof AiConfigBody>;

/** A tenant key is write-only: it can be set or removed, never read back. */
export const AiKeyBody = z.object({ key: z.string().trim().min(10).max(500).nullable() });

export interface AiConfigView {
  /** How this deployment runs AI: `mock` (recorded responses), `local` (Ollama only) or `cloud`. */
  mode: 'mock' | 'local' | 'cloud';
  /** The Ollama model every task uses in `local` mode. */
  localModel: string;
  policy: AiPolicy;
  allowed: AiProvider[];
  /** Effective config per task: the tenant override, else the platform default. */
  tasks: Record<AiTask, TaskConfig & { overridden: boolean }>;
  monthlyBudget: number;
  usedThisMonth: number;
  /** Masked hint of each tenant key ("sk-…7Q2f"), or null when the platform key is used. */
  keys: Record<Exclude<AiProvider, 'local'>, string | null>;
  /** Providers that have a key (platform or tenant) and can actually be called. */
  available: AiProvider[];
}

export interface AiUsageRow {
  at: string;
  task: AiTask;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  error: string | null;
  user: string | null;
}

// ---------- task inputs and outputs ----------

export const DraftStep = z.object({
  action: z.string().min(1).max(2000),
  expected: z.string().max(2000),
  data: z.string().max(2000).default(''),
});

export const DraftCase = z.object({
  title: z.string().min(3).max(300),
  priority: Priority,
  preconditions: z.string().max(4000).default(''),
  steps: z.array(DraftStep).min(1).max(30),
});
export type DraftCase = z.infer<typeof DraftCase>;

export const DraftCases = z.object({ cases: z.array(DraftCase).min(1).max(20) });

export const EdgeCase = z.object({
  title: z.string().min(3).max(300),
  why: z.string().max(600),
});
export const EdgeCases = z.object({ edgeCases: z.array(EdgeCase).min(1).max(15) });
export type EdgeCase = z.infer<typeof EdgeCase>;

export const ExtractedRequirement = z.object({
  ref: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(4000),
});
export type ExtractedRequirement = z.infer<typeof ExtractedRequirement>;
export const ExtractedRequirements = z.object({ requirements: z.array(ExtractedRequirement).max(300) });

export const GenerateCasesBody = z.object({
  requirementId: z.uuid(),
  count: z.number().int().min(1).max(10).default(5),
});
export const EdgeCasesBody = z.object({ caseKey: z.string().regex(/^TC-\d+$/i) });

/** What every AI endpoint returns alongside its result, so the UI can say which model answered. */
export interface AiAnswer<T> {
  result: T;
  provider: AiProvider | 'mock';
  model: string;
}
