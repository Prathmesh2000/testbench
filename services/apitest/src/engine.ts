import type { ApiWorkflowCondition, ApiWorkflowDef, ApiWorkflowStep, ApiWorkflowStepResult } from '@tb/contracts';
import { extract, type ResponseFacts } from './assert';

// Runs a workflow's steps (plan §12) with the request send injected, so every step kind is testable
// without a database or a network. Values move between steps as variables: each request's extractors,
// scripts and `assign` rules add to them, and later steps use them as {{name}}.

export interface StepSend {
  /** False when the request failed a check, errored, or got no response. */
  passed: boolean;
  message: string;
  historyId: string | null;
  facts: ResponseFacts | null;
  /** What its extractors and scripts set. */
  extracted: Record<string, string>;
}

export interface EngineDeps {
  send(requestId: string, variationId: string | null, vars: Record<string, string>): Promise<StepSend>;
  /** A sub-workflow's current definition. */
  loadWorkflow(id: string): Promise<{ name: string; def: ApiWorkflowDef }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Called as each result is known, so a watcher sees progress. */
  onResult(r: ApiWorkflowStepResult): void | Promise<void>;
  /** Masks secret values in what is stored and shown. */
  mask(text: string): string;
  cancelled(): boolean;
}

export const LIMITS = { steps: 500, durationMs: 10 * 60_000, depth: 5 };

const LOOP_MAX = 100;

/**
 * A loop over a list of objects makes each field reachable: with `as` = item, {{item}} is the whole value
 * and {{item.id}} a top-level field of it.
 */
function setItem(vars: Record<string, string>, as: string, item: unknown): void {
  for (const k of Object.keys(vars)) if (k.startsWith(`${as}.`)) delete vars[k];
  if (typeof item === 'string') vars[as] = item;
  else {
    vars[as] = JSON.stringify(item);
    if (item && typeof item === 'object' && !Array.isArray(item))
      for (const [k, v] of Object.entries(item)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) vars[`${as}.${k}`] = String(v);
  }
}
const snapshot = (vars: Record<string, string>, as: string) => Object.fromEntries(Object.entries(vars).filter(([k]) => k === as || k.startsWith(`${as}.`)));
function restore(vars: Record<string, string>, as: string, before: Record<string, string>): void {
  for (const k of Object.keys(vars)) if (k === as || k.startsWith(`${as}.`)) delete vars[k];
  Object.assign(vars, before);
}

class StopRun extends Error {}

export function checkCondition(c: ApiWorkflowCondition, vars: Record<string, string>): boolean {
  const v = vars[c.variable];
  if (c.op === 'exists') return v !== undefined && v !== '';
  if (c.op === 'notExists') return v === undefined || v === '';
  if (v === undefined) return false;
  const [a, b] = [Number(v), Number(c.value)];
  const numeric = v.trim() !== '' && c.value.trim() !== '' && !Number.isNaN(a) && !Number.isNaN(b);
  switch (c.op) {
    case 'eq':
      return numeric ? a === b : v === c.value;
    case 'ne':
      return numeric ? a !== b : v !== c.value;
    case 'lt':
      return numeric && a < b;
    case 'gt':
      return numeric && a > b;
    case 'contains':
      return v.includes(c.value);
  }
}

const describe = (c: ApiWorkflowCondition) => `${c.variable} ${{ eq: '=', ne: '≠', lt: '<', gt: '>', contains: 'contains', exists: 'exists', notExists: 'is not set' }[c.op]}${c.op === 'exists' || c.op === 'notExists' ? '' : ` ${c.value}`}`;

/** Teardown cleans up after a cancel too, so test data is not left behind. */
const forTeardown = (deps: EngineDeps): EngineDeps => ({ ...deps, cancelled: () => false });

export class Engine {
  /** True once any step failed, even one set to continue on failure: the run as a whole did not pass. */
  failed = false;
  private executed = 0;
  private readonly started: number;

  constructor(private readonly deps: EngineDeps) {
    this.started = deps.now();
  }

  private budget(): void {
    if (this.deps.cancelled()) throw new StopRun('The run was cancelled.');
    if (++this.executed > LIMITS.steps) throw new StopRun(`Stopped after ${LIMITS.steps} steps: check for a loop that never ends.`);
    if (this.deps.now() - this.started > LIMITS.durationMs) throw new StopRun('Stopped after 10 minutes.');
  }

  private async record(step: ApiWorkflowStep, iteration: string, r: Omit<ApiWorkflowStepResult, 'stepId' | 'iteration' | 'kind' | 'name' | 'startedAt'>, startedAt: number): Promise<ApiWorkflowStepResult> {
    const out: ApiWorkflowStepResult = {
      stepId: step.id,
      iteration,
      kind: step.kind,
      name: step.name,
      startedAt: new Date(startedAt).toISOString(),
      ...r,
      message: this.deps.mask(r.message),
      assigned: Object.fromEntries(Object.entries(r.assigned).map(([k, v]) => [k, this.deps.mask(v)])),
    };
    if (out.status === 'failed') this.failed = true;
    await this.deps.onResult(out);
    return out;
  }

