import { test, expect, type Response } from '@playwright/test';

/**
 * TDA-014 — E2E smoke for the public landing + signup funnel.
 *
 * Two tests:
 *   1. The anonymous funnel: anon "/" -> /welcome (landing) -> Get started ->
 *      /signup -> submit -> "check your email" confirmation panel.
 *   2. Email verification completion: take the signup test-seam token and drive
 *      the /verify-email page to its success state + "Sign in" CTA.
 *
 * The API runs with NODE_ENV=test (see playwright.config.ts) so POST
 * /auth/signup echoes the raw `verificationToken`, letting us verify
 * deterministically.
 */

// IP boundary (TDA-006/§7): the public landing copy must never reveal how
// signals are produced. These provenance terms must not appear anywhere in the
// rendered landing page text.
const FORBIDDEN_TERMS = ['scanner', 'chartink', 'strategy'];

const PASSWORD = 'Sup3rSecret!pw';
const freshEmail = () => `tda014+${Date.now()}@example.com`;

test('anon redirect -> landing -> signup confirmation', async ({ page }) => {
  // --- Step 1: anon "/" redirects to /welcome and the landing renders -------
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);

  // Hero
  await expect(
    page.getByRole('heading', {
      name: /Automated trading on your own broker account/i,
    }),
  ).toBeVisible();

  // Both value props (Intraday + Swing) render as section headings.
  await expect(
    page.getByRole('heading', { name: /Intraday/i }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /Swing/i }).first(),
  ).toBeVisible();

  // IP guard: no provenance terms anywhere in the landing page text.
  const landingText = (await page.locator('body').innerText()).toLowerCase();
  for (const term of FORBIDDEN_TERMS) {
    expect(landingText, `landing copy must not contain "${term}"`).not.toContain(
      term,
    );
  }

  // --- Step 2: "Get started" navigates to /signup --------------------------
  await page.getByRole('link', { name: 'Get started' }).first().click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(
    page.getByRole('button', { name: /Create account/i }),
  ).toBeVisible();

  // --- Step 3: submit a fresh account, expect the confirmation panel -------
  const email = freshEmail();
  await page.getByPlaceholder('you@example.com').fill(email);
  // Both password fields share the bullet placeholder; target by index.
  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.nth(0).fill(PASSWORD);
  await passwordInputs.nth(1).fill(PASSWORD);

  const signupResponsePromise = page.waitForResponse(
    (res: Response) =>
      res.url().includes('/auth/signup') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Create account/i }).click();
  const signupResponse = await signupResponsePromise;
  expect(signupResponse.ok()).toBeTruthy();

  // "Check your email" confirmation panel (non-enumerating copy).
  await expect(
    page.getByRole('heading', { name: 'Check your email' }),
  ).toBeVisible();
  await expect(
    page.getByText(/we've sent a\s+verification link/i),
  ).toBeVisible();
});

test('email verification completes -> success + Sign in CTA', async ({
  page,
  request,
}) => {
  // Mint a fresh account directly via the API (through the same /auth proxy the
  // app uses) so this test owns an unused verification token regardless of the
  // funnel test above. Relies on the NODE_ENV=test seam exposing the raw token.
  const res = await request.post('/auth/signup', {
    data: { email: freshEmail(), password: PASSWORD },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const token: string | undefined =
    typeof body?.verificationToken === 'string'
      ? body.verificationToken
      : undefined;

  // The seam must be present for this test to be meaningful; if it isn't, the
  // API isn't running in test mode and that is itself a failure worth flagging.
  expect(
    token,
    'POST /auth/signup did not expose verificationToken — is the API running with NODE_ENV=test?',
  ).toBeTruthy();

  await page.goto(`/verify-email?token=${encodeURIComponent(token as string)}`);

  // Success state.
  await expect(
    page.getByRole('heading', { name: 'Email verified' }),
  ).toBeVisible();

  // "Sign in" CTA points at /login.
  const signInCta = page.getByRole('link', { name: 'Sign in' });
  await expect(signInCta).toBeVisible();
  await expect(signInCta).toHaveAttribute('href', '/login');
});
