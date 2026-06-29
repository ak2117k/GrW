# TDA-002 — Authentication

**Spec ID:** TDA-002 · **Sprint:** S1 · **Phase:** MVP
**Depends on:** TDA-001 (User model exists) · **Blocks:** TDA-003, TDA-009, TDA-014, TDA-016
**Date:** 2026-06-27 · **Status:** In design
**Parent:** [TDA-ROADMAP](./2026-06-27-production-rearchitecture-roadmap.md)

---

## 1. Goal

Give the platform real authentication: public signup, email verification, password login
with optional TOTP MFA, stateless access + rotating refresh tokens (mobile-ready), password
reset, and logout. Deliver a `JwtAuthGuard` (applied globally, opt-out via `@Public`) that
populates `req.user` for every protected route, plus a `@CurrentUser` decorator.

**In scope:** authentication (who you are) and the token machinery.
**Out of scope:** authorization/tenant isolation enforcement and RBAC guards → **TDA-003**;
KMS envelope encryption + Secrets Manager → **TDA-004/005** (this spec uses the existing
`JWT_SECRET`/`ENCRYPTION_KEY` env vars as an interim, flagged for migration).

## 2. Decisions (locked)

- **Hashing:** argon2id for passwords.
- **Tokens:** JWT HS256 signed with `JWT_SECRET`. Access token TTL **15m** (carried in memory
  by clients, sent as `Authorization: Bearer`). Refresh token TTL **30d**, **rotating**,
  returned in the response body (NOT a cookie — React Native compatibility), stored **hashed**
  server-side with **reuse detection**.
- **Email:** pluggable `EmailService` interface. Dev transport logs the link to console;
  production transport is AWS SES (wired in TDA-004). Never blocks dev on SES approval.
- **MFA:** optional per-user TOTP (otplib). Enroll → activate (verify a code) → required at login.
  The TOTP secret is sensitive: stored **encrypted** via an interim AES-256-GCM helper keyed by
  `ENCRYPTION_KEY`, flagged for KMS migration in TDA-005.

## 3. Schema additions (one migration `tda002_auth`)

```prisma
model RefreshToken {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash    String    @unique          // sha256 of the opaque refresh token
  familyId     String                      // rotation lineage; reuse → revoke whole family
  expiresAt    DateTime
  revokedAt    DateTime?
  replacedById String?                      // the token that rotated this one
  userAgent    String?
  ip           String?
  createdAt    DateTime  @default(now())
  @@index([userId])
  @@index([familyId])
  @@map("refresh_tokens")
}

model VerificationToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  type      VerificationTokenType
  tokenHash String   @unique               // sha256 of the opaque token sent by email
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime @default(now())
  @@index([userId, type])
  @@map("verification_tokens")
}

enum VerificationTokenType { EMAIL_VERIFY PASSWORD_RESET }
```

Additions to the existing `User` model (from TDA-001):
```prisma
  mfaEnabled   Boolean  @default(false)
  mfaSecretEnc String?                      // encrypted TOTP secret (interim AES-GCM; KMS in TDA-005)
  lastLoginAt  DateTime?
  // back-relations:
  refreshTokens      RefreshToken[]
  verificationTokens VerificationToken[]
```

## 4. Module layout (follow existing convention)

```
apps/api/src/modules/auth/
  auth.module.ts
  controllers/   auth.controller.ts            index.ts
  services/      auth.service.ts               // orchestrates signup/login/verify/reset
                 token.service.ts              // issue/verify/rotate access+refresh
                 password.service.ts           // argon2 hash/verify + strength check
                 mfa.service.ts                // TOTP enroll/activate/verify
                 email/email.service.ts        // interface + ConsoleEmailTransport (+ SesEmailTransport stub)
                 index.ts
  dto/           (signup, login, verify, refresh, reset, mfa dtos)  index.ts
  strategies/    jwt.strategy.ts               // passport-jwt → validates access token
  guards/        jwt-auth.guard.ts             // global guard, honours @Public
apps/api/src/common/
  decorators/    public.decorator.ts  current-user.decorator.ts  index.ts
  crypto/        field-crypto.ts               // interim AES-256-GCM (ENCRYPTION_KEY); used for mfaSecretEnc
```

`JwtAuthGuard` is registered as an `APP_GUARD` in `auth.module.ts` so every route is protected
by default; `@Public()` opts a route out (signup/login/refresh/verify/forgot/reset are public).

## 5. Endpoints

