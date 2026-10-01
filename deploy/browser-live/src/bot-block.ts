/**
 * Whether a page load was answered by a site's bot protection rather than the site: a challenge page
 * (Cloudflare, Akamai, DataDome, PerimeterX, Imperva) or a connection the edge cut off. Testers
 * otherwise see a blank or odd page and assume Testbench is broken; this lets the pane say why.
 */
export function blockedBy(res: { status: number; headers: Record<string, string> } | { failure: string }): string | null {
  if ('failure' in res) {
    // Akamai and others reset the connection instead of answering an unwelcome client.
    return /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(res.failure) ? 'the site' : null;
  }
  if (![401, 403, 429, 503].includes(res.status)) return null;
  const h = res.headers;
  if (h['cf-mitigated'] || (h.server ?? '').toLowerCase() === 'cloudflare') return 'Cloudflare';
  if ((h.server ?? '').includes('AkamaiGHost')) return 'Akamai';
  if (h['x-datadome'] || h['x-dd-b']) return 'DataDome';
  if (Object.keys(h).some((k) => k.startsWith('x-px'))) return 'PerimeterX';
  if (h['x-iinfo'] || h['x-cdn'] === 'Imperva') return 'Imperva';
  return null;
}

export function blockedMessage(by: string): string {
  return `${by === 'the site' ? 'The site' : `${by} on this site`} blocked the Test Browser as automated traffic. ` +
    'Ask the team to allowlist the Test Browser on the environment you test (staging), or use Embedded mode.';
}

/**
 * A page that is itself a "prove you are human" check. The tester can solve it in the pane (they are
 * a person); the message says so, so a CAPTCHA is not mistaken for Testbench being stuck.
 */
export function challengePage(url: string): string | null {
  if (/^https?:\/\/(www\.)?google\.[a-z.]+\/sorry\//i.test(url)) return 'Google';
  if (/\/cdn-cgi\/challenge-platform\//.test(url)) return 'Cloudflare';
  return null;
}

export function challengeMessage(by: string): string {
  return `${by} is asking to confirm this is a person. Solve the check in the pane to carry on` +
    (by === 'Google' ? ', or type words in the address bar to search with Bing, which does not ask.' : '.');
}

/**
 * A frame that belongs to a CAPTCHA widget. What a tester does in one (ticking the box, picking
 * images) is a person proving themselves and can never replay, so it is not recorded.
 */
export function isChallengeFrame(url: string): boolean {
  return /\/\/([a-z0-9-]+\.)*(google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com)/i.test(url);
}
