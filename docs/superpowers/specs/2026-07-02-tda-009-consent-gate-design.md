# TDA-009 — Versioned Consent & Disclaimer Gate — Design Spec

**Doc ID:** TDA-009
**Date:** 2026-07-02
**Sprint:** S4 (Audit & Consent) — MVP
**Depends on:** TDA-002 (auth: `JwtAuthGuard`, `@CurrentUser`, `AuthenticatedUser`, `req.ip`/user-agent capture), TDA-008 (`AuditService.append`, the `CONSENT_*` taxonomy, `canonicalize`/`sha256`)
**Blocks:** TDA-011 (opt-in auto-execution — the fan-out MUST NOT place an order for a user who has not accepted the current consent version)
**Owner:** development@panamoure.com

---

## 1. Goal

A user cannot have orders auto-placed on their broker account until they have
**accepted the current, content-hash-pinned risk-disclosure**, and any change to
that disclosure **forces re-acceptance**. This is the first-line legal defence for
a public auto-trading product: it produces, for every user, a tamper-evident
record of *exactly which words* they agreed to, *when*, and *from what IP*.

TDA-009 delivers: (1) a content-hash pinning scheme so a disclosure version's
body is cryptographically bound to its `version` string; (2) a `ConsentService`
that publishes versions, records acceptances, and answers the single question
TDA-011 needs — **"has this user accepted the current version?"**; (3) each
acceptance / revocation / publication written through the TDA-008 hash-chain with
timestamp + IP; (4) the API + minimal Settings UX to read the disclosure, see
status, and accept.

The enforcement gate itself lives here as a reusable `ConsentGuard` +
`@RequiresConsent()` decorator and the `hasAcceptedCurrent(userId)` seam; TDA-011
attaches the guard to its auto-execution routes and calls the seam per user in the
non-HTTP fan-out.

## 2. Background — what exists today (corrected after code map)

TDA-001 pre-created **both** tables and the seed already writes a placeholder, so
TDA-009 is an **upgrade in place** (like TDA-008 was), not a from-scratch model:

- `prisma/schema.prisma` already has:
  - `ConsentDocument { id, version @unique, kind, body, contentHash, active @default(true), createdAt, records ConsentRecord[] }` — **NOT** in `TENANT_MODELS` (`apps/api/src/common/tenant/tenant.constants.ts`), i.e. global: every user reads the same disclosure. Good — that is what a shared legal document must be.
  - `ConsentRecord { id, userId, documentId, version, acceptedAt @default(now()), ipAddress?, userAgent?, @@index([userId, version]) }` — **IS** a `TENANT_MODEL`, so the Prisma tenant extension auto-scopes reads/writes to the acting `userId`. The `ipAddress`/`userAgent` columns for the roadmap's "timestamp + IP" requirement **already exist**.
- `prisma/seed.ts` upserts a placeholder document `cdoc_seed_0001`, `version = '2026-06-27.0-placeholder'`, `kind = 'risk-disclosure'`, `body = 'PLACEHOLDER - replaced in TDA-009'`, `contentHash = 'sha256:placeholder'`. The `sha256:` prefix in the placeholder is the format TDA-009 formalises (§3).
- **`AutoTradeConsent` is a DIFFERENT model** — per-segment auto-execution opt-in (`enabled`, `killSwitch`, `riskPerTrade`, `maxCapital`). That is **TDA-011's** domain (the opt-in + kill switch), **not** the disclaimer consent. TDA-009 owns only `ConsentDocument`/`ConsentRecord`. Keeping these two apart is the clean TDA-011 seam (§5).
- TDA-008 shipped `AuditService.append({ action, userId, target, meta, chainKey })` (the sole `audit_logs` writer, strict/throws), the `canonicalize`/`sha256` single hasher (`apps/api/src/common/audit/canonicalize.ts`), and **already defined** the consent actions in the taxonomy: `CONSENT_ACCEPT`, `CONSENT_REVOKE`, `CONSENT_VERSION_PUBLISHED` (`audit-actions.ts`). TDA-009 is the spec that finally **emits** them (TDA-008 §5/§9 explicitly deferred emission to here).
- Auth (TDA-002) exposes `@CurrentUser(): AuthenticatedUser { userId, role, email }` from `req.user`, and the auth controller already captures `req.ip` + `req.headers['user-agent']` via a `ctx(req)` helper — the same pattern TDA-009's accept endpoint uses for the IP record.

So there is **no new model** and (almost) no schema work: the deltas are two
small additive constraints for idempotency + lookup speed (§3.1). The bulk of
TDA-009 is a service, an API, a guard, and replacing the placeholder seed body.

