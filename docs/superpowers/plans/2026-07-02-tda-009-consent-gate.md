# TDA-009 Versioned Consent & Disclaimer Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Block auto-execution until a user has accepted the current, content-hash-pinned risk disclosure; force re-acceptance on a version bump; record every acceptance / revocation / publication through the TDA-008 hash-chain with timestamp + IP; and expose the minimal `hasAcceptedCurrent(userId)` seam + `ConsentGuard` that TDA-011 will consume.

**Architecture:** A `@Global ConsentModule` provides `ConsentService` — the only code that computes a content hash (`'sha256:' + sha256(canonicalize({kind, version, body}))`, reusing TDA-008's single hasher) and the only code that writes `ConsentRecord`/`ConsentDocument`. "Current version" = the single `active` `ConsentDocument` for `kind='risk-disclosure'`. Acceptance is pinned to the active document's **id**, so publishing a new version (new id) makes `hasAcceptedCurrent` return `false` for everyone with **no** per-user bookkeeping. Acceptance/revoke/publish each append a fatal (throwing) audit row via `AuditService.append`. A `ConsentGuard` + `@RequiresConsent()` decorator enforce the gate on HTTP routes (attached by TDA-011); the fan-out calls `hasAcceptedCurrent` directly.

**Tech Stack:** NestJS 11, Prisma 6 (Postgres `td_saas`/`td_saas_test`), Jest 29.7 + ts-jest, Vitest (web). Reuses TDA-008 (`AuditService`, `canonicalize`/`sha256`, `CONSENT_*` taxonomy), TDA-003 (`@AdminOnly`, `RolesGuard`, `@CurrentUser`, `TenantContextService.runWithoutTenant`), TDA-002 (`JwtAuthGuard`, `req.ip`/user-agent). Frontend React 19 + Zustand + axios `/api` instance.

## Global Constraints

- **Parallel worktree from `main`.** **THIS lane OWNS `prisma/schema.prisma`** for its wave and runs a single **forward** migration only — **never `prisma migrate reset`**, never edit a prior migration. DB: dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`.
- **No new model.** `ConsentDocument` + `ConsentRecord` already exist (TDA-001). The only schema deltas are **additive**: `@@unique([userId, documentId])` on `ConsentRecord` and `@@index([kind, active])` on `ConsentDocument`.
- **Shared seam `app.module.ts`** — register `ConsentModule` (additive import only; `@Global`, so order is not load-bearing — place near `AuditModule`; do not reorder existing imports/guards).
- **Single hasher.** Content hash is computed ONLY in `ConsentService.computeContentHash`, importing `canonicalize`/`sha256` from `apps/api/src/common/audit/canonicalize`. Never hash a disclosure body elsewhere, never in SQL.
- **Audit is fatal for consent** (TDA-008 §4.1): `accept`/`revoke`/`publish` call `AuditService.append` and let it throw (unlike auth's best-effort swallow). Safe because the accept record upsert is idempotent on `(userId, documentId)`.
- **Consent actions already exist** in `audit-actions.ts`: `CONSENT_ACCEPT`, `CONSENT_REVOKE`, `CONSENT_VERSION_PUBLISHED`. Do NOT re-declare — import `AuditAction` and use the strings.
- **Tenant scoping:** `ConsentDocument` is NOT a tenant model (global reads). `ConsentRecord` IS — all its reads/writes here run via `TenantContextService.runWithoutTenant(...)` with an explicit `userId` (mirror TDA-007 `SubscriptionService`).
- **Kind constant:** `RISK_DISCLOSURE = 'risk-disclosure'` (matches the seed). `getCurrent`/`getStatus`/`hasAcceptedCurrent`/`revoke` default to it.
- **Commit prefix:** `TDA-009:`. No `.env`. Stage only changed files (no `git add -A`).
- **Test harness:** reuse TDA-008's tda008 Style-A/Style-B patterns. New tests in `apps/api/test/tda009/` with a `jest.config.js` mirroring `apps/api/test/tda008/jest.config.js` (`roots`→`test/tda009`, otplib stub mapped). Run from `apps/api`: `npx jest --config test/tda009/jest.config.js --verbose` (prefix `DATABASE_URL_TEST=…` for DB specs). Frontend: `cd apps/web && npx vitest run <file>`.

---

## File Structure

- `apps/api/src/modules/consent/consent.constants.ts` — **create.** `RISK_DISCLOSURE`, error codes.
- `apps/api/src/modules/consent/consent.service.ts` — **create.** `computeContentHash`, `getCurrent`, `getStatus`, `hasAcceptedCurrent`, `accept`, `revoke`, `publish`.
- `apps/api/src/modules/consent/consent.guard.ts` — **create.** `ConsentGuard` (403 `CONSENT_REQUIRED`).
- `apps/api/src/modules/consent/consent.decorator.ts` — **create.** `@RequiresConsent()` (sets metadata + `@UseGuards(ConsentGuard)`), or a marker read by a globally-mountable guard — simplest: `@UseGuards(ConsentGuard)` alias.
- `apps/api/src/modules/consent/consent.controller.ts` — **create.** USER: `GET /api/consent/current`, `GET /api/consent/status`, `POST /api/consent/accept`, `POST /api/consent/revoke`.
- `apps/api/src/modules/consent/admin-consent.controller.ts` — **create.** `POST /api/admin/consent/publish` (`@AdminOnly`).
- `apps/api/src/modules/consent/dto/consent.dto.ts` — **create.** `AcceptConsentDto { version, contentHash }`, `PublishConsentDto { kind?, version, body }`.
- `apps/api/src/modules/consent/consent.module.ts` — **create.** `@Global`; provides+exports `ConsentService` + `ConsentGuard`; declares both controllers.
- `apps/api/src/modules/consent/index.ts` — **create.** Barrel (`ConsentService`, `ConsentGuard`, `RequiresConsent`, types) — the TDA-011 seam import point.
- `prisma/schema.prisma` — **modify.** Add the two additive constraints (§3.1).
- `prisma/migrations/<ts>_tda009_consent_constraints/migration.sql` — **create** (forward).
- `prisma/seed.ts` — **modify.** Replace the placeholder body + `contentHash` with real hash-pinned MVP disclosure.
- `apps/api/src/app.module.ts` — **modify.** Import `ConsentModule` (additive).
- `apps/web/src/hooks/useConsent.ts` — **create.** Status fetch + accept + `needsConsent` selector.
- `apps/web/src/pages/settings/SettingsPage.tsx` — **modify.** Real "Consent & disclaimer" card (USER view).
- `apps/api/test/tda009/` — **create.** `jest.config.js`, `otplib.stub.js` (copy from tda008), `content-hash.spec.ts`, `consent-guard.spec.ts`, `consent-service.spec.ts` (DB), `consent-endpoint.spec.ts` (HTTP).
- `apps/web/src/hooks/useConsent.spec.ts` — **create.** `needsConsent` selector (Vitest).

---

### Task 1: Content-hash pinning + `ConsentService.getCurrent` + `ConsentModule`

**Files:**
- Create: `apps/api/src/modules/consent/consent.constants.ts`, `consent.service.ts`, `consent.module.ts`, `index.ts`.
- Create: `apps/api/test/tda009/content-hash.spec.ts`, `apps/api/test/tda009/jest.config.js` (copy tda008's, `roots`→`<rootDir>/test/tda009`); copy `apps/api/test/tda008/otplib.stub.js` → `test/tda009/otplib.stub.js`.

**Interfaces — Produces:**
- `const RISK_DISCLOSURE = 'risk-disclosure'`.
- `ConsentService.computeContentHash(kind, version, body): string` — `'sha256:' + sha256(canonicalize({ kind, version, body }))`.
- `ConsentService.getCurrent(kind?): Promise<CurrentConsent | null>` — the single `active` doc for `kind`.
- `@Global() ConsentModule` providing+exporting `ConsentService`.

**Interfaces — Consumes:** `PrismaService` (`common/prisma`), `TenantContextService` (`common/tenant`), `canonicalize`/`sha256` (`common/audit/canonicalize`), `AuditService` (`common/audit`).

- [ ] **Step 1: Write the failing test** — `content-hash.spec.ts` (pure, no DB): instantiate `ConsentService` with stub deps (only `computeContentHash` under test — pass `null as any` for prisma/tenant/audit, or `new ConsentService(...)` with minimal fakes). Assert:
```ts
const h = svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY');
expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
expect(svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'BODY')).toBe(h); // stable
expect(svc.computeContentHash('risk-disclosure', '2026-07-02.2', 'BODY')).not.toBe(h); // version bound
expect(svc.computeContentHash('risk-disclosure', '2026-07-02.1', 'OTHER')).not.toBe(h); // body bound
```
- [ ] **Step 2: Run → FAIL** (`npx jest --config test/tda009/jest.config.js content-hash --verbose`).
- [ ] **Step 3: Implement** `consent.constants.ts` (`RISK_DISCLOSURE`, error-code strings), `consent.service.ts` (`computeContentHash` importing the shared canonicalizer; `getCurrent` = `prisma.consentDocument.findFirst({ where: { kind, active: true }, orderBy: { createdAt: 'desc' } })` mapped to `CurrentConsent`), the `@Global ConsentModule` (providers/exports `ConsentService`; imports `PrismaModule`, `TenantModule` — `AuditModule` is `@Global` so `AuditService` injects without import), and `index.ts` barrel.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-009: content-hash pinning + ConsentService.getCurrent + ConsentModule`.

