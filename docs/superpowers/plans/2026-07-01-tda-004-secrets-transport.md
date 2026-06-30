# TDA-004 Secrets, KMS, Transport & Rate-Limit Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is TDD: write the failing test, run → FAIL, implement, run → PASS, commit.

**Goal:** Remove the hardcoded `ENCRYPTION_KEY` fallback; introduce `SecretsProvider`/`KmsProvider` abstractions (local impl now, AWS adapter deployment-gated); add boot-time config assertions, helmet, strict CORS, TLS enforcement; and add global + per-account rate limiting backed by Redis so limits hold across replicas.

**Architecture:** Two provider interfaces (`SecretsProvider`, `KmsProvider`) selected by config (`local` default / `aws` gated). All secret + key-material access flows through them. Security hardening lands in `main.ts` (helmet/CORS/https) and `app.module.ts` (one global throttler — the shared seam, additive). A per-account limiter guard sits over a `RateLimitStore` (memory dev/test, Redis prod). See spec `docs/superpowers/specs/2026-07-01-tda-004-secrets-transport-design.md`.

**Tech Stack:** NestJS 11, `@nestjs/throttler@6`, `helmet@8`, `ioredis@5` (all already installed), Prisma 6 (Postgres `td_saas`), Jest 29.7 + ts-jest. `@aws-sdk/client-secrets-manager` / `@aws-sdk/client-kms` are **NOT installed** and must NOT be added in this plan (the AWS adapters are skeletons behind a dynamic import, only wired at prod deploy).

## Global Constraints

- **Parallel worktree:** this lane is branched from `main` and runs concurrently with other TDA lanes.
  - **Shared-file seam:** `apps/api/src/app.module.ts` (throttler registration). Keep edits **additive** — add the `ThrottlerModule` import + one `APP_GUARD`; do not reorder/remove existing imports or the CLS/Tenant/Auth wiring.
  - **Do NOT change `prisma/schema.prisma`** — TDA-008 owns schema this wave. No migration in this plan (`prisma migrate status` must be clean before and after; the envelope-encryption columns are TDA-005).
