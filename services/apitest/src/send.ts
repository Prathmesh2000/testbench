import {
  ApiContainerConfig,
  ApiRequestDef,
  type ApiAuth,
  HTTP_METHODS,
  type ApiResponseView,
  type CookieView,
  type HistoryDetail,
  type HistoryEntry,
  type SendBody,
  type SendResult,
} from '@tb/contracts';
import { badRequest, notFound, type ObjectStorage, type Tx } from '@tb/platform';
import { evaluate, extract } from './assert';
import { checkDrift } from './drift';
import { passiveChecks } from './security';
import { loadSpecDoc } from './effective';
import { deref } from './spec';
import { cookieHeader, cookieView, storeCookies, type StoredCookie } from './cookies';
import { sendHttp, type SendOutcome } from './http';
import { applyVariation, buildRequest, effectiveAuth, flattenScopes, maskHeaders, maskSecrets, ResolveError, secretValues, type ConcreteRequest, type Scopes } from './resolve';
import { runScripts, type ScriptHost, type ScriptOutput, type ScriptSource } from './sandbox';
import { loadCerts, loadProfile, saveSession, type LoadedProfile } from './auth';
import { applyCredential, certFor, csrfHeader, extractCredential, hasSessionCookie, ProfileError, sessionExpiry, type CertBundle } from './profiles';
import { toResolved, type StoredVariable } from './vars';
import { ancestry, environmentIn, variationOverrides, type Caller, type SecretBox } from './workspaces';

// One send from the builder, in three steps so no transaction is open while the target API answers:
// prepare (load scopes, run pre scripts, resolve), send and run post scripts, record (history and
// cookie jar). See plan §4, §5, §6, §16.5.

export interface SendConfig {
  allowPrivate: boolean;
}

/** What the builder shows of a body. The send reads up to MAX_READ; history keeps a shorter preview. */
const MAX_READ = 10 * 1024 * 1024;
const MAX_VIEW = 2 * 1024 * 1024;
const MAX_HISTORY = 64 * 1024;
/** How much of the response body a post script sees; the sandbox has 32 MB in all. */
const MAX_SCRIPT_BODY = 2 * 1024 * 1024;

export interface PreparedSend {
  request: ConcreteRequest;
  body: SendBody;
  def: ReturnType<typeof applyVariation>;
  jar: StoredCookie[] | null;
  jarId: string | null;
  /** Every secret value in scope, for masking whatever is stored or shown, script output included. */
  secrets: string[];
  pre: ScriptOutput | null;
  /** Post scripts, request first then its folders up to the collection. */
  post: ScriptSource[];
  /** Variables as they stand after the pre scripts, and the environment's own, for the post scripts. */
  variables: Record<string, string>;
  environment: Record<string, string>;
  /** Only the "saved" cookie option keeps the jar; otherwise it lives for this send. */
  persistJar: boolean;
  certs: (CertBundle & { host: string })[];
  /** Set when the request logs in with an auth profile: the profile, and its login ready to send. */
  profile: { loaded: LoadedProfile; login: PreparedSend } | null;
  spec: SpecLink | null;
}

const decryptWith = (box: SecretBox) => (box ? (c: string) => box.decrypt(c) : null);

/** Everything a send needs from the database, read in one transaction before anything runs. */
export interface LoadedSend {
  body: SendBody;
  def: ApiRequestDef;
  scopes: Scopes;
  auth: ApiAuth;
  containerScripts: { source: string; scripts: { pre: string; post: string } }[];
  environment: Record<string, string>;
  jar: StoredCookie[] | null;
  jarId: string | null;
  certs: (CertBundle & { host: string })[];
  profile: { loaded: LoadedProfile; login: LoadedSend } | null;
  /** The effective spec operation the request was made from, to check the response for drift. */
  spec: SpecLink | null;
}

export interface SpecLink {
  specId: string;
  version: number;
  key: string;
  doc: Record<string, unknown>;
  op: Record<string, unknown>;
}

/**
 * Reads what the request inherits: its folders and collection, variation, environment, cookie jar,
 * certificates and auth profile. With `forLogin`, this is a profile's login request: it never uses a
 * profile itself, so a collection-level profile cannot make its own login recurse.
 */