---

### Task 2: Schema delta + forward migration + seed replacement

**Files:**
- Modify: `prisma/schema.prisma` (§3.1: `@@unique([userId, documentId])` on `ConsentRecord`; `@@index([kind, active])` on `ConsentDocument`).
- Create: `prisma/migrations/<ts>_tda009_consent_constraints/migration.sql`.
- Modify: `prisma/seed.ts`.

**Context:** Additive constraints only — no column changes, no `NOT NULL` tightening. The seed currently writes `body='PLACEHOLDER - replaced in TDA-009'`, `contentHash='sha256:placeholder'`; replace with a real MVP disclosure body and its real hash. If any pre-existing `ConsentRecord` rows would violate the new `@@unique([userId, documentId])`, dedupe them in the migration first (dev DB has none, but keep the migration prod-safe).

- [ ] **Step 1: Edit `schema.prisma`** — add the two `@@` lines (§3.1). Keep existing indexes/`@@map`.
- [ ] **Step 2: Generate WITHOUT applying** — `npx prisma migrate dev --name tda009_consent_constraints --create-only`. Inspect the generated `CREATE UNIQUE INDEX "consent_records_userId_documentId_key"` + `CREATE INDEX "consent_documents_kind_active_idx"`. (If prod-safety needs it, prepend a dedupe `DELETE` keeping the latest `acceptedAt` per `(userId, documentId)`.)
- [ ] **Step 3: Replace the seed** — in `prisma/seed.ts`, define the real MVP disclosure body (a structurally-correct risk disclosure string; final legal copy is Harden-phase) and a small local `contentHash` computed with the SAME algorithm (import `canonicalize`/`sha256` from `apps/api/src/common/audit/canonicalize`, or inline the identical `'sha256:'+sha256(canonicalize({kind,version,body}))`). Upsert `cdoc_seed_0001` with a real `version` (e.g. `'2026-07-02.1'`), the body, `contentHash`, `active: true`. Keep idempotent.
- [ ] **Step 4: Apply + seed** — `npx prisma migrate dev` (applies pending), `npx prisma generate`, then `DATABASE_URL=<td_saas> npx prisma db seed`. Confirm the seeded row's `contentHash` is a real `sha256:<64hex>` (no `placeholder`).
- [ ] **Step 5: Verify** — `npx prisma migrate status` clean; `docker exec td-postgres psql -U postgres -d td_saas -c '\d consent_records'` + `'\d consent_documents'` show the new index/unique.
- [ ] **Step 6: Commit** `TDA-009: consent constraints migration + real hash-pinned seed disclosure`.

