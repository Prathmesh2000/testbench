import {
  AI_PROVIDERS,
  AI_TASKS,
  type AiAnswer,
  type AiConfigBody,
  type AiConfigView,
  type AiPolicy,
  type AiProvider,
  type AiTask,
  type AiUsageRow,
  type TaskConfig,
} from '@tb/contracts';
import { AppError, recordEvent, withTenant, type Db, type Tx } from '@tb/platform';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { sql } from 'kysely';
import { defaultTaskConfig, monthStart, resolveChain, type AiSettings, type CloudProvider } from './chain';
import { decryptKey, encryptKey, keyHint } from './keys';
import { extractJson, schemaInstruction } from './json-answer';
import { languageModel, recordedModel } from './providers';
import { TASKS, type TaskInputs, type TaskOutputs } from './tasks';

export interface Caller {
  orgId: string;
  userId: string;
}

interface ConfigRow {
  policy: AiPolicy;
  allowed: AiProvider[];
  tasks: Partial<Record<AiTask, TaskConfig>>;
  monthlyBudget: number;
  keys: Record<string, { ciphertext: string; hint: string }>;
}

/** The model a call went to; `mock` only in AI_MODE=mock. */
type Target = { provider: AiProvider | 'mock'; model: string };

const DEFAULT_ROW: ConfigRow = { policy: 'any', allowed: [], tasks: {}, monthlyBudget: 10_000_000, keys: {} };
const CLOUD: CloudProvider[] = ['openai', 'anthropic', 'xai'];
// A small local model on CPU needs minutes for a long answer (HLD §10.3); cloud models don't.
const TIMEOUT_MS = { local: 300_000, cloud: 90_000 };

/**
 * The AI provider layer (HLD §2.3): resolves the tenant's config for a task, enforces policy and the
 * monthly token budget, tries the configured model and its fallbacks, validates the answer against the
 * task's schema and meters every attempt.
 *
 * `run` takes the database handle, not a transaction: a model call can take minutes, and holding a
 * transaction (and a pooled connection) open that long would starve the API.
 */
export class AiService {
  constructor(
    private readonly db: Db,
    readonly settings: AiSettings,
  ) {}

  async run<K extends AiTask>(
    caller: Caller,
    task: K,
    input: TaskInputs[K],
  ): Promise<AiAnswer<TaskOutputs[K]>> {
    const { row, used } = await withTenant(this.db, caller, async (trx) => ({
      row: await this.load(trx),
      used: await this.usedThisMonth(trx),
    }));
    if (row.policy === 'off')
      throw new AppError(403, 'ai_disabled', 'AI is turned off for your organisation.');
    if (used >= row.monthlyBudget)
      throw new AppError(
        429,
        'ai_budget_exhausted',
        'This month’s AI token budget is used up. An Org Admin can raise it in Settings → AI.',
      );

    const def = TASKS[task];
    if (this.settings.mode === 'mock') {
      const answer = await this.attempt(
        caller,
        task,
        { provider: 'mock', model: 'recorded' },
        recordedModel(def.mock(input)),
        input,
      );
      if ('output' in answer) return { result: answer.output, provider: 'mock', model: 'recorded' };
      throw new AppError(502, 'ai_failed', answer.error);
    }

    const chain = resolveChain({
      mode: this.settings.mode,
      config: row.tasks[task] ?? defaultTaskConfig(task, this.settings),
      policy: row.policy,
      allowed: row.allowed,
      available: this.available(row),
      localModel: this.settings.localModel,
    });
    if (!chain.ok) throw new AppError(409, 'ai_unavailable', chain.reason);

    let lastError = '';
    for (const ref of chain.chain) {
      const model = languageModel(ref, this.keyFor(row, ref.provider), this.settings.ollamaUrl);
      const answer = await this.attempt(caller, task, ref, model, input);
      if ('output' in answer) return { result: answer.output, provider: ref.provider, model: ref.model };
      lastError = answer.error;
    }
    throw new AppError(502, 'ai_failed', `The AI providers for this task failed. Last error: ${lastError}`);
  }

