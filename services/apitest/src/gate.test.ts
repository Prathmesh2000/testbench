import { describe, expect, it } from 'vitest';
import { decide, dnsName, dnsValue, fileUrl, hostKey, proveTarget, type Prover } from './gate';

const base = { host: 'api.shop.test', local: false, verified: true, production: false, override: false, canOverride: false };

describe('hostKey', () => {
  it('compares hosts the same way everywhere', () => {
    expect(hostKey('https://API.Shop.test/orders?x=1')).toBe('api.shop.test');
    expect(hostKey('https://api.shop.test:8443/x')).toBe('api.shop.test:8443');
    expect(hostKey('http://localhost:4000')).toBe('localhost:4000');
    expect(hostKey('https://api.shop.test:443/')).toBe('api.shop.test');
  });
});

describe('decide', () => {
  it('lets a verified host through, and refuses an unverified one with the reason', () => {
    expect(decide(base)).toEqual({ ok: true, via: 'verified', overridden: false });
    expect(decide({ ...base, verified: false })).toMatchObject({ ok: false, code: 'unverified' });
  });

  it('needs no proof for a local development host', () => {
    expect(decide({ ...base, host: 'localhost:4000', local: true, verified: false })).toEqual({ ok: true, via: 'local', overridden: false });
  });

  it('refuses production without an override, and without an admin to give it', () => {
    expect(decide({ ...base, production: true })).toMatchObject({ ok: false, code: 'production' });
    expect(decide({ ...base, production: true, override: true, canOverride: false })).toMatchObject({ ok: false, code: 'production', reason: expect.stringContaining('admin') });
    expect(decide({ ...base, production: true, override: true, canOverride: true })).toEqual({ ok: true, via: 'verified', overridden: true });
  });

  it('still requires proof at production, and for local hosts at production the override', () => {
    expect(decide({ ...base, production: true, override: true, canOverride: true, verified: false })).toMatchObject({ ok: false, code: 'unverified' });
    expect(decide({ ...base, local: true, verified: false, production: true })).toMatchObject({ ok: false, code: 'production' });
  });
});

describe('proof', () => {
  const target = { host: 'api.shop.test:8443', token: 'abc123' };
  const prover = (txt: string[], files: Record<string, string>): Prover => ({ txt: async () => txt, fetchText: async (u) => files[u] ?? null });

  it('names what to publish', () => {
    expect(dnsName(target.host)).toBe('_testbench-challenge.api.shop.test');
    expect(dnsValue('abc')).toBe('testbench-verify=abc');
    expect(fileUrl(target.host, true)).toBe('https://api.shop.test:8443/.well-known/testbench-verify.txt');
  });

  it('accepts the exact DNS value or the exact file content, and nothing near it', async () => {
    expect(await proveTarget(prover(['v=spf1', 'testbench-verify=abc123'], {}), target, 'dns')).toBe(true);
    expect(await proveTarget(prover(['testbench-verify=abc12'], {}), target, 'dns')).toBe(false);
    expect(await proveTarget(prover([], { [fileUrl(target.host, true)]: 'abc123\n' }), target, 'file')).toBe(true);
    expect(await proveTarget(prover([], { [fileUrl(target.host, true)]: 'nope' }), target, 'file')).toBe(false);
    expect(await proveTarget(prover([], {}), target, 'file')).toBe(false);
  });

  it('can fall back to http for the file when the host has no TLS', async () => {
    const p = prover([], { [fileUrl(target.host, false)]: 'abc123' });
    expect(await proveTarget(p, target, 'file')).toBe(false);
    expect(await proveTarget(p, target, 'file', ['https', 'http'])).toBe(true);
  });
});
