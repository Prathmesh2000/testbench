import { Suspense } from 'react';
import { ExecuteScreen } from '@/features/execute/ExecuteScreen';

export default async function ExecutePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense>
      <ExecuteScreen runId={runId} />
    </Suspense>
  );
}