export async function loadSend(
  trx: Tx,
  box: SecretBox,
  caller: Caller,
  workspace: { id: string; variables: unknown[] },
  body: SendBody,
  opts: { forLogin?: boolean; certs?: LoadedSend['certs']; storage?: ObjectStorage; projectId?: string } = {},
): Promise<LoadedSend> {
  let def = body.request;
  const start = body.nodeId ?? body.parentId;
  const chain = start ? await ancestry(trx, workspace.id, start) : [];
  if (start && !chain.length) throw notFound('Item');
  if (body.nodeId && chain[0]?.kind !== 'request') throw badRequest('Only a request can be sent.');
  if (body.variationId) {
    if (!body.nodeId) throw badRequest('A variation is sent from its saved request.');
    def = applyVariation(def, await variationOverrides(trx, body.nodeId, body.variationId));
  }
  const names = chain.filter((n) => n.kind !== 'request');
  const containers = names.map((n) => ApiContainerConfig.safeParse({ ...n.config, variables: [] }));
  const decrypt = decryptWith(box);
  const env = body.environmentId ? await environmentIn(trx, workspace.id, body.environmentId) : null;
  const envVars = toResolved((env?.variables as StoredVariable[] | undefined) ?? [], decrypt);

  const scopes: Scopes = [
    Object.entries(body.locals).map(([key, value]) => ({ key, value, secret: false, enabled: true })),
    ...names.map((n) => toResolved((n.config.variables as StoredVariable[] | undefined) ?? [], decrypt)),
    envVars,
    toResolved(workspace.variables as StoredVariable[], decrypt),
  ];
  let auth = effectiveAuth(
    def.auth,
    containers.map((c) => (c.success ? c.data.auth : { type: 'none' as const })),
  );
  let loaded: LoadedProfile | null = null;
  if (auth.type === 'profile') {
    if (!opts.forLogin) loaded = await loadProfile(trx, box, caller.userId, workspace.id, auth.profileId, body.environmentId);
    // The credential goes on at send time, after a login if one is needed.
    auth = { type: 'none' };
  }

  let jar: StoredCookie[] | null = null;
  let jarId: string | null = null;
  // A profile's login and the request share a jar; with the "none" option it lasts only this send.
  if (loaded && body.cookies !== 'saved') jar = [];
  if (body.cookies === 'saved') {
    const row = await trx
      .selectFrom('apitest.cookie_jar')
      .select(['id', 'cookies_enc'])
      .where('user_id', '=', caller.userId)
      .where('workspace_id', '=', workspace.id)
      .where((eb) => (body.environmentId ? eb('environment_id', '=', body.environmentId) : eb('environment_id', 'is', null)))
      .executeTakeFirst();
    jarId = row?.id ?? null;
    jar = [];
    if (row && box) {
      try {
        jar = JSON.parse(box.decrypt(row.cookies_enc)) as StoredCookie[];
      } catch {
        // A jar that cannot be read (key rotated) starts empty rather than blocking the send.
        jar = [];
      }
    }
  }
  const certs = opts.certs ?? (await loadCerts(trx, box, workspace.id));
  let profile: LoadedSend['profile'] = null;
  if (loaded) {
    const node = await trx.selectFrom('apitest.node').select('config').where('id', '=', loaded.loginNodeId).executeTakeFirstOrThrow();
    const login = await loadSend(
      trx,
      box,
      caller,
      workspace,
      { request: ApiRequestDef.parse(node.config), nodeId: loaded.loginNodeId, parentId: null, variationId: null, environmentId: body.environmentId, cookies: body.cookies, locals: body.locals },
      { forLogin: true, certs },
    );
    profile = { loaded, login };
  }
  // A spec that was deleted or cannot be read just means no drift check, never a failed send.
  let spec: SpecLink | null = null;
  if (def.operation && opts.storage && opts.projectId) {
    const { specId, method, path } = def.operation;
    spec = await loadSpecDoc(trx, opts.storage, opts.projectId, specId).then(
      (s) => {
        const item = deref(s.doc, (s.doc.paths as Record<string, unknown> | undefined)?.[path]) as Record<string, unknown> | undefined;
        const op = item ? (deref(s.doc, item[method.toLowerCase()]) as Record<string, unknown> | undefined) : undefined;
        return op ? { specId, version: s.version, key: `${method} ${path}`, doc: s.doc, op } : null;
      },
      () => null,
    );
  }
  return {
    spec,
    body,
    def,
    scopes,
    auth,
    // Innermost first; pre scripts run outermost first.
    containerScripts: containers.map((c, i) => ({ source: `${names[i]!.kind} ${names[i]!.name}`, scripts: c.success ? c.data.scripts : { pre: '', post: '' } })),
    environment: Object.fromEntries(envVars.filter((v) => v.enabled).map((v) => [v.key, v.value])),
    jar,
    jarId,
    certs,
    profile,
  };
}