  /**
   * One model, up to two tries: an answer that fails schema validation is retried once, because small
   * models often fix their JSON on a second go; a provider error (429, 5xx, timeout) moves on to the
   * next model in the chain instead.
   */
  private async attempt<K extends AiTask>(
    caller: Caller,
    task: K,
    ref: Target,
    model: ReturnType<typeof languageModel>,
    input: TaskInputs[K],
  ): Promise<{ output: TaskOutputs[K] } | { error: string }> {
    const def = TASKS[task];
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      try {
        const res = await generateText({
          model,
          system: def.system,
          // Ollama's cloud models ignore the response format; shown the schema, they follow it.
          prompt: ref.provider === 'local' ? `${def.prompt(input)}\n\n${schemaInstruction(def.schema)}` : def.prompt(input),
          output: Output.object({ schema: def.schema }),
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(ref.provider === 'local' ? TIMEOUT_MS.local : TIMEOUT_MS.cloud),
          // Qwen-style local models "think" out loud by default, which breaks JSON output and triples latency.
          providerOptions: { ollama: { think: false } },
        });
        await this.meter(caller, task, ref, res.totalUsage, null);
        return { output: res.output as TaskOutputs[K] };
      } catch (err) {
        // A right answer in the wrong wrapping (a code fence, a sentence around it) is still right,
        // once the task's own schema has checked it.
        if (NoObjectGeneratedError.isInstance(err) && err.text) {
          const found = def.schema.safeParse(extractJson(err.text));
          if (found.success) {
            await this.meter(caller, task, ref, err.usage, null);
            return { output: found.data };
          }
        }
        const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
        const usage = NoObjectGeneratedError.isInstance(err) ? err.usage : undefined;
        await this.meter(caller, task, ref, usage, message);
        if (!(NoObjectGeneratedError.isInstance(err) && tryNo === 1)) return { error: message };
      }
    }
    return { error: 'unreachable' };
  }

  /** Usage is written in its own transaction so failed calls are metered even though the request fails. */
  private async meter(
    caller: Caller,
    task: AiTask,
    ref: Target,
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
    error: string | null,
  ): Promise<void> {
    await withTenant(this.db, caller, (trx) =>
      trx
        .insertInto('ai.usage')
        .values({
          org_id: caller.orgId,
          user_id: caller.userId,
          task,
          provider: ref.provider,
          model: ref.model,
          input_tokens: usage?.inputTokens ?? 0,
          output_tokens: usage?.outputTokens ?? 0,
          ok: error === null,
          error,
        })
        .execute(),
    );
  }

  // ---------- configuration ----------

  async view(trx: Tx): Promise<AiConfigView> {
    const row = await this.load(trx);
    const tasks = Object.fromEntries(
      AI_TASKS.map((t) => {
        const override = row.tasks[t];
        return [t, { ...(override ?? defaultTaskConfig(t, this.settings)), overridden: Boolean(override) }];
      }),
    ) as AiConfigView['tasks'];
    return {
      mode: this.settings.mode,
      localModel: this.settings.localModel,
      policy: row.policy,
      allowed: row.allowed,
      tasks,
      monthlyBudget: row.monthlyBudget,
      usedThisMonth: await this.usedThisMonth(trx),
      keys: Object.fromEntries(CLOUD.map((p) => [p, row.keys[p]?.hint ?? null])) as AiConfigView['keys'],
      available: this.available(row),
    };
  }

  async saveConfig(trx: Tx, caller: Caller, body: AiConfigBody): Promise<void> {
    await trx
      .insertInto('ai.config')
      .values({
        org_id: caller.orgId,
        policy: body.policy,
        allowed: body.allowed,
        tasks: JSON.stringify(body.tasks),
        monthly_budget: body.monthlyBudget,
        updated_by: caller.userId,
      })
      .onConflict((oc) =>
        oc.column('org_id').doUpdateSet({
          policy: body.policy,
          allowed: body.allowed,
          tasks: JSON.stringify(body.tasks),
          monthly_budget: body.monthlyBudget,
          updated_by: caller.userId,
          updated_at: new Date(),
        }),
      )
      .execute();
    await recordEvent(trx, {
      type: 'ai.config_changed',
      orgId: caller.orgId,
      projectId: null,
      actor: caller.userId,
      data: { what: 'policy and models', detail: `policy ${body.policy} · budget ${body.monthlyBudget}` },
    });
  }

  /** Sets or removes a tenant key. The plain key is encrypted here and never stored or logged as is. */
  async setKey(trx: Tx, caller: Caller, provider: CloudProvider, key: string | null): Promise<void> {
    if (key !== null && !this.settings.keySecret)
      throw new AppError(
        409,
        'byok_unavailable',
        'Bringing your own key needs AI_KEY_SECRET to be configured.',
      );
    const row = await this.load(trx);
    const keys = { ...row.keys };
    if (key === null) delete keys[provider];
    else keys[provider] = { ciphertext: encryptKey(this.settings.keySecret!, key), hint: keyHint(key) };
    await trx
      .insertInto('ai.config')
      .values({ org_id: caller.orgId, keys: JSON.stringify(keys), updated_by: caller.userId })
      .onConflict((oc) =>
        oc
          .column('org_id')
          .doUpdateSet({ keys: JSON.stringify(keys), updated_by: caller.userId, updated_at: new Date() }),
      )
      .execute();
    // The key itself never goes into the event, only which provider changed.
    await recordEvent(trx, {
      type: 'ai.config_changed',
      orgId: caller.orgId,
      projectId: null,
      actor: caller.userId,
      data: { what: `${provider} key`, detail: key === null ? 'removed' : 'set' },
    });
  }

  async usage(trx: Tx): Promise<AiUsageRow[]> {
    const rows = await trx
      .selectFrom('ai.usage as u')
      .leftJoin('iam.app_user as p', 'p.id', 'u.user_id')
      .select([
        'u.created_at',
        'u.task',
        'u.provider',
        'u.model',
        'u.input_tokens',
        'u.output_tokens',
        'u.ok',
        'u.error',
        'p.name',
      ])
      .orderBy('u.created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((r) => ({
      at: r.created_at.toISOString(),
      task: r.task as AiTask,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      ok: r.ok,
      error: r.error,
      user: r.name,
    }));
  }

  private async load(trx: Tx): Promise<ConfigRow> {
    const row = await trx.selectFrom('ai.config').selectAll().executeTakeFirst();
    if (!row) return DEFAULT_ROW;
    return {
      policy: row.policy as AiPolicy,
      allowed: row.allowed.filter((p): p is AiProvider => (AI_PROVIDERS as readonly string[]).includes(p)),
      tasks: row.tasks as ConfigRow['tasks'],
      monthlyBudget: row.monthly_budget,
      keys: row.keys,
    };
  }

  private async usedThisMonth(trx: Tx): Promise<number> {
    const r = await trx
      .selectFrom('ai.usage')
      .select(sql<number>`coalesce(sum(input_tokens + output_tokens), 0)::bigint`.as('used'))
      .where('created_at', '>=', monthStart())
      .executeTakeFirstOrThrow();
    return r.used;
  }

  private keyFor(row: ConfigRow, provider: AiProvider): string | undefined {
    if (provider === 'local') return undefined;
    const tenant = row.keys[provider];
    if (tenant && this.settings.keySecret) return decryptKey(this.settings.keySecret, tenant.ciphertext);
    return this.settings.platformKeys[provider];
  }

  private available(row: ConfigRow): AiProvider[] {
    return [...CLOUD.filter((p) => row.keys[p] || this.settings.platformKeys[p]), 'local'];
  }
}
