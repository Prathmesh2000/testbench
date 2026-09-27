import { Suspense } from 'react';
import { AnalyticsScreen } from '@/features/analytics/AnalyticsScreen';

export default function AnalyticsPage() {
  return (
    <Suspense>
      <AnalyticsScreen />
    </Suspense>
  );
}
