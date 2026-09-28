// Local stand-in for Jira Cloud (HLD §10). Implements only the REST API subset Testbench uses:
// create/get issue, comments, transitions and JQL search, with Basic auth and Jira-style webhooks
// signed with X-Hub-Signature. A page at http://localhost:8090 moves bugs between statuses, which
// is how a developer "fixes" a bug locally. No dependencies: it runs straight from node:24-alpine.

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const TOKEN = process.env.JIRA_SANDBOX_TOKEN ?? 'jira-sandbox-token';
const WEBHOOK_URL = process.env.JIRA_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET ?? '';
const DATA = process.env.JIRA_DATA ?? './issues.json';
const PORT = 8090;

// A realistic team workflow, so Testbench shows every status name as Jira has it, not only the three categories.
const STATUSES = {
  11: { name: 'To Do', category: 'new' },
  15: { name: 'Reopened', category: 'new' },
  21: { name: 'In Progress', category: 'indeterminate' },
  25: { name: 'Blocked', category: 'indeterminate' },
  31: { name: 'In Review', category: 'indeterminate' },
  35: { name: 'In QA', category: 'indeterminate' },
  41: { name: 'Done', category: 'done' },
  51: { name: "Won't Do", category: 'done' },
};
const statusField = (id) => ({ id: String(id), name: STATUSES[id].name, statusCategory: { key: STATUSES[id].category, name: STATUSES[id].category === 'done' ? 'Done' : STATUSES[id].category === 'new' ? 'To Do' : 'In Progress' } });
const DEVELOPERS = ['Aman Tiwari', 'Farhan Qureshi', 'Lakshmi Ramesh', 'Gaurav Sethi', 'Shruti Bhat', 'Omkar Patil'];

// ---------- storage ----------
let db = existsSync(DATA) ? JSON.parse(readFileSync(DATA, 'utf8')) : null;
if (!db) {
  // A few open bugs already exist, so the duplicate check has something to find on day one.
  db = { next: 4801, issues: {} };
  const existing = [
    'Collect request expiry after 5 minutes is ignored on Safari 17',
    'OTP resend button stays disabled after 30 seconds',
    'Refund SMS shows untranslated text in Hindi locale',
    'Mandate pause and resume returns HTTP 500 for first-time users',
    'Dynamic QR with a fixed amount shows the wrong amount',
    'CSV export of 1 lakh transactions times out',
    'Saved card list crashes the page on iOS 17',
    'Pre-debit notification is not shown 24 hours before charge',
  ];
  for (const summary of existing) createIssue({ project: { key: 'PAY' }, summary, issuetype: { name: 'Bug' }, priority: { name: 'Major' }, labels: ['legacy'] }, true);
  save();
}
// Stories and tasks to link test cases to (the bugs above come from runs). Added once, also to older data files.
if (!db.seededWork) {
  const work = [
    ['Story', 'UPI Autopay: pause a mandate for up to 90 days', 21],
    ['Story', 'Checkout 2.0: pay with a saved card in one tap', 31],
    ['Story', 'Refunds revamp: instant refunds to the source account', 35],
    ['Story', 'Video KYC: reconnect after a dropped call', 11],
    ['Task', 'Set up UAT merchant accounts for release 4.18', 41],
    ['Epic', 'Release 4.18: Payments web', 21],
  ];
  for (const [type, summary, status] of work) {
    const issue = createIssue({ project: { key: 'PAY' }, summary, issuetype: { name: type }, priority: { name: 'Major' }, labels: ['roadmap'] }, true);
    issue.fields.status = statusField(status);
  }
  db.seededWork = true;
  save();
}

function save() {
  writeFileSync(DATA, JSON.stringify(db, null, 2));
}