  /** One send plus its assign rules; the variables it produced are merged into `vars`. */
  private async request(step: Extract<ApiWorkflowStep, { kind: 'request' | 'poll' }>, vars: Record<string, string>): Promise<{ sent: StepSend; assigned: Record<string, string>; problems: string[] }> {
    const sent = await this.deps.send(step.requestId, step.variationId, { ...vars });
    const assigned = { ...sent.extracted };
    const problems: string[] = [];
    if (sent.facts && step.assign.length) {
      const got = extract(step.assign.map((a) => ({ ...a, enabled: true })), sent.facts);
      Object.assign(assigned, got.values);
      problems.push(...got.problems);
    }
    Object.assign(vars, assigned);
    return { sent, assigned, problems };
  }

  /** Runs steps in order. Returns false when a step failed and the run should stop. */
  async run(steps: ApiWorkflowStep[], vars: Record<string, string>, iteration = '', depth = 0): Promise<boolean> {
    for (const step of steps) if (!(await this.step(step, vars, iteration, depth))) return false;
    return true;
  }

  async step(step: ApiWorkflowStep, vars: Record<string, string>, iteration: string, depth: number): Promise<boolean> {
    this.budget();
    const t0 = this.deps.now();
    const took = () => this.deps.now() - t0;
    switch (step.kind) {
      case 'request': {
        const { sent, assigned, problems } = await this.request(step, vars);
        const passed = sent.passed && problems.length === 0;
        await this.record(step, iteration, {
          status: passed ? 'passed' : 'failed',
          message: [sent.message, ...problems.map((p) => `Could not assign ${p}`)].filter(Boolean).join(' '),
          historyId: sent.historyId,
          httpStatus: sent.facts?.status ?? null,
          durationMs: took(),
          assigned,
        }, t0);
        return passed || step.continueOnFail;
      }
      case 'wait':
        await this.deps.sleep(step.ms);
        await this.record(step, iteration, { status: 'passed', message: `Waited ${step.ms} ms`, historyId: null, httpStatus: null, durationMs: took(), assigned: {} }, t0);
        return true;
      case 'poll': {
        let tries = 0;
        let lastAnswer: string;
        for (;;) {
          tries++;
          const { sent, assigned } = await this.request(step, vars);
          lastAnswer = sent.facts ? `the last answer was ${sent.facts.status}` : sent.message || 'there was no answer';
          if (checkCondition(step.until, vars)) {
            await this.record(step, iteration, { status: 'passed', message: `${describe(step.until)} after ${tries} tr${tries === 1 ? 'y' : 'ies'}`, historyId: sent.historyId, httpStatus: sent.facts?.status ?? null, durationMs: took(), assigned }, t0);
            return true;
          }
          if (took() + step.intervalMs > step.timeoutMs) {
            await this.record(step, iteration, { status: 'failed', message: `${describe(step.until)} was not true after ${tries} tr${tries === 1 ? 'y' : 'ies'} in ${Math.round(took() / 1000)} s; ${lastAnswer}`, historyId: sent.historyId, httpStatus: sent.facts?.status ?? null, durationMs: took(), assigned }, t0);
            return false;
          }
          await this.deps.sleep(step.intervalMs);
          this.budget();
        }
      }
      case 'if': {
        const yes = checkCondition(step.condition, vars);
        await this.record(step, iteration, { status: 'passed', message: `${describe(step.condition)}: ${yes ? 'then' : 'else'}`, historyId: null, httpStatus: null, durationMs: 0, assigned: {} }, t0);
        return this.run(yes ? step.then : step.else, vars, iteration, depth);
      }
      case 'loop': {
        let items: unknown[];
        let cut = '';
        if (step.overVariable) {
          const raw = vars[step.overVariable];
          let parsed: unknown;
          try {
            parsed = raw === undefined ? undefined : JSON.parse(raw);
          } catch {
            parsed = undefined;
          }
          if (!Array.isArray(parsed)) {
            await this.record(step, iteration, { status: 'failed', message: `${step.overVariable} is not a JSON array, so there is nothing to loop over`, historyId: null, httpStatus: null, durationMs: 0, assigned: {} }, t0);
            return false;
          }
          items = parsed.slice(0, LOOP_MAX);
          if (parsed.length > LOOP_MAX) cut = ` (the first ${LOOP_MAX} of ${parsed.length})`;
        } else items = Array.from({ length: step.count ?? 1 }, (_, i) => String(i + 1));
        await this.record(step, iteration, { status: 'passed', message: `${items.length} time${items.length === 1 ? '' : 's'}${cut}`, historyId: null, httpStatus: null, durationMs: 0, assigned: {} }, t0);
        const before = snapshot(vars, step.as);
        try {
          for (const [i, item] of items.entries()) {
            setItem(vars, step.as, item);
            if (!(await this.run(step.steps, vars, `${iteration}${step.id}#${i + 1}/`, depth))) return false;
          }
          return true;
        } finally {
          // The loop's own variable is not left behind for later steps to trip over.
          restore(vars, step.as, before);
        }
      }
      case 'parallel': {
        // Each branch works on its own copy, so branches cannot overwrite each other mid-flight; what they
        // changed is merged back in branch order afterwards (the later branch wins a clash).
        const start = { ...vars };
        const copies = step.branches.map(() => ({ ...vars }));
        const outcomes = await Promise.all(step.branches.map((b, i) => this.run(b, copies[i]!, `${iteration}${step.id}|${i + 1}/`, depth)));
        for (const copy of copies) for (const [k, v] of Object.entries(copy)) if (start[k] !== v) vars[k] = v;
        const ok = outcomes.every(Boolean);
        await this.record(step, iteration, { status: ok ? 'passed' : 'failed', message: ok ? `${step.branches.length} branches` : `${outcomes.filter((o) => !o).length} of ${step.branches.length} branches failed`, historyId: null, httpStatus: null, durationMs: took(), assigned: {} }, t0);
        return ok;
      }
      case 'workflow': {
        if (depth >= LIMITS.depth) throw new StopRun(`Workflows nest at most ${LIMITS.depth} deep; check that no workflow calls itself.`);
        const sub = await this.deps.loadWorkflow(step.workflowId);
        for (const v of sub.def.variables) if (!(v.key in vars) && v.enabled) vars[v.key] = v.value;
        const ok = await this.run(sub.def.steps, vars, `${iteration}${step.id}>`, depth + 1);
        await this.run(sub.def.teardown, vars, `${iteration}${step.id}>teardown/`, depth + 1).catch(() => false);
        await this.record(step, iteration, { status: ok ? 'passed' : 'failed', message: `Ran ${sub.name}`, historyId: null, httpStatus: null, durationMs: took(), assigned: {} }, t0);
        return ok;
      }
    }
  }
}