const SCRIPT_SEND_TIMEOUT_MS = 10_000;
const SCRIPT_SEND_MAX_BYTES = 1024 * 1024;

/** How a script's tb.sendRequest goes out: the same sender, SSRF guard and certificates as any send. */
export function scriptSender(cfg: SendConfig, certs: LoadedSend['certs']): ScriptHost['send'] {
  return async (req) => {
    if (!/^https?:\/\//i.test(req.url)) return { error: 'tb.sendRequest needs a full http:// or https:// URL' };
    const out = await sendHttp(
      { method: req.method, url: req.url, headers: req.headers, body: req.body === null ? null : Buffer.from(req.body), secrets: [], unresolved: [] },
      { allowPrivate: cfg.allowPrivate, timeoutMs: SCRIPT_SEND_TIMEOUT_MS, followRedirects: true, maxBodyBytes: SCRIPT_SEND_MAX_BYTES, tls: certs.length ? (url) => certFor(certs, url) : undefined },
    );
    if (!out.response) return { error: out.error?.message ?? 'The request failed' };
    const r = out.response;
    return { code: r.status, status: r.statusText, headers: r.headers, body: r.body.toString('utf8'), responseTime: out.timings.totalMs, size: r.body.length };
  };
}

/** Runs the pre scripts and builds the concrete request. No database, so a script's own requests never hold a transaction. */
export async function buildSend(l: LoadedSend, cfg: SendConfig): Promise<PreparedSend> {
  let def = l.def;
  const scopes = l.scopes.map((sc) => [...sc]);
  const secrets = secretValues(scopes);
  const preScripts: ScriptSource[] = [
    ...[...l.containerScripts].reverse().map((c) => ({ source: c.source, code: c.scripts.pre })),
    { source: 'request', code: def.scripts.pre },
  ];
  let pre: ScriptOutput | null = null;
  if (preScripts.some((x) => x.code.trim())) {
    const editable = def.body.type === 'json' || def.body.type === 'text';
    pre = await runScripts(
      preScripts,
      {
        phase: 'pre',
        request: { method: def.method, url: def.url, headers: def.headers, body: editable ? (def.body as { text: string }).text : null },
        response: null,
        variables: flattenScopes(scopes),
        environment: l.environment,
      },
      { send: scriptSender(cfg, l.certs) },
    );
    const r = pre.request;
    def = {
      ...def,
      method: (HTTP_METHODS as readonly string[]).includes(r.method) ? (r.method as typeof def.method) : def.method,
      url: r.url,
      headers: r.headers,
      body: editable && r.body !== null ? ({ ...(def.body as { type: 'json' | 'text'; text: string }), text: r.body } as typeof def.body) : def.body,
    };
    // What the scripts set is the most specific scope, above the tester's session values.
    const unset = new Set(pre.unset);
    scopes[0] = [
      ...Object.entries(pre.set).map(([key, value]) => ({ key, value, secret: false, enabled: true })),
      ...scopes[0]!.filter((v) => !(v.key in pre!.set) && !unset.has(v.key)),
    ];
  }

  let request: ConcreteRequest;
  try {
    request = buildRequest(def, l.auth, scopes);
  } catch (err) {
    if (err instanceof ResolveError) throw badRequest(err.message);
    throw err;
  }
  const profile = l.profile ? { loaded: l.profile.loaded, login: await buildSend(l.profile.login, cfg) } : null;
  return {
    spec: l.spec,
    request,
    body: l.body,
    def,
    jar: l.jar,
    jarId: l.jarId,
    persistJar: l.body.cookies === 'saved',
    certs: l.certs,
    profile,
    secrets: [...new Set([...secrets, ...request.secrets, ...(profile?.loaded.session ? [profile.loaded.session.token] : []), ...(profile?.login.secrets ?? [])])],
    pre,
    post: [{ source: 'request', code: def.scripts.post }, ...l.containerScripts.map((c) => ({ source: c.source, code: c.scripts.post }))],
    variables: flattenScopes(scopes),
    environment: l.environment,
  };
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|problem\+json|[\w.+-]*\+(json|xml)))/i;

