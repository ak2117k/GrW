import { defineConfig, devices } from '@playwright/test';

// TDA-007 Task 8 — Playwright config for the USER-surface E2E smoke.
//
// The standalone SaaS app runs web on 4100 and proxies /api -> 4101 (see
// vite.config.ts). This config drives a real browser against a RUNNING stack;
// it deliberately does NOT spin up the API (the API needs its own DB/env and
// cannot be started by Playwright here). You must start both servers yourself
// before running the suite — see tests/e2e/user-surface.spec.ts header for the
// exact commands.
//
// A `webServer` block is intentionally omitted: wiring it to start only the web
// server would still leave the API down (every /api call would 502), so the
// test would fail in a confusing way. Keep startup explicit and documented.
export default defineConfig({
  testDir: './tests/e2e',
  // Fail fast on a leftover `test.only` in CI; harmless locally.
  forbidOnly: !!process.env.CI,
  // The smoke is a single linear flow; no value in retries masking flakiness.
  retries: 0,
  // One worker — the flow logs in and navigates a shared app; keep it serial.
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:4100',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
