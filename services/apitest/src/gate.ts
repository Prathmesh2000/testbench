import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { ApiTarget } from '@tb/contracts';
import { AppError, badRequest, conflict, isBlockedHost, notFound, type Tx } from '@tb/platform';
import { sendHttp } from './http';
import type { Caller } from './workspaces';

// The safety gate (plan §14). Load tests and active security checks send traffic that can hurt, so they
// run only against a host the project has proved it owns, never at production without an admin's
// explicit go-ahead, and every use is audited. Local development hosts need no proof.

/** host[:port] of a URL, lowercased, with default ports dropped: how targets are stored and compared. */
export function hostKey(url: string): string {
  const u = new URL(url);
  return u.port ? `${u.hostname.toLowerCase()}:${u.port}` : u.hostname.toLowerCase();
}

export const dnsName = (host: string) => `_testbench-challenge.${host.split(':')[0]}`;
export const dnsValue = (token: string) => `testbench-verify=${token}`;
export const fileUrl = (host: string, secure: boolean) => `${secure ? 'https' : 'http'}://${host}/.well-known/testbench-verify.txt`;

export type Decision = { ok: true; via: 'local' | 'verified'; overridden: boolean } | { ok: false; code: 'unverified' | 'production'; reason: string };

/**
 * May traffic go to this host? `local` is a private or loopback host in a development setup. A
 * production environment is refused unless an admin overrides, whatever the verification says.
 */
export function decide(i: { host: string; local: boolean; verified: boolean; production: boolean; override: boolean; canOverride: boolean }): Decision {
  if (i.production) {
    if (!i.override) return { ok: false, code: 'production', reason: `${i.host} is a production environment. Heavy traffic and attack probes there need an admin's explicit override.` };
    if (!i.canOverride) return { ok: false, code: 'production', reason: 'Only a project admin can override the production guard.' };
  }
  if (i.local) return { ok: true, via: 'local', overridden: i.production };
  if (!i.verified) return { ok: false, code: 'unverified', reason: `${i.host} has not been verified as yours. Add it under Safety, publish the DNS record or file, and verify it first.` };
  return { ok: true, via: 'verified', overridden: i.production };
}

// ---------- targets ----------

type TargetRow = { id: string; host: string; token: string; status: string; method: string | null; verified_at: Date | null; verified_by: string | null };

function view(r: TargetRow, name: string | null): ApiTarget {
  return {
    id: r.id,
    host: r.host,
    status: r.status as ApiTarget['status'],
    challenge: {
      token: r.token,
      dns: { name: dnsName(r.host), value: dnsValue(r.token) },
      file: { url: fileUrl(r.host, true), content: r.token },
    },
    verifiedAt: r.verified_at?.toISOString() ?? null,
    verifiedBy: name,
    method: r.method as ApiTarget['method'],
  };
}

export async function listTargets(trx: Tx, projectId: string): Promise<ApiTarget[]> {
  const rows = await trx
    .selectFrom('apitest.target as t')
    .leftJoin('iam.app_user as u', 'u.id', 't.verified_by')
    .select(['t.id', 't.host', 't.token', 't.status', 't.method', 't.verified_at', 't.verified_by', 'u.name as who'])
    .where('t.project_id', '=', projectId)
    .orderBy('t.host')
    .execute();
  return rows.map((r) => view(r, r.who));
}

export async function addTarget(trx: Tx, caller: Caller, projectId: string, host: string): Promise<ApiTarget> {
  try {
    const row = await trx
      .insertInto('apitest.target')
      .values({ org_id: caller.orgId, project_id: projectId, host, token: randomBytes(16).toString('hex'), created_by: caller.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row, null);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict(`${host} is already in the list.`);
    throw err;
  }
}

export async function removeTarget(trx: Tx, projectId: string, id: string): Promise<void> {
  const done = await trx.deleteFrom('apitest.target').where('id', '=', id).where('project_id', '=', projectId).executeTakeFirst();
  if (!done.numDeletedRows) throw notFound('Target');
}

export interface Prover {
  txt(name: string): Promise<string[]>;
  fetchText(url: string): Promise<string | null>;
}

/** The real prover: DNS lookups, and file fetches through the same SSRF guard as every other send. */
export const realProver = (allowPrivate: boolean): Prover => ({
  txt: async (name) => (await resolveTxt(name).catch(() => [] as string[][])).map((parts) => parts.join('')),
  fetchText: async (url) => {
    const out = await sendHttp({ method: 'GET', url, headers: [], body: null, secrets: [], unresolved: [] }, { allowPrivate, timeoutMs: 10_000, followRedirects: false, maxBodyBytes: 4096 });
    return out.response && out.response.status === 200 ? out.response.body.toString('utf8') : null;
  },
});

/** Checks the proof is published; marks the target verified when it is. The network call is outside the transaction. */
export async function proveTarget(prover: Prover, target: { host: string; token: string }, method: 'dns' | 'file', schemes: ('https' | 'http')[] = ['https']): Promise<boolean> {
  if (method === 'dns') return (await prover.txt(dnsName(target.host))).some((v) => v.trim() === dnsValue(target.token));
  for (const scheme of schemes) {
    const text = await prover.fetchText(fileUrl(target.host, scheme === 'https'));
    if (text?.trim() === target.token) return true;
  }
  return false;
}

export async function targetToProve(trx: Tx, projectId: string, id: string) {
  const t = await trx.selectFrom('apitest.target').select(['id', 'host', 'token', 'status']).where('id', '=', id).where('project_id', '=', projectId).executeTakeFirst();
  if (!t) throw notFound('Target');
  return t;
}

export async function markVerified(trx: Tx, caller: Caller, id: string, method: 'dns' | 'file'): Promise<void> {
  await trx.updateTable('apitest.target').set({ status: 'verified', method, verified_at: new Date(), verified_by: caller.userId }).where('id', '=', id).execute();
}

/** Throws unless traffic may go to the URL; returns how it was allowed, for the audit entry. */
export async function assertAllowed(
  trx: Tx,
  cfg: { allowPrivate: boolean },
  projectId: string,
  url: string,
  env: { name: string; production: boolean },
  override: { requested: boolean; canOverride: boolean },
): Promise<{ host: string; decision: Extract<Decision, { ok: true }> }> {
  let host: string;
  try {
    host = hostKey(url);
  } catch {
    throw badRequest(`${url} is not a valid address. Set {{baseUrl}} in the environment ${env.name}.`);
  }
  const local = cfg.allowPrivate && (await isBlockedHost(host.split(':')[0]!));
  const t = await trx.selectFrom('apitest.target').select('status').where('project_id', '=', projectId).where('host', '=', host).executeTakeFirst();
  const d = decide({ host, local, verified: t?.status === 'verified', production: env.production, override: override.requested, canOverride: override.canOverride });
  if (!d.ok) throw new AppError(d.code === 'production' ? 403 : 412, d.code === 'production' ? 'production_guard' : 'target_unverified', d.reason);
  return { host, decision: d };
}
