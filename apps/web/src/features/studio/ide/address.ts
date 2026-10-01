/**
 * What the Site pane's address bar opens, read the way Chrome's omnibox reads it: a full URL as is, a
 * host ("google.com", "localhost:3000", an IP) with https:// or http:// added, and anything else as a
 * search. Bing, not Google: Google answers searches from a server-side browser with a CAPTCHA page,
 * Bing serves the results. Only http(s) ever comes out, so the Test Browser's scheme check still holds.
 */
export function toAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s/]+:\d+/.test(text)) return null; // javascript:, file:, …
  const host = text.split(/[/?#]/)[0]!;
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(host);
  if (!/\s/.test(text) && (local || /^[^.\s]+(\.[^.\s]+)+(:\d+)?$/.test(host))) return `${local ? 'http' : 'https'}://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
