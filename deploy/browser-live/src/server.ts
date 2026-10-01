import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { BrowserClaims } from '@tb/contracts';
import { BROWSER_ARGS, loadEnvFileIfPresent, verifyTicket } from '@tb/platform';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { LiveSession } from './session';

// The Test Browser server (testing-studio-plan §3.1): one shared Chromium, one isolated context per
// tester, streamed over WebSocket. It has no database or storage access: core-api decides who may open
// a session and signs a ticket; evidence goes back through the web app's normal upload flow.

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const cfg = z
  .object({
    BROWSER_SECRET: z.string().min(32),
    BROWSER_PORT: z.coerce.number().int().default(4400),
    BROWSER_MAX_SESSIONS: z.coerce.number().int().min(1).default(30),
    BROWSER_IDLE_MINUTES: z.coerce.number().int().min(1).default(10),
    // Private, loopback and metadata addresses are blocked unless explicitly allowed, which only makes
    // sense on a developer laptop testing an app on localhost.
    BROWSER_ALLOW_PRIVATE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Headed only when debugging locally; servers have no display.
    BROWSER_HEADLESS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .parse(process.env);

// Full Chromium, not the default headless shell: bot protection on many public sites (justdial.com,
// for one) refuses the shell's fingerprint outright, and testers need those sites to behave as in Chrome.
const browser = await chromium.launch({ channel: 'chromium', headless: cfg.BROWSER_HEADLESS, args: BROWSER_ARGS });
const sessions = new Map<string, LiveSession>();

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: browser.isConnected(), sessions: sessions.size }));
  }
  res.writeHead(404).end();
});

// Client messages are small (input events, commands); a large frame is abuse, not a tester.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const ticket = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ticket') ?? '';
  const claims = verifyTicket<BrowserClaims>(cfg.BROWSER_SECRET, ticket);
  if (!claims) return ws.close(4401, 'This session has expired. Start it again from Testbench.');

  const existing = sessions.get(claims.session);
  if (existing) return void existing.attach(ws);
  if (sessions.size >= cfg.BROWSER_MAX_SESSIONS) return ws.close(4429, 'The Test Browser is at capacity. Try again shortly.');

  void LiveSession.open(browser, claims, {
    idleMs: cfg.BROWSER_IDLE_MINUTES * 60_000,
    blockPrivate: !cfg.BROWSER_ALLOW_PRIVATE,
    onClosed: (id) => sessions.delete(id),
  })
    .then(async (session) => {
      sessions.set(claims.session, session);
      await session.attach(ws);
    })
    .catch((err: Error) => ws.close(1011, `Could not start the browser: ${err.message}`.slice(0, 120)));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all([...sessions.values()].map((s) => s.close('The Test Browser server is restarting')));
    await browser.close();
    server.close();
    process.exit(0);
  });
}

server.listen(cfg.BROWSER_PORT, () => console.log(`Test Browser on :${cfg.BROWSER_PORT}`));
