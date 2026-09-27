import { defineConfig, devices } from '@playwright/test';

// Runs against the local stack: `pnpm infra:up && pnpm db:migrate && pnpm seed`, then `pnpm dev`
// (web on :3000, core-api on :4000). The suite signs in through the real Keycloak login page.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
