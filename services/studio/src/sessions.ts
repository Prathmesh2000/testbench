import type { BrowserClaims, BrowserDevice, BrowserSession } from '@tb/contracts';
import { AppError, badRequest, notFound, signTicket, type Tx } from '@tb/platform';

/** Longest a live session may run; the ticket expires with it and browser-live closes the page. */
export const SESSION_MAX_S = 4 * 3600;
/** Live sessions open at once per organisation (testing-studio-plan §16). */
export const MAX_OPEN_SESSIONS = 30;

export interface BrowserConfig {
  url: string;
  /** Null disables the Test Browser: there is nothing to sign tickets with. */
  secret: string | null;
  /** Local development only: lets testers open apps on localhost. */
  allowPrivate: boolean;
}

/**
 * Opens a Test Browser session: records it, enforces the organisation's cap, and signs the ticket the
 * web app presents to browser-live. The browser itself starts when that WebSocket connects.
 */
export async function startSession(
  trx: Tx,
  browser: BrowserConfig,
  caller: { orgId: string; userId: string },
  projectId: string,
  body: { url: string; device: BrowserDevice; runItemId?: string },
): Promise<BrowserSession> {
  // Internal addresses are refused in browser-live on every request (after DNS resolution); this only
  // gives an early, clear answer for the obvious cases.
  const host = new URL(body.url).hostname;
  if (!browser.allowPrivate && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)|\.internal$/.test(host))
    throw badRequest('The Test Browser cannot open internal addresses.');
  if (!browser.secret)
    throw new AppError(503, 'browser_unavailable', 'The Test Browser is not enabled on this server: BROWSER_SECRET is not set.');
  if (body.runItemId) {
    const item = await trx
      .selectFrom('exec.run_item')
      .select('id')
      .where('id', '=', body.runItemId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!item) throw badRequest('That run item is not in this project.');
  }
  const open = await trx
    .selectFrom('studio.live_session')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('ended_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirstOrThrow();
  if (Number(open.n) >= MAX_OPEN_SESSIONS)
    throw new AppError(
      429,
      'too_many_sessions',
      `Your organisation already has ${MAX_OPEN_SESSIONS} Test Browser sessions open. Close one and try again.`,
    );

  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_S;
  const row = await trx
    .insertInto('studio.live_session')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      user_id: caller.userId,
      url: body.url,
      device: body.device,
      run_item_id: body.runItemId ?? null,
      expires_at: new Date(exp * 1000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const claims: BrowserClaims = {
    session: row.id,
    org: caller.orgId,
    user: caller.userId,
    url: body.url,
    device: body.device,
    exp,
  };
  return { id: row.id, wsUrl: browser.url, ticket: signTicket(browser.secret, claims), device: body.device, url: body.url };
}

export async function endSession(trx: Tx, userId: string, sessionId: string): Promise<void> {
  const ended = await trx
    .updateTable('studio.live_session')
    .set({ ended_at: new Date() })
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .where('ended_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!ended) throw notFound('Session');
}
