import type { CapturedElementsBody, Locator, PickerClaims, PickerSession } from '@tb/contracts';
import { AppError, notFound, signTicket, verifyTicket, type Tx } from '@tb/platform';
import type { z } from 'zod';
import { saveElement } from './tests';

/** Long enough to work through a few screens, short enough that a leaked bookmarklet goes stale. */
const PICKER_TTL_S = 2 * 3600;

/**
 * Starts a locator-picking session. The tester runs the returned bookmarklet on their own site in
 * their own browser: nothing is streamed and Testbench never touches the site. The picker reads the
 * page's own DOM, ranks locators, and sends the ones the tester keeps back to the page library.
 */
export function pickerSession(
  secret: string | null,
  webUrl: string,
  caller: { orgId: string; userId: string },
  projectId: string,
): PickerSession {
  if (!secret)
    throw new AppError(503, 'picker_unavailable', 'The locator picker is not enabled on this server: BROWSER_SECRET is not set.');
  const exp = Math.floor(Date.now() / 1000) + PICKER_TTL_S;
  const claims: PickerClaims = { kind: 'picker', project: projectId, org: caller.orgId, user: caller.userId, exp };
  const ticket = signTicket(secret, claims);
  const src = `${webUrl.replace(/\/+$/, '')}/api/picker/script?t=${encodeURIComponent(ticket)}`;
  const loader = `var s=document.createElement('script');s.src=${JSON.stringify(src)};s.crossOrigin='anonymous';document.body.appendChild(s);`;
  return {
    ticket,
    bookmarklet: `javascript:(function(){${encodeURIComponent(loader)}})()`,
    consoleSnippet: loader,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function readPickerTicket(secret: string | null, ticket: string): PickerClaims {
  const claims = secret ? verifyTicket<PickerClaims>(secret, ticket) : null;
  if (!claims || claims.kind !== 'picker')
    throw new AppError(401, 'picker_expired', 'This picking session has expired. Start a new one in Testbench.');
  return claims;
}

/**
 * Saves elements the tester kept. Each one goes through the ordinary page library path, so a name
 * that already exists updates its locators and every test using that element follows.
 */
export async function saveCaptured(
  trx: Tx,
  claims: PickerClaims,
  body: z.infer<typeof CapturedElementsBody>,
): Promise<{ saved: number }> {
  const project = await trx
    .selectFrom('repo.project')
    .select('id')
    .where('id', '=', claims.project)
    .executeTakeFirst();
  if (!project) throw notFound('Project');
  for (const el of body.elements)
    await saveElement(trx, { orgId: claims.org, userId: claims.user }, claims.project, {
      page: el.page,
      name: el.name,
      locators: el.locators as Locator[],
    });
  return { saved: body.elements.length };
}
