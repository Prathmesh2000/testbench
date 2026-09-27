import { CaseDetailScreen } from '@/features/cases/CaseDetailScreen';

export default async function CaseDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <CaseDetailScreen caseKey={decodeURIComponent(key).toUpperCase()} />;
}