---

### Task 3: `hasAcceptedCurrent` + `getStatus` + `accept` + `revoke` (fatal audit)

**Files:**
- Modify: `apps/api/src/modules/consent/consent.service.ts`.
- Create: `apps/api/test/tda009/consent-service.spec.ts` (DB-backed, Style-B).

**Interfaces — Produces:**
- `getStatus(userId, kind?): Promise<ConsentStatus>` (`{ currentVersion, accepted, acceptedVersion, requiresReconsent }`).
- `hasAcceptedCurrent(userId, kind?): Promise<boolean>` — **the TDA-011 seam**; `false` when no active doc (fail closed).
- `accept(userId, version, contentHash, ip, userAgent): Promise<ConsentStatus>` (spec §4.1).
- `revoke(userId, kind?): Promise<void>`.

**Interfaces — Consumes:** `AuditService.append` (fatal), `TenantContextService.runWithoutTenant`, `canonicalize`/`sha256`.

**Context:** All `ConsentRecord` queries run inside `runWithoutTenant(...)` with explicit `where: { userId }` (mirror TDA-007). Acceptance is pinned to the active document **id**. `accept` order: (1) load active doc, 409 `NO_ACTIVE_CONSENT` if none; (2) 409 `CONSENT_VERSION_STALE` if `version !== active.version`; (3) recompute `computeContentHash` and 409 `CONSENT_CONTENT_MISMATCH` if it ≠ `active.contentHash` OR ≠ echoed `contentHash`; (4) `upsert` `ConsentRecord` on `{ userId_documentId: { userId, documentId } }` with `version`, `ipAddress`, `userAgent`; (5) `await audits.append({ action: 'CONSENT_ACCEPT', userId, target: version, meta: { documentId, contentHash, kind, ip, userAgent } })` — **let it throw** (fatal); (6) return `getStatus`.

