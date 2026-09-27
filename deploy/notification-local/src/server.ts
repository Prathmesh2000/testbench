import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { notificationApi, Queues, Senders, startWorkers, Store } from '@tb/notification';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';

// The notification service as one local process: the HTTP API and every channel worker. In AWS the
// API runs behind API Gateway and each queue has its own Lambda; both call the same handlers.

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const cfg = z
  .object({
    NOTIFY_PORT: z.coerce.number().int().default(4100),
    NOTIFY_SERVICE_KEY: z.string().min(24),
    AWS_REGION: z.string().default('ap-south-1'),
    DYNAMODB_ENDPOINT: z.url().optional(),
    SQS_ENDPOINT: z.url().optional(),
    NOTIFY_TABLE: z.string().default('notify'),
    NOTIFY_QUEUE_PREFIX: z.string().default('notify'),
    SMTP_URL: z.string().min(1),
    NOTIFY_EMAIL_FROM: z.string().min(3),
    SMS_SANDBOX_URL: z.url().optional(),
    SMS_ORIGINATION_IDENTITY: z.string().optional(),
    NOTIFY_ALLOW_LOCAL_TARGETS: z.enum(['true', 'false']).default('false'),
    LOG_LEVEL: z.string().default('info'),
  })
  .parse(process.env);

const app = Fastify({
  logger: { level: cfg.LOG_LEVEL, redact: ['req.headers.authorization'] },
  bodyLimit: 256 * 1024,
});
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

const store = Store.create({
  endpoint: cfg.DYNAMODB_ENDPOINT,
  region: cfg.AWS_REGION,
  table: cfg.NOTIFY_TABLE,
});
await store.ensureTable();
const deps = {
  store,
  queues: Queues.create({
    endpoint: cfg.SQS_ENDPOINT,
    region: cfg.AWS_REGION,
    prefix: cfg.NOTIFY_QUEUE_PREFIX,
  }),
  senders: new Senders({
    smtpUrl: cfg.SMTP_URL,
    emailFrom: cfg.NOTIFY_EMAIL_FROM,
    smsSandboxUrl: cfg.SMS_SANDBOX_URL,
    smsOriginationIdentity: cfg.SMS_ORIGINATION_IDENTITY,
    region: cfg.AWS_REGION,
  }),
  log: app.log,
};
await app.register(notificationApi, {
  ...deps,
  serviceKey: cfg.NOTIFY_SERVICE_KEY,
  allowLocalTargets: cfg.NOTIFY_ALLOW_LOCAL_TARGETS === 'true',
});
const stopWorkers = startWorkers(deps);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await stopWorkers();
    process.exit(0);
  });
}
await app.listen({ port: cfg.NOTIFY_PORT, host: '0.0.0.0' });
