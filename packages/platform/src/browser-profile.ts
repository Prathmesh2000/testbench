// How Testbench's browsers (the Test Browser and the automation runner) present themselves, so a site
// sees an ordinary Chrome and behaves as it would for a tester. Sites that fingerprint automation
// check for mismatches: navigator.webdriver, a "HeadlessChrome" user agent, a Windows user agent on a
// Linux platform, a UTC clock behind an Indian IP. Each of those is fixed here, in one place.
// This does not defeat CAPTCHAs or challenge pages; a site that shows one should allowlist the Test
// Browser on its staging environment.

/** Removes the automation flag that sets navigator.webdriver and marks the browser as controlled. */
export const BROWSER_ARGS = ['--disable-blink-features=AutomationControlled'];

/** Testbench shows every time in IST, and its testers are in India; the browser matches. */
export const BROWSER_LOCALE = 'en-IN';
export const BROWSER_TIMEZONE = 'Asia/Kolkata';

/**
 * A desktop user agent for the Chrome that is actually running, on the platform it runs on (Linux in
 * a container). The version comes from Playwright's own device profile, which tracks the bundled
 * browser, so the user agent and the client-hint headers Chrome sends always agree.
 */
export function desktopUserAgent(profileUserAgent: string): string {
  const major = /Chrome\/(\d+)/.exec(profileUserAgent)?.[1] ?? '140';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
