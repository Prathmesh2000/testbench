import { describe, expect, it } from 'vitest';
import { blockedBy, challengePage, isChallengeFrame } from './bot-block';

describe('blockedBy', () => {
  it('recognises challenge pages by their edge headers', () => {
    expect(blockedBy({ status: 403, headers: { 'cf-mitigated': 'challenge' } })).toBe('Cloudflare');
    expect(blockedBy({ status: 403, headers: { server: 'AkamaiGHost' } })).toBe('Akamai');
    expect(blockedBy({ status: 403, headers: { 'x-datadome': 'protected' } })).toBe('DataDome');
  });

  it('treats a reset connection on the page itself as a block', () => {
    expect(blockedBy({ failure: 'net::ERR_HTTP2_PROTOCOL_ERROR' })).toBe('the site');
    expect(blockedBy({ failure: 'net::ERR_NAME_NOT_RESOLVED' })).toBeNull();
  });

  it('leaves ordinary errors alone', () => {
    expect(blockedBy({ status: 404, headers: { server: 'cloudflare' } })).toBeNull();
    expect(blockedBy({ status: 403, headers: { server: 'nginx' } })).toBeNull();
    expect(blockedBy({ status: 200, headers: { 'cf-mitigated': 'challenge' } })).toBeNull();
  });
});

describe('challengePage', () => {
  it('spots the CAPTCHA pages testers run into', () => {
    expect(challengePage('https://www.google.com/sorry/index?continue=x')).toBe('Google');
    expect(challengePage('https://www.google.co.in/sorry/index')).toBe('Google');
    expect(challengePage('https://shop.test/cdn-cgi/challenge-platform/h/b')).toBe('Cloudflare');
    expect(challengePage('https://www.google.com/search?q=sorry')).toBeNull();
  });
});

describe('isChallengeFrame', () => {
  it('knows CAPTCHA widgets, and nothing else', () => {
    expect(isChallengeFrame('https://www.google.com/recaptcha/api2/bframe?hl=en')).toBe(true);
    expect(isChallengeFrame('https://newassets.hcaptcha.com/captcha/v1/x')).toBe(true);
    expect(isChallengeFrame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x')).toBe(true);
    expect(isChallengeFrame('https://www.google.com/maps/embed')).toBe(false);
    expect(isChallengeFrame('https://pay.example.com/frame')).toBe(false);
  });
});
