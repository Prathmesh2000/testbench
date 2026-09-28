import { z } from 'zod';

// Boards and meetings (HLD §5.9): live documents, sheets and whiteboards, and meetings whose notes are
// a live document and whose action items become test cases or tasks.

export const BOARD_KINDS = ['doc', 'sheet', 'whiteboard'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export const BoardBody = z.object({
  kind: z.enum(BOARD_KINDS),
  title: z.string().trim().min(1).max(200),
});

export interface BoardRow {
  id: string;
  kind: BoardKind;
  title: string;
  createdBy: string;
  updatedAt: string;
}

/** A short-lived pass to one board on the collaboration server. */
export interface CollabTicket {
  url: string;
  token: string;
  canEdit: boolean;
  user: { id: string; name: string };
}

export const MeetingBody = z.object({
  title: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }),
  minutes: z.number().int().min(5).max(480),
  attendeeIds: z.array(z.uuid()).max(50).default([]),
  /** What it is about: "RUN-231", "build 8812", "UPI Autopay v3". */
  context: z.string().trim().max(120).optional(),
});

export interface MeetingRow {
  id: string;
  title: string;
  startsAt: string;
  minutes: number;
  context: string | null;
  attendees: { id: string; name: string }[];
  openItems: number;
}

export interface ActionItem {
  id: string;
  text: string;
  assignee: { id: string; name: string } | null;
  status: 'open' | 'done' | 'converted';
  convertedTo: string | null;
  createdAt: string;
}

export interface MeetingDetail extends MeetingRow {
  notesBoardId: string;
  calendar: string;
  actionItems: ActionItem[];
}

export const ActionItemBody = z.object({
  text: z.string().trim().min(1).max(1000),
  assigneeId: z.uuid().nullable().default(null),
});

export const ActionItemPatch = z.object({ status: z.enum(['open', 'done']) });

export const ConvertBody = z.discriminatedUnion('to', [
  z.object({
    to: z.literal('case'),
    moduleId: z.uuid(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  }),
  z.object({ to: z.literal('task') }),
]);