function responseView(outcome: SendOutcome, secrets: string[], limit: number): ApiResponseView | null {
  const r = outcome.response;
  if (!r) return null;
  const contentType = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
  const cut = r.body.subarray(0, limit);
  const text = !contentType || TEXTUAL.test(contentType);
  return {
    status: r.status,
    statusText: r.statusText,
    headers: maskHeaders(r.headers, secrets),
    body: text ? maskSecrets(cut.toString('utf8'), secrets) : cut.toString('base64'),
    bodyEncoding: text ? 'utf8' : 'base64',
    contentType,
    sizeBytes: r.body.length,
    truncated: r.truncated || r.body.length > limit,
  };
}

export interface Sent {
  outcome: SendOutcome;
  jar: StoredCookie[] | null;
  cookiesSet: string[];
  cookiesSent: string[];
  post: ScriptOutput | null;
  /** The profile's login, when this send had to log in first, and why. */
  login: { prepared: PreparedSend; sent: Sent; reason: NonNullable<SendResult['login']>['reason'] } | null;
  /** A new credential to keep for the tester. */
  session: { profileId: string; token: string; expiresAt: number | null } | null;
}

const noResponse = (message: string, code: string, headers: [string, string][]): SendOutcome => ({
  response: null,
  error: { code, message },
  timings: { dnsMs: null, connectMs: null, tlsMs: null, firstByteMs: null, totalMs: 0 },
  redirects: [],
  sentHeaders: headers,
});

export const factsOf = (r: NonNullable<SendOutcome['response']>, timeMs: number) => {
  const bodyText = r.body.toString('utf8');
  return { status: r.status, timeMs, sizeBytes: r.body.length, headers: r.headers, bodyText, json: parseJson(bodyText) };
};

/**
 * Sends the prepared request. No database: this is the step that can take as long as the API does.
 * With an auth profile it logs in first when there is no live session, and once more on a 401.
 */
