# TDA-005 — Per-Tenant Credential Vault + Envelope Encryption + "Connect Angel One" — Design Spec

**Doc ID:** TDA-005
**Date:** 2026-07-02
**Sprint:** S2 (Secrets, Transport & Credential Vault) — MVP
**Depends on:** TDA-001 (the vault-shaped `BrokerCredential` model + seeded ADMIN), TDA-004 (`KmsProvider`/`SecretsProvider` seams, `getEncryptionKey()`, boot assertions), TDA-003 (`TenantGuard` + Prisma auto-scoping, RBAC, `@CurrentUser`), TDA-008 (`AuditService.append` + `CREDENTIAL_*` taxonomy)
**Blocks:** TDA-010 (fan-out reads the decrypt-for-execution seam), TDA-011 (opt-in auto-execution decrypts per user before placing an order)
**Owner:** development@panamoure.com

---

## 1. Goal

Give every tenant a **cryptographically isolated home for their five Angel One
SmartAPI secrets** (API key, API secret, client-id, password/PIN, TOTP secret),
and a first-class **"Connect Angel One"** flow that proves the credentials work —
via a **real broker test login** — *before* anything is persisted.

Concretely:

1. **Per-user envelope encryption.** The KMS CMK (via TDA-004's `KmsProvider`)
   wraps a fresh **per-user 32-byte data key**; the five fields are each
   **AES-256-GCM** encrypted under that data key. The wrapped data key
   (`encDataKey`) and its `keyVersion` are stored on the row. Plaintext secrets
   and the plaintext data key exist **only in-memory**, are **zeroized** after
   use, and are **never logged**.
2. **A single decrypt-for-execution boundary.** Unwrapping the data key and
   decrypting the fields happens through **one narrow, scoped interface**
   (`CredentialDecryptor.withDecryptedCredentials`) that lives inside an
   **isolated execution submodule holding the sole KMS *unwrap* grant** (roadmap
   §2). It hands callers a *lease* (a callback scope), not raw plaintext, so
   zeroization is guaranteed. This is the exact seam TDA-010/011 consume.
3. **Validated connect UX.** `POST /api/broker/connect` performs an **ephemeral**
   Angel One `generateSession` with the submitted creds; only on success are they
   envelope-encrypted and upserted. A failed login persists **nothing**.
4. **Key-rotation re-wrap job.** A job re-wraps each `encDataKey` under the
   current CMK version without touching the field ciphertext (the point of
   envelope encryption — cheap rotation), tracking `keyVersion`.
5. **Rebuild `broker.service` onto the vault.** The current service references
   **removed plaintext columns** (`apiKey`/`clientId`/`password`/`totpSecret`) and
   a single-user `where: { broker }` — it does not type-check against the schema
   (roadmap §8, TDA-003b follow-up (a)). It is rebuilt per-user on the vault.

This spec **consumes** TDA-004's `KmsProvider` and TDA-008's `AuditService`; it
**owns** the `BrokerCredential` behavioural rebuild and one small additive schema
delta (§3.3). It does **not** build the per-user live-session fan-out or place
orders — that is TDA-010/011, which call the §6 seam.

---

## 2. Background — what exists today (corrected after code map)

- **Schema is already vault-shaped** (TDA-001). `prisma/schema.prisma` →
  `model BrokerCredential { id, userId @unique, broker @default("angel_one"),
  encApiKey, encApiSecret, encClientId, encPassword, encTotpSecret, encDataKey,
  keyVersion Int @default(1), isActive, lastConnected, lastValidated, createdAt,
  updatedAt }`. **No plaintext columns exist.** `BrokerCredential` is in
  `TENANT_MODELS` (`tenant.constants.ts`) → Prisma auto-scopes it by `userId`.
- **`broker.service.ts` is stale and does not compile against the schema.** It
  reads/writes `apiKey`/`clientId`/`password`/`totpSecret` (gone) and upserts on
  `where: { broker: 'angel_one' }` (there is no `@unique` on `broker` — only
  `userId @unique`). It builds under SWC (`typeCheck:false`) but is dead-wrong
  runtime code (roadmap §8 (a)). It also carries a single-user
  `onModuleInit` auto-connect and a `getSavedCredentials` that returns `apiKey`
  in the clear.
- **TDA-004 shipped the seams we consume:** `KmsProvider` (`generateDataKey`,
  `unwrapKey`, `keyVersion`) with `LocalKmsProvider` (default) + gated
  `AwsKmsProvider`; `@Global KmsModule`; `getEncryptionKey()`. Config keys
  `kms.provider` / `kms.cmkId` exist.
- **TDA-008 shipped `AuditService.append`** (`@Global AuditModule`) and the
  `CREDENTIAL_CONNECT`/`CREDENTIAL_DECRYPT`/`CREDENTIAL_ROTATE`/`CREDENTIAL_DELETE`
  actions are already **defined** in `audit-actions.ts` — TDA-005 is their first
  **emitter**.
- **Angel One access lives in `market-data`.** `AngelOneAuthService` is a
  **singleton holding one mutable session** seeded from `.env` (`ANGEL_ONE_*`),
  with a private RFC-6238 `generateTOTP`. It serves the **global market-data
  feed** (the engine/ADMIN account) and is *not* a per-user construct. TDA-005
  must **not** disturb that feed.
- **Frontend** (`apps/web/src/pages/settings/SettingsPage.tsx`) already has a
  "Connect Angel One" card that reads *"Coming soon — broker connection lands in
  TDA-005"*, plus a legacy Section-6 broker form posting to
  `/api/broker/test-connection` with `{apiKey, clientId}` only.

So TDA-005 is a **behavioural rebuild in place**: replace the stale broker service
with a per-user vault, add the envelope/decrypt/rotate machinery on top of the
existing TDA-004 seam, and wire the real "Connect Angel One" UX.

---

## 3. Envelope encryption scheme

### 3.1 The scheme (per user)

```
                    KMS CMK  (TDA-004 KmsProvider — the KEK)
                       │  generateDataKey()            wrapKey(dk)/unwrapKey(blob)
                       ▼
     ┌── per-user DATA KEY (32 bytes, random, in-memory only) ──┐
     │                                                          │
     │  AES-256-GCM (fresh 12-byte IV per field)                │
     │     encApiKey     = enc(apiKey,     dk)                  │
     │     encApiSecret  = enc(apiSecret,  dk)                  │  fields NEVER
     │     encClientId   = enc(clientId,   dk)                  │  touch the CMK
     │     encPassword   = enc(password,   dk)                  │  directly
     │     encTotpSecret = enc(totpSecret, dk)                  │
     └──────────────────────────────────────────────────────────┘
   stored on the row:  encApiKey … encTotpSecret,
                       encDataKey = wrapped(dk),  keyVersion = KmsProvider.keyVersion()
   plaintext dk + fields:  zeroized in a finally block; never logged.
```

- **Two-tier (envelope):** the CMK (KEK) never sees the field plaintext — it only
  wraps/unwraps the small per-user data key (DEK). Rotating the CMK re-wraps the
  DEK only; the five field ciphertexts are untouched (cheap rotation, §7).
- **Per-user DEK** → blast-radius isolation: compromising one user's wrapped DEK
  (without the CMK) reveals nothing, and a DEK compromise is scoped to one user.
- **Per-field IV** → each `enc*` column is an independent
  `base64(iv):base64(tag):base64(ct)` GCM blob (the format `field-crypto.ts`
  already uses), so the five columns can be decrypted independently and a swapped
  ciphertext fails its auth tag.

### 3.2 Field cipher helper

`apps/api/src/modules/credential-vault/crypto/field-cipher.ts` — pure functions
over an explicit `dataKey: Buffer` (no ambient key; the vault passes the unwrapped
DEK in):

```ts
export function encryptWithDataKey(plain: string, dataKey: Buffer): string;      // iv:tag:ct (base64)
export function decryptWithDataKey(blob: string, dataKey: Buffer): string;       // throws on tag mismatch
```

Distinct from `common/crypto/field-crypto.ts` (which keys off the ambient
`ENCRYPTION_KEY` for `User.mfaSecretEnc`) — the vault is **DEK-keyed**, not
env-keyed. Same GCM wire format for review familiarity.

### 3.3 Schema delta (THIS lane owns — additive, forward-only)

The vault columns already exist (TDA-001). Two minimal deltas:

```prisma
model BrokerCredential {
  // … existing columns …
  keyVersion    String    @default("local-v1")  // was Int — holds KmsProvider.keyVersion()
  lastRotatedAt DateTime?                         // NEW — last successful re-wrap (nullable)
  // encApiKey/encApiSecret/encClientId/encPassword/encTotpSecret/encDataKey unchanged
}
```

- `keyVersion Int → String`: `DataKey.keyVersion` is a **string**
  (`'local-v1'` / CMK id-or-alias). Storing it as text lets a row record exactly
  which KEK version wrapped its DEK — which the rotation job (§7) keys on.
  Migration: `ALTER COLUMN "keyVersion" TYPE TEXT USING "keyVersion"::text`,
  set default `'local-v1'`.
- `lastRotatedAt`: observability for the re-wrap job. Nullable, no backfill.
- **Coordination note:** TDA-004 explicitly did **not** touch the schema; this is
  the only S2 lane that migrates `BrokerCredential`. Forward migration only,
  **never `migrate reset`** (mirrors TDA-008's discipline). Existing dev rows are
  ADMIN/engine test data only.

---

## 4. `CredentialVaultService` — the write side (connect / store / rotate / delete)

**Location:** `apps/api/src/modules/credential-vault/services/credential-vault.service.ts`

Injects `KMS_PROVIDER` (TDA-004), `PrismaService`, `AuditService` (TDA-008), and
the §5 `AngelOneValidator`. Owns everything **except** decrypt-for-execution.

```ts
async connect(userId: string, dto: ConnectAngelOneDto, reqMeta: ReqMeta): Promise<ConnectResult>;
async disconnect(userId: string, reqMeta: ReqMeta): Promise<void>;   // delete row
async getStatus(userId: string): Promise<BrokerStatus>;             // NON-secret metadata only
async rewrapUser(userId: string): Promise<{ rotated: boolean; keyVersion: string }>; // §7
```

**`connect` algorithm:**

```
1. VALIDATE FIRST (nothing persisted yet):
     const ok = await validator.validateLogin(dto);   // ephemeral generateSession (§5)
     if (!ok.success) throw new UnprocessableEntityException('Angel One login failed');
2. ENVELOPE-ENCRYPT:
     const dk = await kms.generateDataKey();           // { plaintext, wrapped, keyVersion }
     try {
       const enc = {
         encApiKey:     encryptWithDataKey(dto.apiKey,     dk.plaintext),
         encApiSecret:  encryptWithDataKey(dto.apiSecret,  dk.plaintext),
         encClientId:   encryptWithDataKey(dto.clientId,   dk.plaintext),
         encPassword:   encryptWithDataKey(dto.password,   dk.plaintext),
         encTotpSecret: encryptWithDataKey(dto.totpSecret, dk.plaintext),
       };
       await prisma.brokerCredential.upsert({
         where:  { userId },
         create: { userId, broker: 'angel_one', ...enc, encDataKey: dk.wrapped,
                   keyVersion: dk.keyVersion, isActive: true,
                   lastValidated: new Date(), lastConnected: new Date() },
         update: { ...enc, encDataKey: dk.wrapped, keyVersion: dk.keyVersion,
                   isActive: true, lastValidated: new Date() },
       });
     } finally {
       dk.plaintext.fill(0);                            // zeroize the DEK
     }
3. AUDIT (metadata only — NO secrets):
     await audit.append({ action: 'CREDENTIAL_CONNECT', userId,
       target: 'angel_one', meta: { clientIdMasked: mask(dto.clientId), ...reqMeta } });
4. RETURN { connected: true, validatedAt } — never echo any secret.
```

- **Validate-before-persist** is non-negotiable: a bad-cred save that later fails
  silently at execution time is exactly the footgun we avoid.
- **Upsert on `userId`** (the real `@unique`) — one Angel One account per tenant.
  `TenantGuard` + Prisma scoping guarantee a user can only touch their own row;
  `userId` is passed explicitly for defence-in-depth.
- **`getStatus` returns NO secrets and decrypts NOTHING** — only
  `{ connected, broker, isActive, keyVersion, lastConnected, lastValidated,
  clientIdMasked }`. `clientIdMasked` is derived at *connect* time and stored…
  → see §4.1.

### 4.1 Displaying without decrypting

The old `getSavedCredentials` returned `apiKey`/`clientId` in the clear. Since all
five fields are now encrypted, the status view must not decrypt (decrypt is the
isolated grant, §6). Decision: store a **non-sensitive masked client-id**
(`clientIdMasked`, e.g. `A•••23`) as a plain column set at connect time, so
`getStatus` renders "Connected as A•••23" with **zero** KMS calls. (Added to the
§3.3 delta as `clientIdMasked String?`.) No other field is ever surfaced.

---

## 5. "Connect Angel One" — validation via a real test login

**Location:** `apps/api/src/modules/market-data/services/angel-one-validator.service.ts`
(exported from `MarketDataModule`; the SmartAPI client + TOTP generator live here).

```ts
async validateLogin(creds: {
  apiKey: string; clientId: string; password: string; totpSecret: string;
}): Promise<{ success: boolean; clientName?: string; reason?: string }>;
```

- Creates a **throwaway** `new SmartAPI({ api_key })`, computes a fresh TOTP from
  `totpSecret`, calls `generateSession(clientId, password, totp)`, and
  **immediately discards** the session (no token retention, no scheduled refresh).
- **Does NOT touch the market-data singleton** (`AngelOneAuthService`): the global
  feed session is never clobbered by a user's connect attempt.
- Extract the private `generateTOTP` from `angel-one-auth.service.ts` into a shared
  `market-data/utils/angel-one-totp.ts` and have both consume it (DRY; the
  validator must produce codes identically to the live login).
- Returns a **generic** failure reason to the caller; the raw SmartAPI error is
  logged server-side at `warn` **with the secrets stripped** (never log the
  password/TOTP). `apiSecret` is not used by SmartAPI `generateSession` today but
  is stored for order placement (TDA-011); its presence is validated by DTO shape,
  not by the login.

### 5.1 API surface (rebuilt `broker.controller.ts`)

All routes are authenticated (global `JwtAuthGuard`) and per-user via
`@CurrentUser('userId')`; `BrokerCredential` is tenant-scoped by TDA-003.

| Method + route | Body | Behaviour |
|---|---|---|
| `POST /api/broker/connect` | `ConnectAngelOneDto` (5 fields) | validate → encrypt → upsert → audit; `200 {connected,validatedAt}` or `422` (nothing saved) |
| `GET  /api/broker/status` | — | non-secret metadata (§4.1); `{connected:false}` if no row |
| `DELETE /api/broker` | — | delete row + audit `CREDENTIAL_DELETE`; `204` |

The legacy split (`/credentials` save + separate `/test-connection` +
`/connect` + `/disconnect` + `/account`) collapses: **connect = validate + store**
in one call. `GET /account` (live profile/RMS) is **out of scope** here — it needs
a *live per-user session*, which is TDA-010/011.

### 5.2 `ConnectAngelOneDto`

```ts
class ConnectAngelOneDto {
  @IsString() @IsNotEmpty() apiKey: string;
  @IsString() @IsNotEmpty() apiSecret: string;   // NEW — the 5th field
  @IsString() @IsNotEmpty() clientId: string;
  @IsString() @IsNotEmpty() password: string;    // PIN/password
  @IsString() @IsNotEmpty() totpSecret: string;  // base32 TOTP seed
}
```

The current 4-field DTO is missing `apiSecret` — one of the roadmap's five fields.
Added here.

### 5.3 Frontend

Replace the "Coming soon" placeholder in `SettingsPage.tsx` with a real form (5
inputs, secrets masked, never pre-filled from the server) posting to
`POST /api/broker/connect`; render `GET /api/broker/status`
("Connected as A•••23 · validated 2m ago") and a Disconnect button
(`DELETE /api/broker`). Remove the legacy Section-6 form and the
`/broker/test-connection` call. On `422`, show "Angel One rejected these
credentials" without leaking the broker's raw message.

---

## 6. The decrypt-for-execution boundary (the one deliberate seam)

This is the isolated module with the **sole KMS *unwrap* grant** (roadmap §2). It
is the **only** place a field is ever decrypted to plaintext.

**Location:** `apps/api/src/modules/credential-vault/execution/credential-decryptor.ts`
(an internal submodule; provider token `CREDENTIAL_DECRYPTOR`).

```ts
export interface DecryptedBrokerCredentials {
  apiKey: string; apiSecret: string; clientId: string; password: string; totpSecret: string;
}
export interface DecryptContext { reason: 'ORDER' | 'REVALIDATE'; signalId?: string; }

export interface CredentialDecryptor {
  /**
   * Lease THIS user's plaintext Angel One creds for the lifetime of `use` only.
   * Unwraps the DEK (KMS), decrypts the 5 fields, invokes `use`, then ALWAYS
   * zeroizes every plaintext buffer in a finally — even if `use` throws.
   * Emits one CREDENTIAL_DECRYPT audit row (metadata only). Returns use()'s result.
   */
  withDecryptedCredentials<T>(
    userId: string,
    ctx: DecryptContext,
    use: (creds: DecryptedBrokerCredentials) => Promise<T>,
  ): Promise<T>;
}
```

**Why a scoped lease, not a getter:** returning raw plaintext makes zeroization
the caller's responsibility (and it will be forgotten). The callback scope lets the
boundary own the full lifecycle: `unwrap → decrypt → use() → finally zeroize`.
TDA-011's `execute.user` job becomes:

```ts
await decryptor.withDecryptedCredentials(userId, { reason: 'ORDER', signalId },
  async (creds) => broker.placeOrder(creds, sizedOrder));   // creds gone after this scope
```

**Implementation:**

```
1. row = prisma.brokerCredential.findUniqueOrThrow({ where: { userId } });
2. const dk = await kms.unwrapKey(row.encDataKey);          // in-memory DEK
   let plain: DecryptedBrokerCredentials | null = null;
   try {
     plain = {
       apiKey:     decryptWithDataKey(row.encApiKey,     dk),
       apiSecret:  decryptWithDataKey(row.encApiSecret,  dk),
       clientId:   decryptWithDataKey(row.encClientId,   dk),
       password:   decryptWithDataKey(row.encPassword,   dk),
       totpSecret: decryptWithDataKey(row.encTotpSecret, dk),
     };
     await audit.append({ action: 'CREDENTIAL_DECRYPT', userId, target: 'angel_one',
       meta: { reason: ctx.reason, signalId: ctx.signalId, keyVersion: row.keyVersion } });
     return await use(plain);
   } finally {
     dk.fill(0);
     if (plain) zeroizeStrings(plain);   // best-effort scrub of the container
   }
```

- **Sole grant, isolated:** only `CredentialDecryptorModule` injects `KMS_PROVIDER`
  for `unwrapKey`. In prod, only this module's IAM role is granted CMK `Decrypt`
  (§9). The write side (§4) needs `GenerateDataKey`/`Encrypt` — a **different**
  grant — so connect and decrypt are separable IAM principals from day one.
- **Minimal & explicit for TDA-010/011:** they depend on **only**
  `CredentialDecryptor` (one method) — no schema, no crypto, no KMS knowledge. If
  the execution path later lifts into its own service/VPC (roadmap §2), this
  interface is the wire contract; nothing else moves.
- **Never logged:** `CREDENTIAL_DECRYPT` records *that* a decrypt happened (who,
  why, `signalId`, `keyVersion`) — **never** the plaintext (TDA-008 §5). No
  `console`/`Logger` call in this file ever receives a plaintext value.
- **JS zeroization caveat (documented, not hidden):** `Buffer.fill(0)` reliably
  scrubs the DEK; JS `string` immutability means the field strings can linger
  until GC. We minimise exposure (shortest possible lease, no retention, no logs)
  and scrub the container object; true wipe would require Buffer-only handling
  end-to-end into the broker client — flagged as a hardening follow-up for
  TDA-011's order path.

---

## 7. Key-rotation re-wrap job

**Location:** `apps/api/src/modules/credential-vault/jobs/credential-rewrap.job.ts`
(a Bull/cron processor, mirroring the existing worker pattern).

**Goal:** when the CMK version advances (`KmsProvider.keyVersion()` changes), re-wrap
every `encDataKey` under the new version **without decrypting any field**:

```
for each BrokerCredential where keyVersion != kms.keyVersion():
   const dk = await kms.unwrapKey(row.encDataKey);      // old KEK still resolves it
   try {
     const rewrapped = await kms.wrapKey(dk);            // { wrapped, keyVersion } — NEW KEK
     await prisma.brokerCredential.update({ where: { id: row.id },
       data: { encDataKey: rewrapped.wrapped, keyVersion: rewrapped.keyVersion,
               lastRotatedAt: new Date() } });
     await audit.append({ action: 'CREDENTIAL_ROTATE', userId: row.userId,
       target: 'angel_one', meta: { from: row.keyVersion, to: rewrapped.keyVersion } });
   } finally { dk.fill(0); }
```

- **Fields are never touched** — only the wrapped DEK changes. This is the whole
  economic point of envelope encryption: rotating the KEK is O(users) tiny writes,
  not O(users × fields) re-encryption.
- Runs **inside the isolated execution module** (it needs `unwrapKey` — the
  decrypt grant) and additionally `wrapKey`.
- Idempotent: rows already at the current `keyVersion` are skipped, so re-runs are
  safe; the job can be triggered manually (ADMIN) or on a schedule.

### 7.1 Required `KmsProvider` extension (coordination with TDA-004)

The TDA-004 `KmsProvider` interface has `generateDataKey` / `unwrapKey` /
`keyVersion` but **no way to wrap a data key we already hold** — `generateDataKey`
always mints a *new* random key, which would force full field re-encryption. Add
**one additive method** (backward-compatible):

```ts
export interface KmsProvider {
  generateDataKey(): Promise<DataKey>;
  unwrapKey(wrapped: string): Promise<Buffer>;
  wrapKey(plaintext: Buffer): Promise<{ wrapped: string; keyVersion: string }>;  // NEW (TDA-005)
  keyVersion(): string;
}
```

- `LocalKmsProvider.wrapKey` = AES-256-GCM wrap of `plaintext` under
  `getEncryptionKey()` (identical framing to its `generateDataKey` wrap;
  refactor the two to share a private `wrap()`), `keyVersion:'local-v1'`.
- `AwsKmsProvider.wrapKey` = KMS `Encrypt` (a 32-byte DEK is well under the 4 KB
  limit), returning `base64(CiphertextBlob)` + the CMK id.

This lightly extends the TDA-004 seam. It is additive (no existing caller breaks)
and is the cleanest way to support envelope re-wrap. **Flagged as the one genuine
cross-spec coordination item** (§10).

---

## 8. Rebuilding `broker.service` onto the vault

`broker.service.ts` is replaced by `CredentialVaultService` (§4) + the isolated
decryptor (§6). Migration of the existing module:

- **Delete** the static AES helpers, the `getEncryptionKey()` field encryption
  (superseded by DEK-keyed `field-cipher`), the plaintext-column reads/writes, and
  the `where: { broker }` upsert.
- **Remove** the single-user `onModuleInit` auto-connect. It is a single-tenant
  relic; per-user login now happens on-demand in the execution path (TDA-010/011).
  **This does not affect the global market-data feed** — `AngelOneAuthService`
  keeps its own `.env`-seeded `onModuleInit` login for the engine account.
- `BrokerModule` re-exports `CredentialVaultService`; the isolated
  `CredentialDecryptorModule` exports `CREDENTIAL_DECRYPTOR` for TDA-010/011.
- **ADMIN engine account (out of scope, noted):** the engine's own Angel One creds
  stay in `.env` for the global feed at MVP. Optionally they can later be stored
  in the vault under `SYSTEM_USER_ID` and read via the same seam — not required
  here.

---

## 9. AWS posture (deployment-gated — not in the MVP test loop)

Mirrors TDA-004's gating (`KMS_PROVIDER=aws` flips the factory; `@aws-sdk/*` stays
a dynamic import, never a test-build dep). Documented, executed at deploy:

- **Two IAM grants on the one CMK, deliberately split:**
  - the **connect/write** role → `GenerateDataKey`, `Encrypt` (and `Encrypt` for
    re-wrap);
  - the **execution/decrypt** role (`CredentialDecryptorModule`) → `Decrypt`
    **only** — the sole unwrap principal (roadmap §2).
- CMK key policy denies `Decrypt` to every principal except the execution role.
- CMK rotation (annual auto, or manual re-key) triggers the §7 re-wrap job.
- No plaintext secret is ever written to logs, metrics, or Secrets Manager; the
  vault is the sole store, KMS the sole KEK.

---

## 10. Open decisions (for the human)

1. **`KmsProvider.wrapKey` extension (§7.1).** Default chosen: add the one additive
   method so re-wrap does not re-encrypt fields. It touches a TDA-004-owned
   interface — confirm TDA-005 may extend it (additive, no breakage), vs. doing
   full field re-encryption on rotation (no interface change, far costlier).
2. **`keyVersion Int → String` migration (§3.3).** Default chosen: repurpose the
   column to hold the KMS version string. Confirm acceptable vs. adding a separate
   `kmsKeyId String` and keeping `keyVersion` a local counter (more columns, same
   effect).
3. **String-plaintext zeroization (§6).** Default chosen: Buffer-wipe the DEK,
   best-effort scrub the field container, minimise lease lifetime, and defer
   true Buffer-only handling to TDA-011's order path. Confirm this residual is
   acceptable for MVP.
4. **ADMIN engine account (§8).** Default chosen: leave the global-feed creds in
   `.env` at MVP. Confirm we are not required to vault the engine account now.

---

## 11. Acceptance criteria

1. `BrokerCredential` stores only ciphertext: the 5 `enc*` fields are AES-256-GCM
   under a per-user DEK, `encDataKey` is the wrapped DEK, `keyVersion` is a string
   set from `KmsProvider.keyVersion()`. No plaintext secret is ever persisted or
   logged. `broker.service`'s stale plaintext-column code is gone (compiles clean
   against the schema).
