# TDA-014 — Public Landing Page + Signup Funnel — Design Spec

**Doc ID:** TDA-014
**Date:** 2026-07-01
**Sprint:** S7 (Landing & Billing) — Harden
**Depends on:** TDA-002 (auth: `/auth/signup`, `/auth/verify-email`, login, Zustand auth store)
**Blocks:** TDA-015 (billing/checkout hangs off the pricing CTA + signup funnel)
**Parallel lane:** shares `apps/web/src/App.tsx` with **TDA-007** (authenticated surface). See §9.
**Owner:** development@panamoure.com

---

## 1. Goal

Give the product a **public front door**. Today the SaaS web app (`apps/web`,
ports 4100→4101) has exactly one anonymous route — `/login` — and every other
route is behind `RequireAuth`. A logged-out visitor to the bare domain is bounced
straight to a login form: there is nothing that explains or sells the product.

TDA-014 adds a **public marketing landing page** and a **signup funnel** that
flows into the existing TDA-002 auth (signup → verify email → sign in → into the
app). It is **frontend-only**: the signup and email-verification endpoints already
exist on the backend (TDA-002); this sprint wires the UI to them. No backend code,
no schema change.

The product is sold as a **public SaaS for automated Intraday and Swing
execution on the user's own broker account**. The proprietary signal engine /
scanner / strategy internals are **IP and must never appear in marketing copy**
(mirrors the TDA-006 provenance boundary, applied to public-facing text).

## 2. Current state (from code map) — what exists

- **Routing** (`apps/web/src/App.tsx`): a single `<Routes>` with `/login` (public,
  via `LoginRoute`) and one pathless `<Route element={<RequireAuth><AppLayout/></RequireAuth>}>`
  wrapping ~26 child routes. The layout's `index` route renders `DashboardPage`.
  `RequireAuth` sends `status === 'anon'` users to `/login`; `LoginRoute` sends
  `authed` users to `/`.
- **Auth services** (`apps/web/src/services/auth.ts`): an interceptor-free axios
  instance on `baseURL: '/auth'`. It exposes `login`, `loginMfa`, `refreshTokens`,
  `getMe`, `logout` — but **NOT `signup` or `verifyEmail`** (those frontend
  wrappers do not exist yet, even though the backend endpoints do). This sprint
  adds them.
- **Auth store** (`apps/web/src/stores/auth-store.ts`): Zustand, `status`
  `loading|authed|anon`, `setTokens`/`setUser`/`logout`/`hydrate`. Reused as-is.
- **Backend auth** (`apps/api/src/modules/auth/controllers/auth.controller.ts`),
  all `@Public()`:
  - `POST /auth/signup` — body `{ email, password, displayName? }`; returns **201**
    `{ message }` (always the same generic, non-enumerating message; in
    `NODE_ENV=test` also returns `verificationToken`). Sends a verification email.
  - `POST /auth/verify-email` — body `{ token }`; returns **200** `{ message }` on a
    valid, unexpired, unused `EMAIL_VERIFY` token; **401** otherwise. Flips the user
    `PENDING_VERIFICATION → ACTIVE`.
  - The backend builds the email link as `${APP_BASE_URL}/verify-email?token=<raw>`
    (`AuthService.verifyUrl`). `APP_BASE_URL` therefore **must point at the SaaS web
    origin** (dev `http://localhost:4100`) so the link opens *this* app's
    `/verify-email` page — see §9 config note.
- **Signup validation** (`SignupDto`): `email` is a valid email; `password` 8–128
  chars; `displayName` optional, ≤120 chars. The frontend form mirrors these.
- **Styling**: Tailwind v4 via `@theme` CSS variables in `apps/web/src/app.css`
  (`--color-bg-primary`, `--color-accent-blue`, `--color-text-muted`, …), dark
  theme, inline `className` with `var(--color-…)`, `lucide-react` icons,
  `react-hot-toast` for transient messages. The existing `LoginPage` is the styling
  reference for auth forms (brand wordmark "TD**Auto**", card on `--color-bg-secondary`).

## 3. Public route surface (the parallel-worktree seam)

TDA-014 adds **only anonymous routes**, as **top-level siblings of `/login`**,
**outside** the `RequireAuth` block. It does **not** touch the authenticated
`<Route>` group, its child routes, `Sidebar`, or any product page (those belong to
TDA-007). New public routes:

| Route | Element | Purpose |
|---|---|---|
| `/welcome` | `LandingPage` | Marketing landing (hero, value props, pricing teaser, CTAs). |
| `/signup` | `SignupPage` | Signup funnel → `POST /auth/signup`. |
| `/verify-email` | `VerifyEmailPage` | Reads `?token=`, `POST /auth/verify-email`. |

- `/welcome`, `/signup` are wrapped in a small `RedirectIfAuthed` guard (mirrors
  the existing `LoginRoute`) so a logged-in user who hits them is sent to `/`
  (which, post-TDA-007, lands a USER on `/intraday`).
