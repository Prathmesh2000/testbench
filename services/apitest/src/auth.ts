import { ApiRequestDef, AuthProfileConfig, type AuthProfileBody, type AuthProfileView, type ClientCertBody, type ClientCertView } from '@tb/contracts';
import { AppError, badRequest, conflict, notFound, type Tx } from '@tb/platform';
import { inspectBundle, ProfileError, type CertBundle } from './profiles';
import type { Caller, SecretBox } from './workspaces';

// Client certificates and auth profiles per workspace, and the sessions profiles produce per tester
// (plan §4, §16.5). Everything credential-shaped is encrypted with API_STUDIO_SECRET.

const needBox = (box: SecretBox) => {
  if (!box) throw new AppError(503, 'secrets_unavailable', 'Certificates and saved sessions need API_STUDIO_SECRET to be set on the server.');
  return box;
};
const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

// ---------- client certificates ----------

type CertRow = { id: string; name: string; host: string; subject: string; expires_at: Date | null; bundle_enc: string; updated_at: Date };

function openBundle(box: SecretBox, enc: string): CertBundle {
  if (!box) return {};
  try {
    return JSON.parse(box.decrypt(enc)) as CertBundle;
  } catch {
    return {};
  }
}

function certView(r: CertRow, box: SecretBox): ClientCertView {
  const bundle = openBundle(box, r.bundle_enc);
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    subject: r.subject,
    expiresAt: r.expires_at?.toISOString() ?? null,
    hasClientCert: Boolean(bundle.cert),
    hasCa: Boolean(bundle.ca),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listCerts(trx: Tx, box: SecretBox, workspaceId: string): Promise<ClientCertView[]> {
  const rows = await trx.selectFrom('apitest.client_cert').selectAll().where('workspace_id', '=', workspaceId).orderBy('host').execute();
  return rows.map((r) => certView(r, box));
}

/** Stores a certificate after checking it parses and its key belongs to it. The key is never shown again. */
export async function createCert(trx: Tx, box: SecretBox, caller: Caller, workspaceId: string, body: ClientCertBody): Promise<ClientCertView> {
  const b = needBox(box);
  let info;
  try {
    info = inspectBundle(body);
  } catch (err) {
    if (err instanceof ProfileError) throw badRequest(err.message);
    throw err;
  }
  const bundle: CertBundle = { cert: body.cert, key: body.key, passphrase: body.passphrase || undefined, ca: body.ca };
  try {
    const row = await trx
      .insertInto('apitest.client_cert')
      .values({
        org_id: caller.orgId,
        workspace_id: workspaceId,
        name: body.name,
        host: body.host,
        bundle_enc: b.encrypt(JSON.stringify(bundle)),
        subject: info.subject,
        expires_at: info.expiresAt,
        created_by: caller.userId,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return certView(row, box);
  } catch (err) {
    if (isUnique(err)) throw conflict(`There is already a certificate for ${body.host}. Delete it first to replace it.`);
    throw err;
  }
}

export async function deleteCert(trx: Tx, workspaceId: string, id: string): Promise<void> {
  const done = await trx.deleteFrom('apitest.client_cert').where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!done.numDeletedRows) throw notFound('Certificate');
}

/** Decrypted bundles for a send. One that cannot be decrypted (key rotated) is skipped. */
export async function loadCerts(trx: Tx, box: SecretBox, workspaceId: string): Promise<(CertBundle & { host: string })[]> {
  if (!box) return [];
  const rows = await trx.selectFrom('apitest.client_cert').select(['host', 'bundle_enc']).where('workspace_id', '=', workspaceId).execute();
  return rows.flatMap((r) => {
    try {
      return [{ host: r.host, ...(JSON.parse(box.decrypt(r.bundle_enc)) as CertBundle) }];
    } catch {
      return [];
    }
  });
}

// ---------- auth profiles ----------

type ProfileRow = { id: string; name: string; login_node_id: string | null; config: Record<string, unknown>; updated_at: Date };

async function profileView(trx: Tx, r: ProfileRow): Promise<AuthProfileView> {
  const login = r.login_node_id ? await trx.selectFrom('apitest.node').select('name').where('id', '=', r.login_node_id).executeTakeFirst() : null;
  return { id: r.id, name: r.name, loginNodeId: r.login_node_id, loginName: login?.name ?? null, config: AuthProfileConfig.parse(r.config), updatedAt: r.updated_at.toISOString() };
}

export async function listProfiles(trx: Tx, workspaceId: string): Promise<AuthProfileView[]> {
  const rows = await trx.selectFrom('apitest.auth_profile').select(['id', 'name', 'login_node_id', 'config', 'updated_at']).where('workspace_id', '=', workspaceId).orderBy('name').execute();
  return Promise.all(rows.map((r) => profileView(trx, r)));
}

/** The login must be a request in this workspace that does not itself log in with a profile. */
async function checkLogin(trx: Tx, workspaceId: string, nodeId: string): Promise<void> {
  const n = await trx.selectFrom('apitest.node').select(['kind', 'config']).where('id', '=', nodeId).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!n || n.kind !== 'request') throw badRequest('Pick the login request from this workspace.');
  if (ApiRequestDef.parse(n.config).auth.type === 'profile') throw badRequest('The login request cannot itself use an auth profile.');
}

export async function saveProfile(trx: Tx, caller: Caller, workspaceId: string, body: AuthProfileBody, id?: string): Promise<AuthProfileView> {
  await checkLogin(trx, workspaceId, body.loginNodeId);
  const values = { name: body.name, login_node_id: body.loginNodeId, config: JSON.stringify(body.config), updated_by: caller.userId, updated_at: new Date() };
  try {
    const row = id
      ? await trx.updateTable('apitest.auth_profile').set(values).where('id', '=', id).where('workspace_id', '=', workspaceId).returning(['id', 'name', 'login_node_id', 'config', 'updated_at']).executeTakeFirst()
      : await trx.insertInto('apitest.auth_profile').values({ ...values, org_id: caller.orgId, workspace_id: workspaceId }).returning(['id', 'name', 'login_node_id', 'config', 'updated_at']).executeTakeFirst();
    if (!row) throw notFound('Auth profile');
    // A changed profile may extract or apply differently, so sessions made under the old one are dropped.
    if (id) await trx.deleteFrom('apitest.auth_session').where('profile_id', '=', id).execute();
    return profileView(trx, row);
  } catch (err) {
    if (isUnique(err)) throw conflict(`An auth profile called "${body.name}" already exists.`);
    throw err;
  }
}

export async function deleteProfile(trx: Tx, workspaceId: string, id: string): Promise<void> {
  const done = await trx.deleteFrom('apitest.auth_profile').where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!done.numDeletedRows) throw notFound('Auth profile');
}

