# TDA-008 — Tamper-Evident, Hash-Chained Audit Log — Design Spec

**Doc ID:** TDA-008
**Date:** 2026-07-01
**Sprint:** S4 (Audit & Consent) — MVP
**Depends on:** TDA-001 (the `AuditLog` model + seeded ADMIN), TDA-003 (RBAC `@AdminOnly`, `RolesGuard`, `@CurrentUser`, Prisma tenant scoping)
**Blocks:** TDA-009 (versioned consent — every acceptance is an audit row), TDA-011 (auto-execution — every order is an audit row)
**Owner:** development@panamoure.com

---

## 1. Goal

Make every security-relevant action **provably un-rewritable after the fact**. A
single `AuditService.append(event)` is the **only** sanctioned writer of
`AuditLog`; each row stores `hash = sha256(prevHash + canonicalize(payload))`, so
the rows form an append-only chain. Deleting, reordering, or editing **any** row
breaks the chain at that point and every row after it — and an ADMIN can prove it
by re-walking the chain. The log covers auth events, credential access/decrypt,
consent changes, and every order; it is ADMIN-readable and exportable.

This is the evidentiary record for a public auto-trading product. Hiding the data
behind RBAC (TDA-003) stops *reads*; this spec stops **silent tampering** — a DBA
or a compromised process that rewrites history is detectable, not invisible.

## 2. Background — what exists today (corrected after code map)

TDA-001 already added the table and TDA-002 already writes to it, but the chain is
a **placeholder**:

- `prisma/schema.prisma` → `model AuditLog { id, userId?, action, target?, meta?, prevHash?, hash, createdAt }` with `@@index([userId, createdAt])` and `@@index([action, createdAt])`. **`hash` and `prevHash` columns already exist** (TDA-001 reserved them); there is **no** sequence or chain-partition column yet.
- `AuthService.audit()` (`apps/api/src/modules/auth/services/auth.service.ts`) and `MfaService.audit()` (`.../mfa.service.ts`) are **two duplicated private helpers** that each do `prisma.auditLog.create({ data: { …, hash: '', prevHash: '' } })` and swallow errors (auditing must never break the user flow). They write **empty-string hashes** — no chaining today.
- Actions already emitted (the de-facto auth taxonomy): `AUTH_SIGNUP`, `AUTH_LOGIN`, `AUTH_LOGIN_FAILED`, `AUTH_MFA_CHALLENGE`, `AUTH_MFA_FAILED`, `AUTH_MFA_ENROLL`, `AUTH_MFA_ACTIVATE`, `AUTH_MFA_DISABLE`, `AUTH_PASSWORD_FORGOT`, `AUTH_PASSWORD_RESET`, `AUTH_REFRESH`, `AUTH_REFRESH_REUSE`, `AUTH_LOGOUT`.
- **`AuditLog` is deliberately NOT in `TENANT_MODELS`** (`apps/api/src/common/tenant/tenant.constants.ts`), so the Prisma tenant-scoping `$extends` never rewrites audit reads/writes. The audit service therefore sees the whole table regardless of request context — which is exactly what a global chain and an ADMIN export need.
- The seeded ADMIN `SYSTEM_USER_ID = 'usr_admin_seed_0001'` owns engine/system rows; system-originated audit events (no end user) use `userId = null`.

So TDA-008 is an **upgrade in place**: add the chain columns, centralise the two
helpers into one strict `AuditService.append`, backfill the existing rows into a
valid chain, and add verify + ADMIN read/export.

## 3. The chain model — one global chain

**Decision: a single global hash chain (`chainKey = 'global'`), not per-user
chains.** Rationale:

- **Strongest tamper-evidence.** With one continuous chain, removing or reordering *any* row — including wholesale deletion of one user's events — breaks verification, because every later row's `prevHash` no longer matches. Per-user chains let an attacker with DB access drop a user's entire tail (or the whole chain) with **nothing else** to detect it, since no cross-user row links to it.
- **Simplicity of verification + export.** One ordered walk proves the entire history; the ADMIN export is one stream.
- **Cost is acceptable at MVP volume.** The price is a single serialization point on append (§4). Auth + credential + consent + order events at MVP scale are low-frequency; a short advisory-lock-guarded transaction absorbs them.

**Future-proofing without another migration:** the new `chainKey` column defaults
to `'global'`. If order fan-out throughput (TDA-011) ever makes the single chain a
bottleneck, appends can be partitioned (e.g. a `'security'` chain for auth/consent
and per-segment order chains) by **passing a different `chainKey`** — the append,
verify, and storage code are already keyed on it. This is flagged as the one
genuine open decision (§10).

### 3.1 New `AuditLog` shape (schema delta — THIS lane owns it)

