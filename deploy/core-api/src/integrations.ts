import type { Integration } from '@tb/contracts';
import { orgTx } from '@tb/iam';
import type { ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import type { AppOptions } from './app';

/**
 * The admin console's Integrations tab: which outside systems this deployment talks to and whether they
 * answer. Lives in the deploy unit because only it knows what was configured.
 */
export const integrationRoutes: FastifyPluginAsync<ServiceDeps & { opts: AppOptions }> = async (
  app,
  { db, opts },
) => {
  app.get('/admin/integrations', async (req): Promise<Integration[]> =>
    orgTx(db, req, 'project.manage', async (trx) => {
      const sync = await trx
        .selectFrom('defect.sync_state')
        .select((eb) => [eb.fn.max('last_run_at').as('last'), eb.fn.max('last_error').as('error')])
        .executeTakeFirst();
      const people = await opts.jira.list(trx);
      const active = people.filter((p) => p.status === 'active').length;
      const searchUp = await opts.index.ping();
      const ai = opts.ai.settings;
      return [
        {
          id: 'jira',
          name: 'Jira Cloud',
          // Each tester connects their own account (Settings → Jira); this only summarises who has.
          detail: people.length
            ? `${active} of ${people.length} connected people active · ${[...new Set(people.map((p) => p.siteUrl))].join(', ')}`
            : 'Nobody has connected Jira yet. Each tester connects their own account in Settings → Jira.',
          state: !people.length ? 'not_configured' : sync?.error || active < people.length ? 'error' : 'connected',
          lastSync: sync?.last ? new Date(sync.last as Date).toISOString() : null,
        },
        {
          id: 'notifications',
          name: 'Notification service',
          detail: opts.notify
            ? 'Email, SMS, Slack, Teams, Discord and in-app'
            : 'Set NOTIFY_URL and NOTIFY_SERVICE_KEY',
          state: opts.notify ? 'connected' : 'not_configured',
          lastSync: null,
        },
        {
          id: 'sso',
          name: 'Single sign-on (OIDC)',
          detail: opts.issuer,
          state: 'connected',
          lastSync: null,
        },
        {
          id: 'ai',
          name: 'AI providers',
          detail:
            ai.mode === 'local'
              ? `Offline · Ollama ${ai.localModel}`
              : ai.mode === 'mock'
                ? 'Recorded responses (mock)'
                : 'OpenAI, Anthropic, xAI',
          state: ai.mode === 'cloud' ? 'connected' : 'local',
          lastSync: null,
        },
        {
          id: 'search',
          name: 'OpenSearch',
          detail: 'TQL search, filters and subscriptions',
          state: searchUp ? 'connected' : 'error',
          lastSync: null,
        },
        {
          id: 'agents',
          name: 'MCP server and Slack bot',
          detail: opts.gatewayUrl ? `${opts.gatewayUrl}/mcp · /slack/commands` : 'Start deploy/agent-gateway',
          state: opts.gatewayUrl ? 'local' : 'not_configured',
          lastSync: null,
        },
      ];
    }),
  );
};
