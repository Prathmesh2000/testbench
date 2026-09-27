// Local stand-in for notification providers (HLD §10): accepts Slack incoming-webhook, Teams Workflows,
// Discord webhook and SMS calls, keeps the last 500 in memory, and shows them at http://localhost:8091.
// No dependencies: it runs straight from node:24-alpine.

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 8091;
// The Slack console below signs commands like Slack does, with the gateway's signing secret.
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://host.docker.internal:4200';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? '';
const slackLog = [];
const captured = [];

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });

/** A readable one-liner for each provider's payload shape. */
function summarise(kind, body) {
  try {
    const b = JSON.parse(body);
    if (kind === 'slack') return b.text ?? JSON.stringify(b.blocks ?? b);
    if (kind === 'discord') return b.content ?? b.embeds?.[0]?.title ?? '';
    if (kind === 'teams') return b.attachments?.[0]?.content?.body?.map((x) => x.text).join(' · ') ?? '';
    if (kind === 'sms') return `${b.to}: ${b.message}`;
  } catch { /* not JSON */ }
  return body.slice(0, 300);
}

function page(filter) {
  const rows = captured.filter((c) => !filter || c.kind === filter).map((c) => `
    <tr><td>${c.at.slice(11, 19)}</td><td><b>${c.kind}</b></td><td>${escapeHtml(c.target)}</td><td>${escapeHtml(c.summary)}</td>
    <td><details><summary>payload</summary><pre>${escapeHtml(c.body)}</pre></details></td></tr>`).join('');
  const tabs = ['', 'slack', 'teams', 'discord', 'sms'].map((k) => `<a href="/?kind=${k}" class="${k === (filter ?? '') ? 'on' : ''}">${k || 'all'}</a>`).join(' ');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Provider sandbox</title>
  <style>body{font:14px system-ui;margin:24px;background:#111214;color:#e6e7ea}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2b2d33;padding:6px 8px;text-align:left;vertical-align:top}
  a{color:#4c8dff;margin-right:10px;text-decoration:none}a.on{font-weight:600;text-decoration:underline}pre{white-space:pre-wrap;font-size:12px;color:#a2a5ad;max-width:640px}</style>
  <h2>Provider sandbox</h2><p>Messages Testbench sent to Slack, Teams, Discord and SMS. Refreshes every 5 seconds. ${tabs} · <a href="/slack-console">Slack console</a></p>
  <table><tr><th>Time</th><th>Channel</th><th>To</th><th>Message</th><th></th></tr>${rows || '<tr><td colspan="5">Nothing sent yet.</td></tr>'}</table>`;
}

/** A stand-in for typing /tcm in Slack: posts a signed slash command to the agent gateway. */
function slackConsole() {
  const rows = slackLog.map((l) => `<tr><td>${l.at.slice(11, 19)}</td><td><code>/tcm ${escapeHtml(l.text)}</code></td><td><pre>${escapeHtml(l.reply)}</pre></td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Slack console</title>
  <style>body{font:14px system-ui;margin:24px;background:#111214;color:#e6e7ea}input{font:14px monospace;padding:6px;width:520px;background:#1b1c20;color:#e6e7ea;border:1px solid #2b2d33}
  button{padding:6px 12px}table{border-collapse:collapse;width:100%;margin-top:16px}td{border-bottom:1px solid #2b2d33;padding:6px 8px;vertical-align:top}pre{white-space:pre-wrap;margin:0;color:#a2a5ad}a{color:#4c8dff}</style>
  <h2>Slack console</h2><p>Sends <code>/tcm</code> as Slack user <b>U-LOCAL</b> to ${escapeHtml(GATEWAY_URL)}. <a href="/">Back to captured messages</a></p>
  <form method="post" action="/slack-console"><input name="text" placeholder="status RUN-1 PAY" autofocus> <button>Send</button></form>
  <table>${rows}</table>`;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(url.searchParams.get('kind') || null)); }
  if (url.pathname === '/slack-console') {
    if (req.method === 'POST') {
      const text = new URLSearchParams(await readBody(req)).get('text') ?? '';
      const body = new URLSearchParams({ team_id: 'T-LOCAL', user_id: 'U-LOCAL', user_name: 'local', command: '/tcm', text }).toString();
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
      let reply;
      try {
        const r = await fetch(`${GATEWAY_URL}/slack/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': signature },
          body,
        });
        const data = await r.json().catch(() => ({}));
        reply = data.text ?? data.error ?? `HTTP ${r.status}`;
      } catch (err) {
        reply = `Gateway not reachable: ${err.message}`;
      }
      slackLog.unshift({ at: new Date().toISOString(), text, reply });
      res.writeHead(303, { location: '/slack-console' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(slackConsole());
  }
  if (req.method === 'GET' && url.pathname === '/captured') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(captured)); }

  // /slack/<anything>, /teams/<anything>, /discord/<anything>, /sms
  const m = /^\/(slack|teams|discord|sms)(\/.*)?$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    const body = await readBody(req);
    if (url.searchParams.get('fail') === '1') { res.writeHead(500); return res.end('simulated provider failure'); }
    captured.unshift({ at: new Date().toISOString(), kind: m[1], target: m[2] ?? '', body, summary: summarise(m[1], body) });
    captured.length = Math.min(captured.length, 500);
    // Discord answers 204, Slack "ok", Teams 202: mimic them so adapters are exercised as in production.
    if (m[1] === 'discord') { res.writeHead(204); return res.end(); }
    if (m[1] === 'teams') { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(m[1] === 'sms' ? JSON.stringify({ MessageId: `sandbox-${Date.now()}` }) : 'ok');
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => console.log(`provider sandbox on :${PORT}`));
