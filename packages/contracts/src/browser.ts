import { z } from 'zod';
import { FieldRules, Locator, type AutoStep } from './studio';
import type { UiNode, UiScan } from './ui-review';

export { FieldRules };

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
  /** Named keys only (Enter, ArrowDown, Control…); printable text and IME input go as `text`. */
  | { kind: 'keydown' | 'keyup'; key: string }
  | { kind: 'text'; text: string };

/** Files the server can produce on request; each becomes run evidence in the web app. */
export type BrowserArtifact = 'screenshot' | 'logs' | 'trace';

/**
 * One element a picker reports: its ranked locators and enough context to name it. Produced by
 * describeElement in locator-core.ts. In the Test Browser it comes from a page nobody vetted, so it is
 * parsed with this schema before it leaves browser-live.
 */
/** One ranked way to find a picked element; parsed one by one so a single bad one is simply dropped. */
export const PickedLocator = Locator.extend({
  code: z.string().max(2_000),
  matches: z.number().int().min(0),
  /** False when the locator leans on the page's data (a price, a count, a list position). */
  stable: z.boolean().default(true),
});

export const PickedElement = z.object({
  tag: z.string().max(40),
  role: z.string().max(60).nullable(),
  text: z.string().max(200),
  xpath: z.string().max(2_000),
  suggestedName: z.string().max(200),
  page: z.string().max(200),
  url: z.string().max(2_000),
  locators: z.array(PickedLocator).max(30),
});
export type PickedElement = z.infer<typeof PickedElement>;

export const RECORDED_ACTIONS = ['click', 'dblclick', 'type', 'select', 'check', 'uncheck', 'press', 'store'] as const;

/**
 * One action the recorder saw, already cleaned in the page: keystrokes merged into one fill, clicks
 * that only focus a field dropped. A password's value is never captured; `secret` marks where it goes.
 * `store` is the tester saying "remember what this shows": its value is the text at recording time, and
 * the script reads it again at run time into a variable.
 */
// FieldRules lives in studio.ts, beside the page info that keeps it with a saved workflow.


/**
 * One field of the form a submit belongs to, as it stood when the tester submitted: filled or not.
 * A tester types into the fields they need; the test covers the ones they left out too.
 */
export const FormField = z.object({
  element: PickedElement,
  label: z.string().max(200),
  rules: FieldRules,
  /** Only for fields that are not secret; empty when the tester left it empty. */
  value: z.string().max(4_000),
  secret: z.boolean().default(false),
});
export type FormField = z.infer<typeof FormField>;

export const RecordedAction = z.object({
  action: z.enum(RECORDED_ACTIONS),
  /** Null for a key pressed with nothing focused. */
  element: PickedElement.nullable(),
  value: z.string().max(4_000).optional(),
  secret: z.boolean().default(false),
  /** The iframes the element is inside, outermost first; empty on the top-level page. */
  frames: z.array(PickedElement).max(5).default([]),
  /** For fills and selects: the field's validation rules. */
  field: FieldRules.optional(),
  /** On a submit (a click or Enter inside a form or dialog): every field of that form. */
  form: z.array(FormField).max(40).optional(),
});
export type RecordedAction = z.infer<typeof RecordedAction>;

/** One tab of a Test Browser session. */
export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

/** Something that showed up on the page: a message, a dialog, a heading, new text. */
export const ObservedItem = z.object({
  kind: z.enum(['alert', 'status', 'dialog', 'heading', 'text']),
  text: z.string().max(300),
  element: PickedElement,
});
export type ObservedItem = z.infer<typeof ObservedItem>;

const tab = z.string().max(64);

/**
 * One step of a recording, in order. Page actions carry the tab they happened in; the rest come from
 * the browser itself (a tab opened, the address changed, something appeared, a tab closed) or from
 * the pane (`open`). A schema, not just a type: a recording is sent on to core-api to build a test.
 */
