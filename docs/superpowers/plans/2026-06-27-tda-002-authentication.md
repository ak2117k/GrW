# TDA-002 Authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Public signup + email verification, argon2 password login with optional TOTP MFA, stateless access + rotating refresh tokens with reuse detection, password reset, logout, and a global `JwtAuthGuard` populating `req.user`.

**Architecture:** A new NestJS `auth` module following the repo's `controllers/ services/ dto/` convention. `JwtAuthGuard` registered as a global `APP_GUARD`, opt-out via `@Public()`. Pluggable `EmailService` (console dev / SES prod). Spec: `docs/superpowers/specs/2026-06-27-tda-002-authentication-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (Postgres `td_saas`), `argon2`, `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `otplib`, `@nestjs/throttler`, Jest + ts-jest.

## Global Constraints

- **Database:** dev `td_saas`, tests against `td_saas_test` (env `DATABASE_URL_TEST`). Run Prisma from worktree root with `--schema prisma/schema.prisma`. DB admin via `docker exec td-postgres psql -U <user-from-.env>`. Never `prisma migrate reset`.
- **Tokens:** access JWT HS256, TTL `15m`; refresh opaque random (32 bytes base64url), TTL `30d`, stored as sha256 hash, rotating with family-reuse revocation. Sign with `process.env.JWT_SECRET`.
- **Hashing:** argon2id, `memoryCost: 19456, timeCost: 2, parallelism: 1`.
- **Token/secret storage:** refresh + verification tokens stored only as sha256 hashes; TOTP secret stored AES-256-GCM-encrypted via `common/crypto/field-crypto.ts` keyed by `process.env.ENCRYPTION_KEY` (interim; KMS in TDA-005).
- **No user enumeration:** `/auth/signup` and `/auth/password/forgot` return generic success regardless of whether the email exists.
- **Audit:** each auth event writes an `AuditLog` row (action strings per spec §7); leave `hash`/`prevHash` as `""` (TDA-008 adds chaining).
- **Global guard:** `JwtAuthGuard` as `APP_GUARD`; public routes use `@Public()`.
- **Module convention:** mirror `apps/api/src/modules/settings/` (subfolders + barrel `index.ts` + `<name>.module.ts`).
- **Commit prefix:** `TDA-002:`. Do not commit `.env`.

---

## File Structure

- `prisma/schema.prisma` — add `RefreshToken`, `VerificationToken`, `VerificationTokenType`, User fields.
- `apps/api/src/common/crypto/field-crypto.ts` — interim AES-256-GCM encrypt/decrypt.
- `apps/api/src/common/decorators/{public,current-user}.decorator.ts` + `index.ts`.
- `apps/api/src/modules/auth/` — module, controller, services (`auth`, `token`, `password`, `mfa`, `email/email.service`), `strategies/jwt.strategy.ts`, `guards/jwt-auth.guard.ts`, `dto/`.
- Tests under `apps/api/test/tda002/` (integration) and co-located `*.spec.ts` (unit).

---

### Task 1: Auth schema, migration, and field-crypto util

**Files:** Modify `prisma/schema.prisma`; create migration `…_tda002_auth`; create `apps/api/src/common/crypto/field-crypto.ts` + `field-crypto.spec.ts`.

**Interfaces — Produces:**
- Models `RefreshToken`, `VerificationToken` + enum `VerificationTokenType` (exact shapes in spec §3); User gains `mfaEnabled`, `mfaSecretEnc`, `lastLoginAt`, and back-relations `refreshTokens`, `verificationTokens`.
- `encryptField(plain: string): string` / `decryptField(cipher: string): string` (AES-256-GCM, key = sha256(`ENCRYPTION_KEY`), output `iv:tag:ciphertext` base64).

