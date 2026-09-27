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
  /** Minutes between reconcile passes (HLD §5.4). */
  JIRA_RECONCILE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
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
