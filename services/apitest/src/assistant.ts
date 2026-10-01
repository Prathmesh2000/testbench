import type { AiService } from '@tb/ai';
import type { AskResult, AssistAi, DetectAuthResult, ExplainedRoute, ExplainResult, PlanChain, PlanResult } from '@tb/contracts';
import type { ObjectStorage, Tx } from '@tb/platform';
import { detectAuth, matchRoute, parseRoutes, retrieve } from './assist';
import { chainTo, type OperationIO } from './deps';
import { projectMap } from './map';
import { getHistory } from './send';
import type { Caller } from './workspaces';

// The API assistant (plan §16) over the database and the AI layer. The rules always produce a full
// answer; the model, when allowed and reachable, writes the explanation or picks among valid chains.
// Anything it names that is not a real operation is dropped.

const MAX_ROUTES = 30;
type Map = Awaited<ReturnType<typeof projectMap>>;

function brief(o: OperationIO, map: Map) {
  return {
    key: o.key,
    summary: o.summary,
    inputs: [...o.inputs.map((i) => `${i.name} (${i.in})`), ...o.bodyIds.map((b) => `${b} (body)`)],
    outputs: o.outputs,
    security: o.securitySchemes,
    dependsOn: [...new Set(map.links.filter((l) => l.to === o.key).map((l) => l.from))],
    feeds: [...new Set(map.links.filter((l) => l.from === o.key).map((l) => l.to))],
  };
}

/** What a route is worth testing, from its shape alone: the fallback when no model is used. */
function rulesWhatToTest(o: OperationIO, map: Map): string[] {
  const out = ['A valid request succeeds and returns the documented body'];
  if (o.inputs.length || o.bodyIds.length) out.push(`Missing or invalid ${[...o.inputs.map((i) => i.name), ...o.bodyIds].slice(0, 3).join(', ')} is refused`);
  if (o.secured) out.push('No or expired credential gets 401; a role without access gets 403');
  if (o.inputs.some((i) => i.in === 'path')) out.push('An unknown id gets 404, and another customer’s id is refused');
  if (o.method === 'POST') out.push('Sending the same create twice is handled (409, or one record)');
  if (o.method === 'DELETE') out.push('After deleting, reading it back gets 404');
  const needs = map.links.filter((l) => l.to === o.key && l.param.in !== 'auth');
  if (needs.length) out.push(`Set up first with ${[...new Set(needs.map((l) => l.from))].slice(0, 2).join(' and ')}`);
  return out;
}

export async function explainContext(trx: Tx, storage: ObjectStorage, projectId: string, text: string) {
  const map = await projectMap(trx, storage, projectId);
  const parsed = parseRoutes(text).slice(0, MAX_ROUTES);
  const lines = text.split('\n').filter((l) => l.trim()).length;
  const routes: ExplainedRoute[] = parsed.map((r) => {
    const o = matchRoute(r, map.io);
    if (!o)
      return {
        key: `${r.method} ${r.path}`,
        known: false,
        source: r.source,
        purpose: 'Not in any of the project’s specs.',
        inputs: [...r.path.matchAll(/\{([^}]+)\}/g)].map((m) => `${m[1]} (path)`),
        security: [],
        dependsOn: [],
        feeds: [],
        whatToTest: ['Add it to the spec (or upload the spec that has it) to get its inputs, auth and dependencies'],
        gaps: ['Undocumented: no spec describes this route'],
      };
    const b = brief(o, map);
    return {
      key: o.key,
      known: true,
      source: r.source,
      purpose: o.summary || `${o.method} ${o.path}`,
      inputs: b.inputs,
      security: o.securitySchemes,
      dependsOn: map.links.filter((l) => l.to === o.key).map((l) => ({ key: l.from, field: l.field, param: l.param.in === 'auth' ? 'login' : l.param.name })),
      feeds: b.feeds,
      whatToTest: rulesWhatToTest(o, map),
      gaps: [...(o.outputs.length ? [] : ['The response body is not described']), ...map.operations.find((m) => m.key === o.key)!.orphans.map((x) => `Nothing produces ${x}: supply it`)],
    };
  });
  const briefs = parsed.map((r) => matchRoute(r, map.io)).filter((o): o is OperationIO => !!o).map((o) => brief(o, map));
  return { result: { routes, unread: Math.max(0, lines - parsed.length), ai: { status: 'off', message: null } as AssistAi } satisfies ExplainResult, briefs };
}

/** Runs the model when allowed, merging its words into the rule answer; never trusts keys it invents. */
export async function explainWithAi(ai: AiService | null, caller: Caller, ctx: Awaited<ReturnType<typeof explainContext>>, aiOff: string | null): Promise<ExplainResult> {
  const r = ctx.result;
  if (aiOff) return { ...r, ai: { status: 'off', message: aiOff } };
  if (!ai || !ctx.briefs.length) return r;
  try {
    const out = await ai.run(caller, 'api_explain', { routes: ctx.briefs });
    const byKey = new Map(out.result.routes.map((x) => [x.key, x]));
    return {
      ...r,
      routes: r.routes.map((route) => {
        const m = route.known ? byKey.get(route.key) : undefined;
        return m ? { ...route, purpose: m.purpose || route.purpose, whatToTest: m.whatToTest.length ? m.whatToTest : route.whatToTest, gaps: [...new Set([...route.gaps, ...m.gaps])] } : route;
      }),
      ai: { status: 'used', message: `${out.provider} · ${out.model}` },
    };
  } catch (err) {
    return { ...r, ai: { status: 'unavailable', message: err instanceof Error ? err.message : 'The AI model could not be reached.' } };
  }
}

