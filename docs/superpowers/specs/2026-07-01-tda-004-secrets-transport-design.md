# TDA-004 — AWS Baseline: Secrets, KMS, Transport & Rate-Limit Hardening — Design Spec

**Doc ID:** TDA-004
**Date:** 2026-07-01
**Sprint:** S2 (Secrets, Transport & Credential Vault) — MVP
**Depends on:** — (runs in parallel with S1; no hard code dependency)
**Blocks:** TDA-005 (credential vault uses the `KmsProvider`/`SecretsProvider` seam), TDA-013 (HA infra reuses the Redis throttler + TLS posture)
**Owner:** development@panamoure.com

---

## 1. Goal

Move the platform off "works on my machine" secret handling and onto a
production-credible security baseline, **without** requiring a live AWS account
to develop or test against. Concretely:

1. **Kill the hardcoded encryption-key fallback.** `BrokerService` currently
   keys AES-256-GCM off `process.env.ENCRYPTION_KEY || 'td-automation-default-key-change-me'`.
   A deploy that forgets to set `ENCRYPTION_KEY` silently encrypts every broker
   credential under a **public, source-controlled key**. That fallback is deleted;
   a missing key fails loud at boot.
2. **Provider abstraction for secrets + KMS.** Introduce `SecretsProvider` and
   `KmsProvider` interfaces with a **local/env implementation** (dev/test) and an
   **AWS implementation** (prod, behind config). All secret and key-material
   access goes through these seams, so TDA-005's envelope encryption and the prod
   AWS wiring become thin adapters, and everything stays unit-testable offline now.
3. **Transport hardening.** Security headers (`helmet`), strict fail-closed CORS,
   and boot-time assertions that DB / AI-engine / Redis connections are TLS in
   production.
4. **Rate limiting that survives horizontal scaling.** Global per-IP rate
   limiting, plus the carried-forward **per-account** limiter (keyed on normalized
   email) for auth routes, with throttler/limiter storage moved to **Redis** so
   limits hold across API replicas.

This is the "secure the doors and the keys" spec. It does **not** implement
envelope encryption of the five Angel One fields — that is TDA-005, which consumes
the `KmsProvider` seam defined here.

---

## 2. Key design decision — provider abstraction over real AWS (MUST READ)

Real AWS KMS and Secrets Manager are **not available in local dev or CI**, and we
do not want to provision (and pay for / leak) real cloud resources just to run the
test suite. So the deliverable is built around two interfaces:

```
            ┌─────────────────────┐        ┌──────────────────┐
 app code ─►│  SecretsProvider    │◄─ factory selects by config
            │  getSecret(name)    │        │ EnvSecretsProvider│  (dev/test, default)
            └─────────────────────┘        │ AwsSecretsProvider│  (prod, gated)
            ┌─────────────────────┐        └──────────────────┘
 app code ─►│  KmsProvider        │◄─ factory selects by config
            │  wrapKey/unwrapKey  │        │ LocalKmsProvider  │  (dev/test, default)
            │  generateDataKey    │        │ AwsKmsProvider    │  (prod, gated)
            └─────────────────────┘        └──────────────────┘
```

**What ships in the MVP (this spec, executable now):**
- `SecretsProvider` + `KmsProvider` interfaces.
- `EnvSecretsProvider` — reads secrets from `process.env` (already loaded from the
  repo-root `.env` by `load-env.ts`). This is the dev/test default.
- `LocalKmsProvider` — a deterministic local key-wrapping implementation (AES key
  wrap using a local master key sourced from the `SecretsProvider`), so TDA-005 can
  build/test envelope encryption with no cloud.
- A `secretsProviderFactory` / `kmsProviderFactory` that selects the implementation
  from `SECRETS_PROVIDER` / `KMS_PROVIDER` config (`local` default, `aws` opt-in).
- The security hardening: removal of the hardcoded fallback, helmet, strict CORS,
  Redis-backed global + per-account rate limiting, transport boot assertions.

**What is specced but deployment-gated (NOT wired in the MVP build):**
- `AwsSecretsProvider` (wraps `@aws-sdk/client-secrets-manager`) and
  `AwsKmsProvider` (wraps `@aws-sdk/client-kms`). These are written as thin adapters
  but only constructed when `SECRETS_PROVIDER=aws` / `KMS_PROVIDER=aws`, and the
  `@aws-sdk/*` packages are added **only when prod wiring happens** (flagged, not a
  build dependency now). The KMS CMK + Secrets Manager provisioning (IaC) is
  documented here (§8) but executed at deploy time, outside the app test loop.

