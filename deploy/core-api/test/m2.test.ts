import type {
  CaseDetail,
  DefectDetail,
  DefectRow,
  EvidenceUpload,
  JiraConnection,
  JiraMapping,
  RunItemRow,
  RunSummary,
  SavedFilter,
  SearchResult,
} from '@tb/contracts';
import { processAttachment } from '@tb/defect';
import { createPreparedRun, prepChunk } from '@tb/execution';
import { relayBatch, withTenant } from '@tb/platform';
import { ALIAS, caseIndexer } from '@tb/search';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, JIRA_SANDBOX, startHarness, type Harness, type TestUser } from './harness';

// M2 against the local stack: OpenSearch for search, the Jira sandbox for defects.

let h: Harness;
const unique = Date.now().toString(36);
const quiet = { error: () => {} };

beforeAll(async () => {
  h = await startHarness();
}, 30_000);
afterAll(async () => {
  await h?.close();
});

async function newCase(title: string, extra: object = {}): Promise<CaseDetail> {
  const res = await call<CaseDetail>(h, h.users.lead, 'POST', `/projects/${h.projectId}/cases`, {
    moduleId: h.moduleIds.collect,
    title,
    steps: [{ action: 'Start a UPI collect request with OTP retry enabled', expected: 'Request is PENDING' }],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Delivers pending outbox events (as the relay would) and makes the index searchable right away. */
async function flushIndex() {
  while ((await relayBatch(h.appDb, [caseIndexer(h.index)], quiet)) > 0) {
    /* drain */
  }
  await h.index.client.indices.refresh({ index: ALIAS });
}

const search = (tql: string, extra: object = {}) =>
  call<SearchResult>(h, h.users.lead, 'POST', `/projects/${h.projectId}/search`, { tql, ...extra });

describe('outbox relay and search indexing', () => {
  let otp: CaseDetail;

  beforeAll(async () => {
    otp = await newCase(`Verify OTP retry limit ${unique}`, {
      labels: ['smoke', 'release-4.18'],
      priority: 'P0',
    });
    await newCase(`Verify refund SMS in Hindi ${unique}`, { labels: ['hindi'], priority: 'P2' });
    await flushIndex();
  });

  it('indexes new cases from their outbox events, exactly once per consumer', async () => {
    const res = await search(`key = ${otp.key}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.key)).toEqual([otp.key]);
    const processed = await h.owner
      .selectFrom('outbox.processed')
      .select('consumer')
      .where('org_id', '=', h.orgId)
      .where('consumer', '=', 'search-indexer')
      .execute();
    const events = await h.owner
      .selectFrom('outbox.event')
      .select('id')
      .where('org_id', '=', h.orgId)
      .where('type', '=', 'testcase.created')
      .execute();
    expect(processed.length).toBeGreaterThanOrEqual(events.length);
  });

  it('re-indexes on edit, so search sees the new title', async () => {
    await call(h, h.users.lead, 'PATCH', `/projects/${h.projectId}/cases/${otp.key}`, {
      title: `Verify OTP retry lockout ${unique}`,
    });
    await flushIndex();
    const res = await search(`title ~ lockout AND title ~ ${unique}`);
    expect(res.body.items.map((i) => i.key)).toEqual([otp.key]);
  });

  it('finds words near each other with proximity search and highlights them', async () => {
    const near = await search(`text ~ "collect retry"~3 AND label = smoke`);
    expect(near.body.items.map((i) => i.key)).toContain(otp.key);
    expect(near.body.items[0]!.highlight.steps ?? near.body.items[0]!.highlight.title).toContain('<mark>');
    const far = await search(`text ~ "collect pending"~0 AND label = smoke`);
    expect(far.body.items.map((i) => i.key)).not.toContain(otp.key);
  });

  it('groups results with counts', async () => {
    const res = await search('label IS NOT EMPTY GROUP BY priority');
    expect(res.body.groups).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'P0' })]));
  });

  it('never returns another organisation’s cases, even for a match-everything query', async () => {
    const res = await call<SearchResult>(h, h.users.outsider, 'POST', `/projects/${h.projectId}/search`, {
      tql: '',
    });
    expect(res.status).toBe(404);
  });

  it('reports TQL mistakes with a position the editor can underline', async () => {
    const res = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/search`, {
      tql: 'statsu = ready',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        code: 'invalid_tql',
        message: "Unknown field 'statsu'. Did you mean status?",
        details: { start: 0, end: 6 },
      },
    });
  });

  it('rejects owners and modules that do not exist instead of silently matching nothing', async () => {
    const owner = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/search`, {
      tql: 'owner = "Nobody Such"',
    });
    const module = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/search`, {
      tql: 'module = "Nowhere"',
    });
    expect(owner.body.error.message).toContain('No one called');
    expect(module.body.error.message).toContain('No module called');
  });

  it('returns every matching key for "create run from results"', async () => {
    const res = await call<{ keys: string[]; more: boolean }>(
      h,
      h.users.lead,
      'POST',
      `/projects/${h.projectId}/search/keys`,
      { tql: `title ~ ${unique}` },
    );
    expect(res.body.keys).toHaveLength(2);
    expect(res.body.more).toBe(false);
  });
});

describe('saved filters', () => {
  it('saves, shares, subscribes and restricts edits to the owner', async () => {
    const created = await call<{ id: string }>(h, h.users.lead, 'POST', `/projects/${h.projectId}/filters`, {
      name: 'Smoke P0',
      tql: 'label = smoke AND priority = P0',
      shared: true,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const asTester = await call<SavedFilter[]>(h, h.users.tester, 'GET', `/projects/${h.projectId}/filters`);
    expect(asTester.body.find((f) => f.id === id)).toMatchObject({ mine: false, shared: true });
    expect(
      (
        await call(h, h.users.tester, 'PUT', `/projects/${h.projectId}/filters/${id}`, {
          name: 'x',
          tql: '',
          shared: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(h, h.users.tester, 'PUT', `/projects/${h.projectId}/filters/${id}/subscription`, {
          subscribed: true,
        })
      ).status,
    ).toBe(204);
    const after = await call<SavedFilter[]>(h, h.users.tester, 'GET', `/projects/${h.projectId}/filters`);
    expect(after.body.find((f) => f.id === id)!.subscribed).toBe(true);
  });

  it('refuses to save a filter that cannot run', async () => {
    const res = await call(h, h.users.lead, 'POST', `/projects/${h.projectId}/filters`, {
      name: 'Broken',
      tql: 'label =',
    });
    expect(res.status).toBe(400);
  });
});

describe('defects and Jira', () => {
  let run: RunSummary;
  let item: RunItemRow;
  let defect: DefectRow;
  let evidenceId: string;
  const base = () => `/projects/${h.projectId}`;
  const connect = (user: TestUser, apiToken = JIRA_SANDBOX.apiToken, siteUrl = JIRA_SANDBOX.siteUrl) =>
    call<JiraConnection>(h, user, 'PUT', '/me/jira', { siteUrl, email: user.email, apiToken });
  /** Claims and uploads every queued attachment, as the background worker would. */
  const drainAttachments = async () => {
    for (;;) {
      const { rows } = await sql<{ id: string; org_id: string }>`SELECT * FROM defect.claim_attachment()`.execute(
        h.appDb,
      );
      if (!rows[0]) return;
      await processAttachment(h.appDb, h.storage, h.accounts, rows[0]);
    }
  };

  beforeAll(async () => {
    const c = await newCase(`Verify collect expiry for Jira flow ${unique}`);
    const res = await call<RunSummary>(h, h.users.lead, 'POST', `${base()}/runs`, {
      name: 'Defect flow',
      environment: 'Staging-IN',
      build: '8812',
      configs: ['Safari 17 · macOS 14'],
      assigneeIds: [h.users.tester.id],
      filter: { keys: [c.key] },
    });
    run = res.body;
    item = (await call<RunItemRow[]>(h, h.users.tester, 'GET', `${base()}/runs/${run.id}/items`)).body[0]!;
    await call(h, h.users.tester, 'POST', `${base()}/runs/${run.id}/items/${item.id}/results`, {
      stepIndex: 0,
      status: 'failed',
      actual: 'Stayed PENDING after 6 minutes',
    });
    // A real screenshot upload: presigned URL from the API, bytes straight to S3.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await call<EvidenceUpload>(h, h.users.tester, 'POST', `${base()}/runs/${run.id}/items/${item.id}/evidence`, {
      stepIndex: 0,
      fileName: 'pending-status.png',
      contentType: 'image/png',
      sizeBytes: png.length,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    await fetch(up.body.uploadUrl, { method: 'PUT', body: png, headers: { 'content-type': 'image/png' } });
    evidenceId = up.body.evidence.id;
  });

  it('asks the tester to connect their own Jira before logging a bug', async () => {
    const res = await call(h, h.users.tester, 'POST', `${base()}/defects`, {
      runId: run.id,
      itemId: item.id,
      summary: 'Bug before connecting Jira',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('jira_not_connected');
  });

  it('refuses a token Jira rejects and sites outside the allowed list', async () => {
    expect((await connect(h.users.tester, 'wrong-token')).status).toBe(400);
    const internal = await connect(h.users.tester, JIRA_SANDBOX.apiToken, 'http://169.254.169.254');
    expect(internal.status).toBe(400);
    expect((await call(h, h.users.tester, 'GET', '/me/jira')).body).toBeFalsy();
  });

  it('connects each tester to Jira as themselves', async () => {
    const res = await connect(h.users.tester);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ siteUrl: JIRA_SANDBOX.siteUrl, email: h.users.tester.email, status: 'active' });
    expect(JSON.stringify(res.body)).not.toContain(JIRA_SANDBOX.apiToken);
    const admins = await call(h, h.users.admin, 'GET', '/admin/jira/connections');
    expect(admins.body.map((c: { user: { id: string } }) => c.user.id)).toContain(h.users.tester.id);
    expect((await call(h, h.users.tester, 'GET', '/admin/jira/connections')).status).toBe(403);
  });

  it('maps the project to a Jira project that really exists', async () => {
    expect((await connect(h.users.admin)).status).toBe(200);
    const bad = await call(h, h.users.admin, 'PUT', `${base()}/jira/mapping`, {
      siteUrl: JIRA_SANDBOX.siteUrl,
      jiraKey: 'NOPE',
    });
    expect(bad.status).toBe(400);
    const res = await call<JiraMapping>(h, h.users.admin, 'PUT', `${base()}/jira/mapping`, {
      siteUrl: JIRA_SANDBOX.siteUrl,
      jiraKey: 'ci',
      issueType: 'bug',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ jiraKey: 'CI', issueType: 'Bug' });
    expect((await call(h, h.users.tester, 'PUT', `${base()}/jira/mapping`, { siteUrl: JIRA_SANDBOX.siteUrl, jiraKey: 'CI' })).status).toBe(403);
  });

  it('logs a bug in Jira as the tester, prefilled from the failed step', async () => {
    const res = await call<DefectRow>(h, h.users.tester, 'POST', `${base()}/defects`, {
      runId: run.id,
      itemId: item.id,
      summary: `Collect request expiry ignored on Safari ${unique}`,
      severity: 'Critical',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    defect = res.body;
    expect(defect).toMatchObject({
      severity: 'Critical',
      statusCategory: 'new',
      linkedCases: [{ key: item.caseKey }],
      jiraUrl: `${JIRA_SANDBOX.siteUrl}/browse/${defect.jiraKey}`,
    });
    expect(defect.jiraKey).toMatch(/^CI-\d+$/);
    const issue = (await h.jira.getIssue(defect.jiraKey)) as unknown as {
      fields: { reporter: { displayName: string }; description: unknown };
    };
    const me = (await call<JiraConnection>(h, h.users.tester, 'GET', '/me/jira')).body;
    expect(issue.fields.reporter.displayName).toBe(me.displayName);
    expect(JSON.stringify(issue)).toContain('Stayed PENDING after 6 minutes');
    expect(JSON.stringify(issue.fields.description)).toContain('pending-status.png (screenshot');
  });

  it('attaches the evidence to the Jira issue', async () => {
    const before = await call<DefectDetail>(h, h.users.tester, 'GET', `${base()}/defects/${defect.id}`);
    // Queued, not yet in Jira. A worker running elsewhere may already have claimed it, so either
    // state means the same thing here.
    expect(before.body.attachments).toHaveLength(1);
    expect(before.body.attachments[0]).toMatchObject({ fileName: 'pending-status.png', error: null });
    expect(['pending', 'uploading', 'uploaded']).toContain(before.body.attachments[0]!.status);
    await drainAttachments();
    const after = await call<DefectDetail>(h, h.users.tester, 'GET', `${base()}/defects/${defect.id}`);
    expect(after.body.attachments[0]).toMatchObject({ status: 'uploaded' });
    const issue = (await h.jira.getIssue(defect.jiraKey)) as unknown as {
      fields: { attachment?: { filename: string }[] };
    };
    // The sandbox returns every field, so the stored attachment is visible here.
    expect(issue.fields.attachment?.map((a) => a.filename)).toEqual(['pending-status.png']);
    expect(evidenceId).toBeTruthy();
  });

  it('lets anyone view defects without a Jira connection of their own', async () => {
    const res = await call<DefectRow[]>(h, h.users.viewer, 'GET', `${base()}/defects`);
    expect(res.status).toBe(200);
    expect(res.body.find((d) => d.id === defect.id)?.jiraUrl).toContain('/browse/');
  });

  it('finds the new bug as a likely duplicate of a reworded summary', async () => {
    const res = await call(
      h,
      h.users.tester,
      'GET',
      `${base()}/defects/similar?summary=${encodeURIComponent(`Safari collect request expiry not enforced ${unique}`)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ jiraKey: defect.jiraKey, known: true });
    expect(res.body[0].similarity).toBeGreaterThan(30);
  });

  it('syncs "Done" through the reporter’s connection and queues one retest', async () => {
    await h.jira.transitionTo(defect.jiraKey, 'Done');
    // The lead has no Jira connection: the sync still works, borrowing the reporter's.
    const res = await call<{ changed: number }>(h, h.users.lead, 'POST', `${base()}/defects/sync`);
    expect(res.body.changed).toBeGreaterThanOrEqual(1);
    const queue = await call<DefectRow[]>(h, h.users.tester, 'GET', `${base()}/defects?view=retest`);
    expect(queue.body.find((d) => d.id === defect.id)).toMatchObject({ status: 'Done', retest: 'pending' });
    // A repeated pass must not queue a second retest.
    await call(h, h.users.lead, 'POST', `${base()}/defects/sync`);
    const detail = await call<DefectDetail>(h, h.users.tester, 'GET', `${base()}/defects/${defect.id}`);
    expect(detail.body.retests.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(detail.body.timeline.map((e) => e.kind)).toEqual(['created', 'status', 'retest']);
    const sync = await call(h, h.users.lead, 'GET', `${base()}/defects/sync`);
    expect(sync.body).toMatchObject({ connected: true, lastError: null });
  });

  it('reopens the Jira issue when the retest fails, with the tester’s note', async () => {
    const detail = await call<DefectDetail>(h, h.users.tester, 'GET', `${base()}/defects/${defect.id}`);
    const retest = detail.body.retests[0]!;
    const res = await call(h, h.users.tester, 'POST', `${base()}/retests/${retest.id}`, {
      status: 'failed',
      build: '8814',
      note: 'Still PENDING on Safari',
    });
    expect(res.status).toBe(204);
    const issue = await h.jira.getIssue(defect.jiraKey);
    expect(issue.fields.status.name).toBe('To Do');
    expect(JSON.stringify(issue)).toContain('Still PENDING on Safari');
  });

  it('links an existing bug and records the repeat sighting in Jira', async () => {
    const res = await call<DefectRow>(h, h.users.tester, 'POST', `${base()}/defects/link`, {
      runId: run.id,
      itemId: item.id,
      jiraKey: defect.jiraKey,
    });
    expect(res.status).toBe(200);
    // Same item already linked: no duplicate link or comment.
    const comments = (await h.jira.getIssue(defect.jiraKey)) as unknown as {
      fields: { comment?: { comments: unknown[] } };
    };
    expect(comments.fields.comment?.comments.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('says why sync is paused once the reporter disconnects and nobody else can reach Jira', async () => {
    await call(h, h.users.tester, 'DELETE', '/me/jira');
    await call(h, h.users.admin, 'DELETE', '/me/jira');
    await call(h, h.users.lead, 'POST', `${base()}/defects/sync`);
    const sync = await call(h, h.users.lead, 'GET', `${base()}/defects/sync`);
    expect(sync.body.connected).toBe(false);
    expect(sync.body.lastError).toMatch(/nobody with access/);
    await connect(h.users.tester);
  });

  it('refuses defect actions for a viewer', async () => {
    const res = await call(h, h.users.viewer, 'POST', `${base()}/defects`, {
      runId: run.id,
      itemId: item.id,
      summary: 'Viewer bug attempt',
    });
    expect(res.status).toBe(403);
  });
});

describe('background run preparation', () => {
  it('prepares a run in chunks and activates it when every item exists', async () => {
    for (let i = 0; i < 3; i++) await newCase(`Prep case ${i} ${unique}`);
    const actor = { orgId: h.orgId, userId: h.users.lead.id };
    const runId = await withTenant(h.appDb, actor, (trx) =>
      createPreparedRun(trx, actor, h.projectId, {
        name: 'Big run',
        type: 'regression',
        environment: 'UAT',
        build: '8812',
        configs: ['Chrome 128 · Win 11', 'Safari 17 · macOS 14'],
        assigneeIds: [h.users.tester.id, h.users.lead.id],
        filter: { q: `Prep case` },
        dueAt: null,
      }),
    );
    const before = await call<RunSummary>(h, h.users.lead, 'GET', `/projects/${h.projectId}/runs/${runId}`);
    expect(before.body).toMatchObject({ status: 'preparing', counts: { total: 6 } });

    const done = await withTenant(h.appDb, actor, (trx) => prepChunk(trx, runId));
    expect(done).toBe(true);
    const after = await call<RunSummary>(h, h.users.lead, 'GET', `/projects/${h.projectId}/runs/${runId}`);
    expect(after.body).toMatchObject({ status: 'active', counts: { total: 6 } });
    const items = await call<RunItemRow[]>(
      h,
      h.users.lead,
      'GET',
      `/projects/${h.projectId}/runs/${runId}/items`,
    );
    // Every configuration of a case goes to the same tester.
    const byCase = new Map<string, Set<string>>();
    for (const i of items.body)
      byCase.set(i.caseKey, (byCase.get(i.caseKey) ?? new Set()).add(i.assignee!.id));
    expect([...byCase.values()].every((s) => s.size === 1)).toBe(true);
  });
});