export const RecordedStep = z.union([
  RecordedAction.extend({ tab }),
  z.object({ action: z.literal('open'), tab, url: z.string().max(4_000) }),
  z.object({ action: z.literal('navigated'), tab, url: z.string().max(4_000) }),
  z.object({ action: z.literal('history'), tab, go: z.enum(['back', 'forward', 'reload']) }),
  z.object({ action: z.literal('popup'), tab, opener: tab }),
  /** A blank tab the tester opened with +; its first `open` step says where it went. */
  z.object({ action: z.literal('newtab'), tab }),
  z.object({ action: z.literal('close'), tab }),
  /** What appeared on the page within a moment of the action before it: the raw material for checks. */
  z.object({ action: z.literal('observed'), tab, items: z.array(ObservedItem).max(8) }),
  /** The page as recording stopped: where the tester ended up, which the goal is checked against. */
  z.object({ action: z.literal('facts'), tab, url: z.string().max(4_000), title: z.string().max(300), items: z.array(ObservedItem).max(20) }),
  /** An API the page called while recording (XHR or fetch), its address without query or secrets. */
  z.object({ action: z.literal('api'), tab, method: z.string().max(10), url: z.string().max(2_000), status: z.number().int().nullable() }),
]);
export type RecordedStep = z.infer<typeof RecordedStep>;

export type BrowserClientMessage =
  | { t: 'input'; input: BrowserInput }
  | { t: 'navigate'; url: string }
  | { t: 'history'; go: 'back' | 'forward' | 'reload' }
  | { t: 'capture'; id: string; artifact: BrowserArtifact }
  /** Turns the element picker on or off; while on, a click picks instead of acting on the page. */
  | { t: 'pick'; on: boolean }
  /** Turns the recorder on or off; while on, the tester's actions come back as `recorded`. */
  | { t: 'record'; on: boolean }
  /** While recording: the next click stores what the element shows instead of clicking it. */
  | { t: 'store' }
  | { t: 'tab'; action: 'switch' | 'close'; id: string }
  | { t: 'tab'; action: 'new' }
  /**
   * Inspecting a request or the page's storage. `reveal` is the tester explicitly asking to see
   * credential-like values unmasked; without it they arrive masked like everything else.
   */
  | { t: 'request_detail'; id: string; reveal: boolean }
  | { t: 'storage'; reveal: boolean }
  /** Resize every tab's viewport to the pane (the large view), or null to go back to the device profile's. */
  | { t: 'viewport'; size: { width: number; height: number } | null }
  /**
   * Runs saved steps in the active tab: a prerequisite, or a scenario to see what the app does.
   * Steps with components already expanded; secrets are used for this run and never kept.
   */
  | {
      t: 'run_steps';
      id: string;
      steps: AutoStep[];
      data: Record<string, string>;
      secrets: Record<string, string>;
      baseUrl: string;
      /** Reload the page first, so nothing a run before left on it (a toast, an open dialog) is seen as this run's. */
      fresh?: boolean;
    }
  /** UI review: reads the active tab as a tree of elements, with accessibility checks and timings. */
  | { t: 'ui_scan'; id: string }
  /** UI review: the element under the pointer, in page coordinates, outlined in the page. */
  | { t: 'ui_at'; x: number; y: number }
  /** UI review: outlines a scanned element in the page (null clears it), scrolling to it if asked. */
  | { t: 'ui_highlight'; node: number | null; scroll: boolean };

