import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RunItemRow, RunSummary } from '@tb/contracts';
import { decryptSecret, encryptSecret, type JsonCache } from '@tb/platform';
import { CoreClient, CoreError } from './core';

// The Slack bot's slash command, /tcm (HLD §5.8). People link their Slack account once with a
// personal access token (/tcm login tbp_…); every later command runs as them through core-api.

/**
 * Slack signs each request with the app's signing secret: v0=HMAC-SHA256("v0:<timestamp>:<body>").
 * Requests older than five minutes are refused so a captured one can't be replayed later.
 */
export function verifySlackSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Command =
  | { kind: 'help' }
  | { kind: 'login'; token: string }
  | { kind: 'logout' }
  | { kind: 'status'; run: string; project?: string }
  | { kind: 'run'; type: 'smoke' | 'regression'; project?: string; build?: string }
  | { kind: 'unknown'; text: string };

/** "/tcm run smoke PAY 8812" → { kind: 'run', type: 'smoke', project: 'PAY', build: '8812' }. */
export function parseCommand(text: string): Command {
  const [verb = '', ...args] = text.trim().split(/\s+/).filter(Boolean);
  switch (verb.toLowerCase()) {
    case '':
    case 'help':
      return { kind: 'help' };
    case 'login':
      return args[0]?.startsWith('tbp_') ? { kind: 'login', token: args[0] } : { kind: 'unknown', text };
    case 'logout':
      return { kind: 'logout' };
    case 'status':
      return args[0] && /^RUN-\d+$/i.test(args[0])
        ? { kind: 'status', run: args[0].toUpperCase(), project: args[1] }
        : { kind: 'unknown', text };
    case 'run': {
      const type = args[0]?.toLowerCase();
      if (type !== 'smoke' && type !== 'regression') return { kind: 'unknown', text };
      return { kind: 'run', type, project: args[1], build: args[2] };
    }
    default:
      return { kind: 'unknown', text };
  }
}

const HELP = [
  '*Testbench commands*',
  '`/tcm login tbp_…` link your Slack account (create a token in Testbench → Settings → Access tokens)',
  '`/tcm status RUN-88 [PROJECT]` progress of a run',
  '`/tcm run smoke|regression PROJECT [build]` start a run from the cases labelled smoke or regression',
  '`/tcm logout` unlink',
].join('\n');

export interface SlackReply {
  response_type: 'ephemeral' | 'in_channel';
  text: string;
}
const reply = (text: string, visible = false): SlackReply => ({
  response_type: visible ? 'in_channel' : 'ephemeral',
  text,
});

export interface SlackDeps {
  cache: JsonCache;
  coreUrl: string;
  tokenSecret: string;
  webUrl: string;
}

// ponytail: links live in Valkey without expiry; move them to Postgres if Valkey stops being durable.
const linkKey = (team: string, user: string) => `slack-link:${team}:${user}`;

export async function handleCommand(
  deps: SlackDeps,
  team: string,
  user: string,
  text: string,
): Promise<SlackReply> {
  const cmd = parseCommand(text);
  if (cmd.kind === 'help') return reply(HELP);
  if (cmd.kind === 'unknown') return reply(`I didn't understand "${cmd.text}".\n${HELP}`);
  if (cmd.kind === 'logout') {
    await deps.cache.del(linkKey(team, user));
    return reply(
      'Unlinked. Your Testbench token still exists; revoke it in Settings if you no longer need it.',
    );
  }
  if (cmd.kind === 'login') {
    const core = new CoreClient(deps.coreUrl, cmd.token, 'slack');
    const me = await core.whoami().catch(() => null);
    if (!me) return reply('That token did not work. Check it has not expired or been revoked.');
    // A year, like the longest token; the token's own expiry is what really ends access.
    await deps.cache.set(linkKey(team, user), encryptSecret(deps.tokenSecret, cmd.token), 365 * 86_400);
    return reply(`Linked to ${me.user.name} (${me.org.name}). Try \`/tcm status RUN-1\`.`);
  }

  const stored = await deps.cache.get<string>(linkKey(team, user));
  if (!stored) return reply('Link your account first: `/tcm login tbp_…`');
  const core = new CoreClient(deps.coreUrl, decryptSecret(deps.tokenSecret, stored), 'slack');
  try {
    const project = await core.project(cmd.project);
    if (cmd.kind === 'status') {
      const runs = await core.get<RunSummary[]>(`/projects/${project.id}/runs`);
      const run = runs.find((r) => r.key === cmd.run);
      if (!run) return reply(`No ${cmd.run} in ${project.key}.`);
      const items = await core.get<RunItemRow[]>(`/projects/${project.id}/runs/${run.id}/items`);
      const failed = items.filter((i) => i.status === 'failed').slice(0, 5);
      const c = run.counts;
      const done = c.total - c.untested;
      return reply(
        [
          `*${run.key}* ${run.name} · build ${run.build} · ${run.status}`,
          `${done}/${c.total} done · ✅ ${c.passed} · ❌ ${c.failed} · ⛔ ${c.blocked} · ⏭ ${c.skipped}`,
          ...failed.map((i) => `❌ ${i.caseKey} ${i.title}`),
          `<${deps.webUrl}/runs/${run.id}|Open in Testbench>`,
        ].join('\n'),
        true,
      );
    }
    const { keys } = await core.call<{ keys: string[] }>('POST', `/projects/${project.id}/search/keys`, {
      tql: `label = ${cmd.type} AND status = ready`,
    });
    if (!keys.length) return reply(`No Ready cases labelled ${cmd.type} in ${project.key}.`);
    const run = await core.call<RunSummary>('POST', `/projects/${project.id}/runs`, {
      name: `${cmd.type === 'smoke' ? 'Smoke' : 'Regression'} from Slack${cmd.build ? ` — build ${cmd.build}` : ''}`,
      type: cmd.type,
      environment: 'Staging-IN',
      build: cmd.build ?? 'latest',
      configs: ['Chrome 128 · Win 11'],
      filter: { keys: keys.slice(0, 5000) },
    });
    return reply(
      `Started *${run.key}* with ${run.counts.total} items. <${deps.webUrl}/runs/${run.id}|Open it>`,
      true,
    );
  } catch (err) {
    return reply(err instanceof CoreError ? err.message : 'Something went wrong talking to Testbench.');
  }
}