export async function planContext(trx: Tx, storage: ObjectStorage, projectId: string, requirement: string) {
  const map = await projectMap(trx, storage, projectId);
  const hits = retrieve(requirement, map.operations, 6);
  const chains: PlanChain[] = [];
  for (const h of hits) {
    const steps = chainTo(h.op.key, map.links);
    if (chains.some((c) => c.steps.join('|') === steps.join('|'))) continue;
    const setup = steps.length - 1;
    chains.push({ index: chains.length, steps, why: `Ends with ${h.op.key} (${h.op.summary || 'no summary'})${setup ? `, after ${setup} setup call${setup === 1 ? '' : 's'}` : ''}` });
  }
  return { chains, map };
}

export async function planWithAi(ai: AiService | null, caller: Caller, requirement: string, chains: PlanChain[], aiOff: string | null): Promise<PlanResult> {
  const fallback: PlanResult = {
    chains,
    chosen: chains.length ? 0 : null,
    explanation: chains.length ? `The closest documented calls end with ${chains[0]!.steps.at(-1)}. Matched on the words of the requirement.` : 'No documented operation matches this requirement. It may need an API that does not exist yet.',
    gaps: chains.length ? [] : [requirement],
    ai: { status: 'off', message: aiOff },
  };
  if (aiOff || !ai || !chains.length) return fallback;
  try {
    const out = await ai.run(caller, 'api_plan', { requirement, candidates: chains.map((c) => ({ index: c.index, steps: c.steps, why: c.why })) });
    const chosen = out.result.chosen >= 0 && out.result.chosen < chains.length ? out.result.chosen : null;
    return { chains, chosen, explanation: out.result.explanation, gaps: out.result.gaps, ai: { status: 'used', message: `${out.provider} · ${out.model}` } };
  } catch (err) {
    return { ...fallback, ai: { status: 'unavailable', message: err instanceof Error ? err.message : 'The AI model could not be reached.' } };
  }
}

export async function askContext(trx: Tx, storage: ObjectStorage, projectId: string, userId: string, workspaceId: string | null, question: string, historyId: string | null) {
  const map = await projectMap(trx, storage, projectId);
  const last = historyId && workspaceId ? await getHistory(trx, userId, workspaceId, historyId) : null;
  const lastOp = last ? map.io.find((o) => matchRoute({ method: last.method, path: new URL(last.url).pathname }, [o])) : undefined;
  const hits = retrieve(question, map.operations, 6).map((h) => map.io.find((o) => o.key === h.op.key)!);
  const ops = [...new Set([...(lastOp ? [lastOp] : []), ...hits])];
  const auth = last?.request.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1].split(' ')[0] ?? (last?.request.headers.some(([k]) => k.toLowerCase() === 'cookie') ? 'a cookie' : 'no credential');
  return {
    map,
    input: {
      question,
      operations: ops.map((o) => brief(o, map)),
      last: last ? { status: last.status, security: lastOp?.securitySchemes ?? [], auth, body: (last.response?.body ?? '').slice(0, 1500) } : null,
    },
  };
}

export async function askWithAi(ai: AiService | null, caller: Caller, ctx: Awaited<ReturnType<typeof askContext>>, aiOff: string | null): Promise<AskResult> {
  const known = new Set(ctx.map.io.map((o) => o.key));
  const { input } = ctx;
  const rules = (): AskResult => {
    if (input.last && (input.last.status === 401 || input.last.status === 403))
      return {
        answer: `${input.last.status === 401 ? 'A 401 means the API did not accept the credential' : 'A 403 means the credential is valid but not allowed to do this'}. The request was sent with ${input.last.auth}${input.last.security.length ? `; the operation expects ${input.last.security.join(' or ')}` : ''}. Check the Auth tab (or the folder's), that the token is current, and that the profile's user has the role this needs.`,
        operations: input.operations.slice(0, 1).map((o) => o.key),
        ai: { status: 'off', message: aiOff },
      };
    return input.operations.length
      ? { answer: `The closest documented operations are ${input.operations.slice(0, 3).map((o) => `${o.key}${o.summary ? ` (${o.summary})` : ''}`).join(', ')}.`, operations: input.operations.slice(0, 3).map((o) => o.key), ai: { status: 'off', message: aiOff } }
      : { answer: 'Nothing in the project’s specs matches that. Upload the spec that covers it, or ask about another part of the API.', operations: [], ai: { status: 'off', message: aiOff } };
  };
  if (aiOff || !ai) return rules();
  try {
    const out = await ai.run(caller, 'api_ask', input);
    return { answer: out.result.answer, operations: out.result.operations.filter((k) => known.has(k)), ai: { status: 'used', message: `${out.provider} · ${out.model}` } };
  } catch (err) {
    return { ...rules(), ai: { status: 'unavailable', message: err instanceof Error ? err.message : 'The AI model could not be reached.' } };
  }
}

const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Reads how a login hands out its credential from a send in history. */
export async function detectFromHistory(trx: Tx, userId: string, workspaceId: string, historyId: string): Promise<DetectAuthResult> {
  const h = await getHistory(trx, userId, workspaceId, historyId);
  if (!h.response) return { found: false, config: null, explanation: 'That send got no response, so there is nothing to read.', loginNodeId: h.nodeId };
  const body = h.response.bodyEncoding === 'utf8' ? parseJsonOrNull(h.response.body) : null;
  // History masks Set-Cookie values but keeps the names, which is all detection needs.
  const d = detectAuth({ headers: h.response.headers, body });
  return d ? { found: true, config: d.config, explanation: d.explanation, loginNodeId: h.nodeId } : { found: false, config: null, explanation: 'The response carries no token, credential header or session cookie. Is this the login request?', loginNodeId: h.nodeId };
}
