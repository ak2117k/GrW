import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve the monorepo root (two levels up from apps/web) so the webServer
// commands run pnpm filters from the right place regardless of the CWD that
// invokes `playwright test`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const WEB_PORT = 4100;
const API_PORT = 4101;
// Vite binds to `localhost` (which resolves to IPv6 ::1 on Windows), so we must
// address it by hostname rather than 127.0.0.1 to avoid ERR_CONNECTION_REFUSED.
const BASE_URL = `http://localhost:${WEB_PORT}`;

// Playwright owns the lifecycle of BOTH servers so `npx playwright test` is a
// single, self-contained command. The API MUST run with NODE_ENV=test so that
// POST /auth/signup echoes the raw `verificationToken` (the documented test
// seam) — we inject it via Playwright's `env` rather than inline shell vars,
// which behave inconsistently on Windows.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @td/api dev',
      port: API_PORT,
      cwd: repoRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        API_PORT: String(API_PORT),
      },
    },
    {
      command: 'pnpm --filter @td/web dev',
      port: WEB_PORT,
      cwd: repoRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
