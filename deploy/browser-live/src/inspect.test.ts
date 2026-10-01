import { describe, expect, it } from 'vitest';
import { clip, isTextual, phases } from './inspect';

describe('inspect helpers', () => {
  it('shows text types as text and leaves binaries out', () => {
    for (const t of ['application/json; charset=utf-8', 'text/html', 'application/javascript', 'image/svg+xml', 'application/x-www-form-urlencoded'])
      expect(isTextual(t)).toBe(true);
    for (const t of ['image/png', 'font/woff2', 'application/octet-stream', null]) expect(isTextual(t)).toBe(false);
  });

  it('cuts long bodies and says so', () => {
    expect(clip('abcdef', 3)).toBe('abc\n… cut at 0 KB of 0 KB');
    expect(clip('abc', 3)).toBe('abc');
  });

  it('turns timing marks into phases, zero for what did not happen', () => {
    expect(
      phases({ domainLookupStart: 1, domainLookupEnd: 11, connectStart: 11, secureConnectionStart: 30, connectEnd: 60, requestStart: 61, responseStart: 161, responseEnd: 181 }),
    ).toEqual({ dns: 10, connect: 19, tls: 30, wait: 100, download: 20 });
    expect(
      phases({ domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1, requestStart: 0, responseStart: 40, responseEnd: 45 }),
    ).toEqual({ dns: 0, connect: 0, tls: 0, wait: 40, download: 5 });
  });
});
