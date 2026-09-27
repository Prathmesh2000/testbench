import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { Shell } from '@/components/Shell';
import { COOKIE } from '@/server/session';

/**
 * Every signed-in screen. Without a refresh cookie there is no session to resume, so the user goes
 * straight to sign-in; an expired access token is renewed transparently by the API proxy.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  if (!store.get(COOKIE.refresh) && !store.get(COOKIE.access)) redirect('/auth/login');
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
