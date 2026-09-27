import { NextResponse, type NextRequest } from 'next/server';
import * as oidc from 'openid-client';
import { COOKIE, cookieOptions, oidcConfig, sessionCookies, unseal, webUrl } from '@/server/session';

interface LoginState {
  verifier: string;
  state: string;
  returnTo: string;
}

/** Completes sign-in: checks state and PKCE, swaps the code for tokens, and stores them in sealed cookies. */
export async function GET(req: NextRequest) {
  const login = await unseal<LoginState>(req.cookies.get(COOKIE.login)?.value);
  if (!login) return NextResponse.redirect(`${webUrl()}/auth/login`);

  // The provider redirects to WEB_URL, which may differ from the internal URL Next.js sees.
  const callbackUrl = new URL(`${webUrl()}/auth/callback${req.nextUrl.search}`);
  let tokens: oidc.TokenEndpointResponse;
  try {
    tokens = await oidc.authorizationCodeGrant(await oidcConfig(), callbackUrl, {
      pkceCodeVerifier: login.verifier,
      expectedState: login.state,
    });
  } catch {
    // Expired or replayed code: start again rather than showing a raw OAuth error.
    return NextResponse.redirect(`${webUrl()}/auth/login`);
  }

  const cookies = await sessionCookies(tokens);
  const res = NextResponse.redirect(`${webUrl()}${login.returnTo}`);
  res.cookies.set(COOKIE.access, cookies.access.value, cookieOptions(cookies.access.maxAge));
  if (cookies.refresh) res.cookies.set(COOKIE.refresh, cookies.refresh.value, cookieOptions(cookies.refresh.maxAge));
  res.cookies.delete(COOKIE.login);
  return res;
}
