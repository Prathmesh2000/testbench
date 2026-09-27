import type { AuditPage, RoleView, TokenCreated } from '@tb/contracts';
import { auditConsumer } from '@tb/audit';
import { relayBatch } from '@tb/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, startHarness, type Harness, type TestUser } from './harness';

// M5 against the local stack: custom roles and their guardrails, personal access tokens, and the audit log.

let h: Harness;
const quiet = { error: () => {} };

beforeAll(async () => {
  h = await startHarness();
}, 30_000);
afterAll(async () => {
  await h?.close();
});

const asToken = (token: string): TestUser => ({ id: '', email: '', token });

describe('custom roles', () => {
  let ref: string;

  it('lets an Org Admin copy a built-in role, and hides roles from those who cannot manage them', async () => {
    const created = await call<{ ref: string }>(h, h.users.admin, 'POST', '/admin/roles', {
      name: 'Release Manager',
      basedOn: 'viewer',
      permissions: ['case.read', 'run.read', 'run.signoff'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ref = created.body.ref;
    expect((await call(h, h.users.tester, 'GET', '/admin/roles')).status).toBe(403);
    const roles = await call<RoleView[]>(h, h.users.admin, 'GET', '/admin/roles');
    expect(roles.body.find((r) => r.ref === ref)).toMatchObject({
      builtIn: false,
      permissions: ['case.read', 'run.read', 'run.signoff'],
    });
  });

  it('applies a custom role to the person who holds it, including after an edit', async () => {
    const set = await call(h, h.users.admin, 'PUT', `/admin/members/${h.users.viewer.id}`, {
      role: ref,
      projectId: null,
    });
    expect(set.status).toBe(204);
    const signoff = () =>
      call(h, h.users.viewer, 'POST', `/projects/${h.projectId}/reports/readiness/signoff`, {
        build: 'none-yet',
        decision: 'no_go',
      });
    expect((await signoff()).status).toBe(201);

    const edit = await call(h, h.users.admin, 'PUT', `/admin/roles/${ref.slice('custom:'.length)}`, {
      name: 'Release Manager',
      basedOn: 'viewer',
      permissions: ['case.read', 'run.read'],
    });
    expect(edit.status).toBe(204);
    expect((await signoff()).status).toBe(403);
  });

  it('refuses to delete a role people still hold', async () => {
    const res = await call(h, h.users.admin, 'DELETE', `/admin/roles/${ref.slice('custom:'.length)}`);
    expect(res.status).toBe(409);
  });
});

describe('guardrails', () => {
  it('keeps the last Org Admin', async () => {
    const res = await call(h, h.users.admin, 'PUT', `/admin/members/${h.users.admin.id}`, {
      role: 'viewer',
      projectId: null,
    });
    expect(res.status).toBe(409);
  });

  it('stops a member manager from granting more than they hold', async () => {
    // A project admin may manage members but holds neither role.manage nor ai.configure. The lead has
    // made no request yet, so no identity with the old role is cached.
    await h.owner
      .updateTable('iam.membership')
      .set({ role: 'project_admin' })
      .where('user_id', '=', h.users.lead.id)
      .execute();
    const res = await call<{ error: { code: string } }>(
      h,
      h.users.lead,
      'PUT',
      `/admin/members/${h.users.tester.id}`,
      {
        role: 'org_admin',
        projectId: null,
      },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('grant_exceeds_own');
    await h.owner
      .updateTable('iam.membership')
      .set({ role: 'test_lead' })
      .where('user_id', '=', h.users.lead.id)
      .execute();
  });
});

describe('personal access tokens', () => {
  let read: TokenCreated;

  it('works as a bearer token and is shown only once', async () => {
    const res = await call<TokenCreated>(h, h.users.tester, 'POST', '/me/tokens', {
      name: 'CI read',
      scopes: ['read'],
      days: 1,
    });
    expect(res.status).toBe(201);
    read = res.body;
    expect(read.token).toMatch(/^tbp_/);
    const me = await call(h, asToken(read.token), 'GET', '/me');
    expect(me.status).toBe(200);
    const list = await call<{ token?: string }[]>(h, h.users.tester, 'GET', '/me/tokens');
    expect(list.body.every((t) => t.token === undefined)).toBe(true);
  });

  it('enforces read-only scope but still allows search', async () => {
    const write = await call(h, asToken(read.token), 'POST', `/projects/${h.projectId}/cases`, {
      moduleId: h.moduleIds.collect,
      title: 'Nope',
    });
    expect(write.status).toBe(403);
    const search = await call(h, asToken(read.token), 'POST', `/projects/${h.projectId}/search`, {
      tql: 'priority = P0',
    });
    expect(search.status).toBe(200);
    const mint = await call(h, asToken(read.token), 'POST', '/me/tokens', {
      name: 'x',
      scopes: ['read'],
      days: 1,
    });
    expect(mint.status).toBe(403);
  });

  it('stops working once revoked', async () => {
    const revoke = await call(h, h.users.tester, 'DELETE', `/me/tokens/${read.id}`);
    expect(revoke.status).toBe(204);
    expect((await call(h, asToken(read.token), 'GET', '/me')).status).toBe(401);
  });
});

describe('audit log', () => {
  it('records changes with who made them and from where', async () => {
    const token = await call<TokenCreated>(h, h.users.lead, 'POST', '/me/tokens', {
      name: 'agent',
      scopes: ['read', 'write'],
      days: 1,
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${h.projectId}/cases`,
      headers: { authorization: `Bearer ${token.body.token}`, 'x-tb-client': 'mcp' },
      payload: { moduleId: h.moduleIds.collect, title: 'Verify case created by an agent' },
    });
    expect(res.statusCode).toBe(201);
    while ((await relayBatch(h.appDb, [auditConsumer], quiet)) > 0) {
      /* drain */
    }
    const page = await call<AuditPage>(h, h.users.lead, 'GET', '/admin/audit?q=Case%20created');
    expect(page.body.items[0]).toMatchObject({ action: 'Case created', source: 'mcp' });
    expect((await call(h, h.users.tester, 'GET', '/admin/audit')).status).toBe(403);
    const other = await call<AuditPage>(h, h.users.outsider, 'GET', '/admin/audit');
    expect(other.body.items.some((i) => i.entity === JSON.parse(res.body).key)).toBe(false);
  });
});