- `/verify-email` is **not** auth-guarded — a freshly-verified, not-yet-logged-in
  user must be able to open it from their email regardless of session.

**Bare-domain behaviour (default, see §9):** change the single line in
`RequireAuth`'s anon branch so an anonymous visitor to `/` (or any protected path)
is redirected to **`/welcome`** instead of `/login`. The landing's "Sign in" CTA
links to `/login`; the primary CTA links to `/signup`. This is the *only* edit
TDA-014 makes inside `App.tsx` besides adding the three sibling routes + their
imports, and it is a line TDA-007 does not touch (§9).

## 4. The landing page (`/welcome`)

A single scrollable marketing page, dark theme, reusing the existing CSS-variable
palette. Sections, top to bottom:

1. **Top bar** — brand wordmark ("TD**Auto**"), a "Sign in" link (`/login`) and a
   "Get started" button (`/signup`).
2. **Hero** — headline + subhead positioning the product as *"Automated Intraday &
   Swing execution on your own broker account."* Primary CTA "Create your account"
   → `/signup`; secondary "Sign in" → `/login`.
3. **Two value props — Intraday & Swing** (the two product sections, locked by the
   roadmap). Each is a card describing the *outcome* for the user: hands-off
   execution on their own Angel One account, per-user risk sizing, opt-in
   auto-execution, kill switch. **No mention of how signals are produced** (no
   scanner, no strategy names, no "signal engine", no provenance) — §7.
4. **How it works** — a 3–4 step outcome narrative: *Sign up → connect your broker
   → choose Intraday and/or Swing → opt in to auto-execution.* Describes the user
   journey, not the internals. (Connect-broker / consent / subscribe are delivered
   by TDA-005/009/015; here they are described, not linked to live flows.)
5. **Pricing teaser** — indicative plan tiers: **Intraday**, **Swing**, **Both**
   (Intraday and Swing are separate subscriptions per the roadmap). Feature bullets
   per tier; price shown as a **launch-pricing placeholder** (no real numbers, no
   checkout — billing is TDA-015). Each tier CTA → `/signup`. See §9 decision.
