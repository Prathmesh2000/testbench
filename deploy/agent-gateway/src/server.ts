import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JsonCache, loadEnvFileIfPresent } from '@tb/platform';
import Fastify from 'fastify';
import { z } from 'zod';
import { CoreClient } from './core';
import { buildMcpServer } from './mcp';
import { handleCommand, verifySlackSignature } from './slack';

// The agent gateway deploy unit (HLD §1.1): the MCP server for Claude, Cursor and other agents, and
// the Slack bot. It is a public surface with its own rate limits in AWS, and holds no data or
// permissions of its own: everything it does, it does through core-api as the calling user.

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const cfg = z
  .object({
    AGENT_GATEWAY_PORT: z.coerce.number().int().default(4200),
    CORE_API_URL: z.url(),
    WEB_URL: z.url(),
    VALKEY_URL: z.url(),
    SLACK_SIGNING_SECRET: z.string().min(16).optional(),
    SLACK_TOKEN_SECRET: z.string().min(32).optional(),
    LOG_LEVEL: z.string().default('info'),
  })
  .parse(process.env);

const app = Fastify({
  logger: { level: cfg.LOG_LEVEL, redact: ['req.headers.authorization'] },
  bodyLimit: 1024 * 1024,
});
const cache = JsonCache.connect(cfg.VALKEY_URL, app.log);

app.get('/healthz', async () => ({ ok: true }));

// ---------- MCP (Streamable HTTP, stateless) ----------
// Stateless: each POST gets a fresh server bound to the caller's token, so no session state can mix
// one user's calls with another's, and any gateway instance can serve any request.
app.post('/mcp', async (req, reply) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply
      .status(401)
      .header('www-authenticate', 'Bearer realm="testbench"')
      .send({ error: 'Send a Testbench access token: Authorization: Bearer tbp_…' });
  }
  const core = new CoreClient(cfg.CORE_API_URL, auth.slice('Bearer '.length), 'mcp');
  const server = buildMcpServer(core);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  reply.hijack();
  reply.raw.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req.raw, reply.raw, req.body);
});
// Stateless servers have no stream to resume or session to end.
app.get('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send());
app.delete('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send());

// ---------- Slack ----------
// Slack signs the exact bytes it sent, so the form body is kept raw for verification and parsed here.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
  done(null, body),
);

app.post('/slack/commands', async (req, reply) => {
  if (!cfg.SLACK_SIGNING_SECRET || !cfg.SLACK_TOKEN_SECRET)
    return reply
      .status(503)
      .send({ error: 'Set SLACK_SIGNING_SECRET and SLACK_TOKEN_SECRET to enable the Slack bot.' });
  const raw = String(req.body ?? '');
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (
    !verifySlackSignature(
      cfg.SLACK_SIGNING_SECRET,
      typeof ts === 'string' ? ts : undefined,
      typeof sig === 'string' ? sig : undefined,
      raw,
    )
  )
    return reply.status(401).send({ error: 'bad signature' });
  const form = new URLSearchParams(raw);
  return handleCommand(
    { cache, coreUrl: cfg.CORE_API_URL, tokenSecret: cfg.SLACK_TOKEN_SECRET, webUrl: cfg.WEB_URL },
    form.get('team_id') ?? '',
    form.get('user_id') ?? '',
    form.get('text') ?? '',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await cache.close();
    process.exit(0);
  });
}
await app.listen({ port: cfg.AGENT_GATEWAY_PORT, host: '0.0.0.0' });
