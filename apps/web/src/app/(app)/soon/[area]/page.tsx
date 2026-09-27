import { Icon } from '@/components/Icon';

const AREAS: Record<string, { title: string; milestone: string; what: string }> = {
  boards: { title: 'Boards', milestone: 'M5', what: 'Live documents, sheets and whiteboards.' },
  meetings: { title: 'Meetings', milestone: 'M5', what: 'Calendar scheduling, notes and action items that become cases or bugs.' },
  admin: { title: 'Admin', milestone: 'M5', what: 'Members, the roles matrix, integrations, AI providers and the audit log.' },
};

export default async function Soon({ params }: { params: Promise<{ area: string }> }) {
  const { area } = await params;
  const info = AREAS[area] ?? { title: 'This area', milestone: 'a later milestone', what: '' };
  return (
    <div className="page">
      <div className="empty" style={{ flex: 1 }}>
        <Icon name="flag" size={22} />
        <div className="h1">{info.title} arrives in {info.milestone}</div>
        <div className="t2" style={{ maxWidth: 460 }}>{info.what}</div>
      </div>
    </div>
  );
}
