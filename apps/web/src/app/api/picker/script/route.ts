import { NextResponse, type NextRequest } from 'next/server';
import { PICKER_SOURCE } from '@/features/studio/picker/source';
import { webUrl } from '@/server/session';

// Serves the locator picker to the tester's own site, with their ticket and the capture address
// substituted in. The script is public: on its own it can do nothing, because every capture is
// authorised by the short-lived ticket the tester's bookmarklet carries.

export async function GET(req: NextRequest) {
  const ticket = req.nextUrl.searchParams.get('t') ?? '';
  // Only the characters a signed ticket uses, so nothing from the query can break out of the string.
  if (!/^[A-Za-z0-9._-]{10,2000}$/.test(ticket))
    return new NextResponse('/* Testbench: this picking session link is not valid. */', {
      status: 400,
      headers: { 'content-type': 'application/javascript; charset=utf-8' },
    });
  const body = PICKER_SOURCE.replace('__TICKET__', ticket).replace(
    '__CAPTURE_URL__',
    `${webUrl().replace(/\/+$/, '')}/api/picker/capture`,
  );
  return new NextResponse(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // It runs on the tester's own site, which is any origin as far as we know.
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