export async function performSend(p: PreparedSend, cfg: SendConfig): Promise<Sent> {
  const state = { jar: p.jar, cookiesSet: [] as string[], cookiesSent: [] as string[] };
  const done = (outcome: SendOutcome, extra: Partial<Sent> = {}): Sent => ({ outcome, jar: state.jar, cookiesSet: state.cookiesSet, cookiesSent: state.cookiesSent, post: null, login: null, session: null, ...extra });
  if (p.def.protocol === 'ws' || p.def.protocol === 'sse')
    return done(noResponse('WebSocket and SSE requests are sent from the request builder; suites, workflows and load tests do not run them.', 'protocol', p.request.headers));
  if (p.pre?.errors.length) {
    const e = p.pre.errors[0]!;
    return done(noResponse(`The pre-request script in the ${e.source} failed, so the request was not sent: ${e.message}`, 'script', p.request.headers));
  }

  const send = (headers: [string, string][]) =>
    sendHttp(
      { ...p.request, headers },
      {
        allowPrivate: cfg.allowPrivate,
        timeoutMs: p.def.settings.timeoutMs,
        followRedirects: p.def.settings.followRedirects,
        maxBodyBytes: MAX_READ,
        tls: p.certs.length ? (url) => certFor(p.certs, url) : undefined,
        cookies: state.jar
          ? {
              header: (url) => {
                const { header, names } = cookieHeader(state.jar!, url, Date.now());
                state.cookiesSent.push(...names);
                return header;
              },
              store: (url, set) => {
                const next = storeCookies(state.jar!, set, url, Date.now());
                state.jar = next.jar;
                state.cookiesSet.push(...next.set);
              },
            }
          : undefined,
      },
    );

  let outcome: SendOutcome;
  let login: Sent['login'] = null;
  let session: Sent['session'] = null;
  if (!p.profile) outcome = await send(p.request.headers);
  else {
    const { loaded } = p.profile;
    const url = new URL(p.request.url);
    let token = loaded.session && !loaded.session.expired ? loaded.session.token : null;

    /** Runs the login and reads the credential from it; the error to show when it does not work. */
    const logIn = async (reason: NonNullable<SendResult['login']>['reason']): Promise<string | null> => {
      p.profile!.login.jar = state.jar;
      const sent = await performSend(p.profile!.login, cfg);
      state.jar = sent.jar;
      login = { prepared: p.profile!.login, sent, reason };
      const r = sent.outcome.response;
      if (!r) return `The login request of "${loaded.name}" failed: ${sent.outcome.error?.message ?? 'no response'}`;
      if (r.status >= 400) return `The login request of "${loaded.name}" answered ${r.status}, so this request was not sent. Check the login's credentials.`;
      try {
        const value = loaded.config.apply.as === 'cookie' ? '' : extractCredential(loaded.config, factsOf(r, sent.outcome.timings.totalMs), state.jar ?? [], new URL(p.profile!.login.request.url), Date.now());
        if (loaded.config.apply.as === 'cookie' && !hasSessionCookie(loaded.config, state.jar ?? [], url, Date.now()))
          return `The login of "${loaded.name}" set no ${loaded.config.extract.path} cookie for ${url.host}.`;
        token = value;
        if (value) {
          p.secrets.push(value);
          session = { profileId: loaded.id, token: value, expiresAt: sessionExpiry(value, loaded.config.ttlSeconds, Date.now()) };
        }
        return null;
      } catch (err) {
        if (err instanceof ProfileError) return err.message;
        throw err;
      }
    };
    const headersNow = () => {
      let h = token ? applyCredential(p.request.headers, loaded.config.apply, token) : p.request.headers;
      const csrf = csrfHeader(loaded.config, state.jar ?? [], url, p.request.method, Date.now());
      if (csrf) h = [...h.filter(([k]) => k.toLowerCase() !== csrf[0].toLowerCase()), csrf];
      return h;
    };

    const cookieOnly = loaded.config.apply.as === 'cookie';
    const live = cookieOnly ? hasSessionCookie(loaded.config, state.jar ?? [], url, Date.now()) : token !== null;
    if (!live) {
      const failed = await logIn(loaded.session?.expired ? 'expired' : 'no_session');
      if (failed) return done(noResponse(failed, 'login', p.request.headers), { login, session });
    }
    outcome = await send(headersNow());
    // A stored session can go stale before its expiry; one fresh login settles it.
    if (outcome.response?.status === 401 && loaded.config.reloginOn401 && live) {
      const failed = await logIn('unauthorized');
      if (failed) return done(noResponse(failed, 'login', p.request.headers), { login, session });
      outcome = await send(headersNow());
    }
  }

  const r = outcome.response;
  const post =
    r && p.post.some((x) => x.code.trim())
      ? await runScripts(p.post, {
          phase: 'post',
          request: { method: p.def.method, url: p.request.url, headers: p.def.headers, body: p.request.body?.toString('utf8') ?? null },
          response: {
            code: r.status,
            status: r.statusText,
            headers: r.headers,
            body: r.body.subarray(0, MAX_SCRIPT_BODY).toString('utf8'),
            responseTime: outcome.timings.totalMs,
            size: r.body.length,
          },
          variables: p.variables,
          environment: p.environment,
        }, { send: scriptSender(cfg, p.certs) })
      : null;
  return done(outcome, { post, login, session });
}

/** The body as JSON, or undefined when it is not JSON (assertions then say so). */
function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * What a send's extractors and scripts set, unmasked: a workflow passes these to its next step. Only
 * masked copies are ever stored or shown.
 */
export function rawExtracted(p: PreparedSend, sent: Sent): Record<string, string> {
  const r = sent.outcome.response;
  let out = r ? extract(p.def.extractors, factsOf(r, sent.outcome.timings.totalMs)).values : {};
  for (const run of [p.pre, sent.post]) if (run) out = { ...out, ...run.set };
  return out;
}

