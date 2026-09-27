import { Suspense } from 'react';
import { CreateRunScreen } from '@/features/runs/CreateRunScreen';

export default function NewRunPage() {
  return (
    <Suspense>
      <CreateRunScreen />
    </Suspense>
  );
}
