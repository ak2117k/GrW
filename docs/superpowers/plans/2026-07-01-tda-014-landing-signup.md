# TDA-014 Public Landing Page + Signup Funnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a public marketing landing page (`/welcome`) and a signup funnel
(`/signup` → `/verify-email`) that wires the SaaS web app to the existing TDA-002
auth endpoints, giving the product a public front door. Frontend-only; no backend
code; no schema change.

**Architecture:** Three new **anonymous** routes added as top-level siblings of
`/login` in `apps/web/src/App.tsx`, **outside** the `RequireAuth` block. Two thin
service wrappers (`signup`, `verifyEmail`) added to the existing `/auth` axios
instance. All marketing copy lives in a `landingContent.ts` data module guarded by
a forbidden-term test. Pure-logic helpers (`validateSignup`, `extractVerifyToken`)
carry the testable logic; pages are presentational. The pricing CTA is a stub that
routes to signup (real billing = TDA-015).

**Tech Stack:** React 19 + react-router-dom 7 + Zustand (`useAuthStore`) + axios
`/auth` instance + Tailwind v4 (`@theme` CSS vars in `app.css`) + `lucide-react` +
`react-hot-toast` + Vitest (pure-logic). Backend untouched: `POST /auth/signup`
(201, `{message}`) and `POST /auth/verify-email` (200/401, `{message}`) already
exist from TDA-002.

## Global Constraints

- **Frontend only.** No `apps/api` change. **No `prisma/schema.prisma` change.**
- **Commit prefix:** `TDA-014:`. No `.env`. Stage only changed files.
- **Public routes only.** TDA-014 adds **anonymous** routes outside `RequireAuth`.
  It MUST NOT touch the authenticated `<Route>` group, its child routes,
  `Sidebar.tsx`, or any product page — those belong to the **TDA-007** lane (see
  the Parallel-Worktree Seam section below).
- **Non-enumerating signup:** the UI never branches on "already registered"; any
  2xx → the same "check your email" confirmation. Matches the backend contract.
- **No provenance in copy:** landing/signup text must not reference the signal
  engine, scanner, strategy names, or any provenance term (enforced by test).
- **Tests:** Vitest, from `apps/web`: `npx vitest run <file>`. Pure-logic only (no
  jsdom). E2E via Playwright `npx playwright test` against the 4100/4101 stack.

---

## Parallel-Worktree Seam (READ FIRST — TDA-014 ⟂ TDA-007 both edit `App.tsx`)

`apps/web/src/App.tsx` is edited by **two parallel lanes**:

- **TDA-007** owns the **authenticated** surface: it adds `<RequireRole>`, wraps the
  ~26 child routes inside the `RequireAuth` group, and makes the `index` route
  role-aware. It does **not** modify `RequireAuth`'s anon-redirect line.
- **TDA-014** (this lane) owns the **anonymous** surface only.

To merge cleanly, TDA-014's edits to `App.tsx` are restricted to exactly:

1. **Add imports** for `LandingPage`, `SignupPage`, `VerifyEmailPage` — append at
   the **end** of the existing import block (do not interleave with the page
   imports TDA-007 may reorder).
2. **Add three sibling `<Route>`s** next to the existing `/login` route, **above**
   the `<Route element={<RequireAuth>…}>` group. Group them with a comment
   `{/* TDA-014: public routes */}` so the diff is self-contained.
3. **Change one line** inside `RequireAuth`: the anon branch target
   `<Navigate to="/login" …>` → `<Navigate to="/welcome" …>`. (This line is not in
   the `<Route>` group and is not touched by TDA-007.)

TDA-014 MUST NOT: edit any `<Route>` inside the `RequireAuth` group, add/modify
`RequireRole`, touch the `index` route, or edit `Sidebar.tsx` / product pages. If a
merge conflict arises in `App.tsx`, it should be confined to the import block and
the route-list region; resolve by keeping **both** lanes' additions (TDA-007's
guarded child routes AND TDA-014's public sibling routes).

