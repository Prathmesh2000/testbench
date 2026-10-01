import type { AiPolicy, AiProvider, AiTask, ModelRef, TaskConfig } from '@tb/contracts';

export type AiMode = 'mock' | 'local' | 'cloud';
export type CloudProvider = Exclude<AiProvider, 'local'>;

export interface AiSettings {
  mode: AiMode;
  ollamaUrl: string;
  localModel: string;
  platformKeys: Partial<Record<CloudProvider, string>>;
  models: Record<CloudProvider, string>;
  /** Null when tenant keys can't be stored (no AI_KEY_SECRET). */
  keySecret: string | null;
}

/**
 * Platform defaults per task (HLD §2.3), used when a tenant hasn't overridden the task. Extraction
 * and intent builds need careful reading, so they go to Claude; edge cases benefit from a second
 * model's view.
 */
export function defaultTaskConfig(task: AiTask, s: AiSettings): TaskConfig {
  const m = (provider: CloudProvider): ModelRef => ({ provider, model: s.models[provider] });
  switch (task) {
    case 'extract_requirements':
      return { ...m('anthropic'), fallback: [m('openai')] };
    case 'generate_cases':
      return { ...m('anthropic'), fallback: [m('openai'), m('xai')] };
    case 'edge_cases':
      return { ...m('xai'), fallback: [m('anthropic')] };
    case 'intent_test':
    case 'scenario_chat':
    case 'ui_review':
    case 'api_enrich':
    case 'api_explain':
    case 'api_plan':
    case 'api_ask':
      return { ...m('anthropic'), fallback: [m('openai')] };
  }
}

export interface ChainInput {
  mode: AiMode;
  config: TaskConfig;
  policy: AiPolicy;
  allowed: readonly AiProvider[];
  /** Providers with a usable key. `local` is always available. */
  available: readonly AiProvider[];
  localModel: string;
}

export type Chain = { ok: true; chain: ModelRef[] } | { ok: false; reason: string };

/**
 * The ordered list of models to try for one task call: the configured model and its fallbacks,
 * minus whatever the tenant policy forbids or has no key. `local` mode ignores the task config and
 * sends everything to Ollama (HLD §10.3); policy `off` still wins over that.
 */
export function resolveChain(input: ChainInput): Chain {
  if (input.policy === 'off') return { ok: false, reason: 'AI is turned off for your organisation.' };
  const local: ModelRef = { provider: 'local', model: input.localModel };
  if (input.mode === 'local') return { ok: true, chain: [local] };

  const permitted = (p: AiProvider) =>
    input.policy === 'local_only'
      ? p === 'local'
      : input.policy === 'allowed'
        ? input.allowed.includes(p)
        : true;
  const candidates = [input.config, ...input.config.fallback].map(({ provider, model }) => ({
    provider,
    model,
  }));
  if (input.policy === 'local_only' && !candidates.some((c) => c.provider === 'local'))
    candidates.push(local);

  const forbidden = candidates.filter((c) => !permitted(c.provider));
  const chain = candidates.filter((c) => permitted(c.provider) && input.available.includes(c.provider));
  if (chain.length) return { ok: true, chain };
  if (forbidden.length === candidates.length)
    return {
      ok: false,
      reason: 'Your organisation’s AI policy does not allow the providers configured for this task.',
    };
  return {
    ok: false,
    reason: 'No API key is set for the providers configured for this task. Add one in Settings → AI.',
  };
}

/** First day of the current month in UTC: budgets reset then. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