**Rationale:** the security *posture* (no public default key, TLS, headers, durable
rate limits, a single sanctioned path to every secret/key) is what protects the
MVP, and all of it is testable today. AWS is an adapter swap, not a rewrite. This
mirrors the program's "one deliberate seam" philosophy (roadmap §2) — the KMS grant
lives behind one interface that TDA-005's isolated execution module will own.

---

## 3. Secrets — `SecretsProvider`

**Location:** `apps/api/src/common/secrets/`

```ts
export interface SecretsProvider {
  /** Resolve a named secret; returns undefined if absent. Never throws on miss. */
  getSecret(name: string): Promise<string | undefined>;
  /** Convenience: resolve-or-throw for secrets that are mandatory. */
  getRequiredSecret(name: string): Promise<string>;
}
```

- `EnvSecretsProvider` resolves from `process.env[name]`. `getRequiredSecret`
  throws `MissingSecretError(name)` when unset/empty — **no defaults, ever.**
- `AwsSecretsProvider` (gated) resolves from AWS Secrets Manager
  (`GetSecretValue`), with a short in-process cache (Secrets Manager calls are
  billable + rate-limited) and a JSON-bundle convention (one secret per env, keys
  inside). On prod boot it pre-warms the known required names.
- `SECRETS_PROVIDER` config (`local` | `aws`, default `local`) selects the impl
  via `secretsProviderFactory`. The provider is registered as a `@Global` Nest
  module exporting the `SECRETS_PROVIDER` DI token, so any service injects the same
  instance.

**Required secrets** (asserted present at boot via `getRequiredSecret`, see §6):
`JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`. Optional-but-validated:
`WEB_ORIGIN` (required in prod), `REDIS_*`.

## 4. KMS — `KmsProvider` (seam for TDA-005)

**Location:** `apps/api/src/common/crypto/kms/`

```ts
export interface DataKey { plaintext: Buffer; wrapped: string; keyVersion: string; }

export interface KmsProvider {
  /** Generate a fresh per-tenant data key: plaintext (in-memory) + wrapped blob. */
  generateDataKey(): Promise<DataKey>;
  /** Unwrap a previously wrapped data key back to plaintext (in-memory, zeroize after). */
  unwrapKey(wrapped: string): Promise<Buffer>;
  /** Current key version/id for rotation tracking. */
  keyVersion(): string;
}
```

- `LocalKmsProvider` — master key derived from `SecretsProvider.getRequiredSecret('ENCRYPTION_KEY')`
  (sha256 → 32 bytes). `generateDataKey` mints a random 32-byte data key and wraps
  it with AES-256-GCM under the master key; `wrapped` is `v1:iv:tag:ct` (base64).
  `keyVersion()` returns `local-v1`. Deterministic, offline, test-friendly.
- `AwsKmsProvider` (gated) — `generateDataKey` calls KMS `GenerateDataKey`
  (CMK + `KeySpec=AES_256`), returns `Plaintext` + `CiphertextBlob`; `unwrapKey`
  calls KMS `Decrypt`. `keyVersion()` is the CMK key-id/alias. The **sole KMS grant**
  in prod is held by this provider (roadmap §2 isolated seam) — TDA-005 wires it
  into the execution module only.
- `KMS_PROVIDER` config (`local` | `aws`, default `local`) selects via `kmsProviderFactory`.

**Scope note:** TDA-004 ships the interface + `LocalKmsProvider` + the gated
`AwsKmsProvider` skeleton. The actual envelope encryption of broker fields, the
`encDataKey`/`keyVersion` columns, and the re-wrap rotation job are **TDA-005**.
TDA-004 does **not** touch `prisma/schema.prisma` (owned by TDA-008 this wave).

## 5. Remove the hardcoded encryption-key fallback

**Offender:** `apps/api/src/modules/broker/services/broker.service.ts:11-14`
```ts
private static readonly ENCRYPTION_KEY = crypto.createHash('sha256')
  .update(process.env.ENCRYPTION_KEY || 'td-automation-default-key-change-me')  // ← public default
  .digest();
```
Computed at **class-load**, so it cannot be made async/provider-injected without a
small refactor.

**Change:**
- Replace the static field with a lazily-evaluated accessor that derives the key
  from the `SecretsProvider` (or directly from `getRequiredSecret('ENCRYPTION_KEY')`),
  **with no default** — it throws `MissingSecretError('ENCRYPTION_KEY')` when unset.
