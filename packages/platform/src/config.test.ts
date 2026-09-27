import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const valid = {
  DATABASE_URL: 'postgres://tb_app:x@localhost:5433/testbench',
  VALKEY_URL: 'redis://localhost:6379',
  OIDC_ISSUER: 'http://localhost:8080/realms/testbench',
  OIDC_AUDIENCE: 'core-api',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ap-south-1',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  S3_BUCKET: 'evidence',
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const cfg = loadConfig(valid);
    expect(cfg.CORE_API_PORT).toBe(4000);
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('coerces the port from a string', () => {
    expect(loadConfig({ ...valid, CORE_API_PORT: '4100' }).CORE_API_PORT).toBe(4100);
  });

  it('lists every problem at once', () => {
    const { DATABASE_URL: _db, S3_BUCKET: _bucket, ...rest } = valid;
    expect(() => loadConfig({ ...rest, VALKEY_URL: 'not a url' })).toThrowError(
      /DATABASE_URL[\s\S]*VALKEY_URL[\s\S]*S3_BUCKET|DATABASE_URL[\s\S]*S3_BUCKET[\s\S]*VALKEY_URL/,
    );
  });
});