## 3. Content-hash pinning scheme

A disclosure version is a `(kind, version, body)` triple. Its **content hash**
binds the exact bytes of `body` (and its identifying `kind`/`version`) so a
recorded acceptance can never be silently re-pointed at different words.

**Decision: reuse TDA-008's canonical-JSON + SHA-256, not an ad-hoc hash.** One
hasher across the codebase (`canonicalize` + `sha256` from `common/audit`) means
the consent content hash is computed the same reproducible way as every audit link:

```
contentHash = 'sha256:' + sha256(canonicalize({ kind, version, body }))
```

- The `'sha256:'` prefix is stored verbatim (matches the seed's `'sha256:placeholder'` shape) so the algorithm is self-describing in the row and future algorithms can coexist.
- `canonicalize` gives byte-for-byte reproducibility (recursive key-sort) so `computeContentHash` yields an identical digest on publish, on accept-time verification, and in any later audit.
- **`ConsentService` is the only code that computes a content hash** — mirroring TDA-008's "single canonicalizer / single hasher" rule. Never hash a disclosure body anywhere else (especially not in SQL).

**"Current version" = the single `active` `ConsentDocument` for a `kind`.** MVP has
one kind, `RISK_DISCLOSURE = 'risk-disclosure'` (a combined disclaimer + risk
disclosure), so "current" is unambiguous. Publishing a new version (§6)
**deactivates** the prior active document of that kind and inserts a new `active`
one in a single transaction, so at most one document per kind is ever `active`.

### 3.1 Schema delta (additive — THIS lane owns it)

The models exist; TDA-009 adds only two additive, forward-only constraints:

```prisma
model ConsentDocument {
  // …unchanged…
  @@index([kind, active])          // NEW — fast "current active doc for kind" lookup
  @@map("consent_documents")
}

model ConsentRecord {
  // …unchanged…
  @@unique([userId, documentId])   // NEW — one acceptance row per (user, document);
                                   //       makes POST /accept idempotent (upsert)
  @@index([userId, version])
  @@map("consent_records")
}
```

- `@@unique([userId, documentId])` makes a double-click / retried accept a no-op upsert instead of duplicate rows, and lets `hasAcceptedCurrent` be a single indexed point-lookup.
- No column changes, no `NOT NULL` tightening → a **single forward migration**, `--create-only` reviewed, **never `prisma migrate reset`** (TDA-008 discipline; this lane owns `schema.prisma` for its wave).

## 4. `ConsentService` — the gate

**Location:** `apps/api/src/modules/consent/consent.service.ts`, in a `@Global()`
`ConsentModule` (mirrors `AuditModule`/`TenantModule`) so the guard and TDA-011
can inject it without re-importing.

```ts
const RISK_DISCLOSURE = 'risk-disclosure';

interface CurrentConsent {          // what a USER is asked to accept
  documentId: string;
  kind: string;
  version: string;
  body: string;
  contentHash: string;              // 'sha256:…'
  createdAt: Date;
}

interface ConsentStatus {           // what /status and the UI need
  currentVersion: string | null;    // null if no active doc (fail-closed)
  accepted: boolean;                 // accepted the CURRENT version?
  acceptedVersion: string | null;   // the version the user last accepted, if any
  requiresReconsent: boolean;        // accepted an older version but not the current
}

class ConsentService {
  computeContentHash(kind: string, version: string, body: string): string;
  getCurrent(kind?: string): Promise<CurrentConsent | null>;
  getStatus(userId: string, kind?: string): Promise<ConsentStatus>;
  hasAcceptedCurrent(userId: string, kind?: string): Promise<boolean>;   // ← TDA-011 seam
  accept(userId: string, version: string, contentHash: string, ip: string | null, userAgent: string | null): Promise<ConsentStatus>;
  revoke(userId: string, kind?: string): Promise<void>;
  publish(kind: string, version: string, body: string, actorUserId: string | null): Promise<CurrentConsent>;   // ADMIN
}
```

- **`ConsentDocument` reads run unscoped** (it is not a tenant model) — every user sees the same active doc.
- **`ConsentRecord` reads/writes must run unscoped with an explicit `userId`** — it *is* a tenant model, but `hasAcceptedCurrent`/`accept` are keyed on an explicit `userId` (the fan-out checks arbitrary users; the guard checks the request's own user). Use `TenantContextService.runWithoutTenant(...)` with an explicit `where: { userId }`, exactly as TDA-007's `SubscriptionService` does for its tenant-model queries.
- **`hasAcceptedCurrent`** = load the active doc for `kind`; if none → **`false`** (fail closed: no disclosure published ⇒ no auto-execution); else return whether a `ConsentRecord` exists for `(userId, activeDoc.id)`.
- Because acceptance is pinned to the active document's **id**, publishing a new version (new id) makes every prior acceptance stop matching → `hasAcceptedCurrent` returns `false` → re-consent is forced with **no** per-user bookkeeping.

### 4.1 `accept` flow + audit failure policy

`accept(userId, version, contentHash, ip, userAgent)`:

1. Load the active doc for `RISK_DISCLOSURE`. If none → `409 { code: 'NO_ACTIVE_CONSENT' }`.
2. **Stale-guard:** if `version !== active.version` → `409 { code: 'CONSENT_VERSION_STALE', currentVersion }`. The client must re-fetch and accept the version it is actually shown; it cannot accept a version that is no longer current.
3. **Integrity check:** recompute `computeContentHash(active.kind, active.version, active.body)` and assert it equals both `active.contentHash` **and** the client-echoed `contentHash`. A mismatch → `409 { code: 'CONSENT_CONTENT_MISMATCH' }` (a tampered document row, or a client showing different bytes, must not be silently accepted).
4. **Upsert** the `ConsentRecord` on `@@unique([userId, documentId])` with `version`, `ipAddress = ip`, `userAgent`, `acceptedAt = now()`.
5. **Append** `CONSENT_ACCEPT` via `AuditService.append({ action: 'CONSENT_ACCEPT', userId, target: version, meta: { documentId, contentHash, kind, ip, userAgent } })`.
6. Return the refreshed `ConsentStatus`.

**Failure policy (per TDA-008 §4.1: consent is a *fatal* audit event, not
best-effort like auth).** The `ConsentRecord` upsert (step 4) then the `append`
(step 5) both run inside `accept`; **if `append` throws, `accept` throws** and the
caller gets a 5xx. Honest limitation, flagged as an open decision (§10.1):
`AuditService.append` opens its **own** advisory-lock + `Serializable` transaction
(TDA-008 §4) and cannot enlist in an outer interactive transaction, so step 4 and
step 5 are not one DB transaction. This is made safe by idempotency: the record
upsert is keyed on `(userId, documentId)`, so a client retry re-runs cleanly, and a
duplicate `CONSENT_ACCEPT` audit row is harmless — the hash-chain is append-only
evidence and two accept rows for the same version simply record two attempts.
`revoke` and `publish` follow the same fatal-append contract.

## 5. Enforcement seam for TDA-011 (keep it minimal)

TDA-011 owns auto-execution; TDA-009 gives it exactly two things and nothing more:

1. **The check:** `ConsentService.hasAcceptedCurrent(userId): Promise<boolean>`. The fan-out worker (non-HTTP, TDA-010/011) calls this per eligible user in its pipeline **before** decrypting creds / placing an order; a `false` skips that user and the worker audits the skip (`ORDER_REJECTED` with a consent reason is TDA-011's to emit). One boolean, keyed on an explicit `userId`, no request context needed — safe to call from a queue worker.
2. **The HTTP guard:** `@RequiresConsent()` + `ConsentGuard` (`apps/api/src/modules/consent/consent.guard.ts`). Reads `@CurrentUser()` (`req.user`), calls `hasAcceptedCurrent(user.userId)`, and on `false` throws `403 { code: 'CONSENT_REQUIRED', currentVersion }`. TDA-011 annotates its "enable auto-execution" / manual-execute routes with `@RequiresConsent()`. The guard does **not** special-case ADMIN — consent is about the account being traded, and an ADMIN auto-trading their own account must consent too; the fan-out already checks each *target* user individually.

`ConsentGuard` runs **after** `JwtAuthGuard` (so `req.user` is populated), the same
ordering constraint TDA-008's `RolesGuard` documents. TDA-009 ships the guard but
attaches it to **no** route yet (there is no execution route until TDA-011) — it is
unit-tested standalone (§12) so TDA-011 can adopt it with zero design work.

## 6. Publishing a version + seed replacement

- **`publish(kind, version, body, actorUserId)`** (ADMIN): compute `contentHash`; in one `prisma.$transaction`, set `active = false` on the current active doc of `kind` and `create` the new `{ version, kind, body, contentHash, active: true }` (uniqueness of `version` prevents accidental re-publish of the same string); then `append` `CONSENT_VERSION_PUBLISHED` (`target: version`, `meta: { kind, contentHash, previousVersion }`). This is the only path that mints a new "current version" and thus the only path that forces global re-consent.
- **Seed replacement (`prisma/seed.ts`):** replace the placeholder body with the real MVP risk-disclosure text and compute its real `contentHash` via the **same** `computeContentHash` (import the shared `canonicalize`/`sha256`), so a freshly seeded DB already has a valid, hash-consistent active document instead of `'sha256:placeholder'`. Keep it an idempotent upsert. The disclosure wording itself is legal-reviewed before public launch (roadmap §7, Harden phase) — TDA-009 ships a structurally-correct, hash-pinned MVP body, not final legal copy.

## 7. API surface

All under the global `JwtAuthGuard` (authenticated). No `/api` global prefix is
set app-wide, so controllers carry it (matches `AuditController`).

**USER (self):**
- `GET /api/consent/current` — the active disclosure to display: `{ documentId, kind, version, body, contentHash, createdAt }`. `404 { code: 'NO_ACTIVE_CONSENT' }` if none.
- `GET /api/consent/status` — `ConsentStatus` for the caller (`{ currentVersion, accepted, acceptedVersion, requiresReconsent }`).
- `POST /api/consent/accept` — body `{ version, contentHash }` (the client echoes what it was shown). Captures `req.ip` + `req.headers['user-agent']` server-side (never trusted from the body), records + audits (§4.1), returns the refreshed `ConsentStatus`. Errors: `409` for stale / content-mismatch / no-active (§4.1).
- `POST /api/consent/revoke` — withdraws consent (deletes/marks the caller's `ConsentRecord` for the current doc), audits `CONSENT_REVOKE`. After revoke, `hasAcceptedCurrent` is `false` → auto-execution is gated again (roadmap: withdrawal must stop execution).

**ADMIN:**
- `POST /api/admin/consent/publish` — `@AdminOnly()`; body `{ kind?, version, body }`; calls `publish(...)`; returns the new `CurrentConsent`. This is the "version bump" that forces re-consent for everyone.

## 8. Frontend / minimal UX

TDA-007 already left a **Settings → "Consent & disclaimer"** placeholder card
stating "real versioned gate in TDA-009". TDA-009 makes it real (USER view):

- On mount, `GET /api/consent/status`. If `accepted` and not `requiresReconsent` → show "You accepted version `{acceptedVersion}` on …" (accepted state).
- If `!accepted` or `requiresReconsent` → fetch `GET /api/consent/current`, render the `body`, an **"I have read and accept the risk disclosure"** checkbox, and an **Accept** button that `POST /api/consent/accept` with `{ version, contentHash }` from the fetched doc. On success, refresh status.
- The auto-execution toggle (TDA-011) reads this status: it stays **disabled** with a "Accept the risk disclosure to enable auto-execution" hint until `accepted && !requiresReconsent`. TDA-009 exposes the status; TDA-011 wires the toggle.
- A `useConsent()` hook (`apps/web/src/hooks/useConsent.ts`) encapsulates the status fetch + accept call, mirroring TDA-007's `useSubscriptions`. Pure-logic (a `needsConsent(status)` selector) is unit-tested; no jsdom render tests (repo has none).

## 9. Out of scope (deferred)

- The auto-execution opt-in toggle, per-user risk sizing, kill switch, and the fan-out's per-user consent skip — **TDA-011** (`AutoTradeConsent` model + fan-out). TDA-009 only provides `hasAcceptedCurrent` + `ConsentGuard`.
- Final legal wording / jurisdiction review of the disclosure body — Harden phase (roadmap §7). TDA-009 ships a hash-pinned MVP body.
- Multiple concurrent consent kinds / per-segment disclosures — the schema (`kind`) supports it; MVP enables one (`risk-disclosure`).
- An ADMIN consent-records viewer UI — the audit export (TDA-008 `/api/admin/audit/export`, filter `action=CONSENT_ACCEPT`) already provides the evidentiary view; no new UI here.
- Emailing users on a version bump — a later notification concern.

## 10. Open decisions (for the human)

1. **Accept + audit atomicity.** Default: consent is a **fatal** audit event (§4.1) — a failed `append` fails the accept — made safe by an idempotent `(userId, documentId)` upsert (record retry is a no-op; a duplicate audit row is harmless append-only evidence). Because `AuditService.append` owns its own advisory-lock transaction, the record write and the audit write are not a single DB transaction. Confirm this is acceptable, or mandate a follow-up that lets `append` accept an external `tx` (a TDA-008 change) for true one-transaction atomicity.
2. **`hasAcceptedCurrent` when no active document exists.** Default: **fail closed** → `false` (no published disclosure ⇒ no auto-execution). The seed always publishes one, so this only bites a misconfigured environment — which is exactly when blocking execution is correct. Confirm fail-closed over fail-open.
3. **Does re-consent invalidate an already-enabled auto-execution?** Default: TDA-009 makes `hasAcceptedCurrent` return `false` on a version bump; whether that **auto-disables** an existing `AutoTradeConsent.enabled` or merely **blocks new orders** at the gate is TDA-011's policy. Recommendation (flag for TDA-011): the fan-out's per-order `hasAcceptedCurrent` check blocks new orders on a bump without needing to mutate `AutoTradeConsent` — simplest and safe.
4. **Revoke semantics.** Default: `revoke` removes the current acceptance so the gate closes; it does **not** delete historical `CONSENT_ACCEPT` audit rows (they are permanent evidence). Confirm revoke is "close the gate", not "erase history".

## 11. Acceptance criteria

1. `ConsentService.computeContentHash` is the only content-hash implementation; it returns `'sha256:' + sha256(canonicalize({kind, version, body}))` and is stable across publish / accept-verify. The seeded document's stored `contentHash` equals a fresh recomputation (no more `'sha256:placeholder'`).
2. `getCurrent()` returns the single `active` document for `risk-disclosure`; publishing a new version deactivates the prior one so exactly one is active.
3. `hasAcceptedCurrent(userId)` is `true` iff a `ConsentRecord` exists for the caller and the **current** active document; it becomes `false` for every user immediately after a version bump (proven by a test that publishes v2 after a v1 acceptance).
4. `POST /api/consent/accept` records a `ConsentRecord` with the server-captured IP + user-agent and appends a `CONSENT_ACCEPT` row that `verifyChain('global')` accepts; accepting a stale version → `409 CONSENT_VERSION_STALE`; a body/hash mismatch → `409 CONSENT_CONTENT_MISMATCH`.
5. `@RequiresConsent()` + `ConsentGuard`: a user who has not accepted the current version is `403 { code: 'CONSENT_REQUIRED', currentVersion }`; after accepting, the same request passes.
6. `POST /api/admin/consent/publish` is `@AdminOnly()` (USER → 403, ADMIN → 200), mints a new current version, and appends `CONSENT_VERSION_PUBLISHED`.
7. The schema migration is forward-only (no `migrate reset`); `prisma migrate status` clean; `app.module.ts` registers `ConsentModule` (additive).

## 12. Test plan

- **Unit (`apps/api/test/tda009/`):**
  - `computeContentHash` — deterministic (`'sha256:'` prefix, 64-hex body), differs when `body`/`version`/`kind` differ, and re-hashing the seeded doc equals its stored `contentHash`.
  - `ConsentGuard` — with a stubbed `ConsentService`: `hasAcceptedCurrent → false` throws `403 CONSENT_REQUIRED`; `true` returns `true`. Pure, no DB.
  - `needsConsent(status)` frontend selector (Vitest, `apps/web`): `accepted && !requiresReconsent` → false; otherwise true.
- **Integration (DB-backed, `td_saas_test`, Style-B — real `PrismaClient` + `runWithoutTenant`, mirrors TDA-007 `subscription.spec.ts`):**
  - `publish` v1 → `getCurrent` returns v1, one active row. `accept(user, v1)` → `hasAcceptedCurrent` true, `ConsentRecord` has ip/userAgent. `publish` v2 → `hasAcceptedCurrent` false (re-consent forced); `accept(user, v2)` → true again.
  - Stale accept (`version` ≠ active) and content-mismatch both rejected.
  - After `accept`, the latest `CONSENT_ACCEPT` audit row has non-empty `hash`/`prevHash` and `verifyChain('global')` is `ok` (proves fatal-append routes through the chain).
  - Idempotent accept: two `accept` calls → one `ConsentRecord` (upsert), gate still `true`.
- **HTTP (Style-A focused boot, reuse the tda008 harness):** mint `td-access` JWTs; `GET /api/consent/current` + `/status` for a USER; `POST /api/consent/accept` flips status; USER → `POST /api/admin/consent/publish` 403, ADMIN → 200; after ADMIN publishes v2, the USER's `/status.requiresReconsent` is `true`.
- Jest 29.7 `--verbose` from `apps/api`: `npx jest --config test/tda009/jest.config.js --verbose` (prefix `DATABASE_URL_TEST=…` for DB-backed specs). Frontend: `cd apps/web && npx vitest run <file>`.
