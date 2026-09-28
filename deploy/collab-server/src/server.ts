import { fileURLToPath } from 'node:url';
import { Database } from '@hocuspocus/extension-database';
import { Server } from '@hocuspocus/server';
import {
  createDb,
  loadEnvFileIfPresent,
  verifyCollabTicket,
  withTenant,
  type CollabClaims,
} from '@tb/platform';
import { z } from 'zod';

// The collaboration server (HLD §5.9): Hocuspocus syncing Yjs documents for live boards and meeting
// notes. It trusts nothing but tickets signed by core-api, which already checked who may open which
// board, and stores each document in Postgres under that board's organisation.

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const cfg = z
  .object({
    COLLAB_PORT: z.coerce.number().int().default(4300),
    COLLAB_SECRET: z.string().min(32),
    DATABASE_URL: z.url(),
  })
  .parse(process.env);

const db = createDb(cfg.DATABASE_URL, 5);

const server = new Server<CollabClaims>({
  port: cfg.COLLAB_PORT,
  // Edits are stored a couple of seconds after typing pauses, not on every keystroke.
  debounce: 2000,
  maxDebounce: 10_000,
  async onAuthenticate({ token, documentName, connectionConfig }) {
    const claims = verifyCollabTicket(cfg.COLLAB_SECRET, token);
    // A ticket opens exactly one board: the document name must be the board it was issued for.
    if (!claims || claims.board !== documentName) throw new Error('Not allowed');
    connectionConfig.readOnly = !claims.canEdit;
    return claims;
  },
  extensions: [
    new Database({
      async fetch({ documentName, context }) {
        const row = await withTenant(db, { orgId: context.org, userId: context.user }, (trx) =>
          trx
            .selectFrom('collab.board_state')
            .select('state')
            .where('board_id', '=', documentName)
            .executeTakeFirst(),
        );
        return row ? new Uint8Array(row.state) : null;
      },
      // The last editor's ticket names the organisation; every connection to one board shares it.
      async store({ documentName, state, lastContext: context }) {
        await withTenant(db, { orgId: context.org, userId: context.user }, async (trx) => {
          await trx
            .insertInto('collab.board_state')
            .values({ board_id: documentName, org_id: context.org, state: Buffer.from(state) })
            .onConflict((oc) =>
              oc.column('board_id').doUpdateSet({ state: Buffer.from(state), updated_at: new Date() }),
            )
            .execute();
          await trx
            .updateTable('collab.board')
            .set({ updated_at: new Date() })
            .where('id', '=', documentName)
            .execute();
        });
      },
    }),
  ],
});

await server.listen();
