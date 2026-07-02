# TDA-005 Per-Tenant Credential Vault + Envelope Encryption + "Connect Angel One" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is TDD: write the failing test, run → FAIL, implement, run → PASS, commit.

**Goal:** Give each tenant an envelope-encrypted home for their five Angel One secrets (CMK-wrapped per-user data key; 5 fields AES-256-GCM under that DEK), a real-login-validated "Connect Angel One" flow, a decrypt-for-execution boundary that is the sole KMS-unwrap grant (the TDA-010/011 seam), and a key-rotation re-wrap job — and rebuild the stale `broker.service` onto the vault.

**Architecture:** `CredentialVaultService` owns the write side (connect/store/rotate/delete) and injects `KMS_PROVIDER` for `generateDataKey`/`wrapKey`. An **isolated** `CredentialDecryptorModule` is the **only** `unwrapKey` caller and exposes one method, `withDecryptedCredentials(userId, ctx, use)`, that leases plaintext for a callback scope then zeroizes it — this is the minimal seam TDA-010/011 consume. Field crypto is DEK-keyed (`field-cipher.ts`), distinct from the env-keyed `common/crypto/field-crypto.ts`. Validation uses an ephemeral Angel One login (`AngelOneValidator`) that never touches the market-data singleton. Every credential event routes through `AuditService.append` (TDA-008). See spec `docs/superpowers/specs/2026-07-02-tda-005-credential-vault-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (Postgres `td_saas`/`td_saas_test`), Node `crypto`, `smartapi-javascript` (already used by market-data), Jest 29.7 + ts-jest. Consumes TDA-004 (`KmsProvider`, `KMS_PROVIDER`, `getEncryptionKey`), TDA-008 (`AuditService`, `AUDIT_ACTIONS.credential`), TDA-003 (`@CurrentUser`, `TenantGuard`, Prisma scoping). `@aws-sdk/*` stays a dynamic import (never added to the test build).

## Global Constraints

- **Parallel worktree from `main`.** THIS lane runs a **forward-only** migration on `prisma/schema.prisma` (`BrokerCredential` only — §3.3). **Never `prisma migrate reset`**, never edit a prior migration. Coordinate: no other S2 lane touches `BrokerCredential`. `prisma migrate status` must be clean before and after. DB: dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`.
- **Shared seam `app.module.ts`** — register `CredentialVaultModule` + `CredentialDecryptorModule` additively (do not reorder existing imports/guards; `BrokerModule` already imported at line ~146).
- **Commit prefix:** `TDA-005:`. No `.env` committed. Stage only changed files (no `git add -A`).
- **No plaintext ever persisted or logged.** The 5 fields + the DEK live in-memory only; `Buffer.fill(0)` the DEK in a `finally`; no `Logger`/`console` call receives a secret. Audit `meta` carries **no** secret (TDA-008 §5).
- **Decrypt is isolated.** `KMS_PROVIDER.unwrapKey` is called from **exactly one** file — `credential-decryptor.ts`. The write side uses `generateDataKey`/`wrapKey` only. A test enforces this.
- **Validate-before-persist.** `connect` performs a real (or, in tests, mocked) ephemeral login and writes nothing on failure.
- **Test harness:** reuse the TDA-003 Style-A focused-boot pattern (mint `td-access` JWTs `{sub,role,email}`). New tests in `apps/api/test/tda005/` with a `jest.config.js` mirroring `apps/api/test/tda003/jest.config.js` (`roots`→`<rootDir>/test/tda005`, otplib stub mapped). Run **from `apps/api`** with Jest 29.7 flag `--verbose` (NOT `-v`): `npx jest --config test/tda005/jest.config.js --verbose` (prefix `DATABASE_URL_TEST=…` for DB-backed specs).

---

## File Structure

- `apps/api/src/modules/credential-vault/crypto/field-cipher.ts` — **create.** `encryptWithDataKey`/`decryptWithDataKey` (DEK-keyed AES-256-GCM, `iv:tag:ct` base64).
- `apps/api/src/common/crypto/kms/kms-provider.interface.ts` — **modify (additive).** Add `wrapKey(plaintext): Promise<{wrapped;keyVersion}>`.
- `apps/api/src/common/crypto/kms/local-kms.provider.ts` — **modify.** Implement `wrapKey` (share a private `wrap()` with `generateDataKey`).
- `apps/api/src/common/crypto/kms/aws-kms.provider.ts` — **modify (gated skeleton).** Implement `wrapKey` via dynamic `EncryptCommand`.
- `apps/api/src/modules/market-data/utils/angel-one-totp.ts` — **create.** Extracted RFC-6238 `generateTOTP`.
- `apps/api/src/modules/market-data/services/angel-one-auth.service.ts` — **modify.** Import the extracted `generateTOTP` (behaviour unchanged).
- `apps/api/src/modules/market-data/services/angel-one-validator.service.ts` — **create.** `validateLogin(creds)` — ephemeral session, no singleton mutation.
- `prisma/schema.prisma` — **modify.** `BrokerCredential`: `keyVersion Int → String @default("local-v1")`, add `lastRotatedAt DateTime?`, `clientIdMasked String?`.
- `prisma/migrations/<ts>_tda005_credential_vault/migration.sql` — **create** (forward).
- `apps/api/src/modules/credential-vault/dto/connect-angel-one.dto.ts` — **create.** 5-field DTO.
- `apps/api/src/modules/credential-vault/services/credential-vault.service.ts` — **create.** `connect`/`disconnect`/`getStatus`/`rewrapUser`.
- `apps/api/src/modules/credential-vault/execution/credential-decryptor.ts` — **create.** `CredentialDecryptor` + token `CREDENTIAL_DECRYPTOR` (sole `unwrapKey` caller).
- `apps/api/src/modules/credential-vault/execution/credential-decryptor.module.ts` — **create.** Isolated `@Module` exporting `CREDENTIAL_DECRYPTOR`.
- `apps/api/src/modules/credential-vault/jobs/credential-rewrap.job.ts` — **create.** Re-wrap processor.
- `apps/api/src/modules/credential-vault/controllers/broker.controller.ts` — **create/replace.** `POST /api/broker/connect`, `GET /api/broker/status`, `DELETE /api/broker`.
- `apps/api/src/modules/credential-vault/credential-vault.module.ts` — **create.** Wires the above; re-exports vault service + decryptor module.
- `apps/api/src/modules/broker/**` — **remove/retire.** Delete the stale `broker.service.ts`/`broker.controller.ts`/`dto`; repoint `broker.module.ts` (or drop it in favour of `CredentialVaultModule`).
- `apps/api/src/app.module.ts` — **modify (additive).** Register `CredentialVaultModule` (replaces `BrokerModule`).
- `apps/web/src/pages/settings/SettingsPage.tsx` — **modify.** Real Connect Angel One form + status + disconnect; remove legacy Section-6 + `/broker/test-connection`.
- `apps/api/test/tda005/` — **create.** `jest.config.js`, `otplib.stub.js` (copy from tda003), spec files per task.

---

### Task 1: `field-cipher` (DEK-keyed field encryption)

**Files:**
- Create: `apps/api/src/modules/credential-vault/crypto/field-cipher.ts`
- Create: `apps/api/test/tda005/jest.config.js` (copy `apps/api/test/tda003/jest.config.js`, `roots`→`<rootDir>/test/tda005`); copy `apps/api/test/tda003/otplib.stub.js` → `apps/api/test/tda005/otplib.stub.js`.
- Create: `apps/api/test/tda005/field-cipher.spec.ts`

**Interfaces — Produces:** `encryptWithDataKey(plain: string, dataKey: Buffer): string` (`base64(iv):base64(tag):base64(ct)`), `decryptWithDataKey(blob: string, dataKey: Buffer): string` (throws on tamper).

- [ ] **Step 1: Write the failing test** — `field-cipher.spec.ts`:

```ts
import { encryptWithDataKey, decryptWithDataKey } from '../../src/modules/credential-vault/crypto/field-cipher';
import { randomBytes } from 'crypto';

describe('field-cipher (DEK-keyed)', () => {
  const dk = randomBytes(32);
  it('round-trips under a data key', () => {
    const blob = encryptWithDataKey('s3cr3t-totp', dk);
    expect(decryptWithDataKey(blob, dk)).toBe('s3cr3t-totp');
  });
  it('uses a fresh IV each call (ciphertexts differ)', () => {
    expect(encryptWithDataKey('x', dk)).not.toBe(encryptWithDataKey('x', dk));
  });
  it('throws on a tampered blob (auth-tag fail)', () => {
    const blob = encryptWithDataKey('x', dk);
    const bad = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A');
    expect(() => decryptWithDataKey(bad, dk)).toThrow();
  });
  it('throws when decrypted under the wrong data key', () => {
    const blob = encryptWithDataKey('x', dk);
    expect(() => decryptWithDataKey(blob, randomBytes(32))).toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL** (module not found). `npx jest --config test/tda005/jest.config.js field-cipher --verbose`
- [ ] **Step 3: Implement** `field-cipher.ts` — `aes-256-gcm`, 12-byte IV, format `base64(iv):base64(tag):base64(ct)` (mirror `common/crypto/field-crypto.ts` framing but take the key as an explicit `Buffer` arg; no ambient key).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-005: DEK-keyed field cipher (AES-256-GCM)`.

---

### Task 2: `KmsProvider.wrapKey` extension (envelope re-wrap primitive)

**Files:**
- Modify: `apps/api/src/common/crypto/kms/kms-provider.interface.ts`, `local-kms.provider.ts`, `aws-kms.provider.ts`
- Create: `apps/api/test/tda005/local-kms-wrap.spec.ts`

**Interfaces — Produces:** `KmsProvider.wrapKey(plaintext: Buffer): Promise<{ wrapped: string; keyVersion: string }>`. **Consumes:** `getEncryptionKey()` (TDA-004).

- [ ] **Step 1: Write the failing test** — `local-kms-wrap.spec.ts`:

```ts
import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';
import { randomBytes } from 'crypto';

describe('LocalKmsProvider.wrapKey', () => {
  const orig = process.env.ENCRYPTION_KEY;
  beforeAll(() => { process.env.ENCRYPTION_KEY = 'master-key-passphrase-tda005-xxxxxxxx'; });
  afterAll(() => { process.env.ENCRYPTION_KEY = orig; });
  const kms = new LocalKmsProvider();

  it('wrapKey round-trips through unwrapKey', async () => {
    const dek = randomBytes(32);
    const { wrapped, keyVersion } = await kms.wrapKey(dek);
    expect(keyVersion).toBe('local-v1');
    expect((await kms.unwrapKey(wrapped)).equals(dek)).toBe(true);
  });
  it('rejects a tampered wrapped blob', async () => {
    const { wrapped } = await kms.wrapKey(randomBytes(32));
    const bad = wrapped.slice(0, -2) + (wrapped.endsWith('A') ? 'B' : 'A');
    await expect(kms.unwrapKey(bad)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`wrapKey` not a function).
- [ ] **Step 3: Implement.** Add `wrapKey` to the interface (additive — after `unwrapKey`). In `LocalKmsProvider`, factor a private `wrap(plaintext): string` (the `v1:iv:tag:ct` framing already in `generateDataKey`) and have both `generateDataKey` and `wrapKey` call it; `wrapKey` returns `{ wrapped: this.wrap(plaintext), keyVersion: 'local-v1' }`. In `AwsKmsProvider` (gated skeleton) add `wrapKey` using a dynamic `EncryptCommand` (`base64(CiphertextBlob)` + `keyVersion()`), mirroring the existing dynamic-import style.
- [ ] **Step 4: Run → PASS.** Confirm the existing `test/tda004/local-kms.spec.ts` still passes (no regression): `npx jest --config test/tda004/jest.config.js local-kms --verbose`.
- [ ] **Step 5: Commit** `TDA-005: add KmsProvider.wrapKey for envelope re-wrap (additive)`.

---

### Task 3: `BrokerCredential` schema delta + forward migration

**Files:**
- Modify: `prisma/schema.prisma` (`BrokerCredential` per spec §3.3).
- Create: `prisma/migrations/<ts>_tda005_credential_vault/migration.sql`.

**Context:** Current: `keyVersion Int @default(1)`. Change to `String @default("local-v1")`; add `lastRotatedAt DateTime?` and `clientIdMasked String?`. Dev rows are ADMIN/engine test data only.

- [ ] **Step 1: Edit `schema.prisma`** — `keyVersion String @default("local-v1")`, add `lastRotatedAt DateTime?`, `clientIdMasked String?` to `BrokerCredential`. Leave all `enc*`/`encDataKey`/`userId @unique`/`@@map` unchanged.
- [ ] **Step 2: Generate the migration WITHOUT applying** — from repo root: `npx prisma migrate dev --name tda005_credential_vault --create-only`. Inspect `migration.sql`: it should `ALTER COLUMN "keyVersion" ... TYPE TEXT` (add `USING "keyVersion"::text` and reset the default to `'local-v1'` by hand so the type change is safe on existing rows) and `ADD COLUMN "lastRotatedAt" TIMESTAMP`, `ADD COLUMN "clientIdMasked" TEXT`.
- [ ] **Step 3: Apply** — `npx prisma migrate dev` (applies pending), then `npx prisma generate`.
- [ ] **Step 4: Verify** — `npx prisma migrate status` clean; `docker exec td-postgres psql -U postgres -d td_saas -c '\d broker_credentials'` shows `keyVersion text`, `lastRotatedAt`, `clientIdMasked`. Do **not** migrate `td_saas_test` here (DB-backed specs apply via their own setup / `migrate deploy` against `DATABASE_URL_TEST`).
- [ ] **Step 5: Commit** `TDA-005: BrokerCredential keyVersion→String + rotation/display columns (forward migration)`.

---

### Task 4: `AngelOneValidator` + extract `generateTOTP`

**Files:**
- Create: `apps/api/src/modules/market-data/utils/angel-one-totp.ts`
- Modify: `apps/api/src/modules/market-data/services/angel-one-auth.service.ts` (import extracted TOTP)
- Create: `apps/api/src/modules/market-data/services/angel-one-validator.service.ts`
- Modify: `apps/api/src/modules/market-data/market-data.module.ts` (provide + export `AngelOneValidator`)
- Create: `apps/api/test/tda005/angel-one-validator.spec.ts`

**Interfaces — Produces:** `generateTOTP(base32: string): string`; `AngelOneValidator.validateLogin(creds): Promise<{ success; clientName?; reason? }>` — ephemeral session, **no** singleton mutation.

- [ ] **Step 1: Write the failing test** — inject a **fake SmartAPI factory** so no network is hit. Prove: (a) success maps `generateSession → {success:true}`; (b) a thrown/`jwtToken`-less response maps to `{success:false}` with a generic reason; (c) the shared `AngelOneAuthService` singleton's session is untouched (spy that `updateCredentials`/`login` are never called). Assert the validator computes a TOTP via the extracted util.

```ts
it('returns success when generateSession yields a jwtToken', async () => {
  const fakeApi = { generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt' } }) };
  const v = new AngelOneValidator(() => fakeApi as any);
  const r = await v.validateLogin({ apiKey: 'k', clientId: 'C1', password: 'p', totpSecret: 'JBSWY3DPEHPK3PXP' });
  expect(r.success).toBe(true);
  expect(fakeApi.generateSession).toHaveBeenCalledTimes(1);
});
it('returns a generic failure without leaking the broker error', async () => {
  const fakeApi = { generateSession: jest.fn().mockRejectedValue(new Error('AB1234: invalid password')) };
  const v = new AngelOneValidator(() => fakeApi as any);
  const r = await v.validateLogin({ apiKey: 'k', clientId: 'C1', password: 'bad', totpSecret: 'JBSWY3DPEHPK3PXP' });
  expect(r.success).toBe(false);
  expect(r.reason ?? '').not.toContain('invalid password');
});
```

- [ ] **Step 2: Run → FAIL** (modules missing).
- [ ] **Step 3: Implement.** Move the private RFC-6238 `generateTOTP` from `angel-one-auth.service.ts` into `utils/angel-one-totp.ts` (export it) and have the auth service import it (behaviour identical). Implement `AngelOneValidator` with an injectable **SmartAPI factory** (default `(apiKey) => new SmartAPI({ api_key: apiKey })`, overridable in tests): create a throwaway client, `generateSession(clientId, password, generateTOTP(totpSecret))`, return `{success:true, clientName}` on a `jwtToken`, else `{success:false, reason:'Angel One rejected the credentials'}`; log the raw error at `warn` **with password/TOTP stripped**. Never call the shared singleton. Provide + export from `MarketDataModule`.
- [ ] **Step 4: Run → PASS.** Smoke the existing market-data auth spec (if any) to confirm the TOTP extraction didn't regress.
- [ ] **Step 5: Commit** `TDA-005: AngelOneValidator (ephemeral login) + shared generateTOTP util`.

---

### Task 5: `CredentialVaultService.connect/disconnect/getStatus`

**Files:**
- Create: `apps/api/src/modules/credential-vault/dto/connect-angel-one.dto.ts`
- Create: `apps/api/src/modules/credential-vault/services/credential-vault.service.ts`
- Create: `apps/api/src/modules/credential-vault/credential-vault.module.ts` (partial — write side; decryptor added in Task 6)
- Create: `apps/api/test/tda005/credential-vault.spec.ts` (DB-backed)

**Interfaces — Produces:** `CredentialVaultService.connect(userId, dto, reqMeta)`, `.disconnect(userId, reqMeta)`, `.getStatus(userId)`. **Consumes:** `KMS_PROVIDER` (`generateDataKey`), `field-cipher` (T1), `AngelOneValidator` (T4), `AuditService` (TDA-008), `PrismaService`.

- [ ] **Step 1: Write the failing test** — boot `PrismaModule` + a stubbed `KMS_PROVIDER` (real `LocalKmsProvider`) + a **mocked `AngelOneValidator`** + `AuditModule`; point `DATABASE_URL` at `DATABASE_URL_TEST`. Use a unique test `userId` (seed a `User` row or reuse the seeded ADMIN):

```ts
it('validates then persists ciphertext + CREDENTIAL_CONNECT', async () => {
  validator.validateLogin.mockResolvedValue({ success: true, clientName: 'Test' });
  await svc.connect(userId, dto, { ip: '1.2.3.4' });
  const row = await prisma.brokerCredential.findUnique({ where: { userId } });
  expect(row!.encTotpSecret).not.toContain(dto.totpSecret);       // stored encrypted
  expect(row!.encDataKey).toMatch(/^v1:/);                         // wrapped DEK
  expect(row!.clientIdMasked).toBeDefined();
  const audits = await prisma.auditLog.findMany({ where: { userId, action: 'CREDENTIAL_CONNECT' } });
  expect(audits.length).toBe(1);
  expect(JSON.stringify(audits[0].meta)).not.toContain(dto.password); // no secret in meta
});
it('persists NOTHING when the test login fails', async () => {
  validator.validateLogin.mockResolvedValue({ success: false });
  await expect(svc.connect(userId2, dto, {})).rejects.toThrow();   // 422
  expect(await prisma.brokerCredential.findUnique({ where: { userId: userId2 } })).toBeNull();
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `ConnectAngelOneDto` (5 `@IsString @IsNotEmpty` fields incl. `apiSecret`) and `CredentialVaultService` per spec §4: validate → `generateDataKey` → encrypt 5 via `field-cipher` → `upsert({ where: { userId }})` with `encDataKey`/`keyVersion`/`clientIdMasked`/`lastValidated`/`isActive` → `audit.append('CREDENTIAL_CONNECT')` (mask client-id, no secrets) → return `{connected:true, validatedAt}`; **zeroize `dk.plaintext` in a `finally`**; throw `UnprocessableEntityException` on validation failure. `disconnect` deletes the row + `CREDENTIAL_DELETE`. `getStatus` returns non-secret metadata only (no KMS call). Register the write side in `credential-vault.module.ts`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-005: CredentialVaultService connect/disconnect/status (validate-before-persist, envelope-encrypt)`.

---

### Task 6: Isolated `CredentialDecryptor` (sole KMS-unwrap grant — the TDA-010/011 seam)

**Files:**
- Create: `apps/api/src/modules/credential-vault/execution/credential-decryptor.ts`
- Create: `apps/api/src/modules/credential-vault/execution/credential-decryptor.module.ts`
- Modify: `apps/api/src/modules/credential-vault/credential-vault.module.ts` (import + re-export the decryptor module)
- Create: `apps/api/test/tda005/credential-decryptor.spec.ts` (DB-backed)
- Create: `apps/api/test/tda005/decrypt-isolation.spec.ts` (source-scan guard)

**Interfaces — Produces:** `CredentialDecryptor.withDecryptedCredentials<T>(userId, ctx, use)`, token `CREDENTIAL_DECRYPTOR`, `@Module CredentialDecryptorModule` exporting it. **Consumes:** `KMS_PROVIDER` (`unwrapKey`), `field-cipher` (T1), `AuditService`, `PrismaService`.

- [ ] **Step 1: Write the failing tests.**
  - `credential-decryptor.spec.ts`: after a `connect` (Task 5), `withDecryptedCredentials(userId, {reason:'ORDER', signalId:'s1'}, async c => c)` returns the original five plaintext values; asserts exactly one `CREDENTIAL_DECRYPT` row whose `meta` contains no secret; asserts the callback result is propagated and a throwing `use` still emits the audit row and rejects (finally-zeroize path).
  - `decrypt-isolation.spec.ts`: grep `apps/api/src/**/*.ts` and assert `unwrapKey(` appears **only** in `credential-decryptor.ts` (and the rewrap job, Task 7 — allow both files) — proving the decrypt grant is isolated. Also assert the retired `broker.service.ts` no longer references `brokerCredential.password`/`.totpSecret`/`.apiKey` plaintext columns.

```ts
it('leases plaintext then zeroizes; emits one CREDENTIAL_DECRYPT', async () => {
  const got = await decryptor.withDecryptedCredentials(userId, { reason: 'ORDER', signalId: 's1' }, async (c) => c.totpSecret);
  expect(got).toBe(dto.totpSecret);
  const rows = await prisma.auditLog.findMany({ where: { userId, action: 'CREDENTIAL_DECRYPT' } });
  expect(rows.length).toBe(1);
  expect(JSON.stringify(rows[0].meta)).not.toContain(dto.totpSecret);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `credential-decryptor.ts` per spec §6: `findUniqueOrThrow({ where:{ userId }})` → `kms.unwrapKey(encDataKey)` → decrypt 5 via `field-cipher` → `audit.append('CREDENTIAL_DECRYPT')` (meta: reason/signalId/keyVersion, **no secret**) → `await use(plain)` → `finally { dk.fill(0); zeroize container }`. No `Logger`/`console` ever receives a plaintext. `CredentialDecryptorModule` is a standalone `@Module` (imports `PrismaModule`; `KmsModule`/`AuditModule` are `@Global`) that provides + exports `CREDENTIAL_DECRYPTOR`. `CredentialVaultModule` imports and re-exports it so TDA-010/011 depend on the vault module alone.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-005: isolated CredentialDecryptor (scoped lease, sole unwrap grant) — TDA-010/011 seam`.

---

### Task 7: Key-rotation re-wrap job

**Files:**
- Create: `apps/api/src/modules/credential-vault/jobs/credential-rewrap.job.ts`
- Modify: `apps/api/src/modules/credential-vault/credential-vault.module.ts` (register the job/processor)
- Add: `CredentialVaultService.rewrapUser(userId)` (or a `rewrapAll()` batch used by the job)
- Create: `apps/api/test/tda005/credential-rewrap.spec.ts` (DB-backed)

**Interfaces — Produces:** a re-wrap routine that, for rows whose `keyVersion !== kms.keyVersion()`, unwraps + `wrapKey`s the DEK, updates `encDataKey`/`keyVersion`/`lastRotatedAt`, emits `CREDENTIAL_ROTATE`. **Fields are never re-encrypted.** **Consumes:** `KMS_PROVIDER` (`unwrapKey`+`wrapKey`, T2), `AuditService`.

- [ ] **Step 1: Write the failing test** — connect a user (Task 5), then force a stale version (`prisma.brokerCredential.update({ data: { keyVersion: 'stale-v0' }})`) and capture the current `encApiKey`/`encTotpSecret`. Run the re-wrap. Assert: `encDataKey` **changed**, `encApiKey`/`encTotpSecret` **unchanged**, `keyVersion === kms.keyVersion()`, `lastRotatedAt` set, one `CREDENTIAL_ROTATE` row. Re-run → no-op (row already current; no new audit row).

```ts
it('re-wraps the DEK without touching field ciphertext, idempotently', async () => {
  await prisma.brokerCredential.update({ where: { userId }, data: { keyVersion: 'stale-v0' } });
  const before = await prisma.brokerCredential.findUnique({ where: { userId } });
  await job.rewrapAll();
  const after = await prisma.brokerCredential.findUnique({ where: { userId } });
  expect(after!.encDataKey).not.toBe(before!.encDataKey);
  expect(after!.encApiKey).toBe(before!.encApiKey);        // fields untouched
  expect(after!.keyVersion).toBe('local-v1');
  expect(after!.lastRotatedAt).not.toBeNull();
  const auditsBefore = await prisma.auditLog.count({ where: { userId, action: 'CREDENTIAL_ROTATE' } });
  await job.rewrapAll();                                    // idempotent
  expect(await prisma.auditLog.count({ where: { userId, action: 'CREDENTIAL_ROTATE' } })).toBe(auditsBefore);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** per spec §7: iterate `brokerCredential.findMany({ where: { keyVersion: { not: kms.keyVersion() } }})`; per row `unwrapKey → wrapKey → update(encDataKey,keyVersion,lastRotatedAt) → audit('CREDENTIAL_ROTATE', meta:{from,to})`; `finally { dk.fill(0) }`. Skip current rows (idempotent). Wire as a Bull processor / manually-triggerable method mirroring the existing worker pattern; it lives in the vault module (needs the unwrap grant — allowed alongside the decryptor per Task 6's isolation guard).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-005: credential re-wrap job (KEK rotation, fields untouched, idempotent)`.

---

### Task 8: Rebuild `broker.controller` + retire the stale broker module + wire `app.module`

**Files:**
- Create: `apps/api/src/modules/credential-vault/controllers/broker.controller.ts`
- Remove: `apps/api/src/modules/broker/services/broker.service.ts`, `controllers/broker.controller.ts`, `dto/broker.dto.ts`
- Modify/Remove: `apps/api/src/modules/broker/broker.module.ts` (drop, or make it a thin re-export of `CredentialVaultModule`)
- Modify: `apps/api/src/app.module.ts` (replace `BrokerModule` import with `CredentialVaultModule`, additive/minimal)
- Create: `apps/api/test/tda005/broker-endpoint.spec.ts` (HTTP, Style-A harness)

**Interfaces — Produces:** `POST /api/broker/connect` (per-user, `@CurrentUser('userId')`), `GET /api/broker/status`, `DELETE /api/broker`. **Consumes:** `CredentialVaultService`.

- [ ] **Step 1: Write the failing test** — reuse the tda003 `boot`/`tokenFor` helpers; mock `AngelOneValidator` to succeed. Assert: `POST /api/broker/connect` → 200 `{connected:true}`; `GET /api/broker/status` → masked client-id, `connected:true`; a **second** user's `GET /api/broker/status` → `{connected:false}` (TenantGuard isolation); `DELETE /api/broker` → 204 and status flips to `{connected:false}`; a failed validator → 422 and status stays `{connected:false}`.

```ts
it('is per-user isolated', async () => {
  await postJson('/api/broker/connect', tokenFor('USER', u1), dto);
  const s2 = await getJson('/api/broker/status', tokenFor('USER', u2));
  expect(s2.body.connected).toBe(false);
});
```

- [ ] **Step 2: Run → FAIL** (routes 404 / old controller).
- [ ] **Step 3: Implement** the new `broker.controller.ts` (class routes under `api/broker`, methods delegate to `CredentialVaultService`, `@CurrentUser('userId')`, pass `{ ip }` reqMeta). Delete the stale `broker/*` files. In `app.module.ts`, swap `BrokerModule` → `CredentialVaultModule` (keep the diff minimal — one import line changed, one module in the array). Confirm the app still boots under SWC: `cd apps/api && npx nest build`.
- [ ] **Step 4: Run → PASS.** Run the full tda005 suite + a smoke of tda003 (guards still wired) + `prisma migrate status` clean.
- [ ] **Step 5: Commit** `TDA-005: rebuild broker.controller on the vault; retire stale broker.service; wire app.module`.

---

### Task 9: Frontend "Connect Angel One" flow

**Files:**
- Modify: `apps/web/src/pages/settings/SettingsPage.tsx`
- Modify: `apps/web/src/services/api.ts` (add `connectBroker`/`brokerStatus`/`disconnectBroker` if a typed client is used)
- (If a web test harness exists) Create/extend a component test; otherwise manual-verify note.

**Context:** Replace the "Coming soon — TDA-005" placeholder with a real 5-field form (apiKey, apiSecret, clientId, password, totpSecret), secrets masked and never pre-filled from the server. Remove the legacy Section-6 form and the `/broker/test-connection` call.

- [ ] **Step 1: Implement the form** posting to `POST /api/broker/connect`; on success toast "Broker connected" and refresh `GET /api/broker/status` (render "Connected as A•••23 · validated <relative>"); on 422 show "Angel One rejected these credentials" (no raw broker message). Add a Disconnect button → `DELETE /api/broker`.
- [ ] **Step 2: Remove** the legacy Section-6 broker form + `broker.apiKey/clientId` local state that fed `/broker/test-connection`.
- [ ] **Step 3: Verify** — `cd apps/web && npm run build` (or the repo's typecheck/lint) is clean; if a component test harness exists, add a happy-path + 422 test; otherwise document a manual check (form submits, status renders masked, disconnect clears).
- [ ] **Step 4: Commit** `TDA-005: Connect Angel One frontend (validated connect + status + disconnect)`.

---

## Self-Review

- **Spec coverage:** §3.1/3.2 (envelope + field cipher) → T1; §3.3 (schema delta) → T3; §4 (write side) → T5; §4.1 (masked display) → T5/T8; §5 (validation login) → T4; §5.1/5.2 (API + DTO) → T8; §5.3 (frontend) → T9; §6 (decrypt-for-execution seam) → T6; §7 (re-wrap job) → T7; §7.1 (`wrapKey` extension) → T2; §8 (rebuild broker.service) → T8; §9 (AWS posture) → deployment-gated, documented in spec (not executed here).
- **Acceptance mapping:** AC1→T1/T3/T8, AC2→T4/T5/T8, AC3→T1/T5/T6, AC4→T6, AC5→T7, AC6→T5/T8, AC7→T3/T8.
- **Decrypt isolation enforced by a test** (T6 `decrypt-isolation.spec.ts`): `unwrapKey(` appears only in the decryptor + the re-wrap job. The write side uses `generateDataKey`/`wrapKey` only → connect and decrypt are separable IAM grants (spec §9). ✅
- **No plaintext persisted/logged:** T1 (encrypted at rest), T5 (audit meta has no secret), T6 (no logger receives plaintext; DEK zeroized in `finally`); JS string-lifetime caveat documented (spec §6, open decision §10.3). ✅
- **Validate-before-persist:** T5 proves a failed login writes zero rows. ✅
- **Forward-migration discipline:** T3 is `--create-only` + hand-edit (`ALTER … TYPE TEXT USING …`), applied via `migrate dev`; never `migrate reset`; this is the only S2 lane touching `BrokerCredential`. ✅
- **Additive seam discipline:** `KmsProvider.wrapKey` is additive (T2, no existing caller breaks; TDA-004 `local-kms.spec` still passes). `app.module.ts` swaps one module import (T8). ✅
- **Cheap rotation invariant:** T7 asserts field ciphertext is byte-unchanged after re-wrap (only the DEK is re-wrapped) and the job is idempotent. ✅
- **Does not disturb the global feed:** `AngelOneValidator` uses an ephemeral throwaway client; the market-data `AngelOneAuthService` singleton is never mutated (T4 spies); its `.env`-seeded auto-login is untouched (spec §8). ✅

### Dependency / spec-coverage note

- **Consumes (must exist first):** TDA-004 `KMS_PROVIDER`/`KmsModule`/`getEncryptionKey` (present in `apps/api/src/common/crypto/kms/**` + `common/secrets/**`); TDA-008 `AuditService`/`AUDIT_ACTIONS.credential` (present in `apps/api/src/common/audit/**` — `CREDENTIAL_*` already declared, TDA-005 is the first emitter); TDA-003 `@CurrentUser`/`TenantGuard`/Prisma `BrokerCredential` scoping (present); TDA-001 vault-shaped `BrokerCredential` (present).
- **Provides (for downstream):** `CREDENTIAL_DECRYPTOR` / `CredentialDecryptor.withDecryptedCredentials` — the **only** symbol TDA-010 (fan-out) and TDA-011 (auto-execution) import to obtain a user's live Angel One creds; it emits `CREDENTIAL_DECRYPT` and zeroizes automatically.
- **One genuine cross-spec coordination item:** the additive `KmsProvider.wrapKey` (spec §7.1 / §10.1) extends a TDA-004-owned interface. Additive and backward-compatible; confirm before merge.
- **Contradiction found in code vs. roadmap (resolved here):** (a) `broker.service.ts` still references removed plaintext columns and a non-existent `broker` `@unique` — exactly the roadmap §8 TDA-003b follow-up (a); rebuilt in T8. (b) `keyVersion` is `Int` in the schema but `KmsProvider.keyVersion()` is a **string** — reconciled by the T3 `Int→String` migration. (c) the DTO had only 4 fields (missing `apiSecret`, one of the roadmap's five) — added in T5/T8.