```prisma
model AuditLog {
  id        String   @id @default(cuid())
  chainKey  String   @default("global")  // NEW — chain partition (one chain at MVP)
  seq       BigInt                         // NEW — 1-based position within chainKey
  userId    String?
  user      User?    @relation(fields: [userId], references: [id])
  action    String
  target    String?
  meta      Json?
  prevHash  String                          // was String? — now always set (genesis const for seq 1)
  hash      String
  createdAt DateTime @default(now())
  @@unique([chainKey, seq])                 // NEW — backstops the append race; gap/dupe = tamper
  @@index([userId, createdAt])
  @@index([action, createdAt])
  @@index([chainKey, seq])                  // NEW — ordered chain walk
  @@map("audit_logs")
}
```

Only **additive** columns + indexes + one `@@unique`; `hash`/`prevHash` already
exist (`prevHash` tightens from nullable to NOT NULL during backfill, §6).

## 4. `AuditService.append(event)` — the only writer

**Location:** `apps/api/src/common/audit/audit.service.ts` (in a `@Global`
`AuditModule`, mirroring `TenantModule`, so auth/mfa/credential/consent/order code
can inject it without re-importing).

```ts
interface AuditEvent {
  action: AuditAction;          // from the taxonomy (§5)
  userId?: string | null;       // end user, or null for system-originated
  target?: string | null;       // subject (email, credentialId, orderId, …)
  meta?: Record<string, unknown>; // structured detail (NO secrets, NO plaintext)
  chainKey?: string;            // defaults 'global'
}
async append(event: AuditEvent): Promise<{ seq: bigint; hash: string }>;
```

**Algorithm (concurrency-safe, per chain):**

