import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { ModelRef } from '@tb/contracts';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createOllama } from 'ollama-ai-provider-v2';

/**
 * The SDK model for one configured provider and model. Calls go straight to the provider; the hosted
 * Vercel AI Gateway is not used, so request data stays on a path we control (HLD §2.3).
 */
export function languageModel(ref: ModelRef, apiKey: string | undefined, ollamaUrl: string): LanguageModel {
  switch (ref.provider) {
    case 'openai':
      return createOpenAI({ apiKey })(ref.model);
    case 'anthropic':
      return createAnthropic({ apiKey })(ref.model);
    case 'xai':
      return createXai({ apiKey })(ref.model);
    case 'local':
      return createOllama({ baseURL: `${ollamaUrl.replace(/\/$/, '')}/api` })(ref.model);
  }
}

/**
 * AI_MODE=mock: a model that answers with a fixed JSON value. It goes through the same generateText
 * call and schema validation as a real provider, so mock mode exercises the whole code path.
 */
export function recordedModel(answer: unknown): LanguageModel {
  const text = JSON.stringify(answer);
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'recorded',
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: Math.ceil(text.length / 4), text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}
