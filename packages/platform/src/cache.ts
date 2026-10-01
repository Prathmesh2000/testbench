import { Redis } from 'ioredis';

/**
 * Small JSON cache over Valkey. A cache miss or an unreachable cache never fails a request: callers
 * fall back to the database, which is always the source of truth.
 */
export class JsonCache {
  constructor(
    private readonly redis: Redis,
    private readonly log: { warn: (obj: object, msg: string) => void },
  ) {}

  static connect(url: string, log: { warn: (obj: object, msg: string) => void }): JsonCache {
    return new JsonCache(new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false }), log);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      this.log.warn({ err, key }, 'cache read failed');
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.log.warn({ err, key }, 'cache write failed');
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      // A failed invalidation leaves stale data until the TTL expires, which is why every key has one.
      this.log.warn({ err, keys }, 'cache invalidation failed');
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/** Where the runner keeps the latest live frame of a running test item (deploy/runner/src/live.ts). */
export const liveFrameKey = (itemId: string) => `tb:live:${itemId}`;
