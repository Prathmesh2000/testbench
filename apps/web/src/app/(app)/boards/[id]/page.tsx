import { BoardScreen } from '@/features/boards/BoardScreen';

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BoardScreen key={id} boardId={id} />;
}