```
prisma.$transaction(async (tx) => {
  // 1. Serialize all appends to this chain. xact-scoped advisory lock auto-
  //    releases on COMMIT/ROLLBACK; key = hash of chainKey.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chainKey}, 0))`;

  // 2. Read the current head of this chain.
  const head = await tx.auditLog.findFirst({
    where: { chainKey }, orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });

  // 3. Compute the new link. createdAt is app-generated so it is part of the
  //    hashed payload and reproducible at verify time.
  const seq      = (head?.seq ?? 0n) + 1n;
  const prevHash = head?.hash ?? GENESIS_PREV_HASH;     // 64 '0' chars for seq 1
  const createdAt = new Date();
  const payload  = canonicalize({ chainKey, seq, action, userId, target, meta, createdAt });
  const hash     = sha256(prevHash + payload);          // hex

  // 4. Append. @@unique([chainKey, seq]) makes a lost race fail loudly, not silently.
  await tx.auditLog.create({ data: { chainKey, seq, userId, target, action, meta, prevHash, hash, createdAt } });
  return { seq, hash };
}, { isolationLevel: 'Serializable' });
```

- **Concurrency:** the `pg_advisory_xact_lock` serialises concurrent appends to the same chain so head-read and insert are atomic; `Serializable` isolation + the `@@unique([chainKey, seq])` constraint are belt-and-braces (a duplicate `seq` raises `P2002` → the caller policy in §4.1 decides retry vs. fail). No two rows can share a `(chainKey, seq)`, and no `prevHash` can point at a stale head.
- **Canonicalization** (`apps/api/src/common/audit/canonicalize.ts`): deterministic JSON with **recursively sorted object keys**, `Date` rendered as ISO-8601, `bigint` as decimal string. The hash is reproducible only if the bytes are reproducible, so this is the single source of truth used by both `append` and `verify`. No `JSON.stringify` of the raw event anywhere else.
- **`append` is strict** — it throws on failure. It does **not** swallow errors (unlike today's helpers). Call-site policy (§4.1) decides whether a failed audit aborts the action.
- **Single canonicalizer / single hasher** — `sha256` and `canonicalize` live in `common/audit` and are imported everywhere; this also pays down the roadmap follow-up "DRY the duplicated `sha256`/`audit` helpers."

### 4.1 Call-site failure policy

- **Best-effort (non-fatal) events** — auth events. Migrate `AuthService.audit()` and `MfaService.audit()` to call `AuditService.append`, keeping their existing `try/catch` swallow so a login still succeeds if the audit write hiccups. (A failed *auth* audit is undesirable but must not lock users out — preserves current behaviour.)
- **Fatal (transactional) events** — orders & consent (TDA-011/009). These call `append` **inside the same transaction** as the state change (or fail the action if it throws): an order must never be placed without its audit row. This spec defines the contract; the order/consent emission is those specs' work (§7).

## 5. Event taxonomy

A single `AuditAction` union (`apps/api/src/common/audit/audit-actions.ts`),
grouped by domain. **In scope for THIS spec to actually emit:** the `AUTH_*` set
(by migrating the existing auth/mfa helpers). The rest are **defined here** (so the
vocabulary is fixed and reviewable) and **emitted by their owning spec**:

| Group | Actions | Emitted by |
|---|---|---|
| Auth | `AUTH_SIGNUP`, `AUTH_LOGIN`, `AUTH_LOGIN_FAILED`, `AUTH_LOGOUT`, `AUTH_REFRESH`, `AUTH_REFRESH_REUSE`, `AUTH_PASSWORD_FORGOT`, `AUTH_PASSWORD_RESET`, `AUTH_MFA_CHALLENGE`, `AUTH_MFA_FAILED`, `AUTH_MFA_ENROLL`, `AUTH_MFA_ACTIVATE`, `AUTH_MFA_DISABLE` | **TDA-008 (this spec)** — migrate existing writers |
| Credential | `CREDENTIAL_CONNECT`, `CREDENTIAL_DECRYPT`, `CREDENTIAL_ROTATE`, `CREDENTIAL_DELETE` | TDA-005 |
| Consent | `CONSENT_ACCEPT`, `CONSENT_REVOKE`, `CONSENT_VERSION_PUBLISHED` | TDA-009 |
| Execution | `ORDER_PLACED`, `ORDER_REJECTED`, `ORDER_FILLED`, `ORDER_CANCELLED`, `AUTOTRADE_ENABLED`, `AUTOTRADE_DISABLED`, `KILL_SWITCH_TRIGGERED` | TDA-010/011 |

`AuditAction` is a string union (not a Prisma enum) so a new domain can add actions
without a migration; the `action` column stays `String`. **`meta` must never carry
secrets** — `CREDENTIAL_DECRYPT` records *that* a decrypt happened (who, which
`credentialId`, why/`signalId`), never the plaintext (TDA-005 zeroizes plaintext;
it never reaches the audit payload).

## 6. Backfill (one-time, forward migration only)

Existing rows have `hash = ''`, `prevHash = ''` and no `seq`. The forward migration
is **DDL-only** (add `chainKey` default `'global'`, nullable `seq`, indexes); a
**JS backfill** then forms a valid chain from genesis so `verify()` passes over all
of history:

1. Read all existing rows ordered by `(createdAt, id)` (stable tiebreak).
2. Assign `seq = 1..N`; recompute `prevHash`/`hash` via the **same** `canonicalize`+`sha256` as `append` (one canonicalizer — never re-implement the hash in SQL).
3. Then a follow-up DDL step sets `seq` `NOT NULL`, `prevHash` `NOT NULL`, adds `@@unique([chainKey, seq])`.

**Honest framing (documented in the spec, not hidden):** pre-migration rows were
written with empty hashes and were mutable before this change — backfilling makes
the chain *self-consistent and tamper-evident from now on*, but it does **not**
retroactively prove the pre-TDA-008 rows were never altered. The chain's
cryptographic guarantee begins at the backfill. (Acceptable: this is a fresh
`td_saas` build with only dev auth rows.) **Never `migrate reset`** — forward
migration + idempotent backfill script only.

## 7. ADMIN read / verify / export endpoint

**Location:** `apps/api/src/common/audit/audit.controller.ts`, class-level
`@AdminOnly()` (TDA-003 `RolesGuard`). A USER hitting any of these gets **403**.

- `GET /api/admin/audit` — paginated list, `orderBy seq asc`, filters: `action`, `userId`, `chainKey`, `from`/`to` (`createdAt`), `cursor`/`limit`. Returns rows verbatim (chain fields included) so an auditor sees `seq`/`hash`/`prevHash`.
- `GET /api/admin/audit/verify` — runs §8 over `chainKey` (default `'global'`); returns `{ ok, chainKey, checked, head: { seq, hash }, firstBrokenSeq? , reason? }`.
- `GET /api/admin/audit/export` — streams the chain (filtered or whole) as **NDJSON** (one JSON row per line, `seq` order) for off-box archival/legal retention. NDJSON over CSV so `meta` (nested JSON) survives losslessly; the stream preserves `hash`/`prevHash` so the export is independently verifiable.

These reads must run **unscoped** — `AuditLog` is not a tenant model, so the Prisma
extension already leaves audit queries alone; the ADMIN context also bypasses
scoping. No `redactProvenance` here: this is the ADMIN evidentiary view (engine
provenance redaction was TDA-006's USER-path concern).

## 8. Verification routine

`AuditService.verifyChain(chainKey = 'global')` re-walks the chain in `seq` order
and returns the first divergence:

1. Load rows for `chainKey` `orderBy seq asc`.
2. Assert `seq` is **contiguous from 1** (a gap = a deleted row → tamper).
3. For each row: assert `prevHash === previousRow.hash` (row 1 → `GENESIS_PREV_HASH`).
4. Recompute `sha256(prevHash + canonicalize({chainKey, seq, action, userId, target, meta, createdAt}))` and assert it **equals** the stored `hash` (any edited field → mismatch).
5. Return `{ ok: true, checked: N, head }` or `{ ok: false, firstBrokenSeq, reason }` (`reason ∈ {GAP, PREV_MISMATCH, HASH_MISMATCH}`).

Pure function over stored columns — no external state — so it is unit-testable with
a hand-built fixture and is exactly what the ADMIN `verify` endpoint calls.

## 9. Out of scope (deferred)

- **Emitting** credential/consent/order events — owned by TDA-005/009/011; this spec only fixes the taxonomy + provides `append` + wires the existing auth events.
- Periodic external anchoring (publishing the head hash to an append-only external store / notarisation) — a later hardening option; the `chainKey`/`seq`/`hash` design supports it without change.
- Per-user / per-segment chain partitioning — supported by `chainKey` but not enabled now (§10).
- Log-redaction of provenance — TDA-006 (already shipped) covers the USER path.
- An ADMIN audit *viewer UI* — API only here.

## 10. Open decisions (for the human)

1. **Global vs partitioned chain.** Default chosen: **single global chain** (§3) — strongest tamper-evidence, simplest verify/export, one append serialization point. *Flag:* if TDA-011 order fan-out drives high concurrent append volume, the single advisory lock becomes a throughput ceiling. Mitigation is already in place (the `chainKey` column) — partition later with no schema change. Confirm the global default is acceptable for MVP.
2. **Backfill semantics.** Default chosen: backfill existing rows into a valid chain from genesis (§6), with the honest caveat that pre-TDA-008 integrity isn't retroactively proven. Alternative: seal legacy rows under `chainKey='legacy'` and start `'global'` fresh at seq 1. Default is cleaner for a single ADMIN export; flag if legal prefers an explicit legacy boundary.
3. **Auth-audit failure policy.** Default chosen: keep auth audit **best-effort** (§4.1) so a transient audit failure can't lock users out, while orders/consent are **fatal/transactional**. Confirm this asymmetry is acceptable (the alternative — fatal auth audit — trades availability for completeness).

## 11. Acceptance criteria

1. `AuditService.append` is the only code path that writes `AuditLog`; `AuthService`/`MfaService` no longer create audit rows directly (their helpers delegate to `append`). No row is written with `hash === ''`.
2. `append` computes `hash = sha256(prevHash + canonicalize(payload))`, assigns a contiguous `seq` per `chainKey`, and is concurrency-safe: N concurrent appends produce N rows with distinct contiguous `seq` and a valid chain (no gaps, no dupes).
3. `verifyChain` returns `ok:true` for an untampered chain and pinpoints `firstBrokenSeq` + `reason` when a row is edited, deleted, or reordered (covered by tests that mutate a row and re-verify).
4. The backfilled table verifies `ok:true` from `seq 1` after migration.
5. `GET /api/admin/audit*` is `@AdminOnly` (USER → 403, ADMIN → 200); list is `seq`-ordered + filterable; `export` emits verifiable NDJSON; `verify` returns the chain status.
6. The schema migration is forward-only (no `migrate reset`); `prisma migrate status` is clean; `app.module.ts` registers `AuditModule` (additive).

## 12. Test plan

- **Unit (`apps/api/test/tda008/`):**
  - `canonicalize` — key-order independence (same hash for reordered keys), `Date`→ISO, `bigint`→string, nested objects.
  - `verifyChain` over a hand-built fixture — passes clean; fails with the right `firstBrokenSeq`/`reason` for (a) an edited `meta`, (b) a deleted middle row (gap), (c) a swapped `prevHash`.
- **Integration (DB-backed, `td_saas_test`):**
  - `append` chains: three sequential appends → `seq 1,2,3`, each `prevHash === prior.hash`, row 1 `prevHash === GENESIS`. `verifyChain` → `ok`.
  - **Concurrency:** `Promise.all` of ~20 `append` calls → 20 rows, contiguous `seq`, `verifyChain` ok (proves the advisory lock + unique constraint serialise correctly).
  - Auth integration: drive `AuthService.signup`/`login` and assert the resulting rows have non-empty `hash`/`prevHash` and verify.
- **HTTP (Style-A focused boot, reuse the tda003 harness):** mint `td-access` JWTs; USER → `/api/admin/audit` 403, ADMIN → 200; `verify` returns `ok:true`; `export` returns NDJSON whose lines re-verify.
- Jest 29.7 — run with `--verbose` (not `-v`): `npx jest --config test/tda008/jest.config.js --verbose` (prefix `DATABASE_URL_TEST=…` for DB-backed specs).