---

## File Structure

**Services & logic (testable)**
- `apps/web/src/services/auth.ts` — **modify.** Add `signup()` and `verifyEmail()`
  wrappers (same `/auth` instance).
- `apps/web/src/pages/signup/validateSignup.ts` — **create.** Pure form validator.
- `apps/web/src/pages/verify-email/extractVerifyToken.ts` — **create.** Pure query
  parser.
- `apps/web/src/pages/landing/landingContent.ts` — **create.** All marketing copy
  (hero, value props, pricing tiers) as data.

**Pages & components (presentational)**
- `apps/web/src/pages/landing/LandingPage.tsx` — **create.** Sections from §4.
- `apps/web/src/pages/signup/SignupPage.tsx` — **create.** Funnel form + confirm
  state.
- `apps/web/src/pages/verify-email/VerifyEmailPage.tsx` — **create.** Token handler.
- `apps/web/src/App.tsx` — **modify** (seam — see above).

**Tests**
- `apps/web/src/pages/signup/validateSignup.spec.ts`
- `apps/web/src/pages/verify-email/extractVerifyToken.spec.ts`
- `apps/web/src/pages/landing/landingContent.spec.ts`
- `apps/web/tests/e2e/landing-signup.spec.ts` (Playwright)

---

### Task 1: `signup()` + `verifyEmail()` service wrappers

**Files:**
- Modify: `apps/web/src/services/auth.ts`

**Interfaces — Produces:**
- `signup(email: string, password: string, displayName?: string): Promise<{ message: string; verificationToken?: string }>`
- `verifyEmail(token: string): Promise<{ message: string }>`

**Context:** `auth.ts` already exports the interceptor-free `authApi` axios
instance on `baseURL: '/auth'`. Add the two wrappers next to `login`/`getMe`,
following the same `res.data` pattern. `signup` POSTs `/signup` (backend 201);
`verifyEmail` POSTs `/verify-email` with `{ token }` (backend 200). Do NOT add
interceptors (the refresh loop must stay off this instance).

- [ ] **Step 1: Implement** (no separate unit test — these are one-line axios
  passthroughs; covered by the E2E in Task 6):
```ts
export async function signup(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ message: string; verificationToken?: string }> {
  const res = await authApi.post('/signup', { email, password, displayName });
  return res.data;
}

export async function verifyEmail(token: string): Promise<{ message: string }> {
  const res = await authApi.post('/verify-email', { token });
  return res.data;
}
```
- [ ] **Step 2: Verify types** — `cd apps/web && npx tsc -b --noEmit` → no errors.
- [ ] **Step 3: Commit** `TDA-014: signup + verifyEmail auth service wrappers`.

---

### Task 2: `validateSignup` pure validator

**Files:**
- Create: `apps/web/src/pages/signup/validateSignup.ts`
- Test: `apps/web/src/pages/signup/validateSignup.spec.ts`

**Interfaces — Produces:**
- `type SignupErrors = Partial<Record<'email'|'password'|'confirm'|'displayName', string>>`
- `validateSignup(input: { email: string; password: string; confirm: string; displayName?: string }): SignupErrors`
  (empty object = valid). Rules mirror `SignupDto`: email must match a basic email
  regex; password 8–128; `confirm` must equal `password`; `displayName` (if
  non-empty) ≤120.

