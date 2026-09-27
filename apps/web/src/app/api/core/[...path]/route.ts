import { NextResponse, type NextRequest } from 'next/server';
import * as oidc from 'openid-client';
import { COOKIE, cookieOptions, coreApiUrl, oidcConfig, sessionCookies, unseal, webUrl, type AccessCookie } from '@/server/session';

// Same-origin proxy from the browser to core-api. It exists so the access token never reaches page
// JavaScript: the browser sends its httpOnly cookies here and this handler adds the bearer header.

type Ctx = { params: Promise<{ path: string[] }> };

/** Refreshes when the access token is missing or expires within 30 seconds. */
async function currentToken(req: NextRequest): Promise<{ token: string | null; refreshed?: Awaited<ReturnType<typeof sessionCookies>> }> {
  const access = await unseal<AccessCookie>(req.cookies.get(COOKIE.access)?.value);
  if (access && access.exp - 30 > Date.now() / 1000) return { token: access.at };

  const refresh = await unseal<{ rt: string }>(req.cookies.get(COOKIE.refresh)?.value);
  if (!refresh) return { token: null };
  try {
    const tokens = await oidc.refreshTokenGrant(await oidcConfig(), refresh.rt);
    return { token: tokens.access_token, refreshed: await sessionCookies(tokens) };
  } catch {
    return { token: null };
  }
}

async function forward(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // SameSite=Lax already keeps cookies off cross-site POSTs; checking Origin as well means a browser
  // quirk or a future cookie change cannot turn this proxy into a CSRF target.
  const origin = req.headers.get('origin');
  if (req.method !== 'GET' && origin && origin !== new URL(webUrl()).origin) {
    return NextResponse.json({ error: { code: 'forbidden', message: 'Cross-site request refused.' } }, { status: 403 });
  }
  const { token, refreshed } = await currentToken(req);
  if (!token) {
    return NextResponse.json({ error: { code: 'unauthenticated', message: 'Your session has ended. Sign in again.' } }, { status: 401 });
  }

  const { path } = await params;
  const target = `${coreApiUrl()}/api/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody && { 'content-type': req.headers.get('content-type') ?? 'application/json' }),
      'x-request-id': req.headers.get('x-request-id') ?? crypto.randomUUID(),
    },
    body: hasBody ? await req.text() : undefined,
    cache: 'no-store',
  });

  const res = new NextResponse(upstream.status === 204 ? null : await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
  if (refreshed) {
    res.cookies.set(COOKIE.access, refreshed.access.value, cookieOptions(refreshed.access.maxAge));
    if (refreshed.refresh) res.cookies.set(COOKIE.refresh, refreshed.refresh.value, cookieOptions(refreshed.refresh.maxAge));
  }
  return res;
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