/**
 * Runs a whole workflow: its steps, then its teardown whatever happened. Returns the run's status
 * and why it stopped, when it did.
 */
export async function runWorkflow(def: ApiWorkflowDef, vars: Record<string, string>, deps: EngineDeps): Promise<{ status: 'passed' | 'failed' | 'error' | 'cancelled'; error: string | null }> {
  for (const v of def.variables) if (v.enabled && !(v.key in vars)) vars[v.key] = v.value;
  const engine = new Engine(deps);
  let status: 'passed' | 'failed' | 'error' | 'cancelled' = 'passed';
  let error: string | null = null;
  try {
    const ok = await engine.run(def.steps, vars);
    if (!ok || engine.failed) status = 'failed';
  } catch (err) {
    status = deps.cancelled() ? 'cancelled' : err instanceof StopRun ? 'failed' : 'error';
    error = err instanceof Error ? err.message : 'The run failed';
  }
  // Teardown runs on its own budget of steps, so a run stopped for looping still cleans up.
  try {
    await new Engine(forTeardown(deps)).run(def.teardown, vars, 'teardown/');
  } catch (err) {
    error = error ?? `Teardown stopped: ${err instanceof Error ? err.message : 'failed'}`;
  }
  return { status, error };
}

/**
 * Runs one top-level step, for step-by-step mode. The teardown runs when the run ends. `failed` carries
 * whether an earlier step failed (and was set to continue), because each call is a fresh process step.
 */
export async function runOneStep(
  def: ApiWorkflowDef,
  index: number,
  vars: Record<string, string>,
  deps: EngineDeps,
  priorFailed = false,
): Promise<{ done: boolean; status: 'paused' | 'passed' | 'failed' | 'error' | 'cancelled'; error: string | null; failed: boolean }> {
  if (index === 0) for (const v of def.variables) if (v.enabled && !(v.key in vars)) vars[v.key] = v.value;
  const step = def.steps[index];
  let go = true;
  let failed = priorFailed;
  let error: string | null = null;
  let status: 'passed' | 'failed' | 'error' | 'cancelled' = 'passed';
  if (step) {
    const engine = new Engine(deps);
    try {
      go = await engine.step(step, vars, '', 0);
      failed = failed || engine.failed || !go;
    } catch (err) {
      go = false;
      failed = true;
      status = deps.cancelled() ? 'cancelled' : err instanceof StopRun ? 'failed' : 'error';
      error = err instanceof Error ? err.message : 'The step failed';
    }
  }
  const last = index + 1 >= def.steps.length;
  if (go && !last) return { done: false, status: 'paused', error: null, failed };
  await new Engine(forTeardown(deps)).run(def.teardown, vars, 'teardown/').catch(() => false);
  return { done: true, status: !failed ? 'passed' : status === 'passed' ? 'failed' : status, error, failed };
}
