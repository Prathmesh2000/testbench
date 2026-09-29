import { Suspense } from 'react';
import { StudioScreen } from '@/features/studio/StudioScreen';

export default function AutomationPage() {
  return (
    <Suspense>
      <StudioScreen />
    </Suspense>
  );
}
