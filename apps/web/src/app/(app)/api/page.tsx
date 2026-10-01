import { Suspense } from 'react';
import { ApiStudioScreen } from '@/features/apistudio/ApiStudioScreen';

export default function ApiStudioPage() {
  return (
    <Suspense>
      <ApiStudioScreen />
    </Suspense>
  );
}