- **Commit prefix:** `TDA-004:`. No `.env` committed. Stage only changed files (no `git add -A`).
- **DB:** dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`. **Never `prisma migrate reset`.**
- **Secrets:** NO defaults, ever. `getRequiredSecret` throws on miss. The literal `td-automation-default-key-change-me` must be **deleted** from the codebase.
- **Provider selection:** `SECRETS_PROVIDER` / `KMS_PROVIDER` config, values `local` (default) | `aws`. Tests run `local`. `aws` adapters are never constructed unless explicitly selected; their `@aws-sdk/*` imports are **dynamic** (`await import(...)`) so the test build never needs the package.
- **Rate-limit storage:** memory in dev/test; Redis only when `REDIS_THROTTLER==='true'` (or prod). The single ioredis client is the `REDIS_CLIENT` provider (config from `redis.*`, same connection Bull uses).
- **Test harness:** reuse the TDA-003 Style-A boot harness (mint JWTs with `audience:'td-access'`; `{ sub, role, email }`). New tests in `apps/api/test/tda004/` with a `jest.config.js` mirroring `apps/api/test/tda003/jest.config.js` (roots → `test/tda004`, otplib stub mapped). Run from `apps/api`. **Jest 29.7 rejects `-v`; use `--verbose`.** Prefix DB-backed specs with `DATABASE_URL_TEST=...`.

---

## File Structure

- `apps/api/src/common/secrets/secrets-provider.interface.ts` — **create.** `SecretsProvider`, `MissingSecretError`, DI token `SECRETS_PROVIDER`.
- `apps/api/src/common/secrets/env-secrets.provider.ts` — **create.** `EnvSecretsProvider` (dev/test default).
- `apps/api/src/common/secrets/aws-secrets.provider.ts` — **create.** `AwsSecretsProvider` skeleton (dynamic `@aws-sdk` import; gated).
- `apps/api/src/common/secrets/secrets.module.ts` — **create.** `@Global` module + `secretsProviderFactory`.
- `apps/api/src/common/crypto/kms/kms-provider.interface.ts` — **create.** `KmsProvider`, `DataKey`, DI token `KMS_PROVIDER`.
- `apps/api/src/common/crypto/kms/local-kms.provider.ts` — **create.** `LocalKmsProvider` (dev/test default).
- `apps/api/src/common/crypto/kms/aws-kms.provider.ts` — **create.** `AwsKmsProvider` skeleton (gated).
- `apps/api/src/common/crypto/kms/kms.module.ts` — **create.** `@Global` module + `kmsProviderFactory`.
- `apps/api/src/common/crypto/encryption-key.ts` — **create.** `getEncryptionKey()` accessor (sha256 of `ENCRYPTION_KEY`, throws on miss — no default).
- `apps/api/src/common/config/validate-boot-config.ts` — **create.** `validateBootConfig`, `BootConfigError`.
- `apps/api/src/common/http/enforce-https.middleware.ts` — **create.** prod-only https guard.
- `apps/api/src/common/ratelimit/rate-limit-store.interface.ts` — **create.** `RateLimitStore`.
- `apps/api/src/common/ratelimit/memory-rate-limit.store.ts` — **create.** `MemoryRateLimitStore`.
- `apps/api/src/common/ratelimit/redis-rate-limit.store.ts` — **create.** `RedisRateLimitStore`.
- `apps/api/src/common/ratelimit/redis.provider.ts` — **create.** `REDIS_CLIENT` + `THROTTLER_STORAGE` factories (gated).
- `apps/api/src/common/ratelimit/account-rate-limit.guard.ts` + `account-rate-limit.decorator.ts` — **create.** per-account limiter.
- `apps/api/src/modules/broker/services/broker.service.ts` — **modify.** Remove the hardcoded fallback; use `getEncryptionKey()`.
- `apps/api/src/common/crypto/field-crypto.ts` — **modify.** Route key through `getEncryptionKey()` (behaviour unchanged: still throws on miss).
- `apps/api/src/main.ts` — **modify.** helmet, strict CORS, `trust proxy`, `EnforceHttpsMiddleware`, `validateBootConfig` before `listen`.
- `apps/api/src/app.module.ts` — **modify (additive seam).** Central `ThrottlerModule` + global `ThrottlerGuard` + Redis/Secrets/Kms modules.
- `apps/api/src/modules/auth/auth.module.ts` + `controllers/auth.controller.ts` — **modify.** Drop local `ThrottlerModule.forRoot`; add `@AccountRateLimit` to `login`/`password/forgot`.
- `apps/api/test/tda004/` — **create.** `jest.config.js`, `otplib.stub.js` (copy from tda003), and the spec files per task.

---

### Task 1: `SecretsProvider` + `EnvSecretsProvider` + module

**Files:**
- Create: `apps/api/src/common/secrets/secrets-provider.interface.ts`, `env-secrets.provider.ts`, `secrets.module.ts`
- Create: `apps/api/test/tda004/jest.config.js` (copy `apps/api/test/tda003/jest.config.js`, `roots` → `<rootDir>/test/tda004`); copy `apps/api/test/tda003/otplib.stub.js` → `apps/api/test/tda004/otplib.stub.js`.
- Create: `apps/api/test/tda004/env-secrets.spec.ts`

**Interfaces — Produces:** `SecretsProvider`, `EnvSecretsProvider`, `MissingSecretError`, token `SECRETS_PROVIDER`, `secretsProviderFactory`.

- [ ] **Step 1: Write the failing test** — `apps/api/test/tda004/env-secrets.spec.ts`:

```ts
import { EnvSecretsProvider } from '../../src/common/secrets/env-secrets.provider';
import { MissingSecretError } from '../../src/common/secrets/secrets-provider.interface';

describe('EnvSecretsProvider', () => {
  const p = new EnvSecretsProvider();
  afterEach(() => { delete process.env.__TDA004_T; });

  it('returns a present secret', async () => {
    process.env.__TDA004_T = 'hello';
    await expect(p.getSecret('__TDA004_T')).resolves.toBe('hello');
  });
  it('returns undefined for an absent secret (no throw)', async () => {
    await expect(p.getSecret('__TDA004_MISSING')).resolves.toBeUndefined();
  });
  it('getRequiredSecret throws MissingSecretError when absent', async () => {
    await expect(p.getRequiredSecret('__TDA004_MISSING')).rejects.toBeInstanceOf(MissingSecretError);
  });
  it('getRequiredSecret throws for an empty string (no silent default)', async () => {
    process.env.__TDA004_T = '';
    await expect(p.getRequiredSecret('__TDA004_T')).rejects.toBeInstanceOf(MissingSecretError);
  });
});
```

- [ ] **Step 2: Run → FAIL** (module not found).
`npx jest --config test/tda004/jest.config.js env-secrets --verbose`

- [ ] **Step 3: Implement.**

`secrets-provider.interface.ts`:
```ts
export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');

export class MissingSecretError extends Error {
  constructor(public readonly name: string) {
    super(`Required secret "${name}" is not set. Refusing to start with no value (no defaults).`);
    this.name = 'MissingSecretError';
  }
}

export interface SecretsProvider {
  getSecret(name: string): Promise<string | undefined>;
  getRequiredSecret(name: string): Promise<string>;
}
```

`env-secrets.provider.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { MissingSecretError, SecretsProvider } from './secrets-provider.interface';

/** Dev/test default. Reads from process.env (loaded by load-env.ts). No defaults. */
@Injectable()
export class EnvSecretsProvider implements SecretsProvider {
  async getSecret(name: string): Promise<string | undefined> {
    const v = process.env[name];
    return v == null || v === '' ? undefined : v;
  }
  async getRequiredSecret(name: string): Promise<string> {
    const v = await this.getSecret(name);
    if (v === undefined) throw new MissingSecretError(name);
    return v;
  }
}
```

`secrets.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SECRETS_PROVIDER, SecretsProvider } from './secrets-provider.interface';
import { EnvSecretsProvider } from './env-secrets.provider';