/** Checks assertions, runs extractors, writes masked history and the jar, and returns what the builder shows. */
export async function recordSend(
  trx: Tx,
  box: SecretBox,
  caller: Caller,
  projectId: string,
  workspaceId: string,
  p: PreparedSend,
  sent: Sent,
): Promise<SendResult> {
  const { outcome } = sent;
  const secrets = p.secrets;
  const r = outcome.response;
  let assertions: SendResult['assertions'] = [];
  let extracted: Record<string, string> = {};
  let drift: SendResult['drift'] = null;
  let security: SendResult['security'] = [];
  if (r) {
    const facts = factsOf(r, outcome.timings.totalMs);
    assertions = evaluate(p.def.assertions, facts);
    extracted = extract(p.def.extractors, facts).values;
    if (p.spec)
      drift = {
        operation: p.spec.key,
        specId: p.spec.specId,
        specVersion: p.spec.version,
        status: r.status,
        issues: checkDrift(p.spec.doc, p.spec.op, r.status, facts.json).map((i) => ({ ...i, actual: maskSecrets(i.actual, secrets) })),
      };
    security = passiveChecks(
      {
        method: p.request.method,
        url: p.request.url,
        requestHeaders: outcome.sentHeaders,
        requestBody: p.request.body?.subarray(0, 4000).toString('utf8') ?? null,
        status: r.status,
        responseHeaders: r.headers,
        responseBody: facts.bodyText.slice(0, 4000),
      },
      { operation: p.spec?.key ?? null, authSent: outcome.sentHeaders.some(([k]) => /^(authorization|cookie|x-api-key)$/i.test(k)), json: facts.json },
      secrets,
    );
  }
  // Script tests sit with the no-code checks; what scripts set joins what extractors saved.
  const scriptRuns = [p.pre, sent.post].filter((x): x is ScriptOutput => x !== null);
  scriptRuns.forEach((run, n) =>
    run.tests.forEach((t, i) =>
      assertions.push({ id: `script:${n}:${i}`, passed: t.passed, message: t.passed ? t.name : `${t.name}: ${maskSecrets(t.error ?? 'failed', secrets)}`, actual: null }),
    ),
  );
  for (const run of scriptRuns) extracted = { ...extracted, ...run.set };
  const cleared = scriptRuns.flatMap((run) => run.unset).filter((k) => !(k in extracted));

  const url = maskSecrets(p.request.url, secrets);
  const requestHeaders = maskHeaders(outcome.sentHeaders, secrets);
  const requestBody = p.request.body ? maskSecrets(p.request.body.subarray(0, MAX_HISTORY).toString('utf8'), secrets) : null;
  const history = await trx
    .insertInto('apitest.history')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      workspace_id: workspaceId,
      user_id: caller.userId,
      node_id: p.body.nodeId,
      method: p.request.method,
      url,
      status: r?.status ?? null,
      duration_ms: outcome.timings.totalMs,
      request: JSON.stringify({ headers: requestHeaders, body: requestBody }),
      response: JSON.stringify(responseView(outcome, secrets, MAX_HISTORY) && { ...responseView(outcome, secrets, MAX_HISTORY), drift }),
      error: outcome.error?.message ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // The login goes into history as its own send, so the tester can see what it did.
  const login = sent.login ? await recordSend(trx, box, caller, projectId, workspaceId, sent.login.prepared, { ...sent.login.sent, jar: null }) : null;
  if (sent.session) await saveSession(trx, box, caller, sent.session.profileId, p.body.environmentId, sent.session.token, sent.session.expiresAt);
  const loginSetCookies = sent.login?.sent.cookiesSet.length ?? 0;

  // The jar is only kept when the server can encrypt it: cookies are credentials.
  if (p.persistJar && sent.jar && box && (sent.cookiesSet.length || loginSetCookies)) {
    const cookies_enc = box.encrypt(JSON.stringify(sent.jar));
    if (p.jarId) await trx.updateTable('apitest.cookie_jar').set({ cookies_enc, updated_at: new Date() }).where('id', '=', p.jarId).execute();
    else
      await trx
        .insertInto('apitest.cookie_jar')
        .values({ org_id: caller.orgId, user_id: caller.userId, workspace_id: workspaceId, environment_id: p.body.environmentId, cookies_enc, updated_at: new Date() })
        .execute();
  }

  return {
    historyId: history.id,
    url,
    method: p.def.method,
    requestHeaders,
    response: responseView(outcome, secrets, MAX_VIEW),
    error: outcome.error,
    timings: outcome.timings,
    redirects: outcome.redirects.map((x) => ({ ...x, url: maskSecrets(x.url, secrets) })),
    assertions,
    // Extracted values go back to the tester's browser as locals; secret values in them stay masked.
    extracted: Object.fromEntries(Object.entries(extracted).map(([k, v]) => [k, maskSecrets(v, secrets)])),
    unresolved: p.request.unresolved,
    cookiesSent: [...new Set(sent.cookiesSent)],
    cookiesSet: [...new Set(sent.cookiesSet)],
    cleared,
    drift,
    security,
    login: login && sent.login ? { status: login.response?.status ?? null, error: login.error?.message ?? null, historyId: login.historyId, reason: sent.login.reason } : null,
    logs: scriptRuns.flatMap((run) => run.logs).map((l) => ({ ...l, text: maskSecrets(l.text, secrets) })),
    scriptErrors: [p.pre && { phase: 'pre' as const, errors: p.pre.errors }, sent.post && { phase: 'post' as const, errors: sent.post.errors }]
      .filter((x) => x !== null)
      .flatMap((x) => x.errors.map((e) => ({ phase: x.phase, source: e.source, message: maskSecrets(e.message, secrets) }))),
  };
}

