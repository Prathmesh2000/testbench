import { describe, expect, it } from 'vitest';
import { defaultTaskConfig, resolveChain, type AiSettings, type ChainInput } from './chain';
import { decryptKey, encryptKey, keyHint } from './keys';
import { sentenceRequirements, TASKS } from './tasks';

const settings: AiSettings = {
  mode: 'cloud',
  ollamaUrl: 'http://localhost:11434',
  localModel: 'qwen3:4b',
  platformKeys: {},
  models: { openai: 'gpt-x', anthropic: 'claude-x', xai: 'grok-x' },
  keySecret: null,
};
const base: ChainInput = {
  mode: 'cloud',
  config: defaultTaskConfig('generate_cases', settings),
  policy: 'any',
  allowed: [],
  available: ['openai', 'anthropic', 'xai', 'local'],
  localModel: 'qwen3:4b',
};

describe('resolveChain', () => {
  it('keeps the configured order: primary, then fallbacks', () => {
    const r = resolveChain(base);
    expect(r.ok && r.chain.map((c) => c.provider)).toEqual(['anthropic', 'openai', 'xai']);
  });

  it('skips providers without a key', () => {
    const r = resolveChain({ ...base, available: ['xai', 'local'] });
    expect(r.ok && r.chain).toEqual([{ provider: 'xai', model: 'grok-x' }]);
  });

  it('applies the allowed-list policy', () => {
    const r = resolveChain({ ...base, policy: 'allowed', allowed: ['openai'] });
    expect(r.ok && r.chain.map((c) => c.provider)).toEqual(['openai']);
  });

  it('local only falls back to Ollama even when the task names cloud models', () => {
    const r = resolveChain({ ...base, policy: 'local_only' });
    expect(r.ok && r.chain).toEqual([{ provider: 'local', model: 'qwen3:4b' }]);
  });

  it('local mode sends everything to Ollama, but off still refuses', () => {
    expect(resolveChain({ ...base, mode: 'local' })).toEqual({
      ok: true,
      chain: [{ provider: 'local', model: 'qwen3:4b' }],
    });
    expect(resolveChain({ ...base, mode: 'local', policy: 'off' }).ok).toBe(false);
  });

  it('explains whether the policy or a missing key is the problem', () => {
    const policy = resolveChain({ ...base, policy: 'allowed', allowed: ['local'] });
    const keys = resolveChain({ ...base, available: ['local'] });
    expect(!policy.ok && policy.reason).toMatch(/policy/);
    expect(!keys.ok && keys.reason).toMatch(/API key/);
  });
});

describe('tenant keys', () => {
  const secret = 'a'.repeat(40);
  it('round-trips and never stores the plain key', () => {
    const stored = encryptKey(secret, 'sk-ant-api03-SECRET-7Q2f');
    expect(stored).not.toContain('SECRET');
    expect(decryptKey(secret, stored)).toBe('sk-ant-api03-SECRET-7Q2f');
  });
  it('rejects a key encrypted with another secret', () => {
    expect(() => decryptKey('b'.repeat(40), encryptKey(secret, 'sk-1234567890'))).toThrow();
  });
  it('shows only a recognisable hint', () => {
    expect(keyHint('sk-proj-abcdefghijkla91c')).toBe('sk-proj-••••a91c');
  });
});

describe('mock answers', () => {
  it('pick requirement-like sentences in document order', () => {
    const reqs = sentenceRequirements(
      '# Autopay\nAutopay is popular.\nA customer can pause a mandate for up to 90 days. Debits inside the window are skipped.\n- A pre-debit notification is sent 24 hours before each execution.',
    );
    expect(reqs.map((r) => r.ref)).toEqual(['REQ-1', 'REQ-2']);
    expect(reqs[0]!.title).toBe('customer can pause a mandate for up to 90 days');
  });

  it('are valid against the task schemas', () => {
    const requirement = {
      ref: 'REQ-AP-04',
      title: 'Pause',
      text: 'A customer can pause a mandate for up to 90 days.',
    };
    const cases = TASKS.generate_cases.mock({ document: 'Autopay', requirement, count: 3, existing: [] });
    expect(TASKS.generate_cases.schema.parse(cases).cases).toHaveLength(3);
    const edges = TASKS.edge_cases.mock({ title: 'Verify pause', preconditions: '', steps: [] });
    expect(() => TASKS.edge_cases.schema.parse(edges)).not.toThrow();
  });
});
