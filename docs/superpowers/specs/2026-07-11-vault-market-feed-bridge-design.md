# Vault → Market-Feed Credential Bridge — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorming) — pending implementation
**Branch:** `feature/vault-market-feed-bridge`

---

## 1. Problem

The platform has **two independent Angel One credential paths**:

- **Order execution** — per-user, sourced from the encrypted credential vault (TDA-005)
  via `PerUserBrokerSessionFactory` + `CredentialDecryptor`. Correct and per-tenant.
- **Market data** (quotes, ticks, charts) — a single shared, always-on feed powered by
  `AngelOneAuthService`, which reads credentials **only from `ANGEL_ONE_*` environment
  variables**.

Because the two were never bridged, a user who connects their broker account through the
vault form still sees **demo/static market data** until someone also sets `ANGEL_ONE_*`
env vars on the server. The bridge method `AngelOneAuthService.updateCredentials()` was
built for exactly this hand-off but is **never called** (dead code).

**Goal:** let a *designated connected account's* vault credentials power the shared market
feed, so operating the platform does not require duplicating credentials into env vars —
while preserving an optional dedicated "house account" via env for production.

Market data is intentionally **one shared connection** (Angel One caps WebSocket at ~50
tokens; per-user feeds would not scale). So exactly one account powers the feed.

## 2. Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Which account powers the feed | A single **designated** account |
| How it is designated | **DB flag** `isFeedAccount` on `users` (no env var; admin-togglable) |
| Env credentials | **Env wins → vault fallback** (env = optional dedicated house account) |
| Decrypted-cred lifetime | **Ephemeral** — re-leased from the vault per login; secrets never held warm |
| Live "connect → feed up" trigger | **Deferred** to a follow-up; v1 logs in at boot |

## 3. Architecture

```
AngelOneAuthService.login()
   └─> FeedCredentialProvider.withFeedCredentials(use)
          1. ENV   — ANGEL_ONE_* set & non-placeholder ......... use(envCreds)
          2. VAULT — user WHERE isFeedAccount=true w/ creds .... CredentialDecryptor
                                                                  .withDecryptedCredentials(
                                                                    userId,{reason:'FEED'},use)
          3. NONE  — no feed creds ............................ hasFeedCredentials()=false
```

`market-data` depends on `credential-vault` (the decryptor) — a clean one-way dependency;
no circular import (the decryptor module depends only on Prisma/KMS/Audit).

### 3.1 `FeedCredentialProvider` (new — `market-data` module)

Single-purpose resolver. Public surface:

```ts
interface AngelOneCreds { apiKey; apiSecret; clientId; password; totpSecret }

class FeedCredentialProvider {
  // Runs `use` with the feed account's creds inside a bounded lease, then the
  // underlying vault lease zeroizes them. Throws NoFeedCredentialsError if none.
  withFeedCredentials<T>(use: (creds: AngelOneCreds) => Promise<T>): Promise<T>;
  // Cheap check used by onModuleInit to decide whether to attempt login.
  hasFeedCredentials(): Promise<boolean>;
}
```

Resolution order: **env → vault → none** (see 3). Env is considered "present" only when
`ANGEL_ONE_API_KEY` and `ANGEL_ONE_CLIENT_ID` are set, non-empty, and not the
`your_*_here` placeholders. The vault path calls the **existing**
`CredentialDecryptor.withDecryptedCredentials`, so decrypt→use→zeroize is unchanged.

Dependencies: `ConfigService`, `PrismaService`, `CREDENTIAL_DECRYPTOR`.

### 3.2 `DecryptContext.reason` gains `'FEED'`

`'ORDER' | 'REVALIDATE'` → `'ORDER' | 'REVALIDATE' | 'FEED'`. The `CREDENTIAL_DECRYPT`
audit row will record `reason: 'FEED'` so feed logins are attributable and distinct from
order-time decrypts.

### 3.3 `AngelOneAuthService` refactor (ephemeral secrets)

