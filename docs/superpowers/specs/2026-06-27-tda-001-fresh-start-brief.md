# TDA-001 (fresh-start) — Multi-Tenant Foundation Brief

**Spec ID:** TDA-001 · **Sprint:** S1 · **Branch:** `feat/TDA-001-multi-tenant-model`
**Supersedes** the in-place-migration variant: we build on a **fresh `td_saas` database**.

## Context (already done before this task)
- Worktree at `.claude/worktrees/TDA-001`, branched from `main` HEAD. `.env` present with `DATABASE_URL` → `td_saas`.
- `td_saas` database created; the full current engine schema applied via migration `20260626204320_catchup_engine_schema_to_current`. `td_saas` is in sync with `prisma/schema.prisma`.
- Run all Prisma commands from the **worktree root** (not `apps/api`) with `--schema prisma/schema.prisma`. The DB user is a superuser; DB admin ops use `docker exec td-postgres psql -U postgres ...`.

## Goal of this task
Add the multi-tenant foundation to `prisma/schema.prisma`, generate ONE clean migration `tda001_multi_tenant_foundation`, seed an ADMIN user + placeholder consent doc, and prove it with integration tests. **Shapes only — no behaviour** (no auth logic, no KMS crypto; those are TDA-002/005). On this fresh DB there is NO backfill and NO legacy plaintext columns.

## A. New models (append to schema.prisma)
```prisma
enum UserRole { USER ADMIN }
enum UserStatus { PENDING_VERIFICATION ACTIVE SUSPENDED CLOSED }
enum Segment { INTRADAY SWING }
enum SubscriptionStatus { ACTIVE PAST_DUE CANCELLED EXPIRED }

model User {
  id              String      @id @default(cuid())
  email           String      @unique
  passwordHash    String
  role            UserRole    @default(USER)
  status          UserStatus  @default(PENDING_VERIFICATION)
  emailVerifiedAt DateTime?
  displayName     String?
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
  subscriptions     Subscription[]
  brokerCredential  BrokerCredential?
  autoTradeConsents AutoTradeConsent[]
  consentRecords    ConsentRecord[]
  trades            Trade[]
  settings          UserSettings?
  alerts            Alert[]
  dailyPerformance  DailyPerformance[]
  tradeAnalyses     AITradeAnalysis[]
  weeklyReports     AIWeeklyReport[]
  auditLogs         AuditLog[]
  @@index([status])
  @@map("users")
}

model Subscription {
  id        String             @id @default(cuid())
  userId    String
  user      User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  segment   Segment
  status    SubscriptionStatus @default(ACTIVE)
  startedAt DateTime           @default(now())
  expiresAt DateTime?
  createdAt DateTime           @default(now())
  updatedAt DateTime           @updatedAt
  @@unique([userId, segment])
  @@index([status, expiresAt])
  @@map("subscriptions")
}

model AutoTradeConsent {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  segment      Segment
  enabled      Boolean  @default(false)
  killSwitch   Boolean  @default(false)
  riskPerTrade Float?
  maxCapital   Float?
  enabledAt    DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([userId, segment])
  @@map("auto_trade_consents")
}

model ConsentDocument {
  id          String   @id @default(cuid())
  version     String   @unique
  kind        String
  body        String
  contentHash String
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  records     ConsentRecord[]
  @@map("consent_documents")
}

model ConsentRecord {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  documentId String
  document   ConsentDocument @relation(fields: [documentId], references: [id])
  version    String
  acceptedAt DateTime @default(now())
  ipAddress  String?
  userAgent  String?
  @@index([userId, version])
  @@map("consent_records")
}

model AuditLog {
  id        String   @id @default(cuid())
  userId    String?
  user      User?    @relation(fields: [userId], references: [id])
  action    String
  target    String?
  meta      Json?
  prevHash  String?
  hash      String
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
  @@index([action, createdAt])
  @@map("audit_logs")
}
```

## B. Reshape `BrokerCredential` → vault-only (replace the whole model)
The current model has plaintext `apiKey/clientId/password/totpSecret` and `broker @unique`. Replace with:
```prisma
model BrokerCredential {
  id            String    @id @default(cuid())
  userId        String    @unique
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  broker        String    @default("angel_one")
  encApiKey     String
  encApiSecret  String
  encClientId   String
  encPassword   String
  encTotpSecret String
  encDataKey    String
  keyVersion    Int       @default(1)
  isActive      Boolean   @default(true)
  lastConnected DateTime?
  lastValidated DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  @@map("broker_credentials")
}
```
(No plaintext columns — TDA-005 populates the `enc*` fields with real envelope-encrypted ciphertext. For now they are required strings holding whatever the connect flow writes.)

## C. Add `userId` to the 6 other tenant-owned models
For each, ADD `userId String` + relation `user User @relation(fields: [userId], references: [id], onDelete: Cascade)` and indexes as noted. Read each model's current definition first; keep all existing fields/indexes except where a replacement is specified.

