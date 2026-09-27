import { Suspense } from 'react';
import { DefectsScreen } from '@/features/defects/DefectsScreen';

export default function DefectsPage() {
  return (
    <Suspense>
      <DefectsScreen />
    </Suspense>
  );
}
