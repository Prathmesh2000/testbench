import { Suspense } from 'react';
import { CasesScreen } from '@/features/cases/CasesScreen';

export default function CasesPage() {
  // useSearchParams (for ?new=1) needs a Suspense boundary.
  return (
    <Suspense>
      <CasesScreen />
    </Suspense>
  );
}
