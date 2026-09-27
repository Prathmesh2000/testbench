import { Suspense } from 'react';
import { AdminScreen } from '@/features/admin/AdminScreen';

export default function AdminPage() {
  return (
    <Suspense>
      <AdminScreen />
    </Suspense>
  );
}