export async function secretsProviderFactory(config: ConfigService): Promise<SecretsProvider> {
  const kind = config.get<string>('secrets.provider', 'local');
  if (kind === 'aws') {
    // Dynamic import so @aws-sdk is never required by the dev/test build.
    const { AwsSecretsProvider } = await import('./aws-secrets.provider');
    return new AwsSecretsProvider(config);
  }
  return new EnvSecretsProvider();
}

@Global()
@Module({
  providers: [{ provide: SECRETS_PROVIDER, useFactory: secretsProviderFactory, inject: [ConfigService] }],
  exports: [SECRETS_PROVIDER],
})
export class SecretsModule {}
```

Add to `configuration.ts` (additive): `secrets: { provider: process.env.SECRETS_PROVIDER || 'local' }`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-004: SecretsProvider abstraction + EnvSecretsProvider (local default)`.

---

### Task 2: Remove the hardcoded `ENCRYPTION_KEY` fallback

**Files:**
- Create: `apps/api/src/common/crypto/encryption-key.ts`
- Modify: `apps/api/src/modules/broker/services/broker.service.ts` (lines 11-14 + usages)
- Modify: `apps/api/src/common/crypto/field-crypto.ts` (`getKey` → delegate to accessor)
- Create: `apps/api/test/tda004/encryption-key.spec.ts`

**Interfaces — Produces:** `getEncryptionKey(): Buffer` — sha256 of `process.env.ENCRYPTION_KEY`, throws `MissingSecretError` when unset. **No default.**

- [ ] **Step 1: Write the failing test** — `apps/api/test/tda004/encryption-key.spec.ts`:

```ts
import { getEncryptionKey } from '../../src/common/crypto/encryption-key';
import { MissingSecretError } from '../../src/common/secrets/secrets-provider.interface';
import * as fs from 'fs';
import * as path from 'path';

describe('getEncryptionKey', () => {
  const orig = process.env.ENCRYPTION_KEY;
  afterEach(() => { process.env.ENCRYPTION_KEY = orig; });

  it('derives a 32-byte key from ENCRYPTION_KEY', () => {
    process.env.ENCRYPTION_KEY = 'a-real-passphrase-of-sufficient-length';
    expect(getEncryptionKey()).toHaveLength(32);
  });
  it('throws (no default) when ENCRYPTION_KEY is unset', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => getEncryptionKey()).toThrow(MissingSecretError);
  });

  it('the public default-key sentinel no longer exists in source (regression guard)', () => {
    const src = path.resolve(__dirname, '../../src/modules/broker/services/broker.service.ts');
    expect(fs.readFileSync(src, 'utf8')).not.toContain('td-automation-default-key-change-me');
  });
});
```

- [ ] **Step 2: Run → FAIL** (module missing + sentinel still present).

- [ ] **Step 3: Implement.**

`encryption-key.ts`:
```ts
import { createHash } from 'crypto';
import { MissingSecretError } from '../secrets/secrets-provider.interface';

/** The single source of the field-encryption key. sha256(ENCRYPTION_KEY) → 32 bytes.
 *  Throws when unset — there is deliberately NO default (see TDA-004 §5). */
export function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new MissingSecretError('ENCRYPTION_KEY');
  return createHash('sha256').update(secret, 'utf8').digest();
}
```

`broker.service.ts` — delete the static field (lines 11-14) and replace the four `BrokerService.ENCRYPTION_KEY` usages with `getEncryptionKey()`:
```ts
import { getEncryptionKey } from '../../../common/crypto/encryption-key';
// ...
const encryptedPassword = BrokerService.encrypt(dto.password, getEncryptionKey());
const encryptedTotp = BrokerService.encrypt(dto.totpSecret, getEncryptionKey());
// connect(): const password = BrokerService.decrypt(creds.password, getEncryptionKey()); ...
```
(Keep the static `encrypt`/`decrypt` AES-256-GCM `ivHex:tagHex:ctHex` format unchanged.)

`field-crypto.ts` — replace the local `getKey()` body with `return getEncryptionKey();` and drop the now-duplicated sha256 logic (import from `encryption-key.ts`). Behaviour is identical (still throws on miss).

- [ ] **Step 4: Run → PASS.** Also run the existing crypto spec to confirm no regression: `npx jest --config test/tda004/jest.config.js --verbose` and `cd apps/api && npx jest field-crypto --verbose`.
- [ ] **Step 5: Commit** `TDA-004: remove hardcoded ENCRYPTION_KEY fallback; single key accessor`.

---

### Task 3: `KmsProvider` + `LocalKmsProvider` + gated AWS skeleton

**Files:**
- Create: `apps/api/src/common/crypto/kms/kms-provider.interface.ts`, `local-kms.provider.ts`, `aws-kms.provider.ts`, `kms.module.ts`
- Create: `apps/api/test/tda004/local-kms.spec.ts`

**Interfaces — Produces:** `KmsProvider`, `DataKey`, `LocalKmsProvider`, token `KMS_PROVIDER`, `kmsProviderFactory`. **Consumes:** `getEncryptionKey()` (Task 2).

- [ ] **Step 1: Write the failing test** — `apps/api/test/tda004/local-kms.spec.ts`:

```ts
import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';

describe('LocalKmsProvider', () => {
  const orig = process.env.ENCRYPTION_KEY;
  beforeAll(() => { process.env.ENCRYPTION_KEY = 'master-key-passphrase-tda004-xxxxxxxx'; });
  afterAll(() => { process.env.ENCRYPTION_KEY = orig; });
  const kms = new LocalKmsProvider();

  it('generateDataKey returns a 32-byte plaintext key + a wrapped blob', async () => {
    const dk = await kms.generateDataKey();
    expect(dk.plaintext).toHaveLength(32);
    expect(typeof dk.wrapped).toBe('string');
    expect(dk.keyVersion).toBe('local-v1');
  });
  it('unwrapKey round-trips the plaintext', async () => {
    const dk = await kms.generateDataKey();
    const back = await kms.unwrapKey(dk.wrapped);
    expect(back.equals(dk.plaintext)).toBe(true);
  });
  it('rejects a tampered wrapped blob', async () => {
    const dk = await kms.generateDataKey();
    const tampered = dk.wrapped.slice(0, -2) + (dk.wrapped.endsWith('A') ? 'B' : 'A');
    await expect(kms.unwrapKey(tampered)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**

`kms-provider.interface.ts`:
```ts
export const KMS_PROVIDER = Symbol('KMS_PROVIDER');
export interface DataKey { plaintext: Buffer; wrapped: string; keyVersion: string; }
export interface KmsProvider {
  generateDataKey(): Promise<DataKey>;
  unwrapKey(wrapped: string): Promise<Buffer>;
  keyVersion(): string;
}
```

`local-kms.provider.ts` (AES-256-GCM wrap under the local master key; `wrapped = v1:iv:tag:ct` base64):
```ts
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getEncryptionKey } from '../encryption-key';
import { DataKey, KmsProvider } from './kms-provider.interface';

@Injectable()
export class LocalKmsProvider implements KmsProvider {
  keyVersion(): string { return 'local-v1'; }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrapped = ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
    return { plaintext, wrapped, keyVersion: this.keyVersion() };
  }

  async unwrapKey(wrapped: string): Promise<Buffer> {
    const [v, ivB64, tagB64, ctB64] = wrapped.split(':');
    if (v !== 'v1') throw new Error(`Unsupported wrapped-key version: ${v}`);
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  }
}
```

`aws-kms.provider.ts` — **deployment-gated skeleton**; `@aws-sdk/client-kms` imported dynamically so the dev/test build never needs it:
```ts
import { DataKey, KmsProvider } from './kms-provider.interface';
import type { ConfigService } from '@nestjs/config';

/** PROD adapter (TDA-004 §4). NOT constructed unless KMS_PROVIDER=aws.
 *  Holds the sole KMS grant in prod (roadmap §2 isolated seam). Wired by TDA-005. */
export class AwsKmsProvider implements KmsProvider {
  private cmkId: string;
  constructor(private readonly config: ConfigService) {
    this.cmkId = config.get<string>('kms.cmkId') ?? '';
  }
  keyVersion(): string { return this.cmkId; }
  async generateDataKey(): Promise<DataKey> {
    const { KMSClient, GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');
    const client = new KMSClient({});
    const out = await client.send(new GenerateDataKeyCommand({ KeyId: this.cmkId, KeySpec: 'AES_256' }));
    return {
      plaintext: Buffer.from(out.Plaintext as Uint8Array),
      wrapped: Buffer.from(out.CiphertextBlob as Uint8Array).toString('base64'),
      keyVersion: this.keyVersion(),
    };
  }
  async unwrapKey(wrapped: string): Promise<Buffer> {
    const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
    const client = new KMSClient({});
    const out = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64') }));
    return Buffer.from(out.Plaintext as Uint8Array);
  }
}
```
(Mirror this dynamic-import pattern for `aws-secrets.provider.ts` from Task 1 using `@aws-sdk/client-secrets-manager`; it stays a skeleton.)

`kms.module.ts` — `@Global`, `kmsProviderFactory` selecting on `config.get('kms.provider', 'local')` (dynamic-import the AWS impl when `aws`). Add to `configuration.ts`: `kms: { provider: process.env.KMS_PROVIDER || 'local', cmkId: process.env.KMS_CMK_ID || '' }`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-004: KmsProvider abstraction + LocalKmsProvider (AWS adapter gated)`.

---

### Task 4: Boot-time config assertions

**Files:**
- Create: `apps/api/src/common/config/validate-boot-config.ts`
- Create: `apps/api/test/tda004/validate-boot-config.spec.ts`

**Interfaces — Produces:** `validateBootConfig(env: NodeJS.ProcessEnv): void` (throws `BootConfigError` aggregating all failures).

- [ ] **Step 1: Write the failing test:**

```ts
import { validateBootConfig, BootConfigError } from '../../src/common/config/validate-boot-config';

const base = { JWT_SECRET: 's', ENCRYPTION_KEY: 'k'.repeat(32), DATABASE_URL: 'postgresql://x/db' };

describe('validateBootConfig', () => {
  it('passes in dev with the three core secrets', () => {
    expect(() => validateBootConfig({ ...base, NODE_ENV: 'development' } as any)).not.toThrow();
  });
  it('throws listing every missing core secret', () => {
    try { validateBootConfig({ NODE_ENV: 'development' } as any); fail('should throw'); }
    catch (e) {
      expect(e).toBeInstanceOf(BootConfigError);
      expect((e as Error).message).toContain('JWT_SECRET');
      expect((e as Error).message).toContain('ENCRYPTION_KEY');
      expect((e as Error).message).toContain('DATABASE_URL');
    }
  });
  it('in production requires WEB_ORIGIN + DB/AI/Redis TLS', () => {
    expect(() => validateBootConfig({ ...base, NODE_ENV: 'production' } as any)).toThrow(/WEB_ORIGIN|sslmode|AI_ENGINE_URL|REDIS_TLS/);
  });
  it('in production passes when fully configured', () => {
    expect(() => validateBootConfig({
      ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com',
      DATABASE_URL: 'postgresql://x/db?sslmode=require', AI_ENGINE_URL: 'https://ai.example.com',
      REDIS_TLS: 'true', REDIS_THROTTLER: 'true',
    } as any)).not.toThrow();
  });
  it('rejects the public default key sentinel even if non-empty', () => {
    expect(() => validateBootConfig({ ...base, ENCRYPTION_KEY: 'td-automation-default-key-change-me', NODE_ENV: 'development' } as any))
      .toThrow(/default/i);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `validate-boot-config.ts`:

```ts
export class BootConfigError extends Error {
  constructor(failures: string[]) {
    super(`Refusing to start — invalid configuration:\n  - ${failures.join('\n  - ')}`);
    this.name = 'BootConfigError';
  }
}

export function validateBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  const fail: string[] = [];
  const need = (k: string) => { if (!env[k]) fail.push(`${k} is required but unset`); };

