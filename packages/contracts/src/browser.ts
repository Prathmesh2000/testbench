import { z } from 'zod';

// Test Browser (testing-studio-plan §3): a real browser on the server, streamed into the app. The web
// app starts a session through core-api, then talks to the browser-live server over one WebSocket.

/** Device profiles offered in the picker; names match Playwright's built-in device list. */
export const BROWSER_DEVICES = ['Desktop Chrome', 'Desktop Chrome HiDPI', 'iPhone 15', 'Pixel 7', 'iPad Pro 11'] as const;
export type BrowserDevice = (typeof BROWSER_DEVICES)[number];

export const StartSessionBody = z.object({
  url: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/, message: 'Use a web address starting with http:// or https://' })),
  device: z.enum(BROWSER_DEVICES).default('Desktop Chrome'),
  /** The run item being executed, so the session's evidence lands on it. */
  runItemId: z.uuid().optional(),
});

export interface BrowserSession {
  id: string;
  /** WebSocket address of the browser-live server. */
  wsUrl: string;
  /** Single-session pass for that server; expires with the session's maximum length. */
  ticket: string;
  device: BrowserDevice;
  url: string;
}

/** What core-api signs and browser-live checks. */
export interface BrowserClaims {
  session: string;
  org: string;
  user: string;
  url: string;
  device: BrowserDevice;
  /** Expiry, epoch seconds. */
  exp: number;
}

// ---------- WebSocket protocol ----------

export type BrowserInput =
  | { kind: 'mousemove' | 'mousedown' | 'mouseup'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { kind: 'wheel'; x: number; y: number; deltaY: number }
  | { kind: 'keydown' | 'keyup'; key: string };

/** Files the server can produce on request; each becomes run evidence in the web app. */
export type BrowserArtifact = 'screenshot' | 'logs' | 'trace';

export type BrowserClientMessage =
  | { t: 'input'; input: BrowserInput }
  | { t: 'navigate'; url: string }
  | { t: 'history'; go: 'back' | 'forward' | 'reload' }
  | { t: 'capture'; id: string; artifact: BrowserArtifact };

export type BrowserServerMessage =
  | { t: 'ready'; width: number; height: number }
  /** One JPEG frame of the page, base64. */
  | { t: 'frame'; data: string }
  | { t: 'page'; url: string; title: string }
  | { t: 'signal'; kind: 'console_error' | 'request_failed'; text: string }
  | { t: 'artifact'; id: string; fileName: string; contentType: string; data: string }
  | { t: 'error'; message: string }
  | { t: 'closed'; reason: string };

/** One captured network request, masked, as saved in the session's network log. */
export interface NetworkEntry {
  at: string;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  durationMs: number | null;
  failure: string | null;
}

export interface ConsoleEntry {
  at: string;
  type: string;
  text: string;
}