export interface LoadedProfile {
  id: string;
  name: string;
  loginNodeId: string;
  config: AuthProfileConfig;
  /** The tester's stored credential, when there is one; `expired` when it has run out. */
  session: { token: string; expired: boolean } | null;
}

export async function loadProfile(trx: Tx, box: SecretBox, userId: string, workspaceId: string, profileId: string, environmentId: string | null): Promise<LoadedProfile> {
  const p = await trx.selectFrom('apitest.auth_profile').select(['id', 'name', 'login_node_id', 'config']).where('id', '=', profileId).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (!p) throw badRequest('This request uses an auth profile that no longer exists. Pick another in its Auth tab.');
  if (!p.login_node_id) throw badRequest(`The login request of the auth profile "${p.name}" was deleted. Pick a new one in the profile.`);
  const s = box
    ? await trx
        .selectFrom('apitest.auth_session')
        .select(['token_enc', 'expires_at'])
        .where('user_id', '=', userId)
        .where('profile_id', '=', p.id)
        .where((eb) => (environmentId ? eb('environment_id', '=', environmentId) : eb('environment_id', 'is', null)))
        .executeTakeFirst()
    : undefined;
  let session: LoadedProfile['session'] = null;
  if (s && box) {
    try {
      session = { token: box.decrypt(s.token_enc), expired: s.expires_at !== null && s.expires_at.getTime() <= Date.now() };
    } catch {
      session = null;
    }
  }
  return { id: p.id, name: p.name, loginNodeId: p.login_node_id, config: AuthProfileConfig.parse(p.config), session };
}

/** Keeps the credential a login produced, replacing the tester's previous one for this profile. */
export async function saveSession(
  trx: Tx,
  box: SecretBox,
  caller: Caller,
  profileId: string,
  environmentId: string | null,
  token: string,
  expiresAt: number | null,
): Promise<void> {
  if (!box) return;
  await trx
    .deleteFrom('apitest.auth_session')
    .where('user_id', '=', caller.userId)
    .where('profile_id', '=', profileId)
    .where((eb) => (environmentId ? eb('environment_id', '=', environmentId) : eb('environment_id', 'is', null)))
    .execute();
  await trx
    .insertInto('apitest.auth_session')
    .values({ org_id: caller.orgId, user_id: caller.userId, profile_id: profileId, environment_id: environmentId, token_enc: box.encrypt(token), expires_at: expiresAt === null ? null : new Date(expiresAt) })
    .execute();
}

/** Forgets the tester's sessions for this workspace, so the next request logs in again. */
export async function clearSessions(trx: Tx, userId: string, workspaceId: string): Promise<void> {
  await trx
    .deleteFrom('apitest.auth_session')
    .where('user_id', '=', userId)
    .where('profile_id', 'in', trx.selectFrom('apitest.auth_profile').select('id').where('workspace_id', '=', workspaceId))
    .execute();
}