export type BrowserServerMessage =
  | { t: 'ready'; width: number; height: number }
  /** One JPEG frame of the page, base64. */
  | { t: 'frame'; data: string }
  | { t: 'page'; url: string; title: string }
  /** `blocked`: the site's bot protection answered with a challenge instead of the page. */
  | { t: 'signal'; kind: 'console_error' | 'request_failed' | 'blocked'; text: string }
  | { t: 'tabs'; tabs: BrowserTab[]; active: string }
  /** One finished or failed request of any kind (the pane filters by type), URL already masked. */
  | { t: 'network'; tab: string; entry: NetworkEntry }
  /** Null when the browser no longer has that request (the tab closed, or it fell out of the log). */
  | { t: 'request_detail'; id: string; detail: RequestDetail | null }
  | { t: 'storage'; snapshot: StorageSnapshot }
  | { t: 'run_step'; id: string; index: number; ok: boolean; error: string | null }
  /** A run of saved steps ended: at `failedAt` if a step could not be done, and what the page shows now. */
  | {
      t: 'run_done';
      id: string;
      ok: boolean;
      failedAt: number | null;
      error: string | null;
      /** Why the failed step could not be done, when it is one a test can expect: disabled, or not there. */
      blocked: 'disabled' | 'missing' | null;
      snapshot: PageSnapshot | null;
      /** The APIs the page called during the run, in order. */
      apis?: Array<{ method: string; path: string; status: number | null }>;
    }
  /** What a page the Test Browser reached is made of, for the project's site map. */
  | { t: 'page_context'; context: PageContext }
  | { t: 'artifact'; id: string; fileName: string; contentType: string; data: string }
  | { t: 'ui_scan'; id: string; scan: UiScan | null; error: string | null }
  /** Null when the pointer is over nothing (the page's margin, or a frame). */
  | { t: 'ui_at'; node: UiNode | null }
  | { t: 'hover' | 'picked'; element: PickedElement }
  | { t: 'recorded'; step: RecordedStep }
  /** Sent after the last `recorded` of a recording, so the pane knows the script is complete. */
  | { t: 'record_stopped' }
  | { t: 'error'; message: string }
  | { t: 'closed'; reason: string };

/** One captured network request, masked, as saved in the session's network log. */
export interface NetworkEntry {
  /** Stable for the session: the pane asks for a request's details with it. */
  id: string;
  /** When the response finished (or the request failed). */
  at: string;
  /** When the page sent it: the order requests were made in, which finish times do not show. */
  startedAt: string | null;
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

/** Time spent in each phase of a request, in milliseconds; a phase that did not happen is 0. */
export interface RequestTiming {
  dns: number;
  connect: number;
  tls: number;
  /** Time to first byte, after the request was sent. */
  wait: number;
  download: number;
}

/** Everything the Network tab shows for one request, as DevTools does. Masked unless `masked` is false. */
export interface RequestDetail {
  url: string;
  method: string;
  status: number | null;
  statusText: string;
  resourceType: string;
  remoteAddress: string | null;
  /** In the order the browser sent or received them; a header may repeat (set-cookie). */
  requestHeaders: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  postData: string | null;
  /** The response as text when it is text (JSON, HTML, JS…), cut at 200 KB. */
  body: string | null;
  /** Why there is no body to show: binary, too large, or no longer held by the browser. */
  bodyNote: string | null;
  contentType: string | null;
  timing: RequestTiming | null;
  /** WebSocket frames, newest last, for a `websocket` entry. */
  messages: Array<{ dir: 'sent' | 'received'; at: string; data: string }>;
  masked: boolean;
}

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

/** The active tab's storage: every cookie in the session, and the page's own local and session storage. */
export interface StorageSnapshot {
  origin: string;
  cookies: StorageCookie[];
  local: Array<[string, string]>;
  session: Array<[string, string]>;
  masked: boolean;
}

/** What a page shows at a moment: where it is, and what it says about the last action. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Open dialogs, by their name or heading. */
  dialogs: string[];
  /** Messages, alerts and toasts on screen. */
  messages: string[];
  /** Inline errors: the browser's own validation message, or error text the app shows by the field. */
  fieldErrors: Array<{ field: string; message: string; source: 'native' | 'page' }>;
  /** What the app keeps in the browser now; values masked where they look secret. */
  storage?: Array<{ area: 'cookie' | 'local' | 'session'; key: string; value: string }>;
}

/**
 * A page as the Test Browser found it: its headings, what can be pressed (and where links lead), its
 * fields and their rules, and the APIs it called. Sent on every page reached, to build the site map.
 */
export interface PageContext {
  url: string;
  title: string;
  headings: string[];
  actions: Array<{ label: string; role: 'button' | 'link' | 'tab' | 'menuitem'; href: string | null }>;
  fields: Array<{ label: string; rules: FieldRules }>;
  apis: Array<{ method: string; path: string; status: number | null }>;
}