- [ ] **Step 1: Write the failing test** — `validateSignup.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateSignup } from './validateSignup';

const ok = { email: 'a@b.com', password: 'password1', confirm: 'password1' };
describe('validateSignup', () => {
  it('accepts a valid payload', () => expect(validateSignup(ok)).toEqual({}));
  it('rejects a malformed email', () =>
    expect(validateSignup({ ...ok, email: 'nope' }).email).toBeTruthy());
  it('rejects a short password', () =>
    expect(validateSignup({ ...ok, password: 'short', confirm: 'short' }).password).toBeTruthy());
  it('rejects a >128 char password', () => {
    const p = 'x'.repeat(129);
    expect(validateSignup({ ...ok, password: p, confirm: p }).password).toBeTruthy();
  });
  it('flags a confirm mismatch', () =>
    expect(validateSignup({ ...ok, confirm: 'different' }).confirm).toBeTruthy());
  it('rejects a >120 char display name', () =>
    expect(validateSignup({ ...ok, displayName: 'y'.repeat(121) }).displayName).toBeTruthy());
});
```
- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vitest run src/pages/signup/validateSignup.spec.ts`).
- [ ] **Step 3: Implement** `validateSignup.ts` per the rules above (simple email
  regex such as `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-014: signup form validator`.

---

### Task 3: `extractVerifyToken` pure query parser

**Files:**
- Create: `apps/web/src/pages/verify-email/extractVerifyToken.ts`
- Test: `apps/web/src/pages/verify-email/extractVerifyToken.spec.ts`

**Interfaces — Produces:**
- `extractVerifyToken(search: string): string | null` — parses a `?token=` value
  from a `location.search` string; trims; returns `null` when absent/empty.

- [ ] **Step 1: Write the failing test** — `extractVerifyToken.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { extractVerifyToken } from './extractVerifyToken';