- The AES-256-GCM ciphertext format (`ivHex:tagHex:ctHex`) is **unchanged**, so any
  rows already stored under a real (non-default) key still decrypt. (Rows encrypted
  under the *old default* were never production data; broker creds are rebuilt under
  envelope encryption in TDA-005 regardless — roadmap §8 TDA-003b note (a).)
- `field-crypto.ts` already throws when `ENCRYPTION_KEY` is unset (no default) — keep
  it, and route its key through the same accessor for consistency. The boot
  assertion (§6) makes the failure happen at startup, not first-use.

## 6. Boot-time configuration assertions (folds in a carried follow-up)

A `validateBootConfig(secrets, config)` run during bootstrap (before
`app.listen`) that **fails fast** rather than starting a half-secure server.
Folds in the TDA-002 carried follow-up "boot-time assertion that
`JWT_SECRET`/`ENCRYPTION_KEY` are set".

Assertions:
- `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL` present and non-empty (always).
- **Production only** (`NODE_ENV==='production'`):
  - `WEB_ORIGIN` set (CORS cannot fall back to localhost / wildcard).
  - `DATABASE_URL` carries `sslmode=require` (or `=verify-full`).
  - `AI_ENGINE_URL` uses `https://`.
  - `REDIS_TLS==='true'` (ElastiCache in-transit encryption) and the throttler
    storage is Redis (`REDIS_THROTTLER==='true'`).
  - `ENCRYPTION_KEY` is not the literal default sentinel and is ≥ 32 chars.
- Errors are aggregated and thrown as one `BootConfigError` listing every failure.

## 7. Transport hardening

### 7.1 Security headers — helmet
`helmet@8` is already a dependency but **not applied**. Add `app.use(helmet())` in
`main.ts` (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, no
`X-Powered-By`, referrer policy). Swagger UI at `/api/docs` may need a relaxed
`contentSecurityPolicy` (document the minimal CSP override rather than disabling).

### 7.2 Strict CORS (fail closed)
Current CORS (`main.ts:56-61`) defaults to `localhost:4000` when `WEB_ORIGIN` is
unset and is otherwise an env-split allowlist — acceptable for dev, unsafe as a
prod default. Change:
- Dev/test: keep the localhost allowlist default.
- Prod: `WEB_ORIGIN` is **required** (asserted in §6); no localhost fallback, never
  `origin:'*'` with `credentials:true`. Origin function rejects unknown origins.
- Note (coordination, not in scope): `signal.gateway.ts` WS CORS `origin:'*'` is
  tightened by TDA-006; this spec only governs the HTTP CORS. Flag for alignment.

### 7.3 TLS enforcement
- **API:** TLS terminates at the ALB/reverse proxy in prod (infra). In-app, trust
  the proxy (`app.set('trust proxy', 1)`) and add an `EnforceHttpsMiddleware` that,
  **in production only**, rejects requests where `x-forwarded-proto !== 'https'`
  (426 / redirect). HSTS via helmet. No-op in dev.
- **DB:** `sslmode=require` in the prod `DATABASE_URL` (asserted §6).
- **AI engine:** `AI_ENGINE_URL` must be `https://` in prod (asserted §6).
- **Redis:** `rediss://` / `tls:{}` for ElastiCache in prod (asserted §6).

## 8. Rate limiting — global + per-account, Redis-backed

### 8.1 Global per-IP (the shared seam)
Register the throttler centrally in `app.module.ts` (the documented shared seam —
keep edits **additive**) with one named throttler `default` (e.g. **120 req / 60 s
per IP**, env-tunable via `GLOBAL_RATE_LIMIT`/`GLOBAL_RATE_TTL`) and a global
`ThrottlerGuard` (`APP_GUARD`). Because the root `AppModule` is module-scanned
before `AuthModule`, this `APP_GUARD` runs **before** `JwtAuthGuard` — correct for a
rate limiter (limit before auth, no `req.user` needed).

The existing auth-route tightening stays: `@Throttle({ default: { limit: 10, ttl: 60000 } })`
on `login` / `login/mfa` / `password/forgot` overrides the per-IP limit on those
handlers. `AuthModule` drops its own `ThrottlerModule.forRoot` (now centralized) so
there is exactly one throttler config — a small, justified edit.