- **Trade** (`trades`): add `userId String` + relation + `@@index([userId])`; REPLACE `@@index([status, createdAt])` → `@@index([userId, status, createdAt])`; REPLACE `@@index([source, status])` → `@@index([userId, source, status])`. Leave other indexes as-is.
- **UserSettings** (`user_settings`): add `userId String @unique` + relation. (Was a singleton.)
- **DailyPerformance** (`daily_performance`): add `userId String` + relation + `@@index([userId])`.
- **Alert** (`alerts`): add `userId String` + relation; REPLACE `@@index([isActive, type])` → `@@index([userId, isActive, type])`.
- **AITradeAnalysis** (`ai_trade_analysis`): add `userId String` + relation + `@@index([userId])`.
- **AIWeeklyReport** (`ai_weekly_reports`): add `userId String` + relation + `@@index([userId])`.

> NOT tenant-owned — DO NOT add `userId` to any other model (Signal, Setup, Zone, all Chartink/Watch/Ungated/AdaptiveStop/Intraday/Swing/BreakoutSwing/Reinvestment/Instrument/Candle/etc. stay global/IP).

## D. Migration
From worktree root: `npx prisma migrate dev --name tda001_multi_tenant_foundation --schema prisma/schema.prisma`
Then append the ADMIN + ConsentDocument seed INSERTs to the generated `migration.sql` (so prod migrate is self-contained):
```sql
INSERT INTO "users" ("id","email","passwordHash","role","status","createdAt","updatedAt")
VALUES ('usr_admin_seed_0001','admin@local','!UNSET-SET-IN-TDA-002','ADMIN','ACTIVE', now(), now())
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "consent_documents" ("id","version","kind","body","contentHash","active","createdAt")
VALUES ('cdoc_seed_0001','2026-06-27.0-placeholder','risk-disclosure','PLACEHOLDER - replaced in TDA-009','sha256:placeholder', true, now())
ON CONFLICT ("id") DO NOTHING;
```
Re-apply so the seed rows land: `npx prisma migrate reset --force --schema prisma/schema.prisma` is NOT allowed (it drops data). Instead run the two INSERTs once against `td_saas` via `docker exec td-postgres psql -U postgres -d td_saas -c "..."` OR rely on the seed script (E). Either way the ADMIN + consent rows must exist in `td_saas` after this task.

## E. Seed script
Inspect the existing `prisma/seed.ts` (referenced by root `package.json` → `prisma.seed`). Add idempotent upserts (do not remove existing seed logic):
```ts
await prisma.user.upsert({ where: { id: 'usr_admin_seed_0001' }, update: {},
  create: { id: 'usr_admin_seed_0001', email: 'admin@local', passwordHash: '!UNSET-SET-IN-TDA-002', role: 'ADMIN', status: 'ACTIVE' } });
await prisma.consentDocument.upsert({ where: { id: 'cdoc_seed_0001' }, update: {},
  create: { id: 'cdoc_seed_0001', version: '2026-06-27.0-placeholder', kind: 'risk-disclosure', body: 'PLACEHOLDER - replaced in TDA-009', contentHash: 'sha256:placeholder' } });
```
Run it: `npx prisma db seed`.

## F. Integration tests (use a dedicated test DB `td_saas_test`)
Provision: `docker exec td-postgres psql -U postgres -c "CREATE DATABASE td_saas_test;"` then
`DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/td_saas_test npx prisma migrate deploy --schema prisma/schema.prisma`
(use the SAME credentials/host as `.env`'s DATABASE_URL — read them; do not hardcode a wrong password).
Then seed it the same way against that URL.

Create `apps/api/test/tda001/test-prisma.ts` and `apps/api/test/tda001/tenancy.spec.ts` (Jest). Tests must assert, against `DATABASE_URL_TEST` → `td_saas_test`:
1. ADMIN user `usr_admin_seed_0001` exists with role ADMIN, status ACTIVE.
2. Consent doc `cdoc_seed_0001` exists with version `2026-06-27.0-placeholder`.
3. A full subscriber graph can be created and cascades on delete: `User` → `Subscription(SWING)` + `AutoTradeConsent(SWING)` + `BrokerCredential{enc* all set, encDataKey:'wrapped'}` + `ConsentRecord{documentId:'cdoc_seed_0001'}`. Assert `brokerCredential.encDataKey === 'wrapped'`, then `db.user.delete` and assert children are gone.
4. `broker_credentials` has NO plaintext columns: query `information_schema.columns` and assert `apiKey`,`password`,`clientId`,`totpSecret` are ABSENT and `encApiKey`,`encDataKey`,`keyVersion` are PRESENT.
5. `trades.userId` is NOT NULL (information_schema `is_nullable='NO'`).

Run: `cd apps/api && DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/td_saas_test npx jest test/tda001 -v` (substitute real creds from `.env`).

## G. Acceptance
- `npx prisma validate` passes; `npx prisma generate` succeeds.
- Migration `tda001_multi_tenant_foundation` exists and applies cleanly to a fresh DB (verified via `td_saas_test` deploy).
- All TDA-001 tests pass.
- `td_saas` contains ADMIN + consent rows.
- No `userId` added to any global/IP model; no plaintext columns remain on `broker_credentials`.

## Commits
One or more commits prefixed `TDA-001:`. Do NOT commit `.env`. Commit schema, migration dir, seed changes, and tests.