- [ ] **Step 1: Write the failing test** — `consent-service.spec.ts` (real `PrismaClient` + `PrismaService` + `TenantContextService`, mirror `test/tda007/subscription.spec.ts` boot). Use a unique test user + a test doc; import `GENESIS_PREV_HASH`/`verifyChain` via a real `AuditService`:
```ts
it('accept records ip/userAgent, gate opens, chain verifies', async () => {
  await svc.publish('risk-disclosure', v1, 'BODY-1', null);
  expect(await svc.hasAcceptedCurrent(uId)).toBe(false);
  await svc.accept(uId, v1, svc.computeContentHash('risk-disclosure', v1, 'BODY-1'), '1.2.3.4', 'jest');
  expect(await svc.hasAcceptedCurrent(uId)).toBe(true);
  const rec = await raw.consentRecord.findFirst({ where: { userId: uId } });
  expect(rec?.ipAddress).toBe('1.2.3.4');
  expect((await audit.verifyChain('global')).ok).toBe(true);
});
it('version bump forces re-consent', async () => {
  await svc.publish('risk-disclosure', v2, 'BODY-2', null);
  expect(await svc.hasAcceptedCurrent(uId)).toBe(false);
});
it('stale + content-mismatch are rejected', async () => {
  await expect(svc.accept(uId, 'nope', 'sha256:x', null, null)).rejects.toBeTruthy();
});
it('accept is idempotent (one row)', async () => {
  await svc.accept(uId, v2, svc.computeContentHash('risk-disclosure', v2, 'BODY-2'), null, null);
  await svc.accept(uId, v2, svc.computeContentHash('risk-disclosure', v2, 'BODY-2'), null, null);
  const rows = await raw.consentRecord.findMany({ where: { userId: uId, version: v2 } });
  expect(rows.length).toBe(1);
});
```
(Use a unique `chainKey` is NOT possible here — `append` uses `'global'`; isolate by asserting `verifyChain('global').ok` rather than exact seq. Clean the test user's `ConsentRecord` in `afterAll`.)
- [ ] **Step 2: Run → FAIL** (`DATABASE_URL_TEST=… npx jest --config test/tda009/jest.config.js consent-service --verbose`).
- [ ] **Step 3: Implement** `getStatus`/`hasAcceptedCurrent`/`accept`/`revoke` per §4/§4.1. `getStatus`: load active doc + the user's most-recent `ConsentRecord`; `accepted` = a record exists for the active doc id; `requiresReconsent` = a record exists for an older version but not the current. Throw `ConflictException({ code })` for the 409 cases. `revoke`: delete the caller's `ConsentRecord` for the active doc, then `append({ action: 'CONSENT_REVOKE', userId, target: currentVersion })` (fatal).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-009: hasAcceptedCurrent + accept/revoke with fatal audit`.

---

### Task 4: `publish` (ADMIN) + version-bump deactivation

**Files:**
- Modify: `apps/api/src/modules/consent/consent.service.ts`.
- Extend: `apps/api/test/tda009/consent-service.spec.ts` (publish path).

**Interfaces — Produces:** `publish(kind, version, body, actorUserId): Promise<CurrentConsent>`.

**Context:** In one `prisma.$transaction`: `updateMany({ where: { kind, active: true }, data: { active: false } })` then `create({ data: { kind, version, body, contentHash: computeContentHash(...), active: true } })` (unique `version` guards accidental re-publish). After the transaction, `await audits.append({ action: 'CONSENT_VERSION_PUBLISHED', userId: actorUserId, target: version, meta: { kind, contentHash, previousVersion } })` (fatal). Publishing is the ONLY path that changes "current".

- [ ] **Step 1: Write the failing test** — assert `publish` deactivates the prior active doc (exactly one active after), stores a real `contentHash`, and appends a `CONSENT_VERSION_PUBLISHED` row (query `raw.auditLog.findFirst({ where: { action: 'CONSENT_VERSION_PUBLISHED', target: version } })`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `publish` as above.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-009: publish new consent version (single-active + audit)`.

---

### Task 5: HTTP API + `ConsentGuard`/`@RequiresConsent` seam

**Files:**
- Create: `apps/api/src/modules/consent/dto/consent.dto.ts`, `consent.guard.ts`, `consent.decorator.ts`, `consent.controller.ts`, `admin-consent.controller.ts`.
- Modify: `consent.module.ts` (declare controllers; provide+export `ConsentGuard`), `apps/api/src/app.module.ts` (import `ConsentModule`).
- Create: `apps/api/test/tda009/consent-guard.spec.ts` (unit), `consent-endpoint.spec.ts` (HTTP, Style-A).

**Interfaces — Produces:**
- `ConsentGuard implements CanActivate` — reads `@CurrentUser` (`req.user`), calls `hasAcceptedCurrent(user.userId)`; `false` → `ForbiddenException({ code: 'CONSENT_REQUIRED', currentVersion })`.
- `@RequiresConsent()` = `applyDecorators(UseGuards(ConsentGuard))` (TDA-011 attaches this).
- Routes (spec §7): `GET /api/consent/current`, `GET /api/consent/status`, `POST /api/consent/accept`, `POST /api/consent/revoke`, `POST /api/admin/consent/publish` (`@AdminOnly`).

**Interfaces — Consumes:** `ConsentService`, `@CurrentUser`, `@AdminOnly`, `@Req()` for `req.ip`/`req.headers['user-agent']` (mirror `AuthController.ctx`).

- [ ] **Step 1: Write the failing tests.**
  - `consent-guard.spec.ts` (unit, stub `ConsentService`): build a fake `ExecutionContext` with `req.user = { userId, role }`; `hasAcceptedCurrent → false` ⇒ guard throws `ForbiddenException` whose response `.code === 'CONSENT_REQUIRED'`; `→ true` ⇒ `canActivate` resolves `true`.
  - `consent-endpoint.spec.ts` (Style-A, reuse tda008 `boot`/`tokenFor`/`getJson`/`postJson`): mint a USER JWT with `sub` = a seeded user id.
```ts
it('USER can read current + status', async () => {
  expect((await getJson('/api/consent/current', userToken)).status).toBe(200);
  expect((await getJson('/api/consent/status', userToken)).body.accepted).toBe(false);
});
it('accept flips status; admin publish forces reconsent', async () => {
  const cur = (await getJson('/api/consent/current', userToken)).body;
  expect((await postJson('/api/consent/accept', { version: cur.version, contentHash: cur.contentHash }, userToken)).status).toBe(201);
  expect((await getJson('/api/consent/status', userToken)).body.accepted).toBe(true);
  expect((await postJson('/api/admin/consent/publish', { version: '2026-07-02.9', body: 'NEW' }, userToken)).status).toBe(403);
  expect((await postJson('/api/admin/consent/publish', { version: '2026-07-02.9', body: 'NEW' }, adminToken)).status).toBe(201);
  expect((await getJson('/api/consent/status', userToken)).body.requiresReconsent).toBe(true);
});
```
- [ ] **Step 2: Run → FAIL** (no controllers / 404).
- [ ] **Step 3: Implement** the DTOs (`class-validator`: `version` non-empty string, `contentHash` matches `/^sha256:[0-9a-f]{64}$/`, `body` non-empty for publish), `ConsentGuard`, `@RequiresConsent()`, both controllers (accept/revoke capture `req.ip` + `req.headers['user-agent']` server-side, never from the body). Register controllers in `ConsentModule`; provide+export `ConsentGuard`. Add `ConsentModule` to `app.module.ts` imports (additive; near `AuditModule`).
- [ ] **Step 4: Run → PASS.** Also run tda008 endpoint suite to confirm no audit-chain regression.
- [ ] **Step 5: Commit** `TDA-009: consent API + ConsentGuard/@RequiresConsent seam for TDA-011`.

---

### Task 6: Frontend Settings consent card (USER)

**Files:**
- Create: `apps/web/src/hooks/useConsent.ts`, `apps/web/src/hooks/useConsent.spec.ts`.
- Modify: `apps/web/src/pages/settings/SettingsPage.tsx`.

**Interfaces — Produces:** `useConsent(): { status, current, loading, accept, needsConsent }`; `needsConsent(status): boolean = !(status.accepted && !status.requiresReconsent)`.

**Context:** TDA-007 left a "Consent & disclaimer" placeholder card in `SettingsPage`. Make it real for the USER view: fetch `/api/consent/status`; if `needsConsent`, fetch `/api/consent/current`, render `body` + an "I have read and accept" checkbox + Accept button → `POST /api/consent/accept` with `{ version, contentHash }` from the fetched doc; on success refresh status. If accepted, show "Accepted version {acceptedVersion}". Mirror `useSubscriptions` (TDA-007) style. No jsdom render tests.

- [ ] **Step 1: Write the failing test** — `useConsent.spec.ts` (Vitest, pure): `needsConsent({accepted:true, requiresReconsent:false})` → false; `{accepted:false,…}` → true; `{accepted:true, requiresReconsent:true}` → true.
- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vitest run src/hooks/useConsent.spec.ts`).
- [ ] **Step 3: Implement** `useConsent.ts` (export `needsConsent` + the hook) and wire the SettingsPage card (checkbox-gated Accept; disabled until checked). Keep the ADMIN Settings behavior unchanged.
- [ ] **Step 4: Run → PASS** + `cd apps/web && npx tsc -b --noEmit` (no type errors).
- [ ] **Step 5: Commit** `TDA-009: Settings consent card + useConsent hook`.

---

## Self-Review

- **Spec coverage:** §3 content-hash → T1; §3.1 schema delta + §6 seed → T2; §4 service (`getCurrent` T1, `getStatus`/`hasAcceptedCurrent`/`accept`/`revoke` T3), §4.1 fatal-audit policy → T3; §6 `publish` → T4; §5 guard/seam + §7 API → T5; §8 UX → T6. Acceptance: AC1→T1/T2, AC2→T4, AC3→T3, AC4→T3/T5, AC5→T5, AC6→T5, AC7→T2/T5. Test plan: unit→T1/T5/T6, integration→T3/T4, HTTP→T5. ✅
- **Single-hasher guarantee:** `computeContentHash` (T1) imports the TDA-008 `canonicalize`/`sha256`; the seed (T2) uses the identical formula; verify-time recompute in `accept` (T3) uses `computeContentHash`. No second hash implementation, none in SQL. ✅
- **No new model / additive-only migration:** `ConsentDocument`/`ConsentRecord` pre-exist; T2 adds only `@@unique([userId, documentId])` + `@@index([kind, active])`, forward-only via `--create-only`, never `migrate reset`. ✅
- **TDA-008 audit interface:** consent actions already in `audit-actions.ts` (no re-declare); `append` called fatally for accept/revoke/publish; safety rests on the idempotent `(userId, documentId)` upsert (T3). Full one-transaction atomicity is NOT achievable because `append` owns its advisory-lock/Serializable transaction — flagged as open decision §10.1. ✅
- **TDA-011 seam is minimal + clean:** exactly `hasAcceptedCurrent(userId)` (worker-safe boolean) + `ConsentGuard`/`@RequiresConsent()` (HTTP), exported from the `consent/index.ts` barrel; `ConsentModule` is `@Global` so TDA-011 injects without importing. The disclaimer consent (`ConsentDocument`/`ConsentRecord`, TDA-009) is kept distinct from the auto-execution opt-in + kill switch (`AutoTradeConsent`, TDA-011) — noted in spec §2/§9. ✅
- **Tenant scoping:** `ConsentRecord` is a `TENANT_MODEL`; all its access uses `runWithoutTenant` + explicit `userId` (mirrors TDA-007 `SubscriptionService`); `ConsentDocument` is global (unscoped reads). ✅
- **IP capture:** taken server-side from `req.ip` + `req.headers['user-agent']` (mirrors `AuthController.ctx`), never trusted from the request body; stored on `ConsentRecord` AND echoed into the `CONSENT_ACCEPT` audit `meta` so the audit row is self-contained evidence (roadmap "timestamp + IP"). ✅
- **Contradictions with roadmap scope found in code:** the roadmap describes TDA-009 as building the models, but TDA-001 **already created** `ConsentDocument`/`ConsentRecord` fully (incl. `ipAddress`/`userAgent`) and the seed already writes a placeholder tagged "replaced in TDA-009" — so TDA-009 is an upgrade-in-place, not a model build. TDA-008 also **pre-defined** the `CONSENT_*` taxonomy. No blocking contradiction; scope is narrower (service/API/guard/seed) than the roadmap line implies. ✅
- **Fail-closed:** `hasAcceptedCurrent` returns `false` when no active document exists (§10.2) — a misconfigured environment blocks auto-execution rather than opening it. ✅