describe('extractVerifyToken', () => {
  it('extracts the token', () => expect(extractVerifyToken('?token=abc123')).toBe('abc123'));
  it('ignores other params', () =>
    expect(extractVerifyToken('?foo=1&token=xyz&bar=2')).toBe('xyz'));
  it('returns null when missing', () => expect(extractVerifyToken('?foo=1')).toBeNull());
  it('returns null for empty token', () => expect(extractVerifyToken('?token=')).toBeNull());
  it('returns null for empty search', () => expect(extractVerifyToken('')).toBeNull());
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** using `URLSearchParams`:
```ts
export function extractVerifyToken(search: string): string | null {
  const t = new URLSearchParams(search).get('token')?.trim();
  return t ? t : null;
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-014: verify-email token parser`.

---

### Task 4: `landingContent` data module + forbidden-term guard

**Files:**
- Create: `apps/web/src/pages/landing/landingContent.ts`
- Test: `apps/web/src/pages/landing/landingContent.spec.ts`

**Interfaces — Produces:** a typed `landingContent` object with `hero {title,
subtitle, ctaPrimary, ctaSecondary}`, `valueProps: Array<{ segment: 'Intraday' |
'Swing'; title; body; bullets: string[] }>` (exactly those two segments),
`howItWorks: string[]`, `pricingTiers: Array<{ name; priceLabel; bullets: string[]
}>` (name ∈ Intraday/Swing/Both; `priceLabel` a launch-pricing placeholder, no real
number), `disclaimer: string`. **All user-visible copy lives here** so the page is
presentational and the copy is testable.

- [ ] **Step 1: Write the failing test** — `landingContent.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { landingContent } from './landingContent';

// IP boundary: marketing copy must never expose signal provenance (TDA-006/§7).
const FORBIDDEN = [
  'scanner', 'chartink', 'strategy', 'signal engine', 'provenance',
  'source', 'rejection', 'gate',
];

function allCopy(): string {
  return JSON.stringify(landingContent).toLowerCase();
}

describe('landingContent IP guard', () => {
  it('contains no provenance terms', () => {
    const copy = allCopy();
    for (const term of FORBIDDEN) expect(copy).not.toContain(term);
  });
  it('exposes exactly the Intraday and Swing product sections', () => {
    expect(landingContent.valueProps.map((v) => v.segment).sort())
      .toEqual(['Intraday', 'Swing']);
  });
});
```
- [ ] **Step 2: Run → FAIL** (module missing).
- [ ] **Step 3: Implement** `landingContent.ts` with outcome-focused copy (automated
  Intraday & Swing execution on the user's own broker account, per-user risk
  sizing, opt-in auto-execution, kill switch). **Avoid every forbidden term** —
  e.g. say "signals for your subscribed segments", never "from our scanner". Avoid
  the word "strategy" entirely (use "plan"/"approach" if needed, or rephrase).
  Pricing labels like `"Launch pricing — coming soon"`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-014: landing copy data module + IP guard test`.

---

### Task 5: Landing, Signup, and Verify-Email pages + route wiring

**Files:**
- Create: `apps/web/src/pages/landing/LandingPage.tsx`
- Create: `apps/web/src/pages/signup/SignupPage.tsx`
- Create: `apps/web/src/pages/verify-email/VerifyEmailPage.tsx`
- Modify: `apps/web/src/App.tsx` (seam — see Parallel-Worktree Seam section)

**Interfaces — Consumes:** `landingContent` (T4), `validateSignup` (T2),
`extractVerifyToken` (T3), `signup`/`verifyEmail` (T1), `useAuthStore` (status for
the `RedirectIfAuthed` guard), `react-router-dom` (`Link`, `Navigate`,
`useNavigate`, `useLocation`), `react-hot-toast`, `lucide-react`.

**Context:** Match the existing `LoginPage` styling (dark cards on
`var(--color-bg-secondary)`, `var(--color-accent-blue)` buttons, brand wordmark).
Reuse the `errorMessage(err, fallback)` pattern from `LoginPage` for axios errors
(extract a shared `authError.ts` if convenient, else inline).

- [ ] **Step 1: `LandingPage.tsx`** — render the §4 sections purely from
  `landingContent`: top bar (brand + `Link` "Sign in"→`/login` + "Get started"
  →`/signup`), hero with both CTAs, the two Intraday/Swing value-prop cards,
  "How it works" steps, pricing-teaser tiers (each tier button → `/signup`, no
  checkout), disclaimer strip, footer CTA. No data fetching.

- [ ] **Step 2: `SignupPage.tsx`** — controlled form (email, password, confirm,
  optional display name). On submit: run `validateSignup`; if errors, show them
  inline and stop. Else call `signup(email, password, displayName)`; on success set
  a `submitted` state and render the **"Check your email"** confirmation panel
  (non-enumerating wording). Map errors via the `LoginPage`-style `errorMessage`
  (400→message, 429→too-many, fallback). "Already have an account? Sign in"
  → `/login`. (Call all hooks unconditionally; branch only in render.)

- [ ] **Step 3: `VerifyEmailPage.tsx`** — on mount, `const token =
  extractVerifyToken(useLocation().search)`. If `null` → "invalid link" state
  (CTA → `/signup`), no API call. Else call `verifyEmail(token)` in an effect with a
  `status` state machine (`verifying | success | failure`): success → "Email
  verified — sign in" (CTA → `/login`); 401/any error → "invalid or expired" (CTA →
  `/signup`). Guard the effect against double-run (ref flag) so the token is posted
  once.

- [ ] **Step 4: Wire routes in `App.tsx`** (seam-restricted edits only):
  - Append imports:
    ```tsx
    import LandingPage from '@/pages/landing/LandingPage';
    import SignupPage from '@/pages/signup/SignupPage';
    import VerifyEmailPage from '@/pages/verify-email/VerifyEmailPage';
    ```
  - Add a `RedirectIfAuthed` helper next to `LoginRoute` (mirrors it):
    ```tsx
    function RedirectIfAuthed({ children }: { children: ReactNode }) {
      const status = useAuthStore((s) => s.status);
      if (status === 'authed') return <Navigate to="/" replace />;
      return <>{children}</>;
    }
    ```
  - Add the public sibling routes just before the `RequireAuth` group:
    ```tsx
    {/* TDA-014: public routes */}
    <Route path="/welcome" element={<RedirectIfAuthed><LandingPage /></RedirectIfAuthed>} />
    <Route path="/signup" element={<RedirectIfAuthed><SignupPage /></RedirectIfAuthed>} />
    <Route path="/verify-email" element={<VerifyEmailPage />} />
    ```
  - Change the one anon-redirect line in `RequireAuth`:
    `<Navigate to="/login" replace state={{ from: location }} />`
    → `<Navigate to="/welcome" replace state={{ from: location }} />`.
  - Do NOT touch the `RequireAuth` `<Route>` group, the `index` route, or
    `Sidebar`.

- [ ] **Step 5: Verify** — `cd apps/web && npx tsc -b --noEmit` → no errors; run the
  existing helper tests to confirm nothing regressed:
  `npx vitest run src/pages/signup src/pages/verify-email src/pages/landing`.
- [ ] **Step 6: Commit** `TDA-014: landing, signup, verify-email pages + public routes`.

---

### Task 6: E2E smoke (anon redirect → landing → signup → verify)

**Files:**
- Create: `apps/web/tests/e2e/landing-signup.spec.ts` (Playwright; `test:e2e`)

**Context:** Requires the SaaS web (4100) + API (4101) stack running, with
`NODE_ENV=test` on the API so `POST /auth/signup` returns `verificationToken`
(the documented test seam) — otherwise stop at the confirmation panel.

- [ ] **Step 1: Write the E2E** —
  1. Visit `/` while logged out → assert redirected to `/welcome`; assert the hero
     and both "Intraday"/"Swing" value props render and that the captured page text
     contains none of `scanner`/`chartink`/`strategy`.
  2. Click "Get started" → assert URL `/signup`.
  3. Fill a fresh unique email + valid password + confirm → submit → assert the
     "check your email" confirmation panel.
  4. (If `verificationToken` is exposed) capture it from the signup response and
     visit `/verify-email?token=<token>` → assert the success state and the "Sign
     in" CTA → `/login`.
- [ ] **Step 2: Run** `cd apps/web && npx playwright test tests/e2e/landing-signup.spec.ts`
  (start the 4100/4101 stack first). Expected: PASS.
- [ ] **Step 3: Commit** `TDA-014: E2E smoke for landing + signup funnel`.

---

## Self-Review

- **Spec coverage:** §3 public routes → T5/seam; §4 landing sections → T4 (copy) +
  T5 (render); §5 signup funnel → T1 (`signup`) + T2 (validator) + T5; §6 verify →
  T1 (`verifyEmail`) + T3 (parser) + T5; §7 IP copy guard → T4; acceptance
  AC1/AC2 → T5+seam (E2E T6), AC3 → T2/T5, AC4 → T3/T5, AC5 → T4, AC6 → seam. ✅
- **Type consistency:** `signup`/`verifyEmail` return shapes (T1) match what
  `SignupPage`/`VerifyEmailPage` consume (T5); `SignupErrors` keys (T2) match the
  form fields (T5); `landingContent` shape (T4) matches `LandingPage` reads (T5). ✅
- **Backend untouched:** uses existing `/auth/signup` (201) and `/auth/verify-email`
  (200) only; no `apps/api` edit; no `prisma/schema.prisma` edit. ✅
- **Parallel-worktree seam:** `App.tsx` edits confined to appended imports, a
  commented public-route block, a new `RedirectIfAuthed` helper, and one
  anon-redirect line — none of which TDA-007 touches. The authenticated `<Route>`
  group, `index` route, and `Sidebar` are untouched. ✅
- **Non-enumeration & IP:** signup UI never branches on existing-email; copy guard
  test blocks provenance terms. ✅
- **Hooks-rule risk (T5):** `SignupPage`/`VerifyEmailPage` call all hooks
  unconditionally and branch only in render; the verify effect is guarded against
  double-post. Flagged in T2/T3 steps. ✅
- **Config (not code):** `APP_BASE_URL` must point at the SaaS web origin so
  verification links open this app's `/verify-email` — deploy note, no code. ✅
- **Deferred:** real prices/checkout, waitlist backend, resend-verification, real
  onboarding (broker/consent/auto-exec), SEO/SSR → TDA-005/009/011/015. ✅
