import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { NextResponse } from 'next/server';

// Playwright's own type definitions for the code workspace editor, so `page.`, `expect(` and
// locators autocomplete and type-check in the browser exactly as they would in VS Code. They are
// public package files (the same version the runner uses), so no session is needed.

// Resolve from the app folder, not this file: the bundler moves compiled routes elsewhere.
const require = createRequire(join(process.cwd(), 'package.json'));
export const runtime = 'nodejs';

/** Package → the declaration files the editor needs, relative to the package folder. */
const FILES: Record<string, string[]> = {
  '@playwright/test': ['package.json', 'index.d.ts'],
  playwright: ['package.json', 'index.d.ts', 'test.d.ts', 'types/test.d.ts'],
  'playwright-core': ['package.json', 'index.d.ts', 'types/types.d.ts', 'types/structs.d.ts', 'types/protocol.d.ts'],
};

// The Playwright types import a few Node and zod modules for rarely used signatures. The browser
// editor has no @types/node, so these stubs keep those imports from showing as errors.
const STUBS = `declare module 'child_process' { export type ChildProcess = any; }
declare module 'stream' { export type Readable = any; }
declare module 'fs' { export type ReadStream = any; }
declare module 'zod' { export type ZodTypeAny = any; export const z: any; }
declare module 'zod/v3' { const z3: any; export = z3; }
declare type Buffer = Uint8Array;
declare const process: { env: Record<string, string | undefined> };
`;

let cached: { path: string; content: string }[] | null = null;

async function load() {
  if (cached) return cached;
  const testDir = dirname(require.resolve('@playwright/test/package.json'));
  const pwDir = dirname(require.resolve('playwright/package.json', { paths: [testDir] }));
  const coreDir = dirname(require.resolve('playwright-core/package.json', { paths: [pwDir] }));
  const dirs: Record<string, string> = { '@playwright/test': testDir, playwright: pwDir, 'playwright-core': coreDir };
  const out: { path: string; content: string }[] = [{ path: 'file:///node_modules/@types/tb-stubs/index.d.ts', content: STUBS }];
  for (const [pkg, files] of Object.entries(FILES))
    for (const f of files)
      out.push({ path: `file:///node_modules/${pkg}/${f}`, content: await readFile(join(dirs[pkg]!, f), 'utf8') });
  cached = out;
  return out;
}

export async function GET() {
  return NextResponse.json(await load(), {
    // Tied to the installed Playwright version; a day's caching keeps the 2 MB off every page load.
    headers: { 'cache-control': 'public, max-age=86400' },
  });
}
