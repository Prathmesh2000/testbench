import { NextResponse } from 'next/server';
import * as oidc from 'openid-client';
import { COOKIE, oidcConfig, webUrl } from '@/server/session';

/** Clears our cookies and ends the Keycloak session too, so "sign out" really signs out. */
export async function POST() {
  const endSession = oidc.buildEndSessionUrl(await oidcConfig(), { post_logout_redirect_uri: `${webUrl()}/` });
  const res = NextResponse.redirect(endSession, 303);
  for (const name of Object.values(COOKIE)) res.cookies.delete(name);
  return res;
}
