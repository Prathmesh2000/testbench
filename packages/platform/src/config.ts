import { existsSync } from 'node:fs';
import { z } from 'zod';

const Config = z.object({
  DATABASE_URL: z.url(),
  VALKEY_URL: z.url(),
  OIDC_ISSUER: z.url(),
  OIDC_AUDIENCE: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(3),
  CORE_API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  OPENSEARCH_URL: z.url(),
  /** Public URL of the web app, used for links in Jira issues. */
  WEB_URL: z.url(),
  // Jira is optional: without it the defect screens explain that Jira is not connected.
  JIRA_BASE_URL: z.url().optional(),
  JIRA_EMAIL: z.string().min(1).optional(),
  JIRA_API_TOKEN: z.string().min(1).optional(),
  JIRA_WEBHOOK_SECRET: z.string().min(16).optional(),
  // The notification service (optional, like Jira): without it, notifications are simply not sent.
  NOTIFY_URL: z.url().optional(),
  NOTIFY_SERVICE_KEY: z.string().min(24).optional(),
  /** Minutes between reconcile passes (HLD §5.4). */
  JIRA_RECONCILE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  // AI provider layer (HLD §2.3, §10.3). `mock` answers from recorded responses so tests never
  // depend on a model; `local` sends everything to Ollama; `cloud` uses the providers below.
  AI_MODE: z.enum(['mock', 'local', 'cloud']).default('mock'),
  OLLAMA_BASE_URL: z.url().default('http://localhost:11434'),
  AI_LOCAL_MODEL: z.string().min(1).default('qwen3:4b'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  XAI_API_KEY: z.string().min(1).optional(),
  AI_OPENAI_MODEL: z.string().min(1).default('gpt-5-mini'),
  AI_ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  AI_XAI_MODEL: z.string().min(1).default('grok-4'),
  /** Encrypts tenant API keys at rest (KMS in AWS). Without it, tenants can't bring their own keys. */
  AI_KEY_SECRET: z.string().min(32).optional(),
  // Keycloak admin API, used to create accounts for invited people. Optional: with SSO the identity
  // provider owns accounts and an invitation only adds the Testbench membership.
  KEYCLOAK_ADMIN_URL: z.url().optional(),
  KEYCLOAK_REALM: z.string().min(1).default('testbench'),
  KEYCLOAK_ADMIN_USER: z.string().min(1).optional(),
  KEYCLOAK_ADMIN_PASSWORD: z.string().min(1).optional(),
  // Live boards: core-api signs tickets for the collaboration server with this shared secret.
  COLLAB_URL: z
    .string()
    .regex(/^wss?:\/\//)
    .default('ws://localhost:4300'),
  COLLAB_SECRET: z.string().min(32).optional(),
  /** Calendar invites for meetings; locally the provider sandbox records them. */
  CALENDAR_URL: z.url().optional(),
  /** The agent gateway (MCP + Slack), shown in the admin console when set. */
  AGENT_GATEWAY_URL: z.url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});
export type Config = z.infer<typeof Config>;

/**
 * Reads and validates configuration once at startup. A missing or malformed value stops the process with
 * every problem listed together, instead of surfacing later as a confusing runtime error on first use.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

/** Loads a .env file into process.env when it exists (local development). Existing variables win. */
export function loadEnvFileIfPresent(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
