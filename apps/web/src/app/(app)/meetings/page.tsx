import { Suspense } from 'react';
import { MeetingsScreen } from '@/features/meetings/MeetingsScreen';

export default function MeetingsPage() {
  return (
    <Suspense>
      <MeetingsScreen />
    </Suspense>
  );
}