- [ ] **Step 1: Write `field-crypto.spec.ts` (round-trip + tamper)**
```ts
import { encryptField, decryptField } from './field-crypto';
beforeAll(() => { process.env.ENCRYPTION_KEY = 'test-key-32-bytes-long-aaaaaaaaaa'; });
it('round-trips', () => { const c = encryptField('s3cret'); expect(c).not.toContain('s3cret'); expect(decryptField(c)).toBe('s3cret'); });
it('rejects tampered ciphertext', () => { const c = encryptField('x'); const bad = c.slice(0,-2)+'aa'; expect(() => decryptField(bad)).toThrow(); });
```
- [ ] **Step 2: Run → FAIL** (`field-crypto` missing). `cd apps/api && npx jest src/common/crypto/field-crypto.spec.ts`
- [ ] **Step 3: Implement `field-crypto.ts`** using Node `crypto` (`createCipheriv('aes-256-gcm', key, iv)`, random 12-byte iv, store `base64(iv):base64(tag):base64(ct)`; key = `createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Add the three models/enum + User fields to `prisma/schema.prisma`** (verbatim from spec §3, including back-relations on User).
- [ ] **Step 6: Generate + apply migration**
`npx prisma migrate dev --name tda002_auth --schema prisma/schema.prisma` then deploy to test DB: `DATABASE_URL=<.env url with /td_saas→/td_saas_test> npx prisma migrate deploy --schema prisma/schema.prisma`; `npx prisma generate`.
- [ ] **Step 7: Commit** `git commit -m "TDA-002: auth schema (refresh/verification tokens, MFA fields) + field-crypto"`

---

### Task 2: PasswordService + TokenService (rotation & reuse detection)

**Files:** `services/password.service.ts` (+spec), `services/token.service.ts` (+ integration spec in `test/tda002/token.service.spec.ts`).

**Interfaces:**
- Consumes: Prisma `RefreshToken`, `field-crypto` not needed here.
- Produces:
  - `PasswordService.hash(plain): Promise<string>`, `verify(hash, plain): Promise<boolean>` (argon2id, params per constraints).
  - `TokenService.issuePair(user, ctx): Promise<{accessToken, refreshToken}>` — signs access JWT `{ sub, role, email }` 15m; creates a new `RefreshToken` row (new `familyId`), returns the opaque refresh token (caller never sees the hash).
  - `TokenService.rotate(refreshToken, ctx): Promise<{accessToken, refreshToken}>` — see algorithm below.
  - `TokenService.revokeFamily(familyId): Promise<void>`; `TokenService.verifyAccess(token): payload`.

- [ ] **Step 1: Write `token.service.spec.ts` covering the security-critical paths**
```ts
it('rotate issues a new pair and revokes the old token', async () => {/* issue → rotate → old.revokedAt set, new token works */});
it('reusing a rotated refresh token revokes the entire family', async () => {
  const { refreshToken } = await svc.issuePair(user, ctx);
  const rotated = await svc.rotate(refreshToken, ctx);          // refreshToken now revoked
  await expect(svc.rotate(refreshToken, ctx)).rejects.toThrow(); // reuse
  await expect(svc.rotate(rotated.refreshToken, ctx)).rejects.toThrow(); // family nuked
});
it('rejects expired or unknown refresh tokens', async () => {/* ... */});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `rotate` algorithm: sha256 the presented token → find `RefreshToken`. If none → throw. If `revokedAt != null` → **reuse**: `revokeFamily(familyId)` then throw. If `expiresAt < now` → throw. Else: create new token (same `familyId`), set old `revokedAt=now`, `replacedById=new.id`, return new pair. Hash passwords with argon2id params from constraints.
- [ ] **Step 4: Run → PASS** (against `td_saas_test`).
- [ ] **Step 5: Commit** `TDA-002: password hashing + token issue/rotate with reuse detection`

---

### Task 3: Pluggable EmailService

**Files:** `services/email/email.service.ts`, `email/console.transport.ts`, `email/ses.transport.ts` (stub throwing "configure SES in TDA-004"), `email/email.types.ts`, `+ email.service.spec.ts`.

**Interfaces — Produces:**
- `interface EmailTransport { send(msg: { to; subject; html; text }): Promise<void> }`.
- `EmailService.sendVerification(to, link)`, `sendPasswordReset(to, link)` — compose message, delegate to the configured transport. Transport chosen by `EMAIL_TRANSPORT` env (`console` default, `ses` prod).
- `ConsoleEmailTransport.send` logs `to`, `subject`, and the link via Nest `Logger`.

- [ ] **Step 1: Spec** — `sendVerification` with console transport logs the link; SES transport `send` rejects with the stub error.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** interface + two transports + provider that selects by env.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-002: pluggable EmailService (console dev / SES stub)`

---

### Task 4: Auth core — signup/verify/login/refresh/logout/me + global guard

**Files:** `auth.module.ts`, `controllers/auth.controller.ts`, `services/auth.service.ts`, `strategies/jwt.strategy.ts`, `guards/jwt-auth.guard.ts`, `common/decorators/{public,current-user}.decorator.ts`, dto files; register `AuthModule` in `app.module.ts`; integration tests `test/tda002/auth-core.spec.ts`. Consumes Tasks 1–3.

**Interfaces:**
- `@Public()` sets metadata `isPublic=true`; `JwtAuthGuard` (extends `AuthGuard('jwt')`) returns true when `isPublic`. `@CurrentUser()` extracts `req.user`.
- `JwtStrategy.validate(payload)` → `{ userId: payload.sub, role, email }` (becomes `req.user`).
- `AuthService.signup(dto)`, `verifyEmail(token)`, `login(dto, ctx)`, `refresh(token, ctx)`, `logout(user)`, `me(userId)`.

- [ ] **Step 1: Integration spec** `auth-core.spec.ts` (bootstrap a Nest test app, real `td_saas_test`):
```ts
it('signup → cannot login until verified → verify → login → /me', async () => {/* console transport exposes token via a test hook or read VerificationToken hash path */});
it('protected route 401 without token; 200 with access token', async () => {/* GET /auth/me */});
it('refresh returns a new pair; old refresh reuse → 401', async () => {/* ... */});
```
> For the verify token in tests: expose the raw token through the `AuthService.signup` return ONLY in `NODE_ENV=test`, or read it from a test-only seam — do not weaken production. Document the seam in the report.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** services + controller + strategy + guard + decorators; register `JwtAuthGuard` as `APP_GUARD` and `JwtModule.register({ secret: process.env.JWT_SECRET })` in `auth.module.ts`; import `AuthModule` in `app.module.ts`. Mark signup/verify/login/refresh/forgot/reset `@Public()`. Block login when `status !== ACTIVE` or `emailVerifiedAt == null`. Write `AuditLog` rows for signup/login/login-failed/refresh/refresh-reuse/logout.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-002: auth core (signup/verify/login/refresh/logout/me) + global JwtAuthGuard`

---

### Task 5: TOTP MFA

**Files:** `services/mfa.service.ts` (+spec), MFA endpoints in `auth.controller.ts`, `login/mfa` in `auth.service.ts`, dto; integration `test/tda002/mfa.spec.ts`. Consumes Task 4 + `field-crypto`.

**Interfaces — Produces:**
- `MfaService.enroll(userId): { otpauthUri, secret }` (generates base32 secret, returns but not yet active).
- `MfaService.activate(userId, code)` — verify TOTP against the pending secret → store `mfaSecretEnc = encryptField(secret)`, `mfaEnabled=true`.
- `MfaService.verify(userId, code): boolean` (decrypt secret, otplib check, ±1 window).
- `AuthService.login` returns `{ mfaRequired: true, mfaToken }` (signed 5m JWT, audience `mfa`) when `mfaEnabled`; `loginMfa(mfaToken, code, ctx)` verifies and issues the real pair.

- [ ] **Step 1: Spec** — enroll→activate flips `mfaEnabled`; login then returns `mfaRequired`; valid code via `/auth/login/mfa` issues tokens; invalid code rejected; secret never returned after activation.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with otplib; store encrypted secret; audit `AUTH_MFA_ENROLL/ACTIVATE/DISABLE/CHALLENGE`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-002: optional TOTP MFA (enroll/activate/disable + login challenge)`

---

### Task 6: Password reset + rate limiting + audit completeness

**Files:** `forgot`/`reset` in controller+service, `@nestjs/throttler` config in `auth.module.ts` (or `app.module.ts`), dto; integration `test/tda002/password-reset.spec.ts`. Consumes Tasks 2–4.

**Interfaces — Produces:**
- `AuthService.forgotPassword(email)` — always succeeds outwardly; if user exists, create `VerificationToken(PASSWORD_RESET)` + email link.
- `AuthService.resetPassword(token, newPassword)` — validate token, set new argon2 hash, **revoke all user refresh tokens**, mark token used.

- [ ] **Step 1: Spec** — `forgot` returns 200 for unknown email (no enumeration); `reset` changes password + invalidates all refresh tokens (old refresh now 401); throttler returns 429 after the configured burst on `/auth/login`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** flows + `ThrottlerModule` (e.g. 10 req/min on auth routes) + `AUTH_PASSWORD_RESET` audit.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-002: password reset + login rate limiting + audit events`

---

## Self-Review

- Spec coverage: §3 schema → T1; §6 token rotation/reuse → T2; pluggable email §2/§8 → T3; signup/verify/login/refresh/logout/me + global guard §4/§5 → T4; MFA §5/§6 → T5; reset + throttling + no-enumeration §6/§7 → T6. Audit §7 spread across T4–T6. ✅
- Deferred: TenantGuard/RBAC (TDA-003), SES/Secrets (TDA-004), KMS for `mfaSecretEnc` (TDA-005) — not implemented here. ✅
- Implementer judgement flagged: the test-only seam to read the email verification token (T4 Step 1) must not weaken production; document it.
- Type consistency: `issuePair`/`rotate`/`revokeFamily`/`verifyAccess` names used identically across T2 and T4–T6.
