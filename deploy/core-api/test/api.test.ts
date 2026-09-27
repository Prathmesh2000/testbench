import type {
  CaseDetail,
  CaseRow,
  JobStatus,
  Page,
  RecordResultResponse,
  RunItemRow,
  RunSummary,
} from '@tb/contracts';
import { withTenant } from '@tb/platform';
import { runChunk } from '@tb/repository';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 30_000);
afterAll(async () => {
  await h?.close();
});

const steps = [
  { action: 'Open the payment page', expected: 'Page loads', data: '' },
  { action: 'Pay ₹499 with UPI collect', expected: 'Status is PENDING', data: 'vpa: qa@okaxis' },
];

async function createCase(
  title: string,
  moduleId = h.moduleIds.collect,
  extra: object = {},
): Promise<CaseDetail> {
  const res = await call<CaseDetail>(h, h.users.lead, 'POST', `/projects/${h.projectId}/cases`, {
    moduleId,
    title,
    steps,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('authentication and identity', () => {
  it('rejects requests without a token', async () => {
    expect((await call(h, null, 'GET', '/me')).status).toBe(401);
  });

  it('rejects a token it cannot verify', async () => {
    const res = await call(h, { ...h.users.lead, token: 'not.a.jwt' }, 'GET', '/me');
    expect(res.status).toBe(401);
  });

  it('returns the organisation and per-project permissions', async () => {
    const { status, body } = await call(h, h.users.lead, 'GET', '/me');
    expect(status).toBe(200);
    expect(body.org.id).toBe(h.orgId);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].permissions).toEqual(expect.arrayContaining(['case.write', 'run.create']));
  });
});

describe('tenant isolation', () => {
  it('hides another organisation’s project behind a 404', async () => {
    expect((await call(h, h.users.lead, 'GET', `/projects/${h.otherProjectId}/modules`)).status).toBe(404);
  });

  it('keeps rows invisible at the database level, not just in the API', async () => {
    const rows = await withTenant(h.appDb, { orgId: h.orgId, userId: h.users.lead.id }, (trx) =>
      trx.selectFrom('repo.module').select('id').where('project_id', '=', h.otherProjectId).execute(),
    );
    expect(rows).toEqual([]);
  });

  it('sees nothing at all without a tenant context', async () => {
    const rows = await h.appDb.selectFrom('repo.project').select('id').execute();
    expect(rows).toEqual([]);
  });
});

describe('permissions', () => {
  it('lets a viewer read but not write', async () => {
    expect((await call(h, h.users.viewer, 'GET', `/projects/${h.projectId}/modules`)).status).toBe(200);
    const res = await call(h, h.users.viewer, 'POST', `/projects/${h.projectId}/cases`, {
      moduleId: h.moduleIds.auth,
      title: 'Viewer case',
    });
    expect(res.status).toBe(403);
  });

  it('validates input and says which field is wrong', async () => {
    const res = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/cases`, {
      moduleId: h.moduleIds.auth,
      title: 'x',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toContain('title');
  });
});

describe('test cases', () => {
  it('creates, versions content edits, and refuses stale edits', async () => {
    const created = await createCase('Verify collect request expiry after 5 minutes');
    expect(created.key).toMatch(/^TC-\d+$/);
    expect(created.currentVersion).toBe(1);

    const base = `/projects/${h.projectId}/cases/${created.key}`;
    const metadataOnly = await call<CaseDetail>(h, h.users.lead, 'PATCH', base, {
      priority: 'P0',
      labels: ['smoke'],
    });
    expect(metadataOnly.body.currentVersion).toBe(1);

    const edited = await call<CaseDetail>(h, h.users.lead, 'PATCH', base, {
      steps: [...steps, { action: 'Wait 5 minutes', expected: 'Status is EXPIRED', data: '' }],
      baseVersion: 1,
      note: 'Add expiry step',
    });
    expect(edited.body.currentVersion).toBe(2);

    const stale = await call(h, h.users.lead, 'PATCH', base, {
      title: 'Stale edit of expiry',
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);

    const diff = await call(h, h.users.lead, 'GET', `${base}/versions/2`);
    expect(diff.body.diff.map((d: { kind: string }) => d.kind)).toEqual(['same', 'same', 'added']);
  });

  it('refuses to modify a stored version, even for the app role', async () => {
    const c = await createCase('Verify immutable versions');
    await expect(
      withTenant(h.appDb, { orgId: h.orgId, userId: h.users.lead.id }, (trx) =>
        sql`UPDATE repo.case_version SET title = 'rewritten' WHERE case_id = ${c.id}`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('pages with a keyset cursor without gaps or repeats', async () => {
    for (let i = 0; i < 7; i++)
      await createCase(`Verify paging case ${String(i).padStart(2, '0')}`, h.moduleIds.auth);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({
        moduleId: h.moduleIds.auth,
        sort: 'title',
        dir: 'desc',
        limit: '3',
        ...(cursor ? { cursor } : {}),
      });
      const page: { body: Page<CaseRow> } = await call(
        h,
        h.users.lead,
        'GET',
        `/projects/${h.projectId}/cases?${qs}`,
      );
      seen.push(...page.body.items.map((c) => c.title));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('filters by module subtree and rolls counts up the tree', async () => {
    const tree = await call(h, h.users.lead, 'GET', `/projects/${h.projectId}/modules`);
    const upi = tree.body.find((n: { id: string }) => n.id === h.moduleIds.upi);
    const collect = tree.body.find((n: { id: string }) => n.id === h.moduleIds.collect);
    expect(upi.total).toBe(collect.total);
    const list = await call<Page<CaseRow>>(
      h,
      h.users.lead,
      'GET',
      `/projects/${h.projectId}/cases?moduleId=${h.moduleIds.upi}&limit=500`,
    );
    expect(list.body.items.every((c) => c.modulePath === 'UPI / Collect')).toBe(true);
  });

  it('refuses a dependency loop', async () => {
    const a = await createCase('Verify loop case A', h.moduleIds.auth);
    const b = await createCase('Verify loop case B', h.moduleIds.auth);
    expect(
      (
        await call(h, h.users.lead, 'PUT', `/projects/${h.projectId}/cases/${b.key}/dependencies`, {
          dependsOn: [a.key],
        })
      ).status,
    ).toBe(200);
    const loop = await call(h, h.users.lead, 'PUT', `/projects/${h.projectId}/cases/${a.key}/dependencies`, {
      dependsOn: [b.key],
    });
    expect(loop.status).toBe(409);
    expect(loop.body.error.message).toContain(`${a.key} → ${b.key} → ${a.key}`);
  });

  it('applies a bulk edit by filter in resumable chunks', async () => {
    const res = await call<JobStatus>(h, h.users.lead, 'POST', `/projects/${h.projectId}/cases/bulk`, {
      filter: { moduleId: h.moduleIds.auth },
      patch: { addLabels: ['release-4.18'], status: 'ready' },
    });
    expect(res.status).toBe(202);
    expect(res.body.total).toBeGreaterThanOrEqual(7);
    // Run the job inline instead of waiting on the background worker.
    const done = await withTenant(h.appDb, { orgId: h.orgId, userId: h.users.lead.id }, (trx) =>
      runChunk(trx, res.body.id),
    );
    expect(done).toBe(true);
    const job = await call<JobStatus>(h, h.users.lead, 'GET', `/projects/${h.projectId}/jobs/${res.body.id}`);
    expect(job.body).toMatchObject({ status: 'done', processed: res.body.total });
    const list = await call<Page<CaseRow>>(
      h,
      h.users.lead,
      'GET',
      `/projects/${h.projectId}/cases?moduleId=${h.moduleIds.auth}&labels=release-4.18&limit=500`,
    );
    expect(list.body.items).toHaveLength(res.body.total);
    expect(list.body.items.every((c) => c.status === 'ready')).toBe(true);
  });
});

describe('runs and execution', () => {
  let run: RunSummary;
  let items: RunItemRow[];
  let login: CaseDetail;
  let checkout: CaseDetail;

  beforeAll(async () => {
    login = await createCase('Verify login with OTP', h.moduleIds.auth);
    checkout = await createCase('Verify checkout with UPI', h.moduleIds.collect);
    await call(h, h.users.lead, 'PUT', `/projects/${h.projectId}/cases/${checkout.key}/dependencies`, {
      dependsOn: [login.key],
    });
    const res = await call<RunSummary>(h, h.users.lead, 'POST', `/projects/${h.projectId}/runs`, {
      name: 'CI smoke',
      type: 'smoke',
      environment: 'Staging-IN',
      build: '8812',
      configs: ['Chrome 128 · Win 11', 'Safari 17 · macOS 14'],
      assigneeIds: [h.users.tester.id],
      filter: { keys: [checkout.key, login.key] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    run = res.body;
    items = (
      await call<RunItemRow[]>(h, h.users.tester, 'GET', `/projects/${h.projectId}/runs/${run.id}/items`)
    ).body;
  });

  const url = (itemId: string) => `/projects/${h.projectId}/runs/${run.id}/items/${itemId}`;

  it('creates one item per case per configuration, prerequisites first', () => {
    expect(run.counts).toMatchObject({ total: 4, untested: 4 });
    expect(items.map((i) => i.caseKey)).toEqual([login.key, login.key, checkout.key, checkout.key]);
    expect(items.every((i) => i.assignee?.id === h.users.tester.id)).toBe(true);
  });

  it('does not let a viewer record results', async () => {
    const res = await call(h, h.users.viewer, 'POST', `${url(items[0]!.id)}/results`, {
      stepIndex: 0,
      status: 'passed',
    });
    expect(res.status).toBe(403);
  });

  it('requires an actual result when a step fails', async () => {
    const res = await call(h, h.users.tester, 'POST', `${url(items[0]!.id)}/results`, {
      stepIndex: 0,
      status: 'failed',
    });
    expect(res.status).toBe(400);
  });

  it('auto-blocks dependents in the same configuration and releases them when fixed', async () => {
    const loginChrome = items[0]!;
    const checkoutChrome = items.find((i) => i.caseKey === checkout.key && i.config === loginChrome.config)!;
    const checkoutSafari = items.find((i) => i.caseKey === checkout.key && i.config !== loginChrome.config)!;

    const failed = await call<RecordResultResponse>(
      h,
      h.users.tester,
      'POST',
      `${url(loginChrome.id)}/results`,
      {
        stepIndex: 1,
        status: 'failed',
        actual: 'Stayed on the OTP screen',
        elapsedS: 42,
      },
    );
    expect(failed.status).toBe(200);
    expect(failed.body.item.status).toBe('failed');
    expect(failed.body.affected).toEqual([
      { id: checkoutChrome.id, status: 'blocked', blockedReason: `Prerequisite ${login.key} failed` },
    ]);
    expect(failed.body.counts).toMatchObject({ failed: 1, blocked: 1, untested: 2 });

    const safari = await call(h, h.users.tester, 'GET', url(checkoutSafari.id));
    expect(safari.body.status).toBe('untested');

    await call(h, h.users.tester, 'POST', `${url(loginChrome.id)}/results`, {
      stepIndex: 1,
      status: 'passed',
    });
    const fixed = await call<RecordResultResponse>(
      h,
      h.users.tester,
      'POST',
      `${url(loginChrome.id)}/results`,
      { stepIndex: 0, status: 'passed' },
    );
    expect(fixed.body.item.status).toBe('passed');
    expect(fixed.body.counts).toMatchObject({ passed: 1, failed: 0, blocked: 0, untested: 3 });
    const released = await call(h, h.users.tester, 'GET', url(checkoutChrome.id));
    expect(released.body).toMatchObject({ status: 'untested', blockedReason: null });
  });

  it('hands out a presigned upload URL that S3 accepts', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const res = await call(h, h.users.tester, 'POST', `${url(items[1]!.id)}/evidence`, {
      stepIndex: 0,
      fileName: 'otp screen.png',
      contentType: 'image/png',
      sizeBytes: png.length,
    });
    expect(res.status).toBe(201);
    const put = await fetch(res.body.uploadUrl, {
      method: 'PUT',
      body: png,
      headers: { 'content-type': 'image/png' },
    });
    expect(put.status).toBe(200);
    const detail = await call(h, h.users.tester, 'GET', url(items[1]!.id));
    expect(detail.body.evidence).toHaveLength(1);
  });

  it('shows the tester their queue on Home', async () => {
    const home = await call(h, h.users.tester, 'GET', `/projects/${h.projectId}/home`);
    expect(home.status).toBe(200);
    expect(home.body.assigned).toBe(3);
    expect(home.body.executedToday).toBe(1);
    expect(home.body.activeRuns.map((r: RunSummary) => r.id)).toContain(run.id);
  });
});
