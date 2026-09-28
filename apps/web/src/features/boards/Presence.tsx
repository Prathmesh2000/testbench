'use client';

import { initials } from '@/lib/format';
import { usePeers, type BoardDoc } from './collab';
import s from './boards.module.css';

/** Who has the board open, plus the connection state: Connected, Reconnecting or Read-only. */
export function Presence({ board, compact = false }: { board: BoardDoc; compact?: boolean }) {
  const peers = usePeers(board.provider);
  const label =
    board.status === 'failed' ? 'Offline'
      : board.status === 'connecting' ? 'Connecting…'
        : board.status === 'reconnecting' ? 'Reconnecting…'
          : board.canEdit ? 'Connected' : 'Read-only';
  const tone = board.status === 'connected' ? (board.canEdit ? s.ok : s.ro) : board.status === 'failed' ? s.bad : s.wait;
  return (
    <span className="row t3" style={{ gap: 8, fontSize: 12 }}>
      {peers.length > 0 && (
        <span className="avs" aria-label={`${peers.length} here now: ${peers.map((p) => p.name).join(', ')}`}>
          {peers.slice(0, 5).map((p) => <span key={p.id} className={`av ${p.tone}`} title={p.name}>{initials(p.name)}</span>)}
        </span>
      )}
      {!compact && peers.length > 0 && <span>{peers.length} here now</span>}
      <span className={`${s.status} ${tone}`} role="status" title={board.error ?? undefined}><i />{label}</span>
    </span>
  );
}
