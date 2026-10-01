import { describe, expect, it } from 'vitest';
import { desktopUserAgent } from './browser-profile';

describe('desktopUserAgent', () => {
  it('keeps the running Chrome major version and states the real platform, without Headless', () => {
    const ua = desktopUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36');
    expect(ua).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    expect(ua).not.toContain('Headless');
  });
});