function createIssue(fields, quiet = false) {
  const key = `${fields.project?.key ?? 'PAY'}-${db.next++}`;
  const now = new Date().toISOString();
  const issue = {
    id: String(10000 + db.next),
    key,
    fields: {
      summary: fields.summary ?? '(no summary)',
      description: fields.description ?? null,
      issuetype: { name: fields.issuetype?.name ?? 'Bug' },
      project: { key: fields.project?.key ?? 'PAY' },
      status: statusField(11),
      priority: { name: fields.priority?.name ?? 'Major' },
      labels: fields.labels ?? [],
      assignee: { displayName: DEVELOPERS[db.next % DEVELOPERS.length] },
      fixVersions: [{ name: '4.18.0' }],
      created: now,
      updated: now,
      comment: { comments: [] },
    },
  };
  db.issues[key] = issue;
  if (!quiet) save();
  return issue;
}

function sendWebhook(issue, event = 'jira:issue_updated') {
  if (!WEBHOOK_URL) return;
  const body = JSON.stringify({ timestamp: Date.now(), webhookEvent: event, issue });
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  fetch(WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature': signature }, body })
    .then((r) => console.log(`webhook ${event} ${issue.key} -> ${r.status}`))
    .catch((err) => console.log(`webhook ${event} ${issue.key} failed: ${err.message}`));
}

function transition(issue, id) {
  if (!STATUSES[id]) return false;
  issue.fields.status = statusField(id);
  issue.fields.updated = new Date().toISOString();
  save();
  sendWebhook(issue);
  return true;
}

// ---------- JQL: just the clauses Testbench sends ----------
const plainText = (adf) => (adf && typeof adf === 'object' ? JSON.stringify(adf).match(/"text":"([^"]*)"/g)?.map((t) => t.slice(8, -1)).join(' ') ?? '' : String(adf ?? ''));
function matches(issue, jql) {
  const where = jql.split(/\s+ORDER\s+BY\s+/i)[0];
  return where.split(/\s+AND\s+/i).every((raw) => {
    const clause = raw.trim();
    let m;
    if ((m = /^project\s*=\s*"?(\w+)"?$/i.exec(clause))) return issue.fields.project.key === m[1];
    if ((m = /^statusCategory\s*(!=|=)\s*"?Done"?$/i.exec(clause))) return (issue.fields.status.statusCategory.key === 'done') === (m[1] === '=');
    if ((m = /^key\s+in\s*\(([^)]*)\)$/i.exec(clause))) return m[1].split(',').map((k) => k.trim().replace(/"/g, '')).includes(issue.key);
    if ((m = /^updated\s*>=\s*"([^"]+)"$/i.exec(clause))) return new Date(issue.fields.updated) >= new Date(m[1].replace(' ', 'T') + 'Z');
    if ((m = /^text\s*~\s*"([^"]*)"$/i.exec(clause))) {
      const hay = `${issue.fields.summary} ${plainText(issue.fields.description)}`.toLowerCase();
      // Like Jira's text search: any meaningful word matching is enough; ranking is the caller's job.
      return m[1].toLowerCase().split(/\W+/).filter((w) => w.length > 2).some((w) => hay.includes(w));
    }
    return true;
  });
}

// ---------- HTTP ----------
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let data = ''; req.on('data', (c) => (data += c)); req.on('end', () => resolve(data)); });
const authorised = (req) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [, token] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return token === TOKEN;
};
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page() {
  const rows = Object.values(db.issues).sort((a, b) => b.fields.updated.localeCompare(a.fields.updated)).map((i) => `
    <tr><td><b>${i.key}</b></td><td>${escapeHtml(i.fields.summary)}</td><td>${i.fields.status.name}</td>
    <td>${Object.entries(STATUSES).map(([id, s]) => `<form method="post" action="/ui/transition"><input type="hidden" name="key" value="${i.key}"><input type="hidden" name="id" value="${id}"><button ${s.name === i.fields.status.name ? 'disabled' : ''}>${s.name}</button></form>`).join('')}</td>
    <td>${i.fields.comment.comments.map((c) => `<div class="c">${escapeHtml(plainText(c.body))}</div>`).join('')}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Jira sandbox</title>
  <style>body{font:14px system-ui;margin:24px;background:#111214;color:#e6e7ea}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2b2d33;padding:6px 8px;text-align:left;vertical-align:top}
  form{display:inline}button{margin:0 2px;background:#1e2024;color:#e6e7ea;border:1px solid #2b2d33;border-radius:4px;padding:2px 8px;cursor:pointer}button[disabled]{opacity:.4}.c{font-size:12px;color:#a2a5ad}</style>
  <h2>Jira sandbox</h2><p>Changing a status sends a signed <code>jira:issue_updated</code> webhook to Testbench.</p>
  <table><tr><th>Key</th><th>Summary</th><th>Status</th><th>Move to</th><th>Comments</th></tr>${rows}</table>`;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/health') return json(res, 200, { ok: true });
    if (path === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page()); }
    if (path === '/ui/transition' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const issue = db.issues[form.get('key')];
      if (issue) transition(issue, Number(form.get('id')));
      res.writeHead(303, { location: '/' });
      return res.end();
    }

    if (!path.startsWith('/rest/api/3/')) return json(res, 404, { errorMessages: ['Not found'] });
    if (!authorised(req)) return json(res, 401, { errorMessages: ['Client must be authenticated to access this resource.'] });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};

    if (path === '/rest/api/3/issue' && req.method === 'POST') {
      if (!body.fields?.summary) return json(res, 400, { errors: { summary: 'You must specify a summary of the issue.' } });
      const issue = createIssue(body.fields);
      sendWebhook(issue, 'jira:issue_created');
      return json(res, 201, { id: issue.id, key: issue.key, self: `http://localhost:${PORT}/rest/api/3/issue/${issue.id}` });
    }
    if (path === '/rest/api/3/search/jql' && req.method === 'POST') {
      const issues = Object.values(db.issues).filter((i) => matches(i, body.jql ?? '')).sort((a, b) => b.fields.updated.localeCompare(a.fields.updated));
      return json(res, 200, { issues: issues.slice(0, body.maxResults ?? 50), isLast: true });
    }
    // Every status of every issue type in a project, as Jira Cloud's project statuses endpoint returns them.
    const ps = /^\/rest\/api\/3\/project\/([A-Z][A-Z0-9]*)\/statuses$/.exec(path);
    if (ps && req.method === 'GET') {
      const statuses = Object.keys(STATUSES).map((id) => statusField(Number(id)));
      return json(res, 200, ['Bug', 'Story', 'Task', 'Epic'].map((name, i) => ({ id: String(10001 + i), name, statuses })));
    }
    const m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)(\/comment|\/transitions)?$/.exec(path);
    if (m) {
      const issue = db.issues[m[1]];
      if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
      if (!m[2] && req.method === 'GET') return json(res, 200, issue);
      if (m[2] === '/comment' && req.method === 'POST') {
        const comment = { id: String(Date.now()), body: body.body, created: new Date().toISOString(), author: { displayName: 'Testbench' } };
        issue.fields.comment.comments.push(comment);
        issue.fields.updated = comment.created;
        save();
        return json(res, 201, comment);
      }
      if (m[2] === '/transitions' && req.method === 'GET') {
        return json(res, 200, { transitions: Object.entries(STATUSES).map(([id, s]) => ({ id, name: s.name, to: statusField(Number(id)) })) });
      }
      if (m[2] === '/transitions' && req.method === 'POST') {
        return transition(issue, Number(body.transition?.id)) ? json(res, 204) : json(res, 400, { errorMessages: ['Transition id is not valid.'] });
      }
    }
    return json(res, 404, { errorMessages: ['Not found'] });
  } catch (err) {
    console.error(err);
    return json(res, 500, { errorMessages: [String(err.message ?? err)] });
  }
}).listen(PORT, () => console.log(`Jira sandbox on :${PORT}`));
