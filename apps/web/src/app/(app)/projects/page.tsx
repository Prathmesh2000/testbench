import { Suspense } from 'react';
import { ProjectsScreen } from '@/features/projects/ProjectsScreen';

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsScreen />
    </Suspense>
  );
}