  need('JWT_SECRET'); need('ENCRYPTION_KEY'); need('DATABASE_URL');
  if (env.ENCRYPTION_KEY === 'td-automation-default-key-change-me')
    fail.push('ENCRYPTION_KEY is the public default sentinel — set a real key');

  if (env.NODE_ENV === 'production') {
    if (env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length < 32) fail.push('ENCRYPTION_KEY must be >= 32 chars in production');
    if (!env.WEB_ORIGIN) fail.push('WEB_ORIGIN is required in production (no localhost/wildcard CORS fallback)');
    if (env.DATABASE_URL && !/sslmode=(require|verify-full|verify-ca)/.test(env.DATABASE_URL))
      fail.push('DATABASE_URL must enforce TLS (sslmode=require) in production');
    if (!/^https:\/\//.test(env.AI_ENGINE_URL ?? '')) fail.push('AI_ENGINE_URL must be https in production');
    if (env.REDIS_TLS !== 'true') fail.push('REDIS_TLS must be "true" in production (ElastiCache in-transit encryption)');
    if (env.REDIS_THROTTLER !== 'true') fail.push('REDIS_THROTTLER must be "true" in production (durable cross-replica limits)');
  }
  if (fail.length) throw new BootConfigError(fail);
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-004: boot-time config assertions (secrets + prod TLS/CORS)`.

---

### Task 5: helmet, strict CORS, HTTPS enforcement, boot validation in `main.ts`

**Files:**
- Create: `apps/api/src/common/http/enforce-https.middleware.ts`
- Modify: `apps/api/src/main.ts`
- Create: `apps/api/test/tda004/transport-hardening.spec.ts`

**Interfaces — Produces:** helmet headers on every response; CORS that rejects unknown origins (prod, fail-closed); `EnforceHttpsMiddleware` (prod-only). **Consumes:** `validateBootConfig` (Task 4).

- [ ] **Step 1: Write the failing test** — boot a minimal Nest app applying the same hardening helpers and assert headers/CORS. Use the tda003 Style-A harness (random port, real fetch). Factor the hardening into a `applyHttpHardening(app, env)` helper in `main.ts` (export it) so the test exercises the real code, not a copy:

```ts
import { INestApplication, Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { applyHttpHardening } from '../../src/main';

@Controller() class PingController { @Get('ping') ping() { return { ok: true }; } }
@Module({ controllers: [PingController] }) class PingModule {}

let app: INestApplication; let url: string;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [PingModule] }).compile();
  app = mod.createNestApplication();
  applyHttpHardening(app, { NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com' } as any);
  await app.init(); await app.listen(0);
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => { await app?.close(); });

it('sets helmet security headers and hides X-Powered-By', async () => {
  const res = await fetch(`${url}/ping`);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toMatch(/DENY|SAMEORIGIN/);
  expect(res.headers.get('x-powered-by')).toBeNull();
});
it('rejects a foreign CORS origin in production', async () => {
  const res = await fetch(`${url}/ping`, { headers: { Origin: 'https://evil.example.com' } });
  // CORS rejection → no ACAO echoing the foreign origin
  expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
});
it('allows the configured WEB_ORIGIN', async () => {
  const res = await fetch(`${url}/ping`, { headers: { Origin: 'https://app.example.com' } });
  expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
});
```

- [ ] **Step 2: Run → FAIL** (`applyHttpHardening` not exported).

- [ ] **Step 3: Implement.**

`enforce-https.middleware.ts`:
```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/** Prod-only: behind an ALB/proxy, reject plaintext requests (x-forwarded-proto !== https). */
@Injectable()
export class EnforceHttpsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
      res.status(426).json({ statusCode: 426, message: 'HTTPS required' });
      return;
    }
    next();
  }
}
```

In `main.ts`: export `applyHttpHardening(app, env = process.env)` that does helmet + CORS + trust-proxy + https middleware; call `validateBootConfig(env)` at the top of `bootstrap()` (before `NestFactory.create`), and call `applyHttpHardening(app)` in place of the current inline `enableCors`:
```ts
import helmet from 'helmet';
import { EnforceHttpsMiddleware } from './common/http/enforce-https.middleware';
import { validateBootConfig } from './common/config/validate-boot-config';

