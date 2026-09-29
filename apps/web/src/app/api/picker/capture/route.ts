import { NextResponse, type NextRequest } from 'next/server';
import { coreApiUrl } from '@/server/session';

// Takes the elements a tester kept while picking on their own site. It carries a picker ticket
// instead of a session, so it is reachable from any origin; core-api checks the ticket's signature
// and only ever adds to that one project's page library.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  // A capture is a handful of elements; anything larger is not a tester picking locators.
  const body = await req.text();
  if (body.length > 64 * 1024)
    return NextResponse.json({ error: { code: 'too_large', message: 'Too many elements at once.' } }, { status: 413, headers: CORS });
  const res = await fetch(`${coreApiUrl()}/api/v1/studio/picker/captured`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}
