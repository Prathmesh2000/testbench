'use client';

import { HocuspocusProvider } from '@hocuspocus/provider';
import type { CollabTicket } from '@tb/contracts';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { useSession } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { avatarTone } from '@/lib/format';

// Live board documents: a Yjs doc per board, synced through the collaboration server with tickets
// that core-api signs.

export type CollabStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** What each client publishes in awareness under `user`; the doc editor's carets read `name` and `color`. */
export interface Peer {
  id: string;
  name: string;
  tone: string;
  color: string;
}

// Mirrors the .av-* backgrounds in globals.css; carets and Excalidraw need the colour as a value, not a class.
const TONE_COLORS: Record<string, string> = {
  'av-a': '#4a5aa8', 'av-b': '#2f7266', 'av-c': '#8a4f7d', 'av-d': '#7a6130', 'av-e': '#3d6b99',
  'av-f': '#8a4d3f', 'av-g': '#5b6b3a', 'av-h': '#5a4a93', 'av-i': '#4d5566',
};

export function peerOf(user: { id: string; name: string }): Peer {
  const tone = avatarTone(user.id);
  return { ...user, tone, color: TONE_COLORS[tone] ?? '#4d5566' };
}

interface Connection {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  user: Peer;
}

/** Opens board `boardId` on the collaboration server for as long as the calling component is mounted. */
export function useBoardDoc(boardId: string) {
  const { project } = useSession();
  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let provider: HocuspocusProvider | undefined;
    const doc = new Y.Doc();
    const fetchTicket = () => api<CollabTicket>('POST', `/projects/${project.id}/boards/${boardId}/ticket`);
    setStatus('connecting');
    setError(null);

    fetchTicket()
      .then((first) => {
        if (cancelled) return;
        let unused: CollabTicket | null = first;
        const user = peerOf(first.user);
        setCanEdit(first.canEdit);
        provider = new HocuspocusProvider({
          url: first.url,
          name: boardId,
          document: doc,
          // Tickets expire after two minutes, so every reconnect asks core-api for a fresh one. The first
          // connect reuses the ticket that told us where the server is. A failed fetch sends an empty
          // token, which the server rejects and onAuthenticationFailed reports.
          token: async () => {
            try {
              const ticket = unused ?? (await fetchTicket());
              unused = null;
              if (!cancelled) setCanEdit(ticket.canEdit);
              return ticket.token;
            } catch {
              return '';
            }
          },
          onStatus: ({ status: ws }) => {
            if (ws !== 'connected') setStatus((s) => (s === 'connecting' || s === 'failed' ? s : 'reconnecting'));
          },
          onSynced: ({ state }) => {
            if (state) setStatus('connected');
          },
          onAuthenticationFailed: ({ reason }) => {
            setStatus('failed');
            setError(reason || 'The collaboration server refused this board');
          },
        });
        provider.setAwarenessField('user', user);
        setConn({ doc, provider, user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('failed');
        setError(err instanceof ApiError ? err.message : 'Could not open this board');
      });

    return () => {
      cancelled = true;
      provider?.destroy();
      doc.destroy();
      setConn(null);
    };
  }, [project.id, boardId]);

  return { doc: conn?.doc ?? null, provider: conn?.provider ?? null, user: conn?.user ?? null, status, canEdit, error };
}

export type BoardDoc = ReturnType<typeof useBoardDoc>;

/** Everyone connected to the board, one entry per person even with several tabs open. */
export function usePeers(provider: HocuspocusProvider | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) return setPeers([]);
    const read = () => {
      const byId = new Map<string, Peer>();
      for (const state of awareness.getStates().values()) {
        const u = state.user as Peer | undefined;
        if (u?.id) byId.set(u.id, u);
      }
      setPeers([...byId.values()]);
    };
    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [provider]);
  return peers;
}

/** Re-renders the caller whenever a shared type changes, local or remote. */
export function useYVersion<T>(type: Y.Map<T> | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!type) return;
    const bump = () => setVersion((v) => v + 1);
    type.observe(bump);
    return () => type.unobserve(bump);
  }, [type]);
  return version;
}