export function applyHttpHardening(app: INestApplication, env: NodeJS.ProcessEnv = process.env): void {
  app.use(helmet());                       // HSTS, nosniff, frameguard, hide x-powered-by
  app.set('trust proxy', 1);
  const isProd = env.NODE_ENV === 'production';
  const allowlist = (env.WEB_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean))
    ?? (isProd ? [] : ['http://localhost:4000', 'http://127.0.0.1:4000']);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);             // same-origin / curl / mobile
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`), false);
    },
    credentials: true,
  });
  app.use(new EnforceHttpsMiddleware().use);
}
```
Then in `bootstrap()`: `validateBootConfig();` first, replace the inline CORS block with `applyHttpHardening(app);`. Keep helmet CSP minimal so Swagger `/api/docs` still loads (if it breaks, pass `helmet({ contentSecurityPolicy: false })` only for the docs route, or a scoped CSP — document the choice in the commit).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-004: helmet + fail-closed CORS + HTTPS enforcement + boot validation`.

---

### Task 6: Redis client + pluggable rate-limit storage + global throttler seam

**Files:**
- Create: `apps/api/src/common/ratelimit/rate-limit-store.interface.ts`, `memory-rate-limit.store.ts`, `redis-rate-limit.store.ts`, `redis.provider.ts`
- Modify (shared seam, additive): `apps/api/src/app.module.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts` (drop local `ThrottlerModule.forRoot`)
- Create: `apps/api/test/tda004/rate-limit-store.spec.ts`
- Create: `apps/api/test/tda004/global-throttle.spec.ts`

**Interfaces — Produces:** `RateLimitStore { hit(key, ttlMs): Promise<{count, resetMs}> }`, `MemoryRateLimitStore`, `RedisRateLimitStore`, `REDIS_CLIENT` token, central `ThrottlerModule` + global `ThrottlerGuard`.

- [ ] **Step 1a: Write the store unit test** — `rate-limit-store.spec.ts`:

```ts
import { MemoryRateLimitStore } from '../../src/common/ratelimit/memory-rate-limit.store';

