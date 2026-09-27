import { Suspense } from 'react';
import { SearchScreen } from '@/features/search/SearchScreen';

export default function SearchPage() {
  return (
    <Suspense>
      <SearchScreen />
    </Suspense>
  );
}
