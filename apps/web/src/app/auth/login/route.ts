import { NextResponse, type NextRequest } from 'next/server';
import * as oidc from 'openid-client';
import { COOKIE, cookieOptions, oidcConfig, seal, webUrl } from '@/server/session';

/** Starts the OIDC authorization-code flow with PKCE and remembers where to return afterwards. */
export async function GET(req: NextRequest) {
  const config = await oidcConfig();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  // Only same-site paths: an absolute URL here would turn login into an open redirect.
  const requested = req.nextUrl.searchParams.get('returnTo') ?? '/';
  const returnTo = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${webUrl()}/auth/callback`,
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(COOKIE.login, await seal({ verifier, state, returnTo }, 600), cookieOptions(600));
  return res;
}
