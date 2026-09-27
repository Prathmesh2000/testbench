import type {
  AiAnswer,
  AiConfigView,
  CaseDetail,
  CaseFlag,
  DocumentDetail,
  DraftCase,
  Health,
  Readiness,
  Traceability,
  VersionResult,
} from '@tb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, startHarness, type Harness } from './harness';

// M4 against the local stack: PRD impact on linked cases, readiness sign-off and the AI layer in mock mode.

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 30_000);
afterAll(async () => {
  await h?.close();
});

const V1 = `# Autopay\n\nREQ-AP-04 A customer can pause an active mandate for up to 30 days.\n\nREQ-AP-10 Revoking a mandate requires OTP confirmation.\n\nREQ-AP-11 Mandates show the next debit date.`;
const V2 = `# Autopay\n\nREQ-AP-04 A customer can pause an active mandate for up to 90 days.\n\nREQ-AP-11 Mandates show the next debit date.\n\nREQ-AP-12 Merchants receive a webhook within 5 seconds.`;

async function newCase(title: string): Promise<CaseDetail> {
  const res = await call<CaseDetail>(h, h.users.lead, 'POST', `/projects/${h.projectId}/cases`, {
    moduleId: h.moduleIds.collect,
    title,
    status: 'ready',
    steps: [{ action: 'Pause the mandate', expected: 'Paused' }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('PRD versions and change impact', () => {
  let docId: string;
  let pause: CaseDetail;
  let revoke: CaseDetail;
  let untouched: CaseDetail;

  beforeAll(async () => {
    const created = await call<{ id: string; requirements: number }>(
      h,
      h.users.tester,
      'POST',
      `/projects/${h.projectId}/documents`,
      {
        title: 'Autopay',
        body: V1,
      },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.requirements).toBe(3);
    docId = created.body.id;
    [pause, revoke, untouched] = await Promise.all([
      newCase('Verify pause'),
      newCase('Verify revoke OTP'),
      newCase('Verify next date'),
    ]);
    const doc = await call<DocumentDetail>(
      h,
      h.users.tester,
      'GET',
      `/projects/${h.projectId}/documents/${docId}`,
    );
    const req = (ref: string) => doc.body.requirements.find((r) => r.ref === ref)!.id;
    for (const [ref, c] of [
      ['REQ-AP-04', pause],
      ['REQ-AP-10', revoke],
      ['REQ-AP-11', untouched],
    ] as const) {
      const link = await call(
        h,
        h.users.tester,
        'POST',
        `/projects/${h.projectId}/requirements/${req(ref)}/cases`,
        { caseKeys: [c.key] },
      );
      expect(link.status).toBe(200);
    }
  });

  it('flags cases of changed and removed requirements, and only those', async () => {
    const v = await call<VersionResult>(
      h,
      h.users.tester,
      'POST',
      `/projects/${h.projectId}/documents/${docId}/versions`,
      { body: V2 },
    );
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body).toEqual({ version: 2, changed: 1, added: 1, removed: 1, flagged: 2 });

    const status = async (key: string) =>
      (await call<CaseDetail>(h, h.users.tester, 'GET', `/projects/${h.projectId}/cases/${key}`)).body.status;
    expect(await status(pause.key)).toBe('needs_review');
    expect(await status(revoke.key)).toBe('needs_review');
    expect(await status(untouched.key)).toBe('ready');

    const flags = await call<CaseFlag[]>(
      h,
      h.users.tester,
      'GET',
      `/projects/${h.projectId}/cases/${revoke.key}/flags`,
    );
    expect(flags.body).toMatchObject([{ kind: 'possibly_obsolete', requirementRef: 'REQ-AP-10' }]);

    const doc = await call<DocumentDetail>(
      h,
      h.users.tester,
      'GET',
      `/projects/${h.projectId}/documents/${docId}`,
    );
    expect(doc.body.impact).toEqual({ changed: 1, added: 1, removed: 1, needsReview: 2, uncoveredAdded: 1 });
  });

  it('clears the flag when the owner confirms the case', async () => {
    const res = await call(
      h,
      h.users.tester,
      'POST',
      `/projects/${h.projectId}/cases/${pause.key}/confirm-review`,
    );
    expect(res.status).toBe(204);
    const after = await call<CaseDetail>(
      h,
      h.users.tester,
      'GET',
      `/projects/${h.projectId}/cases/${pause.key}`,
    );
    expect(after.body.status).toBe('ready');
    const trace = await call<Traceability>(
      h,
      h.users.viewer,
      'GET',
      `/projects/${h.projectId}/documents/${docId}/traceability`,
    );
    expect(trace.body.rows.find((r) => r.ref === 'REQ-AP-04')).toMatchObject({
      coverage: 'full',
      caseCount: 1,
    });
  });

  it('keeps documents inside the organisation and read-only for viewers', async () => {
    const other = await call(h, h.users.outsider, 'GET', `/projects/${h.projectId}/documents/${docId}`);
    expect(other.status).toBe(404);
    const write = await call(h, h.users.viewer, 'POST', `/projects/${h.projectId}/documents`, {
      title: 'x',
      body: V1,
    });
    expect(write.status).toBe(403);
  });

  it('drafts cases for a requirement through the AI layer and meters the call', async () => {
    const doc = await call<DocumentDetail>(
      h,
      h.users.tester,
      'GET',
      `/projects/${h.projectId}/documents/${docId}`,
    );
    const added = doc.body.requirements.find((r) => r.ref === 'REQ-AP-12')!;
    const drafts = await call<AiAnswer<{ cases: DraftCase[] }>>(
      h,
      h.users.tester,
      'POST',
      `/projects/${h.projectId}/requirements/${added.id}/draft-cases`,
      { count: 2 },
    );
    expect(drafts.status, JSON.stringify(drafts.body)).toBe(200);
    expect(drafts.body.provider).toBe('mock');
    expect(drafts.body.result.cases).toHaveLength(2);
    const usage = await h.owner
      .selectFrom('ai.usage')
      .select(['task', 'ok'])
      .where('org_id', '=', h.orgId)
      .execute();
    expect(usage).toContainEqual({ task: 'generate_cases', ok: true });
  });
});

describe('AI configuration', () => {
  it('lets only Org Admins change it, and refuses calls when AI is off', async () => {
    const lead = await call(h, h.users.lead, 'PUT', `/projects/${h.projectId}/ai/config`, {
      policy: 'off',
      monthlyBudget: 1000,
    });
    expect(lead.status).toBe(403);
    const view = await call<AiConfigView>(h, h.users.tester, 'GET', `/projects/${h.projectId}/ai/config`);
    expect(view.body).toMatchObject({ mode: 'mock', policy: 'any' });

    const c = await newCase('Verify edge cases refused');
    await h.owner.insertInto('ai.config').values({ org_id: h.orgId, policy: 'off' }).execute();
    const off = await call<{ error: { code: string } }>(
      h,
      h.users.tester,
      'POST',
      `/projects/${h.projectId}/ai/edge-cases`,
      { caseKey: c.key },
    );
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('ai_disabled');
  });
});

describe('release readiness', () => {
  it('evaluates criteria for a build and refuses Go while any fails', async () => {
    const run = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/runs`, {
      name: 'Readiness smoke',
      type: 'smoke',
      environment: 'Staging-IN',
      build: 'r-4.18',
      configs: ['Chrome'],
      filter: { keys: [(await newCase('Verify readiness smoke')).key] },
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);

    const r = await call<Readiness>(
      h,
      h.users.viewer,
      'GET',
      `/projects/${h.projectId}/reports/readiness?build=r-4.18`,
    );
    expect(r.status).toBe(200);
    expect(r.body.criteria.find((c) => c.id === 'smoke')).toMatchObject({ status: 'failing', actual: '0%' });
    expect(r.body.ready).toBe(false);

    const go = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/reports/readiness/signoff`, {
      build: 'r-4.18',
      decision: 'go',
    });
    expect(go.status).toBe(409);
    const viewerNoGo = await call(
      h,
      h.users.viewer,
      'POST',
      `/projects/${h.projectId}/reports/readiness/signoff`,
      { build: 'r-4.18', decision: 'no_go' },
    );
    expect(viewerNoGo.status).toBe(403);
    const noGo = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/reports/readiness/signoff`, {
      build: 'r-4.18',
      decision: 'no_go',
      note: 'Smoke not run',
    });
    expect(noGo.status).toBe(201);
    const after = await call<Readiness>(
      h,
      h.users.viewer,
      'GET',
      `/projects/${h.projectId}/reports/readiness?build=r-4.18`,
    );
    expect(after.body.signoffs).toMatchObject([{ decision: 'no_go', note: 'Smoke not run' }]);
  });

  it('reports test health', async () => {
    const res = await call<Health>(h, h.users.viewer, 'GET', `/projects/${h.projectId}/reports/health`);
    expect(res.status).toBe(200);
    expect(res.body.counts.needs_review).toBeGreaterThanOrEqual(1);
  });
});