### 8.2 Per-account limiter (carried follow-up)
Per-IP alone lets a botnet spread a credential-stuffing attack across many IPs at
one account. Add an `AccountRateLimitGuard` keyed on **normalized email**
(`req.body.email`, lowercased/trimmed), applied via `@UseGuards` + an
`@AccountRateLimit({ limit, ttl })` decorator on `login` and `password/forgot`
(e.g. **5 / 15 min per account**). Exceeding → HTTP 429. It is a thin guard over a
`RateLimitStore` abstraction (see §8.3); it never reveals whether the account exists
(same 429 regardless), preserving the no-enumeration property.

### 8.3 Durable storage — Redis across replicas
Both limiters must hold across horizontally-scaled API replicas, so storage moves
off in-memory:
- A `RateLimitStore` interface (`hit(key, ttlMs): Promise<{count, ttlMs}>`) with a
  `MemoryRateLimitStore` (dev/test default) and a `RedisRateLimitStore`
  (ioredis `INCR` + `PEXPIRE`, gated by `REDIS_THROTTLER`/prod). Backs §8.2.
- For the `@nestjs/throttler` global guard (§8.1), provide a `ThrottlerStorage`
  that is the default in-memory store in dev/test and a Redis-backed store in prod
  (gated by `REDIS_THROTTLER`). `ioredis@5` is already a dependency — the single
  shared Redis client is exposed via a `REDIS_CLIENT` provider (the same connection
  Bull already uses; config from `redis.*`).

This keeps CI/dev fully offline (memory) while production gets cross-replica limits
— consistent with the provider-abstraction theme of §2.

## 9. Out of scope (deferred)

- Envelope encryption of the 5 Angel One fields, `encDataKey`/`keyVersion` columns,
  key-rotation re-wrap job — **TDA-005** (consumes the §4 `KmsProvider`).
- Actual AWS resource provisioning (CMK, Secrets Manager entries, ElastiCache,
  RDS Multi-AZ) — IaC executed at deploy; HA topology is **TDA-013**.
- WS-gateway CORS/auth tightening — **TDA-006**.
- `POST /auth/resend-verification` — separate TDA-002 follow-up, not this spec.
- Password-strength check / `algorithms:['HS256']` pin in `loginMfa` — minor TDA-002
  follow-ups; may be picked up opportunistically but are not TDA-004 acceptance.

## 10. Acceptance criteria

1. `SecretsProvider` + `KmsProvider` interfaces exist with `EnvSecretsProvider`,
   `LocalKmsProvider` (default) and config-selected factories; `AwsSecretsProvider`/
   `AwsKmsProvider` exist as deployment-gated skeletons not constructed unless
   `*_PROVIDER=aws`.
2. The string `td-automation-default-key-change-me` no longer exists in the codebase;
   a missing `ENCRYPTION_KEY` throws at boot (and at use), never silently defaults.
3. `validateBootConfig` fails startup when a required secret is missing, and (in
   prod) when DB/AI/Redis TLS or `WEB_ORIGIN` is not configured.
4. `helmet()` is applied; responses carry HSTS / `X-Content-Type-Options` /
   `X-Frame-Options`; `X-Powered-By` is absent. CORS rejects an unknown origin in
   prod and has no wildcard-with-credentials.
5. A global per-IP throttler is active app-wide via the `app.module.ts` seam; auth
   routes keep the tighter per-IP limit; a per-account limiter returns 429 after the
   account threshold regardless of source IP.
6. Rate-limit storage is pluggable: in-memory in test, Redis-backed when gated —
   verified by a `RedisRateLimitStore` unit test (against a stubbed/embedded ioredis)
   and a `MemoryRateLimitStore` unit test.

## 11. Test plan

- **Unit:** `EnvSecretsProvider.getRequiredSecret` throws on miss / returns on hit;
  `LocalKmsProvider` round-trips `generateDataKey`→`unwrapKey`; `validateBootConfig`
  aggregates failures (dev vs prod matrices); `MemoryRateLimitStore` /
  `RedisRateLimitStore` increment + TTL semantics; broker key accessor throws with
  no `ENCRYPTION_KEY` and uses no default (assert the sentinel string is gone).
- **Integration (`apps/api/test/tda004/`, Style-A boot harness from tda003):**
  helmet headers present + CORS rejects a foreign origin; global throttler returns
  429 after N requests; `AccountRateLimitGuard` 429s on the (N+1)th login for one
  email across two source IPs; `EnforceHttpsMiddleware` rejects non-https only in
  prod mode.
- **Regression / CI guard:** a test that greps the built source for the default-key
  sentinel and fails if it reappears.
- Run from `apps/api` with **`--verbose`** (jest 29.7 rejects `-v`):
  `npx jest --config test/tda004/jest.config.js --verbose`.
