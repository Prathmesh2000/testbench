import { NextResponse } from 'next/server';
import { EMBED_SOURCE } from '@/features/studio/picker/embed';
import { webUrl } from '@/server/session';

// The one script a team adds to their own staging site so it can be opened in the pane beside the
// editor. It is public and carries no credentials: on its own it does nothing, because it only
// responds to a frame on this Testbench origin and only ever posts back to it.

export async function GET() {
  const origin = new URL(webUrl()).origin;
  return new NextResponse(EMBED_SOURCE.replace('__PARENT_ORIGIN__', origin), {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      // Short: a team that updates Testbench should get the current picker on their next reload.
      'cache-control': 'public, max-age=60',
    },
  });
}
