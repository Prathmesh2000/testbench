import { describe, expect, it } from 'vitest';
import { isBlockedHost, isPrivateAddress } from './net-guard';

describe('isPrivateAddress', () => {
  it('blocks loopback, private, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.255.255', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('blocks local hostnames without a DNS lookup', async () => {
    expect(await isBlockedHost('localhost')).toBe(true);
    expect(await isBlockedHost('metadata.google.internal')).toBe(true);
    expect(await isBlockedHost('[::1]')).toBe(true);
  });
});