6. **Trust / disclaimer strip** — a short risk-disclosure line ("Trading involves
   risk… past performance…") foreshadowing the TDA-009 consent gate. Static copy.
7. **Footer CTA** — repeat "Create your account" → `/signup`.

The page is presentational: a `landingContent.ts` data module holds all copy
(hero, value props, tiers) so it is (a) easy to edit and (b) **testable** against
the forbidden-term guard (§7).

## 5. The signup funnel (`/signup`)

**Default: single-step form + confirmation state** (multi-step is deferred — §9).

- Fields: **email**, **password**, **display name (optional)** — validated
  client-side against the `SignupDto` rules (valid email; password 8–128; name
  ≤120) via a pure `validateSignup()` helper (testable). A password-match confirm
  field is added client-side only (UX), not sent.
- Submit → new `signup(email, password, displayName?)` wrapper in `auth.ts` →
  `POST /auth/signup`.
- Because the backend response is **always the same generic message** (no
  enumeration, no tokens in prod), the UI does not branch on "already registered".
  On any 2xx it switches to a **"Check your email"** confirmation panel: *"If that
  address is available, we've sent a verification link to {email}."* — wording that
  matches the backend's non-enumerating contract.
- Error handling mirrors `LoginPage.errorMessage`: 400 → show validation message
  from `response.data.message`; 429 → "Too many attempts…"; otherwise a generic
  fallback.
- Below the form: "Already have an account? **Sign in**" → `/login`.

## 6. Email verification handler (`/verify-email`)

- On mount, parse `token` from the query string via a pure
  `extractVerifyToken(search)` helper (testable). If absent/empty → render an
  "invalid link" state with a CTA back to `/signup`.
- If present → new `verifyEmail(token)` wrapper in `auth.ts` → `POST
  /auth/verify-email`. Three render states: **verifying** (spinner), **success**
  ("Email verified — you can now sign in", CTA → `/login`), **failure** (401 →
  "This link is invalid or has expired", CTA → `/signup`).
- The funnel intentionally ends at **"sign in"**, not auto-login: `verify-email`
  returns no tokens. After signing in, the user lands in the app on the TDA-007
  USER surface (Intraday/Swing/Positions/Settings), where the real onboarding
  (connect broker, subscribe, consent, auto-exec) is delivered by later sprints.

## 7. IP / marketing-copy guard (no provenance)

Marketing copy must **never** reference the proprietary signal source. Forbidden
terms in any landing/signup copy: `scanner`, `chartink`, `strategy` (as a named
engine), `signal engine`, `provenance`, `source`, `rejection`, `gate`, and the
internal strategy names. A unit test (§11) scans the `landingContent.ts` strings
(case-insensitive) and **fails** if any forbidden term appears — the public-text
analogue of the TDA-006 CI forbidden-field test. Copy talks about *outcomes*
("automated execution", "Intraday & Swing", "on your own account"), never *how
the calls are generated*.

## 8. Out of scope (deferred)

- **Billing / real prices / checkout** → TDA-015 (the pricing CTA is a stub that
  routes to `/signup`).
- **Lead capture / waitlist backend** → not built. The only "capture" is a real
  signup (existing `/auth/signup`, creates a `PENDING_VERIFICATION` user). A
  dedicated waitlist table/endpoint, if ever wanted, is a TDA-015 concern.
- **Resend-verification** → the roadmap §8 carry-forward (`POST
  /auth/resend-verification`) is not yet implemented; the confirmation panel
  mentions checking spam rather than offering a resend button. (Flag — §9.)
- **Real onboarding** (connect broker, subscribe, consent, auto-exec) →
  TDA-005/009/011/015. The landing *describes* these; it does not implement them.
- **SEO / SSR / analytics / cookie banner** → not in this sprint (CSR SPA only).

## 9. Open decisions & chosen defaults

1. **Landing route strategy — `/` vs `/welcome`.** *Default: `/welcome`* as the
   canonical public landing, plus redirect anonymous `/` → `/welcome` (one-line
   change in `RequireAuth`'s anon branch). This keeps the `/` **index route owned
   by TDA-007** untouched (avoiding a worktree conflict on the same line) while
   still giving logged-out visitors marketing at the bare domain. *Alternative:*
   make `/` itself render the landing for anon — rejected because the index route
   lives inside the `RequireAuth` group that TDA-007 owns; editing it would
   conflict.
2. **Pricing detail pre-billing.** *Default: indicative tiers (Intraday / Swing /
   Both) with feature bullets and placeholder "launch pricing", no real numbers,
   CTA → signup.* Avoids committing to prices before TDA-015 defines billing. *Flag
   if* marketing wants concrete prices shown now.
3. **Signup shape — single-step vs multi-step.** *Default: single-step form +
   "check your email" confirmation.* The backend only needs email+password(+name);
   a wizard adds friction for no data gain. *Flag if* a guided multi-step onboard
   is desired (it would still hit the same one endpoint).
4. **Resend-verification.** *Default: not offered* (endpoint unimplemented per
   roadmap §8). *Flag* as a small TDA-002 follow-up if signup drop-off matters.
5. **`APP_BASE_URL` config (not code).** Must be set to the SaaS web origin
   (`http://localhost:4100` in dev; the production web origin in prod) so
   verification emails link to *this* app's `/verify-email`. Document in deploy
   notes; no code change in this sprint.

## 10. Acceptance criteria

1. An anonymous visitor to `/welcome` sees the landing page (hero, Intraday &
   Swing value props, pricing teaser, CTAs) — no login required.
2. An anonymous visitor to `/` is redirected to `/welcome` (not `/login`); a
   logged-in visitor to `/welcome` or `/signup` is redirected to `/`.
3. `/signup` validates inputs client-side (email format, password 8–128) and, on
   submit, calls `POST /auth/signup` and shows the non-enumerating "check your
   email" confirmation on success.
4. `/verify-email?token=…` calls `POST /auth/verify-email` and shows success
   (→ Sign in) or failure (→ Sign up) states; a missing token shows the invalid
   state without calling the API.
5. No landing/signup copy references the signal engine, scanner, strategy names,
   or any provenance term (enforced by the §11 copy test).
6. `App.tsx` changes are limited to: three new public sibling routes + their
   imports, and the single anon-redirect target line. The authenticated `<Route>`
   group, `Sidebar`, and product pages are **untouched** (clean merge with TDA-007).

## 11. Test plan

Frontend test runner is **Vitest, pure-logic only** (no jsdom). Tests target the
extracted helpers, not rendered components:

- **`validateSignup.spec.ts`** — the form validator: rejects bad email, password
  <8 / >128, name >120; accepts a valid payload; confirm-password mismatch flagged.
  Mirrors `SignupDto`.
- **`extractVerifyToken.spec.ts`** — parses `?token=abc` → `'abc'`; missing/empty
  token → `null`; ignores other params.
- **`landingContent.spec.ts`** — the **forbidden-term guard**: asserts no
  provenance term (`scanner`, `chartink`, `strategy`, `signal engine`, `source`,
  `provenance`, `rejection`, `gate`, internal strategy names) appears in any hero /
  value-prop / pricing string (case-insensitive). Also asserts both product
  sections present are exactly **Intraday** and **Swing**.
- **`signupError.spec.ts`** (optional) — the axios-error→message mapper (401/429/
  validation/fallback), mirroring `LoginPage.errorMessage`.
- **E2E smoke (Playwright, `test:e2e`)** — anon `/` → redirected to `/welcome`;
  landing renders; "Get started" → `/signup`; fill + submit a fresh email → "check
  your email" panel; (optionally, with the `NODE_ENV=test` `verificationToken`
  seam) open `/verify-email?token=…` → success → `/login`. Requires the 4100/4101
  stack running.