2. `POST /api/broker/connect` performs a **real ephemeral** Angel One login first;
   on failure it returns `422` and **persists nothing**; on success it
   envelope-encrypts + upserts (per `userId`) and emits `CREDENTIAL_CONNECT`. The
   validator never mutates the market-data singleton session.
3. Round-trip: for any user, encrypt-then-`withDecryptedCredentials` yields the
   original five values; a tampered `enc*` blob or `encDataKey` fails its GCM auth
   tag (throws, no plaintext).
4. Decryption occurs **only** inside `CredentialDecryptor` (the sole `unwrapKey`
   caller); it hands a scoped lease, zeroizes the DEK in a `finally`, emits
   `CREDENTIAL_DECRYPT` with **no** secret in `meta`, and is the only symbol
   TDA-010/011 import.
5. The re-wrap job re-wraps `encDataKey` under the current `keyVersion` **without
   changing any field ciphertext**, updates `keyVersion`/`lastRotatedAt`, emits
   `CREDENTIAL_ROTATE`, and is idempotent (skips already-current rows).
6. `GET /api/broker/status` returns non-secret metadata only (incl.
   `clientIdMasked`) and performs **zero** KMS calls; `DELETE /api/broker` removes
   the row and emits `CREDENTIAL_DELETE`. All routes are per-user (TenantGuard).