| Method | Path | Public? | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | ✅ | email+password → create PENDING_VERIFICATION user, send verify email |
| POST | `/auth/verify-email` | ✅ | token → mark `emailVerifiedAt`, status ACTIVE |
| POST | `/auth/resend-verification` | ✅ | re-send verify email (rate-limited) |
| POST | `/auth/login` | ✅ | email+password → tokens, OR `{ mfaRequired: true, mfaToken }` if MFA on |
| POST | `/auth/login/mfa` | ✅ | mfaToken + 6-digit code → tokens |
| POST | `/auth/refresh` | ✅ | refresh token → new access+refresh (rotated); reuse → family revoked |
| POST | `/auth/logout` | 🔒 | revoke the caller's refresh token (family) |
| POST | `/auth/password/forgot` | ✅ | email → send reset link (always 200, no user enumeration) |
| POST | `/auth/password/reset` | ✅ | token + new password → set hash, revoke all refresh tokens |
| GET | `/auth/me` | 🔒 | current user profile (id, email, role, status, mfaEnabled) |
| POST | `/auth/mfa/enroll` | 🔒 | returns otpauth URI + base32 secret (not yet active) |
| POST | `/auth/mfa/activate` | 🔒 | verify a code → `mfaEnabled=true`, persist encrypted secret |
| POST | `/auth/mfa/disable` | 🔒 | password + code → disable MFA |

## 6. Key flows

**Signup → verify:** create user (argon2 hash, status `PENDING_VERIFICATION`); create
`VerificationToken(EMAIL_VERIFY)` (store only sha256, email the opaque token); on verify,
validate unexpired+unused, set `emailVerifiedAt`, status `ACTIVE`, mark token used.

**Login:** verify email is verified + status ACTIVE; argon2 verify password (timing-safe;
generic error on failure — no "wrong password" vs "no user" distinction). If `mfaEnabled`,
return a short-lived (`5m`) signed `mfaToken` instead of session tokens; `/auth/login/mfa`
verifies the TOTP code and issues tokens. Update `lastLoginAt`.

**Refresh rotation + reuse detection:** refresh presents an opaque token; look up by sha256.
If found & not revoked & not expired → issue a new access+refresh in the **same family**,
set old `revokedAt` + `replacedById`. If the presented token is **already revoked** (reuse) →
revoke the **entire family** (treat as theft) and reject. Logout revokes the family.

**Password reset:** `forgot` always returns 200 (no enumeration); if the user exists, create a
`VerificationToken(PASSWORD_RESET)` and email it. `reset` validates the token, sets a new
argon2 hash, and **revokes all of the user's refresh tokens**.

## 7. Security requirements

- Brute-force defence: per-IP + per-account rate limiting on `/auth/login`, `/auth/login/mfa`,
  `/auth/password/forgot`, `/auth/resend-verification` (use `@nestjs/throttler`).
- No user enumeration on signup/forgot (generic responses).
- Refresh tokens & verification tokens stored only as sha256 hashes.
- TOTP secret stored encrypted (interim AES-GCM; never returned after activation).
- Argon2id params: memoryCost ≥ 19456 KiB, timeCost ≥ 2 (tune to ~50–100ms).
- Every auth event (`AUTH_SIGNUP`, `AUTH_LOGIN`, `AUTH_LOGIN_FAILED`, `AUTH_MFA_*`,
  `AUTH_REFRESH`, `AUTH_REFRESH_REUSE`, `AUTH_LOGOUT`, `AUTH_PASSWORD_RESET`) writes to the
  `AuditLog` table (TDA-001). Hash-chaining is added in TDA-008; for now write rows with
  `hash`/`prevHash` left as simple values (a `null`/`""` placeholder is acceptable — TDA-008
  backfills chaining).

## 8. Libraries

`argon2`, `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`, `otplib`,
`@nestjs/throttler`. (`qrcode` optional — return the `otpauth://` URI and let the client render.)

## 9. Out of scope (explicit)

- `TenantGuard` + Prisma tenant auto-scoping + `RolesGuard` enforcement → **TDA-003** (this
  spec only embeds `role` in the JWT and exposes `req.user`).
- Real SES wiring + Secrets Manager + moving `JWT_SECRET`/`ENCRYPTION_KEY` out of `.env` →
  **TDA-004**. KMS envelope for `mfaSecretEnc` → **TDA-005**.
- Social/OAuth login — not in MVP.

## 10. Acceptance criteria

- A user can sign up, verify via the console-logged link, log in, and call `/auth/me` with the
  access token; an unverified user cannot log in.
- Protected routes reject missing/invalid/expired access tokens (401); `@Public` routes don't.
- Refresh rotates and **reusing a rotated refresh token revokes the family** (verified by test).
- Enrolling + activating TOTP makes login return an MFA challenge; a valid code completes login;
  an invalid code is rejected.
- Password reset sets a new password and invalidates all existing refresh tokens.
- `EmailService` is pluggable; dev transport logs, no real email required to pass tests.
- Auth events appear in `AuditLog`.
- `prisma validate` passes; integration + unit tests green against `td_saas_test`.
