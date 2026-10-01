import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveFrame } from '@tb/contracts';
import { liveFrameKey, maskText, maskValue, type JsonCache } from '@tb/platform';

// Watching a run as it happens. The test process shows its own page into its own working folder
// (a frame a few times a second, and the step it is on); the runner publishes the latest of each to
// Valkey, where core-api serves it to people allowed to see the run. Nothing is kept afterwards: the
// entry expires, and the evidence (screenshots, video, trace) is what stays.
//
// No debugging port is opened for this. A port, even on 127.0.0.1, could be reached by another test on
// the same runner, and workspace specs are arbitrary code from any organisation.

export const LIVE_TTL_S = 15;
const FRAME_FILE = 'live-frame.b64';
const STEP_FILE = 'live-step.json';

/**
 * Loaded by generated specs: from each test's first moment, its page (and any tab it opens, the
 * newest winning) is screencast into FRAME_FILE, at most three frames a second.
 */
export const LIVE_HOOK = `import { test } from '@playwright/test';
import { renameSync, writeFileSync } from 'node:fs';

test.beforeEach(async ({ context, page }) => {
  let last = 0;
  const watch = async (p: typeof page) => {
    try {
      const cdp = await context.newCDPSession(p);
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (Date.now() - last < 330) return;
        last = Date.now();
        try {
          // Written whole, then renamed: the runner never reads half a frame.
          writeFileSync('${FRAME_FILE}.tmp', JSON.stringify({ data, url: p.url() }));
          renameSync('${FRAME_FILE}.tmp', '${FRAME_FILE}');
        } catch {}
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 960, maxHeight: 600, everyNthFrame: 2 });
    } catch {}
  };
  await watch(page);
  context.on('page', (p) => void watch(p));
});
`;

/** A Playwright reporter that records the step a test is on, as "2. Sign in › 2.3 click". */
export const LIVE_REPORTER = `const { renameSync, writeFileSync } = require('node:fs');
// Written whole, then renamed, like the frame: the runner never reads half a file.
const write = (step) => { try { writeFileSync('${STEP_FILE}.tmp', JSON.stringify({ step })); renameSync('${STEP_FILE}.tmp', '${STEP_FILE}'); } catch {} };
const title = (s) => { const t = []; for (let x = s; x; x = x.parent) if (x.category === 'test.step') t.unshift(x.title); return t.join(' › '); };
class LiveReporter {
  onStepBegin(_test, _result, step) { if (step.category === 'test.step') write(title(step)); }
  onTestEnd() { write(null); }
  printsToStdio() { return false; }
}
module.exports = LiveReporter;
`;
export const LIVE_REPORTER_FILE = 'tb-live-reporter.cjs';
export const LIVE_HOOK_FILE = 'tb-live.ts';

/** A small JSON file the test process writes, or null while it is missing or unreadable. */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The page address as shown to people watching: credentials in the query string masked. */
function maskedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const [k, v] of url.searchParams) url.searchParams.set(k, maskValue(k, v));
    return url.toString();
  } catch {
    return maskText(raw);
  }
}

/** Publishes what the test process shows, every half second, until stopped. */
export function publishLive(opts: { dir: string; itemId: string; cache: JsonCache | null }): () => Promise<void> {
  const { dir, itemId, cache } = opts;
  if (!cache) return async () => {};
  let stopped = false;
  let busy = false;
  // Never throws: a live view that fails costs a frame, never the run (an unhandled rejection here
  // would take the whole runner down, with every test it is running).
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const shot = await readJson<{ data: string; url: string }>(join(dir, FRAME_FILE));
      const step = (await readJson<{ step: string | null }>(join(dir, STEP_FILE)))?.step ?? null;
      if (shot || step) {
        const live: LiveFrame = { frame: shot?.data ?? null, step, url: shot ? maskedUrl(shot.url) : '', at: new Date().toISOString() };
        await cache.set(liveFrameKey(itemId), live, LIVE_TTL_S);
      }
    } catch {
      // Skipped: the next tick tries again.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 500);
  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}