7. Schema migration is forward-only (no `migrate reset`); `prisma migrate status`
   clean before + after; the new modules are registered additively in
   `app.module.ts`.

---

## 12. Test plan

- **Unit (`apps/api/test/tda005/`):**
  - `field-cipher` round-trips under a fixed DEK; a flipped byte in the blob throws
    (auth-tag fail); distinct IV per call (two encrypts of the same plaintext
    differ).
  - `LocalKmsProvider.wrapKey` (§7.1) round-trips with `unwrapKey`; a tampered
    wrapped blob throws; `keyVersion` is `'local-v1'`.
  - Envelope round-trip: `generateDataKey → encrypt 5 → unwrapKey → decrypt 5`
    equals the originals; tampering `encDataKey` throws.
  - A source-scan test asserting **no plaintext logging** in the decryptor and no
    stale plaintext-column references remain in `broker.service`
    (regression guard: grep for `.password`/`.totpSecret` reads on
    `brokerCredential`).
- **Integration (DB-backed, `td_saas_test`, Style-A boot harness from tda003):**
  - `connect` with a **mocked** `AngelOneValidator` → success path persists
    ciphertext + `CREDENTIAL_CONNECT` audit row (verify chain still `ok`);
    failure path (`validateLogin` returns `{success:false}`) → `422`, **zero**
    rows written.
  - `withDecryptedCredentials(userId, …)` returns the connected user's plaintext
    and writes exactly one `CREDENTIAL_DECRYPT` row; asserts the `meta` contains no
    secret substring.
  - Re-wrap job: seed a row with a stale `keyVersion`, run job → `encDataKey`
    changes, field columns **unchanged**, `keyVersion` current,
    `CREDENTIAL_ROTATE` emitted; re-run → no-op (idempotent).
- **HTTP (Style-A focused boot):** `POST /api/broker/connect` (mocked validator)
  200; `GET /api/broker/status` reflects masked client-id and does not call KMS;
  a **second** user cannot see the first user's row (TenantGuard) → their status is
  `{connected:false}`; `DELETE /api/broker` → 204 + `CREDENTIAL_DELETE`.
- Jest 29.7 — run **from `apps/api`** with `--verbose` (not `-v`):
  `npx jest --config test/tda005/jest.config.js --verbose` (prefix
  `DATABASE_URL_TEST=…` for DB-backed specs).
