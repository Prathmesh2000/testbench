import { Suspense } from 'react';
import { DocsScreen } from '@/features/docs/DocsScreen';

export default function DocsPage() {
  return (
    <Suspense>
      <DocsScreen />
    </Suspense>
  );
}
