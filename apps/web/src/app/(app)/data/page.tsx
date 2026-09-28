import { Suspense } from 'react';
import { DataSetsScreen } from '@/features/datasets/DataSetsScreen';

export default function DataPage() {
  return (
    <Suspense>
      <DataSetsScreen />
    </Suspense>
  );
}