// ---------- history and cookies ----------

type HistoryRow = { id: string; node_id: string | null; method: string; url: string; status: number | null; duration_ms: number; error: string | null; created_at: Date };
const entry = (h: HistoryRow): HistoryEntry => ({
  id: h.id,
  nodeId: h.node_id,
  method: h.method as HistoryEntry['method'],
  url: h.url,
  status: h.status,
  durationMs: h.duration_ms,
  error: h.error,
  createdAt: h.created_at.toISOString(),
});

export async function listHistory(trx: Tx, userId: string, workspaceId: string): Promise<HistoryEntry[]> {
  const rows = await trx
    .selectFrom('apitest.history')
    .select(['id', 'node_id', 'method', 'url', 'status', 'duration_ms', 'error', 'created_at'])
    .where('user_id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .orderBy('created_at', 'desc')
    .limit(100)
    .execute();
  return rows.map(entry);
}

export async function getHistory(trx: Tx, userId: string, workspaceId: string, id: string): Promise<HistoryDetail> {
  const h = await trx
    .selectFrom('apitest.history')
    .selectAll()
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!h) throw notFound('History entry');
  return { ...entry(h), request: h.request as HistoryDetail['request'], response: h.response as ApiResponseView | null };
}

export async function clearHistory(trx: Tx, userId: string, workspaceId: string): Promise<void> {
  await trx.deleteFrom('apitest.history').where('user_id', '=', userId).where('workspace_id', '=', workspaceId).execute();
}

export async function listCookies(trx: Tx, box: SecretBox, userId: string, workspaceId: string, environmentId: string | null): Promise<CookieView[]> {
  const row = await trx
    .selectFrom('apitest.cookie_jar')
    .select('cookies_enc')
    .where('user_id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .where((eb) => (environmentId ? eb('environment_id', '=', environmentId) : eb('environment_id', 'is', null)))
    .executeTakeFirst();
  if (!row || !box) return [];
  try {
    const now = Date.now();
    return (JSON.parse(box.decrypt(row.cookies_enc)) as StoredCookie[]).filter((c) => c.expires === null || c.expires > now).map(cookieView);
  } catch {
    return [];
  }
}

export async function clearCookies(trx: Tx, userId: string, workspaceId: string, environmentId: string | null): Promise<void> {
  await trx
    .deleteFrom('apitest.cookie_jar')
    .where('user_id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .where((eb) => (environmentId ? eb('environment_id', '=', environmentId) : eb('environment_id', 'is', null)))
    .execute();
}