describe('MemoryRateLimitStore', () => {
  it('increments within the window and resets after TTL', async () => {
    const s = new MemoryRateLimitStore();
    expect((await s.hit('k', 50)).count).toBe(1);
    expect((await s.hit('k', 50)).count).toBe(2);
    await new Promise((r) => setTimeout(r, 70));
    expect((await s.hit('k', 50)).count).toBe(1); // window expired
  });
  it('keys are independent', async () => {
    const s = new MemoryRateLimitStore();
    await s.hit('a', 1000);
    expect((await s.hit('b', 1000)).count).toBe(1);
  });
});
```

- [ ] **Step 1b: Write the global-throttle integration test** — `global-throttle.spec.ts`: boot a focused module that imports the central `ThrottlerModule` config + registers the global `ThrottlerGuard`, with a tiny limit (e.g. 3/60s) via env override; hammer a test route and assert the 4th request is 429. (Use Style-A harness; force `REDIS_THROTTLER` unset so it uses memory storage — no Redis needed in CI.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**

`rate-limit-store.interface.ts`:
```ts
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export interface RateLimitHit { count: number; resetMs: number; }
export interface RateLimitStore { hit(key: string, ttlMs: number): Promise<RateLimitHit>; }
```

`memory-rate-limit.store.ts` — a `Map<string, { count; expiresAt }>` with lazy expiry (dev/test default).

`redis-rate-limit.store.ts` — ioredis `INCR` then `PEXPIRE` on first hit (atomic via a tiny Lua script or a pipeline), `PTTL` for `resetMs`:
```ts
import Redis from 'ioredis';
import { RateLimitHit, RateLimitStore } from './rate-limit-store.interface';

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, ttlMs: number): Promise<RateLimitHit> {
    const k = `rl:${key}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, ttlMs);
    const ttl = await this.redis.pttl(k);
    return { count, resetMs: ttl < 0 ? ttlMs : ttl };
  }
}
```

`redis.provider.ts` — `REDIS_CLIENT` factory (gated: returns a shared `new Redis({ host, port, password, tls })` from `redis.*` config; in tests with `REDIS_THROTTLER!=='true'` it is not instantiated). Also a `THROTTLER_STORAGE` factory: when `REDIS_THROTTLER==='true'`, wrap the Redis client in a `ThrottlerStorage` (use `@nest-lab/throttler-storage-redis` **only if added at prod time**, or a thin adapter over `RedisRateLimitStore`); otherwise return `undefined` so `@nestjs/throttler` uses its default in-memory storage. Document that the package add is deferred to prod wiring.

`app.module.ts` (**additive**): add near the BullModule block —
```ts
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
// ...
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    throttlers: [{
      name: 'default',
      ttl: config.get<number>('rateLimit.ttl', 60_000),
      limit: config.get<number>('rateLimit.limit', 120),
    }],
    // storage left default (in-memory) unless the gated Redis storage is provided
  }),
}),
SecretsModule, KmsModule,   // from Tasks 1 & 3
// ...
providers: [
  { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },  // existing
  { provide: APP_GUARD, useClass: ThrottlerGuard },                  // NEW — runs before JwtAuthGuard (AppModule scanned first)
]
```
Add to `configuration.ts`: `rateLimit: { ttl: +(process.env.GLOBAL_RATE_TTL||60000), limit: +(process.env.GLOBAL_RATE_LIMIT||120) }`.

`auth.module.ts` — remove the local `ThrottlerModule.forRoot([...])` import/registration (now centralized). The `@Throttle({ default: AUTH_THROTTLE })` decorators in the controller keep working against the central `default` throttler. Leave `@UseGuards(ThrottlerGuard)` on the auth handlers (harmless; the global guard also covers them).

- [ ] **Step 4: Run → PASS.** Confirm app still boots: `cd apps/api && npx nest build` (SWC) or smoke `npx jest --config test/tda003/jest.config.js --verbose` (guards still wired).
- [ ] **Step 5: Commit** `TDA-004: central global throttler (app.module seam) + pluggable Redis rate-limit storage`.

---

### Task 7: Per-account rate limiter on auth routes

**Files:**
- Create: `apps/api/src/common/ratelimit/account-rate-limit.decorator.ts`, `account-rate-limit.guard.ts`
- Modify: `apps/api/src/modules/auth/controllers/auth.controller.ts` (`login`, `password/forgot`)
- Modify: `apps/api/src/modules/auth/auth.module.ts` (provide the store + guard)
- Create: `apps/api/test/tda004/account-rate-limit.spec.ts`

**Interfaces — Produces:** `@AccountRateLimit({ limit, ttl })` + `AccountRateLimitGuard` (429 keyed on normalized `req.body.email`). **Consumes:** `RateLimitStore` (Task 6).

- [ ] **Step 1: Write the failing test** — boot the real `AuthModule` (Style-A, point `DATABASE_URL` at `td_saas_test`); POST `/auth/login` with the **same email from two different `X-Forwarded-For` IPs** and assert the 6th attempt (limit 5) returns 429 even though IPs differ; a *different* email is unaffected:

```ts
it('429s after the per-account limit regardless of source IP', async () => {
  const body = JSON.stringify({ email: 'victim@t.local', password: 'wrong' });
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
      body,
    });
    last = res.status;
  }
  expect(last).toBe(429);
});
it('a different account is not throttled by the victim’s attempts', async () => {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'other@t.local', password: 'wrong' }),
  });
  expect(res.status).not.toBe(429);
});
```
(Use a `MemoryRateLimitStore` bound for the test; limit configured low, e.g. `{ limit: 5, ttl: 900000 }`.)

- [ ] **Step 2: Run → FAIL** (no per-account limiting yet — all 6 return 401/200).

- [ ] **Step 3: Implement.**

`account-rate-limit.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
export const ACCOUNT_RATE_LIMIT = 'account_rate_limit';
export interface AccountRateLimitOpts { limit: number; ttl: number; }
export const AccountRateLimit = (opts: AccountRateLimitOpts) => SetMetadata(ACCOUNT_RATE_LIMIT, opts);
```

`account-rate-limit.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Inject, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCOUNT_RATE_LIMIT, AccountRateLimitOpts } from './account-rate-limit.decorator';
import { RATE_LIMIT_STORE, RateLimitStore } from './rate-limit-store.interface';

@Injectable()
export class AccountRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.get<AccountRateLimitOpts>(ACCOUNT_RATE_LIMIT, ctx.getHandler());
    if (!opts) return true;
    const req = ctx.switchToHttp().getRequest();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email) return true; // body validation will 400; nothing to key on
    const route = req.route?.path ?? req.url;
    const { count } = await this.store.hit(`acct:${route}:${email}`, opts.ttl);
    if (count > opts.limit) {
      throw new HttpException('Too many attempts for this account. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
```
(Returns the same 429 whether or not the account exists → preserves no-enumeration.)

Controller — add to `login` and `forgotPassword`:
```ts
import { AccountRateLimit } from '../../../common/ratelimit/account-rate-limit.decorator';
import { AccountRateLimitGuard } from '../../../common/ratelimit/account-rate-limit.guard';
// ...
@AccountRateLimit({ limit: 5, ttl: 15 * 60_000 })
@UseGuards(ThrottlerGuard, AccountRateLimitGuard)   // keep existing ThrottlerGuard, add account guard
@Post('login') ...
```

`auth.module.ts` — provide the store + guard:
```ts
import { RATE_LIMIT_STORE } from '../../common/ratelimit/rate-limit-store.interface';
import { MemoryRateLimitStore } from '../../common/ratelimit/memory-rate-limit.store';
import { RedisRateLimitStore } from '../../common/ratelimit/redis-rate-limit.store';
import { AccountRateLimitGuard } from '../../common/ratelimit/account-rate-limit.guard';
// providers: add
{ provide: RATE_LIMIT_STORE, useFactory: (config: ConfigService, /* REDIS_CLIENT? */) =>
    config.get('rateLimit.redis') ? new RedisRateLimitStore(/* client */) : new MemoryRateLimitStore(),
  inject: [ConfigService] },
AccountRateLimitGuard,
```
(In tests the factory yields `MemoryRateLimitStore`.)

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-004: per-account rate limiter on login/forgot (Redis-backed, cross-replica)`.

---

### Task 8: AWS provisioning notes + env template + regression CI guard

**Files:**
- Modify: `.env.example` (additive — document the new vars; no real secrets)
- Create: `apps/api/test/tda004/no-default-key.spec.ts` (repo-wide regression guard)
- Create: `docs/superpowers/specs/2026-07-01-tda-004-aws-provisioning-notes.md` (deployment runbook stub — IaC outline, NOT executed here)

**Note:** This task is documentation + a CI lock; no app behaviour changes.

- [ ] **Step 1: Write the regression guard** — `no-default-key.spec.ts`: walk `apps/api/src/**/*.ts` and fail if any file contains `td-automation-default-key-change-me`. (Use `fs`/`glob`; assert zero matches.)

- [ ] **Step 2: Run → PASS** (Task 2 already removed it; this locks it). If it FAILS, a stray fallback remains — fix it.

- [ ] **Step 3: Document.**
  - `.env.example`: add `SECRETS_PROVIDER=local`, `KMS_PROVIDER=local`, `KMS_CMK_ID=`, `REDIS_TLS=false`, `REDIS_THROTTLER=false`, `GLOBAL_RATE_LIMIT=120`, `GLOBAL_RATE_TTL=60000`, `WEB_ORIGIN=`, `AI_ENGINE_URL=http://localhost:5000`, `NODE_ENV=development`. Update the `ENCRYPTION_KEY` comment to "REQUIRED — no default; app refuses to boot if unset".
  - `2026-07-01-tda-004-aws-provisioning-notes.md`: IaC outline only — (a) KMS CMK with alias `alias/td-saas-cmk`, key policy granting only the execution role `Encrypt`/`Decrypt`/`GenerateDataKey`; (b) Secrets Manager secret `td-saas/<env>` (JSON bundle: `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, …) with rotation; (c) RDS `sslmode=require` + bundled CA; (d) ElastiCache in-transit encryption (`rediss://`); (e) ALB TLS termination + HSTS; (f) the `@aws-sdk/client-kms` + `@aws-sdk/client-secrets-manager` deps are added **only in the prod build**, and `SECRETS_PROVIDER=aws`/`KMS_PROVIDER=aws` flip the factories. Mark the whole doc **deployment-gated — not part of the MVP test loop**.

- [ ] **Step 4: Run the full tda004 suite** → PASS: `cd apps/api && npx jest --config test/tda004/jest.config.js --verbose`.
- [ ] **Step 5: Commit** `TDA-004: env template + AWS provisioning notes + default-key regression guard`.

---

## Self-Review

- Spec §2 (provider abstraction) → T1 (Secrets) + T3 (Kms); §3 → T1; §4 → T3; §5 (kill fallback) → T2; §6 (boot assertions) → T4; §7 (helmet/CORS/TLS) → T5; §8.1 (global throttler seam) → T6; §8.2 (per-account) → T7; §8.3 (Redis storage) → T6/T7; §8 AWS provisioning → T8.
- **Acceptance mapping:** AC1→T1/T3, AC2→T2 (+T8 lock), AC3→T4, AC4→T5, AC5→T6/T7, AC6→T6.
- **No schema change / no migration** — `prisma migrate status` clean before+after (envelope columns are TDA-005). ✅
- **Shared seam discipline:** `app.module.ts` edits are purely additive (one ThrottlerModule import, two new global modules, one APP_GUARD); existing CLS/Tenant/Auth ordering untouched. The new `ThrottlerGuard` APP_GUARD is in the root module, scanned before `AuthModule`, so it runs before `JwtAuthGuard` — correct for a limiter (no `req.user` needed). ✅
- **Offline-testable:** all default providers are env/memory/local; `@aws-sdk/*` and Redis are dynamic/gated so CI needs neither. ✅
- **No-enumeration preserved:** `AccountRateLimitGuard` returns an identical 429 regardless of account existence; `forgotPassword` still always 200 until the limit. ✅
- **Risk — Swagger CSP:** `helmet()` default CSP can block `/api/docs`; T5 flags the minimal CSP override and to verify the docs route loads. ✅
- **Risk — double throttler config:** T6 removes `AuthModule`'s local `ThrottlerModule.forRoot` so there is exactly one `default` throttler; the controller's `@Throttle({ default })` overrides bind to it. Verify auth routes still 429 after 10/min. ✅
- **Jest 29.7:** all run commands use `--verbose`, never `-v`. ✅
