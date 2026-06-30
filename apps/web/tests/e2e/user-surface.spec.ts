/**
 * TDA-007 Task 8 — E2E smoke for the sanitized USER surface.
 *
 * Proves the visible behavior delivered by TDA-007 Tasks 1-7:
 *   1. A seeded USER logs in.
 *   2. The sidebar shows EXACTLY Intraday / Swing / Positions / Settings (the
 *      full ADMIN nav is hidden).
 *   3. Opening Swing (the viewer has no SWING subscription) renders the
 *      Subscribe placeholder, not the signals tables.
 *   4. Every captured `/api/anand/*` response body is provenance-free: it never
 *      contains `scannerName` or `scoreBreakdown` (the ADMIN-only fields that
 *      the public `toPublicEntry` mapper strips).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNNING THIS SUITE — the stack is NOT auto-started; bring it up first.
 *
 *   This config drives a REAL browser against a running web (4100) + API (4101)
 *   stack. Playwright does not (and cannot) start the API here.
 *
 *   1. Start the API (from repo root):
 *        cd apps/api && npx nest build           # only if dist/ is missing
 *        cd apps/api && DOTENV_CONFIG_PATH="$PWD/.env" node dist/main.js
 *      (API listens on 4101 with the `td_saas` DB.)
 *
 *   2. Start the web dev server (separate shell, from repo root):
 *        cd apps/web && node node_modules/vite/bin/vite.js --port 4100
 *
 *   3. Install the browser once if needed:
 *        cd apps/web && npx playwright install chromium
 *
 *   4. Run the smoke:
 *        cd apps/web && npx playwright test tests/e2e/user-surface.spec.ts
 *
 * Seeded credentials (in `td_saas`): viewer@panamoure.com / ViewerPass123!
 * (a USER, ACTIVE + verified, with NO segment subscriptions).
 *
 * OPTIONAL / DEFERRED — admin-grant → feed step. The original brief also wanted
 * to grant SWING to the viewer via `POST /api/admin/subscriptions` with an ADMIN
 * token, reload Swing, and assert entries render. That step is NOT automated
 * here because the seeded ADMIN (`admin@local`) has no usable password, so no
 * ADMIN token can be minted in this environment. The provenance guarantee is
 * still asserted on the unsubscribed surface below (the NOT_SUBSCRIBED 403 body
 * is likewise provenance-free), and the grant path is covered by Tasks 1-3's
 * unit/integration tests. To enable it: seed an ADMIN password, obtain a token,
 * POST the SWING grant for the viewer, then re-open Swing and assert the table.
 */
import { test, expect, type Response } from '@playwright/test';

const VIEWER_EMAIL = 'viewer@panamoure.com';
const VIEWER_PASSWORD = 'ViewerPass123!';

const USER_NAV_LABELS = ['Intraday', 'Swing', 'Positions', 'Settings'];

// Provenance fields that the public entry mapper must strip for non-ADMIN.
const FORBIDDEN_PROVENANCE = ['scannerName', 'scoreBreakdown'];

test('USER surface: sanitized nav, Swing gate, provenance-free anand responses', async ({
  page,
}) => {
  // Capture the raw body of every /api/anand/* response the app makes. We scan
  // the raw text (not a parsed object) so the assertion catches the forbidden
  // keys regardless of nesting or response shape (array, object, or error body).
  const anandBodies: { url: string; status: number; body: string }[] = [];
  page.on('response', (res: Response) => {
    const url = res.url();
    if (!url.includes('/api/anand/')) return;
    // Read the body lazily; ignore bodies that are unavailable (e.g. redirects).
    void res
      .text()
      .then((body) => anandBodies.push({ url, status: res.status(), body }))
      .catch(() => {
        /* body not retrievable — nothing to scan */
      });
  });

  // 1. Log in as the seeded viewer via the real login form.
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(VIEWER_EMAIL);
  await page.locator('input[type="password"]').fill(VIEWER_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // A USER lands on /intraday (the index route redirects non-ADMINs there).
  await page.waitForURL('**/intraday', { timeout: 30_000 });

  // 2. Sidebar shows EXACTLY the four USER product sections — nothing else.
  const navLinks = page.locator('aside nav a');
  await expect(navLinks).toHaveCount(USER_NAV_LABELS.length);
  await expect(navLinks).toHaveText(USER_NAV_LABELS.map((l) => new RegExp(l)));

  // 3. Open Swing → the viewer has no SWING subscription, so the Subscribe
  //    placeholder renders instead of the signals tables.
  await navLinks.filter({ hasText: 'Swing' }).click();
  await page.waitForURL('**/swing', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Subscribe to Swing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Subscribe' })).toBeVisible();

  // Give any in-flight /api/anand/* requests (fired by the page's hooks) a beat
  // to resolve so their bodies are captured before we assert on them.
  await page.waitForTimeout(1_000);

  // 4. Provenance: no captured anand response body leaks ADMIN-only fields.
  expect(anandBodies.length).toBeGreaterThan(0);
  for (const { url, status, body } of anandBodies) {
    for (const field of FORBIDDEN_PROVENANCE) {
      expect(
        body.includes(field),
        `anand response leaked "${field}" (status ${status}): ${url}`,
      ).toBe(false);
    }
  }
});
