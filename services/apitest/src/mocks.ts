import { createHash, randomBytes } from 'node:crypto';
import { MockConfig, MockOverride, type MockBody, type MockHit, type MockView } from '@tb/contracts';
import { AppError, notFound, withTenant, type Db, type ObjectStorage, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { loadSpecDoc } from './effective';
import { answer, compile, type MockAnswer, type MockRequest } from './mock';
import type { Caller, SecretBox } from './workspaces';

// Mock servers over the database (plan §14). Management needs a login; answering does not: the URL
// token is the credential, and it only ever gets back what the spec's examples and schemas say.

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
/** The public path a mock answers on, relative to the API prefix. */
export const MOCK_ROUTE = '/api/v1/apitest/mock/:token/*';

function urlFor(token: string, origin: string) {
  return `${origin}/api/v1/apitest/mock/${token}`;
}

export async function getMock(trx: Tx, box: SecretBox, projectId: string, specId: string, origin: string): Promise<MockView> {
  const spec = await trx.selectFrom('apitest.spec').select('id').where('id', '=', specId).where('project_id', '=', projectId).executeTakeFirst();
  if (!spec) throw notFound('Spec');
  const m = await trx.selectFrom('apitest.mock').selectAll().where('spec_id', '=', specId).executeTakeFirst();
  if (!m) return { specId, url: null, enabled: false, config: MockConfig.parse({}), overrides: {} };
  // A token that cannot be decrypted (key rotated) shows no URL; rotate it to get a working one.
  const token = (() => {
    try {
      return box ? box.decrypt(m.token_enc) : null;
    } catch {
      return null;
    }
  })();
  return { specId, url: token ? urlFor(token, origin) : null, enabled: m.enabled, config: MockConfig.parse(m.config), overrides: parseOverrides(m.overrides) };
}

const parseOverrides = (raw: Record<string, unknown>): MockView['overrides'] =>
  Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, MockOverride.parse(v)]));

/** Creates the mock on first save, with a fresh token; later saves keep the URL. */
export async function saveMock(trx: Tx, box: SecretBox, caller: Caller, projectId: string, specId: string, body: MockBody, origin: string): Promise<MockView> {
  if (!box) throw new AppError(503, 'secrets_unavailable', 'Mock servers need API_STUDIO_SECRET to be set on the server.');
  const spec = await trx.selectFrom('apitest.spec').select('id').where('id', '=', specId).where('project_id', '=', projectId).executeTakeFirst();
  if (!spec) throw notFound('Spec');
  const known = new Set((await specOperations(trx, specId)).map((o) => `${o.method} ${o.path}`));
  const overrides = Object.fromEntries(Object.entries(body.overrides).filter(([k, v]) => known.has(k) && (v.status !== null || v.body.trim() || v.delayMs)));
  const values = { enabled: body.enabled, config: JSON.stringify(body.config), overrides: JSON.stringify(overrides), updated_at: new Date() };
  const existing = await trx.selectFrom('apitest.mock').select('id').where('spec_id', '=', specId).executeTakeFirst();
  if (existing) await trx.updateTable('apitest.mock').set(values).where('id', '=', existing.id).execute();
  else {
    const token = randomBytes(24).toString('base64url');
    await trx.insertInto('apitest.mock').values({ org_id: caller.orgId, project_id: projectId, spec_id: specId, token_hash: sha(token), token_enc: box.encrypt(token), owner_id: caller.userId, ...values }).execute();
  }
  return getMock(trx, box, projectId, specId, origin);
}

/** A new URL: the old one stops working at once. For when a URL was shared too widely. */
export async function rotateMock(trx: Tx, box: SecretBox, projectId: string, specId: string, origin: string): Promise<MockView> {
  if (!box) throw notFound('Mock');
  const m = await trx.selectFrom('apitest.mock').select('id').where('spec_id', '=', specId).where('project_id', '=', projectId).executeTakeFirst();
  if (!m) throw notFound('Mock');
  const token = randomBytes(24).toString('base64url');
  await trx.updateTable('apitest.mock').set({ token_hash: sha(token), token_enc: box.encrypt(token), updated_at: new Date() }).where('id', '=', m.id).execute();
  return getMock(trx, box, projectId, specId, origin);
}

async function specOperations(trx: Tx, specId: string) {
  const v = await trx.selectFrom('apitest.spec_version as v').innerJoin('apitest.spec as s', (j) => j.onRef('s.id', '=', 'v.spec_id').onRef('s.current_version', '=', 'v.version')).select('v.operations').where('v.spec_id', '=', specId).executeTakeFirst();
  return (v?.operations ?? []) as { method: string; path: string }[];
}

// ---------- answering ----------

// ponytail: the request log and the compiled-spec cache live in this process, so each core-api
// instance has its own; a shared store (Valkey) when more than one runs.
const LOG_MAX = 50;
const logs = new Map<string, MockHit[]>();
const compiled = new Map<string, { at: number; doc: Record<string, unknown>; c: ReturnType<typeof compile> }>();
const CACHE_MS = 15_000;
const hits = new Map<string, { start: number; n: number }>();
const RATE_PER_MINUTE = 600;

export const mockLog = (specId: string): MockHit[] => logs.get(specId) ?? [];

/** Loose limit per mock so a loop in someone's client cannot hammer the server. */
function limited(token: string): boolean {
  const now = Date.now();
  const e = hits.get(token);
  if (!e || now - e.start > 60_000) {
    hits.set(token, { start: now, n: 1 });
    return false;
  }
  return ++e.n > RATE_PER_MINUTE;
}

export type MockResult = MockAnswer & { off?: 'unknown' | 'disabled' | 'rate' };

/** Answers a request for the mock behind `token`. The caller sends it; delays are the caller's to wait out. */
export async function serveMock(db: Db, storage: ObjectStorage, token: string, req: MockRequest): Promise<MockResult> {
  const t0 = Date.now();
  const fail = (status: number, message: string, off: MockResult['off']): MockResult => ({ status, body: { error: message }, headers: { 'content-type': 'application/json' }, operation: null, delayMs: 0, off });
  if (limited(token)) return fail(429, 'Too many requests to this mock; slow down.', 'rate');
  const { rows } = await sql<{ org_id: string; project_id: string; spec_id: string; owner_id: string; enabled: boolean; config: Record<string, unknown>; overrides: Record<string, unknown> }>`SELECT * FROM apitest.mock_lookup(${sha(token)})`.execute(db);
  const m = rows[0];
  if (!m) return fail(404, 'There is no mock at this address. It may have been given a new URL.', 'unknown');
  if (!m.enabled) return fail(404, 'This mock is switched off.', 'disabled');

  let cached = compiled.get(m.spec_id);
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const loaded = await withTenant(db, { orgId: m.org_id, userId: m.owner_id }, (trx) => loadSpecDoc(trx, storage, m.project_id, m.spec_id));
    cached = { at: Date.now(), doc: loaded.doc, c: compile(loaded.doc) };
    compiled.set(m.spec_id, cached);
  }
  const out = answer(cached.c, cached.doc, MockConfig.parse(m.config), parseOverrides(m.overrides), req);
  const log = logs.get(m.spec_id) ?? [];
  log.unshift({ at: new Date().toISOString(), method: req.method.toUpperCase(), path: req.path, status: out.status, operation: out.operation, ms: Date.now() - t0 });
  logs.set(m.spec_id, log.slice(0, LOG_MAX));
  return out;
}

/** Forgets the cached spec after an answer or version changes it, so the next request sees it. */
export const forgetMockCache = (specId: string) => void compiled.delete(specId);