- Constructor no longer reads `ANGEL_ONE_*` into fields; it injects
  `FeedCredentialProvider`.
- `login()` wraps its work in a lease:

```
login(): provider.withFeedCredentials(async creds => {
  this.smartApi = new SmartAPI({ api_key: creds.apiKey })
  const totp = generateTOTP(creds.totpSecret)
  session = await this.smartApi.generateSession(creds.clientId, creds.password, totp)
  // STORE SESSION ONLY: jwtToken, refreshToken, feedToken, clientId, apiKey, client
  // NEVER store creds.password / creds.totpSecret
})
```

- **Sensitivity split:** the true authenticators (`password`, `totpSecret`) live only
  inside the lease and are zeroized on exit. The ~24h session token plus low-sensitivity
  identifiers (`clientId`, `apiKey`) and the authenticated `smartApi` client stay warm —
  enough for `getFeedToken()`, `getAuthToken()`, `refreshToken()`, `getClientId()`,
  `getApiKey()`, `logout()`.
- `onModuleInit()`: `if (await provider.hasFeedCredentials()) await login()` else warn and
  skip (feed serves demo data, as today).
- `refreshToken()` unchanged (uses the refresh token, needs no secrets); on failure it
  already falls back to `login()`, which now re-leases.
- **Delete the dead `updateCredentials()` method** — the provider supersedes it.

Public method signatures are otherwise unchanged, so `MarketFeedService`,
`AngelOneAdapterService`, etc. are unaffected. `MarketFeedService.onModuleInit` already
waits for `angelOneAuth.isAuthenticated()`, so the slower vault-backed boot login needs no
change there.

### 3.4 Schema + designation

- Prisma `User` gains `isFeedAccount Boolean @default(false)`.
- A **partial unique index** enforces at most one feed account:
  `CREATE UNIQUE INDEX users_is_feed_account_key ON users ("isFeedAccount") WHERE "isFeedAccount" = true;`
- One migration.

### 3.5 Admin endpoint

`PATCH /broker/feed-account { userId }` — admin-guarded. Transactionally clears any
existing feed account and sets the flag on `userId` (also verifies that user has a
`brokerCredential`, else 400). Returns the new feed account's id/email.

For immediate use, the flag will also be set directly on `anandmarks@gmail.com`.

## 4. Trigger model / scope

- **v1:** boot-time login via the resolver. Since the operator has already connected,
  a redeploy makes live data flow with **no env creds**. Refresh failures self-heal.
- **Deferred:** live re-login when the designated user connects at runtime (needs an
  event bus / forwardRef). Documented as a follow-up; a restart is acceptable for this
  infrequent admin action.

## 5. Error handling

- No feed creds anywhere → `onModuleInit` logs a warning and skips login; feed falls back
  to demo/REST as today. No crash.
- Vault decrypt/login failure → `login()`'s existing retry (3×) applies; after exhaustion
  it logs (masked) and the feed stays unauthenticated (demo data) until the next attempt.
- Env present but invalid → same failed-login path; env is not silently ignored.
- Secrets are never logged: the existing masking in `AngelOneAuthService` /
  `PerUserBrokerSessionFactory` patterns are followed (log error `name`, not `message`, on
  a failed `generateSession`).

## 6. Testing

- `FeedCredentialProvider`: env path, vault path, none path, **env-wins precedence**,
  placeholder detection.
- `AngelOneAuthService`: `login()` leases from a mock provider and stores session; asserts
  `password`/`totpSecret` are **not** retained on the instance; `onModuleInit` skips
  cleanly when `hasFeedCredentials()` is false; refresh→login fallback re-leases.
- Schema: partial-unique-index rejects a second feed account.
- Admin endpoint: admin-only guard; 400 when target has no broker credential; transactional
  swap.

## 7. Out of scope

- Live connect-trigger (deferred, §4).
- Admin UI toggle for the feed account (endpoint only for now).
- Market-data licensing / dedicated data-vendor integration (separate concern).
- Any change to the per-user execution path (unchanged).
